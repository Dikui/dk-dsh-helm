/**
 * Private reveal handoff between the `/boost` host entrypoint and the reviewer
 * role plugin.
 *
 * The entrypoint reserves the reviewer child id with `startActivation`, arms the
 * reveal callback under that exact id, and disarms it when the run settles. The
 * role plugin can reach this module only through the same process/package
 * instance, and the tool looks the callback up by the calling agent id — never by
 * a model-supplied id. The callback itself owns one-shot and closed-run policy,
 * so a successful call is deliberately not removed here.
 *
 * Locking the verdict and delivering the report are distinct. When the tool
 * runs, the callback defers delivery and this module records the execution token
 * of that exact call. The reviewer preset observes `tools/result` and routes
 * the final model-facing result back here; only that event, for that token and
 * caller, confirms delivery. Late, foreign, or duplicate events cannot.
 */

const armedReveals = new Map()
const pendingDeliveries = new Map()

/** Error raised by the reveal boundary, carrying a stable `code` for callers. */
export class BoostRevealError extends Error {
  /**
   * @param {string} code - stable machine-readable failure code.
   * @param {string} message - human-readable failure detail.
   * @param {{ cause?: unknown }} [options] - optional underlying error.
   */
  constructor(code, message, options) {
    super(message, options)
    this.name = 'BoostRevealError'
    this.code = code
  }
}

/**
 * @param {unknown} value - candidate session id.
 * @param {string} label - field name used in the error.
 * @returns {string} the unchanged non-empty id.
 */
function requireId(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BoostRevealError('INVALID_CHILD_ID', `${label} must be a non-empty session id`)
  }
  return value
}

/**
 * Arm one reviewer child with the reveal callback created by the Boost protocol.
 * @param {string} childId - child id reserved by `startActivation`.
 * @param {(initialVerdict: string, options?: { deferDelivery?: boolean }) => string} revealFn - protocol-owned reveal callback.
 * @returns {() => void} idempotent disposer; it removes only this exact callback and its pending deliveries.
 */
export function armReveal(childId, revealFn) {
  const key = requireId(childId, 'armReveal() childId')
  if (typeof revealFn !== 'function') {
    throw new BoostRevealError('INVALID_REVEAL_FUNCTION', 'armReveal() requires a reveal function')
  }
  if (armedReveals.has(key)) {
    throw new BoostRevealError('REVEAL_ALREADY_ARMED', `a reveal callback is already armed for child "${key}"`)
  }

  const entry = { revealFn, tokens: new Set() }
  armedReveals.set(key, entry)
  let disposed = false

  return function dispose() {
    if (disposed) return
    disposed = true
    if (armedReveals.get(key) === entry) armedReveals.delete(key)
    for (const token of entry.tokens) pendingDeliveries.delete(token)
    entry.tokens.clear()
  }
}

/**
 * @param {unknown} report - value returned by the armed reveal callback.
 * @returns {string} the unchanged predecessor report.
 */
function requireReport(report) {
  if (typeof report !== 'string') {
    throw new BoostRevealError('INVALID_REVEAL_RESULT', 'the armed reveal callback did not return a predecessor report string')
  }
  return report
}

/**
 * Invoke the reveal callback armed for exactly this calling agent.
 * @param {string} agentId - `exec.agent.id` of the calling reviewer.
 * @param {string} initialVerdict - non-empty verdict text from the model.
 * @param {{ name?: string, agent?: { id?: string }, token?: unknown }} [execution] -
 *   the tool execution context when called from the real pipeline.
 * @returns {string} the predecessor worker report returned by the protocol.
 */
export function revealPredecessor(agentId, initialVerdict, execution) {
  const key = requireId(agentId, 'boost_reveal caller agent id')
  const entry = armedReveals.get(key)
  if (entry === undefined) {
    throw new BoostRevealError(
      'REVEAL_NOT_ARMED',
      `boost_reveal is not armed for agent "${key}"; only the reviewer child armed by /boost may call it`,
    )
  }
  if (typeof initialVerdict !== 'string' || initialVerdict.trim().length === 0) {
    throw new BoostRevealError('EMPTY_INITIAL_VERDICT', 'boost_reveal requires a non-empty initialVerdict')
  }

  if (arguments.length < 3) {
    // Pure protocol direct calls omit the execution argument entirely; the
    // synchronous return is the delivery. A present argument, even `undefined`
    // from a Host tool path, must identify the exact Host tool call.
    return requireReport(entry.revealFn(initialVerdict))
  }

  if (execution === null || typeof execution !== 'object') {
    throw new BoostRevealError(
      'INVALID_REVEAL_EXECUTION',
      'boost_reveal delivery requires its tool execution context',
    )
  }
  const token = execution.token
  if (typeof token !== 'symbol') {
    throw new BoostRevealError(
      'REVEAL_EXECUTION_TOKEN_REQUIRED',
      'boost_reveal delivery requires the execution token supplied by the Host; refusing to treat this call as delivered',
    )
  }

  if (execution.name !== 'boost_reveal' || execution.agent?.id !== key) {
    throw new BoostRevealError(
      'INVALID_REVEAL_EXECUTION',
      'boost_reveal delivery requires the execution context of this exact calling agent',
    )
  }
  if (pendingDeliveries.has(token)) {
    throw new BoostRevealError(
      'REVEAL_ALREADY_RECORDED',
      'this boost_reveal execution already has a pending delivery observation',
    )
  }

  const report = requireReport(entry.revealFn(initialVerdict, { deferDelivery: true }))
  pendingDeliveries.set(token, { agentId: key, entry })
  entry.tokens.add(token)
  return report
}

/**
 * Observe the final model-facing result of one tool execution and confirm
 * delivery only for the pending boost_reveal call it belongs to.
 * Never throws: an unrelated or malformed event is simply not a receipt.
 * @param {{ name?: string, agent?: { id?: string }, token?: unknown }} exec - execution context from `tools/result`.
 * @param {{ isError?: boolean, content?: unknown }} result - final frozen tool result.
 * @returns {boolean} whether this observation confirmed the locked verdict's delivery.
 */
export function observeRevealResult(exec, result) {
  const token = exec !== null && typeof exec === 'object' ? exec.token : undefined
  if (typeof token !== 'symbol') return false
  const pending = pendingDeliveries.get(token)
  if (pending === undefined) return false
  if (exec.name !== 'boost_reveal' || exec.agent?.id !== pending.agentId) return false

  pendingDeliveries.delete(token)
  pending.entry.tokens.delete(token)
  const confirmDelivery = pending.entry.revealFn.confirmDelivery
  if (typeof confirmDelivery !== 'function') return false
  try {
    return confirmDelivery({
      agentId: pending.agentId,
      token,
      // DSH rc.5 has no default-success convention: a success result carries
      // isError:false explicitly. Forward the final flag unchanged so a
      // malformed event fails closed instead of being read as success.
      isError: result?.isError,
      content: result?.content,
    }) === true
  } catch {
    return false
  }
}

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
 */

const armedReveals = new Map()

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
 * @param {(initialVerdict: string) => string} revealFn - protocol-owned reveal callback.
 * @returns {() => void} idempotent disposer; it removes only this exact callback.
 */
export function armReveal(childId, revealFn) {
  const key = requireId(childId, 'armReveal() childId')
  if (typeof revealFn !== 'function') {
    throw new BoostRevealError('INVALID_REVEAL_FUNCTION', 'armReveal() requires a reveal function')
  }
  if (armedReveals.has(key)) {
    throw new BoostRevealError('REVEAL_ALREADY_ARMED', `a reveal callback is already armed for child "${key}"`)
  }

  armedReveals.set(key, revealFn)
  let disposed = false

  return function dispose() {
    if (disposed) return
    disposed = true
    if (armedReveals.get(key) === revealFn) armedReveals.delete(key)
  }
}

/**
 * Invoke the reveal callback armed for exactly this calling agent.
 * @param {string} agentId - `exec.agent.id` of the calling reviewer.
 * @param {string} initialVerdict - non-empty verdict text from the model.
 * @returns {string} the predecessor worker report returned by the protocol.
 */
export function revealPredecessor(agentId, initialVerdict) {
  const key = requireId(agentId, 'boost_reveal caller agent id')
  const revealFn = armedReveals.get(key)
  if (revealFn === undefined) {
    throw new BoostRevealError(
      'REVEAL_NOT_ARMED',
      `boost_reveal is not armed for agent "${key}"; only the reviewer child armed by /boost may call it`,
    )
  }
  if (typeof initialVerdict !== 'string' || initialVerdict.trim().length === 0) {
    throw new BoostRevealError('EMPTY_INITIAL_VERDICT', 'boost_reveal requires a non-empty initialVerdict')
  }

  const report = revealFn(initialVerdict)
  if (typeof report !== 'string') {
    throw new BoostRevealError('INVALID_REVEAL_RESULT', 'the armed reveal callback did not return a predecessor report string')
  }
  return report
}

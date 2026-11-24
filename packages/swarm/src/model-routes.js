// Provider/model route admission for Swarm dispatch and quota failover.
//
// This module deliberately mirrors the installed `dsh-tool-subagent` model
// selection rules instead of relying on `llm.prepareCall`: prepareCall proves
// that a provider adapter exists and is configured, not that this root Session
// authorized the route for a child. The durable authorization source is the
// root Session's `subagent/model-selection-policy` event; without one, an
// explicit child route is limited to the parent's current route.
//
// No DSH imports live here so the module stays directly testable.

import { failure, isPlainObject, oneLine } from './host-format.js'

/** Durable Session event written by `dsh-tool-subagent`'s model-selection opt-in. */
export const MODEL_SELECTION_POLICY_EVENT = 'subagent/model-selection-policy'

/** Route error codes surfaced by the Swarm host. */
export const ROUTE_ERRORS = Object.freeze({
  INVALID: 'ROUTE_INVALID',
  NOT_AUTHORIZED: 'ROUTE_NOT_AUTHORIZED',
  POLICY_INVALID: 'ROUTE_POLICY_INVALID',
  POLICY_UNAVAILABLE: 'ROUTE_POLICY_UNAVAILABLE',
  UNAVAILABLE: 'ROUTE_UNAVAILABLE',
})

/**
 * Normalize one `{ provider, model }` route.
 * @param {unknown} value - candidate route, or `"provider/model"`.
 * @param {string} [label] - human name used in failures.
 * @returns {{provider: string, model: string} | null} a detached route, or null when absent.
 */
export function normalizeModelRoute(value, label = 'model route') {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') {
    const slash = value.indexOf('/')
    if (slash <= 0 || slash === value.length - 1) {
      throw failure(ROUTE_ERRORS.INVALID, `${label} must be "provider/model"`)
    }
    return normalizeModelRoute({ provider: value.slice(0, slash), model: value.slice(slash + 1) }, label)
  }
  if (!isPlainObject(value)) {
    throw failure(ROUTE_ERRORS.INVALID, `${label} must be { provider, model }`)
  }
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  if (!provider || !model) {
    throw failure(ROUTE_ERRORS.INVALID, `${label} needs non-empty provider and model`)
  }
  return { provider, model }
}

/** Stable identity of one exact route. */
export function routeKey(route) {
  return route ? `${route.provider}\u0000${route.model}` : ''
}

/** Whether two routes are the same provider and model. */
export function sameModelRoute(left, right) {
  return routeKey(left) !== '' && routeKey(left) === routeKey(right)
}

/** Render a route for diagnostics. */
export function modelRouteLabel(route) {
  return route ? `${route.provider}/${route.model}` : '(none)'
}

/**
 * The root Session's current route, preferring its latest request header (the
 * same source installed delegation uses) and falling back to agent options.
 * @param {any} agent - live root agent.
 * @returns {{provider: string, model: string} | null} current route when known.
 */
export function agentModelRoute(agent) {
  let config
  try {
    config = agent?.session?.requestHeader?.()?.config
  } catch {
    config = undefined
  }
  const fromHeader = normalizeRouteQuietly(config)
  if (fromHeader) return fromHeader
  return normalizeRouteQuietly(agent?.options)
}

function normalizeRouteQuietly(value) {
  if (!isPlainObject(value)) return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  return provider && model ? { provider, model } : null
}

/**
 * Read the durable authorization list from a root Session.
 *
 * Mirrors `subagentModelSelectionPolicy`: the first recorded policy event wins
 * (the projection refuses to overwrite a non-null state), and its absence means
 * "only the parent route".
 * @param {any} session - root Session.
 * @returns {{provider: string, model: string}[] | undefined} detached allowlist, or undefined when no policy was recorded.
 * @throws {HostError} `ROUTE_POLICY_UNAVAILABLE` when the Session cannot be read,
 *   or `ROUTE_POLICY_INVALID` when the recorded policy is malformed.
 */
export function readAllowedModelRoutes(session) {
  if (!session) {
    throw failure(ROUTE_ERRORS.POLICY_UNAVAILABLE, 'the root Session has no readable model-selection policy')
  }
  let events
  try {
    if (typeof session.snapshotEvents === 'function') events = session.snapshotEvents()
    else if (typeof session.eventAt === 'function' && Number.isInteger(session.seq)) {
      events = []
      for (let index = 0; index < session.seq; index += 1) {
        const event = session.eventAt(index)
        if (event !== undefined) events.push(event)
      }
    }
  } catch (error) {
    throw failure(ROUTE_ERRORS.POLICY_UNAVAILABLE, `cannot read the root Session model-selection policy: ${oneLine(error?.message ?? error, 200)}`)
  }
  if (!Array.isArray(events)) {
    throw failure(ROUTE_ERRORS.POLICY_UNAVAILABLE, 'this host cannot expose the root Session event log')
  }
  const recorded = events.find(event => event && event.type === MODEL_SELECTION_POLICY_EVENT)
  if (recorded === undefined) return undefined
  return validatePolicyRoutes(recorded.data?.allowedModels)
}

function validatePolicyRoutes(routes) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw failure(ROUTE_ERRORS.POLICY_INVALID, 'the recorded model-selection policy has no allowed routes')
  }
  const seen = new Set()
  const allowed = []
  for (const raw of routes) {
    if (!isPlainObject(raw)) {
      throw failure(ROUTE_ERRORS.POLICY_INVALID, 'the recorded model-selection policy has an invalid route')
    }
    const keys = Object.keys(raw)
    if (keys.some(key => key !== 'provider' && key !== 'model')) {
      throw failure(ROUTE_ERRORS.POLICY_INVALID, 'the recorded model-selection policy has an unsupported route field')
    }
    let route
    try {
      route = normalizeModelRoute(raw, 'policy route')
    } catch (error) {
      throw failure(ROUTE_ERRORS.POLICY_INVALID, error?.message ?? 'the recorded model-selection policy has an invalid route')
    }
    const key = routeKey(route)
    if (seen.has(key)) {
      throw failure(ROUTE_ERRORS.POLICY_INVALID, 'the recorded model-selection policy repeats a route')
    }
    seen.add(key)
    allowed.push(route)
  }
  return allowed
}

/**
 * Assert that this root Session authorizes one explicit child route.
 * @param {{provider: string, model: string}} route - normalized candidate.
 * @param {{rootAgent: any, label?: string}} options - live root agent and display label.
 * @returns {{provider: string, model: string}} the same route.
 * @throws {HostError} route admission failures; never bypasses a missing policy.
 */
export function assertRouteAllowed(route, { rootAgent, label = 'model route' } = {}) {
  const candidate = normalizeModelRoute(route, label)
  if (!candidate) throw failure(ROUTE_ERRORS.INVALID, `${label} is required`)
  const allowed = readAllowedModelRoutes(rootAgent?.session)
  if (allowed === undefined) {
    const parent = agentModelRoute(rootAgent)
    if (!parent) {
      throw failure(ROUTE_ERRORS.POLICY_UNAVAILABLE, `cannot determine the root Session route, so ${label} "${modelRouteLabel(candidate)}" cannot be authorized`)
    }
    if (!sameModelRoute(parent, candidate)) {
      throw failure(
        ROUTE_ERRORS.NOT_AUTHORIZED,
        `child LLM route "${modelRouteLabel(candidate)}" is not allowed for this Session; without a recorded model-selection policy, explicit selection is limited to the parent route "${modelRouteLabel(parent)}"`,
      )
    }
    return candidate
  }
  if (!allowed.some(entry => sameModelRoute(entry, candidate))) {
    throw failure(
      ROUTE_ERRORS.NOT_AUTHORIZED,
      `child LLM route "${modelRouteLabel(candidate)}" is not in this Session's model-selection allowlist (${allowed.map(modelRouteLabel).join(', ')})`,
    )
  }
  return candidate
}

/**
 * Prove that an authorized route is registered and configured on this host.
 * Uses `llm.resolveCallConfig` (the installed delegation preflight) rather than
 * `prepareCall`, which would bind a dispatch.
 * @param {any} llm - `ctx.get('llm')`.
 * @param {{provider: string, model: string}} route - authorized route.
 * @param {{signal?: AbortSignal, label?: string}} [options] - cancellation and display label.
 * @returns {Promise<void>} resolves when the host accepts the route.
 * @throws {HostError} `ROUTE_UNAVAILABLE` with the underlying provider failure.
 */
export async function assertRouteAvailable(llm, route, { signal, label = 'model route' } = {}) {
  const candidate = normalizeModelRoute(route, label)
  if (!candidate) throw failure(ROUTE_ERRORS.INVALID, `${label} is required`)
  if (!llm || typeof llm.resolveCallConfig !== 'function') {
    throw failure(ROUTE_ERRORS.UNAVAILABLE, `${label} "${modelRouteLabel(candidate)}" cannot be verified: the host does not expose llm.resolveCallConfig`)
  }
  try {
    await llm.resolveCallConfig({ provider: candidate.provider, model: candidate.model }, signal)
  } catch (error) {
    throw failure(
      ROUTE_ERRORS.UNAVAILABLE,
      `${label} "${modelRouteLabel(candidate)}" is not available: ${oneLine(error?.message ?? error, 240)}`,
      { causeCode: typeof error?.code === 'string' ? error.code : undefined },
    )
  }
}

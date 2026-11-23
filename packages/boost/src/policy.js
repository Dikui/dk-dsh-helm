/**
 * Role boundary for the two `/boost` agent presets.
 *
 * Each preset mounts this plugin inside its own preset scope. At that scope it
 * hides every Host-global tool that the role does not allow, then installs a
 * monotonic guard that independently admits only the role's exact tool names.
 * Preset-scope restrictions leave the preset's own tool rows visible; the guard
 * is the execution boundary, so a newly mounted global cannot widen the role.
 *
 * Installation is fail-closed: a failed registration, restriction, or guard
 * throws and breaks the preset mount instead of leaving an agent with broader
 * permissions.
 */

import { BoostRevealError, revealPredecessor } from './reveal.js'

/** Cordis plugin name. */
export const name = 'boost-role'

/** The tool registry this plugin wraps. */
export const inject = ['tools']

/** Exact model-facing tools admitted to the worker preset. */
export const WORKER_ALLOWED_TOOLS = Object.freeze(['read', 'glob', 'grep', 'edit', 'write', 'bash'])

/** Exact model-facing tools admitted to the reviewer preset. */
export const REVIEWER_ALLOWED_TOOLS = Object.freeze(['boost_reveal'])

/** Reserved PTC transport name that `tools.restrict()` refuses to mask. */
const RESERVED_TRANSPORT = 'run_code'

/**
 * @param {unknown} config - preset row config.
 * @returns {'worker' | 'reviewer'} validated role.
 */
function readRole(config) {
  const role = config !== null && typeof config === 'object' ? config.role : undefined
  if (role !== 'worker' && role !== 'reviewer') {
    throw new Error('boost-role: config.role must be "worker" or "reviewer"')
  }
  return role
}

/**
 * @param {string} role - validated role.
 * @param {unknown} cause - failed installation step.
 * @returns {Error} fail-closed installation error.
 */
function integrityError(role, cause) {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new Error(
    `boost-role: /boost ${role} could not install its tool boundary (${detail}). ` +
      `Refusing to start /boost ${role} with broader permissions; check @local/dk-dsh-boost integrity ` +
      '(package exports, preset rows, and tool availability).',
    { cause },
  )
}

/**
 * @param {() => void} [dispose] - optional rollback action.
 */
function rollback(dispose) {
  if (typeof dispose !== 'function') return
  try {
    dispose()
  } catch {
    // Rollback is best-effort; the original installation error is authoritative.
  }
}

/**
 * Define the reviewer-only evidence tool.
 * @returns {object} plain tool definition accepted by `ctx.tools.register`.
 */
function createRevealTool() {
  return {
    name: 'boost_reveal',
    description:
      'Reveal your initial verdict to the Boost orchestrator. Call exactly once, before writing your final report. ' +
      'The first accepted verdict is locked; the tool returns the predecessor worker report.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        initialVerdict: {
          type: 'string',
          description: 'Your initial verdict text. Must be non-empty; the first accepted verdict is locked.',
        },
      },
      required: ['initialVerdict'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agentId = exec?.agent?.id
      if (typeof agentId !== 'string' || agentId.length === 0) {
        throw new BoostRevealError('REVEAL_CALLER_REQUIRED', 'boost_reveal requires a calling agent')
      }
      const initialVerdict = args !== null && typeof args === 'object' ? args.initialVerdict : undefined
      return revealPredecessor(agentId, initialVerdict)
    },
  }
}

/**
 * @param {'worker' | 'reviewer'} role - validated role.
 * @param {ReadonlySet<string>} allowed - exact admitted tool names.
 * @returns {(exec: object) => string | undefined} monotonic tool guard.
 */
function createRoleGuard(role, allowed) {
  const list = [...allowed].join(', ')
  return exec => {
    const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined
    if (agent === undefined || agent === null || typeof agent.id !== 'string' || agent.id.length === 0) {
      return `boost-role: /boost ${role} tools require a calling agent`
    }
    if (typeof exec.name !== 'string' || !allowed.has(exec.name)) {
      return `tool "${String(exec.name)}" is not allowed for /boost ${role} agents (allowed: ${list})`
    }
    return undefined
  }
}

/**
 * Install the preset's tool boundary.
 * @param {object} ctx - preset-scope Cordis context.
 * @param {{ role?: 'worker' | 'reviewer' }} config - preset row config.
 */
export function apply(ctx, config) {
  const role = readRole(config)
  const tools = ctx?.tools
  for (const method of ['register', 'restrict', 'guard', 'definitions']) {
    if (tools === null || typeof tools !== 'object' || typeof tools[method] !== 'function') {
      throw new Error(`boost-role: ctx.tools service with ${method}() is required`)
    }
  }

  const allowed = new Set(role === 'worker' ? WORKER_ALLOWED_TOOLS : REVIEWER_ALLOWED_TOOLS)
  let registered
  let restricted
  let guarded

  try {
    if (role === 'reviewer') {
      try {
        registered = tools.register(createRevealTool())
      } catch (cause) {
        throw integrityError(role, cause)
      }
    }

    try {
      const globals = tools.definitions(undefined)
      if (!Array.isArray(globals)) throw new Error('tools.definitions(undefined) did not return an array')
      const names = [...new Set(globals.map(definition => definition?.name))]
      if (names.some(toolName => typeof toolName !== 'string')) {
        throw new Error('tools.definitions(undefined) returned a tool without a name')
      }
      const deny = names.filter(toolName => toolName !== RESERVED_TRANSPORT && !allowed.has(toolName))
      restricted = tools.restrict({ deny })
    } catch (cause) {
      throw integrityError(role, cause)
    }

    try {
      guarded = tools.guard(createRoleGuard(role, allowed))
    } catch (cause) {
      throw integrityError(role, cause)
    }
  } catch (error) {
    rollback(guarded)
    rollback(restricted)
    rollback(registered)
    throw error
  }
}

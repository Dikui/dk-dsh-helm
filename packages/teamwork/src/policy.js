/**
 * Tool boundary for the Teamwork role presets.
 *
 * Each preset mounts this plugin inside its own preset scope. At that scope it
 * hides every Host-global tool the role does not allow, then installs a
 * monotonic guard that independently admits only the role's exact tool names.
 * Preset-scope restrictions leave the preset's own tool rows visible; the
 * guard is the execution boundary, so a newly mounted global cannot widen the
 * role.
 *
 * This is a tool policy, not an operating-system sandbox. The implementer can
 * write anywhere its own `bash`/`write` tools can reach; its prompt states the
 * intended workspace and asks it to stay there. Reviewers and auditors get no
 * write or shell tool at all, so their read-only property is enforced by this
 * boundary rather than promised by prose.
 *
 * Installation is fail-closed: a failed restriction or guard throws and breaks
 * the preset mount instead of leaving an agent with broader permissions.
 */

/** Cordis plugin name. */
export const name = 'teamwork-role'

/** The tool registry this plugin wraps. */
export const inject = ['tools']

/** Exact model-facing tools admitted to the implementer preset. */
export const IMPLEMENTER_ALLOWED_TOOLS = Object.freeze(['read', 'glob', 'grep', 'edit', 'write', 'bash'])

/** Exact model-facing tools admitted to read-only exploration. */
export const EXPLORER_ALLOWED_TOOLS = Object.freeze(['read', 'glob', 'grep'])

/** Exact model-facing tools admitted to independent verification. */
export const REVIEWER_ALLOWED_TOOLS = Object.freeze(['read', 'glob', 'grep'])

/** Exact model-facing tools admitted to the victory audit. */
export const AUDITOR_ALLOWED_TOOLS = Object.freeze(['read', 'glob', 'grep'])

/** @type {Readonly<Record<string, readonly string[]>>} */
export const ROLE_TOOLS = Object.freeze({
  implementer: IMPLEMENTER_ALLOWED_TOOLS,
  explorer: EXPLORER_ALLOWED_TOOLS,
  reviewer: REVIEWER_ALLOWED_TOOLS,
  auditor: AUDITOR_ALLOWED_TOOLS,
})

/** Reserved PTC transport name that `tools.restrict()` refuses to mask. */
const RESERVED_TRANSPORT = 'run_code'

/**
 * @param {unknown} config - preset row config.
 * @returns {string} validated role.
 */
function readRole(config) {
  const role = config !== null && typeof config === 'object' ? config.role : undefined
  if (typeof role !== 'string' || !Object.hasOwn(ROLE_TOOLS, role)) {
    throw new Error(`teamwork-role: config.role must be one of ${Object.keys(ROLE_TOOLS).join(', ')}`)
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
    `teamwork-role: the ${role} preset could not install its tool boundary (${detail}). ` +
      `Refusing to run with broader permissions; check @local/dk-dsh-teamwork integrity ` +
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
 * @param {string} role - validated role.
 * @param {ReadonlySet<string>} allowed - exact admitted tool names.
 * @returns {(exec: object) => string | undefined} monotonic tool guard.
 */
function createRoleGuard(role, allowed) {
  const list = [...allowed].join(', ')
  return exec => {
    const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined
    if (agent === undefined || agent === null || typeof agent.id !== 'string' || agent.id.length === 0) {
      return `teamwork-role: ${role} tools require a calling agent`
    }
    if (typeof exec.name !== 'string') {
      return `tool "${String(exec.name)}" is not allowed for teamwork ${role} agents (allowed: ${list})`
    }
    if (!allowed.has(exec.name)) {
      return `tool "${exec.name}" is not allowed for teamwork ${role} agents (allowed: ${list})`
    }
    return undefined
  }
}

/**
 * Install the preset's tool boundary.
 * @param {object} ctx - preset-scope Cordis context.
 * @param {{ role?: string }} config - preset row config.
 */
export function apply(ctx, config) {
  const role = readRole(config)
  const tools = ctx?.tools
  for (const method of ['restrict', 'guard', 'definitions']) {
    if (tools === null || typeof tools !== 'object' || typeof tools[method] !== 'function') {
      throw new Error(`teamwork-role: ctx.tools service with ${method}() is required`)
    }
  }

  const allowed = new Set(ROLE_TOOLS[role])
  let restricted
  let guarded

  try {
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
    throw error
  }
}

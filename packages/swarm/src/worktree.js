// Optional per-member git worktrees for Swarm dispatch.
//
// A dispatch stays on the shared workspace by default. The lead may ask this
// service for an independent checkout before spawning a member, then merge the
// member's committed branch back explicitly after the member is inactive.
//
// Safety posture:
// - every git command runs through the DSH subprocess/sandbox seam with a
//   frozen argv (never a shell), hooks/filters/fsmonitor disabled;
// - the optional services are resolved lazily, so the Swarm plugin still loads
//   on hosts that do not provide them (prepare/merge then fail closed);
// - merge is fast-forward only, never forced, never deletes the member branch
//   or worktree, and refuses dirty / stale / active / identity-mismatched state;
// - rollback removes only a clean, registered, identity-matched worktree with a
//   non-force `git worktree remove`; a branch is deleted only when its tip is
//   still exactly the recorded base commit.
import { randomBytes } from 'node:crypto'
import { HostError, isPlainObject, truncateText } from './host-format.js'


export const WORKTREE_RECORD_VERSION = 1

const DEFAULT_CONFIG = Object.freeze({
  directory: '.agents/worktrees/swarm',
  branchPrefix: 'swarm/',
  gitCommand: 'git',
  timeoutMs: 120_000,
  graceMs: 3_000,
  maxOutputBytes: 65_536,
})

const MEMBER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/
const RECORD_ID = /^wt_[0-9a-f]{16}$/
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const BRANCH_TEXT = /^[A-Za-z0-9._/-]+$/
const STATUSES = new Set(['prepared', 'merged', 'rolled-back'])
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])

// Git global options prepended to every command. Hooks are never sourced from
// the user's repository; filters are additionally neutralized per checkout.
const SAFETY_ARGS = Object.freeze(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'])

// Remove inherited repository / attribute / replacement selectors so the
// command can only act on the cwd and argv we supply.
const GIT_ENV = Object.fromEntries([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES', 'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE', 'GIT_ATTR_SOURCE',
].map(key => [key, undefined]))

const SERVICE_CODES = new Set([
  'WORKTREE_UNAVAILABLE', 'SANDBOX_UNAVAILABLE', 'SANDBOX_READ_ONLY', 'GIT_UNAVAILABLE',
  'WORKTREE_TIMEOUT', 'WORKTREE_ABORTED',
])

export class WorktreeError extends HostError {
  constructor(code, message, details = undefined) {
    super(code, message, details)
    this.name = 'WorktreeError'
  }
}

function fail(code, message, details = undefined) {
  return new WorktreeError(code, message, details)
}

function asWorktreeError(error) {
  if (error instanceof WorktreeError) return error
  if (error instanceof HostError) {
    return new WorktreeError(error.code, error.message, isPlainObject(error.details) ? error.details : undefined)
  }
  return new WorktreeError('WORKTREE_FAILED', error instanceof Error ? error.message : String(error))
}

function withDetails(error, details) {
  const base = asWorktreeError(error)
  return new WorktreeError(base.code, base.message, {
    ...(isPlainObject(base.details) ? base.details : {}),
    ...details,
  })
}

function throwIfAborted(signal) {
  if (!signal) return
  if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted()
  else if (signal.aborted) throw new Error('aborted')
}

function assertStringField(record, field) {
  const value = record[field]
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw fail('INVALID_RECORD', `worktree record ${field} must be a non-empty string`, { field })
  }
}

function isAbsolutePath(value) {
  return typeof value === 'string' && !value.includes('\0')
    && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))
}

function lexicalBranch(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || !BRANCH_TEXT.test(value)) return false
  if (value.startsWith('-') || value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.includes('..') || value.includes('@{')) return false
  return !value.split('/').some(part => !part || part === '.' || part === '..')
}

function validateMemberName(value) {
  if (typeof value !== 'string' || !MEMBER_NAME.test(value)) {
    throw fail('INVALID_MEMBER_NAME', 'member name must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/', {
      memberName: typeof value === 'string' ? truncateText(value, 64) : null,
    })
  }
  return value
}

function normalizeConfig(input) {
  const source = input === undefined || input === null ? {} : input
  if (!isPlainObject(source)) throw fail('INVALID_CONFIG', 'worktree config must be an object')
  const config = { ...DEFAULT_CONFIG, ...source }

  const directory = config.directory
  if (typeof directory !== 'string' || directory.length === 0 || directory.length > 240) {
    throw fail('INVALID_CONFIG', 'worktree directory must be a non-empty relative path')
  }
  if (directory.includes('\0') || directory.includes('\\') || directory.startsWith('/') || /^[A-Za-z]:/.test(directory)) {
    throw fail('INVALID_CONFIG', 'worktree directory must stay inside the repository', { directory })
  }
  if (directory.split('/').some(part => !part || part === '.' || part === '..')) {
    throw fail('INVALID_CONFIG', 'worktree directory must not contain empty, "." or ".." segments', { directory })
  }

  const branchPrefix = config.branchPrefix
  if (typeof branchPrefix !== 'string' || branchPrefix.length === 0 || branchPrefix.length > 120) {
    throw fail('INVALID_CONFIG', 'worktree branchPrefix must be a non-empty string')
  }
  if (!BRANCH_TEXT.test(branchPrefix) || branchPrefix.startsWith('-') || branchPrefix.startsWith('/')
    || branchPrefix.includes('..') || branchPrefix.includes('@{')
    || branchPrefix.split('/').some((part, index) => part === '.' || part === '..' || (part === '' && index !== branchPrefix.split('/').length - 1))) {
    throw fail('INVALID_CONFIG', 'worktree branchPrefix must be a valid branch prefix', { branchPrefix })
  }

  const gitCommand = config.gitCommand
  if (typeof gitCommand !== 'string' || gitCommand.length === 0 || gitCommand.includes('\0')) {
    throw fail('INVALID_CONFIG', 'worktree gitCommand must be a non-empty string')
  }

  for (const field of ['timeoutMs', 'graceMs', 'maxOutputBytes']) {
    if (!Number.isSafeInteger(config[field]) || config[field] <= 0) {
      throw fail('INVALID_CONFIG', `worktree ${field} must be a positive integer`, { [field]: config[field] })
    }
  }

  return Object.freeze(config)
}

function normalizeRecord(input) {
  if (!isPlainObject(input)) throw fail('INVALID_RECORD', 'worktree record must be an object')
  const record = { ...input }
  if (record.version !== WORKTREE_RECORD_VERSION) {
    throw fail('INVALID_RECORD', 'unsupported worktree record version', { version: record.version })
  }
  if (typeof record.id !== 'string' || !RECORD_ID.test(record.id)) {
    throw fail('INVALID_RECORD', 'worktree record id is invalid')
  }
  for (const field of ['rootSessionId', 'member', 'repositoryRoot', 'commonDir', 'targetBranch', 'targetHead', 'baseCommit', 'branch', 'path']) {
    assertStringField(record, field)
  }
  if (!MEMBER_NAME.test(record.member)) throw fail('INVALID_RECORD', 'worktree record member is invalid')
  if (!isAbsolutePath(record.repositoryRoot)) throw fail('INVALID_RECORD', 'worktree record repositoryRoot must be absolute')
  if (!isAbsolutePath(record.commonDir)) throw fail('INVALID_RECORD', 'worktree record commonDir must be absolute')
  if (!isAbsolutePath(record.path)) throw fail('INVALID_RECORD', 'worktree record path must be absolute')
  if (!COMMIT.test(record.targetHead) || !COMMIT.test(record.baseCommit)) {
    throw fail('INVALID_RECORD', 'worktree record commit names must be full object names')
  }
  if (!lexicalBranch(record.targetBranch) || !lexicalBranch(record.branch)) {
    throw fail('INVALID_RECORD', 'worktree record branch names are invalid')
  }
  if (!STATUSES.has(record.status)) throw fail('INVALID_RECORD', 'worktree record status is invalid', { status: record.status })
  if (!Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)) {
    throw fail('INVALID_RECORD', 'worktree record timestamps are invalid')
  }
  if (record.memberSessionId !== undefined && record.memberSessionId !== null
    && (typeof record.memberSessionId !== 'string' || record.memberSessionId.length === 0)) {
    throw fail('INVALID_RECORD', 'worktree record memberSessionId is invalid')
  }
  if (record.mergedHead !== undefined && (typeof record.mergedHead !== 'string' || !COMMIT.test(record.mergedHead))) {
    throw fail('INVALID_RECORD', 'worktree record mergedHead is invalid')
  }
  return record
}

function rootSession(rootAgent) {
  const session = rootAgent && typeof rootAgent === 'object' ? rootAgent.session : undefined
  if (!session || typeof session !== 'object' || typeof session.id !== 'string' || session.id.length === 0) {
    throw fail('INVALID_AGENT', 'rootAgent.session.id is required')
  }
  return session
}

function assertRoot(record, rootAgent) {
  const session = rootSession(rootAgent)
  // The binding is the root session id captured by prepare. Callers always pass
  // the current root agent, and a child session can never share that id; the
  // session header is deliberately not used as the primary check.
  if (session.id !== record.rootSessionId) {
    throw fail('NOT_ROOT', 'only the session that prepared this worktree may merge or roll it back', {
      rootSessionId: record.rootSessionId,
    })
  }
}

function assertInactive(active) {
  if (active !== false) {
    throw fail('MEMBER_ACTIVE', 'refusing to change delivery state while the member may still be active; pass active: false after the member is inactive', {
      active: active === undefined ? null : active,
    })
  }
}

function lockKey(value) {
  return `${value.repositoryRoot}\0${value.commonDir}`
}

function statusEntries(fields) {
  return fields.map((field) => {
    if (typeof field !== 'string' || field.length === 0) return field
    if (field.length < 4) return truncateText(field, 160)
    return `${field.slice(0, 2)} ${truncateText(field.slice(3), 160)}`
  })
}

function parseWorktreeFields(fields) {
  const entries = []
  let current = null
  for (const field of fields) {
    if (typeof field !== 'string' || field.length === 0) continue
    const separator = field.indexOf(' ')
    const key = separator < 0 ? field : field.slice(0, separator)
    const value = separator < 0 ? '' : field.slice(separator + 1)
    if (key === 'worktree') {
      if (current) entries.push(current)
      current = { path: value, head: null, branch: null, bare: false, detached: false, locked: false, prunable: false }
      continue
    }
    if (!current) continue
    if (key === 'HEAD') current.head = value
    else if (key === 'branch') current.branch = value
    else if (key === 'bare') current.bare = true
    else if (key === 'detached') current.detached = true
    else if (key === 'locked') current.locked = true
    else if (key === 'prunable') current.prunable = true
  }
  if (current) entries.push(current)
  return entries
}

/**
 * Build the DSH-backed worktree service. No optional service is touched here:
 * a host without sandboxPolicy/subprocess/fs still loads the Swarm plugin, and
 * only a prepare/merge/rollback call reports WORKTREE_UNAVAILABLE.
 */
export function createSwarmWorktrees({ ctx, config, logger } = {}) {
  if (!ctx || typeof ctx !== 'object') throw fail('INVALID_CONTEXT', 'createSwarmWorktrees requires a DSH context')
  const normalized = normalizeConfig(config)
  return new SwarmWorktrees({ host: createDshHost(ctx, normalized, logger), config: normalized, logger })
}

export class SwarmWorktrees {
  constructor({ host, config, logger } = {}) {
    if (!host || typeof host !== 'object') throw fail('INVALID_HOST', 'SwarmWorktrees requires a host adapter')
    this.host = host
    this.config = normalizeConfig(config)
    this.logger = logger
    this.locks = new Map()
  }

  /**
   * Create an independent branch worktree from the lead workspace's current
   * committed HEAD. The caller persists the returned record with the member.
   */
  async prepare({ rootAgent, memberName, memberSessionId = null, signal, onPhase } = {}) {
    const name = validateMemberName(memberName)
    const session = rootSession(rootAgent)
    if (memberSessionId !== null && memberSessionId !== undefined
      && (typeof memberSessionId !== 'string' || memberSessionId.length === 0)) {
      throw fail('INVALID_MEMBER_SESSION', 'memberSessionId must be a non-empty string when provided')
    }
    throwIfAborted(signal)
    const workspace = await this.host.workspace(rootAgent, signal)
    const initial = await this.readRepository(rootAgent, workspace, signal)
    const key = lockKey(initial)
    return this.exclusive(key, async () => {
      const repo = await this.readRepository(rootAgent, workspace, signal)
      if (repo.repositoryRoot !== initial.repositoryRoot || repo.commonDir !== initial.commonDir) {
        throw fail('REPOSITORY_CHANGED', 'the lead repository changed while preparing the worktree')
      }
      const created = { branch: null, path: null }
      try {
        return await this.prepareInRepo({ rootAgent, session, name, memberSessionId: memberSessionId ?? null, repo, signal, onPhase, created })
      } catch (error) {
        const failure = asWorktreeError(error)
        let reaped = { reaped: false, reason: 'not-created' }
        if (created.path && created.branch) {
          reaped = await this.reap({
            rootAgent,
            repositoryRoot: repo.repositoryRoot,
            path: created.path,
            branch: created.branch,
            baseCommit: repo.targetHead,
            signal: signal && !signal.aborted ? signal : undefined,
          })
        }
        throw withDetails(failure, {
          member: name,
          branch: created.branch,
          path: created.path,
          baseCommit: repo.targetHead,
          reaped: reaped.reaped === true,
          retained: reaped.reaped !== true,
          ...(reaped.reason ? { reapReason: reaped.reason } : {}),
          ...(reaped.error ? { reapError: reaped.error } : {}),
        })
      }
    })
  }

  /**
   * Explicitly deliver a prepared member branch into the lead's target branch.
   * Fast-forward only; nothing is removed and the member branch is preserved.
   */
  async merge({ rootAgent, record: rawRecord, active, signal } = {}) {
    const record = normalizeRecord(rawRecord)
    rootSession(rootAgent)
    assertRoot(record, rootAgent)
    assertInactive(active)
    if (record.status === 'merged') {
      return this.exclusive(lockKey(record), async () => {
        const repo = await this.verifyRepository(rootAgent, record, signal)
        const targetHead = await this.resolveCommit(rootAgent, repo.repositoryRoot, `refs/heads/${record.targetBranch}`, signal)
        const mergedHead = record.mergedHead
        if (!mergedHead || !(await this.isAncestor(rootAgent, repo.repositoryRoot, mergedHead, targetHead, signal))) {
          throw fail('TARGET_REWRITTEN', 'the merged member commits are no longer reachable from the target branch', {
            targetBranch: record.targetBranch,
            targetHead,
            mergedHead: mergedHead ?? null,
          })
        }
        return {
          status: 'already-merged',
          strategy: 'none',
          branch: record.branch,
          targetBranch: record.targetBranch,
          previousTargetHead: record.targetHead,
          memberHead: mergedHead,
          targetHead,
          baseCommit: record.baseCommit,
          worktreePath: record.path,
          record,
        }
      })
    }
    if (record.status !== 'prepared') {
      throw fail('ALREADY_TERMINAL', `worktree record is already ${record.status}`, { status: record.status })
    }
    return this.exclusive(lockKey(record), () => this.mergeLocked({ rootAgent, record, signal }))
  }

  /**
   * Remove a prepared worktree that was not delivered. Refuses dirty, locked,
   * unregistered or identity-mismatched state; never forces.
   */
  async rollback({ rootAgent, record: rawRecord, active, reason, signal } = {}) {
    const record = normalizeRecord(rawRecord)
    rootSession(rootAgent)
    assertRoot(record, rootAgent)
    assertInactive(active)
    if (record.status === 'rolled-back') {
      return {
        status: 'already-removed',
        branch: record.branch,
        worktreePath: record.path,
        branchRetained: record.branchRetained === true,
        record,
      }
    }
    if (record.status === 'merged') {
      throw fail('ALREADY_MERGED', 'the member branch was already merged; rollback does not undo a delivery', {
        targetBranch: record.targetBranch,
        branch: record.branch,
      })
    }
    return this.exclusive(lockKey(record), () => this.rollbackLocked({ rootAgent, record, reason, signal }))
  }

  async prepareInRepo({ rootAgent, session, name, memberSessionId, repo, signal, onPhase, created }) {
    await this.host.assertWritable?.(rootAgent, signal)
    const poolPath = await this.host.canonicalPath(rootAgent, this.config.directory, { cwd: repo.repositoryRoot, signal })
    if (poolPath === repo.repositoryRoot || !(await this.host.contains(rootAgent, repo.repositoryRoot, poolPath, { signal }))) {
      throw fail('POOL_OUTSIDE_REPOSITORY', 'the configured worktree pool must stay inside the lead repository', {
        directory: this.config.directory,
        repositoryRoot: repo.repositoryRoot,
        pool: poolPath,
      })
    }
    const poolInfo = await this.host.lstat(rootAgent, poolPath, { signal })
    if (poolInfo && poolInfo.type !== 'directory') {
      throw fail('POOL_UNSAFE', 'the configured worktree pool exists but is not a directory', { pool: poolPath, type: poolInfo.type })
    }

    onPhase?.('prepare')
    await this.ensurePoolIgnore(rootAgent, repo.repositoryRoot, poolPath, signal)
    await this.assertPoolIgnored(rootAgent, repo, signal)

    let lastError = null
    for (let attempt = 0; attempt < 8; attempt += 1) {
      throwIfAborted(signal)
      const suffix = randomBytes(4).toString('hex')
      const branch = `${this.config.branchPrefix}${name}-${suffix}`
      const checkoutName = `${name}-${suffix}`
      if (!lexicalBranch(branch)) {
        throw fail('INVALID_BRANCH_NAME', 'the configured branch prefix produced an invalid branch name', { branch, branchPrefix: this.config.branchPrefix })
      }
      const path = await this.host.canonicalPath(rootAgent, checkoutName, { cwd: poolPath, signal })
      if (path === poolPath || !(await this.host.contains(rootAgent, poolPath, path, { signal }))) {
        throw fail('UNSAFE_PATH', 'resolved worktree path escaped the configured pool', { pool: poolPath, path })
      }
      await this.checkBranchName(rootAgent, repo.repositoryRoot, branch, signal)
      const existing = await this.git(rootAgent, {
        cwd: repo.repositoryRoot,
        args: ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
        allowedExitCodes: [0, 1],
        signal,
      })
      if (existing.exitCode === 0) {
        lastError = fail('BRANCH_EXISTS', 'generated worktree branch already exists', { branch })
        continue
      }
      const info = await this.host.lstat(rootAgent, path, { signal })
      if (info) {
        lastError = fail('PATH_EXISTS', 'generated worktree path already exists', { path })
        continue
      }

      created.branch = branch
      created.path = path
      await this.git(rootAgent, {
        cwd: repo.repositoryRoot,
        args: ['--work-tree', repo.repositoryRoot, 'worktree', 'add', '--no-checkout', '-b', branch, '--', path, repo.targetHead],
        write: true,
        signal,
      })
      onPhase?.('checkout')
      const overrides = await this.filterOverrides(rootAgent, path, signal)
      await this.git(rootAgent, {
        cwd: path,
        args: ['--work-tree', path, 'reset', '--hard', '--no-recurse-submodules', repo.targetHead],
        env: overrides,
        write: true,
        signal,
      })
      await this.verifyPrepared(rootAgent, path, branch, repo.targetHead, signal)

      const now = Date.now()
      return {
        version: WORKTREE_RECORD_VERSION,
        id: `wt_${randomBytes(8).toString('hex')}`,
        rootSessionId: session.id,
        member: name,
        memberSessionId,
        repositoryRoot: repo.repositoryRoot,
        commonDir: repo.commonDir,
        targetBranch: repo.targetBranch,
        targetHead: repo.targetHead,
        baseCommit: repo.targetHead,
        branch,
        path,
        status: 'prepared',
        createdAt: now,
        updatedAt: now,
      }
    }
    throw lastError ?? fail('WORKTREE_COLLISION', 'could not allocate a unique worktree branch and path')
  }

  async mergeLocked({ rootAgent, record, signal }) {
    const repo = await this.verifyRepository(rootAgent, record, signal)
    await this.host.assertWritable?.(rootAgent, signal)
    const repositoryRoot = repo.repositoryRoot
    await this.assertRecordPath(rootAgent, repositoryRoot, record.path, signal)

    const targetHead = await this.resolveCommit(rootAgent, repositoryRoot, `refs/heads/${record.targetBranch}`, signal)
    if (!(await this.isAncestor(rootAgent, repositoryRoot, record.targetHead, targetHead, signal))) {
      throw fail('TARGET_REWRITTEN', 'the target branch no longer contains the commit the worktree was prepared from', {
        targetBranch: record.targetBranch,
        recordedTargetHead: record.targetHead,
        targetHead,
        worktreePath: record.path,
        preserved: true,
      })
    }
    if (!(await this.isAncestor(rootAgent, repositoryRoot, record.baseCommit, targetHead, signal))) {
      throw fail('TARGET_REWRITTEN', 'the target branch no longer contains the worktree base commit', {
        targetBranch: record.targetBranch,
        baseCommit: record.baseCommit,
        targetHead,
        worktreePath: record.path,
        preserved: true,
      })
    }

    const memberExists = await this.git(rootAgent, {
      cwd: repositoryRoot,
      args: ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`],
      allowedExitCodes: [0, 1],
      signal,
    })
    if (memberExists.exitCode !== 0) {
      throw fail('BRANCH_MISSING', 'the member branch no longer exists', { branch: record.branch, worktreePath: record.path })
    }
    const memberHead = await this.resolveCommit(rootAgent, repositoryRoot, `refs/heads/${record.branch}`, signal)

    const entries = await this.listWorktrees(rootAgent, repositoryRoot, signal)
    const memberEntry = entries.find(entry => entry.path === record.path)
    const pathInfo = await this.host.lstat(rootAgent, record.path, { signal })
    if (!memberEntry) {
      if (pathInfo) {
        throw fail('WORKTREE_UNREGISTERED', 'the recorded worktree path exists but is not registered with git', {
          worktreePath: record.path,
          preserved: true,
        })
      }
      throw fail('WORKTREE_MISSING', 'the recorded worktree is no longer registered', {
        worktreePath: record.path,
        branch: record.branch,
        preserved: true,
      })
    }
    if (!pathInfo) {
      throw fail('WORKTREE_MISSING', 'the registered worktree directory is missing', {
        worktreePath: record.path,
        branch: record.branch,
        preserved: true,
      })
    }
    if (memberEntry.detached || memberEntry.bare) {
      throw fail('WORKTREE_STALE', 'the registered worktree is not on the recorded branch', {
        worktreePath: record.path,
        branch: record.branch,
        preserved: true,
      })
    }
    if (memberEntry.branch !== `refs/heads/${record.branch}`) {
      throw fail('WORKTREE_STALE', 'the registered worktree branch does not match the record', {
        worktreePath: record.path,
        expectedBranch: record.branch,
        registeredBranch: memberEntry.branch,
        preserved: true,
      })
    }
    if (memberEntry.head !== memberHead) {
      throw fail('WORKTREE_STALE', 'the registered worktree HEAD does not match the member branch', {
        worktreePath: record.path,
        branch: record.branch,
        worktreeHead: memberEntry.head,
        branchHead: memberHead,
        preserved: true,
      })
    }
    if (memberEntry.locked) {
      throw fail('WORKTREE_LOCKED', 'the member worktree is locked', { worktreePath: record.path, preserved: true })
    }
    if (memberEntry.prunable) {
      throw fail('WORKTREE_STALE', 'git reports the member worktree as prunable', { worktreePath: record.path, preserved: true })
    }

    const targetRef = `refs/heads/${record.targetBranch}`
    const targetEntries = entries.filter(entry => entry.branch === targetRef)
    if (targetEntries.length !== 1) {
      throw fail('TARGET_NOT_CHECKED_OUT', 'the target branch must be checked out in exactly one worktree', {
        targetBranch: record.targetBranch,
        worktrees: targetEntries.length,
        preserved: true,
      })
    }
    const targetEntry = targetEntries[0]
    if (targetEntry.path !== repositoryRoot) {
      throw fail('TARGET_NOT_CHECKED_OUT', 'the target branch is checked out somewhere other than the lead workspace', {
        targetBranch: record.targetBranch,
        repositoryRoot,
        targetWorktree: targetEntry.path,
        preserved: true,
      })
    }
    if (targetEntry.detached || targetEntry.bare) {
      throw fail('TARGET_STATE_INVALID', 'the lead worktree is not on a branch', { repositoryRoot, preserved: true })
    }
    if (targetEntry.locked) {
      throw fail('TARGET_LOCKED', 'the lead worktree is locked', { repositoryRoot, preserved: true })
    }
    if (targetEntry.prunable) {
      throw fail('WORKTREE_STALE', 'git reports the lead worktree as prunable', { repositoryRoot, preserved: true })
    }

    const mergeHead = await this.git(rootAgent, {
      cwd: repositoryRoot,
      args: ['rev-parse', '--git-path', 'MERGE_HEAD'],
      signal,
    })
    const mergeHeadPath = await this.host.canonicalPath(rootAgent, mergeHead.stdout.trim(), { cwd: repositoryRoot, signal })
    if (await this.host.lstat(rootAgent, mergeHeadPath, { signal })) {
      throw fail('TARGET_MERGE_IN_PROGRESS', 'the lead repository has a merge in progress', { repositoryRoot, preserved: true })
    }

    const memberStatus = await this.scanStatus(rootAgent, record.path, signal, 20)
    if (memberStatus.fields.length > 0) {
      throw fail('WORKTREE_DIRTY', 'the member worktree has uncommitted changes; commit or discard them before merging', {
        worktreePath: record.path,
        entries: statusEntries(memberStatus.fields),
        count: memberStatus.fields.length,
        truncated: memberStatus.truncated,
        preserved: true,
      })
    }
    const targetStatus = await this.scanStatus(rootAgent, repositoryRoot, signal, 20)
    if (targetStatus.fields.length > 0) {
      throw fail('TARGET_DIRTY', 'the lead workspace has uncommitted changes; commit or stash them before merging', {
        repositoryRoot,
        entries: statusEntries(targetStatus.fields),
        count: targetStatus.fields.length,
        truncated: targetStatus.truncated,
        preserved: true,
      })
    }

    if (memberHead === targetHead) {
      return this.finishAlready({ record, targetHead, memberHead })
    }
    if (await this.isAncestor(rootAgent, repositoryRoot, targetHead, memberHead, signal)) {
      return this.mergeFastForward({ rootAgent, record, repo, targetHead, memberHead, signal })
    }
    if (await this.isAncestor(rootAgent, repositoryRoot, memberHead, targetHead, signal)) {
      return this.finishAlready({ record, targetHead, memberHead })
    }

    const mergeBase = (await this.git(rootAgent, {
      cwd: repositoryRoot,
      args: ['merge-base', targetHead, memberHead],
      signal,
    })).stdout.trim()
    const ahead = Number((await this.git(rootAgent, {
      cwd: repositoryRoot,
      args: ['rev-list', '--count', `${targetHead}..${memberHead}`],
      signal,
    })).stdout.trim())
    const behind = Number((await this.git(rootAgent, {
      cwd: repositoryRoot,
      args: ['rev-list', '--count', `${memberHead}..${targetHead}`],
      signal,
    })).stdout.trim())
    throw fail('NOT_FAST_FORWARD', 'the member branch and target branch have diverged; a fast-forward merge is not possible', {
      branch: record.branch,
      targetBranch: record.targetBranch,
      targetHead,
      memberHead,
      baseCommit: record.baseCommit,
      mergeBase,
      ahead: Number.isFinite(ahead) ? ahead : null,
      behind: Number.isFinite(behind) ? behind : null,
      worktreePath: record.path,
      preserved: true,
      manual: {
        summary: 'Nothing was changed and the member worktree/branch are preserved. Integrate manually, then retry or roll back.',
        steps: [
          {
            description: 'Merge the member branch in the lead workspace and resolve conflicts there.',
            argv: ['git', '-C', repositoryRoot, 'merge', '--no-ff', `refs/heads/${record.branch}`],
          },
          {
            description: 'Or rebase the member branch onto the target branch, then retry the fast-forward delivery.',
            argv: ['git', '-C', record.path, 'rebase', `refs/heads/${record.targetBranch}`],
          },
          {
            description: 'Or cherry-pick the member commits.',
            argv: ['git', '-C', repositoryRoot, 'cherry-pick', `${record.baseCommit}..refs/heads/${record.branch}`],
          },
        ],
      },
    })
  }

  finishAlready({ record, targetHead, memberHead }) {
    const now = Date.now()
    const updated = { ...record, status: 'merged', mergedHead: memberHead, mergedAt: now, updatedAt: now }
    return {
      status: 'already-merged',
      strategy: 'none',
      branch: record.branch,
      targetBranch: record.targetBranch,
      previousTargetHead: targetHead,
      memberHead,
      targetHead,
      baseCommit: record.baseCommit,
      worktreePath: record.path,
      record: updated,
    }
  }

  async mergeFastForward({ rootAgent, record, repo, targetHead, memberHead, signal }) {
    const overrides = await this.filterOverrides(rootAgent, repo.repositoryRoot, signal)
    try {
      await this.git(rootAgent, {
        cwd: repo.repositoryRoot,
        args: ['merge', '--ff-only', '--no-stat', '--no-overwrite-ignore', `refs/heads/${record.branch}`],
        env: overrides,
        write: true,
        signal,
      })
    } catch (error) {
      const current = await this.resolveCommitOrNull(rootAgent, repo.repositoryRoot, `refs/heads/${record.targetBranch}`, signal)
      if (current === targetHead) {
        const failure = asWorktreeError(error)
        throw fail('MERGE_FAILED', 'the fast-forward merge was refused; the lead workspace and member branch are unchanged', {
          branch: record.branch,
          targetBranch: record.targetBranch,
          targetHead,
          memberHead,
          worktreePath: record.path,
          targetHeadUnchanged: true,
          preserved: true,
          cause: truncateText(failure.message, 300),
          stderr: isPlainObject(failure.details) && typeof failure.details.stderr === 'string'
            ? truncateText(failure.details.stderr, 2_000)
            : null,
        })
      }
      throw fail('MERGE_INCONSISTENT', 'the target branch moved while a fast-forward merge failed; inspect it by hand', {
        branch: record.branch,
        targetBranch: record.targetBranch,
        expectedTargetHead: targetHead,
        currentTargetHead: current,
        memberHead,
        worktreePath: record.path,
        preserved: true,
      })
    }

    const newHead = await this.resolveCommit(rootAgent, repo.repositoryRoot, `refs/heads/${record.targetBranch}`, signal)
    if (newHead !== memberHead) {
      throw fail('MERGE_INCONSISTENT', 'the merge completed but the target branch tip is not the member branch tip', {
        branch: record.branch,
        targetBranch: record.targetBranch,
        targetHead: newHead,
        memberHead,
        worktreePath: record.path,
      })
    }
    const targetStatus = await this.scanStatus(rootAgent, repo.repositoryRoot, signal, 1)
    if (targetStatus.fields.length > 0) {
      throw fail('MERGE_INCONSISTENT', 'the fast-forward merge completed but the lead workspace is not clean', {
        targetBranch: record.targetBranch,
        targetHead: newHead,
        entries: statusEntries(targetStatus.fields),
        worktreePath: record.path,
      })
    }
    const now = Date.now()
    const updated = { ...record, status: 'merged', mergedHead: memberHead, mergedAt: now, updatedAt: now }
    return {
      status: 'merged',
      strategy: 'ff-only',
      branch: record.branch,
      targetBranch: record.targetBranch,
      previousTargetHead: targetHead,
      memberHead,
      targetHead: newHead,
      baseCommit: record.baseCommit,
      worktreePath: record.path,
      record: updated,
    }
  }

  async rollbackLocked({ rootAgent, record, reason, signal }) {
    await this.host.assertWritable?.(rootAgent, signal)
    const workspace = await this.host.workspace(rootAgent, signal)
    const repo = await this.readRepository(rootAgent, workspace, signal)
    if (repo.repositoryRoot !== record.repositoryRoot || repo.commonDir !== record.commonDir) {
      throw fail('REPOSITORY_MISMATCH', 'the lead workspace is not the repository recorded by the worktree', {
        recordedRepositoryRoot: record.repositoryRoot,
        recordedCommonDir: record.commonDir,
        repositoryRoot: repo.repositoryRoot,
        commonDir: repo.commonDir,
      })
    }
    const path = await this.assertRecordPath(rootAgent, repo.repositoryRoot, record.path, signal)
    const entries = await this.listWorktrees(rootAgent, repo.repositoryRoot, signal)
    const entry = entries.find(candidate => candidate.path === path)
    const info = await this.host.lstat(rootAgent, path, { signal })

    if (!entry) {
      if (info) {
        throw fail('WORKTREE_UNREGISTERED', 'the recorded worktree path exists but is not registered with git', {
          worktreePath: path,
          preserved: true,
        })
      }
      const branchRetained = (await this.git(rootAgent, {
        cwd: repo.repositoryRoot,
        args: ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`],
        allowedExitCodes: [0, 1],
        signal,
      })).exitCode === 0
      return this.finishRollback(record, {
        status: 'already-removed',
        repositoryRoot: repo.repositoryRoot,
        worktreePath: path,
        branchRetained,
        branchDeleted: false,
        reason,
      })
    }
    if (!info) {
      throw fail('WORKTREE_MISSING', 'the registered worktree directory is missing; run `git worktree prune` after checking it by hand', {
        worktreePath: path,
        branch: record.branch,
        preserved: true,
      })
    }
    if (entry.detached || entry.bare || entry.branch !== `refs/heads/${record.branch}`) {
      throw fail('WORKTREE_STALE', 'the registered worktree does not match the recorded branch', {
        worktreePath: path,
        expectedBranch: record.branch,
        registeredBranch: entry.branch,
        preserved: true,
      })
    }
    if (entry.locked) {
      throw fail('WORKTREE_LOCKED', 'the member worktree is locked; unlock it explicitly before rollback', {
        worktreePath: path,
        preserved: true,
      })
    }
    if (entry.prunable) {
      throw fail('WORKTREE_STALE', 'git reports the member worktree as prunable', { worktreePath: path, preserved: true })
    }

    const memberStatus = await this.scanStatus(rootAgent, path, signal, 20)
    if (memberStatus.fields.length > 0) {
      throw fail('WORKTREE_DIRTY', 'the member worktree has uncommitted changes; rollback will not remove or clean it', {
        worktreePath: path,
        entries: statusEntries(memberStatus.fields),
        count: memberStatus.fields.length,
        truncated: memberStatus.truncated,
        preserved: true,
      })
    }

    try {
      await this.git(rootAgent, {
        cwd: repo.repositoryRoot,
        args: ['worktree', 'remove', '--', path],
        write: true,
        signal,
      })
    } catch (error) {
      const failure = asWorktreeError(error)
      throw fail('ROLLBACK_FAILED', 'git refused to remove the worktree; it was left in place', {
        worktreePath: path,
        branch: record.branch,
        preserved: true,
        cause: truncateText(failure.message, 300),
        stderr: isPlainObject(failure.details) && typeof failure.details.stderr === 'string'
          ? truncateText(failure.details.stderr, 2_000)
          : null,
      })
    }

    let branchRetained = false
    let branchDeleted = false
    try {
      const exists = await this.git(rootAgent, {
        cwd: repo.repositoryRoot,
        args: ['show-ref', '--verify', '--quiet', `refs/heads/${record.branch}`],
        allowedExitCodes: [0, 1],
        signal,
      })
      if (exists.exitCode === 0) {
        const branchHead = await this.resolveCommit(rootAgent, repo.repositoryRoot, `refs/heads/${record.branch}`, signal)
        if (branchHead === record.baseCommit) {
          await this.git(rootAgent, {
            cwd: repo.repositoryRoot,
            args: ['branch', '-d', '--', record.branch],
            write: true,
            signal,
          })
          branchDeleted = true
        } else {
          branchRetained = true
        }
      }
    } catch (error) {
      branchRetained = true
    }

    return this.finishRollback(record, {
      status: 'removed',
      repositoryRoot: repo.repositoryRoot,
      worktreePath: path,
      branchRetained,
      branchDeleted,
      reason,
    })
  }

  finishRollback(record, { status, repositoryRoot, worktreePath, branchRetained, branchDeleted, reason }) {
    const now = Date.now()
    const updated = {
      ...record,
      status: 'rolled-back',
      branchRetained,
      rolledBackAt: now,
      updatedAt: now,
      ...(typeof reason === 'string' && reason.length > 0 ? { rollbackReason: truncateText(reason, 200) } : {}),
    }
    return {
      status,
      branch: record.branch,
      branchRetained,
      branchDeleted,
      worktreePath,
      repositoryRoot,
      recovery: branchRetained
        ? {
          branch: record.branch,
          worktreePath,
          steps: [
            { description: 'The branch has commits beyond the recorded base, so it was preserved. Restore its worktree here:', argv: ['git', '-C', repositoryRoot, 'worktree', 'add', worktreePath, `refs/heads/${record.branch}`] },
            { description: 'Or delete it explicitly after checking its commits:', argv: ['git', '-C', repositoryRoot, 'branch', '-D', '--', record.branch] },
          ],
        }
        : null,
      record: updated,
    }
  }

  /**
   * Best-effort cleanup for a worktree this call created. It only acts on a
   * registered, identity-matched, unlocked and clean worktree, and it does not
   * touch an unregistered branch.
   */
  async reap({ rootAgent, repositoryRoot, path, branch, baseCommit, signal }) {
    try {
      const entries = await this.listWorktrees(rootAgent, repositoryRoot, signal)
      const entry = entries.find(candidate => candidate.path === path)
      if (!entry) return { reaped: false, reason: 'not-registered' }
      if (entry.detached || entry.bare || entry.branch !== `refs/heads/${branch}`) {
        return { reaped: false, reason: 'identity-mismatch' }
      }
      if (entry.locked || entry.prunable) return { reaped: false, reason: 'locked-or-prunable' }
      const status = await this.scanStatus(rootAgent, path, signal, 1)
      if (status.fields.length > 0) return { reaped: false, reason: 'dirty' }
      await this.git(rootAgent, {
        cwd: repositoryRoot,
        args: ['worktree', 'remove', '--', path],
        write: true,
        signal,
      })
      let branchDeleted = false
      try {
        const exists = await this.git(rootAgent, {
          cwd: repositoryRoot,
          args: ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
          allowedExitCodes: [0, 1],
          signal,
        })
        if (exists.exitCode === 0) {
          const head = await this.resolveCommit(rootAgent, repositoryRoot, `refs/heads/${branch}`, signal)
          if (head === baseCommit) {
            await this.git(rootAgent, {
              cwd: repositoryRoot,
              args: ['branch', '-d', '--', branch],
              write: true,
              signal,
            })
            branchDeleted = true
          }
        }
      } catch (error) {
        return { reaped: true, branchDeleted, error: truncateText(error?.message, 200) }
      }
      return { reaped: true, branchDeleted }
    } catch (error) {
      return { reaped: false, reason: 'cleanup-failed', error: truncateText(error?.message, 200) }
    }
  }

  async readRepository(rootAgent, cwd, signal) {
    let inside
    try {
      inside = await this.git(rootAgent, {
        cwd,
        args: ['rev-parse', '--is-inside-work-tree'],
        allowedExitCodes: [0, 1],
        signal,
      })
    } catch (error) {
      throw this.repositoryFailure(error, cwd, signal)
    }
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
      throw fail('NOT_A_GIT_REPOSITORY', 'the lead workspace is not inside a git work tree', { cwd })
    }
    const bare = await this.git(rootAgent, {
      cwd,
      args: ['rev-parse', '--is-bare-repository'],
      allowedExitCodes: [0, 1],
      signal,
    })
    if (bare.stdout.trim() === 'true') {
      throw fail('NOT_A_GIT_REPOSITORY', 'bare repositories are not supported', { cwd })
    }
    const top = (await this.git(rootAgent, { cwd, args: ['rev-parse', '--show-toplevel'], signal })).stdout.trim()
    if (!top) throw fail('NOT_A_GIT_REPOSITORY', 'git did not report a work tree root', { cwd })
    const repositoryRoot = await this.host.canonicalPath(rootAgent, top, { signal })
    const commonRaw = (await this.git(rootAgent, {
      cwd: repositoryRoot,
      args: ['rev-parse', '--git-common-dir'],
      signal,
    })).stdout.trim()
    if (!commonRaw) throw fail('NOT_A_GIT_REPOSITORY', 'git did not report a common directory', { cwd })
    const commonDir = await this.host.canonicalPath(rootAgent, commonRaw, { cwd: repositoryRoot, signal })
    const branch = await this.git(rootAgent, {
      cwd: repositoryRoot,
      args: ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      allowedExitCodes: [0, 1],
      signal,
    })
    if (branch.exitCode !== 0) {
      throw fail('TARGET_BRANCH_REQUIRED', 'the lead workspace is on a detached HEAD; check out a branch before preparing a worktree', {
        repositoryRoot,
      })
    }
    const targetBranch = branch.stdout.trim()
    if (!lexicalBranch(targetBranch)) {
      throw fail('TARGET_BRANCH_REQUIRED', 'the lead workspace branch name is not usable', { repositoryRoot })
    }
    let headRes
    try {
      headRes = await this.git(rootAgent, {
        cwd: repositoryRoot,
        args: ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
        signal,
      })
    } catch (error) {
      if (error && SERVICE_CODES.has(error.code)) throw asWorktreeError(error)
      throw fail('TARGET_HEAD_MISSING', 'the lead branch has no committed HEAD to base a worktree on', {
        repositoryRoot,
        targetBranch,
        cause: truncateText(error?.message, 200),
      })
    }
    const targetHead = headRes.stdout.trim()
    if (!COMMIT.test(targetHead)) {
      throw fail('TARGET_HEAD_MISSING', 'git returned an unexpected HEAD object name', { repositoryRoot, targetHead })
    }
    return { repositoryRoot, commonDir, targetBranch, targetHead, workspace: cwd }
  }

  async verifyRepository(rootAgent, record, signal) {
    const workspace = await this.host.workspace(rootAgent, signal)
    const repo = await this.readRepository(rootAgent, workspace, signal)
    if (repo.repositoryRoot !== record.repositoryRoot || repo.commonDir !== record.commonDir) {
      throw fail('REPOSITORY_MISMATCH', 'the lead workspace is not the repository recorded by the worktree', {
        recordedRepositoryRoot: record.repositoryRoot,
        recordedCommonDir: record.commonDir,
        repositoryRoot: repo.repositoryRoot,
        commonDir: repo.commonDir,
      })
    }
    if (repo.targetBranch !== record.targetBranch) {
      throw fail('TARGET_BRANCH_CHANGED', 'the lead workspace is no longer on the recorded target branch', {
        recordedTargetBranch: record.targetBranch,
        targetBranch: repo.targetBranch,
      })
    }
    return repo
  }

  async assertRecordPath(rootAgent, repositoryRoot, recordPath, signal) {
    const poolPath = await this.host.canonicalPath(rootAgent, this.config.directory, { cwd: repositoryRoot, signal })
    if (poolPath === repositoryRoot || !(await this.host.contains(rootAgent, repositoryRoot, poolPath, { signal }))) {
      throw fail('POOL_OUTSIDE_REPOSITORY', 'the configured worktree pool is outside the lead repository', { pool: poolPath })
    }
    const path = await this.host.canonicalPath(rootAgent, recordPath, { signal })
    if (path !== recordPath || path === poolPath || !(await this.host.contains(rootAgent, poolPath, path, { signal }))) {
      throw fail('UNSAFE_PATH', 'the recorded worktree path is not inside the configured pool', { pool: poolPath, path: recordPath })
    }
    return path
  }

  async ensurePoolIgnore(rootAgent, repositoryRoot, poolPath, signal) {
    const ignorePath = await this.host.canonicalPath(rootAgent, `${this.config.directory}/.gitignore`, { cwd: repositoryRoot, signal })
    if (ignorePath === poolPath || !(await this.host.contains(rootAgent, poolPath, ignorePath, { signal }))) {
      throw fail('UNSAFE_PATH', 'the pool .gitignore path escaped the worktree pool', { pool: poolPath, path: ignorePath })
    }
    const info = await this.host.lstat(rootAgent, ignorePath, { signal })
    if (info && info.type !== 'file') {
      throw fail('POOL_UNSAFE', 'the pool .gitignore exists but is not a regular file', { path: ignorePath, type: info.type })
    }
    if (!info) await this.host.writeText(rootAgent, ignorePath, '*\n', { signal })
  }

  async assertPoolIgnored(rootAgent, repo, signal) {
    const status = await this.scanStatus(rootAgent, repo.repositoryRoot, signal, 1, this.config.directory)
    if (status.fields.length > 0) {
      throw fail('POOL_NOT_IGNORED', 'the configured worktree pool is not ignored by git; refusing to make the lead workspace dirty', {
        pool: this.config.directory,
        entries: statusEntries(status.fields),
      })
    }
  }

  async verifyPrepared(rootAgent, path, branch, baseCommit, signal) {
    const head = (await this.git(rootAgent, {
      cwd: path,
      args: ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'],
      signal,
    })).stdout.trim()
    if (head !== baseCommit) {
      throw fail('WORKTREE_VERIFY_FAILED', 'the new worktree HEAD does not match the recorded base commit', {
        worktreePath: path,
        expectedHead: baseCommit,
        head,
      })
    }
    const symbolic = (await this.git(rootAgent, {
      cwd: path,
      args: ['symbolic-ref', '--quiet', 'HEAD'],
      signal,
    })).stdout.trim()
    if (symbolic !== `refs/heads/${branch}`) {
      throw fail('WORKTREE_VERIFY_FAILED', 'the new worktree is not on the recorded branch', {
        worktreePath: path,
        expectedBranch: branch,
        head: symbolic,
      })
    }
  }

  async checkBranchName(rootAgent, cwd, branch, signal) {
    const result = await this.git(rootAgent, {
      cwd,
      args: ['check-ref-format', `refs/heads/${branch}`],
      allowedExitCodes: [0, 1],
      signal,
    })
    if (result.exitCode !== 0) {
      throw fail('INVALID_BRANCH_NAME', 'the generated worktree branch name is not accepted by git', { branch })
    }
  }

  async filterOverrides(rootAgent, cwd, signal) {
    const configured = await this.git(rootAgent, {
      cwd,
      args: ['config', '--null', '--name-only', '--get-regexp', '^filter\\.'],
      allowedExitCodes: [0, 1],
      signal,
    })
    const drivers = new Set()
    for (const key of configured.stdout.split('\0')) {
      const separator = key.lastIndexOf('.')
      if (separator > 'filter.'.length && ['clean', 'smudge', 'process', 'required'].includes(key.slice(separator + 1))) {
        drivers.add(key.slice('filter.'.length, separator))
      }
    }
    const overrides = { GIT_CONFIG_COUNT: String(drivers.size * 4) }
    let index = 0
    for (const driver of drivers) {
      for (const attribute of ['clean', 'smudge', 'process', 'required']) {
        overrides[`GIT_CONFIG_KEY_${index}`] = `filter.${driver}.${attribute}`
        overrides[`GIT_CONFIG_VALUE_${index}`] = attribute === 'required' ? 'false' : ''
        index += 1
      }
    }
    return overrides
  }

  async listWorktrees(rootAgent, repositoryRoot, signal) {
    const fields = []
    const stopped = await this.host.scan(rootAgent, {
      cwd: repositoryRoot,
      args: [...SAFETY_ARGS, 'worktree', 'list', '--porcelain', '-z'],
      signal,
      onField(field) {
        fields.push(field)
        return true
      },
    })
    if (stopped) throw fail('GIT_FAILED', 'git worktree list was stopped unexpectedly')
    const entries = parseWorktreeFields(fields)
    for (const entry of entries) {
      entry.path = await this.host.canonicalPath(rootAgent, entry.path, { signal })
    }
    return entries
  }

  async scanStatus(rootAgent, cwd, signal, max = 20, pathspec = null) {
    const fields = []
    const args = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']
    if (pathspec) args.push('--', pathspec)
    const stopped = await this.host.scan(rootAgent, {
      cwd,
      args: [...SAFETY_ARGS, ...args],
      signal,
      onField(field) {
        if (!field) return true
        fields.push(field)
        return fields.length < max
      },
    })
    return { fields, truncated: stopped }
  }

  async resolveCommit(rootAgent, cwd, ref, signal) {
    const result = await this.git(rootAgent, {
      cwd,
      args: ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
      signal,
    })
    const commit = result.stdout.trim()
    if (!COMMIT.test(commit)) throw fail('GIT_FAILED', 'git returned an unexpected commit object name', { ref, commit })
    return commit
  }

  async resolveCommitOrNull(rootAgent, cwd, ref, signal) {
    const exists = await this.git(rootAgent, {
      cwd,
      args: ['show-ref', '--verify', '--quiet', ref],
      allowedExitCodes: [0, 1],
      signal,
    })
    if (exists.exitCode !== 0) return null
    try {
      return await this.resolveCommit(rootAgent, cwd, ref, signal)
    } catch {
      return null
    }
  }

  async isAncestor(rootAgent, cwd, ancestor, descendant, signal) {
    const result = await this.git(rootAgent, {
      cwd,
      args: ['merge-base', '--is-ancestor', ancestor, descendant],
      allowedExitCodes: [0, 1],
      signal,
    })
    return result.exitCode === 0
  }

  async git(rootAgent, { cwd, args, allowedExitCodes = [0], env = {}, signal, write = false }) {
    return this.host.run(rootAgent, {
      cwd,
      args: [...SAFETY_ARGS, ...args],
      allowedExitCodes,
      env,
      signal,
      write,
    })
  }

  repositoryFailure(error, cwd, signal) {
    if (signal && signal.aborted) return fail('WORKTREE_ABORTED', 'worktree operation was aborted', { cwd })
    if (error && SERVICE_CODES.has(error.code)) return asWorktreeError(error)
    return fail('NOT_A_GIT_REPOSITORY', 'the lead workspace is not inside a git work tree', {
      cwd,
      cause: truncateText(error?.message, 200),
    })
  }

  async exclusive(key, body) {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const operation = previous.then(() => body())
    const tail = operation.then(() => {}, () => {})
    this.locks.set(key, tail)
    try {
      return await operation
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }
}

function createDshHost(ctx, config, logger) {
  const getService = (name) => {
    try {
      if (typeof ctx.get === 'function') return ctx.get(name)
      return ctx[name]
    } catch {
      return undefined
    }
  }
  const need = (name) => {
    const service = getService(name)
    if (!service) {
      throw fail('WORKTREE_UNAVAILABLE', `worktree delivery requires the DSH ${name} service`, { service: name })
    }
    return service
  }
  const policyFor = async (rootAgent) => {
    const sandboxPolicy = need('sandboxPolicy')
    let policy
    try {
      policy = await sandboxPolicy.resolve({ session: rootAgent.session })
    } catch (error) {
      throw fail('WORKTREE_UNAVAILABLE', 'the DSH sandbox policy could not be resolved for the lead session', {
        service: 'sandboxPolicy',
        cause: truncateText(error?.message, 200),
      })
    }
    if (!policy || typeof policy !== 'object' || typeof policy.mode !== 'string' || !SANDBOX_MODES.has(policy.mode)) {
      throw fail('WORKTREE_UNAVAILABLE', 'the DSH sandbox policy did not provide a supported mode', { service: 'sandboxPolicy' })
    }
    return policy
  }
  const abortFailure = (signal, timeoutSignal, fallbackCode) => {
    if (signal && signal.aborted) return fail('WORKTREE_ABORTED', 'worktree operation was aborted')
    if (timeoutSignal && timeoutSignal.aborted) return fail('WORKTREE_TIMEOUT', 'the git command exceeded the worktree timeout', { code: fallbackCode })
    return null
  }

  const host = {
    async workspace(rootAgent, signal) {
      const workingDirectory = getService('workingDirectory')
      if (workingDirectory && typeof workingDirectory.ensure === 'function') {
        let cwd
        try {
          cwd = await workingDirectory.ensure(rootAgent, signal)
        } catch (error) {
          if (signal && signal.aborted) throw fail('WORKTREE_ABORTED', 'worktree operation was aborted')
          throw fail('CWD_UNAVAILABLE', 'the lead workspace could not be resolved', { cause: truncateText(error?.message, 200) })
        }
        if (typeof cwd === 'string' && cwd.length > 0) return cwd
        throw fail('CWD_UNAVAILABLE', 'the lead workspace is not available')
      }
      if (workingDirectory && typeof workingDirectory.get === 'function') {
        try {
          const cwd = await workingDirectory.get(rootAgent.session)
          if (typeof cwd === 'string' && cwd.length > 0) return cwd
        } catch {
          // fall through to the session header
        }
      }
      const cwd = rootAgent?.session?.header?.cwd
      if (typeof cwd === 'string' && cwd.length > 0) return cwd
      throw fail('CWD_UNAVAILABLE', 'the lead workspace is not available')
    },

    async assertWritable(rootAgent) {
      const policy = await policyFor(rootAgent)
      if (policy.mode === 'read-only') {
        throw fail('SANDBOX_READ_ONLY', 'the lead session is read-only; worktree delivery needs write access')
      }
      return policy
    },

    async canonicalPath(rootAgent, path, { cwd, signal } = {}) {
      const fs = need('fs')
      const target = await fs.resolve(path, { cwd, signal })
      return fs.processPath(target)
    },

    async contains(rootAgent, parent, child, { signal } = {}) {
      const fs = need('fs')
      const parentTarget = await fs.resolve(parent, { signal })
      const childTarget = await fs.resolve(child, { signal })
      return fs.contains(parentTarget, childTarget)
    },

    async lstat(rootAgent, path, { cwd, signal } = {}) {
      const fs = need('fs')
      const info = await fs.lstat(path, cwd ? { cwd } : undefined, signal)
      return info ? { type: info.type, version: info.version } : undefined
    },

    async writeText(rootAgent, path, text, { cwd, signal } = {}) {
      const fs = need('fs')
      const policy = await policyFor(rootAgent)
      if (policy.mode === 'read-only') {
        throw fail('SANDBOX_READ_ONLY', 'the lead session is read-only; worktree delivery needs write access')
      }
      const target = await fs.resolve(path, { cwd, signal })
      await fs.writeText(target, text, undefined, signal, policy)
    },

    async run(rootAgent, { cwd, args, allowedExitCodes = [0], env = {}, signal, write = false }) {
      const policy = await policyFor(rootAgent)
      if (write && policy.mode === 'read-only') {
        throw fail('SANDBOX_READ_ONLY', 'the lead session is read-only; worktree delivery needs write access')
      }
      const subprocess = need('subprocess')
      const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
      const timeout = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      throwIfAborted(timeout)
      let program
      let child
      try {
        program = await subprocess.resolveExecutable(config.gitCommand, undefined, timeout)
        throwIfAborted(timeout)
      } catch (error) {
        const aborted = abortFailure(signal, timeoutSignal)
        if (aborted) throw aborted
        throw fail('GIT_UNAVAILABLE', `could not resolve the git executable "${config.gitCommand}"`, {
          cause: truncateText(error?.message, 200),
        })
      }
      let wrapped
      try {
        wrapped = policy.mode === 'danger-full-access'
          ? [program, ...args]
          : (await need('sandbox').confine([program, ...args], { ...policy, mode: policy.mode }, timeout)).argv
        throwIfAborted(timeout)
      } catch (error) {
        const aborted = abortFailure(signal, timeoutSignal)
        if (aborted) throw aborted
        if (error instanceof WorktreeError) throw error
        throw fail('SANDBOX_UNAVAILABLE', 'the DSH sandbox could not confine the git command', {
          cause: truncateText(error?.message, 200),
        })
      }
      try {
        child = await subprocess.spawn({
          argv: wrapped,
          cwd,
          env: {
            ...GIT_ENV,
            GIT_TERMINAL_PROMPT: '0',
            GIT_LFS_SKIP_SMUDGE: '1',
            GIT_NO_LAZY_FETCH: '1',
            ...env,
          },
          signal: timeout,
          graceMs: config.graceMs,
          stdio: { stdin: 'ignore', stdout: { maxBytes: config.maxOutputBytes }, stderr: { maxBytes: config.maxOutputBytes } },
        })
      } catch (error) {
        const aborted = abortFailure(signal, timeoutSignal)
        if (aborted) throw aborted
        throw fail('GIT_FAILED', 'could not spawn the git command', { cause: truncateText(error?.message, 200) })
      }
      try {
        const outcome = await child.done
        const aborted = abortFailure(signal, timeoutSignal)
        if (aborted) throw aborted
        const stderr = child.collected.stderr.readFrom(0)
        if (outcome.exitCode === null || !allowedExitCodes.includes(outcome.exitCode)) {
          throw fail('GIT_FAILED', `git ${args[0] ?? 'command'} failed (${outcome.signal ?? outcome.exitCode})`, {
            exitCode: outcome.exitCode,
            signal: outcome.signal ?? null,
            stderr: truncateText(stderr.text.trim(), 2_000),
          })
        }
        const stdout = child.collected.stdout.readFrom(0)
        if (stdout.lossy) throw fail('GIT_OUTPUT_LIMIT', 'git command output exceeded maxOutputBytes', { arg: args[0] ?? null })
        return { stdout: stdout.text, stderr: stderr.text, exitCode: outcome.exitCode }
      } catch (error) {
        if (error instanceof WorktreeError) throw error
        const aborted = abortFailure(signal, timeoutSignal)
        if (aborted) throw aborted
        throw fail('GIT_FAILED', `git ${args[0] ?? 'command'} failed`, { cause: truncateText(error?.message, 500) })
      } finally {
        child.terminate()
        await child.waitForExit().catch(() => {})
      }
    },

    async scan(rootAgent, { cwd, args, env = {}, signal, onField }) {
      const policy = await policyFor(rootAgent)
      const subprocess = need('subprocess')
      const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
      const timeout = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      throwIfAborted(timeout)
      let program
      let child
      try {
        program = await subprocess.resolveExecutable(config.gitCommand, undefined, timeout)
        const wrapped = policy.mode === 'danger-full-access'
          ? [program, ...args]
          : (await need('sandbox').confine([program, ...args], { ...policy, mode: policy.mode }, timeout)).argv
        throwIfAborted(timeout)
        child = await subprocess.spawn({
          argv: wrapped,
          cwd,
          env: {
            ...GIT_ENV,
            GIT_TERMINAL_PROMPT: '0',
            GIT_LFS_SKIP_SMUDGE: '1',
            GIT_NO_LAZY_FETCH: '1',
            ...env,
          },
          signal: timeout,
          graceMs: config.graceMs,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: { maxBytes: config.maxOutputBytes } },
        })
      } catch (error) {
        const aborted = abortFailure(signal, timeoutSignal)
        if (aborted) throw aborted
        if (error instanceof WorktreeError) throw error
        throw fail('GIT_FAILED', 'could not start the git scan command', { cause: truncateText(error?.message, 200) })
      }
      try {
        const stdout = child.stdout
        if (!stdout) throw fail('GIT_FAILED', 'git scan command has no stdout pipe')
        stdout.setEncoding('utf8')
        let pending = ''
        let stopped = false
        for await (const chunk of stdout) {
          const fields = (pending + chunk).split('\0')
          pending = fields.pop() ?? ''
          for (const field of fields) {
            if (onField(field) === false) {
              stopped = true
              break
            }
          }
          if (stopped) break
        }
        if (stopped) {
          child.terminate()
          await Promise.allSettled([child.done])
          const aborted = abortFailure(signal, timeoutSignal)
          if (aborted) throw aborted
          return true
        }
        const outcome = await child.done
        const aborted = abortFailure(signal, timeoutSignal)
        if (aborted) throw aborted
        const stderr = child.collected.stderr.readFrom(0)
        if (outcome.exitCode !== 0) {
          throw fail('GIT_FAILED', `git ${args[0] ?? 'command'} failed (${outcome.signal ?? outcome.exitCode})`, {
            exitCode: outcome.exitCode,
            stderr: truncateText(stderr.text.trim(), 2_000),
          })
        }
        // An unterminated remainder is intentionally ignored, as in the native
        // worktree scanner.
        return false
      } catch (error) {
        child.terminate()
        await Promise.allSettled([child.done])
        if (error instanceof WorktreeError) throw error
        const aborted = abortFailure(signal, timeoutSignal)
        if (aborted) throw aborted
        throw fail('GIT_FAILED', `git ${args[0] ?? 'command'} failed`, { cause: truncateText(error?.message, 500) })
      } finally {
        child.terminate()
        await child.waitForExit().catch(() => {})
      }
    },
  }
  void logger
  return host
}

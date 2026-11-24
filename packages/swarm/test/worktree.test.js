// Dedicated tests for the optional per-member worktree service. Every scenario
// runs against a real temporary git repository through a host adapter that
// mirrors the DSH fs/subprocess seams; git itself is never mocked.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SwarmWorktrees,
  WorktreeError,
  createSwarmWorktrees,
} from '../src/worktree.js'

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
}

function gitEnv(extra = {}) {
  const merged = { ...process.env, ...GIT_ENV, ...extra }
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => typeof value === 'string'))
}

function runGit(cwd, args, { allowed = [0], env } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: gitEnv(env),
  })
  if (result.error) throw result.error
  if (!allowed.includes(result.status)) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr}`)
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status }
}

function gitOrNull(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: gitEnv(),
  })
  return result.status === 0 ? (result.stdout ?? '').trim() : null
}

function commitFile(dir, relative, content, { force = false } = {}) {
  const file = path.join(dir, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  runGit(dir, force ? ['add', '-f', '--', relative] : ['add', '--', relative])
  runGit(dir, ['commit', '-q', '-m', `write ${relative}`])
  return file
}

function canonical(input) {
  let current = path.resolve(input)
  const tail = []
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...tail.reverse())
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(input)
      tail.push(path.basename(current))
      current = parent
    }
  }
}

function lstatType(target) {
  const stat = fs.lstatSync(target)
  if (stat.isDirectory()) return 'directory'
  if (stat.isFile()) return 'file'
  if (stat.isSymbolicLink()) return 'symlink'
  return 'other'
}

// Mirrors the production DSH host contract (run/scan/canonicalPath/contains/
// lstat/writeText/workspace/assertWritable) over real processes and files.
function makeHost(repo) {
  const host = {
    async workspace() {
      return repo
    },
    async assertWritable() {},
    async canonicalPath(_agent, target, { cwd } = {}) {
      return canonical(cwd ? path.resolve(cwd, target) : target)
    },
    async contains(_agent, parent, child) {
      const root = canonical(parent)
      const target = canonical(child)
      return target === root || target.startsWith(`${root}${path.sep}`)
    },
    async lstat(_agent, target) {
      try {
        return { type: lstatType(canonical(target)), version: 'test' }
      } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
    },
    async writeText(_agent, target, text) {
      const file = canonical(target)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
    },
    async run(_agent, { cwd, args, allowedExitCodes = [0], env = {} }) {
      const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: gitEnv(env),
      })
      if (result.error) {
        throw new WorktreeError('GIT_UNAVAILABLE', 'git could not start', { cause: result.error.message })
      }
      if (!allowedExitCodes.includes(result.status)) {
        throw new WorktreeError('GIT_FAILED', `git ${args[0] ?? 'command'} failed`, {
          exitCode: result.status,
          stderr: (result.stderr ?? '').trim(),
        })
      }
      return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status }
    },
    async scan(_agent, { cwd, args, env = {}, onField }) {
      const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        env: gitEnv(env),
      })
      if (result.error) throw new WorktreeError('GIT_UNAVAILABLE', 'git could not start', { cause: result.error.message })
      if (result.status !== 0) {
        throw new WorktreeError('GIT_FAILED', `git ${args[0] ?? 'command'} failed`, {
          exitCode: result.status,
          stderr: (result.stderr ?? '').trim(),
        })
      }
      const fields = (result.stdout ?? '').split('\0')
      for (const field of fields) {
        if (!field) continue
        if (onField(field) === false) return true
      }
      return false
    },
  }
  return host
}

function makeRepo(t) {
  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-swarm-wt-')))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  runGit(repo, ['init', '-q', '-b', 'main'])
  runGit(repo, ['config', 'user.name', 'Swarm Test'])
  runGit(repo, ['config', 'user.email', 'swarm@example.invalid'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n')
  runGit(repo, ['add', '--', 'a.txt'])
  runGit(repo, ['commit', '-q', '-m', 'base'])
  return repo
}

function setup(t, { repo: provided, config } = {}) {
  const repo = provided ?? makeRepo(t)
  const agent = { session: { id: 'root-session', header: { cwd: repo } } }
  const host = makeHost(repo)
  const service = new SwarmWorktrees({ host, config })
  return { repo, agent, host, service }
}

function status(repo) {
  return runGit(repo, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.trim()
}

function branchExists(repo, branch) {
  return spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo }).status === 0
}

test('prepare creates a clean independent worktree and self-ignores the pool', async (t) => {
  const { repo, agent, service } = setup(t)
  const base = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim()

  const record = await service.prepare({ rootAgent: agent, memberName: 'alpha', memberSessionId: 'child-1' })

  assert.equal(record.version, 1)
  assert.match(record.id, /^wt_[0-9a-f]{16}$/)
  assert.equal(record.rootSessionId, 'root-session')
  assert.equal(record.member, 'alpha')
  assert.equal(record.memberSessionId, 'child-1')
  assert.equal(record.status, 'prepared')
  assert.equal(record.baseCommit, base)
  assert.equal(record.targetHead, base)
  assert.equal(record.targetBranch, 'main')
  assert.match(record.branch, /^swarm\/alpha-[0-9a-f]{8}$/)
  assert.equal(record.repositoryRoot, repo)
  assert.equal(record.path, path.join(repo, '.agents', 'worktrees', 'swarm', path.basename(record.path)))
  assert.ok(record.path.startsWith(path.join(repo, '.agents', 'worktrees', 'swarm') + path.sep))

  assert.equal(fs.readFileSync(path.join(repo, '.agents', 'worktrees', 'swarm', '.gitignore'), 'utf8'), '*\n')
  assert.equal(status(repo), '')
  assert.equal(fs.readFileSync(path.join(record.path, 'a.txt'), 'utf8'), 'base\n')
  assert.equal(runGit(record.path, ['rev-parse', 'HEAD']).stdout.trim(), base)
  assert.equal(runGit(record.path, ['symbolic-ref', '--short', 'HEAD']).stdout.trim(), record.branch)
  assert.equal(status(record.path), '')
  assert.match(runGit(repo, ['worktree', 'list', '--porcelain']).stdout, new RegExp(record.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('prepare leaves existing user data and an existing pool .gitignore untouched', async (t) => {
  const { repo, agent, service } = setup(t)
  commitFile(repo, '.gitignore', '*.log\n')
  fs.mkdirSync(path.join(repo, '.agents', 'worktrees', 'swarm'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.agents', 'worktrees', 'swarm', '.gitignore'), '*\n# keep this file\n')
  fs.writeFileSync(path.join(repo, 'untracked-user.txt'), 'keep\n')
  fs.writeFileSync(path.join(repo, 'ignored-user.log'), 'keep\n')

  const record = await service.prepare({ rootAgent: agent, memberName: 'alpha' })

  assert.equal(fs.readFileSync(path.join(repo, '.agents', 'worktrees', 'swarm', '.gitignore'), 'utf8'), '*\n# keep this file\n')
  assert.equal(fs.readFileSync(path.join(repo, 'untracked-user.txt'), 'utf8'), 'keep\n')
  assert.equal(fs.readFileSync(path.join(repo, 'ignored-user.log'), 'utf8'), 'keep\n')
  assert.equal(status(repo), '?? untracked-user.txt')
  assert.equal(status(record.path), '')
})

test('prepare rejects names and config that could inject paths or arguments', async (t) => {
  const { repo, agent, service } = setup(t)
  for (const memberName of ['../evil', 'a/b', '-dash', 'a b', 'a\0b', 'x'.repeat(33), '']) {
    await assert.rejects(
      service.prepare({ rootAgent: agent, memberName }),
      error => error instanceof WorktreeError && error.code === 'INVALID_MEMBER_NAME',
      `member ${JSON.stringify(memberName)} must be rejected`,
    )
  }
  assert.equal(status(repo), '')
  assert.throws(() => new SwarmWorktrees({ host: makeHost(repo), config: { directory: '../escape' } }), error => error.code === 'INVALID_CONFIG')
  assert.throws(() => new SwarmWorktrees({ host: makeHost(repo), config: { branchPrefix: '-evil' } }), error => error.code === 'INVALID_CONFIG')
  assert.throws(() => new SwarmWorktrees({ host: makeHost(repo), config: { directory: '/tmp/absolute' } }), error => error.code === 'INVALID_CONFIG')
})

test('prepare fails closed outside git and on a detached lead HEAD', async (t) => {
  const plain = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-swarm-nogit-')))
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }))
  const plainService = new SwarmWorktrees({ host: makeHost(plain) })
  await assert.rejects(
    plainService.prepare({ rootAgent: { session: { id: 'root-session', header: { cwd: plain } } }, memberName: 'alpha' }),
    error => error.code === 'NOT_A_GIT_REPOSITORY',
  )

  const { repo, agent, service } = setup(t)
  runGit(repo, ['checkout', '-q', '--detach'])
  await assert.rejects(
    service.prepare({ rootAgent: agent, memberName: 'alpha' }),
    error => error.code === 'TARGET_BRANCH_REQUIRED',
  )
})

test('prepare rejects an unsafe pool and a pool that git would see as dirty', async (t) => {
  const { repo, agent, service } = setup(t)
  fs.mkdirSync(path.join(repo, '.agents', 'worktrees'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.agents', 'worktrees', 'swarm'), 'not a directory\n')
  await assert.rejects(
    service.prepare({ rootAgent: agent, memberName: 'alpha' }),
    error => error.code === 'POOL_UNSAFE' && error.details.type === 'file',
  )
  assert.equal(fs.readFileSync(path.join(repo, '.agents', 'worktrees', 'swarm'), 'utf8'), 'not a directory\n')

  fs.rmSync(path.join(repo, '.agents', 'worktrees', 'swarm'))
  fs.mkdirSync(path.join(repo, '.agents', 'worktrees', 'swarm'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.agents', 'worktrees', 'swarm', '.gitignore'), '')
  await assert.rejects(
    service.prepare({ rootAgent: agent, memberName: 'alpha' }),
    error => error.code === 'POOL_NOT_IGNORED',
  )
  assert.equal(gitOrNull(repo, ['worktree', 'list', '--porcelain']).split('\n\n').length, 1)
})

test('prepare failure reaps only a clean registered worktree and deletes its base-only branch', async (t) => {
  const { repo, agent } = setup(t)
  const baseHost = makeHost(repo)
  const host = {
    ...baseHost,
    async run(agentArg, spec) {
      if (spec.cwd !== repo && spec.cwd.includes(path.join('.agents', 'worktrees', 'swarm'))
        && spec.args.includes('symbolic-ref')) {
        throw new WorktreeError('GIT_FAILED', 'scripted verification failure', {})
      }
      return baseHost.run(agentArg, spec)
    },
  }
  const service = new SwarmWorktrees({ host })

  await assert.rejects(
    service.prepare({ rootAgent: agent, memberName: 'alpha' }),
    (error) => {
      assert.equal(error.code, 'GIT_FAILED')
      assert.equal(error.details.reaped, true)
      assert.equal(error.details.retained, false)
      assert.equal(fs.existsSync(error.details.path), false)
      assert.equal(branchExists(repo, error.details.branch), false)
      return true
    },
  )
  assert.equal(status(repo), '')
  assert.equal(runGit(repo, ['worktree', 'list', '--porcelain']).stdout.trim().split('\n\n').length, 1)
})

test('prepare failure preserves a dirty worktree instead of cleaning user work', async (t) => {
  const { repo, agent } = setup(t)
  const baseHost = makeHost(repo)
  const host = {
    ...baseHost,
    async run(agentArg, spec) {
      if (spec.cwd !== repo && spec.cwd.includes(path.join('.agents', 'worktrees', 'swarm'))
        && spec.args.includes('symbolic-ref')) {
        fs.writeFileSync(path.join(spec.cwd, 'dirty.txt'), 'do not lose me\n')
        throw new WorktreeError('GIT_FAILED', 'scripted verification failure', {})
      }
      return baseHost.run(agentArg, spec)
    },
  }
  const service = new SwarmWorktrees({ host })

  await assert.rejects(
    service.prepare({ rootAgent: agent, memberName: 'alpha' }),
    (error) => {
      assert.equal(error.details.reaped, false)
      assert.equal(error.details.retained, true)
      assert.equal(error.details.reapReason, 'dirty')
      assert.equal(fs.readFileSync(path.join(error.details.path, 'dirty.txt'), 'utf8'), 'do not lose me\n')
      assert.equal(branchExists(repo, error.details.branch), true)
      return true
    },
  )
})

test('prepare failure preserves ignored artifacts instead of deleting them during reap', async (t) => {
  const { repo, agent } = setup(t)
  commitFile(repo, '.gitignore', '.env\ncache/\n')
  const baseHost = makeHost(repo)
  const host = {
    ...baseHost,
    async run(agentArg, spec) {
      if (spec.cwd !== repo && spec.cwd.includes(path.join('.agents', 'worktrees', 'swarm'))
        && spec.args.includes('symbolic-ref')) {
        fs.writeFileSync(path.join(spec.cwd, '.env'), 'SECRET=keep-me\n')
        throw new WorktreeError('GIT_FAILED', 'scripted verification failure', {})
      }
      return baseHost.run(agentArg, spec)
    },
  }
  const service = new SwarmWorktrees({ host })

  await assert.rejects(
    service.prepare({ rootAgent: agent, memberName: 'alpha' }),
    (error) => {
      assert.equal(error.details.reaped, false)
      assert.equal(error.details.retained, true)
      assert.equal(error.details.reapReason, 'ignored')
      assert.equal(fs.readFileSync(path.join(error.details.path, '.env'), 'utf8'), 'SECRET=keep-me\n')
      assert.equal(branchExists(repo, error.details.branch), true)
      return true
    },
  )
})

test('merge fast-forwards the target branch and preserves the member worktree and branch', async (t) => {
  const { repo, agent, service } = setup(t)
  const record = await service.prepare({ rootAgent: agent, memberName: 'alpha' })
  const before = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim()
  commitFile(record.path, 'feature.txt', 'delivered\n')

  const result = await service.merge({ rootAgent: agent, record, active: false })

  assert.equal(result.status, 'merged')
  assert.equal(result.strategy, 'ff-only')
  assert.equal(result.previousTargetHead, before)
  assert.equal(result.targetBranch, 'main')
  assert.equal(result.memberHead, result.targetHead)
  assert.notEqual(result.targetHead, before)
  assert.equal(result.record.status, 'merged')
  assert.equal(result.record.mergedHead, result.memberHead)
  assert.equal(fs.readFileSync(path.join(repo, 'feature.txt'), 'utf8'), 'delivered\n')
  assert.equal(status(repo), '')
  assert.equal(runGit(repo, ['rev-parse', 'HEAD']).stdout.trim(), result.memberHead)
  assert.equal(fs.existsSync(record.path), true)
  assert.equal(fs.readFileSync(path.join(record.path, 'feature.txt'), 'utf8'), 'delivered\n')
  assert.equal(runGit(repo, ['rev-parse', `refs/heads/${record.branch}`]).stdout.trim(), result.memberHead)

  const again = await service.merge({ rootAgent: agent, record: result.record, active: false })
  assert.equal(again.status, 'already-merged')
  assert.equal(again.strategy, 'none')
})

test('merge delivers the verified memberHead even when the branch moves before the merge command', async (t) => {
  const repo = makeRepo(t)
  const agent = { session: { id: 'root-session', header: { cwd: repo } } }
  const baseHost = makeHost(repo)
  let record = null
  let moved = false
  const host = {
    ...baseHost,
    async run(agentArg, spec) {
      if (!moved && spec.args.includes('merge') && spec.args.includes('--ff-only')) {
        moved = true
        commitFile(record.path, 'late.txt', 'late\n')
      }
      return baseHost.run(agentArg, spec)
    },
  }
  const service = new SwarmWorktrees({ host })
  record = await service.prepare({ rootAgent: agent, memberName: 'alpha' })
  commitFile(record.path, 'feature.txt', 'delivered\n')
  const verifiedHead = runGit(repo, ['rev-parse', `refs/heads/${record.branch}`]).stdout.trim()

  const result = await service.merge({ rootAgent: agent, record, active: false })

  assert.equal(result.status, 'merged')
  assert.equal(result.strategy, 'ff-only')
  assert.equal(result.memberHead, verifiedHead)
  assert.equal(result.targetHead, verifiedHead)
  assert.equal(result.branchMoved, true)
  assert.notEqual(result.memberBranchHead, verifiedHead)
  assert.equal(result.memberBranchHead, runGit(repo, ['rev-parse', `refs/heads/${record.branch}`]).stdout.trim())
  // The verified commit was delivered; the later branch commit was not.
  assert.equal(fs.readFileSync(path.join(repo, 'feature.txt'), 'utf8'), 'delivered\n')
  assert.equal(fs.existsSync(path.join(repo, 'late.txt')), false)
  assert.equal(fs.readFileSync(path.join(record.path, 'late.txt'), 'utf8'), 'late\n')
  assert.equal(status(repo), '')
})

test('merge refuses active or non-root callers without touching the repository', async (t) => {
  const { repo, agent, service } = setup(t)
  const record = await service.prepare({ rootAgent: agent, memberName: 'alpha' })
  const before = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim()

  for (const active of [true, undefined, 'false', 0]) {
    await assert.rejects(
      service.merge({ rootAgent: agent, record, active }),
      error => error.code === 'MEMBER_ACTIVE',
    )
  }
  await assert.rejects(
    service.merge({ rootAgent: { session: { id: 'child-session' } }, record, active: false }),
    error => error.code === 'NOT_ROOT' && error.details.rootSessionId === 'root-session',
  )
  assert.equal(runGit(repo, ['rev-parse', 'HEAD']).stdout.trim(), before)
  assert.equal(status(repo), '')
  assert.equal(fs.existsSync(record.path), true)
})

test('merge refuses dirty member and dirty lead workspaces and preserves both', async (t) => {
  const { repo, agent, service } = setup(t)
  const record = await service.prepare({ rootAgent: agent, memberName: 'alpha' })
  const before = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim()
  fs.writeFileSync(path.join(record.path, 'uncommitted.txt'), 'member work\n')

  await assert.rejects(
    service.merge({ rootAgent: agent, record, active: false }),
    (error) => {
      assert.equal(error.code, 'WORKTREE_DIRTY')
      assert.equal(error.details.preserved, true)
      assert.match(error.details.entries[0], /uncommitted\.txt/)
      return true
    },
  )
  assert.equal(fs.readFileSync(path.join(record.path, 'uncommitted.txt'), 'utf8'), 'member work\n')
  assert.equal(runGit(repo, ['rev-parse', 'HEAD']).stdout.trim(), before)

  commitFile(record.path, 'uncommitted.txt', 'member work committed\n')
  fs.writeFileSync(path.join(repo, 'lead-only.txt'), 'lead work\n')
  await assert.rejects(
    service.merge({ rootAgent: agent, record, active: false }),
    (error) => {
      assert.equal(error.code, 'TARGET_DIRTY')
      assert.equal(error.details.preserved, true)
      assert.match(error.details.entries[0], /lead-only\.txt/)
      return true
    },
  )
  assert.equal(fs.readFileSync(path.join(repo, 'lead-only.txt'), 'utf8'), 'lead work\n')
  assert.equal(runGit(repo, ['rev-parse', 'HEAD']).stdout.trim(), before)
})

test('merge never overwrites an ignored lead file that the member also adds', async (t) => {
  const { repo, agent, service } = setup(t)
  commitFile(repo, '.gitignore', '*.log\n')
  const record = await service.prepare({ rootAgent: agent, memberName: 'alpha' })
  commitFile(record.path, 'same.log', 'member log\n', { force: true })
  fs.writeFileSync(path.join(repo, 'same.log'), 'lead log\n')
  const before = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim()

  await assert.rejects(
    service.merge({ rootAgent: agent, record, active: false }),
    (error) => {
      assert.equal(error.code, 'MERGE_FAILED')
      assert.equal(error.details.targetHeadUnchanged, true)
      assert.equal(error.details.preserved, true)
      return true
    },
  )
  assert.equal(fs.readFileSync(path.join(repo, 'same.log'), 'utf8'), 'lead log\n')
  assert.equal(runGit(repo, ['rev-parse', 'HEAD']).stdout.trim(), before)
  assert.equal(branchExists(repo, record.branch), true)
  assert.equal(fs.existsSync(record.path), true)
})

test('merge returns NOT_FAST_FORWARD for divergent parallel deliveries and preserves the loser', async (t) => {
  const { repo, agent, service } = setup(t)
  const first = await service.prepare({ rootAgent: agent, memberName: 'alpha' })
  const second = await service.prepare({ rootAgent: agent, memberName: 'beta' })
  commitFile(first.path, 'alpha.txt', 'alpha\n')
  commitFile(second.path, 'beta.txt', 'beta\n')

  const delivered = await service.merge({ rootAgent: agent, record: first, active: false })
  const betaHead = runGit(repo, ['rev-parse', `refs/heads/${second.branch}`]).stdout.trim()

  await assert.rejects(
    service.merge({ rootAgent: agent, record: second, active: false }),
    (error) => {
      assert.equal(error.code, 'NOT_FAST_FORWARD')
      assert.equal(error.details.preserved, true)
      assert.equal(error.details.targetHead, delivered.targetHead)
      assert.equal(error.details.memberHead, betaHead)
      assert.equal(error.details.ahead, 1)
      assert.ok(error.details.behind >= 1)
      assert.equal(error.details.manual.steps.length, 3)
      assert.ok(error.details.manual.steps.every(step => Array.isArray(step.argv) && step.argv[0] === 'git'))
      return true
    },
  )
  assert.equal(runGit(repo, ['rev-parse', `refs/heads/${second.branch}`]).stdout.trim(), betaHead)
  assert.equal(fs.readFileSync(path.join(second.path, 'beta.txt'), 'utf8'), 'beta\n')
  assert.equal(fs.existsSync(first.path), true)
})

test('merge rejects stale, locked, changed-target and in-progress states', async (t) => {
  const { repo, agent, service } = setup(t)
  const stale = await service.prepare({ rootAgent: agent, memberName: 'stale' })
  runGit(stale.path, ['checkout', '-q', '--detach'])
  await assert.rejects(
    service.merge({ rootAgent: agent, record: stale, active: false }),
    error => error.code === 'WORKTREE_STALE' && error.details.preserved === true,
  )

  const locked = await service.prepare({ rootAgent: agent, memberName: 'locked' })
  runGit(repo, ['worktree', 'lock', locked.path])
  try {
    await assert.rejects(
      service.merge({ rootAgent: agent, record: locked, active: false }),
      error => error.code === 'WORKTREE_LOCKED' && error.details.preserved === true,
    )
  } finally {
    runGit(repo, ['worktree', 'unlock', locked.path])
  }

  const changed = await service.prepare({ rootAgent: agent, memberName: 'changed' })
  runGit(repo, ['checkout', '-q', '-b', 'other'])
  try {
    await assert.rejects(
      service.merge({ rootAgent: agent, record: changed, active: false }),
      error => error.code === 'TARGET_BRANCH_CHANGED',
    )
  } finally {
    runGit(repo, ['checkout', '-q', 'main'])
  }

  const merging = await service.prepare({ rootAgent: agent, memberName: 'merging' })
  const mergeHeadPath = path.join(repo, runGit(repo, ['rev-parse', '--git-path', 'MERGE_HEAD']).stdout.trim())
  fs.writeFileSync(mergeHeadPath, runGit(repo, ['rev-parse', 'HEAD']).stdout.trim() + '\n')
  try {
    await assert.rejects(
      service.merge({ rootAgent: agent, record: merging, active: false }),
      error => error.code === 'TARGET_MERGE_IN_PROGRESS' && error.details.preserved === true,
    )
  } finally {
    fs.rmSync(mergeHeadPath, { force: true })
  }
})

test('merge refuses a target branch that was rewritten since prepare', async (t) => {
  const { repo, agent, service } = setup(t)
  const record = await service.prepare({ rootAgent: agent, memberName: 'alpha' })
  fs.writeFileSync(path.join(repo, 'rewritten.txt'), 'rewrite\n')
  runGit(repo, ['add', '--', 'rewritten.txt'])
  runGit(repo, ['commit', '-q', '--amend', '-m', 'rewritten base'])

  await assert.rejects(
    service.merge({ rootAgent: agent, record, active: false }),
    error => error.code === 'TARGET_REWRITTEN' && error.details.preserved === true,
  )
  assert.equal(fs.existsSync(record.path), true)
})

test('rollback removes a clean base-only worktree and its branch without force', async (t) => {
  const { repo, agent, service } = setup(t)
  const record = await service.prepare({ rootAgent: agent, memberName: 'alpha' })

  const result = await service.rollback({ rootAgent: agent, record, active: false, reason: 'not needed' })

  assert.equal(result.status, 'removed')
  assert.equal(result.branchDeleted, true)
  assert.equal(result.branchRetained, false)
  assert.equal(result.recovery, null)
  assert.equal(result.record.status, 'rolled-back')
  assert.equal(result.record.rollbackReason, 'not needed')
  assert.equal(fs.existsSync(record.path), false)
  assert.equal(branchExists(repo, record.branch), false)
  assert.equal(status(repo), '')
  assert.equal(runGit(repo, ['worktree', 'list', '--porcelain']).stdout.trim().split('\n\n').length, 1)
})

test('rollback refuses to delete ignored artifacts that git status calls clean', async (t) => {
  const { repo, agent, service } = setup(t)
  commitFile(repo, '.gitignore', '.env\ncache/\n')
  const record = await service.prepare({ rootAgent: agent, memberName: 'alpha' })
  fs.writeFileSync(path.join(record.path, '.env'), 'SECRET=keep-me\n')
  fs.mkdirSync(path.join(record.path, 'cache'))
  fs.writeFileSync(path.join(record.path, 'cache', 'build.bin'), 'cache\n')
  // git status ignores these, but `git worktree remove` would delete them.
  assert.equal(status(record.path), '')

  await assert.rejects(
    service.rollback({ rootAgent: agent, record, active: false }),
    (error) => {
      assert.equal(error.code, 'WORKTREE_HAS_IGNORED')
      assert.equal(error.details.preserved, true)
      assert.ok(error.details.entries.some(entry => entry.includes('.env')))
      return true
    },
  )
  assert.equal(fs.readFileSync(path.join(record.path, '.env'), 'utf8'), 'SECRET=keep-me\n')
  assert.equal(fs.existsSync(path.join(record.path, 'cache', 'build.bin')), true)

  fs.rmSync(path.join(record.path, '.env'))
  fs.rmSync(path.join(record.path, 'cache'), { recursive: true })
  const removed = await service.rollback({ rootAgent: agent, record, active: false })
  assert.equal(removed.status, 'removed')
})

test('rollback preserves a branch with commits and reports manual recovery', async (t) => {
  const { repo, agent, service } = setup(t)
  const record = await service.prepare({ rootAgent: agent, memberName: 'alpha' })
  commitFile(record.path, 'kept.txt', 'kept\n')
  const head = runGit(repo, ['rev-parse', `refs/heads/${record.branch}`]).stdout.trim()

  const result = await service.rollback({ rootAgent: agent, record, active: false })

  assert.equal(result.status, 'removed')
  assert.equal(result.branchDeleted, false)
  assert.equal(result.branchRetained, true)
  assert.equal(fs.existsSync(record.path), false)
  assert.equal(runGit(repo, ['rev-parse', `refs/heads/${record.branch}`]).stdout.trim(), head)
  assert.equal(result.recovery.branch, record.branch)
  assert.equal(result.recovery.steps.length, 2)

  runGit(repo, ['worktree', 'add', '-q', record.path, `refs/heads/${record.branch}`])
  assert.equal(fs.readFileSync(path.join(record.path, 'kept.txt'), 'utf8'), 'kept\n')
})

test('rollback refuses dirty, locked, merged and unregistered worktrees', async (t) => {
  const { repo, agent, service } = setup(t)
  const dirty = await service.prepare({ rootAgent: agent, memberName: 'dirty' })
  fs.writeFileSync(path.join(dirty.path, 'do-not-remove.txt'), 'keep\n')
  await assert.rejects(
    service.rollback({ rootAgent: agent, record: dirty, active: false }),
    error => error.code === 'WORKTREE_DIRTY' && error.details.preserved === true,
  )
  assert.equal(fs.readFileSync(path.join(dirty.path, 'do-not-remove.txt'), 'utf8'), 'keep\n')

  const locked = await service.prepare({ rootAgent: agent, memberName: 'locked' })
  runGit(repo, ['worktree', 'lock', locked.path])
  try {
    await assert.rejects(
      service.rollback({ rootAgent: agent, record: locked, active: false }),
      error => error.code === 'WORKTREE_LOCKED',
    )
  } finally {
    runGit(repo, ['worktree', 'unlock', locked.path])
  }

  const merged = await service.prepare({ rootAgent: agent, memberName: 'merged' })
  commitFile(merged.path, 'merged.txt', 'merged\n')
  const delivered = await service.merge({ rootAgent: agent, record: merged, active: false })
  await assert.rejects(
    service.rollback({ rootAgent: agent, record: delivered.record, active: false }),
    error => error.code === 'ALREADY_MERGED',
  )

  const external = await service.prepare({ rootAgent: agent, memberName: 'external' })
  runGit(repo, ['worktree', 'remove', '--force', external.path])
  const approach = await service.rollback({ rootAgent: agent, record: external, active: false })
  assert.equal(approach.status, 'already-removed')
  assert.equal(approach.branchRetained, true)
  assert.equal(branchExists(repo, external.branch), true)

  const unregistered = await service.prepare({ rootAgent: agent, memberName: 'orphan' })
  runGit(repo, ['worktree', 'remove', '--force', unregistered.path])
  fs.mkdirSync(unregistered.path, { recursive: true })
  fs.writeFileSync(path.join(unregistered.path, 'external-data.txt'), 'not ours\n')
  await assert.rejects(
    service.rollback({ rootAgent: agent, record: unregistered, active: false }),
    error => error.code === 'WORKTREE_UNREGISTERED' && error.details.preserved === true,
  )
  assert.equal(fs.readFileSync(path.join(unregistered.path, 'external-data.txt'), 'utf8'), 'not ours\n')
})

test('concurrent prepares allocate unique branches and paths and keep the lead clean', async (t) => {
  const { repo, agent, service } = setup(t)
  const records = await Promise.all([
    service.prepare({ rootAgent: agent, memberName: 'alpha' }),
    service.prepare({ rootAgent: agent, memberName: 'alpha' }),
    service.prepare({ rootAgent: agent, memberName: 'beta' }),
  ])

  assert.equal(new Set(records.map(record => record.branch)).size, 3)
  assert.equal(new Set(records.map(record => record.path)).size, 3)
  for (const record of records) {
    assert.equal(fs.existsSync(record.path), true)
    assert.equal(status(record.path), '')
  }
  assert.equal(status(repo), '')
  assert.equal(runGit(repo, ['worktree', 'list', '--porcelain']).stdout.trim().split('\n\n').length, 4)
})

test('createSwarmWorktrees touches no optional service at construction time', async () => {
  let touched = false
  const ctx = {
    get() {
      touched = true
      throw new Error('service lookup must stay lazy')
    },
  }
  const service = createSwarmWorktrees({ ctx })
  assert.equal(touched, false)
  const agent = { session: { id: 'root-session', header: { cwd: process.cwd() } } }
  await assert.rejects(
    service.prepare({ rootAgent: agent, memberName: 'alpha' }),
    error => error.code === 'WORKTREE_UNAVAILABLE',
  )
  assert.equal(touched, true)
})

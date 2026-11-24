// Installed-runtime integration: the optional worktree service against the real
// DSH file-system and subprocess services (git is never mocked).
//
// The regular suite skips this test. Run it with the installed runtime, e.g.:
//   DSH_TEST_RUNTIME="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/package.json" \
//   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
//     --test test/worktree-runtime.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSwarmWorktrees } from '../src/worktree.js'

const runtime = process.env.DSH_TEST_RUNTIME
const tick = () => new Promise(resolve => setImmediate(resolve))

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return (result.stdout ?? '').trim()
}

test('installed runtime: worktree prepare, fast-forward merge and rollback use real DSH fs/subprocess', { skip: !runtime && 'Set DSH_TEST_RUNTIME to the installed resolver manifest' }, async (t) => {
  const require = createRequire(runtime)
  const { Context } = require('@deepseek-ai/cordis')
  const FsLocal = require('@deepseek-ai/dsh-fs-local').default
  const SubprocessLocal = require('@deepseek-ai/dsh-subprocess-local').default

  const repo = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dk-swarm-wt-runtime-')))
  const ctx = new Context()
  const fibers = []
  t.after(async () => {
    for (const fiber of fibers.reverse()) await fiber.dispose().catch(() => {})
    fs.rmSync(repo, { recursive: true, force: true })
  })

  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.name', 'Swarm Runtime Test'])
  git(repo, ['config', 'user.email', 'swarm@example.invalid'])
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n')
  git(repo, ['add', '--', 'a.txt'])
  git(repo, ['commit', '-q', '-m', 'base'])

  fibers.push(ctx.plugin(FsLocal))
  await tick()
  fibers.push(ctx.plugin(SubprocessLocal))
  await tick()
  // The native policy service needs the sessions/storage stack; supply the same
  // per-call shape the service resolves in production. Danger mode still uses
  // the real fs and subprocess seams exercised below.
  ctx.provide('sandboxPolicy')
  ctx.set('sandboxPolicy', {
    async resolve({ session }) {
      return { mode: 'danger-full-access', workspaceRoot: session.header.cwd, sessionId: session.id }
    },
  })

  const agent = { session: { id: 'root-session', header: { cwd: repo } } }
  const service = createSwarmWorktrees({ ctx })

  const record = await service.prepare({ rootAgent: agent, memberName: 'alpha' })
  assert.equal(record.status, 'prepared')
  assert.equal(git(repo, ['status', '--porcelain']), '')
  assert.equal(fs.readFileSync(path.join(repo, '.agents', 'worktrees', 'swarm', '.gitignore'), 'utf8'), '*\n')
  assert.equal(fs.readFileSync(path.join(record.path, 'a.txt'), 'utf8'), 'base\n')

  fs.writeFileSync(path.join(record.path, 'feature.txt'), 'delivered\n')
  git(record.path, ['add', '--', 'feature.txt'])
  git(record.path, ['commit', '-q', '-m', 'feature'])

  const merged = await service.merge({ rootAgent: agent, record, active: false })
  assert.equal(merged.status, 'merged')
  assert.equal(merged.strategy, 'ff-only')
  assert.equal(merged.targetHead, merged.memberHead)
  assert.equal(fs.readFileSync(path.join(repo, 'feature.txt'), 'utf8'), 'delivered\n')
  assert.equal(git(repo, ['status', '--porcelain']), '')

  await assert.rejects(
    service.rollback({ rootAgent: agent, record: merged.record, active: false }),
    error => error.code === 'ALREADY_MERGED',
  )

  const unused = await service.prepare({ rootAgent: agent, memberName: 'beta' })
  const rolledBack = await service.rollback({ rootAgent: agent, record: unused, active: false, reason: 'not needed' })
  assert.equal(rolledBack.status, 'removed')
  assert.equal(rolledBack.branchDeleted, true)
  assert.equal(fs.existsSync(unused.path), false)
})

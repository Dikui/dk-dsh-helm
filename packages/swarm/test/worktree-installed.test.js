// Exercise the production adapter with the installed Cordis services. The only
// host fixtures are a root identity, its cwd and a policy scoped to a temp repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const runtime = process.env.DSH_TEST_RUNTIME;
test('installed sandbox, subprocess and fs services prepare and deliver a real child checkout', { skip: !runtime && 'Set DSH_TEST_RUNTIME to the installed resolver manifest' }, async t => {
  const { createSwarmWorktrees } = await import('../src/worktree.js');
  const require = createRequire(runtime);
  const { Context } = require('@deepseek-ai/cordis');
  const tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-installed-git-')));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm@example.invalid', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' }).trim();
  t.after(async () => { if (tmp.startsWith(path.join(await realpath(tmpdir()), 'swarm-installed-git-'))) await rm(tmp, { recursive: true, force: true }); });
  git(tmp, 'init', '-q', '-b', 'swarm-test');
  git(tmp, 'commit', '-q', '--allow-empty', '-m', 'base');
  const ctx = new Context();
  const fibers = [];
  t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); });
  const rootAgent = { id: 'root-test', session: { id: 'root-test', cwd: tmp } };
  for (const [name, service] of Object.entries({
    workingDirectory: { ensure: async () => tmp, get: () => tmp },
    sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: tmp }) },
  })) { ctx.provide(name); ctx.set(name, service); }
  for (const name of ['dsh-fs-local', 'dsh-subprocess-local', 'dsh-sandbox-local']) {
    fibers.push(ctx.plugin(require(`@deepseek-ai/${name}`).default)); await new Promise(resolve => setImmediate(resolve));
  }
  const checkout = createSwarmWorktrees({ ctx });
  const record = await checkout.prepare({ rootAgent, memberName: 'alice', memberSessionId: 'child' });
  assert.notEqual(record.path, tmp);
  assert.equal(git(tmp, 'status', '--porcelain'), '');
  git(record.path, 'commit', '-q', '--allow-empty', '-m', 'delivery');
  const head = git(record.path, 'rev-parse', 'HEAD');
  await checkout.merge({ rootAgent, record, active: false });
  assert.equal(git(tmp, 'rev-parse', 'HEAD'), head);
});

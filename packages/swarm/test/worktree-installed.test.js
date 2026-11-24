// Exercise SwarmHost -> BoardState -> installed local services -> actual Git.
// The child activation is scripted: no paid model or desktop profile is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SwarmHost } from '../src/host-runtime.js';
import { BoardState } from '../src/host-state.js';
import * as boardApi from '../src/board.js';
import { openStore } from '../src/store.js';

const runtime = process.env.DSH_TEST_RUNTIME;
test('installed sandbox, subprocess and fs services prepare and deliver a real child checkout', { skip: !runtime && 'Set DSH_TEST_RUNTIME to the installed resolver manifest' }, async t => {
  const require = createRequire(runtime);
  const { Context } = require('@deepseek-ai/cordis');
  const tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-installed-git-')));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Swarm Test', '-c', 'user.email=swarm@example.invalid', '-c', 'commit.gpgSign=false', ...args], { encoding: 'utf8' }).trim();
  t.after(async () => { if (tmp.startsWith(path.join(await realpath(tmpdir()), 'swarm-installed-git-'))) await rm(tmp, { recursive: true, force: true }); });
  git(tmp, 'init', '-q', '-b', 'swarm-test');
  await writeFile(path.join(tmp, 'handler.txt'), 'before\n');
  git(tmp, 'add', 'handler.txt');
  git(tmp, 'commit', '-q', '-m', 'base');
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
  const agents = new Map([[rootAgent.id, rootAgent]]);
  let childCwd;
  const services = {
    subagents: {
      rootOf: () => rootAgent,
      startActivation: async spec => {
        childCwd = spec.cwd; agents.set(spec.childId, { id: spec.childId });
        return { childId: spec.childId, result: new Promise(() => {}), dispose: async () => agents.delete(spec.childId) };
      },
      interrupt() {},
    },
    agents: { get: id => agents.get(id) },
  };
  for (const [key, service] of Object.entries(services)) { ctx.provide(key); ctx.set(key, service); }
  const rows = new Map();
  const store = await openStore({ storageDomain: { open: async () => ({ close() {}, table: () => ({
    entries: () => rows.entries(), get: key => rows.get(key), put: (key, value) => rows.set(key, value),
  }) }) } });
  const state = new BoardState({ ctx, store, board: boardApi });
  const host = new SwarmHost({ ctx, store, state });
  t.after(() => host.close());
  await state.create(rootAgent, 'Acceptance');
  const { sessionId } = await host.addMember({ rootAgent, name: 'alice', workspaceMode: 'branch', prompt: 'deliver a change' });
  assert.notEqual(childCwd, tmp); assert.equal(childCwd, state.member(rootAgent.id, sessionId).worktree.path);
  assert.equal(git(tmp, 'status', '--porcelain'), '');
  await writeFile(path.join(childCwd, 'handler.txt'), 'after\n');
  assert.equal(await readFile(path.join(tmp, 'handler.txt'), 'utf8'), 'before\n');
  git(childCwd, 'commit', '-q', '-am', 'delivery');
  const head = git(childCwd, 'rev-parse', 'HEAD');
  await assert.rejects(host.mergeMember(rootAgent, 'alice'), { code: 'MEMBER_ACTIVE' });
  await host.killMember(rootAgent.id, 'alice');
  await host.mergeMember(rootAgent, 'alice');
  assert.equal(git(tmp, 'rev-parse', 'HEAD'), head);
  assert.equal(await readFile(path.join(tmp, 'handler.txt'), 'utf8'), 'after\n');
  assert.equal(state.member(rootAgent.id, sessionId).worktree.status, 'merged');
  assert.equal(state.member(rootAgent.id, sessionId).worktree.mergedHead, head);
  assert.equal((await host.mergeMember(rootAgent, 'alice')).mergedHead, head);
});

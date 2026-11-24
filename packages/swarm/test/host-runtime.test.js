// Installed-runtime integration for the Swarm Host: real Cordis command/tool
// registry, real JSON storage, a scripted native child, and one failed wake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as plugin from '../index.js';

const runtime = process.env.DSH_TEST_RUNTIME;
const tick = () => new Promise(resolve => setImmediate(resolve));
const postedSeq = result => Number(/seq (\d+)/.exec(result.text)[1]);

test('installed runtime: /swarm command, four-tool gating, wake delivery and durable cursors', { skip: !runtime && 'Set DSH_TEST_RUNTIME to the installed resolver manifest' }, async () => {
  const require = createRequire(runtime);
  const { Context } = require('@deepseek-ai/cordis');
  const temp = await mkdtemp(path.join(tmpdir(), 'dk-swarm-host-'));
  const signal = new AbortController().signal;
  let sends = [], childTask = null, releaseGate;
  const child = { read: null, reply: null };

  async function boot() {
    const ctx = new Context(), fibers = [], agents = new Map();
    const root = { id: 'root-1', session: { append() {} }, steers: [], steer(message) { this.steers.push(message); } };
    agents.set(root.id, root);
    const children = new Map();
    let resolveParked, resolveWoke;
    const parked = new Promise(resolve => { resolveParked = resolve; });
    const woke = new Promise(resolve => { resolveWoke = resolve; });
    let gate;
    const gateReady = new Promise(resolve => { gate = resolve; });
    releaseGate = gate;

    const subagents = {
      rootOf: agent => agent.id === root.id ? root : (children.get(agent.id)?.root ?? root),
      resolveMaxDepth: () => 1,
      async startActivation(spec) {
        const agent = { id: spec.childId };
        children.set(agent.id, { root });
        childTask = (async () => {
          await gateReady;
          assert.deepEqual(await toolNames(agent), ['post_message', 'read_board', 'swarm_wait']);
          const denied = await invoke(agent, 'swarm', { action: 'status' });
          assert.equal(denied.isError, true);
          assert.equal(denied.error.info.code, 'UNKNOWN_TOOL');
          const park = await invoke(agent, 'swarm_wait', {});
          assert.equal(park.value.ok, true);
          assert.equal(park.value.waiting, true);
          resolveParked();
          await woke;
          child.read = (await invoke(agent, 'read_board', {})).value;
          child.reply = (await invoke(agent, 'post_message', { text: '@lead result ready' })).value;
        })();
        return { childId: spec.childId, dispose: async () => {}, result: childTask.then(() => ({ stopReason: 'completed', output: [] })) };
      },
      async sendMessage(_root, sessionId, content) {
        const text = content?.[0]?.text ?? '';
        if (sends.length === 0) {
          sends.push({ sessionId, text, error: 'scripted delivery lost' });
          throw new Error('scripted delivery lost');
        }
        sends.push({ sessionId, text, error: null });
        resolveWoke();
        return { delivered: true };
      },
      async interrupt() {},
    };
    const provide = (key, value) => { ctx.provide(key); ctx.set(key, value); };
    provide('systemPrompt', { tools() {}, section() {} });
    provide('subagents', subagents);
    provide('workingDirectory', { ensure: async () => process.cwd(), get: () => process.cwd() });
    provide('agents', { get: id => agents.get(id), list: () => [...agents.values()] });
    try {
      fibers.push(ctx.plugin(require('@deepseek-ai/dsh-storage').default)); await tick();
      fibers.push(ctx.plugin(require('@deepseek-ai/dsh-storage-json'), { root: temp })); await tick();
      fibers.push(ctx.plugin(require('@deepseek-ai/dsh-storage-domain'), { backend: 'json' })); await tick();
      fibers.push(ctx.plugin(require('@deepseek-ai/dsh-commands').CommandRuntime));
      fibers.push(ctx.plugin(require('@deepseek-ai/dsh-tools').default)); await tick();
      fibers.push(ctx.plugin(require('@deepseek-ai/dsh-tool-executor-native'))); await tick();
      fibers.push(await ctx.plugin(plugin));
    } catch (error) {
      for (const fiber of fibers.reverse()) await fiber.dispose().catch(() => {});
      throw error;
    }
    const toolNames = async agent => {
      const set = await ctx.tools.resolve({ agent, signal });
      try { return [...set.view(agent).keys()].sort(); } finally { set.dispose?.(); }
    };
    const invoke = async (agent, name, args = {}) => {
      const set = await ctx.tools.resolve({ agent, signal });
      try {
        const batch = await ctx.tools.execute({ agent, signal, toolSet: set, calls: [{ type: 'tool-call', id: 'test', name, arguments: JSON.stringify(args) }] });
        return batch.results[0].result;
      } finally { set.dispose?.(); }
    };
    const command = async (agent, line) => {
      const settled = await ctx.commands.execute(agent, line, [], signal);
      assert.ok(settled, `command resolved: ${line}`);
      return settled.result;
    };
    return {
      ctx, root, command, invoke, toolNames, parked,
      async close() { for (const fiber of fibers.reverse()) await fiber.dispose(); },
    };
  }

  let runtimeCtx = null;
  try {
    runtimeCtx = await boot();
    let { root, command, invoke, toolNames, parked, close } = runtimeCtx;
    assert.deepEqual(await toolNames(root), []);
    assert.deepEqual(await toolNames({ id: 'stranger' }), []);
    const denied = await invoke({ id: 'stranger' }, 'post_message', { text: 'nope' });
    assert.equal(denied.isError, true);
    assert.equal(denied.error.info.code, 'UNKNOWN_TOOL');

    assert.equal((await command(root, '/swarm init Host Runtime')).kind, 'success');
    assert.deepEqual(await toolNames(root), ['swarm']);
    // Optional capabilities never turn a missing sandbox/route into shared or inherited dispatch.
    assert.equal((await command(root, '/swarm add blocked --worktree -- do not spawn')).kind, 'error');
    const deniedRoute = await invoke(root, 'swarm', { action: 'add', name: 'blocked', prompt: 'do not spawn', modelRoute: { provider: 'unavailable', model: 'm' } });
    assert.equal(deniedRoute.value.ok, false);
    const wallet = await command(root, '/swarm quota');
    assert.equal(wallet.kind, 'success', wallet.text);
    assert.equal(JSON.parse(wallet.text).supported, false);
    const kickoff = postedSeq(await command(root, '/swarm post Kickoff for the team'));
    assert.equal((await command(root, '/swarm add worker-1 do the task')).kind, 'success');
    releaseGate();
    assert.deepEqual(await toolNames(root), ['post_message', 'read_board', 'swarm', 'swarm_wait']);
    await parked;
    assert.equal((await invoke(root, 'read_board', {})).value.lastReadSeq, kickoff);
    assert.equal((await invoke(root, 'swarm_wait', {})).value.waiting, true);

    const failed = await command(root, '/swarm post @worker-1 first attempt');
    assert.equal(failed.kind, 'success');
    const failedSeq = postedSeq(failed);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].error, 'scripted delivery lost');
    const retried = postedSeq(await command(root, '/swarm post @worker-1 retry after failure'));
    assert.equal(sends.length, 2);
    assert.equal(sends[1].error, null);
    assert.match(sends[1].text, new RegExp(`seq ${retried}`));
    assert.match(sends[1].text, /You were mentioned/);

    await childTask;
    assert.equal(child.read.ok, true);
    assert.deepEqual(child.read.messages.map(message => message.seq), [failedSeq, retried]);
    assert.match(child.read.messages[0].text, /first attempt/);
    assert.equal(child.read.lastReadSeq, retried);
    const replySeq = child.reply.seq;
    assert.equal(root.steers.length, 1);
    assert.match(root.steers[0].content[0].text, /You were mentioned/);
    assert.match(root.steers[0].content[0].text, new RegExp(`seq ${replySeq}`));

    const view = JSON.parse((await command(root, '/swarm view')).text);
    assert.equal(view.seq, replySeq);
    assert.equal(view.members.find(member => member.name === 'worker-1').lastSeq, retried);
    assert.equal(view.members.find(member => member.name === 'lead').lastSeq, kickoff);
    await close();
    runtimeCtx = null;

    runtimeCtx = await boot();
    ({ command, invoke, root, close } = runtimeCtx);
    const reopened = JSON.parse((await command(root, '/swarm view')).text);
    assert.equal(reopened.seq, replySeq);
    assert.equal(reopened.messages.at(-1).text, '@lead result ready');
    assert.equal(reopened.members.find(member => member.name === 'worker-1').lastSeq, retried);
    // A native post-execute policy may withhold the page even though the tool
    // body succeeded. Neither refusal nor a successful rewrite counts as read.
    for (const kind of ['block', 'accept']) {
      const withheld = [{ type: 'text', text: 'Board page withheld by policy' }];
      const off = runtimeCtx.ctx.on('tools/post-execute', (exec, _result, next) =>
        exec.name !== 'read_board' ? next() : kind === 'block'
          ? { kind, feedback: withheld } : { kind, content: withheld });
      try {
        const altered = await invoke(root, 'read_board', {});
        assert.equal(altered.isError, kind === 'block');
        assert.match(altered.content[0].text, /withheld by policy/);
        const snapshot = JSON.parse((await command(root, '/swarm view')).text);
        assert.equal(snapshot.members.find(member => member.name === 'lead').lastSeq, kickoff);
      } finally { off(); }
    }
    const read = (await invoke(root, 'read_board', {})).value;
    assert.deepEqual(read.messages.map(message => message.seq), [failedSeq, retried, replySeq]);
    assert.equal(read.lastReadSeq, replySeq);
    assert.deepEqual((await invoke(root, 'read_board', {})).value.messages, []);
  } finally {
    if (runtimeCtx) await runtimeCtx.close().catch(() => {});
    if (path.dirname(temp) !== path.resolve(tmpdir()) || !path.basename(temp).startsWith('dk-swarm-host-')) throw Error('unexpected temporary root');
    await rm(temp, { recursive: true, force: true });
  }
});

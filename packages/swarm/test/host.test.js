import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readMailbox, enqueueMailbox, readMailboxAck } from '../src/external-bridge.js';

import * as boardApi from '../src/board.js';
import { BoardState, boardKey } from '../src/host-state.js';
import { SwarmHost, createSwarmMessage } from '../src/host-runtime.js';
import { registerSwarmTools, formatStatus } from '../src/host-tools.js';
import { readAddArgs, registerSwarmCommands } from '../src/host-commands.js';

const clone = (value) => (value === undefined ? undefined : structuredClone(value));

class MemoryStore {
  constructor() {
    this.map = new Map();
    this.closed = false;
  }
  get(key) {
    return clone(this.map.get(key));
  }
  async entries() {
    return [...this.map.entries()].map(([key, value]) => [key, clone(value)]);
  }
  async transact(key, fn) {
    if (this.closed) throw new Error('store closed');
    const { state, result } = fn(this.get(key));
    this.map.set(key, clone(state));
    return clone(result);
  }
  async close() {
    this.closed = true;
  }
}

function fakeAgent(id, extra = {}) {
  const steers = [];
  const followups = [];
  return {
    id,
    session: { id },
    steers,
    followups,
    steer(message) {
      steers.push(message);
    },
    followup(message) {
      followups.push(message);
    },
    ...extra,
  };
}

function makeMessage(text, summary) {
  return {
    id: `msg-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'swarm', form: 'notice', summary },
  };
}

function makeRuntime(options = {}) {
  const root = fakeAgent('root');
  const agents = new Map([[root.id, root]]);
  const tools = [];
  const commands = [];
  const events = [];
  const sends = [];
  const spawns = [];
  const disposals = [];

  const ctx = {
    agents: {
      get: (id) => agents.get(id) ?? null,
      list: () => [...agents.values()],
    },
    workingDirectory: {
      get: () => options.cwd ?? '/workspace/shared',
      ensure: async () => options.cwd ?? '/workspace/shared',
    },
    tools: {
      register(definition, opts) {
        tools.push({ definition, opts });
        return () => {};
      },
    },
    commands: {
      register(definition) {
        commands.push(definition);
        return () => {};
      },
    },
    on(name, handler) {
      events.push({ name, handler });
      return () => {};
    },
    subagents: {
      rootOf(agent) {
        if (agent.id === root.id) return root;
        if (!agents.has(agent.id)) throw new Error('UNAUTHORIZED');
        return root;
      },
      resolveMaxDepth: () => 3,
      async startActivation(spec) {
        spawns.push(spec);
        if (options.spawnError) throw options.spawnError;
        const child = fakeAgent(spec.childId);
        agents.set(child.id, child);
        const activation = {
          childId: spec.childId,
          name: spec.name,
          messageId: 'm1',
          // Keep the activation open unless a test explicitly simulates a finished turn.
          result: options.activationResult ?? new Promise(() => {}),
          dispose: async () => {
            disposals.push(spec.childId);
            agents.delete(spec.childId);
          },
        };
        return activation;
      },
      async sendMessage(sender, targetId, content) {
        sends.push({ sender: sender.id, targetId, text: content[0]?.text });
        const target = agents.get(targetId);
        if (target) target.steer({ content });
        return `sent-${sends.length}`;
      },
      interrupt() {},
    },
    logger: null,
  };

  const store = new MemoryStore();
  const state = new BoardState({ ctx, store, board: boardApi, channels: {}, logger: null });
  const host = new SwarmHost({
    ctx,
    store,
    state,
    channels: {},
    logger: null,
    makeMessage,
  });

  return { ctx, store, state, host, root, agents, tools, commands, events, sends, spawns, disposals };
}

async function setup(options = {}) {
  const rt = makeRuntime(options);
  await rt.host.start();
  await rt.state.create(rt.root, options.title ?? 'Swarm', 'lead');
  return rt;
}

async function park(rt, agentId) {
  await rt.host.post('root', 'root', 'sync before parking');
  await rt.host.read('root', agentId);
  return rt.host.wait('root', agentId);
}

async function addAlice(rt, options = {}) {
  return rt.host.addMember({
    rootAgent: rt.root,
    name: options.name ?? 'alice',
    prompt: options.prompt ?? 'do the task',
    role: options.role ?? 'worker',
    channels: options.channels,
    signal: options.signal ?? new AbortController().signal,
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, label) {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${label}`);
}

// Swarm routing/isolation: the task after -- is never interpreted as a dispatch option.
test('add parses isolated checkout and qualified routes without rewriting the task', () => {
  const args = readAddArgs(['alice', '--worktree', '--model', 'first/namespace/model', '--fallback', 'second/model', '--', 'check', '--model', 'literally']);
  assert.equal(args.name, 'alice');
  assert.equal(args.workspaceMode, 'branch');
  assert.deepEqual(args.modelRoute, { provider: 'first', model: 'namespace/model' });
  assert.deepEqual(args.fallbackRoute, { provider: 'second', model: 'model' });
  assert.equal(args.prompt, 'check --model literally');
  assert.throws(() => readAddArgs(['alice', 'work', '--model']), /provider\/model/);
});

test('creates a board and spawns a native member with the shared cwd', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const added = await addAlice(rt, { channels: ['ops'] });
  const board = rt.state.board('root');

  assert.equal(added.member.name, 'alice');
  assert.equal(board.members[added.sessionId].status, 'active');
  assert.deepEqual(board.members[added.sessionId].channels.sort(), ['main', 'ops']);
  assert.ok(board.channels.ops, 'explicit channel created before join');
  assert.equal(rt.spawns.length, 1);
  const spec = rt.spawns[0];
  assert.equal(spec.provider, 'spawn');
  assert.equal(spec.delivery, 'caller');
  assert.equal(spec.childId, added.sessionId);
  assert.equal(spec.cwd, '/workspace/shared');
  assert.equal(spec.agentPreset, undefined, 'inherits the parent preset, never widens it');
  assert.match(spec.prompt[0].text, /You are "alice"/);
  assert.match(spec.prompt[0].text, /do the task/);
});

test('isolated dispatch persists the delivery record, rejects live/non-root merges, and reconciles delivery once', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  let deliveries = 0;
  rt.host.worktrees = {
    prepare: async ({ memberSessionId, memberName, rootAgent }) => ({ version: 1, id: 'wt_1', rootSessionId: rootAgent.id, member: memberName, memberSessionId, status: 'prepared', path: '/repo/checkout', branch: 'swarm/alice' }),
    merge: async ({ record, active }) => { assert.equal(active, false); deliveries++; return { status: 'merged', record: { ...record, status: 'merged', mergedHead: 'a'.repeat(40), mergedAt: 42, updatedAt: 42 } }; },
  };
  const { sessionId } = await rt.host.addMember({ rootAgent: rt.root, name: 'alice', prompt: 'write code', workspaceMode: 'branch' });
  assert.equal(rt.spawns[0].cwd, '/repo/checkout');
  assert.match(rt.spawns[0].prompt[0].text, /isolated Git checkout/);
  assert.equal(rt.store.get(boardKey('root')).members[sessionId].worktree.branch, 'swarm/alice');
  await assert.rejects(rt.host.mergeMember(rt.agents.get(sessionId), 'alice'), { code: 'FORBIDDEN' });
  await assert.rejects(rt.host.mergeMember(rt.root, 'alice'), { code: 'MEMBER_ACTIVE' });
  await rt.host.killMember('root', 'alice');
  assert.equal((await rt.host.mergeMember(rt.root, 'alice')).status, 'merged');
  assert.equal((await rt.host.mergeMember(rt.root, 'alice')).status, 'already-delivered');
  assert.equal(deliveries, 1);
});

test('routes are checked as the root, passed to the native spawn, and visible after storage reload', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const modelRoute = { provider: 'allowed', model: 'models/fast' }, fallbackRoute = { provider: 'allowed', model: 'models/backup' };
  let checks = 0;
  rt.host.validateDispatchRoutes = async (primary, fallback, { rootAgent, signal }) => {
    assert.equal(rootAgent, rt.root); assert.equal(signal.aborted, false);
    assert.deepEqual(primary, modelRoute); assert.deepEqual(fallback, fallbackRoute); checks++;
    return { primary, fallback };
  };
  const { sessionId } = await rt.host.addMember({ rootAgent: rt.root, name: 'alice', prompt: 'work', modelRoute, fallbackRoute });
  assert.equal(checks, 1); assert.deepEqual(rt.spawns[0].agentOptions, modelRoute);
  assert.deepEqual(rt.store.get(boardKey('root')).members[sessionId].fallbackRoute, fallbackRoute);
  assert.match(formatStatus(rt.host.view('root')), /fallback: allowed\/models\/backup/);
});

test('failed isolated spawn rolls back only confirmed inactive checkouts; unsafe cleanup reports recovery metadata', async (t) => {
  const rt = await setup({ spawnError: new Error('failed spawn') });
  t.after(() => rt.host.close());
  let unsafe = false, attempts = 0;
  rt.host.worktrees = {
    prepare: async () => ({ id: 'wt_1', path: '/repo/work', branch: 'swarm/recover' }),
    rollback: async ({ active }) => { assert.equal(active, false); attempts++; if (unsafe) throw new Error('checkout dirty'); return {}; },
  };
  const dispatch = () => rt.host.addMember({ rootAgent: rt.root, name: 'alice', prompt: 'code', workspaceMode: 'branch' });
  await assert.rejects(dispatch, /failed spawn/);
  unsafe = true; await assert.rejects(dispatch, e => e.code === 'CHECKOUT_PRESERVED' && /swarm\/recover/.test(e.message));
  assert.equal(attempts, 2);
  assert.deepEqual(Object.keys(rt.store.get(boardKey('root')).reservations), []);
});

test('wallet monitoring is root opt-in, deduplicated per crossing, and ignores unknown or bonus balances', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const { sessionId } = await addAlice(rt);
  registerSwarmCommands(rt.host);
  const command = (rawInput, agent = rt.root) => rt.commands[0].handler({ agent, rawInput });
  let amount = '2.50', reads = 0;
  rt.host.quotaAdvisory = async () => { reads++; return { supported: true, signedIn: true, balances: [{ currency: 'CNY', amount, wallet: 'recharge' }, { currency: 'CNY', amount: '100', wallet: 'bonus' }] }; };
  const alerts = [];
  let deliverable = false;
  rt.host.steerRoot = async (_root, message) => { if (!deliverable) return false; alerts.push(message); return true; };
  await rt.host.walletAlerts.poll();
  assert.equal((await command('swarm quota', rt.agents.get(sessionId))).kind, 'error');
  assert.equal((await command('swarm quota watch CNY -1')).kind, 'error');
  assert.equal(reads, 0);
  assert.equal((await command('swarm quota watch CNY 5')).kind, 'success');
  await rt.host.walletAlerts.poll(); // disconnected after the account snapshot
  deliverable = true;
  await rt.host.walletAlerts.poll(); await rt.host.walletAlerts.poll();
  assert.equal(alerts.length, 1);
  amount = '8'; await rt.host.walletAlerts.poll();
  amount = null; await rt.host.walletAlerts.poll();
  assert.equal(alerts.length, 1);
  amount = '1'; await rt.host.walletAlerts.poll();
  assert.equal(alerts.length, 2);
  await command('swarm quota off');
  const before = reads; await rt.host.walletAlerts.poll(); assert.equal(reads, before);
});

test('requested capabilities fail closed on old hosts, without spawning or reserving', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  for (const options of [{ workspaceMode: 'branch' }, { workspaceMode: 'external' }, { modelRoute: { provider: 'p', model: 'm' } }, { fallbackRoute: { provider: 'q', model: 'n' } }]) {
    await assert.rejects(rt.host.addMember({ rootAgent: rt.root, name: 'alice', prompt: 'do not downgrade', ...options }));
    assert.deepEqual(Object.keys(rt.state.board('root').reservations), []);
    assert.equal(Object.keys(rt.state.board('root').members).length, 1);
  }
  assert.equal(rt.spawns.length, 0);
  assert.equal((await addAlice(rt)).member.name, 'alice', 'default shared/inherited dispatch still works');
});

test('spawn failure is compensated with failJoin and leaves no member', async (t) => {
  const rt = makeRuntime({ spawnError: new Error('spawn refused') });
  await rt.host.start();
  await rt.state.create(rt.root, 'Swarm', 'lead');
  t.after(() => rt.host.close());

  await assert.rejects(() => addAlice(rt), /spawn refused/);
  const board = rt.state.board('root');
  assert.equal(Object.keys(board.members).length, 1, 'coordinator only');
  assert.deepEqual(board.reservations, {});
});

test('commit failure disposes the activation and fails the reservation', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const original = rt.state.act.bind(rt.state);
  rt.state.act = async (rootId, actorId, action) => {
    if (action.type === 'commitJoin') throw new Error('store unavailable');
    return original(rootId, actorId, action);
  };

  await assert.rejects(() => addAlice(rt), /store unavailable/);
  const board = rt.state.board('root');
  assert.equal(Object.keys(board.members).length, 1);
  assert.deepEqual(board.reservations, {});
  assert.equal(rt.disposals.length, 1);
});

test('view exposes bounded public members and seq-time targets only', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);
  const first = await rt.host.post('root', 'root', 'hello @alice');
  await rt.host.post('root', alice.sessionId, 'results attached');

  const view = rt.host.view('root', { messageLimit: 5 });
  assert.equal(view.v, 1);
  assert.equal(view.title, 'Swarm');
  assert.equal(view.counts.members, 2);
  assert.ok(JSON.stringify(view).length <= 12_000);
  const aliceView = view.members.find((member) => member.name === 'alice');
  assert.equal(aliceView.role, 'worker');
  assert.equal(aliceView.status, 'working');
  assert.equal(typeof aliceView.unread, 'number');
  assert.equal(typeof aliceView.lastSeq, 'number');
  const targetPost = view.messages.find((message) => message.seq === first.seq);
  assert.deepEqual(targetPost.targets, ['alice']);
  assert.equal(view.messages.some((message) => message.seq === 0), false, 'control posts are filtered');

  await rt.host.killMember('root', 'alice');
  const after = rt.host.view('root', { messageLimit: 5 });
  assert.equal(after.members.find((member) => member.name === 'alice').status, 'killed');
  assert.deepEqual(
    after.messages.find((message) => message.seq === first.seq).targets,
    ['alice'],
    'a later kill does not rewrite an older graph edge',
  );
});

test('opens a squad board end to end and reports paused, not stopped', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);
  await rt.host.pauseMember('root', 'alice');
  const view = rt.host.view('root');
  assert.equal(view.members.find((member) => member.name === 'alice').status, 'paused');

  await rt.host.killMember('root', 'alice');
  assert.equal(rt.state.member('root', alice.sessionId).status, 'killed');
  assert.equal(rt.host.canUseSocialTool(rt.agents.get(alice.sessionId)), false);
});

test('wait returns UNREAD with peeked messages and does not advance the cursor', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);
  await rt.host.post('root', 'root', 'wake up @alice');

  const beforeWait = rt.state.member('root', alice.sessionId).lastReadSeq;
  const waited = await rt.host.wait('root', alice.sessionId);
  assert.equal(waited.ok, false);
  assert.equal(waited.code, 'UNREAD');
  assert.ok(waited.messages.length >= 1);
  assert.equal(rt.state.member('root', alice.sessionId).lastReadSeq, beforeWait);

  const read = await rt.host.read('root', alice.sessionId);
  assert.equal(read.ok, true);
  assert.ok(rt.state.member('root', alice.sessionId).lastReadSeq > beforeWait);
});

test('delivers member wakes through sendMessage and root wakes through steer', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);
  const parked = await park(rt, alice.sessionId);
  assert.equal(parked.waiting, true);

  await rt.host.post('root', 'root', 'task for @alice');
  assert.equal(rt.sends.length, 1);
  assert.equal(rt.sends[0].targetId, alice.sessionId);
  assert.match(rt.sends[0].text, /mentioned/);
  assert.equal(rt.state.board('root').pendingWakes.length, 0, 'delivered wake acknowledged');

  await rt.host.read('root', 'root');
  assert.equal((await rt.host.wait('root', 'root')).waiting, true);
  await rt.host.post('root', alice.sessionId, 'need a decision @lead');
  assert.equal(rt.root.steers.length, 1);
  assert.match(rt.root.steers[0].content[0].text, /New board activity/);

  await rt.host.killMember('root', 'alice');
  await rt.host.post('root', 'root', 'nobody hears @alice');
  assert.equal(rt.sends.length, 1, 'killed members receive no Swarm delivery');
});

test('pre-step and turn-stopping derive reminders from a real post to a working member', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);
  const memberAgent = rt.agents.get(alice.sessionId);
  assert.equal(rt.state.member('root', alice.sessionId).status, 'active');
  const before = rt.state.member('root', alice.sessionId).lastReadSeq;

  const posted = await rt.host.post('root', 'root', 'task for @alice');
  assert.equal(posted.ok, true);
  assert.equal(rt.sends.length, 0, 'core does not wake a working member; the step guard must catch it');

  const decision = await rt.host.preStep(
    { agent: memberAgent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(decision.kind, 'enter');
  assert.equal(decision.messages.length, 1);
  assert.match(decision.messages[0].content[0].text, /unread post/);
  assert.match(decision.messages[0].content[0].text, /directed at you/);
  assert.equal(rt.state.member('root', alice.sessionId).lastReadSeq, before, 'a reminder is not a read');

  const again = await rt.host.preStep(
    { agent: memberAgent, messages: [], turn: 1, step: 2, signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(again.messages.length, 0, 'the per-session delivery watermark is monotonic');

  await rt.host.read('root', alice.sessionId);
  await rt.host.post('root', 'root', 'more @alice');
  const aborted = AbortSignal.abort();
  await rt.host.turnStopping({ agent: memberAgent, turn: 1, signal: aborted });
  assert.equal(memberAgent.steers.length, 0, 'user cancellation wins over a park bounce');

  const steer = memberAgent.steer;
  memberAgent.steer = () => { throw new Error('temporary transport outage'); };
  await rt.host.turnStopping({ agent: memberAgent, turn: 1, signal: new AbortController().signal });
  memberAgent.steer = steer;
  await rt.host.turnStopping({ agent: memberAgent, turn: 1, signal: new AbortController().signal });
  assert.equal(memberAgent.steers.length, 1, 'a failed dispatch must remain eligible for retry');
  assert.match(memberAgent.steers[0].content[0].text, /directed at you/);
  assert.equal(memberAgent.followups.length, 0, 'turn-stopping uses nextStep steer, not nextTurn followup');

  await rt.host.post('root', 'root', 'pending @alice');
  const canceled = await rt.host.preStep(
    { agent: memberAgent, messages: [], turn: 1, step: 3, signal: aborted },
    async () => ({ kind: 'enter', messages: [] }),
  );
  assert.equal(canceled.messages.length, 0, 'a canceled step is not blocked by a reminder');
});

test('request-error stops retrying after the quota pause threshold', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);
  const memberAgent = rt.agents.get(alice.sessionId);
  let calls = 0;
  const retry = async () => {
    calls += 1;
    return { kind: 'retry' };
  };

  for (let index = 0; index < 3; index += 1) {
    const result = await rt.host.requestError(
      { agent: memberAgent, failure: { status: 429, message: 'rate limited' } },
      retry,
    );
    if (index < 2) assert.deepEqual(result, { kind: 'retry' }, 'below threshold the policy still applies');
    else assert.equal(result, undefined, 'the pause threshold suppresses the retry');
  }

  assert.equal(calls, 3, 'next is invoked exactly once per event');
  assert.equal(rt.state.member('root', alice.sessionId).status, 'paused');
  assert.ok(rt.root.steers.some((message) => /Paused "alice"/.test(message.content[0].text)));

  const fourth = await rt.host.requestError(
    { agent: memberAgent, failure: { status: 429, message: 'rate limited' } },
    retry,
  );
  assert.equal(fourth, undefined, 'an already paused member never resumes via an always policy');
  assert.equal(calls, 4);
});

// Herd parity: the contract is separate from ordinary posts and applies to its owner only.
test('lead can verify a numbered member submission without treating a done post as acceptance', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  registerSwarmTools(rt.host);
  registerSwarmCommands(rt.host);
  const alice = (await addAlice(rt)).member;
  const command = (agent, rawInput) => rt.commands[0].handler({agent, rawInput});
  const assign = await command(rt.root, 'assign spec alice "report file" "includes error cases"');
  assert.equal(assign.kind, 'success', assign.text);
  const deliver = rt.tools.find(x => x.definition.name === 'swarm_delivery');
  const agent = rt.agents.get(alice.sessionId);
  assert.equal(deliver.opts.when({agent}), true);
  const tasks = await deliver.definition.execute({action:'list'}, {agent});
  assert.equal(tasks.items[0].taskId, 'spec');
  const submitted = await deliver.definition.execute({action:'submit', taskId:'spec', artifactVersion:'v1', artifactPath:'docs/report.md'}, {agent});
  assert.equal(submitted.delivery.status, 'submitted');
  const no = await command(agent, 'review spec 1 accepted passed forged');
  assert.equal(no.kind, 'error');
  const yes = await command(rt.root, `review spec ${submitted.delivery.submission.seq} accepted passed "read the three failure cases in v1"`);
  assert.equal(yes.kind, 'success', yes.text);
  assert.equal(rt.state.board('root').deliveries[0].status, 'accepted');
});

test('external seat exchanges scoped snapshots, durable receipts and versioned submissions without spawning a child', {skip:process.platform === 'win32'}, async t => {
  const rt = await setup();
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'swarm-host-seat-')));
  t.after(async () => { await rt.host.close(); await rm(base, {recursive:true, force:true}); });
  registerSwarmCommands(rt.host);
  const run = async rawInput => {
    const reply = await rt.commands[0].handler({agent:rt.root, rawInput});
    assert.equal(reply.kind, 'success', reply.text);
    return reply.text;
  };
  const {mailbox} = JSON.parse(await run(`external add remote "${base}"`));
  assert.equal(rt.spawns.length, 0);
  await run('channel create private');
  await rt.host.post('root','root','not shared with external','private');
  await run('post hello remote');
  await run('assign report remote "report" "includes sources"');
  await run('external sync remote');
  const view = await readMailbox(mailbox);
  assert.deepEqual(view.messages.map(m => [m.author,m.text]), [['lead','hello remote']]);
  assert.deepEqual(view.deliveries.map(d => [d.owner,d.status]), [['remote','assigned']]);
  assert.ok(!JSON.stringify(view).includes('seat-'));
  const message = {op:'post',text:'hello from external'};
  const {id} = await enqueueMailbox(mailbox,message);
  await enqueueMailbox(mailbox,{op:'submit',taskId:'report',artifactVersion:'rev-a',artifactPath:'report.md'});
  const deniedChannel = await enqueueMailbox(mailbox,{op:'post',text:'not allowed',channel:'private'});
  const notAssigned = await enqueueMailbox(mailbox,{op:'submit',taskId:'other',artifactVersion:'x',artifactPath:'x.md'});
  const forged = randomUUID();
  await writeFile(path.join(mailbox,'inbox',forged+'.json'), JSON.stringify({op:'post',text:'forged',author:'lead'}));
  await run('external sync remote');
  assert.equal((await readMailboxAck(mailbox,id)).ok,true);
  assert.equal((await readMailboxAck(mailbox,deniedChannel.id)).code,'NOT_SUBSCRIBED');
  assert.equal((await readMailboxAck(mailbox,notAssigned.id)).code,'NOT_FOUND');
  assert.equal((await readMailboxAck(mailbox,forged)).code,'INVALID_REQUEST');
  // Replay across a lost disk acknowledgement: the board is the receipt authority.
  await writeFile(path.join(mailbox,'acks.json'),'[]');
  await writeFile(path.join(mailbox,'inbox',id+'.json'),JSON.stringify(message));
  await run('external sync remote');
  assert.equal(rt.state.board('root').posts.filter(p => p.text === message.text).length,1);
  await run('review report 1 accepted passed "read sources at rev-a"');
  await run('reconcile');
  assert.equal(rt.state.memberByName('root','remote').status,'active');
  await run('pause remote');
  assert.equal((await rt.commands[0].handler({agent:rt.root,rawInput:'external sync remote'})).kind,'error');
  await run('resume remote');
  await run('external sync remote');
  assert.equal((await readMailbox(mailbox)).deliveries[0].status,'accepted');
  await run('finish');
  assert.equal((await rt.commands[0].handler({agent:rt.root,rawInput:'external sync remote'})).kind,'error');
  assert.equal(rt.sends.length,0);
});

test('only the lead may configure clocks or explicitly confirm a paid probe', async t => {
  const rt = await setup(); t.after(() => rt.host.close());
  registerSwarmCommands(rt.host);
  const run = (agent, rawInput) => rt.commands[0].handler({agent,rawInput});
  const alice = (await addAlice(rt)).member, worker = rt.agents.get(alice.sessionId);
  assert.deepEqual(JSON.parse((await run(rt.root,'clock')).text),{deadlineUtc:null,silenceMs:null});
  assert.equal((await run(worker,'clock silence 1')).kind,'error');
  const clock = await run(rt.root,'clock silence 2');
  assert.equal(clock.kind,'success',clock.text);
  assert.equal(JSON.parse(clock.text).silenceMs,120000);
  assert.equal((await run(rt.root,'clock deadline 2030-02-30T00:00Z')).kind,'error');
  assert.equal(JSON.parse((await run(rt.root,'clock off')).text).silenceMs,null);
  let dispatched = 0;
  rt.root.session.snapshotEvents = () => [];
  rt.root.session.requestHeader = () => ({config:{provider:'p',model:'m'}});
  rt.ctx.llm = {prepareCall:async config => {dispatched++;return {config,stream:async function*(){yield {type:'finish',reason:{kind:'stop'}};}}}};
  registerSwarmTools(rt.host);
  const coordinatorTool = rt.tools.find(t => t.definition.name === 'swarm').definition;
  assert.equal((await coordinatorTool.execute({action:'probe',confirmPaid:true},{agent:rt.root})).ok,false);
  assert.equal((await run(rt.root,'add bob check documentation')).kind,'success');
  assert.equal((await run(rt.root,'probe p/m')).kind,'error');
  assert.equal((await run(worker,'probe p/m --confirm-paid')).kind,'error');
  assert.equal(dispatched,0);
  const probe = await run(rt.root,'probe p/m --confirm-paid');
  assert.equal(probe.kind,'success',probe.text);
  assert.equal(dispatched,1);
});

test('registers gated tools and shows social tools only after a worker joins', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  registerSwarmTools(rt.host);

  assert.deepEqual(
    rt.tools.map((entry) => entry.definition.name).sort(),
    ['post_message', 'read_board', 'swarm', 'swarm_delivery', 'swarm_wait'],
  );
  const byName = Object.fromEntries(rt.tools.map((entry) => [entry.definition.name, entry]));
  assert.equal(byName.swarm.opts.when({ agent: rt.root }), true);
  assert.equal(byName.post_message.opts.when({ agent: rt.root }), false);

  await addAlice(rt);
  assert.equal(byName.post_message.opts.when({ agent: rt.root }), true);

  const status = await byName.swarm.definition.execute(
    { action: 'status' },
    { agent: rt.root, signal: new AbortController().signal },
  );
  assert.equal(status.ok, true);
  assert.match(status.summary, /Members: 2/);

  const planned = await byName.swarm.definition.execute(
    {
      action: 'plan',
      plan: {
        goal: 'ship the host',
        tasks: [{ id: 't1', title: 'wire tools', status: 'active', owner: 'alice' }],
        threads: [{ id: 'th1', channel: 'main', goal: 'review' }],
      },
    },
    { agent: rt.root, signal: new AbortController().signal },
  );
  assert.equal(planned.ok, true);
  assert.equal(planned.plan.goal, 'ship the host');
  const withPlan = rt.host.view('root');
  assert.equal(withPlan.plan.tasks[0].owner, 'alice');

  const created = await byName.swarm.definition.execute(
    { action: 'channel-create', channel: 'ops', topic: 'operations' },
    { agent: rt.root, signal: new AbortController().signal },
  );
  assert.equal(created.ok, true);
  assert.equal(created.channel.name, 'ops');

  const posted = await byName.post_message.definition.execute(
    { text: 'tool post' },
    { agent: rt.root, signal: new AbortController().signal },
  );
  assert.equal(posted.ok, true);

  const board = rt.state.board('root');
  const alice = Object.values(board.members).find((member) => member.name === 'alice');
  rt.agents.set(alice.sessionId, fakeAgent(alice.sessionId));
  const readExec = { name: 'read_board', agent: rt.agents.get(alice.sessionId), token: Symbol('read') };
  const read = await byName.read_board.definition.execute({}, readExec);
  rt.host.observeToolResult(readExec, { isError: false, content: byName.read_board.definition.output.render({}, read) });
  assert.equal(read.ok, true);
  assert.ok(Array.isArray(read.messages));

  let concluded = 0;
  const waited = await byName.swarm_wait.definition.execute(
    {},
    {
      agent: rt.agents.get(alice.sessionId),
      signal: new AbortController().signal,
      concludeTurn: () => {
        concluded += 1;
      },
    },
  );
  assert.equal(waited.ok, true);
  assert.equal(waited.waiting, true);
  assert.equal(concluded, 1);
});

test('read_board paginates by the rendered JSON and returns an oversized escaped post whole', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);
  registerSwarmTools(rt.host);
  const tool = rt.tools.find((entry) => entry.definition.name === 'read_board').definition;
  const agent = rt.agents.get(alice.sessionId);
  const read = async () => {
    const exec = { agent, name: 'read_board', token: Symbol('page') };
    const value = await tool.execute({}, exec);
    const content = tool.output.render({}, value);
    rt.host.observeToolResult(exec, { isError: false, content });
    const text = content[0].text;
    return { value, text, page: JSON.parse(text) };
  };

  const first = 'a'.repeat(6144);
  const second = 'b'.repeat(6144);
  await rt.host.post('root', 'root', first);
  await rt.host.post('root', 'root', second);

  const page1 = await read();
  assert.ok(page1.text.length <= 9000, 'ordinary pages fit the tool render limit');
  assert.deepEqual(page1.page.messages.map((message) => message.seq), [1]);
  assert.equal(page1.page.messages[0].text, first);

  const page2 = await read();
  assert.ok(page2.text.length <= 9000);
  assert.deepEqual(page2.page.messages.map((message) => message.seq), [2]);
  assert.equal(page2.page.messages[0].text, second);

  const escaped = '"'.repeat(6144);
  await rt.host.post('root', 'root', escaped);
  const page3 = await read();
  assert.deepEqual(page3.page.messages.map((message) => message.seq), [3]);
  assert.equal(page3.page.messages[0].text, escaped);
  assert.ok(page3.text.length > 9000, 'the escaped singleton alone exceeds the ordinary render budget');
  assert.equal(page3.page.lastReadSeq, 3);

  const empty = await read();
  assert.deepEqual(empty.page.messages, [], 'the next read is empty, not a repeat of the oversized post');
  assert.equal(empty.page.lastReadSeq, 3);
});

test('read_board commits only the confirmed page and repeats it after a blocked or rewritten delivery', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);
  registerSwarmTools(rt.host);
  const tool = rt.tools.find((entry) => entry.definition.name === 'read_board').definition;
  const agent = rt.agents.get(alice.sessionId);
  const emit = (exec, result) =>
    rt.events.find((event) => event.name === 'tools/result').handler(exec, result);
  const cursor = () => rt.state.member('root', alice.sessionId).lastReadSeq;
  const read = async (token, args = {}) => {
    const exec = { name: 'read_board', agent, token, signal: new AbortController().signal };
    const value = await tool.execute(args, exec);
    const content = tool.output.render({}, value);
    return { exec, value, content };
  };

  const first = 'a'.repeat(6144);
  const second = 'b'.repeat(6144);
  const third = 'c'.repeat(6144);
  await rt.host.post('root', 'root', first);
  await rt.host.post('root', 'root', second);

  const untracked = await read(undefined);
  assert.equal(untracked.value.ok, false, 'a read without a delivery token must fail closed');
  assert.equal(cursor(), 0);
  const blocked = await read('blocked');
  assert.deepEqual(blocked.value.messages.map((message) => message.seq), [1]);
  assert.equal(cursor(), 0, 'a preview does not move the cursor');
  emit(blocked.exec, { isError: true, content: blocked.content });
  await tick();
  assert.equal(cursor(), 0, 'a blocked tool result is not confirmed');

  const rewritten = await read('rewritten');
  assert.deepEqual(rewritten.value.messages.map((message) => message.seq), [1], 'the page repeats, not skips');
  emit(rewritten.exec, { isError: false, content: [{ type: 'text', text: 'policy rewrite' }] });
  await tick();
  assert.equal(cursor(), 0, 'rewritten content is not confirmed');

  const wrongCaller = await read('wrong-caller');
  emit({ ...wrongCaller.exec, agent: { id: 'someone-else' } }, {
    isError: false,
    content: wrongCaller.content,
  });
  await tick();
  assert.equal(cursor(), 0, 'a result for another caller cannot confirm this page');

  const dropped = await read('dropped');
  assert.deepEqual(dropped.value.messages.map((message) => message.seq), [1]);
  const recovered = await read('recovered-after-drop');
  assert.deepEqual(
    recovered.value.messages.map((message) => message.seq),
    [1],
    'a result that is never observed leaves the page to be read again',
  );

  const page1 = await read('page-1');
  assert.deepEqual(page1.value.messages.map((message) => message.seq), [1]);
  await rt.host.post('root', 'root', third);
  emit(page1.exec, { isError: false, content: page1.content });
  assert.equal(cursor(), 0, 'the commit is queued, not run inside the synchronous event');

  const page2 = await read('page-2');
  assert.equal(cursor(), 1, 'the next read waits for the prior page to commit');
  assert.deepEqual(
    page2.value.messages.map((message) => message.seq),
    [2],
    'the post published after the preview is not folded into the committed page',
  );
  emit(page2.exec, { isError: false, content: page2.content });
  const page3 = await read('page-3');
  assert.equal(cursor(), 2, 'the next read waits for page 2 to commit');
  assert.deepEqual(page3.value.messages.map((message) => message.seq), [3]);

  const peek = await read('peek', { peek: true, since: 0 });
  assert.equal(peek.value.peek, true);
  assert.equal(rt.host.pendingReads.has('peek'), false, 'peek is not armed for a commit');
  emit(peek.exec, { isError: false, content: peek.content });
  await tick();
  assert.equal(cursor(), 2, 'a peek result never advances the cursor');
});

test('the read receipt confirms the original page without rendering a second explicit-seq page', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);
  registerSwarmTools(rt.host);
  const tool = rt.tools.find((entry) => entry.definition.name === 'read_board').definition;
  const agent = rt.agents.get(alice.sessionId);
  // Two posts just below the normal page budget. A larger receipt envelope
  // used to re-paginate the page and acknowledge only the first post.
  await rt.host.post('root', 'root', 'a'.repeat(4052));
  await rt.host.post('root', 'root', 'b'.repeat(4052));
  const exec = { name: 'read_board', agent, token: Symbol('two posts') };
  const value = await tool.execute({}, exec);
  assert.deepEqual(value.messages.map((m) => m.seq), [1, 2]);
  rt.host.observeToolResult(exec, { isError: false, content: tool.output.render({}, value) });
  await rt.host.awaitReadCommit(alice.sessionId);
  assert.equal(rt.state.member('root', alice.sessionId).lastReadSeq, 2);
});

test('read_board leaves the cursor untouched when committing the delivered page fails', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);
  registerSwarmTools(rt.host);
  const tool = rt.tools.find((entry) => entry.definition.name === 'read_board').definition;
  const agent = rt.agents.get(alice.sessionId);
  const emit = (exec, result) =>
    rt.events.find((event) => event.name === 'tools/result').handler(exec, result);
  const originalAct = rt.state.act.bind(rt.state);
  let rejected = false;
  rt.state.act = async (rootId, actorId, action) => {
    if (!rejected && action.type === 'confirmRead') {
      rejected = true;
      throw new Error('disk full');
    }
    return originalAct(rootId, actorId, action);
  };

  await rt.host.post('root', 'root', 'x'.repeat(6144));
  const read = async (token) => {
    const exec = { name: 'read_board', agent, token, signal: new AbortController().signal };
    const value = await tool.execute({}, exec);
    return { exec, value, content: tool.output.render({}, value) };
  };

  const first = await read('first');
  emit(first.exec, { isError: false, content: first.content });
  await rt.host.awaitReadCommit(alice.sessionId);
  assert.equal(rt.state.member('root', alice.sessionId).lastReadSeq, 0, 'a failed commit is conservative');

  const retry = await read('retry');
  assert.deepEqual(
    retry.value.messages.map((message) => message.seq),
    [1],
    'the reader repeats the undelivered page instead of skipping it',
  );
  emit(retry.exec, { isError: false, content: retry.content });
  await rt.host.awaitReadCommit(alice.sessionId);
  assert.equal(rt.state.member('root', alice.sessionId).lastReadSeq, 1);
});

test('resuming a paused active member keeps it stopped and wakeable, ignoring its stale activation', async (t) => {
  const gate = deferred();
  const rt = await setup({ activationResult: gate.promise });
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);

  await rt.host.pauseMember('root', 'alice');
  const resumed = await rt.host.resumeMember('root', 'alice');
  assert.equal(resumed.status, 'stopped', 'a released activation cannot be resumed optimistically');
  assert.equal(rt.sends.length, 0, 'there was no unread directed post to catch up');

  await rt.host.post('root', 'root', 'now wake @alice');
  assert.equal(rt.sends.length, 1, 'a later mention still wakes the resumed member');
  assert.equal(rt.sends[0].targetId, alice.sessionId);
  assert.equal(rt.state.board('root').pendingWakes.length, 0);

  gate.resolve({ stopReason: 'error', diagnostic: 'activation went away while paused' });
  await tick();
  await tick();
  assert.equal(rt.root.steers.length, 0, 'the stale activation callback must not report a stop for the live member');
  assert.equal(rt.state.member('root', alice.sessionId).status, 'stopped');

  await rt.host.pauseMember('root', 'alice');
  await rt.host.post('root', 'root', 'missed @alice');
  assert.equal(rt.sends.length, 1, 'a paused member is not woken');
  const caught = await rt.host.resumeMember('root', 'alice');
  assert.equal(caught.status, 'stopped');
  assert.equal(rt.sends.length, 2, 'resume catches up the missed directed post exactly once');
  assert.equal(rt.sends[1].targetId, alice.sessionId);
  assert.match(rt.sends[1].text, /new board activity|unread/i);
  assert.equal(rt.state.board('root').pendingWakes.length, 0);
});

test('commands cover view, done and explicit channel membership', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);
  registerSwarmCommands(rt.host);
  assert.equal(rt.commands.length, 1);
  const command = rt.commands[0];
  const run = (agent, rawInput) =>
    command.handler({ agent, rawInput, signal: new AbortController().signal });

  const view = await run(rt.root, 'view');
  assert.equal(view.kind, 'success');
  const packet = JSON.parse(view.text);
  assert.deepEqual(Object.keys(packet), [
    'v',
    'title',
    'seq',
    'plan',
    'counts',
    'members',
    'messages',
    'channels',
  ]);
  assert.equal(packet.v, 1);
  assert.equal('rootId' in packet, false);
  assert.equal('members' in packet, true);

  const memberView = await run(rt.agents.get(alice.sessionId), 'view');
  assert.equal(memberView.kind, 'error');
  assert.match(memberView.text, /FORBIDDEN|only the swarm root/);

  const memberStatus = await run(rt.agents.get(alice.sessionId), 'status');
  assert.equal(memberStatus.kind, 'error');
  assert.match(memberStatus.text, /FORBIDDEN|only the swarm root/);

  const channel = await run(rt.root, 'channel create ops operations');
  assert.equal(channel.kind, 'success');
  const added = await run(rt.root, `channel add ops alice`);
  assert.equal(added.kind, 'success');
  const list = await run(rt.root, 'channel list');
  assert.match(list.text, /#ops/);

  const done = await run(rt.root, 'done all green');
  assert.equal(done.kind, 'success');
  const board = rt.state.board('root');
  assert.ok(board.posts.some((post) => post.kind === 'post' && /^\[done\] all green$/.test(post.text)));

  const usage = await run(rt.root, 'help');
  assert.match(usage.text, /\/swarm init/);
});

test('finish reports a partial kill instead of claiming success', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);
  const bob = await addAlice(rt, { name: 'bob' });
  registerSwarmCommands(rt.host);
  const command = rt.commands[0];

  const kill = rt.host.killMember.bind(rt.host);
  let calls = 0;
  rt.host.killMember = async (...args) => {
    calls += 1;
    if (calls === 2) throw new Error('refused by runtime');
    return kill(...args);
  };

  const out = await command.handler({
    agent: rt.root,
    rawInput: 'finish',
    signal: new AbortController().signal,
  });
  assert.equal(out.kind, 'error');
  assert.match(out.text, /partial/i);
  const board = rt.state.board('root');
  assert.equal(board.members[alice.sessionId].status, 'killed');
  assert.notEqual(board.members[bob.sessionId].status, 'killed');
});

test('finish reports an unconfirmed dispose instead of claiming success', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);
  registerSwarmCommands(rt.host);
  const command = rt.commands[0];
  const handle = rt.host.handles.get(alice.sessionId);
  handle.dispose = async () => {
    throw new Error('child is still running');
  };

  const out = await command.handler({
    agent: rt.root,
    rawInput: 'finish',
    signal: new AbortController().signal,
  });
  assert.equal(out.kind, 'error', 'unconfirmed disposal must not be a success');
  assert.match(out.text, /dispose unconfirmed|partial/i);
  assert.match(out.text, /child is still running/);
  assert.equal(rt.state.member('root', alice.sessionId).status, 'killed');
});

test('finish retries a retained unconfirmed disposal on a later call', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const alice = await addAlice(rt);
  registerSwarmCommands(rt.host);
  const command = rt.commands[0];
  const handle = rt.host.handles.get(alice.sessionId);
  let disposeCalls = 0;
  handle.dispose = async () => {
    disposeCalls += 1;
    if (disposeCalls === 1) throw new Error('child is still running');
    rt.disposals.push(alice.sessionId);
    rt.agents.delete(alice.sessionId);
  };

  const first = await command.handler({
    agent: rt.root,
    rawInput: 'finish',
    signal: new AbortController().signal,
  });
  assert.equal(first.kind, 'error', 'the first finish reports the unconfirmed disposal');
  assert.match(first.text, /dispose unconfirmed|partial/i);
  assert.equal(rt.state.member('root', alice.sessionId).status, 'killed');
  assert.equal(disposeCalls, 1);
  assert.equal(rt.host.handles.has(alice.sessionId), true, 'the live handle is retained for a retry');

  const second = await command.handler({
    agent: rt.root,
    rawInput: 'finish',
    signal: new AbortController().signal,
  });
  assert.equal(second.kind, 'success', 'the later finish can confirm the retained disposal');
  assert.equal(disposeCalls, 2);
  assert.equal(rt.host.handles.has(alice.sessionId), false);
});

test('finish ignores a transient reservation revocation failure once the final board is empty', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  registerSwarmCommands(rt.host);
  const command = rt.commands[0];
  const reserved = await rt.state.act('root', 'root', {
    type: 'reserveJoin',
    member: { sessionId: 'session-transient', name: 'transient', role: 'worker' },
  });
  const reservationId = reserved.result.reservationId;

  const originalAct = rt.state.act.bind(rt.state);
  let failJoinCalls = 0;
  rt.state.act = async (rootId, actorId, action) => {
    if (action.type === 'failJoin') {
      failJoinCalls += 1;
      if (failJoinCalls === 1) throw new Error('transient store error');
    }
    return originalAct(rootId, actorId, action);
  };

  const out = await command.handler({
    agent: rt.root,
    rawInput: 'finish',
    signal: new AbortController().signal,
  });
  assert.equal(out.kind, 'success', 'a seat revoked on the retry is not reported still open');
  assert.equal(failJoinCalls, 2);
  assert.equal(rt.state.board('root').reservations[reservationId], undefined);
});

test('finish reports reservations it could not revoke instead of claiming success', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  registerSwarmCommands(rt.host);
  const command = rt.commands[0];
  const reserved = await rt.state.act('root', 'root', {
    type: 'reserveJoin',
    member: { sessionId: 'session-stuck', name: 'stuck', role: 'worker' },
  });
  assert.equal(reserved.result.ok, true);
  const reservationId = reserved.result.reservationId;

  const originalAct = rt.state.act.bind(rt.state);
  rt.state.act = async (rootId, actorId, action) => {
    if (action.type === 'failJoin') throw new Error('store refused the revocation');
    return originalAct(rootId, actorId, action);
  };

  const out = await command.handler({
    agent: rt.root,
    rawInput: 'finish',
    signal: new AbortController().signal,
  });
  assert.equal(out.kind, 'error');
  assert.match(out.text, new RegExp(`reservation ${reservationId}: still open`));
  assert.ok(rt.state.board('root').reservations[reservationId], 'the reservation is visibly still open');
});

test('concurrent finishes share one drain', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const gate = deferred();
  let calls = 0;
  rt.host.runFinish = async () => {
    calls += 1;
    await gate.promise;
    return { killed: [], failed: [], cancelled: 0 };
  };
  const first = rt.host.finish('root');
  const second = rt.host.finish('root');
  assert.equal(calls, 1, 'the second finish joins the running drain');
  gate.resolve();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
});

test('finish publishes its drain promise before a synchronous cancel callback can re-enter', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const gate = deferred();
  rt.ctx.subagents.startActivation = async (spec) => {
    await gate.promise;
    return {
      childId: spec.childId,
      result: new Promise(() => {}),
      dispose: async () => {
        rt.disposals.push(spec.childId);
      },
    };
  };

  const adding = addAlice(rt).then(
    () => null,
    (error) => error,
  );
  await waitFor(() => {
    const guard = [...rt.host.inflightAdds.values()][0];
    return guard?.controller && Object.keys(rt.state.board('root').reservations).length === 1;
  }, 'the add to reserve its seat and install its abort controller');

  const guard = [...rt.host.inflightAdds.values()][0];
  let reentrant;
  guard.controller.signal.addEventListener(
    'abort',
    () => {
      reentrant = rt.host.finish('root');
    },
    { once: true },
  );

  const finishing = rt.host.finish('root');
  assert.ok(reentrant instanceof Promise, 'the synchronous abort listener can join the published drain');
  gate.resolve();
  const [outcome, reentrantOutcome] = await Promise.all([finishing, reentrant]);
  assert.deepEqual(reentrantOutcome, outcome);
  assert.equal(outcome.failed.length, 0);
  assert.match(String(await adding), /finish|cancel/i);
});

test('finish waits for an in-flight add whose spawn ignores the signal, revokes it, and keeps the board open', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  registerSwarmCommands(rt.host);
  const command = rt.commands[0];
  const gate = deferred();
  let gatedSpec;

  rt.ctx.subagents.startActivation = async (spec) => {
    gatedSpec = spec;
    await gate.promise;
    const child = fakeAgent(spec.childId);
    rt.agents.set(child.id, child);
    return {
      childId: spec.childId,
      result: new Promise(() => {}),
      dispose: async () => {
        rt.disposals.push(spec.childId);
        rt.agents.delete(spec.childId);
      },
    };
  };

  const adding = addAlice(rt).then(
    () => null,
    (error) => error,
  );
  await waitFor(
    () => Object.keys(rt.state.board('root').reservations).length === 1,
    'the add to reserve its seat',
  );

  const finishing = command.handler({
    agent: rt.root,
    rawInput: 'finish',
    signal: new AbortController().signal,
  });
  let settled = false;
  finishing.then(() => {
    settled = true;
  });
  await waitFor(
    () => Object.keys(rt.state.board('root').reservations).length === 0,
    'finish to revoke the open reservation',
  );
  assert.equal(settled, false, 'finish must wait for the in-flight add to end');
  await assert.rejects(() => addAlice(rt, { name: 'bob' }), /finish|busy/i);

  gate.resolve();
  const addError = await adding;
  assert.match(String(addError), /finish|cancel/i);
  assert.ok(rt.disposals.includes(gatedSpec.childId), 'the spawned activation is compensated');

  const out = await finishing;
  assert.equal(out.kind, 'success');
  const board = rt.state.board('root');
  assert.equal(board.members[gatedSpec.childId], undefined, 'the accepted add never registers late');
  assert.deepEqual(Object.keys(board.reservations), []);

  const bob = await addAlice(rt, { name: 'bob' });
  assert.equal(rt.state.member('root', bob.sessionId).status, 'active', 'finish does not close the blackboard');
});

test('finish cancels an add whose commit lands after the drain has started', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  registerSwarmCommands(rt.host);
  const command = rt.commands[0];
  const commitGate = deferred();
  const commitEntered = deferred();
  const original = rt.state.act.bind(rt.state);
  let held = false;
  rt.state.act = async (rootId, actorId, action) => {
    const out = await original(rootId, actorId, action);
    if (!held && action.type === 'commitJoin') {
      held = true;
      commitEntered.resolve();
      await commitGate.promise;
    }
    return out;
  };

  const adding = addAlice(rt).then(
    () => null,
    (error) => error,
  );
  await commitEntered.promise;
  const finishing = command.handler({
    agent: rt.root,
    rawInput: 'finish',
    signal: new AbortController().signal,
  });
  commitGate.resolve();

  assert.match(String(await adding), /finish|cancel/i);
  assert.equal((await finishing).kind, 'success');
  const board = rt.state.board('root');
  const workers = Object.values(board.members).filter((member) => member.role !== 'coordinator');
  assert.equal(workers.length, 1);
  assert.equal(workers[0].status, 'killed', 'a commit that won the race is killed before finish returns');
  assert.ok(rt.disposals.includes(rt.spawns[0].childId), 'the late activation is disposed');
});

test('finish still succeeds when a cancelled spawn throws', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  registerSwarmCommands(rt.host);
  const command = rt.commands[0];
  const gate = deferred();
  rt.ctx.subagents.startActivation = async () => {
    await gate.promise;
    throw new Error('spawn refused after cancellation');
  };

  const adding = addAlice(rt).then(
    () => null,
    (error) => error,
  );
  await waitFor(
    () => Object.keys(rt.state.board('root').reservations).length === 1,
    'the add to reserve its seat',
  );
  const finishing = command.handler({
    agent: rt.root,
    rawInput: 'finish',
    signal: new AbortController().signal,
  });
  await waitFor(
    () => Object.keys(rt.state.board('root').reservations).length === 0,
    'finish to revoke the open reservation',
  );
  gate.resolve();

  const addError = await adding;
  assert.match(String(addError), /spawn refused|cancel/i);
  const out = await finishing;
  assert.equal(out.kind, 'success');
  assert.equal(Object.keys(rt.state.board('root').members).length, 1, 'coordinator only');
  assert.deepEqual(Object.keys(rt.state.board('root').reservations), []);
});

test('finish on one root does not block an add on another root', async (t) => {
  const rt = await setup();
  t.after(() => rt.host.close());
  const root2 = fakeAgent('root-2');
  rt.agents.set(root2.id, root2);
  const baseRootOf = rt.ctx.subagents.rootOf.bind(rt.ctx.subagents);
  rt.ctx.subagents.rootOf = (agent) => (agent.id === root2.id ? root2 : baseRootOf(agent));
  await rt.state.create(root2, 'Other', 'lead');
  registerSwarmCommands(rt.host);
  const command = rt.commands[0];

  const gate = deferred();
  const baseStart = rt.ctx.subagents.startActivation.bind(rt.ctx.subagents);
  rt.ctx.subagents.startActivation = async (spec) => {
    if (spec.parent.id === 'root') await gate.promise;
    return baseStart(spec);
  };

  const adding = addAlice(rt).then(
    () => null,
    (error) => error,
  );
  await waitFor(
    () => Object.keys(rt.state.board('root').reservations).length === 1,
    'the first root to reserve',
  );
  const finishing = command.handler({
    agent: rt.root,
    rawInput: 'finish',
    signal: new AbortController().signal,
  });
  await waitFor(
    () => Object.keys(rt.state.board('root').reservations).length === 0,
    'finish to revoke the first root reservation',
  );

  const other = await rt.host.addMember({
    rootAgent: root2,
    name: 'carol',
    prompt: 'other task',
    signal: new AbortController().signal,
  });
  assert.equal(rt.state.member(root2.id, other.sessionId).status, 'active');

  gate.resolve();
  assert.match(String(await adding), /finish|cancel/i);
  assert.equal((await finishing).kind, 'success');
  assert.equal(rt.state.member(root2.id, other.sessionId).status, 'active', 'the other board stays usable');
});

test('board keys are path-safe for per-record storage', () => {
  for (const rootId of ['root-1', 'a:b/c', 'x'.repeat(200)]) {
    const key = boardKey(rootId);
    assert.match(key, /^[A-Za-z0-9_-]+$/);
  }
  assert.notEqual(boardKey('a:b'), boardKey('a_b'));
});

test('a local message factory matches the dsh UserMessage data shape', () => {
  const message = createSwarmMessage('hello', 'summary');
  assert.equal(message.role, 'user');
  assert.equal(message.content[0].type, 'text');
  assert.equal(message.source.kind, 'swarm');
  assert.equal(message.source.form, 'notice');
  assert.equal(Object.isFrozen(message), true);
  assert.equal(typeof message.id, 'string');
  assert.equal(formatStatus({ title: 'x', seq: 0, plan: null, counts: { members: 1, active: 0 }, members: [], messages: [] }), 'Swarm "x" — seq 0\nMembers: 1 (0 active workers)');
});

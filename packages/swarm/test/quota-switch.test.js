import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import * as boardApi from '../src/board.js';
import { BoardState } from '../src/host-state.js';
import { SwarmHost } from '../src/host-runtime.js';
import {
  ROUTE_ERRORS,
  agentModelRoute,
  assertRouteAllowed,
  assertRouteAvailable,
  modelRouteLabel,
  normalizeModelRoute,
  readAllowedModelRoutes,
  sameModelRoute,
} from '../src/model-routes.js';
import { readQuotaAdvisory } from '../src/quota-advisory.js';

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

const CHAT = { provider: 'deepseek', model: 'chat' };
const BACKUP = { provider: 'backup', model: 'flash' };

function sessionWithPolicy({ parent = CHAT, policy, events } = {}) {
  const recorded = events ?? (policy === undefined
    ? []
    : [{ type: 'subagent/model-selection-policy', data: { allowedModels: policy } }]);
  return {
    id: 'root',
    seq: recorded.length,
    requestHeader: () => ({ config: { ...parent } }),
    snapshotEvents: () => recorded,
    eventAt: (index) => recorded[index],
  };
}

function fakeAgent(id, extra = {}) {
  return {
    id,
    options: { provider: CHAT.provider, model: CHAT.model },
    session: { id },
    steers: [],
    steer(message) {
      this.steers.push(message);
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

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate, label, iterations = 200, delayMs = 0) {
  for (let index = 0; index < iterations; index += 1) {
    if (predicate()) return;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    else await tick();
  }
  assert.fail(`timed out waiting for ${label}`);
}

function makeRuntime({ rootSession, llm, account } = {}) {
  const root = fakeAgent('root');
  if (rootSession) root.session = rootSession;
  const agents = new Map([[root.id, root]]);
  const spawns = [];
  const sends = [];
  const selected = [];
  const actions = [];
  const llmCalls = [];

  const resolvedLlm = llm ?? {
    async resolveCallConfig(route) {
      llmCalls.push(route);
      return { config: route };
    },
  };

  const ctx = {
    agents: {
      get: (id) => agents.get(id) ?? null,
      list: () => [...agents.values()],
    },
    workingDirectory: {
      get: () => '/workspace/shared',
      ensure: async () => '/workspace/shared',
    },
    tools: { register: () => () => {} },
    commands: { register: () => () => {} },
    on: () => () => {},
    get(key) {
      if (key === 'llm') return resolvedLlm;
      if (key === 'deepseekAccount') return account ?? null;
      return undefined;
    },
    subagents: {
      rootOf: (agent) => (agent.id === root.id ? root : root),
      resolveMaxDepth: () => 3,
      async startActivation(spec) {
        spawns.push(spec);
        const child = fakeAgent(spec.childId);
        child.session = { id: spec.childId };
        agents.set(child.id, child);
        return {
          childId: spec.childId,
          name: spec.name,
          messageId: 'm1',
          result: new Promise(() => {}),
          dispose: async () => {
            agents.delete(spec.childId);
          },
        };
      },
      async sendMessage(sender, targetId, content) {
        sends.push({ sender: sender.id, targetId, text: content[0]?.text });
        return `sent-${sends.length}`;
      },
      interrupt() {},
    },
    logger: null,
  };

  const store = new MemoryStore();
  const state = new BoardState({ ctx, store, board: boardApi, channels: {}, logger: null });
  const host = new SwarmHost({ ctx, store, state, channels: {}, logger: null, makeMessage });

  // board.js on this branch predates the lead's consumeFallback/confirmedSwitch
  // additions; emulate those coordinator-only transitions so the host half can
  // be exercised end-to-end without editing the core.
  const originalAct = state.act.bind(state);
  state.act = async (rootId, actorId, action) => {
    actions.push(action);
    const board = state.board(rootId);
    const member = action.target ? board?.members?.[action.target] : null;
    if (action.type === 'consumeFallback') {
      if (!member) return { result: { ok: false, code: 'NOT_FOUND' } };
      if (!member.fallbackRoute) return { result: { ok: false, code: 'NO_FALLBACK' } };
      if (action.expect && !sameModelRoute(action.expect, member.modelRoute)) {
        return { result: { ok: false, code: 'STALE_ROUTE' } };
      }
      const route = { ...member.fallbackRoute };
      member.fallbackRoute = null;
      return { result: { ok: true, route } };
    }
    if (action.type === 'setModel' && action.confirmedSwitch) {
      if (!member) return { result: { ok: false, code: 'NOT_FOUND' } };
      member.modelRoute = { ...action.modelRoute };
      return { result: { ok: true, member } };
    }
    return originalAct(rootId, actorId, action);
  };

  return { root, agents, ctx, store, state, host, spawns, sends, selected, actions, llmCalls };
}

async function setup(options = {}) {
  const rt = makeRuntime(options);
  await rt.state.create(rt.root, 'Swarm', 'lead');
  const added = await rt.host.addMember({
    rootAgent: rt.root,
    name: 'alice',
    prompt: 'do the task',
    role: 'worker',
    signal: new AbortController().signal,
  });
  const board = rt.state.board('root');
  const member = board.members[added.sessionId];
  member.modelRoute = { ...(options.primary ?? CHAT) };
  member.fallbackRoute = options.fallback === null ? null : { ...(options.fallback ?? BACKUP) };
  const agent = rt.agents.get(added.sessionId);
  const idle = deferred();
  const selections = [];
  agent.model = {
    current: () => member.modelRoute,
    select: (selection) => {
      selections.push(selection);
      if (options.selectThrows) throw new Error('cannot switch model');
    },
  };
  agent.whenIdle = options.whenIdle ?? (() => idle.promise);
  return { ...rt, member, agent, idle, selections, sessionId: added.sessionId };
}

function quotaFailure(code = 'ACCOUNT_QUOTA') {
  return { code, message: code === 'QUOTA' ? 'provider quota exhausted' : 'account quota exhausted' };
}

// ---------------------------------------------------------------------------
// Route admission
// ---------------------------------------------------------------------------

test('normalizes routes and rejects malformed ones', () => {
  assert.deepEqual(normalizeModelRoute('deepseek/chat'), CHAT);
  assert.deepEqual(normalizeModelRoute({ provider: ' a ', model: ' b/c ' }), { provider: 'a', model: 'b/c' });
  assert.equal(normalizeModelRoute(undefined), null);
  assert.throws(() => normalizeModelRoute({ provider: 'a' }, 'primary route'), (error) => error.code === ROUTE_ERRORS.INVALID);
  assert.throws(() => normalizeModelRoute('no-slash'), (error) => error.code === ROUTE_ERRORS.INVALID);
});

test('without a recorded policy only the parent route is explicitly allowed', () => {
  const session = sessionWithPolicy();
  const rootAgent = { session };
  assert.deepEqual(agentModelRoute(rootAgent), CHAT);
  assert.deepEqual(assertRouteAllowed(CHAT, { rootAgent }), CHAT);
  assert.throws(
    () => assertRouteAllowed(BACKUP, { rootAgent, label: 'fallback route' }),
    (error) => error.code === ROUTE_ERRORS.NOT_AUTHORIZED && /limited to the parent route/.test(error.message),
  );
});

test('a recorded policy admits exactly its allowlist', () => {
  const session = sessionWithPolicy({ policy: [CHAT, BACKUP] });
  const rootAgent = { session };
  assert.deepEqual(readAllowedModelRoutes(session), [CHAT, BACKUP]);
  assert.deepEqual(assertRouteAllowed(BACKUP, { rootAgent }), BACKUP);
  assert.throws(
    () => assertRouteAllowed({ provider: 'other', model: 'x' }, { rootAgent }),
    (error) => error.code === ROUTE_ERRORS.NOT_AUTHORIZED && /allowlist/.test(error.message),
  );
});

test('malformed policies fail closed', () => {
  for (const policy of [[], [{}], [{ provider: 'a', model: 'b', extra: true }], [CHAT, CHAT]]) {
    const session = sessionWithPolicy({ policy });
    assert.throws(() => readAllowedModelRoutes(session), (error) => error.code === ROUTE_ERRORS.POLICY_INVALID);
  }
  const unavailable = { session: {} };
  assert.throws(
    () => readAllowedModelRoutes(unavailable.session),
    (error) => error.code === ROUTE_ERRORS.POLICY_UNAVAILABLE,
  );
});

test('route availability uses resolveCallConfig and reports unsupported or unregistered routes', async () => {
  const calls = [];
  const llm = { async resolveCallConfig(route) { calls.push(route); } };
  await assertRouteAvailable(llm, CHAT, { label: 'primary route' });
  assert.deepEqual(calls, [CHAT]);
  await assert.rejects(
    () => assertRouteAvailable({}, CHAT, { label: 'primary route' }),
    (error) => error.code === ROUTE_ERRORS.UNAVAILABLE && /resolveCallConfig/.test(error.message),
  );
  await assert.rejects(
    () => assertRouteAvailable({
      async resolveCallConfig() {
        const error = new Error('no adapter registered for provider "backup"');
        error.code = 'NO_ADAPTER';
        throw error;
      },
    }, BACKUP),
    (error) => error.code === ROUTE_ERRORS.UNAVAILABLE
      && /backup\/flash/.test(error.message)
      && error.details?.causeCode === 'NO_ADAPTER',
  );
});

test('validateDispatchRoutes normalizes, authorizes and checks both routes', async () => {
  const rt = makeRuntime({ rootSession: sessionWithPolicy({ policy: [CHAT, BACKUP] }) });
  const out = await rt.host.validateDispatchRoutes(CHAT, BACKUP, { rootAgent: rt.root });
  assert.deepEqual(out, { primary: CHAT, fallback: BACKUP });
  assert.equal(rt.llmCalls.length, 2);
  await assert.rejects(
    () => rt.host.validateDispatchRoutes(CHAT, CHAT, { rootAgent: rt.root }),
    (error) => error.code === ROUTE_ERRORS.INVALID,
  );
  const strict = makeRuntime({ rootSession: sessionWithPolicy() });
  await assert.rejects(
    () => strict.host.validateDispatchRoutes(CHAT, BACKUP, { rootAgent: strict.root }),
    (error) => error.code === ROUTE_ERRORS.NOT_AUTHORIZED,
  );
  await strict.host.close();
  await rt.host.close();
});

test('validateDispatchRoutes inherits the parent route when only a fallback is given', async () => {
  const rt = makeRuntime({ rootSession: sessionWithPolicy({ policy: [CHAT, BACKUP] }) });
  const out = await rt.host.validateDispatchRoutes(undefined, BACKUP, { rootAgent: rt.root });
  assert.deepEqual(out, { primary: CHAT, fallback: BACKUP });
  await rt.host.close();
});

// ---------------------------------------------------------------------------
// Account advisory
// ---------------------------------------------------------------------------

test('quota advisory reports exact wallets and never fabricates a percentage', async () => {
  const account = {
    async getBalance(client) {
      assert.equal(typeof client.version, 'string');
      assert.equal(typeof client.locale, 'string');
      assert.equal(typeof client.timezoneOffsetSeconds, 'number');
      return {
        status: 'ready',
        value: [{ currency: 'CNY', balance: '12.34' }],
        bonusWallets: [{ currency: 'USD', balance: '0.50' }],
      };
    },
  };
  const rt = makeRuntime({ rootSession: sessionWithPolicy(), account });
  const report = await rt.host.quotaAdvisory();
  assert.deepEqual(report, {
    supported: true,
    signedIn: true,
    balances: [
      { wallet: 'recharge', currency: 'CNY', amount: '12.34' },
      { wallet: 'bonus', currency: 'USD', amount: '0.50' },
    ],
  });
  await rt.host.close();
});

test('quota advisory states unsupported, signed-out and unavailable outcomes', async () => {
  const unsupported = await readQuotaAdvisory({});
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.reason, /does not expose a DeepSeek account balance/);

  const signedOut = await readQuotaAdvisory({ get: () => ({ getBalance: async () => null }) });
  assert.deepEqual(signedOut, { supported: true, signedIn: false, balances: null, reason: 'not signed in to a DeepSeek account' });

  const failed = await readQuotaAdvisory({
    get: () => ({ getBalance: async () => ({ status: 'failed' }) }),
  });
  assert.equal(failed.supported, true);
  assert.equal(failed.signedIn, true);
  assert.equal(failed.balances, null);

  const hanging = await readQuotaAdvisory(
    { get: () => ({ getBalance: () => new Promise(() => {}) }) },
    { timeoutMs: 5 },
  );
  assert.equal(hanging.supported, true);
  assert.equal(hanging.balances, null);
  assert.match(hanging.reason, /did not complete/);
});

// ---------------------------------------------------------------------------
// Quota switch
// ---------------------------------------------------------------------------

test('account quota switches the same member session to the fallback and continues it', async (t) => {
  const rt = await setup({ rootSession: sessionWithPolicy({ policy: [CHAT, BACKUP] }) });
  t.after(() => rt.host.close());
  let nextCalls = 0;
  const result = await rt.host.requestError(
    { agent: rt.agent, failure: quotaFailure('ACCOUNT_QUOTA') },
    async () => {
      nextCalls += 1;
      return { kind: 'retry' };
    },
  );
  assert.equal(result, undefined, 'the in-place retry is suppressed during the switch');
  assert.equal(nextCalls, 1, 'next is invoked exactly once');
  assert.deepEqual(rt.selections, [BACKUP], 'the live agent selects the fallback route');
  assert.equal(rt.member.fallbackRoute, null, 'the fallback is consumed exactly once');
  assert.deepEqual(rt.member.modelRoute, BACKUP, 'the board records the confirmed route');
  const consume = rt.actions.find((action) => action.type === 'consumeFallback');
  assert.deepEqual(consume.expect, CHAT, 'the claim is bound to the pre-switch route');
  const setModel = rt.actions.find((action) => action.type === 'setModel');
  assert.equal(setModel.confirmedSwitch, true, 'a working member can be switched explicitly');
  assert.equal(rt.sends.length, 0, 'the continuation waits for the interrupted turn to go idle');

  rt.idle.resolve();
  await waitFor(() => rt.sends.length === 1, 'continuation send');
  assert.equal(rt.sends[0].targetId, rt.sessionId, 'the SAME member session is continued');
  assert.match(rt.sends[0].text, /same member session/);
  assert.match(rt.sends[0].text, /backup\/flash/);
  await waitFor(() => rt.root.steers.some((message) => /Switched "alice"/.test(message.content[0].text)), 'root notice');
  assert.equal(rt.state.member('root', rt.sessionId).status, 'active', 'the member is not paused on success');
});

test('a duplicate retry cannot consume the fallback twice', async (t) => {
  const rt = await setup({ rootSession: sessionWithPolicy({ policy: [CHAT, BACKUP] }) });
  t.after(() => rt.host.close());
  const next = async () => ({ kind: 'retry' });
  await rt.host.requestError({ agent: rt.agent, failure: quotaFailure() }, next);
  const before = rt.actions.filter((action) => action.type === 'consumeFallback').length;
  const second = await rt.host.requestError({ agent: rt.agent, failure: quotaFailure() }, next);
  assert.equal(second, undefined);
  assert.equal(
    rt.actions.filter((action) => action.type === 'consumeFallback').length,
    before,
    'the in-flight marker suppresses a duplicate claim',
  );
  rt.idle.resolve();
  await waitFor(() => rt.sends.length === 1, 'single continuation');
  assert.equal(rt.sends.length, 1);
});

test('quota exhaustion without a fallback pauses immediately and keeps the session', async (t) => {
  const rt = await setup({ rootSession: sessionWithPolicy(), fallback: null });
  t.after(() => rt.host.close());
  const result = await rt.host.requestError(
    { agent: rt.agent, failure: quotaFailure('QUOTA') },
    async () => ({ kind: 'retry' }),
  );
  assert.equal(result, undefined);
  assert.equal(rt.state.member('root', rt.sessionId).status, 'paused');
  assert.equal(rt.actions.some((action) => action.type === 'consumeFallback'), false);
  assert.equal(rt.selections.length, 0);
  assert.ok(rt.root.steers.some((message) => /Paused "alice"/.test(message.content[0].text)));
  assert.match(rt.root.steers.at(-1).content[0].text, /no fallback route/);
});

test('an unauthorized fallback is never consumed and the member pauses safely', async (t) => {
  const rt = await setup({ rootSession: sessionWithPolicy({ policy: [CHAT] }) });
  t.after(() => rt.host.close());
  const result = await rt.host.requestError(
    { agent: rt.agent, failure: quotaFailure() },
    async () => ({ kind: 'retry' }),
  );
  assert.equal(result, undefined);
  assert.equal(rt.state.member('root', rt.sessionId).status, 'paused');
  assert.equal(rt.actions.some((action) => action.type === 'consumeFallback'), false);
  assert.deepEqual(rt.member.fallbackRoute, BACKUP, 'the durable fallback stays claimable after a resume');
  assert.match(rt.root.steers.at(-1).content[0].text, /not in this Session's model-selection allowlist/);
});

test('a failed model selection consumes the fallback once and pauses', async (t) => {
  const rt = await setup({ rootSession: sessionWithPolicy({ policy: [CHAT, BACKUP] }), selectThrows: true });
  t.after(() => rt.host.close());
  const result = await rt.host.requestError(
    { agent: rt.agent, failure: quotaFailure() },
    async () => ({ kind: 'retry' }),
  );
  assert.equal(result, undefined);
  assert.equal(rt.actions.filter((action) => action.type === 'consumeFallback').length, 1);
  assert.equal(rt.state.member('root', rt.sessionId).status, 'paused');
  assert.equal(rt.sends.length, 0);
  assert.match(rt.root.steers.at(-1).content[0].text, /could not continue|cannot switch model/);
});

test('a continuation that fails to send pauses instead of leaving the member ambiguous', async (t) => {
  const rt = await setup({ rootSession: sessionWithPolicy({ policy: [CHAT, BACKUP] }) });
  t.after(() => rt.host.close());
  rt.ctx.subagents.sendMessage = async () => {
    throw new Error('target is not live');
  };
  await rt.host.requestError({ agent: rt.agent, failure: quotaFailure() }, async () => ({ kind: 'retry' }));
  rt.idle.resolve();
  await waitFor(() => rt.state.member('root', rt.sessionId).status === 'paused', 'pause after failed continuation');
  assert.match(rt.root.steers.at(-1).content[0].text, /target is not live/);
});

test('the continuation re-checks the root policy and pauses when it no longer allows the fallback', async (t) => {
  const policy = [CHAT, BACKUP];
  const rt = await setup({ rootSession: sessionWithPolicy({ policy }) });
  t.after(() => rt.host.close());
  await rt.host.requestError({ agent: rt.agent, failure: quotaFailure() }, async () => ({ kind: 'retry' }));
  // Simulate an operator narrowing the allowlist while the member finishes.
  policy.splice(0, policy.length, CHAT);
  rt.idle.resolve();
  await waitFor(() => rt.state.member('root', rt.sessionId).status === 'paused', 'pause after policy narrowing');
  assert.equal(rt.sends.length, 0);
  assert.match(rt.root.steers.at(-1).content[0].text, /not in this Session's model-selection allowlist/);
});

test('a member that never becomes idle is paused at the continuation deadline', async (t) => {
  const rt = await setup({
    rootSession: sessionWithPolicy({ policy: [CHAT, BACKUP] }),
    whenIdle: () => new Promise(() => {}),
  });
  t.after(() => rt.host.close());
  rt.host.switchContinuationTimeoutMs = 10;
  await rt.host.requestError({ agent: rt.agent, failure: quotaFailure() }, async () => ({ kind: 'retry' }));
  await waitFor(() => rt.state.member('root', rt.sessionId).status === 'paused', 'idle deadline pause', 400, 5);
  assert.equal(rt.host.switching.size, 0);
  assert.match(rt.root.steers.at(-1).content[0].text, /did not become idle/);
});

test('the coordinator sendMember wrapper is preferred for continuation', async (t) => {
  const rt = await setup({ rootSession: sessionWithPolicy({ policy: [CHAT, BACKUP] }) });
  t.after(() => rt.host.close());
  const calls = [];
  rt.host.sendMember = async (rootAgent, targetId, content, options) => {
    calls.push({ rootAgent, targetId, content, options });
    return 'sent';
  };
  await rt.host.requestError({ agent: rt.agent, failure: quotaFailure() }, async () => ({ kind: 'retry' }));
  rt.idle.resolve();
  await waitFor(() => calls.length === 1, 'sendMember continuation');
  assert.equal(calls[0].targetId, rt.sessionId);
  assert.equal(rt.sends.length, 0, 'the raw subagents path is not used when the wrapper exists');
});

test('a paused member kill/pause during the switch wins over the continuation', async (t) => {
  const rt = await setup({ rootSession: sessionWithPolicy({ policy: [CHAT, BACKUP] }) });
  t.after(() => rt.host.close());
  await rt.host.requestError({ agent: rt.agent, failure: quotaFailure() }, async () => ({ kind: 'retry' }));
  await rt.host.pauseMember('root', 'alice');
  rt.idle.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(rt.sends.length, 0, 'a human pause is not overridden');
  assert.equal(rt.state.member('root', rt.sessionId).status, 'paused');
});

test('rate-limit errors keep the existing bounded threshold and never switch routes', async (t) => {
  const rt = await setup({ rootSession: sessionWithPolicy({ policy: [CHAT, BACKUP] }) });
  t.after(() => rt.host.close());
  const retry = async () => ({ kind: 'retry' });
  for (let index = 0; index < 3; index += 1) {
    await rt.host.requestError(
      { agent: rt.agent, failure: { status: 429, message: 'rate limited' } },
      retry,
    );
  }
  assert.equal(rt.state.member('root', rt.sessionId).status, 'paused');
  assert.equal(rt.actions.some((action) => action.type === 'consumeFallback'), false);
  assert.equal(rt.selections.length, 0);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { probeModelRoute } from '../src/model-probe.js';

const route = { provider: 'local-fixture', model: 'small' };
const result = (status) => ({ ok: status === 'ok', status });

function root() {
  return { session: { id: 'root', snapshotEvents: () => [], requestHeader: () => ({ config: route }) } };
}

// Shape of DSH 0.2.2-rc.5's registration-bound one-shot call; never contacts an adapter.
function nativeLlm({ stream, prepare } = {}) {
  const configs = [], requests = [];
  return {
    configs, requests,
    async prepareCall(config, signal, configure) {
      configs.push(config);
      await prepare?.(signal);
      const { provider, model, ...controls } = config;
      const metadata = { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } };
      return {
        config: { provider, model, ...configure(controls, metadata) },
        stream(options) {
          requests.push(options);
          return stream ? stream(options) : chunks({ type: 'finish', reason: { kind: 'stop' } });
        },
      };
    },
  };
}
async function* chunks(...items) { yield* items; }
const probe = (llm, extra) => probeModelRoute({ llm, rootAgent: root(), route, confirmPaid: true, ...extra });

test('no adapter gets a request without an exact authorized route and readable policy', async () => {
  const llm = nativeLlm();
  for (const [options, status] of [
    [{ route: null }, 'invalid_route'], [{ route: 'missing-slash' }, 'invalid_route'],
    [{ route: 'other/small' }, 'not_authorized'],
    [{ rootAgent: { session: { snapshotEvents: () => { throw Error('private session content'); } } } }, 'policy_unavailable'],
    [{ rootAgent: { session: { snapshotEvents: () => [{ type: 'subagent/model-selection-policy', data: {} }] } } }, 'policy_unavailable'],
    [{ rootAgent: { session: { snapshotEvents: () => [], requestHeader: () => ({ config: { provider: 'a', model: 'b\u0000c' } }) } },
      route: { provider: 'a\u0000b', model: 'c' } }, 'not_authorized'],
  ]) {
    assert.deepEqual(await probe(llm, options), result(status));
  }
  assert.equal(llm.configs.length, 0);
  assert.deepEqual(await probe(null), result('unavailable'));
  const rootAgent = root();
  const allowed = { provider: 'backup', model: 'small' };
  rootAgent.session.snapshotEvents = () => [{ type: 'subagent/model-selection-policy', data: { allowedModels: [allowed] } }];
  assert.deepEqual(await probe(llm, { rootAgent, route }), result('not_authorized'));
  assert.deepEqual(await probe(llm, { rootAgent, route: 'backup/small' }), result('ok'));
});

test('in-band and thrown native failures expose only a stable category, never provider details or an automatic retry', async () => {
  for (const [code, status, category] of [
    ['ACCOUNT_QUOTA', 429, 'quota'], ['QUOTA', undefined, 'quota'], ['HTTP_402', undefined, 'quota'],
    ['SERVER', 503, 'capacity'], ['HTTP_529', undefined, 'capacity'], ['CAPACITY', undefined, 'capacity'],
    ['SERVER', 500, 'failed'], ['TIMEOUT', undefined, 'timeout'], ['SERVER', 504, 'timeout'],
    ['RATE_LIMIT', 429, 'rate_limit'], ['AUTH', 401, 'auth'], ['MISSING_CREDENTIAL', undefined, 'auth'],
    ['NO_ADAPTER', undefined, 'unavailable'], ['ABORTED', undefined, 'cancelled'],
    ['arbitrary private code', undefined, 'failed'],
  ]) {
    const failure = { code, status, message: 'private diagnostic', requestId: 'private reference' };
    const finished = nativeLlm({ stream: () => chunks({ type: 'finish', reason: { kind: 'error', failure } }) });
    assert.deepEqual(await probe(finished), result(category));
    assert.equal(finished.requests.length, 1);
    const thrown = nativeLlm({ prepare() { throw Object.assign(Error('private diagnostic'), { failure, code }); } });
    assert.deepEqual(await probe(thrown), result(category));
    assert.equal(thrown.configs.length, 1);
  }
  for (const terminal of [[], [{ type: 'text-delta', text: 'private output' }],
    [{ type: 'finish', reason: { kind: 'tool-calls' } }]]) {
    assert.deepEqual(await probe(nativeLlm({ stream: () => chunks(...terminal) })), result('failed'));
  }
  const aborted = { type: 'finish', reason: { kind: 'aborted', failure: { code: 'UNKNOWN', message: 'private' } } };
  assert.deepEqual(await probe(nativeLlm({ stream: () => chunks(aborted) })), result('cancelled'));
});

test('cancellation before preparation costs nothing; a deadline during preparation cannot dispatch later', { timeout: 2000 }, async () => {
  const llm = nativeLlm();
  assert.deepEqual(await probe(llm, { signal: AbortSignal.abort() }), result('cancelled'));
  assert.equal(llm.configs.length, 0);
  const gate = Promise.withResolvers();
  let preparationSignal;
  const slow = nativeLlm({ prepare(signal) { preparationSignal = signal; return gate.promise; } });
  try {
    assert.deepEqual(await probe(slow, { timeoutMs: 10 }), result('timeout'));
    assert.equal(preparationSignal.aborted, true);
  } finally { gate.resolve(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(slow.requests.length, 0);
});

test('a cancelled stream stays single-flight for the same root session/route until the adapter unwinds', { timeout: 2000 }, async () => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const llm = nativeLlm({ async *stream() {
    entered.resolve();
    await gate.promise;
    yield { type: 'finish', reason: { kind: 'stop' } };
  } });
  const ctl = new AbortController();
  const first = probe(llm, { signal: ctl.signal });
  try {
    await entered.promise;
    const duplicate = probe(llm, { route: `${route.provider}/${route.model}`, timeoutMs: 20 });
    assert.deepEqual(await duplicate, result('in_progress'));
    ctl.abort(Error('private reason'));
    assert.deepEqual(await first, result('cancelled'));
    assert.equal(llm.requests[0].signal.aborted, true);
    assert.deepEqual(await probe(llm, { timeoutMs: 20 }), result('in_progress'));
    assert.equal(llm.configs.length, 1);
  } finally { gate.resolve(); ctl.abort(); }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await probe(llm), result('ok'));
});

test('preparation cannot authorize a stale root route or replace the approved route and cap', async () => {
  const rootAgent = root();
  const moved = nativeLlm({ prepare() {
    rootAgent.session.requestHeader = () => ({ config: { provider: 'new-parent', model: route.model } });
  } });
  assert.deepEqual(await probe(moved, { rootAgent }), result('not_authorized'));
  assert.equal(moved.requests.length, 0);
  for (const bad of [{ ...route, model: 'redirect', maxTokens: 1 }, { ...route, maxTokens: 2000 }]) {
    let streams = 0;
    const llm = { async prepareCall() { return { config: bad, stream() { streams++; return chunks(); } }; } };
    assert.deepEqual(await probe(llm), result('unavailable'));
    assert.equal(streams, 0);
  }
});

test('one capped native call has no tools, credentials, session context, or user-controlled prompt; response is discarded', async () => {
  const llm = nativeLlm({ stream: () => chunks(
    { type: 'text-delta', text: 'untrusted private response' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ) });
  const input = { ...route, baseURL: 'private endpoint', extraHeaders: { sample: 'private header' }, prompt: 'not sent' };
  assert.deepEqual(await probe(llm, { route: input }), result('ok'));
  assert.deepEqual(llm.configs, [{ ...route, maxTokens: 1 }]);
  const [request] = llm.requests;
  assert.ok(request.signal instanceof AbortSignal);
  assert.deepEqual(llm.requests, [{ ...route, maxTokens: 1, reasoningEffort: 'low', signal: request.signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'OK' }] }],
  }]);
});

test('an omitted, false, or string confirmation never even prepares a paid request', async () => {
  let calls = 0;
  const llm = { prepareCall() { calls += 1; } };
  for (const confirmPaid of [undefined, false, 'true']) {
    assert.deepEqual(await probeModelRoute({ rootAgent: root(), llm, route, confirmPaid }), result('confirmation_required'));
  }
  assert.equal(calls, 0);
});

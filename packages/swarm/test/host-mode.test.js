// Session-level Swarm mode RPC: local-owner only, root-only writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerSwarmMode } from '../src/host-live.js';

const signal = new AbortController().signal;

function harness({ board = null, hostMode = null, setEnabled = async () => ({ enabled: false, title: null }) } = {}) {
  let handler, peer;
  const owner = { principal: { kind: 'owner' } };
  const host = {
    state: { board: (id) => board && board.rootId === id ? board : null },
    mode: hostMode ?? ((sessionId) => board && board.rootId === sessionId
      ? { root: true, exists: true, enabled: board.enabled !== false, title: board.title }
      : { root: sessionId === 'root', exists: false, enabled: false, title: null }),
    setEnabled,
    ctx: { inject(_, apply) {
      apply({ webServer: { host: '127.0.0.1' }, connection: { browserPeer: owner, allowsRemoteAuthorities: false,
        admit: () => ({ peer }), fetch: { register(route) { handler = route.fetch; } } } });
    } },
  };
  registerSwarmMode(host);
  return async function call(data, admitted = owner, abort = signal) {
    peer = admitted;
    const request = new Request('http://localhost/api/dk-swarm/mode', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal: abort });
    return (await handler(request)).json();
  };
}

test('reads the switch without creating a board; only the root is visible', async () => {
  const board = { rootId: 'root', title: 'Hive', enabled: false };
  const call = harness({ board });
  assert.deepEqual(await call({ sessionId: 'root' }), { ok: true, value: { root: true, exists: true, enabled: false, title: 'Hive' } });
  assert.equal((await call({ sessionId: 'child' })).error.code, 'swarm/forbidden');
  const lazy = harness({});
  assert.deepEqual(await lazy({ sessionId: 'root' }), { ok: true, value: { root: true, exists: false, enabled: false, title: null } });
  assert.deepEqual(await lazy({ sessionId: 'root', enabled: false }), { ok: true, value: { root: true, exists: false, enabled: false, title: null } });
});

test('a root write reaches the lazy switch and returns the durable value', async () => {
  const calls = [];
  const board = { rootId: 'root', title: 'Hive', enabled: false };
  const call = harness({ board, setEnabled: async (id, enabled) => {
    calls.push([id, enabled]);
    board.enabled = enabled;
    return { enabled, title: board.title };
  } });
  assert.deepEqual(await call({ sessionId: 'root', enabled: true }), { ok: true, value: { root: true, exists: true, enabled: true, title: 'Hive' } });
  assert.deepEqual(calls, [['root', true]]);
  assert.deepEqual(await call({ sessionId: 'root', enabled: false }), { ok: true, value: { root: true, exists: true, enabled: false, title: 'Hive' } });
});

test('owner, root and payload checks run before setEnabled', async () => {
  let writes = 0;
  const call = harness({ board: { rootId: 'root', title: 'Hive' }, setEnabled: async () => { writes++; return { enabled: false, title: 'Hive' }; } });
  for (const data of [null, {}, [], { sessionId: '' }, { sessionId: 'root', enabled: 'yes' },
    { sessionId: 'root', enabled: true, extra: 1 }, { sessionId: 7 }]) {
    assert.equal((await call(data)).error.code, 'swarm/bad-request');
  }
  for (const peer of [{ principal: { kind: 'share-viewer' } }, { principal: { kind: 'owner' } }, null]) {
    assert.equal((await call({ sessionId: 'root', enabled: true }, peer)).error.code, 'swarm/forbidden');
  }
  assert.equal((await call({ sessionId: 'child', enabled: true })).error.code, 'swarm/forbidden');
  assert.equal(writes, 0);
});

test('a stale root or closed session maps to a useful HTTP failure', async () => {
  const missing = harness({ hostMode: () => ({ root: true, exists: false, enabled: false, title: null }),
    setEnabled: async () => { throw Object.assign(Error('root session is not live'), { code: 'NOT_FOUND' }); } });
  const denied = await missing({ sessionId: 'root', enabled: true });
  assert.equal(denied.error.code, 'swarm/not_found');
  const forbidden = harness({ hostMode: () => ({ root: true, exists: false, enabled: false, title: null }),
    setEnabled: async () => { throw Object.assign(Error('no'), { code: 'FORBIDDEN' }); } });
  assert.equal((await forbidden({ sessionId: 'root', enabled: true })).error.code, 'swarm/forbidden');
  await assert.rejects(callAborted(), { name: 'AbortError' });
});

async function callAborted() {
  const call = harness({ board: { rootId: 'root', title: 'Hive' } });
  return call({ sessionId: 'root' }, undefined, AbortSignal.abort());
}

// Swarm sidebar read-only RPC contract (small/spec, installed-runtime medium/spec).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { registerSwarmLive } from '../src/host-live.js';

const signal = new AbortController().signal;
const payload = { sessionId: 'root', cursor: null };
function fixtureState() {
  const board = { rootId: 'root', title: 'Local board', seq: 1, members: {
    root: { sessionId: 'root', name: 'lead', role: 'coordinator' },
    child: { sessionId: 'child', name: 'worker', role: 'worker' },
  } };
  // Replaces BoardState's exact root lookup and core visibility for this fixture.
  return { board: id => id === 'root' ? board : null, api: { visiblePosts: () => [{}] } };
}

// Simulate only Connection's already-admitted Peer boundary; the runtime test
// below exercises Host/Origin, signed cookies and actual channel disposal.
function harness({ host = '127.0.0.1', allowsRemoteAuthorities = false, state = fixtureState() } = {}) {
  let handler, peer;
  const owner = { principal: { kind: 'owner' } };
  registerSwarmLive({ state, ctx: { inject(_, apply) {
    apply({ webServer: { host }, connection: { browserPeer: owner, allowsRemoteAuthorities,
      admit: () => ({ peer }), fetch: { register(route) { handler = route.fetch; } } } });
  } } });
  return { async read(data = payload, admitted = owner, abort = signal) {
    peer = admitted;
    const request = new Request('http://localhost/api/dk-swarm/liveView', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), signal: abort });
    return (await handler(request)).json();
  } };
}

test('only the selected root receives its public view and can resume it', async () => {
  const { read } = harness();
  const initial = await read();
  assert.equal(initial.ok, true);
  const { kind, view, etag } = initial.value;
  assert.equal(kind, 'snapshot');
  assert.equal(view.title, 'Local board');
  assert.equal(view.members[0].unread, 1);
  const cursor = { etag, since: view.seq };
  assert.deepEqual(await read({ ...payload, cursor }), { ok: true, value: { kind: 'unchanged', etag } });
  for (const sessionId of ['child', 'unrelated', 'constructor']) {
    assert.deepEqual(await read({ sessionId, cursor }), { ok: true, value: { kind: 'empty' } });
  }
});

test('LiveShare, API owners and remotely exposed Hosts cannot look up any board', async () => {
  const state = { ...fixtureState(), board: () => assert.fail('denied caller read board') };
  const local = harness({ state });
  for (const peer of [{ principal: { kind: 'share-viewer' } }, { principal: { kind: 'owner' } }, null]) {
    assert.equal((await local.read(payload, peer)).error.code, 'swarm/forbidden');
  }
  for (const config of [{ host: '192.0.2.1' }, { host: '::' }, { host: '::ffff:192.0.2.1' },
    { host: 'invalid' }, { allowsRemoteAuthorities: true }]) {
    assert.equal((await harness({ ...config, state }).read()).error.code, 'swarm/forbidden');
  }
  for (const host of ['127.0.0.9', '::1', '::ffff:127.0.0.1']) {
    assert.equal((await harness({ host }).read()).value.kind, 'snapshot');
  }
});

test('only the live read shape reaches the board; aborted requests never project it', async () => {
  const { read } = harness({ state: { ...fixtureState(), board: () => assert.fail('invalid call read board') } });
  for (const data of [null, {}, [], { sessionId: '' }, { ...payload, options: {} },
    { ...payload, cursor: 'x' }, { ...payload, cursor: { etag: 'v', since: -1 } }]) {
    assert.equal((await read(data)).error.code, 'swarm/bad-request');
  }
  await assert.rejects(read(payload, undefined, AbortSignal.abort()), { name: 'AbortError' });
});

const runtime = process.env.DSH_TEST_RUNTIME;
test('installed Connection: only a trusted browser cookie reads the local RPC until its plugin unloads',
  { skip: !runtime && 'Set DSH_TEST_RUNTIME to the installed resolver manifest' }, async (t) => {
    const require = createRequire(runtime);
    const { Context } = require('@deepseek-ai/cordis');
    const host = new Context();
    const fibers = [];
    t.after(async () => { for (const fiber of fibers.reverse()) await fiber.dispose(); });
    // No DSH profile: the isolated Host creates a fresh signing key in memory.
    host.provide('credentials', { modifyRecord: (_key, update) => update(undefined) });
    fibers.push(await host.plugin(require('@deepseek-ai/dsh-host-webserver').default, { host: '127.0.0.1', port: 0 }));
    fibers.push(await host.plugin(require('@deepseek-ai/dsh-client-connection')));
    const swarm = await host.plugin({ apply(ctx) { registerSwarmLive({ ctx, state: fixtureState() }); } });
    fibers.push(swarm);

    const base = host.webServer.getOrigin();
    // Equivalent to the Desktop/browser owner's index exchange, without a GUI.
    function exchange(path) {
      let cookie;
      const url = new URL(host.connection.authenticatedUrl(`${base}${path}`));
      const req = { method: 'GET', url: url.pathname + url.search, headers: { host: url.host } };
      const res = { writeHead(status, headers) {
        assert.equal(status, path === '/' ? 303 : 302);
        cookie = headers['set-cookie'].split(';', 1)[0];
      }, end() {} };
      if (path === '/') host.connection.authorizeIndex(req, res);
      else host.connection.authorizeConnect(req, res);
      return cookie;
    }
    const url = new URL('api/dk-swarm/liveView', base);
    const read = (headers = {}) => fetch(url, { method: 'POST', body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', ...headers }, signal });
    assert.equal((await read()).status, 401);
    const cookie = exchange('/');
    assert.equal((await read({ cookie, origin: 'https://foreign.invalid' })).status, 403);
    const apiOwner = await read({ cookie: exchange('/connect') });
    assert.equal(apiOwner.status, 403);
    assert.equal((await apiOwner.json()).error.code, 'swarm/forbidden');
    assert.equal((await read({ cookie, 'content-type': 'text/plain' })).status, 400);
    // A cached/shared page must not sidestep Connection's in-process Peer check,
    // even when its Fetch request carries a valid owner cookie.
    const viewer = host.connection.createPeer({ principal: { kind: 'share-viewer' } });
    try {
      const request = new Request(url, { method: 'POST', headers: { cookie, host: url.host } });
      const denied = await host.connection.createSharedFetchHandler('/api').fetch(request, viewer);
      assert.equal(denied.status, 403);
    } finally { await viewer.dispose(); }
    const owner = await read({ cookie, origin: base });
    assert.equal((await owner.json()).value.view.title, 'Local board');
    assert.equal(owner.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(url, { headers: { cookie } })).status, 404);
    await swarm.dispose(); fibers.pop();
    assert.equal((await read({ cookie })).status, 404);
  });

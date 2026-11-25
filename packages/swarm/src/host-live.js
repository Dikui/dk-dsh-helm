import { BlockList, isIP } from 'node:net';
import { createLiveReader } from './live-view.js';

// webServer.host is a concrete bind IP, not the caller's Host header. BlockList
// also recognizes IPv4-mapped loopback addresses without doing a DNS lookup.
const loopback = new BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');

function localBrowserOwner(ctx, peer) {
  const { connection, webServer } = ctx;
  if (!peer || peer.principal?.kind !== 'owner' || peer !== connection.browserPeer
    || connection.allowsRemoteAuthorities !== false) return false;
  const host = webServer.host;
  const version = typeof host === 'string' && isIP(host);
  return Boolean(version && loopback.check(host, version === 6 ? 'ipv6' : 'ipv4'));
}

function validRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || typeof payload.sessionId !== 'string' || !payload.sessionId.length || payload.sessionId.length > 512
    || Object.keys(payload).some(key => key !== 'sessionId' && key !== 'cursor')) return false;
  const { cursor } = payload;
  return cursor === null || (cursor && typeof cursor === 'object' && !Array.isArray(cursor)
    && typeof cursor.etag === 'string' && cursor.etag.length <= 256
    && Number.isSafeInteger(cursor.since) && cursor.since >= 0
    && Object.keys(cursor).every(key => key === 'etag' || key === 'since'));
}

const response = (result, status = 200) => Response.json(result, { status, headers: { 'cache-control': 'no-store' } });
const failure = (status, code, message) => response({ ok: false, error: { code, message, details: {} } }, status);

/** Connection's exact /api routes require an authenticated owner, including on
 * in-process dispatch. Optional so the no-Web Host still has its tools/commands. */
export function registerSwarmLive(host) {
  host.ctx.inject(['connection', 'webServer'], (ctx) => {
    const read = createLiveReader({ visiblePosts: host.state.api.visiblePosts });
    ctx.connection.fetch.register({
      path: '/api/dk-swarm/liveView', methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        // An API operator also has principal=owner. Only the signed browser
        // cookie (including Desktop's proxy) admits to this particular Peer.
        const { peer } = ctx.connection.admit(request);
        if (!localBrowserOwner(ctx, peer)) return failure(403, 'swarm/forbidden', 'Only the local Host owner can read the Swarm panel.');
        let payload;
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json') {
          payload = await request.json().catch(() => null);
        }
        request.signal.throwIfAborted();
        if (!validRequest(payload)) return failure(400, 'swarm/bad-request', 'Expected a session ID and a Swarm view cursor.');
        // Never resolve a child through its membership/ancestor to a root, nor
        // create or wake a session. Same root-only constraint as /swarm view.
        const { sessionId, cursor } = payload;
        const board = host.state.board(sessionId);
        return response({ ok: true, value: read(board?.rootId === sessionId ? board : null, cursor) });
      },
    });
  });
}

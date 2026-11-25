// small/spec — Swarm sidebar live-read contract. The reference model is always
// a fresh public snapshot; delivery may instead resume a bounded message window.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLiveReader } from '../src/live-view.js';
import { buildPublicView } from '../src/host-view.js';

const post = seq => ({ kind: 'message', name: 'lead', channel: 'main', seq, text: `note ${seq}` });
const member = { name: 'lead', role: 'coordinator', sessionId: 'private-session', status: 'active' };
function board(seq = 1, overrides = {}) {
  return { rootId: 'root', title: 'Live board', members: {lead: member}, seq,
    posts: Array.from({length: seq}, (_, i) => post(i + 1)), ...overrides };
}
const from = packet => ({etag:packet.etag, since:packet.view.seq});

// Apply the public wire contract, not the reader's cache or ETag algorithm.
function resume(base, response) {
  assert.equal(response.baseEtag, base.etag);
  const retained = base.view.messages.filter(p => response.firstSeq !== null && p.seq >= response.firstSeq);
  return {...response.view, messages: [...retained, ...response.view.messages]};
}

test('an unchanged public view returns no snapshot, including after a private-only transition', () => {
  const read = createLiveReader(), state = board();
  assert.deepEqual(read(null, null), {kind: 'empty'});
  const initial = read(state, null);
  assert.equal(initial.kind, 'snapshot');
  assert.deepEqual(initial.view, buildPublicView(state));
  for (const committed of [state, {...state, updatedAt: 99, reservations: {secret: 'private'}}]) {
    assert.deepEqual(read(committed, from(initial)), {kind: 'unchanged', etag: initial.etag});
  }
});

test('polling an unchanged board does not reread member posts', () => {
  let scans = 0;
  // Stand-in for the core's visibility query used to calculate a member's unread count.
  const read = createLiveReader({visiblePosts() { scans++; return []; }});
  const state = board(), cursor = from(read(state, null));
  assert.ok(scans > 0);
  const baseline = scans;
  for (let i = 0; i < 10; i++) assert.equal(read(state, cursor).kind, 'unchanged');
  assert.equal(scans, baseline);
});

test('resuming a board transfers only new public posts and drops evicted messages', () => {
  const read = createLiveReader();
  const initial = read(board(30), null), current = board(33);
  // Control records occupy a seq but are not renderable messages.
  current.posts[31] = {kind: 'control', seq:32, text:'private control', name:'lead'};
  const delta = read(current, from(initial));
  assert.equal(delta.kind, 'delta');
  assert.equal(delta.firstSeq, 3);
  assert.deepEqual(delta.view.messages.map(p => p.seq), [31, 33]);
  assert.deepEqual(resume(initial, delta), buildPublicView(current));
  assert.doesNotMatch(JSON.stringify(delta), /private control|private-session/);
});

test('a status transition with no new seq is visible to a resumed panel', () => {
  const read = createLiveReader(), initial = read(board(), null);
  const current = board(1, {members: {lead: {...member, status:'waiting', lastReadSeq:1}}});
  const delta = read(current, from(initial));
  assert.equal(delta.kind, 'delta');
  assert.notEqual(delta.etag, initial.etag);
  assert.deepEqual(delta.view.messages, []);
  assert.deepEqual(resume(initial, delta), buildPublicView(current));
});

test('a formerly truncated message window can grow back to the exact snapshot', () => {
  const options = {totalLimit: 2000}, read = createLiveReader(options);
  const lean = board(20), crowded = {...lean, plan:{tasks:Array(20).fill('A lengthy description '.repeat(7))}};
  const first = read(lean, null), narrowed = read(crowded, from(first));
  assert.equal(narrowed.kind, 'delta');
  assert.equal(narrowed.firstSeq, null);
  assert.deepEqual(resume(first, narrowed), buildPublicView(crowded, options));
  const expanded = read(lean, from(narrowed));
  assert.equal(expanded.kind, 'snapshot');
  assert.ok(expanded.view.messages.length > 0);
  assert.deepEqual(expanded.view, buildPublicView(lean, options));
});

test('another root, a reset history or an inconsistent cursor receives a fresh snapshot', () => {
  const read = createLiveReader(), state = board(), initial = read(state, null), cursor = from(initial);
  for (const reply of [read({...state, rootId:'other-root'}, cursor), createLiveReader()(board(2), cursor),
    read(state, {...cursor, since: 2}), read(board(0), cursor)]) {
    assert.equal(reply.kind, 'snapshot');
  }
});

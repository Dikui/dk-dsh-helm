// Member delivery acceptance contract; exercise only public board operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { newBoard, transition, boardView } from '../src/board.js';

const LEAD = 'lead-session';
const OWNER = 'worker-session';
const assign = {
  type: 'assignDelivery', taskId: 'map', owner: OWNER,
  deliverable: 'Station map', criterion: 'All station names are legible.',
};

const submit = { type: 'submitDelivery', taskId: 'map', artifactVersion: 'rev-A', artifactPath: 'out/map.svg' };

const review = {
  type: 'reviewDelivery', taskId: 'map', submittedSeq: 1, decision: 'accepted',
  checkPassed: true, evidence: 'Inspected the submitted SVG at print size; every name was legible.',
};

function apply(board, actor, action) {
  const out = transition(board, actor, action);
  assert.equal(out.result.ok, true, JSON.stringify(out.result));
  return out;
}

function rejects(board, actor, action, code) {
  const out = transition(board, actor, action);
  assert.equal(out.result.ok, false, JSON.stringify(out.result));
  assert.equal(out.result.code, code, out.result.message);
  assert.strictEqual(out.state, board);
  assert.deepEqual(out.wakes, []);
}

function members(limits) {
  const board = newBoard('root-session', 'Maps', { coordinator: LEAD, limits });
  return apply(board, LEAD, {
    type: 'add', member: { sessionId: OWNER, name: 'cartographer', role: 'worker' },
  }).state;
}

test('a lead assigns a unique bounded task to an existing member; old v1 boards need no migration', () => {
  const legacy = members();
  assert.deepEqual(legacy.deliveries, []);
  delete legacy.deliveries;
  assert.deepEqual(boardView(legacy).deliveries, []);
  assert.deepEqual(apply(legacy, OWNER, { type: 'status' }).result.deliveries, []);
  rejects(legacy, null, assign, 'NOT_MEMBER');
  rejects(legacy, OWNER, assign, 'FORBIDDEN');
  rejects(legacy, LEAD, { ...assign, owner: 'missing' }, 'NOT_FOUND');
  rejects(legacy, LEAD, { ...assign, owner: LEAD }, 'FORBIDDEN');
  for (const fields of [{ taskId: '' }, { taskId: '__proto__' }, { deliverable: ' ' }, { criterion: null }]) {
    rejects(legacy, LEAD, { ...assign, ...fields }, 'INVALID_ARGUMENT');
  }
  const out = apply(legacy, LEAD, { ...assign, now: 25 });
  assert.deepEqual(out.result.delivery, {
    taskId: 'map', owner: OWNER, deliverable: 'Station map', criterion: 'All station names are legible.',
    status: 'assigned', updatedAt: 25, submission: null, review: null,
  });
  assert.deepEqual(out.state.deliveries, [out.result.delivery]);
  assert.equal(legacy.deliveries, undefined);
  assert.deepEqual(apply(out.state, OWNER, { type: 'status' }).result.deliveries, out.state.deliveries);
  assert.deepEqual(boardView(out.state).deliveries, out.state.deliveries);
  rejects(out.state, LEAD, { ...assign, criterion: 'replacement' }, 'INVALID_STATE');
});

test('only the live owner submits; an ordinary [done] post is not a submission', () => {
  const assigned = apply(members(), LEAD, assign).state;
  const posted = apply(assigned, OWNER, { type: 'post', text: '[done] out/map.svg rev-A' }).state;
  assert.deepEqual(posted.deliveries, assigned.deliveries);
  rejects(posted, LEAD, { ...submit, owner: OWNER }, 'FORBIDDEN');
  const peer = apply(posted, LEAD, {
    type: 'add', member: { sessionId: 'observer', name: 'observer', role: 'monitor' },
  }).state;
  rejects(peer, 'observer', { ...submit, owner: OWNER }, 'FORBIDDEN');
  rejects(peer, 'observer', { ...assign, taskId: 'other' }, 'FORBIDDEN');
  rejects(posted, 'new-session', submit, 'NOT_MEMBER');
  rejects(posted, OWNER, { ...submit, taskId: 'unknown' }, 'NOT_FOUND');
  for (const fields of [{ artifactVersion: '' }, { artifactPath: '\t' }, { artifactVersion: 42 }]) {
    rejects(posted, OWNER, { ...submit, ...fields }, 'INVALID_ARGUMENT');
  }
  const paused = apply(posted, LEAD, { type: 'pause', target: OWNER }).state;
  rejects(paused, OWNER, submit, 'PAUSED');
  const killed = apply(posted, LEAD, { type: 'kill', target: OWNER }).state;
  rejects(killed, OWNER, submit, 'CLOSED');
  rejects(killed, LEAD, { ...assign, taskId: 'appendix' }, 'CLOSED');

  const first = apply(posted, OWNER, { ...submit, now: 30, seq: 900, decision: 'accepted' });
  assert.deepEqual(first.result.delivery.submission, { seq: 1, artifactVersion: 'rev-A', artifactPath: 'out/map.svg' });
  assert.equal(first.result.delivery.status, 'submitted');
  assert.equal(first.result.delivery.updatedAt, 30);
  assert.equal(first.result.delivery.review, null);
  const next = apply(first.state, OWNER, { ...submit, now: 29 });
  assert.deepEqual(next.result.delivery.submission, { ...first.result.delivery.submission, seq: 2 });
  assert.equal(next.result.delivery.updatedAt, 30, 'timestamps cannot regress');
  assert.equal(next.state.seq, posted.seq, 'submissions do not create unread posts or wake intents');
  assert.deepEqual(next.state.pendingWakes, posted.pendingWakes);
});

test('a review consumes exactly the current submission and binds the manual finding to its artifact', () => {
  const assigned = apply(members(), LEAD, assign).state;
  rejects(assigned, LEAD, review, 'INVALID_STATE');
  const submitted = apply(assigned, OWNER, submit).state;
  rejects(submitted, OWNER, { ...review, reviewer: LEAD }, 'FORBIDDEN');
  for (const fields of [
    { checkPassed: false }, { checkPassed: 'true' }, { checkPassed: undefined }, { evidence: '\n ' },
    { evidence: { passed: true } }, { decision: 'done' }, { submittedSeq: '1' }, { submittedSeq: 0 },
  ]) {
    rejects(submitted, LEAD, { ...review, ...fields }, 'INVALID_ARGUMENT');
  }
  const returned = apply(submitted, LEAD, { ...review, decision: 'returned', checkPassed: false, evidence: 'Overlapping labels at east station.', now: 40 });
  assert.deepEqual(returned.result.delivery.review, {
    decision: 'returned', checkPassed: false, evidence: 'Overlapping labels at east station.', reviewer: LEAD,
    submittedSeq: 1, artifactVersion: 'rev-A', artifactPath: 'out/map.svg',
  });
  assert.equal(returned.result.delivery.status, 'returned');
  assert.equal(returned.result.delivery.updatedAt, 40);
  rejects(returned.state, LEAD, review, 'INVALID_STATE');
  const second = apply(returned.state, OWNER, { ...submit, artifactVersion: 'rev-B' }).state;
  assert.equal(second.deliveries[0].review, null, 'new artifact has no previous manual verdict');
  const third = apply(second, OWNER, { ...submit, artifactVersion: 'rev-C', artifactPath: 'out/final.svg' }).state;
  rejects(third, LEAD, review, 'INVALID_STATE');
  rejects(third, LEAD, { ...review, submittedSeq: 2 }, 'INVALID_STATE');
  rejects(third, LEAD, { ...review, submittedSeq: 3, artifactVersion: 'rev-X' }, 'INVALID_STATE');
  rejects(third, LEAD, { ...review, submittedSeq: 3, artifactPath: 'unrelated' }, 'INVALID_STATE');
  const accepted = apply(third, LEAD, { ...review, submittedSeq: 3, now: 50 });
  assert.equal(accepted.result.delivery.status, 'accepted');
  assert.equal(accepted.result.delivery.updatedAt, 50);
  assert.deepEqual(accepted.result.delivery.review, {
    decision: 'accepted', checkPassed: true, evidence: review.evidence, reviewer: LEAD,
    submittedSeq: 3, artifactVersion: 'rev-C', artifactPath: 'out/final.svg',
  });
  rejects(accepted.state, LEAD, { ...review, submittedSeq: 3, decision: 'returned' }, 'INVALID_STATE');
  rejects(accepted.state, OWNER, submit, 'INVALID_STATE');
  rejects(accepted.state, LEAD, assign, 'INVALID_STATE');
  const restored = JSON.parse(JSON.stringify(accepted.state));
  assert.deepEqual(apply(restored, OWNER, { type: 'status' }).result.deliveries, accepted.state.deliveries);
});

// Source: board contract; scale: all five phases × all three write operations.
// An input is legal iff the small independent transition table has an edge.
const edges = {
  none: { assign: 'assigned' },
  assigned: { submit: 'submitted' },
  submitted: { submit: 'submitted', accept: 'accepted', return: 'returned' },
  returned: { submit: 'submitted' },
  accepted: {},
};
test('delivery transitions are closed, including after a board reload', () => {
  const pending = [['none', members()]];
  const visited = new Set();
  while (pending.length) {
    const [phase, snapshot] = pending.shift();
    if (visited.has(phase)) continue;
    visited.add(phase);
    const board = JSON.parse(JSON.stringify(snapshot));
    const ops = {
      assign: [LEAD, assign], submit: [OWNER, submit], accept: [LEAD, review],
      return: [LEAD, { ...review, decision: 'returned', checkPassed: false }],
    };
    for (const [operation, [actor, action]] of Object.entries(ops)) {
      const expected = edges[phase][operation];
      const out = transition(board, actor, action);
      assert.equal(out.result.ok, !!expected, `${phase} + ${operation}`);
      if (expected) {
        assert.equal(out.state.deliveries[0].status, expected);
        pending.push([expected, out.state]);
      } else assert.strictEqual(out.state, board);
      assert.deepEqual(out.wakes, []);
    }
  }
  assert.equal(visited.size, Object.keys(edges).length);
});

test('delivery fields and queue are bounded separately from message and wake quotas', () => {
  const board = members({ maxPosts: 1, maxPendingWakes: 1 });
  const full = apply(board, OWNER, { type: 'post', text: 'last available post' }).state;
  rejects(full, OWNER, { type: 'post', text: 'no room' }, 'BOARD_FULL');
  for (const fields of [{ taskId: 'a'.repeat(65) }, { deliverable: 'a'.repeat(1025) }, { criterion: 'a'.repeat(1025) }]) {
    rejects(full, LEAD, { ...assign, ...fields }, 'INVALID_ARGUMENT');
  }
  let state = full;
  for (let n = 0; n < 128; n++) state = apply(state, LEAD, { ...assign, taskId: `task-${n}` }).state;
  rejects(state, LEAD, assign, 'LIMIT');
  const taskId = 'task-127';
  for (const fields of [{ artifactVersion: 'a'.repeat(161) }, { artifactPath: 'a'.repeat(513) }]) {
    rejects(state, OWNER, { ...submit, taskId, ...fields }, 'INVALID_ARGUMENT');
  }
  const submitted = apply(state, OWNER, { ...submit, taskId }).state;
  assert.equal(submitted.deliveries[0].status, 'assigned');
  const pending = apply(submitted, OWNER, { ...submit, taskId: 'task-0', artifactPath: 'out/front.svg' }).state;
  assert.equal(pending.deliveries[0].submission.seq, 1, 'submission sequence is task-scoped');
  rejects(pending, LEAD, { ...review, taskId, evidence: 'a'.repeat(1025) }, 'INVALID_ARGUMENT');
  const final = apply(pending, LEAD, { ...review, taskId }).state;
  assert.equal(final.deliveries[0].status, 'submitted', 'reviewing one task cannot accept another task at the same version');
  assert.equal(final.deliveries.length, 128);
  assert.deepEqual(final.posts, full.posts);
  assert.deepEqual(final.stats, full.stats);
  assert.deepEqual(final.pendingWakes, full.pendingWakes);
});

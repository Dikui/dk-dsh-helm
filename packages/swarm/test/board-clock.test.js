// small/spec: Swarm deadline and quiet-board reminder contract. Times are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as clock from '../src/board-clock.js';
import { startStallMonitor } from '../src/stall-monitor.js';
const { configureBoardClock, getBoardClock } = clock;

function team() {
  return {
    rootId: 'root', seq: 0, createdAt: 0, posts: [],
    members: {
      root: { role: 'coordinator', name: 'lead', sessionId: 'root', lastReadSeq: 0 },
      a: { role: 'worker', status: 'working', name: 'alice', sessionId: 'a' },
    },
  };
}

const kinds = (board, now) => clock.evaluateBoardAlerts(board, now).map(alert => alert.kind);

test('a legacy board opts into clocks independently, storing the deadline in UTC', () => {
  const board = {};
  assert.deepEqual(getBoardClock(board), { deadlineUtc: null, silenceMs: null });
  assert.deepEqual(configureBoardClock(board, { deadlineUtc: '2030-03-03T00:15:30+08:00' }, 100), {
    ok: true, settings: { deadlineUtc: '2030-03-02T16:15:30.000Z', silenceMs: null },
  });
  assert.equal(configureBoardClock(board, { silenceMs: 1000 }, 110).ok, true);
  assert.deepEqual(getBoardClock(JSON.parse(JSON.stringify(board))), {
    deadlineUtc: '2030-03-02T16:15:30.000Z', silenceMs: 1000,
  });
  assert.equal(configureBoardClock(board, { deadlineUtc: null }, 120).ok, true);
  assert.deepEqual(getBoardClock(board), { deadlineUtc: null, silenceMs: 1000 });
});

test('invalid or ambiguous settings reject the whole patch without changing an enabled clock', () => {
  const board = {};
  configureBoardClock(board, { silenceMs: 5000 }, 100);
  const before = structuredClone(board);
  for (const patch of [
    { deadlineUtc: '2030-02-02T08:00' }, { deadlineUtc: '2030-02-30T08:00:00Z' },
    { deadlineUtc: '2030-02-02T24:00:00Z' }, { deadlineUtc: '2030-02-02T00:00+24:00' },
    { deadlineUtc: 0 }, { silenceMs: -1 }, { silenceMs: 0 }, { silenceMs: 0.5 },
    { deadlineUtc: null, silenceMs: '30000' }, { silenseMs: 2 }, {}, null,
  ]) {
    assert.equal(configureBoardClock(board, patch, 101).code, 'INVALID_ARGUMENT', JSON.stringify(patch));
    assert.deepEqual(board, before);
  }
});

test('deadline becomes due at the specified instant only for unfinished collaboration', () => {
  const board = team();
  configureBoardClock(board, { deadlineUtc: '1970-01-01T00:01Z' }, 0);
  assert.deepEqual(kinds(board, 59_999), []);
  const [deadline] = clock.evaluateBoardAlerts(board, 60_000);
  assert.equal(deadline.kind, 'deadline');
  assert.match(deadline.message, /1970-01-01T00:01:00\.000Z/);
  for (const status of ['assigned', 'submitted', 'returned', 'accepted']) {
    board.deliveries = [{ taskId: 'report', owner: 'a', status, updatedAt: 0 }];
    assert.deepEqual(kinds(board, 60_001), status === 'accepted' ? [] : ['deadline'], status);
  }
  board.deliveries = [];
  board.members.a.status = 'killed';
  assert.deepEqual(kinds(board, 60_001), []);
  board.members.a.status = 'working';
  board.posts.push({ sessionId: 'root', seq: 1, channel: 'main', kind: 'post', text: '[done] verified' });
  assert.deepEqual(kinds(board, 60_001), []);
});

test('new explicit delivery work is actionable after a historical coordinator done post', () => {
  const board = team();
  board.posts.push({ seq: 1, at: 100, sessionId: 'root', kind: 'post', channel: 'main', text: '[done] first round' });
  configureBoardClock(board, { silenceMs: 500 }, 100);
  assert.deepEqual(kinds(board, 600), []);
  board.deliveries = [{ taskId: 'followup', owner: 'a', status: 'assigned', updatedAt: 1000 }];
  assert.deepEqual(kinds(board, 1500), ['silence']);
  board.done = true;
  assert.deepEqual(kinds(board, 1600), []);
});

test('an outstanding delivery owned by an active monitor counts as work even without workers', () => {
  const board = team();
  board.members.a.role = 'monitor';
  configureBoardClock(board, { silenceMs: 1000 }, 100);
  assert.deepEqual(kinds(board, 1100), []); // no worker, no contract
  board.deliveries = [{ taskId: 'audit', owner: 'a', status: 'assigned', updatedAt: 200 }];
  assert.deepEqual(kinds(board, 1200), ['silence']);
  board.members.a.status = 'killed';
  assert.deepEqual(kinds(board, 1200), []);
});

test('the board can go quiet even while working; posts and delivery activity restart its quiet window', () => {
  const board = team();
  configureBoardClock(board, { silenceMs: 1000 }, 500);
  assert.deepEqual(kinds(board, 1499), []);
  assert.deepEqual(kinds(board, 1500), ['silence']);
  // Status polls, read receipts and configuration reads do not constitute a post.
  Object.assign(board, { clock: 1550, updatedAt: 1550, seq: 1 });
  board.posts.push({ seq: 1, at: 1550, kind: 'control' });
  assert.deepEqual(kinds(board, 1550), ['silence']);
  board.seq++;
  board.posts.push({ seq: 2, at: 1551, sessionId: 'root', kind: 'post', text: 'update' });
  assert.deepEqual(kinds(board, 2550), []);
  assert.deepEqual(kinds(board, 2551), ['silence']);
  board.deliveries = [{ taskId: 'evidence', owner: 'a', status: 'submitted', updatedAt: 2600 }];
  assert.deepEqual(kinds(board, 3599), []);
  assert.deepEqual(kinds(board, 3600), ['silence']);
  board.deliveries[0].status = 'accepted';
  assert.deepEqual(kinds(board, 9999), []);
});

test('a durable receipt suppresses just the delivered episode and cannot consume a newer one', () => {
  let board = team();
  configureBoardClock(board, { silenceMs: 1000, deadlineUtc: '1970-01-01T00:00Z' }, 100);
  const [deadline, quiet] = clock.evaluateBoardAlerts(board, 1100);
  assert.deepEqual(clock.ackBoardAlert(board, deadline, 1100), { ok: true, acknowledged: true });
  assert.deepEqual(clock.ackBoardAlert(board, quiet, 1110), { ok: true, acknowledged: true });
  board = JSON.parse(JSON.stringify(board)); // a stopped and reopened store
  assert.deepEqual(kinds(board, 1500), []);
  board.deliveries = [{ taskId: 'evidence', status: 'assigned', updatedAt: 1600 }];
  const [newQuiet] = clock.evaluateBoardAlerts(board, 2600);
  assert.equal(newQuiet.kind, 'silence');
  assert.notEqual(newQuiet.key, quiet.key);
  assert.deepEqual(clock.ackBoardAlert(board, quiet, 2600), { ok: true, acknowledged: false });
  assert.deepEqual(kinds(board, 2600), ['silence']);
  clock.ackBoardAlert(board, newQuiet, 2600);
  // Same-millisecond submissions are still observable new activity.
  board.deliveries[0].status = 'submitted';
  board.deliveries[0].submission = { seq: 1 };
  assert.deepEqual(kinds(board, 2600), ['silence']);
  configureBoardClock(board, { deadlineUtc: null }, 2601);
  configureBoardClock(board, { deadlineUtc: '1970-01-01T00:00Z' }, 2602);
  assert.deepEqual(kinds(board, 2602), ['deadline', 'silence']);
});

test('re-enabling a clock cannot inherit the receipt of a notification still in flight', () => {
  const board = team();
  const enabled = { deadlineUtc: '1970-01-01T00:00Z', silenceMs: 1000 };
  configureBoardClock(board, enabled, 5);
  const original = clock.evaluateBoardAlerts(board, 1005);
  configureBoardClock(board, { deadlineUtc: null, silenceMs: null }, 1005);
  configureBoardClock(board, enabled, 1005);
  for (const alert of original) {
    assert.deepEqual(clock.ackBoardAlert(board, alert, 2005), { ok: true, acknowledged: false });
  }
  assert.deepEqual(kinds(board, 2005), ['deadline', 'silence']);
});

test('a parked board retains its independent stall hint unless its contracts are all accepted', () => {
  const board = team();
  board.members.a.status = 'waiting';
  board.seq = 1;
  board.posts = [{ seq: 1, sessionId: 'a', kind: 'post', text: 'Review please', channel: 'main', at: 100 }];
  configureBoardClock(board, { silenceMs: 200, deadlineUtc: '1970-01-01T00:00Z' }, 100);
  assert.deepEqual(kinds(board, 299), ['deadline', 'stall']);
  const due = clock.evaluateBoardAlerts(board, 300);
  assert.deepEqual(due.map(a => a.kind), ['deadline', 'silence', 'stall']);
  clock.ackBoardAlert(board, due.find(a => a.kind === 'stall'), 300);
  assert.deepEqual(kinds(board, 301), ['deadline', 'silence']);
  board.deliveries = [{ taskId: 'evidence', status: 'accepted', updatedAt: 302 }];
  assert.deepEqual(kinds(board, 1000), []);
});

test('a monitor retries unconfirmed delivery, persists only success and stays quiet after restart', async () => {
  let board = team(), now = 1000, tick, available = false;
  const notices = [], receipts = [];
  configureBoardClock(board, { silenceMs: 1000 }, 0);
  // Fake the interval, host notification and atomic store receipt, not evaluation.
  const start = () => startStallMonitor({
    list: () => [structuredClone(board)], now: () => now,
    setTimer(fn) { tick = fn; return {}; }, clearTimer() {},
    notify(rootId, message) { notices.push({ rootId, message }); return available; },
    ack(rootId, alert) { receipts.push(alert.kind); return clock.ackBoardAlert(board, alert, now); },
  });
  let stop = start();
  await tick();
  assert.deepEqual(receipts, []);
  assert.equal(notices.length, 1);
  available = true;
  await tick();
  assert.deepEqual(receipts, ['silence']);
  assert.equal(notices.length, 2);
  stop();
  board = JSON.parse(JSON.stringify(board));
  stop = start();
  await tick();
  assert.equal(notices.length, 2);
  board.seq = 1;
  board.posts.push({ seq: 1, sessionId: 'a', channel: 'main', kind: 'post', text: 'progress', at: now });
  now += 1000;
  await tick();
  assert.equal(notices.length, 3);
  assert.deepEqual(receipts, ['silence', 'silence']);
  stop();
});

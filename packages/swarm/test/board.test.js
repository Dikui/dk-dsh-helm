// Contract tests for the pure Swarm board state machine.
// Public interface only: newBoard / transition / channels helpers.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseMentions,
  resolveMentions,
  replayChannels,
  isChannelActive,
} from '../src/channels.js';

const T0 = 1_700_000_000_000;

test('parseMentions only reads @ at a word boundary', () => {
  const parsed = parseMentions('hi @worker-1, mail a@b.com and @all @#ops; x@#no');
  assert.deepEqual(parsed.names, ['worker-1']);
  assert.equal(parsed.all, true);
  assert.deepEqual(parsed.channels, ['ops']);
  assert.deepEqual(parsed.tokens.map((t) => t.kind), ['member', 'all', 'channel']);
});

test('parseMentions dedupes case-insensitively and ignores malformed bells', () => {
  const parsed = parseMentions('@Bob @bob @#Ops @#ops @@nope @#');
  assert.deepEqual(parsed.names, ['Bob']);
  assert.deepEqual(parsed.channels, ['Ops']);
});

test('resolveMentions matches an exact name before shard siblings', () => {
  const members = [
    { sessionId: 's1', name: 'worker', role: 'worker' },
    { sessionId: 's2', name: 'worker-1', role: 'worker' },
    { sessionId: 's3', name: 'worker-2', role: 'worker' },
  ];
  const exact = resolveMentions('@worker', { members, channels: {}, atSeq: 1 });
  assert.deepEqual(exact.sessionIds, ['s1']);

  const shards = resolveMentions('@worker', {
    members: members.slice(1),
    channels: {},
    atSeq: 1,
  });
  assert.deepEqual(shards.sessionIds, ['s2', 's3']);
});

test('resolveMentions resolves @all and bracketed channel bells', () => {
  const members = [
    { sessionId: 'c', name: 'coordinator', role: 'coordinator' },
    { sessionId: 'w1', name: 'worker-1', role: 'worker' },
    { sessionId: 'w2', name: 'worker-2', role: 'worker' },
    { sessionId: 'm', name: 'monitor', role: 'monitor' },
  ];
  const channels = {
    ops: {
      name: 'ops',
      createdAtSeq: 2,
      archivedAtSeq: null,
      subscribers: ['w1'],
    },
  };
  const all = resolveMentions('@all', { members, channels, atSeq: 3 });
  assert.deepEqual(all.sessionIds, ['c', 'w1', 'w2', 'm']);

  const channel = resolveMentions('@#ops', { members, channels, atSeq: 3 });
  // subscribers, plus the coordinator/monitor who hold a "*" view
  assert.deepEqual(channel.sessionIds, ['w1', 'c', 'm']);
});

test('resolveMentions ignores unknown, archived, future and @#main channels', () => {
  const members = [{ sessionId: 'w1', name: 'worker-1', role: 'worker' }];
  const channels = {
    old: { name: 'old', createdAtSeq: 2, archivedAtSeq: 4, subscribers: ['w1'] },
    later: { name: 'later', createdAtSeq: 9, archivedAtSeq: null, subscribers: ['w1'] },
  };
  assert.deepEqual(resolveMentions('@#old', { members, channels, atSeq: 2 }).sessionIds, ['w1']);
  assert.deepEqual(resolveMentions('@#old', { members, channels, atSeq: 4 }).sessionIds, []);
  assert.deepEqual(resolveMentions('@#old', { members, channels, atSeq: 5 }).sessionIds, []);
  assert.deepEqual(resolveMentions('@#later', { members, channels, atSeq: 5 }).sessionIds, []);
  assert.deepEqual(resolveMentions('@#main', { members, channels, atSeq: 5 }).sessionIds, []);
});

test('replayChannels rebuilds channel lifecycle and subscribers from control posts', () => {
  const posts = [
    {
      seq: 1,
      kind: 'control',
      control: { op: 'create', channel: 'ops', topic: 'ops', members: ['w1'] },
    },
    {
      seq: 2,
      kind: 'control',
      control: { op: 'subscribe', channel: 'ops', members: ['w2'] },
    },
    {
      seq: 3,
      kind: 'post',
      channel: 'ops',
      text: 'hello',
    },
    {
      seq: 4,
      kind: 'control',
      control: { op: 'unsubscribe', channel: 'ops', members: ['w1'] },
    },
    {
      seq: 5,
      kind: 'control',
      control: { op: 'archive', channel: 'ops' },
    },
  ];
  assert.equal(isChannelActive(replayChannels(posts, 2), 'ops', 2), true);
  assert.equal(isChannelActive(replayChannels(posts, 3), 'ops', 3), true);
  assert.equal(isChannelActive(replayChannels(posts, 5), 'ops', 5), false);
  assert.equal(isChannelActive(replayChannels(posts, 5), 'missing', 1), false);

  const at3 = replayChannels(posts, 3);
  assert.deepEqual(at3.ops.subscribers, ['w1', 'w2']);
  const at4 = replayChannels(posts, 4);
  assert.deepEqual(at4.ops.subscribers, ['w2']);
  assert.equal(at3.main.createdAtSeq, 0);
});

// ---------------------------------------------------------------------------
// Board core: construction, membership, permissions, purity.
// ---------------------------------------------------------------------------

import {
  newBoard,
  transition,
  memberBySession,
  boardHead,
  boardView,
  visiblePosts,
  READ_RENDER_LIMIT,
  ERRORS,
} from '../src/board.js';

const ROOT = 'root-session';
const COORD = 'session-coordinator';
const WORKER = 'session-worker-1';

function seedBoard(options = {}) {
  return newBoard('root-session', 'Swarm', {
    coordinator: COORD,
    now: T0,
    ...options,
  });
}

function addWorker(board, sessionId = WORKER, name = 'worker-1', extra = {}) {
  return transition(board, COORD, {
    type: 'add',
    member: { sessionId, name, role: 'worker', ...extra },
  });
}

function assertFailure(res, code) {
  assert.equal(res.result.ok, false, JSON.stringify(res.result));
  assert.equal(res.result.code, code, JSON.stringify(res.result));
}

test('newBoard seeds an empty board with a coordinator and main channel', () => {
  const board = seedBoard();
  assert.equal(board.version, 1);
  assert.equal(board.rootId, ROOT);
  assert.equal(board.title, 'Swarm');
  assert.equal(board.seq, 0);
  assert.equal(board.posts.length, 0);
  assert.deepEqual(Object.keys(board.channels), ['main']);
  const coord = memberBySession(board, COORD);
  assert.equal(coord.role, 'coordinator');
  assert.equal(coord.status, 'active');
  assert.equal(coord.viewAll, true);
  assert.deepEqual(coord.channels, ['main']);
  assert.equal(board.plan.goal.title, '');
});

test('only the coordinator can claim one reserved fallback; working members need not be restarted', () => {
  const route = { provider: 'secondary', model: 'fast' };
  const { state } = addWorker(seedBoard(), WORKER, 'alice', { fallbackRoute: route });
  const working = transition(state, WORKER, { type: 'setStatus', status: 'working' }).state;
  const claim = { type: 'consumeFallback', target: WORKER };
  assertFailure(transition(working, WORKER, claim), ERRORS.FORBIDDEN);
  const consumed = transition(working, COORD, claim);
  assert.equal(consumed.result.ok, true);
  assert.deepEqual(consumed.result.route, route);
  assert.equal(consumed.state.members[WORKER].modelRoute, null, 'a claim is not evidence of a model switch');
  assert.equal(consumed.state.members[WORKER].fallbackRoute, null);
  assert.equal(transition(consumed.state, COORD, claim).result.ok, false);
  const paused = transition(working, COORD, { type: 'pause', target: WORKER }).state;
  assertFailure(transition(paused, COORD, claim), ERRORS.PAUSED);
});

test('a board with no coordinator can be bootstrapped once', () => {
  const empty = newBoard(ROOT, 'Swarm', { now: T0 });
  assertFailure(transition(empty, 'stranger', { type: 'read' }), ERRORS.NOT_MEMBER);
  const boot = transition(empty, 'first', { type: 'bootstrap', name: 'coordinator' });
  assert.equal(boot.result.ok, true);
  assert.equal(boot.state.members.first.role, 'coordinator');
  assertFailure(
    transition(boot.state, 'second', { type: 'bootstrap' }),
    ERRORS.FORBIDDEN,
  );
});

test('non-members cannot read or write the board', () => {
  const board = seedBoard();
  for (const action of [
    { type: 'read' },
    { type: 'post', text: 'hello' },
    { type: 'wait' },
    { type: 'status' },
    { type: 'setTitle', title: 'pwned' },
    { type: 'channel', op: 'create', channel: 'ops' },
  ]) {
    const res = transition(board, 'stranger', action);
    assertFailure(res, ERRORS.NOT_MEMBER);
    assert.equal(res.state, board, 'failed actions leave state untouched');
    assert.deepEqual(res.wakes, []);
  }
});

test('transition is pure and never mutates its input', () => {
  const board = seedBoard();
  const before = structuredClone(board);
  deepFreeze(board);
  const res = transition(board, COORD, { type: 'post', text: 'hello @all' });
  assert.deepEqual(board, before);
  assert.equal(res.result.ok, true);
  assert.equal(res.state.seq, 1);
  assert.notEqual(res.state, board);
  assert.equal(board.posts.length, 0);
});

test('coordinator adds workers and rejects duplicate or unsafe identities', () => {
  const added = addWorker(seedBoard());
  assert.equal(added.result.ok, true);
  assert.equal(added.state.members[WORKER].name, 'worker-1');
  assert.equal(added.state.members[WORKER].addedBy, COORD);
  assert.deepEqual(added.state.members[WORKER].channels, ['main']);

  const dupSession = addWorker(added.state, WORKER, 'worker-2');
  assertFailure(dupSession, ERRORS.DUPLICATE_SESSION);
  const dupName = addWorker(added.state, 'other', 'Worker-1');
  assertFailure(dupName, ERRORS.DUPLICATE_NAME);

  for (const name of ['all', 'main', '__proto__', 'constructor', 'has space', '1st']) {
    assertFailure(addWorker(added.state, `bad-${name}`, name), ERRORS.INVALID_NAME);
  }
  const protoSession = addWorker(added.state, '__proto__', 'safe-name');
  assertFailure(protoSession, ERRORS.INVALID_SESSION);
  assert.equal({}.polluted, undefined);
});

test('a worker may add a helper but may not add coordinators or monitors', () => {
  const withWorker = addWorker(seedBoard()).state;
  const helper = transition(withWorker, WORKER, {
    type: 'add',
    member: { sessionId: 'helper-1', name: 'helper-1', role: 'worker' },
  });
  assert.equal(helper.result.ok, true);
  assert.equal(helper.state.members['helper-1'].addedBy, WORKER);

  assertFailure(
    transition(withWorker, WORKER, {
      type: 'add',
      member: { sessionId: 'fake-coord', name: 'fake', role: 'coordinator' },
    }),
    ERRORS.FORBIDDEN,
  );
  assertFailure(
    transition(withWorker, WORKER, {
      type: 'add',
      member: { sessionId: 'fake-mon', name: 'mon', role: 'monitor' },
    }),
    ERRORS.FORBIDDEN,
  );
});

test('member capacity limit rejects additions and reservations', () => {
  const board = seedBoard({ limits: { maxMembers: 2 } });
  const one = addWorker(board);
  assert.equal(one.result.ok, true);
  assertFailure(
    addWorker(one.state, 'session-worker-2', 'worker-2'),
    ERRORS.LIMIT,
  );
  assertFailure(
    transition(one.state, COORD, {
      type: 'add',
      reserve: true,
      member: { sessionId: 'session-worker-3', name: 'worker-3' },
    }),
    ERRORS.LIMIT,
  );
});

test('reserved joins commit only from the reserved session', () => {
  const board = seedBoard();
  const reserved = transition(board, COORD, {
    type: 'add',
    reserve: true,
    member: { sessionId: WORKER, name: 'worker-1', role: 'worker' },
  });
  assert.equal(reserved.result.ok, true);
  const id = reserved.result.reservation.id;
  assert.equal(reserved.state.members[WORKER], undefined);
  assert.equal(reserved.state.reservations[id].sessionId, WORKER);

  assertFailure(
    transition(reserved.state, 'someone-else', { type: 'commitJoin', reservationId: id }),
    ERRORS.FORBIDDEN,
  );
  const joined = transition(reserved.state, WORKER, {
    type: 'commitJoin',
    reservationId: id,
  });
  assert.equal(joined.result.ok, true);
  assert.equal(joined.state.members[WORKER].role, 'worker');
  assert.equal(joined.state.reservations[id], undefined);
  assertFailure(
    transition(joined.state, WORKER, { type: 'commitJoin', reservationId: id }),
    ERRORS.NOT_FOUND,
  );

  const failed = transition(reserved.state, WORKER, {
    type: 'failJoin',
    reservationId: id,
    reason: 'spawn failed',
  });
  assert.equal(failed.result.ok, true);
  assert.equal(failed.state.reservations[id], undefined);
});

test('only the coordinator edits title and plan; status lists the roster', () => {
  const added = addWorker(seedBoard()).state;
  assertFailure(
    transition(added, WORKER, { type: 'setTitle', title: 'nope' }),
    ERRORS.FORBIDDEN,
  );
  const titled = transition(added, COORD, { type: 'setTitle', title: '  Alpha  ' });
  assert.equal(titled.result.ok, true);
  assert.equal(titled.state.title, 'Alpha');
  assertFailure(
    transition(added, COORD, { type: 'setTitle', title: '   ' }),
    ERRORS.INVALID_ARGUMENT,
  );

  const plan = {
    goal: { title: 'ship', line: 'one board' },
    tasks: { 'worker-1': 'write tests' },
    threads: [{ id: 't1', title: 'core', goal: 'g', tasks: [] }],
  };
  assertFailure(
    transition(added, WORKER, { type: 'setPlan', plan }),
    ERRORS.FORBIDDEN,
  );
  const planned = transition(titled.state, COORD, { type: 'setPlan', plan });
  assert.equal(planned.result.ok, true);
  assert.deepEqual(planned.state.plan, plan);

  const status = transition(planned.state, WORKER, { type: 'status' });
  assert.equal(status.result.ok, true);
  assert.equal(status.result.title, 'Alpha');
  assert.deepEqual(status.result.plan, plan);
  assert.deepEqual(
    status.result.members.map((m) => m.name),
    ['coordinator', 'worker-1'],
  );
  assertFailure(transition(planned.state, 'stranger', { type: 'status' }), ERRORS.NOT_MEMBER);
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Posting, targets and reading.
// ---------------------------------------------------------------------------

test('posts resolve trusted member targets and channel edges', () => {
  let board = addWorker(seedBoard()).state;
  board = addWorker(board, 'session-worker-2', 'worker-2').state;
  const created = transition(board, COORD, {
    type: 'channel',
    op: 'create',
    channel: 'ops',
    topic: 'operations',
  });
  assert.equal(created.result.ok, true);
  board = transition(created.state, COORD, {
    type: 'channel',
    op: 'subscribe',
    channel: 'ops',
    members: [WORKER],
  }).state;

  const posted = transition(board, COORD, {
    type: 'post',
    text: 'ping @worker-1 @#ops @all',
    now: T0 + 1,
  });
  assert.equal(posted.result.ok, true);
  assert.equal(posted.state.seq, 3);
  const message = posted.result.message;
  assert.deepEqual(message.mentions.names, ['worker-1']);
  assert.deepEqual(message.mentions.channels, ['ops']);
  assert.deepEqual(message.targets, ['worker-1', 'worker-2']);
  assert.deepEqual(message.mentionChannels, ['ops']);

  const control = posted.state.posts[0];
  assert.equal(control.kind, 'control');
  assert.deepEqual(control.targets, []);
  assert.deepEqual(control.control.channel, 'ops');
});

test('read walks the cursor forward and never skips unread posts', () => {
  let board = addWorker(seedBoard()).state;
  board = addWorker(board, 'session-worker-2', 'worker-2').state;
  for (const text of ['one @worker-1', 'two', 'three @worker-1']) {
    board = transition(board, COORD, { type: 'post', text }).state;
  }

  const first = transition(board, WORKER, { type: 'read', limit: 2 });
  assert.deepEqual(first.result.messages.map((m) => m.seq), [1, 2]);
  assert.equal(first.result.lastReadSeq, 2);
  assert.equal(first.result.hasMore, true);

  const second = transition(first.state, WORKER, { type: 'read' });
  assert.deepEqual(second.result.messages.map((m) => m.seq), [3]);
  assert.equal(second.result.lastReadSeq, 3);
  assert.equal(second.result.hasMore, false);

  const peeked = transition(second.state, WORKER, { type: 'read', since: 0, peek: true });
  assert.deepEqual(peeked.result.messages.map((m) => m.seq), [1, 2, 3]);
  assert.equal(peeked.result.lastReadSeq, 3, 'peek never moves the cursor');
  assert.equal(peeked.state.members[WORKER].lastReadSeq, 3);

  const jumped = transition(board, 'session-worker-2', {
    type: 'read',
    seqs: [3, 3],
  });
  assert.deepEqual(jumped.result.messages.map((m) => m.seq), [3]);
  assert.equal(jumped.result.lastReadSeq, 0, 'reading seq 3 cannot skip unread seq 1');
});

test('read pages long posts by their rendered envelope instead of dropping them', () => {
  const envelopeSize = (result) => JSON.stringify({ ok: true, ...result }, null, 2).length;
  let board = addWorker(seedBoard()).state;
  board = transition(board, COORD, { type: 'post', text: 'start' }).state;
  board = transition(board, WORKER, { type: 'read' }).state;
  board = park(board, WORKER).state;

  const first = 'a'.repeat(6000) + ' @worker-1';
  const second = 'b'.repeat(6000) + ' @worker-1';
  board = transition(board, COORD, { type: 'post', text: first }).state;
  const posted = transition(board, COORD, { type: 'post', text: second });
  board = posted.state;
  assert.deepEqual(posted.wakes.map((wake) => wake.seq), [3], 'pending wake follows the newest post');

  const page1 = transition(board, WORKER, { type: 'read' });
  assert.deepEqual(page1.result.messages.map((m) => m.seq), [2], 'only the post that fits is delivered');
  assert.equal(page1.result.lastReadSeq, 2);
  assert.equal(page1.result.hasMore, true);
  assert.ok(envelopeSize(page1.result) <= READ_RENDER_LIMIT);
  assert.deepEqual(page1.state.pendingWakes.map((wake) => wake.seq), [3], 'unsent post keeps its doorbell');

  const page2 = transition(page1.state, WORKER, { type: 'read' });
  assert.deepEqual(page2.result.messages.map((m) => m.seq), [3]);
  assert.deepEqual(page2.result.messages.map((m) => m.text), [second]);
  assert.equal(page2.result.lastReadSeq, 3);
  assert.equal(page2.result.hasMore, false);
  assert.deepEqual(page2.state.pendingWakes, []);

  const empty = transition(page2.state, WORKER, { type: 'read' });
  assert.deepEqual(empty.result.messages, [], 'the page after the last post is empty');
  assert.equal(empty.result.lastReadSeq, 3);
});

test('a single post whose escaped rendering exceeds the limit is still returned whole', () => {
  const text = '"'.repeat(6144);
  let board = addWorker(seedBoard()).state;
  board = transition(board, COORD, { type: 'post', text }).state;

  const page = transition(board, WORKER, { type: 'read' });
  assert.deepEqual(page.result.messages.map((m) => m.seq), [1]);
  assert.equal(page.result.messages[0].text, text);
  assert.ok(JSON.stringify({ ok: true, ...page.result }, null, 2).length > READ_RENDER_LIMIT);
  assert.equal(page.result.lastReadSeq, 1);
  assert.equal(page.result.hasMore, false);

  const again = transition(page.state, WORKER, { type: 'read' });
  assert.deepEqual(again.result.messages, [], 'the oversized post is not delivered twice');
  assert.equal(again.result.lastReadSeq, 1);
});

test('peek reports a same-query continuation without advancing the cursor', () => {
  let board = addWorker(seedBoard()).state;
  const first = 'a'.repeat(6000);
  const second = 'b'.repeat(6000);
  board = transition(board, COORD, { type: 'post', text: first }).state;
  board = transition(board, COORD, { type: 'post', text: second }).state;

  const peek = transition(board, WORKER, { type: 'read', peek: true, since: 0 });
  assert.deepEqual(peek.result.messages.map((m) => m.seq), [1]);
  assert.equal(peek.result.hasMore, true);
  assert.equal(peek.result.nextSince, 1);
  assert.equal(peek.result.lastReadSeq, 0, 'peek never advances the cursor');
  assert.equal(peek.state.members[WORKER].lastReadSeq, 0);

  const peekAgain = transition(peek.state, WORKER, { type: 'read', peek: true, since: 0 });
  assert.deepEqual(peekAgain.result.messages.map((m) => m.seq), [1], 'peek repeats the same page');
  const next = transition(peekAgain.state, WORKER, {
    type: 'read',
    since: peekAgain.result.nextSince,
  });
  assert.deepEqual(next.result.messages.map((m) => m.seq), [2]);
});

test('channel-filtered reads continue at the page tail', () => {
  let board = addWorker(seedBoard()).state;
  board = transition(board, COORD, { type: 'channel', op: 'create', channel: 'ops' }).state;
  board = transition(board, COORD, {
    type: 'channel',
    op: 'subscribe',
    channel: 'ops',
    members: [WORKER],
  }).state;
  const ops1 = '1'.repeat(6000);
  const ops2 = '2'.repeat(6000);
  board = transition(board, COORD, { type: 'post', text: ops1, channel: 'ops' }).state;
  board = transition(board, COORD, { type: 'post', text: 'main post' }).state;
  board = transition(board, COORD, { type: 'post', text: ops2, channel: 'ops' }).state;

  const first = transition(board, WORKER, { type: 'read', channel: 'ops' });
  assert.deepEqual(first.result.messages.map((m) => m.seq), [3]);
  assert.equal(first.result.hasMore, true);
  assert.equal(first.result.nextSince, 3);
  const second = transition(first.state, WORKER, {
    type: 'read',
    channel: 'ops',
    since: first.result.nextSince,
  });
  assert.deepEqual(second.result.messages.map((m) => m.seq), [5], 'no main-channel post is mixed in');
  assert.equal(second.result.hasMore, false);
});

test('explicit seqs continue from the last delivered seq without growing the result', () => {
  let board = addWorker(seedBoard()).state;
  for (const prefix of ['a', 'b', 'c']) {
    board = transition(board, COORD, { type: 'post', text: prefix.repeat(6000) }).state;
  }
  const first = transition(board, WORKER, { type: 'read', seqs: [1, 2, 3] });
  assert.deepEqual(first.result.messages.map((m) => m.seq), [1]);
  assert.equal(first.result.hasMore, true);
  assert.equal(first.result.nextSince, 1);
  assert.equal(first.result.lastReadSeq, 1, 'seq 1 was delivered, so the cursor reaches it');
  const second = transition(first.state, WORKER, {
    type: 'read',
    seqs: [1, 2, 3], since: first.result.nextSince,
  });
  assert.deepEqual(second.result.messages.map((m) => m.seq), [2]);
  assert.equal(second.result.nextSince, 2);
});

test('read hides channels the member cannot see', () => {
  let board = addWorker(seedBoard()).state;
  board = addWorker(board, 'session-worker-2', 'worker-2').state;
  const created = transition(board, COORD, { type: 'channel', op: 'create', channel: 'ops' });
  board = created.state;
  board = transition(board, COORD, {
    type: 'channel',
    op: 'subscribe',
    channel: 'ops',
    members: [WORKER],
  }).state;
  board = transition(board, COORD, { type: 'post', text: 'secret', channel: 'ops' }).state;
  board = transition(board, COORD, { type: 'post', text: 'public' }).state;

  const w1 = transition(board, WORKER, { type: 'read' });
  assert.deepEqual(w1.result.messages.map((m) => m.text), ['secret', 'public']);
  const w2 = transition(board, 'session-worker-2', { type: 'read' });
  assert.deepEqual(w2.result.messages.map((m) => m.text), ['public']);
  assertFailure(
    transition(board, 'session-worker-2', { type: 'post', text: 'nope', channel: 'ops' }),
    ERRORS.NOT_SUBSCRIBED,
  );
});

// ---------------------------------------------------------------------------
// Parking, wakes and member lifecycle.
// ---------------------------------------------------------------------------

function park(board, sessionId, options = {}) {
  return transition(board, sessionId, { type: 'wait', ...options });
}

function prepareParked(wakeMode = 'mentions') {
  let board = addWorker(seedBoard()).state;
  board = transition(board, COORD, { type: 'post', text: 'start' }).state;
  board = transition(board, WORKER, { type: 'read' }).state;
  const parked = park(board, WORKER, { mentionsOnly: wakeMode === 'mentions' });
  assert.equal(parked.result.ok, true, JSON.stringify(parked.result));
  return parked.state;
}

test('wait parks on unread and wakes only on mentions in mentions mode', () => {
  let board = prepareParked('mentions');
  assert.equal(board.members[WORKER].status, 'waiting');

  const neutral = transition(board, COORD, { type: 'post', text: 'hello' });
  assert.deepEqual(neutral.wakes, []);
  assert.equal(neutral.state.pendingWakes.length, 0);

  const mention = transition(neutral.state, COORD, { type: 'post', text: 'help @worker-1' });
  assert.deepEqual(mention.wakes, [{ sessionId: WORKER, seq: 3 }]);
  assert.equal(mention.state.pendingWakes[0].seq, 3);

  const read = transition(mention.state, WORKER, { type: 'read' });
  assert.deepEqual(read.result.messages.map((m) => m.seq), [2, 3]);
  assert.equal(read.state.members[WORKER].status, 'active');
  assert.equal(read.state.pendingWakes.length, 0);
});

test('anything mode wakes on every visible post', () => {
  let board = prepareParked('anything');
  assert.equal(board.members[WORKER].wakeMode, 'anything');
  const neutral = transition(board, COORD, { type: 'post', text: 'hello' });
  assert.deepEqual(neutral.wakes, [{ sessionId: WORKER, seq: 2 }]);
});

test('wait rejects unread and empty boards without changing the cursor', () => {
  const empty = seedBoard();
  assertFailure(park(empty, COORD), ERRORS.EMPTY);

  let board = addWorker(empty).state;
  board = transition(board, COORD, { type: 'post', text: 'one @worker-1' }).state;
  const unread = park(board, WORKER);
  assertFailure(unread, ERRORS.UNREAD);
  assert.equal(unread.state.members[WORKER].status, 'active');
  assert.equal(unread.state.members[WORKER].lastReadSeq, 0);
});

test('@all and @#channel wake parked members', () => {
  let board = prepareParked('mentions');
  const all = transition(board, COORD, { type: 'post', text: 'standup @all' });
  assert.deepEqual(all.wakes, [{ sessionId: WORKER, seq: 2 }]);

  board = transition(all.state, WORKER, { type: 'read' }).state;
  const created = transition(board, COORD, { type: 'channel', op: 'create', channel: 'ops' });
  board = transition(created.state, COORD, {
    type: 'channel',
    op: 'subscribe',
    channel: 'ops',
    members: [WORKER],
  }).state;
  board = transition(board, WORKER, { type: 'read' }).state;
  board = park(board, WORKER).state;
  const channel = transition(board, COORD, { type: 'post', text: 'ping @#ops' });
  assert.deepEqual(channel.wakes, [{ sessionId: WORKER, seq: channel.result.seq }]);
});

test('pause blocks post/wait, keeps read, and resume re-wakes missed mentions', () => {
  let board = prepareParked('mentions');
  board = transition(board, COORD, { type: 'post', text: 'wake @worker-1' }).state;
  assert.equal(board.pendingWakes.length, 1);

  const paused = transition(board, COORD, { type: 'pause', target: WORKER });
  assert.equal(paused.result.ok, true);
  assert.equal(paused.state.members[WORKER].status, 'paused');
  assert.equal(paused.state.pendingWakes.length, 0);

  assertFailure(
    transition(paused.state, WORKER, { type: 'post', text: 'nope' }),
    ERRORS.PAUSED,
  );
  assertFailure(park(paused.state, WORKER), ERRORS.PAUSED);
  const read = transition(paused.state, WORKER, { type: 'read' });
  assert.equal(read.result.ok, true);

  const missed = transition(paused.state, COORD, { type: 'post', text: 'more @worker-1' });
  assert.deepEqual(missed.wakes, []);
  const resumed = transition(missed.state, COORD, { type: 'resume', target: WORKER });
  assert.equal(resumed.result.ok, true);
  assert.equal(resumed.state.members[WORKER].status, 'waiting');
  assert.deepEqual(resumed.wakes, [
    { sessionId: WORKER, seq: missed.state.seq },
  ]);
});

test('killed members are closed; the coordinator cannot be removed', () => {
  let board = prepareParked('mentions');
  board = transition(board, COORD, { type: 'post', text: 'wake @worker-1' }).state;
  const killed = transition(board, COORD, { type: 'kill', target: WORKER });
  assert.equal(killed.result.ok, true);
  assert.equal(killed.state.members[WORKER].status, 'killed');
  assert.equal(killed.state.pendingWakes.length, 0);
  assertFailure(transition(killed.state, WORKER, { type: 'read' }), ERRORS.CLOSED);
  assertFailure(
    transition(killed.state, WORKER, { type: 'post', text: 'nope' }),
    ERRORS.CLOSED,
  );
  assertFailure(transition(killed.state, COORD, { type: 'kill', target: COORD }), ERRORS.FORBIDDEN);
});

// ---------------------------------------------------------------------------
// Wake delivery, retries and quotas.
// ---------------------------------------------------------------------------

test('wake delivery retries and eventually drops after maxWakeAttempts', () => {
  let board = prepareParked('mentions');
  board = transition(board, COORD, { type: 'post', text: 'wake @worker-1' }).state;
  assert.equal(board.pendingWakes.length, 1);

  const failed = transition(board, COORD, {
    type: 'wakeResult',
    sessionId: WORKER,
    seq: 2,
    delivered: false,
  });
  assert.equal(failed.result.ok, true);
  assert.equal(failed.result.attempts, 1);
  assert.equal(failed.result.dropped, false);

  const retried = transition(failed.state, COORD, { type: 'retryWakes', limit: 1 });
  assert.equal(retried.result.retried, 1);
  assert.deepEqual(retried.wakes, [{ sessionId: WORKER, seq: 2 }]);
  assert.equal(retried.state.pendingWakes[0].attempts, 2);

  const dropped = transition(retried.state, COORD, { type: 'retryWakes', limit: 1 });
  assert.equal(dropped.result.failed, 1);
  assert.deepEqual(dropped.wakes, []);
  assert.equal(dropped.state.pendingWakes.length, 0);
});

test('a batch wake acknowledgement clears several pending wakes', () => {
  let board = addWorker(seedBoard()).state;
  board = addWorker(board, 'session-worker-2', 'worker-2').state;
  board = transition(board, COORD, { type: 'post', text: 'start' }).state;
  board = transition(board, WORKER, { type: 'read' }).state;
  board = transition(board, 'session-worker-2', { type: 'read' }).state;
  board = park(board, WORKER).state;
  board = park(board, 'session-worker-2').state;
  const posted = transition(board, COORD, { type: 'post', text: '@worker-1 @worker-2 go' });
  assert.equal(posted.wakes.length, 2);

  const acked = transition(posted.state, COORD, {
    type: 'wakeResult',
    acks: posted.wakes.map((wake) => ({ ...wake, delivered: true })),
  });
  assert.equal(acked.result.ok, true);
  assert.equal(acked.result.results.length, 2);
  assert.equal(acked.state.pendingWakes.length, 0);
});

test('wakeResult is coordinator-only and missing wakes are NOT_FOUND', () => {
  const board = prepareParked('mentions');
  assertFailure(
    transition(board, WORKER, { type: 'wakeResult', sessionId: WORKER, seq: 1 }),
    ERRORS.FORBIDDEN,
  );
  assertFailure(
    transition(board, COORD, { type: 'wakeResult', sessionId: WORKER, seq: 1 }),
    ERRORS.NOT_FOUND,
  );
});

test('rate, byte, board and pending-wake limits are enforced', () => {
  let board = addWorker(seedBoard({ limits: { ratePosts: 1 } })).state;
  board = transition(board, WORKER, { type: 'post', text: 'one' }).state;
  assertFailure(
    transition(board, WORKER, { type: 'post', text: 'two' }),
    ERRORS.RATE_LIMITED,
  );

  board = addWorker(seedBoard({ limits: { maxPostBytes: 4 } })).state;
  assertFailure(
    transition(board, WORKER, { type: 'post', text: 'hello' }),
    ERRORS.POST_TOO_LARGE,
  );
  assert.equal(transition(board, WORKER, { type: 'post', text: 'ok' }).result.ok, true);

  board = addWorker(seedBoard({ limits: { maxPosts: 1 } })).state;
  board = transition(board, COORD, { type: 'post', text: 'one' }).state;
  assertFailure(
    transition(board, COORD, { type: 'post', text: 'two' }),
    ERRORS.BOARD_FULL,
  );

  board = addWorker(seedBoard({ limits: { maxBoardBytes: 10 } })).state;
  board = transition(board, COORD, { type: 'post', text: '12345' }).state;
  assertFailure(
    transition(board, COORD, { type: 'post', text: '123456' }),
    ERRORS.BOARD_FULL,
  );

  board = addWorker(seedBoard({ limits: { maxPendingWakes: 2 } })).state;
  board = addWorker(board, 'session-worker-2', 'worker-2').state;
  board = addWorker(board, 'session-worker-3', 'worker-3').state;
  board = transition(board, COORD, { type: 'post', text: 'start' }).state;
  for (const id of [WORKER, 'session-worker-2', 'session-worker-3']) {
    board = transition(board, id, { type: 'read' }).state;
    board = park(board, id).state;
  }
  const all = transition(board, COORD, { type: 'post', text: '@all go' });
  assert.equal(all.wakes.length, 2);
  assert.equal(all.state.pendingWakes.length, 2);

  board = addWorker(seedBoard({ limits: { maxPlanBytes: 10 } })).state;
  assertFailure(
    transition(board, COORD, { type: 'setPlan', plan: { goal: 'a long plan' } }),
    ERRORS.LIMIT,
  );
});

// ---------------------------------------------------------------------------
// Channels and member administration.
// ---------------------------------------------------------------------------

test('channel lifecycle is coordinator-owned and archived channels stay readable', () => {
  let board = addWorker(seedBoard()).state;
  assertFailure(
    transition(board, WORKER, { type: 'channel', op: 'create', channel: 'ops' }),
    ERRORS.FORBIDDEN,
  );
  const created = transition(board, COORD, {
    type: 'channel',
    op: 'create',
    channel: 'ops',
    topic: 'operations',
  });
  assert.equal(created.result.ok, true);
  assert.equal(created.result.seq, 1);
  assert.equal(created.state.channels.ops.createdAtSeq, 1);
  board = created.state;
  assertFailure(
    transition(board, COORD, { type: 'channel', op: 'create', channel: 'ops' }),
    ERRORS.DUPLICATE_CHANNEL,
  );

  board = transition(board, WORKER, {
    type: 'channel',
    op: 'subscribe',
    channel: 'ops',
    members: [WORKER],
  }).state;
  board = transition(board, COORD, { type: 'post', text: 'secret', channel: 'ops' }).state;
  board = transition(board, COORD, { type: 'channel', op: 'archive', channel: 'ops' }).state;
  assert.equal(board.channels.ops.archivedAtSeq, board.seq);
  assertFailure(
    transition(board, COORD, { type: 'post', text: 'too late', channel: 'ops' }),
    ERRORS.CHANNEL_ARCHIVED,
  );
  assertFailure(
    transition(board, WORKER, {
      type: 'channel',
      op: 'subscribe',
      channel: 'ops',
      members: [WORKER],
    }),
    ERRORS.CHANNEL_ARCHIVED,
  );
  const unsub = transition(board, WORKER, {
    type: 'channel',
    op: 'unsubscribe',
    channel: 'ops',
    members: [WORKER],
  });
  assert.equal(unsub.result.ok, true);

  const history = transition(board, WORKER, { type: 'read', since: 0 });
  assert.deepEqual(history.result.messages.map((m) => m.text), ['secret']);
  const list = transition(board, WORKER, { type: 'channel', op: 'list' });
  assert.deepEqual(list.result.channels.map((c) => c.name), ['main', 'ops']);
});

test('reserved joins claim names and sessions before commit', () => {
  const board = seedBoard();
  const reserved = transition(board, COORD, {
    type: 'reserveJoin',
    member: { sessionId: WORKER, name: 'worker-1' },
  });
  assert.equal(reserved.result.ok, true);
  const id = reserved.result.reservationId;
  assertFailure(
    transition(reserved.state, COORD, {
      type: 'add',
      member: { sessionId: WORKER, name: 'worker-1' },
    }),
    ERRORS.ALREADY_RESERVED,
  );
  assertFailure(
    transition(reserved.state, COORD, {
      type: 'add',
      member: { sessionId: 'session-worker-2', name: 'Worker-1' },
    }),
    ERRORS.DUPLICATE_NAME,
  );
  const failed = transition(reserved.state, COORD, {
    type: 'failJoin',
    reservationId: id,
    reason: 'spawn failed',
  });
  assert.equal(failed.result.ok, true);
  assert.equal(failed.state.reservations[id], undefined);
});

test('setStatus/setModel are managed and model changes wake parked members', () => {
  let board = addWorker(seedBoard()).state;
  assertFailure(
    transition(board, WORKER, { type: 'setStatus', target: COORD, status: 'waiting' }),
    ERRORS.FORBIDDEN,
  );
  const waiting = transition(board, COORD, {
    type: 'setStatus',
    target: WORKER,
    status: 'waiting',
    since: 0,
  });
  assert.equal(waiting.result.ok, true);
  assert.equal(waiting.state.members[WORKER].waitSince, 0);

  const model = transition(waiting.state, COORD, {
    type: 'setModel',
    target: WORKER,
    modelRoute: { provider: 'deepseek', model: 'v4' },
  });
  assert.equal(model.result.ok, true);
  assert.deepEqual(model.state.members[WORKER].modelRoute, {
    provider: 'deepseek',
    model: 'v4',
  });
  assert.deepEqual(model.wakes, [{ sessionId: WORKER, seq: 0 }]);

  const working = transition(model.state, COORD, {
    type: 'setStatus',
    target: WORKER,
    status: 'working',
  }).state;
  assertFailure(
    transition(working, COORD, {
      type: 'setModel',
      target: WORKER,
      modelRoute: { provider: 'deepseek', model: 'v4' },
    }),
    ERRORS.BUSY,
  );
});

// ---------------------------------------------------------------------------
// Restart reconciliation and strict-JSON state.
// ---------------------------------------------------------------------------

test('reconcile repairs cursors, channels, stats and stale reservations', () => {
  let board = addWorker(seedBoard()).state;
  const reserved = transition(board, COORD, {
    type: 'reserveJoin',
    member: { sessionId: 'session-ghost', name: 'ghost' },
  });
  board = transition(reserved.state, COORD, { type: 'post', text: 'start' }).state;
  board = transition(board, WORKER, { type: 'read' }).state;

  const stored = JSON.parse(JSON.stringify(board));
  stored.members[WORKER].lastReadSeq = 999;
  stored.members[WORKER].waitSince = 999;
  stored.members[WORKER].channels.push('ghost-channel');
  stored.stats.postBytes = 0;
  stored.pendingWakes.push({
    sessionId: WORKER,
    seq: 999,
    reason: 'corrupt',
    attempts: 0,
    at: T0,
    status: 'pending',
  });

  const repaired = transition(stored, null, {
    type: 'reconcile',
    liveSessionIds: [COORD],
    now: T0 + 5,
  });
  assert.equal(repaired.result.ok, true);
  assert.ok(repaired.result.fixes.length > 0);
  assert.equal(repaired.state.members[WORKER].lastReadSeq, repaired.state.seq);
  assert.equal(repaired.state.members[WORKER].waitSince, repaired.state.seq);
  assert.deepEqual(repaired.state.members[WORKER].channels, ['main']);
  assert.equal(repaired.state.members[WORKER].status, 'stopped');
  assert.equal(repaired.state.reservations[reserved.result.reservationId], undefined);
  assert.equal(repaired.state.pendingWakes.length, 0);
  assert.equal(
    repaired.state.stats.postBytes,
    Buffer.byteLength('start', 'utf8'),
  );

  const again = transition(repaired.state, null, {
    type: 'reconcile',
    liveSessionIds: [COORD],
    now: T0 + 6,
  });
  assert.deepEqual(again.result.fixes, []);
  assert.deepEqual(again.wakes, []);
});

test('reconcile re-emits pending wakes but never resurrects stopped members', () => {
  let board = prepareParked('mentions');
  board = transition(board, COORD, { type: 'post', text: 'wake @worker-1' }).state;
  board = JSON.parse(JSON.stringify(board));

  const live = transition(board, null, {
    type: 'reconcile',
    liveSessionIds: [COORD, WORKER],
    now: T0 + 1,
  });
  assert.equal(live.state.members[WORKER].status, 'waiting');
  assert.deepEqual(live.wakes, [{ sessionId: WORKER, seq: 2 }]);

  const dead = transition(board, null, {
    type: 'reconcile',
    liveSessionIds: [COORD],
    now: T0 + 1,
  });
  assert.equal(dead.state.members[WORKER].status, 'stopped');
  assert.equal(dead.wakes.length, 0);
});

test('board views are bounded and visiblePosts is a read-only projection', () => {
  let board = addWorker(seedBoard()).state;
  board = transition(board, COORD, { type: 'post', text: 'a'.repeat(120) }).state;
  board = transition(board, COORD, { type: 'post', text: 'two' }).state;
  board = transition(board, COORD, { type: 'post', text: 'three' }).state;

  const before = structuredClone(board);
  const visible = visiblePosts(board, WORKER, { since: 0 });
  assert.deepEqual(visible.map((message) => message.seq), [1, 2, 3]);
  assert.deepEqual(visiblePosts(board, 'stranger'), []);
  assert.deepEqual(board, before, 'visiblePosts never mutates the board');

  const view = boardView(board, { postLimit: 1, memberLimit: 1, textLimit: 64 });
  assert.equal(view.posts.length, 1);
  assert.equal(view.posts[0].seq, 3);
  assert.equal(view.members.length, 1);
  assert.equal(view.truncated.posts, true);
  assert.equal(view.truncated.members, true);

  const narrow = boardView(board, { postLimit: 2, memberLimit: 10, textLimit: 64 });
  assert.equal(narrow.posts.length, 2);
  assert.equal(narrow.posts[0].seq, 2);
  assert.equal(narrow.posts[ 1 ].text, 'three');
  assert.equal(boardView(board, { postLimit: 0 }).posts.length, 0);
});

test('new workers fast-forward to the head unless they explicitly ask for history', () => {
  let board = seedBoard();
  board = transition(board, COORD, { type: 'post', text: 'one' }).state;
  board = transition(board, COORD, { type: 'post', text: 'two' }).state;
  board = addWorker(board).state;
  assert.equal(board.members[WORKER].lastReadSeq, 2);
  const emptyRead = transition(board, WORKER, { type: 'read' });
  assert.deepEqual(emptyRead.result.messages, []);
  assert.equal(emptyRead.result.lastReadSeq, 2);

  board = addWorker(board, 'session-worker-2', 'worker-2', { lastReadSeq: 0 }).state;
  const history = transition(board, 'session-worker-2', { type: 'read' });
  assert.deepEqual(history.result.messages.map((message) => message.text), ['one', 'two']);
});

test('plans reject non-JSON values, cycles and prototype keys', () => {
  const board = seedBoard();
  const cyclic = {};
  cyclic.self = cyclic;
  const dangerous = { ['__proto__']: { polluted: true } };
  for (const plan of [
    { value: undefined },
    { value: NaN },
    { value: Infinity },
    { value: () => {} },
    { value: 1n },
    { value: new Date() },
    [],
    cyclic,
    dangerous,
  ]) {
    const res = transition(board, COORD, { type: 'setPlan', plan });
    assertFailure(res, ERRORS.INVALID_ARGUMENT);
    assert.equal(res.state, board);
  }
  assert.equal({}.polluted, undefined);

  const accepted = transition(board, COORD, {
    type: 'setPlan',
    plan: { goal: { title: 'ok' }, tasks: {}, threads: [] },
  });
  assert.equal(accepted.result.ok, true);
  assert.equal(accepted.state.plan.goal.title, 'ok');
});

test('titles, identities and channel names stay bounded and safe', () => {
  const board = seedBoard();
  assertFailure(
    transition(board, COORD, { type: 'setTitle', title: 'x'.repeat(121) }),
    ERRORS.INVALID_ARGUMENT,
  );
  assertFailure(
    transition(board, COORD, { type: 'setTitle', title: '   ' }),
    ERRORS.INVALID_ARGUMENT,
  );
  assertFailure(
    transition(board, WORKER, { type: 'setTitle', title: 'nope' }),
    ERRORS.NOT_MEMBER,
  );
  assert.throws(() => newBoard('__proto__'));
  assert.throws(() => newBoard(ROOT, 'Swarm', { coordinator: { sessionId: 's', name: 'all' } }));
  assert.throws(() => newBoard(ROOT, 'x'.repeat(121)));

  assertFailure(
    transition(board, COORD, { type: 'channel', op: 'create', channel: '__proto__' }),
    ERRORS.INVALID_NAME,
  );
  assertFailure(
    transition(board, COORD, { type: 'channel', op: 'create', channel: 'ops', topic: 'x'.repeat(201) }),
    ERRORS.INVALID_ARGUMENT,
  );
  assertFailure(
    transition(board, COORD, { type: 'channel', op: 'archive', channel: 'main' }),
    ERRORS.UNKNOWN_CHANNEL,
  );

  let limited = newBoard(ROOT, 'Swarm', {
    coordinator: COORD,
    now: T0,
    limits: { maxChannels: 1 },
  });
  const first = transition(limited, COORD, { type: 'channel', op: 'create', channel: 'ops' });
  assert.equal(first.result.ok, true);
  assertFailure(
    transition(first.state, COORD, { type: 'channel', op: 'create', channel: 'dev' }),
    ERRORS.LIMIT,
  );

  const duplicate = transition(board, COORD, { type: 'channel', op: 'create', channel: 'ops' });
  assert.equal(duplicate.result.ok, true);
  assertFailure(
    transition(duplicate.state, COORD, { type: 'channel', op: 'create', channel: 'ops' }),
    ERRORS.DUPLICATE_CHANNEL,
  );
});

test('rate limits expire at the window boundary and failed controls are atomic', () => {
  let board = newBoard(ROOT, 'Swarm', {
    coordinator: COORD,
    now: T0,
    limits: { ratePosts: 1, rateWindowMs: 1000, maxPosts: 2 },
  });
  board = transition(board, COORD, { type: 'post', text: 'one', now: T0 + 1 }).state;
  assertFailure(
    transition(board, COORD, { type: 'post', text: 'two', now: T0 + 2 }),
    ERRORS.RATE_LIMITED,
  );
  const later = transition(board, COORD, { type: 'post', text: 'three', now: T0 + 1002 });
  assert.equal(later.result.ok, true);

  let capped = newBoard(ROOT, 'Swarm', {
    coordinator: COORD,
    now: T0,
    limits: { maxPosts: 2 },
  });
  capped = addWorker(capped).state;
  capped = transition(capped, COORD, { type: 'channel', op: 'create', channel: 'ops' }).state;
  capped = transition(capped, COORD, { type: 'post', text: 'fill' }).state;
  assert.equal(capped.posts.length, 2);
  const denied = transition(capped, COORD, {
    type: 'channel',
    op: 'subscribe',
    channel: 'ops',
    members: [WORKER],
  });
  assertFailure(denied, ERRORS.BOARD_FULL);
  assert.equal(denied.state, capped);
  assert.deepEqual(denied.state.members[WORKER].channels, ['main']);
  assert.deepEqual(denied.state.channels.ops.subscribers, [COORD]);
});

test('read keeps hasMore scoped to the same explicit-seq query', () => {
  let board = addWorker(seedBoard()).state;
  for (const text of ['one', 'two', 'three']) {
    board = transition(board, COORD, { type: 'post', text }).state;
  }
  const jumped = transition(board, 'session-worker-1', { type: 'read', seqs: [3] });
  assert.deepEqual(jumped.result.messages.map((message) => message.seq), [3]);
  assert.equal(jumped.result.lastReadSeq, 0, 'a jumped seq cannot skip unread seq 1');
  assert.equal(jumped.result.hasMore, false, 'the explicit seq query has no continuation');
  assert.equal(jumped.result.nextSince, undefined);
  assertFailure(
    transition(board, WORKER, { type: 'read', channel: 'missing' }),
    ERRORS.UNKNOWN_CHANNEL,
  );
  assertFailure(
    transition(board, WORKER, { type: 'read', since: 99 }),
    ERRORS.INVALID_ARGUMENT,
  );
});

test('resume restores the status the member had before pausing', () => {
  let board = addWorker(seedBoard()).state;
  board = transition(board, COORD, {
    type: 'setStatus',
    target: WORKER,
    status: 'waiting',
    since: 0,
  }).state;
  const paused = transition(board, COORD, { type: 'pause', target: WORKER });
  assert.equal(paused.result.ok, true);
  const resumed = transition(paused.state, COORD, { type: 'resume', target: WORKER });
  assert.equal(resumed.state.members[WORKER].status, 'waiting');

  const stopped = transition(resumed.state, COORD, {
    type: 'setStatus',
    target: WORKER,
    status: 'stopped',
  }).state;
  const pausedAgain = transition(stopped, COORD, { type: 'pause', target: WORKER }).state;
  const resumedAgain = transition(pausedAgain, COORD, { type: 'resume', target: WORKER });
  assert.equal(resumedAgain.state.members[WORKER].status, 'stopped');
});

test('resuming a member that is not paused is an idempotent control', () => {
  const board = addWorker(seedBoard()).state;
  const resumed = transition(board, COORD, { type: 'resume', target: WORKER });
  assert.equal(resumed.result.ok, true);
  assert.equal(resumed.state.members[WORKER].status, 'active', 'a live worker stays active');
  assert.deepEqual(resumed.wakes, [], 'resume must not schedule a duplicate wake');
  assert.deepEqual(transition(board, COORD, { type: 'post', text: 'hello @worker-1' }).wakes, []);
});

test('resuming a paused active member leaves it wakeable instead of optimistically active', () => {
  let board = addWorker(seedBoard()).state;
  const paused = transition(board, COORD, { type: 'pause', target: WORKER });
  const resumed = transition(paused.state, COORD, { type: 'resume', target: WORKER });
  assert.equal(resumed.result.ok, true);
  assert.equal(
    resumed.state.members[WORKER].status,
    'stopped',
    'resume must not claim an activation that was released',
  );
  assert.deepEqual(resumed.wakes, [], 'there is no unread directed post to catch up');

  const mentioned = transition(resumed.state, COORD, {
    type: 'post',
    text: 'now wake @worker-1',
  });
  assert.deepEqual(
    mentioned.wakes.map((wake) => wake.sessionId),
    [WORKER],
    'a later mention must still wake the resumed member',
  );
});

test('wake acknowledgements guard malformed batches and retries validate ids', () => {
  let board = prepareParked('mentions');
  board = transition(board, COORD, { type: 'post', text: 'wake @worker-1' }).state;
  const acked = transition(board, COORD, {
    type: 'wakeResult',
    acks: [null, { sessionId: WORKER, seq: 2, delivered: true }],
  });
  assert.equal(acked.result.ok, true);
  assert.equal(acked.result.results[0].ok, false);
  assert.equal(acked.result.results[0].code, ERRORS.INVALID_ARGUMENT);
  assert.equal(acked.result.results[1].delivered, true);
  assert.equal(acked.state.pendingWakes.length, 0);

  assertFailure(
    transition(acked.state, COORD, { type: 'retryWakes', sessionId: 7 }),
    ERRORS.INVALID_ARGUMENT,
  );
});

test('setGoal cannot silently grow the plan past maxPlanBytes', () => {
  const board = newBoard(ROOT, 'Swarm', {
    coordinator: COORD,
    now: T0,
    limits: { maxPlanBytes: 80 },
  });
  const before = structuredClone(board.plan);
  assertFailure(
    transition(board, COORD, { type: 'setGoal', goal: 'x'.repeat(100) }),
    ERRORS.LIMIT,
  );
  assert.deepEqual(board.plan, before);
  const short = transition(board, COORD, { type: 'setGoal', goal: 'ship' });
  assert.equal(short.result.ok, true);
  assert.equal(short.state.plan.goal.title, 'ship');
});

test('channel control replay matches the live channel map', () => {
  let board = addWorker(seedBoard()).state;
  board = transition(board, COORD, {
    type: 'channel',
    op: 'create',
    channel: 'ops',
    topic: 'operations',
  }).state;
  board = transition(board, COORD, {
    type: 'channel',
    op: 'subscribe',
    channel: 'ops',
    members: [WORKER],
  }).state;
  board = transition(board, COORD, {
    type: 'channel',
    op: 'unsubscribe',
    channel: 'ops',
    members: [COORD],
  }).state;
  const archived = transition(board, COORD, { type: 'channel', op: 'archive', channel: 'ops' });
  assert.equal(archived.result.ok, true);

  const replayed = replayChannels(archived.state.posts, archived.state.seq);
  assert.deepEqual(replayed.ops, archived.state.channels.ops);
  assert.equal(replayed.ops.archivedAtSeq, archived.state.channels.ops.archivedAtSeq);
  assert.deepEqual(archived.state.channels.ops.subscribers, [WORKER]);
});

test('historical targets are frozen when the post is written', () => {
  let board = addWorker(seedBoard()).state;
  board = transition(board, COORD, { type: 'channel', op: 'create', channel: 'ops' }).state;
  board = transition(board, COORD, {
    type: 'channel',
    op: 'subscribe',
    channel: 'ops',
    members: [WORKER],
  }).state;
  board = addWorker(board, 'session-worker-2', 'worker-2').state;
  const posted = transition(board, COORD, { type: 'post', text: 'ping @#ops', channel: 'ops' });
  assert.equal(posted.result.ok, true);
  assert.deepEqual(posted.result.message.targets, ['worker-1']);

  const later = transition(posted.state, COORD, {
    type: 'channel',
    op: 'subscribe',
    channel: 'ops',
    members: ['session-worker-2'],
  }).state;
  assert.deepEqual(later.posts.find((post) => post.text === 'ping @#ops').targets, ['worker-1']);
  assert.deepEqual(
    boardView(later).posts.find((post) => post.text === 'ping @#ops').targets,
    ['worker-1'],
  );
});

test('state and views are strict JSON', () => {
  let board = addWorker(seedBoard()).state;
  board = addWorker(board, 'session-worker-2', 'worker-2').state;
  const created = transition(board, COORD, {
    type: 'channel',
    op: 'create',
    channel: 'ops',
  });
  board = transition(created.state, COORD, {
    type: 'channel',
    op: 'subscribe',
    channel: 'ops',
    members: [WORKER],
  }).state;
  board = transition(board, COORD, { type: 'post', text: '@all hello', channel: 'ops' }).state;
  board = transition(board, WORKER, { type: 'read' }).state;
  board = park(board, WORKER).state;

  assertJson(board);
  const view = boardView(board, { postLimit: 10, memberLimit: 10, textLimit: 100 });
  assertJson(view);
  const status = transition(board, COORD, { type: 'status' });
  assertJson(status.result);
  const reserved = transition(board, COORD, {
    type: 'reserveJoin',
    member: { sessionId: 'session-worker-3', name: 'worker-3' },
  });
  assertJson(reserved.state);
  assertJson(reserved.result);
});

function assertJson(value) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}

test('the session switch is coordinator-only, boolean, durable and defaults legacy boards on', () => {
  const board = seedBoard();
  assert.equal(board.enabled, true);
  const withWorker = addWorker(board).state;
  assertFailure(transition(withWorker, WORKER, { type: 'setEnabled', enabled: false }), ERRORS.FORBIDDEN);
  assertFailure(transition(board, COORD, { type: 'setEnabled', enabled: 'no' }), ERRORS.INVALID_ARGUMENT);
  const off = transition(board, COORD, { type: 'setEnabled', enabled: false });
  assert.equal(off.result.ok, true);
  assert.deepEqual(off.result, { ok: true, enabled: false });
  assert.equal(off.state.enabled, false);
  assert.equal(board.enabled, true, 'transition stays pure');
  const on = transition(off.state, COORD, { type: 'setEnabled', enabled: true });
  assert.equal(on.state.enabled, true);
  const legacy = structuredClone(board);
  delete legacy.enabled;
  const touched = transition(legacy, COORD, { type: 'setEnabled', enabled: false });
  assert.equal(touched.state.enabled, false);
  assert.equal(newBoard(ROOT, 'Swarm', { coordinator: COORD, now: T0, enabled: false }).enabled, false);
});

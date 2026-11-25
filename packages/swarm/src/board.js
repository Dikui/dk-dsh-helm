// Pure Swarm board state machine.
//
// Public contract (locked with swarm-host):
//   newBoard(rootId, title?, { coordinator?, now?, limits? })
//   transition(board, actorSessionId, action) -> { state, result, wakes }
//
// `transition` never mutates `board`: it clones, applies one action, and
// returns a new state. Policy failures return { ok:false, code, message }
// without changing state. Malformed boards/actions throw TypeError.
//
// Security invariants:
//   * non-members cannot read or write (bootstrap/commitJoin excepted)
//   * killed members are closed; paused members keep membership but cannot
//     post or wait
//   * object-prototype keys (__proto__, prototype, constructor) are rejected
//     for every name/session/channel used as a map key

import {
  MAIN_CHANNEL,
  DANGEROUS_KEYS,
  isSafeKey,
  isValidMemberName,
  isValidChannelName,
  canSeeChannel,
  emptyChannels,
  isChannelActive,
  parseMentions,
  resolveMentions,
} from './channels.js';
import { assignDelivery, submitDelivery, reviewDelivery, visibleDeliveries } from './deliveries.js';

import { configureBoardClock, ackBoardAlert } from './board-clock.js';
import { externalRequest } from './external-requests.js';

export const VERSION = 1;

export const ERRORS = Object.freeze({
  NOT_MEMBER: 'NOT_MEMBER',
  CLOSED: 'CLOSED',
  PAUSED: 'PAUSED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_ARGUMENT: 'INVALID_ARGUMENT',
  INVALID_NAME: 'INVALID_NAME',
  INVALID_SESSION: 'INVALID_SESSION',
  DUPLICATE_NAME: 'DUPLICATE_NAME',
  DUPLICATE_SESSION: 'DUPLICATE_SESSION',
  ALREADY_RESERVED: 'ALREADY_RESERVED',
  NOT_FOUND: 'NOT_FOUND',
  DUPLICATE_CHANNEL: 'DUPLICATE_CHANNEL',
  UNKNOWN_CHANNEL: 'UNKNOWN_CHANNEL',
  CHANNEL_ARCHIVED: 'CHANNEL_ARCHIVED',
  NOT_SUBSCRIBED: 'NOT_SUBSCRIBED',
  EMPTY: 'EMPTY',
  UNREAD: 'UNREAD',
  RATE_LIMITED: 'RATE_LIMITED',
  POST_TOO_LARGE: 'POST_TOO_LARGE',
  BOARD_FULL: 'BOARD_FULL',
  LIMIT: 'LIMIT',
  BUSY: 'BUSY',
  INVALID_STATE: 'INVALID_STATE',
});

export const DEFAULT_LIMITS = Object.freeze({
  maxMembers: 64,
  maxPosts: 2000,
  maxPostBytes: 8192,
  maxBoardBytes: 4 * 1024 * 1024,
  maxChannels: 64,
  ratePosts: 10,
  rateWindowMs: 30_000,
  maxWakeAttempts: 3,
  maxPlanBytes: 65_536,
  maxPendingWakes: 512,
});

// Pages are cut by the final JSON that a model sees, not by the raw post bytes:
// escaping can nearly double a post, and the envelope adds metadata. A single
// legal post is always returned whole, even when it alone exceeds this budget.
export const READ_RENDER_LIMIT = 9000;

const ROLES = new Set(['coordinator', 'worker', 'monitor']);
const STATUSES = new Set(['active', 'working', 'waiting', 'stopped', 'paused', 'killed']);
const WAKE_MODES = new Set(['mentions', 'anything']);
const MAX_TITLE = 120;
const encoder = new TextEncoder();

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isValidSessionId(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 200 &&
    !DANGEROUS_KEYS.has(value) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function byteLength(text) {
  return encoder.encode(text).length;
}

function clone(value) {
  return structuredClone(value);
}

function hasOwn(object, key) {
  return isSafeKey(key) && Object.hasOwn(object, key);
}

function memberBySession(board, sessionId) {
  if (!isValidSessionId(sessionId) || !hasOwn(board.members, sessionId)) return null;
  return board.members[sessionId] ?? null;
}

function memberByName(board, name) {
  if (typeof name !== 'string') return null;
  const wanted = name.toLowerCase();
  for (const id of Object.keys(board.members)) {
    if (board.members[id].name.toLowerCase() === wanted) return board.members[id];
  }
  return null;
}

export { memberBySession, memberByName };

export function boardHead(board) {
  return typeof board?.seq === 'number' ? board.seq : 0;
}

function fail(code, message) {
  return { ok: false, code, message: message ?? code };
}

function sanitizeLimits(raw) {
  const limits = { ...DEFAULT_LIMITS };
  if (!raw || typeof raw !== 'object') return limits;
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const value = raw[key];
    if (Number.isFinite(value) && value >= 0) {
      limits[key] = Math.floor(value);
    }
  }
  for (const key of ['maxMembers', 'maxPosts', 'maxPostBytes', 'maxBoardBytes', 'maxChannels', 'maxPlanBytes', 'maxPendingWakes']) {
    if (limits[key] < 1) limits[key] = 1;
  }
  if (limits.maxWakeAttempts < 1) limits.maxWakeAttempts = 1;
  return limits;
}

function timeOf(now) {
  return new Date(now).toISOString();
}

function validNow(value) {
  return Number.isInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

function resolveNow(action, board) {
  if (action.now === undefined || action.now === null) {
    return validNow(board.clock) ? board.clock : 0;
  }
  if (!validNow(action.now)) return null;
  return action.now;
}

function emptyPlan() {
  return { goal: { title: '', line: '' }, tasks: {}, threads: [] };
}

function normalizeChannels(values, draft) {
  if (values === undefined) return { channels: [MAIN_CHANNEL], error: null };
  if (!Array.isArray(values)) {
    return { channels: null, error: fail(ERRORS.INVALID_ARGUMENT, 'channels must be an array') };
  }
  const seen = new Set();
  for (const value of values) {
    if (!isValidChannelName(value) && value !== MAIN_CHANNEL) {
      return { channels: null, error: fail(ERRORS.INVALID_NAME, `invalid channel ${String(value)}`) };
    }
    if (!hasOwn(draft.channels, value)) {
      return { channels: null, error: fail(ERRORS.UNKNOWN_CHANNEL, `unknown channel ${value}`) };
    }
    if (value !== MAIN_CHANNEL && !isChannelActive(draft.channels, value, draft.seq)) {
      return { channels: null, error: fail(ERRORS.CHANNEL_ARCHIVED, `archived channel ${value}`) };
    }
    seen.add(value);
  }
  seen.add(MAIN_CHANNEL);
  return { channels: [...seen], error: null };
}

function normalizeModelRoute(route) {
  if (route === undefined || route === null) return { route: null, error: null };
  if (!isPlainObject(route)) {
    return { route: null, error: fail(ERRORS.INVALID_ARGUMENT, 'modelRoute must be an object') };
  }
  const provider = route.provider;
  const model = route.model;
  if (typeof provider !== 'string' || provider.length === 0 || provider.length > 120) {
    return { route: null, error: fail(ERRORS.INVALID_ARGUMENT, 'modelRoute.provider is invalid') };
  }
  if (typeof model !== 'string' || model.length === 0 || model.length > 200) {
    return { route: null, error: fail(ERRORS.INVALID_ARGUMENT, 'modelRoute.model is invalid') };
  }
  return { route: { provider, model }, error: null };
}

function normalizeWorkspace(spec) {
  const mode = spec.workspaceMode ?? 'inherit';
  if (!['inherit', 'share', 'branch'].includes(mode)) {
    return { value: null, error: fail(ERRORS.INVALID_ARGUMENT, 'invalid workspaceMode') };
  }
  const value = {
    workspaceMode: mode,
    worktreeId: typeof spec.worktreeId === 'string' ? spec.worktreeId : null,
    worktreePath: typeof spec.worktreePath === 'string' ? spec.worktreePath : null,
  };
  return { value, error: null };
}

function memberView(board, member) {
  const unread = unreadFor(board, member);
  return {
    sessionId: member.sessionId,
    name: member.name,
    role: member.role,
    addedBy: member.addedBy,
    status: member.status,
    channels: member.channels.slice(),
    wakeMode: member.wakeMode,
    lastReadSeq: member.lastReadSeq,
    waitSince: member.waitSince,
    pausedFromStatus: member.pausedFromStatus,
    lastNudgedSeq: member.lastNudgedSeq,
    lastParkBlockedSeq: member.lastParkBlockedSeq,
    quotaPausedAtSeq: member.quotaPausedAtSeq,
    joinedAtSeq: member.joinedAtSeq,
    updatedAtSeq: member.updatedAtSeq,
    modelRoute: member.modelRoute ? { ...member.modelRoute } : null,
    fallbackRoute: member.fallbackRoute ? { ...member.fallbackRoute } : null,
    workspaceMode: member.workspaceMode,
    worktreeId: member.worktreeId,
    worktreePath: member.worktreePath,
    viewAll: member.viewAll,
    unread: unread.total,
    unreadMentions: unread.mentions,
  };
}

function messageView(post) {
  return {
    seq: post.seq,
    sessionId: post.sessionId,
    name: post.name,
    text: post.text,
    channel: post.channel,
    kind: post.kind,
    at: post.at,
    time: post.time,
    mentions: post.mentions ? clone(post.mentions) : parseMentions(post.text),
    targets: Array.isArray(post.targets) ? post.targets.slice() : [],
    mentionChannels: Array.isArray(post.mentionChannels) ? post.mentionChannels.slice() : [],
    ...(post.control ? { control: clone(post.control) } : {}),
  };
}

function channelView(board, channel, member) {
  const active = channel.name === MAIN_CHANNEL || isChannelActive(board.channels, channel.name, board.seq);
  return {
    name: channel.name,
    topic: channel.topic ?? '',
    createdAtSeq: channel.createdAtSeq,
    archivedAtSeq: channel.archivedAtSeq ?? null,
    active,
    subscribers: Array.isArray(channel.subscribers) ? channel.subscribers.slice() : [],
    subscribed: member ? member.channels.includes(channel.name) : false,
  };
}

function visiblePostList(board, member, { since = 0, limit = Infinity, seqs, channel } = {}) {
  if (!member || member.status === 'killed') return [];
  const wanted = Array.isArray(seqs) ? new Set(seqs.filter(Number.isInteger)) : null;
  const posts = [];
  for (const post of board.posts) {
    if (post.kind === 'control') continue;
    if (post.seq <= since) continue;
    if (wanted && !wanted.has(post.seq)) continue;
    if (channel && post.channel !== channel) continue;
    if (!canSeeChannel(member, post.channel)) continue;
    posts.push(post);
  }
  posts.sort((a, b) => a.seq - b.seq);
  if (Number.isFinite(limit) && limit >= 0) return posts.slice(0, limit);
  return posts;
}

export function visiblePosts(board, memberOrSessionId, options = {}) {
  const member =
    typeof memberOrSessionId === 'string'
      ? memberBySession(board, memberOrSessionId)
      : memberOrSessionId;
  return visiblePostList(board, member, options).map(messageView);
}

function unreadFor(board, member) {
  if (!member) return { total: 0, mentions: 0 };
  const posts = visiblePostList(board, member, { since: member.lastReadSeq });
  let mentions = 0;
  for (const post of posts) {
    if (postTargets(board, post).sessionIds.includes(member.sessionId)) mentions += 1;
  }
  return { total: posts.length, mentions };
}

function postTargets(board, post) {
  if (Array.isArray(post.targets)) {
    // Targets are resolved and frozen when the post is appended. Re-deriving
    // them from today's roster/channel membership would make history drift
    // (a later subscriber must not become a target of an old @#channel post).
    const ids = [];
    const names = [];
    const seen = new Set();
    for (const name of post.targets) {
      const member = memberByName(board, name);
      if (!member || member.status === 'killed' || member.sessionId === post.sessionId) continue;
      if (seen.has(member.sessionId)) continue;
      seen.add(member.sessionId);
      ids.push(member.sessionId);
      names.push(member.name);
    }
    return {
      names,
      sessionIds: ids,
      channels: Array.isArray(post.mentionChannels) ? post.mentionChannels.slice() : [],
    };
  }
  const parsed = post.mentions ?? parseMentions(post.text);
  const resolution = resolveMentions(parsed, {
    members: board.members,
    channels: board.channels,
    atSeq: post.seq,
  });
  const ids = [];
  const names = [];
  const seen = new Set();
  for (const id of resolution.sessionIds) {
    if (id === post.sessionId) continue;
    const member = memberBySession(board, id);
    if (!member || member.status === 'killed' || id === post.sessionId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    names.push(member.name);
  }
  const channels = [];
  for (const hit of resolution.hits) {
    if (hit.kind === 'channel' && hit.active && !channels.includes(hit.name)) {
      channels.push(hit.name);
    }
  }
  return { names, sessionIds: ids, channels };
}

export function resolveTargets(board, post) {
  return postTargets(board, post);
}

function makePending(draft, member, seq, reason, now, force = false) {
  if (!member || member.status === 'killed' || member.externalMailbox) return false;
  if (!force && seq <= member.lastReadSeq) return false;
  let pending = draft.pendingWakes.find((item) => item.sessionId === member.sessionId);
  if (pending) {
    if (pending.seq >= seq) return false;
    pending.seq = seq;
    pending.reason = reason;
    pending.attempts = 0;
    pending.at = now;
    return true;
  }
  if (draft.pendingWakes.length >= draft.limits.maxPendingWakes) return false;
  draft.pendingWakes.push({
    sessionId: member.sessionId,
    seq,
    reason,
    attempts: 0,
    at: now,
    status: 'pending',
  });
  return true;
}

function wakeFor(member, seq) {
  return { sessionId: member.sessionId, seq };
}

function newestPostFor(board, member, options = {}) {
  const posts = visiblePostList(board, member, { since: member.lastReadSeq });
  let latest = null;
  for (const post of posts) {
    if (options.mentionsOnly) {
      if (!postTargets(board, post).sessionIds.includes(member.sessionId)) continue;
    }
    latest = post;
  }
  return latest;
}

function canManage(actor, target) {
  if (actor.sessionId === target.sessionId) return true;
  if (actor.role === 'coordinator') return true;
  return target.addedBy === actor.sessionId;
}

function createMember(draft, spec, addedBy, now) {
  const member = {
    sessionId: spec.sessionId,
    name: spec.name,
    role: spec.role,
    addedBy,
    status: 'active',
    channels: spec.channels.slice(),
    wakeMode: spec.wakeMode,
    lastReadSeq: Math.min(draft.seq, Math.max(0, spec.lastReadSeq ?? draft.seq)),
    waitSince: 0,
    pausedFromStatus: null,
    lastNudgedSeq: 0,
    lastParkBlockedSeq: 0,
    quotaPausedAtSeq: null,
    joinedAtSeq: draft.seq,
    updatedAtSeq: now,
    modelRoute: spec.modelRoute ?? null,
    fallbackRoute: spec.fallbackRoute ?? null,
    workspaceMode: spec.workspaceMode ?? 'inherit',
    worktreeId: spec.worktreeId ?? null,
    worktreePath: spec.worktreePath ?? null,
    viewAll: spec.role === 'coordinator' || spec.role === 'monitor',
  };
  draft.members[member.sessionId] = member;
  for (const channel of member.channels) {
    const entry = draft.channels[channel];
    if (entry && !entry.subscribers.includes(member.sessionId)) {
      entry.subscribers.push(member.sessionId);
    }
  }
  return member;
}

function readSpec(actor, draft, raw, { reserve = false } = {}) {
  if (!isPlainObject(raw)) {
    return { error: fail(ERRORS.INVALID_ARGUMENT, 'member must be an object') };
  }
  if (!isValidSessionId(raw.sessionId)) {
    return { error: fail(ERRORS.INVALID_SESSION, 'invalid member sessionId') };
  }
  if (!isValidMemberName(raw.name)) {
    return { error: fail(ERRORS.INVALID_NAME, 'invalid member name') };
  }
  const role = raw.role ?? 'worker';
  if (!ROLES.has(role)) {
    return { error: fail(ERRORS.INVALID_ARGUMENT, 'invalid member role') };
  }
  if (actor.role === 'coordinator') {
    if (role === 'coordinator') {
      return { error: fail(ERRORS.FORBIDDEN, 'board already has a coordinator') };
    }
  } else if (actor.role === 'worker') {
    if (role !== 'worker') {
      return { error: fail(ERRORS.FORBIDDEN, 'workers may only add workers') };
    }
  } else {
    return { error: fail(ERRORS.FORBIDDEN, 'monitors cannot add members') };
  }
  const wakeMode = raw.wakeMode ?? 'mentions';
  if (!WAKE_MODES.has(wakeMode)) {
    return { error: fail(ERRORS.INVALID_ARGUMENT, 'invalid wakeMode') };
  }
  const channelResult = normalizeChannels(raw.channels, draft);
  if (channelResult.error) return { error: channelResult.error };
  if (actor.role !== 'coordinator') {
    for (const channel of channelResult.channels) {
      if (!actor.channels.includes(channel)) {
        return { error: fail(ERRORS.FORBIDDEN, `worker cannot grant channel ${channel}`) };
      }
    }
  }
  const model = normalizeModelRoute(raw.modelRoute);
  if (model.error) return { error: model.error };
  const fallback = normalizeModelRoute(raw.fallbackRoute);
  if (fallback.error) return { error: fallback.error };
  const workspace = normalizeWorkspace(raw);
  if (workspace.error) return { error: workspace.error };
  const lastReadSeq =
    raw.lastReadSeq === undefined || raw.lastReadSeq === null ? null : Number(raw.lastReadSeq);
  if (lastReadSeq !== null && (!Number.isInteger(lastReadSeq) || lastReadSeq < 0)) {
    return { error: fail(ERRORS.INVALID_ARGUMENT, 'lastReadSeq must be a non-negative integer') };
  }
  return {
    value: {
      sessionId: raw.sessionId,
      name: raw.name,
      role,
      wakeMode,
      channels: channelResult.channels,
      modelRoute: model.route,
      fallbackRoute: fallback.route,
      ...workspace.value,
      lastReadSeq,
      reserved: reserve,
    },
    error: null,
  };
}

function nameTaken(draft, name, ignoreReservationId = null) {
  const wanted = name.toLowerCase();
  for (const id of Object.keys(draft.members)) {
    if (draft.members[id].name.toLowerCase() === wanted) return true;
  }
  for (const id of Object.keys(draft.reservations)) {
    if (id === ignoreReservationId) continue;
    if (draft.reservations[id].name.toLowerCase() === wanted) return true;
  }
  return false;
}

function sessionReserved(draft, sessionId) {
  for (const id of Object.keys(draft.reservations)) {
    if (draft.reservations[id].sessionId === sessionId) return id;
  }
  return null;
}

function memberCount(draft) {
  return Object.keys(draft.members).length + Object.keys(draft.reservations).length;
}

function ok(result, wakes = []) {
  return { result: { ok: true, ...result }, wakes };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function actionBootstrap(draft, actor, action, now) {
  if (Object.keys(draft.members).length > 0 || Object.keys(draft.reservations).length > 0) {
    return fail(ERRORS.FORBIDDEN, 'board already has members');
  }
  if (!isValidSessionId(actor)) return fail(ERRORS.INVALID_SESSION, 'invalid sessionId');
  const name = action.name ?? 'coordinator';
  if (!isValidMemberName(name)) return fail(ERRORS.INVALID_NAME, 'invalid coordinator name');
  const member = createMember(
    draft,
    {
      sessionId: actor,
      name,
      role: 'coordinator',
      channels: [MAIN_CHANNEL],
      wakeMode: 'mentions',
      lastReadSeq: 0,
    },
    null,
    now,
  );
  return ok({ member: memberView(draft, member) });
}

// Validate using the same policy as manual assignment, without publishing a
// delivery or granting the reserved identity any board access.
function prepareAssignment(draft, actor, action, owner) {
  const deliveries = [...draft.deliveries];
  for (const reservation of Object.values(draft.reservations)) {
    if (reservation.contract) deliveries.push(reservation.contract); // claims its ID and one slot
  }
  return assignDelivery({ clock: draft.clock, deliveries }, actor, action, owner);
}

function assignAvailableDelivery(draft, actor, action, owner) {
  const prepared = prepareAssignment(draft, actor, action, owner);
  if (prepared.result?.ok) draft.deliveries.push(clone(prepared.result.delivery));
  return prepared;
}

function addMember(draft, actor, action, now, { reserve = false } = {}) {
  const specResult = readSpec(actor, draft, action.member, { reserve });
  if (specResult.error) return specResult.error;
  const spec = specResult.value;
  if (hasOwn(draft.members, spec.sessionId)) {
    return fail(ERRORS.DUPLICATE_SESSION, 'session is already a member');
  }
  if (sessionReserved(draft, spec.sessionId)) {
    return fail(ERRORS.ALREADY_RESERVED, 'session already has a reservation');
  }
  if (nameTaken(draft, spec.name)) {
    return fail(ERRORS.DUPLICATE_NAME, 'member name is taken');
  }
  if (memberCount(draft) >= draft.limits.maxMembers) {
    return fail(ERRORS.LIMIT, `member limit ${draft.limits.maxMembers} reached`);
  }
  let contract;
  if (action.contract !== undefined) {
    if (!reserve || !isPlainObject(action.contract)) return fail(ERRORS.INVALID_ARGUMENT, 'a native add contract must be a reservation object');
    const prepared = prepareAssignment(draft, actor, action.contract, spec);
    if (!prepared.result?.ok) return prepared;
    const { taskId, deliverable, criterion } = prepared.result.delivery;
    contract = { taskId, deliverable, criterion };
  }
  if (reserve) {
    draft.counters.reservation += 1;
    let id = `res-${draft.counters.reservation}`;
    while (hasOwn(draft.reservations, id)) {
      draft.counters.reservation += 1;
      id = `res-${draft.counters.reservation}`;
    }
    const reservation = {
      id,
      ...spec,
      ...(contract ? { contract } : {}),
      reservedBy: actor.sessionId,
      reservedAtSeq: draft.seq,
      at: now,
    };
    delete reservation.reserved;
    draft.reservations[id] = reservation;
    return ok({
      reservationId: id,
      reservation: {
        id,
        sessionId: reservation.sessionId,
        name: reservation.name,
        role: reservation.role,
        channels: reservation.channels.slice(),
        reservedBy: reservation.reservedBy,
        reservedAtSeq: reservation.reservedAtSeq,
        ...(contract ? { contract: { ...contract } } : {}),
      },
      member: {
        sessionId: spec.sessionId,
        name: spec.name,
        role: spec.role,
        channels: spec.channels.slice(),
      },
    });
  }
  const member = createMember(draft, spec, actor.sessionId, now);
  return ok({ member: memberView(draft, member) });
}

function commitJoin(draft, actor, action, now) {
  const id = action.reservationId;
  if (typeof id !== 'string' || !hasOwn(draft.reservations, id)) {
    return fail(ERRORS.NOT_FOUND, 'reservation not found');
  }
  const reservation = draft.reservations[id];
  if (actor.sessionId !== reservation.sessionId && actor.role !== 'coordinator') {
    return fail(ERRORS.FORBIDDEN, 'only the reserved session or coordinator may commit');
  }
  if (reservation.contract && actor.role !== 'coordinator') {
    return fail(ERRORS.FORBIDDEN, 'only the coordinator may commit a contracted join');
  }
  if (hasOwn(draft.members, reservation.sessionId)) {
    return fail(ERRORS.DUPLICATE_SESSION, 'session is already a member');
  }
  if (memberCount(draft) - 1 >= draft.limits.maxMembers) {
    return fail(ERRORS.LIMIT, `member limit ${draft.limits.maxMembers} reached`);
  }
  if (nameTaken(draft, reservation.name, id)) {
    return fail(ERRORS.DUPLICATE_NAME, 'member name was taken after reservation');
  }
  const channelResult = normalizeChannels(reservation.channels, draft);
  if (channelResult.error) return channelResult.error;
  const checkout = action.worktree;
  if (checkout != null && (actor.role !== 'coordinator' || reservation.workspaceMode !== 'branch' ||
      checkout.rootSessionId !== draft.rootId || checkout.memberSessionId !== reservation.sessionId ||
      checkout.member !== reservation.name || !checkout.id || !checkout.path || checkout.status !== 'prepared')) {
    return fail(ERRORS.FORBIDDEN, 'only the coordinator may attach the reserved checkout');
  }
  delete draft.reservations[id];
  const member = createMember(
    draft,
    { ...reservation, channels: channelResult.channels },
    reservation.reservedBy,
    now,
  );
  if (checkout != null) {
    member.worktree = { ...checkout };
    member.worktreeId = checkout.id;
    member.worktreePath = checkout.path;
  }
  if (reservation.contract) {
    const assigned = assignAvailableDelivery(draft, actor, reservation.contract, member);
    if (!assigned.result?.ok) return assigned; // transition discards the whole draft
    return ok({ member: memberView(draft, member), delivery: assigned.result.delivery });
  }
  return ok({ member: memberView(draft, member) });
}

function failJoin(draft, actor, action) {
  const id = action.reservationId;
  if (typeof id !== 'string' || !hasOwn(draft.reservations, id)) {
    return fail(ERRORS.NOT_FOUND, 'reservation not found');
  }
  const reservation = draft.reservations[id];
  if (actor.sessionId !== reservation.sessionId && actor.role !== 'coordinator') {
    return fail(ERRORS.FORBIDDEN, 'only the reserved session or coordinator may fail a join');
  }
  if (reservation.contract && actor.role !== 'coordinator') {
    return fail(ERRORS.FORBIDDEN, 'only the coordinator may revoke a contracted join');
  }
  delete draft.reservations[id];
  return ok({ reservationId: id, failed: true, reason: action.reason ?? null });
}

function setTitle(draft, actor, action) {
  if (actor.role !== 'coordinator') return fail(ERRORS.FORBIDDEN, 'coordinator only');
  if (typeof action.title !== 'string') return fail(ERRORS.INVALID_ARGUMENT, 'title must be a string');
  const title = action.title.trim();
  if (title.length === 0) return fail(ERRORS.INVALID_ARGUMENT, 'title is empty');
  if (title.length > MAX_TITLE) return fail(ERRORS.INVALID_ARGUMENT, `title exceeds ${MAX_TITLE}`);
  draft.title = title;
  return ok({ title });
}

function isJsonSafe(value, seen = new Set(), depth = 0) {
  if (depth > 64) return false;
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return true;
  if (type === 'number') return Number.isFinite(value);
  if (type !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let safe = true;
  if (Array.isArray(value)) {
    safe = value.every((item) => isJsonSafe(item, seen, depth + 1));
  } else if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key) || !isJsonSafe(value[key], seen, depth + 1)) {
        safe = false;
        break;
      }
    }
  } else {
    safe = false;
  }
  seen.delete(value);
  return safe;
}

function validatePlan(plan) {
  if (!isPlainObject(plan)) return fail(ERRORS.INVALID_ARGUMENT, 'plan must be an object');
  if (!isJsonSafe(plan)) {
    return fail(ERRORS.INVALID_ARGUMENT, 'plan must contain only JSON values');
  }
  try {
    const text = JSON.stringify(plan);
    if (typeof text !== 'string') return fail(ERRORS.INVALID_ARGUMENT, 'plan is not serializable');
  } catch {
    return fail(ERRORS.INVALID_ARGUMENT, 'plan is not serializable');
  }
  return null;
}

function setPlan(draft, actor, action) {
  if (actor.role !== 'coordinator') return fail(ERRORS.FORBIDDEN, 'coordinator only');
  const invalid = validatePlan(action.plan);
  if (invalid) return invalid;
  const text = JSON.stringify(action.plan);
  if (byteLength(text) > draft.limits.maxPlanBytes) {
    return fail(ERRORS.LIMIT, `plan exceeds ${draft.limits.maxPlanBytes} bytes`);
  }
  draft.plan = clone(action.plan);
  return ok({ plan: clone(draft.plan) });
}

function setGoal(draft, actor, action) {
  if (actor.role !== 'coordinator') return fail(ERRORS.FORBIDDEN, 'coordinator only');
  let goal;
  if (typeof action.goal === 'string') {
    goal = { title: action.goal, line: '' };
  } else if (isPlainObject(action.goal)) {
    goal = {
      title: typeof action.goal.title === 'string' ? action.goal.title : '',
      line: typeof action.goal.line === 'string' ? action.goal.line : '',
    };
  } else {
    return fail(ERRORS.INVALID_ARGUMENT, 'goal must be a string or {title,line}');
  }
  if (goal.title.length > 500 || goal.line.length > 2000) {
    return fail(ERRORS.INVALID_ARGUMENT, 'goal is too long');
  }
  draft.plan.goal = goal;
  const text = JSON.stringify(draft.plan);
  if (byteLength(text) > draft.limits.maxPlanBytes) {
    return fail(ERRORS.LIMIT, `plan exceeds ${draft.limits.maxPlanBytes} bytes`);
  }
  return ok({ plan: clone(draft.plan) });
}

function setStatus(draft, actor, action, now) {
  const target = action.target === undefined ? actor : memberBySession(draft, action.target);
  if (!target) return fail(ERRORS.NOT_FOUND, 'target member not found');
  if (!canManage(actor, target)) return fail(ERRORS.FORBIDDEN, 'cannot manage this member');
  if (target.status === 'killed') return fail(ERRORS.CLOSED, 'member is killed');
  if (target.status === 'paused') return fail(ERRORS.PAUSED, 'resume the member first');
  const status = action.status;
  if (!['active', 'working', 'waiting', 'stopped'].includes(status)) {
    return fail(ERRORS.INVALID_ARGUMENT, 'invalid status');
  }
  let since = action.since ?? draft.seq;
  if (!Number.isInteger(since) || since < 0 || since > draft.seq) {
    return fail(ERRORS.INVALID_ARGUMENT, 'invalid since');
  }
  target.status = status;
  target.updatedAtSeq = now;
  if (status === 'waiting') {
    target.waitSince = since;
  } else {
    target.waitSince = 0;
  }
  target.pausedFromStatus = null;
  return ok({ member: memberView(draft, target) });}

function setModel(draft, actor, action, now) {
  const target = action.target === undefined ? actor : memberBySession(draft, action.target);
  if (!target) return fail(ERRORS.NOT_FOUND, 'target member not found');
  if (!canManage(actor, target)) return fail(ERRORS.FORBIDDEN, 'cannot manage this member');
  if (target.status === 'killed') return fail(ERRORS.CLOSED, 'member is killed');
  if (action.confirmedSwitch && actor.role !== 'coordinator') return fail(ERRORS.FORBIDDEN, 'coordinator only');
  if (target.status === 'working' && !action.confirmedSwitch) return fail(ERRORS.BUSY, 'member is working');
  const model = normalizeModelRoute(action.modelRoute ?? action.model);
  if (model.error) return model.error;
  if (!model.route) return fail(ERRORS.INVALID_ARGUMENT, 'modelRoute is required');
  target.modelRoute = model.route;
  target.updatedAtSeq = now;
  if (action.confirmedSwitch) return ok({ member: memberView(draft, target) });
  const wakes = [];
  if (target.status === 'waiting' || target.status === 'stopped') {
    if (makePending(draft, target, draft.seq, 'model', now, true)) {
      wakes.push(wakeFor(target, draft.seq));
    }
  }
  return ok({ member: memberView(draft, target) }, wakes);
}

// A fallback is a one-shot grant, not a new agent or a generic model override.
// Claim it durably before touching a live session: a crash must not loop back.
function consumeFallback(draft, actor, action, now) {
  if (actor.role !== 'coordinator') return fail(ERRORS.FORBIDDEN, 'coordinator only');
  const member = memberBySession(draft, action.target);
  if (!member || member.role === 'coordinator') return fail(ERRORS.NOT_FOUND, 'worker not found');
  if (member.status === 'paused') return fail(ERRORS.PAUSED, 'member is paused');
  if (member.status === 'killed') return fail(ERRORS.CLOSED, 'member is killed');
  if (!member.fallbackRoute) return fail('NO_FALLBACK', 'no fallback available');
  if (action.expect && (member.modelRoute?.provider !== action.expect.provider || member.modelRoute?.model !== action.expect.model)) {
    return fail('STALE_ROUTE', 'model route changed');
  }
  const route = member.fallbackRoute;
  member.fallbackRoute = null;
  member.updatedAtSeq = now;
  return ok({ route, member: memberView(draft, member) });
}

function killMember(draft, actor, action, now) {
  const target = action.target === undefined ? actor : memberBySession(draft, action.target);
  if (!target) return fail(ERRORS.NOT_FOUND, 'target member not found');
  if (target.role === 'coordinator') return fail(ERRORS.FORBIDDEN, 'coordinator cannot be killed');
  if (!canManage(actor, target)) return fail(ERRORS.FORBIDDEN, 'cannot manage this member');
  target.status = 'killed';
  target.updatedAtSeq = now;
  draft.pendingWakes = draft.pendingWakes.filter((item) => item.sessionId !== target.sessionId);
  return ok({ member: memberView(draft, target) });
}

function pauseMember(draft, actor, action, now) {
  const target = action.target === undefined ? actor : memberBySession(draft, action.target);
  if (!target) return fail(ERRORS.NOT_FOUND, 'target member not found');
  if (target.role === 'coordinator') return fail(ERRORS.FORBIDDEN, 'coordinator cannot be paused');
  if (!canManage(actor, target)) return fail(ERRORS.FORBIDDEN, 'cannot manage this member');
  if (target.status === 'killed') return fail(ERRORS.CLOSED, 'member is killed');
  const previousStatus = target.status;
  target.status = 'paused';
  target.pausedFromStatus = previousStatus;
  target.quotaPausedAtSeq = draft.seq;
  target.updatedAtSeq = now;
  draft.pendingWakes = draft.pendingWakes.filter((item) => item.sessionId !== target.sessionId);
  return ok({ member: memberView(draft, target) });
}

function resumeMember(draft, actor, action, now) {
  const target = action.target === undefined ? actor : memberBySession(draft, action.target);
  if (!target) return fail(ERRORS.NOT_FOUND, 'target member not found');
  if (target.role === 'coordinator') return fail(ERRORS.FORBIDDEN, 'coordinator cannot be paused');
  if (!canManage(actor, target)) return fail(ERRORS.FORBIDDEN, 'cannot manage this member');
  if (target.status === 'killed') return fail(ERRORS.CLOSED, 'member is killed');
  if (target.status !== 'paused') return ok({ member: memberView(draft, target) });
  // Pause released the real activation, so only a prior waiting/stopped state is
  // still true. Anything else must come back as stopped (wakeable on a mention),
  // never as active, or a later directed post has no running session to reach.
  target.status = target.pausedFromStatus === 'waiting' || target.pausedFromStatus === 'stopped'
    ? target.pausedFromStatus
    : 'stopped';
  if (target.externalMailbox) target.status = 'active';
  target.pausedFromStatus = null;
  target.quotaPausedAtSeq = null;
  target.updatedAtSeq = now;
  const wakes = [];
  const latest = newestPostFor(draft, target, { mentionsOnly: true });
  if (latest && makePending(draft, target, latest.seq, 'resume', now)) {
    wakes.push(wakeFor(target, latest.seq));
  }
  return ok({ member: memberView(draft, target) }, wakes);
}

function postMessage(draft, actor, action, now) {
  if (actor.status === 'paused') return fail(ERRORS.PAUSED, 'member is paused');
  const text = action.text;
  if (typeof text !== 'string') return fail(ERRORS.INVALID_ARGUMENT, 'text must be a string');
  if (text.trim().length === 0) return fail(ERRORS.INVALID_ARGUMENT, 'post text is empty');
  const bytes = byteLength(text);
  if (bytes > draft.limits.maxPostBytes) {
    return fail(ERRORS.POST_TOO_LARGE, `post exceeds ${draft.limits.maxPostBytes} bytes`);
  }
  const channel = action.channel ?? MAIN_CHANNEL;
  if (typeof channel !== 'string' || !hasOwn(draft.channels, channel)) {
    return fail(ERRORS.UNKNOWN_CHANNEL, `unknown channel ${channel}`);
  }
  if (channel !== MAIN_CHANNEL && !isChannelActive(draft.channels, channel, draft.seq + 1)) {
    return fail(ERRORS.CHANNEL_ARCHIVED, `channel ${channel} is archived`);
  }
  if (!canSeeChannel(actor, channel)) {
    return fail(ERRORS.NOT_SUBSCRIBED, `not subscribed to ${channel}`);
  }
  if (draft.posts.length >= draft.limits.maxPosts) {
    return fail(ERRORS.BOARD_FULL, `post limit ${draft.limits.maxPosts} reached`);
  }
  if (draft.stats.postBytes + bytes > draft.limits.maxBoardBytes) {
    return fail(ERRORS.BOARD_FULL, `board byte limit ${draft.limits.maxBoardBytes} reached`);
  }
  let recent = 0;
  for (let i = draft.posts.length - 1; i >= 0; i -= 1) {
    const post = draft.posts[i];
    if (post.kind === 'control') continue;
    if (post.at <= now - draft.limits.rateWindowMs) break;
    if (post.sessionId === actor.sessionId) recent += 1;
  }
  if (recent >= draft.limits.ratePosts) {
    return fail(ERRORS.RATE_LIMITED, `rate limit ${draft.limits.ratePosts}/${draft.limits.rateWindowMs}ms`);
  }

  const seq = draft.seq + 1;
  const parsed = parseMentions(text);
  const post = {
    seq,
    sessionId: actor.sessionId,
    name: actor.name,
    text,
    channel,
    kind: 'post',
    at: now,
    time: timeOf(now),
    mentions: parsed,
  };
  const targets = postTargets({ ...draft, posts: draft.posts }, { ...post, mentions: parsed });
  post.targets = targets.names;
  post.mentionChannels = targets.channels;
  draft.posts.push(post);
  draft.seq = seq;
  draft.stats.postBytes += bytes;
  draft.stats.postCount = draft.posts.length;

  const wakes = [];
  const mentionedIds = new Set(targets.sessionIds);
  const candidates = [];
  for (const id of targets.sessionIds) {
    const member = memberBySession(draft, id);
    if (member) candidates.push(member);
  }
  // `anything` mode is a live feed of the channels this member can see: it
  // wakes for every post in those channels, not only posts that mention it.
  for (const member of Object.values(draft.members)) {
    if (member.wakeMode === 'anything' && !mentionedIds.has(member.sessionId)) {
      candidates.push(member);
    }
  }
  const seen = new Set();
  for (const member of candidates) {
    if (seen.has(member.sessionId)) continue;
    seen.add(member.sessionId);
    if (member.sessionId === actor.sessionId) continue;
    if (member.status !== 'waiting' && member.status !== 'stopped') continue;
    if (member.waitSince > seq) continue;
    const mentioned = mentionedIds.has(member.sessionId);
    if (member.wakeMode === 'mentions' && !mentioned) continue;
    if (!canSeeChannel(member, channel)) continue;
    if (makePending(draft, member, seq, mentioned ? 'mention' : 'anything', now)) {
      wakes.push(wakeFor(member, seq));
    }
  }
  return ok({ seq, message: messageView(post) }, wakes);
}

function indentMessageBlock(message) {
  return JSON.stringify(message, null, 2)
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function readCursor(draft, member, readSeqs) {
  const bySeq = new Map();
  for (const post of draft.posts) bySeq.set(post.seq, post);
  let cursor = member.lastReadSeq;
  for (let seq = cursor + 1; seq <= draft.seq; seq += 1) {
    const post = bySeq.get(seq);
    if (!post || post.kind === 'control' || !canSeeChannel(member, post.channel)) {
      cursor = seq;
      continue;
    }
    if (!readSeqs.has(seq)) break;
    cursor = seq;
  }
  return cursor;
}

function recordRead(draft, actor, delivered, now) {
  const cursor = readCursor(draft, actor, delivered);
  actor.lastReadSeq = cursor;
  actor.updatedAtSeq = now;
  draft.pendingWakes = draft.pendingWakes.filter(
    (item) => item.sessionId !== actor.sessionId || (item.seq > cursor && !delivered.has(item.seq)),
  );
  return cursor;
}

function readBoard(draft, actor, action, now) {
  const peek = action.peek === true;
  // A preview selects the exact page for a tool result that has not reached the
  // model yet. It reports the cursor the page would produce without moving it;
  // the host commits that page only after the runtime confirms the delivery.
  const preview = !peek && action.preview === true;
  const sinceGiven = action.since === undefined ? null : action.since;
  if (sinceGiven !== null && (!Number.isInteger(sinceGiven) || sinceGiven < 0)) {
    return fail(ERRORS.INVALID_ARGUMENT, 'since must be a non-negative integer');
  }
  const since = Math.max(0, sinceGiven ?? actor.lastReadSeq);
  if (since > draft.seq) {
    return fail(ERRORS.INVALID_ARGUMENT, 'since is beyond board head');
  }
  if (action.channel !== undefined) {
    if (typeof action.channel !== 'string' || !hasOwn(draft.channels, action.channel)) {
      return fail(ERRORS.UNKNOWN_CHANNEL, `unknown channel ${String(action.channel)}`);
    }
  }
  const limit = action.limit === undefined ? 100 : Number(action.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return fail(ERRORS.INVALID_ARGUMENT, 'limit must be 1..200');
  }
  let seqs = null;
  if (action.seqs !== undefined) {
    if (!Array.isArray(action.seqs)) return fail(ERRORS.INVALID_ARGUMENT, 'seqs must be an array');
    const unique = [];
    const seen = new Set();
    for (const seq of action.seqs) {
      if (!Number.isInteger(seq) || seq < 1 || seq > draft.seq) {
        return fail(ERRORS.INVALID_ARGUMENT, 'seqs must contain positive integers at or below head');
      }
      if (!seen.has(seq)) {
        seen.add(seq);
        unique.push(seq);
      }
    }
    seqs = unique;
  }
  const candidates = visiblePostList(draft, actor, {
    since: seqs && sinceGiven === null ? 0 : since,
    seqs,
    channel: action.channel,
  });

  // Size each page by the exact JSON the model sees. The provisional envelope
  // uses the widest possible continuation metadata, so the selected page is a
  // safe upper bound without serializing the whole result for every post.
  const provisional = {
    messages: [],
    lastReadSeq: peek ? actor.lastReadSeq : draft.seq,
    headSeq: draft.seq,
    hasMore: true,
    peek,
    nextSince: draft.seq,
  };
  const fixedChars = JSON.stringify({ ok: true, ...provisional }, null, 2).length - 2;
  const page = [];
  let blockChars = 0;
  for (const post of candidates) {
    const message = messageView(post);
    blockChars += indentMessageBlock(message).length;
    const arrayChars = 6 + blockChars + 2 * page.length;
    // Even when its JSON escapes exceed the budget, a legal singleton must
    // remain retrievable in full. Never serialize the remaining backlog.
    if (page.length && fixedChars + arrayChars > READ_RENDER_LIMIT) break;
    page.push(message);
    if (page.length === limit) break;
  }
  const hasMore = page.length < candidates.length;
  const continuation = hasMore ? { nextSince: page.at(-1).seq } : {};
  const result = {
    messages: page,
    lastReadSeq: peek ? actor.lastReadSeq : undefined,
    headSeq: draft.seq,
    hasMore,
    peek,
    ...continuation,
  };
  if (peek) return ok(result);

  const delivered = new Set(page.map((message) => message.seq));
  result.lastReadSeq = preview ? readCursor(draft, actor, delivered) : recordRead(draft, actor, delivered, now);
  // The call itself proves the member is running. A later delivery receipt
  // updates only the cursor; it must not reactivate a since-paused/stopped turn.
  if (actor.status === 'waiting' || actor.status === 'stopped') {
    actor.status = 'active';
    actor.waitSince = 0;
    actor.updatedAtSeq = now;
  }
  return ok(result);
}

function waitForWake(draft, actor, action, now) {
  if (actor.status === 'paused') return fail(ERRORS.PAUSED, 'member is paused');
  let since = action.since ?? actor.lastReadSeq;
  if (!Number.isInteger(since) || since < 0) {
    return fail(ERRORS.INVALID_ARGUMENT, 'since must be a non-negative integer');
  }
  if (since < actor.lastReadSeq) since = actor.lastReadSeq;
  if (since > draft.seq) return fail(ERRORS.INVALID_ARGUMENT, 'since is beyond board head');
  const mentionsOnly =
    action.mentionsOnly === undefined
      ? action.wakeMode !== 'anything'
      : action.mentionsOnly !== false;
  const allVisible = visiblePostList(draft, actor, { since: 0 });
  if (allVisible.length === 0) {
    return fail(ERRORS.EMPTY, 'board has no posts visible to this member');
  }
  const unread = visiblePostList(draft, actor, { since });
  const matching = mentionsOnly
    ? unread.filter((post) => postTargets(draft, post).sessionIds.includes(actor.sessionId))
    : unread;
  if (matching.length > 0) {
    return fail(ERRORS.UNREAD, 'unread messages must be read before sleeping');
  }
  actor.status = 'waiting';
  actor.waitSince = since;
  actor.wakeMode = mentionsOnly ? 'mentions' : 'anything';
  actor.updatedAtSeq = now;
  draft.pendingWakes = draft.pendingWakes.filter(
    (item) => item.sessionId !== actor.sessionId || item.seq > since,
  );
  return ok({
    waiting: true,
    since,
    wakeMode: actor.wakeMode,
    headSeq: draft.seq,
  });
}

function statusOf(draft, actor) {
  const members = Object.keys(draft.members).map((id) => memberView(draft, draft.members[id]));
  const channels = Object.keys(draft.channels).map((name) =>
    channelView(draft, draft.channels[name], actor),
  );
  return ok({
    title: draft.title,
    plan: clone(draft.plan),
    deliveries: clone(visibleDeliveries(draft, actor)),
    seq: draft.seq,
    headSeq: draft.seq,
    members,
    reservations: Object.keys(draft.reservations).map((id) => {
      const reservation = draft.reservations[id];
      return {
        id,
        sessionId: reservation.sessionId,
        name: reservation.name,
        role: reservation.role,
        channels: reservation.channels.slice(),
        reservedBy: reservation.reservedBy,
        reservedAtSeq: reservation.reservedAtSeq,
      };
    }),
    channels,
    pendingWakes: draft.pendingWakes.map((item) => ({
      sessionId: item.sessionId,
      seq: item.seq,
      reason: item.reason,
      attempts: item.attempts,
    })),
    limits: { ...draft.limits },
  });
}

function appendControl(draft, actor, control, text, now) {
  if (draft.posts.length >= draft.limits.maxPosts) {
    return fail(ERRORS.BOARD_FULL, `post limit ${draft.limits.maxPosts} reached`);
  }
  const bytes = byteLength(text);
  if (draft.stats.postBytes + bytes > draft.limits.maxBoardBytes) {
    return fail(ERRORS.BOARD_FULL, `board byte limit ${draft.limits.maxBoardBytes} reached`);
  }
  const seq = draft.seq + 1;
  const post = {
    seq,
    sessionId: actor.sessionId,
    name: actor.name,
    text,
    channel: MAIN_CHANNEL,
    kind: 'control',
    at: now,
    time: timeOf(now),
    mentions: { all: false, names: [], channels: [], tokens: [] },
    targets: [],
    mentionChannels: [],
    control,
  };
  draft.posts.push(post);
  draft.seq = seq;
  draft.stats.postBytes += bytes;
  draft.stats.postCount = draft.posts.length;
  return { post };
}

function channelAction(draft, actor, action, now) {
  const op = action.op;
  if (op === 'list') {
    return ok({
      channels: Object.keys(draft.channels).map((name) =>
        channelView(draft, draft.channels[name], actor),
      ),
    });
  }
  if (op === 'create') {
    if (actor.role !== 'coordinator') return fail(ERRORS.FORBIDDEN, 'coordinator only');
    const name = action.channel;
    if (!isValidChannelName(name)) return fail(ERRORS.INVALID_NAME, 'invalid channel name');
    if (hasOwn(draft.channels, name)) return fail(ERRORS.DUPLICATE_CHANNEL, 'channel exists');
    if (Object.keys(draft.channels).length - 1 >= draft.limits.maxChannels) {
      return fail(ERRORS.LIMIT, `channel limit ${draft.limits.maxChannels} reached`);
    }
    const topic = action.topic === undefined ? '' : action.topic;
    if (typeof topic !== 'string' || topic.length > 200) {
      return fail(ERRORS.INVALID_ARGUMENT, 'invalid channel topic');
    }
    const seq = draft.seq + 1;
    const appended = appendControl(
      draft,
      actor,
      { op: 'create', channel: name, topic, members: [actor.sessionId], createdAtSeq: seq },
      `[channel] create #${name}`,
      now,
    );
    if (appended.ok === false) return fail(appended.code, appended.message);
    draft.channels[name] = {
      name,
      topic,
      createdAtSeq: seq,
      archivedAtSeq: null,
      subscribers: [actor.sessionId],
    };
    if (!actor.channels.includes(name)) actor.channels.push(name);
    return ok({ channel: channelView(draft, draft.channels[name], actor), seq });
  }
  if (op === 'archive') {
    if (actor.role !== 'coordinator') return fail(ERRORS.FORBIDDEN, 'coordinator only');
    const name = action.channel;
    if (typeof name !== 'string' || !hasOwn(draft.channels, name) || name === MAIN_CHANNEL) {
      return fail(ERRORS.UNKNOWN_CHANNEL, 'unknown channel');
    }
    if (!isChannelActive(draft.channels, name, draft.seq + 1)) {
      return fail(ERRORS.CHANNEL_ARCHIVED, 'channel is already archived');
    }
    const seq = draft.seq + 1;
    const appended = appendControl(
      draft,
      actor,
      { op: 'archive', channel: name, archivedAtSeq: seq },
      `[channel] archive #${name}`,
      now,
    );
    if (appended.ok === false) return fail(appended.code, appended.message);
    draft.channels[name].archivedAtSeq = seq;
    return ok({ channel: channelView(draft, draft.channels[name], actor), seq });
  }
  if (op === 'subscribe' || op === 'unsubscribe') {
    const name = action.channel;
    if (typeof name !== 'string' || !hasOwn(draft.channels, name)) {
      return fail(ERRORS.UNKNOWN_CHANNEL, 'unknown channel');
    }
    if (name === MAIN_CHANNEL) {
      if (op === 'unsubscribe') return fail(ERRORS.FORBIDDEN, 'cannot unsubscribe from main');
      return ok({ channel: channelView(draft, draft.channels[name], actor), changed: false });
    }
    if (op === 'subscribe' && !isChannelActive(draft.channels, name, draft.seq + 1)) {
      return fail(ERRORS.CHANNEL_ARCHIVED, 'channel is archived');
    }
    const requested = action.members === undefined ? [actor.sessionId] : action.members;
    if (!Array.isArray(requested) || requested.length === 0) {
      return fail(ERRORS.INVALID_ARGUMENT, 'members must be a non-empty array');
    }
    const targets = [];
    const seenMembers = new Set();
    for (const id of requested) {
      if (seenMembers.has(id)) continue;
      seenMembers.add(id);
      const member = memberBySession(draft, id);
      if (!member) return fail(ERRORS.NOT_FOUND, `member ${id} not found`);
      if (actor.role !== 'coordinator' && id !== actor.sessionId) {
        return fail(ERRORS.FORBIDDEN, 'only coordinator may change another member');
      }
      if (member.status === 'killed') return fail(ERRORS.CLOSED, 'member is killed');
      targets.push(member);
    }
    const changed = [];
    for (const member of targets) {
      const has = member.channels.includes(name);
      if ((op === 'subscribe' && !has) || (op === 'unsubscribe' && has)) {
        changed.push(member.sessionId);
      }
    }
    if (changed.length === 0) {
      return ok({ channel: channelView(draft, draft.channels[name], actor), changed: false });
    }
    const seq = draft.seq + 1;
    const appended = appendControl(
      draft,
      actor,
      { op, channel: name, members: changed },
      `[channel] ${op} #${name}`,
      now,
    );
    if (appended.ok === false) return fail(appended.code, appended.message);
    for (const member of targets) {
      if (!changed.includes(member.sessionId)) continue;
      if (op === 'subscribe') member.channels.push(name);
      else member.channels = member.channels.filter((channel) => channel !== name);
    }
    const subscribers = new Set(draft.channels[name].subscribers);
    for (const id of changed) {
      if (op === 'subscribe') subscribers.add(id);
      else subscribers.delete(id);
    }
    draft.channels[name].subscribers = [...subscribers];
    return ok({ channel: channelView(draft, draft.channels[name], actor), seq, changed: true });
  }
  return fail(ERRORS.INVALID_ARGUMENT, 'unknown channel op');
}

function applyWakeAck(draft, ack) {
  if (!isPlainObject(ack)) {
    return { ok: false, code: ERRORS.INVALID_ARGUMENT, message: 'ack must be an object' };
  }
  const sessionId = ack.sessionId;
  const seq = ack.seq;
  if (typeof sessionId !== 'string' || !Number.isInteger(seq)) {
    return { ok: false, code: ERRORS.INVALID_ARGUMENT, message: 'sessionId and seq are required' };
  }
  const index = draft.pendingWakes.findIndex((item) => item.sessionId === sessionId);
  if (index === -1) {
    return { ok: false, code: ERRORS.NOT_FOUND, message: 'pending wake not found' };
  }
  const pending = draft.pendingWakes[index];
  const delivered = ack.delivered !== false && ack.ok !== false;
  if (delivered) {
    if (pending.seq <= seq) draft.pendingWakes.splice(index, 1);
    return {
      ok: true,
      delivered: true,
      sessionId,
      seq,
      attempts: pending.attempts,
      ...(ack.error ? { error: ack.error } : {}),
    };
  }
  pending.attempts += 1;
  if (pending.attempts >= draft.limits.maxWakeAttempts) {
    draft.pendingWakes.splice(index, 1);
    return { ok: true, delivered: false, sessionId, seq, attempts: pending.attempts, dropped: true };
  }
  return { ok: true, delivered: false, sessionId, seq, attempts: pending.attempts, dropped: false };
}

function wakeResult(draft, actor, action) {
  if (actor.role !== 'coordinator') return fail(ERRORS.FORBIDDEN, 'coordinator only');
  if (action.acks !== undefined) {
    if (!Array.isArray(action.acks) || action.acks.length === 0) {
      return fail(ERRORS.INVALID_ARGUMENT, 'acks must be a non-empty array');
    }
    const results = action.acks.map((ack) => applyWakeAck(draft, ack));
    return ok({ results });
  }
  const result = applyWakeAck(draft, action);
  if (result.ok === false) return result;
  return ok(result);
}

function retryWakes(draft, actor, action, now) {
  if (actor.role !== 'coordinator') return fail(ERRORS.FORBIDDEN, 'coordinator only');
  const wants = action.sessionId;
  if (wants !== undefined && (typeof wants !== 'string' || wants.length === 0)) {
    return fail(ERRORS.INVALID_ARGUMENT, 'sessionId must be a non-empty string');
  }
  let limit = Infinity;
  if (action.limit !== undefined) {
    if (!Number.isInteger(action.limit) || action.limit < 1) {
      return fail(ERRORS.INVALID_ARGUMENT, 'limit must be a positive integer');
    }
    limit = action.limit;
  }
  const wakes = [];
  let failed = 0;
  let processed = 0;
  const keep = [];
  for (const pending of draft.pendingWakes) {
    if (wants !== undefined && pending.sessionId !== wants) {
      keep.push(pending);
      continue;
    }
    if (processed >= limit) {
      keep.push(pending);
      continue;
    }
    processed += 1;
    const member = memberBySession(draft, pending.sessionId);
    if (!member || member.status === 'killed' || member.status === 'paused') {
      failed += 1;
      continue;
    }
    pending.attempts += 1;
    pending.at = now;
    if (pending.attempts >= draft.limits.maxWakeAttempts) {
      failed += 1;
      continue;
    }
    keep.push(pending);
    wakes.push({ sessionId: pending.sessionId, seq: pending.seq });
  }
  draft.pendingWakes = keep;
  return ok({ retried: wakes.length, failed }, wakes);
}

function reconcile(draft, actor, action, now) {
  const live = Array.isArray(action.liveSessionIds)
    ? new Set(action.liveSessionIds.filter((id) => isValidSessionId(id)))
    : null;
  const fixes = [];

  for (const id of Object.keys(draft.members)) {
    const member = draft.members[id];
    if (!STATUSES.has(member.status)) {
      member.status = 'stopped';
      fixes.push(`member ${id} had invalid status`);
    }
    if (live && !live.has(id) && !member.externalMailbox && member.status !== 'killed' && member.status !== 'paused') {
      if (member.status !== 'stopped') {
        member.status = 'stopped';
        fixes.push(`member ${id} marked stopped`);
      }
    }
    const clamped = Math.min(Math.max(member.lastReadSeq, 0), draft.seq);
    if (clamped !== member.lastReadSeq) {
      member.lastReadSeq = clamped;
      fixes.push(`member ${id} lastReadSeq clamped`);
    }
    const wait = Math.min(Math.max(member.waitSince, 0), draft.seq);
    if (wait !== member.waitSince) {
      member.waitSince = wait;
      fixes.push(`member ${id} waitSince clamped`);
    }
    const channels = member.channels.filter(
      (name) => name === MAIN_CHANNEL || hasOwn(draft.channels, name),
    );
    if (!channels.includes(MAIN_CHANNEL)) channels.unshift(MAIN_CHANNEL);
    if (channels.length !== member.channels.length || channels.some((c, i) => c !== member.channels[i])) {
      member.channels = channels;
      fixes.push(`member ${id} channels repaired`);
    }
  }

  if (live) {
    for (const id of Object.keys(draft.reservations)) {
      if (!live.has(draft.reservations[id].sessionId)) {
        delete draft.reservations[id];
        fixes.push(`reservation ${id} expired`);
      }
    }
  }

  const bySession = new Map();
  for (const pending of draft.pendingWakes) {
    const member = memberBySession(draft, pending.sessionId);
    if (
      !member ||
      member.status === 'killed' ||
      member.status === 'paused' ||
      (member.status !== 'waiting' && member.status !== 'stopped') ||
      (live && !live.has(member.sessionId))
    ) {
      fixes.push(`pending wake for ${pending.sessionId} dropped`);
      continue;
    }
    if (pending.seq <= member.lastReadSeq) {
      fixes.push(`pending wake for ${pending.sessionId} dropped as already read`);
      continue;
    }
    if (pending.seq > draft.seq) {
      fixes.push(`pending wake for ${pending.sessionId} clamped`);
      pending.seq = draft.seq;
    }
    const existing = bySession.get(pending.sessionId);
    if (!existing || existing.seq < pending.seq) {
      bySession.set(pending.sessionId, pending);
    }
  }
  const deduped = [...bySession.values()].sort((a, b) => a.seq - b.seq);
  if (deduped.length !== draft.pendingWakes.length) fixes.push('pending wakes deduplicated');
  draft.pendingWakes = deduped;

  for (const id of Object.keys(draft.channels)) {
    if (id === MAIN_CHANNEL) continue;
    const expected = [];
    for (const memberId of Object.keys(draft.members)) {
      const member = draft.members[memberId];
      if (member.status === 'killed') continue;
      if (member.channels.includes(id)) expected.push(memberId);
    }
    const current = draft.channels[id].subscribers;
    if (current.length !== expected.length || current.some((value, i) => value !== expected[i])) {
      draft.channels[id].subscribers = expected;
      fixes.push(`channel #${id} subscribers rebuilt`);
    }
  }
  const mainExpected = Object.keys(draft.members).filter(
    (id) => draft.members[id].status !== 'killed',
  );
  const mainCurrent = draft.channels[MAIN_CHANNEL].subscribers;
  if (
    mainCurrent.length !== mainExpected.length ||
    mainCurrent.some((value, i) => value !== mainExpected[i])
  ) {
    draft.channels[MAIN_CHANNEL].subscribers = mainExpected;
    fixes.push('channel #main subscribers rebuilt');
  }

  let bytes = 0;
  for (const post of draft.posts) bytes += byteLength(post.text ?? '');
  if (bytes !== draft.stats.postBytes) {
    draft.stats.postBytes = bytes;
    fixes.push('board byte stats recomputed');
  }
  if (draft.stats.postCount !== draft.posts.length) {
    draft.stats.postCount = draft.posts.length;
    fixes.push('board post stats recomputed');
  }

  const wakes = [];
  for (const member of Object.values(draft.members)) {
    if (member.status !== 'waiting' && member.status !== 'stopped') continue;
    if (live && !live.has(member.sessionId)) continue;
    const latest = newestPostFor(draft, member, { mentionsOnly: member.wakeMode === 'mentions' });
    if (latest && makePending(draft, member, latest.seq, 'reconcile', now)) {
      wakes.push(wakeFor(member, latest.seq));
    }
  }
  for (const pending of draft.pendingWakes) {
    const member = memberBySession(draft, pending.sessionId);
    if (member && !wakes.some((wake) => wake.sessionId === member.sessionId)) {
      wakes.push(wakeFor(member, pending.seq));
    }
  }
  return ok({ fixes }, wakes);
}

// ---------------------------------------------------------------------------
// Constructor and dispatcher
// ---------------------------------------------------------------------------

export function newBoard(rootId, title = 'Swarm', options = {}) {
  if (!isValidSessionId(rootId)) {
    throw new TypeError('newBoard: rootId must be a non-empty session id');
  }
  if (title !== undefined && typeof title !== 'string') {
    throw new TypeError('newBoard: title must be a string');
  }
  const cleanTitle = (title ?? 'Swarm').trim() || 'Swarm';
  if (cleanTitle.length > MAX_TITLE) {
    throw new TypeError(`newBoard: title exceeds ${MAX_TITLE} characters`);
  }
  const now = options.now === undefined ? 0 : options.now;
  if (!validNow(now)) throw new TypeError('newBoard: now must be a valid millisecond timestamp');
  const limits = sanitizeLimits(options.limits);
  const board = {
    version: VERSION,
    rootId,
    title: cleanTitle,
    createdAt: now,
    clock: now,
    updatedAt: now,
    seq: 0,
    members: {},
    reservations: {},
    channels: emptyChannels(),
    posts: [],
    plan: emptyPlan(),
    deliveries: [],
    pendingWakes: [],
    counters: { reservation: 0 },
    limits,
    stats: { postBytes: 0, postCount: 0 },
  };
  if (options.coordinator !== undefined && options.coordinator !== null) {
    const spec =
      typeof options.coordinator === 'string'
        ? { sessionId: options.coordinator, name: 'coordinator' }
        : options.coordinator;
    if (!isPlainObject(spec)) throw new TypeError('newBoard: coordinator must be a session id or object');
    if (!isValidSessionId(spec.sessionId)) {
      throw new TypeError('newBoard: invalid coordinator sessionId');
    }
    if (!isValidMemberName(spec.name ?? 'coordinator')) {
      throw new TypeError('newBoard: invalid coordinator name');
    }
    createMember(
      board,
      {
        sessionId: spec.sessionId,
        name: spec.name ?? 'coordinator',
        role: 'coordinator',
        channels: [MAIN_CHANNEL],
        wakeMode: 'mentions',
        lastReadSeq: 0,
        modelRoute: null,
      },
      null,
      now,
    );
  }
  return board;
}

export function transition(board, actorSessionId, action) {
  if (!isPlainObject(board) || board.version !== VERSION) {
    throw new TypeError('transition: board must be a version 1 Swarm board');
  }
  if (!isPlainObject(action) || typeof action.type !== 'string') {
    throw new TypeError('transition: action must be an object with a string type');
  }
  if (actorSessionId !== null && actorSessionId !== undefined && typeof actorSessionId !== 'string') {
    throw new TypeError('transition: actorSessionId must be a string or null');
  }
  const now = resolveNow(action, board);
  if (now === null) {
    return {
      state: board,
      result: fail(ERRORS.INVALID_ARGUMENT, 'now must be a valid millisecond timestamp'),
      wakes: [],
    };
  }
  const draft = clone(board);
  draft.deliveries ??= []; // Boards persisted before member delivery acceptance.
  draft.clock = Math.max(draft.clock ?? 0, now);
  draft.updatedAt = draft.clock;
  const actorId = actorSessionId ?? null;
  const actor = actorId === null ? null : memberBySession(draft, actorId);

  const requireActor = ({ allowPaused = false, allowKilled = false } = {}) => {
    if (!actor) return fail(ERRORS.NOT_MEMBER, 'not a board member');
    if (actor.status === 'killed' && !allowKilled) return fail(ERRORS.CLOSED, 'member is killed');
    if (actor.status === 'paused' && !allowPaused) return fail(ERRORS.PAUSED, 'member is paused');
    return null;
  };

  let outcome;
  switch (action.type) {
    case 'bootstrap': {
      outcome = actionBootstrap(draft, actorId, action, now);
      break;
    }
    case 'add':
    case 'reserveJoin': {
      const denied = requireActor();
      if (denied) outcome = denied;
      else outcome = addMember(draft, actor, action, now, { reserve: action.type === 'reserveJoin' || action.reserve === true });
      break;
    }
    case 'commitJoin': {
      if (actor?.status === 'killed') outcome = fail(ERRORS.CLOSED, 'member is killed');
      else if (actor) outcome = commitJoin(draft, actor, action, now);
      else if (actorId) outcome = commitJoin(draft, { sessionId: actorId, role: 'worker' }, action, now);
      else outcome = fail(ERRORS.NOT_MEMBER, 'not a board member');
      break;
    }
    case 'failJoin': {
      if (actor) outcome = failJoin(draft, actor, action);
      else if (actorId) outcome = failJoin(draft, { sessionId: actorId, role: 'worker' }, action);
      else outcome = fail(ERRORS.NOT_MEMBER, 'not a board member');
      break;
    }
    case 'post': {
      const denied = requireActor();
      if (denied) outcome = denied;
      else outcome = postMessage(draft, actor, action, now);
      break;
    }
    case 'read': {
      const denied = requireActor({ allowPaused: true });
      if (denied) outcome = denied;
      else outcome = readBoard(draft, actor, action, now);
      break;
    }
    case 'confirmRead': {
      const denied = requireActor({ allowPaused: true });
      if (denied) outcome = denied;
      else if (!Array.isArray(action.seqs) || action.seqs.length > 200 ||
        !action.seqs.every((s) => Number.isInteger(s) && s >= 1 && s <= draft.seq)) {
        outcome = fail(ERRORS.INVALID_ARGUMENT, 'invalid delivered page sequences');
      } else {
        outcome = ok({ lastReadSeq: recordRead(draft, actor, new Set(action.seqs), now) });
      }
      break;
    }
    case 'wait': {
      const denied = requireActor();
      if (denied) outcome = denied;
      else outcome = waitForWake(draft, actor, action, now);
      break;
    }
    case 'status': {
      const denied = requireActor({ allowPaused: true });
      if (denied) outcome = denied;
      else outcome = statusOf(draft, actor);
      break;
    }
    case 'setTitle': {
      const denied = requireActor();
      if (denied) outcome = denied;
      else outcome = setTitle(draft, actor, action);
      break;
    }
    case 'assignDelivery': {
      outcome = requireActor() ?? assignAvailableDelivery(draft, actor, action, memberBySession(draft, action.owner));
      break;
    }
    case 'submitDelivery': {
      outcome = requireActor() ?? submitDelivery(draft, actor, action);
      break;
    }
    case 'reviewDelivery': {
      outcome = requireActor() ?? reviewDelivery(draft, actor, action);
      break;
    }
    case 'setPlan': {
      const denied = requireActor();
      if (denied) outcome = denied;
      else outcome = setPlan(draft, actor, action);
      break;
    }
    case 'setGoal': {
      const denied = requireActor();
      if (denied) outcome = denied;
      else outcome = setGoal(draft, actor, action);
      break;
    }
    case 'setStatus': {
      const denied = requireActor();
      if (denied) outcome = denied;
      else outcome = setStatus(draft, actor, action, now);
      break;
    }
    case 'setModel': {
      const denied = requireActor();
      if (denied) outcome = denied;
      else outcome = setModel(draft, actor, action, now);
      break;
    }
    case 'setBoardClock':
    case 'ackBoardAlert': {
      if (actor?.role !== 'coordinator') outcome = fail(ERRORS.FORBIDDEN, 'coordinator only');
      else {
        const res = action.type === 'setBoardClock' ? configureBoardClock(draft, action.patch, now) : ackBoardAlert(draft, action.alert, now);
        outcome = res.ok ? ok(res) : res;
      }
      break;
    }
    case 'addExternal': {
      if (actor?.role !== 'coordinator') outcome = fail(ERRORS.FORBIDDEN, 'coordinator only');
      else if (typeof action.mailbox !== 'string' || !action.mailbox.startsWith('/') || action.mailbox.length > 4096) outcome = fail(ERRORS.INVALID_ARGUMENT, 'invalid mailbox');
      else {
        outcome = addMember(draft, actor, {member:{sessionId:action.sessionId, name:action.name, role:'worker'}}, now);
        if (outcome.result?.ok) {
          draft.members[action.sessionId].externalMailbox = action.mailbox;
          draft.members[action.sessionId].externalReceipts = {};
        }
      }
      break;
    }
    case 'externalRequest': {
      outcome = requireActor() ?? externalRequest(draft, actor, action.request, now, transition);
      break;
    }
    case 'setQuotaWatch': {
      if (actor?.role !== 'coordinator') outcome = fail(ERRORS.FORBIDDEN, 'coordinator only');
      else if (action.watch !== null && (!['CNY', 'USD'].includes(action.watch?.currency) || !Number.isFinite(action.watch?.threshold) || action.watch.threshold <= 0)) outcome = fail(ERRORS.INVALID_ARGUMENT, 'invalid balance threshold');
      else {
        draft.quotaWatch = action.watch ? { currency: action.watch.currency, threshold: action.watch.threshold } : null;
        outcome = ok({ watch: draft.quotaWatch });
      }
      break;
    }
    case 'recordMerge': {
      const target = memberBySession(draft, action.target);
      if (actor?.role !== 'coordinator') outcome = fail(ERRORS.FORBIDDEN, 'coordinator only');
      else if (target?.status !== 'killed' || !target.worktree || target.worktree.id !== action.worktreeId) outcome = fail(ERRORS.INVALID_ARGUMENT, 'checkout mismatch');
      else if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(action.mergedHead) || !Number.isSafeInteger(action.mergedAt)) outcome = fail(ERRORS.INVALID_ARGUMENT, 'invalid delivery receipt');
      else {
        target.worktree = { ...target.worktree, status: 'merged', mergedHead: action.mergedHead, mergedAt: action.mergedAt, updatedAt: action.mergedAt };
        outcome = ok({ member: memberView(draft, target) });
      }
      break;
    }
    case 'consumeFallback': {
      const denied = requireActor();
      outcome = denied ?? consumeFallback(draft, actor, action, now);
      break;
    }
    case 'kill': {
      const denied = requireActor();
      if (denied) outcome = denied;
      else outcome = killMember(draft, actor, action, now);
      break;
    }
    case 'pause': {
      const denied = requireActor();
      if (denied) outcome = denied;
      else outcome = pauseMember(draft, actor, action, now);
      break;
    }
    case 'resume': {
      const denied = requireActor();
      if (denied) outcome = denied;
      else outcome = resumeMember(draft, actor, action, now);
      break;
    }
    case 'channel': {
      const denied = requireActor();
      if (denied) outcome = denied;
      else outcome = channelAction(draft, actor, action, now);
      break;
    }
    case 'wakeResult': {
      const denied = requireActor();
      if (denied) outcome = denied;
      else outcome = wakeResult(draft, actor, action);
      break;
    }
    case 'retryWakes': {
      const denied = requireActor();
      if (denied) outcome = denied;
      else outcome = retryWakes(draft, actor, action, now);
      break;
    }
    case 'reconcile': {
      if (actor) {
        if (actor.status === 'killed') outcome = fail(ERRORS.CLOSED, 'member is killed');
        else if (actor.role !== 'coordinator') outcome = fail(ERRORS.FORBIDDEN, 'coordinator only');
        else outcome = reconcile(draft, actor, action, now);
      } else if (actorId === null) {
        outcome = reconcile(draft, null, action, now);
      } else {
        outcome = fail(ERRORS.NOT_MEMBER, 'not a board member');
      }
      break;
    }
    default:
      outcome = fail(ERRORS.INVALID_ACTION, `unknown action ${action.type}`);
  }

  if (outcome && Object.hasOwn(outcome, 'ok') && outcome.ok === false) {
    return { state: board, result: outcome, wakes: [] };
  }
  const { result, wakes = [] } = outcome;
  return { state: draft, result, wakes };
}

// ---------------------------------------------------------------------------
// Bounded read-only projection for host/client rendering.
// ---------------------------------------------------------------------------

export function boardView(board, options = {}) {
  const postLimit = clampInt(options.postLimit, 50, 0, 500);
  const memberLimit = clampInt(options.memberLimit, 100, 0, 500);
  const textLimit = clampInt(options.textLimit, 2000, 64, 100_000);
  const allMembers = Object.keys(board.members).map((id) => board.members[id]);
  const allPosts = board.posts;
  const start = Math.max(0, allPosts.length - postLimit);
  const posts = allPosts.slice(start).map((post) => {
    const view = messageView(post);
    if (view.text.length > textLimit) view.text = `${view.text.slice(0, textLimit)}…`;
    return view;
  });
  return {
    rootId: board.rootId,
    title: board.title,
    seq: board.seq,
    headSeq: board.seq,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    plan: clone(board.plan),
    deliveries: clone(board.deliveries ?? []),
    members: allMembers.slice(0, memberLimit).map((member) => memberView(board, member)),
    channels: Object.keys(board.channels).map((name) => channelView(board, board.channels[name], null)),
    reservations: Object.keys(board.reservations).map((id) => {
      const reservation = board.reservations[id];
      return {
        id,
        sessionId: reservation.sessionId,
        name: reservation.name,
        role: reservation.role,
        channels: reservation.channels.slice(),
        reservedBy: reservation.reservedBy,
        reservedAtSeq: reservation.reservedAtSeq,
      };
    }),
    pendingWakes: board.pendingWakes.map((item) => ({
      sessionId: item.sessionId,
      seq: item.seq,
      reason: item.reason,
      attempts: item.attempts,
    })),
    posts,
    limits: { ...board.limits },
    stats: { ...board.stats },
    truncated: {
      posts: allPosts.length > postLimit,
      members: allMembers.length > memberLimit,
    },
  };
}

function clampInt(value, fallback, min, max) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

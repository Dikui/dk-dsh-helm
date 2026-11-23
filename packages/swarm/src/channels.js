// Shared bell (mention) parsing and channel replay for the Swarm board.
// Imported by both the host WakeEngine and the client UI, so it must stay
// dependency-free and side-effect-free.
//
// A bell is `@` at a word boundary:
//   @name      exactly one member, or all `<name>-<digits>` shards when no
//              member has that exact name
//   @all       every member
//   @#channel  the channel's subscribers plus every member with a "*" view
//              (coordinator/monitor), only while the channel is active at the
//              post's seq
//
// `@#main` is never a bell: main is implicit.

export const MAIN_CHANNEL = 'main';
export const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const MENTION_RE = /(^|[^A-Za-z0-9_@-])@(#?)([A-Za-z0-9][A-Za-z0-9_-]*)/g;

export function isSafeKey(value) {
  return typeof value === 'string' && value.length > 0 && !DANGEROUS_KEYS.has(value);
}

export function isValidMemberName(name) {
  return (
    typeof name === 'string' &&
    /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name) &&
    !DANGEROUS_KEYS.has(name) &&
    !['all', 'main'].includes(name.toLowerCase())
  );
}

export function isValidChannelName(name) {
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(name) &&
    !DANGEROUS_KEYS.has(name) &&
    !['all', 'main'].includes(name.toLowerCase())
  );
}

/**
 * Parse the bells in a post. Names/channels are deduplicated
 * case-insensitively but keep the first spelling seen.
 *
 * @returns {{all: boolean, names: string[], channels: string[],
 *            tokens: Array<{kind: 'all'|'member'|'channel', name: string}>}}
 */
export function parseMentions(text) {
  if (typeof text !== 'string') {
    return { all: false, names: [], channels: [], tokens: [] };
  }
  const names = [];
  const channels = [];
  const tokens = [];
  const seenNames = new Set();
  const seenChannels = new Set();
  let all = false;

  MENTION_RE.lastIndex = 0;
  let match;
  while ((match = MENTION_RE.exec(text)) !== null) {
    const hash = match[2];
    const raw = match[3];
    if (hash === '#') {
      const key = raw.toLowerCase();
      if (!seenChannels.has(key)) {
        seenChannels.add(key);
        channels.push(raw);
        tokens.push({ kind: 'channel', name: raw });
      }
      continue;
    }
    if (raw.toLowerCase() === 'all') {
      if (!all) {
        all = true;
        tokens.push({ kind: 'all', name: 'all' });
      }
      continue;
    }
    const key = raw.toLowerCase();
    if (!seenNames.has(key)) {
      seenNames.add(key);
      names.push(raw);
      tokens.push({ kind: 'member', name: raw });
    }
  }
  return { all, names, channels, tokens };
}

export function isChannelActive(channels, name, seq) {
  if (name === MAIN_CHANNEL) return true;
  if (!channels || !Object.hasOwn(channels, name)) return false;
  const channel = channels[name];
  if (!channel || typeof channel.createdAtSeq !== 'number') return false;
  if (channel.createdAtSeq > seq) return false;
  return channel.archivedAtSeq === null || channel.archivedAtSeq === undefined
    ? true
    : channel.archivedAtSeq > seq;
}

export function hasViewAll(member) {
  return (
    member?.viewAll === true ||
    member?.role === 'coordinator' ||
    member?.role === 'monitor'
  );
}

export function canSeeChannel(member, channel) {
  if (!member) return false;
  if (hasViewAll(member)) return true;
  if (channel === MAIN_CHANNEL) return true;
  return Array.isArray(member.channels) && member.channels.includes(channel);
}

function normalizeMembers(members) {
  if (Array.isArray(members)) return members.filter(Boolean);
  if (members && typeof members === 'object') {
    return Object.keys(members)
      .filter((key) => isSafeKey(key))
      .map((key) => members[key])
      .filter(Boolean);
  }
  return [];
}

function pushUnique(list, seen, value) {
  if (!seen.has(value)) {
    seen.add(value);
    list.push(value);
  }
}

/**
 * Resolve bells against the member roster and the channel snapshot at a seq.
 * Returned sessionIds are ordered by bell occurrence and deduplicated. This
 * function does not filter killed members; callers that deliver wakes must.
 */
export function resolveMentions(textOrParsed, { members, channels = {}, atSeq = 0 } = {}) {
  const parsed =
    typeof textOrParsed === 'string' ? parseMentions(textOrParsed) : textOrParsed;
  const roster = normalizeMembers(members);
  const result = parsed?.all
    ? { all: true, sessionIds: roster.map((m) => m.sessionId), hits: [] }
    : { all: false, sessionIds: [], hits: [] };
  const seen = new Set(result.sessionIds.filter(Boolean));

  if (parsed?.all) {
    result.hits.push({ kind: 'all', sessionIds: result.sessionIds.slice() });
  }

  const byName = new Map();
  for (const member of roster) {
    if (typeof member?.name === 'string') {
      const key = member.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, member);
    }
  }

  for (const name of parsed?.names ?? []) {
    const key = name.toLowerCase();
    let targets = [];
    if (byName.has(key)) {
      targets = [byName.get(key)];
    } else {
      const shard = new RegExp(`^${escapeRegExp(key)}-\\d+$`, 'i');
      targets = roster.filter(
        (member) => typeof member.name === 'string' && shard.test(member.name),
      );
    }
    const ids = [];
    for (const member of targets) {
      if (member?.sessionId) {
        pushUnique(result.sessionIds, seen, member.sessionId);
        ids.push(member.sessionId);
      }
    }
    result.hits.push({ kind: 'member', name, sessionIds: ids });
  }

  for (const name of parsed?.channels ?? []) {
    const ids = [];
    if (name.toLowerCase() === MAIN_CHANNEL || !isChannelActive(channels, name, atSeq)) {
      result.hits.push({ kind: 'channel', name, sessionIds: ids, active: false });
      continue;
    }
    const channel = channels[name];
    const subscriberIds = Array.isArray(channel?.subscribers) ? channel.subscribers : [];
    for (const id of subscriberIds) {
      const member = roster.find((m) => m.sessionId === id);
      if (member) {
        pushUnique(result.sessionIds, seen, id);
        ids.push(id);
      }
    }
    for (const member of roster) {
      if (hasViewAll(member) && member.sessionId) {
        pushUnique(result.sessionIds, seen, member.sessionId);
        ids.push(member.sessionId);
      }
    }
    result.hits.push({ kind: 'channel', name, sessionIds: ids, active: true });
  }

  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cloneChannel(channel) {
  return {
    name: channel.name,
    topic: channel.topic ?? '',
    createdAtSeq: channel.createdAtSeq ?? 0,
    archivedAtSeq: channel.archivedAtSeq ?? null,
    subscribers: Array.isArray(channel.subscribers) ? channel.subscribers.slice() : [],
  };
}

export function emptyChannels() {
  return {
    [MAIN_CHANNEL]: {
      name: MAIN_CHANNEL,
      topic: '',
      createdAtSeq: 0,
      archivedAtSeq: null,
      subscribers: [],
    },
  };
}

export function cloneChannels(channels) {
  const next = {};
  for (const name of Object.keys(channels ?? {})) {
    if (isSafeKey(name) && channels[name]) next[name] = cloneChannel(channels[name]);
  }
  if (!next[MAIN_CHANNEL]) next[MAIN_CHANNEL] = cloneChannel(emptyChannels().main);
  return next;
}

/**
 * Apply one control record to a channel map in place. Returns the changed
 * channel name, or null when the control is a no-op / unknown.
 */
export function applyChannelControl(channels, control, seq) {
  if (!control || typeof control !== 'object') return null;
  const op = control.op;
  const name = control.channel;
  if (typeof name !== 'string' || !isSafeKey(name) || name === MAIN_CHANNEL) {
    return null;
  }
  if (op === 'create') {
    if (Object.hasOwn(channels, name)) return null;
    const members = Array.isArray(control.members) ? control.members : [];
    channels[name] = {
      name,
      topic: typeof control.topic === 'string' ? control.topic : '',
      createdAtSeq: Number.isInteger(control.createdAtSeq) ? control.createdAtSeq : seq,
      archivedAtSeq: null,
      subscribers: [...new Set(members.filter(isSafeKey))],
    };
    return name;
  }
  if (!Object.hasOwn(channels, name)) return null;
  if (op === 'archive') {
    if (channels[name].archivedAtSeq !== null) return null;
    channels[name].archivedAtSeq = Number.isInteger(control.archivedAtSeq)
      ? control.archivedAtSeq
      : seq;
    return name;
  }
  if (op === 'subscribe' || op === 'unsubscribe') {
    const members = Array.isArray(control.members) ? control.members : [];
    const set = new Set(channels[name].subscribers);
    for (const id of members) {
      if (!isSafeKey(id)) continue;
      if (op === 'subscribe') set.add(id);
      else set.delete(id);
    }
    channels[name].subscribers = [...set];
    return name;
  }
  return null;
}

/**
 * Replay channel lifecycle controls up to `upToSeq` (inclusive). Post records
 * are irrelevant; control records with a non-null `control` object are
 * applied in seq order. Returns a fresh map including `main`.
 */
export function replayChannels(posts, upToSeq = Infinity) {
  const channels = emptyChannels();
  const ordered = (Array.isArray(posts) ? posts : [])
    .filter(
      (post) =>
        post &&
        post.kind === 'control' &&
        post.control &&
        Number.isInteger(post.seq) &&
        post.seq <= upToSeq,
    )
    .slice()
    .sort((a, b) => a.seq - b.seq);
  for (const post of ordered) {
    applyChannelControl(channels, post.control, post.seq);
  }
  return channels;
}

export function channelSubscriberIds(channels, name) {
  if (!channels || !Object.hasOwn(channels, name)) return [];
  return Array.isArray(channels[name].subscribers) ? channels[name].subscribers.slice() : [];
}

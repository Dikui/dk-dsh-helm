import { clampInt, isPlainObject, truncateText } from './host-format.js';

export const VIEW_TOTAL_LIMIT = 12_000;
export const VIEW_MEMBER_LIMIT = 64;
export const VIEW_CHANNEL_LIMIT = 32;
export const VIEW_MESSAGE_LIMIT = 30;
export const VIEW_TEXT_LIMIT = 400;

function normalizeGoal(goal) {
  if (goal === undefined || goal === null) return '';
  if (typeof goal === 'string') return truncateText(goal.trim(), 300);
  if (!isPlainObject(goal)) return '';
  const title = truncateText(String(goal.title ?? '').trim(), 180);
  const line = truncateText(String(goal.line ?? '').trim(), 300);
  if (title && line && title !== line) return `${title} — ${line}`;
  return title || line;
}

function normalizeTasks(tasks) {
  if (!tasks) return [];
  const entries = [];
  if (Array.isArray(tasks)) {
    for (const [index, task] of tasks.entries()) {
      if (entries.length >= 20) break;
      if (typeof task === 'string') {
        entries.push({ id: String(index + 1), title: truncateText(task, 140), status: 'pending' });
      } else if (isPlainObject(task)) {
        entries.push(normalizeTask(task, index));
      }
    }
    return entries;
  }
  if (isPlainObject(tasks)) {
    for (const [id, task] of Object.entries(tasks)) {
      if (entries.length >= 20) break;
      if (typeof task === 'string') {
        entries.push({ id: String(id), title: truncateText(task, 140), status: 'pending' });
      } else if (isPlainObject(task)) {
        entries.push({ ...normalizeTask(task, entries.length), id: String(task.id ?? id) });
      }
    }
  }
  return entries;
}

function normalizeTask(task, index) {
  const value = {
    id: String(task.id ?? index + 1),
    title: truncateText(String(task.title ?? task.goal ?? task.text ?? ''), 140),
    status: truncateText(String(task.status ?? 'pending'), 24),
  };
  if (task.owner !== undefined && task.owner !== null) value.owner = truncateText(String(task.owner), 48);
  return value;
}

function normalizeThreads(threads) {
  if (!threads) return [];
  const source = Array.isArray(threads) ? threads : isPlainObject(threads) ? Object.values(threads) : [];
  const out = [];
  for (const [index, thread] of source.entries()) {
    if (out.length >= 10) break;
    if (typeof thread === 'string') {
      out.push({ id: String(index + 1), channel: '', goal: truncateText(thread, 160) });
    } else if (isPlainObject(thread)) {
      out.push({
        id: String(thread.id ?? index + 1),
        channel: truncateText(String(thread.channel ?? ''), 32),
        goal: truncateText(String(thread.goal ?? thread.title ?? ''), 160),
      });
    }
  }
  return out;
}

export function normalizePlan(plan) {
  if (!plan) return null;
  const goal = normalizeGoal(plan.goal);
  const tasks = normalizeTasks(plan.tasks);
  const threads = normalizeThreads(plan.threads);
  if (!goal && tasks.length === 0 && threads.length === 0) return null;
  return { goal, tasks, threads };
}

const STATUS_MAP = Object.freeze({
  active: 'working',
  working: 'working',
  waiting: 'waiting',
  stopped: 'stopped',
  paused: 'paused',
  killed: 'killed',
});

function normalizeStatus(status) {
  return STATUS_MAP[status] ?? 'stopped';
}

function unreadCount(board, member, options) {
  // Core owns visibility (control records, channels, killed authors), so never
  // derive "unread" from seq arithmetic here.
  if (typeof options.visiblePosts === 'function') {
    try {
      const posts = options.visiblePosts(board, member.sessionId, {
        since: member.lastReadSeq ?? 0,
      });
      return Array.isArray(posts) ? posts.length : 0;
    } catch {
      return 0;
    }
  }
  if (options.unread && Number.isFinite(options.unread[member.sessionId])) {
    return Math.max(0, options.unread[member.sessionId]);
  }
  return 0;
}

/**
 * Copy the core's resolved target names exactly as they were at post time.
 * Deliberately do not re-resolve against the current roster: a later kill or
 * rename must not rewrite the graph edge for an older seq.
 */
function normalizeTargets(post) {
  if (!Array.isArray(post.targets) || post.targets.length === 0) return undefined;
  const out = [];
  const seen = new Set();
  for (const target of post.targets) {
    if (typeof target !== 'string' || !target) continue;
    if (target === post.name) continue;
    if (seen.has(target.toLowerCase())) continue;
    seen.add(target.toLowerCase());
    out.push(truncateText(target, 48));
    if (out.length >= 16) break;
  }
  return out.length ? out : undefined;
}

function normalizeChannels(board) {
  const out = [];
  for (const channel of Object.values(board.channels ?? {})) {
    if (!channel || typeof channel.name !== 'string') continue;
    if (out.length >= VIEW_CHANNEL_LIMIT) break;
    const subscribers = Array.isArray(channel.subscribers) ? channel.subscribers.length : 0;
    out.push({
      name: truncateText(channel.name, 32),
      topic: truncateText(String(channel.topic ?? ''), 120),
      members: subscribers,
      archived: Boolean(channel.archivedAtSeq),
    });
  }
  return out;
}

/**
 * Bounded read-only projection for `/swarm view`. It deliberately drops raw
 * session ids, cursors, reservations and control posts. Targets are copied from
 * the core's resolved `post.targets` only; the host never re-parses bell text.
 */
export function buildPublicView(board, options = {}) {
  if (!board || typeof board !== 'object') throw new TypeError('buildPublicView: board required');
  const messageLimit = clampInt(options.messageLimit, VIEW_MESSAGE_LIMIT, 0, VIEW_MESSAGE_LIMIT);
  const memberLimit = clampInt(options.memberLimit, VIEW_MEMBER_LIMIT, 0, VIEW_MEMBER_LIMIT);
  const channelLimit = clampInt(options.channelLimit, VIEW_CHANNEL_LIMIT, 0, VIEW_CHANNEL_LIMIT);
  const totalLimit = clampInt(options.totalLimit, VIEW_TOTAL_LIMIT, 512, VIEW_TOTAL_LIMIT);
  const allMembers = Object.values(board.members ?? {});
  const allPosts = (board.posts ?? []).filter((post) => post.kind !== 'control');

  const members = allMembers.slice(0, memberLimit).map((raw) => {
    const channels = Array.isArray(raw.channels)
      ? raw.channels.slice(0, 8).map((channel) => truncateText(String(channel), 32))
      : ['main'];
    return {
      name: truncateText(String(raw.name ?? ''), 48),
      role: raw.role === 'coordinator' ? 'coordinator' : raw.role === 'monitor' ? 'monitor' : 'worker',
      status: normalizeStatus(raw.status),
      ...(raw.workspaceMode === 'branch' ? { workspaceMode: 'branch' } : {}),
      ...(raw.modelRoute ? { model: truncateText(`${raw.modelRoute.provider}/${raw.modelRoute.model}`, 96) } : {}),
      ...(raw.fallbackRoute ? { fallback: truncateText(`${raw.fallbackRoute.provider}/${raw.fallbackRoute.model}`, 96) } : {}),
      channels,
      unread: unreadCount(board, raw, options),
      lastSeq: Math.max(0, Number(raw.lastReadSeq ?? 0)),
    };
  });

  const channels = normalizeChannels(board).slice(0, channelLimit);
  const counts = {
    members: allMembers.length,
    active: allMembers.filter(
      (member) =>
        member.role !== 'coordinator' && !['stopped', 'paused', 'killed'].includes(member.status),
    ).length,
    messages: allPosts.length,
    channels: Object.keys(board.channels ?? {}).length,
  };

  let textLimit = 400;
  for (; textLimit >= 64; textLimit = Math.floor(textLimit / 2)) {
    const messages = allPosts
      .slice(-messageLimit)
      .map((post) => message(post, textLimit));
    const packet = {
      v: 1,
      title: truncateText(String(board.title ?? 'Swarm'), 120),
      seq: board.seq ?? 0,
      plan: normalizePlan(board.plan),
      counts,
      members,
      messages,
      channels,
    };
    trim(packet, totalLimit);
    if (JSON.stringify(packet).length <= totalLimit) return packet;
  }

  const packet = {
    v: 1,
    title: truncateText(String(board.title ?? 'Swarm'), 64),
    seq: board.seq ?? 0,
    plan: null,
    counts,
    members: members.slice(0, 8).map((member) => ({ ...member, channels: ['main'] })),
    messages: [],
    channels: channels.slice(0, 8).map((channel) => ({ ...channel, topic: '' })),
  };
  trim(packet, totalLimit);
  return packet;
}

function message(post, textLimit) {
  const value = {
    seq: post.seq,
    author: truncateText(String(post.name ?? 'unknown'), 48),
    channel: truncateText(String(post.channel ?? 'main'), 32),
    text: truncateText(String(post.text ?? ''), textLimit),
  };
  const targets = normalizeTargets(post);
  if (targets) value.targets = targets;
  return value;
}

function trim(packet, totalLimit) {
  while (JSON.stringify(packet).length > totalLimit && packet.messages.length > 0) {
    packet.messages.shift();
  }
  while (JSON.stringify(packet).length > totalLimit && packet.channels.length > 1) {
    packet.channels.pop();
  }
  while (JSON.stringify(packet).length > totalLimit && packet.members.length > 1) {
    packet.members.pop();
  }
  while (JSON.stringify(packet).length > totalLimit && packet.plan) {
    if (packet.plan.tasks.length > 0) packet.plan.tasks.pop();
    else if (packet.plan.threads.length > 0) packet.plan.threads.pop();
    else packet.plan = null;
  }
}

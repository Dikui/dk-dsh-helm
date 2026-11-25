import { createHash } from 'node:crypto';

// Optional board reminders live on the board record so they survive host restarts.
// Legacy boards have no reminders and need no migration.
export function getBoardClock(board) {
  const { deadlineUtc = null, silenceMs = null } = board.reminders ?? {};
  return { deadlineUtc, silenceMs };
}

// Require an explicit offset. Date.parse alone accepts local times and silently
// rolls some impossible calendar dates into the following month.
function utcInstant(value) {
  const format = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
  const match = typeof value === 'string' && format.exec(value);
  if (!match) return null;
  const day = Date.parse(`${match[1]}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== match[1]) return null;
  return new Date(value).toISOString();
}

function invalid(message) {
  return { ok: false, code: 'INVALID_ARGUMENT', message };
}

// Call within a board transaction. An omitted field is unchanged; null disables it.
export function configureBoardClock(draft, patch, now) {
  const fields = patch && typeof patch === 'object' && !Array.isArray(patch) && Object.keys(patch);
  if (!fields?.length || !fields.every(key => ['deadlineUtc', 'silenceMs'].includes(key))) {
    return invalid('expected deadlineUtc and/or silenceMs');
  }
  if (!Number.isSafeInteger(now) || now < 0) return invalid('expected a millisecond timestamp');
  const settings = getBoardClock(draft);
  if (fields.includes('deadlineUtc')) {
    if (patch.deadlineUtc === null) settings.deadlineUtc = null;
    else if (!(settings.deadlineUtc = utcInstant(patch.deadlineUtc))) {
      return invalid('deadlineUtc must be an ISO date-time with Z or an explicit UTC offset');
    }
  }
  if (fields.includes('silenceMs')) {
    if (patch.silenceMs !== null && !(Number.isSafeInteger(patch.silenceMs) && patch.silenceMs > 0)) {
      return invalid('silenceMs must be a positive integer or null');
    }
    settings.silenceMs = patch.silenceMs;
  }
  const previous = getBoardClock(draft);
  const reminders = { ...draft.reminders, ...settings, acks: { ...draft.reminders?.acks } };
  // A setting can be disabled and restored while its previous notification is
  // in flight, even within a single millisecond. Keep those epochs distinct.
  if (settings.deadlineUtc !== previous.deadlineUtc) {
    delete reminders.acks.deadline;
    reminders.deadlineEpoch = (reminders.deadlineEpoch ?? 0) + 1;
  }
  if (settings.silenceMs !== previous.silenceMs) {
    delete reminders.acks.silence;
    reminders.silenceEpoch = (reminders.silenceEpoch ?? 0) + 1;
    reminders.silenceSince = now;
  }
  draft.reminders = reminders;
  return { ok: true, settings };
}

// Explicit contracts are authoritative, even after a historical [done] post.
// Legacy boards have ordinary work and a coordinator-authored terminal marker.
function unfinishedTeam(board) {
  if (!board || board.done === true) return null;
  const members = Object.values(board.members);
  const lead = members.find(member => member.role === 'coordinator');
  const workers = members.filter(member => member.role === 'worker' && member.status !== 'killed');
  if (!lead) return null;
  const posts = board.posts.filter(post => post.kind === 'post');
  const deliveries = board.deliveries ?? [];
  const outstanding = deliveries.filter(d => ['assigned', 'submitted', 'returned'].includes(d.status));
  if (deliveries.length && !outstanding.length) return null;
  if (!workers.length && !outstanding.some(d => {
    const owner = board.members[d.owner];
    return owner?.role === 'monitor' && owner.status !== 'killed';
  })) return null;
  if (!deliveries.length && posts.some(post => post.sessionId === board.rootId && post.channel === 'main' &&
      /^\[done\](?:\s|$)/i.test(post.text) && !/@/.test(post.text))) return null;
  return { lead, workers, posts, deliveries, outstanding };
}

// Kept as its own diagnosis: all workers parked is actionable even before a
// configured silence timeout, but working without posts is not a parked stall.
export function diagnoseStall(board, team = unfinishedTeam(board)) {
  if (!team) return null;
  const { workers, lead, posts } = team;
  if (!workers.length || !posts.length || workers.some(m => !['waiting', 'stopped', 'paused'].includes(m.status))) return null;
  const latest = posts.at(-1);
  const pending = board.pendingWakes?.find(wake => wake.attempts > 0);
  const paused = workers.find(m => m.status === 'paused');
  let reason, note;
  if (paused) {
    reason = 'paused'; note = `${paused.name} is paused. Inspect the quota or pause reason before resuming.`;
  } else if (pending) {
    reason = 'delivery'; note = `Doorbell #${pending.seq} has an unacknowledged delivery attempt.`;
  } else if (posts.some(p => p.seq > lead.lastReadSeq && p.targets?.includes(lead.name))) {
    reason = 'lead'; note = `${lead.name} has an unread directed reply. Read the board before dispatching more work.`;
  } else if (latest.sessionId !== board.rootId && latest.channel === 'main' && latest.seq > lead.lastReadSeq) {
    reason = 'result'; note = `The latest worker post (#${latest.seq}) may need a coordinator decision.`;
  } else {
    reason = 'waiting'; note = 'All remaining workers are parked or stopped. Check whether anyone owns the next action.';
  }
  return { key: `${board.seq}:${reason}`, message:
    `[Swarm monitor] ${note} Inspect /swarm status. This is a stall hint, not a request to restart workers.` };
}

function quietAlert(board, team, silenceMs, now) {
  const latestPost = team.posts.at(-1);
  const since = team.deliveries.reduce((at, delivery) => Math.max(at, delivery.updatedAt),
    Math.max(board.reminders.silenceSince ?? board.createdAt, latestPost?.at ?? 0));
  if (!(now - since >= silenceMs)) return null;
  // The timestamp alone cannot distinguish multiple posts or delivery revisions
  // in the same millisecond. Store a bounded receipt, not the entire task list.
  const revisions = team.deliveries.map(d => [d.taskId, d.status, d.submission?.seq ?? 0]);
  const episode = [board.reminders.silenceEpoch ?? 0, silenceMs, since, latestPost?.seq ?? 0, revisions];
  const key = createHash('sha256').update(JSON.stringify(episode)).digest('hex');
  const outstanding = team.outstanding.length;
  const subject = outstanding ? `${outstanding} delivery task(s) await progress or review.`
    : `There are ${team.workers.length} remaining worker(s).`;
  return { kind: 'silence', key, message:
    `[Swarm monitor] No board post or delivery update for at least ${silenceMs} ms. ${subject} Inspect /swarm status; no member has been stopped.` };
}

// Pure evaluation against a snapshot at a caller-supplied wall-clock instant.
export function evaluateBoardAlerts(board, now) {
  const team = unfinishedTeam(board);
  if (!team) return [];
  const { deadlineUtc, silenceMs } = getBoardClock(board);
  const alerts = [];
  if (deadlineUtc && now >= Date.parse(deadlineUtc)) {
    alerts.push({ kind: 'deadline', key: `${board.reminders.deadlineEpoch ?? 0}:${deadlineUtc}`, message:
      `[Swarm monitor] The board deadline ${deadlineUtc} has arrived. Review outstanding work; no member has been stopped.` });
  }
  if (silenceMs) {
    const quiet = quietAlert(board, team, silenceMs, now);
    if (quiet) alerts.push(quiet);
  }
  const stall = diagnoseStall(board, team);
  if (stall) alerts.push({ kind: 'stall', ...stall });
  return alerts.filter(alert => board.reminders?.acks?.[alert.kind] !== alert.key);
}

// Pass only a successful notification's {kind,key}. Re-evaluate the transaction's
// *current* board before writing, so a late receipt cannot consume later activity.
export function ackBoardAlert(draft, alert, now) {
  const current = evaluateBoardAlerts(draft, now).find(candidate =>
    candidate.kind === alert?.kind && candidate.key === alert?.key);
  if (!current) return { ok: true, acknowledged: false };
  draft.reminders ??= {};
  draft.reminders.acks = { ...draft.reminders.acks, [current.kind]: current.key };
  return { ok: true, acknowledged: true };
}

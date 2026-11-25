// Manual, member-level delivery receipts. References and evidence are text to
// record, never paths to open or checks to execute. The board has already
// cloned the state and authenticated the actor before entering this module.
import { isSafeKey } from './channels.js';

const MAX_DELIVERIES = 128;

function text(value, limit) {
  if (typeof value !== 'string' || value.length > limit) return null;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) return null;
  return value.trim() || null;
}

export function visibleDeliveries(board, member) {
  const items = board.deliveries ?? [];
  return member.role === 'coordinator' ? items : items.filter(d => d.owner === member.sessionId);
}

export function validTaskId(id) {
  return isSafeKey(id) && id.length <= 64 && !/[\s\u0000-\u001f\u007f]/u.test(id);
}

function reject(code, message) {
  return { ok: false, code, message };
}

function receipt(delivery) {
  return { result: { ok: true, delivery: structuredClone(delivery) } };
}

export function assignDelivery(draft, actor, action, owner) {
  if (actor.role !== 'coordinator') return reject('FORBIDDEN', 'coordinator only');
  if (!validTaskId(action.taskId)) return reject('INVALID_ARGUMENT', 'invalid delivery taskId');
  if (!owner) return reject('NOT_FOUND', 'owner is not a member');
  if (owner.status === 'killed') return reject('CLOSED', 'owner is killed');
  if (owner.role === 'coordinator') return reject('FORBIDDEN', 'the reviewer cannot own a delivery');
  const deliverable = text(action.deliverable, 1024);
  const criterion = text(action.criterion, 1024);
  if (!deliverable || !criterion) {
    return reject('INVALID_ARGUMENT', 'deliverable and criterion must be nonempty bounded text');
  }
  if (draft.deliveries.some((item) => item.taskId === action.taskId)) {
    return reject('INVALID_STATE', 'delivery taskId already assigned');
  }
  if (draft.deliveries.length >= MAX_DELIVERIES) return reject('LIMIT', 'delivery task limit reached');
  const delivery = {
    taskId: action.taskId, owner: owner.sessionId, deliverable, criterion,
    status: 'assigned', updatedAt: draft.clock, submission: null, review: null,
  };
  draft.deliveries.push(delivery);
  return receipt(delivery);
}

// Shared with the external mailbox. Return only the supplied reference fields;
// callers may apply stricter path rules, but neither surface resolves or opens them.
export function submissionRefs(version, path, commit) {
  if (commit !== undefined) {
    if (version !== undefined || path !== undefined || typeof commit !== 'string' || !/^[a-f0-9]{7,64}$/i.test(commit)) return null;
    return { artifactCommit: commit };
  }
  const artifactPath = text(path, 512);
  if (!artifactPath || /[\t\n\r]/u.test(path)) return null;
  if (version === undefined) return { artifactPath };
  const artifactVersion = text(version, 160);
  if (!artifactVersion || /[\t\n\r]/u.test(version)) return null;
  return { artifactVersion, artifactPath };
}

function recordedRefs({ artifactVersion, artifactPath, artifactCommit }) {
  const refs = submissionRefs(artifactVersion, artifactPath, artifactCommit);
  // v1 version+path receipts retain their exact original shape.
  if (!refs || refs.artifactVersion !== undefined) return refs;
  return { refKind: refs.artifactCommit !== undefined ? 'commit' : 'path', ...refs };
}

export function submitDelivery(draft, actor, action) {
  if (!validTaskId(action.taskId)) return reject('INVALID_ARGUMENT', 'invalid delivery taskId');
  const delivery = draft.deliveries.find((item) => item.taskId === action.taskId);
  if (actor.role === 'coordinator') return reject('FORBIDDEN', 'delivery owner only');
  if (!delivery || delivery.owner !== actor.sessionId) return reject('NOT_FOUND', 'no such delivery in your scope');
  if (!['assigned', 'returned', 'submitted'].includes(delivery.status)) {
    return reject('INVALID_STATE', 'delivery is not open for submission');
  }
  const refs = recordedRefs(action);
  if (!refs) return reject('INVALID_ARGUMENT', 'submit a path (with optional version) or a 7–64 digit hex commit');
  const seq = (delivery.submission?.seq ?? 0) + 1;
  if (!Number.isSafeInteger(seq)) return reject('LIMIT', 'delivery submission sequence exhausted');
  // A fresh submission has no verdict. Keep the last consumed return separately
  // so that the owner and lead can compare it with this attempt, even on v1 boards.
  if (delivery.review?.decision === 'returned') delivery.lastReturn = delivery.review;
  delivery.submission = { seq, ...refs };
  delivery.review = null;
  delivery.status = 'submitted';
  delivery.updatedAt = draft.clock;
  return receipt(delivery);
}

export function reviewDelivery(draft, actor, action) {
  if (actor.role !== 'coordinator') return reject('FORBIDDEN', 'coordinator only');
  if (!validTaskId(action.taskId)) return reject('INVALID_ARGUMENT', 'invalid delivery taskId');
  const delivery = draft.deliveries.find((item) => item.taskId === action.taskId);
  if (!delivery) return reject('NOT_FOUND', 'delivery task not found');
  if (delivery.status !== 'submitted') return reject('INVALID_STATE', 'delivery has no pending submission');
  const { submittedSeq, decision, checkPassed } = action;
  if (!Number.isSafeInteger(submittedSeq) || submittedSeq < 1) {
    return reject('INVALID_ARGUMENT', 'submittedSeq must be a positive integer');
  }
  const { seq, ...refs } = delivery.submission;
  if (submittedSeq !== seq || ['artifactVersion', 'artifactPath', 'artifactCommit'].some(
    field => action[field] !== undefined && action[field] !== refs[field],
  )) {
    return reject('INVALID_STATE', 'review does not match the pending submission');
  }
  if (decision !== 'accepted' && decision !== 'returned') {
    return reject('INVALID_ARGUMENT', 'decision must be accepted or returned');
  }
  if (typeof checkPassed !== 'boolean' || (decision === 'accepted' && !checkPassed)) {
    return reject('INVALID_ARGUMENT', 'explicit checkPassed required; failed checks cannot be accepted');
  }
  const evidence = text(action.evidence, 1024);
  if (!evidence) return reject('INVALID_ARGUMENT', 'manual review evidence must be nonempty bounded text');
  delivery.review = { submittedSeq, ...refs, decision, checkPassed, evidence, reviewer: actor.sessionId };
  delivery.status = decision;
  delivery.updatedAt = draft.clock;
  return receipt(delivery);
}

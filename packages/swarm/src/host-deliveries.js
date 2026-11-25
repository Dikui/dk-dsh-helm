import { failure } from './host-format.js';

// Detail reads are per task. List pages deliberately omit paths, evidence and host IDs.
export function listDeliveries(entry, { taskId, offset = 0 } = {}) {
  const items = (entry.board.deliveries ?? []).filter(d => entry.isRoot || d.owner === entry.self.sessionId);
  if (taskId !== undefined) {
    const item = items.find(d => d.taskId === taskId);
    if (!item) throw failure('NOT_FOUND', 'no such delivery in your scope');
    return { ok: true, delivery: publicDelivery(entry.board, item) };
  }
  if (!Number.isSafeInteger(offset) || offset < 0) throw failure('INVALID_ARGUMENT', 'offset must be a non-negative integer');
  return { ok: true, total: items.length, items: items.slice(offset, offset + 20).map(d => ({ taskId:d.taskId,
    owner:entry.board.members[d.owner]?.name, status:d.status, submittedSeq:d.submission?.seq ?? null })),
    nextOffset: offset + 20 < items.length ? offset + 20 : null };
}

export function publicDelivery(board, item) {
  return { ...item, owner:board.members[item.owner]?.name, review:item.review ? {
    ...item.review, reviewer:board.members[item.review.reviewer]?.name ?? 'lead' } : null };
}

export async function changeDelivery(host, entry, action, args) {
  if (action !== 'submit' && !entry.isRoot) throw failure('FORBIDDEN', 'only the lead assigns and reviews');
  let input;
  if (action === 'assign') {
    const owner = Object.values(entry.board.members).find(m => m.name.toLowerCase() === String(args.owner).toLowerCase());
    if (!owner) throw failure('NOT_FOUND', 'member not found');
    input = { type:'assignDelivery', owner:owner.sessionId, deliverable:args.deliverable, criterion:args.criterion };
  } else if (action === 'review') {
    input = { type:'reviewDelivery', submittedSeq:args.submittedSeq, decision:args.decision, checkPassed:args.checkPassed, evidence:args.evidence };
  } else if (action === 'submit') {
    input = { type:'submitDelivery', artifactPath:args.artifactPath, artifactVersion:args.artifactVersion };
  } else throw failure('INVALID_ARGUMENT', 'unknown delivery action');
  const { result } = await host.state.act(entry.rootId, entry.self.sessionId, { ...input, taskId:args.taskId });
  if (!result.ok) throw failure(result.code, result.message);
  const d = result.delivery;
  // Notification is advisory; do not report a committed mutation as failed if the recipient is offline.
  const target = entry.board.members[d.owner];
  const root = host.state.rootAgent(entry.rootId);
  const notice = `[Swarm] Delivery ${d.taskId}: ${d.status}. Use swarm_delivery(action=list, taskId=${JSON.stringify(d.taskId)}) for the exact contract and submission.`;
  let notified = false;
  try {
    if (action === 'submit') notified = await host.steerRoot(entry.rootId, notice, 'Swarm delivery submitted');
    else if (root && target && !target.externalMailbox && !['paused','killed'].includes(target.status)) {
      await host.sendMember(root, target.sessionId, [{type:'text', text:notice}], { signal:host.lifecycle.signal });
      notified = true;
    }
  } catch { /* Durable list remains the source of truth. */ }
  return { ok:true, delivery:publicDelivery(entry.board, d), notified };
}

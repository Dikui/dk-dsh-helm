import { createHash } from 'node:crypto';
import { canSeeChannel } from './channels.js';

// Hash only the canonical operation, never the identity, host or envelope metadata.
export function requestDigest(r) {
  const fields = r.op === 'submit' ? ['submit',r.taskId,r.after ?? 0,r.artifactVersion ?? null,r.artifactPath ?? null,r.artifactCommit ?? null] : ['post',r.channel ?? 'main',r.text];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A finite, non-evicting ledger. Forgetting old UUIDs would make a replay a new write.
// Rotate to a newly authorized seat once full; old inputs never acquire the new identity.
export function externalRequest(draft, actor, request, now, transition) {
  const reject = (code, message) => ({ok:false, code, message});
  if (!actor?.externalMailbox || actor.role !== 'worker') return reject('FORBIDDEN','external worker required');
  if (!request || typeof request.id !== 'string' || !UUID.test(request.id)) return reject('INVALID_ARGUMENT','invalid external request ID');
  const receipts = actor.externalReceipts;
  const digest = requestDigest(request);
  if (Object.hasOwn(receipts, request.id)) {
    const previous = receipts[request.id];
    if (previous.digest !== digest) return reject('ID_CONFLICT','request ID already used');
    return {result:{ok:true, receipt:previous.receipt, replay:true}, wakes:[]};
  }
  if (Object.keys(receipts).length >= 512) return reject('LIMIT','external seat receipt limit reached');
  let input, denial;
  if (request.op === 'post') {
    const channel = request.channel ?? 'main';
    if (!canSeeChannel(actor, channel)) denial = 'NOT_FOUND';
    input = {type:'post', text:request.text, channel};
  } else if (request.op === 'submit') {
    const own = draft.deliveries.find(d => d.taskId === request.taskId && d.owner === actor.sessionId);
    if (!own) denial = 'NOT_FOUND';
    else if ((request.after ?? 0) !== (own.submission?.seq ?? 0)) denial = 'STALE_SUBMISSION';
    input = {type:'submitDelivery', taskId:request.taskId, artifactPath:request.artifactPath,
      artifactVersion:request.artifactVersion, artifactCommit:request.artifactCommit};
  } else return reject('INVALID_ARGUMENT','unsupported external operation');
  // Bind authorization, expected revision, mutation and its receipt in one board write.
  const next = denial ? {result:{ok:false,code:denial},wakes:[]} : transition(draft, actor.sessionId, {...input, now});
  const receipt = next.result.ok ? {ok:true, seq:next.result.seq ?? next.result.delivery.submission.seq} : {ok:false, code:next.result.code};
  if (next.result.ok) Object.assign(draft, next.state);
  draft.members[actor.sessionId].externalReceipts[request.id] = {digest, receipt};
  return {result:{ok:true, receipt}, wakes:next.wakes};
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A finite, non-evicting ledger. Forgetting old UUIDs would make a replay a new write.
// Rotate to a newly authorized seat once full; old inputs never acquire the new identity.
export function externalRequest(draft, actor, request, now, transition) {
  const reject = (code, message) => ({ok:false, code, message});
  if (!actor?.externalMailbox || actor.role !== 'worker') return reject('FORBIDDEN','external worker required');
  if (!request || typeof request.id !== 'string' || !UUID.test(request.id)) return reject('INVALID_ARGUMENT','invalid external request ID');
  const receipts = actor.externalReceipts;
  if (Object.hasOwn(receipts, request.id)) return {result:{ok:true, receipt:receipts[request.id], replay:true}, wakes:[]};
  if (Object.keys(receipts).length >= 512) return reject('LIMIT','external seat receipt limit reached');
  const input = request.op === 'post' ? {type:'post', text:request.text, channel:request.channel} : request.op === 'submit' ?
    {type:'submitDelivery', taskId:request.taskId, artifactPath:request.artifactPath, artifactVersion:request.artifactVersion} : null;
  if (!input) return reject('INVALID_ARGUMENT','unsupported external operation');
  // Derive actor and action here, never from a supplied role/author/memberId/type.
  const next = transition(draft, actor.sessionId, {...input, now});
  const receipt = next.result.ok ? {ok:true, seq:next.result.seq ?? next.result.delivery.submission.seq} : {ok:false, code:next.result.code};
  if (next.result.ok) Object.assign(draft, next.state);
  draft.members[actor.sessionId].externalReceipts[request.id] = receipt;
  return {result:{ok:true, receipt}, wakes:next.wakes};
}

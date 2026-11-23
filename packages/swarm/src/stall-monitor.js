// One non-blocking host clock serves every board. An alert is a suggestion,
// never a command to spawn/restart a member or a proof that the team is stuck.
export function diagnoseStall(board) {
  if (!board || board.done === true) return null;
  const members = Object.values(board.members), lead = members.find(m=>m.role==='coordinator');
  const remaining = members.filter(m=>m.role==='worker' && m.status!=='killed');
  if (!lead || !remaining.length || remaining.some(m=>!['waiting','stopped','paused'].includes(m.status))) return null;
  const tail = board.posts.filter(p=>p.kind==='post');
  if (!tail.length || tail.some(p=>p.sessionId===board.rootId && p.channel==='main' && /^\[done\](?:\s|$)/i.test(p.text) && !/@/.test(p.text))) return null;
  const latest=tail.at(-1), pending=board.pendingWakes?.find(w=>w.attempts>0), quota=remaining.find(m=>m.status==='paused');
  let reason, note;
  if (quota) {reason='paused';note=`${quota.name} is paused. Inspect the quota or pause reason before resuming.`;}
  else if (pending) {reason='delivery';note=`Doorbell #${pending.seq} has an unacknowledged delivery attempt.`;}
  else if (tail.some(p=>p.seq>lead.lastReadSeq && p.targets?.includes(lead.name))) {reason='lead';note=`${lead.name} has an unread directed reply. Read the board before dispatching more work.`;}
  else if (latest.sessionId!==board.rootId && latest.channel==='main' && latest.seq>lead.lastReadSeq) {reason='result';note=`The latest worker post (#${latest.seq}) may need a coordinator decision.`;}
  else {reason='waiting';note='All remaining workers are parked or stopped. Check whether anyone owns the next action.';}
  return {key:`${board.seq}:${reason}`, message:`[Swarm monitor] ${note} Inspect /swarm status. This is a stall hint, not a request to restart workers.`};
}

export function startStallMonitor({list,notify,onError=()=>{},setTimer=setInterval,clearTimer=clearInterval}) {
  let active=true, processing=false;const sent=new Map();
  const timer=setTimer(async()=>{
    if (!active || processing) return;
    processing=true;
    try {
      const boards=await list(), seen=new Set();
      for (const b of boards) {
        if (!active) break;
        seen.add(b.rootId);
        try {
          const hint=diagnoseStall(b);
          if (hint && sent.get(b.rootId)!==hint.key && await notify(b.rootId,hint.message)===true && active) sent.set(b.rootId,hint.key);
        } catch(e){onError(e);}
      }
      for(const id of sent.keys()) if(!seen.has(id)) sent.delete(id);
    } catch(e){onError(e);} finally{processing=false;}
  },180000);
  timer.unref?.(); return ()=>{if(active){active=false;clearTimer(timer);sent.clear();}};
}

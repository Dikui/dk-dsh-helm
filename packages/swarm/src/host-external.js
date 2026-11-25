import { randomUUID } from 'node:crypto';
import { isValidMemberName } from './channels.js';
import { failure } from './host-format.js';
import { publicDelivery } from './host-deliveries.js';
import { visibleDeliveries } from './deliveries.js';
import { createMailbox, syncMailbox } from './external-bridge.js';

// No listener or shell. The human chooses the directory; models cannot provision or sync seats.
export async function addExternal(host, agent, name, baseDir, signal) {
  const {rootId} = host.ensureRoot(agent);
  if (!isValidMemberName(name)) throw failure('INVALID_NAME', 'invalid external member name');
  if (host.state.memberByName(rootId, name)) throw failure('DUPLICATE_NAME', 'member name is taken');
  const sessionId = `seat-${randomUUID()}`;
  const guard = host.beginInflightAdd(rootId, sessionId);
  try {
    signal?.throwIfAborted();
    const mailbox = await createMailbox(baseDir);
    signal?.throwIfAborted();
    if (guard.cancelled || host.disposed) throw host.cancelledAdd(guard);
    const {result} = await host.state.act(rootId, rootId, {type:'addExternal', sessionId, name, mailbox});
    if (!result.ok) throw failure(result.code, result.message);
    return {name, mailbox};
  } finally { host.endInflightAdd(guard); }
}

export async function syncExternal(host, agent, name) {
  const {rootId} = host.ensureRoot(agent);
  const seat = host.state.memberByName(rootId, name);
  if (!seat?.externalMailbox) throw failure('NOT_FOUND', 'external seat not found');
  const current = () => {
    const board = host.state.board(rootId);
    const member = board?.members?.[seat.sessionId];
    if (host.disposed || !member || ['killed','paused'].includes(member.status)) throw failure('CLOSED', 'seat inactive');
    return {board, member};
  };
  current();
  return syncMailbox(seat.externalMailbox, {
    snapshot() {
      const {board, member} = current();
      const posts = host.state.api.visiblePosts(board, member, {since:0});
      return {v:1, name:member.name, channels:member.channels, seq:board.seq,
        messages:posts.slice(-32).map(({seq,name:author,channel,text}) => ({seq,author,channel,text})),
        earlierVisiblePosts:Math.max(0, posts.length-32),
        deliveries:visibleDeliveries(board, member).map(d => publicDelivery(board,d))};
    },
    async consume(request) {
      current();
      const {result, wakes} = await host.state.act(rootId, seat.sessionId, {type:'externalRequest', request});
      if (!result.ok) return {ok:false, code:result.code};
      if (wakes.length) await host.dispatchWakes(rootId, wakes);
      if (!result.replay && result.receipt.ok && request.op === 'submit') {
        try { await host.steerRoot(rootId, `[Swarm] ${name} submitted ${request.taskId}, revision ${result.receipt.seq}. Inspect /swarm deliveries before review.`, 'External delivery submitted'); } catch { /* The board is authoritative. */ }
      }
      return result.receipt;
    },
  });
}

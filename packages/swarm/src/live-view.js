import { createHash } from 'node:crypto';
import { buildPublicView } from './host-view.js';

// BoardState replaces committed boards rather than editing them in place. An
// unchanged poll should not rescan posts or recompute unread counts. Only keep
// bounded *public* history for resuming; a cache miss is always a full snapshot.
export function createLiveReader(options = {}) {
  const projections = new WeakMap();
  const history = new Map();
  const historyLimit = 64;

  function project(board) {
    let record = projections.get(board);
    if (!record) {
      const view = buildPublicView(board, options);
      // seq alone misses status/read-cursor and plan changes. Namespace the tag
      // by root and hash the entire public projection, never private state.
      const etag = createHash('sha256').update(JSON.stringify([board.rootId, view])).digest('hex');
      record = { rootId: board.rootId, etag, view };
      projections.set(board, record);
    }
    if (!history.has(record.etag)) {
      history.set(record.etag, record);
      if (history.size > historyLimit) history.delete(history.keys().next().value);
    }
    return record;
  }

  return function read(board, cursor) {
    if (!board) return { kind: 'empty' };
    const { etag, view } = project(board);
    const full = () => ({ kind: 'snapshot', etag, view });
    if (!cursor || !Number.isSafeInteger(cursor.since) || cursor.since < 0) return full();
    if (cursor.etag === etag && cursor.since === view.seq) return { kind: 'unchanged', etag };

    const previous = history.get(cursor.etag);
    if (!previous || previous.rootId !== board.rootId) return full();
    const base = previous.view;
    if (base.seq !== cursor.since || view.seq < base.seq) return full();
    const firstSeq = view.messages[0]?.seq ?? null;
    const retained = firstSeq === null ? [] : base.messages.filter(m => m.seq >= firstSeq);
    const overlap = view.messages.filter(m => m.seq <= base.seq);
    // A smaller plan/roster can free space in the bounded projection and make
    // older posts reappear. Only send a delta when it reconstructs the exact view.
    if (JSON.stringify(retained) !== JSON.stringify(overlap)) return full();
    return {
      kind: 'delta', etag, baseEtag: cursor.etag, firstSeq,
      view: { ...view, messages: view.messages.slice(overlap.length) },
    };
  };
}

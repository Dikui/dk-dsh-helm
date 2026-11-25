import { evaluateBoardAlerts } from './board-clock.js';
export { diagnoseStall } from './board-clock.js';

// One non-blocking host clock for all boards. Notify the root, and only persist a
// receipt on confirmed delivery. With no store adapter, retain legacy in-memory
// deduplication; never use that cache in place of a failed persistent write.
export function startStallMonitor({
  list, notify, ack, now = Date.now, onError = () => {}, setTimer = setInterval, clearTimer = clearInterval,
}) {
  let active = true, processing = false;
  const sent = new Map();
  const timer = setTimer(async () => {
    if (!active || processing) return;
    processing = true;
    try {
      const boards = await list();
      const seen = new Set();
      for (const board of boards) {
        if (!active) break;
        try {
          const { rootId } = board;
          seen.add(rootId);
          const local = sent.get(rootId) ?? {};
          for (const alert of evaluateBoardAlerts(board, now())) {
            if (!active) break;
            if (!ack && local[alert.kind] === alert.key) continue;
            try {
              if (await notify(rootId, alert.message) !== true || !active) continue;
              if (ack) await ack(rootId, alert);
              else {
                local[alert.kind] = alert.key;
                sent.set(rootId, local);
              }
            } catch (error) { onError(error); }
          }
        } catch (error) { onError(error); }
      }
      for (const id of sent.keys()) if (!seen.has(id)) sent.delete(id);
    } catch (error) { onError(error); }
    finally { processing = false; }
  }, 180000);
  timer.unref?.();
  return () => {
    if (!active) return;
    active = false;
    clearTimer(timer);
    sent.clear();
  };
}

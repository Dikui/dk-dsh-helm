import { z } from 'zod';

// Single-host transaction boundary. The entire board/campaign is one record, so
// appending a message and moving its wake watermark can never split across writes.
const record = z.record(z.string(), z.json());
const spec = { name: 'dk_swarm', version: 1, layout: 'per-record', tables: { runs: {valueSchema: record} } };
export async function openStore(ctx) {
  const domain = await ctx.storageDomain.open(spec), table = domain.table('runs');
  const tails = new Map(); let closing;
  return {
    get: key => structuredClone(table.get(key)),
    entries: () => Array.from(table.entries(), ([key, state]) => [key, structuredClone(state)]),
    transact(key, fn) {
      if (closing) return Promise.reject(new Error('Coordination store is closing'));
      if (typeof key !== 'string' || !key || key.length>256) return Promise.reject(new Error('Invalid session key'));
      const work = (tails.get(key) ?? Promise.resolve()).then(async () => {
        const next = fn(structuredClone(table.get(key)));
        if (next && typeof next.then === 'function') { Promise.resolve(next).catch(()=>{}); throw new TypeError('Transaction callback must be synchronous'); }
        // Domain validates cold reads, not writes. Validate before publishing.
        const state = record.parse(next?.state);
        await table.put(key, state);
        return next.result;
      });
      const settled = work.then(()=>{}, ()=>{});
      tails.set(key, settled);
      void settled.then(()=>{ if (tails.get(key)===settled) tails.delete(key); });
      return work;
    },
    close() {
      return closing ??= Promise.all([...tails.values()]).then(() => domain.close());
    },
  };
}

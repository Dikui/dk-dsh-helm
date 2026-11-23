// Test-only in-memory store with the same transaction contract as the
// production openStore: transact() persists the returned state and resolves
// only the callback's result.
export function createMemoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  const tails = new Map();

  const clone = value => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

  return {
    async get(key) {
      return clone(map.get(key) ?? null);
    },
    async entries() {
      return [...map.entries()].map(([key, state]) => [key, clone(state)]);
    },
    transact(key, fn) {
      const work = (tails.get(key) ?? Promise.resolve()).then(async () => {
        const current = clone(map.get(key));
        const next = fn(current);
        if (next && typeof next.then === 'function') {
          throw new TypeError('Transaction callback must be synchronous');
        }
        if (!next || typeof next !== 'object' || !('state' in next)) {
          throw new TypeError('Transaction callback must return { state, result }');
        }
        const state = clone(next.state);
        // Production schema is JSON-only; fail loudly on undefined/NaN here too.
        JSON.stringify(state, (_key, value) => {
          if (typeof value === 'number' && !Number.isFinite(value)) {
            throw new TypeError('state contains a non-finite number');
          }
          if (typeof value === 'undefined') {
            throw new TypeError('state contains undefined');
          }
          return value;
        });
        map.set(key, state);
        return next.result;
      });
      const settled = work.then(() => {}, () => {});
      tails.set(key, settled);
      void settled.then(() => {
        if (tails.get(key) === settled) tails.delete(key);
      });
      return work;
    },
    async close() {
      await Promise.all([...tails.values()]);
    },
  };
}

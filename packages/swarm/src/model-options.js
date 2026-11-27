const KEY = 'settings:model-options';
export const MAX_MODEL_OPTIONS = 16;

const PROVIDER = /^[a-z0-9][a-z0-9._@-]{0,63}$/i;
const MODEL = /^[^\s\u0000-\u001f\u007f]{1,200}$/;

function invalid(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' });
}

/**
 * Validate and copy a candidate route list. Routes are only a convenience for
 * the dispatch UI: they never grant a Session access to a model, and a route
 * that is not selectable by the current policy must still be rejected by the
 * normal dispatch validation.
 *
 * @param {unknown} input
 * @returns {{provider: string, model: string}[]}
 */
export function normalizeModelOptions(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw invalid('model options must be an array');
  if (input.length > MAX_MODEL_OPTIONS) {
    throw invalid(`at most ${MAX_MODEL_OPTIONS} model options are allowed`);
  }
  const seen = new Set();
  return input.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalid(`model option ${index + 1} must be an object`);
    }
    const keys = Object.keys(entry);
    if (keys.some(key => key !== 'provider' && key !== 'model')) {
      throw invalid(`model option ${index + 1} has an unknown field`);
    }
    const { provider, model } = entry;
    if (typeof provider !== 'string' || !PROVIDER.test(provider)) {
      throw invalid(`model option ${index + 1} has an invalid provider`);
    }
    if (typeof model !== 'string' || !MODEL.test(model)) {
      throw invalid(`model option ${index + 1} has an invalid model`);
    }
    const route = `${provider}/${model}`;
    if (seen.has(route)) throw invalid(`duplicate model option: ${route}`);
    seen.add(route);
    return { provider, model };
  });
}

/**
 * Profile-level candidate list kept beside the board store. The key is not a
 * session id, so the same list is visible from every conversation; the form's
 * save path is a single transaction, like a board write.
 *
 * @param {{ get: (key: string) => unknown, transact: (key: string, fn: () => unknown) => Promise<unknown> }} store
 */
export function createModelOptions(store) {
  return {
    read() {
      const state = store.get(KEY);
      return normalizeModelOptions(state?.options);
    },
    async write(options) {
      const normalized = normalizeModelOptions(options);
      await store.transact(KEY, () => ({ state: { options: normalized }, result: normalized }));
      return normalized;
    },
  };
}

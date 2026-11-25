import { assertRouteAllowed, ROUTE_ERRORS } from './model-routes.js';

const outcome = status => ({ ok: status === 'ok', status });

// Native finish failures and thrown LlmError.failure use the same taxonomy.
// Never echo error.message, request IDs, response text or arbitrary extension codes.
function failureStatus(failure) {
  switch (failure?.code) {
    case 'QUOTA': case 'ACCOUNT_QUOTA': return 'quota';
    case 'CAPACITY': return 'capacity';
    case 'TIMEOUT': return 'timeout';
    case 'RATE_LIMIT': return 'rate_limit';
    case 'ABORTED': return 'cancelled';
    case 'AUTH': case 'MISSING_CREDENTIAL': case 'INVALID_CREDENTIAL':
    case 'NO_CREDENTIAL_STORE': case 'ACCOUNT_SIGN_IN_REQUIRED': case 'ACCOUNT_TOKEN_INVALID': return 'auth';
    case 'NO_ADAPTER': case 'UNKNOWN_MODEL': case 'MODEL_UNSUPPORTED': return 'unavailable';
  }
  const code = failure?.code;
  const status = failure?.status ?? (typeof code === 'string' && /^HTTP_\d{3}$/.test(code) ? Number(code.slice(5)) : undefined);
  switch (status) {
    case 401: case 403: return 'auth';
    case 402: return 'quota';
    case 408: case 504: return 'timeout';
    case 429: return 'rate_limit';
    case 503: case 529: return 'capacity';
    default: return 'failed';
  }
}

async function dispatch(llm, route, rootAgent, signal) {
  const prepared = await llm.prepareCall({ ...route, maxTokens: 1 }, signal, (controls, model) => {
    const least = model.reasoning?.efforts[0];
    return least ? { ...controls, reasoningEffort: least.id } : controls;
  });
  signal.throwIfAborted(); // No late paid dispatch, even if preparation ignored cancellation.
  assertRouteAllowed(route, { rootAgent }); // The parent's current route may have changed.
  const config = prepared.config;
  if (config?.provider !== route.provider || config.model !== route.model || config.maxTokens !== 1) return 'unavailable';
  const stream = prepared.stream({ ...route, reasoningEffort: config.reasoningEffort, maxTokens: 1, signal,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'OK' }] }],
  });
  for await (const chunk of stream) {
    signal.throwIfAborted();
    if (chunk.type !== 'finish') continue;
    switch (chunk.reason.kind) {
      case 'stop': case 'max-tokens': return 'ok';
      case 'aborted': return 'cancelled';
      case 'error': return failureStatus(chunk.reason.failure);
      default: return 'failed';
    }
  }
  return 'failed';
}

const DEFAULT_TIMEOUT_MS = 15_000;
const inFlight = new Set();

async function boundedDispatch(llm, route, rootAgent, parentSignal, timeoutMs) {
  const sessionId = rootAgent.session.id;
  if (typeof sessionId !== 'string' || !sessionId) return 'policy_unavailable';
  const key = JSON.stringify([sessionId, route.provider, route.model]);
  if (inFlight.has(key)) return 'in_progress';
  const controller = new AbortController();
  let settle;
  const stopped = new Promise(resolve => { settle = resolve; });
  const stop = status => {
    settle(status);
    controller.abort();
  };
  const cancel = () => stop('cancelled');
  parentSignal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  try {
    inFlight.add(key);
    // The caller may already have timed out while the adapter is still billing.
    // Release the reservation on actual settlement, not on the caller's deadline.
    const attempt = dispatch(llm, route, rootAgent, controller.signal).finally(() => inFlight.delete(key));
    return await Promise.race([attempt, stopped]);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', cancel);
  }
}

/** Host-only; explicit confirmation belongs to a human command, never a model tool. */
export async function probeModelRoute({ llm, rootAgent, route, confirmPaid, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (confirmPaid !== true) return outcome('confirmation_required');
  try {
    const allowed = assertRouteAllowed(route, { rootAgent });
    if (typeof llm?.prepareCall !== 'function') return outcome('unavailable');
    if (signal?.aborted) return outcome('cancelled');
    const budget = Number.isSafeInteger(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 60_000)) : DEFAULT_TIMEOUT_MS;
    return outcome(await boundedDispatch(llm, allowed, rootAgent, signal, budget));
  } catch (error) {
    switch (error?.code) {
      case ROUTE_ERRORS.INVALID: return outcome('invalid_route');
      case ROUTE_ERRORS.NOT_AUTHORIZED: return outcome('not_authorized');
      case ROUTE_ERRORS.POLICY_UNAVAILABLE:
      case ROUTE_ERRORS.POLICY_INVALID: return outcome('policy_unavailable');
      default: return outcome(failureStatus(error?.failure ?? error));
    }
  }
}

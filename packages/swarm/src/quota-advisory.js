// Trusted account-balance advisory for Swarm quota warnings.
//
// DSH exposes exact first-party recharge and bonus wallet amounts through the
// optional `deepseekAccount` service. It exposes no "remaining quota" ratio or
// percentage, so this module never invents one: callers receive exact decimal
// amounts and the wallet/currency they belong to, or an explicit unsupported /
// signed-out / unavailable reason.
//
// No DSH imports live here so the module stays directly testable.

import { oneLine } from './host-format.js'

const DEFAULT_TIMEOUT_MS = 5000
const TIMEOUT = Symbol('balance-timeout')
const ABORTED = Symbol('balance-aborted')

/**
 * Resolve the optional DeepSeek account service without requiring it as a hard
 * dependency. Older hosts simply do not provide it.
 * @param {any} ctx - Swarm host context.
 * @returns {any | null} the account service when present.
 */
export function accountService(ctx) {
  try {
    const service = ctx?.get?.('deepseekAccount')
    if (service) return service
  } catch {
    // Fall through to the direct property for older host shapes.
  }
  return ctx?.deepseekAccount ?? null
}

function clientMetadata(ctx, version) {
  let resolved = typeof version === 'string' && version.trim() ? version.trim() : ''
  if (!resolved) {
    for (const key of ['product', 'app', 'version']) {
      try {
        const candidate = ctx?.get?.(key)
        if (typeof candidate === 'string' && candidate.trim()) {
          resolved = candidate.trim()
          break
        }
        if (candidate && typeof candidate.version === 'string' && candidate.version.trim()) {
          resolved = candidate.version.trim()
          break
        }
      } catch {
        // Ignore absent optional services.
      }
    }
  }
  let locale = 'en'
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en'
  } catch {
    locale = 'en'
  }
  return {
    version: resolved || '0.0.0',
    locale,
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
}

function walletEntries(wallet, list) {
  if (!Array.isArray(list)) return []
  const entries = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const currency = entry.currency
    const amount = entry.balance
    if (typeof currency !== 'string' || !currency) continue
    if (typeof amount !== 'string' || !amount.trim()) continue
    entries.push({ wallet, currency, amount })
  }
  return entries
}

/**
 * Read the host's exact account wallet amounts when the optional service exists.
 *
 * The returned shape is stable for the `/swarm quota` command and the wallet
 * watch:
 * `{ supported, signedIn, balances, reason? }`, where each balance is
 * `{ wallet: 'recharge' | 'bonus', currency, amount }` with the provider's
 * exact decimal string. `balances` is null when no trustworthy snapshot exists.
 *
 * @param {any} ctx - Swarm host context.
 * @param {{signal?: AbortSignal, timeoutMs?: number, version?: string}} [options] - cancellation and identity overrides.
 * @returns {Promise<{supported: boolean, signedIn: boolean | null, balances: Array<{wallet: string, currency: string, amount: string}> | null, reason?: string}>} advisory snapshot.
 */
export async function readQuotaAdvisory(ctx, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, version } = {}) {
  const service = accountService(ctx)
  if (!service || typeof service.getBalance !== 'function') {
    return {
      supported: false,
      signedIn: null,
      balances: null,
      reason: 'this host does not expose a DeepSeek account balance (getBalance); no quota percentage is available',
    }
  }

  let timer
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(TIMEOUT), Math.max(1, timeoutMs))
    timer.unref?.()
  })
  const aborted = signal
    ? new Promise(resolve => {
      if (signal.aborted) {
        resolve(ABORTED)
        return
      }
      signal.addEventListener('abort', () => resolve(ABORTED), { once: true })
    })
    : undefined

  try {
    const balance = await Promise.race([
      Promise.resolve().then(() => service.getBalance(clientMetadata(ctx, version))),
      timeout,
      ...(aborted ? [aborted] : []),
    ])
    if (balance === TIMEOUT || balance === ABORTED) {
      return {
        supported: true,
        signedIn: null,
        balances: null,
        reason: 'the account balance request did not complete; no quota percentage is available',
      }
    }
    if (balance === null || balance === undefined) {
      return { supported: true, signedIn: false, balances: null, reason: 'not signed in to a DeepSeek account' }
    }
    if (balance.status === 'failed') {
      return { supported: true, signedIn: true, balances: null, reason: 'the DeepSeek account balance is currently unavailable' }
    }
    if (balance.status !== 'ready' || !Array.isArray(balance.value)) {
      return { supported: true, signedIn: true, balances: null, reason: 'the host returned an unrecognized account balance payload' }
    }
    const balances = [
      ...walletEntries('recharge', balance.value),
      ...walletEntries('bonus', balance.bonusWallets),
    ]
    return { supported: true, signedIn: true, balances }
  } catch (error) {
    return {
      supported: true,
      signedIn: null,
      balances: null,
      reason: `the account balance request failed: ${oneLine(error?.message ?? error, 200)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

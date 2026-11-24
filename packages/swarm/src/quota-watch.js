import { failure } from './host-format.js';

// Only compare like-for-like first-party recharge wallets. Promotional credits,
// token counts and rate limits are not a documented account spending limit.
export function parseAlert(currency, threshold) {
  if (!['CNY', 'USD'].includes(currency) || !/^\d{1,9}(?:\.\d{1,6})?$/.test(String(threshold)) || Number(threshold) <= 0) {
    throw failure('INVALID_ARGUMENT', 'use CNY or USD and a positive recharge-wallet amount (up to six decimals)');
  }
  return { currency, threshold: Number(threshold) };
}

export class WalletAlerts {
  constructor(host) { this.host = host; this.alerted = new Map(); this.busy = false; }

  async poll() {
    if (this.busy || this.host.disposed) return;
    const watches = this.host.state.roots().flatMap(rootId => {
      const board = this.host.state.board(rootId);
      return board?.quotaWatch && this.host.state.rootAgent(rootId) && Object.values(board.members).some(m => m.role !== 'coordinator' && m.status !== 'killed')
        ? [{ rootId, watch: board.quotaWatch }] : [];
    });
    if (!watches.length) return;
    this.busy = true;
    try {
      const report = await this.host.quotaAdvisory({ signal: AbortSignal.any([this.host.lifecycle.signal, AbortSignal.timeout(5000)]) });
      if (!report?.supported || !report.signedIn || this.host.disposed) return;
      for (const { rootId, watch } of watches) {
        const current = this.host.state.board(rootId)?.quotaWatch;
        if (!current || current.currency !== watch.currency || current.threshold !== watch.threshold) continue;
        const matching = report.balances?.filter(x => x.wallet === 'recharge' && x.currency === watch.currency);
        if (matching?.length !== 1) continue; // absent/ambiguous is unknown, not zero
        const amount = matching[0].amount;
        if (amount == null || String(amount).trim() === '' || !Number.isFinite(Number(amount))) continue;
        const key = `${watch.currency}:${watch.threshold}`;
        if (Number(amount) > watch.threshold) this.alerted.delete(rootId);
        else if (this.alerted.get(rootId) !== key) {
          const delivered = await this.host.steerRoot(rootId, `DeepSeek account recharge wallet: ${amount} ${watch.currency}, at or below your ${watch.threshold} ${watch.currency} alert. Bonus credits are separate; this is not a remaining-quota percentage.`, 'Swarm balance alert');
          if (delivered) this.alerted.set(rootId, key);
        }
      }
    } finally { this.busy = false; }
  }
}

// js/core/balance-answer.js — the shape every balance answer shares: accounts
// and envelopes in display (array) order with their balance, plus unallocated.
// `balances` and `forecast.balances` both build it here, so the two cannot
// drift apart on rounding, ordering or what the archive filter hides.

import { computeUnallocated } from '../engine/balances.js';
import { round2 } from '../utils.js';

/**
 * @param {{ accounts?: any[], envelopes?: any[] }} data
 * @param {Map<string, number>} accBal  from computeAccountBalances over the lens rows
 * @param {Map<string, number>} envBal  from computeEnvelopeBalances over the same rows
 * @param {{ includeArchived?: boolean }} [opts]
 */
export function balanceAnswer(data, accBal, envBal, { includeArchived = false } = {}) {
  const accounts = (data.accounts || []).filter(Boolean);
  const envelopes = (data.envelopes || []).filter(Boolean);
  const keep = (row) => includeArchived || !row.archived;
  return {
    accounts: accounts.filter(keep).map(a => ({
      id: a.id,
      name: a.name ?? null,
      type: a.type ?? null,
      archived: !!a.archived,
      balance: round2(accBal.get(a.id) ?? 0),
    })),
    envelopes: envelopes.filter(keep).map(e => ({
      id: e.id,
      name: e.name ?? null,
      category: e.category ?? null,
      archived: !!e.archived,
      balance: round2(envBal.get(e.id) ?? 0),
    })),
    // Over every account and envelope, whatever the archive filter hides:
    // it is what the status bar shows, and a filter must not move it.
    unallocated: computeUnallocated(accBal, envBal, data.accounts || null),
  };
}

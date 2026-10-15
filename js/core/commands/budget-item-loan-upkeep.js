// budgetItem.loanUpkeep — a system command, run on load. Keeps each loan
// payment item in step with its loan: a repaid loan's item is disabled, the
// months after a payoff within the year are switched off, and a calculated
// payment follows the schedule (loanPlanUpdates). With nothing to change it
// changes nothing. Returns { updated, repaid } so the caller can announce the
// loans just repaid.

import { ok } from '../result.js';
import { loanPlanUpdates } from '../../engine/loan-schedule.js';
import { monthCountry } from '../month-fields.js';

export default {
  name: 'budgetItem.loanUpkeep',
  summary: 'Keep loan payment plan items in step with their loans: disable a repaid loan\'s item, switch off the months after a payoff, and follow a calculated payment. Returns { updated, repaid: [{ id, description, toAccountId }] }.',
  internal: true,
  input: { type: 'object', properties: {} },
  execute(data, _input, ctx) {
    const updates = loanPlanUpdates({
      budgetItems: data.budgetItems, accounts: data.accounts, transactions: data.transactions,
      today: ctx.now, country: monthCountry(data),
    });
    if (!updates.length) return ok({ changes: {}, value: { updated: 0, repaid: [] } });
    const byId = new Map(updates.map(u => [u.item.id, u.item]));
    const repaid = updates
      .filter(u => u.reason === 'repaid')
      .map(u => ({ id: u.item.id, description: u.item.description ?? null, toAccountId: u.item.to_account_id }));
    return ok({
      changes: { budgetItems: data.budgetItems.map(it => (it && byId.has(it.id) ? byId.get(it.id) : it)) },
      value: { updated: updates.length, repaid },
    });
  },
};

import { it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runCommand, runQuery } from '../js/core/pipeline.js';
import { transactionsPageTxList } from '../js/core/effective-txs.js';
import { makeCtx } from '../js/core/context.js';

const now = new Date(2026, 9, 7, 12);
const ctx = () => makeCtx({ now, newId: () => 'new-tx' });
const fields = { kind: 'account_transfer', transfer_mode: 'target_balance', target_balance: 500,
  account_id: 'income', to_account_id: 'card', payment_day: 25 };
const data = (extra = {}) => ({ accounts: [{ id: 'income', type: 'bank', initialBalance: 1000 },
  { id: 'card', type: 'bank', initialBalance: 180 }], envelopes: [], envelopeTemplates: [],
  budgetItems: [], transactions: [], meta: {}, ...extra });
const command = (d, name, input) => runCommand(registry, d, name, input, ctx());
const query = (d, name, input) => runQuery(registry, d, name, input, ctx());
function saved(extra = {}) {
  const d = data(extra);
  const result = command(d, 'budgetItem.create', fields);
  expect(result.ok).toBe(true);
  return { ...d, ...result.value.changes };
}
it('creates without a fixed amount, accepts a zero target, and preserves it across edits', () => {
  const d = data();
  const result = command(d, 'budgetItem.create', { ...fields, target_balance: 0 });
  expect(result.ok).toBe(true);
  const item = result.value.changes.budgetItems[0];
  expect(item).toMatchObject({ target_balance: 0, default_amount: 0, as_schedule: true });
  const edit = command({ ...d, ...result.value.changes }, 'budgetItem.update', { id: item.id, fields: { description: 'Pay card' } });
  expect(edit.ok).toBe(true);
  expect(edit.value.changes.budgetItems[0].target_balance).toBe(0);
});
it.each([undefined, -1, 1e12])('rejects an invalid target %s', target_balance => {
  const input = { ...fields };
  if (target_balance === undefined) delete input.target_balance;
  else input.target_balance = target_balance;
  expect(command(data(), 'budgetItem.create', input).ok).toBe(false);
});
it('changing back to fixed mode needs a nonzero amount; changing kind clears target fields', () => {
  const d = saved(); const id = d.budgetItems[0].id;
  expect(command(d, 'budgetItem.update', { id, fields: { transfer_mode: 'fixed' } }).ok).toBe(false);
  const fixed = command(d, 'budgetItem.update', { id, fields: { transfer_mode: 'fixed', default_amount: 200 } });
  expect(fixed.ok).toBe(true);
  expect(fixed.value.changes.budgetItems[0]).not.toHaveProperty('target_balance');
  const income = command(d, 'budgetItem.update', { id, fields: { kind: 'income', default_amount: 200 } });
  expect(income.ok).toBe(true);
  expect(income.value.changes.budgetItems[0]).not.toHaveProperty('transfer_mode');
});
it('uses full planned spending for editor, upcoming, ledger and forecast balance estimates', () => {
  const d = saved({ budgetItems: [{ id: 'spend', kind: 'expense', account_id: 'card', default_amount: -100,
    as_schedule: false, include: true, payment_day: 20, funding_style: 'bill', monthly_schedule: { Oct: true } }] });
  const id = d.budgetItems.at(-1).id;
  const preview = query(d, 'transfer.preview', { id });
  expect(preview.ok).toBe(true);
  expect(preview.value).toMatchObject({ today: { amount: 320 }, next: { amount: 420, date: '2026-10-25' } });
  const upcoming = query(d, 'upcoming', { days: 30 });
  expect(upcoming.ok).toBe(true);
  expect(upcoming.value.coming.find(r => r.forecast_budget_item_id === id).amount).toBe(420);
  const ledger = transactionsPageTxList({ ...d, today: now, showScheduled: true });
  expect(ledger.find(r => r.forecast_budget_item_id === id).amount).toBe(420);
  const charged = query(d, 'forecast.balances', { date: '2026-10-25' });
  const none = query(d, 'forecast.balances', { date: '2026-10-25', charge: 'none' });
  expect(charged.ok && none.ok).toBe(true);
  expect(charged.value.accounts.find(a => a.id === 'card').balance).toBe(500);
  expect(none.value.accounts.find(a => a.id === 'card').balance).toBe(500);
  expect(charged.value.accounts.find(a => a.id === 'income').balance).toBe(580);
  expect(none.value.accounts.find(a => a.id === 'income').balance).toBe(680);
});
it('records extra top-ups from actual balances without consuming the next occurrence and repeated clicks do nothing', () => {
  const d = saved(); const id = d.budgetItems[0].id;
  const first = command(d, 'budgetItem.topUp', { id });
  expect(first.ok).toBe(true);
  expect(first.value.value).toMatchObject({ amount: 320, fundingShortfall: 0 });
  expect(first.value.value.row).not.toHaveProperty('from_budget');
  const after = { ...d, ...first.value.changes };
  const again = command(after, 'budgetItem.topUp', { id });
  expect(again.ok).toBe(true);
  expect(again.value.value).toMatchObject({ amount: 0, row: null });
  expect(again.value.changes).toEqual({});
  expect(query(after, 'transfer.preview', { id }).value.next.amount).toBe(0);
});
it('scheduled posting is idempotent through month.start and does not change net worth', () => {
  const d = saved({ budgetItems: [] });
  const result = command(d, 'month.start', { date: '2026-10-25' });
  expect(result.ok).toBe(true);
  expect(result.value.changes.transactions.filter(r => r.type === 'account_transfer')).toMatchObject([{ amount: 320 }]);
  const after = { ...d, ...result.value.changes };
  expect(command(after, 'month.start', { date: '2026-10-25' }).value.value.posted).toBe(0);
  expect(query(d, 'netWorth.current', {}).value).toEqual(query(after, 'netWorth.current', {}).value);
});

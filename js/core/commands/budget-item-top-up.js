import { ok, fail } from '../result.js';
import { isTargetTransfer } from '../../engine/target-transfers.js';
import { checkItem } from '../entity-fields.js';
import { currentTransferPreview } from '../queries/transfer-preview.js';

export default {
  name: 'budgetItem.topUp',
  summary: 'Record an extra top-up now using a saved target-balance transfer rule and today\'s posted balances. Does not consume its next scheduled occurrence. Returns { amount, fundingShortfall, row }; when nothing is needed row is null and nothing is written. Records a ledger entry; does not send money through a bank.',
  input: { type: 'object', required: ['id'], properties: { id: { type: 'ref', kind: 'budgetItem' } } },
  execute(data, { id }, ctx) {
    const item = data.budgetItems.find(it => it.id === id);
    if (!isTargetTransfer(item)) return fail('bad_input', { errors: [{ path: 'id', message: 'must name a target-balance transfer' }] });
    const bad = checkItem(item, data);
    if (bad) return fail(bad.code, bad.params);
    const { amount, fundingShortfall } = currentTransferPreview(data, item, ctx.todayIso);
    if (!amount) return ok({ changes: {}, value: { amount, fundingShortfall, row: null } });
    const stamp = ctx.now.toISOString();
    const row = {
      id: ctx.newId(), type: 'account_transfer', date: ctx.todayIso, status: 'posted', cleared: false,
      amount, from_account: item.account_id, to_account: item.to_account_id, envelope_id: null,
      payee: item.description || 'Transfer', note: null,
      created_at: stamp, modified_at: stamp,
    };
    return ok({ changes: { transactions: [...data.transactions, row] }, value: { amount, fundingShortfall, row } });
  },
};

import { assignShortCode } from '../short-codes.js';
import { isSpendingAccount } from '../../engine/balances.js';
// account.update — set an account's fields. A changed name must be unique
// (an unchanged one may stay a duplicate). Values are stored as the form
// stores them. With `type` given (the form always sends it), fields that do
// not belong to the resulting type are dropped; without it, only the given
// fields change (applyAccountFields).
//
// A type change across the budget's cash boundary moves Unallocated by the
// whole balance (account-type-move.js). The caller says where it goes:
// `moveEnvelope` is the envelope released (or funded) by the same amount, in
// one adjustment row committed with the account, or null to leave the jump
// to Unallocated.

import { ok, fail } from '../result.js';
import {
  ACCOUNT_FIELD_PROPERTIES, applyAccountFields, accountRuleErrors, checkName, trimAccountText,
} from '../entity-fields.js';
import { identityMove, moveAdjustment } from '../account-type-move.js';

const prefixed = (errors) => errors.map(e => ({ ...e, path: `fields.${e.path}` }));

export default {
  name: 'account.update',
  summary: 'Change an account\'s fields (null clears one). A changed name must be unique. A type change that moves the balance into or out of the budget\'s cash (to or from investment, asset or loan types) needs moveEnvelope: the envelope that gives up or receives the balance, or null to leave it to Unallocated.',
  input: {
    type: 'object',
    required: ['id', 'fields'],
    properties: {
      id: { type: 'ref', kind: 'account' },
      fields: { type: 'object', properties: ACCOUNT_FIELD_PROPERTIES },
      moveEnvelope: {
        type: 'ref', kind: 'envelope', nullable: true,
        description: 'Only for a type change across the budget\'s cash: the envelope adjusted by the balance, or null for Unallocated',
      },
      moveNote: { type: 'string', description: 'Note on the type-change adjustment (default "Type change")' },
    },
  },
  execute(data, input, ctx) {
    const acc = data.accounts.find(a => a.id === input.id);
    const codeResult = assignShortCode(data, 'account', trimAccountText(input.fields), acc);
    if (!codeResult.ok) return codeResult;
    const fields = codeResult.value;
    if (Object.hasOwn(fields, 'name') && fields.name !== String(acc.name ?? '').trim()) {
      const bad = checkName('account', data.accounts, fields.name, acc.id);
      if (bad) return bad.code === 'bad_input' ? fail('bad_input', { errors: prefixed(bad.params.errors) }) : fail(bad.code, bad.params);
    }
    const newType = fields.type ?? acc.type;
    const move = newType !== acc.type ? identityMove(acc, newType, data.accounts, data.transactions) : null;
    const hasMoveEnvelope = Object.hasOwn(input, 'moveEnvelope');
    if (move && !hasMoveEnvelope) {
      return fail('bad_input', { errors: [{ path: 'moveEnvelope', message: 'is required: this type change moves the balance into or out of the budget\'s cash; give an envelope id, or null for Unallocated' }] });
    }
    if (!move && hasMoveEnvelope) {
      return fail('bad_input', { errors: [{ path: 'moveEnvelope', message: 'only applies to a type change that moves a balance into or out of the budget\'s cash' }] });
    }
    const account = applyAccountFields(acc, fields);
    const scenarioExpenses = (Array.isArray(data.meta?.stressExpenses) ? data.meta.stressExpenses : []).filter(e => e?.account === acc.id).length;
    if (scenarioExpenses && (account.archived || !isSpendingAccount(account))) return fail('in_use', { kind: 'account', id: acc.id, refs: { scenarioExpenses } });
    const touched = new Set(Object.keys(fields));
    const dependencies = { loanEnd: ['loanStart', 'loanEnd'], loanStart: ['type', 'loanStart', 'interestRates'], initialBalance: ['type', 'initialBalance'] };
    const existing = accountRuleErrors(acc, data.accounts);
    const errors = accountRuleErrors(account, data.accounts).filter(e =>
      (dependencies[e.path] ?? [e.path]).some(k => touched.has(k))
      || !existing.some(old => old.path === e.path && old.message === e.message));
    if (errors.length) return fail('bad_input', { errors: prefixed(errors) });
    /** @type {Record<string, any>} */
    const changes = { accounts: data.accounts.map(a => (a.id === acc.id ? account : a)) };
    if (move && input.moveEnvelope) {
      const row = moveAdjustment(move, input.moveEnvelope, {
        id: ctx.newId(), date: ctx.todayIso, note: input.moveNote ?? 'Type change', nowIso: ctx.now.toISOString(),
      });
      if (row) changes.transactions = [...data.transactions, row];
    }
    return ok({ changes, value: { id: acc.id } });
  },
};

// js/core/balance-fields.js — what balance.adjust and balance.set share: the
// envelope-or-account target, the mandatory note, and the adjustment row.

import { fail } from './result.js';

export const BALANCE_TARGET_PROPERTIES = Object.freeze({
  envelope: { type: 'ref', kind: 'envelope', description: 'The envelope to correct (give this or account, not both)' },
  account: { type: 'ref', kind: 'account', description: 'The account to correct (give this or envelope, not both)' },
  note: { type: 'string', description: 'Why: required, an unexplained correction is not allowed' },
  payee: { type: 'string' },
  date: { type: 'date', description: 'Date, YYYY-MM-DD (default today)' },
  force: { type: 'boolean', description: 'Bypass the strict-ledger history and future-date rules' },
});

/**
 * Resolve the target and check the note.
 * @param {Record<string, any>} data
 * @param {{ envelope?: string, account?: string, note: string }} input
 * @returns {{ ok: true, kind: 'envelope' | 'account', entity: Record<string, any>, note: string } | { ok: false, error: import('./result.js').DomainError }}
 */
export function resolveBalanceTarget(data, input) {
  if ((input.envelope === undefined) === (input.account === undefined)) return fail('target_required');
  const kind = input.envelope !== undefined ? 'envelope' : 'account';
  const rows = kind === 'envelope' ? data.envelopes : data.accounts;
  const entity = rows.find(r => r.id === input[kind]);
  // The pipeline resolves `ref` inputs before execute, so this only fires for
  // a direct execute() call with an id that is not there.
  if (!entity) return fail('ref_not_found', { kind, name: input[kind] });
  const note = input.note.trim();
  if (!note) return fail('note_required');
  return { ok: true, kind, entity, note };
}

/**
 * A posted, cleared adjustment row, as Budget's ledger.mjs writes it.
 * @param {import('./context.js').Ctx} ctx
 * @param {{ date?: string, payee: string, amount: number, target: 'envelope' | 'account', targetId: string, note: string }} f
 */
export function adjustmentRow(ctx, { date, payee, amount, target, targetId, note }) {
  const at = ctx.now.toISOString();
  return {
    id: ctx.newId(), type: 'adjustment', date: date ?? ctx.todayIso, payee, amount,
    target, target_id: targetId, note, cleared: true, status: 'posted',
    created_at: at, modified_at: at,
  };
}

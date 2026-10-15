// js/core/policies/strict-ledger.js — the Budget project's house rules as one
// opt-in policy (spec 2026-10-01 §8). Commands stay neutral; a session that
// activates this policy refuses writes that break the rules, whichever
// surface issued them.

import { isPostedTx, normalizeTransactionsForWrite } from '../../engine/tx-amounts.js';
import { isoDate } from '../context.js';
import { rowDiff, deepEqual } from '../diff.js';

/** Fields a posted past row may still change: bookkeeping marks, not money. */
export const EDITABLE_HISTORY_FIELDS = Object.freeze(['cleared', 'flagged', 'reversed_by', 'modified_at']);

const hasSetLine = (tx) => tx?.type === 'fill' && Array.isArray(tx.lines) && tx.lines.some(l => l && l.mode === 'set');

function onlyEditableFieldsChanged(a, b) {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!EDITABLE_HISTORY_FIELDS.includes(key) && !deepEqual(a[key], b[key])) return false;
  }
  return true;
}

// A row created today stays editable whatever its date, like Budget's guard.
const createdToday = (row, todayIso) => {
  if (typeof row?.created_at !== 'string') return false;
  const d = new Date(row.created_at);
  return !Number.isNaN(d.getTime()) && isoDate(d) === todayIso;
};

const refuse = (code, row) => ({ error: { code, params: code === 'ledger_set_line' ? { id: row.id } : { id: row.id, date: row.date } } });

export default {
  name: 'strict-ledger',
  /**
   * @param {any} before
   * @param {any} after
   * @param {{ name: string, input: any }} command
   * @param {import('../context.js').Ctx} ctx
   */
  check(before, after, command, ctx) {
    if (after.transactions === before.transactions) return null;
    // Legacy rows normalisation will rewrite anyway are not the command's doing.
    const d = rowDiff({ transactions: normalizeTransactionsForWrite(before.transactions || []) }, { transactions: after.transactions }).transactions;
    if (!d) return null;
    const today = ctx.todayIso;
    const force = command.input?.force === true;
    const forced = new Set();
    // Returns a refusal, or records the bypass and returns null.
    const rule = (name, code, row) => {
      if (!force) return refuse(code, row);
      forced.add(name);
      return null;
    };

    for (const { row } of d.added) {
      if (hasSetLine(row)) return refuse('ledger_set_line', row);
      if (isPostedTx(row) && row.date > today) {
        const r = rule('future-posted', 'ledger_future_posted', row);
        if (r) return r;
      }
    }
    for (const c of d.changed) {
      if (hasSetLine(c.after) && !deepEqual(c.before.lines, c.after.lines)) return refuse('ledger_set_line', c.after);
      if (isPostedTx(c.before) && c.before.date < today && !createdToday(c.before, today) && !onlyEditableFieldsChanged(c.before, c.after) && command.name !== 'template.convertIncomeLinked') {
        const r = rule('history-locked', 'ledger_history_locked', c.before);
        if (r) return r;
      }
      if (isPostedTx(c.after) && c.after.date > today && (!isPostedTx(c.before) || c.before.date !== c.after.date)) {
        const r = rule('future-posted', 'ledger_future_posted', c.after);
        if (r) return r;
      }
    }
    for (const { row } of d.removed) {
      if (isPostedTx(row) && row.date < today && !createdToday(row, today)) {
        const r = rule('history-locked', 'ledger_history_locked', row);
        if (r) return r;
      }
    }
    return forced.size ? { forced: [...forced] } : null;
  },
};

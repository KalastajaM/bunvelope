// js/ui/payee-rule-backfill.js — what saving an investment row with a new
// symbol does for its payee: remember the symbol as the payee's rule, and let
// the user name the earlier rows of that payee that have no symbol yet. Shared
// by the add and edit sheets.
//
// Two steps, split around the commit of the row itself: the question comes
// first (the user answers before anything is written); the rule and the
// tagging come after, as ONE investment.setPayeeRule commit (applyTo names the
// rows), best effort, so that a refused tag can never cost the user the entry
// they just made. A declined or refused backfill still saves the rule, without
// applyTo.

import { state, session } from '../app.js';
import { confirmDialog } from './dialog.js';
import { toast } from './toast.js';
import { t } from './i18n.js';
import { normalisePayeeKey, isMappablePayee } from '../state/investments.js';

/**
 * Ask whether the earlier investment rows of `payee` that have no symbol yet
 * should take `symbol`. Writes nothing.
 * @param {string} payee
 * @param {string} symbol
 * @param {string | null} [excludeId]  the row being edited, never a candidate
 * @returns {Promise<string[]>} ids of the rows to backfill with the symbol
 */
export async function askPayeeBackfill(payee, symbol, excludeId = null) {
  const key = normalisePayeeKey(payee);
  if (!key) return [];
  const sym = String(symbol).trim().toUpperCase();
  const matches = state.transactions.filter(x =>
    x.id !== excludeId
    && x.type === 'investment_transfer'
    && !x.symbol
    && normalisePayeeKey(x.payee) === key,
  );
  if (matches.length === 0) return [];
  const ok = await confirmDialog(t('investments.unmapped.retroApplyConfirm')(matches.length, sym));
  return ok ? matches.map(x => x.id) : [];
}

// A refusal after which retrying without the rows is pointless or wrong: the
// budget switched (a new dispatch would bind to the next budget), there is
// none, it is still loading, or the write conflicted.
const NO_RETRY = new Set(['budget_switched', 'no_budget', 'budget_loading', 'version_conflict']);

/**
 * Remember `symbol` as the rule for `payee` and tag the rows `ids`, in one
 * commit. When that commit is refused (strict-ledger on a past row, a row
 * deleted meanwhile), the rule is still saved on its own, as the old
 * rule-first flow kept it, and one toast says the rows were not tagged. A
 * placeholder payee ("Investment") has no rule to remember: its rows only take
 * the symbol (investment.tagSymbol). Reports, never throws.
 * @param {string} payee
 * @param {string} symbol
 * @param {string[]} ids
 * @returns {Promise<void>}
 */
export async function savePayeeRule(payee, symbol, ids) {
  if (!normalisePayeeKey(payee)) return;
  if (!isMappablePayee(payee)) {
    if (ids.length && !(await tryDispatch('investment.tagSymbol', { ids, symbol })).ok) {
      toast(t('addTx.backfillPartial')(ids.length));
    }
    return;
  }
  const r = await tryDispatch('investment.setPayeeRule', { payee, symbol, ...(ids.length ? { applyTo: ids } : {}) });
  if (r.ok || !ids.length) return;
  toast(t('addTx.backfillPartial')(ids.length));
  if (!NO_RETRY.has(r.error?.code)) await tryDispatch('investment.setPayeeRule', { payee, symbol });
}

/**
 * session.dispatch with a refusal or a throw logged and returned as a failed
 * result.
 * @param {string} name
 * @param {Record<string, any>} input
 * @returns {Promise<{ ok: boolean, error?: any }>}
 */
async function tryDispatch(name, input) {
  try {
    const r = await session.dispatch(name, input);
    if (!r.ok) console.error(`${name} refused:`, r.error);
    return r;
  } catch (err) {
    console.error(`${name} failed:`, err);
    return { ok: false, error: { code: 'thrown' } };
  }
}

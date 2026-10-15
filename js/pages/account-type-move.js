// js/pages/account-type-move.js — changing an account's type across the
// budget's cash boundary without moving Unallocated.
//
// Accounts either count toward the zero-sum identity (Σ accounts = Σ
// envelopes + Unallocated) or sit outside it (investment, asset, loan and
// loan-given accounts; engine `countsTowardIdentity`). Switching a type
// across that line takes the account's balance out of the budget's cash, or
// brings it in, so Unallocated jumps by the whole balance. Typically the
// money was held in an envelope (a "Loans to others" savings account whose
// balance an envelope covered): the honest fix is to release that envelope
// by the same amount, which is what this offers, as one envelope
// adjustment. Choosing "Unallocated" leaves the jump where it lands.
//
// The pure helpers (identityMove, moveAdjustment) live in core; this module
// keeps the dialog and re-exports them for its existing callers.

import { state } from '../app.js';
import { openSheet } from '../ui/sheet.js';
import { t } from '../ui/i18n.js';
import { fmt } from '../utils.js';
import { appendEnvelopeOptions } from '../ui/envelope-options.js';
import { enhanceSelectWithSearch } from '../ui/select-combobox.js';
import { ask } from '../ui/query.js';

export { identityMove, moveAdjustment } from '../core/account-type-move.js';

// A real value, not '': the searchable select shows an empty value as its
// placeholder, which would hide that Unallocated is what is chosen.
const UNALLOCATED = '__unallocated__';

/**
 * Ask where the balance goes. Resolves `{ envelopeId }` (null = Unallocated)
 * to go ahead, or null when the user cancels the type change.
 *
 * @param {{ balance: number, leaving: boolean }} move
 * @param {string} accountName
 * @returns {Promise<{ envelopeId: string | null } | null>}
 */
export function askIdentityMove(move, accountName) {
  return new Promise((resolve) => {
    const content = document.createElement('div');
    const p = document.createElement('p');
    p.style.cssText = 'font-size:14px;margin:0 0 12px;line-height:1.5;';
    p.textContent = move.leaving
      ? t('accountEdit.moveOut')(accountName, fmt(move.balance))
      : t('accountEdit.moveIn')(accountName, fmt(move.balance));
    content.append(p);

    // Booked balances: what has been entered, whatever lens is active. A
    // failed query leaves the amounts off rather than showing another figure.
    const balances = ask('balances', { lens: 'booked' });
    const envBal = new Map((balances?.envelopes ?? []).map(e => [e.id, e.balance]));
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const lbl = document.createElement('label');
    lbl.textContent = move.leaving ? t('accountEdit.moveOutEnvelope') : t('accountEdit.moveInEnvelope');
    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = UNALLOCATED;
    none.textContent = t('accountEdit.moveUnallocated');
    sel.append(none);
    appendEnvelopeOptions(sel, (state.envelopes || []).filter(e => !e.archived),
      (e) => (balances ? `${e.name} — ${fmt(envBal.get(e.id) ?? 0)}` : e.name));
    wrap.append(lbl, sel);
    content.append(wrap);
    enhanceSelectWithSearch(sel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });

    const footer = document.createElement('div');
    footer.dataset.sheetActions = '';
    footer.className = 'sheet-footer-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost';
    cancel.textContent = t('common.cancel');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-accent';
    ok.textContent = t('accountEdit.moveConfirm');
    const end = document.createElement('div');
    end.className = 'sheet-footer-actions-end';
    end.append(ok);
    footer.append(cancel, end);
    content.append(footer);

    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const { close } = openSheet({
      title: t('accountEdit.moveTitle'), content, narrow: true,
      onClose: () => finish(null),
      // Not the envelope search: focusing it opens its list over the text.
      initialFocus: ok,
    });
    cancel.addEventListener('click', () => { finish(null); close(); });
    ok.addEventListener('click', () => {
      finish({ envelopeId: sel.value && sel.value !== UNALLOCATED ? sel.value : null });
      close();
    });
  });
}

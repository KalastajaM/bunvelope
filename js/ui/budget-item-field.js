// js/ui/budget-item-field.js — the "Budget item" picker on an expense.
//
// Fill % (js/engine/item-funding.js) splits an envelope's money across its
// budget items. A hand-recorded expense names none of them, so the engine
// guesses (spending items first). This field lets the user say which item a
// payment belongs to. It only appears when the expense has a single envelope
// with two or more items: with one item there is nothing to choose.
//
// "Automatic" (empty) stores no link.
//
// `compact` is the per-line form for a split expense: no hint, the label
// names the line's envelope, and it sits under its split row.

import { state } from '../app.js';
import { envelopeFundingItems } from '../engine.js';
import { t } from './i18n.js';
import { infoButton } from './info-button.js';

/**
 * @param {{ initial?: string | null, compact?: boolean }} [opts]
 * @returns {{ el: HTMLElement, select: HTMLSelectElement,
 *   refresh: (envelopeId: string | null | undefined, preferId?: string | null) => void,
 *   value: () => string | null }}
 */
export function budgetItemField({ initial = null, compact = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = compact ? 'field budget-item-line' : 'field budget-item-field';
  wrap.style.marginTop = compact ? '0' : '10px';
  const label = document.createElement('label');
  label.textContent = t('itemLink.label');
  const select = document.createElement('select');
  select.name = 'budget_item_id';
  label.htmlFor = select.id = `budget-item-${Math.random().toString(36).slice(2, 8)}`;
  if (compact) {
    label.textContent = t('itemLink.lineLabel');
    wrap.append(label, select);
  } else {
    label.append(infoButton(null, { title: t('itemLink.label'), body: t('itemLink.hint') }));
    wrap.append(label, select);
  }
  wrap.hidden = true;

  let envelopeId = null;
  let wanted = initial;

  function refresh(nextEnvelopeId, preferId) {
    const envId = nextEnvelopeId && nextEnvelopeId !== '__none__' ? nextEnvelopeId : null;
    if (preferId !== undefined) {
      wanted = preferId;
    } else if (envId === envelopeId) {
      // Same envelope (an amount or split edit): keep what the user picked.
      if (!wrap.hidden) wanted = select.value || null;
    } else if (envelopeId !== null) {
      // The envelope changed: a link names an item of the old one.
      wanted = null;
    }
    // else: the first fill, which keeps `initial`.
    envelopeId = envId;
    const items = envId ? envelopeFundingItems(state.budgetItems || [], envId) : [];
    if (items.length < 2) {
      wrap.hidden = true;
      select.replaceChildren();
      return;
    }
    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = t('itemLink.automatic');
    const opts = items.map(it => {
      const o = document.createElement('option');
      o.value = it.id;
      o.textContent = it.description || it.id;
      return o;
    });
    select.replaceChildren(auto, ...opts);
    select.value = wanted && items.some(it => it.id === wanted) ? wanted : '';
    wrap.hidden = false;
  }

  return {
    el: wrap,
    select,
    refresh,
    value: () => (wrap.hidden ? null : (select.value || null)),
  };
}

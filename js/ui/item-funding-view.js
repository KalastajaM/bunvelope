// js/ui/item-funding-view.js — the "Budget items" block of the envelope health
// sheet, and the one-line summary on the envelope card.
//
// Renders `computeItemFunding` (js/engine/item-funding.js); computes nothing.
// Reuses the card's meter (.env-meter--spend) and status tags
// (.env-goal-tag--ontrack / --behind) so the block reads like the rest of the
// envelope UI.

import { t, fmtDateLang } from './i18n.js';
import { fmt } from '../utils.js';

const OK = new Set(['on_track', 'paid', 'funded']);

/**
 * The status the "Not on track" filter, the Plan chip and the Overview line
 * count: short, a payment the envelope will not cover on its due date. Over
 * (spent past this month's plan) is not counted: when the envelope's balance
 * still covers it nothing is unpaid, and when it does not the item is short.
 */
export function needsAttention(status) {
  return status === 'short';
}

/**
 * The status tag's text, shared by the health sheet and the Budget plan row.
 * @param {{ status: string, shortBy: number, overspent: number }} item
 */
export function statusText(item) {
  if (item.status === 'paid') return t('itemFunding.paid');
  if (item.status === 'funded') return t('itemFunding.funded');
  if (item.status === 'on_track') return t('itemFunding.onTrack');
  if (item.status === 'over') return t('itemFunding.over')(fmt(item.overspent));
  return t('itemFunding.short')(fmt(item.shortBy));
}

/**
 * "2 of 3 items on track", or null when there is nothing worth a line (fewer
 * than two items: the card's own figures already say it).
 * @param {{ items: Array<{ status: string }> } | null | undefined} funding
 * @returns {{ text: string, problem: boolean } | null}
 */
export function itemFundingSummary(funding) {
  if (!funding || !Array.isArray(funding.items) || funding.items.length < 2) return null;
  const ok = funding.items.filter(i => OK.has(i.status)).length;
  return { text: t('itemFunding.cardLine')(ok, funding.items.length), problem: ok < funding.items.length };
}

function statusTag(item) {
  const tag = document.createElement('span');
  tag.className = 'env-goal-tag ' + (OK.has(item.status) ? 'env-goal-tag--ontrack' : 'env-goal-tag--behind');
  tag.textContent = statusText(item);
  return tag;
}

function detailText(item) {
  if (item.style === 'spending') {
    const parts = [t('itemFunding.leftOf')(fmt(item.remaining), fmt(item.planThisMonth))];
    if (item.status === 'short' && item.shortDate) {
      parts.push(t('itemFunding.spendingShortOn')(fmt(item.shortBy), fmtDateLang(item.shortDate)));
    }
    return parts.join(' · ');
  }
  const parts = [];
  if (item.spent > 0 && (item.status === 'paid' || item.remaining <= 0)) parts.push(t('itemFunding.paidAmount')(fmt(item.spent)));
  if (item.nextDue) {
    const saved = Math.min(item.allocated, item.nextDue.amount);
    parts.push(t('itemFunding.billOf')(fmt(saved), fmt(item.nextDue.amount), fmtDateLang(item.nextDue.date)));
    // Not all of it is in the envelope yet: say where the rest comes from,
    // or, when the projection says it will not come, by how much it falls short.
    if (item.status === 'short') parts.push(t('itemFunding.shortByThen')(fmt(item.shortBy)));
    else if (saved < item.nextDue.amount - 0.005) parts.push(t('itemFunding.restFromFills'));
  } else if (!parts.length) {
    parts.push(t('itemFunding.noNext'));
  }
  return parts.join(' · ');
}

/**
 * Meter fill, 0–100: spending shows what is left of the month; a bill how much
 * of its next payment is already in the envelope, full once this month's is paid.
 */
function meterPct(item) {
  if (item.style === 'spending') {
    if (item.planThisMonth <= 0) return 0;
    return Math.round(Math.max(0, Math.min(1, item.remaining / item.planThisMonth)) * 100);
  }
  if (item.status === 'paid') return 100;
  return item.pct == null ? 100 : Math.round(item.pct * 100);
}

/**
 * @param {import('../engine/item-funding.js').EnvelopeFunding} funding
 * @returns {HTMLElement}
 */
export function itemFundingSection(funding) {
  const box = document.createElement('section');
  box.className = 'item-funding';
  box.style.marginBottom = '18px';
  const title = document.createElement('h3');
  title.textContent = t('itemFunding.title');
  const intro = document.createElement('p');
  intro.className = 'muted';
  intro.style.cssText = 'margin:0 0 10px;font-size:12px;';
  intro.textContent = t('itemFunding.intro');
  box.append(title, intro);

  for (const item of funding.items) {
    const card = document.createElement('div');
    card.className = 'card item-funding-row';
    card.dataset.itemId = item.itemId;
    card.style.cssText = 'padding:10px 14px;margin-bottom:8px;';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
    const name = document.createElement('strong');
    name.textContent = item.name;
    const style = document.createElement('span');
    style.className = 'muted';
    style.style.fontSize = '12px';
    style.textContent = t(item.style === 'spending' ? 'budgetPlan.fundingSpending' : 'budgetPlan.fundingBill');
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    head.append(name, style, spacer, statusTag(item));

    const meter = document.createElement('div');
    meter.className = 'env-meter env-meter--spend'
      + (item.status === 'over' ? ' is-over' : item.status === 'short' ? ' is-tight' : (item.status === 'paid' || item.status === 'funded') ? ' is-funded' : '');
    meter.style.margin = '8px 0 6px';
    const fill = document.createElement('div');
    fill.className = 'fill';
    fill.style.width = meterPct(item) + '%';
    meter.append(fill);

    const detail = document.createElement('div');
    detail.className = 'muted item-funding-detail';
    detail.style.fontSize = '12px';
    detail.textContent = detailText(item);

    card.append(head, meter, detail);
    box.append(card);
  }

  const foot = document.createElement('div');
  foot.className = 'muted';
  foot.style.cssText = 'font-size:12px;display:flex;flex-direction:column;gap:2px;';
  if (funding.reserve > 0) {
    const line = document.createElement('div');
    line.textContent = t('itemFunding.reserve')(fmt(funding.reserveAllocated), fmt(funding.reserve));
    foot.append(line);
  }
  if (funding.unassigned > 0.005) {
    const line = document.createElement('div');
    line.textContent = t('itemFunding.unassigned')(fmt(funding.unassigned));
    foot.append(line);
  }
  if (funding.shortfall > 0.005) {
    const line = document.createElement('div');
    line.style.color = 'var(--danger, var(--rose))';
    line.textContent = t('itemFunding.shortfall')(fmt(funding.shortfall));
    foot.append(line);
  }
  if (foot.childElementCount) box.append(foot);
  return box;
}

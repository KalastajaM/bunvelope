import { state, session, now } from '../app.js';
import { ask } from './query.js';
import { node } from './planning-workspace.js';
import { t, fmtDateLang, trEnv } from './i18n.js';
import { fmt } from '../utils.js';
import { isoDate } from '../core/context.js';
import { openSheet } from './sheet.js';
import { trackDirty } from './dirty-guard.js';
import { guardSubmit } from './submit-guard.js';
import { dispatchOrReport } from './save-error.js';
import { withBusy } from './busy.js';
import { currentBudgetSession } from '../state/budget-session.js';
const tr = key => t('discovery.' + key);
const cadence = period => tr('period' + period);
function button(label, action) {
  const b = node('button', 'btn btn-sm btn-ghost', label);
  b.type = 'button'; b.addEventListener('click', action); return b;
}
export function recurringDiscovery(refresh, editItem) {
  const generation = currentBudgetSession();
  const answer = ask('recurring.suggestions', { date: isoDate(now()) });
  const suggestions = answer?.suggestions || [];
  const pending = suggestions.filter(s => s.status === 'pending');
  const section = node('section', 'recurring-discovery');
  const prices = answer?.priceIncreases || [];
  if (prices.length) {
    const priceSection = node('section', 'recurring-price-reviews');
    priceSection.append(node('h2', '', tr('priceTitle')), node('p', 'page-intro', tr('priceHelp')));
    const priceGrid = node('div', 'env-grid recurring-cost-grid');
    const dismissed = node('details'); dismissed.append(node('summary', '', tr('reviewedPrices')));
    const dismissedGrid = node('div', 'env-grid recurring-cost-grid'); dismissed.append(dismissedGrid);
    for (const price of prices) {
      const card = node('article', 'tpl-card recurring-price-card');
      card.append(node('h3', 'tpl-name', price.payee), node('p', 'tpl-meta', `${state.accounts.find(a => a.id === price.accountId)?.name || price.accountId} · ${cadence(price.period)}`));
      card.append(node('p', '', `${fmt(price.increase.previous)} → ${fmt(price.increase.current)}`), node('p', '', `${tr('extraAnnual')}: ${fmt(price.extraAnnual)}`));
      const evidence = node('details'); evidence.append(node('summary', '', tr('evidence')));
      const list = node('ul');
      for (const payment of price.evidence) list.append(node('li', '', `${fmtDateLang(payment.date)} · ${fmt(payment.amount)}`));
      evidence.append(list); card.append(evidence);
      const actions = node('div', 'tpl-actions');
      if (price.trackedItemId && editItem) actions.append(button(t('recurring.edit'), () => editItem(price.trackedItemId)));
      const control = button(tr(price.dismissed ? 'restore' : 'dismiss'), async () => {
        if (generation !== currentBudgetSession()) return;
        await withBusy(control, async () => {
          const result = await dispatchOrReport(session, 'recurring.reviewPrice', { key: price.key, dismissed: !price.dismissed });
          if (result && generation === currentBudgetSession()) refresh();
        });
      });
      actions.append(control); card.append(actions);
      (price.dismissed ? dismissedGrid : priceGrid).append(card);
    }
    priceSection.append(priceGrid);
    if (prices.some(p => p.dismissed)) priceSection.append(dismissed);
    section.append(priceSection);
  }
  section.append(node('h2', '', `${tr('title')} (${pending.length})`), node('p', 'page-intro', tr('help')));
  const grid = node('div', 'env-grid recurring-cost-grid');
  if (!pending.length) section.append(node('p', 'tpl-meta', tr('empty')));
  section.append(grid);
  const reviewed = node('details');
  reviewed.append(node('summary', '', tr('reviewed')));
  const reviewedGrid = node('div', 'env-grid recurring-cost-grid'); reviewed.append(reviewedGrid);
  const apply = async (s, action, control, extra = {}) => {
    if (generation !== currentBudgetSession()) return null;
    return withBusy(control, async () => {
      const result = await dispatchOrReport(session, 'recurring.reviewSuggestion', { key: s.key, action, ...extra });
      if (result && generation === currentBudgetSession()) refresh();
      return result;
    });
  };
  for (const s of suggestions) {
    const card = node('article', 'tpl-card recurring-suggestion');
    card.append(node('h3', 'tpl-name', s.payee));
    const account = state.accounts.find(a => a.id === s.accountId);
    card.append(node('p', 'tpl-meta', `${account?.name || s.accountId} · ${cadence(s.period)} · ${fmt(s.amount)}`));
    card.append(node('p', '', `${tr('annual')}: ${fmt(s.annual)}`));
    if (s.variable) card.append(node('p', 'tpl-meta', `${tr('variable')}: ${fmt(s.minAmount)}–${fmt(s.maxAmount)}. ${tr('averageHelp')}`));
    const evidence = node('details');
    evidence.append(node('summary', '', `${tr('evidence')} (${s.count})`));
    const list = node('ul');
    for (const payment of s.evidence) list.append(node('li', '', `${fmtDateLang(payment.date)} · ${fmt(payment.amount)}`));
    evidence.append(list); card.append(evidence);
    const actions = node('div', 'tpl-actions');
    if (s.status === 'pending') {
      actions.append(button(tr('add'), () => review(s, 'create')), button(tr('link'), () => review(s, 'link')));
      const dismiss = button(tr('dismiss'), () => apply(s, 'dismiss', dismiss)); actions.append(dismiss);
      grid.append(card);
    } else {
      const item = state.budgetItems.find(it => it.id === s.itemId);
      card.append(node('p', 'tpl-meta', s.status === 'linked' ? `${tr('linked')}: ${item?.description || s.itemId}` : tr('dismissed')));
      const restore = button(tr('restore'), () => apply(s, 'restore', restore)); actions.append(restore);
      reviewedGrid.append(card);
    }
    card.append(actions);
  }
  if (suggestions.some(s => s.status !== 'pending')) section.append(reviewed);
  return section;

  function review(s, action) {
    const form = node('form', 'recurring-editor');
    form.append(node('p', '', `${s.payee} · ${cadence(s.period)} · ${fmt(s.amount)}`));
    const account = state.accounts.find(a => a.id === s.accountId);
    const envelope = state.envelopes.find(e => e.id === s.envelopeId && !e.archived);
    form.append(node('p', 'tpl-meta', `${account?.name || s.accountId} · ${envelope ? trEnv(envelope) : t('recurring.unallocated')}`));
    form.append(node('p', 'page-intro', tr(action === 'create' ? 'confirmHelp' : 'linkHelp')));
    const field = node('div', 'field');
    const label = node('label', '', tr(action === 'create' ? 'firstDate' : 'existing'));
    const input = node(action === 'create' ? 'input' : 'select');
    input.id = 'discovery-review-input'; label.htmlFor = input.id; input.required = true;
    if (action === 'create') {
      input.type = 'date'; input.min = isoDate(now());
      input.value = s.firstDate;
      // The command requires a future payment, never a backdated occurrence.
      input.addEventListener('input', () => input.setCustomValidity(input.value <= isoDate(now()) ? tr('futureDate') : ''));
    } else {
      const empty = node('option', '', tr('choose')); empty.value = ''; input.append(empty);
      for (const item of state.budgetItems.filter(it => it.as_schedule && (it.kind || 'expense') === 'expense')) {
        const account = state.accounts.find(a => a.id === item.account_id);
        const option = node('option', '', `${item.description || item.id} · ${account?.name || ''}`);
        option.value = item.id; input.append(option);
      }
    }
    field.append(label, input); form.append(field);
    let amount;
    if (action === 'create') {
      const wrap = node('div', 'field');
      const amountLabel = node('label', '', tr('scheduleAmount'));
      amount = node('input'); amount.type = 'number'; amount.min = '0.01'; amount.step = '0.01'; amount.required = true; amount.value = String(s.amount);
      amount.id = 'discovery-schedule-amount'; amountLabel.htmlFor = amount.id;
      wrap.append(amountLabel, amount);
      if (s.variable) wrap.append(node('p', 'money-field-help', tr('averageHelp')));
      form.append(wrap);
    }
    const dirty = trackDirty(form);
    const save = node('button', 'btn btn-accent', t('common.save')); save.type = 'submit';
    const cancel = button(t('common.cancel'), () => sheet.requestClose()); cancel.className = 'btn btn-ghost';
    const sheet = openSheet({ title: tr(action === 'create' ? 'add' : 'link'), content: form, confirmClose: dirty.confirmClose, headerActions: [cancel, save] });
    form.addEventListener('submit', guardSubmit(async () => {
      if (generation !== currentBudgetSession()) { sheet.close(); return; }
      const result = await apply(s, action, save, action === 'create' ? { firstDate: input.value, amount: Number(amount.value) } : { itemId: input.value });
      if (result) sheet.close();
    }));
  }
}

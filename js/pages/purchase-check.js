import { state, session, now, navigate } from '../app.js';
import { currentBudgetSession, onBudgetSessionChange } from '../state/budget-session.js';
import { subscribeState } from '../state/events.js';
import { isoDate } from '../core/context.js';
import { isSpendingAccount } from '../engine/balances.js';
import { t, fmtDateLang, trEnv } from '../ui/i18n.js';
import { fmt } from '../utils.js';
import { openSheet } from '../ui/sheet.js';
import { enhanceSelectWithSearch } from '../ui/select-combobox.js';
import { paintYield } from '../ui/skeleton.js';
import { toast } from '../ui/toast.js';
import { undoAction } from '../ui/undo-action.js';
import { reportDispatchFailure } from '../ui/save-error.js';

const el = (tag, cls = '', text) => {
  const node = document.createElement(tag); node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (label, action, accent = false) => {
  const node = el('button', `btn btn-sm ${accent ? 'btn-accent' : 'btn-ghost'}`, label);
  node.type = 'button'; node.addEventListener('click', action); return node;
};

export function purchaseCheckButton(envelope) {
  return button(t('purchase.title'), () => openPurchaseCheck(envelope));
}

export function openPurchaseCheck(initialEnvelope) {
  const owner = currentBudgetSession();
  let closed = false, busy = false, generation = 0, report = null, funding = null;
  const live = () => !closed && currentBudgetSession() === owner;
  const content = el('div', 'purchase-check');
  content.append(el('p', 'sub', t('purchase.intro')));
  const form = el('form');
  const fields = el('fieldset', 'purchase-fields');
  const add = (key, control) => {
    const label = el('label', 'purchase-field');
    label.append(el('span', 'form-label', t('purchase.' + key)), control);
    control.className = 'form-input';
    control.setAttribute('aria-label', t('purchase.' + key));
    fields.append(label); return control;
  };
  const amount = add('amount', el('input')); amount.type = 'number'; amount.min = '0.01'; amount.step = '0.01'; amount.required = true;
  const date = add('date', el('input')); date.type = 'date'; date.required = true; date.min = date.value = isoDate(now());
  const account = add('account', el('select')); account.required = true;
  for (const a of state.accounts.filter(a => !a.archived && (isSpendingAccount(a) || a.type === 'savings' || a.type === 'credit_card'))) account.append(new Option(a.name, a.id));
  const envelope = add('envelope', el('select')); envelope.required = true;
  for (const e of state.envelopes.filter(e => !e.archived)) envelope.append(new Option(trEnv(e), e.id));
  if (initialEnvelope) envelope.value = initialEnvelope;
  const payee = add('payee', el('input')); payee.type = 'text';
  const preview = el('button', 'btn btn-accent', t('purchase.check')); preview.type = 'submit';
  form.append(fields, preview);
  const results = el('div', 'purchase-results'); results.setAttribute('aria-live', 'polite');
  const record = button(t('purchase.record'), recordPurchase, true); record.disabled = true;
  const removeFunding = button(t('purchase.removeFunding'), () => { funding = null; void check(); }); removeFunding.hidden = true;
  const actions = el('div', 'purchase-actions'); actions.append(record, removeFunding);
  content.append(form, results, actions, el('p', 'sub', t('purchase.scope')));
  const sheet = openSheet({ title: t('purchase.title'), content, wide: true, initialFocus: amount,
    onClose: () => { closed = true; offBudget(); offState(); } });
  const offBudget = onBudgetSessionChange(() => { closed = true; sheet.close(); });
  const offState = subscribeState(() => { if (!busy && live()) invalidate(); });
  enhanceSelectWithSearch(envelope, { placeholder: t('purchase.envelope') });
  if (!account.options.length || !envelope.options.length) {
    preview.disabled = true; results.append(el('p', 'sub', t('purchase.setup')));
  }
  function invalidate() {
    generation++; report = null; funding = null; record.disabled = true; removeFunding.hidden = true;
    results.replaceChildren(el('p', 'sub', t('purchase.recheck')));
  }
  form.addEventListener('input', invalidate);
  form.addEventListener('change', invalidate);
  form.addEventListener('submit', event => { event.preventDefault(); void check(); });

  async function check() {
    if (!live() || busy || !form.reportValidity()) return;
    const ticket = ++generation;
    report = null; record.disabled = true;
    results.replaceChildren(el('p', 'muted', t('common.loading')));
    await paintYield();
    if (!live() || ticket !== generation) return;
    try {
      const r = session.query('purchase.preview', { amount: Number(amount.value), date: date.value,
        account: account.value, envelope: envelope.value, payee: payee.value,
        ...(funding ? { fundingEnvelope: funding.id, fundingAmount: funding.amount } : {}) });
      if (!r.ok) { results.replaceChildren(el('p', 'form-hint', t('purchase.invalid'))); return; }
      report = r.value;
      renderReport(report);
      record.textContent = t(report.date > isoDate(now()) ? (funding ? 'purchase.scheduleBoth' : 'purchase.schedule') : (funding ? 'purchase.recordBoth' : 'purchase.record'));
      record.disabled = false; removeFunding.hidden = !funding;
    } catch (err) {
      console.warn('[bunvelope] purchase preview failed', err);
      results.replaceChildren(el('p', 'form-hint', t('purchase.failed')));
    }
  }

  function value(title, amount) {
    const row = el('div', 'purchase-value');
    row.append(el('span', '', title), el('strong', '', fmt(amount)));
    return row;
  }
  function values(title, before, after) {
    const section = el('div', 'purchase-comparison');
    section.append(el('h4', '', title), value(t('purchase.without'), before), value(t('purchase.with'), after));
    return section;
  }
  function renderReport(r) {
    const assessment = r.assessment;
    const summary = el('div', `purchase-summary purchase-summary-${assessment}`);
    summary.append(el('h3', '', t('purchase.assessment.' + assessment)));
    summary.append(el('p', '', `${fmt(r.amount)} · ${fmtDateLang(r.date)} · ${r.account.name}`));
    if (r.repaymentUnknown) summary.append(el('p', '', t('purchase.repaymentUnknown')));
    if (r.repaymentBeyondWindow) summary.append(el('p', '', t('purchase.repaymentBeyondWindow')));
    results.replaceChildren(summary);
    results.append(el('h4', '', `${r.envelope.name} · ${t('purchase.envelopeResult')}`));
    results.append(value(t(r.envelope.after.spare < 0 ? 'purchase.envelopeShort' : 'purchase.envelopeLeft'), r.envelope.after.spare));
    results.append(el('p', 'sub', t('purchase.spareHelp')));
    const envelopeDetails = el('details', 'purchase-details');
    envelopeDetails.append(el('summary', '', t('purchase.explainEnvelope')),
      values(t('purchase.spare'), r.envelope.before.spare, r.envelope.after.spare),
      el('p', 'sub', t('purchase.planHelp')),
      el('p', 'sub', `${t('purchase.lowOn')}: ${fmtDateLang(r.envelope.after.low.date)}`));
    results.append(envelopeDetails);
    if (r.funding) {
      results.append(values(`${r.funding.name} · ${t('purchase.donorSpare')}`, r.funding.before.spare, r.funding.after.spare));
      results.append(el('p', 'sub', `${t('purchase.move')}: ${fmt(r.funding.amount)} · ${r.funding.name} → ${r.envelope.name} · ${fmtDateLang(r.date)}`));
    }
    if (r.otherEnvelopes.length) {
      results.append(el('h4', '', t('purchase.otherEnvelopes')));
      for (const e of r.otherEnvelopes) {
        results.append(values(`${e.name} · ${t('purchase.spare')}`, e.before.spare, e.after.spare));
        results.append(el('p', 'purchase-warning', `${t('purchase.impacts.' + e.impact)} · ${t('purchase.lowOn')}: ${fmtDateLang(e.after.low.date)}`));
      }
    }
    results.append(el('h4', '', t('purchase.cash')));
    results.append(el('p', 'sub', t('purchase.cashHelp')));
    const cash = r.accounts.filter(a => a.after.firstNegative || a.before.firstNegative || a.id === r.account.id);
    if (!cash.some(a => a.after.firstNegative) && !r.repaymentUnknown && !r.repaymentBeyondWindow) results.append(el('p', 'sub', t('purchase.noShortfalls')));
    for (const a of cash) {
      const section = el('section', 'purchase-account');
      section.append(el('h4', '', a.name), value(t('purchase.current'), a.current));
      const changed = a.impact === 'new' || a.impact === 'worse';
      section.append(el('p', changed ? 'purchase-warning' : 'sub', t('purchase.impacts.' + a.impact)));
      const detail = el('details', 'purchase-details');
      detail.append(el('summary', '', t('purchase.explainCash')),
        el('p', 'sub', `${t('purchase.period')}: ${fmtDateLang(r.start)} – ${fmtDateLang(r.end)}`),
        value(`${t('purchase.forecastWithout')} · ${fmtDateLang(a.before.low.date)}`, a.before.low.balance),
        value(`${t('purchase.forecastWith')} · ${fmtDateLang(a.after.low.date)}`, a.after.low.balance),
        value(t('purchase.lowDifference'), a.lowDifference),
        el('h4', '', t('purchase.calculation')),
        value(t('purchase.current'), a.current),
        ...Object.entries(a.movements).filter(([, amount]) => amount !== 0).map(([kind, amount]) => value(t('purchase.movements.' + kind), amount)),
        value(t('purchase.forecastChange'), a.changeToLow),
        value(`${t('purchase.forecastWith')} · ${fmtDateLang(a.after.low.date)}`, a.after.low.balance),
        el('p', 'sub', t('purchase.calculationHelp')));
      if (a.after.firstNegative) detail.append(el('p', 'sub', `${t('purchase.firstNegative')}: ${fmtDateLang(a.after.firstNegative.date)}`));
      section.append(detail); results.append(section);
    }
    results.append(el('h4', '', t('purchase.goals')));
    if (!r.goals.length) results.append(el('p', 'sub', t('purchase.noGoals')));
    for (const g of r.goals) {
      results.append(el('p', '', `${g.name} · ${t('purchase.goalStatuses.' + g.after.status)}${g.before.status === g.after.status && g.before.projected === g.after.projected ? ' · ' + t('purchase.unchanged') : ''}`));
      if (g.after.projected !== null) results.append(values(`${fmtDateLang(g.after.date)} · ${t(g.after.hasDeadline ? 'purchase.target' : 'purchase.targetAtEnd')} ${fmt(g.after.target)}`, g.before.projected, g.after.projected));
      else results.append(el('p', 'sub', `${t('purchase.outside')}: ${fmtDateLang(g.after.date)}`));
    }
    if (r.suggestions.length) {
      results.append(el('h4', '', t('purchase.funding')), el('p', 'sub', t('purchase.fundingHelp')));
      for (const suggestion of r.suggestions) results.append(button(`${t('purchase.previewMove')} ${fmt(suggestion.amount)} · ${suggestion.name}`, () => {
        if (busy || !live()) return;
        funding = suggestion; void check();
      }));
    }
  }

  async function recordPurchase() {
    if (!live() || busy || !report) return;
    // Re-read the current budget before writing; changes since the shown
    // assessment require a fresh preview. The session handles atomicity.
    const input = { amount: Number(amount.value), date: date.value, account: account.value,
      envelope: envelope.value, payee: payee.value, ...(funding ? { fundingEnvelope: funding.id, fundingAmount: funding.amount } : {}) };
    let fresh;
    try { fresh = session.query('purchase.preview', input); } catch { fresh = null; }
    if (!fresh?.ok || JSON.stringify(fresh.value) !== JSON.stringify(report)) { invalidate(); return; }
    const steps = report.steps;
    busy = true; record.disabled = true; preview.disabled = true; fields.disabled = true;
    try {
      const saved = await session.dispatchBatch(steps);
      if (!live()) return;
      if (!saved.ok) { reportDispatchFailure(saved.error); return; }
      sheet.close(); closed = true;
      toast(t('purchase.saved'), { action: undoAction(saved.value.undo, state.currentPage) });
      navigate(state.currentPage);
    } catch (err) {
      console.warn('[bunvelope] purchase save failed', err);
      if (live()) toast(t('purchase.saveFailed'), { assertive: true });
    } finally {
      busy = false;
      if (live()) { fields.disabled = false; preview.disabled = false; invalidate(); }
    }
  }
}

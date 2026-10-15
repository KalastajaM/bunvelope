import { state, session, activeLensInput, navigate, now } from '../app.js';
import { currentBudgetSession, onBudgetSessionChange } from '../state/budget-session.js';
import { ask } from '../ui/query.js';
import { t, fmtDateLang, trEnv } from '../ui/i18n.js';
import { fmt } from '../utils.js';
import { openSheet } from '../ui/sheet.js';
import { isoDate } from '../core/context.js';
import { subscribeState } from '../state/events.js';
import { enhanceSelectWithSearch } from '../ui/select-combobox.js';
import { paintYield } from '../ui/skeleton.js';
import { comparisonSourceTable, comparisonDetailTable } from './number-change-sources.js';

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (label, action) => {
  const node = el('button', 'btn btn-sm btn-ghost', label);
  node.type = 'button'; node.addEventListener('click', action);
  return node;
};
const routes = { accounts: 'accounts', envelopes: 'envelopes', transactions: 'transactions', budgetItems: 'budget-plan', envelopeTemplates: 'templates', settings: 'settings', investments: 'investments' };

export function numberChangesButton() {
  return button(t('numberChanges.title'), () => openNumberChanges());
}

export function openNumberChanges(initialEnvelope) {
  const owner = currentBudgetSession();
  let closed = false, generation = 0;
  const live = () => !closed && owner === currentBudgetSession();
  const content = el('div', 'number-changes');
  const intro = el('p', 'sub', t('numberChanges.intro'));
  const controls = el('div', 'form-row');
  const metric = el('select', 'form-input');
  metric.setAttribute('aria-label', t('numberChanges.metric'));
  for (const key of ['netWorth', 'forecast', 'spare', 'unrealized']) metric.append(new Option(t('numberChanges.metrics.' + key), key));
  const envelope = el('select', 'form-input');
  envelope.setAttribute('aria-label', t('numberChanges.envelope'));
  for (const env of state.envelopes.filter(e => !e.archived)) envelope.append(new Option(trEnv(env), env.id));
  if (initialEnvelope) { metric.value = 'spare'; envelope.value = initialEnvelope; }
  const envelopeHost = el('div', 'number-changes-envelope');
  envelopeHost.append(envelope);
  const date = el('input', 'form-input'); date.type = 'date'; date.max = isoDate(now());
  date.setAttribute('aria-label', t('numberChanges.compareDate'));
  const label = el('label', 'number-changes-date'); label.append(el('span', 'form-label', t('numberChanges.compareDate')), date);
  controls.append(label, metric, envelopeHost);
  const results = el('div', 'number-changes-results');
  results.setAttribute('aria-live', 'polite');
  content.append(intro, controls, results, el('p', 'sub', t('numberChanges.historyStorage')));
  const sheet = openSheet({ title: t('numberChanges.title'), content, wide: true, onClose: () => { closed = true; off(); offState(); } });
  const off = onBudgetSessionChange(() => sheet.close());
  const offState = subscribeState(() => { if (live() && date.value) void paint(); });
  enhanceSelectWithSearch(envelope);
  async function initialize() {
    try {
      const r = await session.dispatch('history.initialize', {});
      if (!live()) return;
      if (!r.ok) { results.replaceChildren(el('p', 'sub', t('numberChanges.historyFailed'))); return; }
      const start = state.meta?.financialHistory?.start?.date;
      const yesterday = now(); yesterday.setDate(yesterday.getDate() - 1);
      date.value = start && start > isoDate(yesterday) ? start : isoDate(yesterday);
      if (!start && state.meta?.comparisonPoint) date.value = state.meta.comparisonPoint.date;
      await paint();
    } catch (error) {
      console.warn('History initialization failed:', error);
      if (live()) results.replaceChildren(el('p', 'sub', t('numberChanges.historyFailed')));
    }
  }

  async function paint() {
    const ticket = ++generation;
    envelopeHost.hidden = metric.value !== 'spare';

    results.replaceChildren(el('p', 'muted', t('common.loading')));
    await paintYield();
    if (!live() || ticket !== generation) return;
    if (metric.value === 'spare' && !envelope.value) {
      results.replaceChildren(el('p', 'sub', t('numberChanges.noEnvelope'))); return;
    }
    if (!date.value || date.value > date.max) { results.replaceChildren(el('p', 'sub', t('numberChanges.invalidDate'))); return; }
    const answer = ask('comparison.explain', { date: date.value, metric: metric.value, ...(metric.value === 'spare' ? { envelope: envelope.value } : {}), ...activeLensInput() });
    results.replaceChildren();
    if (!answer) { results.append(el('p', 'sub', t('numberChanges.failed'))); return; }
    if (answer.coverage?.gap) results.append(el('p', 'sub', t('numberChanges.historyGap')));
    if (answer.coverage) results.append(el('p', 'sub', `${t('numberChanges.historySince')}: ${fmtDateLang(answer.coverage.start.date)}`));
    if (answer.status === 'unavailable' && answer.reason === 'history') { results.append(el('p', 'sub', t('numberChanges.historyUnavailable'))); return; }
    if (answer.status === 'missing') { results.append(el('p', 'sub', t('numberChanges.missing'))); return; }
    if (answer.status === 'unavailable') { results.append(el('p', 'sub', t(answer.reason === 'currency' ? 'numberChanges.currency' : 'numberChanges.unavailable'))); return; }
    results.append(el('p', 'sub', t(answer.source === 'savedPoint' ? 'numberChanges.legacyPoint' : answer.partialDay ? 'numberChanges.partialDay' : 'numberChanges.startOfDay')));
    const basis = (view) => t('lens.' + view.lens) + (view.horizon ? ` · ${view.horizon}` : '');
    results.append(el('p', 'sub', `${fmtDateLang(answer.beforeDate)} → ${fmtDateLang(answer.afterDate)}`));
    if (metric.value === 'netWorth') results.append(el('p', 'sub', `${basis(answer.beforeView)} → ${basis(answer.afterView)}`));
    else results.append(el('p', 'sub', t('numberChanges.independent')));
    const amounts = el('dl', 'number-changes-totals');
    for (const [key, value] of [['before', answer.before], ['after', answer.after], ['difference', answer.delta]]) {
      const item = el('div', '');
      item.append(el('dt', 'sub', t('numberChanges.' + key)), el('dd', '', fmt(value, { signed: key === 'difference' })));
      amounts.append(item);
    }
    results.append(amounts);
    if (answer.steps.some(step => step.sources.some(source => source.amount))) results.append(el('p', 'sub number-changes-amount-note', t('numberChanges.recordAmounts')));
    if (!answer.steps.length) results.append(el('p', 'sub', t('numberChanges.unchanged')));
    for (const step of answer.steps) {
      const block = el('details', 'number-changes-step');
      const summary = el('summary', '');
      const heading = el('span', 'number-changes-heading');
      heading.append(el('span', '', t('numberChanges.groups.' + step.group)));
      if (routes[step.group]) {
        const source = button(t('numberChanges.openSource'), () => { sheet.close(); navigate(routes[step.group]); });
        source.addEventListener('click', event => event.stopPropagation());
        heading.append(source);
      }
      summary.append(heading, el('strong', '', fmt(step.delta, { signed: true })));
      block.append(summary);
      if (step.sources.length) {
        block.append(comparisonSourceTable(step, () => sheet.close()));
        if (step.count > step.sources.length) block.append(el('p', 'sub', t('numberChanges.truncated')));
      }
      if (step.group === 'date') {
        block.append(comparisonDetailTable({ details: [{ path: ['date'], before: fmtDateLang(answer.beforeDate), after: fmtDateLang(answer.afterDate), format: 'text' }] }), el('p', 'sub', t('numberChanges.dateHelp')));
      }
      if (step.group === 'view') block.append(comparisonDetailTable({ details: [{ path: ['balanceView'], before: basis(answer.beforeView), after: basis(answer.afterView), format: 'text' }] }));
      results.append(block);
    }
    results.append(el('p', 'sub', t('numberChanges.order')));
  }
  metric.addEventListener('change', paint);
  envelope.addEventListener('change', paint);
  date.addEventListener('change', paint);
  results.append(el('p', 'sub', t('common.loading')));
  void initialize();
}

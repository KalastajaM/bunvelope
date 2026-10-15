import { rememberDetails } from '../ui/remember-details.js';
import { infoButton } from '../ui/info-button.js';
import { moneyEl } from '../ui/money.js';
// The Overview's working surfaces. Money comes from the same core queries
// and preview pipeline as the other pages; this module only presents it.
import { state, session, navigate, activeLensInput, now } from '../app.js';
import { currentBudgetSession } from '../state/budget-session.js';
import { isoDate } from '../core/context.js';
import { ask } from '../ui/query.js';
import { t, trEnv, trCat, fmtDateLang } from '../ui/i18n.js';
import { fmt } from '../utils.js';
import { envelopeGoalLine } from '../ui/envelope-card.js';
import { envelopeMeterState } from '../ui/envelope-meter.js';
import { icon } from '../ui/icon.js';
import { openSheet } from '../ui/sheet.js';
import { openFillEnvelopes } from './fill-envelopes.js';
import { describeError } from '../core/errors.js';
import { openNumberChanges } from './number-changes.js';
import { purchaseCheckButton } from './purchase-check.js';

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (text, action, cls = 'btn btn-sm btn-ghost') => {
  const node = el('button', cls, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
};
function envelopeReviewButton(env) {
  const label = t('overview.reviewEnvelope')(trEnv(env));
  const review = button('', () => openOverviewEnvelope(env.id), 'btn btn-sm btn-ghost btn-icon');
  review.append(icon('pulse', 22));
  review.title = label;
  review.setAttribute('aria-label', label);
  return review;
}

export function overviewSection(title, subtitle, cls = '') {
  const card = el('section', `card ${cls}`);
  const head = el('div', 'card-title');
  const left = el('div');
  left.append(el('h3', '', title));
  if (subtitle) left.append(el('p', 'sub', subtitle));
  head.append(left);
  card.append(head);
  return card;
}

// A small, explicitly labelled net-worth preview of the existing simulation.
// Keep the day-by-day alerts separate: month-end totals can hide a shortfall.
export function updateOverviewForecast(host, simulation) {
  if (!host) return;
  host.replaceChildren();
  const points = simulation?.points?.slice(0, 12);
  if (!points?.length || points.some(p => !Number.isFinite(p.total))) {
    host.append(el('p', 'muted', t('overview.unavailable')));
    return;
  }
  const heading = el('div', 'overview-forecast-heading');
  heading.append(el('span', '', t('overview.forecastTitle')));
  const link = el('a', '', t('overview.reviewForecast'));
  link.href = '#/net-worth';
  heading.append(link);
  const svgNode = (tag, attrs) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
  };
  const svg = svgNode('svg', { viewBox: '0 0 600 76', preserveAspectRatio: 'none', role: 'img' });
  svg.setAttribute('aria-label', `${t('overview.forecastTitle')}: ${points.map(p => `${fmtDateLang(p.date)}: ${fmt(p.total)}`).join('; ')}`);
  const low = Math.min(...points.map(p => p.total));
  const high = Math.max(...points.map(p => p.total));
  // Fit the forecast range: a zero baseline hides small changes in large balances.
  // Flat series stay centred; changing series leave breathing room at both ends.
  const padding = (high - low) * 0.1;
  const y = value => high === low ? 38 : 66 - (value - low + padding) / (high - low + 2 * padding) * 56;
  const x = i => 4 + i / Math.max(1, points.length - 1) * 592;
  if (low <= 0 && high >= 0) {
    svg.append(svgNode('line', { x1: 4, x2: 596, y1: y(0), y2: y(0), class: 'overview-forecast-zero' }));
  }
  svg.append(svgNode('polyline', { points: points.map((p, i) => `${x(i)},${y(p.total)}`).join(' '), fill: 'none', stroke: 'currentColor', 'stroke-width': 2.5, 'vector-effect': 'non-scaling-stroke' }));
  for (const i of new Set([0, points.length - 1])) svg.append(svgNode('circle', { cx: x(i), cy: y(points[i].total), r: 3, fill: 'currentColor' }));
  const labels = el('div', 'overview-forecast-labels');
  for (const point of [points[0], points[points.length - 1]]) {
    const label = el('div');
    label.append(el('strong', point.total < 0 ? 'overview-short' : '', fmt(point.total)), el('small', '', fmtDateLang(point.date)));
    labels.append(label);
  }
  host.append(heading, svg, labels, el('p', 'muted overview-forecast-scale', t('overview.forecastScale')));
}

export function buildOverviewWorkspace(view) {
  const active = state.envelopes.filter(e => !e.archived);
  const snapshot = ask('envelopes.month', { ...view.lens, date: view.date, envelopes: active.map(e => e.id) });
  const rows = new Map((snapshot?.envelopes || []).map(e => [e.id, e]));
  const short = active.filter(e => rows.get(e.id)?.spare?.spare < -0.005)
    .sort((a, b) => (rows.get(a.id).spare.lowDate || '').localeCompare(rows.get(b.id).spare.lowDate || ''));
  const attention = overviewSection(t('attention.title'), t('overview.projectionBasis'), 'overview-attention');
  attention.querySelector('h3').append(infoButton(null, { title: t('attention.title'), body: t('attention.scope') }));
  const attentionHost = el('div', 'overview-attention-results');
  attentionHost.setAttribute('aria-live', 'polite');
  attentionHost.append(el('p', 'muted', t('overview.forecastLoading')));
  attention.append(attentionHost);
  const alerts = el('div', 'overview-alerts');
  alerts.setAttribute('aria-live', 'polite');
  const forecast = el('div', 'overview-forecast');
  forecast.append(el('p', 'muted', t('overview.forecastLoading')));
  const forecastDetails = rememberDetails(el('details', 'overview-forecast-details daily-details'), 'forecast');
  forecastDetails.append(el('summary', '', t('overview.forecastTitle')), forecast);
  attention.append(alerts, forecastDetails);
  if (!snapshot) return { attention, envelopes: null };

  const card = overviewSection(t('dashboard.envelopes'), null, 'overview-envelopes');
  card.querySelector('h3').append(infoButton('envelopeFigures'));
  card.querySelector('.card-title').append(button(t('dashboard.allEnvelopes'), () => navigate('envelopes')));
  const tools = el('div', 'overview-tools');
  const tabs = el('div', 'seg overview-tabs');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', t('overview.envelopeFilter'));
  const search = el('input', 'form-input overview-search');
  search.type = 'search'; search.placeholder = t('overview.search');
  search.setAttribute('aria-label', t('overview.search'));
  const table = el('div', 'overview-table');
  const head = el('div', 'overview-table-head');
  for (const label of [t('overview.envelope'), t('overview.balanceBasis')(t('lens.' + view.lens.lens)), t('overview.projectedSpare'), t('overview.monthSpending'), '']) head.append(el('span', '', label));
  const body = el('div', 'overview-table-body');
  const footer = el('div', 'overview-table-footer');
  const count = el('span');
  footer.append(count, el('span', '', t('overview.projectionBasis')));
  table.append(head, body);
  tools.append(tabs, search);
  card.append(tools, table, footer);
  let filter = 'favorites';
  const favorites = active.filter(e => e.favorite);
  const choices = new Map();
  for (const [key, label] of [['favorites', t(favorites.length ? 'overview.favorites' : 'overview.snapshot')], ['attention', t('overview.attention')], ['all', t('overview.all')]]) {
    const tab = button(label, () => { filter = key; paint(); }, 'overview-tab');
    tab.title = t(`overview.${key === 'favorites' ? favorites.length ? 'favoritesHint' : 'snapshotHint' : key + 'Hint'}`);
    tab.setAttribute('aria-description', tab.title);
    tabs.append(tab); choices.set(key, tab);
  }
  function paint() {
    const term = search.value.trim().toLocaleLowerCase();
    let shown = term || filter === 'all' ? active : filter === 'attention' ? short : (favorites.length ? favorites : active).slice(0, 8);
    if (term) shown = shown.filter(e => `${trEnv(e)} ${trCat(e.category || 'other')}`.toLocaleLowerCase().includes(term));
    for (const [key, tab] of choices) tab.setAttribute('aria-pressed', String(key === (term ? 'all' : filter)));
    body.replaceChildren();
    for (const env of shown) {
      const f = rows.get(env.id);
      if (!f) continue;
      const row = el('div', 'overview-envelope-row');
      row.dataset.envelopeId = env.id;
      const name = button(trEnv(env), () => navigate('transactions', env.id), 'overview-envelope-name');
      name.append(el('small', '', trCat(env.category || 'other')));
      const balance = el('div', 'overview-money');
      balance.append(el('small', 'overview-mobile-label', t('overview.balanceBasis')(t('lens.' + view.lens.lens))), el('strong', 'money-amount money-table', fmt(f.balance)));
      if (Math.abs(f.balance - f.todayBalance) > 0.005) balance.append(el('small', 'env-upcoming', t('envelopes.upcomingHint')(fmt(f.balance - f.todayBalance, { signed: true }))));
      const spare = button('', () => openOverviewEnvelope(env.id), 'overview-money overview-spare');
      spare.append(el('small', 'overview-mobile-label', t('overview.projectedSpare')), el('strong', f.spare?.spare < -0.005 ? 'overview-short money-amount money-table' : 'money-amount money-table', f.spare ? fmt(f.spare.spare) : '—'));
      spare.setAttribute('aria-label', `${trEnv(env)}: ${t('overview.projectedSpare')} ${f.spare ? fmt(f.spare.spare) : '—'}`);
      spare.title = t(f.spare?.spare < -0.005 ? 'overview.gapExplanation' : 'overview.spareExplanation');
      const spend = el('div', 'overview-spending-cell');
      const plan = f.monthPlanned ?? f.planned;
      const wording = plan > 0 ? t('envelopes.spentOfPlanned')({ spent: fmt(f.spent), amt: fmt(plan) }) : t('overview.spentNoPlan')(fmt(f.spent));
      spend.append(el('div', 'env-spent-line', wording));
      const meter = envelopeMeterState(f);
      const track = el('div', 'overview-progress');
      const fill = el('span'); fill.style.width = meter.meterPct + '%';
      track.classList.toggle('is-over', meter.overPlan); track.append(fill); spend.append(track);
      const goalLine = envelopeGoalLine(f.goal);
      if (goalLine) spend.append(goalLine);
      const review = envelopeReviewButton(env);
      row.append(name, balance, spare, spend, review); body.append(row);
    }
    if (!body.childElementCount) body.append(el('p', 'overview-empty muted', t('overview.noMatches')));
    count.textContent = t('overview.showing')({ shown: body.querySelectorAll('.overview-envelope-row').length, total: active.length });
  }
  search.addEventListener('input', paint);
  paint();
  return { attention, envelopes: card };
}

export function buildOverviewSpending(spending) {
  if (!spending) return null;
  const card = overviewSection(t('dashboard.kpi.spent'), t('overview.recordedActivity'), 'overview-spending');
  const amount = el('div', 'overview-spent-amount money-metric');
  amount.append(moneyEl(spending.spent, { role: 'summary' }));
  card.append(amount, el('p', 'sub', t('overview.calendarPlan')(fmt(spending.calendarPlanned))));
  const track = el('div', 'overview-progress');
  const fill = el('span'); fill.style.width = Math.min(100, Math.max(0, spending.calendarSpentPct)) + '%';
  track.classList.toggle('is-over', spending.calendarSpentPct > 100); track.append(fill); card.append(track);
  card.append(el('p', 'sub', t('dashboard.kpiSpentSub')(spending.calendarSpentPct, spending.daysLeft)));
  for (const category of spending.byCategory.slice(0, 3)) {
    const row = el('div', 'overview-category');
    row.append(el('span', '', trCat(category.category)), el('strong', '', fmt(category.amount))); card.append(row);
  }
  card.append(button(t('overview.spendingDetails'), () => navigate('reports')));
  return card;
}

// Review and preview always re-read current queries. The session token prevents
// a sheet from carrying an old budget's suggestion into a newly opened budget.
export function openOverviewEnvelope(id) {
  const token = currentBudgetSession();
  const env = state.envelopes.find(e => e.id === id && !e.archived);
  if (!env) return;
  const lens = activeLensInput();
  const date = isoDate(now());
  const snap = ask('envelopes.month', { ...lens, date, envelopes: [id] });
  const f = snap?.envelopes[0];
  if (!f) return;
  const review = ask('review.month', { month: date.slice(0, 7) });
  const need = review?.rows.find(r => r.envelope_id === id)?.need;
  const content = el('div', 'overview-envelope-detail');
  const figures = el('div', 'overview-detail-figures');
  for (const [label, value] of [[t('overview.balanceBasis')(t('lens.' + lens.lens)), f.balance], [t('overview.projectedSpare'), f.spare?.spare]]) {
    const cell = el('div'); cell.append(el('small', '', label), el('strong', value < -0.005 ? 'overview-short' : '', value == null ? '—' : fmt(value))); figures.append(cell);
  }
  content.append(figures);
  content.append(button(t('numberChanges.title'), () => openNumberChanges(id)));
  content.append(purchaseCheckButton(id));
  if (f.spare) {
    const explanation = rememberDetails(el('details', 'overview-projection-explanation daily-details'), 'projection');
    explanation.append(
      el('summary', '', t('overview.projectionHeading')),
      el('p', '', t('overview.projectionExplanation')),
      el('p', '', t(f.spare.spare < -0.005 ? 'overview.gapExplanation' : 'overview.spareExplanation')),
    );
    const details = el('dl', 'overview-preview-values');
    details.append(el('dt', '', t('overview.lowBalance')), el('dd', f.spare.lowBalance < -0.005 ? 'overview-short' : '', fmt(f.spare.lowBalance)));
    if (f.spare.lowDate) details.append(el('dt', '', t('overview.lowDate')), el('dd', '', fmtDateLang(f.spare.lowDate)));
    details.append(el('dt', '', t('overview.reserveFloor')), el('dd', '', fmt(f.spare.floor)));
    explanation.append(details, el('p', 'muted', t('overview.reserveExplanation')));
    content.append(explanation);
  }
  const goals = el('div', 'overview-funding-goals');
  const previewHost = el('div', 'overview-preview');
  previewHost.setAttribute('aria-live', 'polite');
  let sheet;
  let latestPreview = 0;
  async function preview(amount, goal) {
    const request = ++latestPreview;
    previewHost.replaceChildren(el('p', 'sub', t('overview.previewLoading')));
    const steps = [{ name: 'allocation.fill', input: { lines: [{ envelope: id, amount }], date } }];
    try {
      const [after, today, envelope] = await Promise.all([
        session.queryAfter(steps, 'balances', lens),
        session.queryAfter(steps, 'balances', { lens: 'today' }),
        session.queryAfter(steps, 'envelopes.month', { ...lens, date, envelopes: [id] }),
      ]);
      if (request !== latestPreview || !content.isConnected || token !== currentBudgetSession()) return;
      const failed = [after, today, envelope].find(r => !r.ok);
      if (failed) { previewHost.replaceChildren(el('p', 'overview-short', describeError(failed.error, t))); return; }
      const row = envelope.value.envelopes.find(e => e.id === id);
      previewHost.replaceChildren(el('h4', '', t('overview.previewTitle')(fmt(amount))), el('p', 'sub', goal));
      const list = el('dl', 'overview-preview-values');
      for (const [label, value] of [[t('overview.resultBalance'), row?.balance], [t('overview.resultSpare'), row?.spare?.spare], [t('overview.poolBasis')(t('lens.' + lens.lens)), after.value.unallocated], ...(lens.lens === 'today' ? [] : [[t('overview.poolBasis')(t('lens.today')), today.value.unallocated]])]) {
        list.append(el('dt', '', label), el('dd', value < -0.005 ? 'overview-short' : '', value == null ? '—' : fmt(value)));
      }
      previewHost.append(list);
      if (after.value.unallocated < -0.005) previewHost.append(el('p', 'overview-preview-warning', t('overview.exceedsPool')(fmt(Math.abs(after.value.unallocated)))));
      else if (today.value.unallocated < -0.005) previewHost.append(el('p', 'overview-preview-warning', t('overview.todayNegative')));
      previewHost.append(el('p', 'sub', t('overview.previewOnly')), button(t('overview.reviewAssignment'), () => {
        if (token !== currentBudgetSession()) return;
        sheet.close();
        openFillEnvelopes({ initialAmounts: { [id]: amount }, onSubmitted: () => navigate('dashboard') });
      }, 'btn btn-accent'));
    } catch (error) {
      console.error('Overview allocation preview failed:', error);
      if (content.isConnected && request === latestPreview && token === currentBudgetSession()) previewHost.replaceChildren(el('p', 'overview-short', t('overview.unavailable')));
    }
  }
  if (f.spare?.spare < -0.005) {
    const amount = Math.abs(f.spare.spare);
    goals.append(button(t('overview.coverGap')(fmt(amount)), () => preview(amount, t('overview.gapGoal')), 'btn btn-ghost'));
  }
  if (Number.isFinite(need) && need > 0.005) goals.append(button(t('overview.fundReserve')(fmt(need)), () => preview(need, t('overview.reserveGoal')), 'btn btn-ghost'));
  if (goals.childElementCount) content.append(el('h4', '', t('overview.fundingGoals')), el('p', 'sub', t('overview.goalsExplanation')), goals, previewHost);
  const activity = button(t('overview.envelopeActivity'), () => { sheet.close(); navigate('transactions', id); });
  const close = button(t('common.close'), () => sheet.requestClose());
  close.style.fontFamily = 'var(--font-ui)';
  sheet = openSheet({ title: trEnv(env), content, headerActions: [activity, close] });
}

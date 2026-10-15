// js/pages/dashboard.js
import { fitDetails } from '../ui/fit-details.js';
import { infoButton, addPageHelp } from '../ui/info-button.js';
import { state, navigate, activeLensInput, now, now as appNow } from '../app.js';
import { fillDisplayTotal, fillSetLineCount, txAbsAmount, isAssetAccount, txAccountDelta } from '../engine.js';
import { fmt, fmtPct } from '../utils.js';
import { moneyEl, amountText } from '../ui/money.js';
import { ask } from '../ui/query.js';
import { sparkBars } from '../ui/spark.js';
import { t, fmtDateShortLang, fmtDateLang, langLocale, trEnv } from '../ui/i18n.js';
import { buildOverviewWorkspace, buildOverviewSpending, overviewSection, updateOverviewForecast, openOverviewEnvelope } from './dashboard-workspace.js';
import { accountCard } from '../ui/account-card.js';
import { mountChart } from '../ui/charts/index.js';
import { avatar } from '../ui/avatar.js';
import { icon } from '../ui/icon.js';
import { openFillEnvelopes } from './fill-envelopes.js';
import { openSheet } from '../ui/sheet.js';
import { skeletonCard, paintYield } from '../ui/skeleton.js';
import { isoDate } from '../core/context.js';
import { updateOverviewAttention } from './overview-attention.js';
import { buildGettingStartedCard } from './getting-started.js';
import { needsAttention } from '../ui/item-funding-view.js';
import { recurringReminderNotice } from '../ui/recurring-reminder-notice.js';
import { numberChangesButton } from './number-changes.js';
import { purchaseCheckButton } from './purchase-check.js';

export async function render(container) {
  const page = document.createElement('div');
  page.className = 'page page-dashboard';

  // The card builders below scan the full transaction list several times,
  // which can block long enough to show a blank page on large budgets.
  // Paint the head + skeleton placeholders, yield a frame so they render,
  // then swap in the real cards (same pattern as reports.js).
  page.append(buildHead());
  const skels = [skeletonCard({ blockHeight: 120 }), skeletonCard({ lineWidth: '24%', blockHeight: 160 })];
  page.append(...skels);
  container.append(page);
  await paintYield();
  // Navigated away during the yield: the cards would only go into a detached
  // page, so skip building them.
  if (!page.isConnected) return;

  // One "today" for the whole render: every query is asked about the same
  // day, and the lens ones about the same lens.
  const today = appNow();
  const view = { today, date: isoDate(today), lens: activeLensInput() };
  const spending = ask('spending.month', { date: view.date });

  const cards = [];
  // First, above the figures: on a new budget they are all zero, and the
  // checklist is what says how to change that.
  const gettingStarted = buildGettingStartedCard();
  if (gettingStarted) cards.push(gettingStarted);
  const workspace = buildOverviewWorkspace(view);
  const recurringNotice = recurringReminderNotice(ask('recurring.costs', { date: view.date }), () => navigate('recurring-costs', { filter: 'attention' }));
  if (recurringNotice) workspace.attention.querySelector('.overview-alerts')?.append(recurringNotice);
  const top = document.createElement('div');
  top.className = 'overview-top';
  top.append(workspace.attention);
  const heroCard = buildHero(view);
  if (heroCard) top.append(heroCard);
  cards.push(top);
  if (workspace.envelopes) cards.push(workspace.envelopes);

  const daily = document.createElement('div');
  daily.className = 'two-col overview-daily';
  const upcoming = buildUpcomingCard(view);
  const spendingCard = buildOverviewSpending(spending);
  if (upcoming) daily.append(upcoming);
  if (spendingCard) daily.append(spendingCard);
  if (daily.childElementCount) cards.push(daily);

  const annualPlanCard = buildAnnualPlanCard(view);
  if (annualPlanCard) {
    const planning = overviewSection(t('overview.biggerPicture'), t('overview.planSeparate'), 'overview-planning');
    planning.append(annualPlanCard);
    cards.push(planning);
  }

  skels.forEach(s => s.remove());
  page.append(...cards);
  if (heroCard) fitDetails(top, heroCard, workspace.attention, heroCard.querySelector('.overview-pool-breakdown'), 'balance');

  scheduleActOnAlert(page, view.date);
  scheduleItemAttention(page);
}

// A separate route keeps the deeper analysis available without building it
// on every visit to the daily workspace.
export async function renderDetailedInsights(container) {
  const page = document.createElement('div');
  page.className = 'page page-dashboard page-detailed-insights';
  const head = document.createElement('div');
  head.className = 'page-head';
  const col = document.createElement('div');
  const title = document.createElement('h1');
  title.textContent = t('nav.detailedInsights');
  addPageHelp(title, 'overview.insightsDescription');
  col.append(title);
  head.append(col);
  const skeleton = skeletonCard({ blockHeight: 160 });
  page.append(head, skeleton);
  container.append(page);
  await paintYield();
  if (!page.isConnected) return;

  const today = appNow();
  const view = { today, date: isoDate(today), lens: activeLensInput() };
  const spending = ask('spending.month', { date: view.date });
  const kpiRow = buildKpiRow(view, spending);
  if (kpiRow) page.append(kpiRow);
  const favAccountsCard = buildFavoriteAccountsCard(view);
  if (favAccountsCard) page.append(favAccountsCard);
  const summaries = document.createElement('div');
  summaries.className = 'insights-summary-row';
  const ccCard = buildCreditCardsToPayCard(view);
  if (ccCard) summaries.append(ccCard);
  const spendCard = buildCategorySpendCard(view, spending);
  if (spendCard) summaries.append(spendCard);
  if (summaries.childElementCount) page.append(summaries);
  page.append(buildRecentCard());
  const trendCard = buildTrendCard(view);
  if (trendCard) page.append(trendCard);
  skeleton.remove();
}

// Local midnight of a YYYY-MM-DD (or the 1st of a YYYY-MM), for labels.
function dateOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d || 1);
}

// Fill %: one line when budget items will not be paid on their due date,
// linking to the Budget plan filtered to just those. Deferred like the
// act-on card above: it projects every envelope that has budget items.
function scheduleItemAttention(page) {
  scheduleIdle(() => {
    if (!page.isConnected) return;
    const funding = ask('plan.funding', { date: isoDate(now()) });
    if (!funding) return;
    const count = funding.items.filter(item => needsAttention(item.status)).length;
    if (count === 0) return;
    page.querySelector('.dashboard-items-card')?.remove();
    const card = document.createElement('div');
    card.className = 'card dashboard-act-card dashboard-items-card';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;';
    const text = document.createElement('div');
    text.style.cssText = 'font-size:13.5px;';
    text.textContent = t('dashboard.itemsAttention')(count);
    const link = document.createElement('a');
    link.style.cssText = 'font-size:12px;color:var(--accent-ink);cursor:pointer;white-space:nowrap;text-decoration:underline;';
    link.textContent = t('dashboard.itemsAttentionShow');
    link.setAttribute('role', 'button');
    link.tabIndex = 0;
    // navigate() owns state.pendingFilter: it sets it from its second argument.
    const go = () => navigate('budget-plan', { funding: 'attention' });
    link.addEventListener('click', go);
    link.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    row.append(text, link);
    card.append(row);
    page.querySelector('.overview-alerts')?.append(card);
  });
}

// Defer the daily forecasts until after the working surface has painted.
const scheduleIdle = (fn) => (
  typeof requestIdleCallback === 'function'
    ? requestIdleCallback(fn, { timeout: 500 })
    : setTimeout(fn, 0)
);

function scheduleActOnAlert(page, date) {
  scheduleIdle(() => {
    if (!page.isConnected) return;
    updateOverviewAttention(page.querySelector('.overview-attention-results'), ask('overview.attention', { date }), openOverviewEnvelope);
    const simulation = ask('forecast.simulation', { date });
    updateOverviewForecast(page.querySelector('.overview-forecast'), simulation);
  });
}

function buildHead() {
  const head = document.createElement('div');
  head.className = 'page-head';
  const col = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.textContent = t('dashboard.title');
  addPageHelp(h1, 'tour.steps.dashboard.body');
  col.append(h1);
  head.append(col);
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(numberChangesButton(), purchaseCheckButton());
  head.append(actions);

  return head;
}

function buildHero(view) {
  const balances = ask('balances', view.lens);
  if (!balances) return null;
  const { unallocated, totals } = balances;

  const isBalanced = Math.abs(unallocated) < 0.01;
  const isOver = unallocated < -0.005;

  const card = document.createElement('div');
  card.className = 'card hero-card' + (isBalanced ? ' is-balanced' : isOver ? ' is-over' : ' is-assign');

  const row = document.createElement('div');
  row.className = 'hero-row';

  const left = document.createElement('div');
  left.className = 'hero-left';

  const lbl = document.createElement('div');
  lbl.className = 'hero-label';
  lbl.textContent = t('overview.poolBasis')(t('lens.' + view.lens.lens));

  const val = document.createElement('div');
  val.className = 'hero-val money-metric';
  val.append(moneyEl(isBalanced ? 0 : unallocated, { role: 'hero' }));
  if (isBalanced) val.classList.add('is-balanced');

  const body = document.createElement('div');
  body.className = 'hero-body';
  body.textContent = isBalanced ? t('dashboard.heroBalancedBody')
    : isOver ? t('dashboard.heroOverBody')
    : t('dashboard.heroAssignBody');
  const basis = document.createElement('p');
  basis.className = 'sub overview-pool-basis';
  basis.textContent = t('lens.' + view.lens.lens + 'Hint');

  lbl.append(infoButton('unallocated', { intro: t('lens.' + view.lens.lens + 'Hint') }));
  left.append(lbl, val, body);

  const right = document.createElement('div');
  right.className = 'hero-meta';
  // The account side of the SAME identity `unallocated` was computed from
  // (`identityAccountTotal`: investment, asset and loan accounts are not
  // money waiting to be assigned), so the three figures explain each other.
  // It used to be every account balance, which on the example budget put the
  // portfolio into "total balance" and understated the share assigned.
  const { envelopes: envTotal, accounts: acctTotal, assignedPct } = totals;

  // Two stacked rows so the meta layout matches the Annual Plan card next
  // to it (Assigned / Total balance instead of one combined "X of Y" line).
  const assignedLbl = document.createElement('div');
  assignedLbl.className = 'hero-meta-lbl';
  assignedLbl.textContent = t('dashboard.heroAssigned');
  const assignedVal = document.createElement('div');
  assignedVal.className = 'hero-meta-val';
  assignedVal.textContent = fmt(envTotal);

  const totalLbl = document.createElement('div');
  totalLbl.className = 'hero-meta-lbl';
  totalLbl.textContent = t('dashboard.heroTotalBalance');
  const totalVal = document.createElement('div');
  totalVal.className = 'hero-meta-val';
  totalVal.textContent = fmt(acctTotal);

  const metaPct = document.createElement('div');
  metaPct.className = 'hero-meta-pct';
  metaPct.textContent = t('dashboard.heroPctOfBalance')(assignedPct);
  right.append(assignedLbl, assignedVal, totalLbl, totalVal, metaPct);

  row.append(left);
  card.append(row);
  const otherLens = view.lens.lens === 'today' ? 'booked' : 'today';
  const other = ask('balances', { lens: otherLens });
  if (other) {
    const comparison = document.createElement('div');
    comparison.className = 'overview-pool-comparison';
    const label = document.createElement('span');
    label.textContent = t('overview.poolBasis')(t('lens.' + otherLens));
    const value = document.createElement('strong');
    value.textContent = fmt(other.unallocated);
    if (other.unallocated < -0.005) value.className = 'overview-short';
    comparison.append(label, value);
    card.append(comparison);
  }
  const breakdown = document.createElement('details');
  breakdown.className = 'overview-pool-breakdown';
  const summary = document.createElement('summary');
  summary.textContent = t('overview.balanceBreakdown');
  breakdown.append(summary, basis, right);
  card.append(breakdown);

  const bar = document.createElement('div');
  bar.className = 'hero-healthbar';
  const barFill = document.createElement('div');
  barFill.style.width = '0%';
  bar.append(barFill);
  breakdown.append(bar);
  requestAnimationFrame(() => { barFill.style.width = assignedPct + '%'; });

  if (!isBalanced) {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn btn-accent hero-action';
    action.textContent = isOver
      ? t('overview.returnAction')
      : t('overview.assignAction');
    action.addEventListener('click', (e) => {
      e.stopPropagation();
      openFillEnvelopes({ mode: isOver ? 'return' : 'fill', onSubmitted: () => navigate('dashboard') });
    });
    row.after(action);
  } else {
    const ok = document.createElement('div');
    ok.className = 'hero-ok';
    ok.textContent = '✓ ' + t('dashboard.heroBalancedHead');
    card.append(ok);
  }
  return card;
}

// The donut's slices: spending.month's byCategory (largest first, 'other'
// for an envelope without a category), with the page's colours and labels.
function categorySpendSegments(byCategory) {
  const CAT_COLOR = {
    housing: 'oklch(0.86 0.08 50)', transport: 'oklch(0.85 0.08 235)',
    food: 'oklch(0.84 0.08 155)', leisure: 'oklch(0.85 0.07 300)',
    utilities: 'oklch(0.9 0.08 95)', saving: 'oklch(0.84 0.08 155)',
    debt: 'oklch(0.86 0.07 20)', other: 'oklch(0.72 0.012 70)',
  };
  // Palette for user-defined categories that don't match the known keys.
  // Hues are spaced around the wheel for maximum distinction at a glance.
  const PALETTE = [
    'oklch(0.85 0.08 30)',  'oklch(0.85 0.08 75)',  'oklch(0.86 0.08 120)',
    'oklch(0.84 0.08 165)', 'oklch(0.83 0.08 210)', 'oklch(0.82 0.08 255)',
    'oklch(0.83 0.08 300)', 'oklch(0.85 0.08 345)',
  ];
  let paletteIdx = 0;
  return byCategory.map(({ category: cat, amount: value }) => ({
    key: cat,
    value,
    color: CAT_COLOR[cat] || PALETTE[paletteIdx++ % PALETTE.length],
    label: (function () {
      const v = t('cat.' + cat);
      return v !== ('cat.' + cat) ? v : cat;
    })(),
  }));
}

function buildKpiRow(view, spending) {
  const row = document.createElement('div');
  row.className = 'kpi-row';
  const loc = langLocale();

  if (spending) {
    const { spent, calendarPlanned: planned, calendarSpentPct: spentPct, averageMonthlyFunding, daysLeft, month } = spending;
    const spentCard = kpi({
      label: t('dashboard.kpi.spent'),
      value: moneyEl(spent, { role: 'summary' }),
      sub: planned > 0 ? t('dashboard.kpiSpentSub')(spentPct, daysLeft)
        : `${t('dashboard.kpi.planned')} ${fmt(planned)}`,
      extra: progressBar(spentPct),
    });
    const funding = document.createElement('div');
    funding.className = 'muted';
    funding.textContent = `${t('dashboard.averageMonthlyFunding')}: ${fmt(averageMonthlyFunding)}`;
    spentCard.append(funding);
    makeClickableCard(spentCard, () => navigate('transactions', `month:${month}`));
    row.append(spentCard);
  }

  // The spending part of net worth, so this card and the Net worth card's
  // "Spending" figure are one number: both skip archived accounts, as the
  // Accounts page and the runway do. The bars are what had cleared by each of
  // the last six month ends (not the lens: a history that moved with the view
  // would be claiming the past had changed).
  const cash = ask('cash.position', { ...view.lens, date: view.date });
  if (cash) {
    const sparkData = cash.series.map(p => p.balance);
    const sparkLabels = cash.series.map(p => dateOf(p.date).toLocaleDateString(loc, { month: 'short' }));
    let balanceSub = `${cash.accountCount} ${t('dashboard.kpi.accounts')}`;
    if (cash.delta != null) {
      balanceSub = t('dashboard.kpiBalanceSub')(fmt(cash.delta, { signed: true, decimals: 0 }));
    }
    // How much of that total the bank does not show yet: under Booked or
    // Forecast the figure includes future-dated and scheduled rows, which on
    // the owner's budget was most of it (ux-review U1). Nothing under Today.
    if (Math.abs(cash.notYetCleared) >= 0.5) {
      balanceSub = `${balanceSub} · ${t('dashboard.inclNotYetCleared')(fmt(cash.notYetCleared, { signed: true, decimals: 0 }))}`;
    }
    const balCard = kpi({
      label: t('dashboard.kpi.balance'),
      value: moneyEl(cash.balance, { role: 'summary' }),
      sub: balanceSub,
      extra: sparkBars({ data: sparkData, labels: sparkLabels, format: (v) => fmt(v, { decimals: 0 }) }),
    });
    makeClickableCard(balCard, () => navigate('accounts'));
    row.append(balCard);
  }

  // Net worth across the accounts (owner decision 2026-09-24): the Accounts
  // page total, broken down so the savings figure this card used to show is
  // still one glance away. It replaced a "Savings & investments" card that
  // left the reader to add the spending accounts in their head.
  const worth = ask('netWorth.current', view.lens);
  if (worth?.hasActiveAccounts) {
    const pl = worth.unrealized;
    const partNames = t('dashboard.netWorthParts');
    const parts = ['spending', 'savings', 'investment', 'pension', 'assets', 'loansGiven', 'debts', 'other']
      .filter(k => Math.abs(worth.parts[k]) >= 0.005)
      .map(k => `${partNames[k]} ${fmt(worth.parts[k], { decimals: 0 })}`);
    let worthSub = parts.join(' · ');
    // Same hint as the spending-accounts card: under Booked or Forecast the
    // total includes money the bank does not show yet.
    if (Math.abs(worth.notYetCleared) >= 0.5) {
      worthSub += ` · ${t('dashboard.inclNotYetCleared')(fmt(worth.notYetCleared, { signed: true, decimals: 0 }))}`;
    }
    const savCard = kpi({
      label: t('dashboard.kpi.netWorth'),
      value: moneyEl(worth.total, { role: 'summary' }),
      sub: worthSub,
    });
    if (pl.hasData) {
      const plLine = document.createElement('div');
      plLine.className = 'sub';
      plLine.style.cssText = `margin-top:2px;color:${pl.pl >= 0 ? 'var(--success, var(--mint))' : 'var(--danger, var(--rose))'};`;
      const sign = pl.pl >= 0 ? '+' : '−';
      const amount = `${sign}${fmt(Math.abs(pl.pl))}`;
      const pctTxt = fmtPct(pl.pct, { signed: true });
      plLine.textContent = t('dashboard.kpiSavingsPl')(amount, pctTxt);
      // Insert just below the existing sub line.
      const existingSub = savCard.querySelector('.sub');
      existingSub.after(plLine);
    }
    makeClickableCard(savCard, () => navigate('accounts'));
    row.append(savCard);
  }

  // Age of Money — average age of dollars used in the last 30 days, with a
  // 12-month trend, a health chip, and a runway estimate. Hidden when there's
  // no AoM data anywhere in the last year.
  const aom = ask('ageOfMoney', { date: view.date });
  if (aom && (aom.days != null || aom.history.some(h => h.days != null))) {
    row.append(buildAgeOfMoneyCard(aom));
  }

  // Every tile's query failed: no empty grid, as the other cards leave out.
  return row.children.length ? row : null;
}

function makeClickableCard(el, onClick) {
  el.setAttribute('role','button');
  el.tabIndex = 0;
  el.classList.add('is-clickable');
  el.addEventListener('click', onClick);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); }
  });
}

// Build the AoM KPI card: number + health chip + runway sub-line + sparkline.
// Clicking opens a detail sheet with the full trend and anomaly callouts.
// `aom` is the ageOfMoney answer; its history samples month-ends, the
// current month at the view's date.
function buildAgeOfMoneyCard(aom) {
  const loc = langLocale();

  const value = document.createElement('div');
  value.style.cssText = 'display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;';
  const num = amountText(aom.days != null ? String(aom.days) : '—');
  const unit = document.createElement('span');
  unit.style.cssText = 'font-size:16px;font-weight:500;color:var(--muted);';
  unit.textContent = t('dashboard.aomUnit');
  value.append(num, unit);
  if (aom.health) {
    value.append(buildHealthChip(aom.health));
  }

  const subText = aom.runwayDays != null
    ? t('dashboard.aomRunway')(aom.runwayDays)
    : t('dashboard.aomSub');

  // Spark data: replace nulls with 0, but tag the labels so the tooltip is
  // honest. The sparkBars title comes from `${label}: ${format(v)}` — we
  // exploit `format` to render "no data" for the originally-null samples.
  const history = aom.history;
  const data = history.map(h => h.days ?? 0);
  const labels = history.map(h => dateOf(h.date).toLocaleDateString(loc, { month: 'short' }));
  const noDataAt = new Set(history.map((h, i) => h.days == null ? i : -1).filter(i => i >= 0));
  let sparkIdx = 0;
  const spark = sparkBars({
    data,
    labels,
    format: (v) => {
      const idx = sparkIdx++;
      if (noDataAt.has(idx)) return t('dashboard.aomNoData');
      return v + t('dashboard.daysSuffix');
    },
  });

  const card = kpi({
    label: t('dashboard.aomLabel'),
    value,
    sub: subText,
    extra: spark,
  });
  makeClickableCard(card, () => openAomDetailSheet(aom));
  return card;
}

function buildHealthChip(health) {
  const span = document.createElement('span');
  span.className = `chip chip--health-${health}`;
  const dot = document.createElement('span');
  dot.className = 'dot';
  span.append(dot);
  const lbl = document.createElement('span');
  lbl.textContent = t(
    health === 'green'  ? 'dashboard.aomHealthGreen' :
    health === 'yellow' ? 'dashboard.aomHealthYellow' :
                          'dashboard.aomHealthRed'
  );
  span.append(lbl);
  return span;
}

function openAomDetailSheet(aom) {
  const loc = langLocale();
  const content = document.createElement('div');

  // Header strip: current AoM + chip + runway.
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px;';
  const big = document.createElement('div');
  big.style.cssText = 'font-size:36px;font-weight:700;line-height:1;';
  big.textContent = aom.days != null
    ? `${aom.days} ${t('dashboard.aomUnit')}`
    : '—';
  header.append(big);
  if (aom.health) header.append(buildHealthChip(aom.health));
  const sub = document.createElement('div');
  sub.style.cssText = 'flex-basis:100%;color:var(--muted);font-size:13px;';
  sub.textContent = aom.runwayDays != null
    ? t('dashboard.aomRunway')(aom.runwayDays)
    : t('dashboard.aomNoRunway');
  header.append(sub);
  content.append(header);
  // Old money next to a short runway is not rated healthy (the query holds
  // the chip at yellow); say why.
  if (aom.runwayLimited) {
    const why = document.createElement('div');
    why.style.cssText = 'color:var(--muted);font-size:13px;margin:-8px 0 16px;';
    why.textContent = t('dashboard.aomRunwayLimited')(aom.runwayDays);
    content.append(why);
  }

  // The full trend, interactive.
  const trendTitle = document.createElement('div');
  trendTitle.style.cssText = 'font-weight:600;font-size:14px;margin-bottom:4px;';
  trendTitle.textContent = t('dashboard.aomTrendTitle');
  content.append(trendTitle);
  const trendSub = document.createElement('div');
  trendSub.style.cssText = 'color:var(--muted);font-size:12px;margin-bottom:8px;';
  trendSub.textContent = t('dashboard.aomTrendSub');
  content.append(trendSub);

  // A month with too little history has no AoM: `gaps` says "no data" for
  // it rather than "0 days".
  content.append(mountChart({
    id: 'dashboard-aom-trend', kind: 'bar', title: t('dashboard.aomTrendTitle'), height: 180, gaps: true,
    format: v => `${Math.round(v)}${t('dashboard.daysSuffix')}`,
    x: aom.history.map(h => ({
      key: h.month,
      label: dateOf(h.date).toLocaleDateString(loc, { month: 'short' }),
    })),
    series: [{ id: 'aom', name: t('dashboard.aomLabel'), color: 'var(--accent-ink)', values: aom.history.map(h => h.days) }],
  }));

  // Anomaly callouts.
  const anomaliesHeader = document.createElement('div');
  anomaliesHeader.style.cssText = 'font-weight:600;font-size:14px;margin:18px 0 4px;';
  anomaliesHeader.textContent = t('dashboard.aomAnomalyHeader');
  content.append(anomaliesHeader);

  const list = document.createElement('div');
  list.className = 'aom-anomaly-list';
  const items = aom.drops;
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'color:var(--muted);font-size:13px;';
    empty.textContent = t('dashboard.aomAnomalyEmpty');
    list.append(empty);
  } else {
    for (const it of items) list.append(buildAnomalyItem(it, loc));
  }
  content.append(list);

  // One-off inflows the figure leaves out, dated in the trend's months.
  if (aom.oneOffs?.length) {
    const oneOffHeader = document.createElement('div');
    oneOffHeader.style.cssText = 'font-weight:600;font-size:14px;margin:18px 0 4px;';
    oneOffHeader.textContent = t('dashboard.aomOneOffsTitle');
    const oneOffHint = document.createElement('div');
    oneOffHint.style.cssText = 'color:var(--muted);font-size:12px;margin-bottom:6px;';
    oneOffHint.textContent = t('dashboard.aomOneOffsHint');
    const oneOffList = document.createElement('ul');
    oneOffList.style.cssText = 'margin:0;padding-left:18px;font-size:13px;';
    for (const o of aom.oneOffs) {
      const li = document.createElement('li');
      li.textContent = `${o.payee ?? '—'} · ${fmt(o.amount, { decimals: 0 })} · ${fmtDateLang(o.date)}`;
      oneOffList.append(li);
    }
    content.append(oneOffHeader, oneOffHint, oneOffList);
  }

  // Explanation copy.
  const expl = document.createElement('div');
  expl.style.cssText = 'color:var(--muted);font-size:12.5px;line-height:1.55;margin-top:18px;white-space:pre-wrap;';
  expl.textContent = t('dashboard.aomDialogBody');
  content.append(expl);

  openSheet({ title: t('dashboard.aomDialogTitle'), content, wide: true });
}

function buildAnomalyItem(it, loc) {
  const row = document.createElement('div');
  row.className = `aom-anomaly-item aom-anomaly-item--${it.kind}`;
  const dot = document.createElement('span'); dot.className = 'dot';
  const text = document.createElement('span');
  const monthLabel = dateOf(it.month).toLocaleDateString(loc, { month: 'short', year: 'numeric' });
  if (it.kind === 'big_expense') {
    text.textContent = t('dashboard.aomAnomalyBigExpense')({
      monthLabel,
      drop: it.drop,
      amount: fmt(it.amount, { decimals: 0 }),
      ageDays: it.ageDays,
      payee: it.payee ?? '—',
    });
  } else if (it.kind === 'income_gap') {
    text.textContent = t('dashboard.aomAnomalyIncomeGap')({
      monthLabel,
      drop: it.drop,
      gapDays: it.gapDays,
    });
  } else {
    text.textContent = t('dashboard.aomAnomalyBroadShift')({
      monthLabel,
      drop: it.drop,
    });
  }
  row.append(dot, text);
  return row;
}

function buildCategorySpendCard(view, spending) {
  if (!spending) return null;
  const segments = categorySpendSegments(spending.byCategory);
  if (segments.length === 0) return null;
  const card = document.createElement('div');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-title';
  const left = document.createElement('div');
  const h3 = document.createElement('h3');
  const monthLabel = view.today.toLocaleDateString(langLocale(), { month: 'long' });
  h3.textContent = t('dashboard.whereMonthWent')(monthLabel);
  left.append(h3);
  head.append(left);
  card.append(head);

  card.append(mountChart({
    id: 'dashboard-category-spend', kind: 'pie', title: h3.textContent, height: 180,
    format: v => fmt(v, { decimals: 0 }),
    items: segments,
  }));
  return card;
}

function buildAnnualPlanCard(view) {
  const plan = ask('plan.annual', { date: view.date });
  if (!plan || !plan.hasIncluded) return null;

  const { income, budget, diff, status, coveragePct, fillPct } = plan;
  const isBalanced = status === 'balanced';
  const isDeficit = status === 'deficit';
  const isSurplus = status === 'surplus';

  const card = document.createElement('div');
  card.className = 'card hero-card bp-annual-card ' +
    (isDeficit ? 'is-over' : isBalanced ? 'is-balanced' : 'is-assign');

  const row = document.createElement('div');
  row.className = 'hero-row';

  const left = document.createElement('div');
  left.className = 'hero-left';

  const lbl = document.createElement('div');
  lbl.className = 'hero-label';
  lbl.textContent = isBalanced
    ? t('dashboard.annualPlanBalanced')
    : isSurplus
      ? t('dashboard.annualSurplus')
      : t('dashboard.annualDeficit');

  const val = document.createElement('div');
  val.className = 'hero-val money-metric';
  if (isBalanced) {
    val.classList.add('is-balanced');
    val.append(moneyEl(0, { role: 'summary' }));
  } else {
    val.append(moneyEl(Math.abs(diff), { role: 'summary' }));
  }

  const body = document.createElement('div');
  body.className = 'hero-body';
  body.textContent = isBalanced
    ? t('dashboard.annualBalancedBody')
    : isSurplus
      ? t('dashboard.annualSurplusBody')
      : t('dashboard.annualDeficitBody');

  left.append(lbl, val, body);

  const right = document.createElement('div');
  right.className = 'hero-meta';

  const incomeLbl = document.createElement('div');
  incomeLbl.className = 'hero-meta-lbl';
  incomeLbl.textContent = t('dashboard.annualIncome');
  const incomeVal = document.createElement('div');
  incomeVal.className = 'hero-meta-val';
  incomeVal.textContent = fmt(income);

  const budgetLbl = document.createElement('div');
  budgetLbl.className = 'hero-meta-lbl';
  budgetLbl.style.marginTop = '10px';
  budgetLbl.textContent = t('dashboard.annualBudget');
  const budgetVal = document.createElement('div');
  budgetVal.className = 'hero-meta-val';
  budgetVal.textContent = fmt(budget);

  const pctEl = document.createElement('div');
  pctEl.className = 'hero-meta-pct';
  pctEl.textContent = income > 0.005 ? t('dashboard.coverageOfIncome')(coveragePct) : '';

  right.append(incomeLbl, incomeVal, budgetLbl, budgetVal, pctEl);

  row.append(left, right);
  card.append(row);

  const bar = document.createElement('div');
  bar.className = 'hero-healthbar';
  const barFill = document.createElement('div');
  barFill.style.width = '0%';
  bar.append(barFill);
  card.append(bar);
  requestAnimationFrame(() => { barFill.style.width = fillPct + '%'; });

  const action = document.createElement('button');
  action.type = 'button';
  action.className = 'btn btn-accent hero-action';
  action.textContent = t('dashboard.openBudgetPlan');
  action.addEventListener('click', (e) => {
    e.stopPropagation();
    navigate('budget-plan');
  });
  card.append(action);

  makeClickableCard(card, () => navigate('budget-plan'));
  return card;
}

function kpi({ label, value, sub, extra, dest }) {
  const el = document.createElement('div');
  el.className = 'kpi';
  const lbl = document.createElement('div'); lbl.className = 'lbl'; lbl.textContent = label;
  const val = document.createElement('div'); val.className = 'val money-metric'; val.append(value);
  const s = document.createElement('div'); s.className = 'sub'; s.textContent = sub;
  el.append(lbl, val, s);
  if (extra) { const x = document.createElement('div'); x.className = 'spark'; x.append(extra); el.append(x); }
  if (dest) {
    const chev = document.createElement('div');
    chev.className = 'kpi-dest';
    chev.textContent = dest;
    el.append(chev);
  }
  return el;
}
function progressBar(pct) {
  const bar = document.createElement('div');
  bar.style.cssText = 'height:5px;background:var(--bg-sunken);border-radius:999px;margin-top:10px;overflow:hidden;';
  const f = document.createElement('div');
  f.style.cssText = `height:100%;background:var(--accent);width:0%;transition:width var(--dur-slow) var(--ease);`;
  bar.append(f);
  requestAnimationFrame(() => { f.style.width = pct + '%'; });
  return bar;
}


function buildCreditCardsToPayCard(view) {
  const due = ask('cards.due', view.lens);
  if (!due || !due.cards.length) return null;

  const card = document.createElement('div');
  card.className = 'card';

  const head = document.createElement('div');
  head.className = 'card-title';
  const left = document.createElement('div');
  const h3 = document.createElement('h3'); h3.textContent = t('dashboard.cardsTitle');
  const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = t('dashboard.cardsSub');
  left.append(h3, sub);
  head.append(left);
  card.append(head);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-top:4px;';

  for (const { account, name: cardName, paymentDue, postedDue } of due.cards) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer;';
    row.addEventListener('click', () => navigate('transactions', `account:${account}`));

    const name = document.createElement('div');
    name.style.cssText = 'flex:1;min-width:0;overflow-wrap:anywhere;display:flex;flex-direction:column;gap:2px;';
    const nameLine = document.createElement('div');
    nameLine.style.cssText = 'font-weight:600;';
    nameLine.textContent = cardName || t('dashboard.creditCardFallback');
    name.append(nameLine);
    if (Math.abs(postedDue - paymentDue) > 0.005) {
      const hint = document.createElement('div');
      hint.className = 'muted';
      hint.style.cssText = 'font-size:12px;';
      hint.textContent = t('dashboard.cardsClearedHint')(fmt(postedDue));
      name.append(hint);
    }

    const amt = document.createElement('div');
    amt.style.cssText = 'flex:1;min-width:0;text-align:right;color:var(--danger-text);';
    amt.classList.add('money-metric');
    amt.append(moneyEl(paymentDue, { role: 'summary' }));

    row.append(name, amt);
    list.append(row);
  }

  if (due.cards.length > 1) {
    const totalRow = document.createElement('div');
    totalRow.style.cssText = 'display:flex;align-items:center;justify-content:flex-end;padding-top:6px;border-top:1px dashed var(--border);font-size:13px;';
    totalRow.textContent = t('dashboard.cardsTotalDue')(fmt(due.total));
    list.append(totalRow);
  }

  card.append(list);
  return card;
}


function buildFavoriteAccountsCard(view) {
  const accounts = (state.accounts || []).filter(a => !a.archived && a.favorite);
  if (accounts.length === 0) return null;
  // Each card's headline is the active lens; its hint is the difference from
  // Today, the part the bank does not show yet. Its rate and yearly estimate
  // come with them; a loan given's terms and a loan's payoff are the Accounts
  // page's, so a loan given here shows the estimate its tiers give.
  const detail = ask('accounts.detail', { ...view.lens, date: view.date, repayment: false, accounts: accounts.map(a => a.id) });
  if (!detail) return null;
  const detailById = new Map(detail.accounts.map(a => [a.id, a]));
  const card = document.createElement('div');
  card.className = 'card';
  const head = document.createElement('div');
  head.className = 'card-title';
  const left = document.createElement('div');
  const h3 = document.createElement('h3'); h3.textContent = t('dashboard.accountsTitle');
  const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = t('dashboard.favoriteAccounts');
  left.append(h3, sub);
  const right = document.createElement('a');
  right.style.cssText = 'color:var(--muted);font-size:12px;letter-spacing:0.04em;text-transform:uppercase;cursor:pointer;';
  right.textContent = t('dashboard.allAccounts');
  right.addEventListener('click', () => navigate('accounts'));
  head.append(left, right);
  card.append(head);

  const grid = document.createElement('div');
  grid.className = 'env-grid account-grid';
  accounts.forEach(acc => grid.append(accountCard({
    account: acc,
    currentBalance: detailById.get(acc.id)?.currentBalance ?? acc.initialBalance ?? 0,
    budgetBalance:  detailById.get(acc.id)?.budgetBalance  ?? acc.initialBalance ?? 0,
    rate: detailById.get(acc.id)?.rate ?? null,
    estInterest: detailById.get(acc.id)?.estInterest ?? 0,
    portfolioValue: detailById.get(acc.id)?.portfolioValue ?? null,
    onClick: (a) => navigate('transactions', `account:${a.id}`),
  })));
  card.append(grid);
  return card;
}

function buildUpcomingCard(view) {
  const upcoming = ask('upcoming', { date: view.date });
  if (!upcoming) return null;
  const card = document.createElement('div');
  card.className = 'card';
  card.append(cardTitle(t('dashboard.upcoming')));
  // Overdue first, then what is coming (stored and forecast rows mixed by date).
  const items = upcoming.overdue.concat(upcoming.coming);

  if (items.length === 0) {
    const empty = document.createElement('p'); empty.className = 'muted'; empty.style.fontSize='13px';
    empty.textContent = t('dashboard.upcomingEmpty');
    card.append(empty);
    return card;
  }
  const list = document.createElement('div');
  list.className = 'dash-scroll-list';
  items.forEach(it => list.append(upcomingRow(it)));
  card.append(list);
  return card;
}

// Names are presentation metadata; monetary values still come from the query.
function upcomingContext(it) {
  const envelopeName = id => trEnv(state.envelopes.find(e => e.id === id)) || '';
  const accountName = id => state.accounts.find(a => a.id === id)?.name || '';
  const parts = [];
  if (it.type === 'fill' || it.envelope_splits?.length) {
    const ids = [...new Set((it.lines || it.envelope_splits || []).map(l => l.envelope_id).filter(Boolean))];
    parts.push(ids.length === 1 ? envelopeName(ids[0]) : ids.length ? t('reports.envelopesCount')(ids.length) : '');
  } else if (it.type === 'envelope_transfer') {
    const label = id => id ? envelopeName(id) : t('transactions.unallocatedShort');
    parts.push([label(it.from_envelope_id), label(it.to_envelope_id)].filter(Boolean).join(' → '));
  } else {
    parts.push(envelopeName(it.envelope_id));
  }
  parts.push(it.from_account || it.to_account
    ? [accountName(it.from_account), accountName(it.to_account)].filter(Boolean).join(' → ')
    : accountName(it.account));
  return parts.filter(Boolean).join(' · ');
}

function upcomingRow(it) {
  const row = document.createElement('div');
  row.className = 'tx-row upcoming-row';
  if (it.is_forecast) row.classList.add('is-forecast');
  if (it.overdue) row.classList.add('is-overdue');
  const when = dateOf(it.date.slice(0, 10)).getTime();
  const isForecast = !!it.is_forecast;
  // Both stored transactions and forecasts open in the edit sheet.
  const clickable = isForecast || !!(it.id && it.date);
  row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--border);'
    + (clickable ? 'cursor:pointer;' : '');
  const image = avatar(it.payee || it.description || '?');
  if (it.type === 'fill') {
    image.className = 'avatar upcoming-fill-icon';
    image.replaceChildren(icon('envelope', 18));
    image.setAttribute('aria-hidden', 'true');
  }
  row.append(image);
  const col = document.createElement('div'); col.className = 'upcoming-copy';
  const p = document.createElement('div'); p.style.fontWeight='500'; p.style.fontSize='13.5px';
  p.textContent = it.payee || it.description || '—';
  p.className = 'upcoming-title';
  p.title = p.textContent;
  const d = document.createElement('div'); d.className = 'muted'; d.style.fontSize='11.5px';
  if (it.overdue) {
    const badge = document.createElement('span');
    badge.className = 'chip overdue';
    badge.style.marginRight = '6px';
    badge.textContent = t('transactions.chipOverdue');
    d.append(badge);
    const whenEl = document.createElement('span');
    whenEl.textContent = relativeDate(when);
    d.append(whenEl);
  } else if (isForecast || it.status === 'scheduled') {
    const badge = document.createElement('span');
    badge.className = 'chip scheduled';
    if (it.type === 'income') badge.classList.add('income');
    badge.style.marginRight = '6px';
    badge.textContent = t('transactions.statusScheduled');
    d.append(badge);
    const whenEl = document.createElement('span');
    whenEl.textContent = relativeDate(when);
    d.append(whenEl);
  } else {
    d.textContent = relativeDate(when);
  }
  d.classList.add('upcoming-status');
  const context = document.createElement('div');
  context.className = 'upcoming-context muted';
  context.textContent = [it.type === 'fill' ? t('dashboard.envelopeFill') : '', upcomingContext(it)].filter(Boolean).join(' · ');
  context.title = context.textContent;
  col.append(p);
  if (context.textContent) col.append(context);
  col.append(d);
  row.append(col);
  const amt = document.createElement('div');
  amt.className = 'num-inline';
  if (it.type === 'fill') {
    // A fill carries `lines`, not `amount` — reading `it.amount` here rendered
    // every fill as -0.00. It is also not cash flow: no account moves, money
    // goes from unallocated into envelopes. So it gets its own muted treatment
    // rather than income's green or an expense's minus sign.
    amt.style.color = 'var(--muted)';
    const setLines = fillSetLineCount(it);
    amt.textContent = setLines > 0
      ? `${fmt(fillDisplayTotal(it))} ${t('transactions.fillSetsNote')(setLines)}`
      : fmt(fillDisplayTotal(it));
  } else if (it.type === 'account_transfer') {
    // Moves money between two of the user's own accounts — neither an
    // inflow nor an outflow — so it shows unsigned, with no outflow colour.
    // investment_transfer keeps the outflow treatment below: it does leave
    // the cash account.
    amt.style.color = 'var(--ink)';
    amt.textContent = fmt(txAbsAmount(it));
  } else {
    amt.style.color = (it.type === 'income') ? 'var(--success)' : 'var(--ink)';
    amt.textContent = fmt((it.type === 'income' ? 1 : -1) * Math.abs(it.amount || 0), { signed: true });
  }
  row.append(amt);

  if (clickable) {
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    const open = () => {
      if (isForecast) {
        import('./edit-tx.js').then(m => m.openEditTx(it)).catch(err => console.error(err));
      } else {
        openTxFromDashboard(it.id);
      }
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  }
  return row;
}

function openTxFromDashboard(txId) {
  const tx = state.transactions.find(t => t.id === txId);
  if (!tx) return;
  import('./edit-tx.js').then(m => m.openEditTx(tx)).catch(err => console.error(err));
}

function relativeDate(ts) {
  const target = new Date(ts);
  const targetMid = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const now = appNow();
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = Math.round((targetMid - todayMid) / 86400000);
  if (days === 0) return t('dashboard.today');
  if (days === 1) return t('dashboard.tomorrow');
  if (days < 0) return `${Math.abs(days)} ${t('dashboard.daysShort')} ago`;
  return `${days} ${t('dashboard.daysShort')}`;
}

function cardTitle(text) {
  const h = document.createElement('div'); h.className = 'card-title';
  const h3 = document.createElement('h3'); h3.textContent = text;
  h.append(h3);
  return h;
}


function buildTrendCard(view) {
  const history = ask('spending.history', { date: view.date });
  if (!history) return null;
  const loc = langLocale();
  const card = document.createElement('div');
  card.className = 'card';
  card.append(cardTitle(t('dashboard.trend')));
  // The same rule as the Spent KPI and the donut, so the current month's
  // point equals the number printed beside it.
  card.append(mountChart({
    id: 'dashboard-trend', kind: 'line', title: t('dashboard.trend'), height: 170,
    area: true, pointLabels: true,
    format: v => fmt(v, { decimals: 0 }),
    x: history.months.map(m => ({ key: m.month, label: dateOf(m.month).toLocaleDateString(loc, { month: 'short' }) })),
    series: [{ id: 'spent', name: t('dashboard.trend'), color: 'var(--accent-ink)', values: history.months.map(m => m.spent) }],
    onSelect: ({ key }) => navigate('transactions', `month:${key}`),
  }));
  return card;
}

function buildRecentCard() {
  const card = document.createElement('div');
  card.className = 'card';
  card.append(cardTitle(t('dashboard.recent')));
  const now = appNow();
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayStr = ymd(now);
  const cutoffStr = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30));
  const recent = state.transactions
    .filter(tx => {
      const d = tx.date && tx.date.slice(0, 10);
      return d && d <= todayStr && d >= cutoffStr && movesAccountMoney(tx);
    })
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (recent.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.style.fontSize = '13px';
    empty.textContent = t('dashboard.noRecentTx');
    card.append(empty);
    return card;
  }
  const list = document.createElement('div');
  list.className = 'dash-scroll-list';
  recent.forEach(tx => list.append(compactTxRow(tx)));
  card.append(list);
  return card;
}

// Recent activity means money that entered or left an account. Fills,
// envelope moves and envelope-side adjustments (rollover sweeps) only move
// money between envelopes, so they showed as rows of €0,00 that buried the
// real spending. They stay on the Transactions page.
// A value update on an asset account (a home revalued) moves no money, so
// only accounts that are not assets count here.
function movesAccountMoney(tx) {
  const ids = [tx.account, tx.from_account, tx.to_account, tx.source_account, tx.target_id];
  return ids.some(id => id && txAccountDelta(tx, id) !== 0
    && !isAssetAccount((state.accounts || []).find(a => a.id === id)));
}

// What to call a row with no payee: its type, rather than "—" under a "?".
const TYPE_LABEL_KEYS = {
  expense: 'editTx.typeExpense',
  income: 'transactions.incomeChip',
  account_transfer: 'transactions.chipTransfer',
  debt_payment: 'transactions.chipDebt',
  investment_transfer: 'transactions.chipInvestment',
  adjustment: 'transactions.chipAdjustment',
};
// A payee of only dashes or '?' is a placeholder some imports wrote, not a
// name, so it gets the type label too.
function txDisplayName(tx) {
  const payee = String(tx.payee ?? '').trim();
  if (payee && !/^[-–—?\s]+$/.test(payee)) return payee;
  const key = TYPE_LABEL_KEYS[tx.type];
  return key ? t(key) : '—';
}

function compactTxRow(tx) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--border);cursor:pointer;';
  row.setAttribute('role', 'button');
  row.tabIndex = 0;
  const name = txDisplayName(tx);
  row.append(avatar(name));
  const col = document.createElement('div'); col.style.flex = '1';
  const p = document.createElement('div'); p.style.fontWeight='500'; p.style.fontSize='13.5px'; p.textContent = name;
  const m = document.createElement('div'); m.className = 'muted'; m.style.fontSize='11.5px';
  m.textContent = fmtDateShortLang(tx.date);
  col.append(p, m);
  row.append(col);
  const amt = document.createElement('div');
  amt.className = 'num-inline';
  // An account adjustment carries its own sign (a reconcile correction can
  // add money); everything else reads as in for income, out otherwise.
  const signed = tx.type === 'adjustment'
    ? txAccountDelta(tx, tx.target_id)
    : (tx.type === 'income' ? 1 : -1) * txAbsAmount(tx);
  amt.style.color = signed > 0 ? 'var(--success)' : 'var(--ink)';
  amt.textContent = fmt(signed, { signed: true });
  row.append(amt);
  const open = () => openTxFromDashboard(tx.id);
  row.addEventListener('click', open);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  return row;
}

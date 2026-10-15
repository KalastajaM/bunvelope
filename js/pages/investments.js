import { contentTabs } from '../ui/content-tabs.js';
import { currentBudgetSession } from '../state/budget-session.js';
import { addPageHelp } from '../ui/info-button.js';
import { node, disclosure } from '../ui/planning-workspace.js';
// js/pages/investments.js — Portfolio view across investment-type accounts.
//
// Holdings come from two sources, in this order of precedence:
//   1. `state.meta.investments.holdingOverrides[accountId][SYMBOL]` — the
//      user's reconciled units / cost basis. Wins outright when present.
//   2. Aggregated `investment_transfer` rows (avg-cost basis).
//
// Current value is computed against `state.meta.investments.prices[SYMBOL]`,
// which the user can refresh from Yahoo Finance quotes or edit by hand.
// The holdings, the totals, the allocation and invested-over-time cards and
// each account's gap are the `investments.holdings` query's
// (js/core/queries/investments-holdings.js); a holding row's own value, P/L
// and average cost are row display and stay here.
// All amounts are assumed to share the budget's currency (FX is a future
// concern noted in AGENTS.md follow-up).

import { state, session, navigate, activeLensInput, now as appNow } from '../app.js';
import { buildUnmappedCard } from './investments-unmapped.js';
import { openHoldingDialog } from './investments-holding-dialog.js';
import { openInvestmentValueDialog } from '../reconcile.js';
import { fmtMoney, numCell, trackedInvestmentAccounts } from './investments-shared.js';
import { buildPerformanceCard } from './investments-performance.js';
import { buildTaxCard } from './investments-tax.js';
import { moneyEl } from '../ui/money.js';
import { ask } from '../ui/query.js';
import { mountChart } from '../ui/charts/index.js';
import { emptyState } from '../ui/empty-state.js';
import { infoButton } from '../ui/info-button.js';
import { isoDate } from '../core/context.js';
import { toast } from '../ui/toast.js';
import { t, fmtDateLang, fmtMonthLang } from '../ui/i18n.js';
import { icon } from '../ui/icon.js';
import { fmtNum, fmtPct } from '../utils.js';
import {
  getInvestmentsMeta,
  fetchPrices,
  getManualRows,
  collectPriceUrls,
} from '../state/investments.js';
import { validate } from '../core/schema.js';
import { describeError } from '../core/errors.js';
import { txSymbol, txAbsAmount } from '../engine.js';
import { isAiFeatureEnabled, aiInsights } from '../ai/client.js';
import { renderAiCard, withAiState } from '../ai/render.js';
import { formatAiText } from '../ai/money-text.js';
import { enableFormulaInput, parseAmountInput } from '../ui/amount-input.js';
import { dispatchOrReport, dispatchBatchOrReport } from '../ui/save-error.js';

const expandedHoldings = new Set();
// Holdings with no current value AND no units (e.g. fully sold or empty
// watchlist entries) are hidden by default; the query leaves them out.
let showZeroBalance = false;

const PALETTE = [
  'var(--accent)', 'var(--sky)', 'var(--rose)', 'var(--butter, var(--mint))',
  'var(--violet, var(--accent))', 'var(--mint)', 'var(--lavender, var(--sky))',
  'var(--peach, var(--rose))',
];

const PRICE_STALE_DAYS = 5;

function isStalePrice(asOf) {
  if (!asOf) return true;
  const d = new Date(asOf);
  if (Number.isNaN(d.getTime())) return true;
  const ageDays = (appNow().getTime() - d.getTime()) / 86_400_000;
  return ageDays > PRICE_STALE_DAYS;
}

function unitsLabel(u) {
  if (!Number.isFinite(u)) return '0';
  // 8dp keeps crypto sub-satoshi precision visible (BTC quotes go to 8dp)
  // while `Number(...)` strips trailing zeros so whole numbers and
  // small-fraction stock holdings still display cleanly.
  return fmtNum(u, { maxDecimals: 8 });
}

let selectedView = 'holdings';
export async function render(container) {
  const restoreTabFocus = container.contains(document.activeElement) && document.activeElement?.getAttribute('role') === 'tab';
  const page = document.createElement('div');
  page.className = 'page working-money';

  const accounts = trackedInvestmentAccounts(state.accounts);
  const inv = getInvestmentsMeta(state.meta);
  // The holdings are the stored rows (no lens); each account's balance, and
  // so its gap, follows the active lens. Null when the query failed (warned):
  // the figures are then left off.
  const holdings = ask('investments.holdings', { ...activeLensInput(), includeZero: showZeroBalance });

  // ── Summary numbers ───────────────────────────────────────────────────
  // Value and unrealised P/L are over priced rows only — the i18n copy
  // promises "market value excludes them", and a silent costBasis fallback
  // would inflate Value to whatever we paid. `cost` still spans every
  // holding so the user can see all invested capital; the "missing prices"
  // subline calls out the gap.
  const totals = holdings?.totals;

  // ── Page head ─────────────────────────────────────────────────────────
  const head = document.createElement('div');
  head.className = 'page-head';
  const left = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.textContent = t('investments.title');
  addPageHelp(h1, 'tour.steps.investments.body');
  const sub = document.createElement('div');
  sub.className = 'page-head-sub';
  if (totals) sub.textContent = t('investments.subtitle')(totals.activeCount, fmtMoney(totals.cost), fmtMoney(totals.valuePriced));
  left.append(h1, sub);
  head.append(left);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'btn btn-ghost';
  refreshBtn.append(icon('chart', 14));
  const refreshLbl = document.createElement('span');
  refreshLbl.textContent = t('investments.refreshPrices');
  refreshBtn.append(refreshLbl);
  refreshBtn.addEventListener('click', () => onRefreshPrices(refreshBtn));
  actions.append(refreshBtn);

  const zeroCount = totals ? totals.zeroCount : 0;
  if (zeroCount > 0) {
    const zeroBtn = document.createElement('button');
    zeroBtn.type = 'button';
    zeroBtn.className = 'btn btn-ghost';
    zeroBtn.textContent = showZeroBalance
      ? t('investments.hideZero')
      : t('investments.showZero')(zeroCount);
    zeroBtn.addEventListener('click', () => {
      showZeroBalance = !showZeroBalance;
      navigate('investments');
    });
    actions.append(zeroBtn);
  } else if (showZeroBalance && totals) {
    // Reset the toggle when nothing zero-balance is left to show.
    showZeroBalance = false;
  }

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn btn-accent';
  addBtn.textContent = t('investments.addHolding');
  addBtn.addEventListener('click', () => openHoldingDialog({ accounts }));
  actions.append(addBtn);

  head.append(actions);
  page.append(head);

  if (!(state.accounts || []).some(a => a.type === 'investment' && a.trackInvestments !== false)) {
    page.append(emptyState({
      icon: 'chart',
      title: t('investments.empty'),
      action: { label: t('investments.emptyAction'), onClick: () => navigate('accounts') },
    }));
    container.append(page);
    return;
  }

  // ── Unmapped transactions card (only when there's something to map) ───
  const investmentAccountIds = new Set(accounts.map(a => a.id));
  const unmappedCard = buildUnmappedCard(state.transactions || [], investmentAccountIds);
  if (unmappedCard) page.append(unmappedCard);

  const overviewPanel = node('section', 'workspace-panel');
  const holdingsPanel = node('section', 'workspace-panel');
  const activityPanel = node('section', 'workspace-panel');
  const taxPanel = node('section', 'workspace-panel');
  const performancePanel = node('section', 'workspace-panel');
  performancePanel.append(buildPerformanceCard());
  if (holdings) {
    const quality = [];
    for (const holding of holdings.holdings.filter(h => h.units > 0)) {
      const price = inv.prices[holding.symbol];
      if (!price || isStalePrice(price.asOf)) quality.push(node('p', '', holding.symbol + ' · ' + t('workspace.checkPrice') + (price?.asOf ? ' · ' + fmtDateLang(price.asOf) : '')));
      if (holding.costBasis === 0 && !holding.valuationOnly) quality.push(node('p', '', holding.symbol + ' · ' + (accounts.find(a => a.id === holding.accountId)?.name || '') + ' · ' + t('workspace.zeroBasis')));
    }
    page.append(disclosure(t('workspace.valuation') + (quality.length ? ' · ' + quality.length : ''), quality.length ? quality : [node('p', '', t('workspace.pricesCurrent'))], false));
    // ── Summary card ────────────────────────────────────────────────────
    page.append(buildSummaryCard(totals));

    // ── Allocation + invested row ───────────────────────────────────────
    const visualsRow = document.createElement('div');
    visualsRow.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:16px;margin-bottom:16px;';
    visualsRow.append(buildAllocationCard(holdings.allocation));
    activityPanel.append(node('p', 'muted', t('workspace.contributionsHint')), buildInvestedSparklineCard(holdings.invested));
    overviewPanel.append(visualsRow);

    // ── Holdings tables (one per account) ───────────────────────────────
    // Each card surfaces the gap between the account's balance (cash
    // deployed + reconciliation adjustments) and what's been identified as
    // priced/cost-based holdings.
    const figuresById = new Map(holdings.accounts.map(a => [a.id, a]));
    for (const acc of accounts) {
      const rows = holdings.holdings.filter(h => h.accountId === acc.id);
      holdingsPanel.append(buildAccountCard(acc, rows, inv.prices, figuresById.get(acc.id)));
    }
  }

  // ── Realised gains for the tax return (FIFO + deemed cost) ────────────
  const taxCard = buildTaxCard({ onChange: () => navigate('investments') });
  if (taxCard) taxPanel.append(taxCard);
  const tabs = contentTabs([
    ['holdings',t('workspace.holdings'),holdingsPanel], ['overview',t('workspace.overview'),overviewPanel],
    ['activity',t('workspace.activity'),activityPanel], ['performance',t('performance.title'),performancePanel], ['tax',t('workspace.tax'),taxPanel],
  ], selectedView, { label: t('investments.title'), onSelect: key => { selectedView = key; } });
  page.append(tabs, holdingsPanel, overviewPanel, activityPanel, performancePanel, taxPanel);

  // ── AI portfolio insight card ─────────────────────────────────────────
  // Cost-basis-only commentary (no price data), strictly observational —
  // see server/ai/prompts.js portfolio_insight for the refusal rules.
  // We only mount once the user has at least one holding so the model has
  // something to talk about.
  if (totals && totals.activeCount + totals.zeroCount > 0 && isAiFeatureEnabled('portfolioInsight')) {
    const insight = buildPortfolioInsightCard();
    insight.card.style.marginBottom = '16px';
    overviewPanel.append(insight.card);
  }

  container.append(page);
  tabs.restoreSelectedTab({ focus: restoreTabFocus });

  async function onRefreshPrices(btn) {
    // Every holding's symbol, the zero ones too, whatever the toggle shows.
    // A failed query is the refresh failing, not a budget without symbols.
    let failure = null;
    const answer = ask('investments.holdings', { includeZero: true }, (error) => { failure = error; return false; });
    if (!answer) {
      toast(failure ? `${t('investments.refreshFailed')}: ${describeError(failure, t)}` : t('investments.refreshFailed'));
      return;
    }
    const symbols = Array.from(new Set(answer.holdings.map(h => h.symbol).filter(Boolean)));
    if (!symbols.length) {
      toast(t('investments.noSymbols'));
      return;
    }
    btn.disabled = true;
    const prevText = refreshLbl.textContent;
    refreshLbl.textContent = t('investments.refreshing');
    try {
      const urlMap = collectPriceUrls(state.meta);
      const result = await fetchPrices(symbols, urlMap, { debug: true, base: state.meta?.currency || null });
      const got = Object.keys(result.prices).length;
      const errors = result.errors || [];
      for (const e of errors) {
        if (e?.debug) console.warn(`[price-fetch] ${e.symbol}: ${e.message}`, e.debug);
      }
      const errSuffix = refreshErrorSuffix(errors);
      if (got === 0) {
        toast(refreshNoneMessage(errors));
      } else {
        // The fetch worked; a failure here is the save, not the refresh. Every
        // price lands in one commit, or none does.
        const saved = await dispatchBatchOrReport(session, Object.entries(result.prices).map(([sym, p]) => ({
          name: 'investment.setPrice',
          input: { symbol: sym, price: p.price, ...scrapedAsOf(p.asOf), ...(p.fx ? { fx: p.fx } : {}) },
        })));
        if (!saved) return;
        toast(t('investments.refreshOk')(got) + errSuffix);
        navigate('investments');
      }
    } catch (err) {
      console.error(err);
      toast(t('investments.refreshFailed'));
    } finally {
      btn.disabled = false;
      refreshLbl.textContent = prevText;
    }
  }
}

/**
 * The tail of a refresh toast naming what failed. Symbols the price service
 * has no quote for are listed (cap at 3 names so it stays readable, then a
 * "+N more" tail; the console keeps the full debug breakdown); symbols whose
 * request never reached the service are only counted, as their names say
 * nothing about why. Empty when nothing failed.
 *
 * @param {Array<{ symbol?: string, unreachable?: boolean }>} errors
 */
export function refreshErrorSuffix(errors) {
  const noQuote = errors.filter(e => !e?.unreachable).map(e => e?.symbol).filter(Boolean);
  const unreachable = errors.filter(e => e?.unreachable).length;
  let out = '';
  if (noQuote.length) out += ` · ${t('investments.refreshFailedSome')(noQuote.length, noQuote.slice(0, 3).join(', '), Math.max(0, noQuote.length - 3))}`;
  if (unreachable) out += ` · ${t('investments.refreshUnreachableSome')(unreachable)}`;
  return out;
}

/**
 * The toast when no price came back. When no request reached the price
 * service it says so, instead of blaming the symbols for a network failure.
 *
 * @param {Array<{ symbol?: string, unreachable?: boolean }>} errors
 */
export function refreshNoneMessage(errors) {
  if (errors.length && errors.every(e => e?.unreachable)) return t('investments.refreshUnreachable');
  return t('investments.refreshNone') + refreshErrorSuffix(errors);
}

/**
 * A scraped quote's date as investment.setPrice takes it: `{ asOf }` when it
 * is a real calendar day, otherwise nothing, so the command dates the price
 * today. One unreadable date must not fail the whole refresh batch.
 */
function scrapedAsOf(asOf) {
  const r = validate(asOf, { type: 'date' });
  return r.ok ? { asOf: r.value } : {};
}

// ── Summary card ────────────────────────────────────────────────────────
function buildSummaryCard({ cost: totalCost, valuePriced: totalValue, unrealized, unrealizedPct, missingPrice: priceMissing }) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'margin-bottom:16px;';

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit, minmax(min(100%, 250px), 1fr));gap:16px;';

  grid.append(stat(t('investments.statValue'), moneyEl(totalValue, { role: 'summary' })));
  grid.append(stat(t('investments.statCost'),  moneyEl(totalCost,  { role: 'summary' }), 'costBasis'));

  const plEl = moneyEl(unrealized, { role: 'summary', signed: true });
  plEl.style.color = unrealized >= 0 ? 'var(--success, var(--mint))' : 'var(--danger, var(--rose))';
  const plWrap = document.createElement('div');
  plWrap.append(plEl);
  if (totalCost > 0) {
    const pct = document.createElement('span');
    pct.style.cssText = 'margin-left:6px;font-size:14px;color:var(--muted);';
    pct.textContent = `(${fmtPct(unrealizedPct, { decimals: 2, signed: true })})`;
    plWrap.append(pct);
  }
  grid.append(stat(t('investments.statUnrealized'), plWrap, 'realizedPl'));

  card.append(grid);

  if (priceMissing > 0) {
    const note = document.createElement('div');
    note.className = 'muted';
    note.style.cssText = 'margin-top:12px;font-size:13px;';
    note.textContent = t('investments.missingPrices')(priceMissing);
    card.append(note);
  }
  return card;
}

function stat(label, valueEl, helpKey) {
  const w = document.createElement('div');
  w.className = 'money-metric';
  const lbl = document.createElement('div');
  lbl.className = 'muted';
  lbl.style.cssText = 'font-size:12px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;';
  lbl.textContent = label;
  if (helpKey) lbl.append(infoButton(helpKey));
  w.append(lbl, valueEl);
  return w;
}

// ── Allocation ───────────────────────────────────────────────────────────
function buildAllocationCard(allocation) {
  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = t('investments.allocation');
  card.append(title);

  // Market value per symbol, largest first, labelled "Name (SYM)" when a
  // holding names it (the query's allocation).
  if (allocation.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.cssText = 'padding:16px 0;';
    empty.textContent = t('investments.allocationEmpty');
    card.append(empty);
    return card;
  }

  // Keyed by symbol, so a hidden holding stays hidden across visits; the
  // label keeps the symbol when the name alone would be ambiguous.
  const items = allocation.map((entry, i) => ({
    key: entry.symbol,
    label: entry.label,
    value: entry.value,
    color: PALETTE[i % PALETTE.length],
  }));
  card.append(mountChart({
    id: 'investments-allocation', kind: 'pie', title: t('investments.allocation'), height: 180,
    format: v => fmtMoney(v),
    items,
  }));
  return card;
}

// ── Invested over time ──────────────────────────────────────────────────
function buildInvestedSparklineCard(invested) {
  const card = document.createElement('div');
  card.className = 'card';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.textContent = t('investments.investedOverTime');
  card.append(title);

  // Net cash invested (buys − sells; dividends are income, not invested
  // capital) at each month from the first investment to this month, carried
  // forward: the query's invested series. Zoom narrows it to a recent stretch.
  // The empty text is for a budget with no dated buy or sell at all; one
  // whose investments all start after this month gets the chart's own empty
  // state, as before the query (its series is empty too).
  const anyInvestment = (state.transactions || []).some(tx =>
    tx?.type === 'investment_transfer' && tx.direction !== 'dividend' && (tx.date || '').slice(0, 7));
  if (!anyInvestment) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.cssText = 'padding:16px 0;';
    empty.textContent = t('investments.allocationEmpty');
    card.append(empty);
    return card;
  }

  const x = invested.map(p => ({ key: p.month, label: fmtMonthLang(p.month) }));
  const values = invested.map(p => p.value);

  card.append(mountChart({
    id: 'investments-invested', kind: 'line', title: t('investments.investedOverTime'), height: 180, area: true,
    format: v => fmtMoney(v),
    x,
    series: [{ id: 'invested', name: t('investments.investedOverTime'), color: 'var(--accent-ink)', values }],
  }));
  return card;
}

// ── Per-account holdings table ──────────────────────────────────────────
function buildAccountCard(account, rows, prices, figures) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'margin-bottom:16px;';

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;margin-bottom:12px;gap:12px;';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.style.margin = '0';
  title.textContent = account.name;
  head.append(title);

  // The value of the listed holdings, at cost where a market price is
  // unknown, so the account total reflects what the user has actually
  // invested; the gap is the account's balance on the lens less that.
  const acctValue = figures?.value ?? 0;
  const acctVal = moneyEl(acctValue, { role: 'table' });
  head.append(acctVal);
  card.append(head);

  // Gap between the account's engine balance and the sum of identified
  // holdings. Positive = cash sitting at the broker that hasn't been
  // deployed; negative = gains the balance does not carry yet: price gains
  // on what is held, or, with nothing held, gains realised by sales (the
  // ledger moves the balance by the cash, so a sale above cost leaves it
  // below zero). Only show when meaningful.
  const gap = figures?.gap ?? 0;
  if (Math.abs(gap) >= 0.005) {
    const noHoldings = Math.abs(acctValue) < 0.005;
    const gapRow = document.createElement('div');
    gapRow.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:-4px 0 12px;font-size:12px;color:var(--muted);';
    const gapLbl = document.createElement('span');
    gapLbl.textContent = gap > 0
      ? t('investments.uninvestedCash')
      : noHoldings ? t('investments.gainsNotInBalance') : t('investments.holdingsExceedBalance');
    const gapVal = document.createElement('span');
    gapVal.textContent = fmtMoney(Math.abs(gap));
    gapRow.append(gapLbl, gapVal);
    card.append(gapRow);
    // Holdings worth more than the recorded balance is normally price gains
    // since the balance was last brought up to date, not an error, so it is
    // explained rather than shown in red (ux-review U26).
    if (gap < 0) {
      const hintKey = noHoldings ? 'investments.gainsNotInBalanceHint' : 'investments.holdingsExceedHint';
      gapRow.title = t(hintKey);
      const hint = document.createElement('div');
      hint.style.cssText = 'margin:-8px 0 12px;font-size:12px;color:var(--muted);'
        + 'display:flex;flex-direction:column;align-items:flex-start;gap:6px;';
      const hintText = document.createElement('span');
      hintText.textContent = t(hintKey);
      hint.append(hintText);
      const fix = document.createElement('button');
      fix.type = 'button';
      fix.className = 'btn btn-ghost btn-sm';
      fix.textContent = t('investments.updateValue');
      fix.addEventListener('click', () =>
        openInvestmentValueDialog(account.id, () => navigate('investments'), { suggestedValue: acctValue }));
      hint.append(fix);
      card.append(hint);
    }
  }

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.cssText = 'padding:8px 0;font-size:13px;';
    empty.textContent = t('investments.accountEmpty');
    card.append(empty);
    return card;
  }

  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:14px;table-layout:auto;';
  // Symbol stretches; numeric columns share equal width so the gaps
  // between them are uniform. Actions is sized to the Edit button.
  const colWidths = {
    symbol: 'auto',
    units: '10%',
    avgCost: '9%',
    cost: '11%',
    price: '11%',
    value: '11%',
    pl: '14%',
    actions: '64px',
  };
  const colgroup = document.createElement('colgroup');
  for (const key of ['symbol', 'units', 'avgCost', 'cost', 'price', 'value', 'pl', 'actions']) {
    const col = document.createElement('col');
    col.style.width = colWidths[key];
    colgroup.append(col);
  }
  table.append(colgroup);

  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const key of ['symbol', 'units', 'avgCost', 'cost', 'price', 'value', 'pl', 'actions']) {
    const th = document.createElement('th');
    th.textContent = key === 'actions' ? '' : t(`investments.col.${key}`);
    th.style.cssText = 'text-align:left;padding:8px 6px;border-bottom:1px solid var(--border, #e5e7eb);font-weight:600;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;';
    if (['units', 'avgCost', 'cost', 'price', 'value', 'pl'].includes(key)) th.style.textAlign = 'right';
    trh.append(th);
  }
  thead.append(trh);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const h of rows) {
    const priceInfo = prices[h.symbol];
    // A unit-less holding with a price is held at cost, not valued at
    // 0 × price (which read as a −100% loss): its markPrice is null.
    const price = h.markPrice;
    const hasPrice = price !== null;
    const value = hasPrice ? h.units * price : null;
    const pl = hasPrice && !h.valuationOnly ? value - h.costBasis : null;
    const avgCost = h.units > 0 ? h.costBasis / h.units : 0;

    const tr = document.createElement('tr');
    tr.style.cssText = 'border-bottom:1px solid var(--border, #f0f0f0);';

    const tdSym = document.createElement('td');
    tdSym.style.cssText = 'padding:10px 6px;font-weight:600;';
    const expandKey = `${h.accountId}|${h.symbol}`;
    const chevron = document.createElement('button');
    chevron.type = 'button';
    chevron.className = 'btn btn-ghost btn-sm';
    chevron.style.cssText = 'padding:0 6px;margin-right:4px;font-size:12px;color:var(--muted);min-width:18px;';
    chevron.setAttribute('aria-expanded', expandedHoldings.has(expandKey) ? 'true' : 'false');
    chevron.textContent = expandedHoldings.has(expandKey) ? '▾' : '▸';
    chevron.title = t('investments.holdingExpand');
    tdSym.append(chevron);
    const symLabel = document.createElement('span');
    symLabel.textContent = h.symbol;
    tdSym.append(symLabel);
    if (h.overridden) {
      const badge = document.createElement('span');
      badge.style.cssText = 'margin-left:6px;font-size:10px;padding:1px 6px;border-radius:8px;background:var(--bg-sunken);color:var(--muted);font-weight:500;';
      badge.textContent = t('investments.overriddenBadge');
      tdSym.append(badge);
    }
    // More units sold than this ledger ever recorded buying — usually a
    // position transferred in whose original buy was never entered. The
    // realized figure then covers only part of what was sold, so say so
    // rather than letting a partial number pass as the whole answer.
    if (h.oversoldUnits > 0) {
      const badge = document.createElement('span');
      badge.style.cssText = 'margin-left:6px;font-size:10px;padding:1px 6px;border-radius:8px;'
        + 'background:color-mix(in srgb, var(--danger) 14%, transparent);color:var(--danger);font-weight:500;';
      badge.textContent = t('investments.oversoldBadge');
      badge.title = t('investments.oversoldHint')(unitsLabel(h.oversoldUnits));
      tdSym.append(badge);
    }
    if (h.name) {
      const sub = document.createElement('div');
      sub.className = 'muted';
      sub.style.cssText = 'font-size:11px;font-weight:400;';
      sub.textContent = h.name;
      tdSym.append(sub);
    }
    tr.append(tdSym);

    tr.append(numCell(unitsLabel(h.units)));
    tr.append(numCell(h.valuationOnly ? t('investments.dialog.costNotTracked') : fmtMoney(avgCost)));
    tr.append(numCell(h.valuationOnly ? t('investments.dialog.costNotTracked') : fmtMoney(h.costBasis)));

    tr.append(buildPriceCell(h, priceInfo));

    if (hasPrice) {
      tr.append(numCell(fmtMoney(value)));
    } else {
      // No live price → fall back to cost basis so the cell isn't empty.
      const tdValue = numCell(h.valuationOnly ? '—' : fmtMoney(h.costBasis));
      tdValue.style.color = 'var(--muted)';
      tr.append(tdValue);
    }

    const tdPl = document.createElement('td');
    tdPl.style.cssText = 'padding:10px 6px;text-align:right;';
    if (pl !== null) {
      const sign = pl >= 0 ? '+' : '−';
      const amount = document.createElement('div');
      amount.className = 'money-amount money-table';
      amount.textContent = `${sign}${fmtMoney(Math.abs(pl))}`;
      tdPl.append(amount);
      if (h.costBasis > 0) {
        const pct = document.createElement('div');
        pct.style.cssText = 'font-size:11px;opacity:0.85;';
        pct.textContent = fmtPct((pl / h.costBasis) * 100, { signed: true });
        tdPl.append(pct);
      }
      tdPl.style.color = pl >= 0 ? 'var(--success, var(--mint))' : 'var(--danger, var(--rose))';
    } else {
      tdPl.textContent = '—';
      tdPl.style.color = 'var(--muted)';
    }
    tr.append(tdPl);

    const tdAct = document.createElement('td');
    tdAct.style.cssText = 'padding:10px 6px;text-align:right;';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-ghost btn-sm btn-icon';
    editBtn.title = t('investments.edit');
    editBtn.setAttribute('aria-label', t('investments.edit'));
    editBtn.append(icon('pencil', 20));
    editBtn.addEventListener('click', () => openHoldingDialog({
      accounts: [account],
      initial: { accountId: account.id, symbol: h.symbol, units: h.units, costBasis: h.costBasis, name: h.name, overridden: h.overridden, valuationOnly: h.valuationOnly },
      priceInfo,
    }));
    tdAct.append(editBtn);
    tr.append(tdAct);

    tbody.append(tr);

    const detailRow = document.createElement('tr');
    detailRow.style.display = expandedHoldings.has(expandKey) ? '' : 'none';
    const detailCell = document.createElement('td');
    detailCell.colSpan = 8;
    detailCell.style.cssText = 'padding:0 6px 12px 28px;background:var(--bg-sunken, transparent);';
    detailRow.append(detailCell);
    tbody.append(detailRow);

    const renderDetail = () => {
      detailCell.replaceChildren(buildHoldingDetail(account, h.symbol));
    };
    if (expandedHoldings.has(expandKey)) renderDetail();

    chevron.addEventListener('click', () => {
      const isOpen = expandedHoldings.has(expandKey);
      if (isOpen) {
        expandedHoldings.delete(expandKey);
        detailRow.style.display = 'none';
        chevron.textContent = '▸';
        chevron.setAttribute('aria-expanded', 'false');
      } else {
        expandedHoldings.add(expandKey);
        renderDetail();
        detailRow.style.display = '';
        chevron.textContent = '▾';
        chevron.setAttribute('aria-expanded', 'true');
      }
    });
  }
  table.append(tbody);
  // On a phone the eight columns scroll sideways inside the card (with an
  // edge fade, js/ui/scroll-cue.js) rather than crushing into one-word lines.
  const scroller = document.createElement('div');
  scroller.className = 'inv-holdings-scroll';
  scroller.setAttribute('data-scroll-cue', '');
  table.classList.add('inv-holdings-table');
  scroller.append(table);
  card.append(scroller);
  return card;
}

// ── Expanded detail: contributing txs + manual corrections ──────────────
export function buildHoldingDetail(account, symbol, { onChange = null } = {}) {
  const generation = currentBudgetSession(), folder = state.budgetFolder;
  const isCurrent = () => generation === currentBudgetSession() && folder === state.budgetFolder;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'padding:8px 0;';

  const realTxs = (state.transactions || []).filter(tx =>
    tx?.type === 'investment_transfer'
    && txSymbol(tx) === symbol
    && (tx.from_account === account.id || tx.to_account === account.id),
  );
  const manualRows = getManualRows(state.meta, account.id, symbol);

  // Combine for display, marking source. Real txs may be buy / sell /
  // dividend; manual rows are buy or sell only (the manual-row writer
  // doesn't accept dividends — those should be entered as transactions
  // because they move cash).
  const normalizeTxDirection = (d) =>
    d === 'sell' ? 'sell' : d === 'dividend' ? 'dividend' : 'buy';
  const combined = [
    ...realTxs.map(tx => ({
      kind: 'tx',
      id: tx.id,
      date: tx.date || '',
      direction: normalizeTxDirection(tx.direction),
      units: Number(tx.units) || 0,
      cash: txAbsAmount(tx),
      payee: tx.payee || '',
      raw: tx,
    })),
    ...manualRows.map(r => ({
      kind: 'manual',
      id: r.id,
      date: r.date || '',
      direction: r.direction === 'sell' ? 'sell'
               : r.direction === 'adjust' ? 'adjust'
               : 'buy',
      units: Number(r.units) || 0,
      cash: Number(r.amount) || 0,
      note: r.note || '',
      raw: r,
    })),
  ].sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  // Walk the sorted rows once and record the cumulative (units, costBasis)
  // *after* each row, mirroring computeHoldings so the drill-down agrees
  // with the holding card. Surfacing this lets users sanity-check entries
  // before they trust the headline numbers — "after this sell I should
  // have 6 units left, basis €600" etc.
  let runUnits = 0;
  let runCost = 0;
  for (const row of combined) {
    if (row.direction === 'buy') {
      runUnits += row.units;
      runCost += row.cash;
    } else if (row.direction === 'sell') {
      const avg = runUnits > 0 ? runCost / runUnits : 0;
      const removed = Math.min(row.units, runUnits);
      const costRemoved = avg * removed;
      runUnits -= removed;
      runCost -= costRemoved;
      if (runUnits <= 1e-9) { runUnits = 0; runCost = 0; }
    } else if (row.direction === 'adjust') {
      runUnits += row.units;
      runCost += row.cash;
    }
    // dividend: no change to units/costBasis
    row.runningUnits = runUnits;
    row.runningCost = runCost;
  }

  if (combined.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.cssText = 'font-size:13px;padding:6px 0 12px;';
    empty.textContent = t('investments.detail.empty');
    wrap.append(empty);
  } else {
    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;margin-bottom:8px;';
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    for (const [label, align] of [
      [t('investments.detail.colDate'), 'left'],
      [t('investments.detail.colDir'), 'left'],
      [t('investments.detail.colUnits'), 'right'],
      [t('investments.detail.colCash'), 'right'],
      [t('investments.detail.colRunUnits'), 'right'],
      [t('investments.detail.colRunCost'), 'right'],
      [t('investments.detail.colSource'), 'left'],
      ['', 'right'],
    ]) {
      const th = document.createElement('th');
      th.textContent = label;
      th.style.cssText = `text-align:${align};padding:4px 6px;border-bottom:1px solid var(--border, #e5e7eb);font-weight:600;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;`;
      trh.append(th);
    }
    thead.append(trh);
    table.append(thead);
    const tbody = document.createElement('tbody');
    for (const row of combined) {
      const tr = document.createElement('tr');
      tr.style.cssText = 'border-bottom:1px solid var(--border, #f0f0f0);';
      if (row.kind === 'tx') {
        tr.style.cursor = 'pointer';
        tr.title = t('investments.detail.openTx') || '';
        tr.addEventListener('click', (e) => {
          // Skip when the click originated on a button inside the row
          // (e.g. the manual-row remove button) so those keep working.
          if (e.target.closest('button')) return;
          import('./edit-tx.js')
            .then(m => { if (isCurrent()) m.openEditTx(row.raw, { onAfterChange: onChange }); })
            .catch(err => console.error(err));
        });
      }

      const tdDate = document.createElement('td');
      tdDate.style.cssText = 'padding:6px;font-variant-numeric:tabular-nums;';
      tdDate.textContent = row.date ? fmtDateLang(row.date) : '—';
      tr.append(tdDate);

      const tdDir = document.createElement('td');
      tdDir.style.cssText = 'padding:6px;';
      tdDir.textContent = row.direction === 'sell' ? t('investments.detail.sell')
                       : row.direction === 'dividend' ? t('investments.detail.dividend')
                       : row.direction === 'adjust' ? t('investments.detail.adjust')
                       : t('investments.detail.buy');
      tr.append(tdDir);

      tr.append(numCell(unitsLabel(row.units)));
      tr.append(numCell(fmtMoney(row.cash)));
      // Running totals — muted to read as secondary info next to the
      // per-row units/cash above.
      const tdRunU = numCell(unitsLabel(row.runningUnits));
      tdRunU.style.color = 'var(--muted)';
      tr.append(tdRunU);
      const tdRunC = numCell(fmtMoney(row.runningCost));
      tdRunC.style.color = 'var(--muted)';
      tr.append(tdRunC);

      const tdSrc = document.createElement('td');
      tdSrc.style.cssText = 'padding:6px;font-size:12px;color:var(--muted);';
      if (row.kind === 'manual') {
        const tag = document.createElement('span');
        tag.style.cssText = 'padding:1px 6px;border-radius:8px;background:var(--bg-sunken);color:var(--muted);font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:0.4px;';
        tag.textContent = t('investments.detail.manualBadge');
        tdSrc.append(tag);
        if (row.note) {
          const nm = document.createElement('span');
          nm.style.marginLeft = '6px';
          nm.textContent = row.note;
          tdSrc.append(nm);
        }
      } else if (row.payee) {
        tdSrc.textContent = row.payee;
      }
      tr.append(tdSrc);

      const tdAct = document.createElement('td');
      tdAct.style.cssText = 'padding:6px;text-align:right;';
      if (row.kind === 'manual') {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'btn btn-ghost btn-sm';
        edit.textContent = t('investments.detail.edit');
        edit.addEventListener('click', () => startEdit(row.raw));
        tdAct.append(edit);
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'btn btn-ghost btn-sm';
        rm.style.color = 'var(--danger, var(--rose))';
        rm.textContent = t('investments.detail.remove');
        rm.addEventListener('click', async () => {
          if (!isCurrent()) return;
          const removed = await dispatchOrReport(session, 'investment.removeManualRow', { account: account.id, symbol, id: row.id });
          if (!removed || !isCurrent()) return;
          toast(t('investments.detail.removed'));
          if (onChange) onChange(); else navigate('investments');
        });
        tdAct.append(rm);
      }
      tr.append(tdAct);

      tbody.append(tr);
    }
    table.append(tbody);
    wrap.append(table);
  }

  // Add-correction inline form; Edit on a manual row reuses it, pre-filled.
  const formWrap = document.createElement('details');
  formWrap.style.cssText = 'margin-top:4px;';
  const summary = document.createElement('summary');
  summary.style.cssText = 'cursor:pointer;font-size:13px;color:var(--accent);padding:4px 0;';
  summary.textContent = t('investments.detail.addCorrection');
  formWrap.append(summary);

  const form = document.createElement('form');
  form.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit, minmax(120px, 1fr));gap:8px;align-items:end;padding:8px 0;';

  const defaultDate = isoDate(appNow());
  const dateField = inlineField(t('investments.detail.colDate'), 'date', defaultDate);
  const dirField = inlineSelect(t('investments.detail.colDir'), [
    ['buy', t('investments.detail.buy')],
    ['sell', t('investments.detail.sell')],
    ['adjust', t('investments.detail.adjust')],
  ]);
  // Buy/sell take positive magnitudes; adjust takes signed deltas
  // (negative = decrease). Step + min get retuned when the direction
  // toggles below.
  const unitsField = inlineField(t('investments.detail.colUnits'), 'number', '', { step: '0.000001', min: '0' });
  const cashField = inlineField(t('investments.detail.colCash'), 'number', '', { step: '0.01', min: '0' });
  const noteField = inlineField(t('investments.detail.note'), 'text', '');
  form.append(dateField.wrap, dirField.wrap, unitsField.wrap, cashField.wrap, noteField.wrap);
  enableFormulaInput(unitsField.input, { decimals: 6 });
  enableFormulaInput(cashField.input);

  function applyDirAttrs() {
    const isAdjust = dirField.select.value === 'adjust';
    // enableFormulaInput switched the inputs to type="text" and moved min
    // into dataset.min, which is what its evaluation clamp reads — so the
    // adjust toggle must edit the dataset, not the attribute.
    if (isAdjust) {
      delete unitsField.input.dataset.min;
      delete cashField.input.dataset.min;
    } else {
      unitsField.input.dataset.min = '0';
      cashField.input.dataset.min = '0';
    }
  }
  dirField.select.addEventListener('change', applyDirAttrs);

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-accent btn-sm';
  submit.textContent = t('investments.detail.save');
  const submitWrap = document.createElement('div');
  submitWrap.style.cssText = 'display:flex;align-items:end;gap:6px;';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-ghost btn-sm';
  cancel.textContent = t('common.cancel');
  cancel.hidden = true;
  cancel.addEventListener('click', () => stopEdit());
  submitWrap.append(submit, cancel);
  form.append(submitWrap);

  // The id of the manual row being edited, or null when adding.
  let editingId = null;
  function startEdit(r) {
    editingId = r.id;
    dateField.input.value = r.date || '';
    dirField.select.value = r.direction === 'sell' || r.direction === 'adjust' ? r.direction : 'buy';
    applyDirAttrs();
    unitsField.input.value = String(Number(r.units) || 0);
    cashField.input.value = String(Number(r.amount) || 0);
    noteField.input.value = r.note || '';
    summary.textContent = t('investments.detail.editCorrection');
    cancel.hidden = false;
    formWrap.open = true;
    dateField.input.focus();
  }
  function stopEdit() {
    editingId = null;
    dateField.input.value = defaultDate;
    dirField.select.value = 'buy';
    unitsField.input.value = '';
    cashField.input.value = '';
    noteField.input.value = '';
    applyDirAttrs();
    summary.textContent = t('investments.detail.addCorrection');
    cancel.hidden = true;
    formWrap.open = false;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!isCurrent()) return;
    const direction = dirField.select.value;
    const units = parseAmountInput(unitsField.input.value);
    const amount = parseAmountInput(cashField.input.value);
    const isAdjust = direction === 'adjust';
    if (!dateField.input.value) {
      toast(t('investments.detail.invalid'));
      return;
    }
    if (isAdjust) {
      // Adjust: at least one of units or amount must be non-zero.
      const u = Number.isFinite(units) ? units : 0;
      const a = Number.isFinite(amount) ? amount : 0;
      if (u === 0 && a === 0) {
        toast(t('investments.detail.invalid'));
        return;
      }
    } else if (!(units > 0) || !(amount >= 0)) {
      toast(t('investments.detail.invalid'));
      return;
    }
    const fields = {
      date: dateField.input.value,
      direction,
      units: Number.isFinite(units) ? units : 0,
      amount: Number.isFinite(amount) ? amount : 0,
      note: noteField.input.value.trim(),
    };
    const saved = editingId
      ? await dispatchOrReport(session, 'investment.updateManualRow', { account: account.id, symbol, id: editingId, row: fields })
      : await dispatchOrReport(session, 'investment.addManualRow', { account: account.id, symbol, row: fields });
    if (!saved || !isCurrent()) return;
    toast(t(editingId ? 'investments.detail.updated' : 'investments.detail.added'));
    if (onChange) onChange(); else navigate('investments');
  });

  formWrap.append(form);
  wrap.append(formWrap);
  return wrap;
}

function inlineField(label, type, value, attrs = {}) {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;';
  const lbl = document.createElement('span');
  lbl.textContent = label;
  const input = document.createElement('input');
  input.type = type;
  input.className = 'form-input';
  input.value = value || '';
  for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
  input.style.cssText = 'font-size:13px;text-transform:none;letter-spacing:0;padding:4px 6px;';
  wrap.append(lbl, input);
  return { wrap, input };
}

function inlineSelect(label, options) {
  const wrap = document.createElement('label');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;';
  const lbl = document.createElement('span');
  lbl.textContent = label;
  const select = document.createElement('select');
  select.className = 'form-input';
  select.style.cssText = 'font-size:13px;text-transform:none;letter-spacing:0;padding:4px 6px;';
  for (const [v, t] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = t;
    select.append(o);
  }
  wrap.append(lbl, select);
  return { wrap, select };
}

// Inline-editable price cell. Renders the current price as a tabular
// number; the cell turns into an input on focus/click and saves on
// blur or Enter. `asOf` is shown underneath and gets stamped to today
// whenever the user saves a new price.
function buildPriceCell(holding, priceInfo) {
  const td = document.createElement('td');
  td.style.cssText = 'padding:10px 6px;text-align:right;vertical-align:top;';

  const initial = Number.isFinite(priceInfo?.price) ? priceInfo.price : null;

  // Display view: formatted price consistent with other money columns
  const displaySpan = document.createElement('span');
  displaySpan.className = 'money-amount money-table';
  displaySpan.style.cssText = 'font-variant-numeric:tabular-nums;cursor:text;';
  displaySpan.title = t('investments.priceEditHint');
  displaySpan.tabIndex = 0;

  function renderDisplay(price) {
    displaySpan.textContent = price === null ? '—' : fmtMoney(price);
  }
  renderDisplay(initial);

  // Edit view: plain input, shown only while editing
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.autocomplete = 'off';
  input.value = initial === null ? '' : String(initial);
  input.placeholder = '—';
  input.title = t('investments.priceEditHint');
  input.hidden = true;
  input.className = 'form-input';
  input.style.cssText = [
    'width:6em',
    'text-align:right',
    'font-variant-numeric:tabular-nums',
    'padding:2px 4px',
  ].join(';');

  function showEdit() {
    displaySpan.hidden = true;
    input.hidden = false;
    input.focus();
    input.select();
  }

  displaySpan.addEventListener('click', showEdit);
  displaySpan.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showEdit(); }
  });

  input.addEventListener('blur', () => {
    input.hidden = true;
    displaySpan.hidden = false;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') {
      input.value = initial === null ? '' : String(initial);
      input.blur();
    }
  });
  input.addEventListener('change', async () => {
    const raw = input.value.trim();
    const parsed = raw === '' ? null : parseAmountInput(raw);
    if (parsed === null) return; // Empty doesn't clear; use the dialog's clearOverride.
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast(t('investments.dialog.invalidNumbers'));
      input.value = initial === null ? '' : String(initial);
      return;
    }
    // Cap precision at 5 decimal places — matches setPrice's storage
    // rounding so what the user sees back is what got saved.
    const next = Math.round(parsed * 100000) / 100000;
    input.value = String(next);
    if (initial !== null && Math.abs(next - initial) < 0.000005) return;
    const today = isoDate(appNow());
    const saved = await dispatchOrReport(session, 'investment.setPrice', { symbol: holding.symbol, price: next, asOf: today });
    if (!saved) {
      input.value = initial === null ? '' : String(initial);
      return;
    }
    toast(t('investments.priceSaved'));
    navigate('investments');
  });
  td.append(displaySpan, input);

  if (initial !== null) {
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.style.cssText = 'font-size:11px;';
    meta.textContent = priceInfo.asOf ? fmtDateLang(priceInfo.asOf) : '';
    if (priceInfo.fx) {
      // Converted from the market's own currency (fetchPrices): say from what.
      meta.textContent += ` · ${t('investments.priceConverted')(priceInfo.fx.currency, priceInfo.fx.price)}`;
    }
    if (isStalePrice(priceInfo.asOf)) {
      meta.style.color = 'var(--warning, var(--butter))';
      meta.title = t('investments.priceStale');
    }
    td.append(meta);
  }

  return td;
}

// ── Unmapped investment transactions card ──────────────────────────────

function buildPortfolioInsightCard() {
  let card, body;
  function load(noCache = false) {
    withAiState(body, async (signal) => {
      const out = await aiInsights('portfolio_insight', { signal, noCache });
      renderPortfolioInsight(body, out);
    });
  }
  ({ card, body } = renderAiCard({
    titleKey: 'ai.portfolio.title',
    subKey: 'ai.portfolio.sub',
    onRefresh: () => load(true),
  }));
  load(false);
  return { card, refresh: load };
}

function renderPortfolioInsight(host, out) {
  host.replaceChildren();

  if (out?.refused) {
    const msg = document.createElement('div');
    msg.className = 'ai-error';
    msg.textContent = t('ai.portfolio.refused');
    host.append(msg);
    return;
  }

  if (out?.headline) {
    const p = document.createElement('p');
    p.className = 'ai-headline';
    p.textContent = formatAiText(out.headline);
    host.append(p);
  }

  const observations = Array.isArray(out?.observations) ? out.observations : [];
  if (!observations.length) {
    const empty = document.createElement('div');
    empty.className = 'ai-error';
    empty.textContent = t('ai.portfolio.empty');
    host.append(empty);
    return;
  }

  const accountById = new Map((state.accounts || []).map((a) => [a.id, a]));
  for (const obs of observations) {
    const row = document.createElement('div');
    row.className = 'ai-row';

    const dot = document.createElement('span');
    dot.className = 'ai-dot ' + (obs.severity === 'warn' ? 'ai-dot-warn' : 'ai-dot-info');
    row.append(dot);

    const text = document.createElement('div');
    text.style.flex = '1';
    text.style.minWidth = '0';

    const msg = document.createElement('div');
    msg.textContent = formatAiText(obs.message || '');
    text.append(msg);

    const tagBits = [];
    if (obs.symbol) tagBits.push(formatAiText(obs.symbol));
    if (obs.account_id && accountById.has(obs.account_id)) {
      tagBits.push(accountById.get(obs.account_id).name);
    }
    if (tagBits.length) {
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.style.cssText = 'font-size:12px;color:var(--muted);margin-top:2px;';
      sub.textContent = tagBits.join(' · ');
      text.append(sub);
    }
    row.append(text);

    const badge = document.createElement('span');
    badge.style.cssText = 'font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;';
    badge.textContent = t(portfolioKindKey(obs.kind));
    row.append(badge);

    host.append(row);
  }

  const disclaimer = document.createElement('div');
  disclaimer.className = 'sub';
  disclaimer.style.cssText = 'margin-top:10px;font-size:12px;color:var(--muted);';
  disclaimer.textContent = t('ai.portfolio.disclaimer');
  host.append(disclaimer);
}

function portfolioKindKey(kind) {
  const map = {
    concentration:      'ai.portfolio.kind.concentration',
    contribution_pace:  'ai.portfolio.kind.contribution',
    idle_cash:          'ai.portfolio.kind.idleCash',
    distribution_yield: 'ai.portfolio.kind.distribution',
    realized_activity:  'ai.portfolio.kind.realized',
    diversification:    'ai.portfolio.kind.diversification',
    other:              'ai.portfolio.kind.other',
  };
  return map[kind] || 'ai.portfolio.kind.other';
}

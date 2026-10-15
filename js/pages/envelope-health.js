// js/pages/envelope-health.js — the envelope health check sheet.
//
// Read-only by design: recommendations state their numbers and link to the
// flow that applies them (fill envelopes, or the template editor). Nothing
// here writes, so there is no version-conflict path to handle.

import { navigate, now as appNow, getPrefs, activeLensInput } from '../app.js';
import { ask } from '../ui/query.js';
import { isoDate } from '../core/context.js';
import { openSheet } from '../ui/sheet.js';
import { moneyEl } from '../ui/money.js';
import { healthChart } from '../ui/health-chart.js';
import { t, trEnv } from '../ui/i18n.js';
import { fmt } from '../utils.js';
import { openFillEnvelopes } from './fill-envelopes.js';
import { itemFundingSection } from '../ui/item-funding-view.js';

const SEVERITY_COLOR = {
  critical: 'var(--danger, var(--rose))',
  warn: 'var(--warning, var(--butter))',
  info: 'var(--muted)',
};

function tile(labelText, value, dateText, danger = false) {
  const box = document.createElement('div');
  box.className = 'card';
  box.style.cssText = 'flex:1;min-width:150px;padding:12px 14px;';
  const label = document.createElement('div');
  label.className = 'muted';
  label.style.cssText = 'font-size:12px;text-transform:uppercase;letter-spacing:.04em;';
  label.textContent = labelText;
  const amount = moneyEl(value, { size: 'lg' });
  if (danger) amount.style.color = 'var(--danger, var(--rose))';
  box.append(label, amount);
  if (dateText) {
    const sub = document.createElement('div');
    sub.className = 'muted';
    sub.style.fontSize = '12px';
    sub.textContent = dateText;
    box.append(sub);
  }
  return box;
}

// `projection.months` is not always 12 entries: a window that doesn't start
// on the 1st (the common case) has a partial bucket at each end, so this can
// be 13. Rows never assume a fixed count, and a partial bucket is marked
// rather than shown as if it closed a full calendar month.
function monthTable(projection) {
  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
  const caption = document.createElement('caption');
  caption.textContent = t('health.tableCaption');
  caption.style.cssText = 'text-align:left;font-weight:600;padding:8px 0;';
  table.append(caption);

  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  for (const key of ['colMonth', 'colOpening', 'colIn', 'colOut', 'colLow', 'colClosing']) {
    const th = document.createElement('th');
    th.textContent = t(`health.${key}`);
    th.style.cssText = 'padding:6px 8px;border-bottom:1px solid var(--border, #e5e7eb);font-weight:600;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;text-align:left;';
    if (key !== 'colMonth') th.style.textAlign = 'right';
    hrow.append(th);
  }
  thead.append(hrow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const m of projection.months) {
    const row = document.createElement('tr');
    row.style.cssText = 'border-bottom:1px solid var(--border, #f0f0f0);';
    // Partial buckets (window doesn't cover the whole calendar month) are
    // dimmed and marked with a tilde so the closing balance there is never
    // mistaken for a full month's figure.
    if (m.partial) row.style.opacity = '0.6';

    const monthCell = document.createElement('td');
    monthCell.style.cssText = 'padding:6px 8px;';
    monthCell.textContent = m.partial ? `${m.key} ~` : m.key;
    row.append(monthCell);

    for (const value of [m.opening, m.in, m.out, m.low, m.closing]) {
      const cell = document.createElement('td');
      cell.style.cssText = 'padding:6px 8px;text-align:right;';
      const money = moneyEl(value, { size: 'inline' });
      if (value < -0.005) money.style.color = 'var(--danger, var(--rose))';
      cell.append(money);
      row.append(cell);
    }
    tbody.append(row);
  }
  table.append(tbody);
  return table;
}

// Maps a recommendation to its display text plus an optional deep link.
// Amounts come from the engine already verified; this only formats them.
function recommendationText(rec, projection) {
  const money = v => fmt(v);
  const T = t('health.rec');
  // `fillMode: 'set'` — the envelope is topped up TO a target by a scheduled
  // set-mode template, and the engine's amount is a change to that target.
  const isSet = rec.meta && rec.meta.fillMode === 'set';
  switch (rec.kind) {
    case 'shortfall-topup':
      return rec.amount === null
        ? { text: T.shortfallTopupUnsolvable, action: null }
        : { text: T.shortfallTopup(money(rec.amount), rec.date), action: 'fill', amount: rec.amount };
    case 'shortfall-monthly':
      if (rec.amount === null) {
        return { text: isSet ? T.shortfallTargetUnsolvable : T.shortfallMonthlyUnsolvable, action: null };
      }
      return {
        text: (isSet ? T.shortfallTarget : T.shortfallMonthly)(money(rec.amount), money(projection.monthlyFill + rec.amount)),
        action: 'template',
      };
    case 'overfunded-trim':
      return {
        text: (isSet ? T.overfundedTrimTarget : T.overfundedTrim)(money(rec.amount), money(projection.monthlyFill - rec.amount)),
        action: 'template',
      };
    case 'goal-on-track':
      return {
        text: rec.date
          ? T.goalOnTrack(money(rec.meta.goalAmount), rec.date)
          : T.goalOnTrackNoDate(money(rec.meta.goalAmount)),
        action: null,
      };
    case 'goal-shortfall': {
      // A goal with no date is compared at the end of the projection window;
      // name that date rather than printing "by null".
      const by = rec.date || rec.meta.cutoff;
      if (rec.amount === null) {
        return { text: T.goalShortfallUnsolvable(money(rec.meta.goalAmount), by), action: null };
      }
      // `fillMode: 'one-time'` — no monthly rate to raise, so the amount is a
      // single top-up by `by`, and the action is a fill, not a template edit.
      if (rec.meta.fillMode === 'one-time') {
        return {
          text: T.goalShortfallTopup(money(rec.meta.goalAmount), by, money(rec.amount)),
          action: 'fill',
          amount: rec.amount,
        };
      }
      return {
        text: (isSet ? T.goalShortfallTarget : T.goalShortfall)(money(rec.meta.goalAmount), by, money(rec.amount)),
        action: 'template',
      };
    }
    case 'warn-fill-from-history':
      return { text: T.warnFillFromHistory, action: null };
    case 'warn-no-fill':
      return { text: T.warnNoFill, action: null };
    case 'warn-irregular-fill':
      return { text: T.warnIrregularFill, action: null };
    case 'warn-drain-only-fill':
      return { text: T.warnDrainOnlyFill, action: null };
    case 'warn-no-scheduled-expenses':
      return { text: T.warnNoScheduledExpenses, action: null };
    case 'warn-unresolved-envelope':
      return { text: T.warnUnresolvedEnvelope, action: null };
    default:
      return { text: '', action: null };
  }
}

export function openEnvelopeHealth(envelope) {
  // Everything the sheet shows is the `envelope.health` query's, asked once
  // as it opens: the 12-month projection (built from the stored rows, as it
  // generates its own scheduled rows and fills; the Forecast lens's rows
  // would count them twice), the recommendations on it, the item funding
  // judged against it, and the balance through the active lens. A failed
  // query opens nothing (warned in the console).
  const answer = ask('envelope.health', { envelope: envelope.id, months: 12, ...activeLensInput(), date: isoDate(appNow()) });
  if (!answer) return;
  const { projection, recommendations: recs, lensBalance, funding } = answer;

  const wrap = document.createElement('div');

  const sub = document.createElement('div');
  sub.className = 'muted';
  sub.style.marginBottom = '12px';
  // `scheduled-irregular` gets its own line rather than falling through to
  // `fillNone`: there IS a scheduled fill, it just has no monthly rate, and
  // saying "no recurring fill found" for a quarterly-funded envelope is as
  // wrong as quoting the quarterly amount as a monthly one.
  // `scheduled-set` states the TARGET, never a per-month amount.
  const fillLine = projection.fillSource === 'scheduled'
    ? t('health.fillScheduled')(fmt(projection.monthlyFill))
    : projection.fillSource === 'scheduled-set'
      ? t('health.fillSet')(fmt(projection.monthlyFill))
      : projection.fillSource === 'scheduled-irregular'
        ? t('health.fillIrregular')
        : projection.fillSource === 'history'
          ? t('health.fillHistory')(fmt(projection.monthlyFill))
          : t('health.fillNone');
  sub.textContent = `${t('health.subtitle')} · ${fillLine}`;
  wrap.append(sub);

  const tiles = document.createElement('div');
  tiles.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;';
  // The balance the envelope card shows, in the active lens, so the sheet
  // opens on the number the user clicked from. The projection always starts
  // from today's balance (plus any bill due and not yet posted); when that
  // differs, say so, or the card, this tile and the chart's first point would
  // not add up.
  const lens = ['today', 'booked', 'forecast'].includes(getPrefs().lens) ? getPrefs().lens : 'booked';
  const startsElsewhere = Math.abs(lensBalance - projection.opening) >= 0.005;
  const balanceTile = tile(
    t('health.balanceLabel')(t(`lens.${lens}`)),
    lensBalance,
    startsElsewhere ? t('health.projectionStartsFrom')(fmt(projection.opening)) : null,
    lensBalance < -0.005,
  );
  balanceTile.classList.add('health-balance-tile');
  tiles.append(
    balanceTile,
    tile(t('health.lowLabel'), projection.low.balance, t('health.onDate')(projection.low.date), projection.low.balance < -0.005),
    tile(t('health.highLabel'), projection.high.balance, t('health.onDate')(projection.high.date)),
    tile(t('health.closingLabel'), projection.closing, null, projection.closing < -0.005),
  );
  wrap.append(tiles);

  // Fill %: the balance as of today (future-dated rows have not left the
  // envelope yet) split across this envelope's budget items, each judged
  // against the projection on its due date (the walk the chart below draws:
  // an item is short exactly where it dips).
  if (funding && funding.items.length) wrap.append(itemFundingSection(funding));

  const chartBox = document.createElement('div');
  chartBox.style.cssText = 'margin-bottom:18px;overflow-x:auto;';
  chartBox.append(healthChart({
    daily: projection.daily,
    low: projection.low,
    high: projection.high,
    ariaLabel: t('health.chartLabel')(fmt(projection.low.balance), fmt(projection.high.balance)),
  }));
  wrap.append(chartBox);

  const recsBox = document.createElement('div');
  recsBox.style.marginBottom = '18px';
  const recsTitle = document.createElement('h3');
  recsTitle.textContent = t('health.recsTitle');
  recsBox.append(recsTitle);

  if (recs.length === 0) {
    const none = document.createElement('p');
    none.className = 'muted';
    none.textContent = t('health.recsNone');
    recsBox.append(none);
  }

  for (const rec of recs) {
    const { text, action } = recommendationText(rec, projection);
    if (!text) continue;
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'padding:12px 14px;margin-bottom:8px;';
    const body = document.createElement('p');
    body.style.cssText = `margin:0 0 8px;color:${SEVERITY_COLOR[rec.severity] || 'inherit'};`;
    body.textContent = text;
    card.append(body);

    if (rec.meta && rec.meta.beyondWindow) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.style.cssText = 'margin:0 0 8px;font-size:12px;';
      note.textContent = t('health.rec').goalBeyondWindow;
      card.append(note);
    }

    if (action === 'fill') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-sm';
      btn.textContent = t('health.actionFill');
      // openFillEnvelopes takes no prefill option (only `onSubmitted`) — see
      // js/pages/fill-envelopes.js. `amount` is already stated in the
      // recommendation text above, so opening it bare is enough.
      btn.addEventListener('click', () => openFillEnvelopes());
      card.append(btn);
    } else if (action === 'template') {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-sm';
      btn.textContent = t('health.actionTemplate');
      btn.addEventListener('click', () => navigate('templates'));
      card.append(btn);
    }

    recsBox.append(card);
  }
  wrap.append(recsBox);

  wrap.append(monthTable(projection));

  // trEnv takes the envelope object, not its name — it reads `i18n_key` first.
  openSheet({ title: t('health.title')(trEnv(envelope)), content: wrap, wide: true });
}

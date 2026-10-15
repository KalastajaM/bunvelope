// js/pages/net-worth-simulation.js — the Net worth page's "Next 24 months"
// card: month-end lines from the simulation walk (the forecast.simulation
// query) and the dates to act on. Always the Forecast rows, whatever lens is
// active: a simulation is a projection by definition, and the subtitle says
// so.

import { navigate } from '../app.js';
import { openFillEnvelopes } from './fill-envelopes.js';
import { mountChart } from '../ui/charts/index.js';
import { fmt } from '../utils.js';
import { t, fmtMonthLang, fmtDateLang } from '../ui/i18n.js';

const PARTS = ['spending', 'savings', 'investment', 'pension', 'assets', 'loansGiven', 'debts'];

const nameOf = (list, id) => (list || []).find(x => x && x.id === id)?.name || id;

// Exported so the Dashboard's "date to act on" card renders the same
// wording for the one alert it shows (js/pages/dashboard.js).
export function alertText(a, { accounts, envelopes, todayIso }) {
  const when = a.firstDate === todayIso ? t('netWorth.whenNow') : t('netWorth.whenOn')(fmtDateLang(a.firstDate));
  const low = fmt(a.low, { decimals: 0 });
  const lowDate = fmtDateLang(a.lowDate);
  if (a.kind === 'account-negative') return t('netWorth.alertAccount')(nameOf(accounts, a.id), when, low, lowDate);
  if (a.kind === 'envelope-short') {
    return t('netWorth.alertEnvelope')(nameOf(envelopes, a.id), when, a.threshold > 0 ? fmt(a.threshold, { decimals: 0 }) : null);
  }
  if (a.kind === 'unallocated-negative') return t('netWorth.alertUnallocated')(when, low, lowDate);
  return t('netWorth.alertCrisis')(when, fmt(a.threshold, { decimals: 0 }));
}

function openAlert(a) {
  if (a.kind === 'account-negative') navigate('transactions', `account:${a.id}`);
  else if (a.kind === 'envelope-short') navigate('transactions', a.id);
  else if (a.kind === 'unallocated-negative') openFillEnvelopes({ onSubmitted: () => navigate('net-worth') });
  else navigate('stress');
}

/**
 * @param {{ sims: { low: any, base: any, high: any }, accounts: any[],
 *   filtered?: boolean, envelopes: any[],
 *   todayIso: string, card: (title: string, sub?: string) => HTMLElement,
 *   whatIf?: { name: string, alertsDiff: { added: any[], removed: any[], moved: any[] } } | null }} input
 *   `sims` are forecast.simulation answers: their `points` total the
 *   accounts this page counts (the page filter may leave some out), the base
 *   run's `alerts` cover every account. `accounts` names the dates to act
 *   on. `whatIf`, when given, adds a "With <name>" list of how its dates to
 *   act on differ from the base run's (the what-if answer's `alertsDiff`).
 */
export function simulationCard({ sims, accounts, filtered = false, envelopes, todayIso, card, whatIf = null }) {
  const el = card(t('netWorth.simTitle'), t('netWorth.simSub'));

  // Month-end net worth and its parts.
  const basePoints = sims.base.points;
  const total = points => points.map(p => p.total);
  const series = [
    { id: 'base', name: t('netWorth.base'), values: total(basePoints) },
    { id: 'low', name: t('netWorth.low'), values: total(sims.low.points) },
    { id: 'high', name: t('netWorth.high'), values: total(sims.high.points) },
  ];
  // The parts start hidden: the chart opens as base and its band, and each
  // part is one legend click away, or all of them via the Stacked view.
  const partIds = [];
  for (const part of PARTS) {
    if (!basePoints.some(p => Math.abs(p[part]) >= 0.005)) continue;
    series.push({ id: part, name: t(`netWorth.part.${part}`), values: basePoints.map(p => p[part]), hidden: true });
    partIds.push(part);
  }
  const x = basePoints.map(p => ({ key: p.date, label: fmtMonthLang(p.date.slice(0, 7)) }));
  // Each date to act on marks the month-end point of the month it first
  // happens in; selecting that point does what its button below does.
  const keyOfMonth = new Map(x.map(p => [String(p.key).slice(0, 7), p.key]));
  const markers = sims.base.alerts
    .map(a => ({ key: keyOfMonth.get(a.firstDate.slice(0, 7)), label: alertText(a, { accounts, envelopes, todayIso }), onSelect: () => openAlert(a) }))
    .filter(m => m.key != null);
  const chart = mountChart({
    id: 'nw-simulation', kind: 'line', scaleControl: true, title: t('netWorth.simTitle'), height: 280,
    csvName: filtered ? `${t('netWorth.simTitle')} ${t('pageFilter.filtered')}` : t('netWorth.simTitle'),
    format: v => fmt(v, { decimals: 0 }),
    x, series, markers,
    band: { low: 'low', high: 'high', around: 'base' },
    stack: partIds.length ? { ids: partIds } : undefined,
  });

  const actHead = document.createElement('h4');
  actHead.className = 'net-worth-act-title';
  actHead.textContent = t('netWorth.actTitle');
  const list = document.createElement('ul');
  list.className = 'net-worth-alerts';
  if (!sims.base.alerts.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = t('netWorth.actNone');
    list.append(li);
  }
  for (const a of sims.base.alerts) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'net-worth-alert';
    b.textContent = alertText(a, { accounts, envelopes, todayIso });
    b.addEventListener('click', () => openAlert(a));
    li.append(b);
    list.append(li);
  }
  el.append(chart, actHead);
  if (filtered) {
    const note = document.createElement('p');
    note.className = 'net-worth-sim-note';
    note.textContent = t('pageFilter.alertsAllAccounts');
    el.append(note);
  }
  el.append(list);

  if (whatIf) {
    const diff = whatIf.alertsDiff;
    const wHead = document.createElement('h4');
    wHead.className = 'net-worth-act-title';
    wHead.textContent = t('netWorth.whatIfWithTitle')(whatIf.name);
    const wList = document.createElement('ul');
    wList.className = 'net-worth-alerts';
    /** @type {string[]} */
    const lines = [];
    const at = a => alertText(a, { accounts, envelopes, todayIso });
    for (const a of diff.added) lines.push(t('netWorth.whatIfNew')(at(a)));
    for (const a of diff.removed) lines.push(t('netWorth.whatIfGone')(at(a)));
    // The alert text already names the new date; say which way it moved and
    // where it was.
    for (const m of diff.moved) {
      const key = m.to < m.from ? 'netWorth.whatIfEarlier' : 'netWorth.whatIfLater';
      lines.push(t(key)(at(m.alert), fmtDateLang(m.from)));
    }
    if (!lines.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = t('netWorth.whatIfNoChange');
      wList.append(li);
    } else {
      for (const text of lines) {
        const li = document.createElement('li');
        li.className = 'net-worth-whatif-diff';
        li.textContent = text;
        wList.append(li);
      }
    }
    el.append(wHead, wList);
  }

  return el;
}

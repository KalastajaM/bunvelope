// Read-only evidence. A ledger date never establishes bank statement coverage.
import { applyAccountEffects } from '../engine/balances.js';
import { computeScheduledOccurrences, dueOccurrenceWindow, forecastKey, scheduledItemForecastable } from '../engine/scheduling.js';
import { cardFundingFor } from '../engine/card-settlement.js';
import { isPostedTx, txAbsAmount } from '../engine/tx-amounts.js';
import { reconciledLedgerBalance, findReconciledDrift } from '../engine/reconciled.js';
import { round2 } from '../utils.js';

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return null;
  const day = value.slice(0, 10);
  const date = new Date(day + 'T00:00:00');
  return Number.isFinite(date.getTime()) && date.getFullYear() === Number(day.slice(0,4)) && date.getMonth() + 1 === Number(day.slice(5,7)) && date.getDate() === Number(day.slice(8,10)) ? day : null;
}

export function accountReadiness(data, todayIso, excludeAccounts = []) {
  const latest = new Map();
  for (const tx of data.transactions || []) {
    const day = validDay(tx?.date);
    if (!isPostedTx(tx) || !day || day > todayIso) continue;
    applyAccountEffects(tx, (id, delta) => {
      if (Number.isFinite(delta) && delta !== 0 && (!latest.has(id) || day > latest.get(id))) latest.set(id, day);
    });
  }
  const excluded = new Set(excludeAccounts);
  return (data.accounts || []).filter(a => !a.archived).map(a => {
    const date = validDay(a.lastReconciledAt);
    const ledger = Number.isFinite(a.lastReconciledLedger);
    const expected = ledger ? a.lastReconciledLedger : Number.isFinite(a.lastReconciledBalance) ? a.lastReconciledBalance : null;
    /** @type {{status:string,date:string|null,expected:number|null,actual:number|null,gap:number|null,checkpointSource:string|null}} */
    const reconciliation = {status:'not-recorded',date,expected:expected === null ? null : round2(expected),actual:null,gap:null,
      checkpointSource:expected === null ? null : ledger ? 'ledger' : 'statement-fallback'};
    if (a.type === 'investment' || a.type === 'asset') reconciliation.status = 'not-applicable';
    else if (!a.lastReconciledAt) reconciliation.status = expected === null ? 'not-recorded' : 'unverifiable';
    else if (!date || expected === null) reconciliation.status = 'unverifiable';
    else if (date > todayIso) reconciliation.status = 'after-start';
    else {
      const actual = reconciledLedgerBalance(a, data.transactions);
      if (actual === null || !Number.isFinite(actual)) reconciliation.status = 'unverifiable';
      else {
        reconciliation.actual = actual;
        reconciliation.gap = round2(actual - expected);
        reconciliation.status = findReconciledDrift([a], data.transactions).length ? 'drift' : 'no-drift';
      }
    }
    return {id:a.id,name:a.name,type:a.type,excluded:excluded.has(a.id),latestPostedDate:latest.get(a.id) || null,reconciliation};
  });
}


export function planReadiness(data, { start, end }) {
  const accounts = data.accounts || [];
  const accountById = new Map(accounts.map(a => [a.id, a]));
  const envelopeById = new Map((data.envelopes || []).map(e => [e.id, e]));
  const taken = new Set((data.transactions || []).filter(t => !t.is_forecast && t.from_budget).map(t => t.from_budget));
  for (const key of data.meta?.scheduledTombstones || []) taken.add(key);
  const checks = [];
  for (const item of data.budgetItems || []) {
    if (!item.as_schedule || item.include === false || scheduledItemForecastable(item, envelopeById, accountById)) continue;
    const window = dueOccurrenceWindow(item.as_schedule_since, new Date(start + 'T00:00:00'));
    const from = window.fromStr < start ? window.fromStr : start;
    const occurrences = computeScheduledOccurrences(item, from, end, {dayType:item.schedule_day_type,country:data.meta?.country || 'FI'});
    if (occurrences.some(o => window.owns(o) && o.date >= start && o.date <= end && !taken.has(forecastKey({forecast_budget_item_id:item.id,forecast_month_key:o.monthKey})))) {
      checks.push({code:'scheduled-input-unavailable',scope:'base-plan',kind:'budgetItem',id:item.id,name:item.description || item.id});
    }
  }
  for (const a of accounts) {
    if (!a.archived && (a.type === 'credit_card' || a.settledFrom) && !cardFundingFor(a, accounts)) {
      checks.push({code:'card-funding-unavailable',scope:'base-plan',kind:'account',id:a.id,name:a.name});
    }
  }
  return {checks};
}

export function estimateReadiness(sim) {
  const groups = new Map();
  for (const row of sim.rows) {
    if (!row.is_forecast || !row.forecast_estimate || row.sim || !txAbsAmount(row)) continue;
    if (row.date < sim.startDate || row.date > sim.endDate) continue;
    const {accountSource, confidence, timing} = row.forecast_estimate;
    const envelopeId = row.envelope_id || null, accountId = row.account || null;
    const key = JSON.stringify([envelopeId, accountId, accountSource, confidence, timing]);
    const group = groups.get(key);
    if (group) {
      group.rowCount++;
      if (row.date < group.firstDate) group.firstDate = row.date;
      if (row.date > group.lastDate) group.lastDate = row.date;
    } else groups.set(key, {envelopeId,accountId,accountSource,confidence,timing,firstDate:row.date,lastDate:row.date,rowCount:1});
  }
  return [...groups.values()];
}

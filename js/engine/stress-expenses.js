// Scenario-only expenses. These never join budgetItems or the posted ledger.
import { round2 } from '../utils.js';
import { MONTHS, SCENARIOS } from './stress.js';

/** Read supported entries defensively without mutating stored metadata. @param {any} raw */
export function stressExpenses(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.filter(e => {
    if (!e || typeof e.id !== 'string' || !e.id || seen.has(e.id) || typeof e.name !== 'string'
      || !e.name.trim() || typeof e.account !== 'string' || !e.account
      || !Number.isInteger(e.day) || e.day < 1 || e.day > 28
      || !e.amounts || !SCENARIOS.every(s => e.amounts[s] === undefined || (Number.isFinite(e.amounts[s]) && e.amounts[s] >= 0 && e.amounts[s] < 1e12))
      || !e.months || !MONTHS.every(m => e.months[m] === undefined || typeof e.months[m] === 'boolean')) return false;
    seen.add(e.id);
    return true;
  });
}

/** @param {any} expense @param {string} scenario */
export function stressExpenseAnnual(expense, scenario) {
  const amount = Number(expense.amounts[scenario]) || 0;
  return round2(MONTHS.filter(m => expense.months[m] === true).length * amount);
}

/** Generate only simulated expenses, using the latest applicable stress change
 * per month (last listed wins ties), so switching severity never doubles costs.
 * @param {any} raw @param {any} scenario @param {string} startIso @param {string} endIso
 */
export function stressExpenseRows(raw, scenario, startIso, endIso) {
  const expenses = stressExpenses(raw);
  const changes = (scenario?.changes || []).filter(c => c.type === 'stress');
  if (!expenses.length || !changes.length) return [];
  const rows = [];
  const [year, month] = startIso.slice(0, 7).split('-').map(Number);
  for (let i = 0; ; i++) {
    const d = new Date(year, month - 1 + i, 1, 12);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (ym > endIso.slice(0, 7)) break;
    let active = null;
    for (const change of changes) if (change.from <= ym && (!active || change.from >= active.from)) active = change;
    if (!active) continue;
    for (const expense of expenses) {
      const amount = round2(expense.amounts[active.scenario] || 0);
      const date = `${ym}-${String(expense.day).padStart(2, '0')}`;
      if (!expense.months[MONTHS[d.getMonth()]] || amount <= 0 || date < startIso || date > endIso) continue;
      rows.push({ id: `stress-expense:${scenario.id}:${expense.id}:${date}`, type: 'expense', date,
        account: expense.account, envelope_id: null, amount, payee: expense.name,
        status: 'scheduled', is_forecast: true, whatif: true });
    }
  }
  return rows;
}

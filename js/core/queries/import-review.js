// Read-only statement review. A sum that fits is evidence, never permission to write.
import { ok, fail } from '../result.js';
import { matchCsvRows } from '../../import/csv-parse-generic.js';
import { getPayeeAliases } from '../payee-fields.js';
import { computeAccountBalances, txAccountDelta } from '../../engine.js';
import { round2 } from '../../utils.js';
import { statementReviewContext } from '../statement-review-context.js';

const cents = n => Math.round(n * 100);
const posted = tx => !tx.is_forecast && tx.status !== 'scheduled';

function explainGap(rows, gap) {
  if (!gap) return { status: 'balanced', keys: [] };
  // Bounded dynamic programming, retaining up to two distinct explanations.
  // Negative and positive rows both participate. Never report unique after truncation.
  if (rows.length > 80) return { status: 'limited', keys: [] };
  /** @type {Map<number, string[][]>} */
  let sums = new Map([[0, [[]]]]);
  for (const row of rows) {
    const next = new Map(sums);
    for (const [sum, paths] of sums) {
      const target = sum + cents(row.amount);
      const found = [...(next.get(target) || [])];
      for (const path of paths) if (found.length < 2) found.push([...path, row.key]);
      next.set(target, found);
    }
    if (next.size > 100000) return { status: 'limited', keys: [] };
    sums = next;
  }
  const matches = sums.get(gap) || [];
  return { status: matches.length > 1 ? 'ambiguous' : matches.length ? 'unique' : 'none', keys: matches.length === 1 ? matches[0] : [] };
}

export default {
  name: 'import.review',
  summary: 'Classify signed statement rows and explain a dated balance gap without writing. Pending reservations and previously adjusted history remain explicit.',
  input: { type: 'object', required: ['account', 'rows'], properties: {
    account: { type: 'ref', kind: 'account' },
    rows: { type: 'array', items: { type: 'object', required: ['key', 'date', 'payee', 'amount'], properties: {
      key: { type: 'string' }, date: { type: 'date' }, payee: { type: 'string' }, amount: { type: 'money' },
      bankStatus: { enum: ['pending', 'booked'] }, bankBalance: { type: 'money' },
    } } },
    target: { type: 'money' }, date: { type: 'date' },
    basis: { enum: ['booked', 'available'], default: 'booked' },
    selected: { type: 'array', items: { type: 'string' } },
    checked: { type: 'array', items: { type: 'string' }, description: 'Reconciliation preview: include only cleared transactions and these checked transaction IDs in the starting balance. Matching still uses the full ledger.' },
  } },
  run(data, input, ctx) {
    if (new Set(input.rows.map(r => r.key)).size !== input.rows.length) return fail('bad_input', { errors: [{ path: 'rows', message: 'source keys must be unique' }] });
    const checking = input.checked !== undefined;
    const checked = new Set(input.checked || []);
    // Check balance posts checked scheduled rows on Save. Preview that same
    // state for both duplicate matching and the starting balance.
    const transactions = (data.transactions || []).filter(tx => posted(tx) || (checking && (tx.cleared || checked.has(tx.id))))
      .map(tx => !posted(tx) && checking ? { ...tx, status: 'posted', is_forecast: false } : tx);
    const booked = input.rows.filter(r => r.bankStatus !== 'pending');
    const date = booked.reduce((d, r) => r.date > d ? r.date : d, '');
    const latest = booked.filter(r => r.date === date && Number.isFinite(r.bankBalance));
    // Multiple balances on the last day need a bank-specific ordering contract.
    const closingBalance = latest.length === 1 ? latest[0].bankBalance : null;
    const asOf = input.date || date || ctx.todayIso;
    const opts = { accountId: input.account, aliases: getPayeeAliases(data.meta) };
    const matches = matchCsvRows(booked, transactions, opts);
    const claimed = new Set(matches.map(r => r.match?.id).filter(Boolean));
    const pending = matchCsvRows(input.rows.filter(r => r.bankStatus === 'pending'), transactions.filter(t => !claimed.has(t.id)), opts);
    const byKey = new Map([...matches, ...pending].map(r => [r.csvRow.key, r]));
    const adjustments = transactions.filter(t => t.type === 'adjustment' && txAccountDelta(t, input.account) !== 0 && t.date <= asOf);
    const selected = input.selected ? new Set(input.selected) : null;
    const rows = input.rows.map(row => {
      const entry = byKey.get(row.key) || { match: null, matchType: 'none', days: undefined, payeeMatch: false };
      const adjustmentDate = adjustments.filter(t => t.date >= row.date).map(t => t.date).sort().at(-1) || null;
      const group = row.bankStatus === 'pending' ? 'pending' : entry.matchType === 'exact' ? 'recorded'
        : entry.matchType === 'possible' || adjustmentDate ? 'review' : 'missing';
      const afterDate = row.date > asOf;
      return { ...row, group, match: entry.match ? { id: entry.match.id, date: entry.match.date, payee: entry.match.payee || '', amount: round2(txAccountDelta(entry.match, input.account)), cleared: !!entry.match.cleared } : null,
        days: entry.days ?? null, payeeMatch: entry.payeeMatch ?? false, adjustmentDate, afterDate,
        included: !afterDate && (selected ? selected.has(row.key) : group === 'missing') };
    });
    const balanceTransactions = checking ? transactions.filter(tx => tx.cleared || checked.has(tx.id)) : transactions;
    const ledger = round2(computeAccountBalances(data.accounts, balanceTransactions, { onlyPosted: true, asOf }).get(input.account) || 0);
    const selectedDelta = round2(rows.filter(r => r.included).reduce((s, r) => s + r.amount, 0));
    const pendingRecorded = round2(rows.filter(r => r.group === 'pending' && !r.afterDate && r.match && r.match.date <= asOf).reduce((s, r) => s + r.match.amount, 0));
    const pendingRows = rows.filter(r => r.group === 'pending' && !r.afterDate);
    const pendingTotal = round2(pendingRows.reduce((s, r) => s + r.amount, 0));
    const pendingUncertain = pendingRows.some(r => r.match && (!r.payeeMatch || r.days !== 0));
    const comparisonLedger = round2(ledger - pendingRecorded + (input.basis === 'available' ? pendingTotal : 0));
    // The statement already describes the pending reservation whether or not
    // the user chooses to record it. Count it once in available, never in booked.
    const comparisonDelta = round2(rows.filter(r => r.included && (r.group !== 'pending' || (r.match && r.match.date <= asOf))).reduce((s, r) => s + r.amount, 0));
    const target = input.target ?? (closingBalance === null ? null : round2(closingBalance + (input.basis === 'available' ? pendingTotal : 0)));
    const gap = Number.isFinite(target) ? round2(target - comparisonLedger) : null;
    const clearedPending = round2(pendingRows.filter(r => r.match?.cleared && r.match.date <= asOf).reduce((s, r) => s + r.match.amount, 0));
    const reconcileTarget = target === null ? null : round2(target - (input.basis === 'available' ? pendingTotal : 0) + clearedPending);
    const rawGap = Number.isFinite(target) ? round2(target - ledger) : null;
    const pendingExplainsGap = gap === 0 && rawGap !== null && rawGap !== 0;
    const candidates = rows.filter(r => !r.afterDate && !r.adjustmentDate && (r.group === 'missing' || r.group === 'review'));
    const suggestionGap = checking ? rawGap : gap;
    const suggestion = suggestionGap === null ? { status: 'noTarget', keys: [] } : checking && cents(suggestionGap - selectedDelta) === 0 ? { status: 'balanced', keys: [] } : !checking && (pendingUncertain || pendingExplainsGap) ? { status: 'pending', keys: [] } : explainGap(candidates, cents(suggestionGap));
    return ok({ context: statementReviewContext(data, input.account), rows, statement: { date: date || null, closingBalance },
      balance: { date: asOf, basis: input.basis, target: target ?? null, reconcileTarget, ledger, rawGap, gap, selectedDelta,
        projected: round2(ledger + selectedDelta), comparisonLedger, comparisonProjected: round2(comparisonLedger + comparisonDelta),
        ledgerRemaining: rawGap === null ? null : round2(rawGap - selectedDelta),
        remaining: gap === null ? null : round2(gap - comparisonDelta),
        pendingTotal, pendingUncertain, pendingRecorded, bookedEstimate: round2(ledger - pendingRecorded), pendingExplainsGap }, suggestion });
  },
};

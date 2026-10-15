// Rebuild the public example from fictional constants only. Never accepts an
// export or reads private data. Run: node scripts/generate-example-budget.mjs
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { registry } from '../js/core/index.js';
import { runCommand } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { applyCommitChecks } from '../js/session/commit-checks.js';
import { computeAccountBalances } from '../js/engine/balances.js';
import { computeHoldings } from '../js/engine/holdings.js';
import { runInvariantCheck } from '../js/engine/insights.js';
import { round2 } from '../js/utils.js';

export const EXAMPLE_DATE = '2026-10-08';
export const EXAMPLE_FILES = {
  accounts: 'accounts.json', envelopes: 'envelopes.json', budgetItems: 'budget-items.json',
  envelopeTemplates: 'envelope-templates.json', transactions: 'transactions.json', meta: 'budget-meta.json',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const everyMonth = () => Object.fromEntries(MONTHS.map(m => [m, true]));
const onMonths = (...months) => Object.fromEntries(MONTHS.map(m => [m, months.includes(m)]));
const envId = name => `env-${name}`;

export function buildExampleBudget() {
  let serial = 0;
  const newId = () => `demo-tx-${String(++serial).padStart(5, '0')}`;
  const ctx = date => makeCtx({ now: new Date(`${date}T12:00:00Z`), newId, country: 'FI' });
  const account = (id, name, type, initialBalance, extra = {}) => ({ id: `acct-${id}`, name, type, initialBalance, archived: false, ...extra });
  const definitions = [
    ['housing', 'Home & Mortgage', 'Essentials', 1500],
    ['utilities', 'Electricity & Water', 'Essentials', 220],
    ['internet', 'Internet & Mobile', 'Essentials', 0],
    ['groceries', 'Groceries', 'Essentials', 150],
    ['transport', 'Transport', 'Essentials', 150],
    ['insurance', 'Insurance', 'Annual bills', 800],
    ['health', 'Health & Dental', 'Essentials', 500],
    ['maintenance', 'Home & Car Repairs', 'Annual bills', 1400],
    ['dining', 'Dining Out', 'Lifestyle', 0],
    ['entertainment', 'Entertainment', 'Lifestyle', 80],
    ['fitness', 'Fitness', 'Lifestyle', 0],
    ['clothing', 'Clothing', 'Lifestyle', 200],
    ['gifts', 'Gifts', 'Annual bills', 400],
    ['vacation', 'Holiday Fund', 'Goals', 2200],
    ['emergency', 'Emergency Fund', 'Goals', 7000],
    ['investing', 'Investing', 'Goals', 12000],
  ];
  let data = {
    accounts: [
      account('checking', 'Current Account', 'bank', 10000, { favorite: true }),
      account('savings', 'Savings Account', 'savings', 20000, { favorite: true, interestTiers: [{ upTo: null, rate: 1.5 }], interestPayout: 'yearly' }),
      account('credit', 'Credit Card', 'credit_card', 0, { favorite: true, settledFrom: 'acct-checking' }),
      account('cash', 'Wallet', 'cash', 120),
      account('brokerage', 'Demo Investments', 'investment', 0, { trackInvestments: true, expectedGrowth: 4, notes: 'Fictional funds and prices for learning. These symbols are not traded securities.' }),
      account('home', 'Example Home', 'asset', 235000, { expectedGrowth: 1, notes: 'Invented home valuation, unrelated to any real property.' }),
      account('mortgage', 'Home Mortgage', 'loan', -169000, { interestRates: [{ from: '2025-09-01', rate: 3.2 }], loanStart: '2025-09-01' }),
    ],
    envelopes: definitions.map(([key, name, category]) => ({
      id: envId(key), name, category, archived: false,
      ...(key === 'emergency' ? { goal_amount: 15000, spend_flag_exempt: true } : {}),
      ...(key === 'vacation' ? { goal_amount: 3600 } : {}),
    })),
    budgetItems: [], envelopeTemplates: [], transactions: [],
    meta: {
      schemaVersion: 8, currency: 'EUR', country: 'FI', name: 'Example Budget (Fictional)',
      emergency_envelope_id: 'env-emergency', emergency_duration_months: 6,
      last_opened_month: '2026-10', last_rollover_month: '2026-09',
      investments: {
        prices: { 'DEMO-GLOBAL': { price: 54, asOf: EXAMPLE_DATE }, 'DEMO-BOND': { price: 25.5, asOf: EXAMPLE_DATE } },
        holdingOverrides: {}, payeeRules: {}, manualRows: {},
      },
    },
  };
  const item = (key, description, amount, envelope, extra = {}) => {
    const row = {
      id: `item-${key}`, kind: 'expense', description, default_amount: -amount,
      envelope_id: envId(envelope), account_id: 'acct-checking', include: true,
      include_in_emergency_budget: true, extra_buffer: 0,
      payment_day: 0, monthly_schedule: everyMonth(), as_schedule: false,
      stress_category: 'Z', stress_cut_pct: 0, stress_cut_pcts: {}, ...extra,
    };
    if (row.kind === 'expense' || row.kind === 'loan_payment') {
      row.funding_style ??= row.as_schedule ? 'bill' : 'spending';
    }
    data.budgetItems.push(row);
    return row;
  };
  const scheduled = { as_schedule: true, as_schedule_since: '2025-10-01', schedule_day_type: 'exact' };
  const flexible = (cut, category = 'E') => ({
    include_in_emergency_budget: false, stress_category: category, stress_cut_pct: cut,
    stress_cut_pcts: Object.fromEntries('ABCDE'.slice(0, 'ABCDE'.indexOf(category) + 1).split('').map((s, i, arr) => [s, round2(cut * (arr.length - i) / arr.length)])),
  });
  item('salary-main', 'Example employer: net salary', 2600, null, { ...scheduled, ...flexible(1, 'C'), kind: 'income', default_amount: 2600, envelope_id: null, payment_day: 1, include_in_emergency_budget: false });
  item('salary-partner', 'Example partner: net salary', 1400, null, { ...scheduled, ...flexible(1, 'A'), kind: 'income', default_amount: 1400, envelope_id: null, payment_day: 1, include_in_emergency_budget: false });
  item('mortgage', 'Mortgage payment', 940, 'housing', { ...scheduled, kind: 'loan_payment', payment_day: 5, to_account_id: 'acct-mortgage', loan_method: null, loan_fee: 2.5 });
  item('housing', 'Example housing company: maintenance charge', 320, 'housing', { ...scheduled, payment_day: 6 });
  item('utilities', 'Example Energy: electricity and water', 105, 'utilities', { ...scheduled, payment_day: 10, monthly_schedule: { ...everyMonth(), Jan: 165, Feb: 155, Mar: 135, Nov: 130, Dec: 155 } });
  item('internet', 'Example Connect: internet and two mobile plans', 69, 'internet', { ...scheduled, payment_day: 7 });
  item('groceries', 'Food and household supplies', 560, 'groceries', { ...flexible(0.15, 'B'), include_in_emergency_budget: true, monthly_schedule: { ...everyMonth(), Dec: 680 } });
  item('transport', 'Fuel and public transport', 145, 'transport', { ...flexible(0.25, 'B'), include_in_emergency_budget: true });
  item('insurance', 'Example Cover: home and car insurance', 390, 'insurance', { ...scheduled, payment_day: 15, monthly_schedule: onMonths('Mar', 'Sep') });
  item('vehicle-tax', 'Annual vehicle charge', 240, 'insurance', { ...scheduled, payment_day: 18, monthly_schedule: onMonths('May') });
  item('health', 'Prescriptions, appointments and dental care', 70, 'health');
  item('maintenance', 'Repairs and annual service reserve', 120, 'maintenance');
  item('dining', 'Meals out and cafes', 160, 'dining', flexible(1));
  item('entertainment', 'Tickets and leisure', 70, 'entertainment', flexible(1));
  item('streaming', 'Example Stream: household subscription', 18, 'entertainment', { ...scheduled, payment_day: 21, ...flexible(1) });
  item('fitness', 'Example Fitness: two memberships', 58, 'fitness', { ...scheduled, payment_day: 22, ...flexible(1) });
  item('clothing', 'Clothing and shoes', 75, 'clothing', flexible(0.75, 'D'));
  item('gifts', 'Birthdays and seasonal gifts', 60, 'gifts', { ...flexible(0.5), monthly_schedule: { ...everyMonth(), Dec: 300 } });
  item('vacation', 'Annual summer holiday', 2400, 'vacation', { ...flexible(1), funding_style: 'bill', payment_day: 12, monthly_schedule: onMonths('Jul') });
  item('investing', 'Monthly fictional fund purchase', 400, 'investing', { kind: 'investment_transfer', direction: 'buy', investment_account_id: 'acct-brokerage', symbol: 'DEMO-GLOBAL', ...flexible(1), payment_day: 25, ...scheduled });
  item('savings', 'Move cash to savings', 500, null, { ...scheduled, kind: 'account_transfer', envelope_id: null, to_account_id: 'acct-savings', payment_day: 27, include_in_emergency_budget: false });
  const funded = data.envelopes.filter(e => e.id !== 'env-emergency');
  data.envelopeTemplates = [
    { id: 'monthly-plan', name: 'Fund the monthly plan', kind: 'dynamic', description: 'Funds the monthly average of the plan, including annual bills and holiday savings.',
      assignments: funded.map(e => ({ envelope_id: e.id, mode: 'add', percent: 100 })),
      schedule: { enabled: true, payment_day: 2, day_type: 'exact', since: '2025-10-01', months: everyMonth() } },
    { id: 'safety-buffer', name: 'Build the emergency buffer', kind: 'manual', description: 'Assign part of the monthly surplus to the emergency fund.',
      lines: [{ envelope_id: 'env-emergency', mode: 'add', amount: 350 }],
      schedule: { enabled: true, payment_day: 2, day_type: 'exact', since: '2025-10-01', months: everyMonth() } },
    { id: 'extra-income', name: 'Give extra income a job', kind: 'manual', description: 'An optional allocation for a bonus or refund. Review the amounts before applying.',
      lines: [{ envelope_id: 'env-emergency', mode: 'add', amount: 250 }, { envelope_id: 'env-vacation', mode: 'add', amount: 150 }, { envelope_id: 'env-maintenance', mode: 'add', amount: 100 }] },
  ];
  const add = (date, row) => data.transactions.push({ id: newId(), date, status: 'posted', cleared: date < '2026-10-06', ...row });
  const expense = (date, envelope, amount, payee, extra = {}) => add(date, { type: 'expense', amount: round2(amount), account: 'acct-checking', envelope_id: envId(envelope), payee, ...extra });
  add('2025-09-30', { type: 'fill', source: 'allocation', payee: 'Opening allocations', note: 'Entirely fictional opening reserves.', lines: definitions.filter(d => d[3]).map(([key, , , amount]) => ({ envelope_id: envId(key), mode: 'add', amount })) });
  // Opening acquisitions give the portfolio a genuine cost history, with no
  // opaque holding overrides or imported snapshots.
  for (const [symbol, units, pricePerUnit] of [['DEMO-GLOBAL', 180, 50], ['DEMO-BOND', 120, 25]]) {
    add('2025-09-30', { type: 'investment_transfer', direction: 'buy', from_account: 'acct-savings', to_account: 'acct-brokerage', envelope_id: 'env-investing', amount: units * pricePerUnit, units, pricePerUnit, fee: 0, symbol, payee: 'Example Broker', note: 'Invented opening purchase, not a real security.' });
  }
  // Walk in date order, letting the real scheduler calculate the mortgage
  // split and allocation amounts. This keeps the example and forecasts aligned.
  for (let offset = 0; offset <= 12; offset++) {
    const year = 2025 + Math.floor((9 + offset) / 12);
    const month = (9 + offset) % 12 + 1;
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const lastDay = offset === 12 ? 8 : new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let day = 1; day <= lastDay; day++) {
      const date = `${key}-${String(day).padStart(2, '0')}`;
      const result = runCommand(registry, data, 'month.postDue', { date, cleared: date < '2026-10-06' }, ctx(date), { checks: applyCommitChecks });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      data = result.value.after;
      // Attach invented trade units to the scheduler's monthly cash purchase.
      data.transactions = data.transactions.map(t => t.from_budget === `item-investing:${key}` && !t.units
        ? { ...t, symbol: 'DEMO-GLOBAL', units: 8, pricePerUnit: 50, fee: 0, payee: 'Example Broker', note: 'Fictional monthly fund purchase.' } : t);
      if ([3, 10, 17, 24].includes(day)) expense(date, 'groceries', 112 + (offset * 13 + day * 7) % 37 + 0.45, day === 17 ? 'Example Neighbourhood Shop' : 'Example Food Market', { account: day === 10 ? 'acct-credit' : 'acct-checking' });
      if ([8, 19].includes(day)) expense(date, 'transport', 48 + (offset * 7 + day) % 24 + 0.6, 'Example Fuel & Transit');
      if ([6, 14, 23].includes(day)) expense(date, 'dining', 27 + (offset * 5 + day) % 25 + 0.8, day === 6 ? 'Example Corner Cafe' : 'Example Kitchen', { account: [6, 14].includes(day) ? 'acct-credit' : 'acct-checking' });
      if (day === 11) expense(date, 'health', 15 + offset % 4 * 7 + 0.9, 'Example Pharmacy');
      if (day === 16) expense(date, 'entertainment', 29 + offset % 3 * 12, 'Example Arts Centre');
      if (day === 20) expense(date, 'clothing', 42 + offset % 4 * 14 + 0.9, 'Example Clothing Shop');
      if (day === 26) expense(date, 'gifts', month === 12 ? 265 : 28 + offset % 4 * 10, 'Example Gift Shop');
      if (day === lastDay) {
        const positions = computeHoldings(data.transactions).get('acct-brokerage');
        const globalPrice = offset === 12 ? 54 : 50 + [0.5, 1, -0.5, -1, 0, 1.5, 2, 1, 2.5, 3, 2, 3.5][offset];
        const bondPrice = offset === 12 ? 25.5 : 25 + offset * 0.04;
        const value = [...positions].reduce((sum, [symbol, h]) => sum + h.units * (symbol === 'DEMO-GLOBAL' ? globalPrice : bondPrice), 0);
        const book = computeAccountBalances(data.accounts, data.transactions).get('acct-brokerage');
        add(date, { type: 'adjustment', target: 'account', target_id: 'acct-brokerage', amount: round2(value - book), payee: 'Fictional portfolio valuation', note: 'Invented market value for the example portfolio.' });
      }
      if (day === 28) {
        const card = computeAccountBalances(data.accounts, data.transactions).get('acct-credit');
        if (card < 0) add(date, { type: 'account_transfer', amount: round2(-card), from_account: 'acct-checking', to_account: 'acct-credit', payee: 'Credit card statement payment', note: 'Pays purchases already charged to their spending envelopes.' });
      }
      if (date === '2026-02-16') {
        expense(date, 'maintenance', 680, 'Example Repair Workshop', { note: 'Unexpected car repair, covered from the emergency reserve.' });
        add(date, { type: 'envelope_transfer', amount: 680, from_envelope_id: 'env-emergency', to_envelope_id: 'env-maintenance', payee: 'Cover the car repair' });
      }
      if (date === '2026-04-18') expense(date, 'health', 245, 'Example Dental Clinic', { note: 'Annual check and treatment.' });
      if (date === '2026-06-13') expense(date, 'maintenance', 420, 'Example Home Services', { note: 'Replace a broken dishwasher.' });
      if (date === '2026-07-12') expense(date, 'vacation', 2280, 'Example Holiday Booking', { note: 'Travel and accommodation for the annual holiday.' });
      if (date === '2026-08-18') expense(date, 'maintenance', 310, 'Example Repair Workshop', { note: 'Annual vehicle service.' });
      if (date === '2026-09-12') add(date, { type: 'expense', amount: 86.4, account: 'acct-checking', envelope_splits: [{ envelope_id: 'env-groceries', amount: 61.4 }, { envelope_id: 'env-gifts', amount: 25 }], payee: 'Example Food Market', note: 'A split purchase: food and a birthday gift.' });
      if (date === '2026-06-26') add(date, { type: 'investment_transfer', direction: 'dividend', amount: 36, from_account: 'acct-brokerage', to_account: 'acct-checking', envelope_id: 'env-investing', symbol: 'DEMO-BOND', payee: 'Example Bond Fund', note: 'Invented distribution.' });
      if (date === '2026-08-26') add(date, { type: 'investment_transfer', direction: 'sell', amount: 538, fee: 2, units: 10, pricePerUnit: 54, from_account: 'acct-brokerage', to_account: 'acct-checking', envelope_id: 'env-investing', symbol: 'DEMO-GLOBAL', payee: 'Example Broker', note: 'Small fictional sale to demonstrate realised gains.' });
    }
  }
  // Stable fictional timestamps independent of the machine generating the files.
  data.transactions = data.transactions.map(t => ({ ...t, created_at: `${t.date}T12:00:00.000Z`, modified_at: `${t.date}T12:00:00.000Z` }));
  const checked = applyCommitChecks({ transactions: [] }, data);
  if (!checked.ok) throw new Error(JSON.stringify(checked.error));
  data = checked.value;
  const report = runInvariantCheck(data);
  if (report.problems.length) throw new Error(JSON.stringify(report.problems));
  return data;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = buildExampleBudget();
  for (const [key, file] of Object.entries(EXAMPLE_FILES)) {
    writeFileSync(new URL(`../budgets/example-project/${file}`, import.meta.url), `${JSON.stringify(data[key], null, 2)}\n`);
  }
  writeFileSync(new URL('../budgets/example-project/scheduled.json', import.meta.url), '[]\n');
  console.log(`Generated fictional example: ${data.transactions.length} transactions.`);
}

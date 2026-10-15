// js/ai/tools/read.js — the tools that answer questions about the budget.
//
// Each reads state and returns plain JSON. None mutate: they copy before
// sorting and never write a field back onto a record. That matters more than
// it looks — the engine's balance functions are memoized on input identity
// (js/engine/balance-cache.js), so mutating an input array in place here would
// poison every later balance computation in the app.

import { registerTool } from './registry.js';
import { txAbsAmount } from '../../engine.js';
import { round2 } from '../../utils.js';
import { queryAnswer } from '../query.js';

/** Cap on rows handed to the model. Enough to reason over, bounded in cost. */
const MAX_ROWS = 60;

function envelopeName(state, id) {
  return (state.envelopes || []).find((e) => e.id === id)?.name || null;
}

function accountName(state, id) {
  return (state.accounts || []).find((a) => a.id === id)?.name || null;
}

function slimTx(state, tx) {
  const out = {
    id: tx.id,
    date: tx.date,
    payee: tx.payee || '',
    amount: round2(txAbsAmount(tx)),
    type: tx.type,
    envelope: envelopeName(state, tx.envelope_id),
    account: accountName(state, tx.account || tx.from_account),
  };
  if (tx.note) out.note = tx.note;
  return out;
}

registerTool({
  name: 'get_envelopes',
  kind: 'read',
  description: 'List the budget\'s envelopes with their current balances. Start here when the '
    + 'question is about where money is allocated.',
  input_schema: {
    type: 'object',
    properties: {
      include_archived: { type: 'boolean', description: 'Default false.' },
    },
  },
  run(state, input, clock) {
    // The Booked view of the `balances` query; `target` is on the envelope record, not in the answer.
    const answer = queryAnswer(state, 'balances', {
      lens: 'booked', includeArchived: !!input.include_archived,
    }, clock);
    const targets = new Map((state.envelopes || []).map((e) => [e.id, e.target]));
    return answer.envelopes.map((e) => ({
      id: e.id,
      name: e.name,
      category: e.category || null,
      balance: e.balance,
      target: targets.get(e.id) ?? null,
      archived: e.archived,
    }));
  },
});

registerTool({
  name: 'get_accounts',
  kind: 'read',
  description: 'List the budget\'s accounts with their current balances.',
  input_schema: {
    type: 'object',
    properties: {
      include_archived: { type: 'boolean', description: 'Default false.' },
    },
  },
  run(state, input, clock) {
    const answer = queryAnswer(state, 'balances', {
      lens: 'booked', includeArchived: !!input.include_archived,
    }, clock);
    return answer.accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type || null,
      balance: a.balance,
      archived: a.archived,
    }));
  },
});

/**
 * The state, with an envelope the budget does not have stood in as an archived
 * one. The tools answer an unknown envelope id with `envelope: null` and the
 * nothing-to-project figures, where the queries refuse a ref they cannot find.
 * It relies on two facts, so a change to either is a change to this shim:
 * `envelope.history` never reads the envelope list (the id only has to pass
 * the ref check), and the engine's forecast treats an archived envelope and an
 * unknown one alike (the same empty projection, engine/envelope-forecast.js).
 */
function withEnvelopeId(state, id) {
  const envelopes = state.envelopes || [];
  if (envelopes.some((e) => e && e.id === id)) return state;
  return { ...state, envelopes: [...envelopes, { id, archived: true }] };
}

/**
 * The envelope id a tool asks about. A missing, empty or non-string
 * `envelope_id` matches no envelope, and the old tools answered it as an
 * unknown one; this id, which no slug or generated id can be, keeps that.
 */
const NO_ENVELOPE_ID = '(no envelope id)';
const envelopeRef = (id) => (typeof id === 'string' && id ? id : NO_ENVELOPE_ID);

/** A whole number in lo..hi from a model's input, `fallback` when it gives none. */
const clampInt = (v, fallback, lo, hi) => Math.trunc(Math.min(Math.max(Number(v) || fallback, lo), hi));

/** The query input from a tool input: only the fields the model gave, under the query's names. */
function queryInput(pairs) {
  return Object.fromEntries(pairs.filter(([, v]) => v !== undefined && v !== null));
}

registerTool({
  name: 'get_runway',
  kind: 'read',
  description: 'How long the household\'s cash would last under stress scenarios, from the plan\'s coming '
    + '12 months. Returns `liquid` (the non-archived crisis-cash accounts through the lens), '
    + '`bufferFloor` (the reserve the plan\'s expense items keep, which does not extend the runway), '
    + '`usableCash` (liquid minus the floor, at least 0), and one row per scenario: Baseline is the '
    + 'plan as it stands, then A (the most severe) to E (the mildest). Each plan item has a stress '
    + 'category A-E and a cut per scenario; a scenario applies the cut of every income and expense '
    + 'item whose category it is at least as severe as (income lost, spending given up), so A cuts '
    + 'the most items. Each row has the plan\'s `income`, `expense` and `net` for the year after that '
    + 'scenario\'s cuts, `netNegative` (net below zero), `delta` (net minus Baseline\'s) with '
    + '`deltaSign` (-1, 0 or 1; 0 within half a cent), and `runway`: "unlimited" when the plan burns '
    + 'nothing, "none" when there is no usable cash, else "months" with `months` of usable cash at '
    + 'that burn (`months` is null otherwise). Money is in the budget currency. Uses the Booked view '
    + 'unless `lens` says otherwise; items that have ended count nothing.',
  input_schema: {
    type: 'object',
    properties: {
      lens: {
        type: 'string',
        enum: ['today', 'booked', 'forecast'],
        description: 'Which balances the cash comes from: today = cleared as of today; booked = '
          + 'everything entered (default); forecast = booked plus the rows the plan generates up to the horizon.',
      },
      horizon: {
        type: 'string',
        description: 'Only with lens forecast: eom, 3m, 6m, 12m or a date (yyyy-mm-dd). Default 3m.',
      },
    },
  },
  run(state, input, clock) {
    return queryAnswer(state, 'stress.runway', queryInput([
      ['lens', input.lens],
      ['horizon', input.horizon],
    ]), clock);
  },
});

registerTool({
  name: 'get_net_worth_history',
  kind: 'read',
  description: 'Net worth over time: one point per month-end for the months before today, then a '
    + 'point for today. Each point has `date`, `total` and its parts: `spending`, `savings`, '
    + '`investment`, `pension`, `assets`, `loansGiven`, `debts` and `other`. It covers the '
    + 'non-archived accounts and counts every ledger row dated on or before the point, any status, '
    + 'so it is the Booked view. Use it for "how has my net worth changed" questions. Money is in the '
    + 'budget currency.',
  input_schema: {
    type: 'object',
    properties: {
      months: { type: 'integer', minimum: 1, maximum: 60, description: 'How many month-ends before today (1-60). Default 24.' },
      exclude_accounts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Account ids to leave out of every figure.',
      },
    },
  },
  run(state, input, clock) {
    return queryAnswer(state, 'netWorth.history', queryInput([
      ['months', input.months],
      ['excludeAccounts', input.exclude_accounts],
    ]), clock);
  },
});

registerTool({
  name: 'get_net_worth_projection',
  kind: 'read',
  description: 'Net worth projected year by year from today. `base` is the expected line: the plan '
    + 'walked for 24 months, then each account compounding at its growth rate and adding its monthly '
    + 'contribution (a loan the plan repays follows its repayment schedule); `low` and `high` move '
    + 'every growth rate by minus and plus 2 points; `whatIf` is a saved what-if scenario\'s line, or '
    + 'null. Each line is one `{ year, total }` per year, `total` only (no parts): year 0 is today, '
    + 'year k is the month-end 12 x k months after this month\'s end (in October, year 1 is next '
    + 'October, not next December). `accounts` lists each non-archived account '
    + 'with its balance today, growth rate and where it comes from, monthly contribution and its '
    + 'source (plan, history or none), its figure at the horizon and a loan\'s payoff date. `table` '
    + 'sums the monthly contributions used against the plan and the last 12 months, and `gap` flags '
    + 'a plan adding far less than the last 12 months did. These are projections from stored '
    + 'settings, not predictions: say so when answering. Money is in the budget currency.',
  input_schema: {
    type: 'object',
    properties: {
      years: { type: 'integer', minimum: 1, maximum: 50, description: 'How many years to project (1-50).' },
      contribution: {
        type: 'string',
        enum: ['plan', 'history'],
        description: 'Where later years\' contributions come from: plan = the plan\'s last simulated year '
          + '(default); history = the average of the last 12 months.',
      },
      exclude_accounts: {
        type: 'array',
        items: { type: 'string' },
        description: 'Account ids to leave out of the lines and the table.',
      },
    },
    required: ['years'],
  },
  run(state, input, clock) {
    return queryAnswer(state, 'netWorth.projection', queryInput([
      ['years', input.years],
      ['contribution', input.contribution],
      ['excludeAccounts', input.exclude_accounts],
    ]), clock);
  },
});

registerTool({
  name: 'query_transactions',
  kind: 'read',
  description: 'Find transactions. Combine filters to narrow the result — prefer one targeted '
    + 'query over several broad ones. Returns at most 60 rows plus the count and total for the '
    + 'whole match. The total is magnitude, not spending or net cash movement.',
  input_schema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Substring of the payee or note, case-insensitive.' },
      envelope_id: { type: 'string' },
      account_id: { type: 'string' },
      type: { type: 'string', description: 'expense, income, account_transfer, fill, …' },
      date_from: { type: 'string', description: 'ISO yyyy-mm-dd, inclusive.' },
      date_to: { type: 'string', description: 'ISO yyyy-mm-dd, inclusive.' },
      min_amount: { type: 'number', description: 'Magnitude, not signed.' },
      max_amount: { type: 'number', description: 'Magnitude, not signed.' },
    },
  },
  run(state, input, clock) {
    const query = { searchMode: 'literal', limit: MAX_ROWS };
    for (const [from, to] of Object.entries({ search: 'search', envelope_id: 'envelope', account_id: 'account',
      type: 'type', date_from: 'dateFrom', date_to: 'dateTo', min_amount: 'minAmount', max_amount: 'maxAmount' })) {
      if (input[from] !== undefined && input[from] !== null && input[from] !== '') query[to] = input[from];
    }
    const answer = queryAnswer(state, 'transactions.search', query, clock);
    return {
      matched: answer.matched,
      total: answer.totalMagnitude,
      truncated: answer.hasMore,
      transactions: answer.rows.map(tx => slimTx(state, tx)),
    };
  },
});

registerTool({
  name: 'get_envelope_history',
  kind: 'read',
  description: 'Month-by-month money in and out of one envelope. Use when the question is about '
    + 'a trend or a typical month rather than a single current figure.',
  input_schema: {
    type: 'object',
    properties: {
      envelope_id: { type: 'string' },
      months: { type: 'integer', description: 'How many months back. Default 12, max 36.' },
    },
    required: ['envelope_id'],
  },
  run(state, input, clock) {
    const months = clampInt(input.months, 12, 1, 36);
    const envelope = envelopeRef(input.envelope_id);
    return {
      envelope: envelopeName(state, input.envelope_id),
      months: queryAnswer(withEnvelopeId(state, envelope), 'envelope.history', {
        envelope, months,
      }, clock),
    };
  },
});

registerTool({
  name: 'get_reports',
  kind: 'read',
  description: 'Aggregated spending. `by` selects the breakdown: envelope, payee, or '
    + 'income_vs_spending month by month. For envelope and payee, `rows` are the top `top` only: '
    + 'the rows past them are summed in `other: { count, value }` (null when none), so the '
    + 'total is the rows plus `other`.',
  input_schema: {
    type: 'object',
    properties: {
      by: { type: 'string', enum: ['envelope', 'payee', 'income_vs_spending'] },
      date_from: { type: 'string', description: 'ISO yyyy-mm-dd.' },
      date_to: { type: 'string', description: 'ISO yyyy-mm-dd.' },
      top: { type: 'integer', description: 'How many rows. Default 12.' },
    },
    required: ['by'],
  },
  run(state, input, clock) {
    const top = clampInt(input.top, 12, 1, 40);
    const range = queryInput([['from', input.date_from || undefined], ['to', input.date_to || undefined]]);

    if (input.by === 'income_vs_spending') {
      // The Reports page's cash flow: principal paid into a loan is saving.
      const cash = queryAnswer(state, 'reports.cashflow', range, clock);
      const series = (name, points) => ({ name, points: points.map((p) => ({ label: p.month, value: p.value })) });
      return {
        by: 'income_vs_spending',
        rows: {
          months: cash.months,
          series: [series('Income', cash.income), series('Spending', cash.spending), series('Saving', cash.saving)],
        },
      };
    }
    const by = input.by === 'payee' ? 'payee' : 'envelope';
    const { rows, other } = queryAnswer(state, 'reports.spending', { ...range, groupBy: by, topN: top }, clock);
    return { by, rows, other };
  },
});

registerTool({
  name: 'get_forecast',
  kind: 'read',
  description: 'Project one envelope\'s balance forward, including scheduled spending and fills. '
    + 'Use for "will X last until…" and "can I afford…" questions.',
  input_schema: {
    type: 'object',
    properties: {
      envelope_id: { type: 'string' },
      months: { type: 'integer', description: 'How far ahead. Default 3, max 24.' },
    },
    required: ['envelope_id'],
  },
  run(state, input, clock) {
    const months = clampInt(input.months, 3, 1, 24);
    const envelope = envelopeRef(input.envelope_id);
    // The Envelope health page's projection, from the tool's own clock.
    return queryAnswer(withEnvelopeId(state, envelope), 'envelope.forecast', {
      envelope, months,
    }, clock);
  },
});

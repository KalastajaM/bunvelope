import { ok, fail } from '../result.js';
import { trackedInvestmentAccounts } from '../portfolio.js';
import { investmentPerformance } from '../../engine/investment-performance.js';

export default {
  name: 'investments.performance',
  summary: 'Recorded securities performance for an inclusive date range: opening/closing market value, purchases, sale proceeds, distributions, gain and personal returnPct (Modified Dietz, a cash-flow-weighted period estimate, not annualized). Posted trades and dated manual corrections only; fees already included in cash amounts. Includes archived tracked accounts unless account is selected; excludes broker cash. Prices must be recorded in the budget currency on/before each boundary, at most maxPriceAgeDays old. Missing prices/units or undated holdings make aggregate valuations and returns null, with actionable issues. Never substitutes current prices or cost basis for history.',
  input: {
    type: 'object', required: ['from', 'to'],
    properties: {
      from: { type: 'date', description: 'First included trade date; opening units/value are at the previous day close' },
      to: { type: 'date', description: 'Last included trade date, no later than today' },
      account: { type: 'ref', kind: 'account', description: 'One tracked investment account; default all, including archived' },
      maxPriceAgeDays: { type: 'integer', minimum: 0, maximum: 31, default: 7, description: 'Maximum age of recorded boundary prices; 0 requires exact dates' },
    },
  },
  run(data, input, ctx) {
    if (input.from > input.to || input.to > ctx.todayIso) return fail('bad_input', { errors: [{ path: 'to', message: 'must be on/after from and no later than today' }] });
    const accounts = trackedInvestmentAccounts(data.accounts);
    if (input.account && !accounts.some(a => a.id === input.account)) return fail('bad_input', { errors: [{ path: 'account', message: 'must be a tracked investment account' }] });
    return ok(investmentPerformance(data, { ...input, accountIds: accounts.filter(a => !input.account || a.id === input.account).map(a => a.id) }));
  },
};

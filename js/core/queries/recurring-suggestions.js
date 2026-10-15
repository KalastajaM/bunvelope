import { ok } from '../result.js';
import { isoDate } from '../context.js';
import { refDate } from '../lens-input.js';
import { discoverRecurring, recurringPriceIncreases } from '../recurring-discovery.js';
export default {
  name: 'recurring.suggestions',
  summary: 'Possible monthly, quarterly and annual expenses from up to 36 months of posted manual payments, including variable bills with additional evidence and average estimates. Also returns priceIncreases from manual or scheduled actual payments. Includes evidence and reversible review decisions; never changes forecasts.',
  input: { type: 'object', properties: { date: { type: 'date' } } },
  run(data, input, ctx) { return ok({ suggestions: discoverRecurring(data, isoDate(refDate(input, ctx))), priceIncreases: recurringPriceIncreases(data, isoDate(refDate(input, ctx))) }); },
};

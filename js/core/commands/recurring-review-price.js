import { ok, fail } from '../result.js';
import { recurringPriceIncreases } from '../recurring-discovery.js';
export default {
  name: 'recurring.reviewPrice',
  summary: 'Dismiss or restore one observed payment increase. A later increase has a different key and is reviewed separately. Never changes the payment schedule.',
  input: { type: 'object', required: ['key', 'dismissed'], properties: { key: { type: 'string' }, dismissed: { type: 'boolean' } } },
  execute(data, input, ctx) {
    if (input.dismissed && !recurringPriceIncreases(data, ctx.todayIso).some(s => s.key === input.key)) return fail('not_found');
    const reviews = { ...data.meta?.recurringPriceReviews };
    if (input.dismissed) reviews[input.key] = true;
    else delete reviews[input.key];
    return ok({ changes: { meta: { ...data.meta, recurringPriceReviews: reviews } } });
  },
};

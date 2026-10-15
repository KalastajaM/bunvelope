import { ok } from '../result.js';
import { spendingProfiles, spendingAccount } from '../../engine/spending-profile.js';
import { refDate } from '../lens-input.js';

export default {
  name: 'spending.profile',
  summary: 'Expected payment-account percentages for an envelope: six calendar months of posted purchases weighted 1–6 by recency, or its manual override. Includes sample size and uncertainty.',
  input: { type: 'object', properties: {
    id: { type: 'ref', kind: 'envelope' }, date: { type: 'date' },
  } },
  run(data, input, ctx) {
    const profiles = spendingProfiles(data, refDate(input, ctx));
    const profile = profiles.byEnvelope.get(input.id) || profiles.fallback;
    const history = profile.source === 'override' ? spendingProfiles({ ...data,
      envelopes: data.envelopes.map(e => e.id === input.id ? { ...e, forecast_account_shares: null } : e) }, refDate(input, ctx)).byEnvelope.get(input.id) : profile;
    return ok({ ...profile, history,
      accounts: (data.accounts || []).filter(spendingAccount).map(a => ({ id: a.id, name: a.name || a.id })) });
  },
};

import { it, expect } from 'vitest';
import { subscriptionDraft } from '../js/core/subscription-draft.js';
const data = { envelopes: [{ id:'e' }] };
it('prefills a future yearly draft without inventing an account or writing data', () => {
  const before = structuredClone(data);
  const draft = subscriptionDraft({ payee:'Music', amount:120, frequency:'yearly', envelope_id:'e' }, data, '2026-12-31');
  expect(draft).toMatchObject({ description:'Music', default_amount:-120, account_id:null, envelope_id:'e', as_schedule:true, start_month:'2027-01', payment_day:1 });
  expect(Object.values(draft.monthly_schedule).filter(Boolean)).toHaveLength(1); expect(data).toEqual(before);
});
it('does not silently convert unsupported weekly cadence to monthly payments', () => {
  const draft = subscriptionDraft({ payee:'Music', amount:10, frequency:'weekly', envelope_id:'missing' }, data, '2026-10-07');
  expect(draft.as_schedule).toBe(false); expect(draft.envelope_id).toBe(null); expect(Object.values(draft.monthly_schedule).some(Boolean)).toBe(false);
});
it('requires correction of invalid model amounts', () => {
  expect(subscriptionDraft({ amount:'nonsense' }, data, '2026-10-07').default_amount).toBe(0);
});

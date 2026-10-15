// A budget that exercises every figure an envelope card, the Envelopes page
// and the health sheet show, for the jsdom page tests. Seeds the shared fake
// state (tests/_fakes/pageApp.js) at its fixed now, 15 Sep 2026.
//
// Accounts chk 1000, sav 500. Envelopes, in array order:
//   food    (living)    fill +300 on 1 Sep, 120 spent on 10 Sep; plan Groceries
//                       300/mo and Snacks 60/mo (two funded items: the card's
//                       "x of 2 items" line); both in the emergency essentials
//                       a 360 template fill on the 1st: short until 1 Oct
//   fun     (living)    fill +40; a scheduled 50 expense on 2 Oct (the
//                       "upcoming" hint outside Today; Booked reads -10,
//                       covered by the 20 template fill on 1 Oct)
//   rent    (housing)   fill +500; Rent 1000/mo scheduled from chk on the 20th,
//                       a 900 template fill on the 1st: short
//   trip    (leisure)   fill +300; goal 1200 by 1 Jun 2027 from 1 Jan 2026
//   car     (transport) fill +150; goal 100, no date (reached)
//   house   (saving)    fill +200; goal 5000, no date
//   savings (saving)    fill +1000; funds "Trip top-up", a set-mode template
//                       landing trip on 500 on the 1st (the funds line; its
//                       spare depends on trip being projected with it)
//   emerg   (saving)    fill +400; the emergency envelope (6 months, every
//                       envelope credited)
//   gone    (living)    archived, fill +20
// A scheduled 100 Bonus into chk on 25 Sep (no envelope) moves Unallocated
// between the lenses.
import { state, resetState } from './pageApp.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const every = () => Object.fromEntries(MONTHS.map(m => [m, true]));

export function seedEnvelopesBudget() {
  resetState({
    transactions: [
      { id: 'f1', type: 'fill', date: '2026-09-01', status: 'posted', source: 'allocation',
        lines: [
          { envelope_id: 'food', mode: 'add', amount: 300 }, { envelope_id: 'fun', mode: 'add', amount: 40 },
          { envelope_id: 'rent', mode: 'add', amount: 500 }, { envelope_id: 'trip', mode: 'add', amount: 300 },
          { envelope_id: 'car', mode: 'add', amount: 150 }, { envelope_id: 'house', mode: 'add', amount: 200 },
          { envelope_id: 'savings', mode: 'add', amount: 1000 }, { envelope_id: 'emerg', mode: 'add', amount: 400 },
          { envelope_id: 'gone', mode: 'add', amount: 20 },
        ] },
      { id: 'g1', type: 'expense', date: '2026-09-10', payee: 'Market', amount: 120, account: 'chk', envelope_id: 'food', status: 'posted' },
      { id: 'bonus', type: 'income', date: '2026-09-25', payee: 'Bonus', amount: 100, account: 'chk', envelope_id: null, status: 'scheduled' },
      { id: 'later', type: 'expense', date: '2026-10-02', payee: 'Later', amount: 50, account: 'chk', envelope_id: 'fun', status: 'scheduled' },
    ],
  });
  state.envelopes = [
    { id: 'food', name: 'Food', category: 'living' },
    { id: 'fun', name: 'Fun', category: 'living', code: 'FN' },
    { id: 'rent', name: 'Rent', category: 'housing' },
    { id: 'trip', name: 'Trip', category: 'leisure', goal_amount: 1200, goal_date: '2027-06-01', goal_start: '2026-01-01' },
    { id: 'car', name: 'Car', category: 'transport', goal_amount: 100 },
    { id: 'house', name: 'House', category: 'saving', goal_amount: 5000 },
    { id: 'savings', name: 'Savings pot', category: 'saving' },
    { id: 'emerg', name: 'Emergency', category: 'saving' },
    { id: 'gone', name: 'Gone', category: 'living', archived: true },
  ];
  state.budgetItems = [
    { id: 'gi', kind: 'expense', envelope_id: 'food', description: 'Groceries', default_amount: -300, extra_buffer: 0, include: true,
      monthly_schedule: every(), as_schedule: false, include_in_emergency_budget: true },
    { id: 'si', kind: 'expense', envelope_id: 'food', description: 'Snacks', default_amount: -60, extra_buffer: 10, include: true,
      monthly_schedule: every(), as_schedule: false, include_in_emergency_budget: true },
    { id: 'ri', kind: 'expense', envelope_id: 'rent', description: 'Rent', default_amount: -1000, extra_buffer: 0, include: true,
      monthly_schedule: every(), as_schedule: true, account_id: 'chk', payment_day: 20, schedule_day_type: 'exact',
      as_schedule_since: '2026-01-01' },
    { id: 'sal', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 3000, extra_buffer: 0, include: true,
      monthly_schedule: every(), as_schedule: true, account_id: 'chk', payment_day: 20, schedule_day_type: 'exact',
      as_schedule_since: '2026-01-01' },
  ];
  state.envelopeTemplates = [
    { id: 'tm', name: 'Monthly fill', kind: 'manual',
      lines: [{ envelope_id: 'food', mode: 'add', amount: 360 }, { envelope_id: 'fun', mode: 'add', amount: 20 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: every() } },
    { id: 'tr', name: 'Rent fill', kind: 'manual', lines: [{ envelope_id: 'rent', mode: 'add', amount: 900 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: every() } },
    { id: 'tt', name: 'Trip top-up', kind: 'manual', lines: [{ envelope_id: 'trip', mode: 'set', amount: 500 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: every(), source_envelope_id: 'savings' } },
  ];
  state.meta = { emergency_envelope_id: 'emerg', emergency_duration_months: 6, emergency_credit_source: 'all' };
}

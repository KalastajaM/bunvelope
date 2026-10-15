// @vitest-environment jsdom
// The Accounts page takes its current (Today lens) and budget (active lens)
// figures from the `accounts.detail` query. Refactor: the page header totals and each
// group's total must equal the old composition, the engine's balances over the
// lens rows, on the same fixture at the same fixed clock. Archived accounts are
// in the answer, so showing them still works.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/data.js', async (importOriginal) => ({
  ...(await importOriginal()),
  saveAccounts: vi.fn(async () => {}),
}));

import { render } from '../js/pages/accounts.js';
import { computeAccountBalances, lensTransactions } from '../js/engine.js';
import { fmt } from '../js/utils.js';
import { t } from '../js/ui/i18n.js';
import { session, state, prefs, resetState, mountHosts, FIXED_NOW } from './_fakes/pageApp.js';

const root = () => document.getElementById('app-root');
const subtitle = () => root().querySelector('.page-head-sub').textContent;
const groupTotals = () => [...root().querySelectorAll('[data-group-type] h3')]
  .map(h => h.parentElement.nextElementSibling.textContent.split(' · ')[1]);

const FIXTURE = [
  { id: 'i1', type: 'income', date: '2026-09-01', payee: 'Job', amount: 900.07, envelope_id: 'food', account: 'chk', status: 'posted' },
  { id: 'e1', type: 'expense', date: '2026-09-05', payee: 'Shop', amount: 40.45, envelope_id: 'food', account: 'chk', status: 'posted' },
  { id: 'e2', type: 'expense', date: '2026-09-20', payee: 'Soon', amount: 30.05, envelope_id: 'food', account: 'chk', status: 'scheduled' },
  { id: 'e3', type: 'expense', date: '2026-09-25', payee: 'Ahead', amount: 7.01, envelope_id: 'food', account: 'sav', status: 'posted' },
  { id: 't1', type: 'account_transfer', date: '2026-09-18', amount: 50, account: 'chk', to_account: 'old', status: 'posted' },
];

/** The old composition: engine balances over the lens rows. */
function oldBalances(lens, horizon) {
  const txs = lensTransactions(state, { lens, horizon, today: FIXED_NOW });
  return computeAccountBalances(state.accounts, txs);
}
const sum = (m, ids) => ids.reduce((s, id) => s + m.get(id), 0);

async function open() {
  mountHosts();
  await render(root());
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  resetState({ transactions: structuredClone(FIXTURE) });
  state.accounts = [
    { id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000.1 },
    { id: 'sav', name: 'Savings', type: 'savings', initialBalance: 500 },
    { id: 'old', name: 'Old', type: 'bank', initialBalance: 25, archived: true },
  ];
});

describe('Accounts page over the balances query', () => {
  for (const [name, patch, horizon] of [
    ['booked', { lens: 'booked' }, undefined],
    ['today', { lens: 'today' }, undefined],
    ['forecast', { lens: 'forecast', lensHorizon: '3m' }, '3m'],
  ]) {
    it(`${name} lens: header totals equal the old composition`, async () => {
      Object.assign(prefs, patch);
      await open();
      const cur = oldBalances('today');
      const bud = oldBalances(patch.lens, horizon);
      const ids = ['chk', 'sav'];
      const totalCur = fmt(sum(cur, ids));
      const totalBud = fmt(sum(bud, ids));
      expect(subtitle()).toBe(
        totalCur === totalBud
          ? t('accounts.countSubToday')(2, totalCur)
          : t('accounts.countSub')(2, totalBud, totalCur),
      );
      // One group per type, each carrying that group's budget total.
      expect(groupTotals()).toEqual([fmt(bud.get('chk')), fmt(bud.get('sav'))]);
    });
  }

  it('is not vacuous: the booked and today totals differ on this fixture', async () => {
    expect(fmt(sum(oldBalances('booked'), ['chk', 'sav']))).not.toBe(fmt(sum(oldBalances('today'), ['chk', 'sav'])));
  });

  it('with archived accounts shown, their balances come from the query too', async () => {
    state.meta = { show_archived_accounts: true };
    await open();
    const bud = oldBalances('booked');
    const cur = oldBalances('today');
    const ids = ['chk', 'sav', 'old'];
    expect(subtitle()).toBe(t('accounts.countSub')(2, fmt(sum(bud, ids)), fmt(sum(cur, ids))));
    // The archived account's card shows its budget balance (25 + the transfer in).
    const oldCard = root().querySelector('[data-acc-id="old"]');
    expect(oldCard.textContent.replace(/\s/g, '')).toContain(fmt(bud.get('old')).replace(/\s/g, ''));
  });

  it('the query answer is what the page reads (same figures through the session)', () => {
    const r = session.query('accounts.detail', { lens: 'booked' });
    expect(r.ok).toBe(true);
    const bud = oldBalances('booked');
    const cur = oldBalances('today');
    for (const a of r.value.accounts) {
      expect(a.budgetBalance).toBe(bud.get(a.id));
      expect(a.currentBalance).toBe(cur.get(a.id));
    }
  });

  it('a failed accounts.detail falls back to the opening balances and still renders every card', async () => {
    const real = session.query.bind(session);
    const spy = vi.spyOn(session, 'query').mockImplementation((name, input) => (
      name === 'accounts.detail' ? { ok: false, error: { code: 'bad_input', params: {} } } : real(name, input)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await open();
      expect(subtitle()).toBe(t('accounts.countSubToday')(2, fmt(1500.1)));
      expect(groupTotals()).toEqual([fmt(1000.1), fmt(500)]);
      expect(root().querySelectorAll('[data-acc-id]')).toHaveLength(2);
    } finally { spy.mockRestore(); warn.mockRestore(); }
  });
});

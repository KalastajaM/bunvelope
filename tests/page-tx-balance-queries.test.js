// @vitest-environment jsdom
// The balances the transaction sheets show read the `balances` query (and,
// for add-tx's over-allocation check, `session.queryAfter`), not the lens
// rows: the account and envelope picker labels of add-tx and edit-tx follow
// the active lens, add-tx's "Unallocated (x)" option too, and the
// account-type move's labels are the booked balances. Every figure is pinned
// against the pages' old composition (the engine calls they made, copied
// below), so the switch changes nothing on screen.
//
// The page stub's viewTxs ignores the lens; here it is the real lens over the
// fake state (as js/app.js resolves it), so the old composition is measured
// on what the app would show, under each lens.
//
// Ledger (resetState's chk 1000 and sav 500, plus an archived "Old" account
// opening at 200; envelopes food / fun / rent and an archived "Gone"):
//   2 Aug   fill   food +300, gone +50
//   2 Oct   expense 1000 Later on chk, no envelope, scheduled (future-dated)
//   plan: Salary 3000/mo into chk on the 20th, no envelope; Groceries 25/mo
//         from chk on the 20th, on food (the forecast lens adds both)
//
// Worked out (unallocated = identity accounts - envelopes):
//   today     chk 1000           -> 1700 - 350 = 1350
//   booked    chk 0              -> 700 - 350  = 350
//   forecast (eom) chk 1000 + 3000 - 25 = 3975, food 275 -> 4675 - 325 = 4350
//              (the 2 Oct row is past the horizon)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => {
  const fake = await import('./_fakes/pageApp.js');
  const { lensTransactions } = await import('../js/engine/lens.js');
  return {
    ...fake.appStub,
    viewTxs: vi.fn(() => {
      const { lens, horizon } = fake.appStub.activeLensInput();
      return lensTransactions(fake.state, { lens, horizon, today: fake.FIXED_NOW });
    }),
  };
});

import { viewTxs } from '../js/app.js';
import { openAddTx } from '../js/pages/add-tx.js';
import { openEditTx } from '../js/pages/edit-tx.js';
import { askIdentityMove } from '../js/pages/account-type-move.js';
import { computeAccountBalances, computeEnvelopeBalances, computeUnallocated, lensTransactions } from '../js/engine.js';
import { t, trEnv } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import {
  state, prefs, session, writeBatch, resetState, mountHosts, flush, setValue, FIXED_NOW, topOverlay, dialogOk,
} from './_fakes/pageApp.js';

const every = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };

function seed() {
  resetState({
    transactions: [
      { id: 'f1', type: 'fill', date: '2026-08-02', status: 'posted', source: 'allocation',
        lines: [{ envelope_id: 'food', mode: 'add', amount: 300 }, { envelope_id: 'gone', mode: 'add', amount: 50 }] },
      { id: 'later', type: 'expense', date: '2026-10-02', payee: 'Later', amount: 1000, account: 'chk', envelope_id: null, status: 'scheduled' },
    ],
  });
  state.accounts = [...state.accounts, { id: 'old', name: 'Old', type: 'bank', initialBalance: 200, archived: true }];
  state.envelopes = [...state.envelopes, { id: 'gone', name: 'Gone', category: 'living', archived: true }];
  state.budgetItems = [
    { id: 'sal', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 3000, extra_buffer: 0, include: true, monthly_schedule: every,
      as_schedule: true, account_id: 'chk', payment_day: 20, schedule_day_type: 'exact', as_schedule_since: '2026-01-01' },
    { id: 'groc', kind: 'expense', envelope_id: 'food', description: 'Groceries', default_amount: -25, extra_buffer: 0, include: true, monthly_schedule: every,
      as_schedule: true, account_id: 'chk', payment_day: 20, schedule_day_type: 'exact', as_schedule_since: '2026-01-01' },
  ];
  // The pickers offer archived accounts and envelopes only with these on.
  state.meta = { show_archived_accounts: true, show_archived_envelopes: true };
}

const LENSES = [
  { name: 'today', set: { lens: 'today' }, unallocated: 1350 },
  { name: 'booked', set: { lens: 'booked' }, unallocated: 350 },
  { name: 'forecast (eom)', set: { lens: 'forecast', lensHorizon: 'eom' }, unallocated: 4350 },
];

// The pages' old composition, verbatim: balances over the active lens rows.
function oldLabels() {
  const lensTxs = lensTransactions(state, { lens: prefs.lens, horizon: prefs.lensHorizon, today: FIXED_NOW });
  const acctBalMap = computeAccountBalances(state.accounts, lensTxs);
  const envBalMap = computeEnvelopeBalances(lensTxs);
  const archivedSuffix = (item) => item && item.archived ? ' · ' + t('addTx.archivedSuffix') : '';
  return {
    acctLabel: (a) => `${a.name} — ${fmt(acctBalMap.get(a.id) ?? 0)}${archivedSuffix(a)}`,
    envLabel: (e) => `${trEnv(e)} — ${fmt(envBalMap.get(e.id) ?? 0)}${archivedSuffix(e)}`,
    unallocated: computeUnallocated(acctBalMap, envBalMap, state.accounts),
  };
}

const form = () => document.querySelector('#sheet-host form');
const fieldSelect = (labelText) => {
  const wrap = [...form().querySelectorAll('.field')].find(f => f.querySelector(':scope > label')?.textContent === labelText);
  return wrap?.querySelector('select');
};
const options = (sel) => [...sel.querySelectorAll('option')].filter(o => o.value && o.value !== '__none__');
const byId = (list, id) => list.find(x => x.id === id);

// Every account option's label as the old code wrote it; returns the ids seen.
function expectAccountLabels(sel, acctLabel) {
  const opts = options(sel);
  expect(opts.length).toBeGreaterThan(0);
  for (const o of opts) expect(o.textContent).toBe(acctLabel(byId(state.accounts, o.value)));
  return opts.map(o => o.value);
}
function expectEnvelopeLabels(sel, envLabel) {
  const opts = options(sel).filter(o => o.value !== '__unallocated__');
  expect(opts.length).toBeGreaterThan(0);
  for (const o of opts) expect(o.textContent).toBe(envLabel(byId(state.envelopes, o.value)));
  return opts.map(o => o.value);
}

beforeEach(() => {
  seed();
  mountHosts();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  viewTxs.mockClear();
});

describe('add-tx picker labels', () => {
  for (const lens of LENSES) {
    it(`show the ${lens.name} balances, archived ones included, from the query`, () => {
      Object.assign(prefs, lens.set);
      const old = oldLabels();
      expect(old.unallocated).toBe(lens.unallocated);
      openAddTx();
      const accounts = expectAccountLabels(fieldSelect(t('editTx.fromAccount')), old.acctLabel);
      expect(accounts).toContain('old');
      const envelopes = expectEnvelopeLabels(form().querySelector('.split-env'), old.envLabel);
      expect(envelopes).toEqual(expect.arrayContaining(['food', 'gone']));
      const fromEnv = fieldSelect(t('addTx.fromEnvelope'));
      expectEnvelopeLabels(fromEnv, old.envLabel);
      const unalloc = [...fromEnv.options].find(o => o.value === '__unallocated__');
      expect(unalloc.textContent).toBe(`— ${t('addTx.unallocated')} (${fmt(lens.unallocated)}) —`);
      expect(viewTxs).not.toHaveBeenCalled();
    });
  }
});

describe('add-tx over-allocation warning, under the active lens', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // An expense from chk with no envelope lowers unallocated by its amount.
  async function saveExpense(amount) {
    openAddTx();
    setValue(form().querySelector('input[name="amount"]'), String(amount));
    setValue(form().querySelector('input[name="date"]'), '2026-09-10');
    const [, save] = [...document.querySelectorAll('.sheet-header .sheet-footer-actions-end button')];
    save.click();
    await flush();
  }
  const warning = () => {
    const top = topOverlay();
    return top && top.textContent.includes(t('addTx.unallocatedWarnTitle')) ? top.textContent : null;
  };

  it('booked: 350 unallocated, a 400 expense crosses zero and warns of the 50 over', async () => {
    Object.assign(prefs, { lens: 'booked' });
    await saveExpense(400);
    expect(warning()).toContain(t('addTx.unallocatedWarn')(fmt(50)));
    expect(writeBatch).not.toHaveBeenCalled();
    dialogOk().click();
    await flush();
    expect(state.transactions.at(-1)).toMatchObject({ type: 'expense', amount: 400, envelope_id: null });
    expect(viewTxs).not.toHaveBeenCalled();
  });

  it('today: 1350 unallocated, the same 400 expense does not warn', async () => {
    Object.assign(prefs, { lens: 'today' });
    await saveExpense(400);
    expect(warning()).toBeNull();
    expect(state.transactions.at(-1)).toMatchObject({ amount: 400 });
  });

  it('forecast: 4350 unallocated, the same 400 expense does not warn', async () => {
    Object.assign(prefs, { lens: 'forecast', lensHorizon: 'eom' });
    await saveExpense(400);
    expect(warning()).toBeNull();
    expect(state.transactions.at(-1)).toMatchObject({ amount: 400 });
  });

  it('forecast: a 4400 expense crosses zero and warns of the 50 over', async () => {
    Object.assign(prefs, { lens: 'forecast', lensHorizon: 'eom' });
    await saveExpense(4400);
    expect(warning()).toContain(t('addTx.unallocatedWarn')(fmt(50)));
    expect(writeBatch).not.toHaveBeenCalled();
    expect(viewTxs).not.toHaveBeenCalled();
  });

  it('forecast: the hand-recorded Groceries payment nets against the plan\'s forecast row, so the "after" is not double-counted', async () => {
    Object.assign(prefs, { lens: 'forecast', lensHorizon: 'eom' });
    const lens = { lens: 'forecast', horizon: 'eom' };
    const step = (envelope) => ({ name: 'transaction.record', input: { type: 'expense', amount: 25, date: '2026-09-10', account: 'chk', payee: 'Shop', envelope } });
    const before = session.query('balances', lens).value.unallocated;
    expect(before).toBe(4350);
    // On food it replaces the forecast Groceries row: nothing moves. Without
    // an envelope nothing is netted and the 25 comes off unallocated.
    expect((await session.queryAfter([step('food')], 'balances', lens)).value.unallocated).toBe(4350);
    expect((await session.queryAfter([step(null)], 'balances', lens)).value.unallocated).toBe(4325);
    expect(viewTxs).not.toHaveBeenCalled();
  });

  // A failed side of the comparison skips the warning; the save goes on.
  async function saveWithBrokenSide(break_) {
    Object.assign(prefs, { lens: 'booked' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    openAddTx();
    setValue(form().querySelector('input[name="amount"]'), '400');
    setValue(form().querySelector('input[name="date"]'), '2026-09-10');
    break_();
    const [, save] = [...document.querySelectorAll('.sheet-header .sheet-footer-actions-end button')];
    save.click();
    await flush();
  }

  it('a failed "before" query skips the warning and still saves', async () => {
    await saveWithBrokenSide(() => {
      const real = session.query.bind(session);
      vi.spyOn(session, 'query').mockImplementation((n, i) => (n === 'balances' ? { ok: false, error: { code: 'bad_input', params: {} } } : real(n, i)));
    });
    expect(warning()).toBeNull();
    expect(state.transactions.at(-1)).toMatchObject({ type: 'expense', amount: 400 });
  });

  it('an "after" answer without the figure skips the warning and still saves', async () => {
    await saveWithBrokenSide(() => {
      vi.spyOn(session, 'queryAfter').mockResolvedValue({ ok: true, value: {} });
    });
    expect(warning()).toBeNull();
    expect(state.transactions.at(-1)).toMatchObject({ type: 'expense', amount: 400 });
  });

  it('does not warn again when unallocated is already below zero', async () => {
    Object.assign(prefs, { lens: 'booked' });
    state.transactions = [...state.transactions,
      { id: 'big', type: 'expense', date: '2026-09-01', payee: 'Big', amount: 400, account: 'chk', envelope_id: null, status: 'posted' }];
    await saveExpense(10);
    expect(warning()).toBeNull();
    expect(state.transactions.at(-1)).toMatchObject({ amount: 10 });
  });
});

describe('edit-tx picker labels', () => {
  const expense = () => ({
    id: 'e1', type: 'expense', date: '2026-09-03', payee: 'Shop', amount: 20,
    envelope_id: 'food', account: 'chk', status: 'posted',
  });

  for (const lens of LENSES) {
    it(`show the ${lens.name} balances, archived ones included, from the query`, () => {
      const tx = expense();
      state.transactions = [...state.transactions, tx];
      Object.assign(prefs, lens.set);
      const old = oldLabels();
      openEditTx(tx);
      const accounts = expectAccountLabels(fieldSelect(t('editTx.fromAccount')), old.acctLabel);
      expect(accounts).toContain('old');
      const envelopes = expectEnvelopeLabels(form().querySelector('.split-env'), old.envLabel);
      expect(envelopes).toEqual(expect.arrayContaining(['food', 'gone']));
      expect(viewTxs).not.toHaveBeenCalled();
    });
  }

  it('labels an envelope transfer\'s pickers the same way', () => {
    const tx = { id: 'et', type: 'envelope_transfer', date: '2026-09-04', amount: 10, from_envelope_id: 'food', to_envelope_id: 'fun', status: 'posted' };
    state.transactions = [...state.transactions, tx];
    Object.assign(prefs, { lens: 'forecast', lensHorizon: 'eom' });
    const old = oldLabels();
    openEditTx(tx);
    expectEnvelopeLabels(fieldSelect(t('addTx.fromEnvelope')), old.envLabel);
  });
});

describe('account-type move labels', () => {
  it('show the booked envelope balances whatever the active lens, archived envelopes left out', async () => {
    Object.assign(prefs, { lens: 'forecast', lensHorizon: 'eom' });
    // The old composition, verbatim: raw rows are the booked lens.
    const envBal = computeEnvelopeBalances(state.transactions || []);
    const query = vi.spyOn(session, 'query');
    const pending = askIdentityMove({ balance: 100, leaving: true }, 'Checking');
    await flush();
    const sel = document.querySelector('#sheet-host select');
    const opts = [...sel.options];
    expect(opts[0].textContent).toBe(t('accountEdit.moveUnallocated'));
    const rest = opts.slice(1);
    expect(rest.map(o => o.value)).toEqual(['food', 'fun', 'rent']);
    for (const o of rest) {
      const e = byId(state.envelopes, o.value);
      expect(o.textContent).toBe(`${e.name} — ${fmt(envBal.get(e.id) ?? 0)}`);
    }
    // Food is 300 booked; the forecast lens would have shown 275.
    expect(rest[0].textContent).toBe(`Food — ${fmt(300)}`);
    expect(query).toHaveBeenCalledWith('balances', { lens: 'booked' });
    query.mockRestore();
    document.querySelector('#sheet-host .btn-ghost').click();
    expect(await pending).toBeNull();
  });
});

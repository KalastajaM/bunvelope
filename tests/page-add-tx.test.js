// @vitest-environment jsdom
// Add transaction sheet: what the form writes for each transaction type.
// Drives the real js/pages/add-tx.js DOM. The page dispatches through the
// session (the real browser session over the fake state in _fakes/pageApp.js),
// so the tests assert on state.transactions once the dispatch has settled and
// on writeBatch, the storage boundary, not on markup.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// jsdom does not implement scrolling used by focused validation comboboxes.
Element.prototype.scrollIntoView = () => {};

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
// A meta write outside the session goes through the meta queue; the fake queue
// applies the patch to the fake state without touching storage.
vi.mock('../js/state/meta-writes.js', async () => ({
  ...(await vi.importActual('../js/state/meta-writes.js')),
  updateMeta: (await import('./_fakes/pageApp.js')).updateMetaFake,
}));

import { openAddTx } from '../js/pages/add-tx.js';
import { t, fmtDateLang } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import {
  state, writeBatch, navigate, resetState, mountHosts, flush, setValue, sheetIsOpen,
  session, FIXED_NOW, dialogOk, topOverlay, toastTexts, appStub,
} from './_fakes/pageApp.js';

// The dry run before the commit also draws an id, so ids are only checked to
// be present. What the session stamps on a row it creates: the injected clock, not wall time.
const AT = FIXED_NOW.toISOString();

const form = () => document.querySelector('#sheet-host form');
const input = (name) => form().querySelector(`input[name="${name}"]`);
const footerButtons = () => [...document.querySelectorAll('.sheet-header .sheet-footer-actions-end button')];
const saveNewBtn = () => footerButtons()[0];
const saveBtn = () => footerButtons()[1];
const typeBtn = (v) => form().querySelector(`.tx-type-btn[data-value="${v}"]`);
const fieldSelect = (labelText) => {
  const wrap = [...form().querySelectorAll('.field')].find(f => f.querySelector(':scope > label')?.textContent === labelText);
  return wrap?.querySelector('select');
};

async function click(button) {
  button.click();
  await flush();
}
const written = () => state.transactions;
const added = () => written().at(-1);
// The transactions file of the last storage write.
const lastWrite = () => writeBatch.mock.calls.at(-1)[1].find(i => i.filename === 'transactions.json').data;

beforeEach(() => {
  resetState();
  mountHosts();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  openAddTx();
});

describe('the date field', () => {
  // Run under `npm run test:tz`: just after local midnight east of UTC, and
  // just before it west of UTC, the UTC date is another day.
  for (const [label, at] of [['00:30', new Date(2026, 8, 16, 0, 30)], ['23:30', new Date(2026, 8, 16, 23, 30)]]) {
    it(`defaults to the app clock's local day at ${label}, not the UTC day`, () => {
      const spy = vi.spyOn(appStub, 'now').mockImplementation(() => new Date(at));
      try {
        mountHosts();
        openAddTx();
        expect(input('date').value).toBe('2026-09-16');
      } finally {
        spy.mockRestore();
      }
    });
  }
});

describe('add expense', () => {
  it('keeps Add available and explains an invalid amount after submitting', async () => {
    expect(saveBtn().disabled).toBe(false);
    saveBtn().click();
    expect(form().querySelector('.has-error')).not.toBeNull();
    expect(writeBatch).not.toHaveBeenCalled();
    await flush();
    setValue(input('amount'), '12.50');
    expect(saveBtn().disabled).toBe(false);
    await flush();
    setValue(input('amount'), '0');
    expect(saveBtn().disabled).toBe(false);
    saveBtn().click();
    expect(form().querySelector('.has-error')).not.toBeNull();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('writes a single-envelope expense with a positive magnitude and closes the sheet', async () => {
    setValue(input('payee'), '  Corner Shop ');
    setValue(input('amount'), '12.50');
    setValue(input('date'), '2026-09-10');
    setValue(form().querySelector('.split-env'), 'food');
    const notes = input('note').closest('details');
    expect(notes.open).toBe(false);
    notes.open = true;
    setValue(input('note'), 'lunch');
    notes.open = false; // Deliberately folding a note must not drop its value.
    await click(saveBtn());

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(writeBatch.mock.calls[0][0]).toBe(state.budgetFolder);
    expect(lastWrite()).toEqual(written());
    expect(written()).toHaveLength(1);
    expect(added()).toMatchObject({
      type: 'expense', date: '2026-09-10', payee: 'Corner Shop',
      amount: 12.5, envelope_id: 'food', account: 'chk', note: 'lunch',
    });
    expect(added().id).toBeTruthy();
    expect(added().envelope_splits).toBeUndefined();
    // Field for field: nothing else is stored, and the timestamps are the
    // session clock's.
    expect(added()).toEqual({
      id: expect.any(String), type: 'expense', date: '2026-09-10', payee: 'Corner Shop', amount: 12.5,
      envelope_id: 'food', account: 'chk', note: 'lunch', created_at: AT, modified_at: AT,
    });
    expect(navigate).toHaveBeenCalledWith('transactions');
    expect(sheetIsOpen()).toBe(false);
  });

  it('choosing "No envelope" stores the deliberate __none__ value', async () => {
    setValue(input('amount'), '4');
    setValue(input('date'), '2026-09-10');
    setValue(form().querySelector('.split-env'), '__none__');
    await click(saveBtn());
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(added()).toMatchObject({ type: 'expense', envelope_id: '__none__' });
  });

  it('appends to the existing ledger instead of replacing it', async () => {
    const existing = { id: 'old', type: 'expense', date: '2026-09-01', payee: 'X', amount: 5, envelope_id: 'food', account: 'chk' };
    state.transactions = [existing];
    mountHosts();
    openAddTx();
    setValue(input('amount'), '3');
    setValue(input('date'), '2026-09-02');
    await click(saveBtn());
    expect(written().map(x => x.id)).toEqual(['old', added().id]);
    expect(written()[0]).toEqual(existing);
  });

  it('records no envelope when none is picked', async () => {
    setValue(input('amount'), '4');
    setValue(input('date'), '2026-09-10');
    await click(saveBtn());
    expect(added().envelope_id).toBeNull();
  });

  it('"Add & new" saves, keeps the sheet open and clears the entry fields', async () => {
    const notes = input('note').closest('details');
    notes.open = true;
    setValue(input('note'), 'Receipt');
    setValue(input('payee'), 'Bakery');
    setValue(input('amount'), '6');
    setValue(input('date'), '2026-09-10');
    await click(saveNewBtn());
    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(added()).toMatchObject({ payee: 'Bakery', amount: 6, note: 'Receipt' });
    expect(input('note').value).toBe('');
    expect(notes.open).toBe(true); // Keep the chosen layout for repeated entry.
    expect(sheetIsOpen()).toBe(true);
    expect(input('payee').value).toBe('');
    expect(input('amount').value).toBe('');
    expect(saveBtn().disabled).toBe(false);
    expect(form().querySelector('.has-error')).toBeNull();
  });

  it('writes envelope_splits, not envelope_id, for a multi-envelope expense', async () => {
    setValue(input('amount'), '30');
    setValue(input('date'), '2026-09-10');
    setValue(form().querySelector('.split-env'), 'food');
    setValue(form().querySelector('.split-amt'), '10');
    // Entering less than the total adds a row pre-filled with the remainder.
    const rows = [...form().querySelectorAll('.split-row')];
    expect(rows).toHaveLength(2);
    expect(rows[1].querySelector('.split-amt').value).toBe('20.00');
    setValue(rows[1].querySelector('.split-env'), 'fun');
    await click(saveBtn());

    expect(added().envelope_id).toBeNull();
    expect(added().envelope_splits).toEqual([
      { envelope_id: 'food', amount: 10 },
      { envelope_id: 'fun', amount: 20 },
    ]);
    expect(added().amount).toBe(30);
    expect(added()).toEqual({
      id: expect.any(String), type: 'expense', date: '2026-09-10', payee: '', amount: 30,
      envelope_id: null, envelope_splits: [{ envelope_id: 'food', amount: 10 }, { envelope_id: 'fun', amount: 20 }],
      account: 'chk', note: null, created_at: AT, modified_at: AT,
    });
  });

  it('blocks saving until every split has an envelope and the splits add up to the total', async () => {
    setValue(input('amount'), '30');
    setValue(form().querySelector('.split-env'), 'food');
    setValue(form().querySelector('.split-amt'), '10');
    let rows = [...form().querySelectorAll('.split-row')];
    setValue(rows[1].querySelector('.split-env'), 'fun');
    // Shrinking the second split leaves 15 uncovered: a third row appears
    // with that remainder, still without an envelope.
    setValue(rows[1].querySelector('.split-amt'), '5');
    rows = [...form().querySelectorAll('.split-row')];
    expect(rows).toHaveLength(3);
    expect(rows[2].querySelector('.split-amt').value).toBe('15.00');
    expect(saveBtn().disabled).toBe(false);
    saveBtn().click();
    expect(form().querySelector('.has-error')).not.toBeNull();
    expect(writeBatch).not.toHaveBeenCalled();
    await flush();
    setValue(rows[2].querySelector('.split-env'), 'rent');
    expect(saveBtn().disabled).toBe(false);
    await flush();
    // Drop a row: 10 + 15 no longer covers 30.
    rows[1].querySelector('.split-rm').click();
    expect(saveBtn().disabled).toBe(false);
    saveBtn().click();
    expect(form().querySelector('.has-error')).not.toBeNull();
    expect(writeBatch).not.toHaveBeenCalled();
  });
});

describe('split remainder (UX 2026-10-05)', () => {
  const rows = () => [...form().querySelectorAll('.split-row')];
  const amt = (i) => rows()[i].querySelector('.split-amt');

  it('lowering one line puts the rest into the empty line, so Save is ready once envelopes are picked', async () => {
    setValue(input('amount'), '100');
    setValue(input('date'), '2026-09-10');
    form().querySelector('.split-add').click();
    expect(rows()).toHaveLength(2);
    expect(amt(1).value).toBe('');
    setValue(amt(0), '60', ['input']);
    expect(amt(1).value).toBe('40.00');
    setValue(rows()[0].querySelector('.split-env'), 'food');
    setValue(rows()[1].querySelector('.split-env'), 'fun');
    expect(saveBtn().disabled).toBe(false);
    await click(saveBtn());
    expect(added().envelope_splits).toEqual([
      { envelope_id: 'food', amount: 60 },
      { envelope_id: 'fun', amount: 40 },
    ]);
  });

  it('typing into the new line takes from the line the form filled with the whole amount', () => {
    setValue(input('amount'), '100');
    form().querySelector('.split-add').click();
    setValue(amt(1), '30', ['input']);
    expect(amt(0).value).toBe('70.00');
    // A line the user typed is not overwritten: raising the first line now
    // is capped by the second.
    setValue(amt(0), '80', ['input']);
    expect(amt(0).value).toBe('70.00');
    expect(amt(1).value).toBe('30');
  });

  it('a remainder line filled by the form follows later edits of the first line', () => {
    setValue(input('amount'), '50');
    setValue(amt(0), '20', ['input', 'change']);
    // Leaving the first line short pre-filled a second line with the rest.
    expect(rows()).toHaveLength(2);
    expect(amt(1).value).toBe('30.00');
    setValue(amt(0), '35', ['input']);
    expect(amt(1).value).toBe('15.00');
  });
});

describe('no envelope note (UX 2026-10-05)', () => {
  it('an expense with an amount and no envelope says it will be saved as unassigned, before saving', () => {
    const note = () => form().querySelector('.field-note--warn');
    expect(note().hidden).toBe(true);
    setValue(input('amount'), '12');
    expect(note().hidden).toBe(false);
    expect(note().textContent).toBe(t('common.noEnvelopeHint'));
    setValue(form().querySelector('.split-env'), 'food');
    expect(note().hidden).toBe(true);
  });
});

describe('add income', () => {
  it('writes income into the chosen account and envelope', async () => {
    typeBtn('income').click();
    setValue(input('payee'), 'Employer');
    setValue(input('amount'), '2000');
    setValue(input('date'), '2026-09-01');
    setValue(fieldSelect(t('addTx.incomeEnvelope')), 'rent');
    await click(saveBtn());
    expect(added()).toEqual({
      id: expect.any(String), type: 'income', payee: 'Employer', amount: 2000, account: 'chk', envelope_id: 'rent',
      date: '2026-09-01', note: null, created_at: AT, modified_at: AT,
    });
  });
});

describe('add transfers', () => {
  it('account transfer needs two different accounts and writes from/to', async () => {
    typeBtn('account_transfer').click();
    setValue(input('amount'), '75');
    setValue(input('date'), '2026-09-05');
    const fromSel = fieldSelect(t('editTx.fromAccount'));
    const toSel = fieldSelect(t('editTx.toAccount'));
    setValue(fromSel, 'chk');
    setValue(toSel, 'chk');
    expect(saveBtn().disabled).toBe(false);
    saveBtn().click();
    expect(form().querySelector('.has-error')).not.toBeNull();
    expect(writeBatch).not.toHaveBeenCalled();
    // Not a silent refusal: the To field says why.
    expect(toSel.closest('.field').querySelector('.field-hint').textContent).toBe(t('addTx.accountsSameError'));
    await flush();
    setValue(toSel, 'sav');
    expect(saveBtn().disabled).toBe(false);
    expect(toSel.closest('.field').querySelector('.field-hint').textContent).toBe('');
    await click(saveBtn());
    expect(added()).toEqual({
      id: expect.any(String), type: 'account_transfer', amount: 75, from_account: 'chk', to_account: 'sav', date: '2026-09-05',
      payee: t('addTx.payeeAccountTransfer'), note: null, created_at: AT, modified_at: AT,
    });
  });

  it('account transfer starts with To on an account other than From, also after a type switch', () => {
    typeBtn('account_transfer').click();
    const fromSel = fieldSelect(t('editTx.fromAccount'));
    const toSel = fieldSelect(t('editTx.toAccount'));
    expect(fromSel.value).toBe('chk');
    expect(toSel.value).toBe('sav');

    // From the expense form with Savings picked: From follows it, To moves off it.
    typeBtn('expense').click();
    setValue(fieldSelect(t('addTx.account')), 'sav');
    setValue(toSel, 'sav');
    typeBtn('account_transfer').click();
    expect(fromSel.value).toBe('sav');
    expect(toSel.value).toBe('chk');
    expect(toSel.closest('.field').querySelector('.field-hint').textContent).toBe('');
  });

  it('envelope transfer maps the Unallocated sentinel to null', async () => {
    typeBtn('envelope_transfer').click();
    setValue(input('amount'), '40');
    setValue(input('date'), '2026-09-05');
    setValue(fieldSelect(t('addTx.fromEnvelope')), '__unallocated__');
    setValue(fieldSelect(t('addTx.toEnvelope')), 'food');
    await click(saveBtn());
    expect(added()).toEqual({
      id: expect.any(String), type: 'envelope_transfer', amount: 40, from_envelope_id: null, to_envelope_id: 'food',
      date: '2026-09-05', payee: t('addTx.payeeEnvelopeTransfer'), note: null, created_at: AT, modified_at: AT,
    });
  });

  it('envelope transfer to the same envelope shows a field error', () => {
    typeBtn('envelope_transfer').click();
    setValue(input('amount'), '40');
    setValue(fieldSelect(t('addTx.fromEnvelope')), 'food');
    setValue(fieldSelect(t('addTx.toEnvelope')), 'food');
    expect(saveBtn().disabled).toBe(false);
    saveBtn().click();
    expect(form().querySelector('.has-error')).not.toBeNull();
    expect(writeBatch).not.toHaveBeenCalled();
  });
});

describe('add investment transfer', () => {
  const fieldWrap = (labelText, { last = false } = {}) => {
    const all = [...form().querySelectorAll('.field')].filter(f => f.querySelector(':scope > label')?.textContent === labelText);
    return last ? all.at(-1) : all[0];
  };
  const dirBtn = (label) => [...fieldWrap(t('addTx.investmentDirection')).querySelectorAll('button')]
    .find(b => b.textContent === label);
  // The investment sheet reuses the "Envelope" label of the expense form; the
  // investment one is the later field.
  const invEnvelope = () => fieldWrap(t('addTx.envelope'), { last: true }).querySelector('select');

  beforeEach(() => {
    state.accounts = [...state.accounts, { id: 'brk', name: 'Brokerage', type: 'investment', initialBalance: 0 }];
    mountHosts();
    openAddTx();
    typeBtn('investment_transfer').click();
    setValue(input('date'), '2026-09-05');
  });

  it('a buy writes units, price and fee with units x price + fee as the cash amount', async () => {
    setValue(fieldSelect(t('addTx.investmentAccount')), 'brk');
    setValue(invEnvelope(), 'fun');
    setValue(input('units'), '10');
    setValue(input('price'), '5');
    setValue(input('fee'), '1.5');
    expect(input('amount').value).toBe('51.50');
    setValue(input('symbol'), 'abc');
    await click(saveBtn());

    expect(added()).toEqual({
      id: expect.any(String), type: 'investment_transfer', direction: 'buy', amount: 51.5, date: '2026-09-05',
      payee: t('addTx.payeeInvestment'), note: null,
      from_account: 'chk', to_account: 'brk', envelope_id: 'fun',
      units: 10, pricePerUnit: 5, fee: 1.5, symbol: 'ABC', created_at: AT, modified_at: AT,
    });
  });

  it('a buy that takes its cash account below zero asks first; Cancel writes nothing', async () => {
    setValue(fieldSelect(t('addTx.investmentAccount')), 'brk');
    setValue(invEnvelope(), 'fun');
    setValue(input('amount'), '1200');
    setValue(input('symbol'), 'abc');
    await click(saveBtn());
    // Checking holds 1000: the buy leaves it at -200. Unallocated does not
    // move (the envelope pays), so this is the account warning, not that one.
    expect(topOverlay().textContent).toContain(t('addTx.overdrawWarnTitle'));
    expect(topOverlay().textContent).toContain(t('addTx.overdrawWarn')('Checking', fmt(-200)));
    expect(topOverlay().textContent).not.toContain(t('addTx.unallocatedWarnTitle'));
    topOverlay().querySelector('.btn:not(.btn-accent)').click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(true);
  });

  it('the overdraw warning saves once confirmed, and a buy within the balance does not ask', async () => {
    setValue(fieldSelect(t('addTx.investmentAccount')), 'brk');
    setValue(invEnvelope(), 'fun');
    setValue(input('amount'), '1200');
    setValue(input('symbol'), 'abc');
    await click(saveBtn());
    dialogOk().click();
    await flush();
    expect(added()).toMatchObject({ type: 'investment_transfer', amount: 1200, from_account: 'chk' });
  });

  it('a buy with no symbol says it counts in no holding and links to the unmapped card', async () => {
    setValue(fieldSelect(t('addTx.investmentAccount')), 'brk');
    setValue(invEnvelope(), 'fun');
    setValue(input('amount'), '50');
    setValue(input('payee'), 'New Broker');
    await click(saveBtn());
    expect(added()).toMatchObject({ type: 'investment_transfer', payee: 'New Broker' });
    expect(added().symbol).toBeUndefined();
    const msg = toastTexts().find(m => m.includes(t('addTx.savedNoSymbol')));
    expect(msg).toBeTruthy();
    const action = [...document.querySelectorAll('.toast .toast-action')].find(b => b.textContent === t('addTx.assignSymbol'));
    expect(action).toBeTruthy();
    action.click();
    await flush();
    expect(navigate).toHaveBeenCalledWith('investments');
  });

  it('a buy with a symbol has the plain toast', async () => {
    setValue(fieldSelect(t('addTx.investmentAccount')), 'brk');
    setValue(invEnvelope(), 'fun');
    setValue(input('amount'), '50');
    setValue(input('symbol'), 'abc');
    await click(saveBtn());
    expect(toastTexts().some(m => m.includes(t('addTx.savedNoSymbol')))).toBe(false);
  });

  it('a sell without units is refused and nothing is written', async () => {
    dirBtn(t('addTx.investmentSell')).click();
    setValue(input('amount'), '100');
    setValue(invEnvelope(), 'fun');
    await click(saveBtn());

    expect(writeBatch).not.toHaveBeenCalled();
    expect(form().textContent).toContain(t('addTx.investmentSellNeedsUnits'));
    expect(sheetIsOpen()).toBe(true);
  });

  it('a sell with units writes direction sell from the investment account', async () => {
    dirBtn(t('addTx.investmentSell')).click();
    setValue(input('amount'), '100');
    setValue(input('units'), '4');
    setValue(invEnvelope(), 'fun');
    await click(saveBtn());

    expect(added()).toMatchObject({
      type: 'investment_transfer', direction: 'sell', amount: 100,
      from_account: 'brk', to_account: 'chk', units: 4,
    });
  });
});

describe('closed month (soft lock)', () => {
  it('asks before adding a row dated in a closed month; Cancel keeps the sheet', async () => {
    state.meta = { ...(state.meta || {}), closed_months: ['2026-08'] };
    setValue(input('amount'), '5');
    setValue(input('date'), '2026-08-20');
    setValue(form().querySelector('.split-env'), 'food');
    await click(saveBtn());
    expect(writeBatch).not.toHaveBeenCalled();
    const overlays = [...document.querySelectorAll('#sheet-host .sheet-overlay[data-sheet-open]')];
    const top = overlays.at(-1);
    expect(top.textContent).toContain(t('closedPeriod.editAnyway'));
    top.querySelector('.btn-accent').click();
    await flush();
    expect(added()).toMatchObject({ date: '2026-08-20', amount: 5 });
  });
});

describe('add loan payment', () => {
  it('is not offered without a loan account', () => {
    expect(typeBtn('loan_payment')).toBeNull();
  });

  describe('with a loan account', () => {
    beforeEach(() => {
      state.accounts = [...state.accounts, { id: 'mtg', name: 'Mortgage', type: 'loan', initialBalance: -100000 }];
      mountHosts();
      openAddTx();
      typeBtn('loan_payment').click();
      setValue(input('date'), '2026-09-05');
    });

    it('leaves the loan out of the expense account picker', () => {
      typeBtn('expense').click();
      const opts = [...fieldSelect(t('addTx.account')).options].map(o => o.value);
      expect(opts).not.toContain('mtg');
    });

    it('writes the principal as a debt payment and the interest as an expense', async () => {
      setValue(input('amount'), '1200');
      setValue(input('interest'), '400');
      setValue(fieldSelect(t('addTx.loanAccount')), 'mtg');
      // The loan's envelope sits in the row with the interest field.
      const env = input('interest').closest('.field-row').querySelector('select');
      setValue(env, 'rent');
      await click(saveBtn());

      expect(written()).toHaveLength(2);
      expect(writeBatch).toHaveBeenCalledTimes(1); // one batch: both rows or neither
      expect(written()[0]).toEqual({
        id: expect.any(String), type: 'debt_payment', amount: 800, from_account: 'chk', to_account: 'mtg', envelope_id: 'rent',
        payee: 'Mortgage', date: '2026-09-05', note: null, created_at: AT, modified_at: AT,
      });
      expect(written()[1]).toEqual({
        id: expect.any(String), type: 'expense', amount: 400, account: 'chk', envelope_id: 'rent',
        payee: 'Mortgage', date: '2026-09-05', note: t('addTx.loanInterestNote'), created_at: AT, modified_at: AT,
      });
    });

    it('books other costs as their own expense; the principal is what remains', async () => {
      setValue(input('amount'), '1200');
      setValue(input('interest'), '400');
      setValue(input('loanFee'), '5');
      setValue(fieldSelect(t('addTx.loanAccount')), 'mtg');
      setValue(input('interest').closest('.field-row').querySelector('select'), 'rent');
      await click(saveBtn());
      expect(written().map(r => [r.type, r.amount, r.note])).toEqual([
        ['debt_payment', 795, null],
        ['expense', 400, t('addTx.loanInterestNote')],
        ['expense', 5, t('addTx.loanFeeNote')],
      ]);
    });

    it('links the interest and other costs to the plan item that pays the loan', async () => {
      state.budgetItems = [{
        id: 'mortgage', kind: 'loan_payment', description: 'Mortgage', envelope_id: 'rent', account_id: 'chk',
        to_account_id: 'mtg', default_amount: -1200, monthly_schedule: { Sep: true }, payment_day: 5,
        as_schedule: true, include: true,
      }];
      setValue(input('amount'), '1200');
      setValue(input('interest'), '400');
      setValue(input('loanFee'), '5');
      setValue(fieldSelect(t('addTx.loanAccount')), 'mtg');
      setValue(input('interest').closest('.field-row').querySelector('select'), 'rent');
      await click(saveBtn());
      // The principal finds the item by its loan; a debt payment cannot carry the link.
      expect(written().map(r => [r.type, r.budget_item_id])).toEqual([
        ['debt_payment', undefined],
        ['expense', 'mortgage'],
        ['expense', 'mortgage'],
      ]);
    });

    it("prefills the loan's plan-item envelope, and links only when paid from it", async () => {
      state.budgetItems = [{
        id: 'mortgage', kind: 'loan_payment', description: 'Mortgage', envelope_id: 'rent', account_id: 'chk',
        to_account_id: 'mtg', default_amount: -1200, monthly_schedule: { Sep: true }, payment_day: 5,
        as_schedule: true, include: true,
      }];
      // Re-open so the form starts with the item in place.
      mountHosts();
      openAddTx();
      typeBtn('loan_payment').click();
      setValue(input('date'), '2026-09-05');
      const env = () => input('interest').closest('.field-row').querySelector('select');
      expect(env().value).toBe('rent');
      setValue(fieldSelect(t('addTx.loanAccount')), 'mtg');
      expect(env().value).toBe('rent');

      // Paid from another envelope: no link to an item of another envelope.
      setValue(input('amount'), '1200');
      setValue(input('interest'), '400');
      setValue(env(), 'fun');
      await click(saveBtn());
      expect(written().map(r => [r.type, r.envelope_id, r.budget_item_id])).toEqual([
        ['debt_payment', 'fun', undefined],
        ['expense', 'fun', undefined],
      ]);
    });

    it('refuses interest larger than the payment', () => {
      setValue(input('amount'), '100');
      setValue(input('interest'), '150');
      setValue(fieldSelect(t('addTx.loanAccount')), 'mtg');
      expect(saveBtn().disabled).toBe(false);
    saveBtn().click();
    expect(form().querySelector('.has-error')).not.toBeNull();
    expect(writeBatch).not.toHaveBeenCalled();
    });
  });
});

describe('add loan given', () => {
  const dirBtn = (v) => [...form().querySelectorAll('.tx-type-btn')].find(b => b.dataset.value === v);

  beforeEach(() => {
    state.accounts = [...state.accounts, { id: 'lg', name: 'Loan to Sam', type: 'loan_given', initialBalance: 0 }];
    mountHosts();
    openAddTx();
    typeBtn('loan_given').click();
    setValue(input('date'), '2026-09-05');
  });

  it('lending writes a debt payment into the loan, from the chosen envelope', async () => {
    setValue(input('amount'), '5000');
    setValue(fieldSelect(t('addTx.lentEnvelope')), 'rent');
    expect(saveBtn().disabled).toBe(false);
    await click(saveBtn());
    expect(added()).toEqual({
      id: expect.any(String), type: 'debt_payment', amount: 5000, from_account: 'chk', to_account: 'lg', envelope_id: 'rent',
      payee: 'Loan to Sam', date: '2026-09-05', note: null, created_at: AT, modified_at: AT,
    });
  });

  it('lending needs an envelope', () => {
    setValue(input('amount'), '5000');
    expect(saveBtn().disabled).toBe(false);
    saveBtn().click();
    expect(form().querySelector('.has-error')).not.toBeNull();
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('a repayment writes the principal back as a transfer and the interest as income', async () => {
    dirBtn('repay').click();
    setValue(input('amount'), '1025');
    setValue(input('lentInterest'), '25');
    await click(saveBtn());
    expect(written()[0]).toEqual({
      id: expect.any(String), type: 'account_transfer', amount: 1000, from_account: 'lg', to_account: 'chk',
      payee: 'Loan to Sam', date: '2026-09-05', note: null, created_at: AT, modified_at: AT,
    });
    expect(written()[1]).toEqual({
      id: expect.any(String), type: 'income', amount: 25, account: 'chk', envelope_id: null, interest_of: 'lg',
      payee: 'Loan to Sam', date: '2026-09-05', note: t('addTx.lentInterestNote'), created_at: AT, modified_at: AT,
    });
  });

  it('the repayment hint asks for the interest still outstanding, net of interest already received', () => {
    state.accounts = state.accounts.map(a => (a.id === 'lg'
      ? { ...a, loanStart: '2026-03-01', interestPayout: 'yearly', interestRates: [{ from: '2026-03-01', rate: 4 }] } : a));
    state.transactions = [
      { id: 'lend', type: 'debt_payment', date: '2026-03-01', amount: 10000, from_account: 'chk', to_account: 'lg', envelope_id: 'rent', status: 'posted' },
      { id: 'int', type: 'income', date: '2026-08-01', amount: 100, account: 'chk', envelope_id: null, interest_of: 'lg', status: 'posted' },
    ];
    mountHosts();
    openAddTx();
    typeBtn('loan_given').click();
    dirBtn('repay').click();
    // 1 Mar to 14 Sep: 198 days at 4 % on 10,000 is 216.99, less the 100
    // received; the year to 1 Mar 2027 comes to 400, less the same 100.
    const accrued = Math.round((10000 * 0.04 * 198 / 365 - 100) * 100) / 100;
    expect(form().textContent).toContain(t('addTx.lentAccrued')(fmt(accrued), fmtDateLang('2027-03-01'), fmt(300)));
  });
});

describe('over-allocation warning', () => {
  // An expense with no envelope lowers unallocated by its amount: 1500 -> -500.
  const fillUnassignedExpense = () => {
    setValue(input('amount'), '2000');
    setValue(input('date'), '2026-09-10');
  };

  it('still fires, before anything is written; Cancel keeps the sheet and writes nothing', async () => {
    fillUnassignedExpense();
    await click(saveBtn());
    expect(topOverlay().textContent).toContain(t('addTx.unallocatedWarnTitle'));
    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.transactions).toEqual([]);
    topOverlay().querySelector('.btn:not(.btn-accent)').click();
    await flush();
    expect(writeBatch).not.toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(true);
  });

  it('writes the row once confirmed', async () => {
    fillUnassignedExpense();
    await click(saveBtn());
    dialogOk().click();
    await flush();
    expect(written()).toHaveLength(1);
    expect(added()).toMatchObject({ amount: 2000, envelope_id: null });
  });

  it('does not warn for an expense that stays within what is unallocated', async () => {
    setValue(input('amount'), '20');
    setValue(input('date'), '2026-09-10');
    await click(saveBtn());
    expect(written()).toHaveLength(1);
  });

  it('keeps a row that landed while the dialog was open (no stale-array overwrite)', async () => {
    fillUnassignedExpense();
    await click(saveBtn());
    // Another writer adds a row while the user reads the dialog.
    const other = { id: 'other', type: 'expense', date: '2026-09-09', payee: 'Other', amount: 1, envelope_id: 'food', account: 'chk', status: 'posted' };
    state.transactions = [...state.transactions, other];
    dialogOk().click();
    await flush();
    expect(written().map(x => x.id)).toEqual(['other', expect.any(String)]);
    expect(lastWrite().map(x => x.id)).toEqual(['other', expect.any(String)]);
  });
});

describe('save results', () => {
  it('toasts the payee that was stored, read back from state', async () => {
    setValue(input('payee'), 'Corner Shop');
    setValue(input('amount'), '12.5');
    setValue(input('date'), '2026-09-10');
    await click(saveBtn());
    expect(toastTexts().some(m => m.includes('Corner Shop'))).toBe(true);
    expect(navigate).toHaveBeenCalledWith('transactions');
  });

  it('a refused write is toasted with the reason and the row is not kept', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    setValue(input('amount'), '12.5');
    setValue(input('date'), '2026-09-10');
    await click(saveBtn());
    expect(state.transactions).toEqual([]);
    expect(toastTexts().some(m => m.startsWith(t('addTx.saveFailed')) && m.includes('disk full'))).toBe(true);
  });

  it('a version conflict opens the conflict dialog instead of a toast', async () => {
    // Only the commit conflicts; the dry run before it is the real thing.
    const real = session.dispatchBatch.bind(session);
    const spy = vi.spyOn(session, 'dispatchBatch').mockImplementation((steps, opts) => (
      opts?.dryRun ? real(steps, opts) : Promise.resolve({ ok: false, error: { code: 'version_conflict', params: {} } })));
    setValue(input('amount'), '12.5');
    setValue(input('date'), '2026-09-10');
    await click(saveBtn());
    expect(topOverlay().textContent).toContain(t('saveError.versionConflictBody'));
    expect(toastTexts().some(m => m.startsWith(t('addTx.saveFailed')))).toBe(false);
    spy.mockRestore();
  });

  it('a commit refused while the budget loads shows the loading text as is', async () => {
    // A load started between the dry run and the commit.
    const real = session.dispatchBatch.bind(session);
    const spy = vi.spyOn(session, 'dispatchBatch').mockImplementation((steps, opts) => (
      opts?.dryRun ? real(steps, opts) : Promise.resolve({ ok: false, error: { code: 'budget_loading', params: {} } })));
    setValue(input('amount'), '12.5');
    setValue(input('date'), '2026-09-10');
    await click(saveBtn());
    expect(toastTexts()).toContain(t('coreError.budgetLoading'));
    expect(toastTexts().some(m => m.startsWith(t('addTx.saveFailed')))).toBe(false);
    expect(state.transactions).toEqual([]);
    spy.mockRestore();
  });
});

describe('investment symbol rule', () => {
  // The rule commit is meta-primary, and a commit validates the whole meta.
  const META = { schemaVersion: 8 };
  const batchFiles = (call) => writeBatch.mock.calls[call][1].map(i => i.filename).sort();

  beforeEach(() => {
    vi.spyOn(session, 'dispatch').mockClear();
    state.meta = { ...META };
    state.accounts = [...state.accounts, { id: 'brk', name: 'Brokerage', type: 'investment', initialBalance: 0 }];
    state.transactions = [
      { id: 'old1', type: 'investment_transfer', direction: 'buy', date: '2026-08-01', payee: 'Broker X', amount: 100, from_account: 'chk', to_account: 'brk', envelope_id: 'fun', note: null, created_at: '2026-08-01T00:00:00.000Z', modified_at: '2026-08-01T00:00:00.000Z' },
    ];
    mountHosts();
    openAddTx();
    typeBtn('investment_transfer').click();
    setValue(input('date'), '2026-09-05');
    setValue(fieldSelect(t('addTx.investmentAccount')), 'brk');
    const envs = [...form().querySelectorAll('.field')].filter(f => f.querySelector(':scope > label')?.textContent === t('addTx.envelope'));
    setValue(envs.at(-1).querySelector('select'), 'fun');
    setValue(input('payee'), 'Broker X');
    setValue(input('amount'), '50');
    setValue(input('symbol'), 'abc');
  });

  it('backfills the symbol on earlier rows of the payee when confirmed: the rule and the rows are one commit', async () => {
    const old1 = state.transactions[0];
    await click(saveBtn());
    expect(topOverlay().textContent).toContain(t('investments.unmapped.retroApplyConfirm')(1, 'ABC'));
    dialogOk().click();
    await flush();
    // The entry is saved first, then the rule and the tagged row together.
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(batchFiles(1)).toEqual(['budget-meta.json', 'transactions.json']);
    expect(session.dispatch).toHaveBeenCalledWith('investment.setPayeeRule', { payee: 'Broker X', symbol: 'ABC', applyTo: ['old1'] });
    // What the old per-row amend stored: symbol and modified_at.
    expect(written().find(x => x.id === 'old1')).toEqual({ ...old1, symbol: 'ABC', modified_at: AT });
    expect(written().find(x => x.id !== 'old1')).toMatchObject({ symbol: 'ABC', payee: 'Broker X' });
    expect(state.meta.investments.payeeRules['broker x']).toBe('ABC');
  });

  it('leaves earlier rows alone when the backfill is declined, but still saves the new one and the rule', async () => {
    await click(saveBtn());
    topOverlay().querySelector('.btn:not(.btn-accent)').click();
    await flush();
    expect(session.dispatch).toHaveBeenCalledWith('investment.setPayeeRule', { payee: 'Broker X', symbol: 'ABC' });
    expect(writeBatch).toHaveBeenCalledTimes(2);
    expect(batchFiles(1)).toEqual(['budget-meta.json']);
    expect(written().find(x => x.id === 'old1').symbol).toBeUndefined();
    expect(written().find(x => x.id !== 'old1')).toMatchObject({ symbol: 'ABC' });
    expect(state.meta.investments.payeeRules['broker x']).toBe('ABC');
  });

  it('a refused backfill never costs the new entry and keeps the rule; one toast says how many rows were not tagged', async () => {
    // strict-ledger locks the posted past row; the new entry, created today, passes.
    state.meta = { ...META, policies: ['strict-ledger'] };
    const legacy = state.transactions[0];
    await click(saveBtn());
    dialogOk().click();
    await flush();
    const fresh = written().find(x => x.id !== 'old1');
    expect(fresh).toMatchObject({ symbol: 'ABC', payee: 'Broker X' });
    expect(written().find(x => x.id === 'old1')).toEqual(legacy);
    // The rule-and-rows commit is refused; the rule is then saved on its own.
    expect(session.dispatch).toHaveBeenCalledWith('investment.setPayeeRule', { payee: 'Broker X', symbol: 'ABC', applyTo: ['old1'] });
    expect(session.dispatch).toHaveBeenLastCalledWith('investment.setPayeeRule', { payee: 'Broker X', symbol: 'ABC' });
    expect(state.meta.investments.payeeRules['broker x']).toBe('ABC');
    const texts = toastTexts();
    expect(texts.some(m => m.startsWith(t('addTx.saved').split('{')[0]))).toBe(true);
    expect(texts).toContain(t('addTx.backfillPartial')(1));
  });

  it('a placeholder payee keeps no rule; its earlier rows still take the symbol', async () => {
    state.transactions = [{ ...state.transactions[0], payee: 'Investment' }];
    setValue(input('payee'), 'Investment');
    await click(saveBtn());
    dialogOk().click();
    await flush();
    expect(session.dispatch).toHaveBeenCalledWith('investment.tagSymbol', { ids: ['old1'], symbol: 'ABC' });
    expect(written().find(x => x.id === 'old1')).toMatchObject({ symbol: 'ABC', modified_at: AT });
    expect(state.meta.investments).toBeUndefined();
  });
});

describe('Add & new does not wait for the write', () => {
  it('a second entry submitted while the first is still being written is stored too', async () => {
    let release;
    writeBatch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const fill = (payee) => {
      setValue(input('payee'), payee);
      setValue(input('amount'), '6');
      setValue(input('date'), '2026-09-10');
    };
    fill('Bakery');
    saveNewBtn().click();
    await flush();
    // The first write is held; the form is already clear and accepts the next entry.
    expect(input('payee').value).toBe('');
    expect(written()).toHaveLength(0);
    fill('Kiosk');
    saveNewBtn().click();
    await flush();
    release();
    await flush();
    await flush();
    expect(written().map(x => x.payee)).toEqual(['Bakery', 'Kiosk']);
  });
});

describe('a thrown error in the dry run', () => {
  it('is toasted as a failed save, not left unhandled', async () => {
    const spy = vi.spyOn(session, 'dispatchBatch').mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setValue(input('amount'), '5');
    setValue(input('date'), '2026-09-10');
    await click(saveBtn());
    expect(toastTexts().some(m => m.startsWith(t('addTx.saveFailed')) && m.includes('boom'))).toBe(true);
    expect(written()).toHaveLength(0);
    spy.mockRestore();
    errSpy.mockRestore();
  });
});

describe('type picker', () => {
  const title = () => document.querySelector('#sheet-host [id^="sheet-title-"]').textContent;

  it('is a row of named icon buttons, and the title names the chosen type', () => {
    const btn = typeBtn('income');
    expect(btn.getAttribute('aria-label')).toBe(t('editTx.typeIncome'));
    expect(btn.title).toBe(t('editTx.typeIncome'));
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(title()).toBe(t('addTx.newTitle').expense);
    expect(typeBtn('expense').getAttribute('aria-pressed')).toBe('true');
    btn.click();
    expect(title()).toBe(t('addTx.newTitle').income);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(typeBtn('expense').getAttribute('aria-pressed')).toBe('false');
  });
});

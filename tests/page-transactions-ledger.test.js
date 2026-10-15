// @vitest-environment jsdom
// Transactions page figures: the running balances, the set fill's step and the
// day headers come from the ledger.running query (lens-less, the scheduled
// preview in or out). Unallocated lives in the shell status bar. A search keystroke repaints from the cached ledger answer; a new
// budget array asks again. The rows' own display amounts (a split share, the
// day total over the visible rows without a single entity) stay the page's.
// Drives the real js/pages/transactions.js over the fake app.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { render } from '../js/pages/transactions.js';
import { fmt } from '../js/utils.js';
import { t } from '../js/ui/i18n.js';
import { moneyEl } from '../js/ui/money.js';
import { state, prefs, session, resetState, mountHosts, flush, setValue } from './_fakes/pageApp.js';

// The fake clock is 15 Sep 2026. Food: an add fill, a plain expense and a
// split's share on one day, a set fill to 300, an expense and a scheduled row.
// Checking: an income, the expense and the whole split, a transfer out, the
// scheduled row and a future-dated row; the Gym bill (fun, from checking, on
// the 20th) is the scheduled preview. The Rent top-up template fill (the
// 28th) moves money out of Unallocated on the Forecast lens.
const ALL = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const TXS = [
  { id: 'fill1', type: 'fill', date: '2026-09-01', payee: 'Fill', status: 'posted', lines: [{ envelope_id: 'food', amount: 400 }, { envelope_id: 'fun', amount: 100 }] },
  { id: 'inc1', type: 'income', date: '2026-09-02', payee: 'Pay', amount: 200, account: 'chk', status: 'posted' },
  { id: 'e1', type: 'expense', date: '2026-09-03', payee: 'Shop', amount: 45.5, account: 'chk', envelope_id: 'food', status: 'posted' },
  { id: 'split1', type: 'expense', date: '2026-09-03', payee: 'Mall', amount: 30, account: 'chk', status: 'posted',
    envelope_splits: [{ envelope_id: 'food', amount: 20.1 }, { envelope_id: 'fun', amount: 9.9 }] },
  { id: 'set1', type: 'fill', date: '2026-09-05', payee: 'Reset', status: 'posted', lines: [{ envelope_id: 'food', mode: 'set', amount: 300 }] },
  { id: 'e2', type: 'expense', date: '2026-09-07', payee: 'Kiosk', amount: 12.34, account: 'chk', envelope_id: 'food', status: 'posted' },
  { id: 'x1', type: 'account_transfer', date: '2026-09-08', amount: 100, from_account: 'chk', to_account: 'sav', status: 'posted' },
  { id: 'e3', type: 'expense', date: '2026-09-10', payee: 'Late', amount: 12, account: 'chk', envelope_id: 'food', status: 'scheduled' },
  { id: 'e4', type: 'expense', date: '2026-09-25', payee: 'Ahead', amount: 7, account: 'chk', envelope_id: 'rent', status: 'posted' },
];
const ITEMS = [
  { id: 'bi-bill', kind: 'expense', description: 'Gym', envelope_id: 'fun', account_id: 'chk', default_amount: -25, payment_day: 20,
    schedule_day_type: 'exact', include: true, as_schedule: true, as_schedule_since: '2026-01-01', monthly_schedule: ALL },
];
const TEMPLATES = [
  { id: 'tplRent', name: 'Rent top-up', kind: 'manual', lines: [{ envelope_id: 'rent', mode: 'add', amount: 50 }],
    schedule: { enabled: true, payment_day: 28, day_type: 'exact', since: '2026-01-01', months: ALL } },
];

const root = () => document.getElementById('app-root');
const rowEl = (id) => root().querySelector(`.tx-row[data-tx-id="${id}"]`);
const rowIds = () => [...root().querySelectorAll('.tx-row')].map(r => r.dataset.txId);
const amountCol = (id) => [...rowEl(id).children].find(c => c.style.alignItems === 'flex-end');
const amountText = (id) => amountCol(id).firstElementChild.textContent;
// The running balance is the amount column's last line, under the amount.
const balanceText = (id) => {
  const lines = [...amountCol(id).children].filter(c => c.tagName === 'DIV');
  return lines.length ? lines.at(-1).textContent : null;
};
// A day's header in the list (the pinned copy sits outside the scroller rows).
const header = (date) => [...root().querySelectorAll(`.tx-date-header[data-header-date="${date}"]`)].at(-1);
const dayTotal = (date) => header(date).querySelector('.tx-date-total')?.textContent ?? null;
const dayBalance = (date) => header(date).querySelector('.tx-date-balance')?.textContent ?? null;
const signed = (n) => fmt(n, { signed: true });

let stored;
async function openPage(filter, { showScheduled = true } = {}) {
  stored.set('bunvelope.tx.showScheduled.test-budget', showScheduled ? '1' : '0');
  state.pendingFilter = filter;
  mountHosts();
  await render(root());
  await flush();
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  // The page reads the preview toggle from localStorage.
  stored = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (stored.has(k) ? stored.get(k) : null),
    setItem: (k, v) => { stored.set(k, String(v)); },
    removeItem: (k) => { stored.delete(k); },
  });
  // The virtual list renders what fits the scroller; jsdom has no layout.
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 4000; } });
  resetState({ transactions: structuredClone(TXS) });
  state.budgetItems = structuredClone(ITEMS);
  state.envelopeTemplates = structuredClone(TEMPLATES);
});

afterEach(() => {
  delete HTMLElement.prototype.clientHeight;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('one envelope selected', () => {
  it('shows each row\'s balance after it, the set fill as its step and the split as its share', async () => {
    await openPage('food');
    expect(rowIds()).toEqual(['e3', 'e2', 'set1', 'split1', 'e1', 'fill1']);
    expect(balanceText('fill1')).toBe(fmt(400));
    expect(balanceText('e1')).toBe(fmt(354.5));
    expect(balanceText('split1')).toBe(fmt(334.4));
    expect(balanceText('set1')).toBe(fmt(300));
    expect(balanceText('e2')).toBe(fmt(287.66));
    expect(balanceText('e3')).toBe(fmt(275.66));
    // The set fill reads the step to its target, not the target.
    expect(amountText('set1')).toBe(moneyEl(-34.4, { size: 'md', signed: true }).textContent);
    // The split reads the envelope's share (row display, the page's own).
    expect(amountText('split1')).toBe(moneyEl(-20.1, { size: 'md' }).textContent);
  });

  it('heads each day with its movement and closing balance', async () => {
    await openPage('food');
    expect([dayTotal('2026-09-01'), dayBalance('2026-09-01')]).toEqual([signed(400), fmt(400)]);
    expect([dayTotal('2026-09-03'), dayBalance('2026-09-03')]).toEqual([signed(-65.6), fmt(334.4)]);
    expect([dayTotal('2026-09-05'), dayBalance('2026-09-05')]).toEqual([signed(-34.4), fmt(300)]);
    expect([dayTotal('2026-09-07'), dayBalance('2026-09-07')]).toEqual([signed(-12.34), fmt(287.66)]);
    expect([dayTotal('2026-09-10'), dayBalance('2026-09-10')]).toEqual([signed(-12), fmt(275.66)]);
  });

  it('walks from the beginning of time inside a date range', async () => {
    await openPage({ envelope: 'food', dateFrom: '2026-09-03', dateTo: '2026-09-05' });
    expect(rowIds()).toEqual(['set1', 'split1', 'e1']);
    expect(balanceText('e1')).toBe(fmt(354.5));
    expect(balanceText('set1')).toBe(fmt(300));
    expect([dayTotal('2026-09-03'), dayBalance('2026-09-03')]).toEqual([signed(-65.6), fmt(334.4)]);
    expect([dayTotal('2026-09-05'), dayBalance('2026-09-05')]).toEqual([signed(-34.4), fmt(300)]);
  });

  it('keeps the set fill\'s step under a search, with no balance column', async () => {
    await openPage({ envelope: 'food', search: 'Reset' });
    expect(rowIds()).toEqual(['set1']);
    expect(amountText('set1')).toBe(moneyEl(-34.4, { size: 'md', signed: true }).textContent);
    expect(balanceText('set1')).toBeNull();
  });

  it('shows no balances and no day totals for the no-envelope filter', async () => {
    state.transactions.push({ id: 'u1', type: 'expense', date: '2026-09-04', payee: 'Cash', amount: 5, account: 'chk', envelope_id: null, status: 'posted' });
    await openPage('__noenvelope__');
    expect(rowIds()).toEqual(['u1']);
    expect(balanceText('u1')).toBeNull();
    expect(dayTotal('2026-09-04')).toBeNull();
  });

  it('leaves a malformed date range out of the ledger ask, so the balances still show', async () => {
    // A structured filter from another page (the AI's navigate) is not
    // checked: an impossible day reaches the page as typed. The list still
    // filters on it; the preview list and the ledger are both built without it.
    const q = vi.spyOn(session, 'query');
    try {
      await openPage({ envelope: 'food', dateFrom: '2026-02-30', dateTo: '2026-09-31' });
      expect(rowIds()).toEqual(['e3', 'e2', 'set1', 'split1', 'e1', 'fill1']);
      const asked = q.mock.calls.filter(([name]) => name === 'ledger.running').map(([, input]) => input);
      expect(asked).toEqual([{ envelope: 'food', showScheduled: true }]);
      expect(balanceText('e1')).toBe(fmt(354.5));
      expect(balanceText('set1')).toBe(fmt(300));
      expect(amountText('set1')).toBe(moneyEl(-34.4, { size: 'md', signed: true }).textContent);
    } finally {
      q.mockRestore();
    }
  });

  it('a failed ledger leaves the set fill\'s amount off, not its target', async () => {
    const real = session.query.bind(session);
    const q = vi.spyOn(session, 'query').mockImplementation((name, input) => (name === 'ledger.running'
      ? { ok: false, error: { code: 'bad_input', params: {} } }
      : real(name, input)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await openPage('food');
      expect(rowIds()).toEqual(['e3', 'e2', 'set1', 'split1', 'e1', 'fill1']);
      // No step to show: a dash, where the stored target (300) used to show.
      expect(amountText('set1')).toBe('\u2014');
      expect(balanceText('set1')).toBeNull();
      // An add fill's line is its own amount, not a step: it stays.
      expect(amountText('fill1')).toBe(moneyEl(400, { size: 'md', signed: true }).textContent);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      q.mockRestore();
    }
  });

  it('asks the ledger once while a search is typed, and again when the budget changes', async () => {
    const q = vi.spyOn(session, 'query');
    await openPage('food');
    const ledgerCalls = () => q.mock.calls.filter(([name]) => name === 'ledger.running');
    const input = root().querySelector('.search input');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    for (const text of ['K', 'Ki', 'Kio', 'Kios', 'Kiosk']) {
      setValue(input, text, ['input']);
      vi.advanceTimersByTime(150);
    }
    expect(rowIds()).toEqual(['e2']);
    expect(ledgerCalls()).toHaveLength(1);
    expect(ledgerCalls()[0][1]).toEqual({ envelope: 'food', showScheduled: true });

    // A write replaces the array: the next repaint walks the new rows.
    state.transactions = [...state.transactions, { id: 'e5', type: 'expense', date: '2026-09-12', payee: 'Kiosk', amount: 1, account: 'chk', envelope_id: 'food', status: 'posted' }];
    setValue(input, 'Kiosk ', ['input']);
    vi.advanceTimersByTime(150);
    expect(ledgerCalls()).toHaveLength(2);
    q.mockRestore();
  });
});

describe('the ledger cache', () => {
  it('asks again after a preview toggle, a range change and a meta replacement, and not for a plain repaint', async () => {
    const q = vi.spyOn(session, 'query');
    try {
      await openPage('food');
      const asked = () => q.mock.calls.filter(([name]) => name === 'ledger.running').map(([, input]) => input);
      expect(asked()).toEqual([{ envelope: 'food', showScheduled: true }]);

      // The preview toggle.
      const toggle = [...root().querySelectorAll('div')].find(d => d.title === t('transactions.scheduledHint'))
        .querySelector('input[type="checkbox"]');
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
      expect(asked()).toHaveLength(2);
      expect(asked().at(-1)).toEqual({ envelope: 'food', showScheduled: false });

      // The date range.
      const from = root().querySelector(`input[aria-label="${t('transactions.fromDate')}"]`);
      const repaintSameRange = () => setValue(from, from.value, ['change']);
      setValue(from, '2026-09-03', ['change']);
      expect(asked()).toHaveLength(3);
      expect(asked().at(-1)).toEqual({ envelope: 'food', showScheduled: false, dateFrom: '2026-09-03' });

      // Nothing changed: the cached answer.
      repaintSameRange();
      expect(asked()).toHaveLength(3);

      // A meta write replaces the object (tombstones, country live there).
      state.meta = { ...state.meta };
      repaintSameRange();
      expect(asked()).toHaveLength(4);
      expect(asked().at(-1)).toEqual({ envelope: 'food', showScheduled: false, dateFrom: '2026-09-03' });
    } finally {
      q.mockRestore();
    }
  });
});

describe('one account selected', () => {
  it('walks the account from its opening balance, the preview left out', async () => {
    await openPage('account:chk', { showScheduled: false });
    expect(rowIds()).toEqual(['e4', 'e3', 'x1', 'e2', 'split1', 'e1', 'inc1']);
    expect(balanceText('inc1')).toBe(fmt(1200));
    expect(balanceText('split1')).toBe(fmt(1124.5));
    expect(balanceText('x1')).toBe(fmt(1012.16));
    expect(balanceText('e4')).toBe(fmt(993.16));
    // The first day counts from zero, as the headers always have.
    expect([dayTotal('2026-09-02'), dayBalance('2026-09-02')]).toEqual([signed(1200), fmt(1200)]);
    expect([dayTotal('2026-09-03'), dayBalance('2026-09-03')]).toEqual([signed(-75.5), fmt(1124.5)]);
    expect([dayTotal('2026-09-25'), dayBalance('2026-09-25')]).toEqual([signed(-7), fmt(993.16)]);
  });

  it('walks the scheduled preview in when it is on', async () => {
    await openPage('account:chk', { showScheduled: true });
    const gym = rowIds().find(id => id.startsWith('forecast:'));
    expect(gym).toBeTruthy();
    expect(balanceText(gym)).toBe(fmt(975.16));
    expect(balanceText('e4')).toBe(fmt(968.16));
    expect([dayTotal('2026-09-20'), dayBalance('2026-09-20')]).toEqual([signed(-25), fmt(975.16)]);
    expect([dayTotal('2026-09-25'), dayBalance('2026-09-25')]).toEqual([signed(-7), fmt(968.16)]);
  });
});

describe('no single entity', () => {
  it('totals each day over its visible rows, a transfer netting to zero', async () => {
    await openPage({ dateFrom: '2026-09-01' }, { showScheduled: false });
    expect(dayTotal('2026-09-03')).toBe(signed(-75.5));
    expect(dayTotal('2026-09-08')).toBe(signed(0));
    expect(dayBalance('2026-09-03')).toBeNull();
    expect(balanceText('e1')).toBeNull();
  });
});

describe('the header', () => {
  it('keeps Unallocated out of the page header and the ledger independent of the forecast lens', async () => {
    Object.assign(prefs, { lens: 'forecast', lensHorizon: '3m' });
    await openPage('food');
    expect(root().querySelector('.page-head-sub')).toBeNull();
    expect(root().querySelector('.page-head h1 .info-btn')).not.toBeNull();
    // The ledger stays lens-less: Food's last balance is the booked walk.
    expect(balanceText('e3')).toBe(fmt(275.66));
  });
});

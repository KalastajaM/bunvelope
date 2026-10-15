// @vitest-environment jsdom
// The first open of a new month offers to close the month that ended (owner
// decision 2026-10-05). Asked once per month and budget (localStorage, with
// an in-memory copy when storage fails); the close is `month.close`.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { offerToCloseLastMonth, closeOfferKey, _resetCloseOfferMemory } from '../js/ui/close-month-offer.js';
import { t, fmtMonthLang } from '../js/ui/i18n.js';

const OCT_1 = new Date(2026, 9, 1, 8, 0, 0);
const folder = { kind: 'cloud', budgetId: 'b1', name: 'Test' };

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

function deps({ meta = {}, transactions = [{ date: '2026-09-12' }], answer = true, closeOk = true, storage = memStorage() } = {}) {
  const session = {
    query: vi.fn(() => ({ ok: true, value: { negativeCount: 2 } })),
    dispatch: vi.fn(async () => (closeOk ? { ok: true, value: { value: { month: '2026-09' } } } : { ok: false, error: { code: 'bad_input', params: {} } })),
  };
  const confirm = vi.fn(async () => answer);
  return { state: { meta, transactions, budgetFolder: folder }, session, now: OCT_1, storage, confirm };
}

beforeEach(() => {
  _resetCloseOfferMemory();
  document.body.innerHTML = '<div id="toast-host"></div>';
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
});

describe('offer to close last month', () => {
  it('asks with the month and its negative count, and closes it on yes', async () => {
    const d = deps();
    expect(await offerToCloseLastMonth(d)).toBe(true);
    expect(d.session.query).toHaveBeenCalledWith('review.month', { month: '2026-09' });
    const [message, opts] = d.confirm.mock.calls[0];
    expect(message).toBe(t('review.closeOffer')(fmtMonthLang('2026-09'), 2));
    expect(opts.okLabel).toBe(t('review.closeOfferOk')(fmtMonthLang('2026-09')));
    expect(opts.cancelLabel).toBe(t('review.notNow'));
    expect(d.session.dispatch).toHaveBeenCalledWith('month.close', { month: '2026-09' }, undefined);
    expect(document.querySelector('.toast-msg').textContent).toBe(t('review.closedToast')(fmtMonthLang('2026-09')));
  });

  it('asks once per month and budget: "Not now" is remembered', async () => {
    const storage = memStorage();
    const d = deps({ answer: false, storage });
    expect(await offerToCloseLastMonth(d)).toBe(false);
    expect(d.session.dispatch).not.toHaveBeenCalled();
    expect(storage.map.get(closeOfferKey('cloud:b1'))).toBe('2026-09');
    _resetCloseOfferMemory();
    const again = deps({ storage });
    expect(await offerToCloseLastMonth(again)).toBe(false);
    expect(again.confirm).not.toHaveBeenCalled();
    // Another budget is asked on its own.
    const other = deps({ storage });
    other.state.budgetFolder = { kind: 'cloud', budgetId: 'b2' };
    await offerToCloseLastMonth(other);
    expect(other.confirm).toHaveBeenCalledTimes(1);
  });

  it('with storage blocked, asks once in this page session', async () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    const first = deps({ storage: blocked, answer: false });
    await offerToCloseLastMonth(first);
    expect(first.confirm).toHaveBeenCalledTimes(1);
    const second = deps({ storage: blocked });
    await offerToCloseLastMonth(second);
    expect(second.confirm).not.toHaveBeenCalled();
  });

  it('does not ask when last month is already closed or has no rows', async () => {
    const closed = deps({ meta: { closed_months: ['2026-09'] } });
    expect(await offerToCloseLastMonth(closed)).toBe(false);
    const empty = deps({ transactions: [{ date: '2026-10-01' }] });
    expect(await offerToCloseLastMonth(empty)).toBe(false);
    expect(closed.confirm).not.toHaveBeenCalled();
    expect(empty.confirm).not.toHaveBeenCalled();
  });

  it('a refused close reports and returns false; a switched budget does not dispatch', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = deps({ closeOk: false });
    expect(await offerToCloseLastMonth(refused)).toBe(false);
    expect(document.querySelector('.toast-msg').textContent).toBe(t('review.closeFailed'));
    const switched = deps();
    expect(await offerToCloseLastMonth({ ...switched, stillCurrent: () => false })).toBe(false);
    expect(switched.session.dispatch).not.toHaveBeenCalled();
  });
});

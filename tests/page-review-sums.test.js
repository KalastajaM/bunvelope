// @vitest-environment jsdom
// The Review page's sums come from the review.month answer: the category
// subtotals, the footer, each row's consolidate amount and the balance the
// consolidate popover offers, the negative count in the close-month
// confirmation and the detail sections' totals. The header pill reads
// balances on the Booked lens. The figures equal what the page summed itself
// before (pinned against that composition), and a doctored answer shows they
// are the answer's.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { render } from '../js/pages/review.js';
import { fmt } from '../js/utils.js';
import { t, fmtMonthLang } from '../js/ui/i18n.js';
import { computeAccountBalances, computeEnvelopeBalances, computeUnallocated } from '../js/engine.js';
import { session, state, resetState, mountHosts, flush, setValue, topOverlay } from './_fakes/pageApp.js';

const root = () => document.getElementById('app-root');
const cells = (tr) => [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/\s+/g, ' ').trim());
const catRows = () => [...root().querySelectorAll('tr.review-cat-row')];
const pill = () => root().querySelector('#review-assign-pill');

// The fake clock is 15 Sep 2026. Food (living) has an income, a posted
// expense, an overdue and a coming scheduled row and a row dated ahead; Fun
// (living) a fill and a split share; Rent (housing) is overspent.
const FIXTURE = [
  { id: 'i1', type: 'income', date: '2026-09-01', payee: 'Job', amount: 500, envelope_id: 'food', account: 'chk', status: 'posted' },
  { id: 'f1', type: 'fill', date: '2026-09-01', payee: 'Fill', status: 'posted', lines: [{ envelope_id: 'fun', amount: 60 }] },
  { id: 'e1', type: 'expense', date: '2026-09-05', payee: 'Shop', amount: 40, envelope_id: 'food', account: 'chk', status: 'posted' },
  { id: 's1', type: 'expense', date: '2026-09-06', payee: 'Mall', amount: 30, account: 'chk', status: 'posted',
    envelope_splits: [{ envelope_id: 'food', amount: 10.1 }, { envelope_id: 'fun', amount: 19.9 }] },
  { id: 'r1', type: 'expense', date: '2026-09-04', payee: 'Landlord', amount: 50.25, envelope_id: 'rent', account: 'chk', status: 'posted' },
  { id: 'e2', type: 'expense', date: '2026-09-10', payee: 'Late', amount: 12, envelope_id: 'food', account: 'chk', status: 'scheduled' },
  { id: 'e3', type: 'expense', date: '2026-09-20', payee: 'Soon', amount: 30, envelope_id: 'food', account: 'chk', status: 'scheduled' },
  { id: 'e4', type: 'expense', date: '2026-09-25', payee: 'Ahead', amount: 7, envelope_id: 'food', account: 'chk', status: 'posted' },
];
const ALL = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };
const ITEMS = [
  { id: 'bi-food', kind: 'expense', description: 'Food', envelope_id: 'food', default_amount: -300, include: true, monthly_schedule: ALL },
  { id: 'bi-rent', kind: 'expense', description: 'Rent', envelope_id: 'rent', default_amount: -800.5, include: true, monthly_schedule: ALL },
];

// The sums as the page made them before (review.js, renderReview): the nine
// columns over a set of rows, unrounded, formatted.
const COLS = ['balance', 'actual', 'scheduled', 'planned', 'projected', 'D', 'required', 'startNext', 'surplus'];
const sumRows = (rows) => Object.fromEntries(COLS.map(k => [k, rows.reduce((a, r) => a + r[k], 0)]));
const totalCells = (s) => [
  `${fmt(s.balance)}${fmt(s.projected)}`, fmt(s.actual), `${fmt(s.scheduled)}${fmt(s.planned)}`,
  fmt(s.D), `${fmt(s.required)}${fmt(s.startNext)}`, fmt(s.surplus),
].map(c => c.replace(/\s+/g, ' '));
// A detail section's total as the page summed it: the stored amounts, unsigned.
const sectionSum = (rows) => rows.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0);

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  // jsdom has no CSS.escape; the page builds a row selector with it.
  vi.stubGlobal('CSS', { escape: (s) => s });
  resetState({ transactions: structuredClone(FIXTURE) });
  state.budgetItems = structuredClone(ITEMS);
  mountHosts();
});

afterEach(() => {
  document.querySelectorAll('.review-consolidate-pop').forEach(el => el.remove());
  vi.restoreAllMocks();
});

const review = (month = '2026-09') => session.query('review.month', { month }).value;

describe('Review sums equal the page\'s own composition', () => {
  it('subtotals each category and totals the footer', async () => {
    await render(root());
    const rows = review().rows;
    const cats = [...new Set(rows.map(r => r.category))];
    expect(cats).toEqual(['housing', 'living']);
    expect(catRows().map(tr => cells(tr)[0])).toEqual(cats);
    cats.forEach((cat, i) => {
      expect(cells(catRows()[i]).slice(1)).toEqual(totalCells(sumRows(rows.filter(r => r.category === cat))));
    });
    expect(cells(root().querySelector('tfoot tr')).slice(1)).toEqual(totalCells(sumRows(rows)));
  });

  it('shows the Booked Unallocated in the pill on the current month, and hides it on a later one', async () => {
    await render(root());
    const u = computeUnallocated(computeAccountBalances(state.accounts, state.transactions), computeEnvelopeBalances(state.transactions), state.accounts);
    expect(u).toBeGreaterThan(0.005);
    expect(pill().hidden).toBe(false);
    expect(pill().classList.contains('is-pos')).toBe(true);
    expect(pill().textContent).toContain(t('lens.booked') + ' · ' + t('review.underAssigned')(fmt(u)));
    expect(pill().textContent).toContain(t('overview.poolBasis')(t('lens.today')));

    setValue(root().querySelector('#month-picker'), '2026-10', ['change']);
    expect(pill().hidden).toBe(true);
    expect(pill().textContent).toBe('');
  });

  it('offers each row\'s surplus as the consolidate amount, and its booked balance as available', async () => {
    await render(root());
    const rows = review().rows;
    const food = rows.find(r => r.envelope_id === 'food');
    const btn = root().querySelector('button[data-consolidate-id="food"]');
    expect(btn.dataset.defaultAmount).toBe(String(Math.round(-food.surplus * 100) / 100));
    btn.click();
    const pop = document.querySelector('.review-consolidate-pop');
    // Booked over every row, the future-dated and scheduled ones too: not the row's as-of-now balance.
    const available = computeEnvelopeBalances(state.transactions).get('food') ?? 0;
    expect(available).not.toBe(food.balance);
    expect(pop.textContent).toContain(t('review.consolidateAvailable')(fmt(available)));
  });

  it('counts the envelopes below zero in the close-month confirmation', async () => {
    // Only an ended month can be closed: the same rows a month earlier, and
    // August reviewed as it stood on the 31st.
    state.transactions = structuredClone(FIXTURE).map(tx => ({ ...tx, date: tx.date.replace('2026-09', '2026-08') }));
    await render(root());
    setValue(root().querySelector('#month-picker'), '2026-08', ['change']);
    const negative = review('2026-08').rows.filter(r => r.balance < -0.005).length;
    expect(negative).toBe(1);
    root().querySelector('#review-close-month').click();
    await flush();
    expect(topOverlay().textContent).toContain(t('review.closeConfirm')(fmtMonthLang('2026-08'), negative));
  });

  it('totals each detail section over its rows\' stored amounts', async () => {
    await render(root());
    root().querySelector('a.env-link[data-envelope-id="food"]').click();
    await flush();
    const heads = [...root().querySelectorAll('tr[data-env-detail-for="food"] td > div > div:first-child')]
      .map(h => h.textContent);
    const detail = session.query('review.month', { month: '2026-09', envelope: 'food' }).value.detail;
    // Actual: the income, the expense and the whole split (30, not the 10.10 share).
    expect(sectionSum(detail.actual)).toBe(500 + 40 + 30);
    expect(heads).toEqual([
      ['review.actuals', detail.actual], ['review.overdue', detail.overdue],
      ['review.scheduled', detail.coming], ['review.future', detail.future],
    ].map(([key, rows]) => `${t(key)} · ${rows.length}${fmt(sectionSum(rows))}`));
  });
});

describe('Review shows the answer\'s figures', () => {
  // The real answer with every page sum replaced: what renders is the answer's.
  function doctor() {
    const real = session.query.bind(session);
    return vi.spyOn(session, 'query').mockImplementation((name, input) => {
      const r = real(name, input);
      if (name === 'review.month' && r.ok) {
        const v = structuredClone(r.value);
        v.totals = { ...v.totals, balance: 1111, surplus: 2222 };
        v.categoryTotals = v.categoryTotals.map(c => ({ ...c, totals: { ...c.totals, actual: 333 } }));
        v.negativeCount = 7;
        v.rows = v.rows.map(row => (row.envelope_id === 'food' ? { ...row, consolidateDelta: 44.5, available: 555 } : row));
        if (v.detail) v.detail.totals = { ...v.detail.totals, actual: 666 };
        return { ok: true, value: v };
      }
      if (name === 'balances' && r.ok) return { ok: true, value: { ...r.value, unallocated: input.lens === 'today' ? 13 : -77 } };
      return r;
    });
  }

  it('renders the footer, subtotals, consolidate amount, available, negative count, detail totals and pill from the answers', async () => {
    const q = doctor();
    await render(root());
    expect(q.mock.calls).toContainEqual(['balances', { lens: 'booked' }]);
    expect(pill().textContent).toContain(t('overview.poolBasis')(t('lens.today')) + ': ' + fmt(13));
    expect(pill().classList.contains('is-neg')).toBe(true);
    expect(pill().textContent).toContain(t('lens.booked') + ' · ' + t('review.overAssigned')(fmt(77)));

    const foot = cells(root().querySelector('tfoot tr'));
    const norm = (text) => text.replace(/\s+/g, ' ');
    expect(foot[1].startsWith(norm(fmt(1111)))).toBe(true);
    expect(foot[6]).toBe(norm(fmt(2222)));
    for (const tr of catRows()) expect(cells(tr)[2]).toBe(norm(fmt(333)));

    const btn = root().querySelector('button[data-consolidate-id="food"]');
    expect(btn.dataset.defaultAmount).toBe('44.5');
    btn.click();
    expect(document.querySelector('.review-consolidate-pop').textContent).toContain(t('review.consolidateAvailable')(fmt(555)));
    document.querySelectorAll('.review-consolidate-pop').forEach(el => el.remove());

    // The confirmation for an ended month (the current one cannot be closed).
    setValue(root().querySelector('#month-picker'), '2026-08', ['change']);
    root().querySelector('#review-close-month').click();
    await flush();
    expect(topOverlay().textContent).toContain(t('review.closeConfirm')(fmtMonthLang('2026-08'), 7));
    topOverlay().querySelector('button:not(.btn-accent)').click();
    await flush();
    setValue(root().querySelector('#month-picker'), '2026-09', ['change']);

    root().querySelector('a.env-link[data-envelope-id="food"]').click();
    await flush();
    const head = root().querySelector('tr[data-env-detail-for="food"] td > div > div:first-child');
    expect(head.textContent).toBe(`${t('review.actuals')} · 3${fmt(666)}`);
  });

  it('groups rows without a category under one subtotal, null and undefined alike', async () => {
    const real = session.query.bind(session);
    const q = vi.spyOn(session, 'query').mockImplementation((name, input) => {
      const r = real(name, input);
      if (name === 'review.month' && r.ok) {
        const v = structuredClone(r.value);
        v.rows = v.rows.map((row, i) => ({ ...row, category: i % 2 ? null : undefined }));
        v.categoryTotals = [{ category: null, totals: { ...v.totals, actual: 321 } }];
        return { ok: true, value: v };
      }
      return r;
    });
    try {
      await render(root());
      expect(catRows()).toHaveLength(1);
      expect(cells(catRows()[0])[2]).toBe(fmt(321).replace(/\s+/g, ' '));
    } finally {
      q.mockRestore();
    }
  });
});

// @vitest-environment jsdom
// The Review page renders the review.month query: its footer carries the
// answer's totals, a failed query shows the empty state without throwing, and
// opening an envelope's detail row classifies its rows from the query and
// leaves no `__overdue` property on the real transactions.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { render } from '../js/pages/review.js';
import { fmt } from '../js/utils.js';
import { t } from '../js/ui/i18n.js';
import { session, state, resetState, mountHosts, flush, setValue } from './_fakes/pageApp.js';

const root = () => document.getElementById('app-root');
const cells = (tr) => [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/\s+/g, ' ').trim());

// The fake clock is 15 Sep 2026. Food has a posted expense, an overdue
// scheduled row (10 Sep), a coming scheduled row (20 Sep) and a posted row
// dated ahead (25 Sep).
const FIXTURE = [
  { id: 'i1', type: 'income', date: '2026-09-01', payee: 'Job', amount: 500, envelope_id: 'food', account: 'chk', status: 'posted' },
  { id: 'e1', type: 'expense', date: '2026-09-05', payee: 'Shop', amount: 40, envelope_id: 'food', account: 'chk', status: 'posted' },
  { id: 'e2', type: 'expense', date: '2026-09-10', payee: 'Late', amount: 12, envelope_id: 'food', account: 'chk', status: 'scheduled' },
  { id: 'e3', type: 'expense', date: '2026-09-20', payee: 'Soon', amount: 30, envelope_id: 'food', account: 'chk', status: 'scheduled' },
  { id: 'e4', type: 'expense', date: '2026-09-25', payee: 'Ahead', amount: 7, envelope_id: 'food', account: 'chk', status: 'posted' },
];

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  // jsdom has no CSS.escape; the page builds a row selector with it.
  vi.stubGlobal('CSS', { escape: (s) => s });
  resetState({ transactions: structuredClone(FIXTURE) });
  mountHosts();
  await render(root());
});

describe('Review page over review.month', () => {
  it('renders the same totals as the query answer', () => {
    const answer = session.query('review.month', { month: '2026-09' });
    expect(answer.ok).toBe(true);
    const rows = answer.value.rows;
    const sum = (k) => rows.reduce((a, r) => a + r[k], 0);

    const foot = cells(root().querySelector('tfoot tr'));
    expect(foot[1]).toBe(`${fmt(sum('balance'))}${fmt(sum('projected'))}`);
    expect(foot[2]).toBe(fmt(sum('actual')));
    expect(foot[3]).toBe(`${fmt(sum('scheduled'))}${fmt(sum('planned'))}`);
    expect(foot[4]).toBe(fmt(sum('D')));
    expect(foot[5]).toBe(`${fmt(sum('required'))}${fmt(sum('startNext'))}`);
    expect(foot[6]).toBe(fmt(sum('surplus')));

    const food = rows.find(r => r.envelope_id === 'food');
    const foodCells = cells(root().querySelector('tr[data-env-row="food"]'));
    expect(foodCells[1]).toBe(`${fmt(food.balance)}${fmt(food.projected)}`);
    expect(foodCells[2]).toBe(fmt(food.actual));
  });

  it('shows the empty state, and does not throw, when the query fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const q = vi.spyOn(session, 'query').mockReturnValue({ ok: false, error: { code: 'bad_input', params: {} } });
    const picker = root().querySelector('#month-picker');
    expect(() => setValue(picker, '2026-10', ['change'])).not.toThrow();
    expect(root().querySelector('#review-content .empty-state')).toBeTruthy();
    expect(err).toHaveBeenCalled();
    q.mockRestore();
    err.mockRestore();
  });

  it('lists the envelope\'s rows by kind and leaves no __overdue on state.transactions', async () => {
    root().querySelector('a.env-link[data-envelope-id="food"]').click();
    await flush();
    const detail = root().querySelector('tr[data-env-detail-for="food"]');
    expect(detail).toBeTruthy();
    const text = detail.textContent;
    for (const payee of ['Shop', 'Late', 'Soon', 'Ahead']) expect(text).toContain(payee);
    // The overdue pill belongs to the one overdue row.
    const pills = [...detail.querySelectorAll('span')].filter(s => s.textContent === t('review.overdue'));
    expect(pills).toHaveLength(1);
    expect(pills[0].parentElement.textContent).toContain('Late');

    for (const tx of state.transactions) expect('__overdue' in tx).toBe(false);
  });
});

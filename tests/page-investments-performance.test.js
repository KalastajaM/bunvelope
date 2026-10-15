// @vitest-environment jsdom
import { beforeEach, it, expect, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/pages/edit-tx.js', () => ({ openEditTx: vi.fn() }));
import { openEditTx } from '../js/pages/edit-tx.js';
import { state, session, resetState, mountHosts, flush } from './_fakes/pageApp.js';
import { buildPerformanceCard } from '../js/pages/investments-performance.js';
import { t } from '../js/ui/i18n.js';

beforeEach(() => {
  resetState(); mountHosts(); vi.clearAllMocks();
  state.accounts = [{ id: 'b', name: 'Broker', type: 'investment' }];
  state.transactions = [{ id: 't', type: 'investment_transfer', direction: 'buy', to_account: 'b', date: '2025-12-01', symbol: 'ABC', units: 10, amount: 100, posted: true }];
  state.meta = { schemaVersion: 8, investments: { prices: { ABC: { price: 12, asOf: '2026-09-15' } }, priceHistory: { ABC: [{ date: '2025-12-31', price: 10 }] } } };
});
const mount = () => { const card = buildPerformanceCard(); document.body.append(card); return card; };
it('shows personal return and gain separately and validates a changed period', () => {
  const card = mount(); const summary = card.querySelector('[aria-live]');
  expect(summary.textContent).toContain('20%');
  expect(summary.textContent).toContain(t('performance.gain'));
  const form = card.querySelector('form'); const dates = form.querySelectorAll('input');
  dates[0].value = '2026-09-16';
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  expect(dates[1].validationMessage).toBe(t('performance.invalidPeriod'));
  expect(summary.textContent).not.toContain('20%');
});
it('keeps missing history visible and saves an opening price via the session', async () => {
  state.meta.investments.priceHistory.ABC = [];
  const card = mount(); const summary = card.querySelector('[aria-live]');
  expect(summary.textContent).toContain(t('performance.incomplete'));
  expect(summary.textContent).not.toContain('20%');
  const priceForm = card.querySelectorAll('form')[1]; const inputs = priceForm.querySelectorAll('input');
  inputs[0].value = 'ABC'; inputs[1].value = '2025-12-31'; inputs[2].value = '10';
  priceForm.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  expect(state.meta.investments.prices.ABC).toEqual({ price: 12, asOf: '2026-09-15' });
  expect(summary.textContent).toContain('20%');
  expect(summary.textContent).not.toContain(t('performance.incomplete'));
  expect(state.meta.investments.priceHistory.ABC).toContainEqual({ date: '2025-12-31', price: 10 });
  expect([...inputs].map(input => input.value)).toEqual(['', '', '']);
  expect(card.querySelector('[role=status]').textContent).toContain('ABC');
  expect(card.querySelector('[role=status]').textContent).toContain('2025-12-31');
});

it('prefills the requested boundary and clears stale price input without writing', () => {
  state.meta.investments.priceHistory.ABC = [];
  const card = mount();
  const form = card.querySelectorAll('form')[1];
  const [symbol, date, price] = form.querySelectorAll('input');
  price.value = '999';
  const action = [...card.querySelectorAll('button')].find(b => b.textContent === t('performance.recordPrice'));
  action.click();
  expect(symbol.value).toBe('ABC');
  expect(date.value).toBe('2025-12-31');
  expect(price.value).toBe('');
  expect(form.closest('details').open).toBe(true);
  expect(document.activeElement).toBe(price);
  expect(state.meta.investments.priceHistory.ABC).toEqual([]);
});

it('groups repeated root issues and preserves dependent oversold details', () => {
  state.transactions = [
    { ...state.transactions[0], id: 'a', units: null },
    { ...state.transactions[0], id: 'b', units: null },
    { ...state.transactions[0], id: 'c', direction: 'sell', from_account: 'b', units: 2 },
  ];
  const card = mount();
  const group = card.querySelector('.performance-coverage-group');
  expect(group.querySelector('h3').textContent).toBe('Broker · ABC');
  expect(group.textContent.split(t('performance.issues.missing_units'))).toHaveLength(2);
  expect(group.textContent).toContain(t('performance.occurrences')(2));
  const related = [...group.querySelectorAll('details')].find(d => d.querySelector('summary').textContent === t('performance.relatedChecks'));
  expect(related.open).toBe(false);
  expect(related.textContent).toContain(t('performance.issues.oversold_units'));
  expect(card.textContent).toContain(t('performance.incomplete'));
});

it('keeps report filters across editor rerenders but resets for a different budget', () => {
  const card = mount();
  const form = card.querySelector('form');
  form.querySelector('input').value = '2026-02-01';
  form.querySelector('select').value = 'b';
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  const rebuilt = buildPerformanceCard();
  expect(rebuilt.querySelector('input').value).toBe('2026-02-01');
  expect(rebuilt.querySelector('select').value).toBe('b');
  resetState();
  expect(buildPerformanceCard().querySelector('input').value).toBe('2026-01-01');
});

it('does not save a stale price form after switching budgets', async () => {
  const card = mount();
  const form = card.querySelectorAll('form')[1];
  const inputs = form.querySelectorAll('input');
  inputs[0].value = 'ABC'; inputs[1].value = '2025-12-31'; inputs[2].value = '10';
  resetState();
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await flush();
  expect(state.meta).toEqual({});
});

it('opens the exact affected trade when two records share an account, symbol and date', async () => {
  state.transactions = [
    { ...state.transactions[0], id: 'first', payee: 'First trade', units: null },
    { ...state.transactions[0], id: 'second', payee: 'Second trade', units: null },
  ];
  const card = mount();
  const buttons = [...card.querySelectorAll('button')].filter(b => b.textContent === t('performance.openTransaction'));
  expect(buttons).toHaveLength(2);
  buttons[1].click();
  await vi.waitFor(() => expect(openEditTx).toHaveBeenCalled());
  expect(openEditTx.mock.calls[0][0].id).toBe('second');
  // An editor's successful-save callback re-queries the live data.
  state.transactions = state.transactions.map(tx => ({ ...tx, units: 5 }));
  openEditTx.mock.calls[0][1].onAfterChange();
  expect(card.textContent).not.toContain(t('performance.issues.missing_units'));
  expect(card.textContent).toContain('20%');
});

it('retains the warning and entered price after a refused save', async () => {
  state.meta.investments.priceHistory.ABC = [];
  const card = mount();
  const form = card.querySelectorAll('form')[1];
  const inputs = form.querySelectorAll('input');
  inputs[0].value = 'ABC'; inputs[1].value = '2025-12-31'; inputs[2].value = '10';
  const dispatch = vi.spyOn(session, 'dispatch').mockResolvedValueOnce({ ok: false, error: { code: 'budget_loading' } });
  try {
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(card.textContent).toContain(t('performance.incomplete'));
    expect(inputs[2].value).toBe('10');
    expect(form.querySelector('button').disabled).toBe(false);
    expect(state.meta.investments.priceHistory.ABC).toEqual([]);
  } finally { dispatch.mockRestore(); }
});

it('explains an earlier quote and offers the valuation date rather than the quote date', () => {
  state.meta.investments.prices.ABC.asOf = '2026-09-14';
  const card = mount();
  const group = card.querySelector('.performance-coverage-group');
  expect(group.textContent).toContain(t('performance.earlierPriceHelp'));
  expect(group.textContent).toContain(t('performance.earlierPriceUsed')(t('performance.closingValue'), '2026-09-15', '2026-09-14'));
  expect(group.textContent).not.toContain(t('performance.relatedChecks'));
  group.querySelector('button').click();
  const inputs = card.querySelectorAll('form')[1].querySelectorAll('input');
  expect(inputs[0].value).toBe('ABC');
  expect(inputs[1].value).toBe('2026-09-15');
});

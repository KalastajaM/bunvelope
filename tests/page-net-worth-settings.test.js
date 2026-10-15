// @vitest-environment jsdom
// Simulation saves leave live account settings untouched.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/state/meta-writes.js', () => ({ updateMeta: vi.fn() }));
vi.mock('../js/ui/dialog.js', () => ({ promptDialog: vi.fn(async () => 'My simulation'), confirmDialog: vi.fn(async () => true), alertDialog: vi.fn() }));
import { updateMeta } from '../js/state/meta-writes.js';
import { promptDialog, confirmDialog } from '../js/ui/dialog.js';
import { render } from '../js/pages/net-worth.js';
import { t } from '../js/ui/i18n.js';
import { saveChartPrefs } from '../js/ui/charts/persist.js';
import { state, writeBatch, resetState, mountHosts, flush, setValue, toastTexts } from './_fakes/pageApp.js';

const root = () => document.getElementById('app-root');
const growthIn = (name) => root().querySelector(`input[aria-label="${t('netWorth.growthLabel')(name)}"]`);
const contribIn = (name) => root().querySelector(`input[aria-label="${t('netWorth.contributionLabel')(name)}"]`);
const edit = (el, v) => setValue(el, v, ['input']);
const action = (el, which) => el.closest('.net-worth-edit').querySelector(`[data-action="${which}"]`);
const all = which => root().querySelector(`[data-action="${which}-all"]`);
const change = (el, v) => {
  const label = el.getAttribute('aria-label');
  setValue(el, v, ['change']);
  action(root().querySelector(`input[aria-label="${label}"]`), 'save').click();
};
const savedAcct = id => state.meta.netWorthSimulations?.at(-1)?.accounts.find(a => a.id === id) || {};
const persist = async (_state, patch) => { state.meta = await patch(state.meta); return true; };
const accountWrites = () => writeBatch.mock.calls.filter(c => c[1].some(i => i.filename === 'accounts.json'));

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  resetState();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  updateMeta.mockReset().mockImplementation(persist);
  promptDialog.mockReset().mockResolvedValue('My simulation');
  confirmDialog.mockReset().mockResolvedValue(true);
  mountHosts();
  await render(root());
});

describe('net worth growth and contribution settings', () => {
  it('a typed growth rate is saved in a simulation, rounded to cents', async () => {
    change(growthIn('Savings'), '4.567');
    await flush();
    expect(savedAcct('sav').expectedGrowth).toBe(4.57);
    expect(state.accounts.find(a => a.id === 'sav')).not.toHaveProperty('expectedGrowth');
    expect(accountWrites()).toHaveLength(0);
    expect(savedAcct('chk')).not.toHaveProperty('expectedGrowth');
  });

  it('a growth or contribution edit changes only that field: stored investment tiers stay', async () => {
    const fund = { id: 'fund', name: 'Fund', type: 'investment', initialBalance: 1000, interestTiers: [{ rate: 2 }], interestPayout: 'monthly', interestFirstMonth: '2024-01' };
    state.accounts = [...state.accounts, fund];
    await render(root());
    change(growthIn('Fund'), '5');
    await flush();
    expect(savedAcct('fund')).toEqual({ id: 'fund', expectedGrowth: 5 });
    change(contribIn('Fund'), '40');
    await flush();
    expect(savedAcct('fund')).toEqual({ id: 'fund', expectedGrowth: 5, plannedMonthly: 40 });
    change(growthIn('Fund'), '');
    await flush();
    expect(savedAcct('fund')).toEqual({ id: 'fund', plannedMonthly: 40 });
    expect(state.accounts.find(a => a.id === 'fund')).toEqual(fund);
  });

  it('a comma decimal parses like every amount', async () => {
    change(growthIn('Savings'), '1,5');
    await flush();
    expect(savedAcct('sav').expectedGrowth).toBe(1.5);
  });

  it('a typed monthly contribution is saved as plannedMonthly', async () => {
    change(contribIn('Checking'), '125');
    await flush();
    expect(savedAcct('chk').plannedMonthly).toBe(125);
  });

  it('clearing the field removes the setting', async () => {
    change(growthIn('Savings'), '3');
    await flush();
    expect(savedAcct('sav').expectedGrowth).toBe(3);
    change(growthIn('Savings'), '  ');
    await flush();
    expect(updateMeta).toHaveBeenCalledTimes(2);
    expect(savedAcct('sav')).not.toHaveProperty('expectedGrowth');
    expect(state.accounts.find(a => a.id === 'sav')).not.toHaveProperty('expectedGrowth');
  });

  it('an unreadable value writes nothing', async () => {
    change(growthIn('Savings'), 'abc');
    await flush();
    expect(accountWrites()).toHaveLength(0);
  });

  it('a failed save is reported, state.accounts is untouched and the draft stays available to retry', async () => {
    const before = state.accounts;
    updateMeta.mockImplementationOnce(async () => { throw new Error('offline'); });
    change(growthIn('Savings'), '6');
    await flush();
    expect(toastTexts().some(x => x.includes('offline'))).toBe(true);
    expect(state.accounts).toBe(before);
    expect(state.accounts.find(a => a.id === 'sav')).not.toHaveProperty('expectedGrowth');
    expect(growthIn('Savings').value).toBe('6');
    expect(action(growthIn('Savings'), 'save').disabled).toBe(false);
  });

  it('saving locks controls until the write settles and a failure keeps the draft', async () => {
    let fail;
    updateMeta.mockImplementationOnce(() => new Promise((_, rej) => { fail = rej; }));
    change(growthIn('Savings'), '6');
    await flush();
    expect(contribIn('Checking').disabled).toBe(true);
    expect(all('save').disabled).toBe(true);
    fail(new Error('offline'));
    await flush();
    expect(toastTexts().some(x => x.includes('offline'))).toBe(true);
    expect(growthIn('Savings').value).toBe('6');
    expect(contribIn('Checking').disabled).toBe(false);
    action(growthIn('Savings'), 'save').click();
    await flush();
    expect(savedAcct('sav').expectedGrowth).toBe(6);
    expect(all('save').disabled).toBe(true);
  });

  it('typing previews without writing, preserves the caret, and reset restores the saved value', async () => {
    expect(all('save').disabled).toBe(true);
    const input = growthIn('Savings');
    input.focus();
    input.value = '4,5';
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
    expect(accountWrites()).toHaveLength(0);
    expect(document.activeElement).toBe(growthIn('Savings'));
    expect(growthIn('Savings').selectionStart).toBe(2);
    expect(growthIn('Savings').value).toBe('4,5');
    expect(action(growthIn('Savings'), 'save').disabled).toBe(false);
    action(growthIn('Savings'), 'reset').click();
    expect(growthIn('Savings').value).toBe('');
    expect(all('save').disabled).toBe(true);
    expect(accountWrites()).toHaveLength(0);
  });

  it('save all commits both fields and collapsed groups atomically', async () => {
    edit(growthIn('Savings'), '4');
    edit(contribIn('Savings'), '25');
    edit(contribIn('Checking'), '50');
    const group = root().querySelector('[data-account-type="savings"]');
    group.click();
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(group.textContent).toContain(t('netWorth.unsaved')(2));
    expect(growthIn('Savings').closest('tr').hidden).toBe(true);
    all('save').click();
    await flush();
    expect(updateMeta).toHaveBeenCalledTimes(1);
    expect(accountWrites()).toHaveLength(0);
    expect(savedAcct('sav')).toMatchObject({ expectedGrowth: 4, plannedMonthly: 25 });
    expect(savedAcct('chk').plannedMonthly).toBe(50);
    expect(all('save').disabled).toBe(true);
    expect(root().querySelector('[data-account-type="savings"]').getAttribute('aria-expanded')).toBe('false');
  });

  it('reset all restores the latest saved values and clears invalid input too', async () => {
    change(growthIn('Savings'), '3');
    await flush();
    edit(growthIn('Savings'), '5');
    edit(contribIn('Checking'), '12oops');
    expect(contribIn('Checking').getAttribute('aria-invalid')).toBe('true');
    expect(all('save').disabled).toBe(true);
    expect(all('reset').disabled).toBe(false);
    all('reset').click();
    expect(growthIn('Savings').value).toBe('3');
    expect(contribIn('Checking').value).toBe('');
    expect(all('reset').disabled).toBe(true);
    expect(updateMeta).toHaveBeenCalledTimes(1);
    expect(accountWrites()).toHaveLength(0);
  });

  it('saving one field leaves the other dirty; returning to the saved value clears it', async () => {
    edit(growthIn('Savings'), '3');
    edit(contribIn('Savings'), '25');
    action(growthIn('Savings'), 'save').click();
    await flush();
    expect(savedAcct('sav').expectedGrowth).toBe(3);
    expect(savedAcct('sav')).not.toHaveProperty('plannedMonthly');
    expect(action(growthIn('Savings'), 'save').disabled).toBe(true);
    expect(action(contribIn('Savings'), 'save').disabled).toBe(false);
    edit(contribIn('Savings'), '');
    expect(all('save').disabled).toBe(true);
  });

  it('drafts survive a page repaint but cannot save into a different budget session', async () => {
    edit(growthIn('Savings'), '4');
    await render(root());
    expect(growthIn('Savings').value).toBe('4');
    const { beginBudgetSession } = await import('../js/state/budget-session.js');
    beginBudgetSession();
    all('save').click();
    await flush();
    expect(accountWrites()).toHaveLength(0);
    await render(root());
    expect(growthIn('Savings').value).toBe('');
    expect(all('save').disabled).toBe(true);
  });
  it('save completion updates the latest page instance after navigating back', async () => {
    let release;
    updateMeta.mockImplementationOnce((_state, patch) => new Promise(resolve => { release = async () => { await persist(state, patch); resolve(true); }; }));
    change(growthIn('Savings'), '4');
    await flush();
    await render(root());
    expect(growthIn('Savings').disabled).toBe(true);
    await release();
    await flush();
    expect(growthIn('Savings').disabled).toBe(false);
    expect(all('save').disabled).toBe(true);
    expect(growthIn('Savings').value).toBe('4');
  });

  it('a failed Save all keeps all drafts and the saved accounts unchanged', async () => {
    const before = state.accounts;
    edit(growthIn('Savings'), '3');
    edit(contribIn('Checking'), '25');
    updateMeta.mockImplementationOnce(async () => { throw new Error('offline'); });
    all('save').click();
    await flush();
    expect(state.accounts).toBe(before);
    expect(growthIn('Savings').value).toBe('3');
    expect(contribIn('Checking').value).toBe('25');
    expect(all('save').disabled).toBe(false);
    all('reset').click();
  });

  it('budget defaults restore live plan contributions as drafts, rather than copying a fixed amount', async () => {
    const monthly = Object.fromEntries(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(m => [m, true]));
    const base = { include: true, as_schedule: true, as_schedule_since: '2026-09-01', monthly_schedule: monthly, payment_day: 25, schedule_day_type: 'exact' };
    state.budgetItems = [
      { ...base, id: 'pay', kind: 'income', account_id: 'chk', default_amount: 3000 },
      { ...base, id: 'food', kind: 'expense', account_id: 'chk', envelope_id: 'food', default_amount: -1000 },
      { ...base, id: 'transfer', kind: 'account_transfer', account_id: 'chk', to_account_id: 'sav', default_amount: -200 },
    ];
    state.accounts = state.accounts.map(a => ({ ...a, plannedMonthly: 999 }));
    saveChartPrefs('nw-projection', { contributionSource: 'history' });
    const { beginBudgetSession } = await import('../js/state/budget-session.js');
    beginBudgetSession();
    await render(root());
    root().querySelector('[data-action="use-defaults"]').click();
    expect(contribIn('Checking').value).toBe('');
    expect(contribIn('Checking').placeholder).toMatch(/^1\s800$/);
    expect(contribIn('Savings').placeholder).toBe('200');
    expect([...root().querySelectorAll('.net-worth-source .btn')].find(b => b.textContent === t('netWorth.sourcePlan')).getAttribute('aria-pressed')).toBe('true');
    expect(accountWrites()).toHaveLength(0);
    expect(all('save').disabled).toBe(false);
    all('save').click();
    await flush();
    expect(savedAcct('chk')).not.toHaveProperty('plannedMonthly');
    expect(savedAcct('sav')).not.toHaveProperty('plannedMonthly');
    expect(state.accounts.every(a => a.plannedMonthly === 999)).toBe(true);
    state.budgetItems = state.budgetItems.map(item => item.id === 'pay' ? { ...item, default_amount: 3500 } : item);
    await render(root());
    expect(contribIn('Checking').placeholder).toMatch(/^2\s300$/);
  });

});

const configAction = key => [...root().querySelectorAll('.net-worth-config-row button')].find(b => b.textContent === t(`netWorth.${key}`));
const chooseConfig = async id => { setValue(root().querySelector('#nw-simulation-config'), id, ['change']); await flush(); };

describe('named simulations', () => {
  it('creates, duplicates, renames and deletes independently of real accounts', async () => {
    const accounts = structuredClone(state.accounts);
    configAction('newSimulation').click();
    await flush();
    expect(root().querySelector('#nw-simulation-config').value).toBe('__draft__');
    edit(growthIn('Savings'), '5');
    all('save').click();
    await flush();
    const first = state.meta.netWorthSimulations[0];
    expect(first.name).toBe('My simulation');
    expect(all('save').disabled).toBe(true);
    promptDialog.mockResolvedValueOnce('Optimistic');
    configAction('duplicateSimulation').click();
    await flush();
    expect(state.meta.netWorthSimulations).toHaveLength(2);
    expect(state.meta.netWorthSimulations[1].id).not.toBe(first.id);
    expect(state.meta.netWorthSimulations[1].accounts).toEqual(first.accounts);
    promptDialog.mockResolvedValueOnce('Renamed');
    configAction('renameSimulation').click();
    await flush();
    expect(state.meta.netWorthSimulations[1].name).toBe('Renamed');
    edit(growthIn('Savings'), '7');
    all('save').click();
    await flush();
    expect(state.meta.netWorthSimulations[0].accounts[0].expectedGrowth).toBe(5);
    expect(state.meta.netWorthSimulations[1].accounts[0].expectedGrowth).toBe(7);
    configAction('deleteSimulation').click();
    await flush();
    expect(state.meta.netWorthSimulations).toEqual([first]);
    expect(root().querySelector('#nw-simulation-config').value).toBe('');
    expect(growthIn('Savings').value).toBe('');
    await chooseConfig(first.id);
    expect(growthIn('Savings').value).toBe('5');
    expect(state.accounts).toEqual(accounts);
    expect(accountWrites()).toHaveLength(0);
  });

  it('asks before discarding changes and keeps drafts when cancelled', async () => {
    change(growthIn('Savings'), '3');
    await flush();
    const id = state.meta.netWorthSimulations[0].id;
    edit(growthIn('Savings'), '5');
    confirmDialog.mockResolvedValueOnce(false);
    await chooseConfig('');
    expect(root().querySelector('#nw-simulation-config').value).toBe(id);
    expect(growthIn('Savings').value).toBe('5');
    await chooseConfig('');
    expect(growthIn('Savings').value).toBe('');
    await chooseConfig(id);
    expect(growthIn('Savings').value).toBe('3');
  });

  it('Actual budget clears legacy overrides and follows changing account rates', async () => {
    state.accounts = state.accounts.map(a => a.id === 'sav' ? { ...a, expectedGrowth: 9, plannedMonthly: 999, interestTiers: [{ rate: 2 }] } : a);
    const { beginBudgetSession } = await import('../js/state/budget-session.js');
    beginBudgetSession();
    await render(root());
    expect(growthIn('Savings').value).toBe('9');
    await chooseConfig('');
    expect(growthIn('Savings').value).toBe('');
    expect(growthIn('Savings').placeholder).toBe('2');
    expect(contribIn('Savings').value).toBe('');
    state.accounts = state.accounts.map(a => a.id === 'sav' ? { ...a, interestTiers: [{ rate: 3 }] } : a);
    await render(root());
    expect(growthIn('Savings').placeholder).toBe('3');
    await chooseConfig('previous-projection');
    root().querySelector('[data-action="use-defaults"]').click();
    expect(growthIn('Savings').value).toBe('');
    expect(growthIn('Savings').placeholder).toBe('3');
    expect(all('save').disabled).toBe(false);
    all('reset').click();
    expect(growthIn('Savings').value).toBe('9');
  });

  it('stores the contribution source in the configuration and restores it on switching', async () => {
    change(growthIn('Savings'), '3');
    await flush();
    const id = state.meta.netWorthSimulations[0].id;
    const source = key => [...root().querySelectorAll('.net-worth-source button')].find(b => b.textContent === t(`netWorth.${key}`));
    source('sourceHistory').click();
    expect(all('save').disabled).toBe(false);
    all('save').click();
    await flush();
    expect(state.meta.netWorthSimulations[0].contribution).toBe('history');
    await chooseConfig('');
    expect(source('sourcePlan').getAttribute('aria-pressed')).toBe('true');
    await chooseConfig(id);
    expect(source('sourceHistory').getAttribute('aria-pressed')).toBe('true');
  });
});

it('saved simulation assumptions remain visible without an unsaved label after saving',async()=>{
  change(growthIn('Savings'),'3');await flush();
  const evidence=root().querySelector('.forecast-readiness');
  expect(evidence.textContent).not.toContain(t('forecastReadiness.draft'));
  expect(evidence.textContent).toContain('3%');
  expect(accountWrites()).toHaveLength(0);
});

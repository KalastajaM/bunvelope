// @vitest-environment jsdom
// Add transaction, loan given, repayment: the hint under the form says what
// the borrower owes in interest so far this cycle. The figures are the loan
// given's terms from `accounts.detail`; the text must read exactly as when
// the page called the engine itself (add-tx.js before 4d:
// `loanGivenTerms(acct, state.transactions, appNow())`, rebuilt below at the
// same fixed clock).
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { openAddTx } from '../js/pages/add-tx.js';
import { loanGivenTerms } from '../js/engine.js';
import { t, fmtDateLang } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import { state, session, resetState, mountHosts, setValue, FIXED_NOW } from './_fakes/pageApp.js';

const form = () => document.querySelector('#sheet-host form');
const typeBtn = (v) => form().querySelector(`.tx-type-btn[data-value="${v}"]`);
const dirBtn = (v) => [...form().querySelectorAll('.tx-type-btn')].find(b => b.dataset.value === v);
const loanSelect = () => [...form().querySelectorAll('.field')].find(f => f.querySelector(':scope > label')?.textContent === t('addTx.lentAccount')).querySelector('select');
const hint = () => [...form().querySelectorAll('div.muted')].find(d => d.textContent.startsWith(t('addTx.lentHintLend')) || d.textContent.startsWith(t('addTx.lentHintRepay')));

/** The old page code's line (add-tx.js L713-720 before 4d), at the fixed clock. */
function oldRepayHint(id) {
  let text = t('addTx.lentHintRepay');
  const acct = state.accounts.find(a => a.id === id);
  const terms = acct ? loanGivenTerms(acct, state.transactions, new Date(FIXED_NOW)) : null;
  if (terms?.dueDate && terms.accrued > 0) {
    text += ` ${t('addTx.lentAccrued')(fmt(terms.accrued), fmtDateLang(terms.dueDate), fmt(terms.atDue))}`;
  }
  return text;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  resetState({
    transactions: [
      { id: 't1', type: 'account_transfer', date: '2026-03-01', amount: 2000, from_account: 'chk', to_account: 'lg', status: 'posted' },
      { id: 't2', type: 'account_transfer', date: '2026-06-01', amount: 1500, from_account: 'chk', to_account: 'lg2', status: 'posted' },
    ],
  });
  state.accounts = [
    ...state.accounts,
    { id: 'lg', name: 'Loan to Sam', type: 'loan_given', initialBalance: 0, loanStart: '2026-03-01', loanEnd: '2028-02-29', interestPayout: 'yearly', interestRates: [{ from: '2026-03-01', rate: 4 }] },
    { id: 'lg2', name: 'Loan to Kim', type: 'loan_given', initialBalance: 0, loanStart: '2026-06-01', interestPayout: 'quarterly', interestTiers: [{ rate: 3 }] },
    { id: 'lg3', name: 'Loan to Ann', type: 'loan_given', initialBalance: 0 },
  ];
  mountHosts();
});

describe('add loan given: the repayment hint', () => {
  it('reads the picked loan given\'s terms from accounts.detail', () => {
    const spy = vi.spyOn(session, 'query');
    openAddTx();
    typeBtn('loan_given').click();
    dirBtn('repay').click();
    const asked = spy.mock.calls.filter(c => c[0] === 'accounts.detail');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.at(-1)[1]).toEqual({ accounts: [loanSelect().value], date: '2026-09-15' });
  });

  it('shows the interest accrued this cycle, as the old code did, for each loan given', () => {
    openAddTx();
    typeBtn('loan_given').click();
    dirBtn('repay').click();
    for (const id of ['lg', 'lg2', 'lg3']) {
      setValue(loanSelect(), id, ['change']);
      expect(hint().textContent).toBe(oldRepayHint(id));
    }
    // Not vacuous: two of the three carry the accrued line, the one without terms does not.
    expect(oldRepayHint('lg')).not.toBe(t('addTx.lentHintRepay'));
    expect(oldRepayHint('lg2')).not.toBe(t('addTx.lentHintRepay'));
    expect(oldRepayHint('lg3')).toBe(t('addTx.lentHintRepay'));
  });

  it('lending shows the plain hint and asks nothing', () => {
    const spy = vi.spyOn(session, 'query');
    openAddTx();
    typeBtn('loan_given').click();
    expect(hint().textContent).toBe(t('addTx.lentHintLend'));
    expect(spy.mock.calls.filter(c => c[0] === 'accounts.detail')).toHaveLength(0);
  });

  it('a failed accounts.detail leaves the plain repayment hint, without the accrued line', () => {
    const real = session.query.bind(session);
    vi.spyOn(session, 'query').mockImplementation((name, input) => (
      name === 'accounts.detail' ? { ok: false, error: { code: 'bad_input', params: {} } } : real(name, input)));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    openAddTx();
    typeBtn('loan_given').click();
    dirBtn('repay').click();
    setValue(loanSelect(), 'lg', ['change']);
    expect(oldRepayHint('lg')).not.toBe(t('addTx.lentHintRepay'));
    expect(hint().textContent).toBe(t('addTx.lentHintRepay'));
  });
});

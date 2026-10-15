// @vitest-environment jsdom
// The prompt dialog's two writers: a file attached in the dialog (read,
// categorized, reviewed, approved) and a proposal the agent made (approved in
// its card). Both record the approved rows with one transaction.import through
// the session (the real browser session over the fake state in
// _fakes/pageApp.js), so these tests assert on state.transactions and the
// session's writeBatch. The model calls are mocked: the agent loop returns a
// canned proposal and the categorizer a canned assignment.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
vi.mock('../js/ai/client.js', async (importOriginal) => ({
  ...(await importOriginal()),
  isAiAvailable: vi.fn(() => true),
}));
vi.mock('../js/ai/categorize.js', async (importOriginal) => ({
  ...(await importOriginal()),
  categorizeRows: vi.fn(),
}));
vi.mock('../js/ai/agent/loop.js', () => ({
  runAgentTurn: vi.fn(),
  resumeAgentTurn: vi.fn(async ({ messages }) => ({ messages, text: '', pending: null, stopped: 'end_turn' })),
}));

import { categorizeRows } from '../js/ai/categorize.js';
import { runAgentTurn, resumeAgentTurn } from '../js/ai/agent/loop.js';
import { openAgentDialog, buildSkeleton } from '../js/ai/agent/dialog.js';
import { resetAgentConversation } from '../js/ai/agent/conversation.js';
import { makeProposal, validateProposal } from '../js/ai/proposal.js';
import { describeError } from '../js/core/errors.js';
import { t } from '../js/ui/i18n.js';
import {
  state, writeBatch, resetState, mountHosts, flush, setValue, topOverlay, toastTexts,
  dialogButton, dialogOk, navigate, updateStatusBar, FIXED_NOW,
} from './_fakes/pageApp.js';

const existing = () => [
  { id: 'x1', type: 'expense', date: '2026-09-01', payee: 'Lidl', amount: 45.2, account: 'chk', envelope_id: 'food' },
];
const dialog = () => document.querySelector('#sheet-host .agent-dialog');
const added = () => state.transactions.slice(1);
const approveBtn = () => dialog().querySelector('.agent-proposal .proposal-actions .btn-accent');
const failText = (message) => describeError({ code: 'write_failed', params: { message } }, t);

let sheet;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  categorizeRows.mockReset();
  runAgentTurn.mockReset();
  resumeAgentTurn.mockClear();
  resetAgentConversation();
  resetState({ transactions: existing() });
  // A failure queued by a test whose write never happened must not leak into the next.
  writeBatch.mockReset();
  writeBatch.mockImplementation(async () => {});
  mountHosts();
  sheet = openAgentDialog(state);
});

// Close the one-at-a-time dialog so the next test opens a fresh one. The
// dialog forgets its handle in the sheet's onClose, after the slide-out.
afterEach(async () => {
  sheet?.close();
  await new Promise(r => setTimeout(r, 250));
});

describe('a file attached in the dialog', () => {
  async function attach(text) {
    const input = dialog().querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', { value: [new File([text], 'bank.csv', { type: 'text/csv' })], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // Reading the file, the lazy import of the review and the categorising
    // step take a variable number of turns (more on a cold, loaded run):
    // wait for the review to be there rather than counting flushes.
    await vi.waitFor(() => { if (!approveBtn()) throw new Error('review not rendered yet'); }, { timeout: 3000, interval: 10 });
  }

  beforeEach(() => {
    categorizeRows.mockResolvedValue([
      { index: 0, type: 'expense', account_id: 'chk', envelope_id: 'fun', confidence: 0.9, rationale: 'coffee' },
      { index: 1, type: 'income', account_id: 'sav', envelope_id: null, confidence: 0.9, rationale: 'pay' },
    ]);
  });

  it('records the approved rows with their source, envelope and account, appended', async () => {
    await attach('Date,Payee,Amount\n2026-09-05,Cafe,-8\n2026-09-02,Employer,2000');
    approveBtn().click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions[0]).toEqual(existing()[0]);
    expect(added()).toHaveLength(2);
    expect(added()[0]).toMatchObject({
      type: 'expense', date: '2026-09-05', payee: 'Cafe', amount: 8, account: 'chk', envelope_id: 'fun', source: 'dialog',
    });
    expect(added()[1]).toMatchObject({ type: 'income', date: '2026-09-02', payee: 'Employer', amount: 2000, account: 'sav', source: 'dialog' });
    expect(toastTexts()).toContain(t('txImport.success')(2));
    expect(dialog().textContent).toContain(t('ai.dialog.added')(2));
    // The categorizer dates its prompt by the app's clock.
    expect(categorizeRows.mock.calls[0][1].clock()).toEqual(FIXED_NOW);
    // The page behind the dialog and the status bar repaint on the new rows.
    expect(updateStatusBar).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('transactions');
  });

  it('a refused write shows the reason in the review, changes nothing, and can be approved again', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    await attach('Date,Payee,Amount\n2026-09-05,Cafe,-8\n2026-09-02,Employer,2000');
    approveBtn().click();
    await flush();

    expect(dialog().querySelector('.import-review-status').textContent).toBe(`${t('txImport.importError')}: ${failText('disk full')}`);
    expect(state.transactions).toEqual(existing());
    expect(approveBtn().disabled).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(updateStatusBar).not.toHaveBeenCalled();

    approveBtn().click();
    await flush();
    expect(added()).toHaveLength(2);
  });

  it('a version conflict offers the reload dialog and leaves the review usable', async () => {
    writeBatch.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { status: 409 }));
    await attach('Date,Payee,Amount\n2026-09-05,Cafe,-8\n2026-09-02,Employer,2000');
    approveBtn().click();
    await flush();

    expect(topOverlay().textContent).toContain(t('saveError.versionConflictBody'));
    expect(state.transactions).toEqual(existing());
    expect(approveBtn().disabled).toBe(false);
    // Dismiss it: the reload dialog is a singleton, and an open one swallows the next.
    [...topOverlay().querySelectorAll('button')].find(x => x.textContent === t('saveError.dismiss')).click();
    await flush();
  });

  it('a closed month asks first; cancelling writes nothing and leaves the review usable', async () => {
    state.meta = { closed_months: ['2026-09'] };
    await attach('Date,Payee,Amount\n2026-09-05,Cafe,-8\n2026-09-02,Employer,2000');
    approveBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('closedPeriod.title'));
    dialogButton(t('common.cancel')).click();
    await flush();

    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.transactions).toEqual(existing());
    expect(dialog().querySelector('.import-review-status').textContent).toContain(t('closedPeriod.importCancelled'));
    expect(approveBtn().disabled).toBe(false);
    expect(toastTexts()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();

    // Asked again, and "Edit anyway" records them.
    approveBtn().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(added()).toHaveLength(2);
  });

  it('a budget switch after the write landed removes the card without a toast or a repaint', async () => {
    await attach('Date,Payee,Amount\n2026-09-05,Cafe,-8\n2026-09-02,Employer,2000');
    writeBatch.mockImplementationOnce(async () => { state.budgetFolder = { name: 'other-budget' }; });
    approveBtn().click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions).toEqual(existing());
    expect(dialog().querySelector('.agent-proposal')).toBe(null);
    expect(toastTexts()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('with no budget open any more the card goes away without a word', async () => {
    await attach('Date,Payee,Amount\n2026-09-05,Cafe,-8\n2026-09-02,Employer,2000');
    state.budgetFolder = null;
    approveBtn().click();
    await flush();

    expect(writeBatch).not.toHaveBeenCalled();
    expect(dialog().querySelector('.agent-proposal')).toBe(null);
    expect(dialog().querySelector('.agent-error')).toBe(null);
    expect(toastTexts()).toEqual([]);
  });
});

describe('a proposal the agent made', () => {
  async function propose(rows) {
    const proposal = validateProposal(makeProposal({ kind: 'transactions', rows, meta: { source: 'dialog' } }), state);
    runAgentTurn.mockResolvedValue({
      messages: [], text: '', stopped: 'tool_use',
      pending: { toolUseId: 'tu1', toolName: 'propose_transactions', proposal, partialResults: [], blocks: [] },
    });
    const input = dialog().querySelector('.agent-input');
    setValue(input, 'add my coffee', ['input']);
    dialog().querySelector('.agent-composer').requestSubmit();
    await vi.waitFor(() => { if (!approveBtn()) throw new Error('proposal not rendered yet'); }, { timeout: 3000, interval: 10 });
  }

  it('records the approved rows in one import and tells the agent how many', async () => {
    await propose([
      { date: '2026-09-05', payee: 'Cafe', amount: 8, type: 'expense', account_id: 'chk', envelope_id: 'fun' },
      { date: '2026-09-06', payee: 'Bakery', amount: 4, type: 'expense', account_id: 'chk', envelope_id: 'food' },
    ]);
    approveBtn().click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(added().map(x => [x.payee, x.amount, x.account, x.envelope_id, x.source])).toEqual([
      ['Cafe', 8, 'chk', 'fun', 'dialog'],
      ['Bakery', 4, 'chk', 'food', 'dialog'],
    ]);
    expect(toastTexts()).toContain(t('txImport.success')(2));
    expect(resumeAgentTurn).toHaveBeenCalledTimes(1);
    expect(resumeAgentTurn.mock.calls[0][0].outcome).toEqual({ approved: true, count: 2 });
    expect(resumeAgentTurn.mock.calls[0][0].clock).toBeTypeOf('function');
    expect(updateStatusBar).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('transactions');
  });

  it('a refused write shows the reason, changes nothing, and keeps the card', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    await propose([{ date: '2026-09-05', payee: 'Cafe', amount: 8, type: 'expense', account_id: 'chk', envelope_id: 'fun' }]);
    approveBtn().click();
    await flush();

    expect(dialog().querySelector('.agent-error').textContent).toContain(failText('disk full'));
    expect(state.transactions).toEqual(existing());
    expect(approveBtn().disabled).toBe(false);
    expect(resumeAgentTurn).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(updateStatusBar).not.toHaveBeenCalled();
  });

  it('a closed month asks first; cancelling writes nothing and keeps the card usable', async () => {
    state.meta = { closed_months: ['2026-09'] };
    await propose([{ date: '2026-09-05', payee: 'Cafe', amount: 8, type: 'expense', account_id: 'chk', envelope_id: 'fun' }]);
    approveBtn().click();
    await flush();
    expect(topOverlay().textContent).toContain(t('closedPeriod.title'));
    dialogButton(t('common.cancel')).click();
    await flush();

    expect(writeBatch).not.toHaveBeenCalled();
    expect(state.transactions).toEqual(existing());
    expect(approveBtn().disabled).toBe(false);
    expect(dialog().querySelector('.agent-error')).toBe(null);
    expect(resumeAgentTurn).not.toHaveBeenCalled();
    expect(toastTexts()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();

    // Asked again, and "Edit anyway" records it.
    approveBtn().click();
    await flush();
    dialogOk().click();
    await flush();
    expect(added()).toHaveLength(1);
    expect(resumeAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('a version conflict offers the reload dialog only, and keeps the card usable', async () => {
    writeBatch.mockRejectedValueOnce(Object.assign(new Error('Conflict'), { status: 409 }));
    await propose([{ date: '2026-09-05', payee: 'Cafe', amount: 8, type: 'expense', account_id: 'chk', envelope_id: 'fun' }]);
    approveBtn().click();
    await flush();

    expect(topOverlay().textContent).toContain(t('saveError.versionConflictBody'));
    expect(dialog().querySelector('.agent-error')).toBe(null);
    expect(state.transactions).toEqual(existing());
    expect(approveBtn().disabled).toBe(false);
    expect(resumeAgentTurn).not.toHaveBeenCalled();
    // Dismiss it: the reload dialog is a singleton, and an open one swallows the next.
    [...topOverlay().querySelectorAll('button')].find(x => x.textContent === t('saveError.dismiss')).click();
    await flush();
  });

  it('a budget switch after the write landed removes the card without a toast, a repaint or a resume', async () => {
    await propose([{ date: '2026-09-05', payee: 'Cafe', amount: 8, type: 'expense', account_id: 'chk', envelope_id: 'fun' }]);
    // The write lands, then another budget opens before the session publishes.
    writeBatch.mockImplementationOnce(async () => { state.budgetFolder = { name: 'other-budget' }; });
    approveBtn().click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions).toEqual(existing());
    expect(dialog().querySelector('.agent-proposal')).toBe(null);
    expect(dialog().querySelector('.agent-error')).toBe(null);
    expect(toastTexts()).toEqual([]);
    expect(navigate).not.toHaveBeenCalled();
    expect(updateStatusBar).not.toHaveBeenCalled();
    expect(resumeAgentTurn).not.toHaveBeenCalled();
  });

  it('with no budget open any more the card goes away without a word', async () => {
    await propose([{ date: '2026-09-05', payee: 'Cafe', amount: 8, type: 'expense', account_id: 'chk', envelope_id: 'fun' }]);
    state.budgetFolder = null;
    approveBtn().click();
    await flush();

    expect(writeBatch).not.toHaveBeenCalled();
    expect(dialog().querySelector('.agent-proposal')).toBe(null);
    expect(dialog().querySelector('.agent-error')).toBe(null);
    expect(toastTexts()).toEqual([]);
    expect(resumeAgentTurn).not.toHaveBeenCalled();
  });
});

describe('the budget skeleton sent with the first message', () => {
  it('dates the budget by the clock\u2019s local day, not its UTC day', () => {
    // 00:30 local on the 15th is still the 14th in UTC for any zone east of it.
    const skeleton = buildSkeleton(state, () => new Date(2026, 8, 15, 0, 30, 0));
    expect(skeleton.today).toBe('2026-09-15');
  });

  it('lists the open accounts and envelopes with their Booked balances', () => {
    state.accounts.push({ id: 'old', name: 'Closed', type: 'bank', initialBalance: 9, archived: true });
    const skeleton = buildSkeleton(state, () => new Date(2026, 8, 15, 12, 0, 0));
    expect(skeleton.accounts).toEqual([
      { id: 'chk', name: 'Checking', balance: 954.8 },
      { id: 'sav', name: 'Savings', balance: 500 },
    ]);
    expect(skeleton.envelopes).toEqual([{ id: 'food', name: 'Food', balance: -45.2 }, { id: 'fun', name: 'Fun', balance: 0 }, { id: 'rent', name: 'Rent', balance: 0 }]);
  });

  it('a missing API key shows the one AI-needs-a-key message, not the HTTP status', async () => {
    runAgentTurn.mockRejectedValue(Object.assign(new Error('412 Precondition Failed'), { code: 'no_user_api_key', status: 412 }));
    setValue(dialog().querySelector('.agent-input'), 'hello', ['input']);
    dialog().querySelector('.agent-composer').requestSubmit();
    await flush();
    const box = dialog().querySelector('.agent-error').textContent;
    expect(box).toContain(t('ai.error.noUserApiKey'));
    expect(box).not.toContain('412');
  });

  it('goes out once with the first message, and the loop gets the app clock', async () => {
    runAgentTurn.mockResolvedValue({ messages: [], text: '', pending: null, stopped: 'end_turn' });
    setValue(dialog().querySelector('.agent-input'), 'hello', ['input']);
    dialog().querySelector('.agent-composer').requestSubmit();
    await flush();

    const call = runAgentTurn.mock.calls[0][0];
    const first = call.messages[0].content[0].text;
    expect(first.startsWith('Budget:\n')).toBe(true);
    expect(JSON.parse(first.slice('Budget:\n'.length)).today).toBe('2026-09-15');
    expect(call.clock()).toEqual(new Date(2026, 8, 15, 12, 0, 0));
  });
});

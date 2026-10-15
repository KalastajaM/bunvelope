// @vitest-environment jsdom
// Fill envelopes sheet: the `fill` transaction the Add / Set rows produce.
// Drives the real js/pages/fill-envelopes.js, which dispatches allocation.fill
// through the real browser session; asserts on state and on what writeBatch got.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);

import { openFillEnvelopes } from '../js/pages/fill-envelopes.js';
import { trEnv, t } from '../js/ui/i18n.js';
import { state, session, writeBatch, updateStatusBar, resetState, mountHosts, flush, setValue, sheetIsOpen } from './_fakes/pageApp.js';

const sheet = () => document.querySelector('#sheet-host .sheet');
function row(envId) {
  const env = state.envelopes.find(e => e.id === envId);
  return [...sheet().querySelectorAll('.fill-env-row')]
    .find(r => r.querySelector('.fill-env-name').textContent === trEnv(env));
}
const inputOf = (envId) => row(envId).querySelector('.fill-env-input');
const modeBtn = (envId, which) => row(envId).querySelectorAll('.fill-env-mode')[which === 'add' ? 0 : 1];
const submitBtn = () => sheet().querySelector('.fill-env-footer .btn-accent');
const zeroBtn = () => sheet().querySelector('.fill-env-footer .btn-ghost');
const remainderText = () => sheet().querySelector('.fill-env-remainder-val').textContent;

const fill = () => state.transactions.at(-1);
const toastText = () => document.querySelector('#toast-host')?.textContent || '';

beforeEach(() => {
  // Food holds 300 (an income credited straight to it); nothing else does.
  resetState({
    transactions: [
      { id: 'i1', type: 'income', date: '2026-09-01', payee: 'Job', amount: 300, envelope_id: 'food', account: 'chk', status: 'posted' },
    ],
  });
  mountHosts();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  openFillEnvelopes();
});

describe('fill envelopes', () => {
  it('starts with nothing to submit', () => {
    expect(submitBtn().disabled).toBe(true);
  });

  it('Add mode writes the typed amount as a posted allocation fill', async () => {
    setValue(inputOf('fun'), '50');
    expect(submitBtn().disabled).toBe(false);
    submitBtn().click();
    await flush();

    expect(writeBatch).toHaveBeenCalledTimes(1);
    expect(state.transactions).toHaveLength(2);
    // Today's row plus the stamps the command adds (note: null, created_at, modified_at).
    expect(fill()).toEqual({
      id: expect.any(String),
      type: 'fill', date: '2026-09-15', status: 'posted', source: 'allocation',
      payee: 'Fill envelopes', note: null,
      lines: [{ envelope_id: 'fun', mode: 'add', amount: 50 }],
      created_at: expect.any(String), modified_at: expect.any(String),
    });
    expect(updateStatusBar).toHaveBeenCalled();
    expect(sheetIsOpen()).toBe(false);
  });

  it('keeps the line order of the sheet when several envelopes are filled', async () => {
    setValue(inputOf('rent'), '20');
    setValue(inputOf('fun'), '10');
    submitBtn().click();
    await flush();
    expect(fill().lines.map(l => [l.envelope_id, l.amount])).toEqual([['fun', 10], ['rent', 20]]);
  });

  it('reports a failed write with a toast and leaves state untouched', async () => {
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    setValue(inputOf('fun'), '50');
    submitBtn().click();
    await flush();
    expect(state.transactions).toHaveLength(1);
    expect(toastText()).toContain('disk full');
  });

  it('a failed write still refreshes the status bar and calls onSubmitted', async () => {
    mountHosts();
    const onSubmitted = vi.fn();
    openFillEnvelopes({ onSubmitted });
    writeBatch.mockRejectedValueOnce(new Error('disk full'));
    updateStatusBar.mockClear();
    setValue(inputOf('fun'), '50');
    submitBtn().click();
    await flush();
    expect(state.transactions).toHaveLength(1);
    expect(updateStatusBar).toHaveBeenCalledTimes(1);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('a version conflict opens the conflict dialog instead of a save-failed toast', async () => {
    mountHosts();
    const onSubmitted = vi.fn();
    openFillEnvelopes({ onSubmitted });
    writeBatch.mockRejectedValueOnce(Object.assign(new Error('409'), { status: 409 }));
    updateStatusBar.mockClear();
    setValue(inputOf('fun'), '50');
    submitBtn().click();
    await flush();
    expect(state.transactions).toHaveLength(1);
    expect(document.body.textContent).toContain(t('saveError.versionConflictBody'));
    expect(toastText()).not.toContain('409');
    expect(updateStatusBar).toHaveBeenCalledTimes(1);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('calls onSubmitted after the write has landed', async () => {
    mountHosts();
    const onSubmitted = vi.fn(() => { seen = state.transactions.length; });
    let seen = -1;
    openFillEnvelopes({ onSubmitted });
    setValue(inputOf('fun'), '50');
    submitBtn().click();
    await flush();
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(seen).toBe(2);
  });

  it('Set mode writes the delta to the target, in either direction', async () => {
    // Food is at 300: set 500 is +200, set 100 is -200. Both stay `add` lines
    // so future-dated rows cannot re-apply on top of an absolute overwrite.
    modeBtn('food', 'set').click();
    setValue(inputOf('food'), '500');
    modeBtn('rent', 'set').click();
    setValue(inputOf('rent'), '20');
    submitBtn().click();
    await flush();
    expect(fill().lines).toEqual([
      { envelope_id: 'food', mode: 'add', amount: 200 },
      { envelope_id: 'rent', mode: 'add', amount: 20 },
    ]);

    // Reopen: food now holds 500 (the fill just written).
    mountHosts();
    openFillEnvelopes();
    modeBtn('food', 'set').click();
    setValue(inputOf('food'), '100');
    submitBtn().click();
    await flush();
    expect(fill().lines).toEqual([{ envelope_id: 'food', mode: 'add', amount: -400 }]);
  });

  it('Set accepts the default zero without typing and commits the previewed delta', async () => {
    expect(inputOf('food').value).toBe('');
    modeBtn('food', 'set').click();
    expect(inputOf('food').value).toBe('0');
    expect(submitBtn().disabled).toBe(false);
    expect(writeBatch).not.toHaveBeenCalled();
    submitBtn().click();
    await flush();
    expect(fill().lines).toEqual([{ envelope_id: 'food', mode: 'add', amount: -300 }]);
  });

  it('Clear entries cancels a default-zero Set', () => {
    modeBtn('food', 'set').click();
    zeroBtn().click();
    expect(inputOf('food').value).toBe('');
    expect(submitBtn().disabled).toBe(true);
  });

  it('skips empty rows and rows whose Set target equals the balance', async () => {
    setValue(inputOf('fun'), '10');
    modeBtn('food', 'set').click();
    setValue(inputOf('food'), '300'); // already 300: a no-op line
    submitBtn().click();
    await flush();
    expect(fill().lines).toEqual([{ envelope_id: 'fun', mode: 'add', amount: 10 }]);
  });

  it('keeps Fill disabled when the only entries are no-ops', () => {
    modeBtn('food', 'set').click();
    setValue(inputOf('food'), '300');
    expect(submitBtn().disabled).toBe(true);
  });

  it('Zero out clears every entry and disables Fill again', () => {
    setValue(inputOf('fun'), '10');
    setValue(inputOf('rent'), '5');
    expect(submitBtn().disabled).toBe(false);
    zeroBtn().click();
    expect(inputOf('fun').value).toBe('');
    expect(inputOf('rent').value).toBe('');
    expect(submitBtn().disabled).toBe(true);
  });

  it('the remainder pill follows the entries against Unallocated', () => {
    const before = remainderText();
    setValue(inputOf('fun'), '10');
    const after = remainderText();
    expect(after).not.toBe(before);
    setValue(inputOf('fun'), '');
    expect(remainderText()).toBe(before);
  });

  it('evaluates a formula entry before writing', async () => {
    setValue(inputOf('fun'), '20*2+5', ['input']);
    // A formula resolves when the field loses focus.
    inputOf('fun').dispatchEvent(new Event('blur'));
    expect(inputOf('fun').value).toBe('45');
    await flush();
    submitBtn().click();
    await flush();
    expect(fill().lines).toEqual([{ envelope_id: 'fun', mode: 'add', amount: 45 }]);
  });

  it('does not write when the sheet is cancelled', async () => {
    setValue(inputOf('fun'), '10');
    const cancel = [...sheet().querySelectorAll('.fill-env-footer .btn-ghost')].at(-1);
    cancel.click();
    await flush();
    // Dirty form: a discard confirmation opens on top instead of closing silently.
    expect(document.querySelectorAll('#sheet-host .sheet-overlay[data-sheet-open]')).toHaveLength(2);
    expect(writeBatch).not.toHaveBeenCalled();
  });
});

it('does not run a delayed preview after its sheet is detached', async () => {
  vi.useFakeTimers();
  const query = vi.spyOn(session, 'query');
  try {
    setValue(inputOf('fun'), '50');
    sheet().closest('.sheet-overlay').remove();
    query.mockClear();
    await vi.advanceTimersByTimeAsync(250);
    expect(query).not.toHaveBeenCalled();
  } finally {
    query.mockRestore();
    vi.useRealTimers();
  }
});


it('a prefilled suggestion stays unsaved until explicit submission and remains editable', async () => {
  mountHosts();
  openFillEnvelopes({ initialAmounts: { fun: 50, food: -10, missing: 100 } });
  expect(inputOf('fun').value).toBe('50');
  expect(Number(inputOf('food').value)).toBe(0);
  expect(writeBatch).not.toHaveBeenCalled();
  setValue(inputOf('fun'), '35');
  submitBtn().click();
  await flush();
  expect(writeBatch).toHaveBeenCalledTimes(1);
  expect(fill().lines).toEqual([{ envelope_id: 'fun', mode: 'add', amount: 35 }]);
});

describe('return to unallocated', () => {
  beforeEach(() => {
    mountHosts();
    openFillEnvelopes({ mode: 'return' });
  });

  it('previews a positive return amount and commits a negative allocation', async () => {
    const before = remainderText();
    setValue(inputOf('food'), '100');
    expect(remainderText()).not.toBe(before);
    expect(writeBatch).not.toHaveBeenCalled();
    expect(submitBtn().disabled).toBe(false);
    submitBtn().click();
    await flush();
    expect(fill().lines).toEqual([{ envelope_id: 'food', mode: 'add', amount: -100 }]);
    expect(writeBatch).toHaveBeenCalledTimes(1);
  });

  it.each(['-10', '301', 'abc', '20oops', '1/0'])('blocks invalid return %s', (value) => {
    setValue(inputOf('food'), value);
    expect(submitBtn().disabled).toBe(true);
    expect(inputOf('food').getAttribute('aria-invalid')).toBe('true');
    expect(writeBatch).not.toHaveBeenCalled();
  });

  it('blocks the whole draft when another row exceeds its available balance', () => {
    setValue(inputOf('food'), '100');
    setValue(inputOf('fun'), '1');
    expect(submitBtn().disabled).toBe(true);
    setValue(inputOf('fun'), '');
    expect(submitBtn().disabled).toBe(false);
  });

  it('accepts arithmetic without requiring blur and clears it without saving', () => {
    setValue(inputOf('food'), '50*2', ['input']);
    expect(submitBtn().disabled).toBe(false);
    zeroBtn().click();
    expect(inputOf('food').value).toBe('');
    expect(submitBtn().disabled).toBe(true);
    expect(writeBatch).not.toHaveBeenCalled();
  });
});

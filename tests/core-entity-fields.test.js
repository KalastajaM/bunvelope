// tests/core-entity-fields.test.js — account, envelope, plan-item and template
// field declarations and rules, the name rule, reference counts, the type-move
// helpers in core, the new error codes and the registry's `internal` flag.
import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_TYPES, ACCOUNT_FIELD_PROPERTIES, ENVELOPE_FIELD_PROPERTIES,
  accountFieldApplies, applyAccountFields, applyEnvelopeFields,
  checkName, newAccountId, newEnvelopeId, accountRefs, envelopeRefs,
  ITEM_KINDS, ITEM_FIELD_PROPERTIES, itemFieldApplies, applyItemFields, checkItem, newItemId,
  TEMPLATE_FIELD_PROPERTIES, applyTemplateFields, checkTemplate, newTemplateId,
} from '../js/core/entity-fields.js';
import { sinceOnSave } from '../js/core/plan-item-rules.js';
import { inputFromCliOptions } from '../js/core/cli-flags.js';
import { uniqueId, slugify } from '../js/utils.js';
import { oldEditorItem } from './_fakes/oldEditorItem.js';
import { identityMove, moveAdjustment } from '../js/core/account-type-move.js';
import { ERROR_CODES, describeError } from '../js/core/errors.js';
import { assertSchema, validate } from '../js/core/schema.js';
import { createRegistry } from '../js/core/registry.js';
import { ok } from '../js/core/result.js';
import { helpText } from '../bin/cli-dispatch.mjs';
import { t, setLang, loadLocale } from '../js/ui/i18n.js';

describe('field declarations', () => {
  it('declares every account type and editable field, and no system field', () => {
    expect(ACCOUNT_TYPES).toEqual(['bank', 'cash', 'credit_card', 'savings', 'investment', 'asset', 'loan', 'loan_given']);
    expect(Object.keys(ACCOUNT_FIELD_PROPERTIES).sort()).toEqual([
      'code', 'crisisCash', 'expectedGrowth', 'favorite', 'group', 'initialBalance', 'interestDayCount', 'interestPayout',
      'interestRates', 'interestTierMode', 'interestTiers', 'loanEnd', 'loanStart', 'name', 'notes', 'pensionInsurance', 'plannedMonthly',
      'settledFrom', 'spending', 'taxWrapped', 'trackInvestments', 'type',
    ]);
    for (const k of ['archived', 'lastReconciledAt', 'lastReconciledBalance', 'lastReconciledLedger', 'id']) {
      expect(ACCOUNT_FIELD_PROPERTIES).not.toHaveProperty(k);
    }
    expect(Object.keys(ENVELOPE_FIELD_PROPERTIES).sort()).toEqual([
      'category', 'code', 'description', 'favorite', 'forecast_account_shares', 'goal_amount', 'goal_date', 'name', 'rollover', 'spend_flag_exempt',
    ]);
  });

  it('are schemas the validator supports', () => {
    expect(() => assertSchema({ type: 'object', properties: ACCOUNT_FIELD_PROPERTIES })).not.toThrow();
    expect(() => assertSchema({ type: 'object', properties: ENVELOPE_FIELD_PROPERTIES })).not.toThrow();
    const acc = validate({ interestTiers: [{ rate: 2, upTo: 1000 }, { rate: 1 }], interestRates: [{ from: '2026-01-01', rate: 3 }] },
      { type: 'object', properties: ACCOUNT_FIELD_PROPERTIES });
    expect(acc.ok).toBe(true);
    const env = validate({ goal_amount: 0 }, { type: 'object', properties: ENVELOPE_FIELD_PROPERTIES });
    expect(env.ok).toBe(false);
  });
});

describe('accountFieldApplies', () => {
  it('follows the form', () => {
    expect(accountFieldApplies('interestTiers', 'savings')).toBe(true);
    expect(accountFieldApplies('interestTiers', 'loan_given')).toBe(false);
    expect(accountFieldApplies('interestPayout', 'loan_given')).toBe(true);
    expect(accountFieldApplies('interestPayout', 'bank')).toBe(false);
    for (const f of ['trackInvestments', 'pensionInsurance', 'taxWrapped']) {
      expect(accountFieldApplies(f, 'investment')).toBe(true);
      expect(accountFieldApplies(f, 'savings')).toBe(false);
    }
    for (const f of ['spending', 'crisisCash']) {
      expect(accountFieldApplies(f, 'bank')).toBe(true);
      for (const off of ['asset', 'loan', 'loan_given']) expect(accountFieldApplies(f, off)).toBe(false);
    }
    expect(accountFieldApplies('group', 'asset')).toBe(true);
    expect(accountFieldApplies('group', 'bank')).toBe(false);
    expect(accountFieldApplies('interestRates', 'loan')).toBe(true);
    expect(accountFieldApplies('interestRates', 'savings')).toBe(false);
    expect(accountFieldApplies('loanStart', 'loan_given')).toBe(true);
    expect(accountFieldApplies('loanEnd', 'loan')).toBe(false);
    // The day count is asked of a loan (taken) only; a loan given accrues on its own cycle.
    expect(accountFieldApplies('interestDayCount', 'loan')).toBe(true);
    for (const type of ACCOUNT_TYPES.filter(x => x !== 'loan')) expect(accountFieldApplies('interestDayCount', type)).toBe(false);
    for (const f of ['name', 'type', 'initialBalance', 'notes', 'favorite', 'expectedGrowth', 'plannedMonthly']) {
      for (const type of ACCOUNT_TYPES) expect(accountFieldApplies(f, type)).toBe(true);
    }
  });
});

describe('applyAccountFields', () => {
  const savings = {
    id: 'sav', name: 'Savings', type: 'savings', initialBalance: 10, notes: 'old',
    interestTiers: [{ rate: 2 }], interestPayout: 'monthly', interestFirstMonth: '2025-01', archived: false,
  };
  it('drops the fields a type change leaves behind', () => {
    const out = applyAccountFields(savings, { type: 'bank' });
    expect(out.type).toBe('bank');
    expect(out).not.toHaveProperty('interestTiers');
    expect(out).not.toHaveProperty('interestPayout');
    expect(out.archived).toBe(false);
    expect(savings.interestTiers).toEqual([{ rate: 2 }]);
  });
  it('deletes notes on null or an empty string', () => {
    expect(applyAccountFields(savings, { notes: null })).not.toHaveProperty('notes');
    expect(applyAccountFields(savings, { notes: '' })).not.toHaveProperty('notes');
    expect(applyAccountFields(savings, { notes: 'new' }).notes).toBe('new');
  });
  it('drops the legacy interestFirstMonth with a type, and leaves it on any other update', () => {
    expect(applyAccountFields(savings, { type: 'savings', name: 'Savings 2' })).not.toHaveProperty('interestFirstMonth');
    expect(applyAccountFields(savings, { name: 'Savings 2' }).interestFirstMonth).toBe('2025-01');
  });
  it('without a type, sets only the given keys, each normalised on its own', () => {
    expect(applyAccountFields(savings, { favorite: true })).toEqual({ ...savings, favorite: true });
    const bank = { id: 'b', name: 'Bank', type: 'bank', initialBalance: 0, group: 'Stray' };
    expect(applyAccountFields(bank, { expectedGrowth: 2 })).toEqual({ ...bank, expectedGrowth: 2 });
    // A given key that does not belong to the type is not stored.
    expect(applyAccountFields(bank, { group: 'Property' })).not.toHaveProperty('group');
    expect(applyAccountFields(bank, { interestDayCount: 'act/360' })).not.toHaveProperty('interestDayCount');
  });
  it('stores a loan day count only when it is not the default actual/365', () => {
    const loan = { id: 'l', name: 'Mortgage', type: 'loan', initialBalance: -1000 };
    expect(applyAccountFields(loan, { interestDayCount: 'act/360' }).interestDayCount).toBe('act/360');
    expect(applyAccountFields(loan, { interestDayCount: '30/360' }).interestDayCount).toBe('30/360');
    const set = { ...loan, interestDayCount: '30/360' };
    expect(applyAccountFields(set, { interestDayCount: 'act/365' })).not.toHaveProperty('interestDayCount');
    expect(applyAccountFields(set, { interestDayCount: null })).not.toHaveProperty('interestDayCount');
    expect(applyAccountFields(set, { name: 'Home loan' }).interestDayCount).toBe('30/360');
    expect(applyAccountFields(set, { type: 'loan_given' })).not.toHaveProperty('interestDayCount');
    expect(validate({ interestDayCount: 'act/366' }, { type: 'object', properties: ACCOUNT_FIELD_PROPERTIES }).ok).toBe(false);
  });
});

describe('applyEnvelopeFields', () => {
  const env = { id: 'e', name: 'Trip', category: 'Fun', description: '', rollover: 'zero-monthly' };
  it('stores carry as no key', () => {
    expect(applyEnvelopeFields(env, { rollover: 'carry' }, '2026-10-02')).not.toHaveProperty('rollover');
    expect(applyEnvelopeFields(env, { rollover: 'cover-from-unallocated' }, '2026-10-02').rollover).toBe('cover-from-unallocated');
  });
  it('stamps a new goal with today', () => {
    const out = applyEnvelopeFields(env, { goal_amount: 500, goal_date: '2027-06-01' }, '2026-10-02');
    expect(out.goal_start).toBe('2026-10-02');
  });
  it('keeps an existing start', () => {
    const withGoal = { ...env, goal_amount: 500, goal_date: '2027-06-01', goal_start: '2026-01-15' };
    expect(applyEnvelopeFields(withGoal, { goal_amount: 800 }, '2026-10-02').goal_start).toBe('2026-01-15');
  });
  it('restamps a start that is not a valid date when the goal is given', () => {
    const withGoal = { ...env, goal_amount: 500, goal_date: '2027-06-01', goal_start: 'soon' };
    expect(applyEnvelopeFields(withGoal, { goal_date: '2027-07-01' }, '2026-10-02').goal_start).toBe('2026-10-02');
  });
  it('re-derives nothing for a field other than the goal and the rollover', () => {
    const legacy = { ...env, rollover: 'carry', goal_amount: 99.999, goal_date: '2027-06-01' };
    expect(applyEnvelopeFields(legacy, { favorite: true }, '2026-10-02')).toEqual({ ...legacy, favorite: true });
  });
  it('deletes the start when the date goes', () => {
    const withGoal = { ...env, goal_amount: 500, goal_date: '2027-06-01', goal_start: '2026-01-15' };
    const out = applyEnvelopeFields(withGoal, { goal_date: null }, '2026-10-02');
    expect(out).not.toHaveProperty('goal_date');
    expect(out).not.toHaveProperty('goal_start');
    expect(out.goal_amount).toBe(500);
  });
});

describe('checkName', () => {
  const rows = [{ id: 'a', name: 'Groceries' }, { id: 'b', name: 'Old', archived: true }];
  it('refuses a clash case-insensitively, archived rows included', () => {
    expect(checkName('envelope', rows, ' groceries ', null)).toEqual({ code: 'name_taken', params: { kind: 'envelope', name: 'groceries' } });
    expect(checkName('envelope', rows, 'OLD', null)?.code).toBe('name_taken');
  });
  it('excludes the row itself', () => {
    expect(checkName('envelope', rows, 'GROCERIES', 'a')).toBeNull();
    expect(checkName('envelope', rows, 'Rent', null)).toBeNull();
  });
  it('refuses an empty name', () => {
    const r = checkName('account', rows, '   ', null);
    expect(r?.code).toBe('bad_input');
    expect(r?.params.errors[0].path).toBe('name');
  });
});

describe('ids', () => {
  it('are made as the forms make them', () => {
    expect(newAccountId([{ id: 'amex' }], 'Amex')).toBe('amex-2');
    expect(newAccountId([], '!!!')).toBe('account');
    expect(newEnvelopeId([], 'Home', 'Rent')).toBe('home-rent');
    expect(newEnvelopeId([], '', '')).toBe('envelope');
  });
});

// Verbatim copies of the page functions (js/pages/account-edit.js
// countAccountRefs, js/pages/envelope-edit.js countEnvelopeRefs), with `state`
// as a parameter: the core counts must add up to exactly these.
function pageCountAccountRefs(state, accountId) {
  let n = 0;
  for (const tx of state.transactions || []) {
    if (tx.account === accountId) n++;
    if (tx.from_account === accountId) n++;
    if (tx.to_account === accountId) n++;
    if (tx.source_account === accountId) n++;
    if (tx.type === 'adjustment' && tx.target === 'account' && tx.target_id === accountId) n++;
  }
  return n;
}
function pageCountEnvelopeRefs(state, envelopeId) {
  let n = 0;
  for (const it of state.budgetItems || []) if (it.envelope_id === envelopeId) n++;
  for (const tx of state.transactions || []) {
    if (tx.envelope_id === envelopeId) n++;
    if (tx.from_envelope_id === envelopeId) n++;
    if (tx.to_envelope_id === envelopeId) n++;
    if (Array.isArray(tx.lines)) for (const ln of tx.lines) if (ln.envelope_id === envelopeId) n++;
    if (Array.isArray(tx.envelope_splits)) for (const sp of tx.envelope_splits) if (sp && sp.envelope_id === envelopeId) n++;
    if (tx.type === 'adjustment' && tx.target === 'envelope' && tx.target_id === envelopeId) n++;
  }
  for (const tpl of state.envelopeTemplates || []) {
    for (const ln of [...(tpl?.lines || []), ...(tpl?.assignments || [])]) {
      if (ln && ln.envelope_id === envelopeId) n++;
    }
    if (tpl?.schedule?.source_envelope_id === envelopeId) n++;
  }
  return n;
}

describe('reference counts', () => {
  const data = {
    accounts: [{ id: 'x' }], envelopes: [{ id: 'e' }],
    budgetItems: [{ id: 'b1', envelope_id: 'e' }, { id: 'b2', envelope_id: 'other' }],
    transactions: [
      { id: 't1', type: 'expense', account: 'x', envelope_id: 'e' },
      { id: 't2', type: 'account_transfer', from_account: 'x', to_account: 'x' },
      { id: 't3', type: 'investment_transfer', from_account: 'y', to_account: 'x', source_account: 'x' },
      { id: 't4', type: 'adjustment', target: 'account', target_id: 'x' },
      { id: 't5', type: 'envelope_transfer', from_envelope_id: 'e', to_envelope_id: 'e' },
      { id: 't6', type: 'fill', lines: [{ envelope_id: 'e' }, { envelope_id: 'e' }, { envelope_id: 'z' }] },
      { id: 't7', type: 'expense', account: 'y', envelope_id: null, envelope_splits: [{ envelope_id: 'e' }, null, { envelope_id: 'z' }] },
      { id: 't8', type: 'adjustment', target: 'envelope', target_id: 'e' },
      { id: 't9', type: 'adjustment', target: 'envelope', target_id: 'x' },
    ],
    envelopeTemplates: [
      { id: 'm', lines: [{ envelope_id: 'e' }, null] },
      { id: 'd', assignments: [{ envelope_id: 'e' }], schedule: { source_envelope_id: 'e' } },
      null,
    ],
  };
  it('count an account exactly as the page did', () => {
    expect(accountRefs(data, 'x')).toEqual({ transactions: 6 });
    expect(accountRefs(data, 'x').transactions).toBe(pageCountAccountRefs(data, 'x'));
    expect(accountRefs({}, 'x')).toEqual({ transactions: 0 });
  });
  it('count an envelope exactly as the page did, per collection', () => {
    const refs = envelopeRefs(data, 'e');
    expect(refs).toEqual({ budgetItems: 1, transactions: 7, envelopeTemplates: 3 });
    expect(refs.budgetItems + refs.transactions + refs.envelopeTemplates).toBe(pageCountEnvelopeRefs(data, 'e'));
    expect(envelopeRefs({}, 'e')).toEqual({ budgetItems: 0, transactions: 0, envelopeTemplates: 0 });
  });
});

describe('type-move helpers in core', () => {
  const savings = { id: 'sav', type: 'savings', initialBalance: 55000 };
  const accounts = [savings, { id: 'chk', type: 'bank', initialBalance: 100 }];
  it('identityMove: the balance leaves budget cash when a savings account becomes a loan given', () => {
    expect(identityMove(savings, 'loan_given', accounts, [])).toEqual({ balance: 55000, leaving: true });
    expect(identityMove(savings, 'bank', accounts, [])).toBeNull();
  });
  it('moveAdjustment: releases the envelope', () => {
    const meta = { id: 'x', date: '2026-10-01', note: 'n', nowIso: '2026-10-01T00:00:00Z' };
    expect(moveAdjustment({ balance: 55000, leaving: true }, 'loans', meta)).toMatchObject({
      type: 'adjustment', target: 'envelope', target_id: 'loans', amount: -55000,
    });
    expect(moveAdjustment({ balance: 55000, leaving: true }, null, meta)).toBeNull();
  });
});

describe('error codes', () => {
  const cases = [
    ['in_use', { kind: 'envelope', id: 'e', refs: { transactions: 3, budgetItems: 1, envelopeTemplates: 0 } }],
    ['name_taken', { kind: 'account', name: 'Amex' }],
    ['not_permutation', { kind: 'envelope' }],
    ['not_found', { kind: 'account', id: 'nope' }],
  ];
  it.each(['en', 'fi', 'nl'])('have texts in %s', async (lang) => {
    await loadLocale(lang);
    setLang(lang);
    try {
      for (const [code, params] of cases) {
        expect(ERROR_CODES).toContain(code);
        const text = describeError({ code, params }, t);
        expect(text, `${lang} ${code}`).not.toBe(code);
        if (code === 'in_use') {
          expect(text).toContain('3 transactions');
          expect(text).not.toContain('envelopeTemplates');
        }
        if (code === 'name_taken') expect(text).toContain('Amex');
        if (code === 'not_found') expect(text).toContain('nope');
      }
    } finally {
      setLang('en');
    }
  });
});

describe('registry internal flag', () => {
  function reg() {
    const r = createRegistry();
    r.defineCommand({ name: 'thing.public', summary: 'Public thing.', input: { type: 'object', properties: {} }, execute: () => ok({ changes: {}, value: null }) });
    r.defineCommand({ name: 'thing.system', summary: 'System thing.', internal: true, input: { type: 'object', properties: {} }, execute: () => ok({ changes: {}, value: null }) });
    return r;
  }
  it('leaves internal entries out of the listing but resolvable by name', () => {
    const r = reg();
    expect(r.list().map(e => e.name)).toEqual(['thing.public']);
    expect(r.list({ includeInternal: true }).map(e => e.name)).toEqual(['thing.public', 'thing.system']);
    expect(r.get('thing.system')?.internal).toBe(true);
  });
  it('leaves internal entries out of help', () => {
    const text = helpText(reg(), []);
    expect(text).toContain('thing public');
    expect(text).not.toContain('thing system');
  });
  it('refuses a non-boolean flag', () => {
    expect(() => createRegistry().defineQuery({ name: 'q', summary: 'Q', internal: 'yes', input: { type: 'object', properties: {} }, run: () => ok(1) })).toThrow(TypeError);
  });
});

// ── Plan items ──────────────────────────────────────────────────────────────

const TODAY = '2026-10-02';
const ITEM_DATA = {
  envelopes: [{ id: 'groceries' }, { id: 'rent' }, { id: 'loan-env' }, { id: 'old', archived: true }],
  accounts: [{ id: 'bank' }, { id: 'savings' }, { id: 'broker' }, { id: 'mortgage', type: 'loan' }],
};
// The editor's new item, before the form (js/pages/budget-plan-editor.js 43-52).
const NEW_ITEM = {
  id: '', envelope_id: '', description: null, default_amount: 0, extra_buffer: 0, include: true,
  monthly_schedule: {}, payment_day: 0, stress_category: null, stress_cut_pct: 0,
  include_in_emergency_budget: false, as_schedule: false, account_id: null, as_schedule_since: null,
  schedule_day_type: 'exact', kind: 'expense', investment_account_id: null, symbol: null, to_account_id: null,
  start_month: null, end_month: null,
};
// What is stored once it has been saved: undefined keys vanish.
const json = (x) => JSON.parse(JSON.stringify(x));

// What the editor sends as `fields`: the form's raw values.
function formFields(item, form) {
  const fields = {
    kind: form.kind,
    envelope_id: form.env || null,
    description: form.desc,
    default_amount: Number(form.amt) || 0,
    extra_buffer: Number(form.buffer) || 0,
    include: form.include,
    include_in_emergency_budget: form.emergency,
    payment_day: parseInt(form.payDay) || 0,
    stress_category: form.stress || null,
    stress_cut_pct: item.stress_cut_pct ?? 0,
    stress_cut_pcts: form.cuts ?? item.stress_cut_pcts ?? null,
    monthly_schedule: form.months,
    as_schedule: form.asSchedule,
    account_id: form.account || null,
    schedule_day_type: form.dayType || 'exact',
    investment_account_id: form.invAcct || null,
    symbol: form.symbol,
    direction: form.invDir,
    to_account_id: form.toAcct || null,
    loan_fee: form.loanFee === '' ? null : Number(form.loanFee),
    loan_method: form.loanMethod === 'fixed_payment' ? null : form.loanMethod,
    loan_end: form.loanEnd || null,
  };
  if (form.fundingStyle) fields.funding_style = form.fundingStyle;
  // Active from / until: sent for every kind but a loan payment (#335).
  if (form.kind !== 'loan_payment' && ('startMonth' in form || 'endMonth' in form)) {
    fields.start_month = form.startMonth || null;
    fields.end_month = form.endMonth || null;
  }
  return fields;
}

const FORM = {
  kind: 'expense', env: '', desc: '', amt: '100', buffer: '', include: true, emergency: false, payDay: '',
  stress: '', months: { Jan: true }, asSchedule: false, account: '', dayType: 'exact', invAcct: '',
  symbol: '', invDir: 'buy', toAcct: '', loanFee: '', loanMethod: 'fixed_payment', loanEnd: '',
};
const STORED_EXPENSE = {
  ...NEW_ITEM, id: 'groceries-item', envelope_id: 'groceries', description: 'Food', default_amount: -300,
  extra_buffer: 20, include_in_emergency_budget: true, stress_category: 'D', stress_cut_pct: 0.2,
  monthly_schedule: { Jan: true }, loan_rate: 3, skipped_occurrences: ['2026-03'], as_schedule_until: '2027-01-01',
  template_id: 'old-tpl', funding_style: 'spending',
};
const STORED_LOAN = {
  ...NEW_ITEM, id: 'loan-env-item', kind: 'loan_payment', envelope_id: 'loan-env', default_amount: -500,
  as_schedule: true, account_id: 'bank', to_account_id: 'mortgage', payment_day: 15, as_schedule_since: '2025-01-01',
  loan_method: 'annuity', loan_end: '2030-06', loan_fee: 2.5, funding_style: 'bill',
  monthly_schedule: { Jan: true, Feb: true, Oct: true, Nov: false, Dec: false },
  loan_months_off: { Nov: true, Dec: true }, loan_paid_off: '2026-09-30', skipped_occurrences: ['2026-05'],
};

const EDITOR_CASES = [
  ['an existing expense, scheduled, with unrendered fields and a legacy rate', STORED_EXPENSE, {
    ...FORM, env: 'groceries', desc: '  Food & drink ', amt: '350', buffer: '25', emergency: true, payDay: '5',
    stress: 'C', months: { Jan: true, Feb: 400 }, asSchedule: true, account: 'bank', dayType: 'next_work_day',
    fundingStyle: 'bill',
  }],
  ['a new expense with an account, unscheduled, never cut', null, {
    ...FORM, env: 'rent', amt: '900', account: 'bank', stress: 'Z', emergency: true,
  }],
  ['an income typed negative, unscheduled, with trimmed cuts', {
    ...NEW_ITEM, id: 'income-item', kind: 'income', envelope_id: 'groceries', default_amount: 2500,
  }, { ...FORM, kind: 'income', amt: '-2500', account: 'bank', stress: 'B', cuts: { A: 0.5, B: 0.1, C: 0.9 }, emergency: true }],
  ['a new investment buy, scheduled', null, {
    ...FORM, kind: 'investment_transfer', env: 'groceries', amt: '100', invAcct: 'broker', account: 'bank',
    asSchedule: true, payDay: '3', symbol: ' vwce ', emergency: true, stress: 'E',
  }],
  ['a new dividend', null, {
    ...FORM, kind: 'investment_transfer', invDir: 'dividend', amt: '12', invAcct: 'broker', symbol: ' vwce ',
  }],
  ['an expense turned into an account transfer', STORED_EXPENSE, {
    ...FORM, kind: 'account_transfer', env: 'groceries', amt: '200', buffer: '20', emergency: true, stress: 'D',
    account: 'bank', toAcct: 'savings', asSchedule: true, payDay: '1', fundingStyle: 'bill',
  }],
  ['a loan payment with a month switched back on', STORED_LOAN, {
    ...FORM, kind: 'loan_payment', env: 'loan-env', amt: '510', loanFee: '2.499', loanMethod: 'annuity',
    loanEnd: '2031-01', toAcct: 'mortgage', account: 'bank', asSchedule: true, payDay: '15', stress: 'C', emergency: true,
    months: { Jan: true, Feb: true, Oct: true, Nov: true },
  }],
  ['a loan payment back to a fixed payment without a fee', STORED_LOAN, {
    ...FORM, kind: 'loan_payment', env: 'loan-env', amt: '500', toAcct: 'mortgage', account: 'bank',
    asSchedule: true, payDay: '15', months: { Jan: true },
  }],
  ['a loan payment turned into an expense', STORED_LOAN, {
    ...FORM, env: 'loan-env', amt: '500', account: 'bank', asSchedule: true, payDay: '15', months: { Jan: true },
  }],
  ['a disabled scheduled expense enabled again', {
    ...STORED_EXPENSE, loan_rate: undefined, include: false, as_schedule: true, account_id: 'bank', payment_day: 5,
    as_schedule_since: '2026-01-01',
  }, { ...FORM, env: 'groceries', amt: '300', asSchedule: true, account: 'bank', payDay: '5', stress: 'D' }],
  ['an expense given active months, its legacy end date replaced', STORED_EXPENSE, {
    ...FORM, env: 'groceries', amt: '300', stress: 'D', startMonth: '2026-11', endMonth: '2027-03',
  }],
  ['a new income with only an end month', null, {
    ...FORM, kind: 'income', amt: '3000', account: 'bank', startMonth: '', endMonth: '2026-10',
  }],
  ['a dated income with both months cleared', {
    ...NEW_ITEM, id: 'income-item', kind: 'income', envelope_id: null, default_amount: 3000, account_id: 'bank',
    start_month: '2026-01', end_month: '2026-10', as_schedule_until: '2026-10-31',
  }, { ...FORM, kind: 'income', amt: '3000', account: 'bank', startMonth: '', endMonth: '' }],
  ['a dated expense turned into a loan payment loses its months', {
    ...STORED_EXPENSE, start_month: '2026-01', end_month: '2026-12',
  }, {
    ...FORM, kind: 'loan_payment', env: 'loan-env', amt: '500', toAcct: 'mortgage', account: 'bank',
    asSchedule: true, payDay: '15', startMonth: '2026-01', endMonth: '2026-12',
  }],
];

describe('plan-item field declarations', () => {
  it('declares the kinds and every editable field, and no stamped or upkeep field', () => {
    expect(ITEM_KINDS).toEqual(['expense', 'income', 'investment_transfer', 'account_transfer', 'loan_payment']);
    expect(Object.keys(ITEM_FIELD_PROPERTIES).sort()).toEqual([
      'account_id', 'as_schedule', 'default_amount', 'description', 'direction', 'end_month', 'envelope_id', 'extra_buffer',
      'funding_style', 'include', 'include_in_emergency_budget', 'investment_account_id', 'kind', 'loan_end',
      'loan_fee', 'loan_method', 'monthly_schedule', 'payment_day', 'recurring_review', 'schedule_day_type', 'start_month', 'stress_category',
      'stress_cut_pct', 'stress_cut_pcts', 'symbol', 'target_balance', 'to_account_id', 'transfer_mode',
    ]);
    for (const k of ['id', 'as_schedule_since', 'skipped_occurrences', 'loan_paid_off', 'loan_months_off', 'as_schedule_until', 'template_id']) {
      expect(ITEM_FIELD_PROPERTIES).not.toHaveProperty(k);
    }
  });

  it('are schemas the validator supports, months true, an amount, or false (off after a payoff)', () => {
    const S = { type: 'object', properties: ITEM_FIELD_PROPERTIES };
    expect(() => assertSchema(S)).not.toThrow();
    const months = { Jan: true, Feb: 120, Nov: false };
    expect(validate({ monthly_schedule: months }, S)).toEqual({ ok: true, value: { monthly_schedule: months } });
    for (const bad of [{ monthly_schedule: { Jan: 0 } }, { monthly_schedule: { Jan: 'yes' } }, { monthly_schedule: { June: true } },
      { stress_cut_pcts: { F: 0.1 } }, { stress_cut_pcts: { A: 2 } }, { kind: 'gift' }, { payment_day: 32 }, { extra_buffer: -1 }]) {
      expect(validate(bad, S).ok).toBe(false);
    }
    expect(validate({ envelope_id: 'nope' }, S, ITEM_DATA).ok).toBe(false);
  });

  it('reach the CLI as a JSON flag', () => {
    const S = { type: 'object', properties: ITEM_FIELD_PROPERTIES };
    const parsed = inputFromCliOptions({ monthly_schedule: '{"Jan":true,"Mar":50}', stress_cut_pcts: 'null' }, S);
    expect(parsed).toEqual({ ok: true, value: { monthly_schedule: { Jan: true, Mar: 50 }, stress_cut_pcts: null } });
    expect(validate(parsed.ok ? parsed.value : null, S).ok).toBe(true);
  });
});

describe('itemFieldApplies', () => {
  it('follows the editor sheet', () => {
    const only = (field, kinds) => {
      for (const kind of ITEM_KINDS) expect([field, kind, itemFieldApplies(field, kind)]).toEqual([field, kind, kinds.includes(kind)]);
    };
    only('to_account_id', ['account_transfer', 'loan_payment']);
    for (const f of ['investment_account_id', 'symbol', 'direction']) only(f, ['investment_transfer']);
    for (const f of ['loan_fee', 'loan_method', 'loan_end']) only(f, ['loan_payment']);
    for (const f of ['stress_category', 'stress_cut_pct', 'stress_cut_pcts']) only(f, ['expense', 'income', 'investment_transfer']);
    only('funding_style', ['expense', 'loan_payment']);
    only('include_in_emergency_budget', ['expense', 'loan_payment']);
    for (const f of ['extra_buffer', 'envelope_id']) only(f, ['expense', 'income', 'investment_transfer', 'loan_payment']);
    for (const f of ['kind', 'description', 'default_amount', 'include', 'payment_day', 'monthly_schedule', 'as_schedule', 'account_id', 'schedule_day_type']) {
      only(f, ITEM_KINDS);
    }
    expect(itemFieldApplies('loan_months_off', 'loan_payment')).toBe(false);
  });
});

describe('applyItemFields: the editor sheet save', () => {
  it.each(EDITOR_CASES)('stores what the editor stores: %s', (_label, stored, form) => {
    const isNew = stored === null;
    const items = [STORED_EXPENSE, STORED_LOAN, { id: 'rent-item' }];
    const base = isNew ? NEW_ITEM : stored;
    const expected = oldEditorItem(base, form, { isNew, items, today: TODAY });
    const out = applyItemFields(base, formFields(base, form), { todayIso: TODAY, prev: isNew ? null : stored });
    const actual = isNew ? { ...out, id: newItemId(items, out) } : out;
    expect(json(actual)).toEqual(json(expected));
    expect(checkItem(actual, ITEM_DATA)).toBeNull();
  });

  it('covers every kind', () => {
    expect(new Set(EDITOR_CASES.map(([, , form]) => form.kind))).toEqual(new Set(ITEM_KINDS));
  });

  it('posts an account transfer and a loan payment on a schedule, as the editor forces', () => {
    const transfer = applyItemFields(NEW_ITEM, { kind: 'account_transfer', as_schedule: false }, { todayIso: TODAY, prev: null });
    expect(transfer.as_schedule).toBe(true);
    expect(transfer.as_schedule_since).toBe(TODAY);
    const loan = applyItemFields(STORED_LOAN, { as_schedule: false }, { todayIso: TODAY, prev: STORED_LOAN });
    expect(loan.as_schedule).toBe(true);
    expect(loan.as_schedule_since).toBe('2025-01-01');
  });

  it('never changes the stored item', () => {
    const stored = structuredClone(STORED_EXPENSE);
    applyItemFields(stored, { kind: 'account_transfer', monthly_schedule: { Feb: 5 } }, { todayIso: TODAY, prev: stored });
    expect(stored).toEqual(STORED_EXPENSE);
  });
});

describe('applyItemFields: a single field touches only its own keys', () => {
  const BASE = {
    ...NEW_ITEM, id: 'groceries-item', envelope_id: 'groceries', default_amount: -300, stress_category: 'C',
    stress_cut_pct: 0.1, stress_cut_pcts: { A: 0.4, B: 0.2, C: 0.1 }, monthly_schedule: { Jan: true },
    skipped_occurrences: ['2026-03'], funding_style: 'bill', loan_rate: 3, loan_months_off: { Nov: true },
  };
  const apply = (fields, item = BASE) => applyItemFields(item, fields, { todayIso: TODAY, prev: item });
  it('a stress cut', () => {
    expect(apply({ stress_cut_pcts: { A: 0.5, B: 0.3, C: 0.1 } })).toEqual({ ...BASE, stress_cut_pcts: { A: 0.5, B: 0.3, C: 0.1 } });
    expect(apply({ stress_cut_pct: 0.4 })).toEqual({ ...BASE, stress_cut_pct: 0.4 });
  });
  it('the emergency flag', () => {
    expect(apply({ include_in_emergency_budget: true })).toEqual({ ...BASE, include_in_emergency_budget: true });
    const income = { ...BASE, kind: 'income', default_amount: 300 };
    expect(apply({ include_in_emergency_budget: true }, income)).toEqual(income);
  });
  it('include', () => {
    expect(apply({ include: false })).toEqual({ ...BASE, include: false });
    const legacy = { ...BASE };
    delete legacy.as_schedule_since;
    expect(apply({ include: false }, legacy)).toEqual({ ...legacy, include: false });
  });
  it('monthly_schedule', () => {
    expect(apply({ monthly_schedule: { Mar: true, Apr: 75 } })).toEqual({ ...BASE, monthly_schedule: { Mar: true, Apr: 75 } });
  });
  it('monthly_schedule prunes loan_months_off: a month switched back on is the user\'s', () => {
    const pruned = { ...BASE, monthly_schedule: { Jan: true, Nov: true } };
    delete pruned.loan_months_off;
    expect(apply({ monthly_schedule: { Jan: true, Nov: true } })).toEqual(pruned);
  });
  it('keeps the legacy loan_rate, which the engine still falls back to; the full save drops it', () => {
    for (const fields of [{ include: false }, { include_in_emergency_budget: true }, { stress_cut_pct: 0.3 },
      { stress_category: 'Z' }, { monthly_schedule: { Feb: true } }, { as_schedule: true, account_id: 'bank' }]) {
      expect(apply(fields).loan_rate).toBe(3);
    }
    expect(apply({ kind: 'expense' })).not.toHaveProperty('loan_rate');
  });
  it('a stress category: none or Z clears the cuts, another one leaves them', () => {
    const cleared = { ...BASE, stress_category: 'Z', stress_cut_pct: 0 };
    delete cleared.stress_cut_pcts;
    expect(apply({ stress_category: 'Z' })).toEqual(cleared);
    expect(apply({ stress_category: null })).toEqual({ ...cleared, stress_category: null });
    expect(apply({ stress_category: 'E' })).toEqual({ ...BASE, stress_category: 'E' });
  });
  it('a field the kind has no use for gets its off value', () => {
    expect(apply({ to_account_id: 'savings' })).toEqual({ ...BASE, to_account_id: null });
    expect(apply({ loan_fee: 3 })).toEqual(BASE);
  });
  it('start_month: set, trimmed, cleared; the end month and the legacy end date stay', () => {
    const dated = { ...BASE, end_month: '2027-06', as_schedule_until: '2027-01-01' };
    expect(apply({ start_month: '2026-11' }, dated)).toEqual({ ...dated, start_month: '2026-11' });
    expect(apply({ start_month: ' 2026-11 ' }, dated)).toEqual({ ...dated, start_month: '2026-11' });
    const started = { ...dated, start_month: '2026-11' };
    expect(apply({ start_month: null }, started)).toEqual({ ...dated, start_month: null });
    expect(apply({ start_month: '' }, started)).toEqual({ ...dated, start_month: null });
  });
  it('end_month: set or cleared keeps the start month and replaces the legacy end date', () => {
    const dated = { ...BASE, start_month: '2026-11', as_schedule_until: '2027-01-01' };
    const noLegacy = { ...dated };
    delete noLegacy.as_schedule_until;
    expect(apply({ end_month: '2027-06' }, dated)).toEqual({ ...noLegacy, end_month: '2027-06' });
    expect(apply({ end_month: null }, { ...dated, end_month: '2027-06' })).toEqual({ ...noLegacy, end_month: null });
  });
  it('another field leaves both months alone', () => {
    const dated = { ...BASE, start_month: '2026-11', end_month: '2027-06' };
    expect(apply({ include: false }, dated)).toEqual({ ...dated, include: false });
  });
  it('a loan payment takes no months', () => {
    const loan = { ...STORED_LOAN };
    delete loan.start_month;
    delete loan.end_month;
    expect(apply({ start_month: '2026-11' }, loan)).toEqual(loan);
    expect(apply({ end_month: '2027-06' }, loan)).toEqual(loan);
  });
});

describe('applyItemFields: as_schedule_since', () => {
  const SCHEDULED = { ...NEW_ITEM, id: 's', envelope_id: 'rent', default_amount: -900, as_schedule: true, account_id: 'bank', payment_day: 1, as_schedule_since: '2026-01-01' };
  it('include true → false → true restarts today, as sinceOnSave does', () => {
    const off = applyItemFields(SCHEDULED, { include: false }, { todayIso: '2026-05-01', prev: SCHEDULED });
    expect(off.as_schedule_since).toBe('2026-01-01');
    const on = applyItemFields(off, { include: true }, { todayIso: TODAY, prev: off });
    expect(on.as_schedule_since).toBe(TODAY);
    expect(on.as_schedule_since).toBe(sinceOnSave({ prevItem: off, nextInclude: true, nextKind: 'expense', asSchedule: true, today: TODAY }));
  });
  it('as_schedule on stamps today, off clears it and the day type', () => {
    const plain = { ...SCHEDULED, as_schedule: false, as_schedule_since: null, account_id: 'bank' };
    const on = applyItemFields(plain, { as_schedule: true }, { todayIso: TODAY, prev: plain });
    expect(on).toEqual({ ...plain, as_schedule: true, as_schedule_since: TODAY });
    const off = applyItemFields({ ...SCHEDULED, schedule_day_type: 'next_work_day' }, { as_schedule: false }, { todayIso: TODAY, prev: SCHEDULED });
    expect(off).toMatchObject({ as_schedule: false, as_schedule_since: null, schedule_day_type: 'exact', account_id: 'bank' });
    const income = { ...SCHEDULED, kind: 'income', default_amount: 900 };
    expect(applyItemFields(income, { as_schedule: false }, { todayIso: TODAY, prev: income }).account_id).toBeNull();
  });
  it('reads a kindless or unknown-kind item as an expense, so it is not taken for a kind change', () => {
    for (const legacyKind of [undefined, 'gift']) {
      const legacy = { ...SCHEDULED, kind: legacyKind, as_schedule_since: '2025-01-01' };
      if (legacyKind === undefined) delete legacy.kind;
      expect(applyItemFields(legacy, { include: true }, { todayIso: TODAY, prev: legacy }).as_schedule_since).toBe('2025-01-01');
      expect(applyItemFields(legacy, { kind: 'expense' }, { todayIso: TODAY, prev: legacy }).as_schedule_since).toBe('2025-01-01');
      expect(applyItemFields(legacy, { kind: 'income' }, { todayIso: TODAY, prev: legacy }).as_schedule_since).toBe(TODAY);
    }
  });
  it('an unrelated field leaves it alone', () => {
    expect(applyItemFields(SCHEDULED, { description: 'Rent' }, { todayIso: TODAY, prev: SCHEDULED }).as_schedule_since).toBe('2026-01-01');
  });
});

describe('applyItemFields: the amount sign follows the kind', () => {
  const at = (item, fields) => applyItemFields(item, fields, { todayIso: TODAY, prev: item }).default_amount;
  const expense = { ...NEW_ITEM, envelope_id: 'rent', default_amount: -50 };
  it('normalises any sign', () => {
    expect(at(expense, { default_amount: 50 })).toBe(-50);
    expect(at(expense, { default_amount: -50 })).toBe(-50);
    expect(at({ ...expense, kind: 'income' }, { default_amount: -50 })).toBe(50);
    expect(at({ ...expense, kind: 'investment_transfer', direction: 'dividend' }, { default_amount: -12 })).toBe(12);
    expect(at({ ...expense, kind: 'investment_transfer', direction: 'buy' }, { default_amount: 12 })).toBe(-12);
    expect(at(expense, { kind: 'account_transfer' })).toBe(-50);
  });
  it('flips the stored amount when the kind or the direction changes', () => {
    expect(at(expense, { kind: 'income' })).toBe(50);
    expect(at({ ...expense, kind: 'investment_transfer', direction: 'buy' }, { direction: 'dividend' })).toBe(50);
  });
});

describe('checkItem', () => {
  const valid = { ...NEW_ITEM, id: 'x', envelope_id: 'rent', default_amount: -900, monthly_schedule: { Mar: true } };
  const paths = (item) => checkItem(item, ITEM_DATA)?.params.errors.map(e => e.path);
  it('passes a valid item', () => {
    expect(checkItem(valid, ITEM_DATA)).toBeNull();
    expect(checkItem({ ...valid, kind: undefined }, ITEM_DATA)).toBeNull();
  });
  it('checks a stored unknown kind as an expense, as the editor reads it', () => {
    expect(checkItem({ ...valid, kind: 'gift' }, ITEM_DATA)).toBeNull();
    expect(checkItem({ ...valid, kind: 'gift', envelope_id: null }, ITEM_DATA)).toBeNull();
  });
  it('refuses with bad_input and the paths at fault', () => {
    expect(paths({ ...valid, default_amount: 0 })).toEqual(['default_amount']);
    expect(paths({ ...valid, default_amount: -1e12 })).toEqual(['default_amount']);
    expect(checkItem({ ...valid, envelope_id: null }, ITEM_DATA)).toBeNull();
    expect(paths({ ...valid, envelope_id: 'nope', account_id: 'gone' })).toEqual(['envelope_id', 'account_id']);
    expect(paths({ ...valid, as_schedule: true })).toEqual(['account_id', 'payment_day']);
    expect(paths({ ...valid, as_schedule: true, account_id: 'bank', payment_day: 32 })).toEqual(['payment_day']);
    const inv = { ...valid, kind: 'investment_transfer', direction: 'buy' };
    expect(paths(inv)).toEqual(['investment_account_id']);
    expect(paths({ ...inv, investment_account_id: 'broker', as_schedule: true, account_id: 'broker', payment_day: 1 })).toEqual(['account_id']);
    expect(paths({ ...inv, direction: 'dividend', envelope_id: null, investment_account_id: 'broker', default_amount: 5 })).toEqual(['symbol']);
    const tr = { ...valid, kind: 'account_transfer', envelope_id: null, as_schedule: true, payment_day: 1 };
    expect(paths(tr)).toEqual(['account_id', 'to_account_id']);
    expect(paths({ ...tr, account_id: 'bank', to_account_id: 'bank' })).toEqual(['to_account_id']);
    const loan = { ...valid, kind: 'loan_payment', envelope_id: 'loan-env', as_schedule: true, account_id: 'bank', payment_day: 1 };
    expect(paths(loan)).toEqual(['to_account_id']);
    expect(paths({ ...loan, to_account_id: 'mortgage', loan_fee: -1 })).toEqual(['loan_fee']);
    expect(paths({ ...loan, to_account_id: 'mortgage', loan_method: 'annuity', loan_end: '2030' })).toEqual(['loan_end']);
    expect(paths({ ...loan, to_account_id: 'mortgage', loan_method: 'annuity', loan_end: '2030-06' })).toBeUndefined();
  });
  it('refuses a malformed month and an end before the start', () => {
    expect(checkItem({ ...valid, start_month: '2026-10', end_month: '2026-12' }, ITEM_DATA)).toBeNull();
    expect(checkItem({ ...valid, start_month: '2026-10', end_month: '2026-10' }, ITEM_DATA)).toBeNull();
    expect(checkItem({ ...valid, start_month: null, end_month: '2026-10' }, ITEM_DATA)).toBeNull();
    expect(checkItem({ ...valid, start_month: '2026-10', end_month: '2026-09' }, ITEM_DATA)).toEqual({
      code: 'bad_input', params: { errors: [{ path: 'end_month', message: 'must not be before start_month' }] },
    });
    expect(paths({ ...valid, start_month: '2026-13' })).toEqual(['start_month']);
    expect(paths({ ...valid, end_month: '2026-1' })).toEqual(['end_month']);
    expect(paths({ ...valid, start_month: 202610 })).toEqual(['start_month']);
  });
  it('leaves the legacy template_id unchecked', () => {
    expect(checkItem({ ...valid, template_id: 'deleted-template' }, ITEM_DATA)).toBeNull();
  });
  it('refuses an included item with no active month; an excluded one may keep none', () => {
    const noMonths = { code: 'bad_input', params: { errors: [{ path: 'monthly_schedule', message: 'needs at least one active month while the item is included' }] } };
    for (const monthly_schedule of [{}, undefined, null, { Jan: false, Feb: 0 }]) {
      expect(checkItem({ ...valid, monthly_schedule }, ITEM_DATA)).toEqual(noMonths);
      expect(checkItem({ ...valid, monthly_schedule, include: false }, ITEM_DATA)).toBeNull();
    }
    // A missing include is included, as the engine reads it.
    expect(checkItem({ ...valid, monthly_schedule: {}, include: undefined }, ITEM_DATA)).toEqual(noMonths);
    // A custom amount is an active month; loan upkeep's `false` months are off.
    expect(checkItem({ ...valid, monthly_schedule: { Jan: false, Jun: 45 } }, ITEM_DATA)).toBeNull();
  });
});

describe('newItemId', () => {
  it('builds the editor id', () => {
    const items = [{ id: 'income-item' }];
    expect(newItemId(items, { kind: 'income' })).toBe('income-item-2');
    expect(newItemId([], { kind: 'investment_transfer', direction: 'dividend', symbol: 'VWCE' })).toBe('dividend-vwce-item');
    expect(newItemId([], { kind: 'investment_transfer', direction: 'buy', envelope_id: 'invest' })).toBe('invest-item');
    expect(newItemId([], { kind: 'account_transfer', envelope_id: 'rent' })).toBe('transfer-item');
    expect(newItemId([], { kind: 'expense', envelope_id: 'Rent Ä' })).toBe('rent-a-item');
    expect(newItemId([], { kind: 'expense', envelope_id: '' })).toBe('item-item');
  });
});

// ── Templates ───────────────────────────────────────────────────────────────

const TPL_DATA = {
  envelopes: [{ id: 'groceries' }, { id: 'rent' }, { id: 'buffer' }, { id: 'old', archived: true }],
  envelopeTemplates: [
    { id: 'monthly', name: 'Monthly', kind: 'manual', lines: [{ envelope_id: 'rent', mode: 'add', amount: 900 }] },
    { id: 'twin-a', name: 'Twin', kind: 'manual', lines: [{ envelope_id: 'rent', mode: 'add', amount: 1 }] },
    { id: 'twin-b', name: 'twin', kind: 'manual', lines: [{ envelope_id: 'rent', mode: 'add', amount: 1 }] },
  ],
};

// The schedule section's getSchedule at aec9887 (js/pages/templates.js 998-1036),
// its DOM reads replaced by `form`.
function oldGetSchedule(tpl, form, { targetEnvelopeIds = [] } = {}) {
  if (!form.enabled) {
    return tpl.schedule ? { ...tpl.schedule, enabled: false } : undefined;
  }
  const months = {};
  form.cells.forEach(mon => { months[mon] = true; });
  if (Object.keys(months).length === 0) return { error: 'templatesPage.scheduleNeedMonth' };
  const day = Math.min(31, Math.max(1, Math.floor(Number(form.day) || 1)));
  const out = { enabled: true, payment_day: day, day_type: form.dayType, months };
  if (/^\d{4}-\d{2}-\d{2}$/.test(form.since)) out.since = form.since;
  if (/^\d{4}-\d{2}-\d{2}$/.test(form.until)) {
    if (out.since && form.until < out.since) return { error: 'templatesPage.scheduleUntilBeforeSince' };
    out.until = form.until;
  }
  const keep = (tpl.schedule?.skipped || []).filter(k => /^\d{4}-\d{2}$/.test(k));
  if (keep.length) out.skipped = keep;
  const srcId = form.src;
  if (srcId) {
    if (targetEnvelopeIds.includes(srcId)) return { error: 'templatesPage.scheduleSourceIsTarget' };
    out.source_envelope_id = srcId;
    if (/^\d{4}-\d{2}-\d{2}$/.test(form.srcSince)) out.source_since = form.srcSince;
  }
  return out;
}

// The manual and dynamic submit handlers' `saved` (templates.js 428-462, 739-773).
function oldSaved(tpl, form, { existing, templates }) {
  const name = form.name.trim();
  const dynamic = form.kind === 'dynamic';
  const rows = dynamic
    ? form.rows.map(r => ({ envelope_id: r.envelope_id, mode: r.mode, percent: Math.max(0, Number(r.value) || 0) })).filter(a => a.envelope_id && a.percent > 0)
    : form.rows.map(r => ({ envelope_id: r.envelope_id, mode: r.mode, amount: Math.abs(Number(r.value) || 0) })).filter(l => l.envelope_id && l.amount > 0);
  const taken = new Set((templates || []).map(x => x.id).filter(id => id !== tpl.id));
  const id = !existing ? uniqueId(slugify(name) || 'template', taken) : tpl.id;
  const sched = oldGetSchedule(tpl, form.sched, { targetEnvelopeIds: rows.map(l => l.envelope_id) });
  const saved = { id, name, description: form.desc.trim() || null, kind: dynamic ? 'dynamic' : 'manual', [dynamic ? 'assignments' : 'lines']: rows };
  if (sched) saved.schedule = sched;
  return saved;
}

// What the editor sends as `fields`.
function tplFields(tpl, form) {
  const dynamic = form.kind === 'dynamic';
  const s = form.sched;
  let schedule = null;
  if (s.enabled) {
    schedule = { enabled: true, payment_day: Math.floor(Number(s.day) || 1), day_type: s.dayType, months: Object.fromEntries(s.cells.map(m => [m, true])) };
    if (s.since) schedule.since = s.since;
    if (s.until) schedule.until = s.until;
    if (tpl.schedule?.skipped) schedule.skipped = tpl.schedule.skipped;
    if (s.src) schedule.source_envelope_id = s.src;
    if (s.srcSince) schedule.source_since = s.srcSince;
  } else if (tpl.schedule) {
    schedule = { ...tpl.schedule, enabled: false };
  }
  return {
    name: form.name,
    description: form.desc,
    kind: form.kind,
    [dynamic ? 'assignments' : 'lines']: form.rows.map(r => ({ envelope_id: r.envelope_id, mode: r.mode, [dynamic ? 'percent' : 'amount']: Number(r.value) || 0 })),
    schedule,
  };
}

const SCHED_OFF = { enabled: false, cells: [], day: '', dayType: 'exact', since: '', until: '', src: '', srcSince: '' };
// A stored schedule is load-normalised (js/state/normalize-templates.js), so
// its `skipped` holds only YYYY-MM months.
const STORED_TPL = {
  id: 'monthly', name: 'Monthly', description: 'Old', kind: 'manual',
  lines: [{ envelope_id: 'rent', mode: 'add', amount: 900 }],
  schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: { Jan: true }, since: '2026-01-01', skipped: ['2026-02'] },
};
const TEMPLATE_CASES = [
  ['a new manual template, no schedule', null, {
    kind: 'manual', name: '  Pay day ', desc: ' ', sched: SCHED_OFF,
    rows: [{ envelope_id: 'rent', mode: 'add', value: '900' }, { envelope_id: 'groceries', mode: 'set', value: '0' }, { envelope_id: '', mode: 'add', value: '5' }],
  }],
  ['an existing manual template rescheduled with a source', STORED_TPL, {
    kind: 'manual', name: 'Monthly', desc: 'New', rows: [{ envelope_id: 'rent', mode: 'set', value: '950' }],
    sched: { enabled: true, cells: ['Jan', 'Jul'], day: '40', dayType: 'next_work_day', since: '2026-01-01', until: '2026-12-31', src: 'buffer', srcSince: '2026-03-01' },
  }],
  ['an existing manual template with its schedule switched off', STORED_TPL, {
    kind: 'manual', name: 'Monthly', desc: 'Old', rows: [{ envelope_id: 'rent', mode: 'add', value: '900' }], sched: SCHED_OFF,
  }],
  ['a new dynamic template, scheduled', null, {
    kind: 'dynamic', name: 'Split', desc: 'Half', rows: [{ envelope_id: 'rent', mode: 'add', value: '50' }, { envelope_id: 'groceries', mode: 'add', value: '-5' }],
    sched: { enabled: true, cells: ['Mar'], day: '15', dayType: 'exact', since: '2026-03-01', until: '', src: '', srcSince: '' },
  }],
];

describe('template field declarations', () => {
  it('declare the editable fields as supported schemas', () => {
    expect(Object.keys(TEMPLATE_FIELD_PROPERTIES).sort()).toEqual(['assignments', 'description', 'kind', 'lines', 'name', 'schedule']);
    const S = { type: 'object', properties: TEMPLATE_FIELD_PROPERTIES };
    expect(() => assertSchema(S)).not.toThrow();
    expect(validate({ lines: [{ envelope_id: 'rent', mode: 'add', amount: 0 }] }, S).ok).toBe(false);
    expect(validate({ assignments: [{ envelope_id: 'rent', mode: 'add', percent: 1001 }] }, S).ok).toBe(false);
    expect(validate({ schedule: { enabled: true, payment_day: 0, months: { Jan: true } } }, S).ok).toBe(false);
    expect(validate({ schedule: STORED_TPL.schedule }, S).ok).toBe(true);
  });
});

describe('applyTemplateFields: the editor sheets', () => {
  it.each(TEMPLATE_CASES)('stores what the editor stores: %s', (_label, stored, form) => {
    const existing = stored !== null;
    const tpl = existing ? stored : {};
    const expected = oldSaved(tpl, form, { existing, templates: TPL_DATA.envelopeTemplates });
    const out = applyTemplateFields(tpl, tplFields(tpl, form));
    const actual = existing ? out : { id: newTemplateId(TPL_DATA.envelopeTemplates, out.name), ...out };
    expect(json(actual)).toEqual(json(expected));
    expect(checkTemplate(actual, TPL_DATA)).toBeNull();
  });

  it('keeps fields the editor does not render, and drops the other kind\'s list on a kind change', () => {
    const tpl = { ...STORED_TPL, note: 'kept', assignments: [] };
    expect(applyTemplateFields(tpl, { description: 'x' })).toEqual({ ...tpl, description: 'x' });
    const dyn = applyTemplateFields(tpl, { kind: 'dynamic', assignments: [{ envelope_id: 'rent', mode: 'add', percent: 50 }] });
    expect(dyn).not.toHaveProperty('lines');
    expect(dyn.note).toBe('kept');
    expect(applyTemplateFields(dyn, { kind: 'manual', lines: [] })).not.toHaveProperty('assignments');
  });

  it('removes an empty skipped list and a null schedule', () => {
    const sched = applyTemplateFields(STORED_TPL, { schedule: { ...STORED_TPL.schedule, skipped: ['junk'] } }).schedule;
    expect(sched).not.toHaveProperty('skipped');
    expect(applyTemplateFields(STORED_TPL, { schedule: null })).not.toHaveProperty('schedule');
  });
});

describe('checkTemplate', () => {
  const tpl = { id: 'new', name: 'New', description: null, kind: 'manual', lines: [{ envelope_id: 'rent', mode: 'add', amount: 5 }] };
  const sched = { enabled: true, payment_day: 1, day_type: 'exact', months: { Jan: true } };
  const paths = (x) => checkTemplate(x, TPL_DATA)?.params.errors?.map(e => e.path);
  it('applies the name rule only when the name changes', () => {
    expect(checkTemplate({ ...tpl, name: ' ' }, TPL_DATA)?.code).toBe('bad_input');
    expect(checkTemplate({ ...tpl, name: 'MONTHLY' }, TPL_DATA)).toEqual({ code: 'name_taken', params: { kind: 'template', name: 'MONTHLY' } });
    expect(checkTemplate({ ...TPL_DATA.envelopeTemplates[1] }, TPL_DATA)).toBeNull();
    expect(checkTemplate({ ...TPL_DATA.envelopeTemplates[0], name: 'Monthly' }, TPL_DATA)).toBeNull();
  });
  it('needs a line or an assignment, one per envelope', () => {
    expect(paths({ ...tpl, lines: [] })).toEqual(['lines']);
    expect(paths({ ...tpl, kind: 'dynamic', lines: undefined, assignments: [] })).toEqual(['assignments']);
    expect(paths({ ...tpl, lines: [...tpl.lines, { envelope_id: 'rent', mode: 'set', amount: 9 }] })).toEqual(['lines[1].envelope_id']);
  });
  it('checks an enabled schedule', () => {
    expect(paths({ ...tpl, schedule: { ...sched, months: {} } })).toEqual(['schedule.months']);
    expect(paths({ ...tpl, schedule: { ...sched, months: {}, enabled: false } })).toBeUndefined();
    expect(paths({ ...tpl, schedule: { ...sched, since: '2026-05-01', until: '2026-04-30' } })).toEqual(['schedule.until']);
    expect(paths({ ...tpl, schedule: { ...sched, source_envelope_id: 'rent' } })).toEqual(['schedule.source_envelope_id']);
    expect(paths({ ...tpl, schedule: { ...sched, source_envelope_id: 'old' } })).toEqual(['schedule.source_envelope_id']);
    expect(paths({ ...tpl, schedule: { ...sched, source_since: '2026-01-01' } })).toEqual(['schedule.source_since']);
    expect(paths({ ...tpl, schedule: { ...sched, source_envelope_id: 'buffer', source_since: '2026-01-01' } })).toBeUndefined();
  });
});

describe('newTemplateId', () => {
  it('slugs the name, avoiding taken ids', () => {
    expect(newTemplateId(TPL_DATA.envelopeTemplates, 'Monthly')).toBe('monthly-2');
    expect(newTemplateId([], '!!!')).toBe('template');
  });
});

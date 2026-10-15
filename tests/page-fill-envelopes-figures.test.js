// @vitest-environment jsdom
// The Fill sheet's figures read queries: `balances` (the active lens) for the
// row balances and the Unallocated pill, `envelopes.month { spare: true }`
// for each row's spare, and `fill.preview` for the spare a pending fill
// leaves, one call for every row with an entry, 200 ms after the last edit.
// Cover shortfalls, the remainder pill and a row's "after" balance are form
// arithmetic on the entries and those answers.
//
// Every figure is pinned against the sheet's old composition (the engine
// calls it made, copied below verbatim), so the switch changes nothing on
// screen. The page stub's viewTxs ignores the lens; here it is the real lens
// over the fake state (as js/app.js resolves it).
//
// Ledger (resetState's chk 1000 and sav 500; envelopes food / fun / rent and
// an archived "Gone"):
//   1 Sep   fill   food +300, fun +40, rent +500, gone +20
//   25 Sep  income 100 Bonus on chk, no envelope, scheduled (Today leaves it out)
//   2 Oct   expense 30 Later on chk, fun, scheduled (future-dated)
//   plan:   Groceries 300/mo on food (planned), Rent 1000/mo on rent from chk
//           on the 20th (scheduled), Salary 3000/mo into chk on the 20th
//   templates: food +250 and rent +900 on the 1st
// Food and Rent are short (Rent most), Fun is not.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../js/app.js', async () => {
  const fake = await import('./_fakes/pageApp.js');
  const { lensTransactions } = await import('../js/engine/lens.js');
  return {
    ...fake.appStub,
    viewTxs: vi.fn((o) => {
      const { lens, horizon } = fake.appStub.activeLensInput();
      return lensTransactions(o ? { ...fake.state, transactions: o } : fake.state, { lens, horizon, today: fake.FIXED_NOW });
    }),
  };
});

import { viewTxs } from '../js/app.js';
import { openFillEnvelopes } from '../js/pages/fill-envelopes.js';
import {
  computeEnvelopeBalances, computeAccountBalances, computeUnallocated, computeSpareByEnvelope,
  projectEnvelopeBalance, envelopeFloor,
} from '../js/engine.js';
import { fillLineForRow } from '../js/pages/fill-line.js';
import { moneyEl } from '../js/ui/money.js';
import { t, trEnv, fmtDateLang } from '../js/ui/i18n.js';
import { fmt } from '../js/utils.js';
import { state, prefs, session, writeBatch, resetState, mountHosts, setValue, toastTexts, FIXED_NOW } from './_fakes/pageApp.js';

const every = Object.fromEntries(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(m => [m, true]));

function seed() {
  resetState({
    transactions: [
      { id: 'f1', type: 'fill', date: '2026-09-01', status: 'posted', source: 'allocation',
        lines: [{ envelope_id: 'food', mode: 'add', amount: 300 }, { envelope_id: 'fun', mode: 'add', amount: 40 },
          { envelope_id: 'rent', mode: 'add', amount: 500 }, { envelope_id: 'gone', mode: 'add', amount: 20 }] },
      { id: 'bonus', type: 'income', date: '2026-09-25', payee: 'Bonus', amount: 100, account: 'chk', envelope_id: null, status: 'scheduled' },
      { id: 'later', type: 'expense', date: '2026-10-02', payee: 'Later', amount: 30, account: 'chk', envelope_id: 'fun', status: 'scheduled' },
    ],
  });
  state.envelopes = [...state.envelopes, { id: 'gone', name: 'Gone', category: 'living', archived: true }];
  state.budgetItems = [
    { id: 'gi', kind: 'expense', envelope_id: 'food', description: 'Groceries', default_amount: -300, extra_buffer: 0, include: true, monthly_schedule: every, as_schedule: false },
    { id: 'ri', kind: 'expense', envelope_id: 'rent', description: 'Rent', default_amount: -1000, extra_buffer: 0, include: true, monthly_schedule: every,
      as_schedule: true, account_id: 'chk', payment_day: 20, schedule_day_type: 'exact', as_schedule_since: '2026-01-01' },
    { id: 'sal', kind: 'income', envelope_id: null, description: 'Salary', default_amount: 3000, extra_buffer: 0, include: true, monthly_schedule: every,
      as_schedule: true, account_id: 'chk', payment_day: 20, schedule_day_type: 'exact', as_schedule_since: '2026-01-01' },
  ];
  state.envelopeTemplates = [
    { id: 'tf', name: 'Food fill', kind: 'manual', lines: [{ envelope_id: 'food', mode: 'add', amount: 250 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: every } },
    { id: 'tr', name: 'Rent fill', kind: 'manual', lines: [{ envelope_id: 'rent', mode: 'add', amount: 900 }],
      schedule: { enabled: true, payment_day: 1, day_type: 'exact', months: every } },
  ];
}

const LENSES = [
  { name: 'today', set: { lens: 'today' } },
  { name: 'booked', set: { lens: 'booked' } },
  { name: 'forecast (eom)', set: { lens: 'forecast', lensHorizon: 'eom' } },
];

// ── The sheet's old composition, verbatim (fill-envelopes.js before 4d) ──────
function round2(n) { return Math.round(n * 100) / 100; }
function todayIso() {
  const d = new Date(FIXED_NOW);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function oldOpen() {
  const lensTxs = viewTxs();
  const envBalances = computeEnvelopeBalances(lensTxs);
  const acctBalances = computeAccountBalances(state.accounts || [], lensTxs);
  const unallocated = computeUnallocated(acctBalances, envBalances, state.accounts);
  const active = (state.envelopes || []).filter(e => !e.archived);
  const spareInput = {
    transactions: state.transactions,
    budgetItems: state.budgetItems,
    envelopeTemplates: state.envelopeTemplates,
    accounts: state.accounts,
    envelopes: active,
    today: new Date(FIXED_NOW),
    months: 12,
    country: state.meta?.country ?? 'FI',
    tombstones: state.meta?.scheduledTombstones || [],
  };
  const spareByEnv = computeSpareByEnvelope(spareInput);
  const spareOf = (env) => {
    const sp = spareByEnv.get(env.id);
    return sp && Number.isFinite(sp.spare) ? sp.spare : null;
  };
  const shortEnvs = active
    .filter(env => (spareOf(env) ?? 0) < -0.005)
    .sort((a, b) => spareOf(a) - spareOf(b));
  return { envBalances, unallocated, active, spareInput, spareOf, shortEnvs };
}
// fill-line.js spareAfterFill, verbatim.
function spareAfterFill(input, envelopeId, lines, dateStr) {
  const hypothetical = { id: 'preview:fill', type: 'fill', date: dateStr, status: 'posted', source: 'allocation', lines };
  const projection = projectEnvelopeBalance({ ...input, envelopeId, transactions: [...(input.transactions || []), hypothetical] });
  if (projection.unresolved || !projection.low) return null;
  const floor = envelopeFloor(input.budgetItems, envelopeId);
  return { spare: round2(projection.low.balance - floor), lowDate: projection.low.date };
}
const spareText = (spare) => spare < -0.005
  ? t('fillEnvelopes.shortfallLine')(fmt(Math.abs(spare)))
  : `(${t('envelopes.spareLine')(fmt(spare))})`;
const money = (v) => moneyEl(v, { size: 'md' }).textContent;
const nb = (str) => String(str).replace(/ /g, ' ');

// ── Sheet accessors ──────────────────────────────────────────────────────────
const sheet = () => document.querySelector('#sheet-host .sheet');
const title = () => {
  const s = document.querySelector('#sheet-host .sheet');
  return document.getElementById(s.getAttribute('aria-labelledby')).textContent;
};
function row(envId) {
  const env = state.envelopes.find(e => e.id === envId);
  return [...sheet().querySelectorAll('.fill-env-row')].find(r => r.querySelector('.fill-env-name').textContent === trEnv(env));
}
const rowIds = (rows) => rows.map(r => state.envelopes.find(e => trEnv(e) === r.querySelector('.fill-env-name').textContent).id);
const balanceOf = (id) => row(id).querySelector('.fill-env-current .num-md').textContent;
const spareEl = (id) => row(id).querySelector('.fill-env-spare');
const inputOf = (id) => row(id).querySelector('.fill-env-input');
const warnOf = (id) => row(id).querySelector('.fill-env-warn');
const modeBtn = (id, which) => row(id).querySelectorAll('.fill-env-mode')[which === 'add' ? 0 : 1];
const unallocatedPill = () => sheet().querySelector('.fill-env-header .fill-env-pill:not(.fill-env-remainder) > span:last-child').textContent;
const remainderText = () => sheet().querySelector('.fill-env-remainder-val').textContent;
const coverBtn = () => [...sheet().querySelectorAll('.fill-env-footer .btn-ghost')].find(b => b.textContent === t('fillEnvelopes.coverShortfalls'));
// The shortfall check waits 200 ms for typing to settle.
const settle = () => new Promise(r => setTimeout(r, 250));

let querySpy;
beforeEach(() => {
  seed();
  mountHosts();
  vi.stubGlobal('requestAnimationFrame', (cb) => setTimeout(cb, 0));
  querySpy?.mockRestore();
  querySpy = vi.spyOn(session, 'query');
});
const asked = (name) => querySpy.mock.calls.filter(([n]) => n === name).map(([, input]) => input);

describe('Fill sheet: the lens-dependent header and balances', () => {
  for (const { name, set } of LENSES) {
    it(`${name}: the title names the lens, the pill and the rows show its balances`, () => {
      Object.assign(prefs, set);
      const old = oldOpen();
      openFillEnvelopes();
      expect(title()).toBe(t('fillEnvelopes.titleLens')(t('lens.' + set.lens)));
      expect(unallocatedPill()).toBe(money(old.unallocated));
      expect(remainderText()).toBe(money(round2(old.unallocated)));
      for (const env of old.active) expect(balanceOf(env.id)).toBe(money(old.envBalances.get(env.id) || 0));
    });
  }

  it('the balances differ between the lenses (the fixture exercises them)', () => {
    const pills = LENSES.map(({ set }) => {
      for (const k of Object.keys(prefs)) delete prefs[k];
      Object.assign(prefs, set);
      return oldOpen().unallocated;
    });
    expect(new Set(pills).size).toBe(3);
  });

  it('asks balances through the active lens and envelopes.month for the spare, once at open', () => {
    Object.assign(prefs, { lens: 'forecast', lensHorizon: 'eom' });
    openFillEnvelopes();
    expect(asked('balances')).toEqual([{ lens: 'forecast', horizon: 'eom' }, { lens: 'today' }]);
    expect(asked('envelopes.month')).toEqual([{ lens: 'forecast', horizon: 'eom', date: '2026-09-15', spare: true }]);
    expect(asked('fill.preview')).toEqual([]);
  });
});

describe('Fill sheet: spare and the short group', () => {
  beforeEach(() => { Object.assign(prefs, { lens: 'booked' }); });

  it('each row shows its spare, a negative one as short', () => {
    const old = oldOpen();
    openFillEnvelopes();
    for (const env of old.active) {
      const spare = old.spareOf(env);
      expect(spareEl(env.id).hidden).toBe(false);
      expect(spareEl(env.id).textContent).toBe(spareText(spare));
      expect(spareEl(env.id).classList.contains('is-short')).toBe(spare < -0.005);
    }
    expect(old.active.map(e => old.spareOf(e) < -0.005)).toEqual([true, false, true]);
  });

  it('short envelopes come first, most short at the top; the rest fold into their categories', () => {
    const old = oldOpen();
    openFillEnvelopes();
    const shortGroup = sheet().querySelector('.fill-env-group--short');
    expect(shortGroup.querySelector('.fill-env-group-head').textContent).toBe(t('fillEnvelopes.shortGroup')(2));
    expect(rowIds([...shortGroup.querySelectorAll('.fill-env-row')])).toEqual(old.shortEnvs.map(e => e.id));
    expect(old.shortEnvs.map(e => e.id)).toEqual(['rent', 'food']);
    const others = sheet().querySelector('details.fill-env-others');
    expect(rowIds([...others.querySelectorAll('.fill-env-row')])).toEqual(['fun']);
    expect(coverBtn().hidden).toBe(false);
  });

  it('Cover shortfalls tops up the smallest shortfall first until Unallocated runs out', () => {
    const old = oldOpen();
    openFillEnvelopes();
    coverBtn().click();
    // The old handler's arithmetic, verbatim.
    let left = round2(old.unallocated);
    const expected = {};
    for (const env of [...old.shortEnvs].reverse()) {
      const need = round2(-old.spareOf(env));
      const give = Math.max(0, Math.min(need, left));
      expected[env.id] = give > 0 ? String(give) : '';
      left = round2(left - give);
    }
    expect(inputOf('food').value).toBe(expected.food);
    expect(inputOf('rent').value).toBe(expected.rent);
    expect(inputOf('fun').value).toBe('');
    // Food's whole shortfall, the rest of Unallocated to Rent: nothing left.
    expect(expected.food).toBe(String(round2(-old.spareOf({ id: 'food' }))));
    expect(Number(expected.rent)).toBeGreaterThan(0);
    expect(Number(expected.rent)).toBeLessThan(-old.spareOf({ id: 'rent' }));
    expect(remainderText()).toBe(money(0));
  });
});

describe('Fill sheet: the after figures and the shortfall warning', () => {
  beforeEach(() => { Object.assign(prefs, { lens: 'booked' }); });

  it('a row with an entry shows its balance after at once and its spare after once typing settles', async () => {
    const old = oldOpen();
    openFillEnvelopes();
    setValue(inputOf('fun'), '25');
    expect(balanceOf('fun')).toBe(money(round2(old.envBalances.get('fun') + 25)));
    expect(row('fun').querySelector('.fill-env-current').classList.contains('is-preview')).toBe(true);
    await settle();
    const lines = [fillLineForRow({ envelopeId: 'fun', mode: 'add', value: 25, curBal: old.envBalances.get('fun') })];
    const after = spareAfterFill(old.spareInput, 'fun', lines, todayIso());
    expect(spareEl('fun').textContent).toBe(spareText(after.spare));
    expect(warnOf('fun').hidden).toBe(true);
    // An untouched row keeps its spare as it is now.
    expect(spareEl('rent').textContent).toBe(spareText(old.spareOf({ id: 'rent' })));
  });

  it('a Set below the balance that leaves the envelope shorter warns with the amount and the date', async () => {
    const old = oldOpen();
    openFillEnvelopes();
    modeBtn('food', 'set').click();
    setValue(inputOf('food'), '100');
    setValue(inputOf('fun'), '10');
    expect(balanceOf('food')).toBe(money(100));
    expect(warnOf('food').hidden).toBe(true); // not before the check runs
    await settle();
    const curBal = old.envBalances.get('food');
    const lines = [
      fillLineForRow({ envelopeId: 'food', mode: 'set', value: 100, curBal }),
      fillLineForRow({ envelopeId: 'fun', mode: 'add', value: 10, curBal: old.envBalances.get('fun') }),
    ];
    const after = spareAfterFill(old.spareInput, 'food', lines, todayIso());
    expect(after.spare).toBeLessThan(old.spareOf({ id: 'food' }));
    expect(spareEl('food').textContent).toBe(spareText(after.spare));
    expect(warnOf('food').hidden).toBe(false);
    expect(warnOf('food').textContent).toBe(t('fillEnvelopes.leavesShort')({
      amt: nb(fmt(Math.abs(after.spare))),
      date: nb(fmtDateLang(after.lowDate)),
    }));
    expect(warnOf('food').title).toBe(t('fillEnvelopes.leavesShortTitle'));
    expect(warnOf('fun').hidden).toBe(true);
  });

  it('clearing the entry drops the warning and the after figures', async () => {
    const old = oldOpen();
    openFillEnvelopes();
    modeBtn('food', 'set').click();
    setValue(inputOf('food'), '100');
    await settle();
    expect(warnOf('food').hidden).toBe(false);
    setValue(inputOf('food'), '');
    await settle();
    expect(warnOf('food').hidden).toBe(true);
    expect(balanceOf('food')).toBe(money(old.envBalances.get('food')));
    expect(spareEl('food').textContent).toBe(spareText(old.spareOf({ id: 'food' })));
  });

  it('the check asks fill.preview once, for every row with an entry, with the lines the sheet would submit', async () => {
    openFillEnvelopes();
    modeBtn('food', 'set').click();
    setValue(inputOf('food'), '100');
    setValue(inputOf('rent'), '40');
    setValue(inputOf('fun'), '10');
    await settle();
    expect(asked('fill.preview')).toEqual([{
      lines: [
        { envelope: 'rent', amount: 40, mode: 'add' },
        { envelope: 'food', amount: -200, mode: 'add' },
        { envelope: 'fun', amount: 10, mode: 'add' },
      ],
      envelopes: ['rent', 'food', 'fun'],
      date: '2026-09-15',
    }]);
  });

  it('no entry, no fill.preview call', async () => {
    openFillEnvelopes();
    setValue(inputOf('fun'), '');
    await settle();
    expect(asked('fill.preview')).toEqual([]);
  });
});

describe('Fill sheet: the failure paths and the shortfall edge cases', () => {
  beforeEach(() => { Object.assign(prefs, { lens: 'booked' }); });

  // Answer `name` with `answer`, everything else through the real session.
  function stub(name, answer) {
    querySpy.mockRestore();
    const real = session.query.bind(session);
    querySpy = vi.spyOn(session, 'query').mockImplementation((n, input) => (n === name ? answer(input) : real(n, input)));
  }

  it('a failed balances query opens no sheet and says so with a toast', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stub('balances', () => ({ ok: false, error: { code: 'bad_input', params: {} } }));
    openFillEnvelopes();
    expect(document.querySelector('#sheet-host .sheet')).toBeNull();
    expect(toastTexts()).toEqual([t('fillEnvelopes.openFailed')]);
  });

  it('an envelope already short that a take-out does not make worse does not warn', async () => {
    const old = oldOpen();
    const base = old.spareOf({ id: 'rent' });
    expect(base).toBeLessThan(-0.005);
    stub('fill.preview', () => ({ ok: true, value: { envelopes: [{ id: 'rent', spare: base, lowDate: '2026-10-20' }] } }));
    openFillEnvelopes();
    setValue(inputOf('rent'), '-5');
    await settle();
    expect(spareEl('rent').textContent).toBe(spareText(base));
    expect(warnOf('rent').hidden).toBe(true);
  });

  it('the same take-out that makes it worse warns', async () => {
    const old = oldOpen();
    const worse = round2(old.spareOf({ id: 'rent' }) - 5);
    stub('fill.preview', () => ({ ok: true, value: { envelopes: [{ id: 'rent', spare: worse, lowDate: '2026-10-20' }] } }));
    openFillEnvelopes();
    setValue(inputOf('rent'), '-5');
    await settle();
    expect(warnOf('rent').hidden).toBe(false);
  });

  it('a preview row with a null spare hides the spare and does not warn', async () => {
    stub('fill.preview', () => ({ ok: true, value: { envelopes: [{ id: 'fun', spare: null, lowDate: null }] } }));
    openFillEnvelopes();
    setValue(inputOf('fun'), '-5');
    await settle();
    expect(spareEl('fun').hidden).toBe(true);
    expect(warnOf('fun').hidden).toBe(true);
    expect(balanceOf('fun')).toBe(money(round2(oldOpen().envBalances.get('fun') - 5)));
  });
});

// Owner decision 2026-10-05: each row shows Review's projected gap for the
// current month (`review.month`'s `need`) and "Fill to need" puts it in the
// line as an Add. The figure is the answer's; the page does no sum.
describe('Fill sheet: needs from Review', () => {
  beforeEach(() => { Object.assign(prefs, { lens: 'booked' }); });
  const needEl = (id) => row(id).querySelector('.fill-env-need');
  const needBtn = (id) => [...needEl(id).querySelectorAll('button')].find(b => b.textContent === t('fillEnvelopes.fillToNeed'));

  it('asks review.month for the current month once at open, and shows each envelope\'s need', () => {
    openFillEnvelopes();
    expect(asked('review.month')).toEqual([{ month: '2026-09' }]);
    const rows = session.query('review.month', { month: '2026-09' }).value.rows;
    const needs = new Map(rows.map(r => [r.envelope_id, r.need]));
    // The fixture has a gap (Rent) and envelopes without one.
    expect([...needs.values()].some(n => n > 0)).toBe(true);
    expect([...needs.values()].some(n => n === 0)).toBe(true);
    for (const id of ['food', 'fun', 'rent']) {
      const need = needs.get(id) ?? 0;
      if (need > 0.005) {
        expect(needEl(id).textContent).toContain(t('fillEnvelopes.needLine')(fmt(need)));
      } else {
        expect(needEl(id)).toBeNull();
      }
    }
  });

  it('shows the answer\'s figure, and Fill to need puts it in the line as an Add', () => {
    querySpy.mockRestore();
    const real = session.query.bind(session);
    querySpy = vi.spyOn(session, 'query').mockImplementation((name, input) => {
      const r = real(name, input);
      if (name !== 'review.month' || !r.ok) return r;
      return { ok: true, value: { ...r.value, rows: r.value.rows.map(x => (x.envelope_id === 'fun' ? { ...x, need: 12.34 } : x)) } };
    });
    openFillEnvelopes();
    expect(needEl('fun').textContent).toContain(t('fillEnvelopes.needLine')(fmt(12.34)));
    modeBtn('fun', 'set').click();
    needBtn('fun').click();
    expect(inputOf('fun').value).toBe('12.34');
    expect(modeBtn('fun', 'add').classList.contains('is-active')).toBe(true);
    expect(row('fun').querySelector('.fill-env-delta').textContent).toBe(`Δ ${fmt(12.34, { signed: true })}`);
  });

  it('a failed review query shows no needs', () => {
    querySpy.mockRestore();
    const real = session.query.bind(session);
    querySpy = vi.spyOn(session, 'query').mockImplementation((name, input) => (name === 'review.month'
      ? { ok: false, error: { code: 'bad_input', params: {} } } : real(name, input)));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    openFillEnvelopes();
    expect(sheet().querySelector('.fill-env-need')).toBeNull();
  });
});


describe('Fill funding goals and recovery', () => {
  beforeEach(() => { prefs.lens = 'booked'; });
  it('offers a projected-gap action without saving and labels the resulting balance', async () => {
    openFillEnvelopes();
    const gap = session.query('envelopes.month', { lens: 'booked', date: '2026-09-15' }).value.envelopes.find(e => e.id === 'food').spare.spare;
    modeBtn('food', 'set').click();
    row('food').querySelector('.fill-env-gap button').click();
    expect(Number(inputOf('food').value)).toBe(-gap);
    expect(modeBtn('food', 'add').classList.contains('is-active')).toBe(true);
    expect(row('food').querySelector('.fill-env-balance-label').textContent).toBe(t('fillEnvelopes.afterLabel'));
    await settle();
    expect(spareEl('food').hidden).toBe(false);
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it('warns when the selected pool is exceeded and clears drafts without saving', () => {
    openFillEnvelopes();
    setValue(inputOf('fun'), '50000');
    const warning = sheet().querySelector('.fill-env-pool-warning');
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toContain(t('overview.exceedsPool')(fmt(50000 - oldOpen().unallocated)));
    warning.querySelector('button').click();
    expect(inputOf('fun').value).toBe('');
    expect(warning.hidden).toBe(true);
    expect(writeBatch).not.toHaveBeenCalled();
  });
  it('warns when Booked has money remaining but Today would be negative', () => {
    openFillEnvelopes();
    const today = session.query('balances', { lens: 'today' }).value.unallocated;
    setValue(inputOf('fun'), String(today + 50));
    expect(sheet().querySelector('.fill-env-pool-warning p').textContent).toBe(t('overview.todayNegative'));
    expect(sheet().querySelector('.fill-env-today').textContent).toBe(t('fillEnvelopes.todayRemaining')(fmt(-50)));
  });
  it('bulk cover preserves other drafts and reserves their money first', () => {
    openFillEnvelopes();
    setValue(inputOf('fun'), '200');
    coverBtn().click();
    expect(inputOf('fun').value).toBe('200');
    expect(Number(inputOf('food').value) + Number(inputOf('rent').value) + 200).toBeCloseTo(oldOpen().unallocated, 2);
    expect(remainderText()).toBe(money(0));
    expect(writeBatch).not.toHaveBeenCalled();
  });
});

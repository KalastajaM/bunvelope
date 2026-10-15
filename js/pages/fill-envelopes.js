import { infoButton } from '../ui/info-button.js';
// js/pages/fill-envelopes.js
import { state, session, updateStatusBar, navigate, activeLensInput, now as appNow } from '../app.js';
import { openSheet } from '../ui/sheet.js';
import { trackDirty } from '../ui/dirty-guard.js';
import { emptyState } from '../ui/empty-state.js';
import { toast } from '../ui/toast.js';
import { isVersionConflict, showVersionConflictDialog } from '../ui/save-error.js';
import { moneyEl } from '../ui/money.js';
import { ask } from '../ui/query.js';
import { t, trEnv, trCat, fmtDateLang } from '../ui/i18n.js';
import { fmt, fmtNum } from '../utils.js';
import { describeError } from '../core/errors.js';
import { enableFormulaInput, parseAmountInput, evalExpression } from '../ui/amount-input.js';
import { fillLineForRow } from './fill-line.js';

function round2(n) { return Math.round(n * 100) / 100; }
function todayIso() {
  const d = appNow();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

export function openFillEnvelopes({ onSubmitted, initialAmounts = {}, mode = 'fill' } = {}) {
  const returning = mode === 'return';
  // Balances through the active lens: the row balances a Set lands on and
  // the Unallocated pill. Without them the sheet has nothing to fill against,
  // so a failed query (warned by `ask`) opens no sheet rather than one
  // showing zeros.
  const lens = activeLensInput();
  const balances = ask('balances', lens);
  if (!balances) { toast(t('fillEnvelopes.openFailed'), { assertive: true }); return; }
  const envBalances = new Map(balances.envelopes.map(e => [e.id, e.balance]));
  const unallocated = balances.unallocated;
  const todayPool = lens.lens === 'today' ? balances : ask('balances', { lens: 'today' });

  const active = (state.envelopes || []).filter(e => !e.archived);

  // "Spare" per envelope: the most an unplanned expense could take right now
  // without the envelope ever projecting below its floor. Shown next to the
  // balance because the balance alone does not say how much of it is already
  // spoken for by scheduled bills — filling to a number that looks healthy
  // while spare stays negative is the mistake this line exists to prevent.
  //
  // `envelopes.month` walks the stored rows whatever the lens (its own
  // 12-month forecast generates the scheduled and fill rows), over every
  // active envelope. A snapshot taken once when the sheet opens: each
  // envelope as it stands. Once a row has an entry it shows the spare AFTER
  // the fill instead (`fill.preview`, see `checkShortfalls`), which also
  // drives the shortfall warning — a fill is not a uniform +delta shift of
  // the projection, so it cannot be derived from this snapshot. A failed
  // query leaves every spare off (no short group, no Cover).
  const month = ask('envelopes.month', { ...lens, date: todayIso(), spare: true });
  const spareByEnv = new Map((month?.envelopes || []).map(e => [e.id, e.spare]));

  // "Needs" per envelope: Review's projected gap for the current month (the
  // row's `need`, how far the projected end-of-month balance falls short of
  // the required reserve), offered as "Fill to need". Lens-free, as Review
  // is. A failed query shows no needs.
  const review = ask('review.month', { month: todayIso().slice(0, 7) });
  const needByEnv = new Map((review?.rows || []).map(r => [r.envelope_id, r.need]));

  // The balances above are lens-dependent, so the header says which lens they
  // came from — a dialog that commits money must not leave the reader
  // guessing which of three definitions of "balance" they are looking at.
  const lensName = t('lens.' + lens.lens);
  const titleFn = t('fillEnvelopes.titleLens');
  const sheetTitle = returning ? t('fillEnvelopes.returnTitle')(lensName) : typeof titleFn === 'function'
    ? titleFn(lensName)
    : `${t('fillEnvelopes.title') || 'Fill envelopes'} (${lensName})`;

  const content = document.createElement('div');
  content.className = 'fill-env';

  // ── Header: unallocated + remaining pills ───────────────────────────────
  const header = document.createElement('div');
  header.className = 'fill-env-header';

  const uPill = document.createElement('div');
  uPill.className = 'fill-env-pill';
  const uLbl = document.createElement('span');
  uLbl.className = 'fill-env-pill-lbl';
  uLbl.textContent = t('fillEnvelopes.unallocated') || 'Unallocated';
  uLbl.append(infoButton('unallocated'));
  uPill.append(uLbl, moneyEl(unallocated, { size: 'md' }));

  const rPill = document.createElement('div');
  rPill.className = 'fill-env-pill fill-env-remainder';
  const rLbl = document.createElement('span');
  rLbl.className = 'fill-env-pill-lbl';
  rLbl.textContent = t('fillEnvelopes.remaining') || 'Remaining';
  const rVal = document.createElement('span');
  rVal.className = 'fill-env-remainder-val';
  rPill.append(rLbl, rVal);

  const rState = document.createElement('span');
  rState.className = 'fill-env-state';
  rPill.append(rState);

  header.append(uPill, rPill);
  content.append(header);
  const explanation = document.createElement('div');
  explanation.className = 'fill-env-explanation';
  for (const key of ['gapExplanation', 'reserveExplanation']) {
    const line = document.createElement('p');
    line.textContent = t('fillEnvelopes.' + key);
    if (key === 'reserveExplanation') line.append(infoButton('envelopeFigures'));
    explanation.append(line);
  }
  const draftNote = document.createElement('p');
  draftNote.textContent = t(returning ? 'fillEnvelopes.returnHint' : 'fillEnvelopes.draftHint');
  explanation.append(draftNote);
  content.append(explanation);
  const poolWarning = document.createElement('div');
  poolWarning.className = 'fill-env-pool-warning';
  poolWarning.setAttribute('role', 'status');
  poolWarning.hidden = true;
  const poolMessage = document.createElement('p');
  const clearSuggestion = document.createElement('button');
  clearSuggestion.type = 'button';
  clearSuggestion.className = 'btn btn-sm btn-ghost';
  clearSuggestion.textContent = t('fillEnvelopes.clearEntries');
  clearSuggestion.addEventListener('click', () => { for (const r of rows) r.input.value = ''; recalc(); });
  poolWarning.append(poolMessage, clearSuggestion);
  content.append(poolWarning);
  const todayRemainder = document.createElement('p');
  todayRemainder.className = 'fill-env-today';
  todayRemainder.hidden = lens.lens === 'today' || !todayPool;
  content.append(todayRemainder);

  if (!active.length) {
    const empty = emptyState({
      icon: 'envelope',
      title: t('envelopes.empty'),
      body: t('envelopes.emptyBody'),
      action: {
        label: t('envelopes.emptyAction'),
        onClick: () => { handle.close(); navigate('envelopes'); },
      },
    });
    empty.style.margin = '20px 0';
    content.append(empty);
    const handle = openSheet({ title: sheetTitle, content, wide: true });
    return;
  }

  // ── Body: rows grouped by category ──────────────────────────────────────
  const list = document.createElement('div');
  list.className = 'fill-env-list';
  content.append(list);

  const rows = [];

  function buildRow(env) {
    const row = document.createElement('div');
    row.className = 'fill-env-row';

    // Name + current balance (inline)
    const info = document.createElement('div');
    info.className = 'fill-env-info';
    const nm = document.createElement('div');
    nm.className = 'fill-env-name';
    nm.textContent = trEnv(env);
    const cur = document.createElement('div');
    cur.className = 'fill-env-current';
    const curBal = envBalances.get(env.id) || 0;
    const balSlot = document.createElement('span');
    const spareEl = document.createElement('span');
    spareEl.className = 'fill-env-spare';
    cur.append(balSlot);
    const baseSpare = spareOf(env);
    info.append(nm, cur);
    row.append(info);
    const need = needByEnv.get(env.id) ?? 0;

    // Mode toggle
    const modeWrap = document.createElement('div');
    modeWrap.className = 'fill-env-mode-toggle';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'fill-env-mode is-active';
    addBtn.textContent = t('fillEnvelopes.modeAdd') || 'Add';
    const setBtn = document.createElement('button');
    setBtn.type = 'button';
    setBtn.className = 'fill-env-mode';
    setBtn.textContent = t('fillEnvelopes.modeSet') || 'Set';
    modeWrap.append(addBtn, setBtn);
    modeWrap.hidden = returning;
    const controls = document.createElement('div');
    controls.className = 'fill-env-controls';
    controls.append(modeWrap);
    row.append(controls);

    // Amount input + delta stacked
    const inputWrap = document.createElement('div');
    inputWrap.className = 'fill-env-input-wrap';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '0.01';
    input.placeholder = fmtNum(0, { decimals: 2 });
    input.className = 'fill-env-input';
    input.inputMode = 'decimal';
    input.setAttribute('aria-label', trEnv(env));
    enableFormulaInput(input);
    const delta = document.createElement('div');
    delta.className = 'fill-env-delta';
    // Filled in by `checkShortfalls` when this row's entry takes money out
    // that the envelope's plan still needs.
    const warn = document.createElement('div');
    warn.className = 'fill-env-warn';
    warn.hidden = true;
    const inputError = document.createElement('div');
    inputError.className = 'field-hint';
    inputError.id = `return-amount-error-${rows.length}`;
    inputError.setAttribute('aria-live', 'polite');
    if (returning) input.setAttribute('aria-describedby', inputError.id);
    inputWrap.append(input, delta, warn, inputError);
    controls.append(inputWrap);

    const rowObj = { env, curBal, baseSpare, mode: 'add', input, inputError, addBtn, setBtn, delta, warn, cur, balSlot, spareEl };
    const initial = initialAmounts[env.id];
    if (Number.isFinite(initial) && initial > 0) input.value = String(initial);
    rows.push(rowObj);
    paintInfo(rowObj, curBal, baseSpare, false);

    const setMode = (m) => {
      rowObj.mode = m;
      // Choosing Set makes the displayed default an explicit target.
      if (m === 'set' && input.value === '') input.value = '0';
      addBtn.classList.toggle('is-active', m === 'add');
      setBtn.classList.toggle('is-active', m === 'set');
      recalc();
    };

    const gapWrap = document.createElement('div');
    gapWrap.className = 'fill-env-gap';
    gapWrap.append(spareEl);
    info.append(gapWrap);
    if (!returning && baseSpare < -0.005) {
      const gapBtn = document.createElement('button');
      gapBtn.type = 'button';
      gapBtn.className = 'btn btn-sm btn-ghost';
      gapBtn.textContent = t('fillEnvelopes.cover');
      gapBtn.title = t('overview.coverGap')(fmt(-baseSpare));
      gapBtn.addEventListener('click', () => { input.value = String(-baseSpare); setMode('add'); });
      gapWrap.append(gapBtn);
    }
    if (need > 0.005) {
      const needWrap = document.createElement('div');
      needWrap.className = 'fill-env-need';
      const needTxt = document.createElement('span');
      needTxt.textContent = t('fillEnvelopes.needLine')(fmt(need));
      needTxt.title = t('fillEnvelopes.needTitle');
      const needBtn = document.createElement('button');
      needBtn.type = 'button';
      needBtn.className = 'btn btn-sm btn-ghost';
      needBtn.textContent = t('fillEnvelopes.fillToNeed');
      needBtn.title = t('fillEnvelopes.fillToNeedTitle')(fmt(need));
      needBtn.addEventListener('click', () => {
        input.value = String(need);
        setMode('add');
      });
      needWrap.append(needTxt);
      if (!returning) needWrap.append(needBtn);
      info.append(needWrap);
    }
    addBtn.addEventListener('click', () => setMode('add'));
    setBtn.addEventListener('click', () => setMode('set'));
    input.addEventListener('input', recalc);

    return row;
  }

  // The row's balance and spare, as they are now or, once a value is typed,
  // as they would be after the fill (`preview`). Spare wording matches the
  // envelope card: a negative spare reads "short", not "−X spare".
  function paintInfo(r, bal, spare, preview) {
    const label = document.createElement('span');
    label.className = 'fill-env-balance-label';
    label.textContent = t(preview ? (returning ? 'fillEnvelopes.returnAfterLabel' : 'fillEnvelopes.afterLabel') : 'fillEnvelopes.beforeLabel');
    r.balSlot.replaceChildren(label, moneyEl(bal, { size: 'md' }));
    const known = Number.isFinite(spare);
    r.spareEl.hidden = !known;
    if (known) {
      const isShort = spare < -0.005;
      r.spareEl.classList.toggle('is-short', isShort);
      r.spareEl.title = t('envelopes.spareTitle');
      r.spareEl.textContent = isShort
        ? t('fillEnvelopes.shortfallLine')(fmt(Math.abs(spare)))
        : `(${t('envelopes.spareLine')(fmt(spare))})`;
    }
    r.cur.classList.toggle('is-preview', preview);
    r.cur.title = preview ? t(returning ? 'fillEnvelopes.returnNowTitle' : 'fillEnvelopes.nowTitle')(fmt(r.curBal)) : '';
  }

  // Short envelopes first (ux-review U17): negative spare means planned bills
  // will take the envelope below its floor, so these are the ones a fill
  // should reach first. Most short at the top; the rest keep their category
  // groups, folded away while there is something short to deal with.
  const spareOf = (env) => {
    const sp = spareByEnv.get(env.id);
    return sp && Number.isFinite(sp.spare) ? sp.spare : null;
  };
  const shortEnvs = (returning ? [] : active)
    .filter(env => (spareOf(env) ?? 0) < -0.005)
    .sort((a, b) => spareOf(a) - spareOf(b));
  const shortIds = new Set(shortEnvs.map(e => e.id));

  if (shortEnvs.length) {
    const group = document.createElement('div');
    group.className = 'fill-env-group fill-env-group--short';
    const gh = document.createElement('div');
    gh.className = 'fill-env-group-head';
    gh.textContent = t('fillEnvelopes.shortGroup')(shortEnvs.length);
    group.append(gh);
    shortEnvs.forEach(env => group.append(buildRow(env)));
    list.append(group);
  }

  const byCat = {};
  const catOrder = [];
  for (const env of active) {
    if (shortIds.has(env.id)) continue;
    const k = env.category || 'other';
    if (!byCat[k]) { byCat[k] = []; catOrder.push(k); }
    byCat[k].push(env);
  }
  const othersHost = shortEnvs.length ? document.createElement('details') : list;
  if (shortEnvs.length) {
    othersHost.className = 'fill-env-others';
    const summary = document.createElement('summary');
    summary.textContent = t('fillEnvelopes.otherEnvelopes');
    othersHost.append(summary);
    list.append(othersHost);
  }

  catOrder.forEach(cat => {
    const group = document.createElement('div');
    group.className = 'fill-env-group';
    const gh = document.createElement('div');
    gh.className = 'fill-env-group-head';
    gh.textContent = trCat(cat);
    group.append(gh);
    byCat[cat].forEach(env => group.append(buildRow(env)));
    othersHost.append(group);
  });

  // A suggestion from Overview is only a prefill. The normal preview and
  // explicit Fill action remain responsible for checking and committing it.
  if (shortEnvs.length && active.some(e => !shortIds.has(e.id) && Number.isFinite(initialAmounts[e.id]) && initialAmounts[e.id] > 0)) othersHost.open = true;

  // ── Footer actions ──────────────────────────────────────────────────────
  const footer = document.createElement('div');
  footer.dataset.sheetActions = '';
  footer.className = 'fill-env-footer';
  const zeroBtn = document.createElement('button');
  zeroBtn.type = 'button';
  zeroBtn.className = 'btn btn-ghost';
  zeroBtn.textContent = t('fillEnvelopes.clearEntries');

  const spacer = document.createElement('div');
  spacer.style.flex = '1';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = t('fillEnvelopes.cancel') || 'Cancel';

  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'btn btn-accent';
  submitBtn.textContent = t(returning ? 'fillEnvelopes.returnSubmit' : 'fillEnvelopes.submit');
  submitBtn.disabled = true;

  // Tops up short envelopes to zero spare until Unallocated runs out,
  // smallest shortfall first, so a limited amount closes as many holes as it
  // can instead of vanishing into the biggest one. It only fills in the
  // inputs; nothing is saved until Fill.
  const coverBtn = document.createElement('button');
  coverBtn.type = 'button';
  coverBtn.className = 'btn btn-ghost';
  coverBtn.textContent = t('fillEnvelopes.coverShortfalls');
  coverBtn.hidden = shortEnvs.length === 0;

  footer.append(zeroBtn, coverBtn, spacer, cancelBtn, submitBtn);
  content.append(footer);

  // ── Math + state sync ───────────────────────────────────────────────────
  function parseInput(v) {
    if (returning) {
      try { return round2(evalExpression(String(v).replace(/,/g, '.'))); }
      catch { return NaN; }
    }
    const n = parseAmountInput(v);
    return Number.isFinite(n) ? n : 0;
  }
  function returnInputInvalid(r) {
    if (!returning || r.input.value === '') return false;
    const value = parseInput(r.input.value);
    return !Number.isFinite(value) || value < 0 || value > Math.max(0, r.curBal);
  }
  function lineForRow(r) {
    if (r.input.value === '' || returnInputInvalid(r)) return null;
    const value = parseInput(r.input.value);
    return fillLineForRow({ envelopeId: r.env.id, mode: r.mode, value: returning ? -value : value, curBal: r.curBal });
  }
  function rowDelta(r) {
    // An empty input means "don't touch this row" — same as the submit loop.
    // Returning `-curBal` here (the old behaviour of 'set' mode) made the
    // Fill button appear actionable while the submit loop skipped every
    // empty row and exited early, so clicking did nothing.
    //
    // Derive the displayed delta from the same helper the submit loop uses so
    // the "Δ" shown can never disagree with the amount actually committed.
    if (r.input.value === '') return 0;
    const line = lineForRow(r);
    return line ? line.amount : 0;
  }
  function recalc() {
    let sum = 0;
    let anyNonzero = false;
    for (const r of rows) {
      const invalid = returnInputInvalid(r);
      r.inputError.textContent = invalid ? t('fillEnvelopes.returnInvalid')(fmt(Math.max(0, r.curBal))) : '';
      if (returning) r.input.setAttribute('aria-invalid', String(invalid));
      const d = rowDelta(r);
      if (d !== 0) anyNonzero = true;
      sum = round2(sum + d);
      // Per-row delta, in both modes: in Set it is the difference the typed
      // target makes, in Add it confirms what the entry moves.
      r.delta.textContent = '';
      if (r.input.value !== '' && d !== 0) {
        r.delta.textContent = `Δ ${fmt(d, { signed: true })}`;
        r.delta.classList.toggle('is-pos', d > 0);
        r.delta.classList.toggle('is-neg', d < 0);
      } else {
        r.delta.classList.remove('is-pos', 'is-neg');
      }
      // The balance follows the entry at once; the spare beside it waits for
      // the re-projection below and until then keeps its last figure.
      if (d !== 0) {
        paintInfo(r, round2(r.curBal + d), r.previewSpare ?? r.baseSpare, true);
      } else {
        r.previewSpare = null;
        paintInfo(r, r.curBal, r.baseSpare, false);
      }
    }
    const remainder = round2(unallocated - sum);
    rVal.textContent = '';
    rVal.append(moneyEl(remainder, { size: 'md' }));
    rPill.classList.remove('is-zero', 'is-pos', 'is-neg');
    if (Math.abs(remainder) < 0.005) {
      rPill.classList.add('is-zero');
      rState.textContent = t('fillEnvelopes.stateZero') || 'balanced';
    } else if (remainder > 0) {
      rPill.classList.add('is-pos');
      rState.textContent = t('fillEnvelopes.statePos') || 'still to distribute';
    } else {
      rPill.classList.add('is-neg');
      rState.textContent = t('fillEnvelopes.stateNeg') || 'over-allocated';
    }
    const todayLeft = todayPool ? round2(todayPool.unallocated - sum) : null;
    if (!todayRemainder.hidden) todayRemainder.textContent = t('fillEnvelopes.todayRemaining')(fmt(todayLeft));
    poolWarning.hidden = !(remainder < -0.005 || (todayLeft !== null && todayLeft < -0.005));
    poolMessage.textContent = remainder < -0.005
      ? t('overview.exceedsPool')(fmt(Math.abs(remainder)))
      : t(anyNonzero ? 'overview.todayNegative' : 'fillEnvelopes.todayAlreadyNegative');
    clearSuggestion.hidden = !anyNonzero;
    submitBtn.disabled = !anyNonzero || rows.some(returnInputInvalid);
    scheduleShortfallCheck();
  }

  // Every line the sheet would submit right now — the submit handler and the
  // shortfall preview share it so the preview is of the exact write.
  function pendingLines() {
    const lines = [];
    for (const r of rows) {
      if (r.input.value === '') continue;
      const line = lineForRow(r);
      if (line) lines.push(line);
    }
    return lines;
  }

  // Shortfall warning. A Set below the balance, or a negative Add, moves money
  // out of an envelope; when its plan still needs that money this month the
  // envelope card afterwards reads "short" and nothing here said so (the
  // owner's Groceries: Set 400 on the 15th swept 175.38 of the second half's
  // budget elsewhere). Only rows taking money out are checked, and only a
  // result that is short AND worse than now warns, so an envelope that was
  // already short is not flagged for a top-up. A warning, never a block:
  // moving an underspend out can be the point.
  //
  // One 12-month walk per row with an entry, so it waits for typing to settle.
  let shortfallTimer = null;
  function scheduleShortfallCheck() {
    clearTimeout(shortfallTimer);
    shortfallTimer = setTimeout(checkShortfalls, 200);
  }
  function checkShortfalls() {
    shortfallTimer = null;
    if (!content.isConnected || !content.closest('[data-sheet-open]')) return;
    const lines = pendingLines();
    // One query for every row with an entry: each re-projected with all the
    // pending lines applied, so a cross-envelope effect is seen too.
    const entered = rows.filter(r => rowDelta(r) !== 0);
    const preview = entered.length ? ask('fill.preview', {
      lines: lines.map(l => ({ envelope: l.envelope_id, amount: l.amount, mode: 'add' })),
      envelopes: entered.map(r => r.env.id),
      date: todayIso(),
    }) : null;
    const afterById = new Map((preview?.envelopes || [])
      .filter(e => e.spare !== null)
      .map(e => [e.id, e]));
    for (const r of rows) {
      const warnEl = r.warn;
      const d = rowDelta(r);
      // Every row with an entry is re-projected, so its spare shows what the
      // fill leaves (not `spare + delta`: see fill.preview). Only rows that
      // take money out can warn.
      const after = d !== 0 ? (afterById.get(r.env.id) ?? null) : null;
      if (d !== 0) {
        r.previewSpare = after ? after.spare : null;
        paintInfo(r, round2(r.curBal + d), r.previewSpare, true);
      }
      const beforeSpare = Number.isFinite(r.baseSpare) ? r.baseSpare : 0;
      if (d >= 0 || !after || after.spare >= -0.005 || after.spare >= beforeSpare - 0.005) {
        warnEl.hidden = true;
        warnEl.textContent = '';
        continue;
      }
      // Non-breaking inside the amount and the date: the line wraps in a
      // narrow column, and "€" or "2026" alone on a line reads as noise.
      const nb = (str) => String(str).replace(/ /g, '\u00a0');
      warnEl.textContent = t('fillEnvelopes.leavesShort')({
        amt: nb(fmt(Math.abs(after.spare))),
        date: nb(fmtDateLang(after.lowDate)),
      });
      warnEl.title = t('fillEnvelopes.leavesShortTitle');
      warnEl.hidden = false;
    }
  }

  coverBtn.addEventListener('click', () => {
    // Preserve other entries and reserve their net allocation first.
    let left = round2(unallocated - rows.filter(r => !shortIds.has(r.env.id)).reduce((sum, r) => sum + rowDelta(r), 0));
    for (const env of [...shortEnvs].reverse()) {
      const r = rows.find(x => x.env.id === env.id);
      if (!r) continue;
      const need = round2(-spareOf(env));
      const give = Math.max(0, Math.min(need, left));
      if (r.mode !== 'add') { r.mode = 'add'; r.addBtn.classList.add('is-active'); r.setBtn.classList.remove('is-active'); }
      r.input.value = give > 0 ? String(give) : '';
      left = round2(left - give);
    }
    recalc();
  });

  zeroBtn.addEventListener('click', () => {
    for (const r of rows) { r.input.value = ''; }
    recalc();
  });

  let sheetRef;
  cancelBtn.addEventListener('click', () => sheetRef && sheetRef.requestClose());

  submitBtn.addEventListener('click', () => {
    if (rows.some(returnInputInvalid)) return;
    const lines = pendingLines();
    if (!lines.length) return;

    // The command writes first and then publishes to state. The sheet still
    // closes straight away (nothing to wait for, and the dirty guard would
    // only get in the way); the toast, status bar and onSubmitted follow the
    // publish, and a refusal or failed write is reported afterwards.
    submitBtn.disabled = true;
    const afterWrite = () => {
      updateStatusBar();
      if (typeof onSubmitted === 'function') onSubmitted();
    };
    const failed = (conflict, message) => {
      updateStatusBar();
      if (conflict) showVersionConflictDialog();
      else toast(t('common.saveFailed')(message), { assertive: true });
      if (typeof onSubmitted === 'function') onSubmitted();
    };
    const savePromise = session.dispatch('allocation.fill', {
      lines: lines.map(l => ({ envelope: l.envelope_id, amount: l.amount })),
      date: todayIso(),
      payee: t(returning ? 'fillEnvelopes.returnSubmit' : 'fillEnvelopes.payee'),
    });
    sheetRef && sheetRef.close();

    savePromise.then((r) => {
      if (!r.ok) { failed(r.error.code === 'version_conflict', describeError(r.error, t)); return; }
      const msgFn = t(returning ? 'fillEnvelopes.returnSuccess' : 'fillEnvelopes.successToast');
      toast(typeof msgFn === 'function' ? msgFn(lines.length) : `Filled ${lines.length} envelope${lines.length === 1 ? '' : 's'}`);
      afterWrite();
    }, (err) => {
      console.error('fill envelopes save failed:', err);
      failed(isVersionConflict(err), err?.message || 'unknown');
    });
  });

  recalc();

  const tracker = trackDirty(content);
  sheetRef = openSheet({
    title: sheetTitle,
    content,
    wide: true,
    confirmClose: tracker.confirmClose,
    onClose: () => { clearTimeout(shortfallTimer); shortfallTimer = null; },
  });
}

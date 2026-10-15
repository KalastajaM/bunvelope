// js/pages/investments-unmapped.js — the "unmapped investment transactions"
// bulk-assignment card, split out of investments.js. Owns its selection
// state per render. Every apply is one session commit: a payee's rule and
// its tagged rows land together (investment.setPayeeRule with applyTo), and
// rows with no rule key take the symbol through investment.tagSymbol. Both
// change only symbol and modified_at, so a legacy row is tagged as it is.

import { state, session, navigate } from '../app.js';
import { txAbsAmount } from '../engine.js';
import { t } from '../ui/i18n.js';
import { toast } from '../ui/toast.js';
import { dispatchOrReport, dispatchBatchOrReport } from '../ui/save-error.js';
import { lookupSymbolForPayee, normalisePayeeKey, isMappablePayee } from '../state/investments.js';
import { ensureSymbolsDatalist, fmtMoney, numCell } from './investments-shared.js';

/**
 * Investment transfers on a tracked investment account that carry no symbol,
 * so they count toward no holding. Settings' Clean-up tab counts these too.
 */
export function findUnmappedInvestmentTxs(transactions, investmentAccountIds) {
  return (transactions || []).filter(tx =>
    tx?.type === 'investment_transfer'
    && !tx.symbol
    && (investmentAccountIds.has(tx.from_account) || investmentAccountIds.has(tx.to_account)),
  );
}

/** The card's element id, so a link elsewhere (add-tx's save toast) can land on it. */
export const UNMAPPED_CARD_ID = 'investments-unmapped';

/** Open the Investments page and bring the unmapped card into view. */
export async function showUnmappedCard() {
  await navigate('investments');
  document.getElementById(UNMAPPED_CARD_ID)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

export function buildUnmappedCard(transactions, investmentAccountIds) {
  const unmapped = findUnmappedInvestmentTxs(transactions, investmentAccountIds);
  if (unmapped.length === 0) return null;

  const card = document.createElement('div');
  card.id = UNMAPPED_CARD_ID;
  card.className = 'card';
  card.style.cssText = 'margin-bottom:16px;';

  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;';
  const title = document.createElement('div');
  title.className = 'card-title';
  title.style.margin = '0';
  title.textContent = t('investments.unmapped.title');
  titleRow.append(title);

  const mapAllBtn = document.createElement('button');
  mapAllBtn.type = 'button';
  mapAllBtn.className = 'btn btn-ghost btn-sm';
  mapAllBtn.textContent = t('investments.unmapped.mapAllExisting');
  mapAllBtn.addEventListener('click', () => onMapAllExisting(unmapped));
  titleRow.append(mapAllBtn);
  card.append(titleRow);

  const intro = document.createElement('div');
  intro.className = 'muted';
  intro.style.cssText = 'font-size:13px;line-height:1.5;margin-bottom:12px;';
  intro.textContent = t('investments.unmapped.intro');
  card.append(intro);

  // Group by lowercase payee key. Empty/placeholder payees → noPayee bucket.
  const buckets = new Map();
  for (const tx of unmapped) {
    const mappable = isMappablePayee(tx.payee);
    const key = mappable ? normalisePayeeKey(tx.payee) : '__nopayee__';
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        mappable,
        displayPayee: mappable ? (tx.payee || '').trim() : t('investments.unmapped.noPayee'),
        rows: [],
        cash: 0,
        earliest: null,
        latest: null,
      };
      buckets.set(key, bucket);
    }
    bucket.rows.push(tx);
    bucket.cash += txAbsAmount(tx);
    const d = tx.date || '';
    if (d) {
      if (!bucket.earliest || d < bucket.earliest) bucket.earliest = d;
      if (!bucket.latest || d > bucket.latest) bucket.latest = d;
    }
  }

  const datalistId = ensureSymbolsDatalist();

  // Buckets that the user has ticked for bulk apply. Lives in card-local
  // state and is rebuilt whenever the page re-renders (which happens
  // after every successful apply, so a stale selection can't carry).
  const selected = new Set();

  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse;font-size:14px;';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  // Leading select-all column.
  const thSelAll = document.createElement('th');
  thSelAll.style.cssText = 'padding:8px 6px;border-bottom:1px solid var(--border, #e5e7eb);width:32px;';
  const selAllCb = document.createElement('input');
  selAllCb.type = 'checkbox';
  selAllCb.title = t('investments.unmapped.selectAll');
  thSelAll.append(selAllCb);
  trh.append(thSelAll);
  for (const [label, align] of [
    [t('investments.unmapped.colPayee'), 'left'],
    [t('investments.unmapped.colCount'), 'right'],
    [t('investments.unmapped.colDates'), 'left'],
    [t('investments.unmapped.colCash'), 'right'],
    [t('investments.col.symbol'), 'left'],
    ['', 'right'],
  ]) {
    const th = document.createElement('th');
    th.style.cssText = `text-align:${align};padding:8px 6px;border-bottom:1px solid var(--border, #e5e7eb);font-weight:600;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;`;
    th.textContent = label;
    trh.append(th);
  }
  thead.append(trh);
  table.append(thead);

  const tbody = document.createElement('tbody');
  const sortedBuckets = [...buckets.values()].sort((a, b) => b.rows.length - a.rows.length);
  const rowCheckboxes = []; // for select-all wiring
  for (const bucket of sortedBuckets) {
    const tr = document.createElement('tr');
    tr.style.cssText = 'border-bottom:1px solid var(--border, #f0f0f0);';

    const tdSel = document.createElement('td');
    tdSel.style.cssText = 'padding:10px 6px;';
    const selCb = document.createElement('input');
    selCb.type = 'checkbox';
    // Non-mappable buckets (blank/placeholder payees) can still be
    // bulk-tagged with a symbol — only the payee-rule write is skipped
    // since there's no key to remember them by.
    selCb.addEventListener('change', () => {
      if (selCb.checked) selected.add(bucket.key);
      else selected.delete(bucket.key);
      updateBulkBar();
      // Keep select-all in sync (indeterminate / checked / unchecked).
      const total = rowCheckboxes.length;
      const on = rowCheckboxes.filter(c => c.checked).length;
      selAllCb.checked = on === total;
      selAllCb.indeterminate = on > 0 && on < total;
    });
    rowCheckboxes.push(selCb);
    tdSel.append(selCb);
    tr.append(tdSel);

    const tdPayee = document.createElement('td');
    tdPayee.style.cssText = 'padding:10px 6px;font-weight:500;';
    tdPayee.textContent = bucket.displayPayee;
    if (!bucket.mappable) {
      const note = document.createElement('div');
      note.className = 'muted';
      note.style.cssText = 'font-size:11px;font-weight:400;';
      note.textContent = t('investments.unmapped.noPayeeNote');
      tdPayee.append(note);
    }
    tr.append(tdPayee);

    tr.append(numCell(String(bucket.rows.length)));

    const tdDates = document.createElement('td');
    tdDates.style.cssText = 'padding:10px 6px;font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px;';
    if (bucket.earliest && bucket.latest) {
      tdDates.textContent = bucket.earliest === bucket.latest
        ? bucket.earliest
        : `${bucket.earliest} – ${bucket.latest}`;
    } else {
      tdDates.textContent = '—';
    }
    tr.append(tdDates);

    tr.append(numCell(fmtMoney(bucket.cash)));

    const tdSym = document.createElement('td');
    tdSym.style.cssText = 'padding:10px 6px;';
    const symInput = document.createElement('input');
    symInput.type = 'text';
    symInput.setAttribute('list', datalistId);
    symInput.placeholder = t('investments.unmapped.symbolPh');
    symInput.style.cssText = 'width:120px;text-transform:uppercase;';
    symInput.addEventListener('input', () => { symInput.value = symInput.value.toUpperCase(); });
    tdSym.append(symInput);
    tr.append(tdSym);

    const tdAct = document.createElement('td');
    tdAct.style.cssText = 'padding:10px 6px;text-align:right;';
    if (bucket.mappable) {
      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'btn btn-accent btn-sm';
      applyBtn.textContent = t('investments.unmapped.apply');
      applyBtn.addEventListener('click', async () => {
        const sym = symInput.value.trim().toUpperCase();
        if (!sym) {
          toast(t('investments.dialog.symbolRequired'));
          return;
        }
        applyBtn.disabled = true;
        await applyBucket(bucket, sym);
      });
      tdAct.append(applyBtn);
    }
    tr.append(tdAct);

    tbody.append(tr);
  }
  table.append(tbody);
  card.append(table);

  // Wire select-all after rows exist.
  selAllCb.addEventListener('change', () => {
    const want = selAllCb.checked;
    selected.clear();
    for (let i = 0; i < rowCheckboxes.length; i++) {
      rowCheckboxes[i].checked = want;
      if (want) selected.add(sortedBuckets[i].key);
    }
    selAllCb.indeterminate = false;
    updateBulkBar();
  });

  // ── Bulk-apply footer ────────────────────────────────────────────────
  // Hidden until ≥1 bucket is ticked. Lets the user assign one symbol
  // to several payee buckets in a single round-trip — useful when a
  // broker writes the same fund under multiple payee strings, or when
  // the user wants to seed several symbols for new holdings at once.
  const bulkBar = document.createElement('div');
  // Surface, not sunken: the .form-input inside is sunken with no border and
  // would have no visible edge on a sunken bar.
  bulkBar.style.cssText = 'display:none;align-items:center;gap:10px;margin-top:12px;padding:10px 12px;border:1px solid var(--border, #e5e7eb);border-radius:8px;background:var(--surface);';
  const bulkLbl = document.createElement('span');
  bulkLbl.style.cssText = 'font-size:13px;color:var(--text);';
  const bulkSym = document.createElement('input');
  bulkSym.type = 'text';
  bulkSym.className = 'form-input';
  bulkSym.setAttribute('list', datalistId);
  bulkSym.placeholder = t('investments.unmapped.symbolPh');
  bulkSym.style.cssText = 'flex:none;width:140px;padding:6px 10px;font-size:13px;text-transform:uppercase;';
  bulkSym.addEventListener('input', () => { bulkSym.value = bulkSym.value.toUpperCase(); });
  const bulkApply = document.createElement('button');
  bulkApply.type = 'button';
  bulkApply.className = 'btn btn-accent btn-sm';
  bulkApply.addEventListener('click', async () => {
    const sym = bulkSym.value.trim().toUpperCase();
    if (!sym) {
      toast(t('investments.dialog.symbolRequired'));
      return;
    }
    const picked = sortedBuckets.filter(b => selected.has(b.key));
    if (picked.length === 0) return;
    bulkApply.disabled = true;
    await applyBuckets(picked, sym);
  });
  const bulkClear = document.createElement('button');
  bulkClear.type = 'button';
  bulkClear.className = 'btn btn-ghost btn-sm';
  bulkClear.textContent = t('investments.unmapped.clearSelection');
  bulkClear.addEventListener('click', () => {
    selected.clear();
    for (const cb of rowCheckboxes) cb.checked = false;
    selAllCb.checked = false;
    selAllCb.indeterminate = false;
    updateBulkBar();
  });
  bulkBar.append(bulkLbl, bulkSym, bulkApply, bulkClear);
  card.append(bulkBar);

  function updateBulkBar() {
    const n = selected.size;
    if (n === 0) { bulkBar.style.display = 'none'; return; }
    bulkBar.style.display = 'flex';
    bulkLbl.textContent = t('investments.unmapped.bulkSelected')(n);
    bulkApply.textContent = t('investments.unmapped.bulkApply')(n);
  }

  return card;

  // The step that gives a bucket's rows `sym`: a mappable payee's rule and
  // its rows together; a blank or placeholder payee has no key to remember,
  // so its rows only take the symbol.
  function bucketStep(bucket, sym) {
    const ids = bucket.rows.map(x => x.id);
    if (bucket.mappable) {
      return { name: 'investment.setPayeeRule', input: { payee: bucket.rows[0].payee, symbol: sym, applyTo: ids } };
    }
    return { name: 'investment.tagSymbol', input: { ids, symbol: sym } };
  }

  async function applyBucket(bucket, sym) {
    // The per-row Apply exists only on a mappable bucket: one setPayeeRule.
    const step = bucketStep(bucket, sym);
    if (!(await dispatchOrReport(session, step.name, step.input))) return;
    toast(t('investments.unmapped.applied')(bucket.rows.length));
    navigate('investments');
  }

  async function applyBuckets(bucketList, sym) {
    // Bulk apply: every selected bucket in one batch, so the rules and the
    // tagged rows land together or not at all.
    const steps = bucketList.map(bucket => bucketStep(bucket, sym));
    const totalRows = bucketList.reduce((n, bucket) => n + bucket.rows.length, 0);
    if (!(await dispatchBatchOrReport(session, steps))) return;
    toast(t('investments.unmapped.bulkApplied')(bucketList.length, totalRows));
    navigate('investments');
  }

  async function onMapAllExisting(allUnmapped) {
    // The rows whose payee already has a rule, grouped by that rule's symbol:
    // one tagSymbol step per symbol, all in one batch.
    const idsBySym = new Map();
    let count = 0;
    for (const tx of allUnmapped) {
      if (!isMappablePayee(tx.payee)) continue;
      const sym = lookupSymbolForPayee(state.meta, tx.payee);
      if (!sym) continue;
      if (!idsBySym.has(sym)) idsBySym.set(sym, []);
      idsBySym.get(sym).push(tx.id);
      count++;
    }
    if (count === 0) {
      toast(t('investments.unmapped.mapAllExistingNone'));
      return;
    }
    const steps = [...idsBySym].map(([symbol, ids]) => ({ name: 'investment.tagSymbol', input: { ids, symbol } }));
    if (!(await dispatchBatchOrReport(session, steps))) return;
    toast(t('investments.unmapped.mapAllExistingApplied')(count));
    navigate('investments');
  }
}

// ── Edit-holding dialog ────────────────────────────────────────────────

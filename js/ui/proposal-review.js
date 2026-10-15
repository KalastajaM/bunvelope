// js/ui/proposal-review.js — the one review surface every AI proposal renders
// through, whether it came from a receipt photo, a bank CSV, or the prompt
// dialog.
//
// The design goal is that the user's attention lands where it is worth
// spending. Rows the model was unsure about, or that carry a warning, are
// grouped first under their own heading; confident rows sit below in a group
// the user can skim or collapse. Duplicates are separated out entirely — they
// are not going to be written, so they should not compete for attention.
//
// One deliberate behaviour: rows never re-sort while the user is working.
// Grouping is computed once when the component is built. Editing a row that
// then jumps to a different part of the list is disorienting, and the whole
// point of the ordering is to give the user a stable place to stop reading.

import { t } from './i18n.js';
import { moneyEl } from './money.js';
import { icon } from './icon.js';
import { fmtDateShortLang } from './i18n.js';
import { needsReview, sortForReview, committableRows } from '../ai/proposal.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function optionList(select, entries, selected, noneLabel) {
  const none = document.createElement('option');
  none.value = '';
  none.textContent = noneLabel;
  select.append(none);
  for (const entry of entries) {
    const opt = document.createElement('option');
    opt.value = entry.id;
    opt.textContent = entry.name;
    if (entry.id === selected) opt.selected = true;
    select.append(opt);
  }
  if (!selected) none.selected = true;
}

function warningText(warning) {
  const key = `ai.proposal.warn.${warning.code}`;
  const template = t(key);
  // t() hands the key path back when a string is missing. The detail on a
  // count-style warning is a bare number, so falling back to it alone renders
  // as a stray digit — include the code so a missing translation is obviously
  // a missing translation rather than mystery output.
  if (template === key) {
    return warning.message ? `${warning.code}: ${warning.message}` : warning.code;
  }
  // Templates get the whole warning, so one carrying two numbers (the row
  // sum and the document's printed total) can phrase both.
  return typeof template === 'function' ? template(warning.message, warning) : template;
}

function confidenceChip(row) {
  const conf = row.confidence;
  const chip = el('span', 'prow-conf');
  if (conf === null || conf === undefined) {
    chip.classList.add('prow-conf--none');
    chip.textContent = t('ai.proposal.confUnknown');
  } else if (conf < 0.7) {
    chip.classList.add('prow-conf--low');
    chip.textContent = t('ai.proposal.confLow');
  } else if (conf < 0.9) {
    chip.classList.add('prow-conf--mid');
    chip.textContent = t('ai.proposal.confMid');
  } else {
    chip.classList.add('prow-conf--high');
    chip.textContent = t('ai.proposal.confHigh');
  }
  if (row.rationale) chip.title = row.rationale;
  return chip;
}

/**
 * @param {object} opts
 * @param {object} opts.proposal   validated proposal (mutated in place as the
 *                                 user edits — Approve receives it as edited)
 * @param {object} opts.state      app state, for envelope/account lists
 * @param {(proposal: object) => void} opts.onApprove
 * @param {() => void=} opts.onDiscard
 * @param {(count: number) => void=} opts.onCountChange
 * @returns {{ root: HTMLElement, refreshFooter: () => void }}
 */
export function renderProposalReview({ proposal, state, onApprove, onDiscard, onCountChange, importReview = null }) {
  const root = el('div', 'proposal-review');

  const envelopes = (state.envelopes || []).filter((e) => !e.archived);
  const accounts = (state.accounts || []).filter((a) => !a.archived && a.type !== 'asset' && a.type !== 'loan' && a.type !== 'loan_given');

  const duplicates = (proposal.rows || []).filter((r) => r.duplicateOf);
  const fresh = (proposal.rows || []).filter((r) => !r.duplicateOf);
  const attention = sortForReview(fresh.filter(needsReview));
  const settled = sortForReview(fresh.filter((r) => !needsReview(r)));

  // ── Summary ────────────────────────────────────────────────────────────
  const summary = el('div', 'proposal-summary');
  const counts = el('div', 'proposal-counts');
  counts.append(el('strong', null, String(fresh.length)));
  counts.append(document.createTextNode(` ${t('ai.proposal.toAdd')}`));
  if (duplicates.length) {
    counts.append(el('span', 'proposal-counts-sep', ' · '));
    counts.append(document.createTextNode(
      typeof t('ai.proposal.dupCount') === 'function'
        ? t('ai.proposal.dupCount')(duplicates.length)
        : `${duplicates.length}`,
    ));
  }
  summary.append(counts);

  const totalWrap = el('div', 'proposal-total');
  totalWrap.append(el('span', 'proposal-total-label', t('ai.proposal.total')));
  let totalValue = moneyEl(0, { size: 'md' });
  totalWrap.append(totalValue);
  summary.append(totalWrap);
  root.append(summary);

  // ── Proposal-level warnings ────────────────────────────────────────────
  if ((proposal.warnings || []).length) {
    const banner = el('div', 'proposal-warnings');
    const head = el('div', 'proposal-warnings-head');
    head.append(icon('flag', 15));
    head.append(el('span', null, t('ai.proposal.checkThese')));
    banner.append(head);
    const list = el('ul', 'proposal-warnings-list');
    for (const w of proposal.warnings) list.append(el('li', null, warningText(w)));
    banner.append(list);
    root.append(banner);
  }

  // ── Row groups ─────────────────────────────────────────────────────────
  const rowEls = new Map();

  if (attention.length) {
    root.append(groupHeading(t('ai.proposal.needsLook'), attention.length, 'attention'));
    const list = el('div', 'prow-list');
    for (const row of attention) list.append(buildRow(row));
    root.append(list);
  }

  if (settled.length) {
    root.append(groupHeading(t('ai.proposal.looksRight'), settled.length, 'settled'));
    const list = el('div', 'prow-list');
    for (const row of settled) list.append(buildRow(row));
    root.append(list);
  }

  if (!fresh.length) {
    root.append(el('p', 'proposal-empty', t('ai.proposal.nothingNew')));
  }

  if (duplicates.length) {
    const details = el('details', 'proposal-dups');
    const summaryEl = document.createElement('summary');
    summaryEl.textContent = typeof t('ai.proposal.dupHeading') === 'function'
      ? t('ai.proposal.dupHeading')(duplicates.length)
      : t('ai.proposal.dupHeading');
    details.append(summaryEl);
    const hint = el('p', 'proposal-dups-hint', t('ai.proposal.dupHint'));
    details.append(hint);
    const list = el('div', 'prow-list prow-list--muted');
    for (const row of duplicates) list.append(buildDuplicateRow(row));
    details.append(list);
    root.append(details);
  }

  // ── Footer ─────────────────────────────────────────────────────────────
  const footer = el('div', 'proposal-actions');
  const discardBtn = el('button', 'btn btn-ghost', t('ai.proposal.discard'));
  discardBtn.type = 'button';
  discardBtn.addEventListener('click', () => onDiscard && onDiscard());

  const approveBtn = el('button', 'btn btn-accent');
  approveBtn.type = 'button';
  approveBtn.addEventListener('click', () => onApprove && onApprove(proposal));

  footer.append(discardBtn, approveBtn);
  root.append(footer);

  refreshFooter();

  function groupHeading(label, count, variant) {
    const h = el('div', `proposal-group proposal-group--${variant}`);
    h.append(el('span', 'proposal-group-label', label));
    h.append(el('span', 'proposal-group-count', String(count)));
    return h;
  }

  function buildRow(row) {
    const wrap = el('div', 'prow');
    if (needsReview(row)) wrap.classList.add('prow--attention');
    rowEls.set(row, wrap);

    const include = document.createElement('input');
    include.type = 'checkbox';
    include.className = 'prow-include';
    include.checked = !row.excluded;
    include.setAttribute('aria-label', t('ai.proposal.includeRow'));
    include.addEventListener('change', () => {
      row.excluded = !include.checked;
      if (importReview) {
        if (row.importDuplicateOf) row.duplicateOf = include.checked ? null : row.importDuplicateOf;
        importReview.onExcluded(row.importSource.key,row.excluded);
      }
      wrap.classList.toggle('prow--excluded', !include.checked);
      refreshFooter();
    });
    wrap.append(include);

    const main = el('div', 'prow-main');

    const top = el('div', 'prow-top');
    const payee = el('span', 'prow-payee', row.payee || t('ai.proposal.noPayee'));
    const amount = moneyEl(row.amount, { size: 'md' });
    amount.classList.add('prow-amount');
    top.append(payee, amount);
    main.append(top);

    const bottom = el('div', 'prow-bottom');
    bottom.append(el('span', 'prow-date', fmtDateShortLang(row.date)));

    const acctSel = document.createElement('select');
    acctSel.className = 'prow-select';
    acctSel.setAttribute('aria-label', t('ai.proposal.account'));
    optionList(acctSel, accounts, row.account_id, t('ai.proposal.pickAccount'));
    acctSel.addEventListener('change', () => {
      row.account_id = acctSel.value || null;
      if (counterSel) fillCounter();
      markReviewed(row, wrap);
    });

    // A transfer needs its other side. Proposals derive the direction from
    // the bank sign, so the row knows whether the money came in or went out;
    // without this picker a transfer whose counterpart the model could not
    // name could only be excluded, never completed.
    let counterSel = null;
    const fillCounter = () => {
      counterSel.replaceChildren();
      optionList(counterSel, accounts.filter(a => a.id !== row.account_id),
        row.counter_account, t('ai.proposal.pickAccount'));
    };
    if (row.type === 'account_transfer') {
      counterSel = document.createElement('select');
      counterSel.className = 'prow-select';
      counterSel.setAttribute('aria-label', t(row.transfer_direction === 'in'
        ? 'ai.proposal.transferFrom' : 'ai.proposal.transferTo'));
      fillCounter();
      counterSel.addEventListener('change', () => {
        row.counter_account = counterSel.value || null;
        if (row.counter_account) {
          row.excluded = false;
          importReview?.onExcluded(row.importSource.key, false);
          include.checked = true;
          wrap.classList.remove('prow--excluded');
        }
        markReviewed(row, wrap);
      });
    }

    const envSel = document.createElement('select');
    envSel.className = 'prow-select';
    envSel.setAttribute('aria-label', t('ai.proposal.envelope'));
    optionList(envSel, envelopes, row.envelope_id, t('ai.proposal.pickEnvelope'));
    envSel.addEventListener('change', () => {
      row.envelope_id = envSel.value || null;
      importReview?.onFieldEdit(row.importSource.key,'envelope',row.envelope_id);
      markReviewed(row, wrap);
      offerApplyToPayee(row, wrap);
    });

    bottom.append(acctSel, ...(counterSel ? [counterSel] : []), envSel, confidenceChip(row));
    main.append(bottom);

    if ((row.warnings || []).length) {
      const notes = el('div', 'prow-notes');
      for (const w of row.warnings) notes.append(el('span', 'prow-note', warningText(w)));
      main.append(notes);
    }

    if (row.rationale) {
      const why = el('div', 'prow-why', row.rationale);
      main.append(why);
    }

    if (importReview) { const rules = el('div','prow-rule-controls'); rules.append(importReview.renderRow(row.importSource.key)); main.append(rules); }
    wrap.append(main);
    return wrap;
  }

  function buildDuplicateRow(row) {
    if (importReview) { row.importDuplicateOf = row.duplicateOf; row.excluded = true; return buildRow(row); }
    const wrap = el('div', 'prow prow--dup');
    const main = el('div', 'prow-main');
    const top = el('div', 'prow-top');
    top.append(el('span', 'prow-payee', row.payee || t('ai.proposal.noPayee')));
    const amount = moneyEl(row.amount, { size: 'md' });
    amount.classList.add('prow-amount');
    top.append(amount);
    main.append(top);
    const bottom = el('div', 'prow-bottom');
    bottom.append(el('span', 'prow-date', fmtDateShortLang(row.date)));
    bottom.append(el('span', 'prow-dup-tag', t('ai.proposal.dupTag')));
    main.append(bottom);
    wrap.append(main);
    return wrap;
  }

  // A hand-edited row is settled by definition — drop the attention styling
  // so the "needs a look" group visibly empties as the user works through it.
  // The row does not move; only its appearance changes.
  function markReviewed(row, wrap) {
    row.confidence = 1;
    row.userEdited = true;
    wrap.classList.remove('prow--attention');
    const chip = wrap.querySelector('.prow-conf');
    if (chip) chip.replaceWith(confidenceChip(row));
    refreshFooter();
  }

  // Statement imports repeat the same payee many times. Having corrected one,
  // offering the rest in a single click is the difference between fixing a
  // booking and fixing forty of them.
  function offerApplyToPayee(row, wrap) {
    wrap.querySelector('.prow-apply-all')?.remove();
    const payee = (row.payee || '').trim().toLowerCase();
    if (!payee || !row.envelope_id) return;

    const siblings = fresh.filter((r) => r !== row
      && (r.payee || '').trim().toLowerCase() === payee
      && r.envelope_id !== row.envelope_id);
    if (!siblings.length) return;

    const bar = el('div', 'prow-apply-all');
    const btn = el('button', 'btn-link');
    btn.type = 'button';
    const label = t('ai.proposal.applyToAll');
    btn.textContent = typeof label === 'function'
      ? label(siblings.length, row.payee)
      : label;
    btn.addEventListener('click', () => {
      for (const sib of siblings) {
        sib.envelope_id = row.envelope_id;
        importReview?.onFieldEdit(sib.importSource.key,'envelope',sib.envelope_id);
        const sibEl = rowEls.get(sib);
        if (!sibEl) continue;
        const sel = sibEl.querySelectorAll('.prow-select')[1];
        if (sel) sel.value = row.envelope_id;
        markReviewed(sib, sibEl);
      }
      bar.replaceChildren(el('span', 'prow-applied', t('ai.proposal.applied')));
      refreshFooter();
    });
    bar.append(btn);
    wrap.querySelector('.prow-main').append(bar);
  }

  function refreshFooter() {
    const rows = committableRows(proposal);
    const total = rows.reduce((sum, r) => sum + r.amount, 0);
    const nextTotal = moneyEl(total, { size: 'md' });
    totalValue.replaceWith(nextTotal);
    totalValue = nextTotal;
    const label = t('ai.proposal.approve');
    approveBtn.textContent = typeof label === 'function' ? label(rows.length) : label;
    approveBtn.disabled = rows.length === 0 || (importReview && !importReview.canApprove());
    if (onCountChange) onCountChange(rows.length);
  }

  function refreshRows() {
    for (const [row,node] of rowEls) {
      const payee = node.querySelector('.prow-payee'); if (payee) payee.textContent = row.payee || t('ai.proposal.noPayee');
      const env = node.querySelector('select[aria-label="'+t('ai.proposal.envelope')+'"]'); if (env) env.value = row.envelope_id || '';
      const controls = node.querySelector('.prow-rule-controls'); if (controls) controls.replaceChildren(importReview.renderRow(row.importSource.key));
    }
    refreshFooter();
  }
  return { root, refreshFooter, refreshRows };
}

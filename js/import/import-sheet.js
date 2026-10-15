import { createImportRuleReview, importRuleApprovalError } from './rule-review.js';
// js/import/import-sheet.js
// "Import Transactions" sheet — generic bank CSV import.
// Two phases: (1) map CSV columns + pick account, (2) review matched/new and confirm.

import { openSheet } from '../ui/sheet.js';
import { addPageHelp } from '../ui/info-button.js';
import { toast } from '../ui/toast.js';
import { confirmDialog } from '../ui/dialog.js';
import { t, trEnv } from '../ui/i18n.js';
import { aiErrorText } from '../ai/render.js';
import { generateId } from '../import.js';
import { fmt } from '../utils.js';
import { updateMeta } from '../state/meta-writes.js';
import { reportSaveError } from '../ui/save-error.js';
import {
  detectSeparator, parseCsv, detectColumns, parseRow, withDecimalHint,
  getTemplates, addTemplate, removeTemplate, matchCsvRows,
  rowProblem, columnHasValues, csvShapeProblem,
} from './csv-parse-generic.js';
import { payeeHistoryDefault } from './payee-defaults.js';
import { enhanceSelectWithSearch } from '../ui/select-combobox.js';
import { readImportFile } from './read-file.js';
import { isImageFile, isPdfFile } from './downscale.js';
import { runAiImportPhase, readDocument, recordImportRows } from './ai-import-flow.js';
import { isAiAvailable } from '../ai/client.js';
import { alertDialog } from '../ui/dialog.js';
import { checkStatementBalance } from './statement-balance.js';
import { openReconcileModal } from '../reconcile.js';
import { parseAmountInput } from '../ui/amount-input.js';
import { countClosedRows } from '../state/closed-periods.js';
import { now, session, navigate, updateStatusBar } from '../app.js';
import { confirmClosedEdit } from '../ui/closed-period-guard.js';
import { csvSourceAccountColumn, filterImportAccount, prepareReconcileImport } from './reconcile-import.js';
import { currentBudgetSession } from '../state/budget-session.js';
import { renderStatementReview } from './statement-review.js';
import { getPayeeAliases } from '../core/payee-fields.js';
import { queryAnswer } from '../ai/query.js';

// ── Tiny DOM helpers ──────────────────────────────────────────────────────────

function mkSel(opts, val) {
  const s = document.createElement('select');
  s.className = 'form-input';
  for (const [v, lbl] of opts) {
    const o = document.createElement('option');
    o.value = String(v); o.textContent = lbl;
    if (String(v) === String(val)) o.selected = true;
    s.append(o);
  }
  return s;
}

function colOpts(headers, none = false) {
  const out = none ? [[-1, t('txImport.payeeNone')]] : [];
  headers.forEach((h, i) => out.push([i, `[${i}] ${h || '(empty)'}`]));
  return out;
}

function fld(label, input) {
  const w = document.createElement('div');
  w.className = 'field';
  w.style.marginBottom = '10px';
  const lbl = document.createElement('label');
  lbl.textContent = label;
  w.append(lbl, input);
  return w;
}

// How many unreadable rows the sheet lists by line before "…and N more".
const PROBLEMS_SHOWN = 5;

/**
 * Parse every data row. `lines` holds each row's line in the file (the
 * header is line 1), so a row that fails is named by where it is.
 */
function parseAll(rows, mapping, headers = [], lines = []) {
  let valid = [], errors = 0;
  const problems = [];
  const hinted = { ...withDecimalHint(rows, mapping), headers };
  const accountCol = csvSourceAccountColumn(headers);
  rows.forEach((r, i) => {
    const p = parseRow(r, hinted);
    if (p) {
      if (accountCol >= 0) p.sourceAccount = String(r[accountCol] || '').trim();
      valid.push(p); return;
    }
    errors++;
    const why = rowProblem(r, hinted);
    if (why) problems.push({ line: lines[i] ?? i + 2, reason: why.reason, value: String(why.value).slice(0, 40) });
  });
  return { valid, errors, problems };
}

/** The first few unreadable rows, by line and reason, as a list element. */
function problemList(problems) {
  const ul = document.createElement('ul');
  ul.className = 'import-problems';
  ul.style.cssText = 'font-size:12px;color:var(--danger-text);margin:0 0 8px;padding-left:18px;';
  for (const p of problems.slice(0, PROBLEMS_SHOWN)) {
    const li = document.createElement('li');
    li.textContent = t('txImport.rowProblem')(p);
    ul.append(li);
  }
  if (problems.length > PROBLEMS_SHOWN) {
    const li = document.createElement('li');
    li.textContent = t('txImport.rowProblemsMore')(problems.length - PROBLEMS_SHOWN);
    ul.append(li);
  }
  return ul;
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function openImportSheet(state, { reconcile = null, initialFile = null } = {}) {
  const generation = currentBudgetSession();
  const folder = state.budgetFolder;
  let closed = false;
  let filename = '';
  let staging = false;
  let fileVersion = 0;
  const active = () => !closed && !!wrap.closest('[data-sheet-open]') && generation === currentBudgetSession() && folder === state.budgetFolder && (!reconcile || reconcile.isActive());
  let dataRows = [], headers = [], sep = ',';
  // Each data row's line in the file (header = 1), for naming bad rows.
  let dataLines = [];
  // Why the chosen file cannot be imported ('empty' | 'notCsv'), or ''.
  let fileProblem = '';
  let mapping = { dateCol: -1, payeeCol: -1, amountCol: -1, debitCol: -1, creditCol: -1, noteCols: [] };
  let amountMode = 'single';
  let accountId = reconcile?.accountId || '';
  // Raw text so the field survives re-renders of phase 1; parsed only at the
  // point of use. Blank means "don't check", which is the default.
  let statementBalanceRaw = '';
  let approvedStatement = null;
  let restartStatementReview = null;
  // Rows read straight out of a document (receipt/PDF/unparseable CSV) rather
  // than through the column mapper. When set, phase 1's mapping UI is skipped
  // entirely — there are no columns to map.
  let docRows = null;
  let docMeta = { declaredTotal: null, source: 'csv', skipped: 0 };
  let inflight = null;

  /**
   * After a successful write, tell the user whether the account now agrees
   * with the statement they just imported. Runs only when they supplied a
   * closing balance — silence otherwise, since a check nobody asked for that
   * reports "no data" is worse than no check.
   *
   * On a mismatch this offers Reconcile rather than fixing anything: the gap
   * usually means a row was imported twice (banks re-date pending rows, so a
   * re-export can slip past the duplicate matcher), and that wants a human
   * looking at the transactions, not a silent adjustment papering over them.
   */
  async function reportStatementBalance(importedRows) {
    if (approvedStatement) {
      const { balance, rows } = approvedStatement;
      if (balance.target === null) return;
      const checked = queryAnswer(state, 'import.review', { account: accountId,
        rows: rows.map(({ key, date, payee, amount, bankStatus, bankBalance }) => ({ key, date, payee, amount,
          ...(bankStatus ? { bankStatus } : {}), ...(Number.isFinite(bankBalance) ? { bankBalance } : {}) })),
        target: balance.target, date: balance.date, basis: balance.basis, selected: [],
      }, now).balance;
      if (checked.ledgerRemaining === 0) toast(t('txImport.balanceMatch')(fmt(checked.target)));
      else if (checked.pendingUncertain) await alertDialog(t('statementReview.afterImport')(fmt(checked.ledgerRemaining, { signed: true })));
      else if (await confirmDialog(t('txImport.balanceMismatch')({ expected: fmt(checked.target), actual: fmt(checked.projected), difference: fmt(Math.abs(checked.ledgerRemaining)) }), {
        title: t('txImport.balanceMismatchTitle'), okLabel: t('txImport.balanceOpenReconcile'), cancelLabel: t('txImport.balanceLater'),
      })) openReconcileModal(accountId);
      return;
    }
    const parsed = parseAmountInput(statementBalanceRaw);
    const result = checkStatementBalance({
      accounts: state.accounts,
      transactions: state.transactions,
      accountId,
      statementBalance: Number.isFinite(parsed) ? parsed : NaN,
      rows: importedRows,
    });
    if (!result) return;

    if (result.matches) {
      toast(t('txImport.balanceMatch')(fmt(result.expected)));
      return;
    }
    const openReconcile = await confirmDialog(
      t('txImport.balanceMismatch')({
        expected: fmt(result.expected),
        actual: fmt(result.actual),
        difference: fmt(Math.abs(result.difference)),
      }),
      {
        title: t('txImport.balanceMismatchTitle'),
        okLabel: t('txImport.balanceOpenReconcile'),
        cancelLabel: t('txImport.balanceLater'),
      },
    );
    if (openReconcile) openReconcileModal(accountId);
  }

  // After rows landed: the page behind the sheet and the status bar show
  // them, the same repaint the loader does after its load-time writes. Not
  // after a refusal (nothing changed) or a budget switch (the next budget's
  // loader paints). Never throws: the rows are written and the sheet closed,
  // so a repaint failure must not reach the import's catch.
  async function repaint() {
    try {
      updateStatusBar();
      await navigate(state.currentPage);
    } catch (err) {
      console.error('repaint after the import failed:', err);
    }
  }

  const wrap = document.createElement('div');
  // A parsed-but-unimported CSV is session work worth a confirm before
  // any dismissal (Escape or Cancel) throws it away.
  const sheet = openSheet({
    title: t('txImport.title'),
    content: wrap,
    wide: true,
    onClose: () => { closed = true; inflight?.abort(); },
    confirmClose: () => (dataRows.length === 0 && !docRows)
      || confirmDialog(t('common.discardConfirm')),
  });
  addPageHelp(wrap.closest('.sheet').querySelector('[id^="sheet-title-"]'), 'statementReview.intro');

  // ── Phase 1 ────────────────────────────────────────────────────────────────

  function showPhase1() {
    approvedStatement = null;
    restartStatementReview = null;
    wrap.innerHTML = '';

    // Templates
    const templates = getTemplates(state.meta);
    if (templates.length) {
      const sec = document.createElement('div');
      sec.style.marginBottom = '16px';
      const h = document.createElement('h4');
      h.style.cssText = 'font-size:11px;font-weight:700;margin:0 0 6px;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;';
      h.textContent = t('txImport.templates');
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;align-items:center;';
      const tplSel = mkSel(templates.map(tp => [tp.id, tp.name]), templates[0]?.id);
      tplSel.style.flex = '1';
      const loadBtn = document.createElement('button');
      loadBtn.className = 'btn btn-ghost'; loadBtn.type = 'button';
      loadBtn.textContent = t('txImport.loadTemplate');
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-ghost'; delBtn.type = 'button';
      delBtn.style.color = 'var(--danger)';
      delBtn.textContent = t('txImport.deleteTemplate');
      row.append(tplSel, loadBtn, delBtn);
      sec.append(h, row);
      wrap.append(sec);

      loadBtn.addEventListener('click', () => {
        const tpl = templates.find(tp => tp.id === tplSel.value);
        if (tpl) applyTemplate(tpl);
      });
      delBtn.addEventListener('click', async () => {
        const tpl = templates.find(tp => tp.id === tplSel.value);
        if (!tpl) return;
        const ok = await confirmDialog(t('txImport.deleteTemplateConfirm')(tpl.name), { okLabel: t('txImport.deleteTemplate'), danger: true });
        if (!ok) return;
        try {
          await removeTemplate(state, tpl.id, updateMeta);
        } catch (err) {
          reportSaveError(err, 'template delete failed');
          return;
        }
        showPhase1();
      });
    }

    // File input
    const fileWrap = document.createElement('div');
    fileWrap.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:16px;';
    const fileInput = document.createElement('input');
    const aiOn = isAiAvailable();
    fileInput.type = 'file';
    // Images and PDFs only make sense when there is a model to read them.
    fileInput.accept = aiOn
      ? '.csv,text/csv,image/png,image/jpeg,image/webp,application/pdf'
      : '.csv,text/csv';
    fileInput.style.display = 'none';
    const fileBtn = document.createElement('button');
    fileBtn.className = 'btn btn-ghost'; fileBtn.type = 'button';
    fileBtn.textContent = aiOn ? t('txImport.ai.chooseFile') : t('txImport.chooseCsv');
    const fileLbl = document.createElement('span');
    fileLbl.style.cssText = 'font-size:13px;color:var(--muted);';
    fileLbl.textContent = dataRows.length ? `${dataRows.length} rows loaded` : '';
    fileWrap.append(fileInput, fileBtn, fileLbl);
    wrap.append(fileWrap);

    if (fileProblem) {
      const p = document.createElement('p');
      p.className = 'import-file-problem';
      p.setAttribute('role', 'alert');
      p.style.cssText = 'font-size:13px;color:var(--danger-text);margin:-6px 0 14px;line-height:1.5;';
      p.textContent = t(fileProblem === 'empty' ? 'txImport.emptyFile' : 'txImport.notCsv');
      wrap.append(p);
    }

    if (aiOn) {
      const blurb = document.createElement('p');
      blurb.style.cssText = 'font-size:12px;color:var(--muted);margin:-8px 0 16px;line-height:1.5;';
      blurb.textContent = t('txImport.ai.blurb');
      wrap.append(blurb);
    }

    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      if (!e.target.files.length) return;
      handleFile(e.target.files[0]).catch(err => alertDialog(`${t('txImport.importError')}: ${err.message}`));
    });

    // Mapping fields (after file is loaded)
    let nextBtn;
    // Rows the current mapping reads; none means nothing to review.
    let validCount = 0;
    if (headers.length) {
      const colsOpts     = colOpts(headers);
      const colsOptsNone = colOpts(headers, true);

      const dateSel = mkSel(colsOpts, mapping.dateCol);
      dateSel.addEventListener('change', () => { mapping.dateCol = +dateSel.value; showPhase1(); });
      wrap.append(fld(t('txImport.dateCol'), dateSel));

      const payeeSel = mkSel(colsOptsNone, mapping.payeeCol);
      const payeeWrap = fld(t('txImport.payeeCol'), payeeSel);
      // A column with nothing in it imports every payee as "—"; say so.
      const payeeHint = document.createElement('div');
      payeeHint.className = 'field-note field-note--warn import-payee-empty';
      payeeHint.style.marginTop = '4px';
      const payeeEmpty = mapping.payeeCol >= 0 && !columnHasValues(dataRows, mapping.payeeCol);
      payeeHint.hidden = !payeeEmpty;
      payeeHint.textContent = payeeEmpty ? t('txImport.payeeColEmpty') : '';
      payeeSel.addEventListener('change', () => { mapping.payeeCol = +payeeSel.value; showPhase1(); });
      payeeWrap.append(payeeHint);
      // Columns whose text becomes the note (message, description, archive id).
      const noteCols = (mapping.noteCols || []).filter(i => i >= 0 && i < headers.length && i !== mapping.payeeCol);
      if (noteCols.length) {
        const noteLine = document.createElement('div');
        noteLine.className = 'import-note-cols';
        noteLine.style.cssText = 'font-size:11px;color:var(--muted);margin-top:4px;';
        noteLine.textContent = t('txImport.noteCols')(noteCols.map(i => headers[i]).join(', '));
        payeeWrap.append(noteLine);
      }
      wrap.append(payeeWrap);

      // Amount mode toggle
      const amtLbl = document.createElement('label');
      amtLbl.style.cssText = 'display:block;font-size:11px;font-weight:700;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.04em;';
      amtLbl.textContent = t('txImport.amountLabel');
      wrap.append(amtLbl);

      const modeDiv = document.createElement('div');
      modeDiv.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
      const mkModeBtn = (mode, lbl) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn btn-ghost';
        b.style.cssText = `font-size:12px;padding:4px 10px;${mode === amountMode ? 'background:var(--surface-alt);font-weight:700;' : ''}`;
        b.textContent = lbl;
        b.addEventListener('click', () => { amountMode = mode; showPhase1(); });
        return b;
      };
      modeDiv.append(mkModeBtn('single', t('txImport.amountSingle')), mkModeBtn('debitcredit', t('txImport.amountDebitCredit')));
      wrap.append(modeDiv);

      if (amountMode === 'single') {
        if (mapping.amountCol < 0 && colsOpts.length) mapping.amountCol = +colsOpts[0][0];
        const amtSel = mkSel(colsOpts, mapping.amountCol);
        amtSel.addEventListener('change', () => { mapping.amountCol = +amtSel.value; showPhase1(); });
        wrap.append(amtSel);
        mapping.debitCol = -1; mapping.creditCol = -1;
      } else {
        const debSel = mkSel(colsOptsNone, mapping.debitCol);
        const creSel = mkSel(colsOptsNone, mapping.creditCol);
        debSel.addEventListener('change', () => { mapping.debitCol = +debSel.value; showPhase1(); });
        creSel.addEventListener('change', () => { mapping.creditCol = +creSel.value; showPhase1(); });
        wrap.append(fld(t('txImport.debitCol'), debSel), fld(t('txImport.creditCol'), creSel));
        mapping.amountCol = -1;
      }

      // Account
      const acctOpts = [['', t('txImport.pickAccount')], ...(state.accounts || []).filter(a => !a.archived).map(a => [a.id, a.name])];
      const acctSel = mkSel(acctOpts, accountId);
      if (reconcile) acctSel.disabled = true;
      acctSel.addEventListener('change', () => { accountId = acctSel.value; updateBtn(); });
      const acctWrap = fld(t('txImport.account'), acctSel);
      acctWrap.style.marginTop = '12px';
      wrap.append(acctWrap);

      // Optional closing balance. The one number that can tell you, at the
      // moment of import, whether anything slipped past the duplicate matcher
      // — a re-dated row imported twice leaves the ledger richer or poorer
      // than the statement by exactly that amount.
      const balInput = document.createElement('input');
      balInput.type = 'text';
      balInput.inputMode = 'decimal';
      balInput.placeholder = t('txImport.closingBalancePh');
      balInput.value = statementBalanceRaw;
      balInput.addEventListener('input', () => { statementBalanceRaw = balInput.value; });
      const balWrap = fld(t('txImport.closingBalance'), balInput);
      balWrap.style.marginTop = '12px';
      balWrap.title = t('txImport.closingBalanceHint');
      const balHint = document.createElement('div');
      balHint.style.cssText = 'font-size:11px;color:var(--muted);margin-top:4px;';
      balHint.textContent = t('txImport.closingBalanceHint');
      balWrap.append(balHint);
      if (!reconcile) wrap.append(balWrap);

      // Preview
      const { valid, errors, problems } = parseAll(dataRows, mapping, headers, dataLines);
      validCount = valid.length;
      if (valid.length) {
        const ph = document.createElement('h4');
        ph.style.cssText = 'font-size:13px;font-weight:700;margin:14px 0 6px;';
        ph.textContent = `${t('txImport.preview')} — ${valid.length} parsed${errors ? `, ${errors} skipped` : ''}`;
        wrap.append(ph, buildPreviewTbl(valid.slice(0, 3)));
        if (problems.length) wrap.append(problemList(problems));
      } else if (errors) {
        const p = document.createElement('p');
        p.style.cssText = 'font-size:13px;color:var(--danger-text);margin:8px 0;';
        p.textContent = t('txImport.parseErrors')(errors);
        wrap.append(p, problemList(problems));
      }

      // Save template
      const saveTplBtn = document.createElement('button');
      saveTplBtn.className = 'btn btn-ghost'; saveTplBtn.type = 'button';
      saveTplBtn.style.cssText = 'font-size:12px;margin-top:10px;';
      saveTplBtn.textContent = t('txImport.saveTemplate');
      saveTplBtn.addEventListener('click', handleSaveTemplate);
      wrap.append(saveTplBtn);
    }

    // Footer
    const foot = document.createElement('div');
    foot.dataset.sheetActions = '';
    foot.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:16px;padding-top:12px;border-top:1px solid var(--border);';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost'; cancelBtn.type = 'button';
    cancelBtn.textContent = t('txImport.cancel');
    cancelBtn.addEventListener('click', () => sheet.requestClose());
    nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn-accent'; nextBtn.type = 'button';
    nextBtn.textContent = t(reconcile ? 'reconcile.stageImport' : 'txImport.reviewMatches');
    nextBtn.addEventListener('click', () => showPhase2());
    foot.append(cancelBtn, nextBtn);
    sheet.setHeaderActions(foot);

    updateBtn();

    function updateBtn() {
      const hasDate = mapping.dateCol >= 0;
      const hasAmt  = amountMode === 'single' ? mapping.amountCol >= 0 : (mapping.debitCol >= 0 || mapping.creditCol >= 0);
      nextBtn.disabled = !(hasDate && hasAmt && accountId && dataRows.length > 0 && validCount > 0);
    }
  }

  // ── File handling ─────────────────────────────────────────────────────────
  // CSV keeps the deterministic parser: it is exact, free, and already knows
  // this user's bank templates. The model is only asked to read a file when
  // the parser genuinely cannot — a photo, a PDF, or a CSV whose columns it
  // could not identify.

  async function handleFile(file) {
    const version = ++fileVersion;
    filename = file.name;
    docRows = null;
    docMeta = { declaredTotal: null, source: 'csv', skipped: 0 };

    if (isImageFile(file) || isPdfFile(file)) {
      if (!isAiAvailable()) {
        await alertDialog(t('ai.error.noUserApiKey'));
        return;
      }
      await readDocumentFile(file, isPdfFile(file) ? 'statement' : 'receipt');
      return;
    }

    const text = await readImportFile(file);
    if (!active() || version !== fileVersion) return;
    sep = detectSeparator(text);
    const rows = parseCsv(text, sep);
    fileProblem = csvShapeProblem(text, rows) || '';
    if (fileProblem) {
      headers = []; dataRows = []; dataLines = [];
      showPhase1();
      return;
    }
    headers = rows[0].map(h => String(h).trim());
    // Blank rows are dropped, so keep each kept row's line (header = 1).
    dataRows = []; dataLines = [];
    rows.slice(1).forEach((r, i) => {
      if (!r.some(c => String(c).trim())) return;
      dataRows.push(r); dataLines.push(i + 2);
    });
    const det = detectColumns(headers, dataRows);
    mapping = {
      dateCol:   det.dateCol,
      payeeCol:  det.payeeCol >= 0 ? det.payeeCol : -1,
      amountCol: det.amountCol >= 0 ? det.amountCol : (det.debitCol < 0 && det.creditCol < 0 && headers.length ? 0 : -1),
      debitCol:  det.debitCol,
      creditCol: det.creditCol,
      noteCols:  det.noteCols,
    };
    amountMode = (det.debitCol >= 0 || det.creditCol >= 0) ? 'debitcredit' : 'single';

    // Columns the parser could not identify are the one CSV case worth
    // spending tokens on. Offer it rather than doing it silently — the user
    // may simply prefer to map three columns by hand.
    const noDate = mapping.dateCol < 0;
    const noAmount = amountMode === 'single'
      ? mapping.amountCol < 0
      : (mapping.debitCol < 0 && mapping.creditCol < 0);
    if ((noDate || noAmount) && isAiAvailable()) {
      const useAi = await confirmDialog(t('txImport.ai.parseFallbackBody'), {
        title: t('txImport.ai.parseFallbackTitle'),
        okLabel: t('txImport.ai.parseFallbackOk'),
      });
      if (useAi) {
        await readDocumentFile(file, 'csv');
        return;
      }
    }

    showPhase1();
  }

  async function readDocumentFile(file, source) {
    inflight = new AbortController();
    try {
      const result = await readDocument({
        setHeaderActions: sheet.setHeaderActions,
        file, host: wrap, state, clock: now,
        signal: inflight.signal,
        onCancel: () => { inflight?.abort(); showPhase1(); },
      });
      if (!active()) return;
      if (!result.rows.length) {
        await alertDialog(t('txImport.ai.nothingFound'));
        showPhase1();
        return;
      }
      docRows = result.rows;
      docMeta = {
        declaredTotal: result.declaredTotal,
        source,
        skipped: result.skipped || 0,
      };
      // A document carries no column mapping to configure, so there is
      // nothing for phase 1 to ask about — go straight to the review.
      await showPhase2();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      // A refusal gets the localized explanation; other failures keep the
      // detail the transport gave, which is what the owner debugs from.
      // A missing or rejected key is not the file's fault: say only that.
      if (err?.code === 'no_user_api_key' || err?.code === 'invalid_user_api_key') {
        await alertDialog(aiErrorText(err));
        showPhase1();
        return;
      }
      const detail = err?.code === 'ai_refused' ? t('ai.error.refused') : err.message;
      await alertDialog(`${t('txImport.ai.readFailed')}\n\n${detail}`);
      showPhase1();
    } finally {
      inflight = null;
    }
  }

  function applyTemplate(tpl) {
    sep         = tpl.separator  || sep;
    amountMode  = tpl.amountMode || 'single';
    accountId   = reconcile?.accountId || tpl.defaultAccountId || accountId;
    mapping = {
      dateCol:   tpl.dateCol   ?? -1,
      payeeCol:  tpl.payeeCol  ?? -1,
      amountCol: tpl.amountCol ?? -1,
      debitCol:  tpl.debitCol  ?? -1,
      creditCol: tpl.creditCol ?? -1,
      // A template saved before notes were imported keeps what this file's
      // headers name.
      noteCols:  Array.isArray(tpl.noteCols) ? tpl.noteCols : (mapping.noteCols || []),
    };
    showPhase1();
  }

  async function handleSaveTemplate() {
    const name = window.prompt(t('txImport.saveTemplateName'));
    if (!name?.trim()) return;
    try {
      await addTemplate(state, {
        id: generateId(), name: name.trim(), separator: sep, amountMode,
        dateCol: mapping.dateCol, payeeCol: mapping.payeeCol,
        amountCol: mapping.amountCol, debitCol: mapping.debitCol, creditCol: mapping.creditCol,
        noteCols: mapping.noteCols || [],
        defaultAccountId: accountId,
      }, updateMeta);
    } catch (err) {
      reportSaveError(err, 'template save failed');
      return;
    }
    toast(t('txImport.templateSaved'));
    showPhase1();
  }

  // ── Phase 2: Matching review ──────────────────────────────────────────────

  async function showPhase2() {
    // Rows come either from a document the model read or from the column
    // mapper; from here down nothing cares which.
    // Rows the parser could not read travel with them: a statement that
    // silently loses a line is worse than one that says it did.
    const parsed = docRows ? null : parseAll(dataRows, mapping, headers, dataLines);
    const valid = docRows || parsed.valid;
    const skipped = docRows ? docMeta.skipped : parsed.errors;
    const problems = docRows ? [] : parsed.problems;

    if (reconcile) {
      await stageReconcileRows(valid, skipped);
      return;
    }

    if (accountId && (statementBalanceRaw.trim() || valid.some(r => r.bankStatus || Number.isFinite(r.bankBalance)))) {
      showStatementReview(valid, (chosen) => finishReview(chosen, skipped, problems));
      return;
    }
    await finishReview(valid, skipped, problems);
  }

  async function finishReview(valid, skipped, problems) {
    if (!valid.length) { sheet.close(); return; }
    if (isAiAvailable()) {
      await showAiReview(valid, skipped, problems);
      return;
    }
    showMatchTable(valid, skipped, problems);
  }

  function showStatementReview(rows, onContinue) {
    const supplied = reconcile?.getBalanceTarget?.() || {};
    renderStatementReview({ host: wrap, setHeaderActions: actions => sheet.setHeaderActions(actions),
      getState: () => reconcile ? { ...state, transactions: reconcile.getTransactions() } : state,
      accountId, rows, clock: now, active, initialTarget: supplied.target ?? parseAmountInput(statementBalanceRaw), initialBasis: supplied.basis || 'booked',
      initialDate: supplied.date, checked: supplied.checked, onBack: showPhase1, onContinue: (chosen, result) => {
        approvedStatement = result;
        restartStatementReview = () => { showStatementReview(rows, onContinue); toast(t('statementReview.changed')); };
        return onContinue(chosen, result);
      } });
  }

  async function stageReconcileRows(valid, skipped) {
    if (!active() || staging) return;
    staging = true;
    try {
      const filtered = filterImportAccount(valid, state.accounts, accountId);
      let rows = filtered.rows;
      for (const identifier of filtered.unknown) {
        const accepted = await confirmDialog(t('reconcile.importConfirmAccount')(
          identifier || t('reconcile.importUnknownAccount'), state.accounts.find(a => a.id === accountId)?.name || accountId,
        ));
        if (!active()) return;
        if (!accepted) { sheet.close(); return; }
      }
      if (skipped) await alertDialog(t('txImport.parseErrors')(skipped));
      if (!active()) return;
      if (!rows.length) {
        await alertDialog(t('reconcile.importNoAccountRows'));
        if (active()) sheet.close();
        return;
      }
      showStatementReview(rows, (chosen, result) => {
        if (!active()) return;
        const working = { ...state, transactions: reconcile.getTransactions() };
        const prepared = prepareReconcileImport({ state: working, accountId, rows: chosen, filename });
        const context = queryAnswer(state, 'import.review', { account: accountId, rows: [] }, now).context;
        reconcile.onStage(prepared.rows, { ...result.balance, context, statementRows: result.rows });
        sheet.close();
        toast(t('reconcile.importSummary')(prepared.rows.length, rows.length - chosen.length, valid.length - rows.length));
      });
    } finally { staging = false; }
  }

  // AI available: categorize the new rows and hand everything to the shared
  // proposal review, which also covers the matched/new split.
  async function showAiReview(valid, skipped = 0, problems = []) {
    inflight = new AbortController();
    try {
      await runAiImportPhase({
        setHeaderActions: sheet.setHeaderActions,
        importSession: session,
        host: wrap,
        state,
        rows: valid,
        accountId,
        declaredTotal: docMeta.declaredTotal,
        source: docMeta.source,
        skipped,
        clock: now,
        signal: inflight.signal,
        onBack: () => showPhase1(),
        onCancel: () => { inflight?.abort(); sheet.requestClose(); },
        onApprove: async (rows, _proposal, expectedImportContext) => {
          if (!active()) { sheet.close(); return; }
          // Thrown rather than returned: the review re-enables its buttons and
          // shows the message only on a throw (recordImportRows throws a
          // refusal the same way).
          if (!(await confirmClosedEdit(rows.map(x => x.date), countClosedRows(state.meta, rows, now())))) {
            throw new Error(t('closedPeriod.importCancelled'));
          }
          // Appended by the session: the transactions array is not a display order.
          let added;
          try {
            added = await recordImportRows(session, rows, { expectedImportContext,
              ...(approvedStatement ? { expectedStatement: { account: accountId, context: approvedStatement.context } } : {}) });
          } catch (err) {
            if (err.code === 'import_review_changed' && restartStatementReview) { restartStatementReview(); return; }
            throw err;
          }
          docRows = null;
          sheet.close();
          if (!added) return; // the budget it belonged to is no longer open
          toast(t('txImport.success')(added.length));
          // `valid` rather than `rows`: the statement's last date is a
          // property of what the bank sent, not of the subset that survived
          // dedup — and a re-import where everything was a duplicate is
          // exactly the case worth checking.
          await reportStatementBalance(valid);
          await repaint();
        },
      });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      await alertDialog(err?.code === 'no_user_api_key' || err?.code === 'invalid_user_api_key'
        ? aiErrorText(err)
        : `${t('txImport.ai.categorizeFailed')}\n\n${err.message}`);
      // A CSV still imports without the suggestions: the plain review, with
      // each row's envelope from its payee's history. A document read by the
      // model has no such fallback.
      if (!docRows) { showMatchTable(valid, skipped, problems); return; }
      showPhase1();
    } finally {
      inflight = null;
    }
  }

  // No AI configured: the original matched/new table, unchanged. Plain CSV
  // import must keep working without a key.
  function showMatchTable(valid, skipped = 0, problems = []) {
    const raw = matchCsvRows(valid, state.transactions || [], { accountId, aliases: getPayeeAliases(state.meta) })
      .map(r => r.csvRow.importReviewed ? { ...r, matchType: 'none', match: null } : r);
    // Only an exact match (same day, amount and payee) is skipped by
    // default; a possible match is imported and stays marked so the user can
    // untick it (owner decision 2026-10-05). Each row to import starts in
    // the envelope its payee's history names (the add form's payee
    // autofill); the user can change it per row.
    const results = raw.map((r, index) => {
      const skip = r.matchType === 'exact';
      const fromHistory = !skip ? payeeHistoryDefault(state, r.csvRow.payee, r.csvRow.amount) : null;
      return { ...r, key: `row:${index}`, skip, envelopeId: fromHistory?.envelope_id || '', suggested: !!fromHistory };
    });
    const ruleReview = createImportRuleReview({ state, session,
      rows: results.map(r => ({ key:r.key, payee:r.csvRow.payee, amount:r.csvRow.amount, account:accountId, excluded:r.skip })),
      baselines: Object.fromEntries(results.map(r => [r.key,{ payee:r.csvRow.payee, envelope:r.envelopeId || null }])),
      onChanged: () => renderRows(),
    });
    const envelopes = (state.envelopes || []).filter(e => !e.archived);

    wrap.innerHTML = '';
    wrap.append(ruleReview.controls.root);

    // Summary chips
    const counts = { exact: 0, possible: 0, none: 0 };
    for (const r of results) counts[r.matchType]++;

    const sumBar = document.createElement('div');
    sumBar.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;align-items:center;padding:8px 12px;background:var(--surface-alt);border-radius:8px;margin-bottom:10px;font-size:12px;';
    const chip = (label, n, dot) => {
      const s = document.createElement('span');
      s.style.cssText = 'display:inline-flex;align-items:center;gap:5px;';
      const d = document.createElement('span');
      d.style.cssText = `width:9px;height:9px;border-radius:50%;background:${dot};display:inline-block;flex-shrink:0;`;
      const txt = document.createElement('span');
      txt.textContent = `${n} ${label}`;
      s.append(d, txt);
      return s;
    };
    if (counts.exact)    sumBar.append(chip(t('txImport.chipExact'),    counts.exact,    '#22c55e'));
    if (counts.possible) sumBar.append(chip(t('txImport.chipPossible'), counts.possible, '#60a5fa'));
    sumBar.append(chip(t('txImport.chipNew'), counts.none, '#9ca3af'));
    wrap.append(sumBar);
    let showRecorded = false;
    if (counts.exact) {
      const toggle = document.createElement('button');
      toggle.type = 'button'; toggle.className = 'btn btn-ghost btn-sm';
      toggle.textContent = t('statementReview.showRecorded');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.addEventListener('click', () => {
        showRecorded = !showRecorded;
        toggle.setAttribute('aria-expanded', String(showRecorded));
        toggle.textContent = t(showRecorded ? 'statementReview.hideRecorded' : 'statementReview.showRecorded');
        renderRows();
      });
      sumBar.append(toggle);
    }
    if (counts.possible) {
      const exclude = document.createElement('button');
      exclude.type = 'button'; exclude.className = 'btn btn-ghost btn-sm';
      exclude.textContent = t('statementReview.excludePossible');
      exclude.addEventListener('click', () => {
        for (const r of results.filter(r => r.matchType === 'possible')) { r.skip = true; ruleReview.draft.setExcluded(r.key, true); }
        renderRows();
      });
      sumBar.append(exclude);
    }

    if (skipped > 0) {
      const lost = document.createElement('p');
      lost.className = 'import-unreadable';
      lost.style.cssText = 'font-size:12px;color:var(--danger-text);margin:0 0 8px;';
      lost.textContent = t('txImport.parseErrors')(skipped);
      wrap.append(lost);
      if (problems.length) wrap.append(problemList(problems));
    }

    const hint = document.createElement('p');
    hint.style.cssText = 'font-size:12px;color:var(--muted);margin:0 0 8px;';
    hint.textContent = t('txImport.dupHint');
    wrap.append(hint);

    // Table. Seven of its nine columns have a fixed width (518px, enough for
    // a whole date and a four-digit amount), so on a phone the two payee
    // columns had nothing left and collapsed. The table keeps a minimum width
    // that leaves each payee ~100px and scrolls sideways inside the sheet,
    // with the scroll cue fading the hidden edge; the wide sheet on a desktop
    // is wider than the minimum, so it does not scroll there.
    const tbl = document.createElement('table');
    tbl.style.cssText = 'width:100%;min-width:720px;border-collapse:collapse;font-size:13px;table-layout:fixed;';
    const thead = document.createElement('thead');
    const hdrRow = document.createElement('tr');
    [
      ['',                        '70px'],
      [t('txImport.previewDate'),  '86px'],
      [t('txImport.dupColNew'),    ''],
      [t('txImport.previewAmount'), '96px'],
      ['',                        '14px'],
      [t('txImport.previewDate'),  '86px'],
      [`${t('txImport.dupColExisting')} / ${t('txImport.envelopeCol')}`, ''],
      [t('txImport.previewAmount'), '96px'],
      ['',                        '70px'],
    ].forEach(([lbl, w]) => {
      const th = document.createElement('th');
      th.style.cssText = `padding:5px 6px;text-align:left;font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:0.04em;border-bottom:2px solid var(--border);${w ? `width:${w};` : ''}`;
      th.textContent = lbl;
      hdrRow.append(th);
    });
    thead.append(hdrRow);
    tbl.append(thead);

    const tbody = document.createElement('tbody');
    tbl.append(tbody);
    wrap.append(scrollBox(tbl, 'import-match-scroll'));

    // Footer
    const foot = document.createElement('div');
    foot.dataset.sheetActions = '';
    foot.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border);';
    const statusEl = document.createElement('span');
    statusEl.style.cssText = 'flex:1;font-size:12px;color:var(--muted);';
    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-ghost'; backBtn.type = 'button';
    backBtn.textContent = t('txImport.backBtn');
    backBtn.addEventListener('click', () => showPhase1());
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost'; cancelBtn.type = 'button';
    cancelBtn.textContent = t('txImport.cancel');
    cancelBtn.addEventListener('click', () => sheet.requestClose());
    const importBtn = document.createElement('button');
    importBtn.className = 'btn btn-accent'; importBtn.type = 'button';
    foot.append(statusEl, backBtn, cancelBtn, importBtn);
    sheet.setHeaderActions(foot);

    importBtn.addEventListener('click', async () => {
      if (!active()) { sheet.close(); return; }
      const approval = ruleReview.approval();
      if (!approval.ok) { renderRows(); statusEl.textContent = importRuleApprovalError(approval.reason); return; }
      const expectedImportContext = approval.context;
      const toImport = results.filter(r => !r.skip).map(r => ({ ...r.csvRow, payee: approval.fieldsByKey[r.key].payee, envelopeId: approval.fieldsByKey[r.key].envelope }));
      if (!toImport.length) return;
      if (!(await confirmClosedEdit(toImport.map(r => r.date), countClosedRows(state.meta, toImport, now())))) return;
      importBtn.disabled = true; backBtn.disabled = true; cancelBtn.disabled = true;
      statusEl.textContent = t('txImport.importing');
      try {
        // transaction.record inputs; the session appends the recorded rows
        // (the transactions array is not a display order). No status: a
        // missing one means posted.
        const rows = toImport.map(row => ({
          type: row.amount > 0 ? 'income' : 'expense',
          date: row.date,
          amount: Math.abs(row.amount),
          payee: row.payee || '',
          account: accountId,
          ...(row.envelopeId ? { envelope: row.envelopeId } : {}),
          ...(row.note ? { note: row.note } : {}),
        }));
        const added = await recordImportRows(session, rows, { expectedImportContext,
          ...(approvedStatement ? { expectedStatement: { account: accountId, context: approvedStatement.context } } : {}) });
        sheet.close();
        if (!added) return; // the budget it belonged to is no longer open
        toast(t('txImport.success')(added.length));
        await reportStatementBalance(toImport);
        await repaint();
      } catch (err) {
        if (err.code === 'import_review_changed' && restartStatementReview) { restartStatementReview(); return; }
        if (err.code === 'import_review_changed') { ruleReview.draft.refresh(state); renderRows(); }
        statusEl.textContent = `${t('txImport.importError')}: ${err.message}`;
        importBtn.disabled = ruleReview.draft.summary().unresolved > 0; backBtn.disabled = false; cancelBtn.disabled = false;
      }
    });

    function renderRows() {
      const views = new Map(ruleReview.draft.view().map(r=>[r.key,r]));
      for (const r of results) r.envelopeId = views.get(r.key).values.envelope || '';
      ruleReview.controls.refresh();
      tbody.innerHTML = '';
      let importCount = 0;
      for (const r of results) {
        if (!r.skip) importCount++;
        const row = buildRow(r);
        row.hidden = r.matchType === 'exact' && r.skip && !showRecorded;
        tbody.append(row);
      }
      importBtn.textContent = t('txImport.importBtn')(importCount);
      importBtn.disabled = importCount === 0 || ruleReview.draft.summary().unresolved > 0;
      if (importCount === 0 && results.length > 0) {
        statusEl.textContent = t('txImport.allDuplicates');
      } else {
        statusEl.textContent = '';
      }
    }

    function buildRow(r) {
      const { csvRow, match, matchType } = r;

      const BG = {
        exact:    'rgba(34,197,94,0.10)',
        possible: 'rgba(96,165,250,0.10)',
        none:     'transparent',
      };
      // Badge colours live in CSS (.import-match-badge--*) so the dark
      // theme can re-tone them.

      const showMatched = r.skip && match;
      // A possible match being imported keeps its blue mark: it is the row
      // the user may want to untick.
      const possibleIn = !r.skip && matchType === 'possible' && match;
      const bg = possibleIn ? BG.possible
        : !r.skip ? BG.none : (matchType === 'none' ? 'rgba(156,163,175,0.10)' : BG[matchType]);

      const tr = document.createElement('tr');
      tr.style.cssText = `background:${bg};cursor:pointer;border-bottom:1px solid var(--border);`;
      tr.addEventListener('click', () => { r.skip = !r.skip; ruleReview.draft.setExcluded(r.key,r.skip); renderRows(); });

      const mkTd = (style = '') => {
        const td = document.createElement('td');
        td.style.cssText = 'padding:6px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' + style;
        return td;
      };

      // Badge
      const badgeTd = mkTd();
      const badge = document.createElement('span');
      const badgeKey = possibleIn ? 'possible'
        : !r.skip ? 'none' : (matchType === 'none' ? 'skipped' : matchType);
      badge.className = `import-match-badge import-match-badge--${badgeKey}`;
      badge.style.cssText = 'display:inline-block;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px;text-transform:uppercase;letter-spacing:0.03em;';
      badge.textContent = t(`txImport.badge.${badgeKey}`);
      badgeTd.append(badge);
      tr.append(badgeTd);

      // CSV side
      const csvDateTd = mkTd('font-variant-numeric:tabular-nums;');
      csvDateTd.textContent = csvRow.date;
      tr.append(csvDateTd);

      const csvPayeeTd = mkTd();
      csvPayeeTd.textContent = csvRow.payee || '—';
      tr.append(csvPayeeTd);

      const csvAmtTd = mkTd(`text-align:right;font-variant-numeric:tabular-nums;color:${csvRow.amount < 0 ? 'var(--danger)' : 'var(--success,green)'};`);
      csvAmtTd.textContent = (csvRow.amount < 0 ? '−' : '+') + fmt(Math.abs(csvRow.amount));
      tr.append(csvAmtTd);

      // Arrow
      const arrowTd = mkTd('text-align:center;color:var(--muted);');
      arrowTd.textContent = showMatched ? '→' : '';
      tr.append(arrowTd);

      // Budget side; a row to import shows its envelope there instead.
      if (!r.skip) {
        const envTd = mkTd('overflow:visible;white-space:normal;');
        envTd.colSpan = 3;
        envTd.append(envelopePicker(r), ruleReview.controls.renderRow(r.key));
        if (possibleIn) {
          // The existing row it may duplicate, under the envelope it lands in.
          const maybe = document.createElement('div');
          maybe.className = 'import-possible-of';
          maybe.style.cssText = 'font-size:11px;color:var(--muted);margin-top:3px;';
          maybe.textContent = t('txImport.possibleOf')(match.date, match.payee || '—');
          envTd.append(maybe);
        }
        envTd.addEventListener('click', (e) => e.stopPropagation());
        tr.append(envTd);
      } else if (showMatched) {
        const mDateTd = mkTd('color:var(--muted);font-variant-numeric:tabular-nums;font-size:12px;');
        mDateTd.textContent = match.date;
        tr.append(mDateTd);
        const mPayeeTd = mkTd('color:var(--muted);font-size:12px;');
        mPayeeTd.textContent = match.payee || '—';
        tr.append(mPayeeTd);
        const mAmtTd = mkTd('text-align:right;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;');
        mAmtTd.textContent = fmt(Math.abs(Number(match.amount)));
        tr.append(mAmtTd);
      } else {
        tr.append(mkTd(), mkTd(), mkTd());
      }

      // Toggle button
      const btnTd = mkTd('text-align:right;');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost';
      btn.style.cssText = 'font-size:11px;padding:2px 8px;';
      btn.textContent = !r.skip ? t('txImport.rowSkip') : (matchType === 'none' ? t('txImport.rowInclude') : t('txImport.rowImport'));
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        r.skip = !r.skip;
        ruleReview.draft.setExcluded(r.key,r.skip);
        renderRows();
      });
      btnTd.append(btn);
      tr.append(btnTd);

      return tr;
    }

    // The envelope a new row lands in: a searchable picker (like the add
    // form's), defaulting to the payee's history. Income may go to an
    // envelope too, as in the add form.
    function envelopePicker(r) {
      const sel = document.createElement('select');
      sel.className = 'form-input import-env';
      sel.setAttribute('aria-label', t('txImport.envelopeCol'));
      const none = document.createElement('option');
      none.value = ''; none.textContent = t('common.unassigned');
      sel.append(none);
      for (const e of envelopes) {
        const o = document.createElement('option');
        o.value = e.id; o.textContent = trEnv(e);
        sel.append(o);
      }
      sel.value = r.envelopeId || '';
      const box = document.createElement('div');
      box.className = 'import-env-cell';
      if (r.suggested) box.title = t('txImport.envelopeFromHistory');
      box.append(sel);
      enhanceSelectWithSearch(sel, { placeholder: t('common.unassigned'), noMatch: t('addTx.envelopeNoMatch') });
      // The app's input look (sunken, no border), compact for a table row.
      box.querySelector('.combo > input')?.classList.add('form-input');
      sel.addEventListener('change', () => { r.envelopeId = sel.value; r.suggested = false; box.title = ''; ruleReview.draft.edit(r.key,'envelope',sel.value || null); renderRows(); });
      return box;
    }

    renderRows();
  }

  // ── Phase 1 preview helper ────────────────────────────────────────────────

  // A wide table scrolls sideways in its own box on a narrow screen, with the
  // scroll cue (js/ui/scroll-cue.js) fading the edge that hides more.
  function scrollBox(tbl, className) {
    const box = document.createElement('div');
    box.className = className;
    box.style.cssText = 'overflow-x:auto;';
    box.setAttribute('data-scroll-cue', '');
    box.append(tbl);
    return box;
  }

  function buildPreviewTbl(rows) {
    const tbl = document.createElement('table');
    tbl.style.cssText = 'width:100%;border-collapse:collapse;font-size:13px;';
    const thead = document.createElement('thead');
    const hRow = document.createElement('tr');
    [t('txImport.previewDate'), t('txImport.previewPayee'), t('txImport.previewAmount')].forEach(h => {
      const th = document.createElement('th');
      th.style.cssText = 'text-align:left;padding:3px 6px;border-bottom:1px solid var(--border);font-size:11px;color:var(--muted);';
      th.textContent = h;
      hRow.append(th);
    });
    thead.append(hRow);
    tbl.append(thead);
    const tbody = document.createElement('tbody');
    for (const r of rows) {
      const tr = document.createElement('tr');
      [r.date, r.payee || '—', fmt(Math.abs(r.amount))].forEach((v, i) => {
        const td = document.createElement('td');
        td.style.cssText = 'padding:4px 6px;border-bottom:1px solid var(--border);';
        // The payee keeps a readable width; the date and the amount don't wrap.
        if (i === 1) td.style.minWidth = '140px';
        else td.style.whiteSpace = 'nowrap';
        if (i === 2) {
          td.style.textAlign = 'right';
          td.style.fontVariantNumeric = 'tabular-nums';
          td.style.color = r.amount < 0 ? 'var(--danger)' : 'var(--success,green)';
        }
        td.textContent = v;
        tr.append(td);
      });
      tbody.append(tr);
    }
    tbl.append(tbody);
    return scrollBox(tbl, 'import-preview-scroll');
  }

  showPhase1();
  if (initialFile) handleFile(initialFile).catch(err => alertDialog(`${t('txImport.importError')}: ${err.message}`));
}

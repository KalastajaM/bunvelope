import { setupFormValidation } from '../ui/form-validation.js';
import { spendingProfileFields } from '../ui/spending-profile.js';
import { disclosure } from '../ui/planning-workspace.js';
// js/pages/envelope-edit.js
import { state, navigate, updateStatusBar, session, now as appNow } from '../app.js';
import { futureRowsTouching } from '../engine.js';
import { openSheet } from '../ui/sheet.js';
import { confirmDialog } from '../ui/dialog.js';
import { trackDirty } from '../ui/dirty-guard.js';
import { guardSubmit } from '../ui/submit-guard.js';
import { attachFieldHint, setFieldHint } from '../ui/field-hint.js';
import { toast } from '../ui/toast.js';
import { reportDispatchFailure, reportMetaFailure, dispatchOrReport as dispatchOrReportVia } from '../ui/save-error.js';
import { undoAction } from '../ui/undo-action.js';
import { t } from '../ui/i18n.js';
import { fmtNum } from '../utils.js';
import { withBusy } from '../ui/busy.js';
import { enableFormulaInput, parseAmountInput } from '../ui/amount-input.js';
import { envelopeRefs } from '../core/entity-fields.js';

/** One command through the session; the ok result, or null after telling the user why not. */
const dispatchOrReport = (name, input) => dispatchOrReportVia(session, name, input);

let _fieldSeq = 0;
function field(label, input) {
  const wrap = document.createElement('div'); wrap.className = 'field';
  const lbl = document.createElement('label'); lbl.textContent = label;
  if (!input.id) input.id = `env-f-${++_fieldSeq}`;
  lbl.htmlFor = input.id;
  wrap.append(lbl, input);
  return wrap;
}

export function openEnvelopeEdit(envelopeOrNull) {
  const isNew = !envelopeOrNull;
  const env = envelopeOrNull || { id: null, name: '', category: '', description: '', archived: false };

  const form = document.createElement('form');

  const nameIn = document.createElement('input');
  nameIn.type = 'text'; nameIn.name = 'name'; nameIn.value = env.name || '';
  nameIn.required = true;

  const nameField = field(t('envelopes.name'), nameIn);
  attachFieldHint(nameField, nameIn);
  nameIn.addEventListener('input', () => setFieldHint(nameField, ''));

  const codeIn = document.createElement('input');
  codeIn.type = 'text'; codeIn.name = 'code'; codeIn.value = env.code || '';
  codeIn.maxLength = 4; codeIn.pattern = '[A-Za-z0-9]{4}';
  codeIn.placeholder = t('coreError.shortCodeAuto');
  const codeField = field(t('coreError.shortCode'), codeIn);
  attachFieldHint(codeField, codeIn);
  const codeHelp = document.createElement('p');
  codeHelp.className = 'muted money-field-help';
  codeHelp.id = codeIn.getAttribute('aria-describedby') + '-usage';
  codeHelp.textContent = t('coreError.shortCodeChatHint');
  codeField.append(codeHelp);
  codeIn.setAttribute('aria-describedby', codeIn.getAttribute('aria-describedby') + ' ' + codeHelp.id);
  codeIn.addEventListener('input', () => setFieldHint(codeField, ''));


  const catIn = document.createElement('input');
  catIn.type = 'text'; catIn.name = 'category'; catIn.value = env.category || '';
  catIn.setAttribute('list', 'env-cat-list');
  const datalist = document.createElement('datalist'); datalist.id = 'env-cat-list';
  const cats = [...new Set(state.envelopes.map(e => e.category).filter(Boolean))].sort();
  cats.forEach(c => { const o = document.createElement('option'); o.value = c; datalist.append(o); });

  const descIn = document.createElement('textarea');
  descIn.name = 'description'; descIn.rows = 2; descIn.value = env.description || '';

  // Optional savings goal: target balance + (optional) date the user wants
  // to hit it by. Stored on the envelope; computation happens in engine.js.
  const goalAmtIn = document.createElement('input');
  goalAmtIn.type = 'number'; goalAmtIn.step = '0.01'; goalAmtIn.min = '0';
  goalAmtIn.placeholder = fmtNum(0, { decimals: 2 });
  goalAmtIn.value = env.goal_amount != null ? String(env.goal_amount) : '';
  enableFormulaInput(goalAmtIn);

  const goalDateIn = document.createElement('input');
  goalDateIn.type = 'date';
  goalDateIn.value = env.goal_date || '';

  const goalAmtField = field(t('envelopes.goalAmount'), goalAmtIn);
  attachFieldHint(goalAmtField, goalAmtIn);
  goalAmtIn.addEventListener('input', () => setFieldHint(goalAmtField, ''));

  const goalRow = document.createElement('div');
  goalRow.className = 'field-row';
  goalRow.append(goalAmtField, field(t('envelopes.goalDate'), goalDateIn));

  // Rollover policy (per-envelope). Default is 'carry' — the existing
  // behaviour: balance carries over unchanged each month.
  const rolloverIn = document.createElement('select');
  for (const [val, lbl] of [
    ['carry', t('envelopes.rolloverCarry')],
    ['cover-from-unallocated', t('envelopes.rolloverCover')],
    ['zero-monthly', t('envelopes.rolloverZero')],
  ]) {
    const o = document.createElement('option');
    o.value = val; o.textContent = lbl;
    if ((env.rollover || 'carry') === val) o.selected = true;
    rolloverIn.append(o);
  }

  // §4.3 — exempt this envelope from the Monthly Review's over/under spend
  // flag. Replaces a hardcoded `category === 'Return'` test in
  // monthly-review.js: a display string, in one language, driving money
  // logic. Left undefined on existing envelopes, where the legacy category
  // still applies, so nothing changes until the owner touches the envelope.
  const exemptIn = document.createElement('input');
  exemptIn.type = 'checkbox';
  exemptIn.checked = env.spend_flag_exempt === true
    || (env.spend_flag_exempt === undefined && (env.category || '') === 'Return');

  const exemptLabel = document.createElement('label');
  exemptLabel.style.cssText = 'display:flex;gap:8px;align-items:center;cursor:pointer;';
  const exemptText = document.createElement('span');
  exemptText.textContent = t('envelopes.spendFlagExempt');
  exemptLabel.append(exemptIn, exemptText);

  const exemptHint = document.createElement('div');
  exemptHint.className = 'muted';
  exemptHint.style.cssText = 'font-size:12px;margin-top:4px;';
  exemptHint.textContent = t('envelopes.spendFlagExemptHint');

  const exemptWrap = document.createElement('div');
  exemptWrap.append(exemptLabel, exemptHint);

  const spendingProfile = spendingProfileFields(env, field);
  form.append(
    nameField,
    field(t('envelopes.category'), catIn),
    datalist,
    field(t('envelopes.description'), descIn),
    codeField,
    disclosure(t('moneyWorkspace.goal'), [goalRow], !!env.goal_amount),
    spendingProfile.element,
    disclosure(t('workspace.advanced'), [field(t('envelopes.rolloverLabel'), rolloverIn), exemptWrap]),
  );

  const footer = document.createElement('div');
  footer.dataset.sheetActions = '';
  footer.style.cssText = 'display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:8px;flex-wrap:wrap;';

  const leftGroup = document.createElement('div');
  leftGroup.style.cssText = 'display:flex;gap:8px;';
  let deleteNote = null;
  if (!isNew) {
    const archiveBtn = document.createElement('button');
    archiveBtn.type = 'button';
    archiveBtn.className = 'btn btn-ghost';
    archiveBtn.textContent = env.archived ? t('envelopes.unarchive') : t('envelopes.archive');
    archiveBtn.addEventListener('click', async () => {
      // Archiving hides the envelope, not its future rows: they still post
      // into it. Say so before archiving (the status badge keeps reporting
      // them afterwards).
      if (!env.archived) {
        const futureRows = futureRowsTouching({
          transactions: state.transactions, today: appNow(), envelopeIds: [env.id],
        }).length;
        if (futureRows > 0) {
          const ok = await confirmDialog(t('common.futureRowsArchiveWarning')(futureRows), {
            title: t('envelopes.archive'), okLabel: t('envelopes.archive'),
          });
          if (!ok) return;
        }
      }
      const r = await dispatchOrReport('envelope.archive', { id: env.id, archived: !env.archived });
      if (!r) return;
      updateStatusBar();
      close();
      navigate('envelopes');
      toast(env.archived ? t('common.unarchivedToast')(env.name) : t('common.archivedToast')(env.name), {
        action: undoAction(r.value.undo, 'envelopes'),
      });
    });
    leftGroup.append(archiveBtn);

    if ((state.budgetItems || []).some(b => b.envelope_id === env.id)) {
      const viewPlan = document.createElement('button');
      viewPlan.type = 'button';
      viewPlan.className = 'btn btn-ghost';
      viewPlan.textContent = t('envelopes.viewInBudgetPlan');
      viewPlan.addEventListener('click', () => {
        close();
        navigate('budget-plan', { envelopeId: env.id });
      });
      leftGroup.append(viewPlan);
    }

    // Delete is for an envelope nothing uses. One that is used shows it
    // disabled, with a note saying what uses it and what to do instead.
    const refs = envelopeRefs(state, env.id);
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-ghost';
    deleteBtn.style.color = 'var(--danger)';
    deleteBtn.textContent = t('envelopes.delete');
    leftGroup.append(deleteBtn);
    if (refs.transactions + refs.budgetItems + refs.envelopeTemplates > 0) {
      deleteBtn.disabled = true;
      deleteNote = document.createElement('p');
      deleteNote.className = 'muted';
      deleteNote.id = `env-delete-note-${++_fieldSeq}`;
      deleteNote.style.cssText = 'font-size:12px;margin:8px 0 0;';
      const parts = [
        refs.transactions && t('envelopes.refsTransactions')(refs.transactions),
        refs.budgetItems && t('envelopes.refsPlanItems')(refs.budgetItems),
        refs.envelopeTemplates && t('envelopes.refsTemplateLines')(refs.envelopeTemplates),
      ].filter(Boolean);
      deleteNote.textContent = t('envelopes.deleteBlocked')(parts.join(', '));
      deleteBtn.setAttribute('aria-describedby', deleteNote.id);
      deleteBtn.title = deleteNote.textContent;
    } else {
      deleteBtn.addEventListener('click', async () => {
        const ok = await confirmDialog(t('envelopes.deleteConfirm')(env.name), { title: t('envelopes.delete'), danger: true, okLabel: t('envelopes.delete') });
        if (!ok) return;
        // in_use cannot normally happen (the button is enabled at zero refs);
        // if the budget changed underneath, the refusal is reported as is.
        const r = await dispatchOrReport('envelope.delete', { id: env.id });
        if (!r) return;
        updateStatusBar();
        close();
        navigate('envelopes');
        toast(t('envelopes.deleted'), { action: undoAction(r.value.undo, 'envelopes') });
      });
    }
  }

  const rightGroup = document.createElement('div');
  rightGroup.style.cssText = 'display:flex;gap:8px;margin-left:auto;';
  const cancel = document.createElement('button');
  cancel.type = 'button'; cancel.className = 'btn btn-ghost';
  cancel.textContent = t('addTx.cancel');
  const save = document.createElement('button');
  save.type = 'submit'; save.className = 'btn btn-accent';
  save.textContent = t('addTx.save');
  rightGroup.append(cancel, save);

  footer.append(leftGroup, rightGroup);
  form.append(footer);
  if (deleteNote) form.append(deleteNote);

  const tracker = trackDirty(form);
  const { close, requestClose } = openSheet({
    title: isNew ? t('envelopes.newTitle') : t('envelopes.editTitle'),
    content: form,
    confirmClose: tracker.confirmClose,
  });
  cancel.addEventListener('click', requestClose);

  setupFormValidation(form);

  form.addEventListener('submit', guardSubmit(async (e) => {
    e.preventDefault();
    const name = nameIn.value.trim();
    if (!name) return;
    const category = catIn.value.trim();
    const description = descIn.value.trim();
    const goalAmtRaw = parseAmountInput(goalAmtIn.value, { strict: true });
    const goalAmount = Number.isFinite(goalAmtRaw) && goalAmtRaw > 0 ? Math.round(goalAmtRaw * 100) / 100 : null;
    // A typed-but-invalid goal must not be silently dropped on save.
    if (goalAmtIn.value.trim() !== '' && goalAmount === null) {
      goalAmtField.closest('details').open = true;
      setFieldHint(goalAmtField, t('common.amountInvalid'));
      goalAmtIn.focus();
      return;
    }
    const goalDate = goalDateIn.value && /^\d{4}-\d{2}-\d{2}$/.test(goalDateIn.value) ? goalDateIn.value : null;

    const rollover = ['carry', 'cover-from-unallocated', 'zero-monthly'].includes(rolloverIn.value)
      ? rolloverIn.value
      : 'carry';

    // The form's values; null clears a goal field. The command stores them
    // (rounding the amount, dropping a default rollover) and stamps goal_start
    // once a goal has both an amount and a date. The explicit exemption flag
    // stops the legacy category-name fallback in monthly-review.js applying,
    // so renaming the category can no longer change the envelope's flagging.
    const fields = {
      code: codeIn.value.trim(),
      name, category, description,
      goal_amount: goalAmount, goal_date: goalDate,
      rollover,
      spend_flag_exempt: exemptIn.checked,
      ...spendingProfile.fields(),
    };
    let r;
    try {
      r = await withBusy(save, () => (isNew
        ? session.dispatch('envelope.create', fields)
        : session.dispatch('envelope.update', { id: env.id, fields })), { label: t('common.saving') });
    } catch (err) {
      console.error(err);
      toast(t('common.saveFailed')(err?.message || err), { assertive: true });
      return;
    }
    if (!r.ok) {
      if (['code_taken', 'code_invalid', 'code_exhausted'].includes(r.error.code)) {
        const key = { code_taken: 'codeTaken', code_invalid: 'codeInvalid', code_exhausted: 'codeExhausted' }[r.error.code];
        setFieldHint(codeField, t(`coreError.${key}`));
        codeIn.focus();
        return;
      }
      // A taken name belongs on the name field, not in a toast.
      if (r.error.code === 'name_taken') {
        setFieldHint(nameField, t('envelopes.nameTaken')(r.error.params?.name ?? name));
        nameIn.focus();
        return;
      }
      reportDispatchFailure(r.error);
      return;
    }
    reportMetaFailure(r);
    updateStatusBar();
    close();
    navigate('envelopes');
  }));
}

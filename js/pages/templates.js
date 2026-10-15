import { addPageHelp } from '../ui/info-button.js';
import { templatePreview } from './template-preview.js';
import { currentBudgetSession } from '../state/budget-session.js';
import { node, disclosure } from '../ui/planning-workspace.js';
// js/pages/templates.js — Envelope templates list + CRUD + apply-to-pool
// It writes through the session: template.create / update / delete, and
// allocation.fill for "Apply to pool".
import { state, session, runDueScheduled, updateStatusBar, now as appNow } from '../app.js';
import { openSheet } from '../ui/sheet.js';
import { confirmDialog, alertDialog } from '../ui/dialog.js';
import { trackDirty } from '../ui/dirty-guard.js';
import { guardSubmit } from '../ui/submit-guard.js';
import { withBusy } from '../ui/busy.js';
import { toast } from '../ui/toast.js';
import { dispatchOrReport, reportDispatchFailure, reportMetaFailure } from '../ui/save-error.js';
import { attachFieldHint, setFieldHint } from '../ui/field-hint.js';
import { undoAction } from '../ui/undo-action.js';
import { t, trEnv, fmtDateLang } from '../ui/i18n.js';
import { escHtml, fmt } from '../utils.js';
import { envelopeOptionsHtml as groupedEnvelopeOptionsHtml } from '../ui/envelope-options.js';
import { enhanceSelectWithSearch } from '../ui/select-combobox.js';
import { isoDate } from '../core/context.js';
import { ask } from '../ui/query.js';
import { isAiFeatureEnabled, aiInsights } from '../ai/client.js';
import { renderAiCard, withAiState } from '../ai/render.js';
import { formatAiText } from '../ai/money-text.js';
import { dismissSubscription } from '../ai/consent.js';
import { navigate } from '../app.js';
import { icon } from '../ui/icon.js';
import { enableFormulaInput, parseAmountInput } from '../ui/amount-input.js';
import { QUARTERS } from './budget-plan-cells.js';

function isDynamic(tpl) {
  return tpl && tpl.kind === 'dynamic';
}

export async function render(container) {
  const focus = state.pendingFilter;
  state.pendingFilter = null;
  const page = document.createElement('div');
  page.className = 'page';

  const stickyTop = document.createElement('div');
  stickyTop.className = 'page-sticky-top-wrap';
  page.append(stickyTop);

  const head = document.createElement('div');
  head.className = 'page-head';
  const left = document.createElement('div');
  const h1 = document.createElement('h1'); h1.textContent = t('nav.templates');
  addPageHelp(h1, 'templatesPage.intro', { detailKeys: ['tour.steps.templates.body'], guide: 'planning' });
  left.append(h1);
  head.append(left);

  const newBtn = document.createElement('button');
  newBtn.className = 'btn btn-accent';
  newBtn.textContent = t('templatesPage.newBtn');
  newBtn.addEventListener('click', () => openKindChooser());
  head.append(newBtn);
  stickyTop.append(head);

  const filters = node('div', 'filters');
  const search = node('input'); search.type = 'search';
  search.placeholder = t('moneyWorkspace.searchTemplates'); search.setAttribute('aria-label', search.placeholder);
  const scheduleFilter = node('select'); scheduleFilter.setAttribute('aria-label', t('workspace.views'));
  for (const [value,key] of [['all','all'],['scheduled','scheduled'],['manual','manual']]) {
    const option = node('option','',t(value === 'all' ? 'workspace.all' : 'moneyWorkspace.' + key)); option.value = value; scheduleFilter.append(option);
  }
  const searchWrap = node('div', 'search');
  searchWrap.append(icon('search', 16), search);
  filters.append(searchWrap, scheduleFilter); stickyTop.append(filters);
  if (isAiFeatureEnabled('subscription')) page.append(buildAiSubscriptionCard());
  search.addEventListener('input', () => repaint()); scheduleFilter.addEventListener('change', () => repaint());
  const listHost = document.createElement('div');
  page.append(listHost);

  function repaint() {
    const templates = (state.envelopeTemplates || []).filter(tpl =>
      (!search.value || (tpl.name + ' ' + (tpl.description || '')).toLowerCase().includes(search.value.toLowerCase())) &&
      (scheduleFilter.value === 'all' || (tpl.schedule?.enabled === true) === (scheduleFilter.value === 'scheduled')));

    listHost.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'env-grid';

    const answer = ask('templates.summary', { date: isoDate(appNow()) });
    const summaryById = new Map((answer?.templates || []).map(row => [row.id, row]));

    if (templates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tpl-empty';
      empty.textContent = (state.envelopeTemplates || []).length ? t('common.noResults') : t('templatesPage.empty');
      grid.append(empty);
    } else {
      templates.forEach(tpl => {
        const card = document.createElement('div');
        card.className = 'tpl-card';

        const nameRow = document.createElement('div');
        nameRow.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
        const name = document.createElement('div');
        name.className = 'tpl-name';
        name.textContent = tpl.name || tpl.id;
        nameRow.append(name);
        if (isDynamic(tpl)) {
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.textContent = t('templatesPage.dynamicChip');
          chip.title = t('templatesPage.dynamicChipHint');
          nameRow.append(chip);
        }
        if (tpl.schedule?.enabled === true) {
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.textContent = t('templatesPage.scheduleChip')(tpl.schedule.payment_day);
          chip.title = t('templatesPage.scheduleEnable');
          nameRow.append(chip);
        }

        const meta = document.createElement('div');
        meta.className = 'tpl-meta';
        const summary = summaryById.get(tpl.id);
        if (summary) meta.textContent = t('templatesPage.linesMeta')(summary.lineCount, fmt(summary.total));
        const next = summary?.nextPending?.date;
        const nextEl = document.createElement('div');
        nextEl.className = 'tpl-meta';
        if (next) nextEl.textContent = t('templatesPage.nextRun')(fmtDateLang(next));

        const actions = document.createElement('div');
        actions.className = 'tpl-actions';

        // Icon plus a word: the two icons alone did not say what they do.
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-ghost btn-sm';
        editBtn.title = t('templatesPage.editTitle');
        editBtn.append(icon('pencil', 16), document.createTextNode(t('templatesPage.editShort')));
        editBtn.addEventListener('click', () => openTemplateSheet(tpl));

        const applyBtn = document.createElement('button');
        applyBtn.className = 'btn btn-ghost btn-sm';
        applyBtn.disabled = !summary;
        applyBtn.title = t('templatesPage.applyToPoolTitle');
        applyBtn.append(icon('send', 16), document.createTextNode(t('templatesPage.applyShort')));
        applyBtn.addEventListener('click', () => openApplyToPoolSheet(tpl));

        actions.append(editBtn, applyBtn);
        const source = tpl.schedule?.enabled ? state.envelopes.find(e => e.id === tpl.schedule.source_envelope_id) : null;
        card.append(nameRow, meta, node('p','tpl-meta',t(tpl.schedule?.enabled ? 'workspace.scheduledSource' : 'workspace.drawsFrom') + ': ' + (source ? trEnv(source) : t('nav.unallocated')) + (tpl.schedule?.enabled && tpl.schedule?.source_since ? ' · ' + tpl.schedule.source_since : '')));
        if (next) card.append(nextEl);
        card.append(actions);
        grid.append(card);
      });
    }

    listHost.append(grid);
  }

  // Grouped by category in the Envelopes page's order, as the transaction
  // sheets offer them; an archived envelope only when the line already names it.
  function envelopeOptionsHtml(selectedId) {
    const envs = (state.envelopes || []).filter(e => !e.archived || e.id === selectedId);
    return `<option value="">${escHtml(t('templatesPage.chooseEnvelope'))}</option>`
      + groupedEnvelopeOptionsHtml(envs, e => trEnv(e) || e.id, selectedId);
  }

  // The searchable envelope picker every other sheet uses. Called once the
  // select is in its row: the combobox wrapper takes the select's place and
  // its flex sizing.
  function enhanceEnvelopeSelect(envSel) {
    const flex = envSel.style.cssText;
    enhanceSelectWithSearch(envSel, { placeholder: t('addTx.envelopeSearchPh'), noMatch: t('addTx.envelopeNoMatch') });
    envSel.style.cssText = '';
    envSel.parentElement.style.cssText = flex;
  }

  // Hide envelope options that are already picked by *other* rows in the
  // editor, so each envelope can only be assigned once per template.
  function refreshEnvOptionDisabled(host) {
    const selects = host.querySelectorAll('.split-env');
    const allSelected = [...selects].map(s => s.value).filter(Boolean);
    selects.forEach(sel => {
      const kept = sel.value;
      const taken = new Set(allSelected);
      taken.delete(kept);
      [...sel.options].forEach(opt => {
        const hide = !!opt.value && taken.has(opt.value);
        opt.hidden = hide;
        opt.disabled = hide;
      });
    });
  }

  function field(labelText, input) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const l = document.createElement('label');
    l.textContent = labelText;
    if (!input.id) input.id = `tpl-f-${Math.random().toString(36).slice(2, 8)}`;
    l.htmlFor = input.id;
    wrap.append(l, input);
    return wrap;
  }

  // The name field, with the hint a taken name is shown in; typing clears it.
  function nameFieldWithHint(nameIn) {
    const nameField = field(t('templatesPage.nameLabel'), nameIn);
    attachFieldHint(nameField, nameIn);
    nameIn.addEventListener('input', () => setFieldHint(nameField, ''));
    return nameField;
  }

  // ── Kind chooser (manual vs dynamic) ─────────────────────────────────────
  function openKindChooser() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

    const intro = document.createElement('p');
    intro.className = 'muted';
    intro.style.cssText = 'margin:0 0 6px;font-size:13px;';
    intro.textContent = t('templatesPage.chooseTypeIntro');
    wrap.append(intro);

    function kindBtn(title, desc, onPick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tpl-kind-card';
      const h = document.createElement('div');
      h.className = 'tpl-kind-title';
      h.textContent = title;
      const d = document.createElement('div');
      d.className = 'muted tpl-kind-desc';
      d.textContent = desc;
      btn.append(h, d);
      btn.addEventListener('click', onPick);
      return btn;
    }

    const { close } = openSheet({ title: t('templatesPage.newTitle'), content: wrap });

    wrap.append(
      kindBtn(
        t('templatesPage.kindManual'),
        t('templatesPage.kindManualBody'),
        () => { close(); openTemplateSheet(null, 'manual'); },
      ),
      kindBtn(
        t('templatesPage.kindDynamic'),
        t('templatesPage.kindDynamicBody'),
        () => { close(); openTemplateSheet(null, 'dynamic'); },
      ),
    );
  }

  // ── Template edit sheet (dispatches on kind) ─────────────────────────────
  async function openTemplateSheet(existing, newKind) {
    const kind = existing ? (existing.kind === 'dynamic' ? 'dynamic' : 'manual') : (newKind || 'manual');
    if (kind === 'dynamic') return openDynamicTemplateSheet(existing);
    return openManualTemplateSheet(existing);
  }

  // ── Manual template editor (original flow) ───────────────────────────────
  async function openManualTemplateSheet(existing) {
    const isNew = !existing;
    const tpl = isNew
      ? { id: '', name: '', description: '', kind: 'manual', lines: [] }
      : { ...existing, kind: 'manual', lines: (existing.lines || []).map(l => ({ ...l })) };

    const form = document.createElement('form');

    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.required = true;
    nameIn.value = tpl.name || '';
    nameIn.placeholder = t('templatesPage.nameStaticPlaceholder');

    const descIn = document.createElement('input');
    descIn.type = 'text';
    descIn.value = tpl.description || '';
    descIn.placeholder = t('templatesPage.descPlaceholder');

    const nameField = nameFieldWithHint(nameIn);
    form.append(nameField, field(t('templatesPage.descriptionLabel'), descIn));

    // ── Lines editor (mirrors add-tx split-row styling) ─────────────────────
    const linesWrap = document.createElement('div');
    linesWrap.className = 'field';
    const linesLbl = document.createElement('label');
    linesLbl.textContent = t('templatesPage.linesLabel');
    const linesHost = document.createElement('div');
    linesHost.style.cssText = 'display:flex;flex-direction:column;gap:6px;width:100%;';
    const linesFooter = document.createElement('div');
    linesFooter.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:12px;';
    const addLineBtn = document.createElement('button');
    addLineBtn.type = 'button';
    addLineBtn.className = 'btn btn-ghost';
    addLineBtn.style.cssText = 'padding:4px 10px;font-size:12px;';
    addLineBtn.textContent = t('templatesPage.addLine');
    const addTotalEl = document.createElement('div');
    addTotalEl.className = 'muted';
    linesFooter.append(addLineBtn, addTotalEl);
    linesWrap.append(linesLbl, linesHost, linesFooter);

    function updateLineRowVisibility() {
      const rows = linesHost.querySelectorAll('.split-row');
      rows.forEach(r => {
        const rm = r.querySelector('.line-rm');
        if (rm) rm.style.visibility = rows.length > 1 ? 'visible' : 'hidden';
      });
      refreshEnvOptionDisabled(linesHost);
      let sum = 0;
      linesHost.querySelectorAll('.split-row').forEach(r => {
        const val = parseAmountInput(r.querySelector('.split-amt').value) || 0;
        sum += Math.abs(val);
      });
      addTotalEl.textContent = t('templatesPage.totalLabel')(fmt(sum));
    }

    function addLineRow(line = { envelope_id: '', mode: 'add', amount: '' }) {
      const row = document.createElement('div');
      row.className = 'split-row';
      row.style.cssText = 'display:flex;gap:6px;align-items:center;width:100%;';

      const envSel = document.createElement('select');
      envSel.className = 'split-env';
      envSel.style.cssText = 'flex:1 1 0;min-width:0;';
      envSel.innerHTML = envelopeOptionsHtml(line.envelope_id);

      const modeSel = document.createElement('select');
      modeSel.className = 'line-mode';
      modeSel.style.cssText = 'flex:0 0 84px;min-width:0;';
      [['add', t('templatesPage.modeAdd')], ['set', t('templatesPage.modeSetTo')]].forEach(([v, lbl]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = lbl;
        if (v === line.mode) o.selected = true;
        modeSel.append(o);
      });

      const amtIn = document.createElement('input');
      amtIn.type = 'number';
      amtIn.step = '0.01';
      amtIn.min = '0';
      amtIn.className = 'split-amt';
      amtIn.placeholder = t('templatesPage.amountPlaceholder');
      amtIn.style.cssText = 'flex:0 0 96px;min-width:0;';
      if (line.amount !== '' && line.amount != null) {
        amtIn.value = Math.abs(Number(line.amount) || 0);
      }
      enableFormulaInput(amtIn);

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn btn-ghost line-rm';
      rmBtn.style.cssText = 'padding:4px 10px;color:var(--danger-text);';
      rmBtn.textContent = '×';
      rmBtn.addEventListener('click', () => { row.remove(); updateLineRowVisibility(); });

      const handle = document.createElement('span');
      handle.className = 'drag-handle';
      handle.textContent = '⠿';
      handle.title = t('templatesPage.dragToReorder');
      // Keyboard alternative to the drag: the handle is the reorder
      // affordance, so it is the thing that takes focus. Alt+Arrow rather
      // than plain Arrow because the row's own selects use the arrow keys.
      handle.tabIndex = 0;
      handle.setAttribute('role', 'button');
      handle.setAttribute('aria-label', t('templatesPage.dragToReorder'));
      handle.addEventListener('keydown', (e) => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        const sibling = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
        if (!sibling) return;
        if (e.key === 'ArrowUp') sibling.before(row); else sibling.after(row);
        updateLineRowVisibility();
        handle.focus();
      });

      row.draggable = true;
      row.addEventListener('dragstart', e => {
        e.dataTransfer.effectAllowed = 'move';
        row.dataset.dragging = '1';
      });
      row.addEventListener('dragend', () => {
        delete row.dataset.dragging;
        linesHost.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', e => {
        if (!linesHost.querySelector('[data-dragging]')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        linesHost.querySelectorAll('.split-row').forEach(r => r.classList.remove('drag-over'));
        row.classList.add('drag-over');
      });
      row.addEventListener('drop', e => {
        e.preventDefault();
        const src = linesHost.querySelector('[data-dragging]');
        if (src && src !== row) {
          const rows = [...linesHost.children];
          const srcIdx = rows.indexOf(src);
          const tgtIdx = rows.indexOf(row);
          if (srcIdx < tgtIdx) row.after(src); else row.before(src);
          updateLineRowVisibility();
        }
        row.classList.remove('drag-over');
      });

      row.append(handle, envSel, modeSel, amtIn, rmBtn);
      enhanceEnvelopeSelect(envSel);
      row._getLine = () => ({
        envelope_id: envSel.value,
        mode: modeSel.value === 'set' ? 'set' : 'add',
        amount: Math.abs(parseAmountInput(amtIn.value) || 0),
      });
      amtIn.addEventListener('input', updateLineRowVisibility);
      modeSel.addEventListener('change', updateLineRowVisibility);
      envSel.addEventListener('change', updateLineRowVisibility);
      linesHost.append(row);
    }

    if (tpl.lines.length === 0) addLineRow();
    else tpl.lines.forEach(l => addLineRow(l));

    addLineBtn.addEventListener('click', () => { addLineRow(); updateLineRowVisibility(); });
    updateLineRowVisibility();

    form.append(linesWrap);

    const schedule = buildScheduleSection(tpl);
    form.insertBefore(node('p', 'muted', t('workspace.templateModes')), form.children[2] || null);
    form.insertBefore(disclosure(t('workspace.schedule'), [schedule.wrap], true), form.children[2] || null);

    const footer = buildEditorActions(!existing);
    const tracker = trackDirty(form);
    const { close, requestClose } = openSheet({
      title: existing ? t('templatesPage.editEnvelopeTitle') : t('templatesPage.newEnvelopeTitle'),
      content: form,
      headerActions: [footer.delBtn, footer.cancelBtn, footer.saveBtn].filter(Boolean),
      confirmClose: tracker.confirmClose,
    });

    footer.cancelBtn.addEventListener('click', requestClose);

    if (footer.delBtn) {
      footer.delBtn.addEventListener('click', () => handleDelete(tpl, close));
    }

    form.addEventListener('submit', guardSubmit(async e => {
      e.preventDefault();
      const name = nameIn.value.trim();
      if (!name) { await alertDialog(t('templatesPage.nameRequired')); return; }
      const rowEls = [...linesHost.children];
      const lines = rowEls.map(r => r._getLine())
        .filter(l => l.envelope_id && l.amount > 0);
      if (lines.length === 0) { await alertDialog(t('templatesPage.needLine')); return; }

      const seenEnv = new Set();
      for (const l of lines) {
        if (seenEnv.has(l.envelope_id)) {
          await alertDialog(t('templatesPage.envelopeOnce'));
          return;
        }
        seenEnv.add(l.envelope_id);
      }

      const sched = schedule.getSchedule({
        targetEnvelopeIds: lines.map(l => l.envelope_id),
      });
      if (sched && sched.error) { await alertDialog(t(sched.error)); return; }

      // Only this kind's list: the command refuses the other one, even empty.
      const fields = {
        name,
        description: descIn.value.trim() || null,
        kind: 'manual',
        lines,
        schedule: sched ?? null,
      };
      await saveTemplate(existing, fields, { nameField, nameIn, saveBtn: footer.saveBtn, close });
    }));
  }

  // ── Dynamic template editor ──────────────────────────────────────────────
  async function openDynamicTemplateSheet(existing) {
    const isNew = !existing;
    const tpl = isNew
      ? { id: '', name: '', description: '', kind: 'dynamic', assignments: [] }
      : { ...existing, kind: 'dynamic', assignments: (existing.assignments || []).map(a => ({ ...a })) };

    // Snapshot monthly plan totals for the live preview: `envelopes.month`'s
    // fillPlanned, the buffer-free monthly plan a dynamic template fills from
    // today (planItemsForDynamicFill), the scheduler's source, or the preview promises a
    // different amount than the fill actually posts. Every envelope the rows
    // can pick (an archived one an existing row keeps included); no
    // projections. Null when the query failed: the preview is then left off.
    // Recompute on any state change by re-opening the sheet — fine for the edit flow.
    const planAnswer = ask('envelopes.month', {
      date: isoDate(appNow()), spare: false, envelopes: (state.envelopes || []).map(e => e.id),
    });
    const monthlyPlan = planAnswer ? new Map(planAnswer.envelopes.map(e => [e.id, e.fillPlanned])) : null;

    const form = document.createElement('form');

    const nameIn = document.createElement('input');
    nameIn.type = 'text';
    nameIn.required = true;
    nameIn.value = tpl.name || '';
    nameIn.placeholder = t('templatesPage.nameDynamicPlaceholder');

    const descIn = document.createElement('input');
    descIn.type = 'text';
    descIn.value = tpl.description || '';
    descIn.placeholder = t('templatesPage.descPlaceholder');

    const nameField = nameFieldWithHint(nameIn);
    form.append(nameField, field(t('templatesPage.descriptionLabel'), descIn));

    const help = document.createElement('p');
    help.className = 'muted';
    help.style.cssText = 'margin:0 0 6px;font-size:12px;';
    help.textContent = t('templatesPage.dynamicHelp');
    form.append(help);

    const assignWrap = document.createElement('div');
    assignWrap.className = 'field';
    const assignLbl = document.createElement('label');
    assignLbl.textContent = t('templatesPage.assignmentsLabel');
    const assignHost = document.createElement('div');
    assignHost.style.cssText = 'display:flex;flex-direction:column;gap:6px;width:100%;padding-right:4px;';
    const assignFooter = document.createElement('div');
    assignFooter.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-top:6px;font-size:12px;gap:8px;flex-wrap:wrap;';
    const footerLeft = document.createElement('div');
    footerLeft.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';
    const addAssignBtn = document.createElement('button');
    addAssignBtn.type = 'button';
    addAssignBtn.className = 'btn btn-ghost';
    addAssignBtn.style.cssText = 'padding:4px 10px;font-size:12px;';
    addAssignBtn.textContent = t('templatesPage.addAssignment');
    const bulkSel = document.createElement('select');
    bulkSel.className = 'bulk-add-group';
    bulkSel.style.cssText = 'padding:4px 8px;font-size:12px;';
    {
      const ph = document.createElement('option');
      ph.value = '';
      ph.textContent = t('templatesPage.addGroup');
      ph.disabled = true;
      ph.selected = true;
      bulkSel.append(ph);
      const all = document.createElement('option');
      all.value = '__all__';
      all.textContent = t('templatesPage.allEnvelopes');
      bulkSel.append(all);
      const cats = new Set();
      (state.envelopes || []).forEach(e => {
        if (e.archived) return;
        if (e.category) cats.add(e.category);
      });
      [...cats].sort((a, b) => a.localeCompare(b)).forEach(cat => {
        const o = document.createElement('option');
        o.value = 'cat:' + cat;
        o.textContent = cat;
        bulkSel.append(o);
      });
    }
    footerLeft.append(addAssignBtn, bulkSel);
    const assignTotalEl = document.createElement('div');
    assignTotalEl.className = 'muted';
    assignFooter.append(footerLeft, assignTotalEl);
    assignWrap.append(assignLbl, assignHost, assignFooter);

    function computeRowMonthly(envId, pct) {
      const base = monthlyPlan?.get(envId) || 0;
      const p = parseAmountInput(pct);
      if (!envId || !Number.isFinite(p) || p <= 0) return 0;
      return base * (p / 100);
    }

    // Keep execution order independent of the grouped presentation. Merely
    // opening and saving a template must not reorder its assignments.
    const assignmentRows = [];
    let nextAssignmentKey = 0;
    let groupSignature = '';
    function groupAssignmentRows() {
      const rows = assignmentRows.filter(row => assignHost.contains(row));
      const categoryFor = row => (state.envelopes || []).find(e => e.id === row.querySelector('.split-env').value)?.category || '';
      const signature = JSON.stringify(rows.map(row => [row.dataset.assignmentKey, categoryFor(row)]));
      if (signature === groupSignature) return;
      groupSignature = signature;
      const focused = document.activeElement;
      const groups = new Map();
      for (const row of rows) {
        const category = categoryFor(row);
        if (!groups.has(category)) groups.set(category, []);
        groups.get(category).push(row);
      }
      const sections = [...groups].map(([category, members]) => {
        const section = node('section', 'tpl-assignment-group');
        section.append(node('h3', 'tpl-assignment-group-title', category || t('flow.uncategorised')), ...members);
        return section;
      });
      assignHost.replaceChildren(...sections);
      if (focused instanceof HTMLElement && assignHost.contains(focused)) focused.focus({ preventScroll: true });
    }

    function moveAssignment(row, target, after) {
      if (!target?.classList.contains('split-row') || row.parentElement !== target.parentElement) return;
      assignmentRows.splice(assignmentRows.indexOf(row), 1);
      assignmentRows.splice(assignmentRows.indexOf(target) + (after ? 1 : 0), 0, row);
      updateAssignRowVisibility();
    }

    function updateAssignRowVisibility() {
      groupAssignmentRows();
      const rows = assignHost.querySelectorAll('.split-row');
      rows.forEach(r => {
        const rm = r.querySelector('.line-rm');
        if (rm) rm.style.visibility = rows.length > 1 ? 'visible' : 'hidden';
      });
      refreshEnvOptionDisabled(assignHost);
      let sum = 0;
      rows.forEach(r => {
        const envId = r.querySelector('.split-env').value;
        const pct = r.querySelector('.split-pct').value;
        const amt = computeRowMonthly(envId, pct);
        r.querySelector('.split-preview').textContent = envId && monthlyPlan ? `= ${fmt(amt)} / mo` : '';
        sum += amt;
      });
      assignTotalEl.textContent = monthlyPlan ? t('templatesPage.monthlyTotal')(fmt(sum)) : '';
    }

    function addAssignRow(assign = { envelope_id: '', mode: 'add', percent: 100 }) {
      const row = document.createElement('div');
      row.className = 'split-row';
      row.style.cssText = 'display:flex;gap:6px;align-items:center;width:100%;flex-wrap:wrap;';

      const envSel = document.createElement('select');
      envSel.className = 'split-env';
      envSel.style.cssText = 'flex:1 1 140px;min-width:0;';
      envSel.innerHTML = envelopeOptionsHtml(assign.envelope_id);

      const modeSel = document.createElement('select');
      modeSel.className = 'line-mode';
      modeSel.style.cssText = 'flex:0 0 84px;min-width:0;';
      [['add', t('templatesPage.modeAdd')], ['set', t('templatesPage.modeSetTo')]].forEach(([v, lbl]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = lbl;
        if (v === assign.mode) o.selected = true;
        modeSel.append(o);
      });

      const pctIn = document.createElement('input');
      pctIn.type = 'number';
      pctIn.step = '1';
      pctIn.min = '0';
      pctIn.max = '1000';
      pctIn.className = 'split-pct';
      pctIn.placeholder = '%';
      pctIn.style.cssText = 'flex:0 0 72px;min-width:0;';
      pctIn.value = Number.isFinite(Number(assign.percent)) ? assign.percent : 100;
      enableFormulaInput(pctIn);

      const pctSuffix = document.createElement('span');
      pctSuffix.className = 'muted';
      pctSuffix.style.cssText = 'font-size:12px;';
      pctSuffix.textContent = '%';

      const preview = document.createElement('span');
      preview.className = 'split-preview muted';
      preview.style.cssText = 'font-size:12px;font-variant-numeric:tabular-nums;flex:1 1 110px;text-align:right;';

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'btn btn-ghost line-rm';
      rmBtn.style.cssText = 'padding:4px 10px;color:var(--danger-text);';
      rmBtn.textContent = '×';
      rmBtn.addEventListener('click', () => { row.remove(); updateAssignRowVisibility(); });

      const handle = document.createElement('span');
      handle.className = 'drag-handle';
      handle.textContent = '⠿';
      handle.title = t('templatesPage.dragToReorder');
      // Keyboard alternative to the drag: the handle is the reorder
      // affordance, so it is the thing that takes focus. Alt+Arrow rather
      // than plain Arrow because the row's own selects use the arrow keys.
      handle.tabIndex = 0;
      handle.setAttribute('role', 'button');
      handle.setAttribute('aria-label', t('templatesPage.dragToReorder'));
      handle.addEventListener('keydown', (e) => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        const sibling = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
        if (!sibling) return;
        moveAssignment(row, sibling, e.key === 'ArrowDown');
        handle.focus();
      });

      row.draggable = true;
      row.addEventListener('dragstart', e => {
        e.dataTransfer.effectAllowed = 'move';
        row.dataset.dragging = '1';
      });
      row.addEventListener('dragend', () => {
        delete row.dataset.dragging;
        assignHost.querySelectorAll('.drag-over').forEach(r => r.classList.remove('drag-over'));
      });
      row.addEventListener('dragover', e => {
        if (!assignHost.querySelector('[data-dragging]')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        assignHost.querySelectorAll('.split-row').forEach(r => r.classList.remove('drag-over'));
        row.classList.add('drag-over');
      });
      row.addEventListener('drop', e => {
        e.preventDefault();
        const src = assignHost.querySelector('[data-dragging]');
        if (src && src !== row) {
          moveAssignment(src, row, assignmentRows.indexOf(src) < assignmentRows.indexOf(row));
        }
        row.classList.remove('drag-over');
      });

      row.append(handle, envSel, modeSel, pctIn, pctSuffix, preview, rmBtn);
      enhanceEnvelopeSelect(envSel);
      row._getAssign = () => ({
        envelope_id: envSel.value,
        mode: modeSel.value === 'set' ? 'set' : 'add',
        percent: Math.max(0, parseAmountInput(pctIn.value) || 0),
      });
      envSel.addEventListener('change', updateAssignRowVisibility);
      pctIn.addEventListener('input', updateAssignRowVisibility);
      modeSel.addEventListener('change', updateAssignRowVisibility);
      row.dataset.assignmentKey = String(nextAssignmentKey++);
      assignmentRows.push(row);
      assignHost.append(row);
    }

    if (tpl.assignments.length === 0) addAssignRow();
    else tpl.assignments.forEach(a => addAssignRow(a));

    addAssignBtn.addEventListener('click', () => {
      addAssignRow();
      updateAssignRowVisibility();
      assignHost.scrollTop = assignHost.scrollHeight;
    });

    bulkSel.addEventListener('change', () => {
      const pick = bulkSel.value;
      bulkSel.value = '';
      if (!pick) return;
      const taken = new Set(
        [...assignHost.querySelectorAll('.split-env')]
          .map(s => s.value)
          .filter(Boolean),
      );
      const targets = (state.envelopes || []).filter(e => {
        if (e.archived) return false;
        if (taken.has(e.id)) return false;
        if (pick === '__all__') return true;
        return ('cat:' + (e.category || '')) === pick;
      });
      if (targets.length === 0) return;
      // If the only row is a blank default, remove it before bulk-adding.
      const rows = [...assignHost.querySelectorAll('.split-row')];
      if (rows.length === 1) {
        const only = rows[0].querySelector('.split-env');
        if (only && !only.value) rows[0].remove();
      }
      targets.forEach(e => addAssignRow({ envelope_id: e.id, mode: 'add', percent: 100 }));
      updateAssignRowVisibility();
      assignHost.scrollTop = assignHost.scrollHeight;
    });

    updateAssignRowVisibility();

    form.append(assignWrap);

    const schedule = buildScheduleSection(tpl);
    form.insertBefore(node('p', 'muted', t('workspace.templateModes')), form.children[2] || null);
    form.insertBefore(disclosure(t('workspace.schedule'), [schedule.wrap], true), form.children[2] || null);

    const footer = buildEditorActions(!existing);
    const tracker = trackDirty(form);
    const { close, requestClose } = openSheet({
      title: existing ? t('templatesPage.editDynamicTitle') : t('templatesPage.newDynamicTitle'),
      content: form,
      wide: true,
      headerActions: [footer.delBtn, footer.cancelBtn, footer.saveBtn].filter(Boolean),
      confirmClose: tracker.confirmClose,
    });

    footer.cancelBtn.addEventListener('click', requestClose);

    if (footer.delBtn) {
      footer.delBtn.addEventListener('click', () => handleDelete(tpl, close));
    }

    form.addEventListener('submit', guardSubmit(async e => {
      e.preventDefault();
      const name = nameIn.value.trim();
      if (!name) { await alertDialog(t('templatesPage.nameRequired')); return; }
      const rowEls = assignmentRows.filter(row => assignHost.contains(row));
      const assignments = rowEls.map(r => r._getAssign())
        .filter(a => a.envelope_id && a.percent > 0);
      if (assignments.length === 0) { await alertDialog(t('templatesPage.needAssignment')); return; }

      // Enforce one assignment per envelope within the template.
      const seen = new Set();
      for (const a of assignments) {
        if (seen.has(a.envelope_id)) {
          await alertDialog(t('templatesPage.envelopeOnceDynamic'));
          return;
        }
        seen.add(a.envelope_id);
      }

      const sched = schedule.getSchedule({
        targetEnvelopeIds: assignments.map(a => a.envelope_id),
      });
      if (sched && sched.error) { await alertDialog(t(sched.error)); return; }

      // Only this kind's list: the command refuses the other one, even empty.
      const fields = {
        name,
        description: descIn.value.trim() || null,
        kind: 'dynamic',
        assignments,
        schedule: sched ?? null,
      };
      await saveTemplate(existing, fields, { nameField, nameIn, saveBtn: footer.saveBtn, close });
    }));
  }

  // ── Shared schedule section for both edit sheets ─────────────────────────
  //
  // A scheduled template fires on its own calendar rather than as a leg of a
  // scheduled income occurrence, so its envelopes keep being funded in months
  // where the income is zero. Months are on/off only — the amounts come from
  // the template's own lines, so there is nothing per-month to override.
  function buildScheduleSection(tpl) {
    const sched = tpl.schedule || {};
    const wrap = document.createElement('div');
    wrap.className = 'field';

    const lbl = document.createElement('label');
    lbl.textContent = t('templatesPage.scheduleLabel');
    wrap.append(lbl);

    const enableRow = document.createElement('label');
    enableRow.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;font-weight:500;';
    const enableIn = document.createElement('input');
    enableIn.type = 'checkbox';
    // `.field input` is width:100%, which stretches a bare checkbox across the
    // whole row and pushes its label to the far edge.
    enableIn.style.cssText = 'flex:0 0 auto;width:auto;margin:0;';
    enableIn.checked = sched.enabled === true;
    const enableTxt = document.createElement('span');
    enableTxt.style.cssText = 'text-transform:none;font-size:13px;letter-spacing:normal;';
    enableTxt.textContent = t('templatesPage.scheduleEnable');
    enableRow.append(enableIn, enableTxt);
    wrap.append(enableRow);

    const hint = document.createElement('div');
    hint.className = 'muted';
    hint.style.cssText = 'font-size:12px;margin:4px 0 8px;';
    hint.textContent = t('templatesPage.scheduleHint');
    wrap.append(hint);

    // Everything below the toggle lives in `body`, hidden when off.
    const body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

    const monthsLbl = document.createElement('div');
    monthsLbl.className = 'bp-section-label';
    monthsLbl.textContent = t('templatesPage.scheduleMonths');

    const grid = document.createElement('div');
    grid.className = 'bp-sched';
    const cells = [];
    QUARTERS.forEach(q => {
      const row = document.createElement('div');
      row.className = 'bp-sched-row';
      const qLbl = document.createElement('div');
      qLbl.className = 'bp-qlabel';
      qLbl.textContent = q.label;
      row.append(qLbl);
      q.months.forEach(mon => {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'bp-mcell';
        cell.dataset.mon = mon;
        // Default a brand-new schedule to every month — the common case is a
        // monthly allocation plan, and an all-off grid fires nothing.
        const on = tpl.schedule ? sched.months?.[mon] === true : true;
        paintMonthCell(cell, on);
        cell.addEventListener('click', () => {
          paintMonthCell(cell, cell.classList.contains('active') ? false : true);
        });
        row.append(cell);
        cells.push(cell);
      });
      row.append(document.createElement('div')); // spacer, matches bp layout
      grid.append(row);
    });

    const dayIn = document.createElement('input');
    dayIn.type = 'number';
    dayIn.min = '1';
    dayIn.max = '31';
    dayIn.step = '1';
    dayIn.value = Number.isFinite(Number(sched.payment_day)) && Number(sched.payment_day) >= 1
      ? String(Math.floor(Number(sched.payment_day)))
      : '1';

    const dayHint = document.createElement('div');
    dayHint.className = 'muted';
    dayHint.style.cssText = 'font-size:12px;';
    dayHint.textContent = t('templatesPage.schedulePayDayHint');

    const typeSel = document.createElement('select');
    [
      ['exact', t('templatesPage.dayTypeExact')],
      ['next_work_day', t('templatesPage.dayTypeNext')],
      ['prev_work_day', t('templatesPage.dayTypePrev')],
    ].forEach(([v, label]) => {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      if (v === (sched.day_type || 'exact')) o.selected = true;
      typeSel.append(o);
    });

    const sinceIn = document.createElement('input');
    sinceIn.type = 'date';
    if (typeof sched.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(sched.since)) {
      sinceIn.value = sched.since;
    } else {
      // Today, not the 1st: a start earlier this month would backfill a fill
      // on save that the user did not ask for (owner decision 2026-10-05).
      sinceIn.value = isoDate(appNow());
    }

    const sinceHint = document.createElement('div');
    sinceHint.className = 'muted';
    sinceHint.style.cssText = 'font-size:12px;';
    sinceHint.textContent = t('templatesPage.scheduleSinceHint');

    // End date. Empty is the common case — a template usually runs until the
    // user turns it off — so this stays blank rather than defaulting to
    // anything the walker would then treat as a bound.
    const untilIn = document.createElement('input');
    untilIn.type = 'date';
    untilIn.value = /^\d{4}-\d{2}-\d{2}$/.test(sched.until || '') ? sched.until : '';

    const untilHint = document.createElement('div');
    untilHint.className = 'muted';
    untilHint.style.cssText = 'font-size:12px;';
    untilHint.textContent = t('templatesPage.scheduleUntilHint');

    // Funding source. Blank = the default regime: the fill comes out of
    // unallocated. Naming an envelope switches to the buffer-funded regime
    // (see engine/scheduling.js templateFillSourceId) where the fill nets to
    // zero across envelopes and unallocated does not move.
    const srcSel = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = t('templatesPage.scheduleSourceNone');
    srcSel.append(noneOpt);
    const currentSrc = typeof sched.source_envelope_id === 'string' ? sched.source_envelope_id : '';
    const envOptions = (state.envelopes || []).filter(e => !e.archived || e.id === currentSrc);
    // An archived source still renders as an option: the engine declines it,
    // and dropping it from the list would silently clear a configured source
    // the moment its envelope was archived — the user must see it to fix it.
    envOptions.forEach(e => {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = e.archived
        ? `${trEnv(e)} ${t('templatesPage.scheduleSourceArchivedTag')}`
        : trEnv(e);
      srcSel.append(o);
    });
    if (currentSrc && !envOptions.some(e => e.id === currentSrc)) {
      const o = document.createElement('option');
      o.value = currentSrc;
      o.textContent = `${currentSrc} ${t('templatesPage.deletedEnvelope')}`;
      srcSel.append(o);
    }
    srcSel.value = currentSrc;

    const srcHint = document.createElement('div');
    srcHint.className = 'muted';
    srcHint.style.cssText = 'font-size:12px;';
    srcHint.textContent = t('templatesPage.scheduleSourceHint');

    const srcSinceIn = document.createElement('input');
    srcSinceIn.type = 'date';
    srcSinceIn.value = /^\d{4}-\d{2}-\d{2}$/.test(sched.source_since || '') ? sched.source_since : '';

    const srcSinceHint = document.createElement('div');
    srcSinceHint.className = 'muted';
    srcSinceHint.style.cssText = 'font-size:12px;';
    srcSinceHint.textContent = t('templatesPage.scheduleSourceSinceHint');

    const srcSinceField = field(t('templatesPage.scheduleSourceSince'), srcSinceIn);

    // The from-date only means anything once a source is named.
    function syncSource() {
      const on = !!srcSel.value;
      srcSinceField.style.display = on ? '' : 'none';
      srcSinceHint.style.display = on ? '' : 'none';
    }
    srcSel.addEventListener('change', syncSource);

    body.append(
      monthsLbl, grid,
      field(t('templatesPage.schedulePayDay'), dayIn), dayHint,
      field(t('templatesPage.scheduleDayType'), typeSel),
      field(t('templatesPage.scheduleSince'), sinceIn), sinceHint,
      field(t('templatesPage.scheduleUntil'), untilIn), untilHint,
      field(t('templatesPage.scheduleSource'), srcSel), srcHint,
      srcSinceField, srcSinceHint,
    );
    syncSource();
    wrap.append(body);

    function syncEnabled() {
      body.style.display = enableIn.checked ? 'flex' : 'none';
    }
    enableIn.addEventListener('change', syncEnabled);
    syncEnabled();

    return {
      wrap,
      // Returns the schedule to persist, `undefined` when the template never
      // had one — an absent `schedule` is what the engine reads as "not
      // self-scheduled" — or `{ error: <i18n key> }` for the caller to report.
      //
      // Unchecking the box on a template that HAS a schedule DISABLES it
      // (enabled: false) rather than deleting it, so the whole configuration
      // (months, funding source, bounds) survives a pause and comes back
      // intact when re-enabled.
      //
      // `targetEnvelopeIds` describes the lines or assignments the caller just
      // collected. It exists for the source-envelope conflict:
      // `templateFillSourceId` DECLINES a source that is also a target, by
      // returning null — which posts the fill from unallocated instead. That
      // silent downgrade is exactly the leak the funding regime exists to
      // prevent, so the editor refuses the configuration outright rather than
      // saving something the engine will quietly ignore.
      //
      // A set-mode line is NOT refused any more (2026-09-24): the source
      // draws the delta that lands the target on its value, resolved at
      // posting and in every forecast.
      getSchedule({ targetEnvelopeIds = [] } = {}) {
        if (!enableIn.checked) {
          return tpl.schedule ? { ...tpl.schedule, enabled: false } : undefined;
        }
        const months = {};
        cells.forEach(c => { if (c.classList.contains('active')) months[c.dataset.mon] = true; });
        if (Object.keys(months).length === 0) return { error: 'templatesPage.scheduleNeedMonth' };
        const day = Math.min(31, Math.max(1, Math.floor(Number(dayIn.value) || 1)));
        const out = {
          enabled: true,
          payment_day: day,
          day_type: typeSel.value,
          months,
        };
        if (/^\d{4}-\d{2}-\d{2}$/.test(sinceIn.value)) out.since = sinceIn.value;
        if (/^\d{4}-\d{2}-\d{2}$/.test(untilIn.value)) {
          // An end before the start fires nothing at all — a schedule that
          // looks configured and never runs is worse than a rejected save.
          if (out.since && untilIn.value < out.since) {
            return { error: 'templatesPage.scheduleUntilBeforeSince' };
          }
          out.until = untilIn.value;
        }
        // Preserve skips the user made from elsewhere rather than dropping them
        // on an unrelated edit.
        const keep = (tpl.schedule?.skipped || []).filter(k => /^\d{4}-\d{2}$/.test(k));
        if (keep.length) out.skipped = keep;

        const srcId = srcSel.value;
        if (srcId) {
          if (targetEnvelopeIds.includes(srcId)) {
            return { error: 'templatesPage.scheduleSourceIsTarget' };
          }
          out.source_envelope_id = srcId;
          if (/^\d{4}-\d{2}-\d{2}$/.test(srcSinceIn.value)) out.source_since = srcSinceIn.value;
        }
        return out;
      },
    };
  }

  // On/off month cell. Deliberately not `paintCell` from budget-plan-cells:
  // that one renders an amount line ("default" / a custom figure), and a
  // template has no per-month amount to show.
  function paintMonthCell(cell, active) {
    cell.classList.toggle('active', !!active);
    cell.replaceChildren();
    const label = document.createElement('div');
    label.className = 'bp-mcell-label';
    label.textContent = String(cell.dataset.mon || '').toUpperCase();
    const mark = document.createElement('div');
    mark.className = active ? 'bp-mcell-amt' : 'bp-mcell-amt muted';
    mark.textContent = active ? '✓' : '—';
    cell.append(label, mark);
  }

  // Shared header actions; openSheet associates Submit with the form.
  function buildEditorActions(isNew) {
    const delBtn = isNew ? null : node('button', 'btn btn-ghost', t('common.delete'));
    if (delBtn) { delBtn.type = 'button'; delBtn.style.color = 'var(--danger)'; }
    const cancelBtn = node('button', 'btn btn-ghost', t('common.cancel'));
    cancelBtn.type = 'button';
    const saveBtn = node('button', 'btn btn-accent', t('common.save'));
    saveBtn.type = 'submit';
    return { delBtn, cancelBtn, saveBtn };
  }

  async function handleDelete(tpl, close) {
    if (!await confirmDialog(t('templatesPage.deleteConfirm'), { title: t('templatesPage.deleteTitle'), danger: true, okLabel: t('common.delete') })) return;
    // The session changes the list only once the write lands; a failure is
    // reported and leaves the template (and this sheet) as they were.
    const r = await dispatchOrReport(session, 'template.delete', { id: tpl.id });
    if (!r) return;
    close();
    repaint();
    toast(t('templatesPage.deleted'), { action: undoAction(r.value.undo, 'templates') });
  }

  // Create or update through the session. The command builds the stored
  // template as this editor did (trimmed name, the schedule as getSchedule
  // stores it), makes a new one's id from its name, and keeps the fields an
  // update does not give.
  async function saveTemplate(existing, fields, { nameField, nameIn, saveBtn, close }) {
    let r;
    try {
      r = await withBusy(saveBtn, () => (existing
        ? session.dispatch('template.update', { id: existing.id, fields })
        : session.dispatch('template.create', fields)), { label: t('common.saving') });
    } catch (err) {
      console.error(err);
      toast(t('common.saveFailed')(err?.message || err), { assertive: true });
      return;
    }
    if (!r.ok) {
      // A taken name belongs on the name field, not in a toast.
      if (r.error.code === 'name_taken') {
        setFieldHint(nameField, t('templatesPage.nameTaken')(r.error.params?.name ?? fields.name));
        nameIn.focus();
        return;
      }
      reportDispatchFailure(r.error);
      return;
    }
    reportMetaFailure(r);
    // A newly scheduled template can already be due (today's payment day, or
    // a start date in the past). Materialise now, as budget-plan does after
    // saving a scheduled item, or the fill only appears on the next load; the
    // toast says how many fills that posted.
    let posted = 0;
    if (fields.schedule?.enabled === true) {
      try {
        posted = (await runDueScheduled())?.posted ?? 0;
        // repaint() below only redraws the template grid, and updateStatusBar
        // otherwise runs only on a page render — so without this the sidebar
        // and status bar keep showing the pre-fill unallocated figure right
        // after the user moved money.
        updateStatusBar();
      } catch (err) { console.error('runDueScheduled after template save failed:', err); }
    }
    close();
    repaint();
    toast(posted > 0 ? t('templatesPage.savedPosted')(posted) : t('templatesPage.saved'));
  }

  // ── Apply-to-pool sheet ──────────────────────────────────────────────────
  async function openApplyToPoolSheet(tpl) {
    const token = currentBudgetSession();
    // Re-read at open: the card may predate a posted fill or a template edit.
    const answer = ask('templates.summary', { date: isoDate(appNow()), templates: [tpl.id] });
    const summary = answer?.templates[0];
    if (!summary) return;
    tpl = state.envelopeTemplates.find(row => row.id === tpl.id);
    if (!tpl) return;
    const effLinesAtOpen = summary.resolvedLines;
    if (!effLinesAtOpen.length) {
      await alertDialog(
        isDynamic(tpl)
          ? t('templatesPage.applyNoLinesDynamic')
          : t('templatesPage.applyNoLines'),
        { title: t('templatesPage.applyTitle') },
      );
      return;
    }

    // A scheduled template will fill these envelopes again on its own, so ask
    // whether this is money on top of that or the next fill brought forward.
    // Brought forward skips the scheduled one; otherwise the envelopes get
    // filled twice.
    let early = null;
    const pending = summary.nextPending;
    if (pending) {
      const when = fmtDateLang(pending.date);
      const choice = await confirmDialog(t('templatesPage.earlyAskBody')(tpl.name || tpl.id, when), {
        title: t('templatesPage.earlyAskTitle'),
        okLabel: t('templatesPage.earlyAskEarly')(when),
        cancelLabel: t('templatesPage.earlyAskExtra'),
        dismissLabel: t('common.cancel'),
      });
      if (choice === null || token !== currentBudgetSession()) return;
      if (choice) early = { ...pending, when };
    }

    const form = document.createElement('form');

    const dateIn = document.createElement('input');
    dateIn.type = 'date';
    const today = appNow();
    const pad = n => String(n).padStart(2, '0');
    dateIn.value = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

    const acctSel = document.createElement('select');
    const chooseOpt = document.createElement('option');
    chooseOpt.value = '';
    chooseOpt.textContent = t('templatesPage.chooseSourceAccount');
    acctSel.append(chooseOpt);
    (state.accounts || []).filter(a => !a.archived && a.type !== 'asset' && a.type !== 'loan' && a.type !== 'loan_given').forEach(a => {
      const o = document.createElement('option');
      o.value = a.id; o.textContent = a.name || a.id;
      acctSel.append(o);
    });

    form.append(field(t('templatesPage.applyDate'), dateIn), field(t('templatesPage.applySourceAccount'), acctSel));

    if (early) {
      const note = document.createElement('div');
      note.className = 'muted';
      note.style.cssText = 'font-size:12px;margin:4px 0 8px;';
      note.textContent = t('templatesPage.earlyNote')(early.when);
      form.append(note);
    }

    const preview = node('div', 'template-execution-preview');
    preview.setAttribute('aria-live', 'polite');
    form.append(preview);

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = t('common.cancel');
    const applyBtn = document.createElement('button');
    applyBtn.type = 'submit';
    applyBtn.className = 'btn btn-accent';
    applyBtn.textContent = t('common.apply');

    const getInput = () => {
      const args = {
        template: tpl.id,
        date: dateIn.value,
        source: 'pool_distribute',
        // null when none is picked: the fill records "no account", as before.
        account: acctSel.value || null,
        payee: tpl.name || t('templatesPage.applyPayee'),
      };
      if (early) {
        // Run early: the fill stands in for that occurrence (its source leg
        // too), and the same commit skips it on the template's schedule. A
        // taken or deleted occurrence is still refused.
        args.month = early.monthKey;
        args.skipTemplateMonth = true;
      } else {
        // Extra money, or a plain apply: a fill outside the schedule. It
        // stands in for no occurrence, draws on no source envelope, and may
        // repeat within a month.
        args.adhoc = true;
      }
      return args;
    };
    const tracker = trackDirty(form);
    const { close, requestClose } = openSheet({
      title: t('templatesPage.applySheetTitle')(tpl.name || tpl.id),
      content: form,
      headerActions: [cancelBtn, applyBtn],
      confirmClose: tracker.confirmClose,
    });
    cancelBtn.addEventListener('click', requestClose);

    const effects = templatePreview({ form, host:preview, button:applyBtn, input:getInput, token });
    dateIn.addEventListener('input', effects.refresh);
    acctSel.addEventListener('change', effects.refresh);
    effects.refresh();

    form.addEventListener('submit', guardSubmit(async e => {
      e.preventDefault();
      // One allocation.fill. The command resolves the template's lines when it
      // runs (a set line becomes the delta to its target as of the fill date;
      // lines of an archived envelope are dropped).
      if (!effects.valid()) { await effects.refresh(); return; }
      const input = getInput();
      let r;
      try {
        r = await withBusy(applyBtn, () => session.dispatch('allocation.fill', input), { label: t('common.saving') });
      } catch (err) {
        console.error(err);
        toast(t('common.saveFailed')(err?.message || err), { assertive: true });
        return;
      }
      if (!r.ok) {
        if (r.error.code === 'fill_nothing_to_fund') {
          await alertDialog(t('templatesPage.staleLines'), { title: t('templatesPage.applyTitle') });
          return;
        }
        reportDispatchFailure(r.error);
        return;
      }
      reportMetaFailure(r);
      close();
      // repaint() only redraws the template grid; the sidebar and status bar
      // would otherwise keep the pre-fill unallocated figure.
      updateStatusBar();
      repaint();
      toast(early ? t('templatesPage.appliedEarly')(early.when) : t('templatesPage.applied'));
    }));
  }

  repaint();
  container.append(page);
  if (focus?.editId) {
    const template = state.envelopeTemplates.find(item => item.id === focus.editId);
    if (template) await openTemplateSheet(template);
  }
}

// ── AI subscription detection card ─────────────────────────────────────

function buildAiSubscriptionCard() {
  let card, body;
  function load(noCache = false) {
    withAiState(body, async (signal) => {
      const out = await aiInsights('subscription_detection', { signal, noCache });
      renderSubs(body, out);
    });
  }
  ({ card, body } = renderAiCard({
    titleKey: 'ai.subs.title',
    subKey: 'ai.subs.sub',
    onRefresh: () => load(true),
  }));
  card.style.marginBottom = '12px';
  load(false);
  return card;
}

function renderSubs(host, out) {
  host.replaceChildren();
  const candidates = Array.isArray(out?.candidates) ? out.candidates : [];
  if (!candidates.length) {
    const empty = document.createElement('div');
    empty.className = 'ai-error';
    empty.textContent = t('ai.subs.empty');
    host.append(empty);
    return;
  }
  const envById = new Map((state.envelopes || []).map((e) => [e.id, e]));
  for (const c of candidates) {
    const row = document.createElement('div');
    row.className = 'ai-row';
    const dot = document.createElement('span');
    dot.className = 'ai-dot ai-dot-info';
    row.append(dot);

    const text = document.createElement('div');
    text.style.flex = '1';
    const name = document.createElement('div');
    name.style.fontWeight = '500';
    // Model-authored: resolved once, used for display, prefill and dismissal.
    const payee = formatAiText(c.payee || '');
    name.textContent = payee;
    const meta = document.createElement('div');
    meta.style.cssText = 'font-size:12.5px;color:var(--muted);';
    const freqKey = `ai.subs.frequency.${c.frequency || 'monthly'}`;
    const env = c.suggested_envelope_id && envById.get(c.suggested_envelope_id);
    const parts = [
      `${fmt(Number(c.amount) || 0)}`,
      t(freqKey),
      formatAiText(c.last_date || ''),
    ].filter(Boolean);
    meta.textContent = parts.join(' · ') + (env ? ` → ${env.name}` : '');
    text.append(name, meta);
    row.append(text);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'btn btn-ghost';
    add.textContent = t('ai.subs.addAsScheduled');
    add.addEventListener('click', () => {
      navigate('budget-plan', {
        prefillScheduled: {
          payee,
          amount: Number(c.amount) || 0,
          frequency: c.frequency || 'monthly',
          envelope_id: c.suggested_envelope_id || null,
        },
      });
    });
    row.append(add);

    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'btn btn-ghost btn-icon';
    dismiss.textContent = '×';
    dismiss.title = t('ai.subs.dismiss');
    // Removing a candidate must not re-call the LLM — that costs money.
    // Persist the dismissal so it stays gone on the next manual refresh,
    // and remove the row locally. If the list ends up empty, swap in the
    // empty-state message.
    dismiss.addEventListener('click', async () => {
      try { await dismissSubscription(payee); }
      catch (err) { console.error('dismiss persist failed', err); }
      row.remove();
      if (!host.querySelector('.ai-row')) {
        const empty = document.createElement('div');
        empty.className = 'ai-error';
        empty.textContent = t('ai.subs.empty');
        host.append(empty);
      }
    });
    row.append(dismiss);
    host.append(row);
  }
}

import { openSheet } from '../ui/sheet.js';
import { confirmDialog } from '../ui/dialog.js';
import { t, trEnv } from '../ui/i18n.js';
import { enhanceSelectWithSearch } from '../ui/select-combobox.js';
import { parseAmountInput } from '../ui/amount-input.js';
import { describeError } from '../core/errors.js';
import { currentBudgetSession, onBudgetSessionChange } from '../state/budget-session.js';
import { fmt } from '../utils.js';
export const ruleElement = (tag, className, text) => {
  const node = document.createElement(tag); node.className = className || '';
  if (text != null) node.textContent = text;
  return node;
};
export function ruleButton(text, handler) {
  const b = ruleElement('button', 'btn btn-sm btn-ghost', text); b.type = 'button'; b.addEventListener('click', handler); return b;
}
function ownedSheet(state, options) {
  const generation = currentBudgetSession(); const folder = state.budgetFolder;
  let closed = false; let unsubscribe = () => {};
  const sheet = openSheet({ ...options, onClose: () => { closed = true; unsubscribe(); options.onClose?.(); } });
  unsubscribe = onBudgetSessionChange(() => sheet.close());
  return { ...sheet, active: () => !closed && !!options.content.closest('[data-sheet-open]') && generation === currentBudgetSession() && folder === state.budgetFolder };
}
export function openImportRuleEditor({ state, session, rows, rule = null, seed = null, getCurrentValues = () => ({}), onSaved = () => {} }) {
  const initial = rule || seed || { name: '', conditions: { merchant: '', operator: 'equals', direction: 'expense' }, actions: {} };
  const form = ruleElement('form', 'import-rule-editor');
  const grid = ruleElement('div', 'import-rule-fields'); form.append(grid);
  function field(key, control) {
    const wrap = ruleElement('label', 'field'); wrap.append(ruleElement('span', '', t(`importRules.${key}`)), control);
    control.className = 'form-input'; control.setAttribute('aria-label', t(`importRules.${key}`)); grid.append(wrap); return control;
  }
  function text(key, value = '') { const n = document.createElement('input'); n.value = value ?? ''; return field(key, n); }
  function select(key, options, value) {
    const n = document.createElement('select');
    for (const [v, label] of options) { const o = ruleElement('option', '', label); o.value = v; n.append(o); }
    n.value = value; return field(key, n);
  }
  const name = text('name', initial.name); name.required = true;
  const merchant = text('merchant', initial.conditions?.merchant); merchant.required = true;
  const operator = select('operator', ['equals','startsWith','contains'].map(k => [k,t(`importRules.${k}`)]), initial.conditions?.operator || 'equals');
  const direction = select('direction', ['expense','income'].map(k => [k,t(`importRules.${k}`)]), initial.conditions?.direction || 'expense');
  const account = select('account', [['',t('importRules.allAccounts')], ...state.accounts.filter(a => !a.archived).map(a => [a.id,a.name])], initial.conditions?.account || '');
  const min = text('minimum', initial.conditions?.minAmount); min.inputMode = 'decimal';
  const max = text('maximum', initial.conditions?.maxAmount); max.inputMode = 'decimal';
  const payee = text('rename', initial.actions?.payee);
  const envelope = select('envelope', [['__unchanged__',t('importRules.unchanged')],['',t('common.unassigned')], ...state.envelopes.filter(e => !e.archived).map(e => [e.id,trEnv(e)])],
    Object.hasOwn(initial.actions || {}, 'envelope') ? initial.actions.envelope || '' : '__unchanged__');
  // Missing references stay visible rather than silently broadening to all accounts.
  for (const [control, original] of [[account, initial.conditions?.account], [envelope, initial.actions?.envelope]]) {
    if (original && ![...control.options].some(o => o.value === original)) { const o = ruleElement('option','', `${original} (${t('importRules.unavailable')})`); o.value = original; control.append(o); control.value = original; }
  }
  enhanceSelectWithSearch(envelope, { placeholder: t('importRules.envelope'), noMatch: t('addTx.envelopeNoMatch') });
  const notice = ruleElement('p','field-note',t('importRules.persistence')); form.append(notice);
  const error = ruleElement('p','import-rule-error'); error.setAttribute('role','alert');
  const preview = ruleElement('div','import-rule-preview'); form.append(error, preview);
  const actions = ruleElement('div','import-rule-actions'); actions.dataset.sheetActions = '';
  let busy = false; let sheet;
  const cancel = ruleButton(t('common.cancel'), () => sheet.requestClose());
  const save = ruleButton(t('common.save'), () => form.requestSubmit()); save.classList.add('btn-accent'); actions.append(cancel,save); form.append(actions);
  function draft() {
    const conditions = { merchant: merchant.value, operator: operator.value, direction: direction.value };
    if (account.value) conditions.account = account.value;
    if (min.value.trim()) conditions.minAmount = parseAmountInput(min.value, { strict: true });
    if (max.value.trim()) conditions.maxAmount = parseAmountInput(max.value, { strict: true });
    const actions = {};
    if (payee.value.trim()) actions.payee = payee.value.trim();
    if (envelope.value !== '__unchanged__') actions.envelope = envelope.value || null;
    return { ...(rule ? { id: rule.id } : {}), name: name.value, enabled: rule?.enabled ?? true, conditions, actions };
  }
  function renderPreview() {
    if (busy) return;
    preview.replaceChildren(ruleElement('h3','',t('importRules.preview')));
    const result = session.query('importRules.preview', { rows, draft: draft() });
    const valid = result.ok && !result.value.diagnostics.some(d => d.id === (rule?.id || '__draft__') || d.code === 'not_found');
    save.disabled = !valid;
    if (!valid) { preview.append(ruleElement('p','field-note',t('importRules.invalid'))); return; }
    const names = new Map((Array.isArray(state.meta?.importRules) ? state.meta.importRules : []).filter(r => r && typeof r === 'object').map(r => [r.id,r.name]));
    names.set(rule?.id || '__draft__', name.value);
    const list = ruleElement('ul','import-rule-preview-list');
    const draftId = rule?.id || '__draft__';
    const current = getCurrentValues();
    const withExcluded = rows.some(r=>r.excluded) ? session.query('importRules.preview',{rows:rows.map(r=>({...r,excluded:false})),draft:draft()}) : result;
    const matchedKeys = new Set((withExcluded.ok ? withExcluded.value.rows : []).filter(r=>r.matches.includes(draftId)).map(r=>r.key));
    for (const r of result.value.rows) {
      const source = rows.find(x => x.key === r.key);
      if (!matchedKeys.has(r.key)) continue;
      const parts = [source.payee, fmt(source.amount)];
      if (r.excluded) parts.push(t('importRules.excluded'));
      for (const [field, value] of Object.entries(r.fields)) {
        const before = field === 'payee' ? current[r.key]?.payee ?? source.payee : state.envelopes.find(e=>e.id===current[r.key]?.envelope)?.name || t('common.unassigned');
        const after = value.alternatives.map(a => `${field === 'envelope' ? state.envelopes.find(e => e.id === a.value)?.name || t('common.unassigned') : a.value} (${a.rules.map(id => names.get(id) || id).join(', ')})`).join(' / ');
        parts.push(`${t(`importRules.${field === 'payee' ? 'rename' : 'envelope'}`)}: ${before} → ${after}${value.status === 'conflict' ? ` (${t('importRules.conflict')})` : ''}`);
      }
      list.append(ruleElement('li','',parts.join(' · ')));
    }
    preview.append(list.children.length ? list : ruleElement('p','field-note',t('importRules.noMatches')));
  }
  form.addEventListener('input',renderPreview); form.addEventListener('change',renderPreview);
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !sheet.active()) return;
    renderPreview(); if (save.disabled) return;
    busy = true; save.disabled = true; cancel.disabled = true; error.textContent = '';
    try {
      const { id, ...fields } = draft();
      const result = await session.dispatch(rule ? 'importRule.update' : 'importRule.create', rule ? { id, fields } : fields);
      if (!sheet.active()) return;
      if (!result.ok) { error.textContent = describeError(result.error,t); return; }
      if (result.value.published === false) return;
      sheet.close(); onSaved();
    } catch (err) { if (sheet.active()) error.textContent = err.message; }
    finally { busy = false; if (sheet.active()) { cancel.disabled = false; renderPreview(); } }
  });
  sheet = ownedSheet(state, { title:t('importRules.editor'), content:form, confirmClose:()=>!busy }); renderPreview(); return sheet;
}
export function openImportRuleManager({ state, session, rows, getCurrentValues = () => ({}), onSaved = () => {} }) {
  const root = ruleElement('div','import-rule-manager'); let sheet; let busy = false;
  const changed = () => { if (sheet.active()) { render(); onSaved(); } };
  function render() {
    root.replaceChildren();
    root.append(ruleButton(t('importRules.create'), () => openImportRuleEditor({ state,session,rows,getCurrentValues,onSaved:changed })));
    const result = session.query('importRules.list',{});
    if (!result.ok) { root.append(ruleElement('p','import-rule-error',describeError(result.error,t))); return; }
    const errors = ruleElement('p','import-rule-error'); errors.setAttribute('role','alert'); root.append(errors);
    if (!result.value.rules.length) root.append(ruleElement('p','field-note',t('importRules.empty')));
    for (const [index, rule] of result.value.rules.entries()) {
      const row = ruleElement('div','import-rule-manager-row');
      const diagnostic = result.value.diagnostics.find(d => d.index === index);
      row.append(ruleElement('strong','',rule?.name || t('importRules.unavailable')));
      if (diagnostic) row.append(ruleElement('span','field-note',t('importRules.unavailable')));
      if (rule?.id && diagnostic?.code !== 'duplicate_id') {
        const mutate = async (command,input) => {
          if (busy || !sheet.active()) return; busy = true;
          try { const r = await session.dispatch(command,input); if (!sheet.active()) return;
            if (r.ok && r.value.published !== false) changed(); else if (!r.ok) errors.textContent = describeError(r.error,t);
          } catch(e) { if (sheet.active()) errors.textContent = e.message; } finally { busy = false; }
        };
        row.append(ruleButton(t('importRules.edit'),()=>openImportRuleEditor({state,session,rows,rule,getCurrentValues,onSaved:changed})),
          ruleButton(t(rule.enabled === false ? 'importRules.enable' : 'importRules.disable'),()=>mutate('importRule.update',{id:rule.id,fields:{enabled:rule.enabled === false}})),
          ruleButton(t('common.delete'),async()=>{ if(await confirmDialog(t('importRules.deleteConfirm'))) await mutate('importRule.delete',{id:rule.id}); }));
      }
      root.append(row);
    }
  }
  sheet = ownedSheet(state,{title:t('importRules.manage'),content:root,confirmClose:()=>!busy}); render(); return sheet;
}

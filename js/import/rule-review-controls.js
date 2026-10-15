import { fmt } from '../utils.js';
import { t } from '../ui/i18n.js';
import { ruleElement as el, ruleButton as button } from './rule-editor.js';
export function renderImportRuleControls({ draft, state, onManage, onRemember, onChanged }) {
  const root = el('div','import-rule-toolbar');
  const summary = el('span','field-note'); root.append(button(t('importRules.manage'),onManage),summary);
  function refresh() {
    const c = draft.summary(); summary.textContent = t('importRules.summary')(c);
    if (draft.diagnostics().length) summary.textContent += ` ${t('importRules.unavailable')}`;
  }
  function renderRow(key) {
    const r = draft.view().find(r=>r.key === key);
    const root = el('div','import-rule-row'); if (!r || r.excluded || !r.eligible) return root;
    const label = el('label','import-rule-name'); label.append(el('span','field-note',t('importRules.rename')));
    const name = document.createElement('input'); name.className = 'form-input import-rule-payee'; name.value = r.writePayee || ''; name.setAttribute('aria-label',t('importRules.rename'));
    name.addEventListener('change',()=>{ draft.edit(key,'payee',name.value); onChanged(); }); label.append(name); root.append(label);
    if (r.values.payee !== r.writePayee) root.append(el('span','field-note',`${t('importRules.savedName')}: ${r.values.payee}`));
    const names = new Map((Array.isArray(state.meta?.importRules) ? state.meta.importRules : []).filter(Boolean).map(r=>[r.id,r.name]));
    for (const [field, suggestion] of Object.entries(r.fields)) {
      const line = el('div',r.unresolved.includes(field) ? 'import-rule-conflict' : 'field-note');
      line.append(el('span','',`${t(r.unresolved.includes(field) ? 'importRules.conflict' : 'importRules.suggested')}: ${suggestion.alternatives.flatMap(a=>a.rules.map(id=>names.get(id)||id)).join(', ')}`));
      if (r.unresolved.includes(field)) {
        for (const a of suggestion.alternatives) {
          const display = field === 'envelope' ? state.envelopes.find(e=>e.id===a.value)?.name || t('common.unassigned') : a.value;
          line.append(button(display,()=>{ draft.edit(key,field,field==='payee'?a.proposed[0]:a.value); onChanged(); }));
        }
        line.append(button(t('importRules.keepOriginal'),()=>{draft.edit(key,field,r.baseline[field]);onChanged();}));
      }
      root.append(line);
    }
    if (Object.values(r.provenance).includes('manual')) root.append(button(t('importRules.remember'),()=>onRemember(key)));
    for (const id of r.matches) {
      const rule = state.meta.importRules.find(rule=>rule?.id===id);
      if (!rule) continue;
      const c=rule.conditions;
      const parts=[`${rule.name}: ${t('importRules.'+c.operator)} “${c.merchant}”`,t('importRules.'+c.direction),
        c.account ? state.accounts.find(a=>a.id===c.account)?.name || c.account : t('importRules.allAccounts')];
      if(c.minAmount!=null) parts.push(`≥ ${fmt(c.minAmount)}`);
      if(c.maxAmount!=null) parts.push(`≤ ${fmt(c.maxAmount)}`);
      root.append(el('span','field-note import-rule-reason',parts.join(' · ')));
    }
    return root;
  }
  refresh(); return {root,refresh,renderRow};
}

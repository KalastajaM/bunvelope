// The file importer alone opts into rule review; general AI proposals do not.
import { createImportRuleDraft } from './rule-draft.js';
import { renderImportRuleControls } from './rule-review-controls.js';
import { openImportRuleEditor, openImportRuleManager } from './rule-editor.js';
import { t } from '../ui/i18n.js';
export function createImportRuleReview({state,session,rows,baselines,onChanged}) {
  const draft = createImportRuleDraft({data:state,rows,baselines});
  const getCurrentValues = () => Object.fromEntries(draft.view().map(r=>[r.key,r.values]));
  const sourceRows = () => draft.view().map(r => r.source);
  const refresh = () => { draft.refresh(state); onChanged(); };
  const controls = renderImportRuleControls({draft,state,onChanged,
    onManage:()=>openImportRuleManager({state,session,rows:sourceRows(),getCurrentValues,onSaved:refresh}),
    onRemember:key=>{
      const r = draft.view().find(r=>r.key===key); if (!r) return;
      const actions = {};
      if (r.provenance.payee === 'manual' && r.writePayee.trim()) actions.payee = r.writePayee.trim();
      if (r.provenance.envelope === 'manual') actions.envelope = r.values.envelope;
      openImportRuleEditor({state,session,rows:sourceRows(),getCurrentValues,onSaved:refresh,seed:{
        name:r.values.payee || r.source.payee,
        conditions:{merchant:r.source.payee,operator:'equals',direction:r.source.amount>0?'income':'expense',...(r.source.account?{account:r.source.account}:{})},actions,
      }});
    },
  });
  return {draft,controls,refresh,approval:()=>draft.approval(state)};
}
export function importRuleApprovalError(reason) {
  return t(reason === 'changed' ? 'coreError.import_review_changed' : reason === 'conflicts' ? 'importRules.resolve' : 'importRules.reviewUnavailable');
}

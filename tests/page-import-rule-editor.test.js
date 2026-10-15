// @vitest-environment jsdom
import { it, expect, beforeEach, vi } from 'vitest';
vi.mock('../js/app.js', async () => (await import('./_fakes/pageApp.js')).appStub);
import { openImportRuleEditor, openImportRuleManager } from '../js/import/rule-editor.js';
import { state, resetState, mountHosts, flush, appStub, writeBatch } from './_fakes/pageApp.js';
import { beginBudgetSession } from '../js/state/budget-session.js';
import { t } from '../js/ui/i18n.js';
beforeEach(() => { resetState(); state.meta = { schemaVersion: 8 }; mountHosts(); state.accounts = [{ id:'bank',name:'Bank',type:'bank' }]; state.envelopes = [{ id:'food',name:'Food' }]; });
const rows = [{ key:'x',payee:'SHOP',amount:-20,account:'bank' }];
const seed = { name:'Shop',conditions:{merchant:'SHOP',operator:'equals',direction:'expense',account:'bank'},actions:{envelope:'food'} };
const button = text => [...document.querySelectorAll('button')].find(b => b.textContent === text);
it('previews without writing and persists a rule only after Save', async () => {
  openImportRuleEditor({ state,session:appStub.session,rows,seed,onSaved:()=>{} });
  expect(document.querySelector('.import-rule-preview').textContent).toContain('SHOP');
  expect(state.meta.importRules).toBeUndefined();
  button(t('common.save')).click(); await flush();
  expect(document.querySelector('.import-rule-error')?.textContent || '').toBe('');
  expect(state.meta.importRules).toHaveLength(1);
  expect(state.transactions).toEqual([]);
});
it('keeps the editor and entered values after a failed write', async () => {
  writeBatch.mockRejectedValueOnce(new Error('disk failed'));
  openImportRuleEditor({ state,session:appStub.session,rows,seed,onSaved:()=>{} });
  button(t('common.save')).click(); await flush();
  expect(document.querySelector('.import-rule-editor')).not.toBeNull();
  expect(state.meta.importRules).toBeUndefined();
  expect(button(t('common.save')).disabled).toBe(false);
});
it('closes the rule editor when its budget session ends', () => {
  openImportRuleEditor({ state,session:appStub.session,rows,seed,onSaved:()=>{} });
  beginBudgetSession();
  expect(document.querySelector('[data-sheet-open] .import-rule-editor')).toBeNull();
});
it('offers rule creation in an empty manager', () => {
  openImportRuleManager({ state,session:appStub.session,rows,onSaved:()=>{} });
  expect(button(t('importRules.create'))).toBeTruthy();
});

import { createImportRuleDraft } from '../js/import/rule-draft.js';
import { renderImportRuleControls } from '../js/import/rule-review-controls.js';
it('resolves a conflict by an explicit rendered choice', () => {
  state.envelopes.push({ id:'other',name:'Other' });
  state.meta.importRules = [{ ...seed,id:'a',enabled:true },{...seed,id:'b',enabled:true,actions:{envelope:'other'}}];
  const draft = createImportRuleDraft({data:state,rows,baselines:{x:{payee:'SHOP',envelope:null}}});
  const c = renderImportRuleControls({draft,state,onManage:()=>{},onRemember:()=>{},onChanged:()=>{}});
  document.body.append(c.renderRow('x'));
  expect(draft.approval(state).reason).toBe('conflicts');
  button('Food').click();
  expect(draft.approval(state).fieldsByKey.x.envelope).toBe('food');
  expect(draft.view()[0].provenance.envelope).toBe('manual');
});

it.each(['100-50','100oops'])('refuses malformed amount limit %s without saving', async value => {
  openImportRuleEditor({state,session:appStub.session,rows,seed});
  const max=document.querySelector('input[aria-label="'+t('importRules.maximum')+'"]');
  max.value=value; max.dispatchEvent(new Event('input',{bubbles:true}));
  expect(button(t('common.save')).disabled).toBe(true);
  document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  await flush(); expect(state.meta.importRules).toBeUndefined();
});
it('shows the actual matching conditions beside rule suggestions', () => {
  state.meta.importRules=[{...seed,id:'a',enabled:true,conditions:{...seed.conditions,minAmount:10,maxAmount:100}}];
  const draft=createImportRuleDraft({data:state,rows,baselines:{x:{payee:'SHOP',envelope:null}}});
  const controls=renderImportRuleControls({draft,state,onManage:()=>{},onRemember:()=>{},onChanged:()=>{}});
  const row=controls.renderRow('x');
  expect(row.textContent).toContain('SHOP');
  expect(row.textContent).toContain('Bank');
  expect(row.textContent).toContain(t('importRules.expense'));
  expect(row.textContent).toContain('100');
});
it('does not label background saved-rule matches as effects of an unrelated draft', () => {
  state.meta.importRules=[{...seed,id:'a',enabled:true}];
  openImportRuleEditor({state,session:appStub.session,rows,seed:{...seed,conditions:{...seed.conditions,merchant:'OTHER'}}});
  expect(document.querySelector('.import-rule-preview').textContent).toContain(t('importRules.noMatches'));
  expect(document.querySelector('.import-rule-preview').textContent).not.toContain('SHOP');
});
it('previews concrete before and after envelopes for affected rows', () => {
  state.envelopes.push({id:'other',name:'Other'});
  openImportRuleEditor({state,session:appStub.session,rows,seed,getCurrentValues:()=>({x:{payee:'SHOP',envelope:'other'}})});
  expect(document.querySelector('.import-rule-preview').textContent).toContain('Other → Food');
});

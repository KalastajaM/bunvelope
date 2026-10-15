// @vitest-environment jsdom
import { beforeEach, it, expect, vi } from 'vitest';
vi.mock('../js/app.js',async()=> (await import('./_fakes/pageApp.js')).appStub);
import { renderForecastReadiness } from '../js/ui/forecast-readiness.js';
import { render } from '../js/pages/net-worth.js';
import { t } from '../js/ui/i18n.js';
import { state,session,writeBatch,resetState,mountHosts,flush,setValue,navigate } from './_fakes/pageApp.js';
const root=()=>document.getElementById('app-root');
const panel=()=>root().querySelector('section.forecast-readiness');
const answer=()=>session.query('forecast.readiness',{}).value;
beforeEach(()=>{
  resetState();mountHosts();
  vi.stubGlobal('requestAnimationFrame',cb=>setTimeout(cb,0));
  vi.stubGlobal('ResizeObserver',class {observe(){} unobserve(){} disconnect(){}});
  vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}});
});
it('keeps evidence closed and routes a visible drift to the correct account without writes',()=>{
  state.accounts=[{id:'chk',name:'Checking',type:'bank',initialBalance:100,lastReconciledAt:'2026-09-14',lastReconciledLedger:105}];
  const seen=[];const el=renderForecastReadiness({answer:answer(),onAction:a=>seen.push(a)});root().append(el);
  const records=el.querySelector('[data-readiness-detail="accounts"]');
  expect(records.open).toBe(false);records.querySelector('summary').click();expect(records.open).toBe(true);
  expect(el.textContent).toContain(t('forecastReadiness.bankCoverageUnknown'));
  el.querySelector('[data-readiness-action="reconcile"]').click();expect(seen).toEqual([{kind:'reconcile',id:'chk'}]);expect(writeBatch).not.toHaveBeenCalled();
});
it('does not turn no listed issues into a complete-budget claim',()=>{
  state.accounts=[];const el=renderForecastReadiness({answer:answer()});
  expect(el.textContent).toContain(t('forecastReadiness.noChecks'));
  expect(el.textContent).toContain(t('forecastReadiness.unenteredUnknown'));
  expect(el.textContent).toContain(t('forecastReadiness.limits'));
});
it.each([['2026-09-14',undefined,'unverifiable'],['2026-09-16',100,'after-start']])('labels incomplete or later checkpoints honestly',(date,value,status)=>{
  state.accounts[0]={...state.accounts[0],lastReconciledAt:date,lastReconciledLedger:value};
  const el=renderForecastReadiness({answer:answer()});expect(el.textContent).toContain(t(`forecastReadiness.reconciliation.${status}`));
});
it('renders entity names as text and links an unusable scheduled item by id',()=>{
  state.budgetItems=[{id:'broken',description:'<img src=x onerror=alert(1)>',kind:'income',as_schedule:true,account_id:'missing',default_amount:10,payment_day:20,monthly_schedule:{Sep:true}}];
  const seen=[];const el=renderForecastReadiness({answer:answer(),onAction:a=>seen.push(a)});
  expect(el.querySelector('img')).toBeNull();expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  el.querySelector('[data-readiness-action="budgetItem"]').click();expect(seen).toEqual([{kind:'budgetItem',id:'broken'}]);
});
it('replaces successful evidence after a query failure and restores open details on recovery',async()=>{
  await render(root());panel().querySelector('[data-readiness-detail="accounts"] summary').click();
  const real=session.query.bind(session);const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const spy=vi.spyOn(session,'query').mockImplementation((name,input)=>name==='forecast.readiness'?{ok:false,error:{code:'bad_input'}}:real(name,input));
  try{
    setValue(root().querySelector('input[aria-label="'+t('netWorth.growthLabel')('Savings')+'"]'),'3',['change']);await flush();
    expect(panel().textContent).toContain(t('forecastReadiness.unavailable'));expect(panel().textContent).not.toContain('Checking');
  }finally{spy.mockRestore();warn.mockRestore();}
  setValue(root().querySelector('input[aria-label="'+t('netWorth.growthLabel')('Savings')+'"]'),'4',['change']);await flush();
  expect(panel().querySelector('[data-readiness-detail="accounts"]').open).toBe(true);
});
it('shows unsaved assumptions immediately and following transactions does not write',async()=>{
  await render(root());const stored=structuredClone(state.accounts);
  setValue(root().querySelector('input[aria-label="'+t('netWorth.growthLabel')('Savings')+'"]'),'3',['change']);await flush();
  expect(panel().textContent).toContain(t('forecastReadiness.draft'));
  panel().querySelector('[data-readiness-action="transactions"]').click();await flush();
  expect(navigate).toHaveBeenCalledWith('transactions','account:chk');expect(state.accounts).toEqual(stored);expect(writeBatch).not.toHaveBeenCalled();
});
it('opens the existing reconciliation sheet without committing a reconciliation',async()=>{
  await render(root());panel().querySelector('[data-readiness-action="reconcile"]').click();await flush();
  await vi.dynamicImportSettled();await flush();
  expect(document.querySelector('.sheet-overlay.open')).not.toBeNull();expect(writeBatch).not.toHaveBeenCalled();
});

it('clears evidence even when both readiness and projection fail',async()=>{
  await render(root());
  const real=session.query.bind(session);const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const spy=vi.spyOn(session,'query').mockImplementation((name,input)=>['forecast.readiness','netWorth.projection'].includes(name)?{ok:false,error:{code:'bad_input'}}:real(name,input));
  try{
    root().querySelector('.net-worth-source button').click();
    expect(panel().textContent).toContain(t('forecastReadiness.unavailable'));
  }finally{spy.mockRestore();warn.mockRestore();}
});
it('opens the matching plan item editor without recording or repairing the item',async()=>{
  state.budgetItems=[{id:'broken',description:'Salary to review',kind:'income',as_schedule:true,account_id:'missing',default_amount:10,payment_day:20,monthly_schedule:{Sep:true}}];
  await render(root());panel().querySelector('[data-readiness-action="budgetItem"]').click();
  await vi.dynamicImportSettled();await flush();
  expect(document.querySelector('.sheet-overlay.open #bp-f-description')?.value).toBe('Salary to review');
  expect(writeBatch).not.toHaveBeenCalled();
});
it('surfaces a plan/history review without opening details when it is the only signal',()=>{
  state.accounts=[{id:'chk',name:'Checking',type:'bank',initialBalance:0,lastReconciledAt:'2026-09-14',lastReconciledLedger:12000}];
  state.transactions=[{id:'salary',type:'income',account:'chk',amount:12000,date:'2026-09-14',cleared:true}];
  state.budgetItems=[];
  const evidence=answer();
  expect(evidence.summary).toEqual({reconciliationChecks:0,planChecks:0,estimateGroups:0,historyGap:true});
  const el=renderForecastReadiness({answer:evidence});
  const issue=el.querySelector('.forecast-readiness-issues');
  expect(issue.textContent).toContain(t('forecastReadiness.historyReview'));
  expect(issue.querySelector('[data-readiness-action="plan"]')).not.toBeNull();
  expect(issue.closest('details')).toBeNull();
});

it('shows only actionable exceptions with one primary action, keeping healthy and valuation accounts in details',()=>{
  const evidence=answer();
  evidence.accounts=[
    {id:'ok',name:'Quiet account',latestPostedDate:'2020-01-01',reconciliation:{status:'no-drift',date:'2026-09-14'}},
    {id:'missing',name:'Unchecked account',reconciliation:{status:'not-recorded'}},
    {id:'changed',name:'Changed account',reconciliation:{status:'drift',date:'2026-09-14',expected:100,actual:90,gap:-10}},
    {id:'asset',name:'Investment',reconciliation:{status:'not-applicable'}},
  ];
  evidence.checks=[];evidence.comparison.gap=false;
  const seen=[];const el=renderForecastReadiness({answer:evidence,onAction:a=>seen.push(a)});
  const issues=el.querySelector('.forecast-readiness-issues');
  expect(issues).not.toBeNull();
  expect(issues.textContent).not.toContain('Quiet account');
  expect(issues.textContent).not.toContain('Investment');
  expect(issues.querySelectorAll('button')).toHaveLength(2);
  const buttons=[...issues.querySelectorAll('button')];
  buttons.find(b=>b.dataset.readinessId==='missing').click();
  buttons.find(b=>b.dataset.readinessId==='changed').click();
  expect(seen).toEqual([{kind:'reconcile',id:'missing'},{kind:'reconcile',id:'changed'}]);
  expect(issues.querySelector('.forecast-readiness-issue--changed').textContent).toContain('Changed account');
  expect(issues.querySelector('.forecast-readiness-issue--changed').textContent).not.toContain('Unchecked account');
  const accounts=el.querySelector('[data-readiness-detail="accounts"]');
  expect(accounts.open).toBe(false);expect(accounts.textContent).toContain('Quiet account');
  expect(accounts.textContent).not.toContain(t('forecastReadiness.reconciliation.not-applicable'));
  expect(el.querySelector('[data-readiness-detail="assumptions"]').open).toBe(false);
});

it('does not count routine estimates or old transaction dates as problems',()=>{
  const evidence=answer();
  evidence.accounts=[{id:'ok',name:'Inactive savings',latestPostedDate:'2020-01-01',reconciliation:{status:'no-drift',date:'2026-09-14'}}];
  evidence.checks=[];evidence.comparison.gap=false;
  evidence.estimates=[{envelopeId:'food',envelopeName:'Estimated groceries',accountId:'ok',accountSource:'explicit',timing:'daily',firstDate:'2026-09-16',lastDate:'2027-09-15',rowCount:365}];
  const el=renderForecastReadiness({answer:evidence});
  expect(el.querySelector('.forecast-readiness-issues')).not.toBeNull();
  expect(el.querySelector('.forecast-readiness-issues').querySelectorAll('button')).toHaveLength(0);
  expect(el.querySelector('.forecast-readiness-issues').textContent).not.toContain('Estimated groceries');
  expect(el.querySelector('.forecast-readiness-issues').textContent).not.toContain('Inactive savings');
  expect(el.textContent).toContain(t('forecastReadiness.noDiscrepancies'));
  expect(el.textContent).toContain(t('forecastReadiness.limits'));
  expect(el.querySelector('[data-readiness-detail="assumptions"]').textContent).toContain('Estimated groceries');
});

it('keeps independently opened evidence disclosures across a projection repaint',async()=>{
  await render(root());
  const accounts=root().querySelector('[data-readiness-detail="accounts"]');
  const assumptions=root().querySelector('[data-readiness-detail="assumptions"]');
  expect(accounts).not.toBeNull();expect(assumptions).not.toBeNull();
  accounts.querySelector('summary').click();assumptions.querySelector('summary').click();
  setValue(root().querySelector('input[aria-label="'+t('netWorth.growthLabel')('Savings')+'"]'),'3',['change']);await flush();
  expect(root().querySelector('[data-readiness-detail="accounts"]').open).toBe(true);
  expect(root().querySelector('[data-readiness-detail="assumptions"]').open).toBe(true);
  expect(writeBatch).not.toHaveBeenCalled();
});

it('limits a matching checkpoint message to its date when later transactions exist',()=>{
  state.accounts=[{id:'chk',name:'Checking',type:'bank',initialBalance:100,lastReconciledAt:'2026-09-14',lastReconciledLedger:100}];
  state.transactions=[{id:'later',type:'expense',account:'chk',amount:10,date:'2026-09-15',cleared:true}];
  const el=renderForecastReadiness({answer:answer()});
  expect(el.querySelector('.forecast-readiness-issues').textContent).not.toContain('Checking');
  expect(el.querySelector('[data-readiness-detail="account:chk"]').textContent).toContain('The balance for the checked date matches your saved check.');
});
it('does not blame transaction edits when only the opening balance differs',()=>{
  state.accounts=[{id:'chk',name:'Checking',type:'bank',initialBalance:90,lastReconciledAt:'2026-09-14',lastReconciledLedger:100}];
  state.transactions=[];
  const el=renderForecastReadiness({answer:answer()});
  expect(el.querySelector('.forecast-readiness-issues').textContent).toContain('The balance for your last checked date does not match the saved check.');
  expect(el.querySelector('.forecast-readiness-issues').textContent).not.toContain('Earlier transactions have changed');
});

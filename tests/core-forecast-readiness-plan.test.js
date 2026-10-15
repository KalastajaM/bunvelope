import { describe, it, expect } from 'vitest';
import { planReadiness, estimateReadiness } from '../js/core/forecast-readiness.js';
import { stressCutFor } from '../js/engine/stress.js';
import { simulate } from '../js/engine/simulation.js';
const ALL=Object.fromEntries(['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map(m=>[m,true]));
const item={id:'salary',description:'Salary',kind:'income',include:true,as_schedule:true,account_id:'missing',default_amount:100,payment_day:15,monthly_schedule:ALL};
const fixture=()=>({meta:{country:'FI'},accounts:[{id:'bank',type:'bank',name:'Bank',initialBalance:1000}],envelopes:[{id:'food',name:'Food'}],transactions:[],budgetItems:[item],envelopeTemplates:[]});
const window={start:'2026-10-09',end:'2026-11-30'};
const check=fields=>planReadiness({...fixture(),budgetItems:[{...item,...fields}]},window).checks;
describe('forecast plan evidence',()=>{
  it('identifies an unusable included schedule once, without claiming missing income',()=>{
    expect(check({})).toEqual([{code:'scheduled-input-unavailable',scope:'base-plan',kind:'budgetItem',id:'salary',name:'Salary'}]);
    expect(planReadiness({...fixture(),budgetItems:[]},window).checks).toEqual([]);
  });
  it.each([{include:false},{as_schedule:false},{end_month:'2026-09'},{start_month:'2026-12'},{monthly_schedule:{Oct:false,Nov:false}},{default_amount:0}])('ignores inactive or empty schedules %j',fields=>expect(check(fields)).toEqual([]));
  it.each([{kind:'account_transfer',account_id:'bank',to_account_id:'missing'},{kind:'account_transfer',account_id:'bank',to_account_id:'bank'},{kind:'expense',account_id:'bank',envelope_id:'missing'}])('checks required endpoints %j',fields=>expect(check(fields)).toHaveLength(1));
  it('accepts unallocated expenses and follows scheduler eligibility for archived accounts',()=>{
    expect(check({kind:'expense',account_id:'bank'})).toEqual([]);
    const d=fixture();d.accounts[0].archived=true;d.budgetItems=[{...item,account_id:'bank'}];
    expect(planReadiness(d,window).checks).toEqual([]);
  });
  it('honours owned, skipped and tombstoned occurrences',()=>{
    const d=fixture();d.transactions=[{id:'paid',from_budget:'salary:2026-10'}];d.meta.scheduledTombstones=['salary:2026-11'];
    expect(planReadiness(d,window).checks).toEqual([]);
    expect(check({skipped_occurrences:['2026-10','2026-11']})).toEqual([]);
  });
  it('includes zero target transfers only when their shifted payment falls inside the horizon',()=>{
    const d=fixture();d.budgetItems=[{...item,kind:'account_transfer',transfer_mode:'target_balance',target_balance:0,default_amount:0,payment_day:31,schedule_day_type:'next_work_day',monthly_schedule:{Oct:true},end_month:'2026-10'}];
    expect(planReadiness(d,{start:'2026-10-09',end:'2026-10-31'}).checks).toEqual([]);
    expect(planReadiness(d,{start:'2026-11-01',end:'2026-11-02'}).checks).toHaveLength(1);
  });
  it('requires usable card funding even when the card or its payer is filtered out',()=>{
    const d=fixture();d.budgetItems=[];d.accounts.push({id:'card',name:'Card',type:'credit_card'});
    expect(planReadiness(d,window).checks).toEqual([{code:'card-funding-unavailable',scope:'base-plan',kind:'account',id:'card',name:'Card'}]);
    d.accounts[1].settledFrom='bank';
    expect(planReadiness(d,{...window,excludeAccounts:['bank']}).checks).toEqual([]);
  });
});
describe('actual forecast estimate evidence',()=>{
  const source=()=>({...fixture(),accounts:[...fixture().accounts,{id:'other',type:'bank',name:'Other'}],envelopes:[{id:'food',name:'Food',forecast_account_shares:[{account_id:'bank',percent:50},{account_id:'other',percent:50}]}],budgetItems:[{id:'food-plan',kind:'expense',include:true,envelope_id:'food',funding_style:'spending',default_amount:-600,monthly_schedule:{Nov:true}}]});
  it('groups actual daily account allocations once within the simulated horizon',()=>{
    const sim=simulate({source:source(),today:new Date(2026,9,9,12),months:1});
    expect(estimateReadiness(sim)).toEqual(['bank','other'].map(accountId=>({envelopeId:'food',accountId,accountSource:'override',confidence:'override',timing:'daily',firstDate:'2026-11-01',lastDate:'2026-11-30',rowCount:30})));
  });
  it('excludes posted markers, growth, zero effects and rows outside the horizon',()=>{
    const sim=simulate({source:source(),today:new Date(2026,9,9,12),months:1});
    const row=sim.rows.find(r=>r.forecast_estimate);
    expect(estimateReadiness({...sim,rows:[{...row,is_forecast:false},{...row,sim:true},{...row,amount:0},{...row,date:'2026-12-01'}]})).toEqual([]);
  });
  it('uses scenario-transformed rows instead of regenerating removed estimates',()=>{
    const d=source(); d.budgetItems[0].stress_category='B'; d.budgetItems[0].stress_cut_pcts={B:1};
    const sim=simulate({source:d,today:new Date(2026,9,9,12),months:1,scenario:{id:'cut',changes:[{type:'stress',scenario:'B',from:'2026-10'}]},stressCut:stressCutFor});
    expect(estimateReadiness(sim)).toEqual([]);
  });
});

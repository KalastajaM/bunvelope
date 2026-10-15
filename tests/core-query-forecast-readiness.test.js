import { describe, it, expect } from 'vitest';
import { registry } from '../js/core/index.js';
import { runQuery } from '../js/core/pipeline.js';
import { makeCtx } from '../js/core/context.js';
import { simulate } from '../js/engine/simulation.js';
const today=new Date(2026,9,9,12);
const ctx=makeCtx({now:today,newId:()=> 'unused'});
const fixture=()=>({meta:{schemaVersion:8,country:'FI'},accounts:[{id:'bank',name:'Bank',type:'bank',initialBalance:100}],envelopes:[{id:'food',name:'Food'}],budgetItems:[],envelopeTemplates:[],transactions:[]});
const ask=(d,input={},name='forecast.readiness')=>runQuery(registry,d,name,input,ctx);
function freeze(o){if(o && typeof o==='object'){Object.freeze(o);Object.values(o).forEach(freeze);}return o;}
describe('forecast.readiness query',()=>{
  it('exposes evidence with a fixed horizon and no completeness score',()=>{
    const r=ask(fixture());expect(r.ok).toBe(true);
    expect(r.value).toMatchObject({start:'2026-10-09',end:'2028-10-31',months:24,assumptions:{whatIf:null,limitations:expect.arrayContaining(['bank-coverage-unknown'])}});
    expect(r.value).not.toHaveProperty('confidenceScore');
    expect(r.value.comparison).toMatchObject({scope:'base-plan',history:{startExclusive:'2025-10-09',endInclusive:'2026-10-09',months:12},planWindow:{startExclusive:'2027-10-31',endInclusive:'2028-10-31',months:12}});
  });
  it('rejects unknown scenarios like the forecast query',()=>expect(ask(fixture(),{whatIf:'absent'})).toMatchObject({ok:false,error:{code:'not_found'}}));
  it('keeps explicit zero overrides and their provenance',()=>{
    const d=fixture();d.accounts[0].expectedGrowth=4;d.accounts[0].plannedMonthly=100;
    expect(ask(d,{accountOverrides:[{id:'bank',expectedGrowth:0,plannedMonthly:0}]}).value.assumptions.accounts[0]).toMatchObject({id:'bank',growthPct:0,growthSource:'set',contribution:0,contributionSource:'set',overriddenFields:['expectedGrowth','plannedMonthly']});
  });
  it('handles empty sources and keeps excluded dependency accounts without counting their contributions',()=>{
    const empty={...fixture(),accounts:[],envelopes:[]};expect(ask(empty).value.accounts).toEqual([]);
    const d=fixture();d.accounts.push({id:'card',name:'Card',type:'credit_card',settledFrom:'bank',initialBalance:-50});
    d.budgetItems=[{id:'transfer',kind:'account_transfer',as_schedule:true,account_id:'bank',to_account_id:'card',default_amount:50,payment_day:15,monthly_schedule:{Nov:true}}];
    const r=ask(d,{excludeAccounts:['bank','card']}).value;
    expect(r.accounts.every(a=>a.excluded)).toBe(true);expect(r.checks).toEqual([]);expect(r.comparison).toMatchObject({plan:0,actual:0});
  });
  it('uses selected scenario estimates while keeping the comparison explicitly base-plan',()=>{
    const d=fixture();d.meta.whatIfScenarios=[{id:'cut',name:'Cut',changes:[{type:'stress',scenario:'B',from:'2026-10'}]}];
    d.budgetItems=[{id:'food-plan',kind:'expense',envelope_id:'food',funding_style:'spending',default_amount:-600,monthly_schedule:{Nov:true},stress_category:'B',stress_cut_pcts:{B:1}}];
    const base=ask(d,{months:1}).value;expect(base.estimates.length).toBeGreaterThan(0);
    const cut=ask(d,{months:1,whatIf:'cut'}).value;expect(cut.estimates).toEqual([]);expect(cut.comparison).toEqual(base.comparison);expect(cut.assumptions.whatIf).toEqual({id:'cut',name:'Cut'});
  });
  it.each([['2028-02-29','2027-03-01','2028-02-29','2028-03-31'],['2026-10-31','2025-10-31','2026-10-31','2026-11-30']])('matches the existing history and contribution windows at %s',(date,historyStart,planStart,end)=>{
    const r=ask(fixture(),{date,months:1}).value;
    expect(r.comparison.history.startExclusive).toBe(historyStart);expect(r.comparison.planWindow).toEqual({startExclusive:planStart,endInclusive:end,months:1});
  });
  it('returns detached evidence and leaves forecast outputs and cached simulation objects unchanged',()=>{
    const d=freeze(fixture());const before=ask(d,{},'forecast.simulation');const proj=ask(d,{},'netWorth.projection');
    const cached=simulate({source:d,today,months:24,shiftPct:0,trackAlerts:true});const snapshot=structuredClone(cached);
    const r=ask(d).value;r.accounts[0].name='Changed';r.assumptions.accounts[0].growthPct=99;
    expect(ask(d,{},'forecast.simulation')).toEqual(before);expect(ask(d,{},'netWorth.projection')).toEqual(proj);
    expect(simulate({source:d,today,months:24,shiftPct:0,trackAlerts:true})).toBe(cached);expect(cached).toEqual(snapshot);
  });
});

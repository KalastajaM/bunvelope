import { describe, it, expect } from 'vitest';
import { accountReadiness } from '../js/core/forecast-readiness.js';
const account = fields => ({id:'bank',name:'Bank',type:'bank',initialBalance:100,...fields});
const tx = fields => ({id:'t',type:'expense',account:'bank',amount:5,date:'2026-10-08',...fields});
const read = (a={},transactions=[]) => accountReadiness({accounts:[account(a)],transactions},'2026-10-09')[0];

describe('forecast account evidence', () => {
  it('does not turn future, scheduled, forecast or invalid dates into current ledger evidence', () => {
    expect(read({},[tx(),tx({date:'2026-10-10'}),tx({date:'2026-10-09',status:'scheduled'}),tx({date:'2026-10-09',is_forecast:true}),tx({date:'2026-02-30'})])).toMatchObject({latestPostedDate:'2026-10-08',reconciliation:{status:'not-recorded'}});
  });
  it('attributes transfers to both endpoints and split expenses to their account', () => {
    const rows=accountReadiness({accounts:[account(),account({id:'other'})],transactions:[tx({type:'account_transfer',from_account:'bank',to_account:'other'}),tx({date:'2026-10-09',envelope_splits:[{envelope_id:'a',amount:2},{envelope_id:'b',amount:3}]})]},'2026-10-09');
    expect(rows.map(r=>r.latestPostedDate)).toEqual(['2026-10-09','2026-10-08']);
  });
  it('does not count zero effects or envelope-only movements as bank activity', () => {
    expect(read({},[tx({amount:0}),tx({type:'envelope_transfer',from_envelope_id:'a',to_envelope_id:'b'})]).latestPostedDate).toBeNull();
  });
  it('keeps excluded and empty accounts but omits archived accounts', () => {
    const rows=accountReadiness({accounts:[account(),account({id:'old',archived:true})],transactions:[]},'2026-10-09',['bank']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({excluded:true,latestPostedDate:null});
  });
  it.each([
    [{},'not-recorded',null],
    [{lastReconciledAt:'2026-10-08'},'unverifiable',null],
    [{lastReconciledAt:'2026-02-30',lastReconciledLedger:100},'unverifiable',null],
    [{lastReconciledAt:'bad',lastReconciledLedger:100},'unverifiable',null],
    [{lastReconciledAt:'2026-10-10',lastReconciledLedger:100},'after-start',null],
    [{lastReconciledAt:'2026-10-08',lastReconciledLedger:100},'no-drift',0],
    [{lastReconciledAt:'2026-10-08',lastReconciledLedger:0,initialBalance:0},'no-drift',0],
    [{type:'investment'},'not-applicable',null],
    [{type:'asset'},'not-applicable',null],
  ])('distinguishes checkpoint evidence %j', (a,status,gap) => {
    expect(read(a).reconciliation).toMatchObject({status,gap});
  });
  it('uses the ledger checkpoint before statement fallback and detects signed drift', () => {
    const a={lastReconciledAt:'2026-10-08',lastReconciledLedger:100,lastReconciledBalance:95};
    expect(read(a,[tx({cleared:true})]).reconciliation).toMatchObject({status:'drift',expected:100,actual:95,gap:-5,checkpointSource:'ledger'});
    expect(read({...a,lastReconciledLedger:undefined},[tx({cleared:true})]).reconciliation).toMatchObject({status:'no-drift',expected:95,actual:95,gap:0,checkpointSource:'statement-fallback'});
  });
  it('does not mutate frozen input or share mutable evidence with it', () => {
    const a=Object.freeze(account({lastReconciledAt:'2026-10-08',lastReconciledLedger:100}));
    const data=Object.freeze({accounts:Object.freeze([a]),transactions:Object.freeze([])});
    const row=accountReadiness(data,'2026-10-09')[0];
    row.name='Changed'; row.reconciliation.expected=5;
    expect(a.name).toBe('Bank'); expect(a.lastReconciledLedger).toBe(100);
  });
});

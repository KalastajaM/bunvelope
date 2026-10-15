import { ok, fail } from '../result.js';
import { isoDate } from '../context.js';
import { refDate } from '../lens-input.js';
import { ACCOUNT_OVERRIDES_INPUT, withAccountOverrides, whatIfScenarios, NONE, countedAccounts, cachedAverages, contributionTable, planGap } from '../projection.js';
import { accountReadiness, planReadiness, estimateReadiness } from '../forecast-readiness.js';
import { simulate } from '../../engine/simulation.js';
import { stressCutFor } from '../../engine/stress.js';
import { round2 } from '../../utils.js';

export default {
  name:'forecast.readiness',
  summary:'Read-only evidence behind the forecast: account records, unusable scheduled inputs, actual spending estimates and assumptions. No completeness or confidence score. Exclusions filter comparison totals, not dependency checks. Comparison and account assumptions describe the base plan; estimates describe the selected scenario.',
  input:{type:'object',properties:{
    date:{type:'date',description:'Forecast start, default today'},
    months:{type:'integer',minimum:1,maximum:60,default:24,description:'Months after the start month'},
    excludeAccounts:{type:'array',items:{type:'ref',kind:'account'}},
    accountOverrides:ACCOUNT_OVERRIDES_INPUT,
    whatIf:{type:'string',description:'Saved what-if scenario id'},
    contribution:{enum:['plan','history'],default:'plan',description:'Contribution source for extrapolation after the simulation, not the near-term walk'},
  }},
  run(data,input,ctx) {
    const stored=data.accounts || NONE;
    let scenario=null;
    if (input.whatIf !== undefined) {
      scenario=whatIfScenarios(data.meta?.whatIfScenarios,stored,data.budgetItems || NONE).find(s=>s.id===input.whatIf) || null;
      if (!scenario) return fail('not_found',{kind:'whatIf',id:input.whatIf});
    }
    const today=refDate(input,ctx);
    const {source,accounts}=withAccountOverrides(data,input.accountOverrides);
    const base=simulate({source,today,months:input.months,shiftPct:0,trackAlerts:true});
    const selected=scenario ? simulate({source,today,months:input.months,shiftPct:0,trackAlerts:true,scenario,stressCut:stressCutFor}) : base;
    const counted=countedAccounts(accounts,input.excludeAccounts).filter(a=>a && !a.archived);
    const averages=cachedAverages(stored,input.excludeAccounts,data.transactions || NONE,today);
    const table=contributionTable(counted,{opening:base.opening.accounts,lastYearContribution:base.lastYearContribution,averages,source:input.contribution});
    const evidence=accountReadiness(source,base.startDate,input.excludeAccounts);
    const {checks}=planReadiness(source,{start:base.startDate,end:base.endDate});
    const estimates=estimateReadiness(selected).map(e=>({...e,envelopeName:(data.envelopes || []).find(env=>env.id===e.envelopeId)?.name || null}));
    const months=Math.min(12,input.months);
    return ok({
      start:base.startDate,end:base.endDate,months:input.months,accounts:evidence,checks,estimates,
      comparison:{scope:'base-plan',plan:table.plan,actual:table.actual,gap:planGap(table),
        history:{startExclusive:isoDate(new Date(today.getFullYear(),today.getMonth()-12,today.getDate())),endInclusive:base.startDate,months:12},
        planWindow:{startExclusive:isoDate(new Date(today.getFullYear(),today.getMonth()+input.months-months+1,0)),endInclusive:base.endDate,months}},
      assumptions:{whatIf:scenario ? {id:scenario.id,name:scenario.name} : null,contribution:input.contribution,
        accounts:table.rows.map(({account,growth,contribution})=>({id:account.id,growthPct:growth.pct,growthSource:growth.source,contribution:round2(contribution.amount),contributionSource:contribution.source,
          overriddenFields:['expectedGrowth','plannedMonthly'].filter(field=>(input.accountOverrides || []).some(o=>o.id===account.id && Object.hasOwn(o,field)))})),
        excludedAccounts:evidence.filter(a=>a.excluded).map(a=>a.id),
        limitations:['bank-coverage-unknown','unentered-plan-items-unknown','rate-band-is-sensitivity']},
      summary:{reconciliationChecks:evidence.filter(a=>!['no-drift','not-applicable'].includes(a.reconciliation.status)).length,planChecks:checks.length,estimateGroups:estimates.length,historyGap:planGap(table)},
    });
  },
};

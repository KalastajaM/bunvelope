import { t } from './i18n.js';
import { fmt, fmtNum } from '../utils.js';

const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const tr = key => t(`forecastReadiness.${key}`);

/** Evidence only: the page owns routing and the core query owns every figure. */
export function renderForecastReadiness({answer,unavailable=false,onAction=()=>{},draftAssumptions=false}) {
  const panel = el('section', undefined, 'forecast-readiness card');
  panel.append(el('h3', tr('thingsToCheck')));
  if (unavailable || !answer) {
    panel.append(el('p', tr('unavailable')));
    return panel;
  }
  const {accounts,checks,estimates,comparison,assumptions} = answer;
  const action = (label,kind,id) => {
    const btn = el('button',label,'btn btn-sm btn-ghost');
    btn.type = 'button';
    btn.dataset.readinessAction = kind;
    if (id) btn.dataset.readinessId = id;
    btn.addEventListener('click',()=>onAction(id ? {kind,id} : {kind}));
    return btn;
  };
  const disclosure = (label,key) => {
    const node = el('details',undefined,'forecast-readiness-details');
    node.dataset.readinessDetail = key;
    node.append(el('summary',label));
    return node;
  };
  const issues = el('ul',undefined,'forecast-readiness-issues');
  panel.append(issues);
  const issue = (name,message,button,{changed=false,excluded=false}={}) => {
    const row = el('li',undefined,'forecast-readiness-issue'+(changed?' forecast-readiness-issue--changed':''));
    const description = el('div');
    description.append(el('strong',name));
    if (changed) description.append(el('span',tr('changedRecords'),'forecast-readiness-tag'));
    if (excluded) description.append(el('span',tr('excluded'),'forecast-readiness-tag'));
    description.append(el('p',message));
    row.append(description,button);
    issues.append(row);
  };
  for (const account of accounts) {
    const status = account.reconciliation.status;
    // An old transaction alone is not a problem. Valuation accounts do not
    // need bank reconciliation; keep them in the optional account evidence.
    if (status === 'no-drift' || status === 'not-applicable') continue;
    issue(account.name,tr(`accountCheck.${status}`),
      action(tr(status === 'drift' ? 'reviewChanges' : 'reconcile'),'reconcile',account.id),
      {changed:status === 'drift',excluded:account.excluded});
  }
  for (const check of checks) {
    issue(check.name,tr(`checks.${check.code}`),
      action(tr('checkSettings'),check.kind === 'account' ? 'account' : 'budgetItem',check.id));
  }
  if (comparison.gap) issue(tr('historyReview'),tr('historyGap'),action(tr('openPlan'),'plan'));
  if (!issues.children.length) panel.append(el('p',tr('noDiscrepancies')));
  panel.append(el('p',tr('limits'),'muted'));
  if (draftAssumptions) panel.append(el('p',tr('draft'),'forecast-readiness-draft'));

  const records = disclosure(tr('viewAccounts'),'accounts');
  panel.append(records);
  const list = el('ul',undefined,'forecast-readiness-account-list');
  records.append(list);
  for (const account of accounts) {
    const row = el('li');
    const heading = el('div',undefined,'forecast-readiness-account-heading');
    heading.append(el('strong',account.name));
    if (account.excluded) heading.append(el('span',tr('excluded'),'forecast-readiness-tag'));
    const reconciliation = account.reconciliation;
    if (reconciliation.date) heading.append(el('span',tr('checkpoint')(reconciliation.date),'muted'));
    else if (reconciliation.status !== 'not-applicable') heading.append(el('span',tr('reconciliation.not-recorded'),'muted'));
    row.append(heading);
    const details = disclosure(tr('technicalDetails'),'account:'+account.id);
    details.append(el('p',tr('latest')(account.latestPostedDate || tr('unknown'))));
    if (reconciliation.status !== 'not-applicable') {
      details.append(el('p',tr(`reconciliation.${reconciliation.status}`)),el('p',tr('bankCoverageUnknown'),'muted'));
    }
    if (reconciliation.status === 'drift') details.append(el('p',tr('driftAmounts')(fmt(reconciliation.expected),fmt(reconciliation.actual),fmt(reconciliation.gap,{signed:true}))));
    if (reconciliation.checkpointSource === 'statement-fallback') details.append(el('p',tr('statementFallback'),'muted'));
    const actions = el('div',undefined,'forecast-readiness-actions');
    actions.append(action(tr('transactions'),'transactions',account.id),
      action(tr(reconciliation.status === 'not-applicable' ? 'accountSettings' : 'reconcile'),reconciliation.status === 'not-applicable' ? 'account' : 'reconcile',account.id));
    details.append(actions);
    row.append(details);
    list.append(row);
  }
  if (!accounts.length) records.append(el('p',tr('noAccounts')));

  const calculation = disclosure(tr('howCalculated'),'assumptions');
  panel.append(calculation);
  calculation.append(el('p',tr('window')(answer.start,answer.end),'muted'));
  const plan = el('section',undefined,'forecast-readiness-section');
  calculation.append(plan);
  plan.append(el('h4',tr('comparison')),el('p',tr('unenteredUnknown'),'muted'));
  if (!checks.length) plan.append(el('p',tr('noChecks')));
  plan.append(el('p',tr('comparisonAmounts')(fmt(comparison.plan,{signed:true}),fmt(comparison.actual,{signed:true}))),
    el('p',tr('comparisonWindows')(comparison.planWindow.startExclusive,comparison.planWindow.endInclusive,comparison.history.startExclusive,comparison.history.endInclusive),'muted'));
  const inputs = el('section',undefined,'forecast-readiness-section');
  inputs.append(el('h4',tr('assumptions')));
  calculation.append(inputs);
  inputs.append(el('p',assumptions.whatIf?tr('scenario')(assumptions.whatIf.name):tr('baseScenario')));
  inputs.append(el('p',tr('laterSource')(tr(`sources.${assumptions.contribution}`)),'muted'),el('p',tr('sensitivity'),'muted'));
  const assumptionList=el('ul',undefined,'forecast-readiness-list');inputs.append(assumptionList);
  for(const a of assumptions.accounts){
    const record=accounts.find(r=>r.id===a.id);
    const li=el('li');li.append(el('strong',record?.name || a.id),el('p',tr('accountAssumptions')(a.growthPct===null?tr('unknown'):fmtNum(a.growthPct)+'%',tr(`sources.${a.growthSource}`),fmt(a.contribution,{signed:true}),tr(`sources.${a.contributionSource}`))));
    assumptionList.append(li);
  }
  if(estimates.length){
    inputs.append(el('h5',tr('estimates')),el('p',tr('estimateMeaning'),'muted'));
    const ul=el('ul',undefined,'forecast-readiness-list');inputs.append(ul);
    for(const e of estimates){
      const li=el('li');const name=e.envelopeName || e.envelopeId || tr('unassigned');
      const account=accounts.find(a=>a.id===e.accountId)?.name || e.accountId || tr('unassigned');
      li.append(el('strong',name),el('p',tr('estimateLine')(account,tr(`allocation.${e.accountSource}`),tr(`timing.${e.timing}`))),el('p',tr('estimateDates')(e.firstDate,e.lastDate,e.rowCount),'muted'));
      if(['limited','variable','established'].includes(e.confidence)) li.append(el('p',t(`spendingProfile.${e.confidence}`),'muted'));
      if(e.envelopeId) li.append(action(tr('review'),'envelope',e.envelopeId));
      ul.append(li);
    }
  }
  return panel;
}

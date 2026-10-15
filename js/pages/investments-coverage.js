// Presentation of query diagnostics; provenance comes from the shared query.
import { state, navigate } from '../app.js';
import { node, disclosure } from '../ui/planning-workspace.js';
import { t } from '../ui/i18n.js';
import { openSheet } from '../ui/sheet.js';
import { currentBudgetSession } from '../state/budget-session.js';

export function buildCoverage(issues, accounts, { recordPrice, refresh, valuations }) {
  const label = key => t(`performance.${key}`);
  const generation = currentBudgetSession(), folder = state.budgetFolder;
  const isCurrent = () => generation === currentBudgetSession() && folder === state.budgetFolder;
  const groups = new Map();
  for (const issue of issues) {
    const key = JSON.stringify([issue.accountId, issue.symbol]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(issue);
  }
  const action = (text, run) => {
    const button = node('button', 'btn btn-sm btn-ghost', text); button.type = 'button';
    button.addEventListener('click', () => { if (isCurrent()) run(); });
    return button;
  };
  const history = async issue => {
    const { buildHoldingDetail } = await import('./investments.js');
    if (!isCurrent()) return;
    const account = accounts.find(a => a.id === issue.accountId);
    if (!account) return;
    const content = node('div', 'performance-history');
    const draw = () => {
      if (!isCurrent()) return;
      content.replaceChildren(buildHoldingDetail(account, issue.symbol, { onChange: () => { draw(); refresh(); } }));
    };
    draw();
    openSheet({ title: `${account.name} · ${issue.symbol}`, content, wide: true, onClose: () => {
      // Refresh the portfolio header and hidden holdings panels after corrections too.
      if (isCurrent() && state.currentPage === 'investments') navigate('investments');
    } });
  };
  const edit = async issue => {
    const { openEditTx } = await import('./edit-tx.js');
    if (!isCurrent()) return;
    const tx = state.transactions.find(row => row.id === issue.transactionId);
    if (tx) openEditTx(tx, { onAfterChange: refresh });
    else {
      state.pendingFilter = { account: issue.accountId, type: 'investment_transfer' };
      navigate('transactions');
    }
  };
  const sections = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    const section = node('section', 'performance-coverage-group');
    section.append(node('h3', '', [accounts.find(a => a.id === first.accountId)?.name || first.accountId,
      first.symbol || (first.accountId ? label('unknownSymbol') : label('title'))].filter(Boolean).join(' · ')));
    const byCode = new Map();
    for (const issue of rows) {
      if (!byCode.has(issue.code)) byCode.set(issue.code, []);
      byCode.get(issue.code).push(issue);
    }
    const priority = ['invalid_date', 'missing_symbol', 'invalid_cash', 'missing_units', 'undated_holding', 'oversold_units', 'manual_adjustment', 'missing_price', 'stale_price'];
    const sorted = [...byCode].sort(([a], [b]) => (priority.indexOf(a) < 0 ? 99 : priority.indexOf(a)) - (priority.indexOf(b) < 0 ? 99 : priority.indexOf(b)));
    const secondary = [];
    for (const [code, entries] of sorted) {
      const item = node('div', 'performance-coverage-issue');
      if (code === 'carried_price') {
        item.append(node('p', '', label('earlierPriceHelp')));
        const holding = valuations?.holdings.find(h => h.accountId === first.accountId && h.symbol === first.symbol);
        for (const [boundary, date] of [['opening', valuations?.openingDate], ['closing', valuations?.to]]) {
          const value = holding?.[boundary];
          if (!value?.priceDate || value.priceDate === date) continue;
          item.append(node('p', '', label('earlierPriceUsed')(label(boundary === 'opening' ? 'openingValue' : 'closingValue'), date, value.priceDate)));
          item.append(action(label('recordPrice'), () => recordPrice({ ...first, date })));
        }
        section.append(item);
        continue;
      }
      const dates = [...new Set(entries.map(i => i.date).filter(Boolean))].sort();
      item.append(node('p', '', label(`issues.${code}`)), node('p', 'muted',
        [label('occurrences')(entries.length), dates.length > 1 ? `${dates[0]} → ${dates.at(-1)}` : dates[0]].filter(Boolean).join(' · ')));
      const details = node('ul', 'performance-coverage-records');
      const priceIssue = code === 'missing_price' || code === 'stale_price';
      for (const issue of entries) {
        const row = node('li');
        row.append(node('span', '', issue.date || label('unknownDate')));
        if (priceIssue) row.append(action(label('recordPrice'), () => recordPrice(issue)));
        else if (issue.transactionId) {
          const tx = state.transactions.find(tx => tx.id === issue.transactionId);
          if (tx?.payee) row.append(node('span', 'muted', tx.payee));
          row.append(action(label('openTransaction'), () => edit(issue)));
        }
        details.append(row);
      }
      if (priceIssue && entries.length === 1) item.append(action(label('recordPrice'), () => recordPrice(entries[0])));
      else if (entries.length === 1 && entries[0].transactionId && code !== 'oversold_units') item.append(action(label('openTransaction'), () => edit(entries[0])));
      else if (entries.length > 1 || entries.some(i => i.transactionId) || priceIssue) item.append(disclosure(label('reviewRecords'), [details]));
      if (first.symbol && (entries.some(i => i.manualRowId) || ['undated_holding', 'oversold_units'].includes(code))) {
        item.append(action(label('reviewHistory'), () => history(first)));
      }
      if (['invalid_date', 'missing_symbol', 'invalid_cash', 'missing_units'].includes(code) && entries.some(i => !i.transactionId && !i.manualRowId)) {
        item.append(action(label('reviewRecords'), () => {
          state.pendingFilter = { account: first.accountId, type: 'investment_transfer' };
          navigate('transactions');
        }));
      }
      if (code === 'manual_adjustment') item.append(action(label('changePeriod'), () => {
        const from = section.closest('.investment-performance')?.querySelector('input[type=date]');
        from?.focus();
      }));
      if (!entries[0].blocking || (code === 'oversold_units' && byCode.has('missing_units'))) secondary.push(item);
      else section.append(item);
    }
    if (secondary.length) section.append(disclosure(label('relatedChecks'), secondary));
    sections.push(section);
  }
  return disclosure(label('coverage'), sections, issues.some(i => i.blocking));
}

import { moneyEl, amountText } from '../ui/money.js';
// Period figures come only from the shared query; filters and price entry stay here.
import { state, session, now as appNow } from '../app.js';
import { isoDate } from '../core/context.js';
import { ask } from '../ui/query.js';
import { node, disclosure } from '../ui/planning-workspace.js';
import { t } from '../ui/i18n.js';
import { fmtNum } from '../utils.js';
import { fmtMoney } from './investments-shared.js';
import { buildCoverage } from './investments-coverage.js';
import { currentBudgetSession } from '../state/budget-session.js';
import { dispatchOrReport } from '../ui/save-error.js';

let savedFilters = null;
export function buildPerformanceCard() {
  const generation = currentBudgetSession(), folder = state.budgetFolder;
  const isCurrent = () => currentBudgetSession() === generation && state.budgetFolder === folder;
  const previous = savedFilters?.generation === generation && savedFilters.folder === folder ? savedFilters : null;
  const today = isoDate(appNow());
  const accounts = (state.accounts || []).filter(a => a.type === 'investment' && a.trackInvestments !== false);
  const card = node('div', 'card investment-performance');
  const label = key => t(`performance.${key}`);
  card.append(node('h2', 'card-title', label('title')), node('p', 'muted', label('scope')));
  const filters = node('form', 'filters');
  filters.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;align-items:end;margin:16px 0';
  const field = (parent, text, type, value) => {
    const wrap = node('label', 'field', text);
    const input = node('input');
    input.type = type; input.value = value; input.required = true;
    wrap.append(input); parent.append(wrap); return input;
  };
  const from = field(filters, label('from'), 'date', previous?.from || `${today.slice(0, 4)}-01-01`);
  const to = field(filters, label('to'), 'date', previous?.to || today);
  from.max = today; to.max = today;
  const accountWrap = node('label', 'field', label('account'));
  const account = node('select');
  const all = node('option', '', label('allAccounts')); all.value = ''; account.append(all);
  for (const a of accounts) {
    const option = node('option', '', a.name); option.value = a.id; account.append(option);
  }
  account.value = previous?.account || '';
  accountWrap.append(account); filters.append(accountWrap);
  const show = node('button', 'btn btn-accent', label('show')); show.type = 'submit'; filters.append(show);
  const result = node('div'); result.setAttribute('aria-live', 'polite');
  const draw = () => {
    if (!isCurrent()) return;
    result.replaceChildren();
    to.setCustomValidity(from.value > to.value ? label('invalidPeriod') : '');
    if (!filters.reportValidity()) return;
    savedFilters = { generation, folder, from: from.value, to: to.value, account: account.value };
    const data = ask('investments.performance', { from: from.value, to: to.value, ...(account.value ? { account: account.value } : {}) });
    if (!data) { result.append(node('p', '', label('failed'))); return; }
    const grid = node('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:16px;margin:20px 0';
    const stat = (key, value) => {
      const box = node('div', 'money-metric'); box.append(node('div', 'muted', label(key)), amountText(value)); grid.append(box);
    };
    stat('personalReturn', data.returnPct == null ? '—' : `${fmtNum(data.returnPct, { maxDecimals: 2 })}%`);
    stat('gain', data.gain == null ? '—' : fmtMoney(data.gain));
    result.append(grid, node('p', 'muted', data.complete ? label('estimate') : label('incomplete')));
    if (data.complete) {
      const amounts = node('div'); amounts.style.cssText = grid.style.cssText;
      for (const key of ['openingValue', 'closingValue', 'contributions', 'withdrawals', 'dividends']) {
        const box = node('div', 'money-metric'); box.append(node('div', 'muted', label(key)), moneyEl(data[key], { role: 'summary' })); amounts.append(box);
      }
      result.append(amounts);
    }
    if (data.issues.length) {
      result.append(buildCoverage(data.issues, accounts, { refresh: draw, valuations: data, recordPrice: issue => {
        priceStatus.textContent = '';
        symbol.value = issue.symbol; date.value = issue.date; price.value = '';
        priceDisclosure.open = true; price.focus();
      } }));
    }
    const scroll = node('div'); scroll.style.overflowX = 'auto';
    const table = node('table'); table.style.cssText = 'width:100%;min-width:600px';
    const header = node('tr');
    for (const key of ['account', 'symbol', 'openingValue', 'closingValue']) header.append(node('th', '', label(key)));
    const thead = node('thead'); thead.append(header); table.append(thead);
    const tbody = node('tbody');
    for (const holding of data.holdings) {
      const row = node('tr');
      row.append(node('td', '', accounts.find(a => a.id === holding.accountId)?.name || holding.accountId), node('td', '', holding.symbol));
      for (const boundary of [holding.opening, holding.closing]) {
        const cell = node('td', 'money-amount money-table', boundary ? fmtMoney(boundary.value) : '—');
        if (boundary?.priceDate) cell.append(node('div', 'muted', `${label('priceDate')}: ${boundary.priceDate}`));
        row.append(cell);
      }
      tbody.append(row);
    }
    table.append(tbody); scroll.append(table);
    result.append(disclosure(`${label('valuations')} · ${data.openingDate} → ${data.to}`, [scroll], false));
  };
  filters.addEventListener('submit', event => { event.preventDefault(); draw(); });
  for (const input of [from, to]) input.addEventListener('input', () => to.setCustomValidity(''));
  card.append(filters, result, disclosure(label('method'), [node('p', '', label('methodHelp'))], false));

  const priceForm = node('form');
  priceForm.style.cssText = 'display:flex;flex-wrap:wrap;gap:12px;align-items:end';
  const symbol = field(priceForm, label('symbol'), 'text', '');
  const date = field(priceForm, label('priceDate'), 'date', today); date.max = today;
  const price = field(priceForm, label('price'), 'number', ''); price.min = '0'; price.step = 'any';
  const save = node('button', 'btn btn-accent', label('savePrice')); save.type = 'submit'; priceForm.append(save);
  const priceStatus = node('p', 'field-status'); priceStatus.setAttribute('role', 'status');
  priceForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!isCurrent() || save.disabled || !priceForm.reportValidity()) return;
    const entry = { symbol: symbol.value.trim().toUpperCase(), price: Number(price.value), asOf: date.value, preserveNewer: true };
    priceStatus.textContent = '';
    save.disabled = true;
    for (const input of [symbol, date, price]) input.disabled = true;
    try {
      const saved = await dispatchOrReport(session, 'investment.setPrice', entry);
      if (saved && isCurrent()) {
        symbol.value = ''; date.value = ''; price.value = '';
        draw();
        priceStatus.textContent = label('priceSaved')(entry.symbol, entry.asOf, fmtMoney(entry.price));
      }
    } finally {
      save.disabled = false;
      for (const input of [symbol, date, price]) input.disabled = false;
    }
  });
  const priceDisclosure = disclosure(label('recordPrice'), [node('p', 'muted', label('priceHelp')), priceForm, priceStatus], false);
  card.append(priceDisclosure);
  draw();
  return card;
}

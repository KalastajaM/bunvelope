import { openSheet } from './ui/sheet.js';
import { t, fmtDateLang } from './ui/i18n.js';
import { fmt } from './utils.js';
import { txAbsAmount } from './engine.js';
import { enableFormulaInput, parseAmountInput } from './ui/amount-input.js';
import { createDirtyTracker } from './ui/dirty-guard.js';

/** Search and review only. The owner stages the result; this sheet never writes. */
export function openReconcilePicker({ candidates, accounts, account, date, onStage, initial = null }) {
  const content = document.createElement('div');
  content.className = 'rec-picker';
  const cancel = button(t('common.cancel'));
  const tracker = createDirtyTracker();
  let applying = false;
  const { close, requestClose } = openSheet({
    title: t('reconcile.findPlanned'), content, wide: true,
    headerActions: [cancel], confirmClose: () => !applying && tracker.confirmClose(),
  });
  cancel.addEventListener('click', requestClose);
  let term = '';
  let accountFilter = '';
  let count = 50;
  const accountName = id => accounts.find(a => a.id === id)?.name || id || '—';
  function describe(candidate) {
    const tx = candidate.tx;
    return `${candidate.booked ? t('reconcile.matchBooked') : t('reconcile.matchScheduled')} · ${fmtDateLang(tx.date)} · ${accountName(tx.account)}${candidate.month ? ` · ${candidate.month}` : ''}`;
  }
  function search() {
    tracker.reset();
    content.replaceChildren();
    const intro = document.createElement('p');
    intro.className = 'muted';
    intro.textContent = t('reconcile.findPlannedHint');
    const filters = document.createElement('div');
    filters.className = 'filters';
    const query = document.createElement('input');
    query.type = 'search'; query.placeholder = t('reconcile.findPlannedSearch');
    query.setAttribute('aria-label', t('reconcile.findPlannedSearch'));
    query.value = term;
    const searchWrap = document.createElement('div');
    searchWrap.className = 'search';
    searchWrap.append(query);
    const accountSelect = document.createElement('select');
    accountSelect.setAttribute('aria-label', t('budgetPlan.account'));
    accountSelect.add(new Option(t('reconcile.allAccounts'), ''));
    accounts.forEach(a => accountSelect.add(new Option(a.name, a.id)));
    accountSelect.value = accountFilter;
    filters.append(searchWrap, accountSelect);
    const results = document.createElement('div');
    results.className = 'rec-picker-results';
    const status = document.createElement('p');
    status.className = 'muted'; status.setAttribute('role', 'status');
    content.append(intro, filters, status, results);
    function paint() {
      tracker.reset();
      const words = term.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
      const matches = candidates().filter(c => (!accountFilter || c.tx.account === accountFilter)
        && words.every(word => `${c.tx.payee || ''} ${c.tx.note || ''} ${accountName(c.tx.account)} ${c.tx.date} ${c.month || ''}`.toLocaleLowerCase().includes(word)));
      status.textContent = matches.length ? t('reconcile.matchCount')(Math.min(count, matches.length), matches.length) : t('common.noResults');
      results.replaceChildren();
      for (const candidate of matches.slice(0, count)) {
        const row = button('', 'btn btn-ghost rec-picker-result');
        const name = document.createElement('strong'); name.textContent = candidate.tx.payee || '—';
        const detail = document.createElement('span'); detail.className = 'muted'; detail.textContent = describe(candidate);
        const amount = document.createElement('span'); amount.className = 'rec-picker-amount'; amount.textContent = `${candidate.tx.type === 'expense' ? '−' : '+'}${fmt(txAbsAmount(candidate.tx))}`;
        row.append(name, amount, detail);
        row.addEventListener('click', () => review(candidate));
        results.append(row);
      }
      if (matches.length > count) {
        const more = button(t('reconcile.moreMatches'));
        more.addEventListener('click', () => { count += 50; paint(); }); results.append(more);
      }
    }
    query.addEventListener('input', () => { term = query.value; count = 50; paint(); });
    accountSelect.addEventListener('change', () => { accountFilter = accountSelect.value; count = 50; paint(); });
    paint(); query.focus();
  }
  function review(candidate) {
    tracker.reset(); content.replaceChildren();
    const tx = candidate.tx;
    const title = document.createElement('h3'); title.textContent = tx.payee || '—';
    const original = document.createElement('p'); original.className = 'muted'; original.textContent = describe(candidate);
    const notice = document.createElement('p');
    notice.className = 'rec-picker-notice';
    notice.textContent = t('reconcile.matchAccount')(accountName(tx.account), account.name);
    const hint = document.createElement('p'); hint.className = 'muted';
    hint.textContent = t(candidate.booked ? 'reconcile.matchBookedHint' : 'reconcile.matchScheduledHint');
    const fields = document.createElement('div'); fields.className = 'rec-picker-fields';
    const dateField = field(t('addTx.date'), 'date', tx.date > date ? date : tx.date || date);
    const amountField = field(t('addTx.amount'), 'text', String(txAbsAmount(tx)));
    const dateInput = dateField.querySelector('input'); dateInput.max = date;
    const amountInput = amountField.querySelector('input');
    amountInput.inputMode = 'decimal'; enableFormulaInput(amountInput);
    // Keep split allocations intact; changing a split total needs the full editor.
    if (tx.envelope_splits?.length) {
      amountInput.readOnly = true;
      const splitHint = document.createElement('p'); splitHint.className = 'muted'; splitHint.textContent = t('reconcile.matchSplitHint'); amountField.append(splitHint);
    }
    fields.append(dateField, amountField);
    fields.addEventListener('input', tracker.markDirty);
    fields.addEventListener('change', tracker.markDirty);
    const error = document.createElement('p'); error.setAttribute('role', 'alert');
    const actions = document.createElement('div'); actions.className = 'rec-picker-actions';
    const back = button(t('reconcile.backToMatches'));
    back.addEventListener('click', async () => { if (await tracker.confirmClose()) search(); });
    const use = button(t('reconcile.useMatch'), 'btn btn-accent');
    use.addEventListener('click', async () => {
      if (applying) return;
      const amount = parseAmountInput(amountInput.value);
      if (!dateInput.value || !dateInput.checkValidity() || !Number.isFinite(amount) || amount <= 0) {
        error.textContent = t('reconcile.matchInvalid'); return;
      }
      applying = true; use.disabled = true; back.disabled = true; cancel.disabled = true;
      try {
        const result = await onStage(candidate, { date: dateInput.value, amount, account: account.id });
        if (result === false) { error.textContent = t('reconcile.matchChanged'); return; }
        if (result === null) return;
        close();
      } finally {
        applying = false; use.disabled = false; back.disabled = false; cancel.disabled = false;
      }
    });
    actions.append(back, use);
    content.append(title, original, notice, hint, fields, error, actions);
    dateInput.focus();
  }
  if (initial) review(initial); else search();
}
function button(label, className = 'btn btn-ghost') {
  const el = document.createElement('button'); el.type = 'button'; el.className = className; el.textContent = label; return el;
}
let fieldId = 0;
function field(label, type, value) {
  const wrap = document.createElement('div'); wrap.className = 'field';
  const text = document.createElement('label'); text.textContent = label;
  const input = document.createElement('input'); input.type = type; input.value = value;
  input.id = `rec-picker-field-${++fieldId}`; text.htmlFor = input.id;
  wrap.append(text, input); return wrap;
}

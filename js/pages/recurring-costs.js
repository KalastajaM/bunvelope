import { moneyEl, amountText } from '../ui/money.js';
import { recurringDiscovery } from '../ui/recurring-discovery.js';
import { state, session, now, navigate, getPrefs, savePrefs } from '../app.js';
import { ask } from '../ui/query.js';
import { node } from '../ui/planning-workspace.js';
import { t, trCat, trEnv, fmtDateLang } from '../ui/i18n.js';
import { fmt } from '../utils.js';
import { isoDate } from '../core/context.js';
import { recurringReminderDates, recurringReminderDays, recurringDeadline, recurringLeadDays } from '../core/recurring-review.js';
import { itemDateBounds } from '../engine/item-dates.js';
import { openSheet } from '../ui/sheet.js';
import { trackDirty } from '../ui/dirty-guard.js';
import { guardSubmit } from '../ui/submit-guard.js';
import { dispatchOrReport } from '../ui/save-error.js';
import { currentBudgetSession } from '../state/budget-session.js';
import { withBusy } from '../ui/busy.js';
import { addPageHelp } from '../ui/info-button.js';
import { recurringCategoryKey as categoryKey, recurringGroupKey, recurringGroupModes } from '../core/recurring-categories.js';
import { announce } from '../ui/announce.js';
import { icon } from '../ui/icon.js';
import { openBudgetItemEditor } from './budget-plan-editor.js';

function button(label, action, cls = 'btn btn-sm btn-ghost') {
  const b = node('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', action);
  return b;
}

export function render(container, view = null) {
  if (!view) {
    view = state.pendingFilter || {};
    state.pendingFilter = null;
  }
  const preferredGroup = view.groupBy ?? getPrefs().recurringGroupBy;
  const groupBy = recurringGroupModes.includes(preferredGroup) ? preferredGroup : 'category';
  const sortBy = (view.sortBy ?? getPrefs().recurringSortBy) === 'renewal' ? 'renewal' : 'plan';
  const generation = currentBudgetSession();
  const page = node('div', 'page recurring-costs');
  const sticky = node('div', 'page-sticky-top-wrap');
  const head = node('div', 'page-head');
  const title = node('div');
  const heading = node('h1', '', t('recurring.title'));
  addPageHelp(heading, 'recurring.intro', { detailKeys: ['recurring.equivalent', 'recurring.reminderHelp'] });
  title.append(heading);
  head.append(title, button(t('recurring.manage'), () => navigate('budget-plan'), 'btn btn-accent'));
  sticky.append(head);
  page.append(sticky);
  const answer = ask('recurring.costs', { date: isoDate(now()) });
  if (!answer) {
    page.append(node('p', '', t('recurring.failed')));
    container.replaceChildren(page);
    return;
  }
  const summary = node('div', 'kpi-row');
  for (const [key, value] of [['trackedMonthly', answer.totals.monthly], ['trackedAnnual', answer.totals.annual], ['attention', answer.totals.attention]]) {
    const card = node('div', key === 'attention' && answer.totals.attention ? 'kpi warn' : 'kpi');
    const amount = node('div', 'val money-metric');
    amount.append(key === 'attention' ? amountText(String(value)) : moneyEl(value, { role: 'summary' }));
    card.append(node('div', 'lbl', t('recurring.' + key)), amount);
    summary.append(card);
  }
  title.append(node('div', 'sub', `${fmtDateLang(answer.from)} – ${fmtDateLang(answer.through)}`));
  page.append(summary);

  const categories = new Map();
  for (const it of answer.items) categories.set(categoryKey(it.category), categories.get(categoryKey(it.category)) || it.category || t('recurring.uncategorized'));
  const filters = node('div', 'filters');
  const searchWrap = node('div', 'search');
  const search = node('input');
  search.type = 'search';
  search.placeholder = t('recurring.search');
  search.setAttribute('aria-label', search.placeholder);
  searchWrap.append(icon('search', 16), search);
  const status = node('select');
  status.setAttribute('aria-label', t('recurring.filter'));
  for (const key of ['current', 'attention', 'all', 'hidden']) {
    const option = node('option', '', t('recurring.' + key));
    option.value = key;
    status.append(option);
  }
  const category = node('select');
  category.setAttribute('aria-label', t('recurring.categoryFilter'));
  const all = node('option', '', t('recurring.allCategories'));
  all.value = 'all'; category.append(all);
  for (const [key, label] of [...categories].sort((a, b) => a[1].localeCompare(b[1]))) {
    const option = node('option', '', label); option.value = key; category.append(option);
  }
  search.value = view.search || '';
  status.value = view.filter || 'current';
  category.value = categories.has(view.category) ? view.category : 'all';
  const grouping = node('select');
  grouping.setAttribute('aria-label', t('recurring.groupBy'));
  for (const mode of recurringGroupModes) {
    const option = node('option', '', t('recurring.group_' + mode));
    option.value = mode; grouping.append(option);
  }
  grouping.value = groupBy;
  const sorting = node('select');
  sorting.setAttribute('aria-label', t('recurring.sortBy'));
  for (const mode of ['plan', 'renewal']) {
    const option = node('option', '', t('recurring.sort_' + mode));
    option.value = mode; sorting.append(option);
  }
  sorting.value = sortBy;
  sorting.title = t('recurring.sortHelp');
  const refresh = () => {
    if (generation === currentBudgetSession() && page.isConnected) render(container, { search: search.value, filter: status.value, category: category.value, groupBy: grouping.value, sortBy: sorting.value });
  };
  grouping.addEventListener('change', () => { savePrefs({ recurringGroupBy: grouping.value }); refresh(); });
  sorting.addEventListener('change', () => { savePrefs({ recurringSortBy: sorting.value }); refresh(); });
  filters.append(searchWrap, status, category, grouping, sorting);
  sticky.append(filters);
  const list = node('div'); page.append(list);
  const groupLabel = group => {
    if (groupBy === 'none') return t('recurring.allCosts');
    if (groupBy === 'account') return group.label || t('recurring.noAccount');
    if (groupBy === 'envelope') return group.label ? trEnv({ name: group.label, i18n_key: group.i18nKey }) : t('recurring.unallocated');
    if (groupBy === 'envelopeCategory') return group.key === 'unallocated' ? t('recurring.unallocated') : (group.label ? trCat(group.label) : t('recurring.uncategorized'));
    return group.label || t('recurring.uncategorized');
  };
  const groupLabels = new Map(answer.groups[groupBy].map(group => [group.key, groupLabel(group)]));
  const rawOrder = groupBy === 'category' ? getPrefs().recurringCategoryOrder : getPrefs().recurringGroupOrders?.[groupBy];
  const savedOrder = Array.isArray(rawOrder) ? [...new Set(rawOrder.filter(key => typeof key === 'string'))] : [];
  let order = [...savedOrder.filter(key => groupLabels.has(key)),
    ...[...groupLabels].sort((a, b) => a[1].localeCompare(b[1])).map(([key]) => key).filter(key => !savedOrder.includes(key))];
  let draggedKey = null;

  function moveCategory(source, target) {
    if (generation !== currentBudgetSession() || !page.isConnected || source === target || !order.includes(source) || !order.includes(target)) return;
    const before = order.indexOf(source);
    const at = order.indexOf(target);
    order = order.filter(key => key !== source);
    order.splice(at, 0, source);
    const persisted = [...order, ...savedOrder.filter(key => !order.includes(key))];
    if (groupBy === 'category') savePrefs({ recurringCategoryOrder: persisted });
    else {
      const previous = getPrefs().recurringGroupOrders;
      savePrefs({ recurringGroupOrders: { ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}), [groupBy]: persisted } });
    }
    repaint();
    announce((at < before ? t('common.movedUp') : t('common.movedDown'))(groupLabels.get(source)));
    [...list.querySelectorAll('.recurring-group')].find(group => group.dataset.categoryKey === source)?.querySelector('.recurring-group-drag')?.focus();
  }

  function repaint() {
    list.replaceChildren();
    const rows = answer.items.filter(it => {
      if (status.value === 'hidden' ? !it.hidden : it.hidden) return false;
      if (status.value === 'current' && !['active', 'upcoming'].includes(it.status)) return false;
      if (status.value === 'attention' && !it.attention) return false;
      if (category.value !== 'all' && categoryKey(it.category) !== category.value) return false;
      return `${it.name} ${it.category || ''} ${it.accountName || ''} ${it.envelopeName || ''} ${it.envelopeCategory || ''}`.toLowerCase().includes(search.value.toLowerCase());
    });
    if (sortBy === 'renewal') rows.sort((a, b) => {
      if (!a.renewsOn && !b.renewsOn) return 0;
      if (!a.renewsOn) return 1;
      if (!b.renewsOn) return -1;
      return a.renewsOn.localeCompare(b.renewsOn);
    });
    const visibleOrder = order.filter(key => rows.some(it => recurringGroupKey(it, groupBy) === key));
    for (const key of visibleOrder) {
      const label = groupLabels.get(key);
      const grouped = rows.filter(it => recurringGroupKey(it, groupBy) === key);
      if (!grouped.length) continue;
      const group = node('section', 'recurring-group');
      group.dataset.categoryKey = key;
      const header = node('div', 'recurring-group-header');
      const handle = button('↕', () => {}, 'btn btn-sm btn-ghost recurring-group-drag');
      handle.draggable = true;
      handle.setAttribute('aria-label', `${t(groupBy === 'category' ? 'recurring.reorderCategory' : 'recurring.reorderGroup')}: ${label}`);
      handle.title = t('recurring.reorderHelp');
      handle.addEventListener('dragstart', event => {
        draggedKey = key;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', key);
      });
      const clearDrag = () => {
        draggedKey = null;
        list.querySelectorAll('.drag-over-group').forEach(el => el.classList.remove('drag-over-group'));
      };
      handle.addEventListener('dragend', clearDrag);
      group.addEventListener('dragover', event => {
        if (!draggedKey || draggedKey === key) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        header.classList.add('drag-over-group');
      });
      group.addEventListener('dragleave', event => {
        if (!group.contains(event.relatedTarget)) header.classList.remove('drag-over-group');
      });
      group.addEventListener('drop', event => {
        if (!draggedKey || draggedKey === key) return;
        event.preventDefault();
        const source = draggedKey;
        clearDrag();
        moveCategory(source, key);
      });
      const position = visibleOrder.indexOf(key);
      const moveBy = delta => {
        const target = visibleOrder[position + delta];
        if (target) moveCategory(key, target);
      };
      handle.addEventListener('keydown', event => {
        if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        moveBy(event.key === 'ArrowUp' ? -1 : 1);
      });
      const controls = node('div', 'recurring-group-actions');
      for (const [delta, text, labelKey] of [[-1, '↑', 'moveUp'], [1, '↓', 'moveDown']]) {
        const control = button(text, () => moveBy(delta));
        control.disabled = !visibleOrder[position + delta];
        control.setAttribute('aria-label', `${t('recurring.' + (groupBy === 'category' ? labelKey : labelKey + 'Group'))}: ${label}`);
        control.title = control.getAttribute('aria-label');
        controls.append(control);
      }
      const totals = answer.groups[groupBy].find(group => group.key === key);
      const costs = node('div', 'recurring-group-totals');
      costs.title = t('recurring.groupTotalsHelp');
      costs.append(node('span', '', `${t('recurring.groupMonthly')}: ${fmt(totals.monthly)}`),
        node('span', '', `${t('recurring.annual')}: ${fmt(totals.annual)}`));
      if (groupBy !== 'none') header.append(handle);
      header.append(node('h2', 'recurring-group-title', label), costs);
      if (groupBy !== 'none') header.append(controls);
      group.append(header);
      const grid = node('div', 'env-grid recurring-cost-grid');
      for (const it of grouped) grid.append(buildCard(it));
      group.append(grid); list.append(group);
    }
    if (!rows.length) list.append(node('p', 'tpl-empty', t('recurring.empty')));
  }

  function buildCard(it) {
    const card = node('article', 'tpl-card recurring-card');
    card.dataset.itemId = it.id;
    const heading = node('div', 'recurring-card-head');
    heading.append(node('h3', 'tpl-name', it.name), node('span', 'chip', t('recurring.' + (it.hidden ? 'hidden' : it.status))));
    card.append(heading);
    const agreementInfo = [
      it.continuous ? t('recurring.continuous') : '',
      it.startsOn ? `${t('recurring.starts_on')}: ${fmtDateLang(it.startsOn)}` : '',
    ].filter(Boolean);
    if (agreementInfo.length) card.append(node('p', 'tpl-meta', agreementInfo.join(' · ')));
    const costs = node('dl', 'recurring-cost-lines');
    for (const [key, value] of [['monthly', it.monthly], ['annual', it.annual]]) {
      const row = node('div');
      row.append(node('dt', '', t('recurring.' + key)), node('dd', 'money-amount money-table', fmt(value)));
      costs.append(row);
    }
    card.append(costs);
    const next = node('p', 'tpl-meta');
    if (it.next) {
      next.append(node('span', '', `${t('recurring.next')}: ${fmtDateLang(it.next.date)} · `), node('span', 'recurring-next-amount money-amount money-table', fmt(it.next.amount)));
    } else next.textContent = t('recurring.noNext');
    card.append(next);
    if (it.renewsOn && !it.reminders.some(reminder => reminder.kind === 'renews_on')) {
      card.append(node('p', 'tpl-meta', `${t('recurring.renews_on')}: ${fmtDateLang(it.renewsOn)}`));
    }
    for (const reminder of it.reminders) {
      const line = node('div', reminder.due ? 'recurring-reminder is-due' : 'recurring-reminder');
      line.append(node('div', '', `${t('recurring.' + reminder.kind)}: ${fmtDateLang(reminder.date)}`));
      line.append(node('div', 'tpl-meta', reminder.due ? t('recurring.due') : `${t('recurring.remindFrom')}: ${fmtDateLang(reminder.remindFrom)}`));
      card.append(line);
    }
    if (it.notes) card.append(node('p', 'tpl-meta recurring-notes', it.notes));
    const actions = node('div', 'tpl-actions');
    actions.append(button(t('recurring.reminders'), () => editReminders(it.id, refresh)), button(t('recurring.edit'), () => {
      const idx = state.budgetItems.findIndex(row => row.id === it.id);
      if (idx >= 0) openBudgetItemEditor(container, idx, { rerenderTable: refresh });
    }));
    const hide = button(t(it.hidden ? 'recurring.unhide' : 'recurring.hide'), async () => {
      if (generation !== currentBudgetSession()) return;
      await withBusy(hide, async () => {
        const latest = state.budgetItems.find(row => row.id === it.id);
        if (!latest) return;
        const result = await dispatchOrReport(session, 'budgetItem.update', { id: it.id, fields: { recurring_review: { ...latest.recurring_review, hidden: !it.hidden } } });
        if (result) refresh();
      });
    });
    hide.title = t('recurring.hideHelp');
    actions.append(hide);
    card.append(actions);
    return card;
  }

  search.addEventListener('input', repaint);
  status.addEventListener('change', repaint);
  category.addEventListener('change', repaint);
  repaint(); page.append(recurringDiscovery(refresh, id => {
    const idx = state.budgetItems.findIndex(it => it.id === id);
    if (idx >= 0) openBudgetItemEditor(container, idx, { rerenderTable: refresh });
  })); container.replaceChildren(page);
}

function editReminders(id, repaint) {
  const item = state.budgetItems.find(it => it.id === id);
  if (!item) return;
  const generation = currentBudgetSession();
  const form = node('form', 'recurring-editor');
  const fields = {};
  form.append(node('p', 'page-intro', t('recurring.reminderHelp')));
  const suggestions = node('datalist');
  suggestions.id = 'recurring-category-suggestions';
  const names = new Set(['streaming', 'insurance', 'phone', 'electricity'].map(key => t('recurring.categories.' + key)));
  for (const row of state.budgetItems) if (row.recurring_review?.category) names.add(row.recurring_review.category);
  for (const name of names) { const option = node('option'); option.value = name; suggestions.append(option); }
  form.append(suggestions);
  const review = item.recurring_review || {};
  const fallbackEnd = itemDateBounds(item).until;
  const oldDates = ['renews_on', 'ends_on'].filter(key => review[key]).sort((a, b) => review[a].localeCompare(review[b]));
  let dateKind = oldDates[0] || 'renews_on';
  if (!oldDates.length && fallbackEnd) dateKind = 'ends_on';
  function field(key, type, value, host = form) {
    const wrap = node('div', 'field');
    const label = node('label', '', t('recurring.' + key));
    const input = node(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    input.id = 'recurring-' + key; label.htmlFor = input.id;
    input.value = value || '';
    fields[key] = input;
    wrap.append(label, input); host.append(wrap);
    return wrap;
  }
  const categoryField = field('category', 'text', review.category);
  fields.category.setAttribute('list', suggestions.id);
  categoryField.append(node('p', 'money-field-help', t('recurring.categoryHelp')));

  const startField = field('starts_on', 'date', review.starts_on);
  startField.append(node('p', 'money-field-help', t('recurring.startHelp')));
  const dateRow = node('div', 'recurring-agreement-row');
  const switchWrap = node('label', 'bp-switch recurring-date-toggle');
  switchWrap.title = t('recurring.deadlineToggleHelp');
  const hasDeadline = node('input');
  hasDeadline.type = 'checkbox'; hasDeadline.checked = !review.continuous;
  hasDeadline.setAttribute('aria-label', t('recurring.dateEnabled'));
  switchWrap.append(hasDeadline, node('span', 'bp-switch-track'));
  dateRow.append(switchWrap);
  form.append(dateRow);

  const kindRow = node('div', 'seg');
  kindRow.setAttribute('role', 'group');
  kindRow.setAttribute('aria-label', t('recurring.dateKind'));
  const kindButtons = ['renews_on', 'ends_on'].map(kind => {
    const control = button(t('recurring.' + kind), () => {
      dateKind = kind;
      updateKind();
      sync('deadline');
      form.dispatchEvent(new Event('input', { bubbles: true }));
    });
    control.setAttribute('aria-pressed', String(kind === dateKind));
    kindRow.append(control);
    return control;
  });
  field('agreementDate', 'date', review[dateKind] || fallbackEnd, dateRow);
  dateRow.append(kindRow);
  const updateKind = () => {
    kindButtons.forEach((control, i) => {
      const selected = ['renews_on', 'ends_on'][i] === dateKind;
      control.setAttribute('aria-pressed', String(selected));
      control.classList.toggle('on', selected);
    });
    form.querySelector('label[for="recurring-agreementDate"]').textContent = t('recurring.' + dateKind);
  };
  updateKind();
  if (fallbackEnd) form.append(node('p', 'money-field-help', `${t('recurring.planEnd')}: ${fmtDateLang(fallbackEnd)}`));

  const extra = node('details');
  extra.open = !!review.cancel_by;
  extra.append(node('summary', '', t('recurring.earlierCancellation')));
  field('cancel_by', 'date', review.cancel_by, extra);
  extra.append(node('p', 'money-field-help', t('recurring.cancellationHelp')));
  form.append(extra);
  const timing = node('div', 'recurring-reminder-timing');
  form.append(timing);
  field('remindOn', 'date', '', timing);
  field('daysBefore', 'number', String(recurringReminderDays(review)), timing);
  fields.daysBefore.min = '0'; fields.daysBefore.max = '3650'; fields.daysBefore.step = '1';
  fields.daysBefore.required = true;
  const basis = node('p', 'money-field-help recurring-reminder-basis'); form.append(basis);
  if (!review.linked_reminder && (review.review_on || oldDates.length > 1)) {
    form.append(node('p', 'money-field-help', t('recurring.legacyReminder')));
  }
  field('notes', 'textarea', review.notes);
  const preview = node('div', 'recurring-preview');
  preview.setAttribute('aria-live', 'polite'); form.append(preview);

  const values = () => ({
    category: fields.category.value.trim() || null,
    starts_on: fields.starts_on.value || null,
    continuous: !hasDeadline.checked,
    notes: fields.notes.value.trim() || null,
    renews_on: hasDeadline.checked && dateKind === 'renews_on' ? fields.agreementDate.value || null : null,
    ends_on: hasDeadline.checked && dateKind === 'ends_on' ? fields.agreementDate.value || null : null,
    cancel_by: !hasDeadline.checked ? null : fields.cancel_by.value || null,
    reminder_days: Number(fields.daysBefore.value),
    linked_reminder: true,
    // Retain a legacy standalone reminder until a deadline is supplied.
    review_on: recurringDeadline({
      continuous: !hasDeadline.checked, [dateKind]: fields.agreementDate.value, cancel_by: fields.cancel_by.value,
    }, fallbackEnd) ? null : fields.remindOn.value || null,
  });
  function updatePreview() {
    preview.replaceChildren(node('strong', '', t('recurring.preview')));
    if (review.hidden) { preview.append(node('p', '', t('recurring.hideHelp'))); return; }
    if (!fields.daysBefore.validity.valid || !fields.remindOn.validity.valid || !fields.cancel_by.validity.valid) return;
    for (const r of recurringReminderDates(values(), fallbackEnd)) {
      preview.append(node('p', '', `${t('recurring.' + r.kind)}: ${fmtDateLang(r.date)} · ${t('recurring.remindFrom')}: ${fmtDateLang(r.remindFrom)}`));
    }
  }
  function sync(source) {
    const deadline = recurringDeadline(values(), fallbackEnd);
    fields.agreementDate.disabled = !hasDeadline.checked;
    kindButtons.forEach(control => { control.disabled = !hasDeadline.checked; });
    fields.cancel_by.disabled = !hasDeadline.checked;
    extra.hidden = !hasDeadline.checked;
    fields.daysBefore.disabled = !deadline;
    fields.remindOn.disabled = !deadline && !review.review_on && hasDeadline.checked;
    fields.remindOn.required = !!deadline;
    fields.remindOn.max = deadline?.date || '';
    fields.remindOn.setCustomValidity('');
    fields.cancel_by.setCustomValidity('');
    const agreement = fields.agreementDate.value || fallbackEnd;
    if (hasDeadline.checked && fields.cancel_by.value && agreement && fields.cancel_by.value >= agreement) {
      fields.cancel_by.setCustomValidity(t('recurring.cancellationEarlier'));
    }
    basis.textContent = deadline
      ? `${t('recurring.countsBackFrom')}: ${t('recurring.' + deadline.kind)} · ${fmtDateLang(deadline.date)}`
      : t(!hasDeadline.checked ? 'recurring.continuousHelp' : 'recurring.addDeadline');
    if (deadline && source === 'remindOn') {
      const days = fields.remindOn.value ? recurringLeadDays(deadline.date, fields.remindOn.value) : null;
      fields.daysBefore.value = days === null ? '' : String(days);
      if (days !== null && (days < 0 || days > 3650)) fields.remindOn.setCustomValidity(t('recurring.reminderRange'));
    } else if (deadline && fields.daysBefore.validity.valid) {
      fields.remindOn.value = recurringReminderDates(values(), fallbackEnd)[0]?.remindFrom || '';
    } else if (!deadline && source !== 'remindOn') {
      if (source !== 'initial' && hasDeadline.checked) fields.remindOn.value = '';
      fields.daysBefore.value = fields.daysBefore.value || String(recurringReminderDays(null));
    }
    updatePreview();
  }
  const previous = recurringReminderDates(review, fallbackEnd)[0];
  if (previous && !review.linked_reminder) {
    fields.remindOn.value = previous.remindFrom;
    sync('remindOn');
  } else {
    fields.remindOn.value = review.review_on || '';
    sync('initial');
  }
  form.addEventListener('input', event => {
    if (event.target === fields.remindOn) sync('remindOn');
    else if ([fields.daysBefore, fields.agreementDate, fields.cancel_by, hasDeadline].includes(event.target)) sync('deadline');
  });
  const save = node('button', 'btn btn-accent', t('common.save')); save.type = 'submit';
  const dirty = trackDirty(form);
  const cancel = button(t('common.cancel'), () => sheet.requestClose(), 'btn btn-ghost');
  // The shared sheet assigns a unique form owner to header submit controls.
  const sheet = openSheet({ title: item.description || id, content: form, confirmClose: dirty.confirmClose, headerActions: [cancel, save] });
  form.addEventListener('submit', guardSubmit(async () => {
    if (generation !== currentBudgetSession()) { sheet.close(); return; }
    await withBusy(save, async () => {
      const latest = state.budgetItems.find(row => row.id === id);
      if (!latest) return;
      const result = await dispatchOrReport(session, 'budgetItem.update', { id, fields: { recurring_review: { ...latest.recurring_review, ...values() } } });
      if (result) { sheet.close(); if (generation === currentBudgetSession()) repaint(); }
    }, { label: t('common.saving') });
  }));
}

import { node } from '../ui/planning-workspace.js';
import { listColumns, listColumnRow } from '../ui/list-columns.js';
// js/pages/accounts.js — Accounts page (card grid, matches Envelopes page layout).
import { state, session, updateStatusBar, navigate, activeLensInput, getPrefs, savePrefs, now as appNow } from '../app.js';
import { openLoanScheduleSheet } from '../ui/loan-schedule-sheet.js';
import { ask } from '../ui/query.js';
import { isoDate } from '../core/context.js';
import { accountCard } from '../ui/account-card.js';
import { openAccountEdit } from './account-edit.js';
import { openReconcileModal, openInvestmentValueDialog } from '../reconcile.js';
import { isAiFeatureEnabled } from '../ai/client.js';
import { openReconcileSheet } from '../ai/reconcile-sheet.js';
import { dispatchOrReport } from '../ui/save-error.js';
import { fmt } from '../utils.js';
import { moneyEl } from '../ui/money.js';
import { icon } from '../ui/icon.js';
import { infoButton } from '../ui/info-button.js';
import { t } from '../ui/i18n.js';
import { emptyState } from '../ui/empty-state.js';
import { enableTouchReorder } from '../ui/touch-reorder.js';
import { announce } from '../ui/announce.js';

// Values are i18n keys — translated at render time.
const TYPE_LABELS = {
  bank: 'accountEdit.typeBank',
  cash: 'accountEdit.typeCash',
  credit_card: 'accountEdit.typeCreditCard',
  savings: 'accountEdit.typeSavings',
  investment: 'accountEdit.typeInvestment',
  asset: 'accountEdit.typeAsset',
  loan: 'accountEdit.typeLoan',
  loan_given: 'accountEdit.typeLoanGiven',
};

let draggedAccId = null;
let draggedGroupType = null;

export async function render(container) {
  const page = document.createElement('div');
  page.className = 'page working-money';

  const stickyTop = document.createElement('div');
  stickyTop.className = 'page-sticky-top-wrap';
  page.append(stickyTop);

  // Page-local copy of the display order: a reorder repaints from it at once,
  // while the session commits (and publishes state.accounts) only on success.
  let accounts = state.accounts || [];
  const renderedFolder = state.budgetFolder;
  const active = accounts.filter(a => !a.archived);

  const showArchived = !!(state.meta && state.meta.show_archived_accounts);
  const visibleAll = showArchived ? accounts : active;
  // Every figure a card shows, for the accounts the page can show, asked once
  // per render (a search or filter repaints from it). `currentBalance` is the
  // Today lens whatever the active lens is: the card's "incl. X upcoming" line
  // is always `displayed − cleared`, so the adjacent figure stays readable
  // without switching modes; `budgetBalance` follows the active lens.
  const detail = ask('accounts.detail', { ...activeLensInput(), date: isoDate(appNow()), accounts: visibleAll.map(a => a.id) });
  const rows = detail?.accounts || [];
  const detailById = new Map(rows.map(d => [d.id, d]));
  const currentBal = new Map(rows.map(d => [d.id, d.currentBalance]));
  const budgetBal  = new Map(rows.map(d => [d.id, d.budgetBalance]));
  const totalCurrent = visibleAll.reduce((s, a) => s + (currentBal.get(a.id) ?? a.initialBalance ?? 0), 0);
  const totalBudget  = visibleAll.reduce((s, a) => s + (budgetBal.get(a.id)  ?? a.initialBalance ?? 0), 0);

  let isListView = getPrefs().acctView === 'list';

  // ── Page head ─────────────────────────────────────────────────────────
  const head = document.createElement('div');
  head.className = 'page-head';
  const left = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.textContent = t('accounts.title');
  // Matches the Envelopes page: one discoverable `?` per page, since a tooltip
  // on a card line is invisible until you happen to hover it (and never on
  // touch). The card tooltips carry the detail; this carries the concept.
  h1.append(infoButton('envelopes'));
  const sub = document.createElement('div');
  sub.className = 'page-head-sub';
  // In the Today lens the two totals are the same number by definition —
  // printing it twice reads as a bug, not as reassurance.
  sub.textContent = Math.abs(totalBudget - totalCurrent) < 0.005
    ? t('accounts.countSubToday')(active.length, fmt(totalCurrent))
    : t('accounts.countSub')(active.length, fmt(totalBudget), fmt(totalCurrent));
  left.append(h1, sub);
  head.append(left);

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(buildViewToggle());

  const newBtn = document.createElement('button');
  newBtn.className = 'btn btn-accent';
  newBtn.textContent = t('accounts.newBtn');
  newBtn.addEventListener('click', () => openAccountEdit(null));
  actions.append(newBtn);
  head.append(actions);
  stickyTop.append(head);

  // ── Filters ───────────────────────────────────────────────────────────
  const filters = document.createElement('div');
  filters.className = 'filters';

  const searchDiv = document.createElement('div');
  searchDiv.className = 'search';
  const searchIcon = document.createElement('span');
  searchIcon.style.color = 'var(--muted)';
  searchIcon.style.display = 'inline-flex';
  searchIcon.append(icon('search', 16));
  const searchInput = document.createElement('input');
  searchInput.placeholder = t('accounts.searchPlaceholder');
  const searchCount = document.createElement('span');
  searchCount.className = 'search-count';
  searchCount.setAttribute('aria-live', 'polite');
  searchDiv.append(searchIcon, searchInput, searchCount);
  filters.append(searchDiv);

  const typeSel = document.createElement('select');
  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = t('accounts.allTypes');
  typeSel.append(allOpt);
  Object.entries(TYPE_LABELS).forEach(([k, lbl]) => {
    const o = document.createElement('option');
    o.value = k; o.textContent = t(lbl);
    typeSel.append(o);
  });
  filters.append(typeSel);

  searchInput.setAttribute('aria-label', t('accounts.searchPlaceholder'));
  typeSel.setAttribute('aria-label', t('accounts.allTypes'));
  stickyTop.append(filters);
  const columnHead = node('div', 'money-column-head');
  stickyTop.append(columnHead);

  // ── Groups host ───────────────────────────────────────────────────────
  const groupsHost = document.createElement('div');
  page.append(groupsHost);

  function repaint() {
    groupsHost.innerHTML = '';
    const term = searchInput.value.trim().toLowerCase();
    const typeFilter = typeSel.value;
    const pool = showArchived ? accounts : active;
    const filtered = pool.filter(a =>
      (!term || (a.name || '').toLowerCase().includes(term) || (a.notes || '').toLowerCase().includes(term)
        || (a.code || '').toLowerCase().includes(term)) &&
      (!typeFilter || (a.type || 'bank') === typeFilter),
    );

    listColumns(groupsHost, 'accounts', isListView && filtered.length > 0, columnHead);

    if (term || typeFilter) {
      searchCount.textContent = filtered.length === 0
        ? t('common.noResults')
        : t('common.resultsFound')(filtered.length);
      searchCount.classList.toggle('is-empty', filtered.length === 0);
    } else {
      searchCount.textContent = '';
      searchCount.classList.remove('is-empty');
    }

    if (filtered.length === 0) {
      groupsHost.append(emptyState(
        accounts.length === 0
          ? {
              icon: 'budget',
              title: t('accounts.empty'),
              body: t('accounts.emptyBody'),
              action: { label: t('accounts.emptyAction'), onClick: () => openAccountEdit(null) },
            }
          : {
              icon: 'budget',
              title: t('accounts.emptyFilter'),
              body: t('accounts.emptyFilterBody'),
            },
      ));
      return;
    }

    const byType = {};
    const typeOrder = [];
    for (const a of filtered) {
      const k = a.type || 'bank';
      if (!byType[k]) { byType[k] = []; typeOrder.push(k); }
      byType[k].push(a);
    }
    // Asset accounts are shown together by their group label ("Properties",
    // "Gold", …), groups in the order they first appear.
    if (byType.asset) {
      const groups = new Map();
      for (const a of byType.asset) {
        const g = a.group || '';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(a);
      }
      byType.asset = [...groups.values()].flat();
    }
    // When each asset was last valued: its newest value-update row.
    const valuedOnById = new Map();
    for (const tx of state.transactions || []) {
      if (tx.type !== 'adjustment' || tx.target !== 'account') continue;
      const d = (tx.date || '').slice(0, 10);
      if (d > (valuedOnById.get(tx.target_id) || '')) valuedOnById.set(tx.target_id, d);
    }

    typeOrder.forEach(key => {
      const group = document.createElement('div');
      group.style.marginBottom = '28px';
      group.dataset.groupType = key;

      const catHead = document.createElement('div');
      catHead.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px;cursor:grab;';
      catHead.draggable = true;
      catHead.addEventListener('dragstart', (e) => {
        draggedGroupType = key;
        e.dataTransfer.effectAllowed = 'move';
        e.stopPropagation();
      });
      catHead.addEventListener('dragend', () => {
        draggedGroupType = null;
        groupsHost.querySelectorAll('.drag-over-group').forEach(el => el.classList.remove('drag-over-group'));
      });
      catHead.addEventListener('dragover', (e) => {
        if (!draggedGroupType || draggedGroupType === key) return;
        e.preventDefault();
        catHead.classList.add('drag-over-group');
      });
      catHead.addEventListener('dragleave', () => catHead.classList.remove('drag-over-group'));
      catHead.addEventListener('drop', (e) => {
        catHead.classList.remove('drag-over-group');
        if (!draggedGroupType || draggedGroupType === key) return;
        e.preventDefault();
        reorderGroup(draggedGroupType, key);
      });
      const collapsedSet = new Set(getPrefs().acctGroupsCollapsed || []);
      const isCollapsed = collapsedSet.has(key);

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'group-toggle';
      toggleBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      toggleBtn.setAttribute('aria-label', isCollapsed ? t('common.expand') : t('common.collapse'));
      toggleBtn.append(icon('chevronR', 16));
      toggleBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = new Set(getPrefs().acctGroupsCollapsed || []);
        if (cur.has(key)) cur.delete(key); else cur.add(key);
        savePrefs({ acctGroupsCollapsed: Array.from(cur) });
        const nowCollapsed = cur.has(key);
        toggleBtn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        toggleBtn.setAttribute('aria-label', nowCollapsed ? t('common.expand') : t('common.collapse'));
        container.style.display = nowCollapsed ? 'none' : '';
      });

      // Keyboard alternative to dragging a whole group, on the toggle button
      // because it is the group's existing focus stop (see envelopes.js).
      toggleBtn.addEventListener('keydown', (e) => {
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        if (!moveGroupBy(key, e.key === 'ArrowUp' ? -1 : 1, typeOrder)) return;
        const label = TYPE_LABELS[key] ? t(TYPE_LABELS[key]) : key;
        announce((e.key === 'ArrowUp' ? t('common.movedUp') : t('common.movedDown'))(label));
        requestAnimationFrame(() => {
          groupsHost.querySelector(`[data-group-type="${CSS.escape(key)}"] .group-toggle`)?.focus();
        });
      });

      const titleWrap = document.createElement('div');
      titleWrap.style.cssText = 'display:flex;align-items:center;min-width:0;';
      const h3 = document.createElement('h3');
      h3.style.cssText = 'font-family:var(--font-display);font-weight:400;font-size:24px;letter-spacing:-0.01em;';
      h3.textContent = TYPE_LABELS[key] ? t(TYPE_LABELS[key]) : key;
      titleWrap.append(toggleBtn, h3);

      const catBudget = byType[key].reduce((s, a) => s + (budgetBal.get(a.id) ?? a.initialBalance ?? 0), 0);
      const right = document.createElement('div');
      right.className = 'muted';
      right.style.fontSize = '12px';
      right.textContent = `${t('accounts.groupCount')(byType[key].length)} · ${fmt(catBudget)}`;
      catHead.append(titleWrap, right);
      group.append(catHead);

      const container = document.createElement('div');
      container.className = isListView ? 'env-list' : 'env-grid account-grid';
      if (isCollapsed) container.style.display = 'none';
      byType[key].forEach(acc => {
        const curBal = currentBal.get(acc.id) ?? acc.initialBalance ?? 0;
        const budBal = budgetBal.get(acc.id)  ?? acc.initialBalance ?? 0;
        let card;
        if (isListView) {
          card = buildAccountListRow(acc, curBal, budBal, detailById.get(acc.id)?.portfolioValue ?? null);
        } else {
          card = accountCard({
            account: acc,
            currentBalance: curBal,
            budgetBalance:  budBal,
            portfolioValue: detailById.get(acc.id)?.portfolioValue ?? null,
            onClick: (a) => navigate('transactions', `account:${a.id}`),
            onToggleFavorite: toggleFavorite,
            valuedOn: valuedOnById.get(acc.id) || null,
            rate: detailById.get(acc.id)?.rate ?? null,
            estInterest: detailById.get(acc.id)?.estInterest ?? 0,
            loanTerms: detailById.get(acc.id)?.loanTerms ?? null,
            repayment: detailById.get(acc.id)?.repayment ?? null,
            onLoanSchedule: (a, r) => openLoanScheduleSheet(a, r),
            onReconcile: (a) => (a.type === 'investment' || a.type === 'asset'
              ? openInvestmentValueDialog(a.id, () => navigate('accounts'), { asset: a.type === 'asset' })
              : openReconcileModal(a.id, () => navigate('accounts'))),
            onAiReconcile: isAiFeatureEnabled('reconcile')
              ? (a) => openReconcileSheet({ accountId: a.id })
              : null,
            onEdit: (a) => openAccountEdit(a),
          });
          if (acc.archived) card.classList.add('account--archived');
        }
        card.draggable = true;
        card.addEventListener('dragstart', e => {
          draggedAccId = acc.id;
          e.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
          draggedAccId = null;
          container.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
        });
        card.addEventListener('dragover', e => {
          if (!draggedAccId || draggedAccId === acc.id) return;
          const srcType = (accounts.find(a2 => a2.id === draggedAccId) || {}).type || 'bank';
          if (srcType !== key) return;
          e.preventDefault();
          card.classList.add('drag-over');
        });
        card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
        card.addEventListener('drop', e => {
          card.classList.remove('drag-over');
          if (!draggedAccId || draggedAccId === acc.id) return;
          const srcType = (accounts.find(a2 => a2.id === draggedAccId) || {}).type || 'bank';
          if (srcType !== key) return;
          e.preventDefault();
          reorderAccount(draggedAccId, acc.id);
        });
        card.dataset.accId = acc.id;
        enableTouchReorder({
          handle: card,
          getItemId: () => acc.id,
          getDropTarget: (x, y) => {
            const els = document.elementsFromPoint(x, y);
            for (const el of els) {
              const c = el.closest && el.closest('[data-acc-id]');
              if (c && c !== card) {
                const id = c.dataset.accId;
                if (id) return { id, el: c, kind: 'card' };
              }
            }
            return null;
          },
          onReorder: ({ from, to }) => reorderAccount(from, to),
        });
        // Keyboard alternative to drag (see envelopes.js for the pattern).
        card.addEventListener('keydown', (e) => {
          if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
          e.preventDefault();
          const neighbor = e.key === 'ArrowUp' ? card.previousElementSibling : card.nextElementSibling;
          if (!neighbor?.dataset?.accId) return;
          reorderAccount(acc.id, neighbor.dataset.accId);
          announce((e.key === 'ArrowUp' ? t('common.movedUp') : t('common.movedDown'))(acc.name));
          requestAnimationFrame(() => {
            groupsHost.querySelector(`[data-acc-id="${CSS.escape(acc.id)}"]`)?.focus();
          });
        });
        container.append(card);
      });
      group.append(container);
      groupsHost.append(group);
    });
  }

  const typeOf = (a) => a.type || 'bank';

  // Dispatches still in flight. The session serialises them, so a later one
  // lands after an earlier one; each is computed from the page-local order.
  let inflight = 0;

  function paintLocal(next) {
    accounts = next;
    active.length = 0;
    active.push(...next.filter(a => !a.archived));
    repaint();
  }

  // Whether any dispatch of the current burst (everything pending together)
  // failed. A failure is never left showing: when the burst ends, the page
  // repaints from state.accounts, which the session leaves untouched by a
  // failed command and which holds every success.
  let burstFailed = false;

  /**
   * One account command. Once nothing is pending, a burst with any failure
   * repaints from state.accounts; a burst without one keeps the page-local
   * order, which equals state. After a budget switch the failure repaint is
   * skipped: state.accounts then belongs to another budget.
   */
  async function dispatchSettled(name, input) {
    inflight++;
    let r;
    try { r = await dispatchOrReport(session, name, input); }
    finally { inflight--; }
    if (r) updateStatusBar(); else burstFailed = true;
    if (inflight > 0) return;
    const failed = burstFailed;
    burstFailed = false;
    if (state.budgetFolder !== renderedFolder) return;
    if (failed) paintLocal(state.accounts || []);
  }

  // Array order IS display order (see AGENTS.md): every reorder computes the
  // complete new order and hands it to account.reorder.
  function applyAccountOrder(next) {
    paintLocal(next);
    return dispatchSettled('account.reorder', { ids: next.map(a => a.id) });
  }

  async function reorderGroup(srcType, dstType) {
    // Move all accounts of srcType to appear just before accounts of dstType.
    // Group order is derived from first-appearance in the order; this
    // preserves within-group ordering for both types.
    const src = accounts.filter(a => typeOf(a) === srcType);
    if (!src.length) return;
    const without = accounts.filter(a => typeOf(a) !== srcType);
    const dstIdx = without.findIndex(a => typeOf(a) === dstType);
    if (dstIdx < 0) return;
    await applyAccountOrder([...without.slice(0, dstIdx), ...src, ...without.slice(dstIdx)]);
  }

  /**
   * Move a whole group one place up or down — the keyboard equivalent of
   * dragging its header. Returns false when there is nowhere to go, so the
   * caller can skip announcing a move that did not happen. `order` is the
   * VISIBLE group order, so a filtered-out group is never a destination the
   * user cannot see.
   */
  function moveGroupBy(type, delta, order) {
    const target = order[order.indexOf(type) + delta];
    if (!target) return false;
    const src = accounts.filter(a => typeOf(a) === type);
    if (!src.length) return false;
    const rest = accounts.filter(a => typeOf(a) !== type);
    const hits = rest.reduce((acc, a, k) => (typeOf(a) === target ? [...acc, k] : acc), []);
    if (!hits.length) return false;
    const at = delta < 0 ? hits[0] : hits[hits.length - 1] + 1;
    applyAccountOrder([...rest.slice(0, at), ...src, ...rest.slice(at)]);
    return true;
  }

  async function reorderAccount(draggedId, targetId) {
    const accs = [...accounts];
    const from = accs.findIndex(a => a.id === draggedId);
    const to   = accs.findIndex(a => a.id === targetId);
    if (from === -1 || to === -1 || from === to) return;
    const [item] = accs.splice(from, 1);
    accs.splice(to, 0, item);
    await applyAccountOrder(accs);
  }

  async function toggleFavorite(acc) {
    const cur = accounts.find(a => a.id === acc.id);
    if (!cur) return;
    const favorite = !cur.favorite;
    paintLocal(accounts.map(a => (a.id === acc.id ? { ...a, favorite } : a)));
    await dispatchSettled('account.update', { id: acc.id, fields: { favorite } });
  }

  function buildViewToggle() {
    const wrap = document.createElement('div');
    wrap.className = 'view-toggle';
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', t('common.viewMode'));
    const gridBtn = document.createElement('button');
    gridBtn.type = 'button';
    gridBtn.className = 'btn btn-ghost btn-sm view-toggle-btn' + (!isListView ? ' is-active' : '');
    gridBtn.title = t('common.cardView');
    gridBtn.append(icon('grid', 15));
    const listBtn = document.createElement('button');
    listBtn.type = 'button';
    listBtn.className = 'btn btn-ghost btn-sm view-toggle-btn' + (isListView ? ' is-active' : '');
    listBtn.title = t('common.listView');
    listBtn.append(icon('rows', 15));
    gridBtn.addEventListener('click', () => {
      isListView = false;
      savePrefs({ acctView: 'card' });
      gridBtn.classList.add('is-active'); listBtn.classList.remove('is-active');
      repaint();
    });
    listBtn.addEventListener('click', () => {
      isListView = true;
      savePrefs({ acctView: 'list' });
      listBtn.classList.add('is-active'); gridBtn.classList.remove('is-active');
      repaint();
    });
    wrap.append(gridBtn, listBtn);
    return wrap;
  }

  function buildAccountListRow(acc, curBal, budBal, portfolioValue) {
    const row = document.createElement('div');
    row.className = 'env-list-row account-list-row';
    // Not a role="button" row: it holds edit/action buttons. The name is the
    // row's primary <button>; clicks anywhere on the row still bubble here.
    if (budBal < -0.005) row.classList.add('over');
    if (acc.archived) row.classList.add('account--archived');

    const nameEl = document.createElement('button');
    nameEl.type = 'button';
    nameEl.className = 'env-list-name env-open';
    nameEl.append(document.createTextNode(acc.name || '(unnamed)'));
    if (acc.code) {
      const codeTag = document.createElement('span');
      codeTag.className = 'code-tag';
      codeTag.textContent = acc.code;
      nameEl.prepend(codeTag);
    }

    if (acc.type === 'investment' && acc.pensionInsurance) {
      const pensionTag = document.createElement('span');
      pensionTag.className = 'code-tag';
      pensionTag.textContent = t('accountCard.pensionBadge');
      nameEl.append(pensionTag);
    }

    const balEl = document.createElement('span');
    balEl.className = 'env-list-bal';
    balEl.append(moneyEl(budBal, { role: 'table' }));

    const subEl = document.createElement('span');
    subEl.className = 'env-list-sub';
    const diff = budBal - curBal;
    const subParts = [];
    if (Math.abs(diff) > 0.005) {
      const isDebit = diff < 0;
      const key = isDebit ? 'accountCard.upcomingHint' : 'accountCard.upcomingHintCredit';
      const fn = t(key);
      const formatted = fmt(Math.abs(diff));
      subParts.push(typeof fn === 'function'
        ? fn(formatted)
        : (isDebit ? `incl. ${formatted} upcoming` : `incl. +${formatted} upcoming`));
    }
    if (acc.type === 'investment'
        && acc.trackInvestments !== false
        && Number.isFinite(portfolioValue)) {
      subParts.push(t('accountCard.portfolioValue')(fmt(portfolioValue)));
    }
    subEl.textContent = subParts.join(' · ');

    const actEl = document.createElement('span');
    actEl.className = 'env-list-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-ghost btn-sm btn-icon';
    const editLabel = t('accounts.editTitle');
    editBtn.title = editLabel;
    editBtn.setAttribute('aria-label', editLabel);
    editBtn.append(icon('pencil', 22));
    editBtn.addEventListener('click', e => { e.stopPropagation(); openAccountEdit(acc); });
    actEl.append(editBtn);

    if (!acc.archived) {
      // Investments and assets are revalued, not reconciled against a
      // statement, as on the card layout.
      const isAsset = acc.type === 'asset';
      const isInvestment = acc.type === 'investment' || isAsset;
      const recBtn = document.createElement('button');
      recBtn.type = 'button';
      recBtn.className = 'btn btn-ghost btn-sm btn-icon';
      const recLabel = isInvestment
        ? t(isAsset ? 'assetValue.btnTooltip' : 'investmentValue.btnTooltip')
        : t('reconcile.btnTooltip');
      recBtn.title = recLabel;
      recBtn.setAttribute('aria-label', recLabel);
      recBtn.append(icon(isInvestment ? 'refresh' : 'scale', 22));
      recBtn.addEventListener('click', e => {
        e.stopPropagation();
        if (isInvestment) {
          openInvestmentValueDialog(acc.id, () => navigate('accounts'), { asset: isAsset });
        } else {
          openReconcileModal(acc.id, () => navigate('accounts'));
        }
      });
      actEl.append(recBtn);

      if (isAiFeatureEnabled('reconcile')) {
        const aiBtn = document.createElement('button');
        aiBtn.type = 'button'; aiBtn.className = 'btn btn-ghost btn-sm btn-icon';
        const sparkle = document.createElement('span');
        sparkle.textContent = '✨';
        sparkle.setAttribute('aria-hidden', 'true');
        aiBtn.append(sparkle);
        aiBtn.setAttribute('aria-label', t('ai.reconcile.btnAccount'));
        aiBtn.title = t('ai.reconcile.btnAccount');
        aiBtn.addEventListener('click', e => {
          e.stopPropagation();
          openReconcileSheet({ accountId: acc.id });
        });
        actEl.append(aiBtn);
      }
    }

    row.append(nameEl, balEl, subEl, actEl);
    listColumnRow(row, 'accounts');
    row.addEventListener('click', () => navigate('transactions', `account:${acc.id}`));
    return row;
  }

  searchInput.addEventListener('input', repaint);
  typeSel.addEventListener('change', repaint);

  repaint();
  container.append(page);
}

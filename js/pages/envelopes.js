import { node } from '../ui/planning-workspace.js';
import { listColumns, listColumnRow } from '../ui/list-columns.js';
// js/pages/envelopes.js
import { state, session, updateStatusBar, navigate, getPrefs, savePrefs, now as appNow, activeLensInput } from '../app.js';
import { envelopeMeterState } from '../ui/envelope-meter.js';
import { LENS_TODAY, LENS_BOOKED } from '../engine.js';
import { ask } from '../ui/query.js';
import { isoDate } from '../core/context.js';
import { envelopeCard, fundsLabel } from '../ui/envelope-card.js';
import { openEmergencyCalcDialog } from '../ui/emergency-calc-dialog.js';
import { t, trCat, trEnv, fmtDateShortLang } from '../ui/i18n.js';
import { openEnvelopeEdit } from './envelope-edit.js';
import { dispatchOrReport } from '../ui/save-error.js';
import { moneyEl } from '../ui/money.js';
import { icon } from '../ui/icon.js';
import { infoButton } from '../ui/info-button.js';
import { emptyState } from '../ui/empty-state.js';
import { openFillEnvelopes } from './fill-envelopes.js';
import { openEnvelopeHealth } from './envelope-health.js';
import { fmt } from '../utils.js';
import { enableTouchReorder } from '../ui/touch-reorder.js';
import { announce } from '../ui/announce.js';

let draggedEnvId = null;
let draggedGroupCat = null;
// The group key of the archived envelopes; no category can be named this.
const ARCHIVED_GROUP = '\u0000archived';

export async function render(container) {
  const initialFilter = state.pendingFilter;
  state.pendingFilter = null;

  const page = document.createElement('div');
  page.className = 'page working-money';

  const stickyTop = document.createElement('div');
  stickyTop.className = 'page-sticky-top-wrap';
  page.append(stickyTop);

  let isListView = getPrefs().envView === 'list';

  const showArchived = !!(state.meta && state.meta.show_archived_envelopes);
  // Page-local copy of the display order: a reorder repaints from it at once,
  // while the session commits (and publishes state.envelopes) only on success.
  let envelopes = state.envelopes;
  const renderedFolder = state.budgetFolder;
  const active = envelopes.filter(e => !e.archived);

  // The figures are the queries': `envelopes.month` for every listed envelope
  // (the active ones, or all of them when archived are shown) and `balances`
  // for Unallocated, through the active lens. Spare and fill % run a 12-month
  // projection per envelope, and a set-mode template's target is projected
  // with its source, so they are asked for the whole list, never the searched
  // part: a search or a category only chooses which rows show. The answers
  // depend only on the budget's arrays, the lens and today, so they are kept
  // while those stay the same: a keystroke, a category, the view toggle or a
  // reorder still in flight repaints without asking again. A write replaces
  // an array, which asks again.
  //
  // Per envelope: balance (lens), todayBalance (Today lens; "incl. X
  // upcoming" is `balance − todayBalance`, the part of the displayed balance
  // that has not cleared yet, as on the account card), planned, monthPlanned
  // (this month's calendar plan, what spent is set against), spent, spare,
  // fundsTemplates (the scheduled templates it bankrolls), goal and funding
  // (fill %). A failed query shows an explicit unavailable state.
  let figuresCache = null;
  function figures() {
    const lens = activeLensInput();
    const date = isoDate(appNow());
    const key = [lens.lens, lens.horizon, date, state.transactions, state.budgetItems, state.envelopeTemplates,
      state.accounts, state.envelopes, state.meta];
    if (figuresCache && figuresCache.key.every((v, i) => v === key[i])) return figuresCache.value;
    const listed = state.envelopes.filter(e => showArchived || !e.archived).map(e => e.id);
    const month = ask('envelopes.month', { ...lens, date, envelopes: listed });
    const bal = ask('balances', lens);
    const value = {
      rows: new Map((month?.envelopes || []).map(r => [r.id, r])),
      available: month != null,
      unallocated: bal ? bal.unallocated : null,
    };
    figuresCache = { key, value };
    return value;
  }
  let rows;
  let available;
  let totalBal;
  let unallocated;
  // The head counts and sums the envelopes the page lists (the archived ones
  // too while they are shown), whatever the search.
  const listedEnvelopes = () => (showArchived ? envelopes : active);
  function refreshFigures() {
    ({ rows, unallocated, available } = figures());
    totalBal = listedEnvelopes().reduce((s, e) => s + (rows.get(e.id)?.balance || 0), 0);
  }
  refreshFigures();

  const head = document.createElement('div');
  head.className = 'page-head';
  const left = document.createElement('div');
  const h1 = document.createElement('h1');
  h1.textContent = t('envelopes.title');
  h1.append(infoButton('envelopes', {
    body: [t('help.envelopes.body'), t('help.envelopeFigures.body')].join('\n\n'),
  }));
  left.append(h1);
  const sub = document.createElement('div');
  sub.className = 'page-head-sub';
  function refreshHeadSub() {
    sub.replaceChildren();
    const listed = listedEnvelopes();
    const archivedN = listed.length - active.length;
    const count = archivedN > 0
      ? t('envelopes.countWithArchived')(listed.length, archivedN)
      : t('envelopes.countN')(listed.length);
    sub.append(document.createTextNode(count));
    if (available) sub.append(document.createTextNode(' · '), moneyEl(totalBal, { size: 'sm' }));
  }
  refreshHeadSub();
  left.append(sub);
  head.append(left);
  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.append(buildViewToggle());

  // State-aware header action button. Three states all open the Fill Envelopes sheet:
  //   unallocated > 0  → green "Assign €X →"
  //   unallocated < 0  → red   "Correct €X →"
  //   unallocated ≈ 0  → gray  "Fill envelopes"
  const headerActionBtn = document.createElement('button');
  function refreshHeaderActionBtn() {
    // A failed balances query leaves the figure off: no button, never a 0.
    headerActionBtn.hidden = unallocated == null;
    if (unallocated == null) return;
    if (unallocated > 0.005) {
      headerActionBtn.className = 'btn btn-accent';
      headerActionBtn.textContent = t('dashboard.heroActionAssign')(fmt(unallocated));
    } else if (unallocated < -0.005) {
      headerActionBtn.className = 'btn btn-danger';
      headerActionBtn.textContent = t('dashboard.heroActionCorrect')(fmt(Math.abs(unallocated)));
    } else {
      headerActionBtn.className = 'btn btn-ghost';
      headerActionBtn.textContent = t('fillEnvelopes.title') || 'Fill envelopes';
    }
  }
  refreshHeaderActionBtn();
  headerActionBtn.addEventListener('click', () => openFillEnvelopes({ onSubmitted: () => repaint() }));

  const newBtn = document.createElement('button');
  newBtn.id = 'env-new';
  newBtn.className = 'btn btn-accent';
  newBtn.textContent = `+ ${t('envelopes.newEnv')}`;
  newBtn.addEventListener('click', () => openEnvelopeEdit(null));
  actions.append(headerActionBtn, newBtn);
  head.append(actions);
  stickyTop.append(head);

  const detailsToggle = document.createElement('button');
  detailsToggle.type = 'button';
  detailsToggle.className = 'btn btn-sm btn-ghost env-details-toggle';
  detailsToggle.textContent = t('columns.details');
  detailsToggle.setAttribute('aria-controls', 'envelope-groups');
  detailsToggle.addEventListener('click', () => {
    savePrefs({ envSupportingDetails: !getPrefs().envSupportingDetails });
    refreshDetails();
  });
  function refreshDetails() {
    const expanded = getPrefs().envSupportingDetails === true;
    page.classList.toggle('show-envelope-details', expanded);
    detailsToggle.setAttribute('aria-pressed', String(expanded));
    detailsToggle.hidden = isListView;
  }

  const filters = document.createElement('div');
  filters.className = 'filters';
  const search = document.createElement('div');
  search.className = 'search';
  const searchIcon = document.createElement('span');
  searchIcon.style.color = 'var(--muted)';
  searchIcon.style.display = 'inline-flex';
  searchIcon.append(icon('search', 16));
  const searchInput = document.createElement('input');
  searchInput.placeholder = t('envelopes.search');
  const searchCount = document.createElement('span');
  searchCount.className = 'search-count';
  searchCount.setAttribute('aria-live', 'polite');
  search.append(searchIcon, searchInput, searchCount);
  filters.append(search);

  const catSel = document.createElement('select');
  // eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped
  catSel.innerHTML = `<option value="">${t('envelopes.allCategories')}</option>`;
  const cats = [...new Set(active.map(e => e.category || 'other'))].sort();
  cats.forEach(c => {
    const o = document.createElement('option'); o.value = c; o.textContent = trCat(c);
    catSel.append(o);
  });
  filters.append(catSel);

  const focusFilter = node('select');
  focusFilter.setAttribute('aria-label', t('workspace.views'));
  for (const [value,label] of [['all',t('workspace.all')],['gap',t('moneyWorkspace.projectedGap')],['negative',t('moneyWorkspace.negativeBalance')]]) {
    const option = node('option','',label); option.value = value; focusFilter.append(option);
  }
  filters.append(focusFilter, detailsToggle);
  focusFilter.addEventListener('change', repaint);
  searchInput.setAttribute('aria-label', t('envelopes.search'));
  catSel.setAttribute('aria-label', t('envelopes.allCategories'));
  stickyTop.append(filters);
  const columnHead = node('div', 'money-column-head');
  stickyTop.append(columnHead);

  const groupsHost = document.createElement('div');
  groupsHost.id = 'envelope-groups';
  page.append(groupsHost);

  function repaint() {
    refreshDetails();
    // Flows that change the budget (Fill Envelopes, archive/unarchive, etc.)
    // replace its arrays, so the next paint asks the queries again instead of
    // showing the figures of the first render.
    refreshFigures();
    refreshHeadSub();
    refreshHeaderActionBtn();

    groupsHost.innerHTML = '';
    if (!available) {
      listColumns(groupsHost, 'envelopes', false, columnHead);
      searchCount.textContent = '';
      searchCount.classList.remove('is-empty');
      const unavailable = emptyState({
        icon: 'envelope',
        title: t('envelopes.loadFailed'),
        body: t('envelopes.loadFailedBody'),
        action: { label: t('envelopes.retry'), onClick: () => {
          figuresCache = null;
          repaint();
        } },
      });
      unavailable.setAttribute('role', 'status');
      groupsHost.append(unavailable);
      return;
    }

    const term = searchInput.value.trim().toLowerCase();
    const filterCat = catSel.value;
    const visible = showArchived ? envelopes : active;
    const filtered = visible.filter(e => rows.has(e.id) &&
      (!term || e.name.toLowerCase().includes(term) || (e.code || '').toLowerCase().includes(term)) &&
      (!filterCat || (e.category || 'other') === filterCat) &&
      (focusFilter.value !== 'gap' || rows.get(e.id)?.spare?.spare < -0.005) &&
      (focusFilter.value !== 'negative' || rows.get(e.id)?.balance < -0.005)
    );
    listColumns(groupsHost, 'envelopes', isListView && filtered.length > 0, columnHead);

    if (term || filterCat || focusFilter.value !== 'all') {
      searchCount.textContent = filtered.length === 0
        ? t('common.noResults')
        : t('common.resultsFound')(filtered.length);
      searchCount.classList.toggle('is-empty', filtered.length === 0);
    } else {
      searchCount.textContent = '';
      searchCount.classList.remove('is-empty');
    }
    if (!filtered.length) {
      const isFiltered = !!(term || filterCat || focusFilter.value !== 'all');
      groupsHost.append(emptyState(
        isFiltered
          ? {
              icon: 'envelope',
              title: t('envelopes.allCategories') + '…',
              body: t('transactions.searchWider') || 'No matches. Try a different search or category.',
            }
          : {
              icon: 'envelope',
              title: t('envelopes.empty'),
              body: t('envelopes.emptyBody'),
              action: { label: t('envelopes.emptyAction'), onClick: () => openEnvelopeEdit(null) },
            },
      ));
      return;
    }
    // Archived envelopes, when shown, sit together in one Archived group after
    // the categories: in their own categories they would make groups of
    // nothing but archived cards (an imported "Available" envelope in a
    // category called Unallocated read as a second Unallocated).
    const byCat = {};
    const catOrder = [];
    for (const e of filtered) {
      if (e.archived) continue;
      const k = e.category || 'other';
      if (!byCat[k]) { byCat[k] = []; catOrder.push(k); }
      byCat[k].push(e);
    }
    const archivedShown = filtered.filter(e => e.archived);
    const groupOrder = archivedShown.length ? [...catOrder, ARCHIVED_GROUP] : catOrder;
    if (archivedShown.length) byCat[ARCHIVED_GROUP] = archivedShown;
    // Spare is measured from today; a lens that shows later money in the
    // balance also says when a short envelope is covered (see envelope-card).
    const showCoveredDate = getPrefs().lens !== LENS_TODAY;
    // Booked counts entered future bills but not the scheduled fills that pay
    // them; a negative balance the forecast covers says when (envelope-card).
    const showBalanceCovered = getPrefs().lens === LENS_BOOKED;

    groupOrder.forEach(cat => {
      const isArchivedGroup = cat === ARCHIVED_GROUP;
      const group = document.createElement('div');
      group.style.marginBottom = '28px';
      group.dataset.groupCat = cat;

      const catHead = document.createElement('div');
      catHead.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px;cursor:grab;';
      catHead.draggable = !isArchivedGroup;
      if (isArchivedGroup) catHead.style.cursor = '';
      catHead.addEventListener('dragstart', (e) => {
        draggedGroupCat = cat;
        e.dataTransfer.effectAllowed = 'move';
        // Prevent envelope-card drag from also firing
        e.stopPropagation();
      });
      catHead.addEventListener('dragend', () => {
        draggedGroupCat = null;
        groupsHost.querySelectorAll('.drag-over-group').forEach(el => el.classList.remove('drag-over-group'));
      });
      catHead.addEventListener('dragover', (e) => {
        if (!draggedGroupCat || draggedGroupCat === cat || isArchivedGroup) return;
        e.preventDefault();
        catHead.classList.add('drag-over-group');
      });
      catHead.addEventListener('dragleave', () => catHead.classList.remove('drag-over-group'));
      catHead.addEventListener('drop', (e) => {
        catHead.classList.remove('drag-over-group');
        if (!draggedGroupCat || draggedGroupCat === cat) return;
        e.preventDefault();
        reorderGroup(draggedGroupCat, cat);
      });
      const collapsedSet = new Set(getPrefs().envGroupsCollapsed || []);
      const isCollapsed = collapsedSet.has(cat);

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'group-toggle';
      toggleBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      toggleBtn.setAttribute('aria-label', isCollapsed ? t('common.expand') : t('common.collapse'));
      toggleBtn.append(icon('chevronR', 16));
      toggleBtn.addEventListener('mousedown', (e) => e.stopPropagation());
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = new Set(getPrefs().envGroupsCollapsed || []);
        if (cur.has(cat)) cur.delete(cat); else cur.add(cat);
        savePrefs({ envGroupsCollapsed: Array.from(cur) });
        const nowCollapsed = cur.has(cat);
        toggleBtn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        toggleBtn.setAttribute('aria-label', nowCollapsed ? t('common.expand') : t('common.collapse'));
        container.style.display = nowCollapsed ? 'none' : '';
      });

      // Keyboard alternative to dragging a whole category, on the toggle
      // button because it is the group's existing focus stop — adding a tab
      // stop to the header itself would put one before every group.
      toggleBtn.addEventListener('keydown', (e) => {
        if (isArchivedGroup) return;
        if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        if (!moveGroupBy(cat, e.key === 'ArrowUp' ? -1 : 1, catOrder)) return;
        announce((e.key === 'ArrowUp' ? t('common.movedUp') : t('common.movedDown'))(trCat(cat)));
        requestAnimationFrame(() => {
          groupsHost.querySelector(`[data-group-cat="${CSS.escape(cat)}"] .group-toggle`)?.focus();
        });
      });

      const titleWrap = document.createElement('div');
      titleWrap.style.cssText = 'display:flex;align-items:center;min-width:0;';
      const h3 = document.createElement('h3');
      h3.style.cssText = 'font-family:var(--font-display);font-weight:400;font-size:24px;letter-spacing:-0.01em;';
      h3.textContent = isArchivedGroup ? t('envelopes.archivedGroup') : trCat(cat);
      titleWrap.append(toggleBtn, h3);

      const right = document.createElement('div');
      right.style.cssText = 'display:flex;align-items:baseline;gap:10px;';
      const catBal = byCat[cat].reduce((s, e) => s + (rows.get(e.id)?.balance || 0), 0);
      const catCount = document.createElement('span');
      catCount.className = 'muted';
      catCount.style.fontSize = '12px';
      catCount.textContent = t('envelopes.countN')(byCat[cat].length);
      right.append(catCount, moneyEl(catBal, { size: 'md' }));
      catHead.append(titleWrap, right);
      group.append(catHead);

      const container = document.createElement('div');
      container.className = isListView ? 'env-list' : 'env-grid';
      if (isCollapsed) container.style.display = 'none';
      const emergencyId = state.meta?.emergency_envelope_id || null;
      byCat[cat].forEach(env => {
        const f = rows.get(env.id);
        const { balance, planned, monthPlanned, spent, spare, fundsTemplates } = f;
        const upcomingDelta = f.balance - f.todayBalance;
        let card;
        if (isListView) {
          card = buildEnvelopeListRow(env, balance, planned, monthPlanned, spent, spare, fundsTemplates, showCoveredDate, showBalanceCovered);
        } else {
          card = envelopeCard({
            envelope: env,
            balance,
            planned,
            monthPlanned,
            spent,
            spare,
            showCoveredDate,
            showBalanceCovered,
            fundsTemplates,
            itemFunding: f.funding,
            goal: f.goal,
            upcomingDelta,
            isEmergency: env.id === emergencyId,
            onClick: (e) => navigate('transactions', e.id),
            onToggleFavorite: toggleFavorite,
            onEdit: (e) => openEnvelopeEdit(e),
            onHealthCheck: env.archived ? null : (e) => openEnvelopeHealth(e),
            onShowCalculation: env.id === emergencyId
              ? () => {
                  // The whole calculation, through the lens, for this month.
                  const calc = ask('emergency.requirement', { ...activeLensInput(), month: isoDate(appNow()).slice(0, 7) });
                  if (calc) openEmergencyCalcDialog(calc, env);
                }
              : null,
          });
          if (env.archived) card.classList.add('env--archived');
        }
        card.draggable = true;
        card.addEventListener('dragstart', e => {
          draggedEnvId = env.id;
          e.dataTransfer.effectAllowed = 'move';
        });
        card.addEventListener('dragend', () => {
          draggedEnvId = null;
          container.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
        });
        card.addEventListener('dragover', e => {
          if (!draggedEnvId || draggedEnvId === env.id) return;
          if (groupOf(envelopes.find(e2 => e2.id === draggedEnvId)) !== cat) return;
          e.preventDefault();
          card.classList.add('drag-over');
        });
        card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
        card.addEventListener('drop', e => {
          card.classList.remove('drag-over');
          if (!draggedEnvId || draggedEnvId === env.id) return;
          if (groupOf(envelopes.find(e2 => e2.id === draggedEnvId)) !== cat) return;
          e.preventDefault();
          reorderEnvelope(draggedEnvId, env.id);
        });
        card.dataset.envId = env.id;
        enableTouchReorder({
          handle: card,
          getItemId: () => env.id,
          getDropTarget: (x, y) => {
            const els = document.elementsFromPoint(x, y);
            for (const el of els) {
              const c = el.closest && el.closest('[data-env-id]');
              if (c && c !== card) {
                const id = c.dataset.envId;
                if (id) return { id, el: c, kind: 'card' };
              }
            }
            return null;
          },
          onReorder: ({ from, to }) => reorderEnvelope(from, to),
        });
        // Keyboard alternative to drag: Alt+ArrowUp/Down moves the focused
        // card within its category. Focus follows the card across the
        // repaint, and the move is announced to screen readers.
        card.addEventListener('keydown', (e) => {
          if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
          e.preventDefault();
          const neighbor = e.key === 'ArrowUp' ? card.previousElementSibling : card.nextElementSibling;
          if (!neighbor?.dataset?.envId) return;
          reorderEnvelope(env.id, neighbor.dataset.envId);
          announce((e.key === 'ArrowUp' ? t('common.movedUp') : t('common.movedDown'))(env.name));
          requestAnimationFrame(() => {
            groupsHost.querySelector(`[data-env-id="${CSS.escape(env.id)}"]`)?.focus();
          });
        });
        container.append(card);
      });
      group.append(container);
      groupsHost.append(group);
    });
  }

  const catOf = (e) => e.category || 'other';
  // The group a card shows in: its category, or Archived. A card is dropped
  // only within its own group.
  const groupOf = (e) => (!e ? null : e.archived && showArchived ? ARCHIVED_GROUP : catOf(e));

  // Dispatches still in flight. The session serialises them, so a later one
  // lands after an earlier one; each is computed from the page-local order.
  let inflight = 0;

  function paintLocal(next) {
    envelopes = next;
    active.length = 0;
    active.push(...next.filter(e => !e.archived));
    repaint();
  }

  // Whether any dispatch of the current burst (everything pending together)
  // failed. A failure is never left showing: when the burst ends, the page
  // repaints from state.envelopes, which the session leaves untouched by a
  // failed command and which holds every success.
  let burstFailed = false;

  /**
   * One envelope command. Once nothing is pending, a burst with any failure
   * repaints from state.envelopes; a burst without one keeps the page-local
   * order, which equals state. After a budget switch the failure repaint is
   * skipped: state.envelopes then belongs to another budget.
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
    if (failed) paintLocal(state.envelopes);
  }

  // Array order IS display order (see AGENTS.md): every reorder computes the
  // complete new order and hands it to envelope.reorder.
  function applyEnvelopeOrder(next) {
    paintLocal(next);
    return dispatchSettled('envelope.reorder', { ids: next.map(e => e.id) });
  }

  async function reorderGroup(srcCat, dstCat) {
    // Move all envelopes of srcCat to appear just before envelopes of dstCat.
    // Category order is derived from first-appearance in the order; this
    // preserves within-group envelope order for both categories.
    const src = envelopes.filter(e => catOf(e) === srcCat);
    if (!src.length) return;
    const without = envelopes.filter(e => catOf(e) !== srcCat);
    const dstIdx = without.findIndex(e => catOf(e) === dstCat);
    if (dstIdx < 0) return;
    await applyEnvelopeOrder([...without.slice(0, dstIdx), ...src, ...without.slice(dstIdx)]);
  }

  /**
   * Move a whole category one place up or down — the keyboard equivalent of
   * dragging its header. Returns false when there is nowhere to go, so the
   * caller can skip announcing a move that did not happen.
   *
   * Unlike `reorderGroup` this inserts AFTER the neighbour when moving down,
   * which is what lets the last-but-one group reach the end. `order` is the
   * VISIBLE category order, so a filtered-out or archived-only category is
   * never a destination the user cannot see.
   */
  function moveGroupBy(cat, delta, order) {
    const target = order[order.indexOf(cat) + delta];
    if (!target) return false;
    const src = envelopes.filter(e => catOf(e) === cat);
    if (!src.length) return false;
    const rest = envelopes.filter(e => catOf(e) !== cat);
    const hits = rest.reduce((acc, e, k) => (catOf(e) === target ? [...acc, k] : acc), []);
    if (!hits.length) return false;
    const at = delta < 0 ? hits[0] : hits[hits.length - 1] + 1;
    applyEnvelopeOrder([...rest.slice(0, at), ...src, ...rest.slice(at)]);
    return true;
  }

  async function reorderEnvelope(draggedId, targetId) {
    const envs = [...envelopes];
    const from = envs.findIndex(e => e.id === draggedId);
    const to   = envs.findIndex(e => e.id === targetId);
    if (from === -1 || to === -1 || from === to) return;
    const [item] = envs.splice(from, 1);
    envs.splice(to, 0, item);
    await applyEnvelopeOrder(envs);
  }

  async function toggleFavorite(env) {
    const cur = envelopes.find(e => e.id === env.id);
    if (!cur) return;
    const favorite = !cur.favorite;
    paintLocal(envelopes.map(e => (e.id === env.id ? { ...e, favorite } : e)));
    await dispatchSettled('envelope.update', { id: env.id, fields: { favorite } });
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
      savePrefs({ envView: 'card' });
      gridBtn.classList.add('is-active'); listBtn.classList.remove('is-active');
      repaint();
    });
    listBtn.addEventListener('click', () => {
      isListView = true;
      savePrefs({ envView: 'list' });
      listBtn.classList.add('is-active'); gridBtn.classList.remove('is-active');
      repaint();
    });
    wrap.append(gridBtn, listBtn);
    return wrap;
  }

  function buildEnvelopeListRow(env, balance, planned, monthPlanned, spent, spare, fundsTemplates, showCoveredDate = false, showBalanceCovered = false) {
    // Same rule as the grid card: under Booked, a negative balance the
    // forecast covers names its date instead of reading "over".
    const balanceCovered = showBalanceCovered && balance < -0.005
      && !!spare && Number.isFinite(spare.spare) && spare.spare >= -0.005
      ? spare.balanceCoveredDate || null : null;
    const { isOver, isTight, isFunded, overPlan, meterPct } = envelopeMeterState({
      balance, planned, monthPlanned, spent, spare, balanceCovered: !!balanceCovered,
    });

    const row = document.createElement('div');
    row.className = 'env-list-row';
    // Not a role="button" row: it holds edit/action buttons. The name is the
    // row's primary <button>; clicks anywhere on the row still bubble here.
    if (isOver)   row.classList.add('over');
    else if (isTight)  row.classList.add('low');
    else if (isFunded) row.classList.add('funded');
    if (env.archived) row.classList.add('env--archived');


    const nameEl = document.createElement('button');
    nameEl.type = 'button';
    nameEl.className = 'env-list-name env-open';
    nameEl.append(document.createTextNode(trEnv(env)));
    if (env.code) {
      const codeTag = document.createElement('span');
      codeTag.className = 'code-tag';
      codeTag.textContent = env.code;
      nameEl.prepend(codeTag);
    }

    const balEl = document.createElement('span');
    balEl.className = 'env-list-bal';
    balEl.title = t(balanceCovered ? 'envelopes.balanceCoveredTitle' : 'envelopes.balanceTitle');
    balEl.append(moneyEl(balance, { size: 'sm' }));
    const suffix = document.createElement('span');
    suffix.className = 'env-amt-suffix';
    suffix.textContent = ' ' + (balanceCovered ? t('envelopes.coveredSuffix')(fmtDateShortLang(balanceCovered))
      : isOver ? t('envelopes.overSuffix') : isTight ? t('envelopes.tightSuffix') : t('envelopes.leftSuffix'));
    balEl.append(suffix);
    // Spare at the balance's own size, as on the grid card (owner decision
    // 2026-09-24): both are headline figures, neither is a footnote.
    if (spare && Number.isFinite(spare.spare)) {
      const isShort = spare.spare < -0.005;
      const spareEl = document.createElement('div');
      spareEl.className = 'env-list-spare' + (isShort ? ' is-short' : '');
      spareEl.title = t('envelopes.spareTitle');
      const spareSuffix = document.createElement('span');
      spareSuffix.className = 'env-amt-suffix';
      const coveredDate = showCoveredDate && isShort ? spare.coveredDate || null : null;
      spareSuffix.textContent = ' ' + (coveredDate
        ? t('envelopes.shortUntilSuffix')(fmtDateShortLang(coveredDate))
        : t(isShort ? 'envelopes.shortSuffix' : 'envelopes.spareSuffix'));
      spareEl.append(moneyEl(spare.spare, { size: 'sm' }), spareSuffix);
      balEl.append(spareEl);
    }
    const progressEl = document.createElement('div');
    progressEl.className = 'env-list-progress';

    // Spent against this month's plan, as on the grid card: the operand that
    // makes the spare figure above checkable.
    const monthPlan = Number.isFinite(monthPlanned) ? monthPlanned : planned;
    if (planned > 0 && Number.isFinite(spent)) {
      const spentEl = document.createElement('div');
      spentEl.className = 'env-list-spent' + (monthPlan > 0 && spent > monthPlan + 0.005 ? ' is-over-plan' : '');
      spentEl.title = t('envelopes.spentTitle');
      spentEl.textContent = monthPlan > 0
        ? t('envelopes.spentOfPlanned')({ spent: fmt(spent), amt: fmt(monthPlan) })
        : spent > 0.005
          ? `${t('envelopes.spentOnly')(fmt(spent))} · ${t('envelopes.nothingPlannedMonth')}`
          : t('envelopes.nothingPlannedMonth');
      progressEl.append(spentEl);
    }
    // Same "this drain is deliberate" note the grid card carries — the list
    // view shows the falling balance just as plainly.
    if (Array.isArray(fundsTemplates) && fundsTemplates.length > 0) {
      const fundsEl = document.createElement('div');
      fundsEl.className = 'env-list-funds';
      fundsEl.title = t('envelopes.fundsTemplateTitle');
      fundsEl.textContent = fundsLabel(fundsTemplates);
      balEl.append(fundsEl);
    }

    const meterWrap = document.createElement('span');
    meterWrap.className = 'env-list-meter';
    const meterFill = document.createElement('span');
    meterFill.className = 'fill';
    meterFill.style.width = '0%';
    meterWrap.append(meterFill);
    progressEl.prepend(meterWrap);
    if (overPlan) meterWrap.classList.add('is-over-plan');
    requestAnimationFrame(() => { meterFill.style.width = meterPct + '%'; });

    const actEl = document.createElement('span');
    actEl.className = 'env-list-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-ghost btn-sm btn-icon';
    const editLabel = t('envelopes.editTitle');
    editBtn.title = editLabel;
    editBtn.setAttribute('aria-label', editLabel);
    editBtn.append(icon('pencil', 22));
    editBtn.addEventListener('click', e => { e.stopPropagation(); openEnvelopeEdit(env); });
    actEl.append(editBtn);

    // Same action the grid card offers — an envelope's health check should not
    // depend on which view the user happens to prefer.
    if (!env.archived) {
      const healthBtn = document.createElement('button');
      healthBtn.type = 'button';
      healthBtn.className = 'btn btn-ghost btn-sm btn-icon';
      const healthLabel = t('workspace.reviewFocus');
      healthBtn.title = healthLabel;
      healthBtn.setAttribute('aria-label', healthLabel);
      healthBtn.append(icon('pulse', 22));
      healthBtn.addEventListener('click', e => { e.stopPropagation(); openEnvelopeHealth(env); });
      actEl.append(healthBtn);
    }

    row.append(nameEl, balEl, progressEl, actEl);
    listColumnRow(row, 'envelopes');
    row.addEventListener('click', () => navigate('transactions', env.id));
    return row;
  }

  searchInput.addEventListener('input', repaint);
  catSel.addEventListener('change', repaint);

  if (initialFilter) {
    const targetEnv = active.find(e => e.id === initialFilter);
    if (targetEnv) searchInput.value = targetEnv.name;
  }

  repaint();

  container.append(page);
}

// ── AI envelope health card ─────────────────────────────────────────────


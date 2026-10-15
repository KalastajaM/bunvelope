// js/ui/shell.js
import { featureEnabled } from './features.js';
import { icon } from './icon.js';
import { bunvelopeLogo } from './logo.js';
import { t } from './i18n.js';
import { lensControl, relabelLensControls } from './lens-control.js';
import { isAiAvailable } from '../ai/client.js';

// `advanced` marks the pages simple mode leaves out of the nav (see
// applyPrefs). They stay routable: a link from another page still opens them.
const defaultCollapsedRailGroups = () => getNav().filter(item => item.children?.length).map(item => item.page);
let featurePrefs = {};
let collapsedRailGroups = new Set(defaultCollapsedRailGroups());

function getNav() {
  return [
    { page: 'dashboard',   labelKey: 'nav.overview',     iconName: 'home', children: [
      { page: 'detailed-insights', labelKey: 'nav.detailedInsights', iconName: 'chart' },
      { page: 'insights',  labelKey: 'nav.insights',     iconName: 'chart', aiOnly: true, advanced: true },
    ] },
    { page: 'envelopes',   labelKey: 'nav.envelopes',    iconName: 'envelope', children: [
      { page: 'templates', labelKey: 'nav.templates',    iconName: 'sliders', advanced: true },
    ] },
    { page: 'accounts',    labelKey: 'nav.accounts',     iconName: 'bank', children: [
      { page: 'net-worth', labelKey: 'nav.netWorth',     iconName: 'trendUp', advanced: true },
    ] },
    { page: 'transactions',labelKey: 'nav.transactions', iconName: 'tx' },
    { page: 'budget-plan', labelKey: 'nav.budget',       iconName: 'budget', children: [
      { page: 'recurring-costs', labelKey: 'recurring.nav', iconName: 'calendar' },
      { page: 'review',    labelKey: 'nav.review',       iconName: 'check', advanced: true },
      { page: 'stress',    labelKey: 'nav.stress',       iconName: 'warn', advanced: true },
    ] },
    { page: 'investments', labelKey: 'nav.investments',  iconName: 'trendUp', advanced: true },
    { page: 'reports',     labelKey: 'nav.reports',      iconName: 'chart', advanced: true, children: [
      { page: 'flow',      labelKey: 'nav.flow',         iconName: 'chart', advanced: true },
    ] },
    { page: 'settings',    labelKey: 'nav.settings',     iconName: 'settings', children: [
      // Actions, not pages: they open the Tweaks panel and the tour. They sit
      // together under Settings.
      { action: 'tweaks',  id: 'rail-tweaks', labelKey: 'nav.tweaks', iconName: 'sliders', railOnly: true },
      { action: 'help',    id: 'rail-help',   labelKey: 'tour.help',  iconName: 'help',    railOnly: true, titleKey: 'tour.helpTitle' },
    ] },
  ];
}

/** Whether simple mode leaves this page out of the nav. */
export function isAdvancedPage(page) {
  return flatNav().some(n => n.page === page && n.advanced);
}

function flatNav() {
  const out = [];
  getNav().forEach(item => {
    out.push(item);
    (item.children || []).forEach(c => out.push({ ...c, parentPage: item.page }));
  });
  return out;
}

export function buildShell({ onNavigate, onNewTransaction, onBudgetClick, onUnallocatedClick, onTweaksToggle, onHelpClick, onRailGroupsChange, lens }) {
  const rail = document.getElementById('rail');
  const topnav = document.getElementById('topnav');
  rail.innerHTML = '';
  topnav.innerHTML = '';
  rail.setAttribute('aria-label', t('nav.primaryLabel'));
  topnav.setAttribute('aria-label', t('nav.primaryTopLabel'));

  // On a phone the rail becomes an off-canvas drawer behind a menu button
  // (css/app.css, the max-width: 840px block). Picking a destination closes
  // it, so every nav handler goes through this wrapper.
  buildMobileBar(rail);
  const go = (page) => { setDrawerOpen(false); onNavigate(page); };
  const goUnalloc = () => { setDrawerOpen(false); onUnallocatedClick(); };

  // A11y on statusbar + separators (once).
  const statusbar = document.getElementById('statusbar');
  if (statusbar && !statusbar.hasAttribute('role')) {
    statusbar.setAttribute('role', 'region');
    statusbar.setAttribute('aria-label', t('tweaks.statusbar'));
    document.getElementById('status-unallocated')?.setAttribute('aria-live', 'polite');
    statusbar.querySelectorAll('.sep').forEach(s => s.setAttribute('aria-hidden', 'true'));
  }

  // Rail brand
  const brand = document.createElement('div');
  brand.className = 'rail-brand';
  brand.append(bunvelopeLogo(32));
  const brandLabel = document.createElement('span');
  brandLabel.textContent = 'Bunvelope';
  brand.append(brandLabel);
  rail.append(brand);

  // Rail items. An item with an `action` runs it instead of navigating.
  const actions = {
    tweaks: (e) => onTweaksToggle(e),
    help: onHelpClick ? (e) => onHelpClick(e) : null,
  };
  const addRailItem = (item, isChild, host = rail, onActivate) => {
    if (item.action && !actions[item.action]) return;
    const el = document.createElement('div');
    el.className = 'rail-item' + (isChild ? ' rail-sub' : '');
    if (item.action) {
      el.dataset.action = item.action;
      if (item.id) el.id = item.id;
    } else {
      el.dataset.page = item.page;
    }
    if (isChild) el.dataset.parent = item.parentPage || '';
    if (item.aiOnly) el.hidden = true;
    if (item.advanced) el.dataset.advanced = '';
    el.setAttribute('role','button');
    el.tabIndex = 0;
    el.append(icon(item.iconName));
    const lbl = document.createElement('span');
    lbl.className = 'label';
    lbl.textContent = t(item.labelKey);
    el.append(lbl);
    el.setAttribute('aria-label', t(item.labelKey));
    if (item.titleKey) el.title = t(item.titleKey);
    const activate = item.action
      ? (e) => { setDrawerOpen(false); actions[item.action](e); }
      : () => { onActivate?.(); go(item.page); };
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e); }
    });
    host.append(el);
  };

  // Global budget controls live together in the always-visible status bar.
  if (statusbar) {
    const controls = document.createElement('div');
    controls.className = 'status-controls';
    if (lens) controls.append(lensControl({ read: lens.read, onChange: lens.onChange, variant: 'status' }));
    const newTransaction = document.createElement('button');
    newTransaction.type = 'button';
    newTransaction.id = 'status-new-transaction';
    newTransaction.className = 'btn btn-ghost btn-sm';
    newTransaction.textContent = '+ ' + t('transactions.new');
    newTransaction.addEventListener('click', () => { setDrawerOpen(false); onNewTransaction?.(); });
    controls.append(newTransaction);
    statusbar.prepend(controls);
  }
  document.getElementById('status-unallocated')?.addEventListener('click', goUnalloc);
  document.getElementById('status-path')?.addEventListener('click', () => { setDrawerOpen(false); onBudgetClick?.(); });
  // Measure wrapped forecast controls too, so neither bar position covers content.
  if (statusbar && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => {
      document.documentElement.style.setProperty('--statusbar-height', `${statusbar.getBoundingClientRect().height}px`);
    }).observe(statusbar);
  }

  // Ask AI sits alongside the balance controls in every navigation layout.
  // Hidden entirely when no transport is configured — a button that can only
  // ever explain why it does not work is worse than no button.
  const askBtn = document.createElement('button');
  askBtn.className = 'btn btn-ghost btn-sm status-ask';
  askBtn.id = 'status-ask-ai';
  askBtn.append(icon('pulse', 14));
  const ab = document.createElement('span'); ab.className = 'label'; ab.textContent = t('ai.dialog.railButton'); askBtn.append(ab);
  const shortcutHint = document.createElement('kbd');
  shortcutHint.className = 'status-kbd';
  shortcutHint.textContent = navigator.platform?.startsWith('Mac') ? '\u2318K' : 'Ctrl K';
  askBtn.append(shortcutHint);
  // Keep the shortcut discoverable when narrow screens hide the keyboard hint.
  askBtn.title = `${t('ai.dialog.railButton')} (${shortcutHint.textContent})`;
  askBtn.setAttribute('aria-label', t('ai.dialog.railButton'));
  askBtn.addEventListener('click', () => { setDrawerOpen(false); openAgentDialogFromShell(); });
  askBtn.hidden = !isAiAvailable();
  statusbar?.insertBefore(askBtn, document.getElementById('status-unallocated')?.nextSibling || null);

  getNav().forEach(item => {
    if (!item.children?.length) {
      addRailItem(item, false);
      return;
    }
    const group = document.createElement('div');
    group.className = 'rail-group';
    group.dataset.group = item.page;
    if (item.advanced) group.dataset.advanced = '';
    const row = document.createElement('div');
    row.className = 'rail-parent-row';
    const children = document.createElement('div');
    children.className = 'rail-submenu';
    children.id = `rail-submenu-${item.page}`;
    item.children.forEach(c => addRailItem({ ...c, parentPage: item.page }, true, children));
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'btn btn-ghost btn-sm rail-submenu-toggle';
    toggle.setAttribute('aria-controls', children.id);
    toggle.addEventListener('click', () => {
      if (collapsedRailGroups.has(item.page)) collapsedRailGroups.delete(item.page);
      else collapsedRailGroups.add(item.page);
      syncRailSubmenus();
      onRailGroupsChange?.([...collapsedRailGroups]);
    });
    addRailItem(item, false, row, () => {
      if (!toggle.hidden && collapsedRailGroups.has(item.page)) toggle.click();
    });
    row.append(toggle);
    group.append(row, children);
    rail.append(group);
  });
  syncRailSubmenus();

  // Topnav
  const tnBrand = document.createElement('div');
  tnBrand.className = 'brand';
  tnBrand.append(bunvelopeLogo(30));
  const tnBrandLbl = document.createElement('span');
  tnBrandLbl.textContent = 'Bunvelope';
  tnBrand.append(tnBrandLbl);
  topnav.append(tnBrand);

  const tnItems = document.createElement('div');
  tnItems.className = 'topnav-items';
  getNav().forEach(item => {
    const children = (item.children || []).filter(c => !c.railOnly);
    const hasChildren = children.length > 0;
    const wrap = document.createElement('div');
    wrap.className = 'topnav-group' + (hasChildren ? ' has-sub' : '');
    if (item.advanced) wrap.dataset.advanced = '';
    // In simple mode a group whose children are all advanced has no submenu.
    if (hasChildren && children.every(c => c.advanced)) wrap.classList.add('sub-advanced-only');

    const el = document.createElement('div');
    el.className = 'topnav-item';
    el.dataset.page = item.page;
    el.textContent = t(item.labelKey);
    el.setAttribute('role','button');
    el.tabIndex = 0;
    el.addEventListener('click', () => go(item.page));
    el.addEventListener('keydown', (e) => { if (e.key==='Enter'||e.key===' '){ e.preventDefault(); go(item.page); }});
    wrap.append(el);

    if (hasChildren) {
      const sub = document.createElement('div');
      sub.className = 'topnav-submenu';
      children.forEach(c => {
        const sEl = document.createElement('div');
        sEl.className = 'topnav-subitem';
        sEl.dataset.page = c.page;
        sEl.dataset.parent = item.page;
        if (c.aiOnly) sEl.hidden = true;
        if (c.advanced) sEl.dataset.advanced = '';
        sEl.textContent = t(c.labelKey);
        sEl.setAttribute('role','button');
        sEl.tabIndex = 0;
        sEl.addEventListener('click', (e) => { e.stopPropagation(); onNavigate(c.page); });
        sEl.addEventListener('keydown', (e) => { if (e.key==='Enter'||e.key===' '){ e.preventDefault(); onNavigate(c.page); }});
        sub.append(sEl);
      });
      wrap.append(sub);
    }
    tnItems.append(wrap);
  });
  topnav.append(tnItems);
  syncFeatureVisibility();
  syncRailSubmenus();
  syncTopnavSubmenus(tnItems);
  const spacer = document.createElement('div'); spacer.className = 'spacer'; topnav.append(spacer);

  const tail = document.createElement('div');
  tail.className = 'topnav-tail';
  // The rail's Tweaks entry is gone in this layout (the rail is hidden), and
  // Tweaks is where the layout itself and simple/full mode are switched, so
  // without this a top-nav user could not get back out.
  const tweaksBtn = document.createElement('button');
  tweaksBtn.type = 'button';
  tweaksBtn.className = 'btn btn-ghost btn-sm topnav-tweaks';
  tweaksBtn.id = 'topnav-tweaks';
  // Labelled, not a bare icon: it is the only way back to the side rail.
  const tweaksLbl = document.createElement('span');
  tweaksLbl.className = 'topnav-tweaks-label';
  tweaksLbl.textContent = t('nav.tweaks');
  tweaksBtn.append(icon('sliders', 16), tweaksLbl);
  tweaksBtn.title = t('tweaks.topHint');
  tweaksBtn.setAttribute('aria-label', t('tweaks.topHint'));
  tweaksBtn.addEventListener('click', (e) => onTweaksToggle(e));
  tail.append(tweaksBtn);
  topnav.append(tail);
}

export function relabelShell() {
  const newTransaction = document.getElementById('status-new-transaction');
  if (newTransaction) newTransaction.textContent = '+ ' + t('transactions.new');
  document.getElementById('statusbar')?.setAttribute('aria-label', t('tweaks.statusbar'));
  relabelLensControls();
  const rail = document.getElementById('rail');
  if (rail) rail.setAttribute('aria-label', t('nav.primaryLabel'));
  const topnav = document.getElementById('topnav');
  if (topnav) topnav.setAttribute('aria-label', t('nav.primaryTopLabel'));
  syncMenuButton();
  syncRailSubmenus();
  const byPage = Object.fromEntries(flatNav().map(n => [n.page, n]));

  document.querySelectorAll('.rail-item').forEach(el => {
    const item = byPage[el.dataset.page];
    if (!item) return;
    const lbl = el.querySelector('.label');
    if (lbl) lbl.textContent = t(item.labelKey);
    el.setAttribute('aria-label', t(item.labelKey));
  });

  document.querySelectorAll('.topnav-item, .topnav-subitem').forEach(el => {
    const item = byPage[el.dataset.page];
    if (!item) return;
    el.textContent = t(item.labelKey);
  });

  const topTweaks = document.getElementById('topnav-tweaks');
  if (topTweaks) {
    topTweaks.title = t('tweaks.topHint');
    topTweaks.setAttribute('aria-label', t('tweaks.topHint'));
    const lbl = topTweaks.querySelector('.topnav-tweaks-label');
    if (lbl) lbl.textContent = t('nav.tweaks');
  }
  // The Ask AI button is not a .rail-item, so the loop above skips it —
  // relabel it by id.
  const ask = document.getElementById('status-ask-ai');
  if (ask) {
    const lbl = ask.querySelector('.label');
    if (lbl) lbl.textContent = t('ai.dialog.railButton');
    const kbd = ask.querySelector('.status-kbd');
    ask.title = `${t('ai.dialog.railButton')} (${kbd?.textContent ?? ''})`;
    ask.setAttribute('aria-label', t('ai.dialog.railButton'));
  }
  document.querySelectorAll('.rail-item[data-action]').forEach(el => {
    const item = flatNav().find(n => n.action === el.dataset.action);
    const lbl = el.querySelector('.label');
    if (item && lbl) lbl.textContent = t(item.labelKey);
    if (item) el.setAttribute('aria-label', t(item.labelKey));
    if (item?.titleKey) el.title = t(item.titleKey);
  });
}

// ── Mobile drawer ─────────────────────────────────────────────────────────

function buildMobileBar(rail) {
  const root = document.getElementById('app-root');
  if (!root || document.getElementById('mobile-bar')) return;

  const bar = document.createElement('header');
  bar.className = 'mobile-bar';
  bar.id = 'mobile-bar';

  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'mobile-menu-btn';
  menuBtn.id = 'mobile-menu-btn';
  menuBtn.setAttribute('aria-controls', rail.id);
  menuBtn.append(icon('rows', 20));
  menuBtn.addEventListener('click', () => setDrawerOpen(!isDrawerOpen()));

  const brand = document.createElement('div');
  brand.className = 'mobile-brand';
  brand.append(bunvelopeLogo(26));
  const brandLbl = document.createElement('span');
  brandLbl.textContent = 'Bunvelope';
  brand.append(brandLbl);

  bar.append(menuBtn, brand);

  const scrim = document.createElement('div');
  scrim.className = 'rail-scrim';
  scrim.id = 'rail-scrim';
  scrim.addEventListener('click', () => setDrawerOpen(false));

  root.prepend(bar);
  root.append(scrim);
  syncMenuButton();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isDrawerOpen()) {
      setDrawerOpen(false);
      document.getElementById('mobile-menu-btn')?.focus();
    }
  });
  // Rotating a tablet or widening the window past the breakpoint must not
  // leave a scrim over the desktop layout.
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(max-width: 840px)');
    const onChange = () => { if (!mq.matches) setDrawerOpen(false); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
  }
}

function isDrawerOpen() {
  return document.getElementById('app-root')?.classList.contains('nav-open') || false;
}

function syncMenuButton() {
  const btn = document.getElementById('mobile-menu-btn');
  if (!btn) return;
  const open = isDrawerOpen();
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  btn.setAttribute('aria-label', t(open ? 'nav.closeMenu' : 'nav.openMenu'));
}

export function setDrawerOpen(open) {
  const root = document.getElementById('app-root');
  if (!root) return;
  const was = root.classList.contains('nav-open');
  root.classList.toggle('nav-open', !!open);
  syncMenuButton();
  if (open && !was) {
    // Move focus into the drawer so keyboard and screen-reader users land
    // on the navigation they just opened.
    const first = document.querySelector('#rail .rail-item.active, #rail .rail-item');
    if (first) requestAnimationFrame(() => first.focus());
  }
}

export function highlightActive(page) {
  const child = flatNav().find(n => n.page === page && n.parentPage);
  const parentOfActive = child ? child.parentPage : null;
  document.querySelectorAll('.rail-item, .topnav-item, .topnav-subitem').forEach(el => {
    const isActive = el.dataset.page === page;
    const isParentOfActive = el.dataset.page === parentOfActive;
    el.classList.toggle('active', isActive);
    el.classList.toggle('parent-active', isParentOfActive && !isActive);
  });
  // Highlighting alone respects saved groups; parent activation opens them.
}

export function applyPrefs(prefs) {
  const root = document.getElementById('app-root');
  if (prefs.nav) root.dataset.nav = prefs.nav;
  document.documentElement.dataset.statusbarPosition = prefs.statusbarPosition === 'top' ? 'top' : 'bottom';
  // Density goes on <html>, not #app-root. The --pad-* tokens are declared on
  // :root and a custom property substitutes var() at its *declaration* site,
  // so `--density` set on a descendant never reaches them — the tokens stayed
  // at their comfy values whatever the control said, which is why the setting
  // appeared to do nothing at all.
  if (prefs.density) document.documentElement.dataset.density = prefs.density;
  if (prefs.accent) document.documentElement.dataset.accent = prefs.accent;
  // Simple mode hides the [data-advanced] nav entries and the balance-view
  // switcher (css/app.css). Unset means full: every budget from before the
  // mode existed keeps the nav it had.
  featurePrefs = prefs;
  document.documentElement.dataset.uiMode = ['simple', 'advanced'].includes(prefs.uiMode) ? prefs.uiMode : 'full';
  document.documentElement.dataset.balanceViews = String(featureEnabled(prefs, 'balance-views'));
  syncFeatureVisibility();
  collapsedRailGroups = new Set(Array.isArray(prefs.collapsedRailGroups) ? prefs.collapsedRailGroups : defaultCollapsedRailGroups());
  syncRailSubmenus();
}

function syncFeatureVisibility() {
  document.querySelectorAll('#rail [data-page], #topnav [data-page], .rail-group, .topnav-group').forEach(el => {
    const page = el.dataset.page || el.dataset.group || el.querySelector('[data-page]')?.dataset.page;
    el.toggleAttribute('data-feature-hidden', !featureEnabled(featurePrefs, page));
  });
  syncTopnavSubmenus(document);
}

export function setNavItemVisible(page, visible) {
  document.querySelectorAll(`[data-page="${CSS.escape(page)}"]`).forEach(el => {
    el.hidden = !visible;
  });
  syncTopnavSubmenus(document);
  syncRailSubmenus();
}

function syncRailSubmenus() {
  const simple = document.documentElement.dataset.uiMode === 'simple';
  const nav = getNav();
  document.querySelectorAll('.rail-group').forEach(group => {
    const page = group.dataset.group;
    const children = group.querySelector('.rail-submenu');
    const toggle = group.querySelector('.rail-submenu-toggle');
    const hasVisibleChildren = [...children.children].some(el => !el.hidden && !el.hasAttribute('data-feature-hidden') && !(simple && el.hasAttribute('data-advanced')));
    const expanded = !collapsedRailGroups.has(page);
    children.hidden = !expanded;
    toggle.hidden = !hasVisibleChildren;
    toggle.textContent = expanded ? '−' : '+';
    toggle.setAttribute('aria-expanded', String(expanded));
    const parent = group.querySelector('.rail-parent-row > .rail-item');
    if (hasVisibleChildren) {
      parent.setAttribute('aria-controls', children.id);
      parent.setAttribute('aria-expanded', String(expanded));
    } else {
      parent.removeAttribute('aria-controls');
      parent.removeAttribute('aria-expanded');
    }
    const label = t(expanded ? 'nav.collapseSubmenu' : 'nav.expandSubmenu')(t(nav.find(item => item.page === page).labelKey));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  });
}

/**
 * Mark top-nav groups whose submenu items are all hidden, so the caret and
 * the empty submenu go too (css: `.sub-all-hidden`). `has-sub` is decided at
 * build time; with AI off, Overview's only child (Insights) is hidden after
 * that, and the caret pointed at nothing. Simple mode handles its own case
 * with `.sub-advanced-only`.
 * @param {ParentNode} root
 */
function syncTopnavSubmenus(root) {
  root.querySelectorAll('.topnav-group.has-sub').forEach(group => {
    const items = group.querySelectorAll('.topnav-subitem');
    const allHidden = items.length > 0 && [...items].every(el => el.hidden || el.hasAttribute('data-feature-hidden'));
    group.classList.toggle('sub-all-hidden', allHidden);
  });
}

// ── Ask AI ────────────────────────────────────────────────────────────────
// The dialog is loaded on demand: it pulls in the tool registry and the engine
// read paths, none of which a user who never opens it should pay for.

export async function openAgentDialogFromShell() {
  if (!isAiAvailable()) return;
  const [{ openAgentDialog }, app] = await Promise.all([
    import('../ai/agent/dialog.js'),
    import('../app.js'),
  ]);
  // The dialog module guards against a second copy; it is the only place that
  // learns about every dismissal path.
  openAgentDialog(app.state);
}

/** Show or hide the status bar's Ask AI button — called when AI availability changes. */
export function refreshAiEntryPoints() {
  const btn = document.getElementById('status-ask-ai');
  if (btn) btn.hidden = !isAiAvailable();
}

// Cmd/Ctrl-K from anywhere. Ignored while typing so it cannot steal the
// shortcut from a text field, and while a dialog already has focus.
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'k' || !(e.metaKey || e.ctrlKey)) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    if (!isAiAvailable()) return;
    e.preventDefault();
    openAgentDialogFromShell();
  });
}

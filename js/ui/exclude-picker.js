// js/ui/exclude-picker.js — the "Exclude…" sheet shared by Reports and Net
// worth: sections (envelopes, payees, accounts) of checkbox rows in groups,
// optional quick-group toggles, one search box, Clear / Cancel / Apply; and
// the "N excluded · Clear" chip shown while a page is filtered.
//
// With more than one section the sections show as tabs (one active panel at
// a time); with exactly one (Net worth) there are no tabs, just the section
// heading, as before tabs existed. A section can also opt into a pinned
// "already excluded" group (`pinSelected`), a cap on how many non-pinned
// rows render before the user searches (`cap`), and a link-style action at
// the top of its panel (`action`) — all via `sectionView` in
// exclude-picker-model.js, which the panel rebuilds from on every tab switch
// and search keystroke.

import { openSheet } from './sheet.js';
import { t } from './i18n.js';
import { foldText } from './option-filter.js';
import { sectionView } from './exclude-picker-model.js';

/**
 * @param {{
 *   title: string,
 *   sections: { id: string, label: string, quick?: { label: string, ids: string[] }[],
 *     groups: { label: string, items: { id: string, label: string }[] }[],
 *     pinSelected?: boolean, cap?: number,
 *     action?: { label: string, onClick: () => void } }[],
 *   selected: Record<string, string[]>,
 *   onApply: (sel: Record<string, string[]>) => void,
 * }} o
 */
export function openExcludePicker({ title, sections, selected, onApply }) {
  /** @type {Record<string, Set<string>>} */
  const chosen = Object.fromEntries(sections.map(s => [s.id, new Set(selected[s.id] || [])]));
  // Rebuilt every time a section's panel is (re)rendered — see the module
  // comment above — so only the currently-visible section's map is ever
  // current; that is also the only one setChecked needs to reach a box in.
  /** @type {Record<string, Map<string, HTMLInputElement>>} */
  const boxes = Object.fromEntries(sections.map(s => [s.id, new Map()]));

  const content = document.createElement('div');
  content.className = 'exclude-picker';

  const search = document.createElement('input');
  search.type = 'search';
  // There is no generic `.input` utility class for form fields (normally
  // styled via `.field input`); mirror `.reports-env-picker input.input`'s
  // approach of setting the class directly on this bare <input>.
  search.className = 'input';
  search.placeholder = t('pageFilter.search');
  search.setAttribute('aria-label', t('pageFilter.search'));

  const tabList = document.createElement('div');
  tabList.className = 'exclude-picker-tabs';
  tabList.setAttribute('role', 'tablist');

  const panel = document.createElement('div');
  panel.className = 'exclude-picker-list';

  let activeId = sections[0].id;
  /** @type {Map<string, HTMLButtonElement>} */
  const tabButtons = new Map();

  const setChecked = (sectionId, id, on) => {
    if (on) chosen[sectionId].add(id);
    else chosen[sectionId].delete(id);
    const box = boxes[sectionId].get(id);
    if (box) box.checked = on;
    updateTabLabel(sectionId);
  };

  function tabLabel(section) {
    return `${section.label} (${chosen[section.id].size})`;
  }

  function updateTabLabel(sectionId) {
    const btn = tabButtons.get(sectionId);
    if (!btn) return;
    const section = sections.find(s => s.id === sectionId);
    btn.textContent = tabLabel(section);
  }

  function activateTab(id) {
    activeId = id;
    for (const [sid, btn] of tabButtons) {
      const on = sid === id;
      btn.setAttribute('aria-selected', String(on));
      btn.tabIndex = on ? 0 : -1;
    }
    renderPanel();
  }

  if (sections.length > 1) {
    for (const section of sections) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-sm btn-ghost';
      b.setAttribute('role', 'tab');
      b.id = `exclude-picker-tab-${section.id}`;
      b.setAttribute('aria-controls', 'exclude-picker-panel');
      b.setAttribute('aria-selected', String(section.id === activeId));
      b.tabIndex = section.id === activeId ? 0 : -1;
      b.textContent = tabLabel(section);
      b.addEventListener('click', () => activateTab(section.id));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const idx = sections.findIndex(s => s.id === activeId);
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const next = sections[(idx + dir + sections.length) % sections.length];
        activateTab(next.id);
        tabButtons.get(next.id)?.focus();
      });
      tabButtons.set(section.id, b);
      tabList.append(b);
    }
    panel.id = 'exclude-picker-panel';
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', `exclude-picker-tab-${activeId}`);
  } else {
    tabList.hidden = true;
  }

  function renderPanel() {
    panel.replaceChildren();
    boxes[activeId] = new Map();
    const section = sections.find(s => s.id === activeId);
    if (sections.length > 1) panel.setAttribute('aria-labelledby', `exclude-picker-tab-${activeId}`);

    if (sections.length === 1) {
      const h = document.createElement('h3');
      h.textContent = section.label;
      panel.append(h);
    }

    if (section.action) {
      const actionWrap = document.createElement('div');
      actionWrap.className = 'exclude-picker-action';
      const a = document.createElement('button');
      a.type = 'button';
      a.className = 'btn-link';
      a.textContent = section.action.label;
      a.addEventListener('click', () => {
        // Closing first matches Cancel's semantics: this picker's own
        // selections (not yet applied) are simply dropped.
        handle?.close();
        section.action.onClick();
      });
      actionWrap.append(a);
      panel.append(actionWrap);
    }

    if (section.quick?.length) {
      const quick = document.createElement('div');
      quick.className = 'exclude-picker-quick';
      quick.setAttribute('role', 'group');
      quick.setAttribute('aria-label', t('pageFilter.quick'));
      for (const q of section.quick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn-sm btn-ghost';
        b.textContent = q.label;
        // All already excluded → include them again; otherwise exclude all.
        b.addEventListener('click', () => {
          const all = q.ids.every(id => chosen[section.id].has(id));
          for (const id of q.ids) setChecked(section.id, id, !all);
        });
        quick.append(b);
      }
      panel.append(quick);
    }

    const query = foldText(search.value);
    const view = sectionView(section, chosen[section.id], query, t('pageFilter.excludedGroup'));

    for (const group of view.groups) {
      const g = document.createElement('div');
      g.className = 'exclude-picker-group';
      if (group.label) {
        const gh = document.createElement('h4');
        gh.textContent = group.label;
        g.append(gh);
      }
      for (const item of group.items) {
        const row = document.createElement('label');
        row.className = 'exclude-picker-row';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = chosen[section.id].has(item.id);
        box.addEventListener('change', () => setChecked(section.id, item.id, box.checked));
        boxes[section.id].set(item.id, box);
        const name = document.createElement('span');
        name.textContent = item.label;
        row.append(box, name);
        g.append(row);
      }
      panel.append(g);
    }

    if (!query && view.hidden > 0) {
      const more = document.createElement('p');
      more.className = 'exclude-picker-more';
      more.textContent = t('pageFilter.searchAll')(view.total);
      panel.append(more);
    }
  }

  search.addEventListener('input', renderPanel);

  /** @type {{ close: () => void } | undefined} */
  let handle;
  const mk = (text, cls, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  };
  const actions = document.createElement('div');
  actions.dataset.sheetActions = '';
  actions.className = 'exclude-picker-actions';
  actions.append(
    mk(t('pageFilter.clear'), 'btn btn-ghost', () => {
      for (const s of sections) for (const id of [...chosen[s.id]]) setChecked(s.id, id, false);
    }),
    mk(t('common.cancel'), 'btn btn-ghost', () => handle?.close()),
    mk(t('common.apply'), 'btn btn-accent', () => {
      handle?.close();
      onApply(Object.fromEntries(sections.map(s => [s.id, [...chosen[s.id]]])));
    }),
  );

  renderPanel();
  content.append(search, tabList, panel, actions);
  handle = openSheet({ title, content, narrow: true, initialFocus: search });
}

/**
 * "N excluded · Clear", shown while a page is filtered.
 * @param {{ count: number, onClear: () => void }} o
 */
export function exclusionChip({ count, onClear }) {
  const chip = document.createElement('span');
  chip.className = 'page-filter-chip';
  chip.title = t('pageFilter.pageOnly');
  const text = document.createElement('span');
  text.textContent = t('pageFilter.excludedCount')(count);
  // The "applies to this page only" caveat lives in `title`, which a
  // screen reader does not read on hover; repeat it as visually-hidden text
  // so it is reachable without a mouse.
  const note = document.createElement('span');
  note.className = 'bv-chart-sr';
  note.textContent = t('pageFilter.pageOnly');
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'btn btn-sm btn-ghost';
  clear.textContent = t('pageFilter.clear');
  clear.setAttribute('aria-label', t('pageFilter.clearExclusions'));
  clear.addEventListener('click', onClear);
  chip.append(text, note, clear);
  return chip;
}

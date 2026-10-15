// js/payee-merge-sheet.js — tidy up near-duplicate payees.
//
// Bank imports write the same shop a dozen ways ("LIDL 1234", "Lidl",
// "lidl"), which splits its transaction history, its remembered envelope,
// and the payee suggestions across several strings (ux-review U16 follow-up:
// ~3 200 near-duplicates in the live budget). `js/state/payee-merge.js` does
// the pure clustering/search/merge; this sheet is where the user reviews a
// group and commits it, same shape as `js/repair-links.js`.

import { state, session } from './app.js';
import { notifyStateChanged } from './state/events.js';
import {
  listPayees, findPayeeClusters, findLooseClusters, searchPayees,
  getIgnoredClusters, ignoreCluster, unignoreCluster, splitIgnoredClusters, splitIgnoredLooseClusters,
  refreshBasket, preferredTarget,
} from './state/payee-merge.js';
import {
  getPayeeAliases, getHiddenPayees,
} from './state/payee-aliases.js';
import { updateMeta } from './state/meta-writes.js';
import { markPayeeIndexStale } from './state/payee-index.js';
import { openSheet } from './ui/sheet.js';
import { confirmDialog } from './ui/dialog.js';
import { toast } from './ui/toast.js';
import { dispatchOrReport, reportSaveError } from './ui/save-error.js';
import { undoAction } from './ui/undo-action.js';
import { t } from './ui/i18n.js';

const CLUSTERS_PAGE = 30;

/**
 * One checkbox row: `payee — n rows`, ticked when in `checked`, plus a trailing
 * Hide button. `onDone` re-renders the sheet after a hide, same contract as
 * `groupCard`'s.
 * `onToggle`, if given, is called after every checkbox change so the caller
 * can keep its Merge button's disabled state in sync with how many members
 * are ticked.
 */
function memberRow(member, checked, onDone, onToggle) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;';

  const label = document.createElement('label');
  label.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;flex:1;min-width:0;';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked.has(member.key);
  cb.style.width = 'auto';
  cb.addEventListener('change', () => {
    if (cb.checked) checked.add(member.key); else checked.delete(member.key);
    if (onToggle) onToggle();
  });

  const text = document.createElement('span');
  text.style.cssText = 'overflow-wrap:anywhere;';
  text.textContent = `${member.payee} — ${t('payeeMerge.rows')(member.count)}`;

  label.append(cb, text);

  const hideBtn = document.createElement('button');
  hideBtn.type = 'button';
  hideBtn.className = 'btn btn-ghost btn-sm';
  hideBtn.textContent = t('payeeMerge.hide');
  const hideTitle = `${t('payeeMerge.hideTitle')} — ${member.payee}`;
  hideBtn.title = hideTitle;
  hideBtn.setAttribute('aria-label', hideTitle);
  hideBtn.addEventListener('click', () => setHidden(member.key, true, onDone));

  row.append(label, hideBtn);
  return row;
}

/**
 * `merge` writes the merge and reports success/failure; `onDone` re-renders
 * the list from the (possibly now different) state.transactions so a merged
 * group disappears. The toast's Undo reverses the one commit (rows, aliases,
 * investment rule, unhide) through the session, then `onRestored` re-renders.
 */
async function merge(group, checkedKeys, targetName, onDone, onRestored = onDone) {
  const toPayee = targetName.trim();
  if (!toPayee || checkedKeys.size === 0) return;

  // One commit: the rows, the investment symbol rule, the aliases and the
  // unhide of a hidden target all land together or not at all. The exact
  // spellings of the merged-away members go as `fromNames`, not their folded
  // keys: a case-only merge (e.g. "lidl" into "Lidl") still needs an alias.
  const fromNames = group.members.filter(m => checkedKeys.has(m.key)).map(m => m.payee);
  const input = { from: [...checkedKeys], fromNames, to: toPayee };
  // The confirmation counts the rows the merge would rewrite, from a dry run
  // of the command: a ticked member already spelled as the target is not one.
  const dry = await dispatchOrReport(session, 'payee.merge', input, { dryRun: true });
  if (!dry) return;
  if (!dry.value.value.changed) { toast(t('payeeMerge.nothing')); return; }
  const ok = await confirmDialog(t('payeeMerge.confirm')(dry.value.value.changed, toPayee), { okLabel: t('payeeMerge.merge') });
  if (!ok) return;

  const r = await dispatchOrReport(session, 'payee.merge', input);
  if (!r) return;
  const changed = r.value.value.changed;
  if (!changed) { toast(t('payeeMerge.nothing')); return; }

  markPayeeIndexStale(state);
  notifyStateChanged();
  const restored = () => {
    markPayeeIndexStale(state);
    notifyStateChanged();
    onRestored();
  };
  toast(t('payeeMerge.done')(changed, toPayee), {
    duration: 8000,
    action: r.value.undo ? undoAction(r.value.undo, null, restored) : undefined,
  });
  onDone();
}

/**
 * Ignore a suggested group, or restore an ignored one. Saved in the budget's
 * meta (`payeeMergeIgnored`), so it follows the budget to every device. A
 * loose group's `clusterKey` is derived from its CURRENT members and may not
 * be the key that was actually stored (see `splitIgnoredLooseClusters`), so
 * restore deletes every key in `group.ignoredKeys` when present rather than
 * `group.clusterKey` alone.
 */
async function setIgnored(group, ignore, onDone) {
  try {
    await updateMeta(state, (meta) => {
      const cur = getIgnoredClusters(meta);
      let next = cur;
      if (ignore) {
        next = ignoreCluster(cur, group);
      } else {
        for (const key of group.ignoredKeys ?? [group.clusterKey]) next = unignoreCluster(next, key);
      }
      return { ...meta, payeeMergeIgnored: next };
    });
  } catch (err) {
    reportSaveError(err, 'payee merge: ignore save failed');
    return;
  }
  toast(ignore ? t('payeeMerge.ignoredToast') : t('payeeMerge.restoredToast'));
  onDone();
}

/**
 * Hide (or restore) a payee from suggestions and pickers; transactions are
 * not touched. Saved in the budget's meta (`payeeHidden`), mirroring
 * `setIgnored`.
 */
async function setHidden(key, hidden, onDone) {
  if (!await dispatchOrReport(session, hidden ? 'payee.hide' : 'payee.unhide', { payee: key })) return;
  markPayeeIndexStale(state);
  toast(hidden ? t('payeeMerge.hiddenToast') : t('payeeMerge.unhiddenToast'));
  onDone();
}

/** Forget a remembered spelling; new rows with it stop being renamed. */
async function forgetAlias(key, onDone) {
  if (!await dispatchOrReport(session, 'payee.unalias', { key })) return;
  toast(t('payeeMerge.forgotToast'));
  onDone();
}

/**
 * A card for one group: member checkboxes, a "merge into" name, a Merge
 * button, and for a suggested group an Ignore (or, once ignored, Restore)
 * button; `ignoreMode` is 'ignore', 'restore' or null (search results). `sheetCtl` coordinates the Merge button's disabled state across
 * every card in the sheet, since a merge in one group's card writes the
 * whole transactions array and a second merge started before the first
 * settles would race it. `onChecked`, if given, is called once with the
 * live `checked` Set so a caller (the search-results "Add to basket"
 * button) can read which members are ticked later, after the user has
 * toggled checkboxes.
 *
 * A "possible duplicate" (loose) group — identified by its `loose:`-prefixed
 * `clusterKey` — starts with nothing ticked and needs at least two members
 * ticked before Merge enables, since (unlike an exact-normalised group) its
 * members are only a suggestion, not already known to be the same payee. An
 * exact group keeps the all-ticked-by-default behaviour with a one-ticked
 * minimum. `opts.startUnchecked` / `opts.minChecked` override those defaults
 * (search results start unticked but can rename a single payee).
 *
 * `opts.memory` (a `cardMemory` entry, see `openPayeeMergeSheet`) carries the
 * ticked members and the typed "merge into" name across re-renders, so a
 * Hide or Ignore elsewhere in the sheet doesn't reset them; `opts.onToggle`
 * is called after every checkbox change.
 */
function groupCard(group, onDone, sheetCtl, ignoreMode = null, onChecked = null, opts = {}) {
  const isLoose = typeof group.clusterKey === 'string' && group.clusterKey.startsWith('loose:');
  const startUnchecked = opts.startUnchecked ?? isLoose;
  const minChecked = opts.minChecked ?? (startUnchecked ? 2 : 1);
  const memory = opts.memory ?? null;

  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'margin-bottom:12px;';

  // Remembered ticks are limited to the CURRENT members: a member merged
  // away or hidden since, or a search match no longer matching, must not
  // ride along into the next merge unseen.
  const memberKeys = new Set(group.members.map(m => m.key));
  const checked = memory?.checked
    ? new Set([...memory.checked].filter(k => memberKeys.has(k)))
    : (startUnchecked ? new Set() : new Set(memberKeys));
  if (memory) memory.checked = checked;
  if (onChecked) onChecked(checked);

  const mergeBtn = document.createElement('button');
  mergeBtn.type = 'button';
  mergeBtn.className = 'btn btn-accent btn-sm';
  mergeBtn.textContent = t('payeeMerge.merge');

  const updateMergeEnabled = () => { mergeBtn.disabled = sheetCtl.isBusy() || checked.size < minChecked; };
  const onToggle = () => { updateMergeEnabled(); if (opts.onToggle) opts.onToggle(); };

  const rows = document.createElement('div');
  for (const m of group.members) rows.append(memberRow(m, checked, onDone, onToggle));

  const mergeRow = document.createElement('div');
  mergeRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;';

  const mergeLabel = document.createElement('span');
  mergeLabel.style.cssText = 'font-size:12px;color:var(--muted);flex-shrink:0;';
  mergeLabel.textContent = t('payeeMerge.mergeInto');

  // Members are sorted most-used first (js/state/payee-merge.js);
  // preferredTarget takes the busiest one without a card-processor prefix.
  const targetInput = targetField(memory, preferredTarget(group.members)?.payee || '');

  sheetCtl.register(mergeBtn, () => checked.size >= minChecked);

  mergeBtn.addEventListener('click', async () => {
    if (sheetCtl.isBusy()) return;
    sheetCtl.setBusy(true);
    try {
      await merge(group, checked, targetInput.value, () => {
        if (opts.onMerged) opts.onMerged();
        onDone();
      }, onDone);
    } finally {
      // A successful merge re-renders the whole list from inside merge()
      // (onDone), which re-registers a fresh set of buttons with sheetCtl
      // while still busy; setBusy(false) here re-enables that fresh set, so
      // a detached pre-render button being touched too is harmless.
      sheetCtl.setBusy(false);
    }
  });

  mergeRow.append(mergeLabel, targetInput, mergeBtn);
  if (ignoreMode) {
    const ignoreBtn = document.createElement('button');
    ignoreBtn.type = 'button';
    ignoreBtn.className = 'btn btn-ghost btn-sm';
    const ignore = ignoreMode === 'ignore';
    ignoreBtn.textContent = ignore ? t('payeeMerge.ignore') : t('payeeMerge.restore');
    ignoreBtn.title = ignore ? t('payeeMerge.ignoreTitle') : t('payeeMerge.restoreTitle');
    ignoreBtn.addEventListener('click', () => setIgnored(group, ignore, onDone));
    mergeRow.append(ignoreBtn);
  }
  card.append(rows, mergeRow);
  return card;
}

/**
 * The merge basket: members collected (ticked) across several searches,
 * shown as its own card so the user can build up a group before merging.
 * Unlike `groupCard`'s rows, a basket row has no checkbox (everything in
 * the basket is, by construction, going into the merge) and its remove
 * button drops the member from the basket, not from suggestions — a
 * different action than `memberRow`'s Hide, so this card does not reuse
 * `memberRow`/`groupCard` for the rows, only their "merge into" + Merge
 * button layout. `basket` is the `Map<key, member>` owned by
 * `openPayeeMergeSheet`; `merge`/`sheetCtl`/`render` are its closures.
 */
function basketCard(basket, sheetCtl, render, memory) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'margin-bottom:12px;';
  card.append(sectionHeading(t('payeeMerge.basket')));

  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.style.cssText = 'font-size:12px;margin:0 0 10px;';
  hint.textContent = t('payeeMerge.basketHint');
  card.append(hint);

  // Sorted most-used first, same convention as groupCard's members, so the
  // default merge target below is the busiest spelling.
  const members = [...basket.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  const rows = document.createElement('div');
  for (const m of members) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;';

    const text = document.createElement('span');
    text.style.cssText = 'flex:1;overflow-wrap:anywhere;';
    text.textContent = `${m.payee} — ${t('payeeMerge.rows')(m.count)}`;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-ghost btn-sm';
    removeBtn.textContent = '✕';
    const removeLabel = t('payeeMerge.removeFromBasket')(m.payee);
    removeBtn.title = removeLabel;
    removeBtn.setAttribute('aria-label', removeLabel);
    removeBtn.addEventListener('click', () => { basket.delete(m.key); render(); });

    row.append(text, removeBtn);
    rows.append(row);
  }
  card.append(rows);

  const mergeRow = document.createElement('div');
  mergeRow.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;';

  const mergeLabel = document.createElement('span');
  mergeLabel.style.cssText = 'font-size:12px;color:var(--muted);flex-shrink:0;';
  mergeLabel.textContent = t('payeeMerge.mergeInto');

  const targetInput = targetField(memory, preferredTarget(members)?.payee || '');

  const mergeBtn = document.createElement('button');
  mergeBtn.type = 'button';
  mergeBtn.className = 'btn btn-accent btn-sm';
  mergeBtn.textContent = t('payeeMerge.merge');
  sheetCtl.register(mergeBtn);

  mergeBtn.addEventListener('click', async () => {
    if (sheetCtl.isBusy()) return;
    sheetCtl.setBusy(true);
    // Captured before the await inside merge() (which shows a confirm
    // dialog), so onDone below removes exactly the members that were
    // actually merged — not whatever happens to be in the basket by the
    // time the write settles, which a Remove/Add in the meantime could have
    // changed.
    const mergedKeys = new Set(basket.keys());
    try {
      // A successful merge (js/state/payee-merge.js mergePayees, via merge()
      // below) records aliases like any other group; onDone here also drops
      // the merged keys from the basket so they don't come back on the next
      // render, while leaving anything added to the basket afterwards.
      await merge({ members }, mergedKeys, targetInput.value, () => {
        for (const key of mergedKeys) basket.delete(key);
        memory.typed = null;
        render();
      }, render);
    } finally {
      sheetCtl.setBusy(false);
    }
  });

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn btn-ghost btn-sm';
  clearBtn.textContent = t('payeeMerge.clearBasket');
  clearBtn.addEventListener('click', () => { basket.clear(); render(); });

  mergeRow.append(mergeLabel, targetInput, mergeBtn, clearBtn);
  card.append(mergeRow);
  return card;
}

/**
 * The "merge into" text field. With a `memory` entry, a name the user typed
 * survives re-renders (`memory.typed`, null until they type) and the field
 * carries `data-memory-key` so `openPayeeMergeSheet` can put focus back.
 */
function targetField(memory, defaultName) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'form-input';
  input.style.cssText = 'flex:1;min-width:160px;';
  input.value = memory?.typed ?? defaultName;
  if (memory) {
    input.dataset.memoryKey = memory.key;
    input.addEventListener('input', () => { memory.typed = input.value; });
  }
  return input;
}

function sectionHeading(text) {
  const h = document.createElement('div');
  h.style.cssText = 'font-size:13px;color:var(--muted);margin:0 0 8px;';
  h.textContent = text;
  return h;
}

function emptyNote() {
  const p = document.createElement('p');
  p.className = 'muted';
  p.style.cssText = 'font-size:13px;margin:0;';
  p.textContent = t('payeeMerge.none');
  return p;
}

/** The ignored-groups toggle: distinct closed/open labels ("Show ignored (n)" / "Hide ignored"). */
function collapseToggle(open, openLabel, closedLabel, onClick) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn btn-ghost btn-sm';
  toggle.style.cssText = 'display:block;margin-top:8px;';
  toggle.textContent = open ? closedLabel : openLabel;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.addEventListener('click', onClick);
  return toggle;
}

/**
 * The aliases/hidden-payees toggles: the label always names the count
 * ("Remembered spellings (n)" / "Hidden payees (n)"), with a ▸/▾ prefix
 * showing open/closed state instead of swapping the text for a generic
 * "Hide list".
 */
function countToggle(open, label, onClick) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'btn btn-ghost btn-sm';
  toggle.style.cssText = 'display:block;margin-top:8px;';
  toggle.textContent = `${open ? '▾' : '▸'} ${label}`;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.addEventListener('click', onClick);
  return toggle;
}

/** One `text` row with a trailing action button, for the management lists. */
function manageRow(text, btnLabel, onClick) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;';

  const label = document.createElement('span');
  label.style.cssText = 'flex:1;overflow-wrap:anywhere;';
  label.textContent = text;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn btn-ghost btn-sm';
  btn.textContent = btnLabel;
  btn.title = `${btnLabel} — ${text}`;
  btn.setAttribute('aria-label', `${btnLabel} — ${text}`);
  btn.addEventListener('click', onClick);

  row.append(label, btn);
  return row;
}

/**
 * How many exact-match groups the sheet would suggest right now: hidden
 * payees and ignored groups left out, same as the sheet's own list. The loose
 * suggestions are not counted; their edit-distance pass is too slow to run
 * just to show a number.
 */
export function countPayeeGroups() {
  const hiddenKeys = getHiddenPayees(state.meta);
  const payees = listPayees(state.transactions || []).filter(p => !hiddenKeys.has(p.key));
  return splitIgnoredClusters(findPayeeClusters(payees), getIgnoredClusters(state.meta)).active.length;
}

/** `onClose`, if given, runs once the sheet has closed, so callers can repaint. */
export function openPayeeMergeSheet({ onClose = null } = {}) {
  const content = document.createElement('div');

  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'form-input';
  search.placeholder = t('payeeMerge.searchPh');
  search.style.cssText = 'margin-bottom:14px;';

  const listHost = document.createElement('div');
  content.append(search, listHost);

  let shown = CLUSTERS_PAGE;
  let shownLoose = CLUSTERS_PAGE;
  let showIgnored = false;
  let showAliases = false;
  let showHidden = false;
  let aliasesShown = CLUSTERS_PAGE;

  // Members ticked in search results across several searches, collected
  // here so they can be merged into one name in one go. Keyed by
  // member.key (the folded payee), same key `merge()` matches on.
  const basket = new Map();

  // Per-card state that must survive a re-render: ticked members and a typed
  // "merge into" name, keyed by the group's clusterKey ('search' for the
  // search results, 'basket' for the basket). Cleared for a card once it
  // merges.
  const cardMemory = new Map();
  const memoryFor = (key) => {
    let m = cardMemory.get(key);
    if (!m) { m = { key, checked: null, typed: null }; cardMemory.set(key, m); }
    return m;
  };
  const forget = key => () => { cardMemory.delete(key); };
  const clusterCard = (cluster, mode) => groupCard(cluster, render, sheetCtl, mode, null, {
    memory: memoryFor(cluster.clusterKey), onMerged: forget(cluster.clusterKey),
  });

  // Sheet-level busy flag: only one merge write can be in flight at a time
  // (they all touch the same state.transactions array), so every Merge
  // button across every card, not just the one clicked, disables for the
  // span of a merge and re-enables once it settles.
  let busy = false;
  // Each entry pairs a registered Merge button with the `canEnable` check
  // (e.g. "at least two ticked" for a loose group) that setBusy must
  // preserve when it turns busy back off — otherwise re-enabling every
  // button on write-completion would un-disable one still below its
  // minimum-ticked count.
  let mergeButtons = [];
  const sheetCtl = {
    isBusy: () => busy,
    setBusy(next) {
      busy = next;
      for (const { btn, canEnable } of mergeButtons) btn.disabled = busy || !canEnable();
    },
    register: (btn, canEnable = () => true) => {
      mergeButtons.push({ btn, canEnable });
      btn.disabled = busy || !canEnable();
    },
  };

  // Exact/loose clustering — including findLooseClusters' quadratic
  // edit-distance pass within each block — only needs to run again when the
  // payee list itself could have changed, i.e. when state.transactions or
  // state.meta?.payeeHidden is a genuinely new array (a merge, a hide/unhide,
  // or a budget switch), not on every re-render: Ignore, a checkbox toggle,
  // Show more and a basket add/remove all call render() without touching
  // either. Keyed on identity, not a deep comparison, since both are treated
  // as immutable and replaced wholesale by their writers.
  let clusterCache = null;
  function getClusters(payees) {
    const txRef = state.transactions;
    const hiddenRef = state.meta?.payeeHidden;
    if (!clusterCache || clusterCache.txRef !== txRef || clusterCache.hiddenRef !== hiddenRef) {
      clusterCache = {
        txRef,
        hiddenRef,
        clusters: findPayeeClusters(payees),
        looseClusters: findLooseClusters(payees),
      };
    }
    return clusterCache;
  }

  function render() {
    // Put focus back in the "merge into" field being typed in, if any (the
    // rebuild below replaces every element).
    const focusedKey = listHost.contains(document.activeElement)
      ? /** @type {HTMLElement} */ (document.activeElement).dataset?.memoryKey
      : undefined;
    paint();
    if (focusedKey) {
      const el = [...listHost.querySelectorAll('input[data-memory-key]')]
        .find(i => /** @type {HTMLInputElement} */ (i).dataset.memoryKey === focusedKey);
      if (el) el.focus();
    }
  }

  function paint() {
    listHost.textContent = '';
    mergeButtons = [];
    const query = search.value.trim();
    const allPayees = listPayees(state.transactions || []);
    const hiddenKeys = getHiddenPayees(state.meta);
    // Display names for hidden keys: meta.payeeHidden stores only the folded
    // key, so recover the last-seen casing from the unfiltered payee list.
    const displayByKey = new Map(allPayees.map(p => [p.key, p.payee]));
    const payees = allPayees.filter(p => !hiddenKeys.has(p.key));

    // Drop a basket member merged away by another card (or search result)
    // since it was added, or hidden in the meantime, and pick up a live
    // count/spelling change for the rest — otherwise the basket card shows
    // stale numbers, or a Merge that includes a payee that no longer exists.
    const freshBasket = refreshBasket([...basket], allPayees, hiddenKeys);
    basket.clear();
    for (const [key, member] of freshBasket) basket.set(key, member);

    if (basket.size > 0) listHost.append(basketCard(basket, sheetCtl, render, memoryFor('basket')));

    if (query) {
      const matches = searchPayees(payees, query);
      listHost.append(sectionHeading(t('payeeMerge.matching')));
      if (matches.length === 0) { listHost.append(emptyNote()); return; }
      // Search results start unticked (a short query can match dozens of
      // payees, and a merge rewrites every row); one ticked result is enough to
      // rename it. "Add ticked" stays disabled until something is ticked.
      let resultsChecked = new Set();
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'btn btn-ghost btn-sm';
      addBtn.textContent = t('payeeMerge.addToBasket');
      const syncAdd = () => { addBtn.disabled = resultsChecked.size === 0; };
      listHost.append(groupCard({ members: matches }, render, sheetCtl, null, (c) => { resultsChecked = c; }, {
        startUnchecked: true, minChecked: 1,
        memory: memoryFor('search'), onMerged: forget('search'), onToggle: syncAdd,
      }));
      syncAdd();
      addBtn.addEventListener('click', () => {
        for (const m of matches) if (resultsChecked.has(m.key)) basket.set(m.key, m);
        memoryFor('search').checked = new Set();
        render();
      });
      listHost.append(addBtn);
      return;
    }

    const { clusters: rawClusters, looseClusters: rawLooseClusters } = getClusters(payees);
    const { active: clusters, ignored } = splitIgnoredClusters(
      rawClusters,
      getIgnoredClusters(state.meta),
    );
    const { active: looseClusters, ignored: looseIgnored } = splitIgnoredLooseClusters(
      rawLooseClusters,
      getIgnoredClusters(state.meta),
    );
    listHost.append(sectionHeading(t('payeeMerge.suggested')));
    if (clusters.length === 0) listHost.append(emptyNote());
    for (const cluster of clusters.slice(0, shown)) {
      listHost.append(clusterCard(cluster, 'ignore'));
    }
    if (clusters.length > shown) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn btn-ghost btn-sm';
      more.textContent = t('payeeMerge.showMore');
      more.addEventListener('click', () => { shown += CLUSTERS_PAGE; render(); });
      listHost.append(more);
    }

    listHost.append(sectionHeading(t('payeeMerge.possible')));
    const possibleHint = document.createElement('p');
    possibleHint.className = 'muted';
    possibleHint.style.cssText = 'font-size:12px;margin:0 0 8px;';
    possibleHint.textContent = t('payeeMerge.possibleHint');
    listHost.append(possibleHint);
    if (looseClusters.length === 0) listHost.append(emptyNote());
    for (const cluster of looseClusters.slice(0, shownLoose)) {
      listHost.append(clusterCard(cluster, 'ignore'));
    }
    if (looseClusters.length > shownLoose) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'btn btn-ghost btn-sm';
      more.textContent = t('payeeMerge.showMore');
      more.addEventListener('click', () => { shownLoose += CLUSTERS_PAGE; render(); });
      listHost.append(more);
    }

    // Ignored groups share one list and one meta key (payeeMergeIgnored)
    // regardless of whether the exact or the looser rule found them.
    const ignoredAll = [...ignored, ...looseIgnored]
      .sort((a, b) => b.total - a.total || a.clusterKey.localeCompare(b.clusterKey));
    if (ignoredAll.length > 0) {
      listHost.append(collapseToggle(
        showIgnored, t('payeeMerge.showIgnored')(ignoredAll.length), t('payeeMerge.hideIgnored'),
        () => { showIgnored = !showIgnored; render(); },
      ));
      if (showIgnored) {
        const ignoredHost = document.createElement('div');
        ignoredHost.style.cssText = 'margin-top:12px;opacity:0.85;';
        ignoredHost.append(sectionHeading(t('payeeMerge.ignoredHeading')));
        for (const cluster of ignoredAll) ignoredHost.append(clusterCard(cluster, 'restore'));
        listHost.append(ignoredHost);
      }
    }

    // Management lists: remembered spellings (aliases) and hidden payees.
    // Both omit their toggle entirely when there is nothing to manage.
    const aliases = getPayeeAliases(state.meta);
    // Sorted by kept name first, then the old spelling, so entries that
    // share a target sit together.
    const aliasEntries = Object.entries(aliases)
      .sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
    if (aliasEntries.length > 0) {
      listHost.append(countToggle(
        showAliases, t('payeeMerge.aliasesToggle')(aliasEntries.length),
        () => { showAliases = !showAliases; render(); },
      ));
      if (showAliases) {
        const host = document.createElement('div');
        host.style.cssText = 'margin-top:12px;';
        host.append(sectionHeading(t('payeeMerge.aliasesHint')));
        for (const [key, target] of aliasEntries.slice(0, aliasesShown)) {
          host.append(manageRow(`${key} → ${target}`, t('payeeMerge.forget'), () => forgetAlias(key, render)));
        }
        if (aliasEntries.length > aliasesShown) {
          const more = document.createElement('button');
          more.type = 'button';
          more.className = 'btn btn-ghost btn-sm';
          more.textContent = t('payeeMerge.showMore');
          more.addEventListener('click', () => { aliasesShown += CLUSTERS_PAGE; render(); });
          host.append(more);
        }
        listHost.append(host);
      }
    }

    const hiddenList = [...hiddenKeys].sort();
    if (hiddenList.length > 0) {
      listHost.append(countToggle(
        showHidden, t('payeeMerge.hiddenToggle')(hiddenList.length),
        () => { showHidden = !showHidden; render(); },
      ));
      if (showHidden) {
        const host = document.createElement('div');
        host.style.cssText = 'margin-top:12px;';
        host.append(sectionHeading(t('payeeMerge.hiddenHint')));
        for (const key of hiddenList) {
          const name = displayByKey.get(key) ?? key;
          host.append(manageRow(name, t('payeeMerge.unhide'), () => setHidden(key, false, render)));
        }
        listHost.append(host);
      }
    }
  }

  search.addEventListener('input', () => { shown = CLUSTERS_PAGE; shownLoose = CLUSTERS_PAGE; render(); });
  render();

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost btn-sm';
  closeBtn.textContent = t('common.close');

  const { close } = openSheet({
    title: t('payeeMerge.title'), content, wide: true,
    headerActions: [closeBtn],
    initialFocus: () => search,
    onClose,
  });
  closeBtn.addEventListener('click', close);
}

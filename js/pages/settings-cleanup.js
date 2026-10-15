// settings-cleanup.js — Settings' Clean-up tab: the checks that find data
// worth fixing, gathered in one place. Each card runs its check when the tab
// opens and shows the count; its button opens the existing review sheet (or,
// for investment payments, the Investments page, where that editor lives).
// Nothing is written from here: every fix is confirmed inside its sheet.

import { state, navigate, runDataCheck, openDataCheckSheet } from '../app.js';
import { t } from '../ui/i18n.js';
import { openRepairLinksSheet, scanUnlinkedPayments } from '../repair-links.js';
import { openDuplicatesSheet, scanDuplicates } from '../duplicates-sheet.js';
import { openTransferPairsSheet, scanTransferPairs } from '../transfer-pairs-sheet.js';
import { openPayeeMergeSheet, countPayeeGroups } from '../payee-merge-sheet.js';
import { findUnmappedInvestmentTxs } from './investments-unmapped.js';
import { trackedInvestmentAccounts } from './investments-shared.js';
import { openChangeLogSheet } from '../change-log-sheet.js';
import { getChangeLog } from '../state/change-log.js';

// Bumped on every render, so a check still running from a previous render
// (tab switched, or re-rendered after a fix) doesn't paint into a stale card.
let generation = 0;

function investmentAccountIds() {
  return new Set(trackedInvestmentAccounts(state.accounts).map(a => a.id));
}

/**
 * The cards, in order of how much a problem costs: a data-rule break first,
 * then rows that skew balances or forecasts, then tidiness. `count` may be
 * async; `open(refresh)` opens the fix and calls `refresh` once something
 * may have changed.
 */
function checks() {
  const list = [
    {
      key: 'dataCheck',
      title: t('cleanup.dataCheck.title'),
      hint: t('cleanup.dataCheck.hint'),
      button: t('cleanup.dataCheck.button'),
      // Unlinked bills and automatic-post duplicates are in the badge's sheet
      // too, but they have their own cards below; counting them here as well
      // would show one problem twice on this tab.
      count: async () => {
        const result = await runDataCheck();
        return { n: result.report.totalProblems + (result.extras.archivedFuture?.length || 0), result };
      },
      open: (refresh, last) => openDataCheckSheet(last.result, { onClose: refresh }),
      found: t('cleanup.dataCheck.found'),
    },
    {
      key: 'repairLinks',
      title: t('repairLinks.settingsTitle'),
      hint: t('repairLinks.settingsHint'),
      button: t('repairLinks.settingsButton'),
      count: () => ({ n: scanUnlinkedPayments().length }),
      open: (refresh) => openRepairLinksSheet({ onAfterChange: refresh }),
      found: t('repairLinks.found'),
    },
    {
      key: 'duplicates',
      title: t('duplicates.settingsTitle'),
      hint: t('duplicates.settingsHint'),
      button: t('duplicates.settingsButton'),
      count: () => ({ n: scanDuplicates().length }),
      open: (refresh) => openDuplicatesSheet({ onAfterChange: refresh }),
      found: t('duplicates.found'),
    },
    {
      key: 'transferPairs',
      title: t('transferPairs.settingsTitle'),
      hint: t('transferPairs.settingsHint'),
      button: t('transferPairs.settingsButton'),
      count: () => ({ n: scanTransferPairs().length }),
      open: (refresh) => openTransferPairsSheet({ onAfterChange: refresh }),
      found: t('transferPairs.found'),
    },
    {
      key: 'payees',
      title: t('payeeMerge.settingsTitle'),
      hint: t('payeeMerge.settingsHint'),
      button: t('payeeMerge.settingsButton'),
      count: () => ({ n: countPayeeGroups() }),
      open: (refresh) => openPayeeMergeSheet({ onClose: refresh }),
      found: t('payeeMerge.settingsFound'),
      // The count covers exact groups only; the sheet may still offer looser
      // "possible duplicates", so zero must not read as "nothing to fix".
      // Counting those too was measured and ruled out: their edit-distance
      // pass took 0.6 s to 5 s once many payees share a first three letters.
      none: { kind: 'neutral', text: t('payeeMerge.settingsNoExact') },
    },
  ];
  // Only relevant to someone tracking investments; the Investments page shows
  // its own empty state otherwise.
  if (investmentAccountIds().size > 0) {
    list.push({
      key: 'unmapped',
      title: t('cleanup.unmapped.title'),
      hint: t('cleanup.unmapped.hint'),
      button: t('cleanup.unmapped.button'),
      count: () => ({ n: findUnmappedInvestmentTxs(state.transactions, investmentAccountIds()).length }),
      open: () => navigate('investments'),
      found: t('cleanup.unmapped.found'),
    });
  }
  // Not a problem check: the audit trail of edits and deletions
  // (js/state/change-log.js). Its count is a record, so the chip stays
  // neutral whatever it says.
  list.push({
    key: 'changeLog',
    title: t('changeLog.title'),
    hint: t('changeLog.hint'),
    button: t('changeLog.button'),
    count: () => ({ n: getChangeLog(state.meta).length }),
    open: () => openChangeLogSheet(),
    found: t('changeLog.found'),
    foundKind: 'neutral',
    none: { kind: 'neutral', text: t('changeLog.none') },
  });
  return list;
}

function setStatus(chip, kind, text) {
  chip.className = 'chip' + (kind === 'found' ? ' chip--health-yellow' : kind === 'clean' ? ' chip--health-green' : '');
  const dot = document.createElement('span');
  dot.className = 'dot';
  const label = document.createElement('span');
  label.textContent = text;
  chip.replaceChildren(dot, label);
}

function buildCard(check, gen) {
  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'max-width:560px;margin-top:16px;';
  card.dataset.check = check.key;

  const titleWrap = document.createElement('div');
  titleWrap.className = 'card-title';
  titleWrap.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;';
  const h3 = document.createElement('h3');
  h3.textContent = check.title;
  const chip = document.createElement('span');
  chip.setAttribute('role', 'status');
  setStatus(chip, 'checking', t('cleanup.checking'));
  titleWrap.append(h3, chip);

  const hint = document.createElement('p');
  hint.className = 'muted';
  hint.style.cssText = 'font-size:13px;margin:0 0 12px;';
  hint.textContent = check.hint;

  const btn = document.createElement('button');
  btn.type = 'button';
  // Ghost, not accent: this only opens a review; nothing is written until
  // a change inside it is explicitly confirmed.
  btn.className = 'btn btn-ghost';
  btn.textContent = check.button;

  let last = null;
  const run = async () => {
    setStatus(chip, 'checking', t('cleanup.checking'));
    btn.disabled = check.key === 'dataCheck';
    try {
      const res = await check.count();
      // A newer render of the tab, or the page gone (navigated away).
      if (gen !== generation || !card.isConnected) return;
      last = res;
      if (res.n > 0) setStatus(chip, check.foundKind || 'found', check.found(res.n));
      else setStatus(chip, check.none?.kind || 'clean', check.none?.text || t('cleanup.clean'));
    } catch (err) {
      console.error(`clean-up check "${check.key}" failed:`, err);
      if (gen !== generation || !card.isConnected) return;
      setStatus(chip, 'checking', t('cleanup.failed'));
    }
    btn.disabled = false;
  };
  btn.addEventListener('click', () => {
    // The data check's sheet renders the report it is given, so it needs
    // one; the other sheets scan for themselves when they open.
    if (check.key === 'dataCheck' && !last) return;
    check.open(() => { run(); }, last);
  });

  card.append(titleWrap, hint, btn);
  return { card, run };
}

export function renderCleanupTab(container) {
  const gen = ++generation;
  const intro = document.createElement('p');
  intro.className = 'muted';
  intro.style.cssText = 'font-size:13px;margin:0;max-width:560px;';
  intro.textContent = t('cleanup.intro');
  container.append(intro);

  const cards = checks().map(check => buildCard(check, gen));
  for (const { card } of cards) container.append(card);

  // Paint the cards first, then run the checks one at a time off the paint
  // path, so each count lands as it finishes instead of the tab waiting on
  // the slowest.
  (async () => {
    for (const { card, run } of cards) {
      await new Promise(r => setTimeout(r, 0));
      // Navigated away: the remaining checks would only paint detached cards.
      if (gen !== generation || !card.isConnected) return;
      await run();
    }
  })();
}

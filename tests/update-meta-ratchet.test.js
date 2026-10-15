// tests/update-meta-ratchet.test.js — the plain `updateMeta` writer is for
// UI-state only. Budget-meaning meta (settings, closed months, payee data,
// investments) goes through commands, so the session can write it atomically
// with the rows it belongs to (spec §6.2). This test lists exactly the files
// allowed to call `updateMeta(`, and how many times each, and fails on any
// other, so a page cannot quietly grow a direct meta writer. The same holds
// for the paths that bypass updateMeta: a direct `saveMeta(`, the queue entry
// `runMetaExclusive(` / `runExclusive(`, and a batch naming the meta file.
// Moving a caller to a command means removing (or lowering) its entry here;
// never add one for budget-meaning data.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const JS_ROOT = join(process.cwd(), 'js');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

const posix = (f) => relative(JS_ROOT, f).split(sep).join('/');

/** Files under js/ (posix paths, relative to js/) whose text calls `name(`. */
function callers(name) {
  const re = new RegExp(`\\b${name}\\(`);
  return walk(JS_ROOT)
    .filter(f => re.test(readFileSync(f, 'utf8')))
    .map(posix)
    .sort();
}

/**
 * file -> how many times its text calls any of `names` (`name(`), for every
 * file under js/ outside js/storage/ (the adapters implement the writers) that
 * calls one at least once.
 * @param {...string} names
 */
function callCounts(...names) {
  const re = new RegExp(`\\b(?:${names.join('|')})\\(`, 'g');
  /** @type {Record<string, number>} */
  const out = {};
  for (const f of walk(JS_ROOT)) {
    const file = posix(f);
    if (file.startsWith('storage/')) continue;
    const n = (readFileSync(f, 'utf8').match(re) || []).length;
    if (n) out[file] = n;
  }
  return out;
}

const counts = (allowlist) => Object.fromEntries(Object.entries(allowlist).map(([f, { calls }]) => [f, calls]));

// The regex sees a call, not a reference: import-sheet.js hands `updateMeta` to
// csv-parse-generic.js's addTemplate/removeTemplate without calling it, so only
// the callee is listed. That is fine because it is csvTemplates (UI state)
// only; a new by-reference use for budget-meaning meta would slip past this test.

// file -> { calls: how many `updateMeta(` it holds, why it stays a plain meta
// writer } (ruling 5: UI state, not budget meaning). The count is per file, so
// a new budget-meaning call inside an allowlisted file fails too.
const UPDATE_META_ALLOWLIST = {
  'pages/settings.js': { calls: 2, why: 'show_archived_* toggles (UI state, autosaveField) and the budget name (the cloud rename side call runs inside the patch)' },
  'payee-merge-sheet.js': { calls: 1, why: 'setIgnored: payeeMergeIgnored is a dismissal list for the tidy-up sheet, UI state' },
  'duplicates-sheet.js': { calls: 1, why: 'duplicateDismissed: dismissed duplicate groups, UI state' },
  'transfer-pairs-sheet.js': { calls: 1, why: 'transferPairDismissed: pairs marked "Not a transfer" (and restored), UI state' },
  'pages/net-worth.js': { calls: 1, why: 'whatIfScenarios and netWorthSimulations: saved simulation configurations, UI state' },
  'pages/getting-started.js': { calls: 1, why: 'getting_started_dismissed: the onboarding card flag, UI state' },
  'ai/consent.js': { calls: 7, why: 'meta.ai consent and dismissals, UI state that must not touch the change log' },
  'import/csv-parse-generic.js': { calls: 2, why: 'csvTemplates: saved CSV column mappings (add and remove), UI state (the queue is passed in)' },
};

// file -> { calls, why } for a direct `saveMeta(`, which skips the meta queue
// entirely. Outside js/storage/ only these two may call it.
const SAVE_META_ALLOWLIST = {
  'state/meta-writes.js': { calls: 1, why: 'the app meta queue\'s fixed save: every updateMeta write ends here' },
  'state/load-budget.js': { calls: 1, why: 'cloud name sync on load: copies the picker\'s budgets.name into meta.name, before any page runs' },
};

// file -> { calls, why } for a meta-primary queue entry: `runMetaExclusive(`
// or `runExclusive(`, which hand the callback the queue's latest meta and let
// it write meta itself.
const RUN_EXCLUSIVE_ALLOWLIST = {
  'state/meta-queue.js': { calls: 1, why: 'defines runExclusive (the method definition matches the call pattern)' },
  'session/browser-session.js': { calls: 1, why: 'the session\'s meta-primary commit, the one sanctioned user of the queue entry' },
};

// Files outside js/storage/ and js/data.js that name the meta file
// ('budget-meta.json' or FILE_META), so a meta writeBatch cannot appear
// unseen. (encryption-config.js lives in js/storage/ and never writes meta.)
const META_FILE_ALLOWLIST = {
  'session/browser-session.js': 'COLLECTION_FILES: the session writes meta with its collections in one batch',
  'state/initial-budget.js': 'the setup wizard\'s first save (bootstrap): all six files in one batch, meta last',
  'ui/guest-budget-picker.js': 'the guest picker loads the example budget into guest memory (bootstrap)',
  'state/load-budget.js': 'fileExists probe that decides wizard versus load; reads only',
  'state/build-export-entries.js': 'names the file inside an export zip; not a storage write',
};

function filesNamingMetaFile() {
  return walk(JS_ROOT)
    .filter(f => /['"]budget-meta\.json['"]|\bFILE_META\b|\bCOLLECTION_FILES(?:\.meta\b|\[['"]meta['"]\])/.test(readFileSync(f, 'utf8')))
    .map(posix)
    .filter(file => !file.startsWith('storage/') && file !== 'data.js')
    .sort();
}

describe('updateMeta caller ratchet', () => {
  it('only the allowlisted UI-state writers call updateMeta(, each exactly as often as listed', () => {
    expect(callers('updateMeta')).toEqual(Object.keys(UPDATE_META_ALLOWLIST).sort());
    expect(callCounts('updateMeta')).toEqual(counts(UPDATE_META_ALLOWLIST));
  });

  it('only the allowlisted files call saveMeta( outside js/storage/', () => {
    expect(callCounts('saveMeta')).toEqual(counts(SAVE_META_ALLOWLIST));
  });

  it('only the allowlisted files call runMetaExclusive( or runExclusive( outside js/storage/', () => {
    expect(callCounts('runMetaExclusive', 'runExclusive')).toEqual(counts(RUN_EXCLUSIVE_ALLOWLIST));
  });

  it('only the allowlisted files name the meta file outside js/storage/', () => {
    expect(filesNamingMetaFile()).toEqual(Object.keys(META_FILE_ALLOWLIST).sort());
  });

  it('every allowlist entry says why it stays', () => {
    const whys = [
      ...[UPDATE_META_ALLOWLIST, SAVE_META_ALLOWLIST, RUN_EXCLUSIVE_ALLOWLIST].flatMap(l => Object.entries(l).map(([f, e]) => [f, e.why])),
      ...Object.entries(META_FILE_ALLOWLIST),
    ];
    for (const [file, why] of whys) expect(why.length, file).toBeGreaterThan(10);
  });

  it('withInvestments has no callers left (investment writes are commands)', () => {
    expect(callers('withInvestments')).toEqual([]);
  });
});

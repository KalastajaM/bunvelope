// tests/lint-collection-save.test.js — the path-wide ban on saving accounts and
// envelopes directly (bunvelope/no-direct-collection-save), and its ratchet.
// Spec docs/superpowers/specs/2026-10-02-api-first-core-slice-2-design.md §4.1, §6.1.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint, Linter } from 'eslint';
import bunvelope from '../tools/eslint-plugin-bunvelope/index.js';
import { COLLECTION_SAVE_ALLOWLIST } from '../eslint.config.js';
import { BROWSER_WRITABLE, COLLECTION_FILES } from '../js/session/browser-session.js';

const RULE = 'bunvelope/no-direct-collection-save';

function lint(code, filename, collections) {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(code, [{
    files: ['**/*.js'],
    plugins: { bunvelope },
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: { [RULE]: ['error', { collections }] },
  }], filename);
}

// Where the rule is configured (eslint.config.js): every js/** file except the
// storage layer, the facade and the sessions, which are the sanctioned writers,
// and the guest example load, a bootstrap write (see the config's comment).
const OUT_OF_SCOPE = (p) => p.startsWith('js/storage/') || p === 'js/data.js' || p.startsWith('js/session/')
  || p === 'js/ui/guest-budget-picker.js';
const jsFiles = () => readdirSync('js', { recursive: true })
  .map(f => `js/${String(f).replaceAll('\\', '/')}`)
  .filter(p => p.endsWith('.js'));

describe('bunvelope/no-direct-collection-save', () => {
  const collections = { saveAccounts: ['js/pages/accounts.js'], saveEnvelopes: [] };

  it('flags a named import of a listed save from the facade, in a file not allowed for it', () => {
    const planted = "import { saveAccounts, saveMeta } from '../data.js';\n";
    const msgs = lint(planted, 'js/pages/planted.js', collections);
    expect(msgs.map(m => m.ruleId)).toEqual([RULE]);
    expect(msgs[0].message).toContain('saveAccounts');
  });

  it('flags the same import from the storage facade', () => {
    const planted = "import { saveEnvelopes as save } from './storage/index.js';\n";
    expect(lint(planted, 'js/reconcile.js', collections).map(m => m.ruleId)).toEqual([RULE]);
  });

  it('passes an allowed path, but only for the function it is allowed', () => {
    expect(lint("import { saveAccounts } from '../data.js';\n", 'js/pages/accounts.js', collections)).toEqual([]);
    const other = lint("import { saveEnvelopes } from '../data.js';\n", 'js/pages/accounts.js', collections);
    expect(other.map(m => m.ruleId)).toEqual([RULE]);
  });

  it('ignores unlisted functions and modules that are not storage', () => {
    expect(lint("import { saveMeta, writeBatch } from '../data.js';\n", 'js/pages/planted.js', collections)).toEqual([]);
    expect(lint("import { saveAccounts } from './metadata-helpers.js';\n", 'js/pages/planted.js', collections)).toEqual([]);
    expect(lint("import { saveAccounts } from '../storage/other-adapter.js';\n", 'js/pages/planted.js', collections)).toEqual([]);
  });

  it('matches an allowed path as a suffix of the file path, not a substring', () => {
    const code = "import { saveAccounts } from '../data.js';\n";
    expect(lint(code, resolve('js/pages/accounts.js'), collections)).toEqual([]);
    expect(lint(code, 'xjs/pages/accounts.js', collections).map(m => m.ruleId)).toEqual([RULE]);
    expect(lint(code, 'js/pages/accounts.js.bak.js', collections).map(m => m.ruleId)).toEqual([RULE]);
  });

  // Every form the rule covers, each planted in a file not allowed for it.
  const planted = (code, filename = 'js/pages/planted.js') => lint(code, filename, collections)
    .map(m => [m.ruleId, m.message.match(/`(\w+)`/)?.[1]]);

  it.each(['api', 'fsapi', 'guest'])('flags a named import from the %s adapter', (adapter) => {
    expect(planted(`import { saveEnvelopes } from '../storage/${adapter}-adapter.js';\n`)).toEqual([[RULE, 'saveEnvelopes']]);
  });

  it('flags a listed function read through a namespace import, and nothing else on it', () => {
    const code = [
      "import * as data from '../data.js';",
      'data.saveAccounts([]);',
      "data['saveEnvelopes']([]);",
      'const { saveEnvelopes: s } = data;',
      'data.saveMeta({});',
    ].join('\n');
    expect(planted(code)).toEqual([[RULE, 'saveAccounts'], [RULE, 'saveEnvelopes'], [RULE, 'saveEnvelopes']]);
    expect(planted("import * as data from '../data.js';\ndata.saveAccounts([]);\n", 'js/pages/accounts.js')).toEqual([]);
  });

  it('flags a named re-export and an export-all of a storage module', () => {
    expect(planted("export { saveAccounts as save } from '../data.js';\n")).toEqual([[RULE, 'saveAccounts']]);
    expect(planted("export { saveMeta } from '../data.js';\n")).toEqual([]);
    expect(planted("export * from '../storage/fsapi-adapter.js';\n")).toEqual([[RULE, 'saveAccounts'], [RULE, 'saveEnvelopes']]);
    // The file allowed saveAccounts is still flagged for the other one.
    expect(planted("export * from '../data.js';\n", 'js/pages/accounts.js')).toEqual([[RULE, 'saveEnvelopes']]);
  });

  it('flags a dynamic import, destructured or bound to a namespace', () => {
    const code = [
      'async function f() {',
      "  const { saveAccounts } = await import('../data.js');",
      "  const api = await import('../storage/api-adapter.js');",
      '  api.saveEnvelopes([]);',
      '  api.patchUserPrefs({});',
      "  const { renameCloudBudget } = await import('../storage/api-adapter.js');",
      '}',
    ].join('\n');
    expect(planted(code)).toEqual([[RULE, 'saveAccounts'], [RULE, 'saveEnvelopes']]);
  });

  it('the configured list bans saveBudgetItems and saveEnvelopeTemplates, per file', () => {
    expect(COLLECTION_SAVE_ALLOWLIST).toHaveProperty('saveBudgetItems');
    expect(COLLECTION_SAVE_ALLOWLIST).toHaveProperty('saveEnvelopeTemplates');
    const configured = (code, file = 'js/pages/planted.js') => lint(code, file, COLLECTION_SAVE_ALLOWLIST)
      .map(m => [m.ruleId, m.message.match(/`(\w+)`/)?.[1]]);
    expect(configured("import { saveBudgetItems } from '../data.js';\n")).toEqual([[RULE, 'saveBudgetItems']]);
    expect(configured("import { saveEnvelopeTemplates as s } from '../storage/api-adapter.js';\n")).toEqual([[RULE, 'saveEnvelopeTemplates']]);
    expect(configured("import * as d from '../data.js';\nd.saveBudgetItems([]);\n")).toEqual([[RULE, 'saveBudgetItems']]);
    // Every list is empty now: the app's loan upkeep dispatches a command, and
    // the templates page dispatches template commands.
    expect(configured("import { saveBudgetItems } from '../data.js';\n", 'js/app.js')).toEqual([[RULE, 'saveBudgetItems']]);
    expect(configured("import { saveEnvelopeTemplates } from '../data.js';\n", 'js/app.js')).toEqual([[RULE, 'saveEnvelopeTemplates']]);
    expect(configured("import { saveEnvelopeTemplates } from '../data.js';\n", 'js/pages/templates.js')).toEqual([[RULE, 'saveEnvelopeTemplates']]);
    expect(configured("import { saveBudgetItems } from '../data.js';\n", 'js/pages/stress.js')).toEqual([[RULE, 'saveBudgetItems']]);
    expect(configured("import { saveBudgetItems } from '../data.js';\n", 'js/pages/templates.js')).toEqual([[RULE, 'saveBudgetItems']]);
  });

  it('the configured list bans saveTransactions, per file', () => {
    expect(COLLECTION_SAVE_ALLOWLIST).toHaveProperty('saveTransactions');
    expect(COLLECTION_SAVE_ALLOWLIST.saveTransactions).toEqual([]);
    const configured = (code, file = 'js/pages/planted.js') => lint(code, file, COLLECTION_SAVE_ALLOWLIST)
      .map(m => [m.ruleId, m.message.match(/`(\w+)`/)?.[1]]);
    expect(configured("import { saveTransactions } from '../data.js';\n")).toEqual([[RULE, 'saveTransactions']]);
    expect(configured("import { saveTransactions as s } from '../storage/api-adapter.js';\n")).toEqual([[RULE, 'saveTransactions']]);
    expect(configured("import * as d from '../data.js';\nd.saveTransactions(h, []);\n")).toEqual([[RULE, 'saveTransactions']]);
    // No file is exempt: the state layer, where the old write helper lived, is
    // covered like every other file outside storage and the sessions.
    expect(configured("import { saveTransactions } from '../data.js';\n", 'js/state/planted.js')).toEqual([[RULE, 'saveTransactions']]);
    expect(configured("import { saveTransactions } from '../data.js';\n", 'js/app.js')).toEqual([[RULE, 'saveTransactions']]);
  });

  it('the configured list bans writeJson too: it writes any file, accounts.json included', () => {
    expect(COLLECTION_SAVE_ALLOWLIST).toHaveProperty('writeJson');
    const configured = (code) => lint(code, 'js/pages/planted.js', COLLECTION_SAVE_ALLOWLIST).map(m => m.ruleId);
    expect(configured("import { writeJson } from '../data.js';\n")).toEqual([RULE]);
    expect(configured("import { writeJson as w } from '../storage/fsapi-adapter.js';\n")).toEqual([RULE]);
    expect(configured("import * as s from '../storage/index.js';\ns.writeJson(h, 'accounts.json', []);\n")).toEqual([RULE]);
  });

  it('is configured for js/** outside storage, the facade and the sessions', async () => {
    const eslint = new ESLint();
    const on = async (p) => Boolean((await eslint.calculateConfigForFile(p))?.rules?.[RULE]);
    expect(await on('js/pages/accounts.js')).toBe(true);
    expect(await on('js/state/load-budget.js')).toBe(true);
    expect(await on('js/reconcile.js')).toBe(true);
    expect(await on('js/storage/fsapi-adapter.js')).toBe(false);
    expect(await on('js/data.js')).toBe(false);
    expect(await on('js/session/browser-session.js')).toBe(false);
    expect(await on('js/ui/guest-budget-picker.js')).toBe(false);
  });
});

describe('collection save ratchet', () => {
  // Lints every js/ file: past the 5 s default under full-suite load.
  it('lists exactly the files that import each save today (shrink it as writers move to the session)', { timeout: 20000 }, () => {
    // Lint every in-scope file with empty allow lists: what it reports is the
    // set of files that import each function, by the rule's own reading.
    const empty = Object.fromEntries(Object.keys(COLLECTION_SAVE_ALLOWLIST).map(fn => [fn, []]));
    /** @type {Record<string, string[]>} */
    const importing = Object.fromEntries(Object.keys(COLLECTION_SAVE_ALLOWLIST).map(fn => [fn, []]));
    for (const path of jsFiles().filter(p => !OUT_OF_SCOPE(p))) {
      for (const m of lint(readFileSync(path, 'utf8'), path, empty)) {
        if (m.ruleId !== RULE) continue;
        const fn = Object.keys(importing).find(name => m.message.includes(`\`${name}\``));
        if (fn && !importing[fn].includes(path)) importing[fn].push(path);
      }
    }
    const sorted = (lists) => Object.fromEntries(Object.entries(lists).map(([fn, files]) => [fn, [...files].sort()]));
    expect(sorted(importing), 'COLLECTION_SAVE_ALLOWLIST in eslint.config.js must match the files that import each save').toEqual(sorted(COLLECTION_SAVE_ALLOWLIST));
  });
});

// The tie: a kind the browser session may write (BROWSER_WRITABLE) has no legacy
// writer left. Meta has its own writers (the meta queue, a different ratchet);
// every other writable kind is a collection whose save function the rule bans,
// so its allow list must be empty and no file may batch-write its file. Adding
// a kind to BROWSER_WRITABLE while a page still saves it directly fails here.
describe('browser-writable kinds have no legacy writer', () => {
  const kinds = BROWSER_WRITABLE.filter(k => k !== 'meta');
  const saveFn = (kind) => `save${kind[0].toUpperCase()}${kind.slice(1)}`;

  it('covers every writable collection (the check below is not vacuous)', () => {
    expect([...kinds].sort()).toEqual(['accounts', 'budgetItems', 'envelopeTemplates', 'envelopes', 'transactions']);
  });

  it.each(kinds)('%s: its save function is banned everywhere, with an empty allow list', (kind) => {
    expect(COLLECTION_SAVE_ALLOWLIST, `${saveFn(kind)} must be a rule-managed save`).toHaveProperty(saveFn(kind));
    expect(COLLECTION_SAVE_ALLOWLIST[saveFn(kind)]).toEqual([]);
  });

  it.each(kinds)('%s: no file outside the exempt writers batch-writes its file', (kind) => {
    const exempt = (p) => OUT_OF_SCOPE(p) || p === 'js/state/initial-budget.js';
    const outside = jsFiles().filter(p => !exempt(p)).filter(path => {
      const source = readFileSync(path, 'utf8');
      return writeBatchCalls(source).length > 0 && writesFile(source, kind);
    });
    expect(outside).toEqual([]);
  });
});

describe('the writeBatch scan', () => {
  it('extracts each call up to its balanced closing paren', () => {
    const text = [
      "await writeBatch(ref, [{ filename: 'a.json', data: f(x, (y)) }]);",
      'other(writeBatch);',
      "writeBatch(r, items.map(i => ({ ...i })))",
    ].join('\n');
    expect(writeBatchCalls(text)).toEqual([
      "writeBatch(ref, [{ filename: 'a.json', data: f(x, (y)) }])",
      'writeBatch(r, items.map(i => ({ ...i })))',
    ]);
    expect(writeBatchCalls('nothing here')).toEqual([]);
    // An unterminated call runs to the end of the text, still scanned.
    expect(writeBatchCalls("writeBatch(r, [{ filename: 'accounts.json'")).toEqual(["writeBatch(r, [{ filename: 'accounts.json'"]);
  });

  it('matches a kind by its file name or its FILE_ constant', () => {
    expect(writesFile("writeBatch(r, [{ filename: 'accounts.json', data }])", 'accounts')).toBe(true);
    expect(writesFile('writeBatch(r, [{ filename: COLLECTION_FILES.accounts, data }])', 'accounts')).toBe(true);
    expect(writesFile("const items = [{ filename: COLLECTION_FILES['accounts'], data }]; writeBatch(r, items)", 'accounts')).toBe(true);
    expect(writesFile('writeBatch(r, [{ filename: FILE_ACCOUNTS, data }])', 'accounts')).toBe(true);
    expect(writesFile('writeBatch(r, [{ filename: FILE_ENVELOPES, data }])', 'envelopes')).toBe(true);
    expect(writesFile('writeBatch(r, [{ filename: FILE_ENV_TEMPLATES, data }])', 'envelopes')).toBe(false);
    expect(writesFile('writeBatch(r, [{ filename: FILE_ENV_TEMPLATES, data }])', 'envelopeTemplates')).toBe(true);
    expect(writesFile('writeBatch(r, [{ filename: FILE_BUDGET_ITEMS, data }])', 'budgetItems')).toBe(true);
    expect(writesFile("writeBatch(r, [{ filename: 'budget-items.json', data }])", 'budgetItems')).toBe(true);
    expect(writesFile("writeBatch(r, [{ filename: 'envelope-templates.json', data }])", 'envelopeTemplates')).toBe(true);
    expect(writesFile("writeBatch(r, [{ filename: 'envelope-templates.json', data }])", 'budgetItems')).toBe(false);
    expect(writesFile("writeBatch(r, [{ filename: 'envelope-templates.json', data }])", 'envelopes')).toBe(false);
    expect(writesFile("writeBatch(r, [{ filename: 'transactions.json', data }])", 'accounts')).toBe(false);
    expect(writesFile("writeBatch(r, [{ filename: 'transactions.json', data }])", 'transactions')).toBe(true);
    expect(writesFile('writeBatch(r, [{ filename: FILE_TRANSACTIONS, data }])', 'transactions')).toBe(true);
    expect(writesFile('writeBatch(r, [{ filename: FILE_TRANSACTIONS, data }])', 'accounts')).toBe(false);
  });
});

// The facade's file constant for each collection. Explicit, not derived from the
// kind's name: FILE_BUDGET_ITEMS and FILE_ENV_TEMPLATES do not follow it.
const FILE_CONSTANTS = { transactions: 'FILE_TRANSACTIONS', accounts: 'FILE_ACCOUNTS', envelopes: 'FILE_ENVELOPES', budgetItems: 'FILE_BUDGET_ITEMS', envelopeTemplates: 'FILE_ENV_TEMPLATES' };

// Whether a writeBatch call's text names `kind`'s file: the literal file name,
// or the facade's constant for it.
function writesFile(call, kind) {
  const constant = FILE_CONSTANTS[kind];
  return call.includes(COLLECTION_FILES[kind]) || new RegExp(`\\b${constant}\\b|\\bCOLLECTION_FILES(?:\\.${kind}\\b|\\[['"]${kind}['"]\\])`).test(call);
}

// The text of every `writeBatch(...)` call in `text`, up to its closing paren.
function writeBatchCalls(text) {
  const calls = [];
  let at = text.indexOf('writeBatch(');
  while (at !== -1) {
    let depth = 0;
    let end = at + 'writeBatch'.length;
    for (; end < text.length; end++) {
      if (text[end] === '(') depth++;
      else if (text[end] === ')' && --depth === 0) break;
    }
    calls.push(text.slice(at, end + 1));
    at = text.indexOf('writeBatch(', end);
  }
  return calls;
}

import js from '@eslint/js';
import globals from 'globals';
import bunvelope from './tools/eslint-plugin-bunvelope/index.js';

// Pages that still save directly instead of dispatching through `session`
// (js/app.js). Empty since slice 2d, and it must stay so: the rule below fails
// on any page that saves directly, and tests/page-save-ratchet.test.js fails on
// any entry that no longer saves. Spec: docs/superpowers/specs/2026-10-01-api-first-core-design.md §10.
export const SAVE_RATCHET_ALLOWLIST = [];

// Files allowed to save a collection directly, per save function: none. The
// browser session writes every collection (js/session/browser-session.js), and
// its concurrency check holds only for a collection with no legacy writer, so
// every list is empty and must stay so. The rule below applies to all of
// js/** except storage, the facade and the sessions; a file that imports one of
// these fails lint. tests/lint-collection-save.test.js keeps each list exact and
// requires it empty for every kind the browser session writes
// (BROWSER_WRITABLE): transactions, accounts, envelopes, budget items and
// envelope templates (meta has its own queue, see tests/update-meta-ratchet.test.js).
// Spec: docs/superpowers/specs/2026-10-02-api-first-core-slice-2-design.md
// §4.1, §6.1. writeJson is listed too: it writes any one file, accounts.json
// and envelopes.json included, and nothing outside storage and the sessions
// uses it.
export const COLLECTION_SAVE_ALLOWLIST = {
  saveTransactions: [],
  saveAccounts: [],
  saveEnvelopes: [],
  saveBudgetItems: [],
  saveEnvelopeTemplates: [],
  writeJson: [],
};

// Pages, UI and AI modules do not compute money. They read a core query
// (`session.query`, js/ai/query.js), so the pages, the CLI and the AI agree.
// `bunvelope/no-page-money` reports an import of a banned engine function in
// js/pages, js/ui and js/ai, including portfolio helpers reached through
// core/portfolio.js or state/investments.js: any name matching a pattern (compute*, aggregate*,
// summarize*) plus the listed names. Not banned: row helpers (txAbsAmount,
// predicates, constants), row generators (forecast*), `loanRepayment` (it
// resolves a schedule; `loanSchedule` itself is banned) and the stress model's
// draft helpers (js/engine/stress.js: clampFrac, scenarioHits, stressCutPct,
// setStressCutPct, clearStressCuts, cutScenariosFor, expandFlatCuts, ...),
// which edit a draft and compute no money. Its money names are banned below.
export const PAGE_MONEY_BANNED = {
  names: [
    'filterAndSort', 'transactionsPageTxList',
    'resolveTemplateLines',
    'portfolioByAccount', 'portfolioSummary', 'trackedHoldings', 'portfolioValueByAccount',
    'identityAccountTotal', 'netWorthFromBalances', 'simulate', 'projectFromSimulation',
    'diffAlerts', 'averageMonthlyContribution', 'loanBalancePath', 'loanSchedule',
    'loanGivenTerms', 'loanRateOn', 'txConsumptionPairs',
    'txConsumptionTotal', 'attributeAgeOfMoneyDrop', 'projectEnvelopeBalance',
    'recommendEnvelopeActions', 'trailingMonthlyAverage', 'buildPlanFlow',
    'buildActualFlow', 'listHoldings',
    'annualAmount', 'adjustedAnnual', 'itemsWithFlatLadder', 'stressCutFor',
  ],
  patterns: ['^(compute|aggregate|summarize)'],
};

// No page, UI or AI file imports a banned name, and none ever will again: the
// table is empty and stays so. A new figure is a core query, not an entry.
// tests/lint-page-money.test.js fails on any import and on any entry. Spec:
// docs/superpowers/specs/2026-10-03-api-first-core-slice-4-design.md §7.
export const PAGE_MONEY_ALLOWLIST = {};

// No file may writeBatch a collection file the session owns: transactions.json,
// accounts.json, envelopes.json, budget-items.json or envelope-templates.json
// (by name or by the facade's FILE_TRANSACTIONS / FILE_ACCOUNTS /
// FILE_ENVELOPES / FILE_BUDGET_ITEMS / FILE_ENV_TEMPLATES). The rule cannot see a file name inside a batch, so
// tests/lint-collection-save.test.js greps for it, per kind. Bootstrap writes
// are exempt by path: the setup wizard's js/state/initial-budget.js and the
// guest example load, js/ui/guest-budget-picker.js (see the rule's config
// block below).

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'AssignmentExpression[left.property.name="innerHTML"][right.type="TemplateLiteral"][right.expressions.length>0]',
          message: 'innerHTML with interpolation is forbidden — call escHtml() on every interpolated value, then add "// eslint-disable-next-line no-restricted-syntax -- values are escHtml-wrapped" above the assignment.',
        },
      ],
    },
  },
  {
    // AGENTS.md's sign convention, machine-checked. The allowlist is the set
    // of files that DEFINE the convention: the helpers themselves, the
    // per-type rules they are built from, and the invariant checker whose job
    // is to inspect the raw stored value.
    files: ['js/**/*.js'],
    plugins: { bunvelope },
    rules: {
      // Engine functions that require a clock throw without one, and page
      // call sites are outside the typecheck scope — so check the call here.
      'bunvelope/clock-argument-required': 'error',
      'bunvelope/no-raw-tx-amount': ['error', {
        allow: [
          'js/engine/tx-amounts.js',
          'js/engine/balances.js',
          'js/engine/insights.js',
        ],
      }],
    },
  },
  {
    // The engine is pure: no DOM, no storage, no network, no clock it did not
    // receive. This is the layering rule AGENTS.md states in prose, made
    // machine-checked — a boundary that exists only in prose gets crossed.
    //
    // `no-restricted-globals` resolves through scope, so a local binding that
    // happens to be named `window` (envelope-forecast.js has one, holding the
    // projection window) is correctly not a violation.
    files: ['js/engine/**/*.js'],
    plugins: { bunvelope },
    rules: {
      'bunvelope/no-ambient-clock': ['error', {
        allow: [
          // Profiling instrumentation for the memoization cache. It reads a
          // clock, but only to fill `_stats` — no result depends on it.
          'js/engine/balance-cache.js',
        ],
      }],
      'no-restricted-globals': ['error',
        { name: 'window', message: 'The engine is pure — no DOM. Take what you need as a parameter.' },
        { name: 'document', message: 'The engine is pure — no DOM. Build elements in js/ui or js/pages.' },
        { name: 'localStorage', message: 'The engine is pure — no storage. Read prefs in js/app.js and pass them in.' },
        { name: 'sessionStorage', message: 'The engine is pure — no storage.' },
        { name: 'fetch', message: 'The engine is pure — no I/O. Fetch in an adapter and pass the data in.' },
        { name: 'XMLHttpRequest', message: 'The engine is pure — no I/O.' },
        { name: 'navigator', message: 'The engine is pure — no host objects.' },
        { name: 'alert', message: 'The engine is pure — no UI. Return a code; the page renders it.' },
        { name: 'requestAnimationFrame', message: 'The engine is pure — no frame loop.' },
      ],
    },
  },
  {
    // Core is the command/query layer every surface calls (spec
    // docs/superpowers/specs/2026-10-01-api-first-core-design.md). It runs
    // unchanged in the browser and in Node, so it gets the engine's purity
    // rules plus a ban on reaching up into app state, storage or UI.
    files: ['js/core/**/*.js'],
    plugins: { bunvelope },
    rules: {
      'bunvelope/no-ambient-clock': 'error',
      'no-restricted-globals': ['error',
        { name: 'window', message: 'Core is pure — no DOM.' },
        { name: 'document', message: 'Core is pure — no DOM.' },
        { name: 'localStorage', message: 'Core is pure — no storage.' },
        { name: 'sessionStorage', message: 'Core is pure — no storage.' },
        { name: 'fetch', message: 'Core is pure — no I/O. A session does I/O.' },
        { name: 'navigator', message: 'Core is pure — no host objects.' },
        { name: 'process', message: 'Core runs in the browser too — no Node globals. A session supplies them.' },
        { name: 'XMLHttpRequest', message: 'Core is pure — no I/O. A session does I/O.' },
        { name: 'alert', message: 'Core is pure — no UI. Return a result; the surface reports it.' },
      ],
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/app.js', '**/data.js', '**/storage/index.js', '**/state/**', '**/ui/**', '**/pages/**', '**/session/**'],
          message: 'Core must not import app state, storage, sessions or UI. Take what you need as input or ctx.',
        }, {
          group: ['node:*'],
          message: 'Core runs in the browser too — no Node built-ins.',
        }],
      }],
    },
  },
  {
    // Accounts, envelopes, budget items and envelope templates are written
    // through the session only. Exempt: storage, the facade and the sessions,
    // which are the writers; and
    // js/ui/guest-budget-picker.js, the guest example load. It resets state,
    // writes all six example files into in-memory guest storage, then loads
    // them: a bootstrap write like the setup wizard's (spec 2026-10-02 slice 2
    // §4.2), and nothing can race it.
    files: ['js/**/*.js'],
    ignores: ['js/storage/**', 'js/data.js', 'js/session/**', 'js/ui/guest-budget-picker.js'],
    plugins: { bunvelope },
    rules: {
      'bunvelope/no-direct-collection-save': ['error', { collections: COLLECTION_SAVE_ALLOWLIST }],
    },
  },
  {
    // Pages, UI and AI modules read money from core queries (see
    // PAGE_MONEY_BANNED above).
    files: ['js/pages/**/*.js', 'js/ui/**/*.js', 'js/ai/**/*.js'],
    plugins: { bunvelope },
    rules: {
      'bunvelope/no-page-money': ['error', { ...PAGE_MONEY_BANNED, allow: PAGE_MONEY_ALLOWLIST }],
    },
  },
  {
    files: ['js/pages/**/*.js'],
    ignores: SAVE_RATCHET_ALLOWLIST,
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: '../data.js', importNames: ['saveTransactions', 'saveAccounts', 'saveEnvelopes', 'saveBudgetItems', 'saveEnvelopeTemplates', 'saveMeta', 'writeBatch'], message: 'Pages write through session.dispatch (js/app.js), not the storage facade.' },
        ],
      }],
    },
  },
  {
    // Test files run in Node via Vitest; allow their globals too.
    files: ['tests/**/*.js', 'vitest.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Fix scripts and build tooling are Node scripts.
    files: ['scripts/**/*.mjs', 'scripts/**/*.js', 'tools/**/*.mjs', 'tools/**/*.js', 'bin/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Playwright e2e suite runs under Node.
    files: ['e2e/**/*.js', 'playwright.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Server runs under Node.
    files: ['server/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    ignores: ['desktop/**', 'node_modules/**', 'design_handoff_bunvelope/**', 'docs/**', '.claude/**', '_scratch/**', 'coverage/**', '.worktrees/**'],
  },
];

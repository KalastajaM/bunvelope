// tests/lint-page-money.test.js — pages, UI and AI modules do not compute money
// (bunvelope/no-page-money), and its per-file, per-name ratchet.
// Spec docs/superpowers/specs/2026-10-03-api-first-core-slice-4-design.md §7.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint, Linter } from 'eslint';
import bunvelope from '../tools/eslint-plugin-bunvelope/index.js';
import { PAGE_MONEY_BANNED, PAGE_MONEY_ALLOWLIST } from '../eslint.config.js';

const RULE = 'bunvelope/no-page-money';

function lint(code, filename, allow = {}) {
  const linter = new Linter({ configType: 'flat' });
  return linter.verify(code, [{
    files: ['**/*.js'],
    plugins: { bunvelope },
    languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    rules: { [RULE]: ['error', { ...PAGE_MONEY_BANNED, allow }] },
  }], filename);
}

const planted = (code, filename = 'js/pages/planted.js', allow = {}) => lint(code, filename, allow)
  .map(m => [m.ruleId, m.message.match(/`([\w*]+)`/)?.[1]]);

describe('bunvelope/no-page-money', () => {
  it('requires shared transaction search rather than rebuilding the display list', () => {
    expect(planted("import { filterAndSort as search } from '../core/transactions-filter.js';"))
      .toEqual([[RULE, 'filterAndSort']]);
    expect(planted("import * as list from '../core/effective-txs.js'; list.transactionsPageTxList();"))
      .toEqual([[RULE, 'transactionsPageTxList']]);
  });
  it('requires a query for resolved template money', () => {
    expect(planted("import { resolveTemplateLines as lines } from '../engine.js';")).toEqual([[RULE, 'resolveTemplateLines']]);
  });
  it.each(['../core/portfolio.js', '../../core/portfolio.js', '../state/investments.js', '../../state/investments.js', '../engine/holdings.js'])(
    'flags portfolio computations through %s, including aliases and namespace/dynamic access', (source) => {
      expect(planted(`import { portfolioByAccount as values, portfolioSummary, trackedHoldings, portfolioValueByAccount } from '${source}';`))
        .toEqual([[RULE, 'portfolioByAccount'], [RULE, 'portfolioSummary'], [RULE, 'trackedHoldings'], [RULE, 'portfolioValueByAccount']]);
      expect(planted(`import * as p from '${source}'; p.portfolioByAccount(); p['portfolioSummary'](); const { trackedHoldings } = p;`))
        .toEqual([[RULE, 'portfolioByAccount'], [RULE, 'portfolioSummary'], [RULE, 'trackedHoldings']]);
      expect(planted(`async function f() { const { portfolioByAccount: p } = await import('${source}'); const m = await import('${source}'); m.portfolioSummary(); }`))
        .toEqual([[RULE, 'portfolioByAccount'], [RULE, 'portfolioSummary']]);
      expect(planted(`export { portfolioByAccount as values } from '${source}';`)).toEqual([[RULE, 'portfolioByAccount']]);
      expect(planted(`export * from '${source}';`)).toEqual([[RULE, '*']]);
    });

  it('allows portfolio metadata and account-selection helpers', () => {
    expect(planted("import { getInvestmentsMeta, lookupSymbolForPayee, normalisePayeeKey } from '../state/investments.js';\nimport { trackedInvestmentAccounts, taxExemptAccountIds } from '../core/portfolio.js';")).toEqual([]);
  });

  it.each(['../engine.js', '../../engine.js', '../engine/balances.js', '../../engine/balances.js', './engine/whatif.js'])(
    'flags a named import of a banned name from %s', (source) => {
      expect(planted(`import { computeAccountBalances, txAbsAmount } from '${source}';\n`)).toEqual([[RULE, 'computeAccountBalances']]);
    });

  it.each(['../engine/stress.js', '../engine.js'])('flags the stress money names imported from %s, and not the draft helpers', (source) => {
    const code = `import { annualAmount, adjustedAnnual, itemsWithFlatLadder, stressCutFor, loanRepayment, clampFrac, stressCutPct, scenarioHits } from '${source}';\n`;
    expect(planted(code)).toEqual([
      [RULE, 'annualAmount'], [RULE, 'adjustedAnnual'], [RULE, 'itemsWithFlatLadder'], [RULE, 'stressCutFor'],
    ]);
  });

  it('flags a banned name by pattern and by list, and reports the original name of an alias', () => {
    const code = "import { aggregateSpendingByEnvelope as a, summarizeHoldings, identityAccountTotal, simulate } from '../engine.js';\n";
    expect(planted(code)).toEqual([
      [RULE, 'aggregateSpendingByEnvelope'], [RULE, 'summarizeHoldings'], [RULE, 'identityAccountTotal'], [RULE, 'simulate'],
    ]);
  });

  it('does not flag a row helper, a row generator, a constant or a stress cut helper', () => {
    const code = [
      "import { txAbsAmount, txAccountDelta, isSpendingAccount, LENS_BOOKED, forecastAllFills, forecastScheduledTransactions } from '../engine.js';",
      "import { stressCutPct, scenarioHits } from '../engine/stress.js';",
      "import { computeAccountBalances } from './other-engine-helpers.js';",
      "import { computeAccountBalances as c } from '../core/engine-like.js';",
    ].join('\n');
    expect(planted(code)).toEqual([]);
  });

  it('flags a banned name read through a namespace, and nothing else on it', () => {
    const code = [
      "import * as eng from '../engine.js';",
      'eng.computeNetWorth([], []);',
      "eng['loanSchedule']({});",
      'const { projectEnvelopeBalance: p } = eng;',
      'eng.txAbsAmount({});',
    ].join('\n');
    expect(planted(code)).toEqual([[RULE, 'computeNetWorth'], [RULE, 'loanSchedule'], [RULE, 'projectEnvelopeBalance']]);
  });

  it('flags a dynamic import, destructured or bound to a namespace', () => {
    const code = [
      'async function f() {',
      "  const { loanSchedule } = await import('../engine/loan-schedule.js');",
      "  const w = await import('../../engine/whatif.js');",
      '  w.computeWhatIf({});',
      '  w.SCENARIOS;',
      "  const { txAbsAmount } = await import('../engine.js');",
      '}',
    ].join('\n');
    expect(planted(code)).toEqual([[RULE, 'loanSchedule'], [RULE, 'computeWhatIf']]);
  });

  it('flags a named re-export and an export-all', () => {
    expect(planted("export { computeAccountBalances as balances } from '../engine.js';\n")).toEqual([[RULE, 'computeAccountBalances']]);
    expect(planted("export { txAbsAmount } from '../engine.js';\n")).toEqual([]);
    expect(planted("export * from '../engine/balances.js';\n")).toEqual([[RULE, '*']]);
    expect(planted("export * from './other.js';\n")).toEqual([]);
  });

  it('passes a name in the file allow list, only for that name and that file', () => {
    const allow = { 'js/pages/dashboard.js': ['simulate'] };
    const code = "import { simulate, computeNetWorth } from '../engine.js';\n";
    expect(planted(code, 'js/pages/dashboard.js', allow)).toEqual([[RULE, 'computeNetWorth']]);
    expect(planted(code, 'js/pages/other.js', allow)).toEqual([[RULE, 'simulate'], [RULE, 'computeNetWorth']]);
    // The path matches as a suffix of the file path, not a substring.
    expect(planted("import { simulate } from '../engine.js';\n", resolve('js/pages/dashboard.js'), allow)).toEqual([]);
    expect(planted("import { simulate } from '../engine.js';\n", 'xjs/pages/dashboard.js', allow)).toEqual([[RULE, 'simulate']]);
  });

  it('is configured for js/pages, js/ui and js/ai, and nowhere else', async () => {
    const eslint = new ESLint();
    const on = async (p) => Boolean((await eslint.calculateConfigForFile(p))?.rules?.[RULE]);
    expect(await on('js/pages/dashboard.js')).toBe(true);
    expect(await on('js/ui/sankey/layout.js')).toBe(true);
    expect(await on('js/ai/tools/read.js')).toBe(true);
    expect(await on('js/core/queries/balances.js')).toBe(false);
    expect(await on('js/engine/balances.js')).toBe(false);
    expect(await on('js/app.js')).toBe(false);
  });
});

const jsFiles = () => readdirSync('js', { recursive: true })
  .map(f => `js/${String(f).replaceAll('\\', '/')}`)
  .filter(p => p.endsWith('.js'))
  .filter(p => p.startsWith('js/pages/') || p.startsWith('js/ui/') || p.startsWith('js/ai/'));

describe('page money ratchet', () => {
  // Lints every page, UI and AI file: past the 5 s default under full-suite load.
  it('no page, UI or AI file imports a banned name', { timeout: 20000 }, () => {
    /** @type {Record<string, string[]>} */
    const importing = {};
    for (const path of jsFiles()) {
      for (const m of lint(readFileSync(path, 'utf8'), path, {})) {
        if (m.ruleId !== RULE) continue;
        const name = m.message.match(/`([\w*]+)`/)[1];
        (importing[path] ??= []).includes(name) || importing[path].push(name);
      }
    }
    expect(importing, 'a page imports a banned engine name: read a core query instead').toEqual({});
  });

  it('the allow list is empty and stays empty: a new figure is a core query, never an entry', () => {
    expect(PAGE_MONEY_ALLOWLIST).toEqual({});
  });

  it('loanItemsByLoanAccount is not banned (it is a row lookup, not money)', () => {
    expect(PAGE_MONEY_BANNED.names).not.toContain('loanItemsByLoanAccount');
  });
});

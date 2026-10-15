/**
 * Local ESLint rules for the conventions AGENTS.md states in prose.
 *
 * Ported in spirit from the v2 rebuild's `tools/eslint-plugin-bunvelope`,
 * whose README gives the reason plainly: a boundary that exists only in prose
 * gets crossed. The June 2026 QA pass found three page modules computing
 * `Math.abs(Number(tx.amount))` by hand instead of calling `txAbsAmount`, and
 * they were fixed; by August there were six, in different files. Nothing had
 * gone wrong with the rule — nothing was checking it.
 */

/**
 * AGENTS.md, "Transaction amount sign convention": never read `tx.amount`
 * directly when computing a display amount or a balance delta.
 *
 *   magnitude       → txAbsAmount(tx)
 *   account delta   → txAccountDelta(tx, accountId)
 *   envelope effect → txEnvelopeEffect(tx, envelopeId)
 *   spend           → txSpendTotal(tx) / txSpendPairs(tx)
 *
 * `validateAmount(tx.amount)` is allowed: that IS the coercion the helpers are
 * built from, and the per-type rules in the engine have to start somewhere.
 * The `allow` option carries the files where those rules live.
 */
const noRawTxAmount = {
  meta: {
    type: 'problem',
    docs: { description: 'read a transaction amount through the engine helpers, not off the object' },
    schema: [{
      type: 'object',
      properties: { allow: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    }],
    messages: {
      raw: 'Do not read `tx.amount` directly — the sign convention lives in the engine. Use txAbsAmount(tx) for a magnitude, txAccountDelta(tx, id) for an account delta, or validateAmount(tx.amount) if you genuinely need the stored value (an adjustment carries its sign).',
    },
  },
  create(ctx) {
    const allow = ctx.options[0]?.allow ?? [];
    const file = ctx.filename.replaceAll('\\', '/');
    if (allow.some(fragment => file.includes(fragment))) return {};
    return {
      'MemberExpression[property.name="amount"]'(node) {
        if (node.computed) return;
        if (node.object.type !== 'Identifier' || node.object.name !== 'tx') return;
        // `validateAmount(tx.amount)` — the sanctioned way to reach the raw value.
        const parent = node.parent;
        if (parent?.type === 'CallExpression'
            && parent.callee.type === 'Identifier'
            && parent.callee.name === 'validateAmount'
            && parent.arguments[0] === node) return;
        // `tx.amount === undefined` and friends: a presence test reads no money.
        if (parent?.type === 'BinaryExpression'
            && (parent.operator === '===' || parent.operator === '!==')
            && (parent.right.type === 'Identifier' || parent.right.type === 'Literal')) return;
        ctx.report({ node, messageId: 'raw' });
      },
    };
  },
};

/**
 * The engine reads no wall clock and no randomness: both arrive as parameters.
 *
 * A default clock — `today = new Date()`, or a
 * `today instanceof Date ? today : new Date()` fallback — is untestable by
 * omission. A caller that forgets silently gets wall time, the answer depends
 * on when and where the process ran, and nothing says so. Three call sites in
 * this app were doing exactly that when the defaults were removed, including
 * the AI's forecast tool. It is also how a date test passes in one timezone
 * and fails in another (`npm run test:tz`).
 *
 * `new Date(y, m, d)` and `new Date(iso)` are CONSTRUCTIONS from values the
 * caller supplied, not clock reads, and stay allowed.
 */
const noAmbientClock = {
  meta: {
    type: 'problem',
    docs: { description: 'the engine takes its clock and randomness as parameters, never reads them' },
    schema: [{
      type: 'object',
      properties: { allow: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    }],
    messages: {
      clock: 'No ambient clock in the engine ({{what}}). The caller supplies "now" as a required parameter — see `requireClock` in js/engine/_constants.js, and `now()` in js/app.js.',
      random: 'No ambient randomness in the engine ({{what}}). Take an id generator as a parameter, the way `applyEnvelopeRollovers` does.',
    },
  },
  create(ctx) {
    const allow = ctx.options[0]?.allow ?? [];
    const file = ctx.filename.replaceAll('\\', '/');
    if (allow.some(fragment => file.includes(fragment))) return {};
    return {
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Date' && node.arguments.length === 0) {
          ctx.report({ node, messageId: 'clock', data: { what: 'new Date()' } });
        }
      },
      'MemberExpression[object.name="Date"][property.name="now"]'(node) {
        ctx.report({ node, messageId: 'clock', data: { what: 'Date.now()' } });
      },
      'MemberExpression[object.name="performance"][property.name="now"]'(node) {
        ctx.report({ node, messageId: 'clock', data: { what: 'performance.now()' } });
      },
      'MemberExpression[object.name="Math"][property.name="random"]'(node) {
        ctx.report({ node, messageId: 'random', data: { what: 'Math.random()' } });
      },
    };
  },
};

/**
 * An engine function that needs a clock takes it as a required parameter, and
 * throws when it is missing (`requireClock`). That is the right runtime
 * behaviour and a poor development experience on its own: page call sites are
 * outside the `checkJs` scope, so a forgotten argument is found by loading the
 * page, not by the gate. That is exactly how `computeAgeOfMoneyHistory(aomTxs)`
 * shipped and broke the dashboard.
 *
 * This closes that gap statically. Positional clocks are checked by argument
 * count; option-bag clocks by looking for the key in a literal argument. Both
 * checks are deliberately conservative — a spread, a variable, or anything
 * this cannot read is left alone, because a false positive here would push
 * someone to disable the rule.
 */
const CLOCK_AT = {
  computeEnvelopeBalanceHistory: 2,
  computeAgeOfMoney: 1,
  computeAgeOfMoneyDetailed: 1,
  computeMoneyCushion: 2,
  computeEnvelopeGoalProgress: 2,
  runMonthlyReview: 5,
  rollForwardEnvelopeBalances: 5,
  applyEnvelopeRollovers: 2,
  resolveHorizonDate: 1,
  materializeDueBudgetItems: 4,
  materializeDueTemplateFills: 4,
  forecastScheduledTransactions: 3,
  forecastAllFills: 4,
  forecastPlannedExpenses: 3,
};

// fn → [argument index, key name]
const CLOCK_KEY = {
  computeAgeOfMoneyHistory: [1, 'refDate'],
  projectEnvelopeBalance: [0, 'today'],
  findUnlinkedScheduledPayments: [0, 'today'],
  lensTransactions: [1, 'today'],
};

const clockArgumentRequired = {
  meta: {
    type: 'problem',
    docs: { description: 'pass the clock to engine functions that require one' },
    schema: [],
    messages: {
      positional: '`{{name}}` needs its clock as argument {{n}} — it throws without one. Pass `now()` from js/app.js, or the `today` this scope already has.',
      key: '`{{name}}` needs `{{key}}` in its argument object — it throws without one. Pass `now()` from js/app.js, or the `today` this scope already has.',
    },
  },
  create(ctx) {
    return {
      CallExpression(node) {
        const name = node.callee.type === 'Identifier' ? node.callee.name : null;
        if (!name) return;

        const at = CLOCK_AT[name];
        if (at !== undefined) {
          // A spread anywhere before the slot means the count says nothing.
          if (node.arguments.some(a => a.type === 'SpreadElement')) return;
          if (node.arguments.length <= at) {
            ctx.report({ node, messageId: 'positional', data: { name, n: at + 1 } });
          }
          return;
        }

        const keyed = CLOCK_KEY[name];
        if (!keyed) return;
        const [index, key] = keyed;
        const arg = node.arguments[index];
        // A missing argument is a definite miss — this is the exact shape that
        // shipped as `computeAgeOfMoneyHistory(aomTxs)` and broke the
        // dashboard's budget load.
        if (!arg) { ctx.report({ node, messageId: 'key', data: { name, key } }); return; }
        // An argument that is present but not a readable literal says nothing.
        if (arg.type !== 'ObjectExpression') return;
        if (arg.properties.some(pr => pr.type === 'SpreadElement')) return;
        const has = arg.properties.some(pr =>
          pr.type === 'Property' && !pr.computed
          && ((pr.key.type === 'Identifier' && pr.key.name === key)
            || (pr.key.type === 'Literal' && pr.key.value === key)));
        if (!has) ctx.report({ node, messageId: 'key', data: { name, key } });
      },
    };
  },
};

/**
 * A collection the browser session may write has one writer: the session.
 * Its concurrency check (state array identity, js/session/browser-session.js)
 * holds only while no legacy code saves that collection behind its back, so a
 * direct save of it in a linted file is the bug this rule exists to stop.
 *
 * Options: `{ collections: { saveAccounts: [paths...], ... } }`, the save
 * functions it bans, each with the files still allowed to reach it: paths
 * from the repo root, matched as a suffix of the linted file's path. Those
 * lists only shrink (tests/lint-collection-save.test.js).
 *
 * A "storage module" is one whose import path ends in `data.js`,
 * `storage/index.js` or `storage/{api,fsapi,guest}-adapter.js`. In a file not
 * allowed for a listed function, the rule reports:
 *   - a named import of it: `import { saveAccounts [as x] } from …`;
 *   - a re-export of it: `export { saveAccounts [as x] } from …`, and
 *     `export * from …` (once per listed function);
 *   - its use through a module namespace bound to a variable, from a static
 *     `import * as ns from …` or a dynamic `const ns = await import('…')`:
 *     `ns.saveAccounts`, `ns['saveAccounts']`, `const { saveAccounts } = ns`;
 *   - a destructured dynamic import: `const { saveAccounts } = await import('…')`.
 *
 * Known limits, all absent from js/ today: a dynamic import with a computed
 * path or consumed without a variable binding (`import('…').then(m => …)`);
 * a namespace passed on whole, or read with a computed key that is not a
 * string literal; a storage module laundered through another module's
 * re-export. A writeBatch that names the file is caught by the test, not here.
 * The configured list also names `writeJson`, which can write any one file.
 */
const STORAGE_MODULE = /(^|\/)(data|storage\/index|storage\/(api|fsapi|guest)-adapter)\.js$/;

/** The literal path of an import source node, or null when it is computed. */
function literalPath(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

/** The name a non-computed or string-literal key or member property spells, or null. */
function keyName(node, computed) {
  if (!computed && node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

/**
 * The visitor shared by the rules that ban names imported from some modules
 * (`no-direct-collection-save`, `no-page-money`). It walks every import form:
 * named import, namespace member use, named re-export, export-all, and a
 * dynamic import with a destructure or a namespace binding.
 *
 * `fromModule(path)` says whether a literal import path is a module the rule
 * watches; `check(node, name)` is called once per imported name; `exportAll(node)`
 * is called for `export * from …` of a watched module.
 */
function importWalker({ ctx, fromModule, check, exportAll }) {
  const watched = (source) => {
    const path = literalPath(source);
    return path !== null && fromModule(path);
  };
  const checkPattern = (pattern) => {
    if (pattern?.type !== 'ObjectPattern') return;
    for (const prop of pattern.properties) {
      if (prop.type === 'Property') check(prop.key, keyName(prop.key, prop.computed));
    }
  };
  /** Every use of a variable that holds a watched module's namespace. */
  const checkNamespace = (declaration) => {
    for (const variable of ctx.sourceCode.getDeclaredVariables(declaration)) {
      for (const ref of variable.references) {
        const id = ref.identifier;
        const parent = id.parent;
        if (parent.type === 'MemberExpression' && parent.object === id) {
          check(parent.property, keyName(parent.property, parent.computed));
        } else if (parent.type === 'VariableDeclarator' && parent.init === id) {
          checkPattern(parent.id);
        }
      }
    }
  };
  return {
    ImportDeclaration(node) {
      if (!watched(node.source)) return;
      for (const spec of node.specifiers) {
        if (spec.type === 'ImportSpecifier') check(spec, keyName(spec.imported, false));
        else if (spec.type === 'ImportNamespaceSpecifier') checkNamespace(spec);
      }
    },
    ExportNamedDeclaration(node) {
      if (!node.source || !watched(node.source)) return;
      for (const spec of node.specifiers) check(spec, keyName(spec.local, false));
    },
    ExportAllDeclaration(node) {
      if (watched(node.source)) exportAll(node);
    },
    ImportExpression(node) {
      if (!watched(node.source)) return;
      const awaited = node.parent.type === 'AwaitExpression' ? node.parent : node;
      const declarator = awaited.parent;
      if (declarator.type !== 'VariableDeclarator' || declarator.init !== awaited) return;
      if (declarator.id.type === 'Identifier') checkNamespace(declarator);
      else checkPattern(declarator.id);
    },
  };
}

const noDirectCollectionSave = {
  meta: {
    type: 'problem',
    docs: { description: 'a collection the session writes is saved only through session.dispatch' },
    schema: [{
      type: 'object',
      properties: {
        collections: {
          type: 'object',
          additionalProperties: { type: 'array', items: { type: 'string' } },
        },
      },
      additionalProperties: false,
    }],
    messages: {
      direct: '`{{name}}` saves a collection the session owns. Dispatch a command through `session` (js/app.js) instead; see COLLECTION_SAVE_ALLOWLIST in eslint.config.js.',
    },
  },
  create(ctx) {
    const collections = ctx.options[0]?.collections ?? {};
    const file = ctx.filename.replaceAll('\\', '/');
    const allowedHere = (allowed) => allowed.some(path => file === path || file.endsWith(`/${path}`));
    /** Report `name` at `node` when it is a listed function this file may not reach. */
    const check = (node, name) => {
      if (name === null || !Object.hasOwn(collections, name)) return;
      if (allowedHere(collections[name])) return;
      ctx.report({ node, messageId: 'direct', data: { name } });
    };
    return importWalker({
      ctx,
      fromModule: (path) => STORAGE_MODULE.test(path),
      check,
      exportAll: (node) => { for (const name of Object.keys(collections)) check(node, name); },
    });
  },
};

/**
 * A page, UI module or AI module does not compute money. It asks a core query
 * (`session.query`, js/ai/query.js), so the CLI, the AI and the pages agree.
 * This is the ratchet that keeps the computation from creeping back: it
 * reports an import of a banned engine or portfolio function in the files it is
 * configured for (js/pages, js/ui, js/ai).
 *
 * Options: `{ names, patterns, allow }`. `names` are exact banned names,
 * `patterns` are regex sources of banned names, and `allow` maps a file path
 * (from the repo root, matched as a suffix) to the banned names that file may
 * still import. The allow lists only shrink: tests/lint-page-money.test.js
 * pins a ceiling on the total number of names (it fails when the table grows)
 * and keeps each entry exact (it fails when an entry is stale or missing).
 *
 * An engine module is an import path ending in `engine.js` or
 * `engine/<module>.js`; core/portfolio.js and state/investments.js are also
 * watched. The forms reported are those of
 * `no-direct-collection-save`; `export * from` an engine module is reported
 * once, under the name `*`, unless the file's allow list holds `*`.
 *
 * Not banned: row helpers (`txAbsAmount`, predicates, constants), row
 * generators (`forecast*`), `loanRepayment` and the stress model's draft
 * helpers (js/engine/stress.js). Its money names (`annualAmount`,
 * `adjustedAnnual`, `itemsWithFlatLadder`, `stressCutFor`) are banned.
 *
 * Known limits (like `no-direct-collection-save`, a static import check):
 * - A namespace passed on whole (`useIt(eng)`) or used through a computed path
 *   (`eng[name]` with a non-literal key) is not seen; only a member read, a
 *   destructure and a literal key are.
 * - `import('…').then(m => m.computeX())` is not seen: a dynamic import is
 *   followed only when it is awaited into a variable or a destructure.
 * - Unlisted wrappers and inline arithmetic are not seen. The known portfolio
 *   helpers are watched through both core/portfolio.js and state/investments.js.
 */
const ENGINE_MODULE = /(^|\/)engine(\.js|\/[^/]+\.js)$/;
const PORTFOLIO_MODULE = /(^|\/)(core\/(portfolio|transactions-filter|effective-txs)|state\/investments)\.js$/;

const noPageMoney = {
  meta: {
    type: 'problem',
    docs: { description: 'pages, UI and AI modules read money from core queries, not engine computations' },
    schema: [{
      type: 'object',
      properties: {
        names: { type: 'array', items: { type: 'string' } },
        patterns: { type: 'array', items: { type: 'string' } },
        allow: {
          type: 'object',
          additionalProperties: { type: 'array', items: { type: 'string' } },
        },
      },
      additionalProperties: false,
    }],
    messages: {
      money: '`{{name}}` computes money in a page, UI or AI module. Read a core query instead (session.query / js/ai/query.js); see PAGE_MONEY_ALLOWLIST in eslint.config.js.',
    },
  },
  create(ctx) {
    const options = ctx.options[0] ?? {};
    const names = new Set(options.names ?? []);
    const patterns = (options.patterns ?? []).map(source => new RegExp(source));
    const allow = options.allow ?? {};
    const file = ctx.filename.replaceAll('\\', '/');
    const allowed = new Set(Object.entries(allow)
      .filter(([path]) => file === path || file.endsWith(`/${path}`))
      .flatMap(([, list]) => list));
    const check = (node, name) => {
      if (name === null || allowed.has(name)) return;
      if (name !== '*' && !names.has(name) && !patterns.some(re => re.test(name))) return;
      ctx.report({ node, messageId: 'money', data: { name } });
    };
    return importWalker({
      ctx,
      fromModule: (path) => ENGINE_MODULE.test(path) || PORTFOLIO_MODULE.test(path),
      check,
      exportAll: (node) => check(node, '*'),
    });
  },
};

export default {
  rules: {
    'no-raw-tx-amount': noRawTxAmount,
    'no-ambient-clock': noAmbientClock,
    'clock-argument-required': clockArgumentRequired,
    'no-direct-collection-save': noDirectCollectionSave,
    'no-page-money': noPageMoney,
  },
};

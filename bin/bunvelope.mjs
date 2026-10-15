#!/usr/bin/env node

import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { createBudgetStore, BudgetStoreError } from '../server/services/budget-store.js';
import { createPool, bindDb } from '../server/db.js';
import {
  PROTOCOL_VERSION, publicError, sslWarning, validateReadable,
} from './cli-support.mjs';
import { isLegacyCommand } from './cli-legacy.mjs';

// The CLI's own pool, under the same TLS rule as the server (buildSslConfig
// in server/db.js): a local database gets no TLS, any other host gets TLS
// with the certificate verified, and PGSSL or a URL sslmode overrides.
const pool = createPool();
const db = bindDb(pool);
const store = createBudgetStore(db);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseOptions(args) {
  const positional = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      throw new BudgetStoreError('bad_arguments', `--${name} requires a value`);
    }
    if (Object.hasOwn(options, name)) {
      throw new BudgetStoreError('bad_arguments', `duplicate option --${name}`);
    }
    options[name] = next;
    index += 1;
  }
  return { positional, options };
}

function requireOnly(options, allowed) {
  for (const name of Object.keys(options)) {
    if (!allowed.includes(name)) {
      throw new BudgetStoreError('bad_arguments', `unknown option --${name}`);
    }
  }
}

function requireId(options) {
  if (!options.id) throw new BudgetStoreError('bad_arguments', '--id is required');
  return options.id;
}

// --user <email|id>: scope a command to one owner. The CLI connects with
// database credentials and so can see every user's budgets; this is how an
// operator (or an agent acting for one person) keeps a command to the
// budgets that person owns.
async function resolveUser(options) {
  if (!options.user) return undefined;
  const value = String(options.user).trim();
  const { rows } = UUID_RE.test(value)
    ? await db.query('select id from users where id = $1', [value])
    : await db.query('select id from users where lower(email) = $1', [value.toLowerCase()]);
  if (!rows.length) throw new BudgetStoreError('not_found', 'user not found');
  return rows[0].id;
}

async function run(argv) {
  const { positional, options } = parseOptions(argv);
  const command = positional.join(' ');

  if (command === 'budgets list') {
    requireOnly(options, ['user']);
    const userId = await resolveUser(options);
    const budgets = await store.listBudgets({ userId });
    return {
      protocol_version: PROTOCOL_VERSION,
      budgets: budgets.map(({ id, name, version, last_opened_at, created_at, owner_email }) => ({
        id, name, version, last_opened_at, created_at, owner_email,
      })),
    };
  }

  if (command === 'budget probe') {
    requireOnly(options, ['id', 'user']);
    const userId = await resolveUser(options);
    const result = await store.probeBudget({ budgetId: requireId(options), userId });
    return {
      protocol_version: PROTOCOL_VERSION,
      budget: {
        id: result.id,
        name: result.name,
        version: result.version,
        schema_version: result.schema_version == null
          ? null : Number(result.schema_version),
        encrypted: Number(result.encrypted_count) > 0,
        blob_count: Number(result.blob_count),
      },
    };
  }

  if (command === 'budget read') {
    requireOnly(options, ['id', 'user']);
    const userId = await resolveUser(options);
    const result = await store.readBudget({
      budgetId: requireId(options), userId, touchLastOpened: false,
    });
    const { encrypted, schemaVersion } = validateReadable(result);
    return {
      protocol_version: PROTOCOL_VERSION,
      budget: {
        id: result.budgetId,
        name: result.budgetName,
        version: result.version,
        schema_version: schemaVersion,
        encrypted,
      },
      bundle: result.bundle,
    };
  }

  if (command === 'budget apply') {
    requireOnly(options, ['id', 'expected-version', 'input', 'user']);
    const budgetId = requireId(options);
    const userId = await resolveUser(options);
    if (!options.input) throw new BudgetStoreError('bad_arguments', '--input is required');
    const expectedVersion = Number(options['expected-version']);
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new BudgetStoreError('bad_arguments', '--expected-version must be a non-negative integer');
    }
    let input;
    try {
      input = JSON.parse(await readFile(options.input, 'utf8'));
    } catch {
      throw new BudgetStoreError('bad_arguments', 'input must be a readable JSON file');
    }
    if (input.protocol_version !== PROTOCOL_VERSION) {
      throw new BudgetStoreError('bad_arguments', `input protocol_version must be ${PROTOCOL_VERSION}`);
    }
    if (input.expected_version !== expectedVersion) {
      throw new BudgetStoreError('bad_arguments', 'input and argument expected versions differ');
    }
    const current = await store.readBudget({ budgetId, userId, touchLastOpened: false });
    validateReadable(current);
    // checkAccountRefs: input here comes from scripts and agents, not the
    // app, so a transaction pointing at an account that does not exist is
    // refused rather than stored for the invariant badge to find later.
    const result = await store.applyBudget({
      budgetId, userId, expectedVersion, items: input.items, checkAccountRefs: true,
    });
    return {
      protocol_version: PROTOCOL_VERSION,
      version: result.version,
      changed_kinds: result.changedKinds,
    };
  }

  throw new BudgetStoreError('bad_arguments',
    'command must be budgets list, budget probe, budget read, or budget apply');
}

const warning = sslWarning(process.env);
if (warning) process.stderr.write(`${warning}\n`);

const args = process.argv.slice(2);
try {
  if (isLegacyCommand(args)) {
    const result = await run(args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    // The generated CLI loads the core layer only when a non-protocol-1 command
    // is run, so a fault there cannot break `budget read|apply`.
    const [{ registry }, { createNodeSession }, { parseArgv, runGenerated, UsageError }] = await Promise.all([
      import('../js/core/index.js'),
      import('../server/session/node-session.js'),
      import('./cli-dispatch.mjs'),
    ]);
    // --user is resolved to an id before any session reads. A malformed
    // command line is left for runGenerated to report as a usage error.
    let userId;
    try {
      const { options } = parseArgv(args);
      if (typeof options.user === 'string') userId = await resolveUser({ user: options.user });
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
    }
    const outcome = await runGenerated({
      args,
      registry,
      readJson: async (path) => JSON.parse(await readFile(path, 'utf8')),
      openSession: ({ budget, file, policies, now }) => createNodeSession({
        policies,
        // --now fixes the clock for the whole run: every query and command,
        // and the change-log and created_at stamps of what it writes.
        ...(now ? { clock: () => new Date(now.getTime()) } : {}),
        source: file ? { kind: 'file', path: file } : { kind: 'postgres', store, budgetId: budget, userId },
      }),
    });
    if (outcome.stdout) process.stdout.write(outcome.stdout);
    if (outcome.stderr) process.stderr.write(outcome.stderr);
    process.exitCode = outcome.exitCode;
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}

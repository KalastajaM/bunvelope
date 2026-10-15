// server/session/node-session.js — the Node counterpart of BrowserSession, for
// the CLI and anything else headless. Same core pipeline, same commit checks;
// only loading and committing differ. Spec 2026-10-01 §6.3.

import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { ok, fail } from '../../js/core/result.js';
import { makeCtx } from '../../js/core/context.js';
import { runCommand, runBatch, runQuery } from '../../js/core/pipeline.js';
import { resolvePolicies } from '../../js/core/policies/index.js';
import { registry as coreRegistry } from '../../js/core/index.js';
import { applyCommitChecks } from '../../js/session/commit-checks.js';
import { appendFinancialHistory } from '../../js/core/financial-history.js';
import { changeLogEntries } from '../../js/session/audit.js';
import { appendChangeLog } from '../../js/state/change-log.js';
import { validateReadable } from './readable.js';
import { BudgetStoreError } from '../services/budget-store.js';

/**
 * Read a `--file` bundle. A missing file is `file_not_found`; one that cannot
 * be read (a directory, no permission) or is not JSON is `file_unreadable`.
 * Both name the path, so the CLI does not answer a typo with internal_error.
 * @param {string} path
 */
async function readBundleFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new BudgetStoreError('file_not_found', `bundle file not found: ${path}`, { path });
    }
    throw new BudgetStoreError('file_unreadable',
      `bundle file could not be read: ${path}${err?.code ? ` (${err.code})` : ''}`, { path });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BudgetStoreError('file_unreadable', `bundle file is not valid JSON: ${path}`, { path });
  }
}

/**
 * @param {object} args
 * @param {{ kind: 'postgres', store: any, budgetId: string, userId?: string } | { kind: 'file', path: string }} args.source
 * @param {any} [args.registry]
 * @param {string[]} [args.policies]  names active for every dispatch unless overridden per call
 * @param {() => Date} [args.clock]
 * @param {() => string} [args.newId]
 */
export function createNodeSession({ source, registry = coreRegistry, policies = [], clock = () => new Date(), newId = randomUUID }) {
  async function load() {
    if (source.kind === 'file') {
      const bundle = await readBundleFile(source.path);
      validateReadable({ bundle });
      return { data: bundle, version: null };
    }
    const result = await source.store.readBudget({ budgetId: source.budgetId, userId: source.userId, touchLastOpened: false });
    validateReadable(result);
    return { data: result.bundle, version: result.version };
  }

  async function save(data, changes, version) {
    if (source.kind === 'file') {
      const tmp = `${source.path}.tmp-${process.pid}`;
      await writeFile(tmp, `${JSON.stringify({ ...data, ...changes }, null, 2)}\n`);
      await rename(tmp, source.path);
      return { version: null };
    }
    const result = await source.store.applyBudget({
      budgetId: source.budgetId,
      userId: source.userId,
      expectedVersion: version,
      items: Object.entries(changes).map(([kind, value]) => ({ kind, data: value })),
      checkAccountRefs: true,
    });
    return { version: result.version };
  }

  const ctxFor = (data) => makeCtx({ now: clock(), newId, country: data.meta?.country ?? 'FI' });

  // `answer` (queryAfter): a dry run whose result is this, asked of the data
  // the steps produced.
  async function execute(compute, { dryRun = false, policies: names } = {}, answer) {
    for (let attempt = 0; ; attempt += 1) {
      const { data, version } = await load();
      // The budget's own policies are a floor; the call or session names add to them.
      const stored = Array.isArray(data.meta?.policies) ? data.meta.policies : [];
      const resolved = resolvePolicies([...stored, ...(names ?? policies)]);
      if (!resolved.ok) return resolved;
      const ctx = ctxFor(data);
      const r = compute(data, resolved.value, ctx);
      if (!r.ok) return r;
      if (answer) return answer(r.value.after, ctx);
      const { value, changes: proposed, diff, forced } = r.value;
      if (dryRun || Object.keys(diff).length === 0) return ok({ value, diff, forced, committed: false, version });
      // Only collections the diff says changed are written: the commit checks
      // hand back a fresh array for every collection they saw.
      const changes = Object.fromEntries(Object.entries(proposed).filter(([kind]) => diff[kind]));
      const entries = changeLogEntries(data, changes, ctx.now.toISOString());
      if (entries.length) changes.meta = appendChangeLog(changes.meta ?? data.meta, entries);
      changes.meta = { ...(changes.meta ?? data.meta), financialHistory: appendFinancialHistory(data, { ...data, ...changes }, ctx.now) };
      try {
        const saved = await save(data, changes, version);
        return ok({ value, diff, forced, committed: true, version: saved.version });
      } catch (err) {
        if (err?.code !== 'version_conflict') throw err;
        if (attempt === 0) continue;
        return fail('version_conflict', { current: err.current ?? null });
      }
    }
  }

  return {
    /** @param {string} name @param {any} input */
    async query(name, input) {
      const { data } = await load();
      return runQuery(registry, data, name, input, ctxFor(data));
    },
    /** @param {string} name @param {any} input @param {{ dryRun?: boolean, policies?: string[] }} [opts] */
    dispatch(name, input, opts = {}) {
      return execute((data, pol, ctx) => runCommand(registry, data, name, input, ctx, { policies: pol, checks: applyCommitChecks }), opts);
    },
    /** @param {{ name: string, input: any }[]} steps @param {{ dryRun?: boolean, policies?: string[] }} [opts] */
    dispatchBatch(steps, opts = {}) {
      return execute((data, pol, ctx) => runBatch(registry, data, steps, ctx, { policies: pol, checks: applyCommitChecks }), opts);
    },
    /**
     * Query `name` asked of the budget as it would be after `steps` (a dry run,
     * policies applied); a refused step returns its error. Writes nothing.
     * @param {{ name: string, input: any }[]} steps @param {string} name @param {any} input
     */
    queryAfter(steps, name, input) {
      return execute(
        (data, pol, ctx) => runBatch(registry, data, steps, ctx, { policies: pol, checks: applyCommitChecks }),
        { dryRun: true },
        (after, ctx) => runQuery(registry, after, name, input, ctx),
      );
    },
  };
}

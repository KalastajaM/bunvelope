// js/core/pipeline.js — the one path every command takes, whatever called it:
// validate the input, execute (pure), apply the session's commit checks, run
// the active policies, diff. Sessions add only loading and committing. The UI,
// the CLI and the AI therefore cannot apply different rules to the same write.

import { ok, fail } from './result.js';
import { validate } from './schema.js';
import { rowDiff } from './diff.js';

const COLLECTIONS = new Set(['meta', 'accounts', 'envelopes', 'budgetItems', 'envelopeTemplates', 'transactions']);
const passThrough = (_before, changes) => ok(changes);

function assertResult(result, name) {
  if (!result || typeof result.ok !== 'boolean') {
    throw new TypeError(`${name}: must return ok(...) or fail(...)`);
  }
}

/**
 * @param {any} registry
 * @param {Record<string, any>} data
 * @param {string} name
 * @param {any} input
 * @param {import('./context.js').Ctx} ctx
 * @param {{ policies?: any[], checks?: (before: any, changes: any, opts?: { applyAliases?: boolean }) => any }} [opts]
 */
export function runCommand(registry, data, name, input, ctx, { policies = [], checks = passThrough } = {}) {
  const entry = registry.get(name);
  if (!entry || entry.kind !== 'command') return fail('unknown_command', { name });
  const valid = validate(input, entry.input, data);
  if (!valid.ok) return valid;
  const result = entry.execute(data, valid.value, ctx);
  assertResult(result, name);
  if (!result.ok) return result;
  const { changes = {}, value = null } = result.value;
  for (const kind of Object.keys(changes)) {
    if (!COLLECTIONS.has(kind)) throw new TypeError(`${name}: unknown collection "${kind}" in changes`);
  }
  // A command that writes app-generated rows (the scheduler's, not typed
  // ones) declares payeeAliases: false so the checks leave their payees alone.
  const checked = checks(data, changes, { applyAliases: entry.payeeAliases !== false });
  if (!checked.ok) return checked;
  const after = { ...data, ...checked.value };
  /** @type {string[]} */
  const forced = [];
  for (const policy of policies) {
    const verdict = policy.check(data, after, { name, input: valid.value }, ctx);
    if (verdict?.error) return { ok: false, error: verdict.error };
    if (verdict?.forced) forced.push(...verdict.forced);
  }
  return ok({ value, changes: checked.value, after, diff: rowDiff(data, checked.value), forced });
}

/**
 * @param {any} registry
 * @param {Record<string, any>} data
 * @param {{ name: string, input: any }[]} steps
 * @param {import('./context.js').Ctx} ctx
 * @param {{ policies?: any[], checks?: (before: any, changes: any, opts?: { applyAliases?: boolean }) => any }} [opts]
 */
export function runBatch(registry, data, steps, ctx, opts = {}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return fail('bad_input', { errors: [{ path: '(batch)', message: 'needs at least one step' }] });
  }
  let current = data;
  /** @type {Record<string, any>} */
  const changes = {};
  const values = [];
  const forced = [];
  for (const [step, s] of steps.entries()) {
    const r = runCommand(registry, current, s?.name, s?.input, ctx, opts);
    if (!r.ok) return { ok: false, error: { code: r.error.code, params: { ...r.error.params, step } } };
    current = r.value.after;
    Object.assign(changes, r.value.changes);
    values.push(r.value.value);
    forced.push(...r.value.forced);
  }
  return ok({ value: values, changes, after: current, diff: rowDiff(data, changes), forced });
}

/**
 * @param {any} registry
 * @param {Record<string, any>} data
 * @param {string} name
 * @param {any} input
 * @param {import('./context.js').Ctx} ctx
 */
export function runQuery(registry, data, name, input, ctx) {
  const entry = registry.get(name);
  if (!entry || entry.kind !== 'query') return fail('unknown_query', { name });
  const valid = validate(input, entry.input, data);
  if (!valid.ok) return valid;
  const result = entry.run(data, valid.value, ctx);
  assertResult(result, name);
  return result;
}

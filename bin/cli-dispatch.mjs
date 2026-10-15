// bin/cli-dispatch.mjs — the CLI generated from the core registry. Every
// command and query is a verb (`transaction.record` → `bunvelope transaction
// record`), its flags come from its input schema, and `help` is built from the
// summaries. Kept free of process and database access so it can be tested;
// bin/bunvelope.mjs supplies the session and does the I/O.

import { cliFlags, inputFromCliOptions, kebabToCamel, camelToKebab } from '../js/core/cli-flags.js';
import { describeError } from '../js/core/errors.js';
import { t, setLang } from '../js/ui/i18n.js';
import { PROTOCOL_LEGACY, isLegacyCommand } from './cli-legacy.mjs';

export { PROTOCOL_LEGACY, isLegacyCommand };
const PROTOCOL_VERSION = 1;
const GLOBAL = new Set(['budget', 'user', 'file', 'dry-run', 'policy', 'input', 'now']);

const NOW_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NOW_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;

/**
 * The run's clock from `--now`: a `YYYY-MM-DD` is local midnight of that day,
 * an ISO date-time is that instant. Returns null for anything else, including
 * a date that does not exist (2026-02-30).
 * @param {unknown} value
 * @returns {Date | null}
 */
export function parseNow(value) {
  if (typeof value !== 'string') return null;
  const d = NOW_DATE.exec(value);
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
    const at = new Date(y, m - 1, day);
    return at.getFullYear() === y && at.getMonth() === m - 1 && at.getDate() === day ? at : null;
  }
  if (!NOW_DATETIME.test(value)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

export class UsageError extends Error {}

/** @param {string[]} args */
export function parseArgv(args) {
  const positional = [];
  /** @type {Record<string, string | true>} */
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const name = a.slice(2);
    if (!name) throw new UsageError('empty flag');
    if (Object.hasOwn(options, name)) throw new UsageError(`duplicate option --${name}`);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) options[name] = true;
    else { options[name] = next; i += 1; }
  }
  return { positional, options };
}

const verbOf = (name) => name.split('.').map(camelToKebab).join(' ');
const nameOf = (positional) => positional.map(kebabToCamel).join('.');

/** @param {any} registry @param {string[]} positional */
export function helpText(registry, positional) {
  if (positional.length === 1 && positional[0] === 'batch') {
    return [
      'bunvelope batch --budget <id> | --file <bundle.json>  --input <ops.json> [--dry-run] [--policy <name>] [--now <YYYY-MM-DD|date-time>]',
      '',
      'Runs several commands as one atomic write: all succeed, or nothing is written.',
      'ops.json: { "steps": [ { "name": "transaction.record", "input": { "type": "expense", "amount": 12.3, "account": "Amex" } } ] }',
      'Names are resolved to ids for schema-declared ref inputs (including nested objects and arrays) of each step.',
      '',
    ].join('\n');
  }
  if (positional.length) {
    const entry = registry.get(nameOf(positional));
    if (!entry) return `Unknown command: ${positional.join(' ')}\n`;
    const lines = [`bunvelope ${verbOf(entry.name)}  (${entry.kind})`, '', entry.summary, ''];
    for (const f of cliFlags(entry.input)) {
      lines.push(`  ${f.flag}${f.required ? ' (required)' : ''}  ${f.type}${f.description ? `  ${f.description}` : ''}`);
    }
    lines.push('', 'Global: --budget <id> | --file <bundle.json>, [--user <email|id>] [--dry-run] [--policy <name,...>] [--input <file.json>] [--now <YYYY-MM-DD|date-time>]');
    return `${lines.join('\n')}\n`;
  }
  const lines = ['bunvelope <command> [flags]   (bunvelope help <command> for its flags)', ''];
  for (const entry of registry.list()) lines.push(`  ${verbOf(entry.name).padEnd(28)} ${entry.kind.padEnd(8)} ${entry.summary.split('. ')[0]}`);
  lines.push('', '  batch                        command  Run several commands as one atomic write (--input {"steps":[...]})');
  lines.push('', `Protocol commands: ${PROTOCOL_LEGACY.join(', ')}`);
  return `${lines.join('\n')}\n`;
}

const out = (doc) => ({ exitCode: 0, stdout: `${JSON.stringify({ protocol_version: PROTOCOL_VERSION, ...doc })}\n` });

function errorOut(exitCode, error) {
  setLang('en');
  const message = error.code === 'bad_arguments' ? error.params.message : describeError(error, t);
  return { exitCode, stderr: `${JSON.stringify({ protocol_version: PROTOCOL_VERSION, error: { code: error.code, message, params: error.params } })}\n` };
}
const usage = (message) => errorOut(2, { code: 'bad_arguments', params: { message } });

async function resolveRefs(session, schema, input) {
  // Traverse only schema-declared references. Unknown/malformed inputs stay
  // untouched for the command validator to explain; nullable/sentinel refs
  // do not name a collection member.
  if (schema.type === 'ref' && typeof input === 'string') {
    if (schema.allow?.includes(input)) return { ok: true, value: input };
    const r = await session.query('ref.resolve', { kind: schema.kind, name: input });
    return r.ok ? { ok: true, value: r.value.id } : r;
  }
  if (schema.type === 'array' && Array.isArray(input)) {
    const value = [];
    for (const item of input) {
      const r = await resolveRefs(session, schema.items, item);
      if (!r.ok) return r;
      value.push(r.value);
    }
    return { ok: true, value };
  }
  if (schema.type === 'object' && input && typeof input === 'object' && !Array.isArray(input)) {
    const value = { ...input };
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (!Object.hasOwn(input, key)) continue;
      const r = await resolveRefs(session, sub, input[key]);
      if (!r.ok) return r;
      value[key] = r.value;
    }
    return { ok: true, value };
  }
  return { ok: true, value: input };
}

/**
 * @param {{ args: string[], registry: any, openSession: (o: any) => any, readJson: (path: string) => Promise<any> }} deps
 */
export async function runGenerated({ args, registry, openSession, readJson }) {
  let parsed;
  try { parsed = parseArgv(args); } catch (err) { return usage(err.message); }
  const { positional, options } = parsed;
  if (positional[0] === 'help' || positional.length === 0) {
    return { exitCode: 0, stdout: helpText(registry, positional.slice(1)) };
  }
  const isBatch = positional.length === 1 && positional[0] === 'batch';
  const entry = isBatch ? null : registry.get(nameOf(positional));
  if (!isBatch && !entry) return usage(`unknown command "${positional.join(' ')}"; run bunvelope help`);
  if (Boolean(options.budget) === Boolean(options.file)) return usage('give exactly one of --budget <id> or --file <bundle.json>');
  const own = Object.fromEntries(Object.entries(options).filter(([k]) => !GLOBAL.has(k)));
  if (options.input && Object.keys(own).length) return usage('--input cannot be combined with other flags');
  if (isBatch && !options.input) return usage('batch needs --input <ops.json>');

  if ('dry-run' in options && options['dry-run'] !== true) return usage('--dry-run takes no value');
  if ('policy' in options && typeof options.policy !== 'string') return usage('--policy needs a name, e.g. --policy strict-ledger');
  const now = 'now' in options ? parseNow(options.now) : undefined;
  if (now === null) return usage('--now needs a date (YYYY-MM-DD) or an ISO date-time, e.g. --now 2026-11-01');

  let input;
  if (options.input) {
    try { input = await readJson(String(options.input)); } catch { return usage('--input must be a readable JSON file'); }
  } else {
    const fromFlags = inputFromCliOptions(own, entry.input);
    if (!fromFlags.ok) return errorOut(2, fromFlags.error);
    input = fromFlags.value;
  }

  const policies = typeof options.policy === 'string' ? options.policy.split(',').map(s => s.trim()).filter(Boolean) : undefined;
  if (policies && policies.length === 0) return usage('--policy needs at least one name, e.g. --policy strict-ledger');
  const session = openSession({ budget: options.budget, user: options.user, file: options.file, policies, ...(now ? { now } : {}) });
  const dryRun = options['dry-run'] === true;

  if (isBatch) {
    const steps = [];
    for (const [step, s] of (input?.steps || []).entries()) {
      const e = registry.get(s?.name);
      if (!e || e.kind !== 'command') return errorOut(1, { code: 'unknown_command', params: { name: s?.name, step } });
      const resolved = await resolveRefs(session, e.input, s.input || {});
      if (!resolved.ok) return errorOut(1, { ...resolved.error, params: { ...resolved.error.params, step } });
      steps.push({ name: s.name, input: resolved.value });
    }
    const r = await session.dispatchBatch(steps, { dryRun });
    return r.ok ? out(r.value) : errorOut(1, r.error);
  }

  const resolved = await resolveRefs(session, entry.input, input);
  if (!resolved.ok) return errorOut(1, resolved.error);
  if (entry.kind === 'query') {
    const r = await session.query(entry.name, resolved.value);
    return r.ok ? out({ value: r.value }) : errorOut(1, r.error);
  }
  const r = await session.dispatch(entry.name, resolved.value, { dryRun });
  return r.ok ? out(r.value) : errorOut(1, r.error);
}

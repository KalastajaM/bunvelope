// js/core/cli-flags.js — a command's input schema, read as command-line flags.
// The CLI is generated from the registry: adding a property to a schema adds
// its flag and its help line, with no CLI code to write.

import { ok, fail } from './result.js';

/** @param {string} s */
export function camelToKebab(s) {
  return s.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}

/** @param {string} s */
export function kebabToCamel(s) {
  return s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** @param {any} schema */
export function cliFlags(schema) {
  const required = schema.required || [];
  return Object.entries(schema.properties || {}).map(([key, sub]) => ({
    flag: `--${camelToKebab(key)}`,
    key,
    type: sub.type ?? 'enum',
    required: required.includes(key),
    description: sub.description || (sub.enum ? `one of: ${sub.enum.join(', ')}` : ''),
  }));
}

/**
 * @param {Record<string, string | true>} options  kebab-case flag → raw value
 * @param {any} schema
 */
export function inputFromCliOptions(options, schema) {
  const props = schema.properties || {};
  const errors = [];
  /** @type {Record<string, any>} */
  const input = {};
  for (const [flag, raw] of Object.entries(options)) {
    const key = kebabToCamel(flag);
    const sub = Object.hasOwn(props, key) ? props[key] : undefined;
    const path = `--${flag}`;
    if (!sub) { errors.push({ path, message: 'is not a known flag' }); continue; }
    if (sub.type === 'boolean') {
      if (raw === true || raw === 'true') input[key] = true;
      else if (raw === 'false') input[key] = false;
      else errors.push({ path, message: 'must be true or false' });
      continue;
    }
    if (raw === true) { errors.push({ path, message: 'needs a value' }); continue; }
    // The literal `null` clears a nullable field (`--from-envelope null` = unallocated).
    if (sub.nullable && raw === 'null') { input[key] = null; continue; }
    if (sub.type === 'number' || sub.type === 'integer') {
      const n = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(n)) errors.push({ path, message: 'must be a number' });
      else input[key] = n;
      continue;
    }
    if (sub.type === 'array' || sub.type === 'object') {
      try { input[key] = JSON.parse(raw); } catch { errors.push({ path, message: 'must be JSON' }); }
      continue;
    }
    input[key] = raw;
  }
  return errors.length ? fail('bad_input', { errors }) : ok(input);
}

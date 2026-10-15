// js/core/schema.js — one input schema per command or query, in a JSON Schema
// subset plus three types of our own (money, date, ref). A node is a `type`, an
// `enum`, or an `anyOf` list of such nodes (a value that may take one of
// several shapes, such as a plan item's month: `true` or an amount). The same schema
// validates input here, becomes CLI flags (cli-flags.js), and becomes the
// AI/MCP tool input_schema (toJsonSchema). Written once, so the surfaces
// cannot disagree about what a command accepts.

import { validateAmount, parseDate } from '../utils.js';
import { ok, fail } from './result.js';
import { isoDate } from './context.js';

export const REF_COLLECTIONS = Object.freeze({
  account: 'accounts',
  envelope: 'envelopes',
  budgetItem: 'budgetItems',
  template: 'envelopeTemplates',
});

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'money', 'date', 'ref']);

/** @typedef {{ path: string, message: string }} FieldError */

/**
 * @param {any} input
 * @param {any} schema
 * @param {any} [data]  BudgetData; when given, `ref` values must exist in it
 */
export function validate(input, schema, data = null) {
  /** @type {FieldError[]} */
  const errors = [];
  const value = check(input === undefined ? {} : input, schema, '', data, errors);
  return errors.length ? fail('bad_input', { errors }) : ok(value);
}

/** Throws TypeError when a schema uses something validate() cannot check. */
export function assertSchema(schema, path = '(schema)') {
  if (!schema || typeof schema !== 'object') throw new TypeError(`${path}: schema must be an object`);
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) throw new TypeError(`${path}: anyOf needs at least one schema`);
    if (schema.type !== undefined || schema.enum !== undefined) throw new TypeError(`${path}: anyOf stands alone, without a type or enum`);
    schema.anyOf.forEach((sub, i) => assertSchema(sub, `${path}.anyOf[${i}]`));
    return;
  }
  if (schema.type === undefined) {
    if (!Array.isArray(schema.enum)) throw new TypeError(`${path}: needs a type or an enum`);
    return;
  }
  if (!TYPES.has(schema.type)) throw new TypeError(`${path}: unsupported type "${schema.type}"`);
  if (schema.type === 'ref' && !Object.hasOwn(REF_COLLECTIONS, schema.kind)) {
    throw new TypeError(`${path}: ref needs kind ${Object.keys(REF_COLLECTIONS).join('|')}`);
  }
  if (schema.allow !== undefined && (schema.type !== 'ref' || !Array.isArray(schema.allow) || !schema.allow.every(a => typeof a === 'string'))) {
    throw new TypeError(`${path}: allow is a list of strings, on a ref`);
  }
  if (schema.type === 'object') {
    for (const [key, sub] of Object.entries(schema.properties || {})) assertSchema(sub, `${path}.${key}`);
    for (const key of schema.required || []) {
      if (!Object.hasOwn(schema.properties || {}, key)) throw new TypeError(`${path}: required "${key}" is not a property`);
    }
  }
  if (schema.type === 'array') assertSchema(schema.items, `${path}[]`);
}

/** Plain JSON Schema for AI tool and MCP definitions. */
export function toJsonSchema(schema) {
  return withNullable(jsonSchemaOf(schema), schema);
}

/** `nullable` adds null to the type (or enum) the schema already exported. */
function withNullable(r, schema) {
  if (!schema.nullable) return r;
  if (Array.isArray(r.anyOf)) return { ...r, anyOf: [...r.anyOf, { type: 'null' }] };
  if (Array.isArray(r.enum)) return { ...r, enum: [...r.enum, null] };
  if (Array.isArray(r.type)) return r.type.includes('null') ? r : { ...r, type: [...r.type, 'null'] };
  if (typeof r.type === 'string') return { ...r, type: [r.type, 'null'] };
  return r;
}

function jsonSchemaOf(schema) {
  /** @type {Record<string, any>} */
  const base = {};
  if (schema.description) base.description = schema.description;
  if (schema.enum) base.enum = [...schema.enum];
  if ('default' in schema) base.default = schema.default;
  if (schema.anyOf) return { ...base, anyOf: schema.anyOf.map(toJsonSchema) };
  switch (schema.type) {
    case undefined:
      return base;
    case 'object': {
      const properties = Object.fromEntries(
        Object.entries(schema.properties || {}).map(([k, v]) => [k, toJsonSchema(v)]),
      );
      /** @type {Record<string, any>} */
      const out = { ...base, type: 'object', properties, additionalProperties: false };
      if (schema.required?.length) out.required = [...schema.required];
      return out;
    }
    case 'array':
      return { ...base, type: 'array', items: toJsonSchema(schema.items) };
    case 'money': {
      /** @type {Record<string, any>} */
      const out = { description: 'Amount: a number or a decimal string', ...base, type: ['number', 'string'] };
      if ('minimum' in schema) out.minimum = schema.minimum;
      if ('maximum' in schema) out.maximum = schema.maximum;
      return out;
    }
    case 'date':
      return { ...base, type: 'string', format: 'date' };
    case 'ref':
      return { description: schema.allow?.length ? `${schema.kind} id, or ${schema.allow.join(' | ')}` : `${schema.kind} id`, ...base, type: 'string' };
    default: {
      /** @type {Record<string, any>} */
      const out = { ...base, type: schema.type };
      if ('minimum' in schema) out.minimum = schema.minimum;
      if ('maximum' in schema) out.maximum = schema.maximum;
      return out;
    }
  }
}

function join(path, key) {
  return path ? `${path}.${key}` : key;
}

function check(v, s, path, data, errors) {
  const at = path || '(input)';
  const bad = (message) => { errors.push({ path: at, message }); return undefined; };
  if (s.anyOf) {
    // The first matching branch reads the value; otherwise preserve each
    // branch's reason in one error at the caller's path.
    const reasons = [];
    for (const sub of s.anyOf) {
      /** @type {FieldError[]} */
      const branchErrors = [];
      const r = check(v, sub, path, data, branchErrors);
      if (!branchErrors.length) return r;
      reasons.push(branchErrors.map(e => `${e.path}: ${e.message}`).join(', '));
    }
    return bad(`must match one of the allowed shapes (${reasons.join('; or ')})`);
  }
  if (s.enum && !s.enum.includes(v)) return bad(`must be one of: ${s.enum.join(', ')}`);
  switch (s.type) {
    case undefined:
      return v;
    case 'object': {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return bad('must be an object');
      const props = s.properties || {};
      const required = s.required || [];
      /** @type {Record<string, any>} */
      const out = {};
      for (const key of Object.keys(v)) {
        if (!Object.hasOwn(props, key)) errors.push({ path: join(path, key), message: 'is not a known field' });
      }
      for (const [key, sub] of Object.entries(props)) {
        const given = v[key] === null && !sub.nullable ? undefined : v[key];
        if (given === undefined) {
          if ('default' in sub) out[key] = structuredClone(sub.default);
          else if (required.includes(key)) errors.push({ path: join(path, key), message: 'is required' });
          continue;
        }
        if (given === null) { out[key] = null; continue; }
        const r = check(given, sub, join(path, key), data, errors);
        if (r !== undefined) out[key] = r;
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(v)) return bad('must be an array');
      return v.map((item, i) => check(item, s.items, `${path}[${i}]`, data, errors));
    }
    case 'string':
      return typeof v === 'string' ? v : bad('must be a string');
    case 'boolean':
      return typeof v === 'boolean' ? v : bad('must be true or false');
    case 'number':
    case 'integer': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return bad('must be a number');
      if (s.type === 'integer' && !Number.isInteger(v)) return bad('must be a whole number');
      return range(v, s, bad);
    }
    case 'money': {
      const n = validateAmount(v);
      if (n === null) return bad('must be an amount');
      return range(n, s, bad);
    }
    case 'date': {
      const d = toRealDate(v);
      if (!d) return bad('must be a real calendar date (YYYY-MM-DD)');
      return isoDate(d);
    }
    case 'ref': {
      if (typeof v !== 'string' || !v) return bad(`must be a ${s.kind} id`);
      // A literal the schema lists is a value in its own right, not an id.
      if (s.allow?.includes(v)) return v;
      if (data) {
        const rows = data[REF_COLLECTIONS[s.kind]] || [];
        if (!rows.some(r => r && r.id === v)) return bad(`no ${s.kind} with id "${v}"`);
      }
      return v;
    }
    default:
      throw new TypeError(`schema: unsupported type "${s.type}" at ${at}`);
  }
}

// parseDate rolls impossible dates over (31/02 → 3 March); a command must
// refuse them instead, so the parsed date has to read back as what was typed.
function toRealDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  const d = parseDate(s);
  if (!d || Number.isNaN(d.getTime())) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isoDate(d) === s ? d : null;
  const [dd, mm] = s.split('/').map(Number);
  return d.getDate() === dd && d.getMonth() + 1 === mm ? d : null;
}

function range(n, s, bad) {
  if ('minimum' in s && n < s.minimum) return bad(`must be at least ${s.minimum}`);
  if ('maximum' in s && n > s.maximum) return bad(`must be at most ${s.maximum}`);
  return n;
}

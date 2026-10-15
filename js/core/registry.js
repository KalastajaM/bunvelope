// js/core/registry.js — the list of everything Bunvelope can do (commands)
// and answer (queries). Every surface (UI, CLI, AI, later MCP) looks entries
// up here; none of them carries business logic of its own.

import { assertSchema } from './schema.js';

const NAME_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;

export function createRegistry() {
  /** @type {Map<string, any>} */
  const entries = new Map();

  function add(kind, def) {
    const name = def?.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw new TypeError(`registry: bad name "${name}"`);
    if (entries.has(name)) throw new TypeError(`registry: "${name}" is already registered`);
    if (typeof def.summary !== 'string' || !def.summary.trim()) throw new TypeError(`registry: "${name}" needs a summary`);
    if (!def.input || def.input.type !== 'object') throw new TypeError(`registry: "${name}" input must be an object schema`);
    assertSchema(def.input, name);
    if (def.payeeAliases !== undefined && typeof def.payeeAliases !== 'boolean') {
      throw new TypeError(`registry: "${name}" payeeAliases must be a boolean`);
    }
    if (def.internal !== undefined && typeof def.internal !== 'boolean') {
      throw new TypeError(`registry: "${name}" internal must be a boolean`);
    }
    const fn = kind === 'command' ? def.execute : def.run;
    if (typeof fn !== 'function') {
      throw new TypeError(`registry: "${name}" needs ${kind === 'command' ? 'execute' : 'run'}()`);
    }
    const entry = Object.freeze({ ...def, kind });
    entries.set(name, entry);
    return entry;
  }

  return {
    defineCommand: (def) => add('command', def),
    defineQuery: (def) => add('query', def),
    /** @param {string} name */
    get: (name) => entries.get(name) ?? null,
    /**
     * Every entry by name. `internal: true` entries (system commands) are left
     * out unless asked for, so help and the AI/MCP schemas never offer them;
     * get() still resolves them, so they stay dispatchable by name.
     * @param {{ includeInternal?: boolean }} [opts]
     */
    list: ({ includeInternal = false } = {}) => [...entries.values()]
      .filter(e => includeInternal || !e.internal)
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

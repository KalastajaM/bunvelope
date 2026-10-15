// js/core/queries/ref-resolve.js — name → id, for adapters that take human
// input. Commands only ever accept ids; a wrong or ambiguous name is an error
// here, never a silently empty reference later.

import { ok, fail } from '../result.js';
import { REF_COLLECTIONS } from '../schema.js';

const LABEL = Object.freeze({ account: 'name', envelope: 'name', budgetItem: 'description', template: 'name' });

export default {
  name: 'ref.resolve',
  summary: 'Find the id of an account, envelope, budget item or template, given its id or its name. Names match case-insensitively among non-archived entries; zero or several matches is an error listing the candidates.',
  input: {
    type: 'object',
    required: ['kind', 'name'],
    properties: {
      kind: { enum: Object.keys(REF_COLLECTIONS), description: 'What to look up' },
      name: { type: 'string', description: 'An id, or a name' },
    },
  },
  /**
   * @param {any} data
   * @param {{ kind: keyof typeof REF_COLLECTIONS, name: string }} input
   */
  run(data, { kind, name }) {
    const rows = (data[REF_COLLECTIONS[kind]] || []).filter(Boolean);
    const label = LABEL[kind];
    const byId = rows.find(r => r.id === name);
    if (byId) return ok({ id: byId.id, name: byId[label] ?? null });
    const key = name.trim().toLowerCase();
    const hits = rows.filter(r => !r.archived && typeof r[label] === 'string' && r[label].trim().toLowerCase() === key);
    if (hits.length === 1) return ok({ id: hits[0].id, name: hits[0][label] });
    if (hits.length === 0) return fail('ref_not_found', { kind, name });
    return fail('ref_ambiguous', { kind, name, candidates: hits.map(r => ({ id: r.id, name: r[label] })) });
  },
};

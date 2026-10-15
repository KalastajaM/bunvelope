// Import-local provenance. Refreshing suggestions never erases an explicit edit.
import { evaluateImportRules, importRuleContext } from '../core/import-rules.js';
import { getPayeeAliases, resolvePayeeAlias } from '../core/payee-fields.js';
const copy = x => JSON.parse(JSON.stringify(x));
export function createImportRuleDraft({ data, rows, baselines }) {
  const sources = copy(rows);
  const base = copy(baselines);
  const edits = new Map();
  let current = data;
  let result;
  const refresh = next => { current = next; result = evaluateImportRules(current, sources); };
  refresh(data);
  function view() {
    return result.rows.map(r => {
      const original = sources.find(s => s.key === r.key);
      const baseline = base[r.key] || { payee: original.payee, envelope: null };
      const values = { ...baseline };
      const provenance = {};
      const unresolved = [];
      let writePayee = baseline.payee;
      const manual = edits.get(r.key) || {};
      for (const field of ['payee', 'envelope']) {
        const suggestion = r.fields[field];
        if (suggestion?.status === 'suggested') {
          const alternative = suggestion.alternatives[0];
          values[field] = alternative.value;
          if (field === 'payee') writePayee = alternative.proposed[0];
          provenance[field] = 'rule';
        }
        if (Object.hasOwn(manual, field)) {
          values[field] = manual[field]; provenance[field] = 'manual';
          if (field === 'payee') writePayee = manual[field];
        } else if (suggestion?.status === 'conflict') unresolved.push(field);
      }
      values.payee = resolvePayeeAlias(writePayee, getPayeeAliases(current.meta));
      return { ...copy(r), source: copy(original), baseline: copy(baseline), values, writePayee, provenance, unresolved };
    });
  }
  return {
    view, refresh,
    edit(key, field, value) {
      if (!sources.some(r => r.key === key) || !['payee', 'envelope'].includes(field)) return;
      edits.set(key, { ...edits.get(key), [field]: value });
    },
    setExcluded(key, excluded) { const row = sources.find(r => r.key === key); if (row) { row.excluded = !!excluded; refresh(current); } },
    setType(key, type) { const row = sources.find(r => r.key === key); if (row) { row.type = type; refresh(current); } },
    diagnostics: () => copy(result.diagnostics),
    summary() {
      const counts = { retained: 0, changed: 0, unresolved: 0 };
      for (const r of view().filter(r => !r.excluded)) {
        counts.unresolved += r.unresolved.length;
        for (const [field, suggestion] of Object.entries(r.fields)) {
          if (r.unresolved.includes(field)) continue;
          if (suggestion.status === 'suggested' && r.values[field] === suggestion.alternatives[0].value) counts.retained++;
          else if (r.provenance[field] === 'manual') counts.changed++;
        }
      }
      return counts;
    },
    approval(next) {
      if (importRuleContext(next) !== result.context) { refresh(next); return { ok: false, reason: 'changed' }; }
      const included = view().filter(r => !r.excluded);
      if (included.some(r => r.unresolved.length)) return { ok: false, reason: 'conflicts' };
      if (included.some(r => r.values.envelope != null && !(next.envelopes || []).some(e => e.id === r.values.envelope && !e.archived))) return { ok: false, reason: 'unavailable' };
      return { ok: true, context: result.context, fieldsByKey: Object.fromEntries(included.map(r => [r.key, { payee: r.writePayee, envelope: r.values.envelope }])) };
    },
  };
}

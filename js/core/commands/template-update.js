// template.update — set an envelope template's fields as the editor sheets
// store them (applyTemplateFields). The stored template is the base, so
// top-level fields the editor does not render survive (the editor rebuilt the
// record and dropped them). A changed name must be unique (an unchanged one
// may stay a duplicate). The result must pass the editor's checks
// (checkTemplate), but only for what the update itself introduces: a stored
// template that already breaks a rule can still be edited in an unrelated
// way. An update that changes nothing is ok, with no changes.

import { ok, fail } from '../result.js';
import { TEMPLATE_FIELD_PROPERTIES, applyTemplateFields, checkTemplate, templateInputErrors } from '../entity-fields.js';
import { deepEqual } from '../diff.js';

const key = (e, tpl) => {
  const match = /^(lines|assignments)\[(\d+)\]\.envelope_id$/.exec(e.path);
  const path = match ? `${match[1]}:${tpl[match[1]]?.[Number(match[2])]?.envelope_id}` : e.path;
  return `${path}\0${e.message}`;
};
const prefixed = (errors) => errors.map(e => ({ ...e, path: `fields.${e.path}` }));

export default {
  name: 'template.update',
  summary: 'Change an envelope template\'s fields (null clears description or schedule). A changed name must be unique. lines belong to a manual template and assignments to a dynamic one; giving kind drops the other list. The schedule is replaced as given. Fields not given stay as stored.',
  input: {
    type: 'object',
    required: ['id', 'fields'],
    properties: {
      id: { type: 'ref', kind: 'template' },
      fields: { type: 'object', properties: TEMPLATE_FIELD_PROPERTIES },
    },
  },
  execute(data, input) {
    const stored = data.envelopeTemplates.find(x => x.id === input.id);
    const fields = input.fields;
    const kind = fields.kind ?? stored.kind;
    const other = kind === 'dynamic' ? 'lines' : 'assignments';
    if (Object.hasOwn(fields, other)) {
      return fail('bad_input', { errors: [{ path: `fields.${other}`, message: `is not used by a ${kind} template` }] });
    }
    const tpl = applyTemplateFields(stored, fields);
    const bad = checkTemplate(tpl, data);
    if (bad) {
      if (bad.code !== 'bad_input') return fail(bad.code, bad.params);
      // Match repeated errors by envelope identity and count, not positions:
      // inserting a valid line must neither hide nor invent a duplicate error.
      const had = new Map();
      for (const e of checkTemplate(stored, data)?.params.errors ?? []) {
        const k = key(e, stored);
        had.set(k, (had.get(k) ?? 0) + 1);
      }
      const added = bad.params.errors.filter(e => {
        const k = key(e, tpl);
        const remaining = had.get(k) ?? 0;
        if (remaining) had.set(k, remaining - 1);
        return !remaining;
      });
      if (added.length) return fail('bad_input', { errors: prefixed(templateInputErrors(added, fields)) });
    }
    if (deepEqual(tpl, stored)) return ok({ changes: {}, value: { id: stored.id } });
    return ok({
      changes: { envelopeTemplates: data.envelopeTemplates.map(x => (x.id === stored.id ? tpl : x)) },
      value: { id: stored.id },
    });
  },
};

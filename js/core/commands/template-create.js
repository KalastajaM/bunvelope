// template.create — a new envelope template. The fields are stored as the
// template editor sheets store them (applyTemplateFields), the name must be
// unique, and the result must pass the editor's checks (checkTemplate). The
// id is made from the name as the editor makes it.

import { ok, fail } from '../result.js';
import { TEMPLATE_FIELD_PROPERTIES, applyTemplateFields, checkTemplate, templateInputErrors, newTemplateId } from '../entity-fields.js';

export default {
  name: 'template.create',
  summary: 'Create an envelope template: kind manual takes lines (an amount per envelope), kind dynamic takes assignments (a percent of each envelope\'s monthly plan). The name must be unique (case-insensitive, archived templates included); one line or assignment per envelope. An optional schedule fills it on a calendar of its own. Returns { id }.',
  input: {
    type: 'object',
    required: ['name', 'kind'],
    properties: { ...TEMPLATE_FIELD_PROPERTIES },
  },
  execute(data, input) {
    const other = input.kind === 'dynamic' ? 'lines' : 'assignments';
    if (Object.hasOwn(input, other)) {
      return fail('bad_input', { errors: [{ path: other, message: `is not used by a ${input.kind} template` }] });
    }
    const id = newTemplateId(data.envelopeTemplates, typeof input.name === 'string' ? input.name.trim() : '');
    const tpl = applyTemplateFields({ id, name: '', description: null, kind: input.kind }, input);
    const bad = checkTemplate(tpl, data);
    if (bad) return fail(bad.code, bad.code === 'bad_input' ? { errors: templateInputErrors(bad.params.errors, input) } : bad.params);
    return ok({ changes: { envelopeTemplates: [...data.envelopeTemplates, tpl] }, value: { id } });
  },
};

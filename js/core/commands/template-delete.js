// template.delete — remove an envelope template. Nothing needs it: fills it
// already posted keep their from_budget key, so there is no in-use check.

import { ok } from '../result.js';

export default {
  name: 'template.delete',
  summary: 'Delete an envelope template. Fills it already posted are kept.',
  input: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'ref', kind: 'template' },
    },
  },
  execute(data, input) {
    return ok({
      changes: { envelopeTemplates: data.envelopeTemplates.filter(x => x.id !== input.id) },
      value: { id: input.id },
    });
  },
};

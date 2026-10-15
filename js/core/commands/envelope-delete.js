// envelope.delete — remove an envelope nothing references. While plan items,
// transactions or templates still use it, the delete is refused with the
// counts (archive it instead).

import { ok, fail } from '../result.js';
import { envelopeRefs } from '../entity-fields.js';

export default {
  name: 'envelope.delete',
  summary: 'Delete an envelope. Refused (in_use, with the counts) while any plan item, transaction or template still references it; archive it instead.',
  input: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'ref', kind: 'envelope' },
    },
  },
  execute(data, input) {
    const { id } = input;
    const refs = envelopeRefs(data, id);
    if (Object.values(refs).some(n => n > 0)) return fail('in_use', { kind: 'envelope', id, refs });
    return ok({ changes: { envelopes: data.envelopes.filter(e => e.id !== id) }, value: { id } });
  },
};

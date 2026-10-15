// envelope.archive — archive or unarchive an envelope. Only `archived`
// changes. Asking for the state it is already in is refused, so every success
// has a diff for Undo to reverse.

import { ok, fail } from '../result.js';

export default {
  name: 'envelope.archive',
  summary: 'Archive (archived: true) or unarchive (archived: false) an envelope. Refused when it is already in that state.',
  input: {
    type: 'object',
    required: ['id', 'archived'],
    properties: {
      id: { type: 'ref', kind: 'envelope' },
      archived: { type: 'boolean' },
    },
  },
  execute(data, input) {
    const { id, archived } = input;
    const env = data.envelopes.find(e => e.id === id);
    if (Boolean(env.archived) === archived) {
      return fail('bad_input', { errors: [{ path: 'archived', message: archived ? 'the envelope is already archived' : 'the envelope is not archived' }] });
    }
    const envelopes = data.envelopes.map(e => (e.id === id ? { ...e, archived } : e));
    return ok({ changes: { envelopes }, value: { id, archived } });
  },
};

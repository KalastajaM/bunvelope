// envelope.archiveDeleted — a system command, run on load. An older version
// marked a deleted envelope by naming it "(deleted: …)" instead of archiving
// it; this archives every such envelope that is not archived yet. With none
// to archive it changes nothing, so a second run is a no-op.

import { ok } from '../result.js';

const isLegacyDeleted = (e) => !e.archived && typeof e.name === 'string' && e.name.startsWith('(deleted:');

export default {
  name: 'envelope.archiveDeleted',
  summary: 'Archive every envelope whose name starts with "(deleted:" (an older version\'s way of deleting). Returns { archived }.',
  internal: true,
  input: { type: 'object', properties: {} },
  execute(data) {
    const archived = data.envelopes.filter(isLegacyDeleted).length;
    if (!archived) return ok({ changes: {}, value: { archived: 0 } });
    return ok({
      changes: { envelopes: data.envelopes.map(e => (isLegacyDeleted(e) ? { ...e, archived: true } : e)) },
      value: { archived },
    });
  },
};

// template.convertIncomeLinked — a system command, run on load. Moves every
// income→template link onto the template's own schedule, rewrites the posted
// fills' keys to match (convertIncomeLinkedTemplates), and clears the link.
// It changes only the collections the conversion touched; with nothing linked
// it changes nothing, so a second run is a no-op. Returns { changed, notes } so
// the caller can say what it could not convert faithfully.

import { ok } from '../result.js';
import { convertIncomeLinkedTemplates } from '../migrate-income-templates.js';

export default {
  name: 'template.convertIncomeLinked',
  summary: 'Move income-linked template calendars onto the templates\' own schedules (the one-time conversion on load). Returns { changed, notes }.',
  internal: true,
  input: { type: 'object', properties: {} },
  execute(data) {
    const out = convertIncomeLinkedTemplates({
      budgetItems: data.budgetItems,
      envelopeTemplates: data.envelopeTemplates,
      transactions: data.transactions,
      meta: data.meta,
    });
    if (!out.changed) return ok({ changes: {}, value: { changed: false, notes: [] } });
    /** @type {Record<string, any>} */
    const changes = {};
    for (const kind of ['budgetItems', 'envelopeTemplates', 'transactions', 'meta']) {
      if (out[kind] !== data[kind]) changes[kind] = out[kind];
    }
    return ok({ changes, value: { changed: true, notes: out.notes } });
  },
};

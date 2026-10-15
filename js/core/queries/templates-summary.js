// Stored-template summaries for the Templates cards, the apply sheet and CLI.
// A line total describes the template; set targets are not the actual fill's
// balance-dependent deltas. Keep missing/archived envelope lines in this
// description as before; the scheduler and allocation command filter them.

import { ok } from '../result.js';
import { refDate } from '../lens-input.js';
import { monthCountry, monthTombstones } from '../month-fields.js';
import { takenOccurrenceKeys } from '../effective-txs.js';
import { nextPendingTemplateFill } from '../template-pending.js';
import { planItemsForDynamicFill } from '../../engine/item-dates.js';
import { resolveTemplateLines } from '../../engine/monthly-review.js';
import { round2 } from '../../utils.js';

export default {
  name: 'templates.summary',
  summary: 'Stored templates in template order: id, lineCount (stored lines or dynamic assignments), resolvedLines (dynamic amounts keep running items at their full monthly average through their end month; upcoming items count their active months in the coming 12 months), total (sum of absolute line amounts, not a set-mode fill delta) and nextPending (date and occurrence monthKey, or null). Pending fills search 13 months ahead, include due-ahead bank-day shifts and omit posted, deleted and skipped occurrences. The summary retains missing/archived envelope lines; actual fills filter them. No writes.',
  input: {
    type: 'object',
    properties: {
      date: { type: 'date', description: 'Reference day for the plan and pending occurrences (YYYY-MM-DD, default today)' },
      templates: { type: 'array', items: { type: 'ref', kind: 'template' }, description: 'Template IDs to report (default all, empty array reports none)' },
    },
  },
  run(data, input, ctx) {
    const today = refDate(input, ctx);
    // The plan a dynamic template fills from, as the scheduler resolves it.
    const items = planItemsForDynamicFill(data.budgetItems || [], today);
    const wanted = input.templates ? new Set(input.templates) : null;
    const selected = (data.envelopeTemplates || []).filter(tpl => !wanted || wanted.has(tpl.id));
    const pendingCtx = {
      budgetItems: data.budgetItems || [],
      envelopes: data.envelopes || [],
      today,
      country: monthCountry(data),
      taken: takenOccurrenceKeys(data.transactions || [], monthTombstones(data)),
    };
    return ok({
      templates: selected.map(tpl => {
        const lines = resolveTemplateLines(tpl, items).filter(Boolean);
        return {
          id: tpl.id,
          lineCount: (tpl.kind === 'dynamic' ? tpl.assignments || [] : tpl.lines || []).length,
          resolvedLines: lines.map(line => ({
            envelope_id: line.envelope_id ?? null,
            mode: line.mode === 'set' ? 'set' : 'add',
            amount: round2(Number(line.amount) || 0),
          })),
          total: round2(lines.reduce((sum, line) => sum + Math.abs(Number(line.amount) || 0), 0)),
          nextPending: nextPendingTemplateFill(tpl, pendingCtx),
        };
      }),
    });
  },
};

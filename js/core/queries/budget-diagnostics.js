import { ok } from '../result.js';
import { refDate } from '../lens-input.js';
import { diagnosticAnswer, duplicateGroups, unlinkedPayments } from '../diagnostics.js';
import { runInvariantCheck, findFutureRowsOnArchived } from '../../engine/insights.js';

export default {
  name: 'budget.diagnostics',
  summary: 'Budget invariant report and cleanup discoveries. Badge count includes invariants, unlinked payments, posted-over-hand groups and archived future rows; ordinary duplicate candidates are separate.',
  input: { type: 'object', properties: {
    date: { type: 'date', description: 'As-of date (YYYY-MM-DD, default query clock)' },
  } },
  run(data, input, ctx) {
    const today = refDate(input, ctx);
    const report = runInvariantCheck(data);
    const groups = duplicateGroups(data);
    const proposals = unlinkedPayments(data, today);
    const archivedFuture = findFutureRowsOnArchived({ ...data, today });
    const extras = {
      unlinked: proposals.length,
      postedDuplicates: groups.filter(group => group.kind === 'postedOverHand').length,
      archivedFuture,
    };
    return ok(diagnosticAnswer({
      report, extras, groups, proposals,
      totalCount: report.totalProblems + extras.unlinked + extras.postedDuplicates + archivedFuture.length,
    }));
  },
};

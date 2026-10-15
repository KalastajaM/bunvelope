// js/state/initial-budget.js — the setup wizard's first save.
//
// The presence of budget-meta.json is what decides "run the wizard" versus
// "load the budget" (fileExists in load-budget.js). Saving the six files one
// by one with meta first meant a failure part-way left meta on disk and the
// rest missing, and the wizard never ran again for that folder. One batch
// publishes them together: the FSAPI adapter journals it and closes meta
// last, the cloud adapter sends a single /batch request, guest mode writes
// memory synchronously.

import {
  writeBatch,
  FILE_ENVELOPES, FILE_BUDGET_ITEMS, FILE_ACCOUNTS, FILE_TRANSACTIONS,
  FILE_ENV_TEMPLATES, FILE_META,
} from '../data.js';

export function writeInitialBudget(folderHandle, bundle) {
  return writeBatch(folderHandle, [
    { filename: FILE_ENVELOPES,     data: bundle.envelopes },
    { filename: FILE_BUDGET_ITEMS,  data: bundle.budgetItems },
    { filename: FILE_ACCOUNTS,      data: bundle.accounts },
    { filename: FILE_TRANSACTIONS,  data: bundle.transactions },
    { filename: FILE_ENV_TEMPLATES, data: bundle.envelopeTemplates },
    // Last: the marker that setup completed.
    { filename: FILE_META,          data: bundle.meta },
  ]);
}

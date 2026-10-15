// server/session/readable.js — whether a stored bundle can be used headless:
// not encrypted (there is no key outside the browser) and at the schema this
// build reads and writes. Shared by the CLI and the Node session.

import { BudgetStoreError } from '../services/budget-store.js';
import { CURRENT_SCHEMA_VERSION } from '../../js/storage/validators.js';

/** @param {{ bundle: Record<string, any> }} result */
export function validateReadable({ bundle }) {
  if (Object.values(bundle).some((value) => value?.__enc === 1)) {
    throw new BudgetStoreError(
      'encrypted_budget', 'encrypted budgets are unavailable to the headless CLI',
    );
  }
  if (bundle.meta?.financialHistory?.storage === 'history-chunks-v1') {
    throw new BudgetStoreError('unsupported_schema', 'Use a self-contained budget export; this file references separate history chunks');
  }
  const schemaVersion = bundle.meta?.schemaVersion;
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new BudgetStoreError(
      'unsupported_schema',
      `headless CLI requires schema ${CURRENT_SCHEMA_VERSION} (found ${schemaVersion ?? 'none'})`,
    );
  }
  return { encrypted: false, schemaVersion };
}

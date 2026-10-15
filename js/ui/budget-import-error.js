import { confirmDialog } from './dialog.js';
import { t } from './i18n.js';

/** Keep the current budget/picker intact and offer a fresh file selection. */
export function offerBudgetImportRetry(result) {
  const key = result.issue === 'ambiguous' ? 'ambiguous' : result.reason === 'unreadable' ? 'unreadable' : 'invalid';
  return confirmDialog(`${t('budgetImport.' + key)}\n\n${t('budgetImport.formats')}`, {
    title: t('budgetImport.title'),
    okLabel: t('budgetImport.retry'),
  });
}

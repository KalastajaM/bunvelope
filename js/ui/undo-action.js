import { describeError } from '../core/errors.js';
// js/ui/undo-action.js — the toast's Undo action for a change made through the
// session (account-edit, envelope-edit, the Transactions page's bulk tools).
// The session reverses only that change, and refuses it (undo_stale) after a
// budget switch or once a row it touched has changed since, as edit-tx's
// delete does.

import { navigate, updateStatusBar, session } from '../app.js';
import { toast } from './toast.js';
import { t } from './i18n.js';
import { reportDispatchFailure } from './save-error.js';

/**
 * @param {any} token  the `undo` of the session's ok result
 * @param {string | null} page  where to go once it is restored ('accounts', 'envelopes')
 * @param {() => void} [onRestored]  what to do once it is restored instead of navigating to `page`
 * @returns {{ label: string, onAction: () => Promise<void> }}
 */
export function undoAction(token, page, onRestored = () => navigate(page)) {
  return {
    label: t('common.undo'),
    onAction: async () => {
      let u;
      try {
        u = await session.undo(token);
      } catch (err) {
        console.error(err);
        toast(t('common.saveFailed')(err?.message || err), { assertive: true });
        return;
      }
      if (u.ok) { updateStatusBar(); toast(t('common.restored')); onRestored(); return; }
      if (u.error.code === 'undo_stale') { toast(describeError(u.error, t)); return; }
      reportDispatchFailure(u.error);
    },
  };
}

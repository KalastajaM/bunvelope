// js/ui/dirty-guard.js — track whether a form sheet has unsaved input and
// gate dismissal on a discard confirmation. Pairs with openSheet's
// `confirmClose` option:
//
//   const tracker = trackDirty(form);
//   const { close, requestClose } = openSheet({ ..., confirmClose: tracker.confirmClose });
//   cancelBtn.addEventListener('click', requestClose);
//
// Completion paths (successful submit, delete, archive) keep calling
// close(), which never consults the guard.
import { confirmDialog } from './dialog.js';
import { t } from './i18n.js';

// Pure core — `confirm` is injectable so node tests can avoid the DOM.
export function createDirtyTracker({ confirm } = {}) {
  let dirty = false;
  const ask = confirm || (() => confirmDialog(t('common.discardConfirm')));
  return {
    markDirty() { dirty = true; },
    reset() { dirty = false; },
    isDirty() { return dirty; },
    // Sheet-facing: truthy means "ok to close". Clean sheets close without
    // asking; dirty ones close only if the user confirms the discard.
    confirmClose() { return dirty ? ask() : true; },
  };
}

// Marks dirty on any 'input' or 'change' bubbling within `root` — covers
// typed edits, selects, checkboxes, and programmatic dispatches alike.
// Widgets that mutate state without emitting either event must call
// tracker.markDirty() themselves.
export function trackDirty(root, opts) {
  const tracker = createDirtyTracker(opts);
  root.addEventListener('input', tracker.markDirty);
  root.addEventListener('change', tracker.markDirty);
  return tracker;
}

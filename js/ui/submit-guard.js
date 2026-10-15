// js/ui/submit-guard.js — wrap a form submit handler so re-entrant submits
// (double-click on Save, Enter mashing) are ignored while one is in flight.
// The guard owns preventDefault, so wrapped handlers may keep their own
// call harmlessly.
export function guardSubmit(handler) {
  let busy = false;
  return async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    try {
      await handler(e);
    } finally {
      busy = false;
    }
  };
}

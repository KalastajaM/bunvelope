// js/ui/toast.js
//
// Two call shapes:
//   toast('Saved')                              — plain transient toast
//   toast('Deleted', { action: { label: 'Undo', onAction: () => … } })
//                                               — toast with a single action button.
//   toast('Save failed', { assertive: true })   — role=alert so screen readers
//                                               interrupt instead of queueing.
// The `duration` arg is still supported as the second positional param for
// back-compat with existing callers; `{ action }` may also be passed directly.
export function toast(message, optsOrDuration) {
  let duration = 2200;
  let action = null;
  let assertive = false;
  if (typeof optsOrDuration === 'number') {
    duration = optsOrDuration;
  } else if (optsOrDuration && typeof optsOrDuration === 'object') {
    if (typeof optsOrDuration.duration === 'number') duration = optsOrDuration.duration;
    if (optsOrDuration.action) action = optsOrDuration.action;
    if (optsOrDuration.assertive) assertive = true;
  }
  if (action) duration = Math.max(duration, 5000);

  const host = document.getElementById('toast-host');
  const el = document.createElement('div');
  el.className = 'toast';
  if (assertive) el.setAttribute('role', 'alert');

  const msg = document.createElement('span');
  msg.className = 'toast-msg';
  msg.textContent = message;
  el.append(msg);

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  };

  if (action && typeof action.onAction === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label || 'Undo';
    btn.addEventListener('click', () => {
      try { action.onAction(); } finally { dismiss(); }
    });
    el.append(btn);
  }

  host.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(dismiss, duration);
  return { dismiss };
}

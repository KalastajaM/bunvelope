// js/ui/sheet.js
import { t } from './i18n.js';

let sheetTitleSeq = 0;

// While any sheet is open the app shell behind it is made inert, so screen
// readers and Tab cannot wander into background content the overlay covers.
// Counter-based because sheets stack. #toast-host stays live on purpose —
// toasts must keep announcing while a sheet is open.
let openSheetCount = 0;
// Open sheets, innermost last, so Back can dismiss the top one.
const openStack = [];
function setBackgroundInert(on) {
  for (const id of ['app-root', 'statusbar', 'tweaks']) {
    const el = document.getElementById(id);
    if (el) el.inert = on;
  }
}

const FIELD_SEL = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])';
const ANY_FOCUSABLE_SEL = 'input, select, textarea, button, [tabindex]:not([tabindex="-1"])';

/** Exported for tests. */
export function pickInitialFocus(sheet, content, initialFocus) {
  const explicit = typeof initialFocus === 'function' ? initialFocus() : initialFocus;
  if (explicit && typeof explicit.focus === 'function') return explicit;
  const scope = content && typeof content.querySelectorAll === 'function' ? content : sheet;
  return firstVisible(scope, '[autofocus]')
    || firstVisible(scope, FIELD_SEL)
    || firstVisible(sheet, ANY_FOCUSABLE_SEL)
    || null;
}

// A display:none control (Edit transaction keeps its real <select> hidden
// behind a row of type buttons) cannot take focus; skipping it matters, or
// focus silently stays on <body>.
function firstVisible(scope, sel) {
  for (const el of scope.querySelectorAll(sel)) {
    if (typeof el.getClientRects !== 'function' || el.getClientRects().length > 0) return el;
  }
  return null;
}

// `confirmClose` (optional, sync or async → boolean): consulted before any
// dismissal — Escape or a requestClose() call (the path
// Cancel buttons should use). Return false to keep the sheet open — used by
// forms to guard half-filled input. Plain close() bypasses it on purpose:
// it is the path for intentional completions (successful submit, delete).
//
// `initialFocus` (optional): the element (or a function returning it) to
// focus when the sheet opens. Without it the sheet prefers an [autofocus]
// element, then the first form field in the body, and only then the first
// focusable anywhere — header actions come first in the DOM, and focusing
// Cancel on a form means the user's first keystroke goes nowhere useful.
export function openSheet({ title, content, onClose, wide = false, narrow = false, headerActions = null, confirmClose = null, initialFocus = null }) {
  const host = document.getElementById('sheet-host');
  // Stack sheets rather than replacing: an inner flow (e.g. editing a row
  // from within a reconcile sheet) must leave the outer sheet intact so it
  // reappears when the inner one closes.
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  if (wide) sheet.classList.add('sheet--wide');
  if (narrow) sheet.classList.add('sheet--narrow');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.tabIndex = -1;
  const header = document.createElement('div');
  header.className = 'sheet-header';
  const titleSpan = document.createElement('span');
  titleSpan.id = `sheet-title-${++sheetTitleSeq}`;
  titleSpan.textContent = title || '';
  header.append(titleSpan);
  if (title) sheet.setAttribute('aria-labelledby', titleSpan.id);
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'sheet-header-actions';
  header.append(actionsDiv);

  // Explicitly marked action rows move with their listeners intact. Keep
  // submit/reset buttons associated with their original form after moving.
  function setHeaderActions(actions) {
    const nodes = actions ? (Array.isArray(actions) ? actions : [actions]) : [];
    for (const node of nodes) {
      const controls = node.matches('button, input, select, textarea')
        ? [node] : node.querySelectorAll('button, input, select, textarea');
      for (const control of controls) {
        const form = control.closest('form') || (content.tagName === 'FORM' && ['submit','reset'].includes(control.type) ? content : null);
        if (form && !control.hasAttribute('form')) {
          if (!form.id) form.id = `sheet-form-${sheetTitleSeq}`;
          control.setAttribute('form', form.id);
        }
      }
    }
    actionsDiv.replaceChildren(...nodes);
    if (!nodes.length) {
      const closeButton = document.createElement('button');
      closeButton.type = 'button';
      closeButton.className = 'btn btn-ghost btn-sm';
      closeButton.textContent = t('common.close');
      closeButton.addEventListener('click', requestClose);
      actionsDiv.append(closeButton);
    }
  }
  setHeaderActions(headerActions || [...content.querySelectorAll('[data-sheet-actions]')]);
  // Native validation must expose invalid controls in collapsed editor sections.
  content.addEventListener('invalid', event => {
    let parent = event.target.parentElement;
    while (parent && parent !== content) {
      if (parent.tagName === 'DETAILS') parent.open = true;
      parent = parent.parentElement;
    }
  }, true);
  const body = document.createElement('div');
  body.className = 'sheet-body';
  body.append(content);
  sheet.append(header, body);
  overlay.append(sheet);
  // Marks this overlay as open the instant it is created, synchronously —
  // separate from the `.open` class, which only lands inside a
  // requestAnimationFrame (for the slide-in transition) and can be delayed
  // when frames are throttled (a backgrounded tab, heavy layout work). Escape
  // must close the sheet even before that frame runs, so `isTopSheet()`
  // below reads this attribute instead of `.open`.
  overlay.dataset.sheetOpen = 'true';
  host.append(overlay);

  const lastFocus = document.activeElement;

  openSheetCount++;
  if (openSheetCount === 1) setBackgroundInert(true);

  requestAnimationFrame(() => {
    // Escape (or any close) can now land before this first frame; don't
    // re-open a sheet that is already closing.
    if (closed) return;
    overlay.classList.add('open');
    // A late frame (a busy or throttled page) can land after the user has
    // already clicked into a field of this sheet; pulling the focus back
    // would send what they type next into the first field.
    if (sheet.contains(document.activeElement)) return;
    const target = pickInitialFocus(sheet, content, initialFocus);
    (target || sheet).focus();
  });

  function isTopSheet() {
    const openOverlays = host.querySelectorAll('.sheet-overlay[data-sheet-open]');
    return openOverlays[openOverlays.length - 1] === overlay;
  }

  function focusableInSheet() {
    const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), '
              + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    return [...sheet.querySelectorAll(sel)].filter(el => {
      // Skip elements that are not visible / not actually focusable.
      if (el.offsetParent === null && el !== document.activeElement) return false;
      return true;
    });
  }

  // Returns true when the sheet actually closed, false when the guard kept
  // it open (or a confirm is already pending from a mashed Escape/click).
  let confirmingClose = false;
  async function requestClose() {
    if (!confirmClose) { close(); return true; }
    if (confirmingClose) return false; // Escape mashing must not stack dialogs
    confirmingClose = true;
    try {
      const ok = await confirmClose();
      if (ok) close();
      return !!ok;
    } finally {
      confirmingClose = false;
    }
  }

  function onKeydown(e) {
    if (!isTopSheet()) return;
    if (e.key === 'Escape') { requestClose(); return; }
    if (e.key !== 'Tab') return;
    const items = focusableInSheet();
    if (items.length === 0) { e.preventDefault(); sheet.focus(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !sheet.contains(active)) { e.preventDefault(); last.focus(); }
    } else {
      if (active === last || !sheet.contains(active)) { e.preventDefault(); first.focus(); }
    }
  }

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    const at = openStack.indexOf(handle);
    if (at !== -1) openStack.splice(at, 1);
    openSheetCount = Math.max(0, openSheetCount - 1);
    if (openSheetCount === 0) setBackgroundInert(false);
    document.removeEventListener('keydown', onKeydown);
    delete overlay.dataset.sheetOpen;
    overlay.classList.remove('open');
    setTimeout(() => {
      if (overlay.parentNode === host) host.removeChild(overlay);
      if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
      if (onClose) onClose();
    }, 220);
  };

  document.addEventListener('keydown', onKeydown);

  // Outside clicks never dismiss a dialog. Closing is always explicit.
  const handle = { close, requestClose, setHeaderActions };
  openStack.push(handle);
  return handle;
}

/** Whether any sheet is open. */
export function hasOpenSheet() {
  return openStack.length > 0;
}

/**
 * Dismiss the innermost open sheet through its close guard, as Escape would.
 * Resolves true when it closed, false when the guard kept it open.
 */
export function requestCloseTopSheet() {
  const top = openStack[openStack.length - 1];
  return top ? top.requestClose() : Promise.resolve(false);
}

/**
 * Change the title of the sheet `el` sits in (the add and edit sheets name
 * the transaction type they are on).
 * @param {Element} el
 * @param {string} text
 */
export function setSheetTitle(el, text) {
  const title = el.closest('.sheet')?.querySelector('[id^="sheet-title-"]');
  if (title) title.textContent = text;
}

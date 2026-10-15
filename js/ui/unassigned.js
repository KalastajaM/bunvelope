// js/ui/unassigned.js — how an expense with no envelope shows up.
//
// Saving such an expense stays allowed (a quick entry can be sorted out
// later), but it must not look like nothing: the row renders an explicit
// "Unassigned" chip, and the add/edit forms say what will happen before the
// user saves. The explicit "No envelope (correction)" choice (`__none__`) is
// a deliberate answer and is not flagged.

import { t } from './i18n.js';

/**
 * Whether the add/edit form should show the no-envelope note.
 *
 * @param {{ type: string, amount: number, envelopeValues: string[] }} args
 *   envelopeValues — the value of each split row's envelope select
 * @returns {boolean}
 */
export function needsNoEnvelopeNote({ type, amount, envelopeValues }) {
  if (type !== 'expense') return false;
  if (!(amount > 0)) return false;
  // Several split rows are validated as a set (each needs an envelope), so
  // only the single-row case can reach the save path without one.
  if (!Array.isArray(envelopeValues) || envelopeValues.length !== 1) return false;
  return !envelopeValues[0];
}

/** The chip a transaction row shows for an expense with no envelope. */
export function unassignedChip() {
  const c = document.createElement('span');
  c.className = 'chip chip-unassigned';
  c.textContent = t('common.unassigned');
  c.title = t('common.unassignedTitle');
  return c;
}

/**
 * A gentle note for the envelope field; call `sync(show)` to toggle it.
 * @returns {{ el: HTMLElement, sync: (show: boolean) => void }}
 */
export function noEnvelopeNote() {
  const el = document.createElement('div');
  el.className = 'field-note field-note--warn';
  el.setAttribute('role', 'status');
  el.hidden = true;
  return {
    el,
    sync(show) {
      el.hidden = !show;
      el.textContent = show ? t('common.noEnvelopeHint') : '';
    },
  };
}

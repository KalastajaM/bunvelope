// js/ui/split-remainder.js — keep a split expense's lines adding up while
// the user types, shared by Add and Edit transaction.
//
// When one line's amount changes, the rest of the total goes into the line
// that is plainly waiting for it: the single empty line, or else the last
// line when the form filled it (the first line takes the whole amount, "+ Add
// envelope" pre-fills the remainder). Lowering one line used to leave the
// other one empty and Save disabled until the user did the subtraction.
// Lines the user typed are never overwritten.

import { parseAmountInput } from './amount-input.js';

/**
 * Which line absorbs the remainder when line `edited` changes, or -1.
 *
 * @param {Array<{ value: string, auto: boolean }>} lines  every line in order
 * @param {number} edited  index of the line the user changed
 * @returns {number}
 */
export function remainderTarget(lines, edited) {
  const others = lines.map((l, i) => ({ ...l, i })).filter(l => l.i !== edited);
  if (!others.length) return -1;
  const empty = others.filter(l => !String(l.value ?? '').trim());
  if (empty.length === 1) return empty[0].i;
  if (empty.length > 1) return -1;
  const last = others[others.length - 1];
  return last.auto ? last.i : -1;
}

/** Mark a split amount input as filled by the form, not typed by the user. */
export function markAutoFilled(input) {
  if (input) input.dataset.autoFilled = '1';
}

/**
 * After the user typed into `input` (one of `container`'s `.split-amt`
 * inputs): cap it at what the other lines leave of `total`, and put the rest
 * into the remainder line (`remainderTarget`). The remainder line is left
 * out of the cap, so raising one line takes from it rather than being cut.
 *
 * @param {HTMLElement} container  the split list
 * @param {HTMLInputElement} input  the line the user changed
 * @param {number} total  the transaction amount
 */
export function rebalanceSplitLines(container, input, total) {
  delete input.dataset.autoFilled;
  const inputs = [...container.querySelectorAll('.split-row .split-amt')];
  if (!(total > 0)) return;
  const edited = inputs.indexOf(input);
  const idx = inputs.length > 1
    ? remainderTarget(inputs.map(i => ({ value: i.value, auto: i.dataset.autoFilled === '1' })), edited)
    : -1;
  const target = idx >= 0 ? inputs[idx] : null;
  let otherSum = 0;
  for (const i of inputs) if (i !== input && i !== target) otherSum += parseAmountInput(i.value) || 0;
  const maxVal = Math.max(0, total - otherSum);
  if ((parseAmountInput(input.value) || 0) > maxVal + 0.005) input.value = maxVal.toFixed(2);
  if (!target) return;
  const rest = total - otherSum - (parseAmountInput(input.value) || 0);
  target.value = rest > 0.005 ? rest.toFixed(2) : '';
  markAutoFilled(target);
}

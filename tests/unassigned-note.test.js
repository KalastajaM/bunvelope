import { describe, it, expect } from 'vitest';
import { needsNoEnvelopeNote } from '../js/ui/unassigned.js';

describe('needsNoEnvelopeNote', () => {
  it('flags a single-row expense with no envelope picked', () => {
    expect(needsNoEnvelopeNote({ type: 'expense', amount: 12, envelopeValues: [''] })).toBe(true);
  });

  it('stays quiet before an amount is entered', () => {
    expect(needsNoEnvelopeNote({ type: 'expense', amount: 0, envelopeValues: [''] })).toBe(false);
    expect(needsNoEnvelopeNote({ type: 'expense', amount: NaN, envelopeValues: [''] })).toBe(false);
  });

  it('accepts an envelope or the explicit no-envelope correction', () => {
    expect(needsNoEnvelopeNote({ type: 'expense', amount: 12, envelopeValues: ['env-food'] })).toBe(false);
    expect(needsNoEnvelopeNote({ type: 'expense', amount: 12, envelopeValues: ['__none__'] })).toBe(false);
  });

  it('ignores other types and multi-row splits', () => {
    expect(needsNoEnvelopeNote({ type: 'income', amount: 12, envelopeValues: [''] })).toBe(false);
    expect(needsNoEnvelopeNote({ type: 'expense', amount: 12, envelopeValues: ['', ''] })).toBe(false);
  });
});

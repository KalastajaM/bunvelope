// tests/page-save-ratchet.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { SAVE_RATCHET_ALLOWLIST } from '../eslint.config.js';

const SAVE = /\b(saveTransactions|saveAccounts|saveEnvelopes|saveBudgetItems|saveEnvelopeTemplates|saveMeta|writeBatch)\b/;

describe('page save ratchet', () => {
  it('lists only pages that still save directly (shrink it when a page moves to the session)', () => {
    const stale = SAVE_RATCHET_ALLOWLIST.filter(path => !SAVE.test(readFileSync(path, 'utf8')));
    expect(stale, 'remove these from SAVE_RATCHET_ALLOWLIST in eslint.config.js').toEqual([]);
  });

  it('covers every page that saves directly', () => {
    const saving = readdirSync('js/pages').map(f => `js/pages/${f}`)
      .filter(p => p.endsWith('.js') && SAVE.test(readFileSync(p, 'utf8')));
    const missing = saving.filter(p => !SAVE_RATCHET_ALLOWLIST.includes(p));
    expect(missing, 'new direct saves in pages: dispatch a command through `session` instead').toEqual([]);
  });
});

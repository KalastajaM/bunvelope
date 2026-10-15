// tests/ai-consent.test.js — the consent disclosure and the conversation's
// lifetime. Both are small, and both were wrong once: the disclosure promised
// notes were stripped after the agent's read tools started sending them, and
// the conversation outlived the budget it was about.

import { describe, it, expect, beforeEach } from 'vitest';
import { getConversation, setConversation, resetAgentConversation } from '../js/ai/agent/conversation.js';
import { _DICTS_FOR_TEST } from '../js/ui/i18n.js';
import fiDict from '../js/ui/i18n/fi.js';

describe('the agent conversation', () => {
  beforeEach(() => resetAgentConversation());

  it('starts empty', () => {
    expect(getConversation()).toEqual([]);
  });

  it('round-trips messages', () => {
    setConversation([{ role: 'user', content: 'hi' }]);
    expect(getConversation()).toHaveLength(1);
  });

  it('is dropped on reset, so a new budget starts a new thread', () => {
    setConversation([{ role: 'user', content: 'about budget A' }]);
    resetAgentConversation();
    expect(getConversation()).toEqual([]);
  });

  it('tolerates being handed nothing', () => {
    setConversation(null);
    expect(getConversation()).toEqual([]);
  });
});

describe('the consent disclosure', () => {
  const dicts = { en: _DICTS_FOR_TEST.en, fi: fiDict };

  it('has a body for each mode in both locales', () => {
    for (const [lang, dict] of Object.entries(dicts)) {
      expect(dict.ai.consent.body, lang).toBeTruthy();
      expect(dict.ai.consent.bodyLocal, lang).toBeTruthy();
    }
  });

  it('no longer claims notes are stripped, because the read tools send them', () => {
    // js/ai/tools/read.js includes tx.note in query_transactions results.
    // If that ever changes back, this test should change with it — but the
    // disclosure and the behaviour must not drift apart silently again.
    expect(_DICTS_FOR_TEST.en.ai.consent.body).toMatch(/including their notes/);
    expect(_DICTS_FOR_TEST.en.ai.consent.bodyLocal).toMatch(/including their notes/);
  });

  it('tells static-mode users there is no server in the path', () => {
    expect(_DICTS_FOR_TEST.en.ai.consent.bodyLocal).toMatch(/no server in this mode/);
    expect(_DICTS_FOR_TEST.en.ai.consent.bodyLocal).toMatch(/stored in this browser/);
  });

  it('still describes the relay for cloud users', () => {
    expect(_DICTS_FOR_TEST.en.ai.consent.body).toMatch(/through this server/);
  });
});

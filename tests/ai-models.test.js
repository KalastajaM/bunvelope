// tests/ai-models.test.js — the model list and the language naming that the
// Settings picker, the relay's allowlist and the agent prompt all share.

import { describe, it, expect } from 'vitest';
import { AI_MODELS, currentModelId, languageName, AGENT_SYSTEM } from '../js/ai/intents.js';
import { clampModel, insightModelParams } from '../server/ai/prompts.js';

describe('currentModelId', () => {
  it('keeps a current model as is', () => {
    for (const id of Object.values(AI_MODELS)) expect(currentModelId(id)).toBe(id);
  });

  it('moves a saved older model to the current one of its tier', () => {
    expect(currentModelId('claude-sonnet-4-6')).toBe(AI_MODELS.sonnet);
    expect(currentModelId('claude-opus-5')).toBe(AI_MODELS.opus);
    expect(currentModelId('claude-haiku-4-5')).toBe(AI_MODELS.haiku);
  });

  it('refuses anything that is not one of ours', () => {
    expect(currentModelId('gpt-4')).toBeNull();
    expect(currentModelId('toString')).toBeNull();
    expect(currentModelId(null)).toBeNull();
    expect(clampModel('claude-fable-5-1')).toBeNull();
  });
});

describe('insightModelParams', () => {
  it('sends a temperature only to the model that accepts one', () => {
    expect(insightModelParams(AI_MODELS.haiku, { temperature: 0.2 })).toEqual({ temperature: 0.2 });
    expect(insightModelParams(AI_MODELS.sonnet, { temperature: 0.2 })).toEqual({ thinking: { type: 'between_tools' } });
    expect(insightModelParams(AI_MODELS.opus, { temperature: 0.2 })).toEqual({ output_config: { effort: 'low' } });
  });
});

describe('languageName', () => {
  it('names each app language and falls back to English', () => {
    expect(languageName('en')).toBe('English');
    expect(languageName('fi')).toBe('Finnish');
    expect(languageName('nl')).toBe('Dutch');
    expect(languageName('de')).toBe('English');
    expect(languageName(undefined)).toBe('English');
  });
});

describe('AGENT_SYSTEM language rule', () => {
  it('follows the user\'s message and falls back to the app language', () => {
    expect(AGENT_SYSTEM).toMatch(/language of the user's latest message/);
    expect(AGENT_SYSTEM).toMatch(/app language named in the\s+budget context/);
  });
});

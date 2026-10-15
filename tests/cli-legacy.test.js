// tests/cli-legacy.test.js — the protocol-1 router loads nothing from the core
// layer, so a broken core entry cannot break `budget read|apply`.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isLegacyCommand, PROTOCOL_LEGACY } from '../bin/cli-legacy.mjs';

describe('bin/cli-legacy.mjs', () => {
  it('imports nothing from js/core, js/ui or the session layer', () => {
    const src = readFileSync(new URL('../bin/cli-legacy.mjs', import.meta.url), 'utf8');
    const specifiers = [...src.matchAll(/(?:import|from)\s*\(?\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    for (const spec of specifiers) expect(spec).not.toMatch(/js\/core|js\/ui|session/);
    expect(specifiers).toEqual([]);
  });

  it('bin/bunvelope.mjs imports only the legacy router statically', () => {
    const src = readFileSync(new URL('../bin/bunvelope.mjs', import.meta.url), 'utf8');
    const statics = [...src.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
    expect(statics).toContain('./cli-legacy.mjs');
    for (const spec of statics) expect(spec).not.toMatch(/js\/core|node-session|cli-dispatch/);
  });

  it('names the four protocol-1 commands', () => {
    expect(PROTOCOL_LEGACY).toEqual(['budgets list', 'budget probe', 'budget read', 'budget apply']);
  });

  it('recognises the protocol-1 commands', () => {
    expect(isLegacyCommand(['budget', 'read', '--id', 'x'])).toBe(true);
    expect(isLegacyCommand(['budgets', 'list'])).toBe(true);
    expect(isLegacyCommand(['ref', 'resolve'])).toBe(false);
  });

  it('finds the command when flags come first, as the protocol-1 parser does', () => {
    expect(isLegacyCommand(['--id', 'x', 'budget', 'read'])).toBe(true);
    expect(isLegacyCommand(['--user', 'a@b', 'budgets', 'list'])).toBe(true);
    expect(isLegacyCommand(['--budget', 'b', 'ref', 'resolve'])).toBe(false);
  });
});

// The production image: a supported Node line, and not running as root.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const lines = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

describe('Dockerfile', () => {
  it('builds on a supported Node LTS, not end-of-life node:20', () => {
    const from = lines.find((l) => l.startsWith('FROM '));
    expect(from).toMatch(/^FROM node:24-alpine/);
  });

  it('drops to the unprivileged node user before starting the server', () => {
    const user = lines.findIndex((l) => l === 'USER node');
    const cmd = lines.findIndex((l) => l.startsWith('CMD '));
    expect(user).toBeGreaterThan(-1);
    expect(user).toBeLessThan(cmd);
    // Nothing after the switch may need root.
    expect(lines.slice(user + 1).some((l) => /^(RUN|COPY|ADD) /.test(l))).toBe(false);
  });
});

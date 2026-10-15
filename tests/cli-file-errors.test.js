// tests/cli-file-errors.test.js — the real `bin/bunvelope.mjs` given a
// `--file` it cannot use: a missing path is `file_not_found`, a directory or a
// file that is not JSON is `file_unreadable`, each naming the path, never the
// bare `internal_error` that hid a typo'd path from the owner. No Postgres.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('CLI --file errors', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bv-cli-file-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (file, ...args) => {
    const r = spawnSync(process.execPath, ['bin/bunvelope.mjs', ...args, '--file', file], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', PGSSL: 'disable' },
    });
    return { status: r.status, out: r.stdout, err: r.stderr ? JSON.parse(r.stderr) : null };
  };

  it('a missing file is file_not_found with the path', () => {
    const file = join(dir, 'no-such-bundle.json');
    const r = cli(file, 'balances');
    expect(r.status).toBe(1);
    expect(r.out).toBe('');
    expect(r.err.error.code).toBe('file_not_found');
    expect(r.err.error.message).toContain(file);
    expect(r.err.error.params).toEqual({ path: file });
  });

  it('a write command on a missing file fails the same way', () => {
    const file = join(dir, 'missing.json');
    const r = cli(file, 'transaction', 'clear', '--ids', '["x"]');
    expect(r.err.error.code).toBe('file_not_found');
  });

  it('a directory is file_unreadable', () => {
    const r = cli(dir, 'balances');
    expect(r.status).toBe(1);
    expect(r.err.error.code).toBe('file_unreadable');
    expect(r.err.error.params).toEqual({ path: dir });
  });

  it('a file that is not JSON is file_unreadable', () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{ not json');
    const r = cli(file, 'balances');
    expect(r.err.error.code).toBe('file_unreadable');
    expect(r.err.error.message).toContain('not valid JSON');
    expect(r.err.error.message).toContain(file);
  });
});

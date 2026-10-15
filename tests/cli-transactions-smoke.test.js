// tests/cli-transactions-smoke.test.js — the real `bin/bunvelope.mjs` process
// over a bundle file: record, reverse and delete a transaction, asserting the
// JSON it prints and the file it leaves behind after each step. No Postgres.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CURRENT_SCHEMA_VERSION } from '../js/storage/validators.js';

describe('CLI transaction commands over a bundle file', () => {
  let dir; let file;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bv-cli-smoke-'));
    file = join(dir, 'bundle.json');
    writeFileSync(file, JSON.stringify({
      meta: { schemaVersion: CURRENT_SCHEMA_VERSION, country: 'FI' },
      accounts: [{ id: 'amex', name: 'Amex', type: 'checking' }],
      envelopes: [{ id: 'groceries', name: 'Groceries' }],
      budgetItems: [], envelopeTemplates: [], transactions: [],
    }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (...args) => {
    const r = spawnSync(process.execPath, ['bin/bunvelope.mjs', ...args, '--file', file], {
      cwd: process.cwd(), encoding: 'utf8',
      // The CLI builds a pool at start-up; a file bundle never connects to it.
      env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', PGSSL: 'disable' },
    });
    return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: parseStderr(r.stderr) };
  };
  // stderr is the CLI's JSON error, but a Node warning or a crash's stack trace
  // is plain text; keep that readable in the failure message instead of
  // throwing a SyntaxError that hides it.
  const parseStderr = (text) => {
    if (!text) return null;
    try { return JSON.parse(text); } catch { return { raw: text }; }
  };
  const saved = () => JSON.parse(readFileSync(file, 'utf8'));

  it('records by name, reverses, then deletes, each step visible in the file', () => {
    const rec = cli('transaction', 'record', '--type', 'expense', '--amount', '12.30', '--date', '2026-10-01',
      '--payee', 'Market', '--account', 'Amex', '--envelope', 'Groceries');
    expect(rec.status, JSON.stringify(rec.err)).toBe(0);
    expect(rec.out.committed).toBe(true);
    const row = rec.out.value;
    expect(row).toMatchObject({ type: 'expense', amount: 12.3, account: 'amex', envelope_id: 'groceries', date: '2026-10-01', payee: 'Market' });
    expect(saved().transactions).toEqual([row]);

    const rev = cli('transaction', 'reverse', '--id', row.id);
    expect(rev.status, JSON.stringify(rev.err)).toBe(0);
    const [mirror] = rev.out.value.reversal;
    expect(mirror).toMatchObject({ type: 'income', amount: 12.3, account: 'amex', envelope_id: 'groceries', reverses: row.id });
    const afterReverse = saved().transactions;
    expect(afterReverse).toHaveLength(2);
    expect(afterReverse.find(t => t.id === row.id).reversed_by).toBe(mirror.id);

    const again = cli('transaction', 'reverse', '--id', row.id);
    expect(again.status).toBe(1);
    expect(again.err.error.code).toBe('already_reversed');

    const del = cli('transaction', 'delete', '--ids', JSON.stringify([row.id, mirror.id]));
    expect(del.status, JSON.stringify(del.err)).toBe(0);
    expect(del.out.value).toMatchObject({ deleted: 2 });
    expect(saved().transactions).toEqual([]);
    // Deletes are logged in the same write.
    expect(saved().meta.change_log.map(e => e.op)).toEqual(['delete', 'delete']);
  });

  it('imports several rows from one --rows JSON array, in one write', () => {
    // Refs inside rows are ids: the CLI resolves names for top-level flags only.
    const rows = [
      { type: 'expense', amount: 4.5, date: '2026-10-01', payee: 'Cafe', account: 'amex', envelope: 'groceries', source: 'csv' },
      { type: 'income', amount: 100, date: '2026-10-02', payee: 'Salary', account: 'amex' },
    ];
    const r = cli('transaction', 'import', '--rows', JSON.stringify(rows));
    expect(r.status, JSON.stringify(r.err)).toBe(0);
    expect(r.out.committed).toBe(true);
    expect(r.out.value.rows).toHaveLength(2);
    expect(saved().transactions).toEqual(r.out.value.rows);
    expect(saved().transactions.map(t => t.payee)).toEqual(['Cafe', 'Salary']);
    expect(saved().transactions[0]).toMatchObject({ amount: 4.5, account: 'amex', envelope_id: 'groceries', source: 'csv' });

    const bad = cli('transaction', 'import', '--rows', JSON.stringify([rows[0], { type: 'expense', amount: 1 }]));
    expect(bad.status).toBe(1);
    expect(bad.err.error.code).toBe('field_required');
    expect(bad.err.error.params.row).toBe(1);
    expect(saved().transactions).toHaveLength(2);
  });

  it('--dry-run leaves the file alone', () => {
    const before = readFileSync(file, 'utf8');
    const r = cli('transaction', 'record', '--type', 'expense', '--amount', '5', '--account', 'Amex', '--dry-run');
    expect(r.status).toBe(0);
    expect(r.out.committed).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

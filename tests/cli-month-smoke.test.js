// tests/cli-month-smoke.test.js — the real `bin/bunvelope.mjs` process running
// month.start and allocation.fill over a bundle file: a dry run shows rows and
// writes nothing, the real run writes them, a repeat posts nothing, and a
// manual fill lands. No Postgres.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CURRENT_SCHEMA_VERSION } from '../js/storage/validators.js';

const ALL_MONTHS = { Jan: true, Feb: true, Mar: true, Apr: true, May: true, Jun: true, Jul: true, Aug: true, Sep: true, Oct: true, Nov: true, Dec: true };

describe('CLI month and fill commands over a bundle file', () => {
  let dir; let file;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bv-cli-month-'));
    file = join(dir, 'bundle.json');
    writeFileSync(file, JSON.stringify({
      meta: { schemaVersion: CURRENT_SCHEMA_VERSION, country: 'FI' },
      accounts: [{ id: 'chk', name: 'Checking', type: 'checking' }],
      envelopes: [
        { id: 'rent', name: 'Rent' },
        { id: 'groceries', name: 'Groceries', rollover: 'zero-monthly' },
      ],
      budgetItems: [{
        id: 'rent', kind: 'expense', description: 'Rent', envelope_id: 'rent', account_id: 'chk',
        as_schedule: true, as_schedule_since: '2026-10-01', monthly_schedule: ALL_MONTHS,
        default_amount: -100, payment_day: 5, schedule_day_type: 'exact', include: true,
      }],
      envelopeTemplates: [],
      // A September surplus the zero-monthly envelope sweeps on rollover.
      transactions: [{ id: 't0', type: 'envelope_transfer', date: '2026-09-10', status: 'posted', amount: 50, from_envelope_id: null, to_envelope_id: 'groceries' }],
    }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cli = (...args) => {
    const r = spawnSync(process.execPath, ['bin/bunvelope.mjs', ...args, '--file', file], {
      cwd: process.cwd(), encoding: 'utf8',
      // The CLI builds a pool at start-up; a file bundle never connects to it.
      env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', PGSSL: 'disable' },
    });
    return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr ? JSON.parse(r.stderr) : null };
  };
  const saved = () => JSON.parse(readFileSync(file, 'utf8'));

  it('month start: dry run writes nothing, the run writes, a repeat posts nothing; a fill then lands', () => {
    const before = readFileSync(file, 'utf8');
    const dry = cli('month', 'start', '--date', '2026-10-10', '--dry-run');
    expect(dry.status, JSON.stringify(dry.err)).toBe(0);
    expect(dry.out.committed).toBe(false);
    expect(dry.out.value).toMatchObject({ adjusted: 1, posted: 1 });
    expect(dry.out.value.rows.map(r => r.from_budget)).toEqual(['rollover:groceries:2026-09', 'rent:2026-10']);
    expect(readFileSync(file, 'utf8')).toBe(before);

    const run = cli('month', 'start', '--date', '2026-10-10');
    expect(run.status, JSON.stringify(run.err)).toBe(0);
    expect(run.out.committed).toBe(true);
    expect(run.out.value).toMatchObject({ adjusted: 1, posted: 1 });
    const afterRun = saved().transactions;
    expect(afterRun).toHaveLength(3);
    expect(afterRun.filter(t => t.from_budget)).toHaveLength(2);

    const again = cli('month', 'start', '--date', '2026-10-10');
    expect(again.status, JSON.stringify(again.err)).toBe(0);
    expect(again.out.value).toMatchObject({ adjusted: 0, posted: 0, rows: [] });
    expect(saved().transactions).toEqual(afterRun);

    // null for a nullable flag moves from unallocated.
    const move = cli('envelope', 'move', '--from-envelope', 'null', '--to-envelope', 'groceries', '--amount', '5', '--date', '2026-10-10');
    expect(move.status, JSON.stringify(move.err)).toBe(0);
    expect(move.out.value).toMatchObject({ type: 'envelope_transfer', from_envelope_id: null, to_envelope_id: 'groceries', amount: 5 });

    // A ref nested inside an array input is given as an id, not a name.
    const fill = cli('allocation', 'fill', '--lines', JSON.stringify([{ envelope: 'groceries', amount: 50 }]), '--date', '2026-10-10');
    expect(fill.status, JSON.stringify(fill.err)).toBe(0);
    expect(fill.out.value).toMatchObject({ type: 'fill' });
    const fills = saved().transactions.filter(t => t.type === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0].lines).toEqual([{ envelope_id: 'groceries', mode: 'add', amount: 50 }]);
  });
});

// tests/cli-config-smoke.test.js — the real `bin/bunvelope.mjs` process running
// the account and envelope commands over a bundle file: create, update (an
// object input is a JSON flag), reorder (an array input too), a delete the
// registry refuses while a transaction uses the account, archive, and `help`
// listing them without the internal system command. Then the plan-item and
// template commands, a template fill that skips its month, and `help` hiding
// their internal load-time commands. No Postgres.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CURRENT_SCHEMA_VERSION } from '../js/storage/validators.js';

describe('CLI account and envelope commands over a bundle file', () => {
  let dir; let file;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bv-cli-config-'));
    file = join(dir, 'bundle.json');
    writeFileSync(file, JSON.stringify({
      meta: { schemaVersion: CURRENT_SCHEMA_VERSION, country: 'FI' },
      accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 100 }],
      envelopes: [{ id: 'rent', name: 'Rent', category: 'Home', archived: false }],
      budgetItems: [],
      envelopeTemplates: [],
      transactions: [{ id: 't1', type: 'expense', date: '2026-09-10', status: 'posted', amount: 10, account: 'chk', envelope: 'rent' }],
    }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args) => spawnSync(process.execPath, ['bin/bunvelope.mjs', ...args], {
    cwd: process.cwd(), encoding: 'utf8',
    // The CLI builds a pool at start-up; a file bundle never connects to it.
    env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', PGSSL: 'disable' },
  });
  const cli = (...args) => {
    const r = run([...args, '--file', file]);
    return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr ? JSON.parse(r.stderr) : null };
  };
  const saved = () => JSON.parse(readFileSync(file, 'utf8'));

  it('creates, updates, reorders and refuses to delete an account in use', () => {
    const created = cli('account', 'create', '--name', 'Savings', '--type', 'bank');
    expect(created.status, JSON.stringify(created.err)).toBe(0);
    expect(created.out.value).toEqual({ id: 'savings' });
    expect(saved().accounts.map(a => a.id)).toEqual(['chk', 'savings']);

    // `fields` is an object input, so it is one JSON flag, not flattened flags.
    // A top-level ref (`--id`) takes a name as well as an id.
    const update = cli('account', 'update', '--id', 'Savings', '--fields', '{"favorite":true}');
    expect(update.status, JSON.stringify(update.err)).toBe(0);
    expect(saved().accounts.find(a => a.id === 'savings')).toMatchObject({ name: 'Savings', favorite: true });

    // `ids` is an array input: JSON too.
    const reorder = cli('account', 'reorder', '--ids', '["savings","chk"]');
    expect(reorder.status, JSON.stringify(reorder.err)).toBe(0);
    expect(saved().accounts.map(a => a.id)).toEqual(['savings', 'chk']);

    const before = readFileSync(file, 'utf8');
    const del = cli('account', 'delete', '--id', 'chk');
    expect(del.status).toBe(1);
    expect(del.err.error.code).toBe('in_use');
    expect(del.err.error.params).toMatchObject({ kind: 'account', id: 'chk' });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('creates and archives an envelope', () => {
    const created = cli('envelope', 'create', '--name', 'Fuel', '--category', 'Car');
    expect(created.status, JSON.stringify(created.err)).toBe(0);
    expect(created.out.value).toEqual({ id: 'car-fuel' });

    const archived = cli('envelope', 'archive', '--id', 'car-fuel', '--archived', 'true');
    expect(archived.status, JSON.stringify(archived.err)).toBe(0);
    expect(saved().envelopes.find(e => e.id === 'car-fuel')).toMatchObject({ name: 'Fuel', archived: true });
  });

  it('help lists the account and envelope commands, not the internal archive-deleted', () => {
    const r = run(['help']);
    expect(r.status).toBe(0);
    for (const verb of ['account create', 'account update', 'account reorder', 'account delete', 'envelope create', 'envelope archive']) {
      expect(r.stdout, verb).toMatch(new RegExp(`^\\s+${verb}\\s`, 'm'));
    }
    expect(r.stdout).not.toContain('archive-deleted');
  });
});

describe('CLI plan-item and template commands over a bundle file', () => {
  let dir; let file;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bv-cli-plan-'));
    file = join(dir, 'bundle.json');
    writeFileSync(file, JSON.stringify({
      meta: { schemaVersion: CURRENT_SCHEMA_VERSION, country: 'FI' },
      accounts: [{ id: 'chk', name: 'Checking', type: 'bank', initialBalance: 1000 }],
      envelopes: [{ id: 'rent', name: 'Rent', category: 'Home', archived: false }],
      budgetItems: [],
      envelopeTemplates: [],
      transactions: [],
    }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args) => spawnSync(process.execPath, ['bin/bunvelope.mjs', ...args], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', PGSSL: 'disable' },
  });
  const cli = (...args) => {
    const r = run([...args, '--file', file]);
    return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr ? JSON.parse(r.stderr) : null };
  };
  const saved = () => JSON.parse(readFileSync(file, 'utf8'));
  const ok = (r) => expect(r.status, JSON.stringify(r.err)).toBe(0);

  it('creates, updates, skips an occurrence of and deletes a plan item', () => {
    // An expense amount is stored negative whatever sign it is given.
    const created = cli('budget-item', 'create', '--kind', 'expense', '--envelope_id', 'rent',
      '--description', 'Rent', '--default_amount', '900', '--payment_day', '1');
    ok(created);
    expect(created.out.value).toEqual({ id: 'rent-item' });
    expect(saved().budgetItems).toEqual([expect.objectContaining({ id: 'rent-item', kind: 'expense', envelope_id: 'rent', default_amount: -900 })]);

    ok(cli('budget-item', 'update', '--id', 'rent-item', '--fields', '{"default_amount":950,"description":"Flat"}'));
    expect(saved().budgetItems[0]).toMatchObject({ default_amount: -950, description: 'Flat' });

    ok(cli('budget-item', 'skip-occurrence', '--id', 'rent-item', '--month', '2026-11'));
    expect(saved().budgetItems[0].skipped_occurrences).toEqual(['2026-11']);

    ok(cli('budget-item', 'delete', '--id', 'rent-item'));
    expect(saved().budgetItems).toEqual([]);
  });

  it('creates and updates a template, fills from it skipping its month, and deletes it', () => {
    const schedule = { enabled: true, payment_day: 1, day_type: 'exact', since: '2026-01-01', months: { Sep: true, Oct: true } };
    const created = cli('template', 'create', '--name', 'Start of month', '--kind', 'manual',
      '--lines', '[{"envelope_id":"rent","mode":"add","amount":100}]', '--schedule', JSON.stringify(schedule));
    ok(created);
    expect(created.out.value).toEqual({ id: 'start-of-month' });

    ok(cli('template', 'update', '--id', 'Start of month', '--fields', '{"description":"Payday split"}'));
    expect(saved().envelopeTemplates[0]).toMatchObject({ name: 'Start of month', description: 'Payday split' });

    // The fill and the skipped month land in one write.
    ok(cli('allocation', 'fill', '--template', 'start-of-month', '--date', '2026-09-01', '--skip-template-month', 'true'));
    const after = saved();
    expect(after.transactions).toEqual([expect.objectContaining({ type: 'fill', template_id: 'start-of-month', from_budget: 'tpl:start-of-month:2026-09' })]);
    expect(after.envelopeTemplates[0].schedule.skipped).toEqual(['2026-09']);

    ok(cli('template', 'delete', '--id', 'start-of-month'));
    expect(saved().envelopeTemplates).toEqual([]);
    // The fill it already posted is kept.
    expect(saved().transactions).toHaveLength(1);
  });

  it('help lists the plan-item and template commands, not the internal load-time ones', () => {
    const r = run(['help']);
    expect(r.status).toBe(0);
    for (const verb of ['budget-item create', 'budget-item update', 'budget-item delete', 'budget-item skip-occurrence',
      'template create', 'template update', 'template delete', 'allocation fill']) {
      expect(r.stdout, verb).toMatch(new RegExp(`^\\s+${verb}\\s`, 'm'));
    }
    expect(r.stdout).not.toContain('loan-upkeep');
    expect(r.stdout).not.toContain('convert-income-linked');
  });
});

describe('CLI settings, payee and investment commands over a bundle file', () => {
  let dir; let file;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bv-cli-meta-'));
    file = join(dir, 'bundle.json');
    // These commands are meta-primary, so the fixture carries schemaVersion.
    writeFileSync(file, JSON.stringify({
      meta: { schemaVersion: CURRENT_SCHEMA_VERSION, country: 'FI', reopened_months: ['2026-08'] },
      accounts: [{ id: 'brk', name: 'Broker', type: 'investment', initialBalance: 0 }],
      envelopes: [],
      budgetItems: [],
      envelopeTemplates: [],
      transactions: [
        { id: 't1', type: 'expense', date: '2026-09-10', status: 'posted', amount: 10, account: 'brk', payee: 'Shell Oy' },
        { id: 't2', type: 'expense', date: '2026-09-11', status: 'posted', amount: 12, account: 'brk', payee: 'Shell' },
        { id: 't3', type: 'investment_transfer', date: '2026-09-12', status: 'posted', amount: 50, account: 'brk', symbol: 'ABC', payee: 'Broker' },
        { id: 't4', type: 'investment_transfer', date: '2026-09-13', status: 'posted', amount: 20, account: 'brk', payee: 'Broker' },
      ],
    }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args) => spawnSync(process.execPath, ['bin/bunvelope.mjs', ...args], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none', PGSSL: 'disable' },
  });
  const cli = (...args) => {
    const r = run([...args, '--file', file]);
    return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr ? JSON.parse(r.stderr) : null };
  };
  const saved = () => JSON.parse(readFileSync(file, 'utf8'));
  const ok = (r) => expect(r.status, JSON.stringify(r.err)).toBe(0);

  it('updates settings from a JSON fields object and refuses a key off the whitelist', () => {
    ok(cli('settings', 'update', '--fields', '{"country":"SE"}'));
    expect(saved().meta.country).toBe('SE');

    const before = readFileSync(file, 'utf8');
    const bad = cli('settings', 'update', '--fields', '{"name":"Nope"}');
    expect(bad.status).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('closes, reopens and clears the reopen exception of a month', () => {
    ok(cli('month', 'close', '--month', '2026-09'));
    expect(saved().meta.closed_months).toContain('2026-09');

    ok(cli('month', 'reopen', '--month', '2026-09'));
    expect(saved().meta.closed_months ?? []).not.toContain('2026-09');

    // Dropping an exception removes it without closing the month by hand.
    ok(cli('month', 'clear-reopen', '--month', '2026-08'));
    expect(saved().meta.reopened_months ?? []).not.toContain('2026-08');
    expect(saved().meta.closed_months ?? []).not.toContain('2026-08');
  });

  it('merges payee spellings in one write, keeping the old spelling as an alias', () => {
    const merged = cli('payee', 'merge', '--from', '["shell oy"]', '--from-names', '["Shell Oy"]', '--to', 'Shell');
    ok(merged);
    expect(merged.out.value).toMatchObject({ changed: 1, to: 'Shell' });
    const after = saved();
    expect(after.transactions.find(t => t.id === 't1').payee).toBe('Shell');
    expect(after.meta.payeeAliases).toEqual({ 'shell oy': 'Shell' });
  });

  it('sets a price, tags rows, maps a payee, and renames a symbol across rows and prices', () => {
    ok(cli('investment', 'set-price', '--symbol', 'abc', '--price', '12.5', '--as-of', '2026-09-30'));
    expect(saved().meta.investments.prices.ABC).toMatchObject({ price: 12.5, asOf: '2026-09-30' });

    ok(cli('investment', 'tag-symbol', '--ids', '["t4"]', '--symbol', 'abc'));
    expect(saved().transactions.find(t => t.id === 't4').symbol).toBe('ABC');

    // The rule and the rows it tags are one commit.
    ok(cli('investment', 'set-payee-rule', '--payee', 'Shell', '--symbol', 'xyz', '--apply-to', '["t2"]'));
    expect(saved().meta.investments.payeeRules.shell).toBe('XYZ');
    expect(saved().transactions.find(t => t.id === 't2').symbol).toBe('XYZ');

    ok(cli('investment', 'rename-symbol', '--from', 'ABC', '--to', 'ABD'));
    const after = saved();
    expect(after.transactions.filter(t => t.symbol === 'ABD').map(t => t.id).sort()).toEqual(['t3', 't4']);
    expect(after.meta.investments.prices.ABD.price).toBe(12.5);
    expect(after.meta.investments.prices.ABC).toBeUndefined();
  });

  it('help lists the settings, month, payee and investment commands', () => {
    const r = run(['help']);
    expect(r.status).toBe(0);
    for (const verb of ['settings update', 'month close', 'month reopen', 'month clear-reopen', 'payee merge', 'payee alias',
      'payee unalias', 'payee hide', 'payee unhide', 'investment set-price', 'investment set-holding', 'investment remove-holding',
      'investment add-manual-row', 'investment update-manual-row', 'investment remove-manual-row', 'investment set-payee-rule',
      'investment tag-symbol', 'investment rename-symbol']) {
      expect(r.stdout, verb).toMatch(new RegExp(`^\\s+${verb}\\s`, 'm'));
    }
  });
});

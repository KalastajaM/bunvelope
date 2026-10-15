// `npm run restore` against a fake store: argument parsing, refusing files
// that are not backups, the dry run writing nothing, restoring as a new
// budget or --into an existing one, and the encrypted-backup key rule
// checked before any write. Plus createBudget's cap logic on a fake client.

import { describe, it, expect } from 'vitest';
import {
  parseRestoreArgs, readBackupDoc, runRestore, resolveBackupFile, restoreErrorOutput,
} from '../scripts/restore-lib.mjs';
import { createBudgetStore, BudgetStoreError } from '../server/services/budget-store.js';

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const NEW_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_ID = '55555555-5555-4555-8555-555555555555';
const CIPHER = { __enc: 1, kid: 'k1', iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAA==' };
const NOW = new Date('2026-09-28T10:00:00Z');

function backupMeta(overrides = {}) {
  return {
    format: 'bunvelope-backup',
    format_version: 1,
    created_at: '2026-09-24T03:15:00.000Z',
    budget: {
      id: SOURCE_ID, name: 'Family', version: 12,
      owner_email: 'owner@example.com', created_at: '2026-01-01T00:00:00.000Z',
    },
    encrypted: false,
    ...overrides,
  };
}

function plainDoc(overrides = {}) {
  return {
    envelopes: [{ id: 'food', name: 'Food' }, { id: 'rent', name: 'Rent' }],
    budgetItems: [],
    transactions: [],
    accounts: [{ id: 'bank', name: 'Bank', type: 'bank' }],
    envelopeTemplates: [],
    meta: { schemaVersion: 8, currency: 'EUR' },
    _backup: backupMeta(),
    ...overrides,
  };
}

function encDoc(kid = 'k1') {
  const blob = { ...CIPHER, kid };
  return {
    envelopes: blob, budgetItems: blob, transactions: blob, accounts: blob,
    envelopeTemplates: blob, meta: blob,
    _backup: backupMeta({
      encrypted: true,
      encryption: { enabled: true, salt: 'c2FsdHNhbHQ=', verifier: { keyId: kid } },
    }),
  };
}

// Incomplete encryption: readBudget fills a missing blob with plaintext [],
// so a backup can mix ciphertext with plaintext collections.
function mixedDoc(kid = 'k1') {
  return { ...encDoc(kid), envelopeTemplates: [] };
}

const text = (doc) => JSON.stringify(doc);

const EMAILS = { [OWNER_ID]: 'owner@example.com', [OTHER_ID]: 'other@example.com' };

// The --into target (TARGET_ID) belongs to `targetOwner`, by default the
// backup's own owner. listBudgets returns `budgetCount` rows for a user,
// the target among them when that user owns it.
function fakeStore({
  budgetCount = 0, targetVersion = 5, conflictOnApply = false, targetOwner = OWNER_ID, createError = null,
} = {}) {
  const calls = { created: [], applied: [], probed: [] };
  return {
    calls,
    async listBudgets({ userId } = {}) {
      const rows = Array.from({ length: budgetCount }, (_, i) => ({
        id: `b${i}`, user_id: userId, owner_email: EMAILS[userId],
      }));
      if (userId === targetOwner) {
        const target = { id: TARGET_ID, user_id: targetOwner, owner_email: EMAILS[targetOwner] };
        if (rows.length) rows[0] = target; else rows.push(target);
      }
      return rows;
    },
    async probeBudget({ budgetId }) {
      calls.probed.push(budgetId);
      if (budgetId !== TARGET_ID) throw new BudgetStoreError('not_found', 'budget not found');
      return {
        id: TARGET_ID, name: 'Current', version: targetVersion, user_id: targetOwner,
        blob_count: 6, encrypted_count: 0,
      };
    },
    // Created and written in one transaction, as the real store does: an
    // error means nothing was created.
    async createBudget(args) {
      calls.created.push(args);
      if (createError) throw createError;
      return {
        id: NEW_ID, name: args.name, version: args.items ? 1 : 0,
        ...(args.items ? { changedKinds: args.items.map((i) => i.kind) } : {}),
      };
    },
    async applyBudget(args) {
      calls.applied.push(args);
      if (conflictOnApply) {
        throw new BudgetStoreError('version_conflict', 'version conflict', { current: args.expectedVersion + 1 });
      }
      return { version: args.expectedVersion + 1, changedKinds: args.items.map((i) => i.kind) };
    },
  };
}

const users = {
  'owner@example.com': { id: OWNER_ID },
  'other@example.com': { id: OTHER_ID },
};
const getUserByEmail = async (email) => users[String(email).toLowerCase()] ?? null;
const noEncryption = async () => ({ enabled: false, keyId: null });
const keyK1 = async () => ({ enabled: true, keyId: 'k1' });

function run(opts) {
  return runRestore({
    getUserByEmail, getEncryption: noEncryption, now: NOW, maxPerUser: 50, yes: false, ...opts,
  });
}

describe('parseRestoreArgs', () => {
  it('requires --file and defaults to a dry run', () => {
    expect(parseRestoreArgs(['--file', 'b.json']))
      .toEqual({ file: 'b.json', yes: false, allowOtherOwner: false });
    expect(() => parseRestoreArgs([])).toThrow(/--file is required/);
  });

  it('takes --yes, --into, --owner and --name', () => {
    expect(parseRestoreArgs(['--file', 'b.json', '--yes'])).toMatchObject({ yes: true });
    expect(parseRestoreArgs(['--file', 'b.json', '--into', TARGET_ID]))
      .toEqual({ file: 'b.json', into: TARGET_ID, yes: false, allowOtherOwner: false });
    expect(parseRestoreArgs(['--file', 'b.json', '--owner', 'a@b.c', '--name', 'Old']))
      .toEqual({ file: 'b.json', owner: 'a@b.c', name: 'Old', yes: false, allowOtherOwner: false });
  });

  it('takes --allow-other-owner only with --into', () => {
    expect(parseRestoreArgs(['--file', 'b.json', '--into', TARGET_ID, '--allow-other-owner']))
      .toMatchObject({ into: TARGET_ID, allowOtherOwner: true });
    expect(() => parseRestoreArgs(['--file', 'b.json', '--allow-other-owner']))
      .toThrow(/--allow-other-owner only applies with --into/);
  });

  it('refuses an empty value rather than falling back to the default', () => {
    for (const name of ['file', 'into', 'owner', 'name']) {
      const argv = name === 'file' ? ['--file', ''] : ['--file', 'b.json', `--${name}`, ''];
      expect(() => parseRestoreArgs(argv)).toThrow(new RegExp(`--${name} requires a value`));
    }
    expect(() => parseRestoreArgs(['--file', '  '])).toThrow(/--file requires a value/);
  });

  it('refuses --into combined with --owner or --name', () => {
    expect(() => parseRestoreArgs(['--file', 'b.json', '--into', TARGET_ID, '--owner', 'a@b.c']))
      .toThrow(/--into/);
    expect(() => parseRestoreArgs(['--file', 'b.json', '--into', TARGET_ID, '--name', 'x']))
      .toThrow(/--into/);
  });

  it('refuses unknown flags, stray words, missing values and duplicates', () => {
    expect(() => parseRestoreArgs(['--file', 'b.json', '--force'])).toThrow(/unknown option --force/);
    expect(() => parseRestoreArgs(['--file', 'b.json', 'extra'])).toThrow(/unexpected argument/);
    expect(() => parseRestoreArgs(['--file'])).toThrow(/--file requires a value/);
    expect(() => parseRestoreArgs(['--file', 'b.json', '--into', '--yes'])).toThrow(/--into requires a value/);
    expect(() => parseRestoreArgs(['--file', 'a', '--file', 'b'])).toThrow(/duplicate option --file/);
    expect(() => parseRestoreArgs(['--file', 'b.json', '--yes', '--yes'])).toThrow(/duplicate option --yes/);
  });

  it('throws bad_arguments carrying the usage line', () => {
    try {
      parseRestoreArgs([]);
      throw new Error('did not throw');
    } catch (error) {
      expect(error.code).toBe('bad_arguments');
      expect(error.message).toMatch(/usage: npm run restore -- --file/);
    }
  });
});

describe('readBackupDoc', () => {
  it('reads a plaintext backup', () => {
    const doc = readBackupDoc(text(plainDoc()));
    expect(doc.encrypted).toBe(false);
    expect(doc.keyIds.size).toBe(0);
    expect(doc.meta.budget.name).toBe('Family');
    expect(doc.bundle.envelopes).toHaveLength(2);
    expect(doc.bundle._backup).toBeUndefined();
  });

  it('reads an encrypted backup and collects its key ids', () => {
    const doc = readBackupDoc(text(encDoc('k1')));
    expect(doc.encrypted).toBe(true);
    expect([...doc.keyIds]).toEqual(['k1']);
  });

  it('refuses what is not a backup', () => {
    expect(() => readBackupDoc('not json')).toThrow(expect.objectContaining({ code: 'not_a_backup' }));
    expect(() => readBackupDoc('[]')).toThrow(expect.objectContaining({ code: 'not_a_backup' }));
    const { _backup: _dropped, ...bare } = plainDoc();
    expect(() => readBackupDoc(text(bare))).toThrow(expect.objectContaining({ code: 'not_a_backup' }));
    expect(() => readBackupDoc(text(plainDoc({ _backup: backupMeta({ format: 'other' }) }))))
      .toThrow(expect.objectContaining({ code: 'not_a_backup' }));
  });

  it('refuses an unsupported format version', () => {
    expect(() => readBackupDoc(text(plainDoc({ _backup: backupMeta({ format_version: 2 }) }))))
      .toThrow(expect.objectContaining({ code: 'unsupported_format_version' }));
  });

  it('refuses a collection that fails validation, naming it', () => {
    expect(() => readBackupDoc(text(plainDoc({ envelopes: 'nope' }))))
      .toThrow(expect.objectContaining({ code: 'validation_failed', message: expect.stringMatching(/envelopes/) }));
    expect(() => readBackupDoc(text(plainDoc({ meta: { __enc: 1, iv: 'x', ct: 'y' } }))))
      .toThrow(expect.objectContaining({ code: 'validation_failed', message: expect.stringMatching(/meta/) }));
  });

  it('reads a mixed backup (incomplete encryption) as encrypted', () => {
    const doc = readBackupDoc(text(mixedDoc()));
    expect(doc.encrypted).toBe(true);
    expect(doc.bundle.envelopeTemplates).toEqual([]);
  });

  it('warns about unknown top-level keys', () => {
    expect(readBackupDoc(text(plainDoc())).warnings).toEqual([]);
    const doc = readBackupDoc(text(plainDoc({ version: 12, payees: [] })));
    expect(doc.warnings).toEqual([expect.stringMatching(/unknown top-level keys ignored: version, payees/)]);
  });

  it('refuses a backup with no collections', () => {
    expect(() => readBackupDoc(text({ _backup: backupMeta(), meta: null })))
      .toThrow(expect.objectContaining({ code: 'empty_backup' }));
  });
});

describe('resolveBackupFile', () => {
  it('resolves relative to the invoking directory and expands ~/', () => {
    expect(resolveBackupFile('b.json', { cwd: '/work/dir', home: '/Users/me' })).toBe('/work/dir/b.json');
    expect(resolveBackupFile('~/Bunvelope-backups/b.json', { cwd: '/work', home: '/Users/me' }))
      .toBe('/Users/me/Bunvelope-backups/b.json');
    expect(resolveBackupFile('/abs/b.json', { cwd: '/work', home: '/Users/me' })).toBe('/abs/b.json');
  });
});

describe('runRestore: dry run', () => {
  it('writes nothing and reports the plan for a new budget', async () => {
    const store = fakeStore({ budgetCount: 3 });
    const summary = await run({ store, doc: readBackupDoc(text(plainDoc())) });
    expect(store.calls.created).toEqual([]);
    expect(store.calls.applied).toEqual([]);
    expect(summary).toMatchObject({
      ok: true,
      dry_run: true,
      mode: 'new',
      target: { id: null, name: 'Family (restored 2026-09-28)', version: null },
      owner: { email: 'owner@example.com', budgets: 3, max_budgets: 50 },
      encrypted: false,
      collections: {
        envelopes: 2, budgetItems: 0, transactions: 0, accounts: 1,
        envelopeTemplates: 0, meta: 'present',
      },
      backup: {
        id: SOURCE_ID, name: 'Family', version: 12, created_at: '2026-09-24T03:15:00.000Z',
        owner_email: 'owner@example.com',
      },
      warnings: [],
    });
  });

  it('reports the target version for --into, and encrypted collections as "encrypted"', async () => {
    const store = fakeStore({ targetVersion: 8 });
    const summary = await run({
      store, getEncryption: keyK1, doc: readBackupDoc(text(encDoc('k1'))), into: TARGET_ID,
    });
    expect(store.calls.applied).toEqual([]);
    expect(summary).toMatchObject({
      dry_run: true,
      mode: 'into',
      target: { id: TARGET_ID, name: 'Current', version: 8 },
      owner: { email: 'owner@example.com' },
      backup: { owner_email: 'owner@example.com' },
      encrypted: true,
      encryption: { key_id_match: true },
      collections: { envelopes: 'encrypted', meta: 'encrypted' },
    });
  });

  it('never includes blob contents', async () => {
    const summary = await run({ store: fakeStore(), doc: readBackupDoc(text(plainDoc())) });
    const out = JSON.stringify(summary);
    expect(out).not.toMatch(/Food|Rent|EUR/);
    const enc = await run({
      store: fakeStore(), getEncryption: keyK1, doc: readBackupDoc(text(encDoc('k1'))),
    });
    expect(JSON.stringify(enc)).not.toContain(CIPHER.ct);
  });

  it('uses --owner and --name when given', async () => {
    const summary = await run({
      store: fakeStore(), doc: readBackupDoc(text(plainDoc())), owner: 'Other@Example.com', name: 'Old copy',
    });
    expect(summary.owner.email).toBe('Other@Example.com');
    expect(summary.backup.owner_email).toBe('owner@example.com');
    expect(summary.target.name).toBe('Old copy');
  });

  it('carries the unknown-key warnings into the plan', async () => {
    const summary = await run({ store: fakeStore(), doc: readBackupDoc(text(plainDoc({ payees: [] }))) });
    expect(summary.warnings).toEqual([expect.stringMatching(/payees/)]);
  });
});

describe('runRestore: writing', () => {
  it('as-new creates a budget for the owner and applies every collection at its version', async () => {
    const store = fakeStore();
    const summary = await run({ store, doc: readBackupDoc(text(plainDoc())), yes: true });
    // One call creates and writes; nothing goes through applyBudget.
    expect(store.calls.applied).toEqual([]);
    expect(store.calls.created).toHaveLength(1);
    const [apply] = store.calls.created;
    expect(apply).toMatchObject({
      userId: OWNER_ID, name: 'Family (restored 2026-09-28)', maxPerUser: 50, decrypting: false,
    });
    expect(apply.items.map((i) => i.kind)).toEqual([
      'envelopes', 'budgetItems', 'transactions', 'accounts', 'envelopeTemplates', 'meta',
    ]);
    expect(apply.items[0].data).toEqual(plainDoc().envelopes);
    expect(summary).toMatchObject({
      ok: true, dry_run: false, mode: 'new',
      target: { id: NEW_ID, name: 'Family (restored 2026-09-28)', version: 1 },
      changed_kinds: ['envelopes', 'budgetItems', 'transactions', 'accounts', 'envelopeTemplates', 'meta'],
    });
  });

  it('applies only the collections present', async () => {
    const store = fakeStore();
    const doc = plainDoc({ meta: null });
    delete doc.budgetItems;
    await run({ store, doc: readBackupDoc(text(doc)), yes: true });
    expect(store.calls.created[0].items.map((i) => i.kind))
      .toEqual(['envelopes', 'transactions', 'accounts', 'envelopeTemplates']);
  });

  it('--into applies with the probed version', async () => {
    const store = fakeStore({ targetVersion: 8 });
    const summary = await run({
      store, doc: readBackupDoc(text(plainDoc())), into: TARGET_ID, yes: true,
    });
    expect(store.calls.created).toEqual([]);
    expect(store.calls.applied[0]).toMatchObject({ budgetId: TARGET_ID, expectedVersion: 8 });
    expect(summary.target).toMatchObject({ id: TARGET_ID, version: 9 });
  });

  it('--into another owner\'s budget applies with --allow-other-owner, showing both owners', async () => {
    const store = fakeStore({ targetOwner: OTHER_ID });
    const summary = await run({
      store, doc: readBackupDoc(text(plainDoc())), into: TARGET_ID, allowOtherOwner: true, yes: true,
    });
    expect(store.calls.applied[0]).toMatchObject({ budgetId: TARGET_ID, userId: OTHER_ID });
    expect(summary).toMatchObject({
      owner: { email: 'other@example.com' }, backup: { owner_email: 'owner@example.com' },
    });
  });

  it('--into surfaces version_conflict', async () => {
    const store = fakeStore({ targetVersion: 8, conflictOnApply: true });
    await expect(run({ store, doc: readBackupDoc(text(plainDoc())), into: TARGET_ID, yes: true }))
      .rejects.toMatchObject({ code: 'version_conflict', current: 9 });
  });

  it('--into an unknown budget is not_found', async () => {
    await expect(run({
      store: fakeStore(), doc: readBackupDoc(text(plainDoc())), into: NEW_ID,
    })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('restores an encrypted backup when the account has the same key id', async () => {
    const store = fakeStore();
    const summary = await run({
      store, getEncryption: keyK1, doc: readBackupDoc(text(encDoc('k1'))), yes: true,
    });
    expect(store.calls.created[0]).toMatchObject({ decrypting: false });
    expect(store.calls.created[0].items[0].data).toEqual(CIPHER);
    expect(summary).toMatchObject({ ok: true, encrypted: true, encryption: { key_id_match: true } });
  });
});

describe('runRestore: a failed write', () => {
  it('reports the error as is: the create and the write are one transaction', async () => {
    for (const createError of [
      Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }),
      new BudgetStoreError('encryption_conflict', 'Encryption configuration changed; reload before saving'),
    ]) {
      const store = fakeStore({ createError });
      const error = await run({ store, doc: readBackupDoc(text(plainDoc())), yes: true })
        .then(() => null, (e) => e);
      expect(store.calls.applied).toEqual([]);
      const out = restoreErrorOutput(error);
      expect(out).not.toHaveProperty('left_empty_budget_id');
      expect(out.error.code).toBe(createError instanceof BudgetStoreError ? 'encryption_conflict' : 'internal_error');
    }
  });

  it('prints only the public error', () => {
    const out = restoreErrorOutput(new BudgetStoreError('not_found', 'budget not found'));
    expect(out).toEqual({
      ok: false, protocol_version: 1, error: { code: 'not_found', message: 'budget not found' },
    });
  });
});

describe('runRestore: refusals before any write', () => {
  async function refuses(opts, code) {
    const store = opts.store ?? fakeStore();
    for (const yes of [false, true]) {
      await expect(run({ ...opts, store, yes })).rejects.toMatchObject({ code });
    }
    expect(store.calls.created).toEqual([]);
    expect(store.calls.applied).toEqual([]);
  }

  it('encrypted backup, different key id', async () => {
    await refuses({ getEncryption: keyK1, doc: readBackupDoc(text(encDoc('k2'))) }, 'encryption_key_mismatch');
  });

  it('encrypted backup, account without encryption', async () => {
    await refuses({ doc: readBackupDoc(text(encDoc('k1'))) }, 'encryption_key_mismatch');
    await refuses({ getEncryption: async () => null, doc: readBackupDoc(text(encDoc('k1'))) }, 'encryption_key_mismatch');
  });

  it('encrypted backup, --into a budget whose owner has another key', async () => {
    await refuses({
      getEncryption: keyK1, doc: readBackupDoc(text(encDoc('k2'))), into: TARGET_ID,
    }, 'encryption_key_mismatch');
  });

  it('plaintext backup into an account with encryption on', async () => {
    await refuses({ getEncryption: keyK1, doc: readBackupDoc(text(plainDoc())) }, 'encryption_conflict');
  });

  it('mixed backup (ciphertext + plaintext) into an account with the matching key', async () => {
    await refuses({ getEncryption: keyK1, doc: readBackupDoc(text(mixedDoc('k1'))) }, 'encryption_conflict');
    await refuses({
      getEncryption: keyK1, doc: readBackupDoc(text(mixedDoc('k1'))), into: TARGET_ID,
    }, 'encryption_conflict');
  });

  it('mixed backup into an account without encryption', async () => {
    await refuses({ doc: readBackupDoc(text(mixedDoc('k1'))) }, 'encryption_key_mismatch');
  });

  it('ciphertext with no key id, saying so', async () => {
    const blob = { __enc: 1, iv: CIPHER.iv, ct: CIPHER.ct };
    const doc = { ...encDoc('k1'), meta: blob };
    await refuses({ getEncryption: keyK1, doc: readBackupDoc(text(doc)) }, 'encryption_key_mismatch');
    await expect(run({ store: fakeStore(), getEncryption: keyK1, doc: readBackupDoc(text(doc)) }))
      .rejects.toThrow(/encrypted blob has no key id; cannot verify it matches this account/);
  });

  it('--into a budget owned by someone other than the backup\'s owner', async () => {
    await refuses({
      store: fakeStore({ targetOwner: OTHER_ID }), doc: readBackupDoc(text(plainDoc())), into: TARGET_ID,
    }, 'owner_mismatch');
  });

  it('--into when the backup names no owner', async () => {
    const doc = plainDoc({ _backup: backupMeta({ budget: { ...backupMeta().budget, owner_email: null } }) });
    await refuses({ doc: readBackupDoc(text(doc)), into: TARGET_ID }, 'owner_mismatch');
  });

  it('owner at the budget cap', async () => {
    await refuses({ store: fakeStore({ budgetCount: 50 }), doc: readBackupDoc(text(plainDoc())) }, 'budget_limit');
  });

  it('owner not found', async () => {
    await refuses({ doc: readBackupDoc(text(plainDoc())), owner: 'nobody@example.com' }, 'owner_not_found');
  });

  it('no owner in the backup and none given', async () => {
    const doc = plainDoc({ _backup: backupMeta({ budget: { ...backupMeta().budget, owner_email: null } }) });
    await refuses({ doc: readBackupDoc(text(doc)) }, 'bad_arguments');
  });

  it('a --name that is too long', async () => {
    await refuses({ doc: readBackupDoc(text(plainDoc())), name: 'n'.repeat(201) }, 'bad_arguments');
  });
});

describe('runRestore: default name', () => {
  it('shortens a long backup name so the suffix fits the 200-character limit', async () => {
    const doc = plainDoc({ _backup: backupMeta({ budget: { ...backupMeta().budget, name: 'x'.repeat(200) } }) });
    const summary = await run({ store: fakeStore(), doc: readBackupDoc(text(doc)) });
    expect(summary.target.name.length).toBe(200);
    expect(summary.target.name.endsWith(' (restored 2026-09-28)')).toBe(true);
  });
});

// createBudget on a fake client: the same lock-count-insert sequence as
// POST /budgets. The SQL itself is covered live in budget-store.test.js.
function fakeDb({ existing = 0, userExists = true } = {}) {
  const log = [];
  const client = {
    async query(sql, params) {
      log.push(sql.replace(/\s+/g, ' ').trim());
      if (/from users where id = \$1 for update/.test(sql)) {
        return { rows: userExists ? [{ id: params[0] }] : [] };
      }
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: existing }] };
      if (/insert into budgets/.test(sql)) {
        return { rows: [{ id: NEW_ID, name: params[1], version: 0 }] };
      }
      if (/from users where id = \$1 for share/.test(sql)) {
        return { rows: [{ encryption_enabled: false }] };
      }
      if (/insert into budget_blobs/.test(sql)) return { rows: [] };
      if (/update budgets set version/.test(sql)) return { rows: [{ version: 1 }] };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
  return {
    log,
    query: client.query,
    withTx: async (fn) => fn(client),
  };
}

describe('createBudget', () => {
  it('locks the owner, counts, then inserts', async () => {
    const db = fakeDb({ existing: 2 });
    const store = createBudgetStore(db);
    const out = await store.createBudget({ userId: OWNER_ID, name: '  Family  ', maxPerUser: 3 });
    expect(out).toEqual({ id: NEW_ID, name: 'Family', version: 0 });
    expect(db.log[0]).toMatch(/for update/);
    expect(db.log[1]).toMatch(/count/);
    expect(db.log[2]).toMatch(/insert into budgets/);
  });

  it('with items, writes them after the insert, inside the same transaction', async () => {
    const db = fakeDb();
    let transactions = 0;
    const withTx = db.withTx;
    db.withTx = async (fn) => { transactions += 1; return withTx(fn); };
    const out = await createBudgetStore(db).createBudget({
      userId: OWNER_ID, name: 'x', maxPerUser: 3,
      items: [{ kind: 'envelopes', data: [] }, { kind: 'meta', data: { schemaVersion: 8 } }],
    });
    expect(transactions).toBe(1);
    expect(out).toMatchObject({ id: NEW_ID, version: 1, changedKinds: ['envelopes', 'meta'] });
    const order = db.log.map((sql) => (/insert into budgets/.test(sql) ? 'budget'
      : /insert into budget_blobs/.test(sql) ? 'blob' : /update budgets/.test(sql) ? 'bump' : null))
      .filter(Boolean);
    expect(order).toEqual(['budget', 'blob', 'blob', 'bump']);
  });

  it('validates items before opening a transaction', async () => {
    const db = fakeDb();
    await expect(createBudgetStore(db).createBudget({
      userId: OWNER_ID, name: 'x', maxPerUser: 3, items: [{ kind: 'nope', data: [] }],
    })).rejects.toMatchObject({ code: 'validation_failed' });
    expect(db.log).toEqual([]);
  });

  it('refuses at the cap without inserting', async () => {
    const db = fakeDb({ existing: 3 });
    await expect(createBudgetStore(db).createBudget({ userId: OWNER_ID, name: 'x', maxPerUser: 3 }))
      .rejects.toMatchObject({ code: 'budget_limit', max: 3 });
    expect(db.log.some((sql) => /insert/.test(sql))).toBe(false);
  });

  it('refuses an empty or overlong name, and an unknown user', async () => {
    const store = createBudgetStore(fakeDb());
    await expect(store.createBudget({ userId: OWNER_ID, name: '  ', maxPerUser: 3 }))
      .rejects.toMatchObject({ code: 'bad_arguments' });
    await expect(store.createBudget({ userId: OWNER_ID, name: 'n'.repeat(201), maxPerUser: 3 }))
      .rejects.toMatchObject({ code: 'bad_arguments' });
    await expect(store.createBudget({ userId: 'nope', name: 'x', maxPerUser: 3 }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(createBudgetStore(fakeDb({ userExists: false }))
      .createBudget({ userId: OWNER_ID, name: 'x', maxPerUser: 3 }))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});

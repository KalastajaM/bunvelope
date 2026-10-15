import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const BASE_URL = process.env.ROUTES_TEST_DATABASE_URL
  || process.env.MIGRATION_TEST_DATABASE_URL;
const ADMIN_URL = process.env.BUDGET_TEST_ADMIN_URL || BASE_URL;
const describeIf = BASE_URL ? describe : describe.skip;
const DB_NAME = 'bunvelope_store_test';

function withDbName(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

describeIf('budget store (live Postgres)', () => {
  let db;
  let pool;
  let store;
  let userA;
  let userB;
  let budgetId;

  beforeAll(async () => {
    const pgMod = await import('pg');
    const { Client } = pgMod.default;
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${DB_NAME} with (force)`);
    const owner = new URL(BASE_URL).username;
    if (!/^[a-z_][a-z0-9_]*$/i.test(owner)) throw new Error('unsafe test database owner');
    await admin.query(`create database ${DB_NAME} owner ${owner}`);
    await admin.end();

    process.env.DATABASE_URL = withDbName(BASE_URL, DB_NAME);
    process.env.PGSSL = 'disable';
    db = await import('../server/db.js');
    pool = db.pool;
    await db.runMigrations({ log: () => {} });

    const seedUser = async (email) => (await db.query(
      `insert into users (email, google_sub, name)
       values ($1, $2, $3) returning id`,
      [email, `sub-${email}`, email],
    )).rows[0].id;
    userA = await seedUser('store-a@example.com');
    userB = await seedUser('store-b@example.com');
    budgetId = (await db.query(
      `insert into budgets (user_id, name, version)
       values ($1, 'Family', 4) returning id`,
      [userA],
    )).rows[0].id;

    const blobs = {
      envelopes: [{ id: 'food', name: 'Food' }],
      budget_items: [],
      transactions: [],
      accounts: [{ id: 'bank', name: 'Bank', type: 'bank' }],
      envelope_templates: [],
      meta: { schemaVersion: 8, currency: 'EUR' },
    };
    for (const [kind, data] of Object.entries(blobs)) {
      await db.query(
        `insert into budget_blobs (budget_id, kind, data)
         values ($1, $2, $3::jsonb)`,
        [budgetId, kind, JSON.stringify(data)],
      );
    }

    const { createBudgetStore } = await import('../server/services/budget-store.js');
    store = createBudgetStore({ query: db.query, withTx: db.withTx });
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
  });

  it('reads all six blobs at one version without touching last_opened_at', async () => {
    const before = (await db.query(
      'select last_opened_at from budgets where id = $1', [budgetId],
    )).rows[0].last_opened_at;
    const result = await store.readBudget({
      budgetId, userId: userA, touchLastOpened: false,
    });
    expect(result).toMatchObject({ budgetId, budgetName: 'Family', version: 4 });
    expect(Object.keys(result.bundle).sort()).toEqual([
      'accounts', 'budgetItems', 'envelopeTemplates',
      'envelopes', 'meta', 'transactions',
    ]);
    const after = (await db.query(
      'select last_opened_at from budgets where id = $1', [budgetId],
    )).rows[0].last_opened_at;
    expect(after).toEqual(before);
  });

  it('scopes reads to the authenticated owner', async () => {
    await expect(store.readBudget({ budgetId, userId: userB }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('applies multiple collections atomically with one version increment', async () => {
    const result = await store.applyBudget({
      budgetId,
      userId: userA,
      expectedVersion: 4,
      items: [
        { kind: 'accounts', data: [{ id: 'bank', name: 'Main bank', type: 'bank' }] },
        { kind: 'meta', data: { schemaVersion: 8, currency: 'EUR', name: 'Family' } },
      ],
    });
    expect(result).toEqual({ version: 5, changedKinds: ['accounts', 'meta'] });
    const read = await store.readBudget({ budgetId, userId: userA });
    expect(read.version).toBe(5);
    expect(read.bundle.accounts[0].name).toBe('Main bank');
    expect(read.bundle.meta.name).toBe('Family');
  });

  it('rejects a stale version without changing any blob', async () => {
    const before = await store.readBudget({ budgetId, userId: userA });
    await expect(store.applyBudget({
      budgetId,
      userId: userA,
      expectedVersion: 4,
      items: [{ kind: 'accounts', data: [] }],
    })).rejects.toMatchObject({ code: 'version_conflict', current: 5 });
    const after = await store.readBudget({ budgetId, userId: userA });
    expect(after.version).toBe(5);
    expect(after.bundle).toEqual(before.bundle);
  });
  it('normalizes type-signed amounts before validating and storing', async () => {
    const { version } = await store.readBudget({ budgetId, userId: userA });
    await store.applyBudget({
      budgetId, userId: userA, expectedVersion: version,
      items: [{ kind: 'transactions', data: [
        { id: 'n1', type: 'expense', amount: -12.5, date: '2026-01-02', account: 'bank' },
        { id: 'n2', type: 'adjustment', amount: -3, date: '2026-01-02', target: 'account', target_id: 'bank' },
      ] }],
    });
    const read = await store.readBudget({ budgetId, userId: userA });
    expect(read.bundle.transactions.map((t) => t.amount)).toEqual([12.5, -3]);
  });

  it('rejects string amounts and impossible dates as validation failures', async () => {
    const { version } = await store.readBudget({ budgetId, userId: userA });
    for (const row of [
      { id: 's1', type: 'expense', amount: '12', date: '2026-01-02' },
      { id: 's2', type: 'expense', amount: 1, date: '2026-02-31' },
    ]) {
      await expect(store.applyBudget({
        budgetId, userId: userA, expectedVersion: version,
        items: [{ kind: 'transactions', data: [row] }],
      })).rejects.toMatchObject({ code: 'validation_failed' });
    }
  });

  it('refuses a new dangling account reference when asked to check', async () => {
    const { version } = await store.readBudget({ budgetId, userId: userA });
    const write = (data, checkAccountRefs = true) => store.applyBudget({
      budgetId, userId: userA, expectedVersion: version, checkAccountRefs,
      items: [{ kind: 'transactions', data }],
    });
    await expect(write([{ id: 'd1', type: 'expense', amount: 1, date: '2026-01-02', account: 'ghost' }]))
      .rejects.toMatchObject({ code: 'validation_failed', message: expect.stringMatching(/ghost/) });
    // Same write in the same batch as the account it points at is fine.
    const both = await store.applyBudget({
      budgetId, userId: userA, expectedVersion: version, checkAccountRefs: true,
      items: [
        { kind: 'accounts', data: [{ id: 'bank', name: 'Main bank' }, { id: 'ghost', name: 'Now real' }] },
        { kind: 'transactions', data: [{ id: 'd1', type: 'expense', amount: 1, date: '2026-01-02', account: 'ghost' }] },
      ],
    });
    // Removing an account that stored transactions still use is refused too.
    await expect(store.applyBudget({
      budgetId, userId: userA, expectedVersion: both.version, checkAccountRefs: true,
      items: [{ kind: 'accounts', data: [{ id: 'bank', name: 'Main bank' }] }],
    })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('does not let a legacy dangling reference block later writes', async () => {
    // Plant a dangling ref directly, the way old data would carry one.
    await db.query(
      `update budget_blobs set data = $2::jsonb where budget_id = $1 and kind = 'transactions'`,
      [budgetId, JSON.stringify([{ id: 'old', type: 'expense', amount: 1, date: '2025-01-01', account: 'closed' }])],
    );
    const { version } = await store.readBudget({ budgetId, userId: userA });
    const result = await store.applyBudget({
      budgetId, userId: userA, expectedVersion: version, checkAccountRefs: true,
      items: [{ kind: 'transactions', data: [
        { id: 'old', type: 'expense', amount: 1, date: '2025-01-01', account: 'closed' },
        { id: 'new', type: 'expense', amount: 2, date: '2026-01-03', account: 'bank' },
      ] }],
    });
    expect(result.version).toBe(version + 1);
  });

  it('treats a malformed budget id as not found', async () => {
    await expect(store.readBudget({ budgetId: 'not-a-uuid' }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(store.probeBudget({ budgetId: '42' }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(store.applyBudget({
      budgetId: 'nope', expectedVersion: 0, items: [{ kind: 'accounts', data: [] }],
    })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lists budgets with the owner email and filters by owner', async () => {
    const all = await store.listBudgets();
    expect(all.find((b) => b.id === budgetId)).toMatchObject({ owner_email: 'store-a@example.com' });
    expect((await store.listBudgets({ userId: userB })).length).toBe(0);
    expect((await store.listBudgets({ userEmail: 'STORE-A@example.com' })).map((b) => b.id))
      .toContain(budgetId);
    expect(await store.listBudgets({ userEmail: 'nobody@example.com' })).toEqual([]);
  });

  it('creates a budget for a user up to the cap, at the schema default version', async () => {
    const created = await store.createBudget({ userId: userB, name: ' Restored ', maxPerUser: 2 });
    expect(created).toMatchObject({ name: 'Restored', version: 0 });
    expect((await store.listBudgets({ userId: userB })).map((b) => b.id)).toEqual([created.id]);
    await store.createBudget({ userId: userB, name: 'Second', maxPerUser: 2 });
    await expect(store.createBudget({ userId: userB, name: 'Third', maxPerUser: 2 }))
      .rejects.toMatchObject({ code: 'budget_limit', max: 2 });
    expect((await store.listBudgets({ userId: userB })).length).toBe(2);
    await expect(store.createBudget({
      userId: '00000000-0000-4000-8000-000000000000', name: 'x', maxPerUser: 2,
    })).rejects.toMatchObject({ code: 'not_found' });
  });

  describe('blob backups on write', () => {
    let owner;
    let seq = 0;
    const backups = async (budget) => (await db.query(
      `select kind, data, version, backed_up_at from budget_blob_backups
        where budget_id = $1 order by kind, backed_up_at desc, id desc`,
      [budget],
    )).rows;
    const freshBudget = async (items) => {
      seq += 1;
      return store.createBudget({ userId: owner, name: `Backups ${seq}`, maxPerUser: 50, items });
    };

    beforeAll(async () => {
      owner = (await db.query(
        `insert into users (email, google_sub, name)
         values ('store-backups@example.com', 'sub-store-backups', 'b') returning id`,
      )).rows[0].id;
    });

    it('backs up each written kind that already had a blob, at the version it was written over', async () => {
      const b = await freshBudget([{ kind: 'envelopes', data: [{ id: 'e1', name: 'One' }] }]);
      expect(b.version).toBe(1);
      await store.applyBudget({
        budgetId: b.id, expectedVersion: 1,
        items: [
          { kind: 'envelopes', data: [{ id: 'e2', name: 'Two' }] },
          { kind: 'accounts', data: [{ id: 'a1', name: 'Bank', type: 'bank' }] },
        ],
      });
      const rows = await backups(b.id);
      // accounts had no blob yet: nothing to back up.
      expect(rows.map(r => [r.kind, r.version, r.data])).toEqual([
        ['envelopes', 1, [{ id: 'e1', name: 'One' }]],
      ]);
    });

    it('takes at most one backup per kind in the throttle window', async () => {
      const b = await freshBudget([{ kind: 'envelopes', data: [] }]);
      for (let v = 1; v <= 3; v++) {
        await store.applyBudget({
          budgetId: b.id, expectedVersion: v, items: [{ kind: 'envelopes', data: [{ id: `e${v}`, name: 'x' }] }],
        });
      }
      const rows = await backups(b.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ version: 1, data: [] });
    });

    it('backs up again once the window has passed, and keeps only the newest 20 per kind', async () => {
      const b = await freshBudget([
        { kind: 'envelopes', data: [] },
        { kind: 'meta', data: { schemaVersion: 8 } },
      ]);
      // 25 old envelope backups and 3 old meta backups, all outside the window.
      for (let i = 0; i < 25; i++) {
        await db.query(
          `insert into budget_blob_backups (budget_id, kind, data, version, backed_up_at)
           values ($1, 'envelopes', '[]'::jsonb, $2, now() - ($3 || ' hours')::interval)`,
          [b.id, 100 + i, String(i + 1)],
        );
      }
      for (let i = 0; i < 3; i++) {
        await db.query(
          `insert into budget_blob_backups (budget_id, kind, data, version, backed_up_at)
           values ($1, 'meta', '{}'::jsonb, $2, now() - interval '1 day')`,
          [b.id, 200 + i],
        );
      }
      await store.applyBudget({
        budgetId: b.id, expectedVersion: 1,
        items: [
          { kind: 'envelopes', data: [{ id: 'e1', name: 'x' }] },
          { kind: 'meta', data: { schemaVersion: 8, currency: 'EUR' } },
        ],
      });
      const rows = await backups(b.id);
      const env = rows.filter(r => r.kind === 'envelopes');
      expect(env).toHaveLength(20);
      // The new one is kept (newest), and the oldest six went.
      expect(env[0]).toMatchObject({ version: 1, data: [] });
      expect(env.map(r => r.version)).not.toContain(124);
      expect(env.map(r => r.version)).toContain(100);
      const meta = rows.filter(r => r.kind === 'meta');
      expect(meta.map(r => r.version).sort()).toEqual([1, 200, 201, 202]);
    });
  });

  it('creates a budget with its collections in one transaction; a refused write creates nothing', async () => {
    const userC = (await db.query(
      `insert into users (email, google_sub, name)
       values ('store-c@example.com', 'sub-store-c', 'c') returning id`,
    )).rows[0].id;
    const items = [
      { kind: 'envelopes', data: [{ id: 'rent', name: 'Rent' }] },
      { kind: 'meta', data: { schemaVersion: 8, currency: 'EUR' } },
    ];
    const created = await store.createBudget({ userId: userC, name: 'Restored', maxPerUser: 5, items });
    expect(created).toMatchObject({ name: 'Restored', version: 1, changedKinds: ['envelopes', 'meta'] });
    const read = await store.readBudget({ budgetId: created.id });
    expect(read.bundle.envelopes).toEqual(items[0].data);
    expect(read.version).toBe(1);

    // Ciphertext for a user without encryption is refused inside the
    // transaction, after the insert: the budget row must roll back with it.
    const cipher = {
      __enc: 1, kid: 'k1',
      iv: Buffer.alloc(12, 1).toString('base64'),
      ct: Buffer.alloc(32, 2).toString('base64'),
    };
    await expect(store.createBudget({
      userId: userC, name: 'Broken', maxPerUser: 5, items: [{ kind: 'envelopes', data: cipher }],
    })).rejects.toMatchObject({ code: 'encryption_conflict' });
    expect((await store.listBudgets({ userId: userC })).map((b) => b.name)).toEqual(['Restored']);
  });
  it('stores history incrementally and returns self-contained logical backups', async () => {
    const { appendFinancialHistory } = await import('../js/core/financial-history.js');
    const userId = (await db.query("insert into users (email, google_sub, name) values ('history@example.com', 'history', 'History') returning id")).rows[0].id;
    const before = { accounts: [{ id: 'bank', name: 'Bank', type: 'bank', initialBalance: 1 }],
      envelopes: [], transactions: [], budgetItems: [], envelopeTemplates: [], meta: { schemaVersion: 8 } };
    const after = { ...before, accounts: [{ ...before.accounts[0], initialBalance: 2 }] };
    after.meta = { ...after.meta, financialHistory: appendFinancialHistory(before, after, new Date('2026-10-08T12:00:00Z')) };
    const created = await store.createBudget({ userId, name: 'History', maxPerUser: 5,
      items: Object.entries(after).map(([kind, data]) => ({ kind, data })) });
    const count = async () => Number((await db.query('select count(*) from budget_history_chunks where budget_id = $1', [created.id])).rows[0].count);
    expect(await count()).toBe(2);
    const logical = await store.readBudget({ budgetId: created.id, userId });
    expect(logical.bundle).toEqual(after);
    const raw = await store.readBudget({ budgetId: created.id, userId, rawHistory: true });
    expect(raw.bundle.meta.financialHistory.storage).toBe('history-chunks-v1');
    expect(raw.bundle.meta.__historyChunks).toHaveLength(2);
    const next = { ...after, accounts: [{ ...after.accounts[0], initialBalance: 3 }] };
    next.meta = { ...after.meta, financialHistory: appendFinancialHistory(after, next, new Date('2026-10-08T13:00:00Z')) };
    await store.applyBudget({ budgetId: created.id, userId, expectedVersion: 1,
      items: [{ kind: 'accounts', data: next.accounts }, { kind: 'meta', data: next.meta }] });
    expect(await count()).toBe(3);
    expect((await store.readBudget({ budgetId: created.id })).bundle).toEqual(next);
    await expect(store.applyBudget({ budgetId: created.id, userId, expectedVersion: 1,
      items: [{ kind: 'meta', data: next.meta }] })).rejects.toMatchObject({ code: 'version_conflict' });
    expect(await count()).toBe(3);
    await db.query("insert into budget_history_chunks (budget_id, id, data) values ($1, $2, '{}'::jsonb)", [created.id, 'a'.repeat(64)]);
    await store.applyBudget({ budgetId: created.id, userId, expectedVersion: 2, items: [{ kind: 'meta', data: next.meta }] });
    expect(await count()).toBe(3); // unreachable chunk collected; current and backup refs survive
    await expect(store.readBudget({ budgetId: created.id, userId: userA, rawHistory: true })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps encrypted history opaque, portable in backups, and atomic on a missing chunk', async () => {
    const { initialHistory } = await import('../js/core/financial-history.js');
    const { packHistoryMeta, unpackHistoryMeta, chunkIds } = await import('../js/storage/history-chunks.js');
    const { encryptJson, decryptJson } = await import('../js/storage/crypto.js');
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const userId = (await db.query(`insert into users (email, google_sub, name, encryption_enabled, encryption_verifier)
      values ('encrypted-history@example.com', 'encrypted-history', 'History', true, '{"keyId":"history-key"}'::jsonb) returning id`)).rows[0].id;
    const data = { accounts: [], envelopes: [], transactions: [], budgetItems: [], envelopeTemplates: [], meta: { schemaVersion: 8 } };
    data.meta.financialHistory = initialHistory(data, new Date('2026-10-08T12:00:00Z'));
    const seal = async v => ({ ...await encryptJson(key, v), kid: 'history-key' });
    const packed = await packHistoryMeta(data.meta, null, seal);
    const encrypted = { ...await seal(packed.meta), historyIds: chunkIds(packed.meta.financialHistory) };
    const created = await store.createBudget({ userId, name: 'Encrypted', maxPerUser: 5,
      items: [{ kind: 'meta', data: encrypted, historyChunks: packed.chunks }] });
    const read = await store.readBudget({ budgetId: created.id, userId });
    const chunks = new Map(read.bundle.meta.historyChunks.map(c => [c.id, c.data]));
    expect([...chunks.values()].every(v => v.__enc === 1)).toBe(true);
    const unpacked = await unpackHistoryMeta(await decryptJson(key, read.bundle.meta), id => chunks.get(id), v => decryptJson(key, v));
    expect(unpacked.meta).toEqual(data.meta);
    const copy = await store.createBudget({ userId, name: 'Restored', maxPerUser: 5,
      items: [{ kind: 'meta', data: read.bundle.meta }] });
    expect((await store.readBudget({ budgetId: copy.id })).bundle.meta).toEqual(read.bundle.meta);
    await expect(store.applyBudget({ budgetId: created.id, userId, expectedVersion: 1,
      items: [{ kind: 'meta', data: { ...encrypted, historyIds: ['a'.repeat(64)] } }] })).rejects.toMatchObject({ code: 'validation_failed' });
    expect((await store.readBudget({ budgetId: created.id })).version).toBe(1);
  });

});

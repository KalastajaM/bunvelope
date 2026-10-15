// `npm run backup` against a fake store: one file per budget, what the store
// returns written verbatim (ciphertext stays ciphertext), pruning to the
// newest N, and one failing budget not stopping the rest.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runBackup, resolveBackupDir, resolveKeep, stampOf, DEFAULT_KEEP,
} from '../scripts/backup-lib.mjs';
import { validateBundle } from '../js/storage/validators.js';

const PLAIN_ID = '11111111-1111-4111-8111-111111111111';
const ENC_ID = '22222222-2222-4222-8222-222222222222';
const BAD_ID = '33333333-3333-4333-8333-333333333333';
const CIPHER = { __enc: 1, kid: 'k1', iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAA==' };

function plainBundle() {
  return {
    envelopes: [], budgetItems: [], transactions: [], accounts: [],
    envelopeTemplates: [], meta: { schemaVersion: 8, name: 'Family' },
  };
}

function fakeStore({ failId } = {}) {
  const budgets = {
    [PLAIN_ID]: { name: 'Family / Home', version: 4, userId: 'u1', bundle: plainBundle() },
    [ENC_ID]: {
      name: 'Secret', version: 9, userId: 'u2',
      bundle: { ...plainBundle(), transactions: CIPHER, meta: CIPHER },
    },
    [BAD_ID]: { name: 'Broken', version: 1, userId: 'u1', bundle: plainBundle() },
  };
  const reads = [];
  return {
    reads,
    async listBudgets() {
      return Object.entries(budgets).map(([id, b]) => ({
        id, name: b.name, version: b.version, user_id: b.userId,
        owner_email: `${b.userId}@example.com`, created_at: '2026-01-01T00:00:00.000Z',
      }));
    },
    async readBudget({ budgetId, touchLastOpened }) {
      reads.push({ budgetId, touchLastOpened });
      if (budgetId === failId) throw Object.assign(new Error('boom'), { code: 'XX000' });
      const b = budgets[budgetId];
      return {
        budgetId, budgetName: b.name, version: b.version, userId: b.userId,
        createdAt: '2026-01-01T00:00:00.000Z', bundle: structuredClone(b.bundle),
      };
    },
  };
}

const getEncryption = async (userId) => ({ enabled: true, salt: `salt-${userId}`, verifier: { keyId: 'k1' } });

describe('runBackup', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bv-backup-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes one timestamped file per budget, read without touching last_opened_at', async () => {
    const store = fakeStore();
    const now = new Date('2026-09-24T08:31:15.123Z');
    const summary = await runBackup({ store, getEncryption, dir, keep: 30, now });

    expect(summary.ok).toBe(true);
    expect(summary.budgets).toHaveLength(3);
    expect(store.reads.every((r) => r.touchLastOpened === false)).toBe(true);
    expect(readdirSync(join(dir, PLAIN_ID))).toEqual(['bunvelope-family-home-20260924T083115Z.json']);

    const doc = JSON.parse(readFileSync(join(dir, PLAIN_ID, 'bunvelope-family-home-20260924T083115Z.json'), 'utf8'));
    expect(doc._backup).toMatchObject({
      format: 'bunvelope-backup', format_version: 1, encrypted: false,
      created_at: '2026-09-24T08:31:15.123Z',
      budget: { id: PLAIN_ID, name: 'Family / Home', version: 4, owner_email: 'u1@example.com' },
    });
    expect(doc._backup.encryption).toBeUndefined();
    // A plaintext backup is a valid bundle, so the app's "Import file" takes it.
    expect(validateBundle(doc).ok).toBe(true);
    expect(statSync(join(dir, PLAIN_ID, 'bunvelope-family-home-20260924T083115Z.json')).mode & 0o077).toBe(0);
  });

  it('keeps ciphertext as ciphertext and records the salt needed to decrypt it', async () => {
    await runBackup({ store: fakeStore(), getEncryption, dir, keep: 30, now: new Date('2026-09-24T00:00:00Z') });
    const [name] = readdirSync(join(dir, ENC_ID));
    const doc = JSON.parse(readFileSync(join(dir, ENC_ID, name), 'utf8'));
    expect(doc.transactions).toEqual(CIPHER);
    expect(doc.meta).toEqual(CIPHER);
    expect(doc._backup.encrypted).toBe(true);
    expect(doc._backup.encryption).toEqual({ enabled: true, salt: 'salt-u2', verifier: { keyId: 'k1' } });
  });

  it('keeps only the newest N files per budget and leaves other files alone', async () => {
    const folder = join(dir, PLAIN_ID);
    mkdirSync(folder, { recursive: true });
    for (const stamp of ['20260101T000000Z', '20260201T000000Z', '20260301T000000Z']) {
      writeFileSync(join(folder, `bunvelope-old-name-${stamp}.json`), '{}');
    }
    writeFileSync(join(folder, 'notes.txt'), 'mine');
    const summary = await runBackup({
      store: fakeStore(), getEncryption, dir, keep: 2, now: new Date('2026-09-24T00:00:00Z'),
    });
    expect(readdirSync(folder).sort()).toEqual([
      'bunvelope-family-home-20260924T000000Z.json',
      'bunvelope-old-name-20260301T000000Z.json',
      'notes.txt',
    ]);
    expect(summary.budgets.find((b) => b.id === PLAIN_ID).pruned).toBe(2);
  });

  it('backs up the other budgets when one fails, and reports failure', async () => {
    const summary = await runBackup({
      store: fakeStore({ failId: BAD_ID }), getEncryption, dir, keep: 30, now: new Date(),
    });
    expect(summary.ok).toBe(false);
    expect(summary.errors).toEqual([{ id: BAD_ID, code: 'XX000', message: 'boom' }]);
    expect(summary.budgets.map((b) => b.id).sort()).toEqual([PLAIN_ID, ENC_ID]);
  });
});

describe('backup settings', () => {
  it('defaults the directory to ~/Bunvelope-backups and expands ~', () => {
    expect(resolveBackupDir(undefined, '/Users/me')).toBe('/Users/me/Bunvelope-backups');
    expect(resolveBackupDir('~/b', '/Users/me')).toBe('/Users/me/b');
    expect(resolveBackupDir('/srv/b', '/Users/me')).toBe('/srv/b');
  });

  it('reads BACKUP_KEEP as a positive integer', () => {
    expect(resolveKeep(undefined)).toBe(DEFAULT_KEEP);
    expect(resolveKeep('7')).toBe(7);
    expect(resolveKeep('0')).toBe(DEFAULT_KEEP);
    expect(resolveKeep('x')).toBe(DEFAULT_KEEP);
  });

  it('stamps sort chronologically', () => {
    expect(stampOf(new Date('2026-09-24T08:31:15.999Z'))).toBe('20260924T083115Z');
  });
});

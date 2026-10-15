// /healthz: 503 when the database is down OR migrations on disk are not all
// applied, with the pending list cached so a frequent probe stays cheap.

import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest';
import express from 'express';
import { createHealthcheck } from '../server/db.js';
import { healthHandler } from '../server/health.js';

function fakePool(applied, { failTable = false } = {}) {
  return {
    query: vi.fn(async (sql) => {
      if (/select 1 as ok/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/schema_migrations/.test(sql)) {
        if (failTable) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
        return { rows: applied.map((filename) => ({ filename })) };
      }
      throw new Error(`unexpected ${sql}`);
    }),
  };
}

const FILES = ['0001_a.sql', '0002_b.sql'];
const listFiles = async () => FILES;

describe('createHealthcheck', () => {
  it('reports pending migrations', async () => {
    const check = createHealthcheck({ pool: fakePool(['0001_a.sql']), listFiles });
    expect(await check()).toEqual({ db: true, pendingMigrations: ['0002_b.sql'] });
  });

  it('treats a missing schema_migrations table as everything pending', async () => {
    const check = createHealthcheck({ pool: fakePool([], { failTable: true }), listFiles });
    expect((await check()).pendingMigrations).toEqual(FILES);
  });

  it('caches a clean result for good and a pending one for ttlMs', async () => {
    let t = 0;
    const applied = ['0001_a.sql'];
    const pool = fakePool(applied);
    const check = createHealthcheck({ pool, listFiles, ttlMs: 1000, now: () => t });
    const migrationReads = () => pool.query.mock.calls.filter(([s]) => /schema_migrations/.test(s)).length;

    await check();
    await check();
    expect(migrationReads()).toBe(1);

    applied.push('0002_b.sql');
    t = 999;
    expect((await check()).pendingMigrations).toEqual(['0002_b.sql']);
    t = 1000;
    expect((await check()).pendingMigrations).toEqual([]);
    t = 1_000_000;
    await check();
    expect(migrationReads()).toBe(2);
  });
});

describe('healthHandler', () => {
  let server; let base; let result;
  beforeAll(async () => {
    const app = express();
    app.get('/healthz', healthHandler(async () => {
      if (result instanceof Error) throw result;
      return result;
    }));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const probe = async () => {
    const res = await fetch(`${base}/healthz`);
    return { status: res.status, body: await res.json() };
  };

  it('200 when the database is up and migrations are applied', async () => {
    result = { db: true, pendingMigrations: [] };
    expect(await probe()).toEqual({ status: 200, body: { ok: true, db: 'up', migrations: 'applied' } });
  });

  it('503 with the pending count when migrations are outstanding', async () => {
    result = { db: true, pendingMigrations: ['0008_x.sql'] };
    expect(await probe()).toEqual({
      status: 503, body: { ok: false, db: 'up', migrations: 'pending', pending: 1 },
    });
  });

  it('503 without internal detail when the database is unreachable', async () => {
    result = new Error('connect ECONNREFUSED 10.0.0.1:5432');
    expect(await probe()).toEqual({ status: 503, body: { ok: false, error: 'db unavailable' } });
  });
});

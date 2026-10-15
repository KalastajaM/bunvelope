// A Postgres advisory lock belongs to the session that took it. Taking it
// with pool.query and releasing it with another pool.query can land on two
// different pooled connections: the unlock then does nothing and the lock
// stays held by an idle connection until it is recycled, stalling the next
// replica's migration run. Lock, migrations and unlock must share one client.

import { describe, it, expect, vi } from 'vitest';
import { runMigrations } from '../server/db.js';

function fakePool() {
  const log = [];
  let clients = 0;
  const respond = (sql) => {
    if (/select filename from schema_migrations/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  const makeClient = () => {
    const id = `client${++clients}`;
    return {
      id,
      released: false,
      async query(sql) { log.push({ on: id, sql: String(sql).trim() }); return respond(String(sql)); },
      release() { this.released = true; log.push({ on: id, sql: 'RELEASE' }); },
    };
  };
  const made = [];
  return {
    log,
    made,
    async query(sql) { log.push({ on: 'pool', sql: String(sql).trim() }); return respond(String(sql)); },
    async connect() { const c = makeClient(); made.push(c); return c; },
  };
}

describe('runMigrations advisory lock', () => {
  it('takes and releases the lock, and applies migrations, on one dedicated client', async () => {
    const pool = fakePool();
    await runMigrations({ log: () => {}, info: () => {}, warn: () => {} }, { pool });

    const lock = pool.log.find((q) => /pg_advisory_lock\(/.test(q.sql));
    const unlock = pool.log.find((q) => /pg_advisory_unlock\(/.test(q.sql));
    expect(lock).toBeDefined();
    expect(unlock).toBeDefined();
    expect(lock.on).not.toBe('pool');
    expect(unlock.on).toBe(lock.on);

    // Everything between lock and unlock runs on the lock's session.
    const i = pool.log.indexOf(lock);
    const j = pool.log.indexOf(unlock);
    const between = pool.log.slice(i + 1, j);
    expect(between.length).toBeGreaterThan(0);
    expect(between.every((q) => q.on === lock.on)).toBe(true);
    expect(between.some((q) => q.sql === 'begin')).toBe(true);

    const client = pool.made.find((c) => c.id === lock.on);
    expect(client.released).toBe(true);
    expect(pool.made.every((c) => c.released)).toBe(true);
  });

  it('unlocks and releases the client even when a migration fails', async () => {
    const pool = fakePool();
    const connect = pool.connect.bind(pool);
    pool.connect = async () => {
      const c = await connect();
      const q = c.query.bind(c);
      c.query = vi.fn(async (sql) => {
        if (/create table|create extension|alter table/i.test(sql)) throw new Error('boom');
        return q(sql);
      });
      return c;
    };
    await expect(runMigrations({ log: () => {}, info: () => {} }, { pool })).rejects.toThrow('boom');
    const unlock = pool.log.find((q) => /pg_advisory_unlock\(/.test(q.sql));
    expect(unlock).toBeDefined();
    expect(pool.made.every((c) => c.released)).toBe(true);
  });
});

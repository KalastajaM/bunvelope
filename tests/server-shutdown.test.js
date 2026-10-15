// Graceful shutdown must let in-flight requests finish before the pool
// closes and the process exits. It used to call server.close() without
// waiting, then pool.end() and exit(0) at once, cutting off a save that was
// halfway through its transaction on every deploy.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { createShutdown } from '../server/shutdown.js';

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}

describe('createShutdown', () => {
  it('waits for an in-flight request before ending the pool and exiting', async () => {
    const order = [];
    let release;
    const app = express();
    app.get('/slow', (_req, res) => {
      release = () => { order.push('response'); res.json({ ok: true }); };
    });
    const server = await listen(app);
    const pool = { end: vi.fn(async () => { order.push('pool.end'); }) };
    const exit = vi.fn((code) => { order.push(`exit:${code}`); });
    const shutdown = createShutdown({ server, pool, exit, log: () => {}, timeoutMs: 5000 });

    const inflight = fetch(`http://127.0.0.1:${server.address().port}/slow`, {
      headers: { connection: 'close' },
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    const done = shutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    expect(pool.end).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    release();
    expect((await inflight).status).toBe(200);
    await done;
    expect(order).toEqual(['response', 'pool.end', 'exit:0']);
  });

  it('forces connections closed after the timeout and exits non-zero', async () => {
    const app = express();
    let arrived;
    const received = new Promise(resolve => { arrived = resolve; });
    app.get('/hang', () => { arrived(); });
    const server = await listen(app);
    const pool = { end: vi.fn(async () => {}) };
    const exit = vi.fn();
    const shutdown = createShutdown({ server, pool, exit, log: () => {}, timeoutMs: 100 });

    const hung = fetch(`http://127.0.0.1:${server.address().port}/hang`).catch((e) => e);
    await received;
    await shutdown('SIGTERM');
    expect(pool.end).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(1);
    expect(await hung).toBeInstanceOf(Error);
  });

  it('ignores a second signal while shutting down', async () => {
    const server = await listen(express());
    const pool = { end: vi.fn(async () => {}) };
    const exit = vi.fn();
    const shutdown = createShutdown({ server, pool, exit, log: () => {} });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(pool.end).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });
});

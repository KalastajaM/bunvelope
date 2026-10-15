// server/health.js — /healthz handler (liveness probe for docker/process supervisors).
//
// Healthy means the database answers AND every migration on disk has been
// applied. The second half is what a plain `select 1` missed: a replica
// running code for a schema the database does not have yet would pass the
// probe and take traffic. Pending filenames are not listed in the response
// (the endpoint is unauthenticated); the count is enough to act on.

/** @param {() => Promise<{ db: boolean, pendingMigrations: string[] }>} check */
export function healthHandler(check) {
  return async (req, res) => {
    let status;
    try {
      status = await check();
    } catch (err) {
      // Log the detail server-side; never leak internal DB error strings to
      // unauthenticated callers.
      req.log?.error?.({ err }, 'healthcheck failed');
      return res.status(503).json({ ok: false, error: 'db unavailable' });
    }
    const pending = status.pendingMigrations.length;
    const ok = status.db && pending === 0;
    const body = { ok, db: status.db ? 'up' : 'down', migrations: pending ? 'pending' : 'applied' };
    if (pending) body.pending = pending;
    res.status(ok ? 200 : 503).json(body);
  };
}

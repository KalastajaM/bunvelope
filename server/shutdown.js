// server/shutdown.js — graceful SIGTERM/SIGINT handling.
//
// A supervisor (docker stop, launchd) sends SIGTERM on every restart, and
// Ctrl-C sends SIGINT. The old handler called server.close() without
// waiting for it, then ended the pool and exited at
// once, so a save halfway through its transaction lost its connection
// mid-flight. Now: stop accepting, let in-flight requests finish (idle
// keep-alive sockets are closed straight away so they cannot hold the wait
// open), and only then end the pool and exit. A request that outlives
// `timeoutMs` is cut off so a hung client cannot block the restart.

/**
 * @param {object} opts
 * @param {import('node:http').Server} opts.server
 * @param {{ end: () => Promise<void> }} opts.pool
 * @param {number} [opts.timeoutMs]
 * @param {(code: number) => void} [opts.exit]
 * @param {(msg: string) => void} [opts.log]
 */
export function createShutdown({
  server, pool, timeoutMs = 10_000, exit = (code) => process.exit(code), log = console.log,
}) {
  let running = null;
  return function shutdown(sig) {
    if (running) return running;
    running = (async () => {
      log(`${sig} received, shutting down`);
      let timer;
      const closed = new Promise((resolve) => {
        server.close(() => resolve('closed'));
        server.closeIdleConnections?.();
      });
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        timer.unref?.();
      });
      const outcome = await Promise.race([closed, timedOut]);
      clearTimeout(timer);
      if (outcome === 'timeout') {
        log(`shutdown: requests still open after ${timeoutMs}ms, closing them`);
        server.closeAllConnections?.();
      }
      await pool.end().catch(() => {});
      exit(outcome === 'timeout' ? 1 : 0);
    })();
    return running;
  };
}

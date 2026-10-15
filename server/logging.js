// server/logging.js — request logger options and the JSON error handler,
// kept out of server/index.js so they can be mounted and tested on a bare
// app (index.js boots a database on import).

/**
 * Error serializer applied on top of pino's standard one.
 *
 * When express.json() meets a body it cannot parse, body-parser attaches the
 * whole raw request body to the error as `err.body`, and pino's serializer
 * copies every enumerable property. A malformed save therefore logged up to
 * 10 MB of plaintext budget (payees, amounts, notes) into the retained server
 * logs, and so did anything else that reached the error handler carrying a
 * body. V8's JSON.parse message also quotes the start of the input, so a
 * parse failure's message and stack headline are replaced too.
 */
export function redactErr(serialized) {
  if (!serialized || typeof serialized !== 'object') return serialized;
  const hadBody = Object.hasOwn(serialized, 'body');
  delete serialized.body;
  const raw = serialized.raw;
  if (hadBody || raw?.type === 'entity.parse.failed') {
    const headline = 'request body could not be parsed';
    serialized.message = headline;
    if (typeof serialized.stack === 'string') {
      const frames = serialized.stack.split('\n').filter((l) => /^\s+at /.test(l));
      serialized.stack = [`${serialized.type || 'Error'}: ${headline}`, ...frames].join('\n');
    }
  }
  return serialized;
}

/** pino-http options. Redacts credentials in headers and bodies in errors. */
export function httpLoggerOptions() {
  return {
    // pino-http's default `req` serializer emits the whole `headers` object,
    // so without this every request logs `cookie: bv.sid=<session token>`,
    // and anyone who can read the retained logs then holds every live
    // session.
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.headers.referer',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
        'err.body',
        'res.err.body',
      ],
      remove: true,
    },
    serializers: {
      err: redactErr,
      req: (serialized) => {
        // OAuth callbacks carry authorization codes and state in the query.
        // Retain the route for diagnostics without retaining URL credentials.
        if (typeof serialized.url === 'string') serialized.url = serialized.url.split('?')[0];
        delete serialized.query;
        return serialized;
      },
    },
  };
}

/** JSON error handler; never leaks stack traces or request bodies. */
export function errorHandler(err, req, res, _next) {
  // Belt and braces with redactErr: drop the raw body from the error object
  // itself so no later consumer (pino-http's response log reads the same
  // object) can see it either.
  if (err && typeof err === 'object' && Object.hasOwn(err, 'body')) delete err.body;
  req.log?.error?.({ err }, 'request failed');
  if (res.headersSent) return;
  const message = err?.type === 'entity.too.large'
    ? 'Request exceeds the server size limit. No changes were saved.'
    : 'internal error';
  res.status(err?.status || 500).json({ error: err?.publicMessage || message });
}

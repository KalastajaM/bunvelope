// bin/cli-support.mjs — pure helpers for bin/bunvelope.mjs, kept separate so
// they can be tested without spawning the CLI or connecting to a database.

import { BudgetStoreError } from '../server/services/budget-store.js';
import { isCertificateError } from '../server/db.js';

export { validateReadable } from '../server/session/readable.js';

export const PROTOCOL_VERSION = 1;

const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT']);

/** The stderr line printed before connecting when verification is off. */
export function sslWarning(env) {
  if (String(env.PGSSL || '').trim().toLowerCase() !== 'no-verify') return null;
  return 'bunvelope: warning: PGSSL=no-verify, the database certificate is not '
    + 'verified; anyone on the network path could read or alter budget data.';
}

/** The JSON error document written to stderr. Never includes secrets. */
export function publicError(error) {
  const known = error instanceof BudgetStoreError;
  let code;
  let message;
  let params;
  if (known) {
    // A --file failure names the path, as the generated CLI's params do.
    if (typeof error.path === 'string') params = { path: error.path };
    code = error.code;
    message = error.message;
  } else if (isCertificateError(error)) {
    code = 'tls_verification_failed';
    message = 'the database TLS certificate could not be verified'
      + `${error?.code ? ` (${error.code})` : ''}. If this database uses a self-signed `
      + 'certificate, set PGSSL=no-verify to connect without verification.';
  } else if (CONNECTION_CODES.has(error?.code)) {
    code = 'connection_failed';
    message = 'database connection failed';
  } else {
    code = 'internal_error';
    message = 'internal error';
  }
  return {
    protocol_version: PROTOCOL_VERSION,
    error: {
      code,
      message,
      ...(params ? { params } : {}),
      ...(error?.current === undefined ? {} : { current: error.current }),
    },
  };
}

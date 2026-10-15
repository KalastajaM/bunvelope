// e2e/static-server.js — webServer entry for the static-mode specs (guest and
// FSAPI): the repo's static dev server (scripts/static-server.mjs), in Node,
// so the suite needs no Python and no database.

import { startStaticServer } from '../scripts/static-server.mjs';

startStaticServer(Number(process.env.E2E_STATIC_PORT || 4174), 'e2e static server');

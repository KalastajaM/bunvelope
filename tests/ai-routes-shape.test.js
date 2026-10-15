// tests/ai-routes-shape.test.js — which /api/ai/* routes exist.
//
// Cheap, no database: build the router and read its stack. It exists because a
// bulk edit once deleted POST /messages along with the route next to it, and
// nothing failed — the unit tests cover runMessages, not the wiring that
// reaches it, so only a lint warning about an unused import gave it away.

import { describe, it, expect, beforeAll } from 'vitest';

let routes;

beforeAll(async () => {
  const { aiRoutes } = await import('../server/routes/ai.js');
  routes = aiRoutes().stack
    .filter((layer) => layer.route)
    .map((layer) => `${Object.keys(layer.route.methods)[0].toUpperCase()} ${layer.route.path}`);
});

describe('/api/ai route surface', () => {
  it('exposes exactly the routes the client calls', () => {
    expect(routes.sort()).toEqual([
      'DELETE /cache',
      'DELETE /key',
      'GET /key',
      'POST /insights',
      'POST /key/test',
      'POST /messages',
      'PUT /key',
    ]);
  });

  it('still serves the agent relay every AI surface now depends on', () => {
    // Import categorization, document parse, the prompt dialog, and the
    // transactions filter all route through this one endpoint in cloud mode.
    expect(routes).toContain('POST /messages');
  });

  it('no longer serves the retired search relay', () => {
    // aiSearch moved onto js/ai/transport.js so it works without a server.
    expect(routes).not.toContain('POST /search');
  });
});

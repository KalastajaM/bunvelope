// Every adapter, one contract. See tests/_fakes/storeContract.js for why.
import { vi } from 'vitest';
import { runStoreContract } from './_fakes/storeContract.js';
import { createFakeFolder } from './_fakes/fakeFolder.js';

import * as fsapi from '../js/storage/fsapi-adapter.js';
import * as guest from '../js/storage/guest-adapter.js';
import * as api from '../js/storage/api-adapter.js';

// ── guest: an in-memory Map, reset between tests ──────────────────────────
runStoreContract('guest', () => ({
  adapter: guest,
  handle: guest.GUEST_FOLDER,
  reset: () => guest.resetGuestMemory(),
}));

// ── fsapi: the fake directory handle ──────────────────────────────────────
runStoreContract('fsapi', () => {
  const { folder } = createFakeFolder();
  return { adapter: fsapi, handle: folder };
});

// ── api: a stubbed server holding one bundle in memory ────────────────────
//
// The cloud adapter speaks HTTP, so its contract run needs a server. This is
// the smallest one that behaves: it stores each collection under its kind,
// serves the whole bundle on GET, and bumps a version on every write, which
// is what the adapter's optimistic-concurrency check reads.
function stubServer() {
  const KIND = {
    'envelopes.json': 'envelopes',
    'budget-items.json': 'budgetItems',
    'transactions.json': 'transactions',
    'accounts.json': 'accounts',
    'envelope-templates.json': 'envelopeTemplates',
    'budget-meta.json': 'meta',
  };
  const store = {
    envelopes: null, budgetItems: null, transactions: null,
    accounts: null, envelopeTemplates: null, meta: null,
  };
  let version = 0;

  globalThis.fetch = vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    const reply = (status, payload) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: '',
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload ?? '')),
    });

    if (method === 'GET') {
      return reply(200, {
        version,
        // A collection never written is absent from the wire, exactly as it
        // would be on a fresh cloud budget.
        ...Object.fromEntries(Object.entries(store).filter(([, v]) => v !== null)),
      });
    }
    if (method === 'PUT' && u.includes('/batch')) {
      for (const item of body.items || []) store[item.kind] = item.data;
      version += 1;
      return reply(200, { version });
    }
    if (method === 'PUT') {
      const kind = u.split('/').pop().split('?')[0];
      store[kind] = body.data;
      version += 1;
      return reply(200, { version });
    }
    return reply(404);
  });

  return { kinds: KIND };
}

runStoreContract('api', () => {
  stubServer();
  api.setEncryptionKey(null);
  return { adapter: api, handle: { kind: 'cloud', budgetId: 'b1', version: 0 } };
}, {
  // `fileExists` answers honestly for meta only: the server seeds defaults
  // for the other blobs, so they are always "present", and callers that guard
  // on existence to decide whether to run the setup wizard must key on meta.
  // (js/storage/api-adapter.js:128.)
  fileExistsIsMetaOnly: true,
  // Reads come from a per-ref bundle cache, so two reads return the same
  // instance and a caller that mutates one changes what the next sees. The
  // app's own rule — never mutate a collection in place, return a new array
  // (AGENTS.md) — is what makes that safe; cloning the transactions blob on
  // every read would not be.
  readsAreCached: true,
});

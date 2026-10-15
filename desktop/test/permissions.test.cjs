const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installPermissions } = require('../main/permissions.cjs');
const { messages } = require('../main/strings.cjs');
const { ENTRY } = require('../main/assets.cjs');

test('native handles work for the app origin even with Chromium null WebContents; other capabilities stay denied', async () => {
  const handlers = {};
  const session = {
    setPermissionCheckHandler: fn => { handlers.check = fn; },
    setPermissionRequestHandler: fn => { handlers.request = fn; },
    on: (_event, fn) => { handlers.restricted = fn; },
  };
  let url = ENTRY;
  const webContents = { getURL: () => url };
  installPermissions(session, () => ({ webContents }));
  assert.equal(handlers.check(null, 'fileSystem', 'bunvelope://app/'), true);
  assert.equal(handlers.check(webContents, 'fileSystem', 'bunvelope://app/'), true);
  for (const permission of ['media', 'notifications', 'openExternal']) {
    assert.equal(handlers.check(webContents, permission, 'bunvelope://app/'), false);
  }
  assert.equal(handlers.check(null, 'fileSystem', 'https://untrusted.example'), false);
  assert.equal(handlers.check(null, 'fileSystem', 'bunvelope://app.evil/'), false);
  const request = () => new Promise(resolve => handlers.request(webContents, 'fileSystem', resolve, { requestingUrl: ENTRY }));
  assert.equal(await request(), true);
  url = 'https://untrusted.example';
  assert.equal(await request(), false);
  assert.equal(handlers.check(webContents, 'fileSystem', 'bunvelope://app/'), false);
  assert.equal(await new Promise(resolve => handlers.restricted(null, {}, resolve)), 'deny');
});

test('native strings have matching English, Finnish and Dutch keys', () => {
  for (const locale of ['fi', 'nl']) assert.deepEqual(Object.keys(messages[locale]).sort(), Object.keys(messages.en).sort());
});

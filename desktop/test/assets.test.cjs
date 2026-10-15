const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { assetPath, serveAsset, ENTRY } = require('../main/assets.cjs');

test('only public application assets can be served', () => {
  const root = path.resolve('/application');
  assert.equal(assetPath(ENTRY, root), path.join(root, 'index.html'));
  assert.equal(assetPath('bunvelope://app/js/app.js', root), path.join(root, 'js/app.js'));
  for (const url of [
    'file:///etc/passwd', 'bunvelope://evil/js/app.js',
    'bunvelope://app/server/auth.js', 'bunvelope://app/.env',
    'bunvelope://app/js/%2e%2e%2fserver/auth.js',
    'bunvelope://app/js/..%5cserver/auth.js', 'bunvelope://app/js/.secret',
    'bunvelope://app/budgets/personal/transactions.json',
  ]) assert.equal(assetPath(url, root), null, url);
});

test('serves modules with CSP, blocks mutations and escaped symlinks', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bv-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'js'));
  await fs.writeFile(path.join(root, 'js/app.js'), 'export const local = true;');
  const response = await serveAsset(new Request('bunvelope://app/js/app.js'), root);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await response.text(), /local = true/);
  assert.equal((await serveAsset(new Request(ENTRY, { method: 'POST' }), root)).status, 405);
  assert.equal((await serveAsset(new Request('bunvelope://app/js/%zz'), root)).status, 404);
  if (process.platform !== 'win32') {
    await fs.writeFile(path.join(root, '.env'), 'not public');
    await fs.symlink(path.join(root, '.env'), path.join(root, 'js/alias.js'));
    assert.equal((await serveAsset(new Request('bunvelope://app/js/alias.js'), root)).status, 404);
    await fs.symlink(os.tmpdir(), path.join(root, 'js/escape'));
    assert.equal((await serveAsset(new Request('bunvelope://app/js/escape/anything'), root)).status, 404);
  }
});

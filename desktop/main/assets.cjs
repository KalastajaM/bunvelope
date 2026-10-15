const path = require('node:path');
const fs = require('node:fs/promises');

const ORIGIN = 'bunvelope://app';
const ENTRY = `${ORIGIN}/index.html`;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};
// No server files, credentials, source-control metadata or arbitrary local paths.
function assetPath(url, root) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'bunvelope:' || parsed.hostname !== 'app' || parsed.port
      || parsed.username || parsed.password) return null;
  const pathname = decodeURIComponent(parsed.pathname);
  if (pathname.includes('\\') || pathname.includes('\0')) return null;
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (relative !== 'index.html' && !/^(js|css|fonts|budgets\/example-project)\//.test(relative)) return null;
  if (relative.split('/').some(part => part === '..' || part.startsWith('.'))) return null;
  const file = path.resolve(root, relative);
  return file.startsWith(path.resolve(root) + path.sep) ? file : null;
}

async function serveAsset(request, root) {
  try {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const file = assetPath(request.url, root);
    if (!file) return new Response(null, { status: 404 });
    // Refuse symlinks escaping the packaged/public asset tree in development too.
    const real = await fs.realpath(file);
    const realRoot = await fs.realpath(root);
    const expected = path.resolve(realRoot, path.relative(path.resolve(root), file));
    if (real !== expected) return new Response(null, { status: 404 });
    return new Response(await fs.readFile(real), { headers: {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self' https://api.anthropic.com; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'",
    } });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function isAppPage(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'bunvelope:' && parsed.host === 'app'
      && !parsed.username && !parsed.password
      && ['/', '/index.html'].includes(parsed.pathname);
  } catch { return false; }
}

module.exports = { ORIGIN, ENTRY, isAppPage, assetPath, serveAsset };

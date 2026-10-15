const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');

// Exercise the API used by the older downloader with its overridden proxy helper.
// The fake destination is intercepted locally; no external download is made.
test('builder downloader still forwards requests through its configured proxy', async t => {
  const requests = [];
  const proxy = http.createServer((req, res) => {
    requests.push(req.url);
    res.end('fixture-artifact');
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => proxy.close(resolve)));
  const source = `
    const { createRequire } = require('node:module');
    const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
    builderRequire('@electron/get').initializeProxy();
    require('node:http').get('http://download.invalid/electron.zip', res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => { process.stdout.write(text); });
    }).on('error', err => { console.error(err.message); process.exitCode = 1; });
  `;
  const child = spawn(process.execPath, ['-e', source], {
    cwd: require('node:path').resolve(__dirname, '..'),
    env: { ...process.env,
      GLOBAL_AGENT_HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`,
      GLOBAL_AGENT_NO_PROXY: 'localhost',
    },
    timeout: 10000,
  });
  let output = ''; let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject); child.on('close', resolve);
  });
  assert.equal(code, 0, errors);
  assert.equal(output, 'fixture-artifact');
  assert.deepEqual(requests, ['http://download.invalid/electron.zip']);
});

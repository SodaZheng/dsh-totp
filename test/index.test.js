import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply, Config } from '../src/index.js';

test('Cordis Config fills defaults and rejects invalid settings before creating state', async t => {
  const result = await Config['~standard'].validate({});
  assert.equal(result.issues, undefined);
  assert.equal(result.value.host, '127.0.0.1');
  assert.equal(result.value.port, 3080);
  assert.equal(result.value.idleMs, 900000);
  assert.equal(result.value.maxMs, 28800000);
  const dir = mkdtempSync(join(tmpdir(), 'dsh-totp-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dataDir = join(dir, 'must-not-exist');
  for (const value of [{ host: 'invalid-host' }, { port: -1 }, { port: 0.5 }, { port: 65536 },
    { idleMs: 0 }, { idleMs: 2000, maxMs: 1000 }, { maxMs: 86400001 }, { allowedHosts: ['https://example.com'] }]) {
    assert.ok((await Config['~standard'].validate(value)).issues, JSON.stringify(value));
    await assert.rejects(apply({}, { ...value, dataDir }));
    assert.equal(existsSync(dataDir), false);
  }
  assert.equal(Config({ port: 0 }).port, 0);
});

test('plugin startup authenticates locally, prints a credential-free entry and disposes its listener', { timeout: 10000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-totp-startup-'));
  const upstream = http.createServer((req, res) => {
    if (req.url === '/native-auth') {
      res.writeHead(303, { 'set-cookie': 'native=test-private-cookie; HttpOnly', location: '/' }); res.end();
    } else if (req.headers.cookie === 'native=test-private-cookie') {
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head></head><body>ready</body></html>');
    } else { res.writeHead(401); res.end(); }
  });
  let dispose;
  t.after(async () => {
    await dispose?.();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const output = [];
  t.mock.method(console, 'log', value => output.push(value));
  await apply({
    webServer: { host: '127.0.0.1', port: upstream.address().port, totpInternal: true },
    connection: { authenticatedUrl: url => new URL('/native-auth', url).href },
    settings: { get: () => undefined }, logger: { info() {} },
    effect: register => { dispose = register(); },
  }, { dataDir: dir, port: 0 });
  assert.equal(output.length, 1);
  assert.match(output[0], /^dsh-totp HTTP entry: http:\/\/127\.0\.0\.1:\d+\/$/);
  const entry = output[0].slice('dsh-totp HTTP entry: '.length);
  const page = await fetch(entry); assert.equal(page.status, 200); await page.text();
  assert.ok(existsSync(join(dir, 'control.json')));
  await dispose(); dispose = undefined;
  assert.equal(existsSync(join(dir, 'control.json')), false);
  await assert.rejects(fetch(entry, { signal: AbortSignal.timeout(1000) }));
});

test('plugin refuses an unprotected or externally bound upstream before initialization', async () => {
  for (const webServer of [{ host: '0.0.0.0', totpInternal: true }, { host: '127.0.0.1' }]) {
    await assert.rejects(apply({ webServer }), /internal-webserver provider; refusing to start/);
  }
});

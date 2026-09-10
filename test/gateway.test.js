import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { Store, hash } from '../src/core.js';
import { Gateway } from '../src/gateway.js';
import { Control, OwnerLease } from '../src/control.js';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-totp-gateway-'));
  let now = 1800000000000;
  const clock = () => now, store = new Store(dir, { clock });
  const received = [], nativeCookie = 'native-session=test-upstream-only';
  const upstream = http.createServer((req, res) => {
    received.push({ path: req.url, headers: req.headers });
    if (req.headers.cookie !== nativeCookie) { res.writeHead(401); res.end(); return; }
    res.setHeader('set-cookie', nativeCookie);
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<html><head></head><body>DSH fixture</body></html>'); }
    else if (req.url.startsWith('/assets/')) { res.setHeader('content-type', 'text/javascript'); res.end('/* asset */'); }
    else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); }
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (ws, req) => {
    received.push({ path: req.url, headers: req.headers });
    ws.on('message', (data, binary) => ws.send(data, { binary }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = new Gateway({ store, port: 0, clock,
    upstream: `http://127.0.0.1:${upstream.address().port}`, authenticate: async () => nativeCookie });
  const clients = new Set();
  t.after(async () => {
    for (const client of clients) client.terminate();
    await gateway.close();
    for (const client of wss.clients) client.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  await gateway.start();
  const origin = `http://127.0.0.1:${gateway.port}`;
  async function request(path, { key, data, headers = {}, method = data === undefined ? 'GET' : 'POST' } = {}) {
    // node:http preserves explicit Host headers, unlike fetch's managed Host.
    return new Promise((resolve, reject) => {
      const req = http.request(origin + path, { method, headers: {
        origin, ...(data === undefined ? {} : { 'content-type': 'application/json' }),
        ...(key ? { 'x-dsh-totp': key } : {}), ...headers,
      }, signal: AbortSignal.timeout(5000) }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString(), resultHeaders = new Headers();
          for (const [name, values] of Object.entries(response.headers)) {
            for (const value of Array.isArray(values) ? values : [values]) if (value !== undefined) resultHeaders.append(name, value);
          }
          resolve({ status: response.statusCode, headers: resultHeaders, text,
            data: resultHeaders.get('content-type')?.includes('application/json') ? JSON.parse(text) : null });
        });
      });
      req.on('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
    });
  }
  const api = (path, key, data = {}) => request('/_totp/' + path, { key, data });
  async function guest() { const r = await api('verify'); assert.equal(r.status, 200); return { key: r.data.key, cookie: r.headers.get('set-cookie').split(';')[0] }; }
  async function enroll(key, code) {
    const begin = await api('enroll/begin', key, { code });
    assert.equal(begin.status, 200); assert.match(begin.data.qr, /^data:image\/png;base64,/);
    // Inspect the generated seed only inside the isolated fixture, never log it.
    const secret = gateway.enrollment.pending.get(hash(begin.data.id)).secret;
    const confirm = await api('enroll/confirm', key, { id: begin.data.id, code: store.otp(secret).generate({ timestamp: now }) });
    assert.equal(confirm.status, 200);
    return { ...confirm.data, secret };
  }
  function socket(key, headers = {}) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + '/api/events', key ? ['dsh-totp', 'dsh-totp.auth.' + key] : [], { origin, headers });
    clients.add(ws); ws.on('error', () => {}); return ws;
  }
  return { dir, store, gateway, origin, received, nativeCookie, request, api, guest, enroll, socket,
    advance(ms = 30000) { now += ms; }, code(secret) { return store.otp(secret).generate({ timestamp: now }); } };
}

test('enrollment keeps its page, protects HTTP and WebSocket data, and lock-all revokes every capability', { timeout: 15000 }, async t => {
  const f = await fixture(t), a = await f.guest(), b = await f.guest();
  const enrolled = await f.enroll(a.key);
  assert.equal(enrolled.key, a.key);
  assert.equal(enrolled.codes.length, 10);
  assert.equal((await f.api('status', a.key)).status, 200);
  assert.equal((await f.api('status', b.key)).status, 401);
  const blocked = await f.request('/api/private');
  assert.equal(blocked.status, 401); assert.equal(blocked.headers.get('x-dsh-totp-locked'), '1');
  const allowed = await f.request('/api/private', { key: a.key });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers.get('set-cookie'), null);
  assert.equal((await f.request('/assets/test.js', { headers: { cookie: a.cookie } })).status, 200);
  assert.equal((await f.request('/api/private', { headers: { cookie: a.cookie } })).status, 401);
  const boot = await f.api('bootstrap', a.key);
  assert.equal(boot.status, 200); assert.ok(boot.text.includes('browserRuntime')); assert.ok(!boot.text.includes(f.nativeCookie));
  assert.equal((await f.api('bootstrap', a.key)).status, 401);
  const deniedWS = f.socket();
  const [, rejection] = await once(deniedWS, 'unexpected-response');
  rejection.resume(); deniedWS.terminate(); assert.equal(rejection.statusCode, 401);
  const ws = f.socket(a.key); await once(ws, 'open');
  const message = once(ws, 'message'); ws.send('echo'); assert.equal(String((await message)[0]), 'echo');
  const resource = await f.api('resource', a.key, { path: '/api/image?id=1' });
  assert.equal((await f.request(resource.data.url)).status, 200);
  assert.equal((await f.request(resource.data.url.replace('id=1', 'id=2'))).status, 401);
  const closed = once(ws, 'close');
  assert.equal((await f.api('lock', a.key)).status, 200);
  assert.equal((await closed)[0], 4001);
  assert.equal((await f.request('/api/private', { key: a.key })).status, 401);
  assert.equal((await f.request(resource.data.url)).status, 401);
  assert.equal((await f.request('/assets/test.js', { headers: { cookie: a.cookie } })).status, 401);
  f.advance();
  const login = await f.api('verify', undefined, { code: f.code(enrolled.secret) });
  assert.equal(login.status, 200);
  assert.equal((await f.request('/api/private', { key: login.data.key })).status, 200);
});

test('recovery permits only re-enrollment until a new authenticator is confirmed', { timeout: 10000 }, async t => {
  const f = await fixture(t), page = await f.guest(), enrolled = await f.enroll(page.key);
  const recovery = await f.api('recovery', undefined, { code: enrolled.codes[0] });
  assert.equal(recovery.status, 200);
  assert.equal((await f.api('status', page.key)).status, 401);
  assert.equal((await f.request('/api/private', { key: recovery.data.key })).status, 401);
  assert.equal((await f.api('bootstrap', recovery.data.key)).status, 401);
  const replacement = await f.enroll(recovery.data.key);
  assert.notEqual(replacement.key, recovery.data.key);
  assert.equal((await f.api('bootstrap', replacement.key)).status, 200);
  assert.equal((await f.api('recovery', undefined, { code: enrolled.codes[1] })).status, 401);
});

test('protection toggles require a fresh code and revoke old pages; disabled lock does not enable protection', { timeout: 10000 }, async t => {
  const f = await fixture(t), page = await f.guest(), enrolled = await f.enroll(page.key);
  f.advance();
  assert.equal((await f.api('protection', page.key, { enabled: false, code: f.code(enrolled.secret), revision: enrolled.revision })).status, 200);
  assert.equal((await f.request('/api/private')).status, 200);
  assert.equal((await f.api('status', page.key)).status, 401);
  const guest = await f.guest();
  const lock = await f.api('lock', guest.key);
  assert.equal(lock.status, 409); assert.equal(lock.data.code, 'PROTECTION_DISABLED');
  assert.equal(f.store.status().enabled, false);
  f.advance();
  assert.equal((await f.api('protection', guest.key, { enabled: true, code: f.code(enrolled.secret), revision: f.store.status().revision })).status, 200);
  assert.equal((await f.request('/api/private')).status, 401);
});

test('host and origin checks reject cross-site requests; the proxy strips client credentials', { timeout: 10000 }, async t => {
  const f = await fixture(t), page = await f.guest();
  assert.equal((await f.request('/_totp/verify', { data: {}, headers: { origin: 'http://attacker.invalid' } })).status, 403);
  assert.equal((await f.request('/api/private', { headers: { host: 'attacker.invalid' } })).status, 403);
  assert.equal((await f.request('/api/private', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  await f.request('/api/private', { key: page.key, headers: { authorization: 'Bearer browser-only', cookie: 'browser-only=1', forwarded: 'for=attacker', 'x-forwarded-for': 'attacker' } });
  const upstream = f.received.at(-1).headers;
  assert.equal(upstream.cookie, f.nativeCookie);
  for (const name of ['authorization', 'x-dsh-totp', 'forwarded', 'x-forwarded-for']) assert.equal(upstream[name], undefined);
  assert.equal(f.gateway.failed, false);
});

test('enrollment belongs to one page and expires after five minutes', { timeout: 10000 }, async t => {
  const f = await fixture(t), a = await f.guest(), b = await f.guest();
  const begin = await f.api('enroll/begin', a.key), id = begin.data.id;
  const secret = f.gateway.enrollment.pending.get(hash(id)).secret;
  assert.equal((await f.api('enroll/confirm', b.key, { id, code: f.code(secret) })).status, 401);
  f.advance(300000);
  assert.equal((await f.api('enroll/confirm', a.key, { id, code: f.code(secret) })).status, 401);
  assert.equal(f.store.status().enabled, false);
});

test('local control requires its separate key and owner lease; state corruption closes access', { timeout: 10000 }, async t => {
  const f = await fixture(t), lease = new OwnerLease(f.dir), control = new Control(f.store, f.gateway);
  try {
    await control.start();
    assert.throws(() => new OwnerLease(f.dir), /已有管理进程/);
    assert.equal((await f.api('control/status')).status, 401);
    const status = await f.request('/_totp/control/status', { data: {}, headers: { 'x-dsh-totp-control': control.key } });
    assert.equal(status.status, 200);
    assert.equal((await f.request('/api/private')).status, 200);
    f.store.db.prepare('UPDATE state SET data=? WHERE id=1').run('corrupt');
    assert.equal((await f.request('/api/private')).status, 503);
    assert.equal(f.gateway.failed, true);
    assert.equal((await f.request('/')).status, 503);
  } finally { await control.close(); lease.close(); }
});

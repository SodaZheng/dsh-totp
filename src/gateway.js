import http from 'node:http';
import { networkInterfaces } from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import { GateError, Sessions, token, hash } from './core.js';
import { portal, runtimeScript } from './ui.js';
import { Enrollment } from './enrollment.js';

export function secureHeaders(res) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', "base-uri 'self'; frame-ancestors 'none'; object-src 'none'");
}
export function json(res, value, status = 200) { secureHeaders(res); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
export async function body(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new GateError('仅接受 JSON 请求', 415);
  let size = 0; const chunks = [];
  for await (const part of req) { size += part.length; if (size > 4096) throw new GateError('请求过大', 413); chunks.push(part); }
  try { const v = JSON.parse(Buffer.concat(chunks).toString()); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; }
  catch { throw new GateError('无效请求'); }
}
export function authority(value) {
  if (typeof value !== 'string' || /[\s/@\\?#]/.test(value)) throw new GateError('无效访问地址', 403);
  try { const u = new URL('http://' + value); return u.host; } catch { throw new GateError('无效访问地址', 403); }
}
export function sameOrigin(req, host, required = false) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new GateError('拒绝跨站请求', 403);
  if (required && !req.headers.origin) throw new GateError('请求缺少来源', 403);
  if (req.headers.origin !== undefined && req.headers.origin !== 'http://' + host) throw new GateError('拒绝跨站请求', 403);
}
const extractKey = req => typeof req.headers['x-dsh-totp'] === 'string' ? req.headers['x-dsh-totp'] : undefined;
const assetCookie = req => req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('dsh-totp-assets='))?.slice(16);
const isAsset = url => /^\/assets\/[A-Za-z0-9_./-]+\.(js|css|woff2?|ttf|wasm|svg|png|ico)$/.test(url.pathname)
  || (url.pathname === '/plugins/' && /^\?\?[@A-Za-z0-9_./,-]+\/client\.js(?:\.map)?&rev=[a-f0-9-]+$/.test(url.search))
  || url.pathname === '/favicon.ico';

export class Gateway {
  constructor({ store, host = '127.0.0.1', port = 3080, allowedHosts = [], upstream, authenticate, clock = Date.now, idleMs, maxMs, theme = () => 'system' }) {
    if (!Number.isInteger(port) || port < 0 || port > 65535 || !Array.isArray(allowedHosts) || allowedHosts.some(h => typeof h !== 'string')) throw new Error('Invalid gateway configuration');
    this.store = store; this.host = host; this.port = port; this.configuredHosts = allowedHosts;
    for (const value of allowedHosts) authority(value);
    this.upstream = new URL(upstream);
    if (this.upstream.protocol !== 'http:' || this.upstream.hostname !== '127.0.0.1' || this.upstream.username || this.upstream.password) throw new Error('DSH upstream must be a fixed loopback HTTP endpoint');
    this.authenticate = authenticate; this.clock = clock;
    this.sessions = new Sessions(store, { clock, idleMs, maxMs });
    this.enrollment = new Enrollment(store, clock); this.theme = theme;
    this.leases = new Map(); this.streams = new Set(); this.sockets = new Map(); this.booted = new Set(); this.failed = false;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false,
      handleProtocols: protocols => [...protocols].find(p => p !== 'dsh-totp' && !p.startsWith('dsh-totp.auth.')) || 'dsh-totp' });
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch(error => {
        if (!(error instanceof GateError)) this.fail();
        if (res.headersSent) res.destroy();
        else {
          if (error.status === 429 && error.retryAfterSeconds) res.setHeader('retry-after', String(error.retryAfterSeconds));
          json(res, { error: error instanceof GateError ? error.message : '访问验证暂不可用', ...(error instanceof GateError ? { code: error.code, retryAfterSeconds: error.retryAfterSeconds } : {}) }, error instanceof GateError ? error.status : 503);
        }
      });
    });
    this.server.headersTimeout = 15000; this.server.requestTimeout = 60000; this.server.maxHeadersCount = 64;
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head));
    this.server.on('clientError', (_err, socket) => socket.destroy());
  }
  async start() {
    this.cookie = await this.authenticate();
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, this.host, resolve); });
    this.port = this.server.address().port;
    this.allowed = new Set(['127.0.0.1', 'localhost', ...(this.host === '::' ? ['[::1]'] : [])].map(h => authority(`${h}:${this.port}`)));
    for (const values of Object.values(networkInterfaces())) for (const entry of values || []) {
      if (entry.family === 'IPv4') this.allowed.add(authority(`${entry.address}:${this.port}`));
    }
    for (const value of this.configuredHosts) {
      const raw = authority(value); this.allowed.add(raw);
      if (!new URL('http://' + value).port && !value.endsWith(':80')) this.allowed.add(authority(`${value}:${this.port}`));
    }
    this.timer = setInterval(() => {
      try {
        this.sessions.prune();
        for (const k of this.booted) if (!this.sessions.items.has(k)) this.booted.delete(k);
        for (const [ws, auth] of this.sockets) if (!this.valid(auth.key, auth.host)) { ws.close(4001, 'Locked'); this.terminateSoon(ws); }
        for (const stream of this.streams) if (stream.auth && !this.valid(stream.auth.key, stream.auth.host)) { stream.req.destroy(); stream.res.destroy(); }
        for (const [k, v] of this.leases) if (v.until <= this.clock() || !this.valid(v.key, v.host)) this.leases.delete(k);
      } catch { this.fail(); }
    }, 1000); this.timer.unref();
    return this;
  }
  fail() { this.failed = true; this.revoke(); }
  revoke(keepKey) {
    if (keepKey) this.sessions.retainPage(keepKey); else this.sessions.revoke();
    for (const [id, lease] of this.leases) if (!keepKey || lease.key !== keepKey) this.leases.delete(id);
    for (const id of this.booted) if (!keepKey || id !== hash(keepKey)) this.booted.delete(id);
    this.enrollment.revoke();
    for (const [socket, auth] of this.sockets) if (!keepKey || auth.key !== keepKey) { socket.close(4001, 'Locked'); this.terminateSoon(socket); }
    for (const stream of this.streams) if (!keepKey || stream.auth?.key !== keepKey) { stream.req.destroy(); stream.res.destroy(); }
  }
  leave(key) {
    this.sessions.items.delete(hash(key)); this.booted.delete(hash(key));
    for (const [ws, s] of this.sockets) if (s.key === key) { ws.close(4001, 'Locked'); this.terminateSoon(ws); }
    for (const stream of this.streams) if (stream.auth?.key === key) { stream.req.destroy(); stream.res.destroy(); }
    for (const [t, lease] of this.leases) if (lease.key === key) this.leases.delete(t);
  }
  terminateSoon(ws) { const timer = setTimeout(() => ws.terminate(), 100); timer.unref(); }
  transition(fn, keepKey) { try { const value = fn(); this.revoke(keepKey); return value; } catch(e) { if (!(e instanceof GateError)) this.fail(); throw e; } }
  valid(key, host, kinds = ['page', 'guest', 'admin']) {
    if (this.failed) return null;
    try { return this.sessions.get(key, host, kinds); } catch { this.fail(); return null; }
  }
  checkRevision(revision) {
    if (this.failed) return false;
    try { return revision === this.store.status().revision; } catch { this.fail(); return false; }
  }
  require(req, host, admin = false) {
    const key = extractKey(req), auth = this.valid(key, host, admin ? ['page', 'admin'] : ['page', 'guest', 'admin']);
    if (!auth) throw new GateError('页面已锁定，请重新验证', 401); return { key, host, ...auth };
  }
  async handle(req, res) {
    secureHeaders(res);
    if (this.failed) throw new GateError('访问验证暂不可用', 503);
    const host = authority(req.headers.host);
    if (!this.allowed.has(host)) throw new GateError('访问地址未配置，请在 allowedHosts 中添加', 403);
    sameOrigin(req, host);
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new GateError('无效路径');
    const url = new URL(req.url, 'http://' + host), state = this.store.status();
    if (url.pathname === '/' && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(req.method === 'HEAD' ? '' : portal(state, this.theme())); return;
    }
    if (url.pathname.startsWith('/_totp/')) {
      if (req.method !== 'POST') throw new GateError('请求方法不支持', 405);
      const route = url.pathname.slice(7);
      if (route.startsWith('control/')) {
        await body(req);
        if (!this.control) throw new GateError('本机管理暂不可用', 503);
        this.control.handle(req, res, route.slice(8), host); return;
      }
      sameOrigin(req, host, true); const input = await body(req);
      if (route === 'verify') {
        // Re-read after the async body to avoid a racing policy change.
        const now = this.store.status(); let kind = 'guest';
        if (now.enabled || input.code) { this.store.authenticate(req.socket.remoteAddress, () => this.store.verify(input.code)); kind = 'page'; }
        json(res, { key: this.createPage(req, res, host, kind) }); return;
      }
      if (route === 'recovery') {
        this.transition(() => this.store.authenticate(req.socket.remoteAddress, () => this.store.recover(input.code)));
        const key = this.sessions.create('recovery', host); this.sessions.items.get(hash(key)).until = this.clock() + 300000;
        json(res, { key }); return;
      }
      if (route.startsWith('enroll/')) {
        // An unprotected page may initiate a step-up operation. Enrollment.begin
        // still requires current TOTP before it issues the session-bound pending id.
        const key = extractKey(req), session = this.valid(key, host, ['page', 'guest', 'admin', 'recovery']);
        if (!session) throw new GateError('绑定授权无效或已过期', 401);
        const auth = { ...session, key, host };
        if (route === 'enroll/begin') {
          const result = await this.enrollment.begin(auth, input.code, req.socket.remoteAddress);
          if (!this.valid(key, host, ['page', 'guest', 'admin', 'recovery'])) throw new GateError('绑定授权已失效', 401);
          json(res, result); return;
        }
        if (route === 'enroll/confirm') {
          const keepKey = auth.kind === 'recovery' ? undefined : key;
          const codes = this.transition(() => this.enrollment.confirm(auth, input.id, input.code, req.socket.remoteAddress), keepKey);
          // Recovery alone cannot enter DSH. A confirmed new TOTP grants a fresh page.
          const pageKey = keepKey || this.createPage(req, res, host, 'page');
          json(res, { codes, key: pageKey, ...this.store.status() }); return;
        }
        if (route === 'enroll/cancel') { this.enrollment.cancel(auth); json(res, { ok: true }); return; }
        throw new GateError('接口不存在', 404);
      }
      const auth = this.require(req, host);
      if (route === 'bootstrap') {
        if (this.booted.has(hash(auth.key))) throw new GateError('启动凭据已使用，请重新验证', 401);
        this.booted.add(hash(auth.key));
        const html = await this.getIndex();
        if (!this.valid(auth.key, host)) throw new GateError('页面已锁定', 401);
        const current = this.store.status();
        const script = `<script>${runtimeScript(auth.key, current.revision, auth.kind !== 'guest', current.enabled, current.bound)}</script>`;
        if (!/<head[\s>]/i.test(html)) throw new GateError('DSH 页面格式不兼容', 503);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html.replace(/(<head[^>]*>)/i, '$1' + script)); return;
      }
      if (route === 'status') { json(res, { ...this.store.status(), pages: [...this.sessions.items.values()].filter(s => s.kind === 'page').length }); return; }
      if (route === 'touch') { this.sessions.get(auth.key, host, ['page', 'guest', 'admin'], true); json(res, { ok: true }); return; }
      if (route === 'leave') { this.leave(auth.key); json(res, { ok: true }); return; }
      if (route === 'lock') {
        // Re-read after the request body: locking never enables protection for an open page.
        const current = this.store.status();
        if (!current.bound) throw new GateError('请先在设置页绑定验证器', 409, { code: 'NOT_ENROLLED' });
        if (!current.enabled) throw new GateError('访问保护未开启，请先到设置 → 访问验证开启保护', 409, { code: 'PROTECTION_DISABLED' });
        this.transition(() => this.store.change(true, { local: true })); json(res, { ok: true }); return;
      }
      if (route === 'protection') {
        if (typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.revision)) throw new GateError('无效设置');
        this.transition(() => this.store.authenticate(req.socket.remoteAddress, () => this.store.change(input.enabled, { code: input.code, expectedRevision: input.revision }))); json(res, { ok: true }); return;
      }
      // Fresh TOTP authorizes this specific mutation, including when protection
      // is off. It does not promote a guest page to a general admin session.
      if (route === 'recovery-codes') { json(res, { codes: this.store.authenticate(req.socket.remoteAddress, () => this.store.recoveryCodes(input.code)) }); return; }
      if (route === 'resource') {
        if (typeof input.path !== 'string' || !input.path.startsWith('/api/') || input.path.length > 2048) throw new GateError('无效资源');
        const resource = new URL(input.path, 'http://' + host);
        if (resource.origin !== 'http://' + host || resource.searchParams.has('_totp_resource')) throw new GateError('无效资源');
        if (this.leases.size >= 1024) throw new GateError('资源请求过多', 429);
        const t = token(); this.leases.set(hash(t), { key: auth.key, host, path: resource.pathname + resource.search, until: this.clock() + 60000 });
        resource.searchParams.set('_totp_resource', t); json(res, { url: resource.pathname + resource.search }); return;
      }
      throw new GateError('接口不存在', 404);
    }
    let auth = this.valid(extractKey(req), host) ? { key: extractKey(req), host } : null;
    if (url.searchParams.has('_totp_resource')) {
      if (url.searchParams.getAll('_totp_resource').length !== 1 || !['GET', 'HEAD'].includes(req.method)) throw new GateError('无效资源票据', 401);
      const lease = this.leases.get(hash(url.searchParams.get('_totp_resource'))); url.searchParams.delete('_totp_resource');
      if (!lease || lease.host !== host || lease.until <= this.clock() || lease.path !== url.pathname + url.search || !this.valid(lease.key, host)) throw new GateError('资源票据失效', 401);
      auth = { key: lease.key, host };
    }
    // Cookies are a distinct capability for compiled static assets, never API data.
    let asset = false;
    if (isAsset(url) && ['GET', 'HEAD'].includes(req.method)) {
      const cookie = assetCookie(req);
      asset = !!this.sessions.get(cookie, host, ['asset']);
    }
    if (state.enabled && !auth && !asset) { res.setHeader('x-dsh-totp-locked', '1'); throw new GateError('请先输入动态码', 401); }
    // App navigation must consume bootstrap; neither a cookie nor a data key gets index.html.
    if (url.pathname.endsWith('.html') || url.pathname === '/index') throw new GateError('请从首页进入', 401);
    await this.proxy(req, res, url.pathname + url.search, auth);
  }
  createPage(req, res, host, kind) {
    const key = this.sessions.create(kind, host);
    const previous = assetCookie(req);
    const asset = this.sessions.get(previous, host, ['asset']) ? previous : this.sessions.create('asset', host);
    this.sessions.items.get(hash(key)).asset = hash(asset);
    res.setHeader('set-cookie', `dsh-totp-assets=${asset}; Path=/; HttpOnly; SameSite=Strict`);
    return key;
  }
  async getIndex() {
    const read = async () => fetch(this.upstream, { headers: { cookie: this.cookie, 'accept-encoding': 'identity' }, redirect: 'manual' });
    let r = await read(); if (r.status === 401) { this.cookie = await this.authenticate(); r = await read(); }
    if (!r.ok) throw new GateError('DSH 暂不可用', 503);
    return r.text();
  }
  proxy(req, res, path, auth) {
    return new Promise(resolve => {
      const revision = this.store.status().revision;
      const headers = { ...req.headers, host: this.upstream.host, cookie: this.cookie, 'accept-encoding': 'identity' };
      delete headers['x-dsh-totp']; delete headers['forwarded']; delete headers['authorization'];
      for (const k of Object.keys(headers)) if (k.startsWith('x-forwarded-')) delete headers[k];
      if (headers.origin) headers.origin = this.upstream.origin;
      delete headers.referer;
      const upstream = http.request(new URL(path, this.upstream), { method: req.method, headers }, response => {
        if (!(auth ? this.valid(auth.key, auth.host) : this.checkRevision(revision))) { upstream.destroy(); res.destroy(); return; }
        const hs = { ...response.headers }; delete hs['set-cookie']; delete hs['content-security-policy']; delete hs['cache-control'];
        // Unknown SPA fallback documents cannot be used to skip entry verification.
        if (String(hs['content-type']).includes('text/html') && !String(hs['content-disposition']).toLowerCase().startsWith('attachment')) { response.resume(); json(res, { error: '请从首页进入' }, 401); return; }
        if (hs.location) { response.resume(); json(res, { error: '不支持上游重定向' }, 502); return; }
        res.writeHead(response.statusCode, hs); response.pipe(res);
      });
      const stream = { req: upstream, res, auth }; this.streams.add(stream);
      const done = () => { this.streams.delete(stream); resolve(); };
      res.once('close', () => { upstream.destroy(); done(); }); res.once('finish', done);
      upstream.once('error', () => { if (!res.headersSent) json(res, { error: 'DSH 暂不可用' }, 502); else res.destroy(); done(); });
      req.once('aborted', () => upstream.destroy()); req.pipe(upstream);
    });
  }
  upgrade(req, socket, head) {
    try {
      if (this.failed) throw new GateError('Unavailable', 503);
      const host = authority(req.headers.host);
      if (!this.allowed.has(host)) throw new GateError('Forbidden', 403);
      sameOrigin(req, host, true);
      if (!req.url?.startsWith('/api/') || req.url.startsWith('//')) throw new GateError('Not found', 404);
      const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map(x => x.trim()).filter(Boolean);
      const keys = protocols.filter(p => p.startsWith('dsh-totp.auth.')).map(p => p.slice(14));
      if (keys.length !== 1 || !this.valid(keys[0], host)) throw new GateError('Unauthorized', 401);
      const key = keys[0];
      this.wss.handleUpgrade(req, socket, head, client => {
        this.sockets.set(client, { key, host });
        const upstreamUrl = new URL(req.url, this.upstream); upstreamUrl.protocol = 'ws:';
        const original = protocols.filter(p => p !== 'dsh-totp' && !p.startsWith('dsh-totp.auth.'));
        const backend = new WebSocket(upstreamUrl, original, { headers: { cookie: this.cookie, origin: this.upstream.origin }, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
        const waiting = []; let waitingBytes = 0;
        const live = () => !!this.valid(key, host);
        backend.on('open', () => { if (!live()) { backend.terminate(); return; } for (const [data, binary] of waiting) backend.send(data, { binary }); waiting.length = 0; });
        client.on('message', (data, binary) => {
          if (!live()) { client.close(4001, 'Locked'); return; }
          if (backend.readyState === WebSocket.OPEN) backend.send(data, { binary });
          else if (backend.readyState === WebSocket.CONNECTING && (waitingBytes += data.length) <= 1024 * 1024) waiting.push([data, binary]);
          else client.close(1009, 'Limit');
        });
        backend.on('message', (data, binary) => { if (live() && client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
        client.on('close', () => { this.sockets.delete(client); backend.terminate(); });
        backend.on('close', () => { if (client.readyState === WebSocket.OPEN) client.close(1012, 'Reconnect'); });
        client.on('error', () => backend.terminate()); backend.on('error', () => client.close(1011, 'Upstream unavailable'));
      });
    } catch(e) {
      const status = e instanceof GateError ? e.status : 503;
      if (!(e instanceof GateError)) this.fail();
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  }
  async close() {
    clearInterval(this.timer); this.failed = true; this.revoke();
    for (const [ws] of this.sockets) ws.terminate();
    this.wss.close();
    await new Promise(resolve => { this.server.close(resolve); this.server.closeAllConnections(); });
  }
}

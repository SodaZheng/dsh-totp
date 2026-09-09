import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { writeFileSync, readFileSync, unlinkSync, chmodSync } from 'node:fs';
import { GateError, token, equal } from './core.js';
import { json } from './gateway.js';

export class OwnerLease {
  constructor(dir) {
    this.db = new DatabaseSync(join(dir, 'owner.sqlite'));
    try { this.db.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN IMMEDIATE;'); }
    catch { this.db.close(); throw new Error('此实例已有管理进程，请使用运行中实例的控制接口'); }
    if (process.platform !== 'win32') chmodSync(join(dir, 'owner.sqlite'), 0o600);
  }
  close() { this.db.exec('ROLLBACK'); this.db.close(); }
}

export class Control {
  constructor(store, gateway) {
    this.store = store; this.gateway = gateway; this.key = token();
  }
  async start() {
    if (!this.gateway?.server.listening) throw new Error('DSH must be running to provide management');
    this.url = 'http://' + (this.gateway.host === '::' || this.gateway.host === '::1' ? '[::1]' : '127.0.0.1') + ':' + this.gateway.port;
    this.gateway.control = this;
    this.path = join(this.store.dir, 'control.json');
    writeFileSync(this.path, JSON.stringify({ url: this.url, key: this.key, pid: process.pid }), { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(this.path, 0o600);
    return this;
  }
  handle(req, res, action, host) {
    const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const hostname = new URL('http://' + host).hostname;
    if (!local || !['127.0.0.1', 'localhost', '[::1]'].includes(hostname) || !equal(req.headers['x-dsh-totp-control'], this.key)) throw new GateError('本机管理授权无效', 401);
    if (action === 'status') { json(res, { ...this.store.status(), gateway: { host: this.gateway.host, port: this.gateway.port, failed: this.gateway.failed } }); return; }
    if (['enable', 'disable', 'lock'].includes(action)) { this.gateway.transition(() => this.store.change(action !== 'disable', { local: true })); json(res, { ok: true }); return; }
    throw new GateError('接口不存在', 404);
  }
  async close() {
    if (this.gateway.control === this) this.gateway.control = null;
    try { const record = JSON.parse(readFileSync(this.path, 'utf8')); if (record.key === this.key) unlinkSync(this.path); } catch { /* Already removed. */ }
    this.key = '';
  }
}

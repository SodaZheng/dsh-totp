import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { TOTP, Secret } from 'otpauth';
import { normalizeOtp } from './otp-input.js';

export const token = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const dataPath = () => resolve(process.env.DSH_TOTP_DATA_DIR || join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'dsh-totp'));
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export class GateError extends Error {
  constructor(message, status = 400, details = {}) { super(message); this.status = status; Object.assign(this, details); }
}
export function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error('State directory must not be a symbolic link');
  if (process.platform !== 'win32') chmodSync(dir, 0o700);
  else {
    // Build the ACL from scratch: inherited broad permissions must not expose seeds.
    const script = `$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); $acl.SetOwner($sid); $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $env:DSH_TOTP_ACL_DIR -AclObject $acl -ErrorAction Stop`;
    const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, env: { ...process.env, DSH_TOTP_ACL_DIR: dir }, stdio: 'pipe' });
    if (result.status !== 0) throw new Error('Cannot restrict state-directory ACL; refusing startup');
  }
}
export function privateFile(path, content) {
  writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
}

/** SQLite is the sole authority. The separate OwnerLease serializes live owners. */
export class Store {
  constructor(dir, { clock = Date.now } = {}) {
    this.dir = resolve(dir); this.clock = clock;
    privateDir(this.dir);
    const keyPath = join(this.dir, 'master.key'), dbPath = join(this.dir, 'state.sqlite');
    const existingDatabase = existsSync(dbPath);
    for (const p of [keyPath, dbPath]) if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('Symbolic state files are refused');
    if (!existsSync(keyPath)) {
      if (existsSync(dbPath)) throw new Error('Encryption key missing; refusing to reset existing state');
      privateFile(keyPath, randomBytes(32));
    }
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw new Error('Invalid encryption key');
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS used (generation INTEGER NOT NULL, step INTEGER NOT NULL, PRIMARY KEY(generation, step));
      CREATE TABLE IF NOT EXISTS attempts (source TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS verification_failures (source TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL);`);
    if (process.platform !== 'win32') { chmodSync(dbPath, 0o600); chmodSync(keyPath, 0o600); }
    if (existingDatabase && !this.db.prepare('SELECT id FROM state WHERE id=1').get()) {
      this.db.close(); this.key.fill(0); throw new Error('Existing TOTP state record is missing; refusing to apply fresh-install defaults');
    }
    this.db.prepare('INSERT OR IGNORE INTO state VALUES (1, ?)').run(JSON.stringify({ version: 1, enabled: false, revision: 0, generation: 0, secret: null, recovery: [], lastStep: -1 }));
    this.read();
  }
  seal(text) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const value = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), value]).toString('base64');
  }
  unseal(text) {
    const raw = Buffer.from(text, 'base64'), decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
  read() {
    const s = JSON.parse(this.db.prepare('SELECT data FROM state WHERE id=1').get().data);
    if (s.version !== 1 || typeof s.enabled !== 'boolean' || !Number.isSafeInteger(s.revision) || !Number.isSafeInteger(s.generation) || !Number.isSafeInteger(s.lastStep) || !Array.isArray(s.recovery) || !(s.secret === null || typeof s.secret === 'string')) throw new Error('Invalid TOTP state; refusing access');
    if (s.secret) this.unseal(s.secret);
    return s;
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const s = this.read(), result = fn(s);
      this.db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(s));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  status() { const s = this.read(); return { bound: !!s.secret, enabled: s.enabled, revision: s.revision }; }
  otp(secret) { return new TOTP({ issuer: 'DSH', label: 'dsh-totp', algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) }); }
  consume(s, code) {
    if (!s.secret) throw new GateError('尚未绑定验证器', 409, { code: 'NOT_ENROLLED' });
    code = normalizeOtp(code);
    if (!/^\d{6}$/.test(code)) throw new GateError('请输入 6 位数字动态码', 400, { code: 'OTP_FORMAT' });
    const now = this.clock(), step = Math.floor(now / 30000);
    const delta = this.otp(this.unseal(s.secret)).validate({ token: code, timestamp: now, window: 1 });
    if (delta === null) throw new GateError('动态码不匹配或已过期，请确认使用的是当前绑定的验证器，并检查手机时间', 401, { code: 'OTP_INVALID' });
    if (step + delta <= s.lastStep) throw new GateError('此动态码已使用，请等待验证器刷新后输入新码', 409, {
      code: 'OTP_REUSED', retryAfterSeconds: Math.max(1, Math.ceil((Math.max(step + 1, s.lastStep) * 30000 - now) / 1000)),
    });
    s.lastStep = step + delta;
    this.db.prepare('INSERT INTO used VALUES (?, ?)').run(s.generation, s.lastStep);
  }
  verify(code) { return this.transaction(s => { this.consume(s, code); return s.revision; }); }
  enroll(secret, code, expectedRevision) {
    return this.transaction(s => {
      if (s.revision !== expectedRevision) throw new GateError('绑定状态已变化，请重新发起', 409);
      s.secret = this.seal(secret); s.lastStep = -1; s.generation++;
      this.consume(s, code); s.enabled = true; s.revision++;
      const codes = Array.from({ length: 10 }, () => randomBytes(16).toString('hex'));
      s.recovery = codes.map(hash); return codes;
    });
  }
  change(enabled, { code, expectedRevision, local = false } = {}) {
    return this.transaction(s => {
      if (!s.secret && (enabled || !local)) throw new GateError('请先在设置页绑定验证器', 409, { code: 'NOT_ENROLLED' });
      if (expectedRevision !== undefined && s.revision !== expectedRevision) throw new GateError('状态已变化，请刷新后重试', 409);
      if (!local) this.consume(s, code);
      s.enabled = enabled; s.revision++; return s.revision;
    });
  }
  recover(code) {
    return this.transaction(s => {
      const i = typeof code === 'string' ? s.recovery.indexOf(hash(code.trim())) : -1;
      if (i < 0) throw new GateError('恢复码无效或已使用', 401, { code: 'RECOVERY_INVALID' });
      s.recovery.splice(i, 1); s.secret = null; s.lastStep = -1; s.enabled = true; s.revision++; return s.revision;
    });
  }
  recoveryCodes(code) {
    return this.transaction(s => {
      this.consume(s, code);
      const codes = Array.from({ length: 10 }, () => randomBytes(16).toString('hex'));
      s.recovery = codes.map(hash); return codes;
    });
  }
  /** Reserve before validation; successful, replayed and non-credential failures refund it. */
  authenticate(source, operation) {
    const reservation = this.attempt(source);
    let result;
    try { result = operation(); }
    catch (error) {
      if (error instanceof GateError && !['OTP_INVALID', 'RECOVERY_INVALID'].includes(error.code)) this.refund(reservation);
      throw error;
    }
    this.refund(reservation); return result;
  }
  refund(reservation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of reservation) this.db.prepare('UPDATE verification_failures SET count=max(0,count-1) WHERE source=? AND start=?').run(item.key, item.start);
      this.db.prepare('DELETE FROM verification_failures WHERE count=0').run();
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  /** An unfinished validation may conservatively retain its reservation after a crash. */
  attempt(source) {
    const now = this.clock();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM verification_failures WHERE start < ?').run(now - 300000);
      const blocked = [];
      for (const [key, window, limit] of [['global', 60000, 10], [`ip:${source}`, 300000, 5]]) {
        const row = this.db.prepare('SELECT * FROM verification_failures WHERE source=?').get(key);
        if (row && now - row.start < window && row.count >= limit) blocked.push(row.start + window - now);
      }
      if (blocked.length) throw new GateError('验证码校验失败次数已达上限，请稍后重试', 429, { code: 'RATE_LIMITED', retryAfterSeconds: Math.max(1, Math.ceil(Math.max(...blocked) / 1000)) });
      const reservation = [];
      for (const [key, window] of [['global', 60000], [`ip:${source}`, 300000]]) {
        const row = this.db.prepare('SELECT * FROM verification_failures WHERE source=?').get(key);
        const start = row && now - row.start < window ? row.start : now;
        this.db.prepare('INSERT OR REPLACE INTO verification_failures VALUES (?, ?, ?)').run(key, start, row && now - row.start < window ? row.count + 1 : 1);
        reservation.push({ key, start });
      }
      this.db.exec('COMMIT'); return reservation;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); this.key.fill(0); }
}

export class Sessions {
  constructor(store, { clock = Date.now, idleMs = 900000, maxMs = 28800000 } = {}) {
    if (!Number.isSafeInteger(idleMs) || !Number.isSafeInteger(maxMs) || idleMs <= 0 || maxMs <= 0 || idleMs > maxMs || maxMs > 86400000) throw new Error('Invalid session lifetime configuration');
    this.store = store; this.clock = clock; this.idleMs = idleMs; this.maxMs = maxMs;
    this.items = new Map(); this.epoch = token();
  }
  create(kind, authority) {
    this.prune();
    if (this.items.size >= 256) throw new GateError('已达到会话上限', 429);
    const key = token(), now = this.clock();
    this.items.set(hash(key), { kind, authority, revision: this.store.status().revision, born: now, seen: now, epoch: this.epoch });
    return key;
  }
  get(key, authority, kinds = ['page', 'admin'], touch = false) {
    if (typeof key !== 'string') return null;
    const s = this.items.get(hash(key)), now = this.clock();
    if (!s || !kinds.includes(s.kind) || s.authority !== authority || s.revision !== this.store.status().revision || now - s.born >= this.maxMs || (s.until !== undefined && s.until <= now) || s.epoch !== this.epoch) return null;
    if (s.kind === 'asset') {
      if (![...this.items.values()].some(p => p.asset === hash(key) && p.revision === s.revision && p.authority === authority && (p.until === undefined || p.until > now) && now - p.born < this.maxMs && now - p.seen < this.idleMs)) return null;
    } else if (now - s.seen >= this.idleMs) return null;
    if (touch) s.seen = now;
    return s;
  }
  revoke() { this.items.clear(); this.epoch = token(); }
  /** Called only after this page has confirmed a new verifier with a valid TOTP. */
  retainPage(key) {
    const id = hash(key), page = this.items.get(id);
    if (!page || !['page', 'guest', 'admin'].includes(page.kind)) throw new Error('Invalid enrollment page');
    const asset = this.items.get(page.asset);
    this.revoke();
    const revision = this.store.status().revision;
    Object.assign(page, { kind: 'page', revision, epoch: this.epoch, seen: this.clock() });
    this.items.set(id, page);
    if (asset) {
      Object.assign(asset, { revision, epoch: this.epoch });
      this.items.set(page.asset, asset);
    }
  }
  prune() {
    const now = this.clock(), rev = this.store.status().revision;
    for (const [k, s] of this.items) if (s.revision !== rev || now - s.born >= this.maxMs || (s.until !== undefined && s.until <= now) || (s.kind !== 'asset' && now - s.seen >= this.idleMs)) this.items.delete(k);
    for (const [k, s] of this.items) if (s.kind === 'asset' && ![...this.items.values()].some(p => p.asset === k)) this.items.delete(k);
  }
}

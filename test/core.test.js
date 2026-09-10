import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, Sessions, GateError } from '../src/core.js';

const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-totp-core-'));
  let now = 1800000000000, store = new Store(dir, { clock: () => now });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    dir, get store() { return store; }, clock: () => now,
    advance(ms = 30000) { now += ms; },
    code() { return store.otp(secret).generate({ timestamp: now }); },
    enroll() { return store.enroll(secret, this.code(), store.status().revision); },
    reopen() { store.close(); store = new Store(dir, { clock: () => now }); },
  };
}

test('fresh installs are off; confirmed enrollment encrypts the seed and hashes ten recovery codes', t => {
  const f = fixture(t);
  assert.deepEqual(f.store.status(), { bound: false, enabled: false, revision: 0 });
  const codes = f.enroll(), state = f.store.read();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.equal(f.store.unseal(state.secret), secret);
  assert.ok(!JSON.stringify(state).includes(secret));
  assert.ok(codes.every(code => !JSON.stringify(state).includes(code)));
  assert.equal(readFileSync(join(f.dir, 'master.key')).length, 32);
  f.reopen();
  assert.deepEqual(f.store.status(), { bound: true, enabled: true, revision: 1 });
});

test('TOTP replay and protection settings survive restart; stale mutations do not consume a code', t => {
  const f = fixture(t);
  f.enroll();
  f.reopen();
  assert.throws(() => f.store.verify(f.code()), { code: 'OTP_REUSED' });
  f.advance();
  assert.throws(() => f.store.change(false, { code: f.code(), expectedRevision: 0 }), { status: 409 });
  f.store.change(false, { code: f.code(), expectedRevision: 1 });
  f.reopen();
  assert.equal(f.store.status().enabled, false);
  assert.throws(() => f.store.verify(f.code()), { code: 'OTP_REUSED' });
});

test('TOTP accepts adjacent time steps and rejects a code beyond the tolerance', t => {
  const f = fixture(t);
  f.enroll(); f.advance(90000);
  const otp = f.store.otp(secret);
  f.store.verify(otp.generate({ timestamp: f.clock() - 30000 }));
  f.store.verify(otp.generate({ timestamp: f.clock() + 30000 }));
  assert.throws(() => f.store.verify(otp.generate({ timestamp: f.clock() + 90000 })), { code: 'OTP_INVALID' });
});

test('recovery is single-use, revokes the old authenticator, and re-enrollment replaces remaining codes', t => {
  const f = fixture(t), codes = f.enroll();
  f.store.recover(codes[0]);
  assert.deepEqual(f.store.status(), { bound: false, enabled: true, revision: 2 });
  assert.throws(() => f.store.recover(codes[0]), { code: 'RECOVERY_INVALID' });
  assert.throws(() => f.store.verify(f.code()), { code: 'NOT_ENROLLED' });
  f.enroll();
  assert.throws(() => f.store.recover(codes[1]), { code: 'RECOVERY_INVALID' });
  f.advance();
  const replacement = f.store.recoveryCodes(f.code());
  assert.equal(replacement.length, 10);
  f.store.recover(replacement[0]);
});

test('only failed credentials consume limits, successes preserve failures, and limits persist', t => {
  const f = fixture(t); f.enroll();
  const invalid = () => { throw new GateError('invalid', 401, { code: 'OTP_INVALID' }); };
  for (let n = 0; n < 4; n++) assert.throws(() => f.store.authenticate('a', invalid), { code: 'OTP_INVALID' });
  assert.throws(() => f.store.authenticate('a', () => f.store.verify('x')), { code: 'OTP_FORMAT' });
  assert.throws(() => f.store.authenticate('a', () => f.store.verify(f.code())), { code: 'OTP_REUSED' });
  f.advance(); f.store.authenticate('a', () => f.store.verify(f.code()));
  f.reopen();
  assert.throws(() => f.store.authenticate('a', invalid), { code: 'OTP_INVALID' });
  assert.throws(() => f.store.authenticate('a', invalid), { code: 'RATE_LIMITED', retryAfterSeconds: 270 });
  f.advance(270000);
  f.store.authenticate('a', () => f.store.verify(f.code()));
});

test('ten failures across sources trigger the shared one-minute limit', t => {
  const f = fixture(t);
  for (let n = 0; n < 10; n++) assert.throws(() => f.store.authenticate(String(n), () => f.store.recover('invalid')), { code: 'RECOVERY_INVALID' });
  assert.throws(() => f.store.authenticate('new', () => {}), { code: 'RATE_LIMITED', retryAfterSeconds: 60 });
  f.advance(60000);
  assert.doesNotThrow(() => f.store.authenticate('new', () => {}));
});

test('page capabilities are host-bound, expire at idle/maximum lifetimes, and are revoked on policy change', t => {
  const f = fixture(t); f.enroll();
  const s = new Sessions(f.store, { clock: f.clock, idleMs: 900000, maxMs: 28800000 });
  const key = s.create('page', 'localhost:3080');
  assert.ok(s.get(key, 'localhost:3080'));
  assert.equal(s.get(key, 'attacker.invalid'), null);
  f.advance(900000);
  assert.equal(s.get(key, 'localhost:3080'), null);
  const active = s.create('page', 'localhost:3080');
  for (let n = 0; n < 47; n++) { f.advance(600000); assert.ok(s.get(active, 'localhost:3080', ['page'], true)); }
  f.advance(600000); assert.equal(s.get(active, 'localhost:3080'), null);
  const revoked = s.create('page', 'localhost:3080');
  f.store.change(false, { local: true });
  assert.equal(s.get(revoked, 'localhost:3080'), null);
});

test('a missing master key never resets an existing database', t => {
  const f = fixture(t); f.enroll();
  unlinkSync(join(f.dir, 'master.key'));
  assert.throws(() => new Store(f.dir), /Encryption key missing/);
  assert.equal(f.store.status().enabled, true);
});

for (const malformed of [{ secret: '' }, { revision: -1 }, { recovery: ['plaintext'] }]) {
  test(`malformed persisted state is refused: ${JSON.stringify(malformed)}`, t => {
    const f = fixture(t); f.enroll();
    const state = { ...f.store.read(), ...malformed };
    f.store.db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(state));
    assert.throws(() => f.store.status(), /Invalid TOTP state/);
    assert.throws(() => new Store(f.dir), /Invalid TOTP state/);
  });
}

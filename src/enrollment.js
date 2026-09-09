import { Secret } from 'otpauth';
import QRCode from 'qrcode';
import { GateError, hash, token } from './core.js';

/** First binding is initiated from Settings while protection is off. */
export class Enrollment {
  constructor(store, clock = Date.now) { this.store = store; this.clock = clock; this.pending = new Map(); }
  prune() {
    const now = this.clock(), revision = this.store.status().revision;
    for (const [k, v] of this.pending) if (v.until <= now || v.revision !== revision) this.pending.delete(k);
  }
  async begin(auth, code, source) {
    this.prune();
    const state = this.store.status();
    if (!['page', 'guest', 'admin', 'recovery'].includes(auth.kind)) throw new GateError('请从设置页进行绑定', 403);
    if (!state.bound && state.enabled && auth.kind !== 'recovery') throw new GateError('请使用恢复码重新绑定验证器', 403);
    if (state.bound) this.store.authenticate(source, () => this.store.verify(code));
    if (this.pending.size >= 20) throw new GateError('绑定流程过多，请稍后再试', 429);
    for (const [k, p] of this.pending) if (p.owner === hash(auth.key)) this.pending.delete(k);
    const id = token(), secret = new Secret({ size: 20 }).base32;
    this.pending.set(hash(id), { secret, owner: hash(auth.key), revision: state.revision, until: this.clock() + 300000 });
    const qr = await QRCode.toDataURL(this.store.otp(secret).toString(), { width: 280, margin: 2 });
    return { id, revision: state.revision, qr };
  }
  confirm(auth, id, code, source) {
    this.prune(); const p = typeof id === 'string' ? this.pending.get(hash(id)) : null;
    if (!p || p.owner !== hash(auth.key)) throw new GateError('绑定流程已过期，请重新发起', 401);
    return this.store.authenticate(source, () => this.store.enroll(p.secret, code, p.revision));
  }
  cancel(auth) { for (const [k, p] of this.pending) if (p.owner === hash(auth.key)) this.pending.delete(k); }
  revoke() { this.pending.clear(); }
}

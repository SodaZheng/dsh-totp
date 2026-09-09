import { Store, dataPath } from './core.js';
import { Gateway } from './gateway.js';
import { Control, OwnerLease } from './control.js';

export const name = 'dsh-totp';
export const inject = ['webServer', 'connection', 'settings'];

export async function apply(ctx, config = {}) {
  if (ctx.webServer.host !== '127.0.0.1' || ctx.webServer.totpInternal !== true) throw new Error('dsh-totp requires its internal-webserver provider; refusing to start');
  if (typeof ctx.connection.authenticatedUrl !== 'function') throw new Error('Unsupported DSH browser authentication contract');
  const store = new Store(config.dataDir || dataPath());
  let lease, gateway, control;
  const close = async () => { await control?.close(); await gateway?.close(); lease?.close(); store.close(); };
  try {
    lease = new OwnerLease(store.dir);
    const upstream = `http://127.0.0.1:${ctx.webServer.port}/`;
    const authenticate = async () => {
      const r = await fetch(ctx.connection.authenticatedUrl(upstream), { redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const cookies = r.headers.getSetCookie().map(s => s.split(';')[0]);
      if (r.status !== 303 || !cookies.length) throw new Error('DSH browser authentication handshake failed');
      await r.body?.cancel(); return cookies.join('; ');
    };
    // The fallback owner can settle just after Connection's route registration.
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try { const c = await authenticate(); const r = await fetch(upstream, { headers: { cookie: c }, signal: AbortSignal.timeout(2000) }); ready = r.ok; await r.body?.cancel(); if (ready) break; } catch { /* Bounded startup retry; never opens the gateway early. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('DSH frontend did not become ready');
    gateway = new Gateway({ store, host: config.host || '127.0.0.1', port: config.port ?? 3080, allowedHosts: config.allowedHosts || [], upstream, authenticate,
      idleMs: config.idleMs, maxMs: config.maxMs, theme: () => ctx.settings.get('ui-theme')?.preference || 'system' });
    await gateway.start();
    control = new Control(store, gateway);
    await control.start();
    ctx.effect(() => close, 'dsh-totp: listener and credentials');
    ctx.logger.info(`dsh-totp HTTP entry: http://${gateway.host === '0.0.0.0' ? '127.0.0.1' : gateway.host}:${gateway.port}/`);
    if (!store.status().bound && !store.status().enabled) ctx.logger.info('访问验证默认关闭，可在 DSH 设置 → 访问验证中扫码绑定。');
  } catch (error) { await close(); throw error; }
}

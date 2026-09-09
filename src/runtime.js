/** Compatibility shims carry a per-document key; authorization stays on the server. */
export function browserRuntime(key, revision, admin, enabled, bound, css, mountEnrollment, installPanel, otpUi) {
  const nativeFetch = window.fetch.bind(window), NativeWS = window.WebSocket, NativeXHR = window.XMLHttpRequest;
  const originalOrigin = location.origin;
  let dead = false, currentRevision = revision, finalizing = false, lockPending = false;
  const scope = url => { try { return new URL(url, location.href).origin === originalOrigin; } catch { return false; } };
  const goLock = () => { if (finalizing) { lockPending = true; return; } if (dead) return; dead = true; document.documentElement.style.visibility = 'hidden'; location.replace('/'); };
  const headers = h => { const x = new Headers(h); x.set('x-dsh-totp', key); return x; };
  window.fetch = async function(input, init = {}) {
    if (!scope(input instanceof Request ? input.url : input)) return nativeFetch(input, init);
    if (dead) throw new Error('页面已锁定');
    const request = new Request(input, init);
    const response = await nativeFetch(new Request(request, { headers: headers(request.headers) }));
    if (response.headers.get('x-dsh-totp-locked') === '1') goLock();
    return response;
  };
  window.WebSocket = class extends NativeWS {
    constructor(url, protocols = []) {
      const target = new URL(url, location.href), ours = target.host === location.host;
      super(url, ours ? [...(typeof protocols === 'string' ? [protocols] : protocols), 'dsh-totp', 'dsh-totp.auth.' + key] : protocols);
      if (ours) this.addEventListener('close', e => { if (e.code === 4001 || e.code === 1008) goLock(); });
    }
  };
  window.XMLHttpRequest = class extends NativeXHR {
    open(method, url, ...args) { this.totpLocal = scope(url); return super.open(method, url, ...args); }
    send(body) { if (this.totpLocal) this.setRequestHeader('x-dsh-totp', key); return super.send(body); }
  };
  // Native element requests cannot carry custom headers. The server issues scoped resource leases.
  const seen = new WeakMap();
  async function protectElement(el, attr) {
    const raw = el.getAttribute(attr);
    if (!raw || !scope(raw) || /^(data:|blob:|#)/.test(raw) || raw.includes('_totp_resource=')) return;
    const url = new URL(raw, location.href);
    if (!url.pathname.startsWith('/api/')) return;
    if (seen.get(el) === raw) return; seen.set(el, raw);
    try {
      const r = await window.fetch('/_totp/resource', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: url.pathname + url.search }) });
      if (!r.ok) return;
      const result = await r.json(); if (el.getAttribute(attr) === raw) el.setAttribute(attr, result.url);
    } catch { /* Unadapted native requests are denied by the server. */ }
  }
  const scan = root => { if (!(root instanceof Element)) return; for (const [selector, attr] of [['img[src],video[src],audio[src],source[src]', 'src'], ['a[href]', 'href']]) { if (root.matches(selector)) protectElement(root, attr); for (const el of root.querySelectorAll(selector)) protectElement(el, attr); } };
  const observer = new MutationObserver(records => { for (const r of records) { if (r.type === 'attributes') scan(r.target); else for (const n of r.addedNodes) scan(n); } });
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });
  addEventListener('pagehide', () => {
    dead = true; document.documentElement.style.visibility = 'hidden';
    nativeFetch('/_totp/leave', { method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-totp': key }, body: '{}', keepalive: true }).catch(() => {});
  });
  addEventListener('pageshow', event => { if (event.persisted) { dead = false; goLock(); } });

  async function api(path, body = {}) {
    if (body.code !== undefined) body = { ...body, code: otpUi.normalize(body.code) };
    const r = await window.fetch('/_totp/' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const value = await r.json(); if (!r.ok) throw Object.assign(new Error(value.error), { code: value.code, retryAfterSeconds: value.retryAfterSeconds }); return value;
  }
  let lastActivity = 0;
  for (const name of ['pointerdown', 'keydown', 'wheel']) addEventListener(name, () => {
    if (Date.now() - lastActivity > 30000) { lastActivity = Date.now(); api('touch').catch(() => {}); }
  }, { passive: true });
  setInterval(async () => {
    if (dead || finalizing) return;
    try { const r = await api('status'); currentRevision = Math.max(currentRevision, r.revision); } catch { goLock(); }
  }, 5000);
  const install = () => installPanel({ api, css, mountEnrollment, bound, enabled, admin, otpUi,
    revision: () => currentRevision,
    enrolled: result => { currentRevision = Math.max(currentRevision, result.revision); },
    finalizing: value => { finalizing = value; if (!value && lockPending) goLock(); },
    finish: () => { finalizing = false; dead = false; goLock(); },
  });
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', install, { once: true }); else install();
}

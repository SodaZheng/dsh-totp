import { portalCss, panelCss } from './theme.js';
import { mountEnrollment } from './enrollment-ui.js';
import { installPanel } from './panel.js';
import { browserRuntime } from './runtime.js';
import { normalizeOtp, prepareOtpInput, showOtpError } from './otp-input.js';
import { renderRecoveryCodes } from './recovery-ui.js';

const otpUiSource = () => `({ normalize: ${normalizeOtp.toString()}, prepare: ${prepareOtpInput.toString()}, error: ${showOtpError.toString()}, recovery: ${renderRecoveryCodes.toString()} })`;

export function runtimeScript(key, revision, admin, enabled, bound) {
  return `(${browserRuntime.toString()})(${JSON.stringify(key)},${revision},${admin},${enabled},${bound},${JSON.stringify(panelCss)},(${mountEnrollment.toString()}),(${installPanel.toString()}),${otpUiSource()})`;
}

function portalScript(mountEnrollment, otpUi) {
  const form = document.querySelector('#login'), code = document.querySelector('#code'), error = document.querySelector('#error');
  const button = form.querySelector('button.primary');
  otpUi.prepare(code, otpUi.normalize);
  async function request(path, body, key) {
    const response = await fetch('/_totp/' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-dsh-totp': key } : {}) }, body: JSON.stringify(body) });
    if (!response.ok) { const value = await response.json(); throw Object.assign(new Error(value.error || '请求失败'), { code: value.code, retryAfterSeconds: value.retryAfterSeconds }); }
    return response;
  }
  async function enter(body) {
    const auth = await request('verify', body).then(r => r.json());
    await enterPage(auth.key);
  }
  async function enterPage(key) {
    const html = await request('bootstrap', {}, key).then(r => r.text());
    document.open(); document.write(html); document.close();
  }
  form.onsubmit = async e => { e.preventDefault(); button.disabled = true; error.textContent = ''; try { await enter({ code: otpUi.normalize(code.value) }); } catch(e) { button.disabled = false; code.value = ''; otpUi.error(error, e, [button]); code.focus(); } };
  const recovery = document.querySelector('#recovery-form');
  document.querySelector('#recovery').onclick = () => { recovery.hidden = !recovery.hidden; if (!recovery.hidden) recovery.querySelector('input').focus(); };
  recovery.onsubmit = async event => {
    event.preventDefault(); const submit = recovery.querySelector('button'); submit.disabled = true; error.textContent = '';
    try {
      const { key } = await request('recovery', { code: recovery.querySelector('input').value }).then(r => r.json());
      recovery.querySelector('input').value = '';
      const dialog = document.querySelector('#recovery-dialog');
      let pageKey;
      const binding = mountEnrollment(dialog.querySelector('div'), async (path, body) => request(path, body, key).then(r => r.json()), {
        finalizing: () => {}, completed: result => { pageKey = result.key; },
        finish: () => enterPage(pageKey), back: () => location.replace('/'), otpUi,
      });
      dialog.addEventListener('cancel', e => { e.preventDefault(); if (!binding.receipt) void binding.cancel(); });
      dialog.showModal(); binding.show(false);
    } catch(e) { otpUi.error(error, e); } finally { submit.disabled = false; }
  };
  if (document.body.dataset.open === 'true') {
    button.disabled = true; enter({}).catch(e => { error.textContent = e.message; button.disabled = false; });
  }
}

export function portal({ bound, enabled }, preference = 'system') {
  const theme = ['light', 'dark', 'system'].includes(preference) ? preference : 'system';
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH · 访问验证</title><style>${portalCss}</style><body data-open="${!enabled}"><script>(()=>{const preference=${JSON.stringify(theme)};const media=matchMedia('(prefers-color-scheme: dark)');const apply=()=>{const dark=preference==='dark'||(preference==='system'&&media.matches);document.body.toggleAttribute('data-ds-dark-theme',dark);document.documentElement.style.colorScheme=dark?'dark':'light';};apply();if(preference==='system')media.addEventListener('change',apply);})()</script><main><div class="eyebrow">DSH / 访问验证</div><h1>${bound ? '验证后进入 DSH' : '在 DSH 中绑定验证器'}</h1><p>${bound ? '打开验证器，输入当前的 6 位动态码。' : enabled ? '访问保护已开启，请使用恢复码重新绑定验证器。' : '正在进入 DSH，可在设置 → 访问验证中绑定验证器。'}</p><form id="login" class="otp-form"><div class="otp-label-row"><label for="code">动态验证码</label><span>每 30 秒更新</span></div><input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" aria-label="动态验证码" autofocus required ${bound ? '' : 'disabled'}><div class="actions"><button class="primary" ${bound ? '' : 'disabled'}>进入 DSH</button></div></form><p id="error" class="error" role="status"></p><button id="recovery" class="text-button" type="button">无法使用验证器</button><form id="recovery-form" hidden><label for="recovery-code">一次性恢复码</label><input id="recovery-code" autocomplete="off" required><button class="primary">恢复并重新绑定</button></form><div class="footer">每次打开页面验证 · Google / Microsoft Authenticator</div></main><dialog id="recovery-dialog" aria-label="重新绑定验证器"><div></div></dialog><script>(${portalScript.toString()})(${mountEnrollment.toString()},${otpUiSource()})</script></body></html>`;
}

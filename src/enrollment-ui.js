/** Shared binding flow, mounted inside DSH's access panel or the recovery dialog. */
export function mountEnrollment(root, api, hooks) {
  root.innerHTML = `
    <ol class="enrollment-steps" aria-label="绑定进度">
      <li><span>1</span>验证身份</li><li><span>2</span>扫码绑定</li><li><span>3</span>保存恢复码</li>
    </ol>
    <div class="enrollment-surface">
      <section data-stage="start">
        <h3>绑定验证器</h3><p class="binding-note" data-intro></p>
        <form data-prior-form class="otp-form">
          <div class="otp-label-row"><label for="totp-prior">当前验证器动态码</label><span>6 位数字</span></div>
          <input id="totp-prior" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" aria-describedby="totp-prior-help" required>
          <p id="totp-prior-help" class="otp-help">输入当前验证器中显示的一组新动态码。</p>
          <div class="actions"><button class="primary">验证并生成二维码</button></div>
        </form>
      </section>
      <section data-stage="scan" hidden>
        <h3>扫码绑定验证器</h3>
        <p class="binding-note">打开 Google 或 Microsoft Authenticator，添加账号并扫描二维码。</p>
        <div class="enrollment-qr"><img class="qr" alt="验证器绑定二维码"></div>
        <form data-confirm-form class="otp-form">
          <div class="otp-label-row"><label for="totp-new">新验证器动态码</label><span>每 30 秒更新</span></div>
          <input id="totp-new" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" aria-describedby="totp-new-help" required>
          <p id="totp-new-help" class="otp-help">扫码后，输入验证器中显示的 6 位数字。</p>
          <div class="actions"><button class="primary">确认绑定并开启保护</button></div>
        </form>
      </section>
      <section data-stage="done" hidden>
        <span class="enrollment-complete" aria-hidden="true">✓</span><h3>绑定完成</h3>
        <p class="binding-note">访问保护已开启，当前页面可继续使用。</p>
        <div data-recovery-output></div><div class="actions"><button class="primary" data-finish>已保存，继续使用 DSH</button></div>
      </section>
      <p class="error" data-binding-error role="status"></p>
    </div>
    <div class="actions"><button data-cancel class="quiet-button">返回</button></div>`;

  const q = selector => root.querySelector(selector);
  hooks.otpUi.prepare(q('#totp-prior'), hooks.otpUi.normalize);
  hooks.otpUi.prepare(q('#totp-new'), hooks.otpUi.normalize);
  let pending, receipt = false, busy = false, visible = false;
  const stage = name => {
    for (const s of root.querySelectorAll('[data-stage]')) s.hidden = s.dataset.stage !== name;
    const active = ['start', 'scan', 'done'].indexOf(name);
    root.querySelectorAll('.enrollment-steps li').forEach((step, i) => { step.dataset.state = i < active ? 'complete' : i === active ? 'active' : 'pending'; if (i === active) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current'); });
  };
  const buttons = disabled => { for (const b of root.querySelectorAll('button')) b.disabled = disabled; };
  const scrub = () => { q('.qr').removeAttribute('src'); q('#totp-prior').value = ''; q('#totp-new').value = ''; pending = null; };
  async function begin(code) {
    if (busy) return; busy = true; buttons(true); q('[data-binding-error]').textContent = '';
    try {
      const p = await api('enroll/begin', { code });
      if (!visible) return;
      pending = p.id; q('.qr').src = p.qr; q('#totp-prior').value = ''; stage('scan'); q('#totp-new').focus();
    } catch(e) { hooks.otpUi.error(q('[data-binding-error]'), e); }
    finally { busy = false; buttons(false); }
  }
  q('[data-prior-form]').onsubmit = e => { e.preventDefault(); void begin(q('#totp-prior').value); };
  q('[data-confirm-form]').onsubmit = async e => {
    e.preventDefault(); if (busy || !pending) return; busy = true; buttons(true); q('[data-binding-error]').textContent = ''; hooks.finalizing(true);
    try {
      const r = await api('enroll/confirm', { id: pending, code: q('#totp-new').value });
      receipt = true; scrub(); hooks.otpUi.recovery(q('[data-recovery-output]'), r.codes); stage('done'); q('[data-cancel]').hidden = true;
      hooks.completed?.(r); hooks.finalizing(false);
    } catch(e) { hooks.finalizing(false); hooks.otpUi.error(q('[data-binding-error]'), e); }
    finally { busy = false; buttons(false); }
  };
  const finish = async () => {
    if (busy) return; busy = true; buttons(true); q('[data-binding-error]').textContent = '';
    try {
      await hooks.finish();
      q('[data-recovery-output]').textContent = ''; receipt = false; visible = false;
    } catch(e) { hooks.otpUi.error(q('[data-binding-error]'), e); }
    finally { busy = false; buttons(false); }
  };
  const cancel = async () => {
    if (busy) return;
    if (receipt) { await finish(); return; }
    visible = false; await api('enroll/cancel', {}).catch(() => {}); scrub(); hooks.back();
  };
  q('[data-cancel]').onclick = cancel;
  q('[data-finish]').onclick = finish;
  return {
    show(bound) {
      visible = true; root.hidden = false; receipt = false; stage('start'); q('[data-cancel]').hidden = false;
      root.querySelectorAll('.enrollment-steps li').forEach((step, i) => { step.hidden = !bound && i === 0; step.querySelector('span').textContent = String(bound ? i + 1 : i); });
      q('[data-stage="start"] h3').textContent = bound ? '更换验证器' : '绑定验证器';
      q('[data-stage="done"] .binding-note').textContent = bound ? '新验证器已生效，当前页面可继续使用。其他页面需要重新验证。' : '访问保护已开启，本次验证已完成。保存恢复码后即可继续使用。';
      q('[data-binding-error]').textContent = ''; q('[data-recovery-output]').textContent = '';
      q('[data-intro]').textContent = bound ? '先验证当前动态码，再绑定新的验证器。新绑定确认前，旧验证器继续有效。' : '在此处完成扫码绑定，访问验证将自动开启。';
      q('[data-prior-form]').hidden = !bound;
      if (!bound) void begin(); else q('#totp-prior').focus();
    },
    cancel,
    get receipt() { return receipt; },
    get busy() { return busy; },
  };
}

export function installPanel(options) {
  const { api, css, mountEnrollment, otpUi } = options;
  let { bound, enabled } = options;
  const host = document.createElement('div'); host.id = 'dsh-totp-controls';
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483000';
  const shadow = host.attachShadow({ mode: 'closed' });
  const icon = name => {
    const paths = {
      shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
      phone: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M10 6h4M11 18h2"/>',
      recovery: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h3m4 0h3M7 14h3m4 0h3"/>',
      lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
      close: '<path d="m6 6 12 12M6 18 18 6"/>',
    };
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
  };
  shadow.innerHTML = `<style>${css}</style><nav class="quick-actions" aria-label="锁定访问"><span id="lock-shortcut" class="lock-shortcut"><button id="lock">${icon('lock')}锁定</button><span id="lock-hint" class="lock-hint" role="tooltip" hidden>请先到「设置 → 访问验证」绑定验证器</span></span><p id="quick-error" class="lock-error" role="alert"></p></nav><dialog aria-label="访问验证"><section id="main" class="control-page"><header class="page-heading"><span class="page-kicker">DSH TOTP</span><h3>访问验证</h3><p>管理进入 DSH 的方式，以及恢复访问的凭据。</p></header><article class="protection-card"><div class="protection-top"><span class="section-kicker">访问保护</span><span id="state" class="state-pill"><i></i><span></span></span></div><div class="protection-body"><div class="protection-symbol">${icon('shield')}</div><div><h4 id="state-title"></h4><p id="state-description"></p></div></div><div class="protection-bottom"><span>6 位动态码 <b>·</b> 每 30 秒更新</span><div id="bound-controls"><button id="toggle"></button></div></div></article><section id="authorize" class="authorization-card" hidden aria-label="确认管理操作"><header><div><span class="section-kicker">验证身份</span><h4 id="authorize-title"></h4></div><button id="cancel-authorize" type="button" class="icon-button" aria-label="取消验证">${icon('close')}</button></header><form id="authorize-form" class="otp-form"><div class="otp-label-row"><label for="otp">当前验证器动态码</label><span>每 30 秒更新</span></div><input id="otp" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" aria-describedby="authorize-description" required pattern="[0-9]{6}"><p id="authorize-description" class="field-note"></p><p id="error" class="error" role="status"></p><div class="actions"><button class="primary" id="confirm" type="submit"></button></div></form></section><section class="credentials-section"><h4 class="section-title">验证方式与恢复</h4><div class="credential-list"><div class="credential-row"><span class="row-symbol">${icon('phone')}</span><div class="credential-copy"><strong>身份验证器 <span id="verifier-state" class="subtle-badge"></span></strong><p>Google / Microsoft Authenticator</p></div><button id="bind" class="quiet-button"></button></div><div class="credential-row"><span class="row-symbol">${icon('recovery')}</span><div class="credential-copy"><strong>恢复码</strong><p>手机不可用时，用于重新绑定验证器。</p></div><button id="codes" class="quiet-button">更新恢复码</button></div></div></section><section id="recovery" class="recovery-panel" hidden></section><footer class="lock-section"><span class="row-symbol">${icon('lock')}</span><div><h4>暂时离开时，锁定访问</h4><p>已授权页面立即失效，后台任务继续运行。</p></div><button id="lock-page">锁定所有设备</button></footer><p id="page-lock-error" class="lock-error" role="alert"></p><div class="panel-dismiss"><button id="close" class="quiet-button">关闭面板</button></div></section><div id="enrollment" hidden></div></dialog>`;
  const dialog = shadow.querySelector('dialog');
  const content = document.createElement('section');
  content.append(shadow.querySelector('#main'), shadow.querySelector('#enrollment'));
  dialog.append(content);
  const q = s => content.querySelector(s) || shadow.querySelector(s);
  let inlineTarget = null, activeAction = null, running = false;
  let canLock;
  const pageLock = q('#lock-page');
  const renderState = () => {
    canLock = bound && enabled;
    const lockHint = !bound ? '请先到「设置 → 访问验证」绑定验证器' : '访问保护未开启，请先到「设置 → 访问验证」开启保护';
    pageLock.disabled = !canLock;
    q('#state span').textContent = enabled ? '已开启' : '已关闭';
    q('#state').dataset.enabled = String(bound && enabled);
    q('#state-title').textContent = !bound ? '为 DSH 绑定验证器' : enabled ? '每次进入，先验证身份' : '当前允许直接访问';
    q('#state-description').textContent = !bound ? '访问验证默认关闭，确认扫码绑定后开启保护。' : enabled ? '内网与公网入口统一验证，由你掌握访问权限。' : '开启保护后，进入 DSH 需要验证器动态码。';
    q('#bound-controls').hidden = !bound;
    q('#toggle').textContent = enabled ? '关闭保护' : '开启保护';
    q('#toggle').classList.toggle('primary', !enabled);
    q('#bind').textContent = bound ? '更换验证器' : '绑定验证器';
    q('#lock').disabled = !canLock;
    q('#lock').setAttribute('aria-label', '锁定所有设备');
    q('#lock-hint').textContent = lockHint;
    q('#lock').title = canLock ? '立即锁定所有设备，无需验证码' : lockHint;
    pageLock.title = q('#lock').title;
    q('.lock-section p').textContent = canLock ? '已授权页面立即失效，后台任务继续运行。' : lockHint;
    const shortcut = q('#lock-shortcut');
    q('#lock-hint').hidden = canLock;
    if (!canLock) {
      shortcut.tabIndex = 0;
      shortcut.setAttribute('role', 'group');
      shortcut.setAttribute('aria-label', '锁定不可用');
      shortcut.setAttribute('aria-describedby', 'lock-hint');
      q('#lock').setAttribute('aria-describedby', 'lock-hint');
      shortcut.onclick = () => shortcut.focus();
    } else {
      for (const attr of ['tabindex', 'role', 'aria-label', 'aria-describedby']) shortcut.removeAttribute(attr);
      q('#lock').removeAttribute('aria-describedby'); shortcut.onclick = null;
    }
    q('#codes').disabled = !bound;
    q('#verifier-state').textContent = bound ? '已绑定' : '未绑定';
  };
  renderState();
  otpUi.prepare(q('#otp'), otpUi.normalize);
  const hideAuthorization = () => { q('#authorize').hidden = true; q('#otp').value = ''; activeAction = null; };
  const authorize = action => {
    if (running) return;
    activeAction = action;
    if (!q('#confirm').disabled) q('#error').textContent = '';
    q('#authorize-title').textContent = action === 'codes' ? '更新恢复码' : enabled ? '关闭访问验证' : '开启访问验证';
    q('#authorize-description').textContent = action === 'codes' ? '生成后，旧恢复码将失效。请使用一组未用过的新动态码。' : !enabled ? '开启后，当前页面及其他已打开页面需要重新验证。' : '关闭后，知道访问地址的人可直接进入。请使用一组新动态码确认。';
    q('#confirm').textContent = action === 'codes' ? '生成新恢复码' : enabled ? '确认关闭保护' : '确认开启保护';
    q('#authorize').hidden = false; q('#otp').focus();
  };
  const backToSettings = () => { q('#enrollment').hidden = true; q('#main').hidden = false; };
  const binding = mountEnrollment(q('#enrollment'), api, {
    finalizing: options.finalizing,
    completed: result => {
      bound = result.bound; enabled = result.enabled;
      options.enrolled(result); renderState();
    },
    finish: () => { backToSettings(); if (!inlineTarget && dialog.open) dialog.close(); },
    otpUi,
    back: backToSettings,
  });
  const showBinding = () => { hideAuthorization(); q('#main').hidden = true; binding.show(bound); };
  const run = async (action, reportFailure) => {
    if (running) return; running = true;
    q('#error').textContent = '';
    const controls = [q('#lock'), ...q('#main').querySelectorAll('button')]; controls.forEach(b => { b.disabled = true; });
    let failure;
    try { await action(); } catch(e) { failure = e; }
    finally {
      controls.forEach(b => { b.disabled = false; });
      q('#codes').disabled = !bound; q('#lock').disabled = !canLock; pageLock.disabled = !canLock; running = false;
      if (failure) {
        if (reportFailure) reportFailure(failure);
        else { q('#otp').value = ''; otpUi.error(q('#error'), failure, [q('#toggle'), q('#codes'), q('#confirm')]); }
      }
    }
  };
  const open = () => {
    if (inlineTarget) { content.querySelector('input:not([disabled])')?.focus(); return; }
    if (!dialog.open) dialog.showModal();
  };
  const lockAll = () => {
    if (!canLock || running) return;
    q('#quick-error').textContent = ''; q('#page-lock-error').textContent = '';
    return run(async () => { await api('lock'); options.finish(); }, failure => {
      const message = failure.message || '锁定失败，请重试';
      q('#quick-error').textContent = message; q('#page-lock-error').textContent = message;
    });
  };
  q('#lock').onclick = lockAll; pageLock.onclick = lockAll;
  addEventListener('dsh-totp:settings', open);
  q('#close').onclick = () => dialog.close();
  q('#toggle').onclick = () => authorize('protection');
  q('#codes').onclick = () => authorize('codes');
  q('#cancel-authorize').onclick = hideAuthorization;
  q('#authorize-form').onsubmit = event => {
    event.preventDefault(); if (!activeAction) return;
    const action = activeAction;
    void run(async () => {
      if (action === 'codes') {
        const r = await api('recovery-codes', { code: q('#otp').value });
        otpUi.recovery(q('#recovery'), r.codes); q('#recovery').hidden = false; hideAuthorization();
      } else {
        await api('protection', { enabled: !enabled, code: q('#otp').value, revision: options.revision() }); options.finish();
      }
    });
  };
  q('#bind').onclick = showBinding;
  dialog.addEventListener('cancel', event => {
    if (!q('#enrollment').hidden) { event.preventDefault(); if (!binding.receipt) void binding.cancel(); }
  });
  dialog.addEventListener('close', () => { if (inlineTarget) return; hideAuthorization(); q('#recovery').textContent = ''; q('#recovery').hidden = true; });
  // Move the single controller's DOM so tab changes cannot create competing binding flows.
  addEventListener('dsh-totp:settings-mount', event => {
    const target = event.detail?.target;
    if (!(target instanceof HTMLElement) || !target.isConnected) return;
    inlineTarget = target;
    if (dialog.open) dialog.close();
    const surface = target.shadowRoot || target.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = css + ':host{display:block;container-type:inline-size;container-name:totp}#main{padding:4px 0 20px}';
    surface.replaceChildren(style, content);
    q('#close').hidden = true;
    event.detail.attached = true;
  });
  addEventListener('dsh-totp:settings-unmount', event => {
    if (event.detail?.target !== inlineTarget) return;
    inlineTarget = null;
    dialog.append(content); q('#close').hidden = false;
    if (binding.receipt || binding.busy) open();
  });
  document.body.append(host);
}

/** Present exact recovery-code values; visual wrapping never changes copied data. */
export function renderRecoveryCodes(root, codes) {
  if (!Array.isArray(codes) || !codes.length || !codes.every(code => typeof code === 'string' && /^[a-f0-9]{32}$/.test(code))) throw new Error('恢复码返回格式异常，请重试');
  root.innerHTML = `<header class="recovery-heading"><div><h4>保存恢复码</h4><p>每个仅可使用一次，请保存在安全的位置。</p></div><button type="button" data-copy>复制全部</button></header><ol class="recovery-grid" aria-label="一次性恢复码"></ol><p class="copy-status" role="status"></p>`;
  const list = root.querySelector('ol');
  codes.forEach((code, index) => {
    const li = document.createElement('li'), number = document.createElement('span'), value = document.createElement('code');
    number.className = 'recovery-number'; number.textContent = String(index + 1).padStart(2, '0'); number.setAttribute('aria-hidden', 'true');
    value.textContent = code; li.append(number, value); list.append(li);
  });
  root.querySelector('[data-copy]').onclick = async () => {
    const text = codes.join('\n'), status = root.querySelector('.copy-status');
    let copied = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; } } catch { /* HTTP and browser permissions may require the selection fallback. */ }
    if (!copied) {
      const field = document.createElement('textarea'); field.value = text; field.readOnly = true;
      field.style.cssText = 'position:fixed;opacity:0;width:1px;height:1px'; root.append(field); field.select();
      try { copied = document.execCommand('copy'); } catch { /* The raw values remain selectable. */ }
      field.remove();
      root.querySelector('[data-copy]').focus({ preventScroll: true });
    }
    status.textContent = copied ? '恢复码已复制' : '未能复制，请选择并保存上方恢复码。';
  };
}

/** Only display separators are removed; arbitrary characters and extra digits stay invalid. */
export function normalizeOtp(value) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/[\s\u200B-\u200D\uFEFF-]/gu, '') : '';
}

/** Normalize before maxlength can truncate a pasted "123 456" into five digits. */
export function prepareOtpInput(input, normalize) {
  input.addEventListener('input', () => { input.value = normalize(input.value); });
  input.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text');
    if (text === undefined) return;
    event.preventDefault();
    input.value = normalize(text).slice(0, 32);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export function showOtpError(element, error, buttons = []) {
  clearInterval(element.totpCountdown);
  const seconds = Number.isFinite(error.retryAfterSeconds) ? Math.max(0, error.retryAfterSeconds) : 0;
  if (!seconds) { element.textContent = error.message; return; }
  const until = Date.now() + seconds * 1000;
  const tick = () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    if (!element.isConnected) { clearInterval(element.totpCountdown); return; }
    element.textContent = left ? `${error.message}（${left} 秒后可重试）` : '可以重试了，请输入验证器当前显示的新动态码。';
    buttons.forEach(button => { button.disabled = left > 0; });
    if (!left) clearInterval(element.totpCountdown);
  };
  element.totpCountdown = setInterval(tick, 250); tick();
}

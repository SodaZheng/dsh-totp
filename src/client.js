/* DSH browser module; React and slots come from the host, not a bundled copy. */
window.__ModuleLoader__.load({ id: 'dsh-totp', factory: require => {
  const React = require('react');
  function AccessSettings() {
    const target = React.useRef(null);
    const [ready, setReady] = React.useState(true);
    React.useLayoutEffect(() => {
      const detail = { target: target.current, attached: false };
      window.dispatchEvent(new CustomEvent('dsh-totp:settings-mount', { detail }));
      setReady(detail.attached);
      return () => window.dispatchEvent(new CustomEvent('dsh-totp:settings-unmount', { detail: { target: detail.target } }));
    }, []);
    return React.createElement('section', { 'aria-label': 'DSH TOTP · 访问验证' },
      React.createElement('div', { ref: target }),
      !ready && React.createElement('p', { style: { color: 'var(--dsw-alias-label-secondary)' } }, '访问验证页面尚未加载，请重启 DSH 后重新打开设置。'));
  }
  return {
    name: 'dsh-totp', inject: ['slots'],
    apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section', id: 'dsh-totp', order: 15, label: '访问验证',
      }, AccessSettings));
    },
  };
} });

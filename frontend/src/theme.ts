export type ProductTheme = 'dark' | 'light';

export function installProductTheme(doc: Document): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  const updateControls = () => {
    const light = doc.documentElement.dataset.theme === 'light';
    doc.querySelectorAll<HTMLButtonElement>('[data-theme-toggle]').forEach(button => {
      button.setAttribute('aria-label', light ? '切换到黑绿深色' : '切换到蓝白浅色');
      button.setAttribute('aria-pressed', String(light));
      const label = light ? '☾ 黑绿深色' : '☀ 蓝白浅色';
      if (button.textContent !== label) button.textContent = label;
    });
    doc.querySelectorAll<HTMLButtonElement>('[data-theme-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === (light ? 'light' : 'dark')));
    });
  };
  const apply = (theme: ProductTheme) => {
    const freeze = doc.createElement('style');
    freeze.textContent = '*,*::before,*::after{transition:none!important}';
    doc.head.append(freeze);
    doc.documentElement.dataset.theme = theme;
    doc.documentElement.style.colorScheme = theme;
    try { win.localStorage.setItem('shensi.theme', theme); } catch { /* Optional cache. */ }
    // Host-scoped appearance cookie survives desktop gateway port changes.
    doc.cookie = `shensi_theme=${theme}; Path=/; Max-Age=31536000; SameSite=Strict${win.location.protocol === 'https:' ? '; Secure' : ''}`;
    updateControls();
    void doc.documentElement.offsetHeight;
    win.requestAnimationFrame(() => win.requestAnimationFrame(() => freeze.remove()));
  };
  const click = (event: Event) => {
    const target = event.target;
    if (!(target instanceof win.Element)) return;
    const button = target.closest<HTMLElement>('[data-theme-toggle], [data-theme-choice]');
    if (!button) return;
    const choice = button.dataset.themeChoice;
    apply(choice === 'light' || choice === 'dark' ? choice
      : doc.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  };
  doc.addEventListener('click', click);
  const observer = new win.MutationObserver(updateControls);
  observer.observe(doc.body, { childList: true, subtree: true });
  updateControls();
  return () => { doc.removeEventListener('click', click); observer.disconnect(); };
}

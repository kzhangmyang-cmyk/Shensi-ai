import { mountGalaxyDust } from './galaxy-dust';

/** Decorative only; no model, progress, account or business inputs. */
export function mountDecisionAtmosphere(root: HTMLElement, retainOnDetach=false) {
  const doc = root.ownerDocument, win = doc.defaultView;
  const background=doc.createElement('img');background.src=new URL('./assets/galaxy-cosmos-blue.png',import.meta.url).href;background.alt='';background.className='decision-cosmos-background';background.setAttribute('aria-hidden','true');root.prepend(background);
  const canvas = doc.createElement('canvas'); canvas.className = 'decision-universe'; canvas.setAttribute('aria-hidden', 'true'); root.prepend(canvas);
  const button = doc.createElement('button'); button.type = 'button'; button.dataset.atmosphereToggle = '';
  root.querySelector('.decision-hero')?.append(button);
  const dust = mountGalaxyDust(canvas);
  const media = win?.matchMedia?.('(prefers-reduced-motion: reduce)');
  let active = true, reduced = false, disposed = false;
  const sync = () => {
    const narrow = root.getBoundingClientRect().width < 700;
    const running = !disposed && active && root.isConnected && !doc.hidden && !reduced && !media?.matches && !narrow;
    root.dataset.atmosphere = running ? 'running' : 'paused'; dust.setRunning(running);
    button.setAttribute('aria-pressed', String(reduced || Boolean(media?.matches)));
    button.textContent = media?.matches ? '已遵循系统减少动态' : narrow ? '窄屏静态星空' : reduced ? '开启星空动态' : '关闭星空动态';
    button.disabled = narrow || Boolean(media?.matches);
  };
  button.onclick = () => { reduced = !reduced; sync(); };
  const resize = win?.ResizeObserver ? new win.ResizeObserver(sync) : undefined; resize?.observe(root);
  if (!resize) win?.addEventListener('resize', sync);
  doc.addEventListener('visibilitychange', sync); media?.addEventListener('change', sync);
  const observer = win?.MutationObserver ? new win.MutationObserver(() => { if (!root.isConnected) { if(retainOnDetach)sync();else dispose(); } }) : undefined;
  observer?.observe(doc.body, { childList: true, subtree: true });
  function dispose() {
    if (disposed) return; disposed = true; sync(); dust.dispose(); resize?.disconnect(); observer?.disconnect();
    win?.removeEventListener('resize', sync); doc.removeEventListener('visibilitychange', sync); media?.removeEventListener('change', sync);
    button.onclick = null;
  }
  sync(); return { setActive(value: boolean) { active = value; sync(); }, dispose };
}

import "./brand-entry.css";

// The desktop splash's original keyframes are kept in brand-entry.css.
// Only their clock changes: a paused timeline is scrubbed in either direction.
export function createBrandEntry(hero: HTMLElement) {
  const layer = document.createElement("div");
  layer.className = "entry-splash is-playing";
  layer.setAttribute("aria-hidden", "true");
  const logo = `<svg viewBox="0 0 1254 1254"><image href="/assets/shensi-logo.png" width="1254" height="1254" filter="url(#entry-remove-white)" /></svg>`;
  layer.innerHTML = `<svg width="0" height="0" style="position:absolute"><defs><filter id="entry-remove-white" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  -1 -1 -1 0 2.85" /></filter></defs></svg><div class="entry-ambient-grid"></div><div class="entry-brand-stage"><div class="entry-orbit"></div><div class="entry-trail entry-trail-a"></div><div class="entry-trail entry-trail-b"></div><div class="entry-trail entry-trail-c"></div><div class="entry-energy-core"></div>${["top", "left", "right"].map(position => `<div class="entry-atom entry-atom-${position}">${logo}</div>`).join("")}<div class="entry-logo">${logo}</div></div>`;
  hero.append(layer);
  return (progress: number, paused: boolean) => {
    const t = Math.min(1, Math.max(0, progress / .72));
    layer.getAnimations({ subtree: true }).forEach(animation => {
      animation.pause();
      animation.currentTime = t * 8750;
    });
    layer.style.opacity = String(paused ? 0 : 1 - Math.min(1, Math.max(0, (progress - .64) / .16)));
    layer.style.setProperty("--entry-scale", String(Math.min(.9, (hero.clientWidth - 36) / 620, (hero.clientHeight - 120) / 620)));
  };
}

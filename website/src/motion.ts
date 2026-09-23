import { pick, type Locale } from "./content";
import { createBrandEntry } from "./brand-entry";

type Point = { x: number; y: number; z: number };
const clamp = (x: number, min = 0, max = 1) => Math.min(max, Math.max(min, x));
const tau = Math.PI * 2;
// Deterministic, bounded geometry: no external renderer, tracking, or random frame churn.
function shape(index: number, point: number, count: number): Point {
  const u = point / count;
  const a = point * 2.39996323;
  const z = 1 - 2 * u;
  const r = Math.sqrt(1 - z * z);
  if (index === 0) {
    const ring = point % 3;
    const t = u * tau * 7;
    const tilt = ring * Math.PI / 3;
    const x = Math.cos(t), y = Math.sin(t) * .45;
    const jitter = Math.sin(point * 43.7) * .04;
    return { x: x * Math.cos(tilt) - y * Math.sin(tilt), y: x * Math.sin(tilt) + y * Math.cos(tilt), z: Math.sin(t) * .55 + jitter };
  }
  if (index === 1) {
    const x = ((point % 48) / 47 - .5) * 2.2;
    const depth = (Math.floor(point / 48) / Math.ceil(count / 48) - .5) * 2;
    return { x, y: Math.sin(x * 3 + depth * 2) * .22 + Math.cos(depth * 5) * .1, z: depth };
  }
  if (index === 2) {
    const x = ((point % 48) / 47 - .5) * 2;
    const y = (Math.floor(point / 48) / Math.ceil(count / 48) - .5) * 1.6;
    return { x, y: y + Math.abs(x) * .25, z: Math.sin(Math.abs(x) * 2.8) * .42 };
  }
  if (index === 3) {
    const edge = point % 4;
    const x = (edge < 2 ? edge * 2 - 1 : Math.cos(a)) * .72;
    const y = z * .85;
    return { x, y, z: (edge >= 2 ? (edge - 2) * 2 - 1 : Math.sin(a)) * .72 };
  }
  return { x: Math.cos(a) * r, y: z, z: Math.sin(a) * r };
}

export function setupMotion(locale: Locale) {
  const preference = matchMedia("(prefers-reduced-motion: reduce)");
  const narrow = matchMedia("(max-width: 800px)");
  const toggle = document.querySelector<HTMLButtonElement>(".motion-toggle")!;
  const hero = document.querySelector<HTMLElement>(".hero");
  const updateBrandEntry = hero ? createBrandEntry(hero) : null;
  const introTrack = document.querySelector<HTMLElement>(".hero-scroll");
  const rings = [...document.querySelectorAll<HTMLElement>(".orbit")];
  const introParts = ["hero-title", "hero-description", "hero-buttons", "hero-disciplines"]
    .map(className => document.querySelector<HTMLElement>(`.${className}`));
  let introProgress = 0;
  const track = document.querySelector<HTMLElement>(".story-track");
  const scenes = [...document.querySelectorAll<HTMLElement>(".story-scene")];
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-scene]")];
  const heroCanvas = document.querySelector<HTMLCanvasElement>(".hero-particles");
  const storyCanvas = document.querySelector<HTMLCanvasElement>(".story-particles");
  const heroCtx = heroCanvas?.getContext("2d");
  const storyCtx = storyCanvas?.getContext("2d");
  let paused = preference.matches;
  let frame = 0;
  let scene = 0;
  let visible = true;
  let phase = 0;
  let last = 0;
  const cursor = { x: -10000, y: -10000 };
  const count = 3200;
  const points = Array.from({ length: count }, (_, i) => shape(0, i, count));
  const targets = Array.from({ length: 5 }, (_, s) => Array.from({ length: count }, (_, i) => shape(s, i, count)));
  let heroSize = { width: 0, height: 0 };
  let storySize = { width: 0, height: 0 };

  function size(canvas: HTMLCanvasElement | null) {
    if (!canvas) return { width: 0, height: 0 };
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
    canvas.getContext("2d")?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width: rect.width, height: rect.height };
  }
  function resize() { heroSize = size(heroCanvas); storySize = size(storyCanvas); updateScroll(); }
  function setScene(next: number) {
    scene = next;
    if (paused || narrow.matches) return;
    scenes.forEach((s, i) => { const active = i === scene; s.classList.toggle("active", active); s.inert = !active; s.setAttribute("aria-hidden", String(!active)); });
    buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(i === scene)));
    const progress = document.querySelector<HTMLElement>(".story-progress i");
    if (progress) progress.style.width = `${(scene + 1) * 20}%`;
  }
  function updateScroll() {
    if (hero && introTrack) {
      introProgress = paused ? 1 : clamp(-introTrack.getBoundingClientRect().top / Math.max(1, introTrack.offsetHeight - hero.offsetHeight));
      updateBrandEntry?.(introProgress, paused);
      const smooth = (start: number, end: number) => {
        const t = clamp((introProgress - start) / (end - start));
        return t * t * (3 - 2 * t);
      };
      const gather = smooth(0, .42);
      const cue = hero.querySelector<HTMLElement>(".scroll-cue");
      if (cue) {
        cue.style.opacity = String(paused ? 1 : 1 - smooth(.8, .9));
        cue.inert = !paused && introProgress >= .9;
      }
      hero.style.setProperty("--intro-brand", String(paused ? 1 : smooth(.66, .8)));
      hero.style.setProperty("--intro-logo-y", `${(narrow.matches ? 105 : 130) * (1 - gather)}px`);
      hero.style.setProperty("--intro-logo-scale", String(1.5 - gather * .5));
      hero.style.setProperty("--intro-pulse", String(Math.sin(clamp((introProgress - .3) / .18) * Math.PI)));
      const stages = [[.72, .82], [.77, .87], [.82, .92], [.87, .96]];
      ["title", "description", "buttons", "disciplines"].forEach((name, i) => {
        const amount = paused ? 1 : smooth(stages[i][0], stages[i][1]);
        hero.style.setProperty(`--intro-${name}`, String(amount));
        const part = introParts[i];
        if (part) {
          part.inert = amount < .05;
          if (amount < .05) part.setAttribute("aria-hidden", "true");
          else part.removeAttribute("aria-hidden");
        }
      });
      rings.forEach((ring, i) => {
        ring.style.transform = paused ? "" : `rotate(${[-18, 60, -65][i] + gather * 70}deg) scale(${1.7 - gather * 1.12})`;
        ring.style.opacity = paused ? "" : String(1 - gather * .7);
      });
    }
    if (!track || paused || narrow.matches) return;
    const bounds = track.getBoundingClientRect();
    setScene(Math.min(4, Math.floor(clamp(-bounds.top / Math.max(1, bounds.height - innerHeight)) * 5)));
  }
  buttons.forEach((button, index) => button.addEventListener("click", () => {
    if (paused || narrow.matches) scenes[index]?.scrollIntoView({ behavior: paused ? "instant" : "smooth", block: "center" });
    else if (track) {
      const top = scrollY + track.getBoundingClientRect().top;
      window.scrollTo({ top: top + (track.offsetHeight - innerHeight) * (index / 5 + .035), behavior: "smooth" });
    }
    buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(i === index)));
  }));

  function draw(now: number) {
    frame = 0;
    if (paused || document.hidden || !visible) return;
    const delta = Math.min(32, now - (last || now)); last = now; phase += delta * .00012;
    if (heroCtx && hero && heroCanvas && hero.getBoundingClientRect().bottom > 0) {
      const { width: w, height: h } = heroSize;
      heroCtx.clearRect(0, 0, w, h);
      const n = narrow.matches ? 75 : 180;
      for (let i = 0; i < n; i++) {
        const a = i * 2.399 + introProgress * 2;
        const radius = (110 + i * 1.2) * (1 - clamp(introProgress / .42) * .75);
        const x = w / 2 + Math.cos(a) * radius * 1.7;
        const y = h * .33 + Math.sin(a) * radius * .52;
        heroCtx.fillStyle = `rgba(44,126,221,${.1 + (i % 7) * .045})`;
        heroCtx.beginPath(); heroCtx.arc(x, y, i % 11 === 0 ? 1.7 : .7, 0, tau); heroCtx.fill();
      }
    }
    if (storyCtx && storyCanvas && !narrow.matches && track) {
      const rect = track.getBoundingClientRect();
      if (rect.top < innerHeight && rect.bottom > 0) {
        const { width: w, height: h } = storySize;
        storyCtx.clearRect(0, 0, w, h);
        const scale = Math.min(w * .21, h * .42);
        const rotation = phase * .24;
        const c = Math.cos(rotation), s = Math.sin(rotation);
        for (let i = 0; i < count; i++) {
          const p = points[i], target = targets[scene][i];
          p.x += (target.x - p.x) * .045; p.y += (target.y - p.y) * .045; p.z += (target.z - p.z) * .045;
          const x = p.x * c + p.z * s;
          const z = p.z * c - p.x * s;
          const perspective = 3.3 / (3.3 + z);
          let sx = w * .74 + x * scale * perspective;
          let sy = h * .50 + (p.y * .9 - z * .2) * scale * perspective;
          const dx = sx - cursor.x, dy = sy - cursor.y;
          const distance = Math.hypot(dx, dy);
          if (distance < 95 && distance > 0) { const force = (1 - distance / 95) * 18; sx += dx / distance * force; sy += dy / distance * force; }
          const alpha = clamp(.4 + (1 - z) * .2, .15, .85);
          storyCtx.fillStyle = i % 5 === 0 ? `rgba(19,162,202,${alpha})` : `rgba(35,100,215,${alpha})`;
          storyCtx.beginPath(); storyCtx.arc(sx, sy, (i % 17 === 0 ? 1.8 : 1) * perspective, 0, tau); storyCtx.fill();
        }
      }
    }
    frame = requestAnimationFrame(draw);
  }
  function start() { if (!frame && !paused && !document.hidden && visible && (hero || track)) { last = 0; frame = requestAnimationFrame(draw); } }
  function applyPreference() {
    document.documentElement.classList.toggle("motion-off", paused);
    document.documentElement.classList.toggle("motion-active", !paused);
    toggle.setAttribute("aria-pressed", String(paused));
    toggle.textContent = paused ? pick(locale, "开启动态效果", "Enable motion") : pick(locale, "关闭动态效果", "Pause motion");
    scenes.forEach(scene => { scene.inert = false; scene.removeAttribute("aria-hidden"); });
    if (frame) cancelAnimationFrame(frame); frame = 0;
    document.querySelectorAll<HTMLElement>(".orbit").forEach(ring => { ring.style.transform = ""; ring.style.opacity = ""; });
    resize(); start();
  }
  toggle.addEventListener("click", () => { paused = !paused; applyPreference(); });
  preference.addEventListener("change", () => { paused = preference.matches; applyPreference(); });
  narrow.addEventListener("change", applyPreference);
  window.addEventListener("scroll", updateScroll, { passive: true });
  window.addEventListener("resize", resize, { passive: true });
  document.addEventListener("visibilitychange", () => { if (document.hidden && frame) { cancelAnimationFrame(frame); frame = 0; } else start(); });
  track?.addEventListener("pointermove", event => { if (!storyCanvas) return; const rect = storyCanvas.getBoundingClientRect(); cursor.x = event.clientX - rect.left; cursor.y = event.clientY - rect.top; }, { passive: true });
  track?.addEventListener("pointerleave", () => { cursor.x = -10000; cursor.y = -10000; });
  if (hero || track) {
    const observation = new Map<Element, boolean>();
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => observation.set(entry.target, entry.isIntersecting));
      visible = [...observation.values()].some(Boolean);
      if (visible) start(); else if (frame) { cancelAnimationFrame(frame); frame = 0; }
    });
    if (hero) observer.observe(hero); if (track) observer.observe(track);
  }
  applyPreference();
}

type TimerHandle = unknown;

export interface StartupSplashOptions {
  readonly document: Document;
  readonly enabled: boolean;
  readonly minimumDurationMs?: number;
  readonly reducedMotion?: boolean;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly cancel?: (handle: TimerHandle) => void;
}

export interface StartupSplashController {
  readonly finished: Promise<void>;
  complete(): void;
  fail(retry: () => void): void;
  dispose(): void;
}

const LOGO_IMAGE = `<svg viewBox="0 0 1254 1254" preserveAspectRatio="xMidYMid meet" focusable="false"><image href="/assets/shensi-logo.png" width="1254" height="1254" filter="url(#startup-remove-white)" /></svg>`;

const MARKUP = `<section class="startup-splash is-playing" data-startup-splash
  aria-label="Shensi 正在启动" aria-live="polite">
  <svg class="startup-filter-defs" aria-hidden="true" width="0" height="0">
    <defs><filter id="startup-remove-white" color-interpolation-filters="sRGB">
      <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  -1 -1 -1 0 2.85" />
    </filter></defs>
  </svg>
  <div class="startup-ambient-grid" aria-hidden="true"></div>
  <div class="startup-brand-stage" aria-hidden="true">
    <div class="startup-orbit"></div>
    <div class="startup-trail startup-trail-a"></div>
    <div class="startup-trail startup-trail-b"></div>
    <div class="startup-trail startup-trail-c"></div>
    <div class="startup-energy-core"></div>
    <div class="startup-atom startup-atom-top" data-startup-atom>${LOGO_IMAGE}</div>
    <div class="startup-atom startup-atom-left" data-startup-atom>${LOGO_IMAGE}</div>
    <div class="startup-atom startup-atom-right" data-startup-atom>${LOGO_IMAGE}</div>
    <svg class="startup-logo" data-startup-logo viewBox="0 0 1254 1254" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Shensi">
      <image href="/assets/shensi-logo.png" width="1254" height="1254" filter="url(#startup-remove-white)" />
    </svg>
  </div>
  <div class="startup-status" data-startup-status>
    <strong>正在准备经营工作台</strong>
    <span>初始化与品牌动效并行；界面就绪后立即进入</span>
  </div>
  <article class="startup-error" data-startup-error>
    <h2>启动未完成</h2>
    <p>经营工作台初始化失败。动画不会无限等待，你可以重新尝试。</p>
    <button type="button" data-startup-retry>重新尝试</button>
  </article>
</section>`;

export function installStartupSplash(
  options: StartupSplashOptions
): StartupSplashController | null {
  if (!options.enabled) return null;
  options.document.querySelector("[data-startup-splash]")?.remove();
  options.document.body.insertAdjacentHTML("afterbegin", MARKUP);
  const splash = options.document.querySelector<HTMLElement>("[data-startup-splash]");
  const retryButton = options.document.querySelector<HTMLButtonElement>("[data-startup-retry]");
  if (!splash || !retryButton) return null;

  const schedule = options.schedule ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  const now = options.now ?? (() => Date.now());
  const minimumDuration = options.minimumDurationMs ?? (options.reducedMotion ? 1_100 : 8_800);
  let startedAt = now();
  let timer: TimerHandle | null = null;
  let retry: (() => void) | null = null;
  let disposed = false;
  let resolveFinished!: () => void;
  const finished = new Promise<void>(resolve => { resolveFinished = resolve; });
  let finishedOnce = false;
  const markFinished = () => { if (finishedOnce) return; finishedOnce = true; resolveFinished(); };

  const cancelTimer = () => {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  };
  const replay = () => {
    cancelTimer();
    splash.classList.remove("is-ready", "is-failed", "is-playing");
    void splash.offsetWidth;
    splash.classList.add("is-playing");
    startedAt = now();
  };
  const onRetry = () => {
    const currentRetry = retry;
    retry = null;
    replay();
    currentRetry?.();
  };
  retryButton.addEventListener("click", onRetry);

  return {
    finished,
    complete() {
      if (disposed || splash.classList.contains("is-failed")) return;
      cancelTimer();
      const remainingDuration = Math.max(0, minimumDuration - (now() - startedAt));
      timer = schedule(() => {
        timer = null;
        splash.classList.add("is-ready");
        timer = schedule(() => {
          timer = null;
          splash.remove();
          markFinished();
        }, 650);
      }, remainingDuration);
    },
    fail(nextRetry) {
      if (disposed) return;
      cancelTimer();
      retry = nextRetry;
      splash.classList.remove("is-playing", "is-ready");
      splash.classList.add("is-failed");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      retryButton.removeEventListener("click", onRetry);
      cancelTimer();
      splash.remove();
      markFinished();
    }
  };
}

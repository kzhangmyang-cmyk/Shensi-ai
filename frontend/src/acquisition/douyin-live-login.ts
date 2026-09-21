import {
  AcquisitionHttpError,
  type DouyinLiveLoginApi
} from "./douyin-automation-api";

type LiveRfbListener = EventListenerOrEventListenerObject;

export interface DouyinLiveRfb {
  viewOnly: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  focusOnClick: boolean;
  addEventListener(type: string, listener: LiveRfbListener): void;
  removeEventListener(type: string, listener: LiveRfbListener): void;
  disconnect(): void;
}

export interface DouyinLiveLoginOptions {
  sessionId: string;
  pageOrigin: string;
  api: DouyinLiveLoginApi;
  createRfb(target: HTMLElement, socketUrl: string): DouyinLiveRfb;
  closePage?: () => void;
  layout?: "page" | "embedded";
  retryDelayMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

function liveSocketUrl(pageOrigin: string, socketPath: string): string {
  const url = new URL(socketPath, pageOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function isStartingContextError(error: unknown): boolean {
  return error instanceof AcquisitionHttpError
    && error.status === 409
    && error.code === "douyin_login_session_not_ready";
}

function renderShell(host: HTMLElement, layout: "page" | "embedded"): void {
  if (layout === "embedded") {
    host.innerHTML = `
      <section class="douyin-live-login-embedded" aria-label="可交互的抖音登录页面">
        <p class="douyin-live-login-status" data-douyin-live-status role="status" aria-live="polite">
          正在连接安全登录环境…
        </p>
        <section class="douyin-live-login-screen" data-douyin-live-screen aria-label="可交互的抖音登录页面"></section>
        <footer class="douyin-live-login-footer">
          <p>登录成功后请保持本页打开，系统会自动确认账号绑定。</p>
          <button type="button" class="secondary" data-douyin-live-reconnect>重新连接画面</button>
        </footer>
      </section>`;
    return;
  }
  host.innerHTML = `
    <main class="douyin-live-login-page" aria-labelledby="douyinLiveLoginTitle">
      <header class="douyin-live-login-head">
        <div>
          <span class="douyin-eyebrow">SECURE LIVE LOGIN</span>
          <h1 id="douyinLiveLoginTitle">抖音真实登录窗口</h1>
          <p>这里操作的是采集、评论与私信共用的同一个安全登录环境。</p>
        </div>
        <button type="button" class="secondary" data-douyin-live-close>关闭窗口</button>
      </header>
      <p class="douyin-live-login-status" data-douyin-live-status role="status" aria-live="polite">
        正在连接安全登录环境…
      </p>
      <section class="douyin-live-login-screen" data-douyin-live-screen aria-label="可交互的抖音登录页面"></section>
      <footer class="douyin-live-login-footer">
        <p>此窗口只负责远程画面；二维码状态与刷新操作请以获客中心提示为准。</p>
        <button type="button" class="primary" data-douyin-live-reconnect>重新连接画面</button>
      </footer>
    </main>`;
}

function safeStatus(host: HTMLElement, message: string, error = false): void {
  const status = host.querySelector<HTMLElement>("[data-douyin-live-status]");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-error", error);
}

export async function mountDouyinLiveLoginPage(
  host: HTMLElement,
  options: DouyinLiveLoginOptions
): Promise<() => void> {
  renderShell(host, options.layout ?? "page");
  const aborter = new AbortController();
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const retryDelayMs = options.retryDelayMs ?? 1_500;
  let rfb: DouyinLiveRfb | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let connectFlight: Promise<void> | null = null;
  let generation = 0;
  let destroyed = false;

  const clearScreen = () => {
    host.querySelector<HTMLElement>("[data-douyin-live-screen]")?.replaceChildren();
  };

  const onConnect: EventListener = () => {
    safeStatus(host, "远程画面已连接；二维码状态以获客中心提示为准。");
  };
  const onDisconnect: EventListener = () => {
    clearScreen();
    if (!destroyed) safeStatus(host, "远程画面已断开，请点击“重新连接画面”。", true);
  };

  const disconnect = () => {
    if (!rfb) return;
    rfb.removeEventListener("connect", onConnect);
    rfb.removeEventListener("disconnect", onDisconnect);
    rfb.disconnect();
    rfb = null;
    clearScreen();
  };

  const clearRetry = () => {
    if (retryTimer === null) return;
    clearTimer(retryTimer);
    retryTimer = null;
  };

  const connect = (): Promise<void> => {
    if (destroyed || retryTimer !== null) return Promise.resolve();
    if (connectFlight) return connectFlight;
    const ownGeneration = ++generation;
    disconnect();
    clearScreen();
    safeStatus(host, "正在连接安全登录环境…");
    const flight = (async () => {
      try {
        const liveSession = await options.api.createLiveLoginSession(
          options.sessionId,
          aborter.signal
        );
        if (destroyed || ownGeneration !== generation) return;
        const screen = host.querySelector<HTMLElement>("[data-douyin-live-screen]");
        if (!screen) return;
        const nextRfb = options.createRfb(
          screen,
          liveSocketUrl(options.pageOrigin, liveSession.socketPath)
        );
        nextRfb.viewOnly = false;
        nextRfb.scaleViewport = true;
        nextRfb.resizeSession = true;
        nextRfb.focusOnClick = true;
        nextRfb.addEventListener("connect", onConnect);
        nextRfb.addEventListener("disconnect", onDisconnect);
        rfb = nextRfb;
      } catch (error) {
        if (!destroyed && ownGeneration === generation
          && !(error instanceof DOMException && error.name === "AbortError")
          && isStartingContextError(error)) {
          safeStatus(host, "安全登录环境正在启动，将自动重试…");
          retryTimer = setTimer(() => {
            retryTimer = null;
            void connect();
          }, retryDelayMs);
        } else if (!destroyed && ownGeneration === generation
          && !(error instanceof DOMException && error.name === "AbortError")) {
          safeStatus(host, error instanceof AcquisitionHttpError && error.status === 503
            ? "抖音登录服务暂时不可用，请稍后创建新登录会话。"
            : "真实登录窗口连接失败，请创建新登录会话。", true);
        }
      }
    })();
    connectFlight = flight;
    void flight.finally(() => {
      if (connectFlight === flight) connectFlight = null;
    });
    return flight;
  };

  const onClick = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest("[data-douyin-live-reconnect]")) void connect();
    else if (target?.closest("[data-douyin-live-close]")) options.closePage?.();
  };
  host.addEventListener("click", onClick);
  void connect();

  return () => {
    destroyed = true;
    generation += 1;
    aborter.abort();
    clearRetry();
    host.removeEventListener("click", onClick);
    disconnect();
  };
}

import {
  createDouyinAutomationApi,
  type DouyinAutomationApi,
  type DouyinLiveLoginApi
} from "./douyin-automation-api";
import {
  mountDouyinLiveLoginPage,
  type DouyinLiveRfb
} from "./douyin-live-login";

export type DouyinRfbFactory = (
  target: HTMLElement,
  socketUrl: string
) => DouyinLiveRfb;

type RoutedLiveLoginApi = Pick<DouyinAutomationApi, "getLoginSession">
  & DouyinLiveLoginApi;

interface RoutedDouyinLiveLoginOptions {
  sessionId: string;
  pageOrigin: string;
  api: RoutedLiveLoginApi;
  closePage?: () => void;
  layout?: "page" | "embedded";
  loadRfbFactory?: () => Promise<DouyinRfbFactory>;
}

async function loadDefaultRfbFactory(): Promise<DouyinRfbFactory> {
  const module = await import("./douyin-rfb-runtime");
  return module.createDouyinRfb;
}

function renderRouteStatus(
  host: HTMLElement,
  message: string,
  layout: "page" | "embedded",
): void {
  const element = layout === "embedded" ? "section" : "main";
  host.innerHTML = `<${element} class="douyin-live-login-${layout}">
    <p class="douyin-live-login-status" role="status" aria-live="polite">${message}</p>
  </${element}>`;
}

export async function mountRoutedDouyinLiveLogin(
  host: HTMLElement,
  options: RoutedDouyinLiveLoginOptions,
): Promise<() => void> {
  const layout = options.layout ?? "page";
  const aborter = new AbortController();
  let destroyed = false;
  let nestedUnmount: (() => void) | null = null;
  renderRouteStatus(host, "正在确认登录窗口类型…", layout);

  void (async () => {
    try {
      const session = await options.api.getLoginSession(
        options.sessionId,
        aborter.signal,
      );
      if (destroyed) return;
      if (session.interactionSurface === "external_window") {
        renderRouteStatus(
          host,
          "此账号使用外部浏览器登录，请返回获客中心并在已打开的外部浏览器中完成操作。",
          layout,
        );
        return;
      }

      const createRfb = await (
        options.loadRfbFactory?.() ?? loadDefaultRfbFactory()
      );
      if (destroyed) return;
      const unmount = await mountDouyinLiveLoginPage(host, {
        sessionId: options.sessionId,
        pageOrigin: options.pageOrigin,
        api: options.api,
        createRfb,
        closePage: options.closePage,
        layout,
      });
      if (destroyed) {
        unmount();
        return;
      }
      nestedUnmount = unmount;
    } catch (error) {
      if (destroyed
        || error instanceof DOMException && error.name === "AbortError") return;
      renderRouteStatus(
        host,
        "无法确认登录窗口状态，请返回获客中心重新打开登录页。",
        layout,
      );
    }
  })();

  return () => {
    destroyed = true;
    aborter.abort();
    nestedUnmount?.();
    nestedUnmount = null;
    host.replaceChildren();
  };
}

export function mountEmbeddedDouyinLiveLogin(
  host: HTMLElement,
  sessionId: string,
): Promise<() => void> {
  return mountRoutedDouyinLiveLogin(host, {
    sessionId,
    pageOrigin: window.location.origin,
    api: createDouyinAutomationApi(),
    layout: "embedded",
  });
}

export async function startDouyinLiveLoginPage(
  sessionId: string,
): Promise<void> {
  const host = document.createElement("div");
  host.id = "douyinLiveLoginRoot";
  document.body.replaceChildren(host);

  const unmount = await mountRoutedDouyinLiveLogin(host, {
    sessionId,
    pageOrigin: window.location.origin,
    api: createDouyinAutomationApi(),
    closePage() {
      window.close();
    },
  });

  window.addEventListener("beforeunload", unmount, { once: true });
}

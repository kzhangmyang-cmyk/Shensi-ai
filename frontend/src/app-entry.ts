import { createAppSessionController } from "./app-session";
import { douyinLiveLoginSessionId } from "./app-route";
import { installDesktopRuntime } from "./desktop/desktop-runtime";
import { installCfoGreeting } from './desktop/cfo-greeting';
import { installAppUpdate, type AppUpdateBridge } from './desktop/app-update-view';
import { installStartupSplash } from './desktop/startup-splash';
import { installProductTheme } from './theme';

declare const __SHENSI_DESKTOP_BUILD__: boolean;

const desktopOnlyBuild = typeof __SHENSI_DESKTOP_BUILD__ !== "undefined"
  && __SHENSI_DESKTOP_BUILD__;

export interface AppEntryOptions {
  windowLike: { location: { hash: string }; readonly shensiDesktop?: Window["shensiDesktop"]; readonly shensiCfoVoice?: Window['shensiCfoVoice']; readonly shensiAppUpdate?: AppUpdateBridge };
  documentLike: Document;
  createSession?: () => Pick<ReturnType<typeof createAppSessionController>, "start"> & Partial<Pick<ReturnType<typeof createAppSessionController>, "destroy">>;
  loadLiveLogin?: () => Promise<Pick<typeof import("./acquisition/douyin-live-login-entry"), "startDouyinLiveLoginPage">>;
  startup?: {
    readonly enabled: boolean;
    readonly minimumDurationMs?: number;
    readonly timeoutMs?: number;
  };
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("startup_timeout")), timeoutMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function renderDesktopLegacyLoginGuidance(documentLike: Document): void {
  documentLike.body.innerHTML = `<main class="auth-shell"><section class="auth-panel"><span class="eyebrow">DESKTOP LOGIN</span><h1>桌面版使用外部浏览器登录</h1><p>此旧链接只适用于网页版远程登录窗口，桌面版不会加载远程画面。</p><a class="primary" href="#acquisition">返回抖音获客</a></section></main>`;
}

export async function startAppEntry(options: AppEntryOptions): Promise<void> {
  const startupEnabled = options.startup?.enabled ?? (typeof window !== "undefined"
    && options.windowLike === window
    && Boolean(options.windowLike.shensiDesktop || desktopOnlyBuild));
  const startup = installStartupSplash({
    document: options.documentLike,
    enabled: startupEnabled,
    minimumDurationMs: options.startup?.minimumDurationMs,
    reducedMotion: typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  });
  const desktopRuntime = installDesktopRuntime(options.windowLike, options.documentLike);
  const greeting = installCfoGreeting(options.documentLike, options.windowLike.shensiCfoVoice, startup?.finished);
  if (options.windowLike.shensiAppUpdate) installAppUpdate(options.documentLike, options.windowLike.shensiAppUpdate);
  const createSession = options.createSession ?? createAppSessionController;
  let appSession = createSession();
  let bootstrapGeneration = 0;
  const bootstrap = async (): Promise<void> => {
    const generation = ++bootstrapGeneration;
    try {
      const initialize = async () => {
        await appSession.start();
        if (generation !== bootstrapGeneration) return;
        void greeting?.refresh();
        if (desktopRuntime.bridge && options.documentLike.body.classList.contains("is-authenticated")) {
          await desktopRuntime.synchronizeWorkspace(desktopRuntime.accountId()).catch(() => undefined);
          if (generation !== bootstrapGeneration) return;
        }
        const sessionId = douyinLiveLoginSessionId(options.windowLike.location.hash);
        if (sessionId && options.documentLike.body.classList.contains("is-authenticated")) {
          if (desktopRuntime.bridge || desktopOnlyBuild) {
            renderDesktopLegacyLoginGuidance(options.documentLike);
          } else {
            const { startDouyinLiveLoginPage } = await (options.loadLiveLogin?.()
              ?? import("./acquisition/douyin-live-login-entry"));
            await startDouyinLiveLoginPage(sessionId);
            if (generation !== bootstrapGeneration) return;
          }
        }
      };
      const initialization = initialize();
      await (startup
        ? withDeadline(initialization, options.startup?.timeoutMs ?? 15_000)
        : initialization);
      if (generation !== bootstrapGeneration) return;
      startup?.complete();
    } catch (error) {
      if (generation !== bootstrapGeneration) return;
      if (!startup) throw error;
      bootstrapGeneration += 1;
      appSession.destroy?.();
      startup.fail(() => {
        appSession = createSession();
        void bootstrap();
      });
    }
  };
  await bootstrap();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  installProductTheme(document);
  void startAppEntry({ windowLike: window, documentLike: document });
}

import { isIP } from "node:net";

export interface CreateMainWindowOptions {
  localOrigin: string;
  preloadPath: string;
  BrowserWindow: new (options: Record<string, unknown>) => any;
  openExternal(url: string): Promise<void>;
}

function hasOrigin(value: string, expectedOrigin: string): boolean {
  try {
    return new URL(value).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function publicHttpsUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !host.includes(".") || host === "localhost" || host.endsWith(".localhost")
      || host.endsWith(".local") || isIP(host)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function createMainWindow(options: CreateMainWindowOptions): any {
  const localOrigin = new URL(options.localOrigin).origin;
  const window = new options.BrowserWindow({
    width: 1440,
    height: 960,
    show: true,
    backgroundColor: "#020303",
    webPreferences: {
      preload: options.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }: { url: string }) => {
    const external = publicHttpsUrl(url);
    if (external) void options.openExternal(external).catch(() => undefined);
    return { action: "deny" };
  });
  window.webContents.on(
    "will-navigate",
    (event: { preventDefault(): void }, target: string) => {
      if (!hasOrigin(target, localOrigin)) event.preventDefault();
    },
  );
  void window.loadURL(localOrigin);
  return window;
}

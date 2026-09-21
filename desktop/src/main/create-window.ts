export interface CreateMainWindowOptions {
  localOrigin: string;
  preloadPath: string;
  BrowserWindow: new (options: Record<string, unknown>) => any;
}

function hasOrigin(value: string, expectedOrigin: string): boolean {
  try {
    return new URL(value).origin === expectedOrigin;
  } catch {
    return false;
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

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on(
    "will-navigate",
    (event: { preventDefault(): void }, target: string) => {
      if (!hasOrigin(target, localOrigin)) event.preventDefault();
    },
  );
  void window.loadURL(localOrigin);
  return window;
}

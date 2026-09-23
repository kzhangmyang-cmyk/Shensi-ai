import { strict as assert } from "node:assert";
import test from "node:test";
import { createMainWindow } from "../src/main/create-window.ts";

test("main window has the required locked-down preferences and denies external navigation", () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  let options: Record<string, any> | null = null;
  const window = {
    webContents: {
      setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) { handlers.set("open", handler); },
      on(event: string, handler: (...args: any[]) => void) { handlers.set(event, handler); }
    },
    loadURL: async () => undefined
  };
  const created = createMainWindow({
    localOrigin: "http://127.0.0.1:45678",
    preloadPath: "/app/preload.js",
    openExternal: async () => undefined,
    BrowserWindow: class { constructor(value: Record<string, any>) { options = value; return window as any; } } as any
  });
  assert.equal(created, window);
  assert.deepEqual((options as any)?.webPreferences, {
    preload: "/app/preload.js", nodeIntegration: false, contextIsolation: true,
    sandbox: true, webviewTag: false
  });
  assert.equal((options as any)?.backgroundColor, "#020303");
  assert.equal((handlers.get("open")!({ url: "https://outside.example" }) as any).action, "deny");
  let prevented = false;
  handlers.get("will-navigate")!({ preventDefault() { prevented = true; } }, "https://outside.example");
  assert.equal(prevented, true);

  prevented = false;
  handlers.get("will-navigate")!({ preventDefault() { prevented = true; } }, "http://127.0.0.1:45678/#acquisition");
  assert.equal(prevented, false);

  prevented = false;
  assert.doesNotThrow(() => handlers.get("will-navigate")!({ preventDefault() { prevented = true; } }, "not a valid URL"));
  assert.equal(prevented, true);
});

test("user-facing HTTPS links open in the macOS default browser without navigating the app", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const opened: string[] = [];
  createMainWindow({
    localOrigin: "http://127.0.0.1:45678",
    preloadPath: "/app/preload.js",
    openExternal: async (url: string) => { opened.push(url); },
    BrowserWindow: class { constructor() { return {
      webContents: {
        setWindowOpenHandler(handler: (...args: any[]) => any) { handlers.set("open", handler); },
        on() {},
      },
      loadURL: async () => undefined,
    } as any; } } as any,
  });
  const open = handlers.get("open")!;
  for (const url of [
    "https://www.douyin.com/video/123",
    "https://help.aliyun.com/zh/model-studio/get-api-key",
  ]) assert.equal(open({ url }).action, "deny");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, [
    "https://www.douyin.com/video/123",
    "https://help.aliyun.com/zh/model-studio/get-api-key",
  ]);
  for (const url of [
    "javascript:alert(1)", "file:///etc/passwd", "http://example.com/",
    "https://127.0.0.1/private", "https://localhost/private",
    "https://user:pass@example.com/private", "http://127.0.0.1:45678/#settings",
  ]) assert.equal(open({ url }).action, "deny");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened.length, 2);
});

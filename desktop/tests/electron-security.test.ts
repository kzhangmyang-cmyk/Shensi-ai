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

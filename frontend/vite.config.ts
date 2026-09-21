import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { createDesktopDevApiProxy } from "./src/desktop/dev-api-proxy";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const desktopDevOrigin = "http://127.0.0.1:5188";
const desktopLiveLoginStub = fileURLToPath(
  new URL("./src/desktop/remote-canvas-disabled.ts", import.meta.url),
);

export default defineConfig(({ mode }) => ({
  plugins: [
    ...(mode === "desktop" ? [{
      name: "shensi-desktop-block-remote-canvas",
      enforce: "pre" as const,
      resolveId(source: string) {
        return source === "./acquisition/douyin-live-login-entry"
          || source === "./douyin-live-login-entry"
          ? desktopLiveLoginStub : null;
      }
    }] : []),
    react()
  ],
  define: {
    __SHENSI_DESKTOP_BUILD__: JSON.stringify(mode === "desktop")
  },
  build: {
    target: "es2022",
    rollupOptions: {
      input: {
        main: `${projectRoot}index.html`,
        admin: `${projectRoot}admin.html`,
        uiKit: `${projectRoot}ui-kit.html`
      }
    }
  },
  server: {
    proxy: {
      "/api": createDesktopDevApiProxy(
        process.env.VITE_API_TARGET || "http://127.0.0.1:4188",
        desktopDevOrigin,
      )
    }
  }
}));

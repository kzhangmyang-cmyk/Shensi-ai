import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Exercise the current desktop Renderer without loading the retained noVNC route.
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: "http://127.0.0.1:5188" },
  testMatch: ["douyin-mediacrawler-acquisition.spec.ts", "platform-selector.spec.ts"],
  grep: /desktop local collection progress|platform selector/u,
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map((server) => ({
    ...server,
    command: server.command?.includes("vite/bin/vite.js")
      ? `${server.command.replace("--port 5388", "--port 5188")} --mode desktop` : server.command,
    url: server.url === "http://127.0.0.1:5388/" ? "http://127.0.0.1:5188/" : server.url
  }))
});

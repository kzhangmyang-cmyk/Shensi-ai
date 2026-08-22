import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: `${projectRoot}index.html`,
        uiKit: `${projectRoot}ui-kit.html`
      }
    }
  },
  server: {
    proxy: {
      "/api": process.env.VITE_API_TARGET || "http://127.0.0.1:4188"
    }
  }
});

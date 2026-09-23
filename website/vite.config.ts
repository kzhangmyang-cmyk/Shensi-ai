// The public website has no customer API proxy or application runtime.
declare const process: { env: { WEBSITE_BUILD_TARGET?: string } };
export default {
  base: "/",
  server: { host: "127.0.0.1", port: 5690, strictPort: true, proxy: { "/api/website-contact": "http://127.0.0.1:5691" } },
  preview: { host: "127.0.0.1", port: 5690, strictPort: true },
  build: { target: "es2022", outDir: process.env.WEBSITE_BUILD_TARGET === "pages" ? "dist-pages" : "dist" },
};

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Separate output keeps local SMTP preview builds unchanged.
const repository = fileURLToPath(new URL("../../", import.meta.url));
const result = spawnSync("pnpm", ["website:build"], {
  cwd: repository, stdio: "inherit",
  env: { ...process.env, WEBSITE_BUILD_TARGET: "pages" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await import("./check-pages-package.mjs");

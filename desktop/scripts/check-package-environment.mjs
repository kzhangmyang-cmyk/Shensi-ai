import {
  normalizePackageMode,
  validateRemoteOrigin,
  validateReleaseEnvironment,
} from "./release-policy.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const mode = normalizePackageMode(process.argv[2] ?? process.env.SHENSI_PACKAGE_MODE);
if (mode === "release") {
  validateReleaseEnvironment(process.env);
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const approval = JSON.parse(await readFile(
    path.join(scriptDirectory, "..", "build", "icon-approval.json"), "utf8",
  ));
  if (approval?.status !== "product-owner-approved") {
    throw new Error("release packaging requires a product-owner-approved Shensi icon");
  }
}
else validateRemoteOrigin(process.env.SHENSI_REMOTE_ORIGIN, false);
console.log(JSON.stringify({ ok: true, mode }));

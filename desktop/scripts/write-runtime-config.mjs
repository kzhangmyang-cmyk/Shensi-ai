import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePackageMode, validateRemoteOrigin } from "./release-policy.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const outputDirectory = path.join(desktopRoot, "resources", "generated");
const outputPath = path.join(outputDirectory, "desktop-config.json");
const temporaryPath = path.join(outputDirectory, `desktop-config.${process.pid}.tmp`);
const value = process.env.SHENSI_REMOTE_ORIGIN;
const mode = normalizePackageMode(process.env.SHENSI_PACKAGE_MODE);
const origin = validateRemoteOrigin(value, mode === "release");

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await writeFile(
  temporaryPath,
  `${JSON.stringify({ remoteOrigin: origin })}\n`,
  { encoding: "utf8", mode: 0o600, flag: "wx" },
);
await rename(temporaryPath, outputPath);
await chmod(outputPath, 0o644);
console.log(JSON.stringify({ ok: true, config: "desktop/resources/generated/desktop-config.json" }));

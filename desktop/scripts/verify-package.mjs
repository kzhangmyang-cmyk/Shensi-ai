import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { listPackage } from "@electron/asar";
import { findDeveloperAbsolutePath, isReviewedVendorPathExample } from "./package-content-policy.mjs";
import { normalizePackageMode, validatePackagedRuntimeConfig } from "./release-policy.mjs";
import { verifyStandaloneResources } from './standalone-resources.mjs';
import { readDesktopBuildIdentity } from "../dist/main/desktop-build-identity.js";
import { verifyAppSignatureIntegrity } from "./macos-signature-policy.mjs";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const appPath = path.resolve(process.argv[2]
  ?? path.join(desktopRoot, "release", "mac-arm64", "Shensi.app"));
const packageMode = normalizePackageMode(process.argv[3]);
if (path.extname(appPath) !== ".app") throw new Error("expected a .app bundle path");

const appReal = await realpath(appPath);
await verifyAppSignatureIntegrity(appReal);
const resources = path.join(appReal, "Contents", "Resources");
const asarPath = path.join(resources, "app.asar");
const sidecarRoot = path.join(resources, "sidecar");
const sidecarInternal = path.join(sidecarRoot, "_internal");
const CFO_GREETING_ASSET_FILENAME = "startup-greeting-qwen35-tina-v1.wav";
const CFO_GREETING_ASSET_SHA256 = "78340a80314916b19bbb7cac6a85dcb2b1f512df1d7e00b8adc33ce9ab4b2ffd";
const cfoGreetingAsset = path.join(resources, "audio", CFO_GREETING_ASSET_FILENAME);
const runtimeConfig = validatePackagedRuntimeConfig(JSON.parse(await readFile(path.join(resources, 'desktop-config.json'), 'utf8')), packageMode === 'release');
const standalone = runtimeConfig.mode === 'standalone';
if (standalone) await verifyStandaloneResources(resources);
const required = [
  asarPath,
  path.join(resources, "desktop-build-manifest.json"),
  path.join(resources, "desktop-config.json"),
  path.join(resources, "frontend", "index.html"),
  path.join(resources, "sidecar", "shensi-sidecar"),
  path.join(resources, "playwright"),
  cfoGreetingAsset,
  path.join(resources, "licenses", "MediaCrawler-LICENSE"),
  path.join(sidecarInternal, "shensi_adapter", "vendor", "douyin_spider", "utils", "mstoken_profile.json"),
  path.join(sidecarInternal, "shensi_adapter", "vendor", "douyin_spider", "utils", "mstoken_common_profile.json"),
  path.join(sidecarInternal, "libs", "stealth.min.js"),
  path.join(sidecarInternal, "libs", "douyin.js"),
  path.join(sidecarInternal, "playwright", "driver", "node"),
  path.join(sidecarInternal, "playwright", "driver", "package", "package.json"),
  path.join(sidecarInternal, "certifi", "cacert.pem"),
];
for (const candidate of required) await stat(candidate);
const buildManifestSha256 = await readDesktopBuildIdentity(resources);

const cfoGreetingBytes = await readFile(cfoGreetingAsset);
if (cfoGreetingBytes.length !== 126_764
  || cfoGreetingBytes.subarray(0, 4).toString("ascii") !== "RIFF"
  || cfoGreetingBytes.subarray(8, 12).toString("ascii") !== "WAVE") {
  throw new Error("packaged startup greeting is not the validated WAV asset");
}
const cfoGreetingDigest = createHash("sha256").update(cfoGreetingBytes).digest("hex");
if (cfoGreetingDigest !== CFO_GREETING_ASSET_SHA256) {
  throw new Error("packaged startup greeting digest mismatch");
}

const asarEntries = listPackage(asarPath, { isPack: false });
for (const requiredEntry of ["/dist/main/main.js", "/dist/preload/preload.cjs"]) {
  if (!asarEntries.includes(requiredEntry)) {
    throw new Error(`required packaged entry missing: ${requiredEntry}`);
  }
}
if (asarEntries.includes("/dist/preload/preload.js")) {
  throw new Error("unsafe ESM preload entry was packaged");
}

// Database client modules can be transitive imports of MediaCrawler. The desktop
// boundary forbids database server binaries, not those inert Python modules.
const forbiddenName = /(?:^|[-_.])(novnc|xvfb|x11vnc|websockify|redis-server|mysqld|mysqld-safe)(?:[-_.]|$)/iu;
const forbiddenSecret = /^(?:\.env(?:\..*)?|sidecar-token(?:-.*)?|service-secret|cookies?\.json)$/iu;
const forbiddenSecretExtension = /(?:\.p12|\.p8|\.key|\.pem)$/iu;
const queue = [appReal];
let entries = 0;
const packagedFiles = [];
while (queue.length > 0) {
  const directory = queue.pop();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    entries += 1;
    if (entries > 200_000) throw new Error("package verification entry cap exceeded");
    const candidate = path.join(directory, entry.name);
    const permittedMysql = standalone && candidate.startsWith(`${path.join(resources, 'mysql')}${path.sep}`)
      && /^(?:mysqld|mysqld_safe|mysqld-safe)(?:[-_.]|$)/iu.test(entry.name);
    if (forbiddenName.test(entry.name) && !permittedMysql) throw new Error(`forbidden packaged component: ${entry.name}`);
    if (entry.name === ".links") throw new Error("Playwright SDK garbage-collection links must not be packaged");
    if (forbiddenSecret.test(entry.name)) throw new Error(`secret-like artifact: ${entry.name}`);
    if (forbiddenSecretExtension.test(entry.name)
      && candidate !== path.join(sidecarInternal, "certifi", "cacert.pem")) {
      throw new Error(`private-key-like artifact: ${entry.name}`);
    }
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      const linkTarget = await readlink(candidate);
      const leakedPath = findDeveloperAbsolutePath(linkTarget);
      if (leakedPath) {
        throw new Error(`developer absolute path leaked in packaged symlink target (${leakedPath}): ${path.relative(appReal, candidate)}`);
      }
      const target = await realpath(candidate);
      if (target !== appReal && !target.startsWith(`${appReal}${path.sep}`)) {
        throw new Error(`package symlink escapes the app: ${candidate}`);
      }
    } else if (metadata.isDirectory()) queue.push(candidate);
    else if (metadata.isFile()) packagedFiles.push(candidate);
  }
}

function onePackagedFile(description, predicate) {
  const matches = packagedFiles.filter(predicate);
  if (matches.length !== 1) throw new Error(`expected one ${description}, found ${matches.length}`);
  return matches[0];
}

onePackagedFile("Playwright package metadata", (candidate) =>
  candidate.startsWith(`${sidecarInternal}${path.sep}`)
    && /playwright-[^/]+\.dist-info\/METADATA$/u.test(candidate));
onePackagedFile("certifi package metadata", (candidate) =>
  candidate.startsWith(`${sidecarInternal}${path.sep}`)
    && /certifi-[^/]+\.dist-info\/METADATA$/u.test(candidate));

const browserExecutable = onePackagedFile("bundled Chromium executable", (candidate) =>
  candidate.startsWith(`${path.join(resources, "playwright")}${path.sep}`)
    && /chromium-\d+\/chrome-mac-(?:arm64|x64)\/Google Chrome for Testing\.app\/Contents\/MacOS\/Google Chrome for Testing$/u.test(candidate));

const sidecar = path.join(resources, "sidecar", "shensi-sidecar");
const executableMode = (await stat(sidecar)).mode & 0o111;
if (executableMode === 0) throw new Error("packaged Sidecar is not executable");
const { stdout: fileDescription } = await execFileAsync("/usr/bin/file", [sidecar]);
const expectedArchitecture = process.arch === "arm64" ? "arm64" : "x86_64";
if (!fileDescription.includes(expectedArchitecture)) {
  throw new Error(`Sidecar architecture mismatch: ${fileDescription.trim()}`);
}
for (const [description, executable] of [
  ["bundled Playwright Node", path.join(sidecarInternal, "playwright", "driver", "node")],
  ["bundled Chromium", browserExecutable],
  ...(standalone ? [['bundled Backend Node', path.join(resources, 'backend-runtime/node')],
    ['bundled MySQL server', path.join(resources, 'mysql/bin/mysqld')],
    ['bundled MySQL client', path.join(resources, 'mysql/bin/mysql')]] : []),
]) {
  const details = await stat(executable);
  if (!details.isFile() || (details.mode & 0o111) === 0) throw new Error(`${description} is not executable`);
  const resolved = await realpath(executable);
  if (resolved !== resources && !resolved.startsWith(`${resources}${path.sep}`)) {
    throw new Error(`${description} escapes packaged resources`);
  }
  const { stdout } = await execFileAsync("/usr/bin/file", [executable]);
  if (!stdout.includes(expectedArchitecture)) throw new Error(`${description} architecture mismatch: ${stdout.trim()}`);
}

const index = await readFile(path.join(resources, "frontend", "index.html"), "utf8");
if (!index.includes("<html")) throw new Error("packaged renderer is invalid");

for (const candidate of packagedFiles) {
  const details = await stat(candidate);
  if (details.size > 2_000_000) continue;
  const bytes = await readFile(candidate);
  if (bytes.includes(0)) continue;
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { continue; }
  const leakedPath = findDeveloperAbsolutePath(text);
  if (leakedPath && !isReviewedVendorPathExample(path.relative(resources, candidate), bytes)) {
    throw new Error(`developer absolute path leaked in packaged file content (${leakedPath}): ${path.relative(appReal, candidate)}`);
  }
}

console.log(JSON.stringify({ ok: true, appPath: appReal, entries, architecture: process.arch, buildManifestSha256,
  browserExecutable: path.relative(resources, browserExecutable) }));

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { createSourceContentManifest } from "../../scripts/source-content-manifest.mjs";
import { decodeDesktopBuildManifest, readDevelopmentDesktopBuildIdentity } from "../src/main/desktop-build-identity.ts";

const invalid = () => new Error("desktop_dev_build_identity_invalid");
async function validateDirectory(directory, privateMode = false) {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || await realpath(directory) !== directory) throw invalid();
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !process.getuid || info.uid !== process.getuid()
    || (privateMode ? (info.mode & 0o7777) !== 0o700 : (info.mode & 0o7022) !== 0)) throw invalid();
  return info;
}
async function ensureDirectory(directory, privateMode) {
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
  return validateDirectory(directory, privateMode);
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function prepareDevelopmentBuildIdentity(repositoryRoot) {
  try {
    await validateDirectory(repositoryRoot);
    const source = await createSourceContentManifest(repositoryRoot, "desktop-app");
    const builderText = await readFile(path.join(repositoryRoot, "desktop/electron-builder.yml"), "utf8");
    const builderRecord = source.records.find((record) => record.path === "desktop/electron-builder.yml");
    if (builderRecord?.sha256 !== createHash("sha256").update(builderText).digest("hex")) throw invalid();
    const bundleIds = [...builderText.matchAll(/^appId: ([a-z][a-z0-9.-]*)\s*$/gmu)];
    if (bundleIds.length !== 1) throw invalid();
    const text = `${JSON.stringify({ version: 1, kind: "development", sourceRootHash: source.rootHash, records: source.records, architecture: process.arch, bundleId: bundleIds[0][1] })}\n`;
    decodeDesktopBuildManifest(text);
    const runtime = path.join(repositoryRoot, ".runtime");
    await ensureDirectory(runtime, false);
    const devRoot = path.join(runtime, "desktop-dev");
    await ensureDirectory(devRoot, true);
    const ownerRoot = path.join(devRoot, source.rootHash);
    let created = false;
    try { await mkdir(ownerRoot, { mode: 0o700 }); created = true; } catch (error) { if (error?.code !== "EEXIST") throw error; }
    await validateDirectory(ownerRoot, true);
    const manifestPath = path.join(ownerRoot, "desktop-build-manifest.json");
    if (created) {
      const handle = await open(manifestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
      try { await handle.chmod(0o644); await handle.writeFile(text, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await syncDirectory(ownerRoot); await syncDirectory(devRoot); await syncDirectory(runtime);
    }
    // A same-source restart is read-only. Never repair, overwrite, or remove a
    // stale, incomplete, foreign, or corrupted owner directory.
    const entries = await readdir(ownerRoot);
    if (entries.length !== 1 || entries[0] !== "desktop-build-manifest.json") throw invalid();
    if (await readDevelopmentDesktopBuildIdentity(repositoryRoot, manifestPath)
      !== createHash("sha256").update(text).digest("hex")) throw invalid();
    return manifestPath;
  } catch { throw invalid(); }
}

export async function startDevelopmentDesktop({ repositoryRoot, electronExecutable, environment = process.env, spawnProcess = spawn }) {
  const manifestPath = await prepareDevelopmentBuildIdentity(repositoryRoot);
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) =>
    key !== "SHENSI_RENDERER_DEV_ORIGIN" && key !== "SHENSI_DESKTOP_DEV_BUILD_MANIFEST_PATH"
    && !/^SHENSI_.*BUILD.*(?:SHA256|DIGEST)$/u.test(key)));
  env.SHENSI_DESKTOP_DEV_BUILD_MANIFEST_PATH = manifestPath;
  return spawnProcess(electronExecutable, ["dist/main/main.js"], {
    cwd: path.join(repositoryRoot, "desktop"), env, shell: false, stdio: "inherit", detached: true,
  });
}

import { spawn } from "node:child_process";
import { mkdtemp, rm, readdir, readFile, readlink, writeFile, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createSourceContentManifest } from "../../scripts/source-content-manifest.mjs";
import os from "node:os";
import path from "node:path";
import { validateReleaseEnvironment } from "./release-policy.mjs";
import {
  verifyReleaseAppSignatures,
  verifyReleaseDmgSignature,
} from "./macos-signature-policy.mjs";

const signedAppIdentities = new Map();

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function treeDigest(root) {
  const records = [];
  async function visit(relative = "") {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
      const name = path.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (entry.isSymbolicLink()) records.push([name, "link", await readlink(path.join(root, name))]);
      else if (entry.isFile()) records.push([name, "file", digest(await readFile(path.join(root, name)))]);
      else throw new Error("unsupported packaged resource");
    }
  }
  await visit();
  return digest(JSON.stringify(records.sort((a, b) => a[0].localeCompare(b[0]))));
}

/** Generated before code signing: payload fingerprints, not signature attestation. */
export async function writePackagedBuildIdentity({ resourcesPath, sourceRootHash, architecture, bundleId }) {
  if (!/^[a-f0-9]{64}$/u.test(sourceRootHash) || !["arm64", "x64"].includes(architecture)
    || !/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(bundleId)) throw new Error("invalid packaged identity inputs");
  const manifest = { version: 1, kind: "packaged", sourceRootHash,
    rendererSha256: await treeDigest(path.join(resourcesPath, "frontend")),
    mainSha256: digest(await readFile(path.join(resourcesPath, "app.asar"))),
    sidecarSha256: await treeDigest(path.join(resourcesPath, "sidecar")),
    runtimeConfigSha256: digest(await readFile(path.join(resourcesPath, "desktop-config.json"))),
    architecture, bundleId };
  const output = path.join(resourcesPath, "desktop-build-manifest.json");
  await writeFile(output, `${JSON.stringify(manifest)}\n`, { mode: 0o644 });
  await chmod(output, 0o644);
  return digest(`${JSON.stringify(manifest)}\n`);
}

export async function afterPack(context) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const source = await createSourceContentManifest(repositoryRoot, "desktop-app");
  const resourcesPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources");
  await writePackagedBuildIdentity({ resourcesPath, sourceRootHash: source.rootHash,
    architecture: process.arch, bundleId: context.packager.appInfo.id });
}

function run(executable, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolve()
      : reject(new Error(`${path.basename(executable)} failed (${code ?? signal ?? "unknown"})`)));
  });
}

function releaseConfiguration() {
  if (process.env.SHENSI_PACKAGE_MODE !== "release") return null;
  return validateReleaseEnvironment(process.env);
}

export async function afterSign(context) {
  const configuration = releaseConfiguration();
  if (!configuration) return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const identity = await verifyReleaseAppSignatures(appPath);
  signedAppIdentities.set(String(context.arch), identity);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "shensi-app-notary-"));
  const submission = path.join(temporaryRoot, "Shensi.app.zip");
  try {
    await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", appPath, submission]);
    await run("/usr/bin/xcrun", ["notarytool", "submit", submission,
      "--keychain-profile", configuration.notaryProfile, "--wait"]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  await run("/usr/bin/xcrun", ["stapler", "staple", "--verbose", appPath]);
  await run("/usr/bin/xcrun", ["stapler", "validate", "--verbose", appPath]);
}

export async function artifactBuildCompleted(context) {
  const configuration = releaseConfiguration();
  if (!configuration || path.extname(context.file).toLowerCase() !== ".dmg") return;
  const identity = signedAppIdentities.get(String(context.arch));
  if (!identity) throw new Error("release DMG cannot be uploaded before its signed app passes verification");
  await verifyReleaseDmgSignature(context.file, identity);
  await run("/usr/bin/xcrun", ["notarytool", "submit", context.file,
    "--keychain-profile", configuration.notaryProfile, "--wait"]);
  await run("/usr/bin/xcrun", ["stapler", "staple", "--verbose", context.file]);
  await run("/usr/bin/xcrun", ["stapler", "validate", "--verbose", context.file]);
}

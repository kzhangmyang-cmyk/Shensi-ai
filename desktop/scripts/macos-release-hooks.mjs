import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateReleaseEnvironment } from "./release-policy.mjs";
import {
  verifyReleaseAppSignatures,
  verifyReleaseDmgSignature,
} from "./macos-signature-policy.mjs";

const signedAppIdentities = new Map();

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

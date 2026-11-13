import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { verifyAppSignatureIntegrity } from "../scripts/macos-signature-policy.mjs";

const execute = promisify(execFile);
const verifierPath = fileURLToPath(new URL("../scripts/verify-package.mjs", import.meta.url));

async function signedFixture() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "shensi-package-signature-"));
  const app = path.join(temporaryRoot, "Shensi.app");
  const contents = path.join(app, "Contents");
  await mkdir(path.join(contents, "MacOS"), { recursive: true });
  await mkdir(path.join(contents, "Resources"), { recursive: true });
  await copyFile("/bin/echo", path.join(contents, "MacOS", "Shensi"));
  await writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Shensi</string>
<key>CFBundleIdentifier</key><string>com.shensi.signature-fixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
  const resource = path.join(contents, "Resources", "fixture.txt");
  await writeFile(resource, "sealed fixture\n");
  await execute("/usr/bin/codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
  return { temporaryRoot, app, resource };
}

test("development package verification rejects a damaged signature before reporting content readiness", {
  skip: process.platform !== "darwin",
}, async (context) => {
  const fixture = await signedFixture();
  context.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  await writeFile(fixture.resource, "changed after signing\n");

  await assert.rejects(execute(process.execPath, [verifierPath, fixture.app, "development"]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /codesign --verify --deep --strict/u);
      assert.match(error.message, /sealed resource is missing or invalid/u);
      assert.doesNotMatch(error.message, /"ok":true/u);
      return true;
    });
});

test("valid ad-hoc test apps pass integrity validation without a Developer ID identity", {
  skip: process.platform !== "darwin",
}, async (context) => {
  const fixture = await signedFixture();
  context.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));

  await assert.doesNotReject(verifyAppSignatureIntegrity(fixture.app));
});

test("release package verification also fails closed on a damaged signature", {
  skip: process.platform !== "darwin",
}, async (context) => {
  const fixture = await signedFixture();
  context.after(() => rm(fixture.temporaryRoot, { recursive: true, force: true }));
  await writeFile(fixture.resource, "changed after signing\n");

  await assert.rejects(execute(process.execPath, [verifierPath, fixture.app, "release"]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /codesign --verify --deep --strict/u);
      assert.match(error.message, /sealed resource is missing or invalid/u);
      assert.doesNotMatch(error.message, /"ok":true/u);
      return true;
    });
});

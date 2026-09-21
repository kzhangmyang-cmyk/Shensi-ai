import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

type EntitlementsPolicy = {
  entitlementKeysForCodeObject?: (filePath: string, appPath: string) => string[];
  assertEntitlementAllowlist?: (details: string, expectedKeys: string[]) => void;
};

const policyUrl = new URL("../scripts/macos-entitlements-policy.mjs", import.meta.url).href;
const policy = await import(policyUrl).catch(() => ({})) as EntitlementsPolicy;
const releaseSignUrl = new URL("../scripts/macos-release-sign.mjs", import.meta.url).href;
const releaseSign = await import(releaseSignUrl) as {
  createReleaseSignOptions: (configuration: Record<string, unknown>) => {
    identity?: string;
    preAutoEntitlements?: boolean;
    optionsForFile: (filePath: string, ...context: unknown[]) => Record<string, unknown>;
  };
};
const app = "/private/tmp/release/Shensi.app";
const jit = ["com.apple.security.cs.allow-jit"];

test("release entitlement policy grants JIT only to explicit Electron code objects", () => {
  assert.equal(typeof policy.entitlementKeysForCodeObject, "function");
  if (!policy.entitlementKeysForCodeObject) return;

  assert.deepEqual(policy.entitlementKeysForCodeObject(app, app), jit);
  assert.deepEqual(policy.entitlementKeysForCodeObject(`${app}/Contents/MacOS/Shensi`, app), jit);
  assert.deepEqual(policy.entitlementKeysForCodeObject(
    `${app}/Contents/Frameworks/Shensi Helper (Renderer).app`, app,
  ), jit);
  assert.deepEqual(policy.entitlementKeysForCodeObject(
    `${app}/Contents/Frameworks/Shensi Helper.app/Contents/MacOS/Shensi Helper`, app,
  ), jit);
  assert.deepEqual(policy.entitlementKeysForCodeObject(
    `${app}/Contents/Frameworks/Shensi Helper (GPU).app/Contents/MacOS/Shensi Helper (GPU)`, app,
  ), jit);
  assert.deepEqual(policy.entitlementKeysForCodeObject(
    `${app}/Contents/Frameworks/Shensi Helper (Renderer).app/Contents/MacOS/Shensi Helper (Renderer)`, app,
  ), jit);
});

test("release entitlement policy scopes JIT to Playwright Node and Chromium main/Renderer/GPU", () => {
  assert.equal(typeof policy.entitlementKeysForCodeObject, "function");
  if (!policy.entitlementKeysForCodeObject) return;

  for (const relative of [
    "Contents/Resources/sidecar/_internal/playwright/driver/node",
    "Contents/Resources/playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app",
    "Contents/Resources/playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "Contents/Resources/playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/149.0.7827.55/Helpers/Google Chrome for Testing Helper (Renderer).app",
    "Contents/Resources/playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/149.0.7827.55/Helpers/Google Chrome for Testing Helper (GPU).app/Contents/MacOS/Google Chrome for Testing Helper (GPU)",
  ]) assert.deepEqual(policy.entitlementKeysForCodeObject(`${app}/${relative}`, app), jit, relative);
});

test("release entitlement policy leaves Sidecar, frameworks, libraries, and ffmpeg empty", () => {
  assert.equal(typeof policy.entitlementKeysForCodeObject, "function");
  if (!policy.entitlementKeysForCodeObject) return;

  for (const relative of [
    "Contents/Resources/sidecar/shensi-sidecar",
    "Contents/Resources/sidecar/_internal/libpython3.11.dylib",
    "Contents/Resources/playwright/ffmpeg-1011/ffmpeg-mac",
    "Contents/Resources/playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework",
    "Contents/Resources/playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/149.0.7827.55/Google Chrome for Testing Framework",
    "Contents/Resources/playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/149.0.7827.55/Libraries/libEGL.dylib",
    "Contents/Frameworks/Shensi Helper (Plugin).app",
    "Contents/Frameworks/Shensi Helper (Plugin).app/Contents/MacOS/Shensi Helper (Plugin)",
    "Contents/Frameworks/Electron Framework.framework",
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework",
    "Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libEGL.dylib",
    "Contents/Frameworks/Squirrel.framework",
    "Contents/Frameworks/Squirrel.framework/Versions/A/Squirrel",
  ]) assert.deepEqual(policy.entitlementKeysForCodeObject(`${app}/${relative}`, app), [], relative);
  assert.throws(() => policy.entitlementKeysForCodeObject?.("/private/tmp/outside", app), /outside release app/u);
});

test("release verifier accepts exactly the boundary allowlist and rejects missing or extra grants", () => {
  assert.equal(typeof policy.assertEntitlementAllowlist, "function");
  if (!policy.assertEntitlementAllowlist) return;

  const jitPlist = `<?xml version="1.0"?><plist><dict>
    <key>com.apple.security.cs.allow-jit</key><true/>
  </dict></plist>`;
  const networkPlist = `<?xml version="1.0"?><plist><dict>
    <key>com.apple.security.network.client</key><true/>
  </dict></plist>`;
  const networkValuePlist = `<?xml version="1.0"?><plist><dict>
    <key>com.apple.security.network.client</key><string>unusual</string>
  </dict></plist>`;
  assert.doesNotThrow(() => policy.assertEntitlementAllowlist?.(jitPlist, jit));
  assert.doesNotThrow(() => policy.assertEntitlementAllowlist?.("", []));
  assert.throws(() => policy.assertEntitlementAllowlist?.(jitPlist, []), /unexpected entitlement/u);
  assert.throws(() => policy.assertEntitlementAllowlist?.("", jit), /missing entitlement/u);
  assert.throws(() => policy.assertEntitlementAllowlist?.(networkPlist, []), /unexpected entitlement/u);
  assert.throws(() => policy.assertEntitlementAllowlist?.(networkValuePlist, []), /unexpected entitlement/u);
});

test("release signer preserves upstream per-file options while replacing the entitlement boundary", () => {
  const buildDirectory = path.resolve(import.meta.dirname, "..", "build");
  const upstreamArguments: unknown[][] = [];
  const signingContext = { arch: "arm64", role: "nested" };
  const options = releaseSign.createReleaseSignOptions({
    app,
    identity: "Developer ID Application: Shensi Ltd (A1B2C3D4E5)",
    optionsForFile: (...arguments_: unknown[]) => {
      upstreamArguments.push(arguments_);
      return { timestamp: "none", entitlements: "/tmp/wide.plist" };
    },
  });
  assert.equal(options.identity, "Developer ID Application: Shensi Ltd (A1B2C3D4E5)");
  assert.equal(options.preAutoEntitlements, false);
  assert.deepEqual(options.optionsForFile(`${app}/Contents/MacOS/Shensi`, signingContext, "future-argument"), {
    timestamp: "none",
    entitlements: path.join(buildDirectory, "entitlements.mac.plist"),
    hardenedRuntime: true,
  });
  assert.deepEqual(options.optionsForFile(`${app}/Contents/Resources/sidecar/shensi-sidecar`), {
    timestamp: "none",
    entitlements: path.join(buildDirectory, "entitlements.mac.empty.plist"),
    hardenedRuntime: true,
  });
  assert.deepEqual(upstreamArguments[0], [
    `${app}/Contents/MacOS/Shensi`, signingContext, "future-argument",
  ]);
});

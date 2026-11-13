import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
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
    ignore?: Array<string | RegExp | ((filePath: string) => boolean)>;
    optionsForFile: (filePath: string, ...context: unknown[]) => Record<string, unknown>;
  };
};
const app = "/private/tmp/release/Shensi.app";
const jit = ["com.apple.security.cs.allow-jit"];

test("signer excludes non-code binary resources while retaining Mach-O code and bundles", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shensi-sign-targets-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixtureApp = path.join(root, "Shensi.app");
  const resources = path.join(fixtureApp, "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  const pythonCache = path.join(resources, "module.pyc");
  const nativeAddon = path.join(resources, "binding.node");
  const helper = path.join(resources, "Helper.app");
  const framework = path.join(resources, "Runtime.framework");
  await Promise.all([
    writeFile(pythonCache, Buffer.from([0xa7, 0x0d, 0x0d, 0x0a, 0, 0, 0, 0])),
    writeFile(nativeAddon, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])),
    mkdir(helper), mkdir(framework),
  ]);
  const options = releaseSign.createReleaseSignOptions({ app: fixtureApp, identity: "-" });
  const ignored = (file: string) => (options.ignore ?? []).some(rule =>
    typeof rule === "function" ? rule(file) : Boolean(file.match(rule)));

  assert.equal(ignored(pythonCache), true, "Python bytecode must not be signed");
  assert.equal(ignored(nativeAddon), false, "Mach-O native addons must be signed");
  assert.equal(ignored(helper), false);
  assert.equal(ignored(framework), false);
});

test("signer ignores duplicate code reached through symlinked files or parent directories", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shensi-sign-aliases-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixtureApp = path.join(root, "Shensi.app");
  const contents = path.join(fixtureApp, "Contents");
  const actual = path.join(contents, "Resources", "actual");
  await mkdir(actual, { recursive: true });
  await writeFile(path.join(actual, "runtime"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  await symlink("actual", path.join(contents, "Resources", "alias"));
  await symlink("actual/runtime", path.join(contents, "Resources", "runtime-link"));
  // A symlink above the app itself is not a duplicate nested code path.
  await symlink("Shensi.app", path.join(root, "entry.app"));
  const entryApp = path.join(root, "entry.app");
  const options = releaseSign.createReleaseSignOptions({ app: entryApp, identity: "-" });
  const ignored = (file: string) => (options.ignore ?? []).some(rule =>
    typeof rule === "function" ? rule(file) : Boolean(file.match(rule)));

  assert.equal(ignored(path.join(entryApp, "Contents/Resources/alias/runtime")), true);
  assert.equal(ignored(path.join(entryApp, "Contents/Resources/runtime-link")), true);
  assert.equal(ignored(path.join(entryApp, "Contents/Resources/actual/runtime")), false);
});

test("signer preserves upstream ignore rules and surfaces filesystem errors", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shensi-sign-rules-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixtureApp = path.join(root, "Shensi.app");
  const resources = path.join(fixtureApp, "Contents", "Resources");
  await mkdir(resources, { recursive: true });
  const file = path.join(resources, "native.node");
  await writeFile(file, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
  const callback = (candidate: string) => candidate === file;
  for (const ignore of [callback, [callback], /native\.node$/u, ["native\\.node$"]]) {
    const options = releaseSign.createReleaseSignOptions({ app: fixtureApp, identity: "-", ignore });
    const ignored = (candidate: string) => (options.ignore ?? []).some(rule =>
      typeof rule === "function" ? rule(candidate) : Boolean(candidate.match(rule)));
    assert.equal(ignored(file), true);
    assert.throws(() => ignored(path.join(resources, "missing.node")), /ENOENT/u);
  }
});

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
    "Contents/Resources/backend-runtime/node",
    "Contents/Resources/playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app",
    "Contents/Resources/playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "Contents/Resources/playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/149.0.7827.55/Helpers/Google Chrome for Testing Helper (Renderer).app",
    "Contents/Resources/playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions/149.0.7827.55/Helpers/Google Chrome for Testing Helper (GPU).app/Contents/MacOS/Google Chrome for Testing Helper (GPU)",
  ]) assert.deepEqual(policy.entitlementKeysForCodeObject(`${app}/${relative}`, app), jit, relative);
});

test("signer finalizes resource fingerprints between nested signing and the final outer seal", async () => {
  const signer = await import(releaseSignUrl);
  assert.equal(typeof signer.signPackagedApplication, 'function');
  const events: string[] = [];
  await signer.signPackagedApplication({ app, identity: '-', identityValidation: false }, {
    signApplication: async (options: { app: string; ignore?: ((file: string) => boolean)[] }) => {
      if (events.length === 0) events.push('nested-and-app');
      else {
        assert.ok(options.ignore);
        assert.equal(options.ignore.some(ignore => ignore(app)), false);
        assert.equal(options.ignore.some(ignore => ignore(`${app}/Contents/MacOS/Shensi`)), true);
        events.push('outer-only');
      }
    },
    finalizeResources: async (target: string) => { assert.equal(target, app); events.push('fingerprints'); },
  });
  assert.deepEqual(events, ['nested-and-app', 'fingerprints', 'outer-only']);
});

test('ad-hoc test signing does not enable Developer ID library validation or contact a timestamp server', () => {
  const options = releaseSign.createReleaseSignOptions({ app, identity: '-' });
  const file = options.optionsForFile(app);
  assert.equal(file.hardenedRuntime, false);
  assert.equal(file.timestamp, 'none');
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

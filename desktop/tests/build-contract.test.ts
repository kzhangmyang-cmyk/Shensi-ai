import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const desktopRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");

function read(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

test("desktop build exposes the complete pnpm command surface", () => {
  const rootPackage = JSON.parse(read("package.json")) as {
    scripts?: Record<string, string>;
  };
  const desktopPackage = JSON.parse(read("desktop/package.json")) as {
    main?: string;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  for (const name of [
    "desktop:dev",
    "desktop:test",
    "desktop:typecheck",
    "desktop:build:renderer",
    "desktop:build:main",
    "desktop:build",
    "desktop:package:mac",
    "desktop:package:mac:release",
    "desktop:verify:mac",
  ]) {
    assert.equal(typeof rootPackage.scripts?.[name], "string", `${name} is missing`);
  }
  for (const name of ["dev", "build:main", "build:preload", "build:sidecar", "build", "package:mac", "package:mac:release", "verify:mac"])
    assert.equal(typeof desktopPackage.scripts?.[name], "string", `desktop ${name} is missing`);
  assert.equal(desktopPackage.main, "dist/main/main.js");
  assert.match(desktopPackage.devDependencies?.["@electron/asar"] ?? "", /^\d+\.\d+\.\d+$/u);
});

test("electron builder packages only the local renderer and bounded desktop resources", () => {
  const builderPath = path.join(desktopRoot, "electron-builder.yml");
  assert.equal(existsSync(builderPath), true, "electron-builder.yml is missing");
  const builder = readFileSync(builderPath, "utf8");

  assert.match(builder, /appId:\s*com\.shensi\.desktop/u);
  assert.match(builder, /asar:\s*true/u);
  assert.match(builder, /from:\s*\.\.\/frontend\/dist-desktop/u);
  assert.match(builder, /to:\s*frontend/u);
  assert.match(builder, /from:\s*resources\/staging\/sidecar/u);
  assert.match(builder, /to:\s*sidecar/u);
  assert.match(builder, /from:\s*resources\/staging\/playwright/u);
  assert.match(builder, /to:\s*playwright/u);
  assert.match(builder, /from:\s*resources\/audio/u);
  assert.match(builder, /to:\s*audio/u);
  assert.match(builder, /minimumSystemVersion:\s*["']13\.0["']/u);
  assert.match(builder, /from:\s*resources\/generated\/desktop-config\.json/u);
  assert.match(builder, /to:\s*desktop-config\.json/u);
  assert.match(builder, /entitlements:\s*build\/entitlements\.mac\.plist/u);
  assert.match(builder, /icon:\s*build\/icon\.icns/u);
  assert.match(builder, /target:\s*zip/u);
  assert.match(builder, /output:\s*\.\.\/dist\/desktop\/macos/u);
  assert.match(builder, /afterSign:\s*scripts\/macos-release-hooks\.mjs/u);
  assert.match(builder, /artifactBuildCompleted:\s*scripts\/macos-release-hooks\.mjs/u);
  assert.doesNotMatch(builder, /forceCodeSigning:\s*true/u);
  const releaseBuilder = read("desktop/electron-builder.release.yml");
  assert.match(releaseBuilder, /extends:\s*\.\/electron-builder\.yml/u);
  assert.match(releaseBuilder, /forceCodeSigning:\s*true/u);
  assert.match(releaseBuilder, /sign:\s*\.\/scripts\/macos-release-sign\.mjs/u);
  assert.match(builder, /entitlementsInherit:\s*build\/entitlements\.mac\.empty\.plist/u);

  for (const forbidden of ["noVNC", "novnc", "Xvfb", "x11vnc", "websockify", "docker-compose", "redis", "mysql"])
    assert.equal(new RegExp(`from:\\s*[^\\n]*${forbidden}`, "iu").test(builder), false,
      `forbidden packaged resource: ${forbidden}`);
});

test("the build is pinned and verifies executable resources outside asar", () => {
  const sidecarBuilder = read("desktop/scripts/build-sidecar.mjs");
  const runtimeConfigBuilder = read("desktop/scripts/write-runtime-config.mjs");
  const releasePolicy = read("desktop/scripts/release-policy.mjs");
  const packageVerifier = read("desktop/scripts/verify-package.mjs");
  const entitlements = read("desktop/build/entitlements.mac.plist");
  const spec = read("desktop/shensi-sidecar.spec");

  assert.match(sidecarBuilder, /pyinstaller==[0-9]+\.[0-9]+\.[0-9]+/u);
  assert.match(sidecarBuilder, /PLAYWRIGHT_BROWSERS_PATH/u);
  assert.match(sidecarBuilder, /playwright", "install", "--no-shell", "chromium"/u);
  assert.match(sidecarBuilder, /shensi-sidecar\.spec/u);
  assert.doesNotMatch(sidecarBuilder, /--specpath/u);
  assert.match(spec, /mstoken_profile\.json/u);
  assert.match(spec, /mstoken_common_profile\.json/u);
  assert.match(spec, /["']libs["']\s*\/\s*["']stealth\.min\.js/u);
  assert.match(spec, /["']libs["']\s*\/\s*["']douyin\.js/u);
  assert.match(spec, /collect_data_files\(["']playwright["']\)/u);
  assert.match(spec, /copy_metadata\(["']playwright["']\)/u);
  assert.match(spec, /collect_data_files\(["']certifi["']\)/u);
  assert.match(spec, /copy_metadata\(["']certifi["']\)/u);
  assert.doesNotMatch(spec, /\/Users\//u);
  assert.match(runtimeConfigBuilder, /SHENSI_REMOTE_ORIGIN/u);
  assert.match(runtimeConfigBuilder, /validateRemoteOrigin/u);
  assert.match(releasePolicy, /127\.0\.0\.1/u);
  assert.match(packageVerifier, /validateRemoteOrigin/u);
  assert.match(packageVerifier, /normalizePackageMode/u);
  assert.match(packageVerifier, /"Contents", "Resources"/u);
  assert.match(packageVerifier, /"desktop-config\.json"/u);
  assert.match(packageVerifier, /"sidecar", "shensi-sidecar"/u);
  assert.match(packageVerifier, /"playwright"/u);
  assert.match(packageVerifier, /mstoken_profile\.json/u);
  assert.match(packageVerifier, /mstoken_common_profile\.json/u);
  assert.match(packageVerifier, /"driver", "node"/u);
  assert.match(packageVerifier, /cacert\.pem/u);
  assert.match(packageVerifier, /"frontend", "index\.html"/u);
  assert.match(packageVerifier, /"audio", CFO_GREETING_ASSET_FILENAME/u);
  assert.match(packageVerifier, /78340a80314916b19bbb7cac6a85dcb2b1f512df1d7e00b8adc33ce9ab4b2ffd/u);
  assert.match(packageVerifier, /packaged startup greeting digest mismatch/u);
  assert.match(packageVerifier, /listPackage/u);
  assert.match(packageVerifier, /dist\/preload\/preload\.cjs/u);
  assert.match(packageVerifier, /noVNC|novnc/u);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/u);
  assert.doesNotMatch(entitlements, /com\.apple\.security\.network\.(?:client|server)/u);
  for (const forbidden of [
    "disable-library-validation",
    "allow-dyld-environment-variables",
    "get-task-allow",
    "com.apple.security.app-sandbox",
  ]) assert.doesNotMatch(entitlements, new RegExp(forbidden, "u"));
});

test("macOS packaging scripts are fail-closed and use the owned output tree", () => {
  for (const script of ["build-sidecar.sh", "package-macos.sh", "verify-macos-artifacts.sh"]) {
    const source = read(`desktop/scripts/${script}`);
    assert.match(source, /^#!\/bin\/bash\nset -euo pipefail\n/u, `${script} must fail closed`);
    assert.doesNotMatch(source, /git\s+(?:clean|reset|checkout|stash)/u);
  }
  const packageScript = read("desktop/scripts/package-macos.sh");
  const releasePolicy = read("desktop/scripts/release-policy.mjs");
  assert.match(releasePolicy, /SHENSI_NOTARYTOOL_KEYCHAIN_PROFILE/u);
  assert.match(releasePolicy, /CSC_NAME|CSC_LINK/u);
  assert.match(packageScript, /dist\/desktop\/macos/u);
  const releaseHook = read("desktop/scripts/macos-release-hooks.mjs");
  assert.match(releaseHook, /notarytool/u);
  assert.match(releaseHook, /--keychain-profile/u);
  assert.match(releaseHook, /stapler/u);
  assert.doesNotMatch(releaseHook, /altool/u);
  assert.ok(releaseHook.indexOf("verifyReleaseAppSignatures") < releaseHook.indexOf("notarytool"),
    "release signature verification must precede notarytool upload");
  assert.match(packageScript, /electron-builder\.release\.yml/u);
  assert.doesNotMatch(packageScript, /eval/u);
  const verifier = read("desktop/scripts/verify-macos-artifacts.sh");
  assert.doesNotMatch(verifier, /eval|mapfile_compat/u);
  assert.match(verifier, /-print0/u);
  assert.equal((verifier.match(/verify-package\.mjs" "[^"]+" "\$MODE"/gu) ?? []).length, 3);
  assert.match(verifier, /macos-signature-policy\.mjs/u);
  const sidecarBuilder = read("desktop/scripts/build-sidecar.mjs");
  assert.match(sidecarBuilder, /["']\.links["']/u);
  assert.match(read("desktop/scripts/verify-package.mjs"), /developer absolute path leaked/u);
  const iconApproval = JSON.parse(read("desktop/build/icon-approval.json")) as {
    status?: string;
    source?: string;
  };
  assert.equal(iconApproval.status, "product-owner-approved");
  assert.equal(iconApproval.source, "icon-source.png");
  assert.match(read("desktop/scripts/check-package-environment.mjs"), /product-owner-approved/u);
});

test("desktop development builds desktop-only assets for the Main gateway", () => {
  const frontendPackage = JSON.parse(read("frontend/package.json")) as {
    scripts?: Record<string, string>;
  };
  const desktopPackage = JSON.parse(read("desktop/package.json")) as {
    scripts?: Record<string, string>;
  };
  const supervisor = read("desktop/scripts/dev.mjs");

  assert.match(frontendPackage.scripts?.["build:desktop"] ?? "", /vite build.+--mode desktop.+--outDir dist-desktop/u);
  assert.match(desktopPackage.scripts?.["dev"] ?? "", /build:main.+build:desktop.+scripts\/dev\.mjs/u);
  assert.match(supervisor, /const SHUTDOWN_TIMEOUT_MS = 10_000/u);
  assert.match(supervisor, /createRequire\(import\.meta\.url\)/u);
  assert.match(supervisor, /const electronExecutable = require\("electron"\)/u);
  // The producer's injected launch tests verify the validated path, executable,
  // argv, detached process ownership, and no shell/Vite-origin propagation.
});

test("the sandboxed preload is emitted as a bundled CommonJS entrypoint", () => {
  const desktopPackage = JSON.parse(read("desktop/package.json")) as {
    scripts?: Record<string, string>;
  };
  const preloadBuilder = read("desktop/scripts/build-preload.mjs");
  const runtimeLocation = read("desktop/src/main/runtime-location.ts");

  assert.match(desktopPackage.scripts?.["build:preload"] ?? "", /build-preload\.mjs/u);
  assert.match(desktopPackage.scripts?.["build:main"] ?? "", /build:preload/u);
  assert.match(preloadBuilder, /format:\s*"cjs"/u);
  assert.match(preloadBuilder, /bundle:\s*true/u);
  assert.match(preloadBuilder, /external:\s*\["electron"\]/u);
  assert.match(preloadBuilder, /preload\.cjs/u);
  assert.match(runtimeLocation, /preload\.cjs/u);
  assert.doesNotMatch(runtimeLocation, /preload\.js/u);
});

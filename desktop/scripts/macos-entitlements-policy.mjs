import path from "node:path";

export const JIT_ENTITLEMENTS = Object.freeze(["com.apple.security.cs.allow-jit"]);
export const EMPTY_ENTITLEMENTS = Object.freeze([]);

function relativeCodeObject(filePath, appPath) {
  const resolvedApp = path.resolve(appPath);
  const relative = path.relative(resolvedApp, path.resolve(filePath));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`code object is outside release app: ${filePath}`);
  }
  return relative.split(path.sep).join("/");
}

function isElectronJitObject(relative) {
  if (relative === "" || relative === "Contents/MacOS/Shensi") return true;
  if (/^Contents\/Frameworks\/Shensi Helper(?: \((?:GPU|Renderer)\))?\.app$/u.test(relative)) return true;
  return /^Contents\/Frameworks\/Shensi Helper(?: \((?:GPU|Renderer)\))?\.app\/Contents\/MacOS\/Shensi Helper(?: \((?:GPU|Renderer)\))?$/u.test(relative);
}

function isPlaywrightNode(relative) {
  return relative === "Contents/Resources/sidecar/_internal/playwright/driver/node"
    || relative === "Contents/Resources/backend-runtime/node";
}

function isChromiumJitObject(relative) {
  const browserRoot = /^Contents\/Resources\/playwright\/chromium-\d+\/chrome-mac-(?:arm64|x64)\/Google Chrome for Testing\.app/u;
  if (!browserRoot.test(relative)) return false;
  if (/\/Google Chrome for Testing\.app$/u.test(relative)) return true;
  if (/\/Google Chrome for Testing\.app\/Contents\/MacOS\/Google Chrome for Testing$/u.test(relative)) return true;
  return /\/Google Chrome for Testing Helper \((?:GPU|Renderer)\)\.app(?:\/Contents\/MacOS\/Google Chrome for Testing Helper \((?:GPU|Renderer)\))?$/u.test(relative);
}

export function entitlementKeysForCodeObject(filePath, appPath) {
  const relative = relativeCodeObject(filePath, appPath);
  return isElectronJitObject(relative) || isPlaywrightNode(relative) || isChromiumJitObject(relative)
    ? [...JIT_ENTITLEMENTS]
    : [...EMPTY_ENTITLEMENTS];
}

export function assertEntitlementAllowlist(details, expectedKeys) {
  const keys = [...details.matchAll(/<key>([^<]+)<\/key>/gu)].map((match) => match[1]);
  const entries = [...details.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\s*\/>/gu)];
  const actual = new Map(entries.map((match) => [match[1], match[2] === "true"]));
  const expected = new Set(expectedKeys);
  for (const key of keys) {
    if (!expected.has(key) || actual.get(key) !== true) {
      throw new Error(`unexpected entitlement on release code object: ${key}`);
    }
  }
  for (const key of expected) {
    if (actual.get(key) !== true) throw new Error(`missing entitlement on release code object: ${key}`);
  }
}

import path from "node:path";
import { closeSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { signAsync } from "@electron/osx-sign";
import { entitlementKeysForCodeObject } from "./macos-entitlements-policy.mjs";
import { finalizePackagedResources } from './macos-release-hooks.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const buildDirectory = path.resolve(scriptDirectory, "..", "build");
const jitEntitlements = path.join(buildDirectory, "entitlements.mac.plist");
const emptyEntitlements = path.join(buildDirectory, "entitlements.mac.empty.plist");

const machOMagic = new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe,
  0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

function nonCodeSigningTarget(appPath) {
  const app = path.resolve(appPath);
  let canonicalApp;
  return (filePath) => {
    const candidate = path.resolve(filePath);
    if (candidate === app) return false;
    const relative = path.relative(app, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('code signing target is outside the app');
    }
    canonicalApp ??= realpathSync(app);
    // osx-sign traverses directory symlinks. Only sign the canonical copy,
    // while allowing the configured app path itself to have an OS path alias.
    if (realpathSync(candidate) !== path.join(canonicalApp, relative)) return true;
    const details = lstatSync(candidate);
    if (details.isDirectory()) return !/\.(?:app|framework)$/u.test(candidate);
    if (!details.isFile()) return true;
    const descriptor = openSync(candidate, 'r');
    try {
      const header = Buffer.alloc(4);
      return readSync(descriptor, header, 0, 4, 0) !== 4 || !machOMagic.has(header.readUInt32BE(0));
    } finally {
      closeSync(descriptor);
    }
  };
}

export function createReleaseSignOptions(configuration) {
  const upstreamOptionsForFile = configuration.optionsForFile;
  const upstreamIgnore = configuration.ignore === undefined ? []
    : Array.isArray(configuration.ignore) ? configuration.ignore : [configuration.ignore];
  return {
    ...configuration,
    ignore: [nonCodeSigningTarget(configuration.app), ...upstreamIgnore],
    preAutoEntitlements: false,
    optionsForFile(filePath, ...context) {
      const upstream = upstreamOptionsForFile?.(filePath, ...context) ?? {};
      const entitlementKeys = entitlementKeysForCodeObject(filePath, configuration.app);
      return {
        ...upstream,
        entitlements: entitlementKeys.length === 0 ? emptyEntitlements : jitEntitlements,
        hardenedRuntime: configuration.identity !== '-',
        ...(configuration.identity === '-' ? { timestamp: 'none' } : {}),
      };
    },
  };
}

export async function signPackagedApplication(configuration, {
  signApplication = signAsync,
  finalizeResources = finalizePackagedResources,
} = {}) {
  const options = createReleaseSignOptions(configuration);
  await signApplication(options);
  // Signing nested runtimes changes their bytes. Hash those final bytes, then
  // seal only the outer app: another nested pass would invalidate the hashes.
  await finalizeResources(configuration.app);
  await signApplication({ ...options, ignore: [
    filePath => path.resolve(filePath) !== path.resolve(configuration.app), ...options.ignore,
  ] });
}

export async function sign(configuration) {
  await signPackagedApplication(configuration);
}

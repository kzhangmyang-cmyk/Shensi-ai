import path from "node:path";
import { fileURLToPath } from "node:url";
import { signAsync } from "@electron/osx-sign";
import { entitlementKeysForCodeObject } from "./macos-entitlements-policy.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const buildDirectory = path.resolve(scriptDirectory, "..", "build");
const jitEntitlements = path.join(buildDirectory, "entitlements.mac.plist");
const emptyEntitlements = path.join(buildDirectory, "entitlements.mac.empty.plist");

export function createReleaseSignOptions(configuration) {
  const upstreamOptionsForFile = configuration.optionsForFile;
  return {
    ...configuration,
    preAutoEntitlements: false,
    optionsForFile(filePath, ...context) {
      const upstream = upstreamOptionsForFile?.(filePath, ...context) ?? {};
      const entitlementKeys = entitlementKeysForCodeObject(filePath, configuration.app);
      return {
        ...upstream,
        entitlements: entitlementKeys.length === 0 ? emptyEntitlements : jitEntitlements,
        hardenedRuntime: true,
      };
    },
  };
}

export async function sign(configuration) {
  await signAsync(createReleaseSignOptions(configuration));
}

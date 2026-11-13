export function writePackagedBuildIdentity(input: {
  resourcesPath: string;
  sourceRootHash: string;
  architecture: string;
  bundleId: string;
}): Promise<string>;
export function finalizePackagedResources(appPath: string): Promise<string>;

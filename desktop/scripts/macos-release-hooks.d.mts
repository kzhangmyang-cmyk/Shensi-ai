export function writePackagedBuildIdentity(input: {
  resourcesPath: string;
  sourceRootHash: string;
  architecture: string;
  bundleId: string;
}): Promise<string>;

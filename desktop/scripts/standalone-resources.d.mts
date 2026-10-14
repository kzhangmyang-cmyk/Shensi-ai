export interface StandaloneStagingOptions {
  backendDirectory: string; contractsDirectory: string; nodeExecutable: string; nodeLicense: string;
  mysqlDirectory: string; referenceDirectory: string; outputDirectory: string;
}
export function stageStandaloneResources(options: StandaloneStagingOptions): Promise<{ sourceCount: number; roots: Record<string, string> }>;
export function verifyStandaloneResources(root: string): Promise<{ sourceCount: number; roots: Record<string, string> }>;
export function installStagedStandaloneResources(stagingRoot: string, resourcesPath: string): Promise<{ sourceCount: number; roots: Record<string, string> }>;
export function refreshStandaloneResourceManifest(resourcesPath: string): Promise<{ sourceCount: number; roots: Record<string, string> }>;

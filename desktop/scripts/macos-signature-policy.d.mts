export interface DeveloperIdIdentity {
  authority: string;
  teamId: string;
}

export function assertDeveloperIdSignature(
  details: string,
  expected?: DeveloperIdIdentity,
  requireRuntime?: boolean,
): DeveloperIdIdentity;
export type ReleaseSignatureOperations = {
  verifyCodesign(target: string, deep: boolean): Promise<void>;
  codesignDetails(target: string): Promise<string>;
  codesignEntitlements(target: string): Promise<string>;
  isMachO(target: string): Promise<boolean>;
};
export function enumerateReleaseCodeObjects(
  root: string,
  identifyMachO?: (target: string) => Promise<boolean>,
): Promise<string[]>;
export function verifyReleaseAppSignatures(
  appPath: string,
  operations?: ReleaseSignatureOperations,
): Promise<DeveloperIdIdentity>;
export function verifyAppSignatureIntegrity(appPath: string): Promise<void>;
export function verifyReleaseDmgSignature(
  dmgPath: string,
  expected: DeveloperIdIdentity,
): Promise<DeveloperIdIdentity>;

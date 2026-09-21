export type PackageMode = "development" | "release";

export function normalizePackageMode(value: string | undefined): PackageMode;
export function validateRemoteOrigin(value: string | undefined, release: boolean): string;
export function validateReleaseEnvironment(environment: Record<string, string | undefined>): {
  remoteOrigin: string;
  notaryProfile: string;
};

export type PackageMode = "development" | "release";

export function normalizePackageMode(value: string | undefined): PackageMode;
export function validateRemoteOrigin(value: string | undefined, release: boolean): string;
export type PackageRuntimeConfig = { remoteOrigin: string } | { mode: "standalone" };
export function resolvePackageRuntimeConfig(environment: Record<string, string | undefined>, release?: boolean): PackageRuntimeConfig;
export function validatePackagedRuntimeConfig(config: unknown, release?: boolean): PackageRuntimeConfig;
export function validateReleaseEnvironment(environment: Record<string, string | undefined>): PackageRuntimeConfig & { notaryProfile: string };

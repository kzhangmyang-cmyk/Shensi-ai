export const JIT_ENTITLEMENTS: readonly string[];
export const EMPTY_ENTITLEMENTS: readonly string[];
export function entitlementKeysForCodeObject(filePath: string, appPath: string): string[];
export function assertEntitlementAllowlist(details: string, expectedKeys: string[]): void;

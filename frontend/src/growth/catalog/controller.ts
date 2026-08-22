import { GrowthApiError } from "../http";
import type {
  CatalogApi,
  CatalogItem,
  PackageVersion,
  PricingPolicyVersion
} from "./api";

export interface CatalogPolicyRow {
  id: string;
  status: string;
  revision: number;
  currency?: string;
  validFrom?: string;
  validTo?: string | null;
  listUnitPriceMinor?: number;
}

function toPolicyRow(policy: PricingPolicyVersion): CatalogPolicyRow {
  const record = policy as unknown as Record<string, unknown>;
  return Object.freeze({
    id: String(record.id),
    status: String(record.status),
    revision: Number(record.revision),
    currency: typeof record.currency === "string"
      ? record.currency : undefined,
    validFrom: typeof record.validFrom === "string"
      ? record.validFrom : undefined,
    validTo: typeof record.validTo === "string" || record.validTo === null
      ? record.validTo as string | null : undefined,
    listUnitPriceMinor: Number.isSafeInteger(record.listUnitPriceMinor)
      ? Number(record.listUnitPriceMinor) : undefined
  });
}

export type CatalogPageState =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "empty"; reason: string }
  | { kind: "conflict"; message: string }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      items: readonly CatalogItem[];
      packagesByItem: ReadonlyMap<string, readonly PackageVersion[]>;
      policies: readonly CatalogPolicyRow[];
      sensitive: boolean;
      canManage: boolean;
    };

export interface CatalogControllerOptions {
  api: CatalogApi;
  hasFeature: (feature: string) => boolean;
  hasCapability: (capability: string) => boolean;
  now?: () => string;
  idFactory?: () => string;
}

export interface CatalogController {
  load(signal?: AbortSignal): Promise<CatalogPageState>;
  nextIdempotencyKey(action: string): string;
}

export function createCatalogController(
  options: CatalogControllerOptions
): CatalogController {
  const now = options.now ?? (() => new Date().toISOString());
  let idSequence = 0;
  const idFactory = options.idFactory
    ?? (() => `catalog-${now()}-${++idSequence}`);
  const controller: CatalogController = {
    nextIdempotencyKey(action: string) {
      return `${action}:${idFactory()}`;
    },
    async load(signal?: AbortSignal) {
      if (!options.hasFeature("catalog")) {
        return { kind: "forbidden" };
      }
      if (!options.hasCapability("catalog.read")) {
        return { kind: "forbidden" };
      }
      try {
        const items = await options.api.listItems({
          limit: 100,
          signal
        });
        const itemRows = items.body.items ?? [];
        const packagesByItem = new Map<string, PackageVersion[]>();
        for (const item of itemRows) {
          const packages = await options.api.listPackageVersions(
            item.id,
            { limit: 100, signal }
          );
          packagesByItem.set(item.id, packages.body.items ?? []);
        }
        const policies = await options.api.listPricingPolicies({
          limit: 100,
          signal
        });
        if (itemRows.length === 0) {
          return { kind: "empty", reason: "catalog_empty" };
        }
        return {
          kind: "ready",
          items: Object.freeze(itemRows),
          packagesByItem,
          policies: Object.freeze(
            (policies.body.items ?? []).map(toPolicyRow)
          ),
          sensitive: options.hasCapability("pricing.sensitive.read"),
          canManage: options.hasCapability("catalog.manage")
        };
      } catch (error) {
        if (error instanceof GrowthApiError
          && (error.status === 409 || error.status === 412)) {
          return { kind: "conflict", message: error.code };
        }
        return {
          kind: "error",
          message: error instanceof Error ? error.message : String(error)
        };
      }
    }
  };
  return Object.freeze(controller);
}

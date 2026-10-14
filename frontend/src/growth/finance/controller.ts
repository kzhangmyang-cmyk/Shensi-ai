import { GrowthApiError } from "../http";
import type {
  AcquisitionCostEntry,
  AcquisitionCostEstimate,
  FinanceApi,
  FinancialFact
} from "./api";
import type { FinanceImportState } from "./import-workflow";

export type FinancePageState =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; message: string }
  | {
      kind: "ready";
      costEntries: readonly AcquisitionCostEntry[];
      costEstimates: readonly AcquisitionCostEstimate[];
      facts: readonly FinancialFact[];
      importState: FinanceImportState;
      canVerify: boolean;
      canImport?: boolean;
      canReadWithModel?: boolean;
    };

export interface FinanceControllerOptions {
  api: FinanceApi;
  hasFeature: (feature: string) => boolean;
  hasCapability: (capability: string) => boolean;
  idFactory?: () => string;
}

export interface FinanceController {
  load(signal?: AbortSignal): Promise<FinancePageState>;
  setImportState(importState: FinanceImportState): FinancePageState;
  nextIdempotencyKey(action: string): string;
}

export function createFinanceController(
  options: FinanceControllerOptions
): FinanceController {
  let importState: FinanceImportState = { kind: "idle" };
  let costEntries: readonly AcquisitionCostEntry[] = Object.freeze([]);
  let costEstimates: readonly AcquisitionCostEstimate[] = Object.freeze([]);
  let facts: readonly FinancialFact[] = Object.freeze([]);
  const idFactory = options.idFactory
    ?? (() => `finance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const controller: FinanceController = {
    nextIdempotencyKey(action: string) {
      return `${action}:${idFactory()}`;
    },
    setImportState(next) {
      importState = next;
      return {
        kind: "ready",
        costEntries,
        costEstimates,
        facts,
        importState,
        canImport: options.hasCapability("ledger.pending.create"),
        canReadWithModel: options.hasCapability("finance.council.run"),
        canVerify: options.hasCapability("ledger.verify")
      };
    },
    async load(signal) {
      if (!options.hasFeature("finance")
        || (!options.hasCapability("ledger.pending.create") && !options.hasCapability("finance.council.run"))) {
        return { kind: "forbidden" };
      }
      if (!options.hasCapability("ledger.pending.create")) {
        costEntries = []; costEstimates = []; facts = [];
        return controller.setImportState(importState);
      }
      try {
        const [entries, estimates, factResponse] = await Promise.all([
          options.api.listCostEntries({ limit: 100, signal }),
          options.api.listCostEstimates({ limit: 100, signal }),
          options.api.listFinancialFacts({ limit: 100, signal })
        ]);
        costEntries = Object.freeze(entries.body.items ?? []);
        costEstimates = Object.freeze(estimates.body.items ?? []);
        facts = Object.freeze(factResponse.body.items ?? []);
        return {
          kind: "ready",
          costEntries,
          costEstimates,
          facts,
          importState,
          canImport: true,
          canReadWithModel: options.hasCapability("finance.council.run"),
          canVerify: options.hasCapability("ledger.verify")
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

import { GrowthApiError } from "../http";
import type {
  AcquisitionCohort,
  GrowthPerformanceApi,
  GrowthPerformanceResponse,
  RoiQueryFilters
} from "./api";

export type RoiPageState =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; message: string }
  | {
      kind: "ready";
      cohorts: readonly AcquisitionCohort[];
      filters: RoiQueryFilters | null;
      performance: GrowthPerformanceResponse | null;
    };

export interface RoiControllerOptions {
  api: GrowthPerformanceApi;
  hasFeature: (feature: string) => boolean;
  hasCapability: (capability: string) => boolean;
}

export interface RoiController {
  loadCohorts(signal?: AbortSignal): Promise<RoiPageState>;
  query(
    filters: RoiQueryFilters,
    signal?: AbortSignal
  ): Promise<RoiPageState>;
}

export function createRoiController(
  options: RoiControllerOptions
): RoiController {
  let querySequence = 0;
  const controller: RoiController = {
    async loadCohorts(signal) {
      if (!options.hasFeature("roi")
        || !options.hasCapability("growth.performance.workspace.read")) {
        return { kind: "forbidden" };
      }
      try {
        const response = await options.api.listCohorts({
          limit: 100,
          signal
        });
        return {
          kind: "ready",
          cohorts: Object.freeze(response.body.items ?? []),
          filters: null,
          performance: null
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
    },
    async query(filters, signal) {
      if (!options.hasCapability("growth.performance.workspace.read")) {
        return { kind: "forbidden" };
      }
      const sequence = ++querySequence;
      try {
        const response = await options.api.getGrowthPerformance(
          filters, signal
        );
        if (sequence !== querySequence) {
          return { kind: "conflict", message: "stale_query" };
        }
        return {
          kind: "ready",
          cohorts: Object.freeze([]),
          filters: Object.freeze({ ...filters }),
          performance: response.body
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

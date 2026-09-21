import { GrowthApiError } from "../http";
import type {
  AdvisorApi,
  AdvisorRecommendation,
  AdvisorTodayQuery,
  AdvisorTodayResponse
} from "./api";
import type { AdvisorCopilotWorkflow } from "./copilot-workflow";

export type AdvisorHomeState =
  | { kind: "loading" }
  | { kind: "forbidden" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; message: string }
  | {
      kind: "ready";
      today: AdvisorTodayResponse;
      explanation: string;
      aiUnavailable: boolean;
      decidingId: string | null;
    };

export interface AdvisorControllerOptions {
  api: AdvisorApi;
  copilot: AdvisorCopilotWorkflow;
  hasFeature: (feature: string) => boolean;
  hasCapability: (capability: string) => boolean;
  idFactory?: () => string;
}

export interface AdvisorController {
  loadToday(
    query: AdvisorTodayQuery,
    signal?: AbortSignal
  ): Promise<AdvisorHomeState>;
  ask(
    prompt: string,
    signal?: AbortSignal
  ): Promise<AdvisorHomeState>;
  decide(
    action: "accept" | "ignore" | "complete",
    recommendation: AdvisorRecommendation
  ): Promise<AdvisorHomeState>;
  nextIdempotencyKey(action: string): string;
}

export function createAdvisorController(
  options: AdvisorControllerOptions
): AdvisorController {
  let currentToday: AdvisorTodayResponse | null = null;
  let currentExplanation = "";
  let aiUnavailable = false;
  const idFactory = options.idFactory
    ?? (() => `advisor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const controller: AdvisorController = {
    nextIdempotencyKey(action: string) {
      return `${action}:${idFactory()}`;
    },
    async loadToday(query, signal) {
      if (!options.hasFeature("advisor")
        || !options.hasCapability("catalog.read")) {
        return { kind: "forbidden" };
      }
      try {
        const response = await options.api.getToday(query, signal);
        currentToday = response.body;
        return {
          kind: "ready",
          today: response.body,
          explanation: currentExplanation,
          aiUnavailable,
          decidingId: null
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
    async ask(prompt, signal) {
      const result = await options.copilot.ask(prompt, signal);
      currentExplanation = result.explanation;
      aiUnavailable = result.aiUnavailable;
      if (!currentToday) {
        return { kind: "error", message: "advisor_today_required" };
      }
      return {
        kind: "ready",
        today: currentToday,
        explanation: currentExplanation,
        aiUnavailable,
        decidingId: null
      };
    },
    async decide(action, recommendation) {
      if (!currentToday) {
        return { kind: "error", message: "advisor_today_required" };
      }
      try {
        const etag = `"advisor-recommendation-v:${recommendation.revision}"`;
        const response = await options.api.decideRecommendation(
          action,
          recommendation.id,
          { reason: null },
          etag,
          controller.nextIdempotencyKey(`advisor-${action}`)
        );
        const updated = (currentToday.recommendations ?? []).map((row) =>
          row.id === response.body.id ? response.body : row);
        currentToday = Object.freeze({
          ...currentToday,
          recommendations: Object.freeze(updated)
        } as unknown as AdvisorTodayResponse);
        return {
          kind: "ready",
          today: currentToday,
          explanation: currentExplanation,
          aiUnavailable,
          decidingId: recommendation.id
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

import express, { type Request, type Router } from "express";
import {
  GROWTH_CAPABILITIES,
  type GrowthCapability
} from "./growth-capabilities.js";
import type { GrowthContractManifest } from "./growth-openapi.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export const GROWTH_FEATURES = [
  "catalog",
  "quotes",
  "finance",
  "roi",
  "advisor"
] as const;

export type GrowthFeature = typeof GROWTH_FEATURES[number];

export type GrowthBootstrapResponse =
  | {
      status: "ready";
      workspaceId: string;
      capabilityRegistryVersion: "growth-capabilities.v1";
      capabilities: readonly Exclude<
        GrowthCapability,
        "acquisition.outcome.reconcile.internal"
      >[];
      contractVersion: string;
      contractHash: `sha256:${string}`;
      features: readonly GrowthFeature[];
    }
  | {
      status: "workspace_selection_required";
      workspaceId: null;
      capabilityRegistryVersion: "growth-capabilities.v1";
      capabilities: readonly [];
      contractVersion: string;
      contractHash: `sha256:${string}`;
      features: readonly [];
    };

export interface GrowthBootstrapRouterOptions {
  manifest: GrowthContractManifest;
  capabilityRegistryVersion: "growth-capabilities.v1";
  resolveContext(req: Request): Promise<ActiveWorkspaceContext | null>;
  enabledFeatures(
    context: ActiveWorkspaceContext
  ): readonly GrowthFeature[];
}

const capabilitySet = new Set<string>(GROWTH_CAPABILITIES);
const featureSet = new Set<string>(GROWTH_FEATURES);
const internalCapability = "acquisition.outcome.reconcile.internal";

export function projectGrowthBootstrapCapabilities(
  capabilities: readonly GrowthCapability[]
): GrowthBootstrapResponse["capabilities"] {
  const projected: Exclude<GrowthCapability, typeof internalCapability>[] = [];
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (!capabilitySet.has(capability)) {
      throw new Error("UNKNOWN_GROWTH_CAPABILITY");
    }
    if (capability === internalCapability || seen.has(capability)) continue;
    seen.add(capability);
    projected.push(capability);
  }
  return Object.freeze(projected);
}

export function projectGrowthBootstrapFeatures(
  features: readonly GrowthFeature[]
): readonly GrowthFeature[] {
  const projected: GrowthFeature[] = [];
  const seen = new Set<string>();
  for (const feature of features) {
    if (!featureSet.has(feature)) {
      throw new Error("UNKNOWN_GROWTH_FEATURE");
    }
    if (seen.has(feature)) continue;
    seen.add(feature);
    projected.push(feature);
  }
  return Object.freeze(projected);
}

export function createGrowthBootstrapRouter(
  options: GrowthBootstrapRouterOptions
): Router {
  const router = express.Router();
  router.get("/api/v1/growth/bootstrap", (req, res, next) => {
    void options.resolveContext(req).then((context) => {
      res.setHeader("Cache-Control", "no-store");
      if (context === null) {
        res.json({
          status: "workspace_selection_required",
          workspaceId: null,
          capabilityRegistryVersion: options.capabilityRegistryVersion,
          capabilities: [],
          contractVersion: options.manifest.contractVersion,
          contractHash: options.manifest.contractHash,
          features: []
        } satisfies GrowthBootstrapResponse);
        return;
      }
      if (!context.workspaceId.trim() || context.workspaceId === "all") {
        throw new Error("INVALID_ACTIVE_GROWTH_WORKSPACE");
      }
      const capabilities = projectGrowthBootstrapCapabilities(
        context.capabilities
      );
      const features = projectGrowthBootstrapFeatures(
        options.enabledFeatures(context)
      );
      res.json({
        status: "ready",
        workspaceId: context.workspaceId,
        capabilityRegistryVersion: options.capabilityRegistryVersion,
        capabilities,
        contractVersion: options.manifest.contractVersion,
        contractHash: options.manifest.contractHash,
        features
      } satisfies GrowthBootstrapResponse);
    }).catch(next);
  });
  return router;
}

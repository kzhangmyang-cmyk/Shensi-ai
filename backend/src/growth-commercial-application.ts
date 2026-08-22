import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response
} from "express";
import {
  createGrowthBootstrapRouter,
  type GrowthFeature
} from "./growth-bootstrap-router.js";
import { GROWTH_CAPABILITY_REGISTRY_VERSION } from "./growth-capabilities.js";
import type { CommandContext } from "./growth-command-context.js";
import type {
  GrowthCommercialComposition,
  GrowthCommercialModule
} from "./growth-commercial-composition.js";
import {
  createGrowthPrivateServiceRegistry,
  type GrowthPrivateServiceRegistry
} from "./growth-commercial-private-services.js";
import type { GrowthContractManifest } from "./growth-openapi.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export type GrowthCommercialToolName =
  | "list_catalog_items"
  | "get_pricing_policy"
  | "preview_quote"
  | "create_quote_draft"
  | "list_pending_quote_approvals"
  | "get_quote_decision"
  | "get_growth_performance"
  | "list_financial_data_gaps"
  | "create_advisor_recommendation"
  | "create_quote_approval_task"
  | "create_sales_todo"
  | "record_recommendation_outcome";

export interface GrowthCommercialToolCall {
  name: GrowthCommercialToolName;
  input: unknown;
  stableCallHash: `sha256:${string}`;
}

export type GrowthCommercialToolHandler = (
  input: unknown,
  command: CommandContext
) => Promise<unknown>;

export interface GrowthCommercialToolPorts {
  register(
    name: GrowthCommercialToolName,
    handler: GrowthCommercialToolHandler
  ): void;
  execute(
    call: GrowthCommercialToolCall,
    command: CommandContext
  ): Promise<unknown>;
}

const growthToolNames = new Set<string>([
  "list_catalog_items",
  "get_pricing_policy",
  "preview_quote",
  "create_quote_draft",
  "list_pending_quote_approvals",
  "get_quote_decision",
  "get_growth_performance",
  "list_financial_data_gaps",
  "create_advisor_recommendation",
  "create_quote_approval_task",
  "create_sales_todo",
  "record_recommendation_outcome"
]);
const issuedGrowthCommercialToolPorts = new WeakSet<object>();

export function assertGrowthCommercialToolPorts(
  value: GrowthCommercialToolPorts
): GrowthCommercialToolPorts {
  if (!value || !issuedGrowthCommercialToolPorts.has(value)) {
    throw new Error("INVALID_GROWTH_TOOL_PORTS");
  }
  return value;
}

export function createGrowthCommercialToolPorts():
GrowthCommercialToolPorts {
  const handlers = new Map<
    GrowthCommercialToolName,
    GrowthCommercialToolHandler
  >();
  const ports = Object.freeze({
    register(
      name: GrowthCommercialToolName,
      handler: GrowthCommercialToolHandler
    ) {
      if (!growthToolNames.has(name)) {
        throw new Error("UNKNOWN_GROWTH_TOOL");
      }
      if (handlers.has(name)) {
        throw new Error(`DUPLICATE_GROWTH_TOOL_PORT:${name}`);
      }
      handlers.set(name, handler);
    },
    async execute(call: GrowthCommercialToolCall, command: CommandContext) {
      if (!growthToolNames.has(call.name)) {
        throw new Error("UNKNOWN_GROWTH_TOOL");
      }
      const handler = handlers.get(call.name);
      if (!handler) throw new Error(`FEATURE_NOT_ENABLED:${call.name}`);
      return handler(call.input, command);
    }
  });
  issuedGrowthCommercialToolPorts.add(ports);
  return ports;
}

export interface GrowthCommercialApplicationOptions<
  TIntegrations extends object
> {
  manifest: GrowthContractManifest;
  requireAuth: RequestHandler;
  workspaceMiddleware: RequestHandler;
  enabledFeatures(
    context: ActiveWorkspaceContext
  ): readonly GrowthFeature[];
  composition: GrowthCommercialComposition<TIntegrations>;
  createToolPorts?: () => GrowthCommercialToolPorts;
  createPrivateServices?: () => GrowthPrivateServiceRegistry;
}

export interface GrowthCommercialRuntime<TIntegrations extends object> {
  handler: RequestHandler;
  toolPorts: GrowthCommercialToolPorts;
  integrations: TIntegrations;
  close(): Promise<void>;
}

async function closeHandles(
  handles: readonly { close(): Promise<void> }[],
  suppressErrors: boolean
): Promise<void> {
  let firstError: unknown;
  for (const handle of [...handles].reverse()) {
    try {
      await handle.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (!suppressErrors && firstError) throw firstError;
}

function assertUniqueModuleNames(modules: readonly GrowthCommercialModule[]) {
  const names = new Set<string>();
  for (const module of modules) {
    const name = module.name.trim();
    if (!name) throw new Error("INVALID_GROWTH_MODULE_NAME");
    if (names.has(name)) throw new Error(`DUPLICATE_GROWTH_MODULE:${name}`);
    names.add(name);
  }
}

const authenticatedPrefixes = [
  "/api/v1/growth",
  "/api/v1/catalog",
  "/api/v1/quotes",
  "/api/v1/finance",
  "/api/v1/acquisition"
] as const;

export async function createGrowthCommercialApplication<
  TIntegrations extends object
>(options: GrowthCommercialApplicationOptions<TIntegrations>):
Promise<GrowthCommercialRuntime<TIntegrations>> {
  assertUniqueModuleNames(options.composition.modules);
  const toolPorts = (options.createToolPorts
    ?? createGrowthCommercialToolPorts)();
  const privateServices = (options.createPrivateServices
    ?? createGrowthPrivateServiceRegistry)();
  const router = express.Router();
  const handles: { close(): Promise<void> }[] = [];
  let closePromise: Promise<void> | null = null;

  try {
    router.use(
      [...authenticatedPrefixes],
      options.requireAuth,
      options.workspaceMiddleware
    );
    router.use(createGrowthBootstrapRouter({
      manifest: options.manifest,
      capabilityRegistryVersion: GROWTH_CAPABILITY_REGISTRY_VERSION,
      resolveContext: async (req) => req.activeWorkspace ?? null,
      enabledFeatures: options.enabledFeatures
    }));

    for (const module of options.composition.modules) {
      handles.push(await module.install({
        router,
        toolPorts,
        privateServices
      }));
    }
    const integrations = options.composition.projectIntegrations(
      privateServices
    );
    router.use((
      error: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      if (process.env.NODE_ENV !== "test") console.error(error);
      res.status(500).json({ code: "GROWTH_INTERNAL_ERROR" });
    });

    return Object.freeze({
      handler: router as RequestHandler,
      toolPorts,
      integrations,
      close() {
        closePromise ??= closeHandles(handles, false);
        return closePromise;
      }
    });
  } catch (error) {
    await closeHandles(handles, true);
    throw error;
  }
}

export type {
  GrowthCommercialComposition,
  GrowthCommercialModule
} from "./growth-commercial-composition.js";
export type {
  GrowthPrivateServiceKey,
  GrowthPrivateServiceRegistry
} from "./growth-commercial-private-services.js";

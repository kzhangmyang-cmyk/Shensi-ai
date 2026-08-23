import { pathToFileURL } from "node:url";
import express, { type Request } from "express";
import type { Server } from "node:http";
import { requireAuth, CSRF_COOKIE_NAME } from "./auth.js";
import { createFinancialCouncilIntegrationFixture,
  financialCouncilIntegrationPolicyInput,
  FINANCIAL_COUNCIL_INTEGRATION_AS_OF } from
  "./financial-council-integration-fixtures.js";
import { createFinancialCouncilMysqlTestDatabase } from
  "./financial-council-mysql-test-support.js";
import { requireFinancialCouncilMysqlTestAdminUrl } from
  "./financial-council-mysql-test-support.js";
import { MysqlFinancialCouncilRepository } from
  "./financial-council-mysql-repository.js";
import { MysqlFinancialCouncilPolicyRepository } from
  "./financial-council-policy-mysql-repository.js";
import { MysqlFinancialCouncilDraftRepository } from
  "./financial-council-draft-mysql-repository.js";
import { MysqlGrowthHttpIdempotencyRepository } from
  "./growth-http-idempotency-mysql-repository.js";
import { MysqlFinancialStatementPackageRepository } from
  "./financial-statement-package-mysql-repository.js";
import { FinancialStatementPackageService } from
  "./financial-statement-package-service.js";
import { createFinancialStatementPackageRouter } from
  "./financial-statement-package-router.js";
import { MysqlFinancialCouncilModelRoutingRepository } from
  "./financial-council-model-routing-mysql-repository.js";
import { FinancialCouncilModelRoutingService } from
  "./financial-council-model-routing-service.js";
import { createFinancialCouncilModelRoutingPolicyVersion } from
  "./financial-council-model-routing.js";
import { createFinancialCouncilModelRoutingRouter } from
  "./financial-council-model-routing-router.js";
import { FinancialCouncilAgentCenter } from
  "./financial-council-agent-center.js";
import { createFinancialCouncilAgentCenterRouter } from
  "./financial-council-agent-center-router.js";
import { createFinancialCouncilRouter,
  createFinancialCouncilPolicyRouter } from
  "./financial-council-router.js";
import { createGrowthCommercialApplication,
  type GrowthCommercialRuntime } from
  "./growth-commercial-application.js";
import type { GrowthCommercialModule } from
  "./growth-commercial-composition.js";
import { commandContextFromRequest } from
  "./growth-http-preconditions.js";
import { loadGrowthContractRelease } from "./growth-openapi.js";
import { createGrowthWorkspaceMiddleware } from
  "./growth-workspace-context.js";
import type { ActiveWorkspaceContext } from
  "./growth-workspace-context.js";
import { capabilitiesForHumanRole } from "./growth-capabilities.js";
import { financialCouncilCanonicalHash } from
  "./financial-council-domain.js";

export const FINANCIAL_COUNCIL_REAL_E2E_HOST = "127.0.0.1";
export const FINANCIAL_COUNCIL_REAL_E2E_PORT = 4_288;
export const FINANCIAL_COUNCIL_REAL_E2E_EMAIL = "admin@goodjob.com";
export const FINANCIAL_COUNCIL_REAL_E2E_PASSWORD = "goodjob123";
export const FINANCIAL_COUNCIL_REAL_E2E_WORKSPACE = "europe";

export interface FinancialCouncilRealE2eContract {
  readonly schemaVersion: "financial-council-real-e2e.v1";
  readonly origin: string;
  readonly healthUrl: string;
  readonly workspaceId: string;
  readonly dataAsOf: string;
  readonly csrf: {
    readonly cookie: string;
    readonly header: "x-csrf-token";
  };
  readonly databaseName: string;
}

export function financialCouncilRealE2eContract(
  databaseName: string
): FinancialCouncilRealE2eContract {
  if (!databaseName.trim()) throw new Error("INVALID_E2E_DATABASE_NAME");
  const origin = `http://${FINANCIAL_COUNCIL_REAL_E2E_HOST}:${
    FINANCIAL_COUNCIL_REAL_E2E_PORT}`;
  return Object.freeze({
    schemaVersion: "financial-council-real-e2e.v1" as const,
    origin,
    healthUrl: `${origin}/healthz`,
    workspaceId: FINANCIAL_COUNCIL_REAL_E2E_WORKSPACE,
    dataAsOf: FINANCIAL_COUNCIL_INTEGRATION_AS_OF,
    csrf: Object.freeze({
      cookie: CSRF_COOKIE_NAME,
      header: "x-csrf-token" as const
    }),
    databaseName
  });
}

function activeWorkspace(req: Request): ActiveWorkspaceContext {
  if (!req.activeWorkspace) throw new Error("E2E_ACTIVE_WORKSPACE_REQUIRED");
  return req.activeWorkspace;
}

async function waitUntilProjectable(
  getRun: () => Promise<{ readonly revision: number }>
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await getRun()).revision >= 2) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("FINANCIAL_COUNCIL_E2E_RUN_NOT_PROJECTABLE");
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export interface FinancialCouncilRealE2eServer {
  readonly contract: FinancialCouncilRealE2eContract;
  close(): Promise<void>;
}

export async function startFinancialCouncilRealE2eServer():
Promise<FinancialCouncilRealE2eServer> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("FINANCIAL_COUNCIL_REAL_E2E_REQUIRES_NODE_ENV_TEST");
  }
  const configuredPort = Number(process.env.PORT
    ?? FINANCIAL_COUNCIL_REAL_E2E_PORT);
  if (configuredPort !== FINANCIAL_COUNCIL_REAL_E2E_PORT) {
    throw new Error("FINANCIAL_COUNCIL_REAL_E2E_PORT_MUST_BE_4288");
  }

  requireFinancialCouncilMysqlTestAdminUrl(
    "financial-council-real-runtime"
  );

  const database = await createFinancialCouncilMysqlTestDatabase();
  const repository = new MysqlFinancialCouncilRepository(database.pool);
  const policyRepository = new MysqlFinancialCouncilPolicyRepository(
    database.pool
  );
  const drafts = new MysqlFinancialCouncilDraftRepository(database.pool);
  const statementPackages = new MysqlFinancialStatementPackageRepository(
    database.pool
  );
  const statementService = new FinancialStatementPackageService({
    repository: statementPackages,
    now: () => "2026-08-16T08:09:00.000Z"
  });
  const e2eStatementService = Object.freeze({
    async preview(...args: Parameters<typeof statementService.preview>) {
      try { return await statementService.preview(...args); }
      catch (error) {
        console.error(JSON.stringify({
          event: "financial_council_real_e2e_statement_preview_failed",
          code: typeof (error as { code?: unknown })?.code === "string"
            ? (error as { code: string }).code : "UNCLASSIFIED"
        }));
        throw error;
      }
    },
    commit: statementService.commit.bind(statementService),
    getPreview: statementService.getPreview.bind(statementService),
    getVerified: statementService.getVerified.bind(statementService)
  });
  const modelRouting = new MysqlFinancialCouncilModelRoutingRepository(
    database.pool
  );
  const runtimeConnections = Object.freeze([
    Object.freeze({ id: "acceptance-openai", ownerId: "u_admin",
      teamId: FINANCIAL_COUNCIL_REAL_E2E_WORKSPACE, provider: "openai" as const,
      model: "acceptance-openai-structured", credentialVersion: 1,
      capabilitySnapshot: Object.freeze({ structuredOutput: true,
        toolCalling: false, parallelToolCalling: false, streaming: false,
        modelListing: false }),
      capabilityCertificationHash: `sha256:${"a".repeat(64)}`,
      status: "active" as const, createdAt: FINANCIAL_COUNCIL_INTEGRATION_AS_OF,
      updatedAt: FINANCIAL_COUNCIL_INTEGRATION_AS_OF }),
    Object.freeze({ id: "acceptance-deepseek", ownerId: "u_admin",
      teamId: FINANCIAL_COUNCIL_REAL_E2E_WORKSPACE,
      provider: "deepseek" as const,
      model: "acceptance-deepseek-structured", credentialVersion: 1,
      capabilitySnapshot: Object.freeze({ structuredOutput: true,
        toolCalling: false, parallelToolCalling: false, streaming: false,
        modelListing: false }),
      capabilityCertificationHash: `sha256:${"b".repeat(64)}`,
      status: "active" as const, createdAt: FINANCIAL_COUNCIL_INTEGRATION_AS_OF,
      updatedAt: FINANCIAL_COUNCIL_INTEGRATION_AS_OF })
  ]);
  const runtimeState = () => Object.freeze({ connections: runtimeConnections,
    recentCalls: Object.freeze([]) });
  let fixture: Awaited<ReturnType<
    typeof createFinancialCouncilIntegrationFixture
  >>;
  try {
    fixture = await createFinancialCouncilIntegrationFixture({
      repository,
      policyRepository,
      draftRepository: drafts,
      statementPackageRepository: e2eStatementService,
      modelRoutingRepository: modelRouting,
      workspaceId: FINANCIAL_COUNCIL_REAL_E2E_WORKSPACE,
      autoWake: true,
      modelDelayMs: 25,
      formulaMinimumCashReserveMinor: 150_000_000,
      logger: {
        error(event) {
          console.error(JSON.stringify({
            event: "financial_council_real_e2e_analysis_failed",
            detail: event
          }));
        }
      }
    });
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
  const policyWorkspace = Object.freeze({
    workspaceId: FINANCIAL_COUNCIL_REAL_E2E_WORKSPACE,
    kind: "team" as const,
    actorId: "u_admin",
    role: "admin" as const,
    teamId: FINANCIAL_COUNCIL_REAL_E2E_WORKSPACE,
    capabilities: capabilitiesForHumanRole("admin"),
    capabilityRegistryVersion: "growth-capabilities.v1" as const
  });
  const initialPolicy = await fixture.service.getPolicy(policyWorkspace);
  await fixture.service.updatePolicy(Object.freeze({
    workspace: policyWorkspace,
    actorId: policyWorkspace.actorId,
    idempotencyKey: "financial-council-real-e2e-policy",
    requestHash: financialCouncilCanonicalHash({
      purpose: "financial-council-real-e2e-policy"
    }),
    expectedRevision: initialPolicy.revision
  }), financialCouncilIntegrationPolicyInput());
  const roleRoute = () => Object.freeze({ mode: "auto" as const,
    primaryConnectionId: null, fallbackConnectionIds: Object.freeze([]),
    preferenceWeightBps: 0 });
  const routingInput = Object.freeze({
    roles: Object.freeze({ cfo: roleRoute(), finance: roleRoute(),
      profit: roleRoute(), cost: roleRoute(), cashflow: roleRoute(),
      tax: roleRoute() }),
    maxRunBudgetMinor: 100_000, maxRoleBudgetMinor: 20_000,
    requestTimeoutMs: 30_000
  });
  await modelRouting.put(Object.freeze({ workspace: policyWorkspace,
    actorId: policyWorkspace.actorId,
    idempotencyKey: "financial-council-real-e2e-routing",
    requestHash: financialCouncilCanonicalHash({
      purpose: "financial-council-real-e2e-routing"
    }), expectedRevision: null }),
  createFinancialCouncilModelRoutingPolicyVersion({
    policyVersionId: "financial-council-real-e2e-routing-v1",
    workspaceId: policyWorkspace.workspaceId, revision: 1, status: "active",
    input: routingInput, createdBy: policyWorkspace.actorId,
    createdAt: FINANCIAL_COUNCIL_INTEGRATION_AS_OF
  }));
  fixture.dispatch.start();
  const httpIdempotency = new MysqlGrowthHttpIdempotencyRepository(
    database.pool
  );
  const routingService = new FinancialCouncilModelRoutingService({
    repository: modelRouting, runtimeState
  });
  const agentCenter = new FinancialCouncilAgentCenter({
    latestPackage: statementPackages, latestRun: repository,
    routing: modelRouting, runtimeState
  });
  const service = fixture.service;
  const routerService = Object.freeze({
    async createRun(...args: Parameters<typeof service.createRun>) {
      let created;
      try { created = await service.createRun(...args); }
      catch (error) {
        console.error(JSON.stringify({
          event: "financial_council_real_e2e_create_run_failed",
          code: typeof (error as { code?: unknown })?.code === "string"
            ? (error as { code: string }).code : "UNCLASSIFIED",
          kind: error instanceof Error ? error.name : "unknown"
        }));
        throw error;
      }
      await waitUntilProjectable(() => service.getRun(
        args[0].workspace, created.value.runId
      ));
      return created;
    },
    async createRunFromStatementPackage(...args: Parameters<
      typeof service.createRunFromStatementPackage>) {
      try {
        const created = await service.createRunFromStatementPackage(...args);
        await waitUntilProjectable(() => service.getRun(
          args[0].workspace, created.value.runId
        ));
        return created;
      } catch (error) {
        console.error(JSON.stringify({
          event: "financial_council_real_e2e_create_package_run_failed",
          code: typeof (error as { code?: unknown })?.code === "string"
            ? (error as { code: string }).code : "UNCLASSIFIED",
          kind: error instanceof Error ? error.name : "unknown"
        }));
        throw error;
      }
    },
    getRun: service.getRun.bind(service),
    listEvents: service.listEvents.bind(service),
    revisePortfolio: service.revisePortfolio.bind(service),
    getPortfolioRevision: service.getPortfolioRevision.bind(service),
    approve: service.approve.bind(service),
    reject: service.reject.bind(service),
    getApproval: service.getApproval.bind(service),
    listDispatches: service.listDispatches.bind(service)
  });
  const policyService = Object.freeze({
    getPolicy: service.getPolicy.bind(service),
    getPolicyVersion: service.getPolicyVersion.bind(service),
    updatePolicy: service.updatePolicy.bind(service)
  });
  const module: GrowthCommercialModule = Object.freeze({
    name: "financial-council-real-e2e",
    async install(input: Parameters<GrowthCommercialModule["install"]>[0]) {
      const { router } = input;
      const shared = {
        workspaceContext: activeWorkspace,
        commandContextFactory: commandContextFromRequest,
        httpIdempotency
      };
      router.use("/api/v1/finance/council-runs",
        createFinancialCouncilRouter({ ...shared, service: routerService }));
      router.use("/api/v1/finance/council-policy",
        createFinancialCouncilPolicyRouter({
          ...shared, service: policyService
        }));
      router.use("/api/v1/finance/statement-packages",
        createFinancialStatementPackageRouter({
          ...shared, service: e2eStatementService,
          now: () => "2026-08-16T08:09:00.000Z"
        }));
      router.use("/api/v1/finance/council-model-routing-policy",
        createFinancialCouncilModelRoutingRouter({
          ...shared, service: routingService
        }));
      router.use("/api/v1/finance",
        createFinancialCouncilAgentCenterRouter({
          workspaceContext: activeWorkspace, center: agentCenter
        }));
      return Object.freeze({ close: () => fixture.close() });
    }
  });

  let runtime: GrowthCommercialRuntime<{ readonly kind: string }> | undefined;
  let httpServer: Server | undefined;
  try {
    runtime = await createGrowthCommercialApplication({
      manifest: loadGrowthContractRelease().manifest,
      requireAuth,
      workspaceMiddleware: createGrowthWorkspaceMiddleware({
        async canAccess(user, workspaceId) {
          return user.teamId === workspaceId;
        }
      }),
      enabledFeatures: () => Object.freeze([]),
      composition: Object.freeze({
        modules: Object.freeze([module]),
        projectIntegrations: () => Object.freeze({ kind: "real-e2e" })
      })
    });
    const serverModule = await import("./server.js");
    serverModule.installTestGrowthCommercialRuntime(runtime);
    const contract = financialCouncilRealE2eContract(database.databaseName);
    const e2eApp = express();
    e2eApp.get("/healthz", (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({
        status: "ok",
        schemaVersion: contract.schemaVersion,
        workspaceId: contract.workspaceId,
        databaseName: contract.databaseName
      });
    });
    e2eApp.use(serverModule.app);
    httpServer = await new Promise<Server>((resolve, reject) => {
      const candidate = e2eApp.listen(
        FINANCIAL_COUNCIL_REAL_E2E_PORT,
        FINANCIAL_COUNCIL_REAL_E2E_HOST,
        () => resolve(candidate)
      );
      candidate.once("error", reject);
    });
    let closePromise: Promise<void> | null = null;
    return Object.freeze({
      contract,
      close() {
        closePromise ??= (async () => {
          let failure: unknown;
          for (const close of [
            () => closeHttpServer(httpServer!),
            () => runtime!.close(),
            () => database.close()
          ]) {
            try {
              await close();
            } catch (error) {
              failure ??= error;
            }
          }
          if (failure) throw failure;
        })();
        return closePromise;
      }
    });
  } catch (error) {
    if (httpServer) await closeHttpServer(httpServer).catch(() => undefined);
    if (runtime) await runtime.close().catch(() => undefined);
    else await fixture.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    const server = await startFinancialCouncilRealE2eServer();
    console.log(JSON.stringify({
      event: "financial_council_real_e2e_ready",
      ...server.contract
    }));
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      void server.close().then(() => process.exit(0), (error) => {
        console.error(JSON.stringify({
          event: "financial_council_real_e2e_shutdown_failed",
          message: error instanceof Error ? error.message : String(error)
        }));
        process.exit(1);
      });
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  } catch (error) {
    console.error(JSON.stringify({
      event: "financial_council_real_e2e_start_failed",
      message: error instanceof Error ? error.message : String(error)
    }));
    process.exitCode = 1;
  }
}

const invokedAs = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : "";
if (import.meta.url === invokedAs) void main();

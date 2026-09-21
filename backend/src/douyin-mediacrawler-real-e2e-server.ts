import express from "express";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import mysql from "mysql2/promise";

import { requireAuth } from "./auth.js";
import { createMysqlStore } from "./mysql-store.js";
import { setStore } from "./store.js";
import { createGrowthCommercialApplication, type GrowthCommercialRuntime } from "./growth-commercial-application.js";
import { createGrowthCommercialCompositionForStore, type GrowthAcquisitionIntegrations } from "./growth-commercial-composition.js";
import { GROWTH_FEATURES } from "./growth-bootstrap-router.js";
import { loadGrowthContractRelease } from "./growth-openapi.js";
import { createAcquisitionApplication } from "./acquisition-application.js";
import { createDouyinMediaCrawlerGateway } from "./acquisition-mediacrawler-gateway.js";
import { MysqlAcquisitionPlanRunRepository } from "./acquisition-mysql-repositories.js";
import { AcquisitionPlanRunService } from "./acquisition-plan-run-service.js";

export interface DouyinMediaCrawlerRealE2eConfiguration {
  readonly databaseAdminUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly backendPort: number;
  readonly sidecarUrl: string;
  readonly serviceSecret: string;
}

function connectionOptions(url: URL) {
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    timezone: "Z" as const,
    dateStrings: true
  };
}

function secretFromFile(path: string) {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("MEDIACRAWLER_SERVICE_SECRET_FILE_INVALID:douyin-mediacrawler-real-runtime");
  const value = readFileSync(path, "utf8");
  if (/\s/u.test(value) || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("MEDIACRAWLER_SERVICE_SECRET_FILE_INVALID:douyin-mediacrawler-real-runtime");
  }
  return value;
}

export function readDouyinMediaCrawlerRealE2eConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): DouyinMediaCrawlerRealE2eConfiguration {
  const rawAdmin = environment.MYSQL_TEST_ADMIN_URL?.trim();
  if (!rawAdmin) throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:douyin-mediacrawler-real-runtime");
  const admin = new URL(rawAdmin);
  if (admin.protocol !== "mysql:") throw new Error("MYSQL_TEST_ADMIN_URL_REQUIRED:douyin-mediacrawler-real-runtime:mysql-protocol");
  const secretFile = environment.MEDIACRAWLER_SERVICE_SECRET_FILE?.trim();
  if (!secretFile) throw new Error("MEDIACRAWLER_SERVICE_SECRET_FILE_REQUIRED:douyin-mediacrawler-real-runtime");
  const databaseName = `shensi_task10_e2e_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const database = new URL(admin);
  database.pathname = `/${databaseName}`;
  return Object.freeze({
    databaseAdminUrl: admin.href,
    databaseName,
    databaseUrl: database.href,
    backendPort: Number(environment.DOUYIN_E2E_BACKEND_PORT ?? 5_488),
    sidecarUrl: environment.MEDIACRAWLER_BASE_URL?.trim() || "http://127.0.0.1:5491",
    serviceSecret: secretFromFile(secretFile)
  });
}

function readiness(configuration: DouyinMediaCrawlerRealE2eConfiguration) {
  return Object.freeze({
    schemaVersion: "douyin-mediacrawler-real-e2e.v1" as const,
    backendUrl: `http://127.0.0.1:${configuration.backendPort}`,
    healthUrl: `http://127.0.0.1:${configuration.backendPort}/healthz`,
    loginPath: "/api/auth/login" as const,
    csrfPath: "/api/auth/csrf" as const,
    workspaceId: "europe" as const,
    databaseName: configuration.databaseName
  });
}

function closeHttpServer(server: Server) {
  return new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function seedApprovedDouyinPlan(databaseUrl: string) {
  const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 2 });
  try {
    let sequence = 0;
    const service = new AcquisitionPlanRunService({
      repository: new MysqlAcquisitionPlanRunRepository(pool),
      executionPort: {
        async enqueue() {}, async requestPause() {}, async resume() {}, async requestCancel() {}
      },
      idFactory: (prefix) => `${prefix}-task10-${++sequence}`
    });
    const scope = { ownerId: "u_admin", teamId: "europe", actorId: "u_admin" };
    const draft = await service.createPlan(scope, {
      targetPlatform: "douyin",
      name: "抖音工业需求获客",
      objective: "发现公开发布的工业泵与替换密封件需求",
      icp: {
        industries: ["工业设备"], regions: ["中国"],
        organizationCriteria: ["公开采购工业泵或密封件"],
        individualCriteria: ["公开表达工业配件需求"],
        exclusionRules: ["明确拒绝联系"]
      },
      subjectChannels: { organization: true, individual: true },
      providerConnections: [{
        connectionId: "task10-public-search", providerId: "brave",
        kind: "search", status: "active", credentialVersion: 1
      }],
      operations: [{
        operationId: "task10-douyin-search", subjectChannel: "individual",
        kind: "search", connectionId: "task10-public-search",
        query: "site:douyin.com industrial pump replacement seal",
        allocatedBudget: { requests: 1, results: 10, amountMinor: 0, durationSeconds: 60 }
      }],
      budgetSnapshot: { billingCurrency: "CNY", maxRequests: 1, maxResults: 10, maxAmountMinor: 0, maxDurationSeconds: 60 },
      modelSnapshotRef: {
        jobSnapshotId: "task10-model-snapshot", connectionId: "task10-model-connection",
        credentialVersion: 1, provider: "fixture", model: "deterministic",
        capabilitySnapshotHash: `sha256:${"1".repeat(64)}`,
        promptVersion: "task10-plan.v1", schemaVersion: "task10-plan.v1",
        promptHash: `sha256:${"2".repeat(64)}`, schemaHash: `sha256:${"3".repeat(64)}`
      },
      stopConditions: { stopWhenBudgetExhausted: true, stopWhenNoMoreResults: true }
    });
    return draft;
  } finally { await pool.end(); }
}

export async function createDouyinMediaCrawlerRealE2eRuntime(options: {
  configuration?: DouyinMediaCrawlerRealE2eConfiguration;
  startDatabase?: () => Promise<{ close(): Promise<void> }>;
  startHttpServer?: () => Promise<{ close(): Promise<void> }>;
} = {}) {
  const configuration = options.configuration ?? readDouyinMediaCrawlerRealE2eConfiguration();
  const contract = readiness(configuration);
  if (options.startDatabase || options.startHttpServer) {
    const database = await (options.startDatabase?.() ?? Promise.resolve({ close: async () => undefined }));
    const http = await (options.startHttpServer?.() ?? Promise.resolve({ close: async () => undefined }));
    return Object.freeze({
      readiness: contract,
      async close() { await http.close(); await database.close(); }
    });
  }

  if (process.env.NODE_ENV !== "test") throw new Error("DOUYIN_MEDIACRAWLER_REAL_E2E_REQUIRES_NODE_ENV_TEST");
  const adminUrl = new URL(configuration.databaseAdminUrl);
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let store: Awaited<ReturnType<typeof createMysqlStore>> | undefined;
  let growth: GrowthCommercialRuntime<GrowthAcquisitionIntegrations> | undefined;
  let acquisition: Awaited<ReturnType<typeof createAcquisitionApplication>> | undefined;
  let uninstallAcquisition: (() => Promise<void>) | undefined;
  let http: Server | undefined;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  try {
    await admin.query(`CREATE DATABASE \`${configuration.databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    process.env.DATABASE_URL = configuration.databaseUrl;
    store = await createMysqlStore({ processRole: "api" });
    setStore(store);
    const foundation = createGrowthCommercialCompositionForStore({ store, databaseUrl: configuration.databaseUrl });
    growth = await createGrowthCommercialApplication({
      manifest: loadGrowthContractRelease().manifest,
      requireAuth,
      workspaceMiddleware: foundation.workspaceMiddleware,
      enabledFeatures: () => GROWTH_FEATURES,
      composition: foundation.composition
    });
    acquisition = await createAcquisitionApplication({
      store,
      masterSecret: process.env.ACQUISITION_MASTER_SECRET!,
      growthToolPorts: growth.toolPorts,
      acquisitionWorkspace: growth.integrations.acquisitionWorkspace,
      growthTemporalBarrier: growth.integrations.temporalBarrier,
      temporalTransactions: growth.integrations.temporalTransactions,
      probabilityAssessments: growth.integrations.probabilityAssessments,
      quoteProjectedDocumentAuthority: growth.integrations.quoteProjectedDocumentAuthority,
      databaseUrl: configuration.databaseUrl,
      douyinMediaCrawlerGateway: createDouyinMediaCrawlerGateway({
        baseUrl: configuration.sidecarUrl,
        serviceSecret: configuration.serviceSecret
      }),
      workerConcurrency: 1,
      shutdownTimeoutMs: 20_000
    });
    await seedApprovedDouyinPlan(configuration.databaseUrl);
    const serverModule = await import("./server.js");
    serverModule.installTestGrowthCommercialRuntime(growth);
    uninstallAcquisition = serverModule.installTestAcquisitionHttpRuntime({
      workspaceMiddleware: foundation.workspaceMiddleware,
      runtime: acquisition
    });
    const e2eApp = express();
    e2eApp.get("/healthz", async (_request, response) => {
      try {
        await createDouyinMediaCrawlerGateway({ baseUrl: configuration.sidecarUrl, serviceSecret: configuration.serviceSecret }).health();
        response.setHeader("cache-control", "no-store");
        response.status(200).json({ status: "ok", schemaVersion: contract.schemaVersion, databaseName: contract.databaseName });
      } catch { response.status(503).json({ status: "unavailable" }); }
    });
    e2eApp.use(serverModule.app);
    http = await new Promise<Server>((resolve, reject) => {
      const candidate = e2eApp.listen(configuration.backendPort, "127.0.0.1", () => resolve(candidate));
      candidate.once("error", reject);
    });
    let closePromise: Promise<void> | null = null;
    return Object.freeze({
      readiness: contract,
      close() {
        closePromise ??= (async () => {
          let failure: unknown;
          for (const close of [
            () => closeHttpServer(http!),
            () => uninstallAcquisition!(),
            () => growth!.close(),
            () => store!.close!(),
            () => admin.query(`DROP DATABASE IF EXISTS \`${configuration.databaseName}\``).then(() => undefined),
            () => admin.end()
          ]) {
            try { await close(); } catch (error) { failure ??= error; }
          }
          if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
          else process.env.DATABASE_URL = previousDatabaseUrl;
          if (failure) throw failure;
        })();
        return closePromise;
      }
    });
  } catch (error) {
    if (http) await closeHttpServer(http).catch(() => undefined);
    await uninstallAcquisition?.().catch(() => undefined);
    await acquisition?.close().catch(() => undefined);
    await growth?.close().catch(() => undefined);
    await store?.close?.().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS \`${configuration.databaseName}\``).catch(() => undefined);
    await admin.end().catch(() => undefined);
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    throw error;
  }
}

async function main() {
  const runtime = await createDouyinMediaCrawlerRealE2eRuntime();
  console.log(JSON.stringify({ event: "douyin_mediacrawler_real_e2e_ready", ...runtime.readiness }));
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void runtime.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

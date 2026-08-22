import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type {
  GrowthCommercialComposition,
  GrowthCommercialModule
} from "./growth-commercial-composition.js";
import {
  createGrowthCommercialApplication,
  createGrowthCommercialToolPorts
} from "./growth-commercial-application.js";
import { createGrowthPrivateServiceRegistry } from "./growth-commercial-private-services.js";
import { nextGrowthRecordedAt } from "./growth-as-of.js";

const manifest = {
  name: "growth-advisor-quote-roi",
  contractVersion: "1.0.0",
  contractHash: `sha256:${"a".repeat(64)}`,
  openapiVersion: "3.1.0"
} as const;

async function get(handler: express.RequestHandler, path: string) {
  const app = express();
  app.use(handler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { response, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
}

function module(
  name: string,
  events: string[],
  options: { failInstall?: boolean; failClose?: boolean } = {}
): GrowthCommercialModule {
  return {
    name,
    async install({ router, toolPorts, privateServices }) {
      events.push(`install:${name}`);
      assert.ok(toolPorts);
      assert.ok(privateServices);
      if (options.failInstall) throw new Error(`install failed:${name}`);
      router.get(`/__test/${name}`, (_req, res) => res.json({ name }));
      let closed = false;
      return {
        async close() {
          if (closed) return;
          closed = true;
          events.push(`close:${name}`);
          if (options.failClose) throw new Error(`close failed:${name}`);
        }
      };
    }
  };
}

function options<T extends object>(
  composition: GrowthCommercialComposition<T>,
  seams: {
    toolPorts?: ReturnType<typeof createGrowthCommercialToolPorts>[];
    privateServices?: ReturnType<typeof createGrowthPrivateServiceRegistry>[];
  } = {}
) {
  return {
    manifest,
    requireAuth: ((_req, _res, next) => next()) as express.RequestHandler,
    workspaceMiddleware: ((req, _res, next) => {
      req.activeWorkspace = {
        workspaceId: "workspace-1",
        kind: "team",
        actorId: "user-1",
        role: "sales",
        teamId: "workspace-1",
        capabilities: ["catalog.read"],
        capabilityRegistryVersion: "growth-capabilities.v1"
      };
      next();
    }) as express.RequestHandler,
    enabledFeatures: () => ["catalog"] as const,
    composition,
    createToolPorts: () => {
      const value = createGrowthCommercialToolPorts();
      seams.toolPorts?.push(value);
      return value;
    },
    createPrivateServices: () => {
      const value = createGrowthPrivateServiceRegistry();
      seams.privateServices?.push(value);
      return value;
    }
  };
}

test("one runtime shares one tool and private registry across every module", async () => {
  const events: string[] = [];
  const toolPorts: ReturnType<typeof createGrowthCommercialToolPorts>[] = [];
  const privateServices: ReturnType<typeof createGrowthPrivateServiceRegistry>[] = [];
  let installedToolPorts: unknown;
  let installedPrivateServices: unknown;
  const probe: GrowthCommercialModule = {
    name: "probe",
    async install(input) {
      installedToolPorts = input.toolPorts;
      installedPrivateServices = input.privateServices;
      return { close: async () => undefined };
    }
  };
  const runtime = await createGrowthCommercialApplication(options({
    modules: [probe],
    projectIntegrations: () => ({ ready: true })
  }, { toolPorts, privateServices }));
  try {
    assert.equal(toolPorts.length, 1);
    assert.equal(privateServices.length, 1);
    assert.equal(runtime.toolPorts, toolPorts[0]);
    assert.equal(installedToolPorts, toolPorts[0]);
    assert.equal(installedPrivateServices, privateServices[0]);
    assert.equal("privateServices" in runtime, false);
    const result = await get(runtime.handler, "/api/v1/growth/bootstrap");
    assert.equal(result.response.status, 200);
  } finally {
    await runtime.close();
  }
});

test("Growth routes enforce authentication before workspace resolution", async () => {
  let workspaceCalls = 0;
  const runtime = await createGrowthCommercialApplication({
    ...options({
      modules: [],
      projectIntegrations: () => ({ ready: true })
    }),
    requireAuth: ((_req, res) => {
      res.status(401).json({ code: "unauthorized" });
    }) as express.RequestHandler,
    workspaceMiddleware: ((_req, _res, next) => {
      workspaceCalls += 1;
      next();
    }) as express.RequestHandler
  });
  try {
    const result = await get(runtime.handler, "/api/v1/growth/bootstrap");
    assert.equal(result.response.status, 401);
    assert.deepEqual(result.body, { code: "unauthorized" });
    assert.equal(workspaceCalls, 0);
  } finally {
    await runtime.close();
  }
});

test("modules install once, project last, and close once in reverse order", async () => {
  const events: string[] = [];
  const integration = Object.freeze({ ready: true });
  const runtime = await createGrowthCommercialApplication(options({
    modules: [module("catalog", events), module("quote", events)],
    projectIntegrations() {
      events.push("project");
      return integration;
    }
  }));
  assert.equal(runtime.integrations, integration);
  assert.deepEqual(events, ["install:catalog", "install:quote", "project"]);
  await runtime.close();
  await runtime.close();
  assert.deepEqual(events, [
    "install:catalog", "install:quote", "project",
    "close:quote", "close:catalog"
  ]);
});

test("application shutdown naturally closes the financial council relay handle", async () => {
  const events: string[] = [];
  const runtime = await createGrowthCommercialApplication(options({
    modules: [module("growth-financial-council", events)],
    projectIntegrations: () => ({ ready: true })
  }));
  await runtime.close();
  assert.deepEqual(events, [
    "install:growth-financial-council",
    "close:growth-financial-council"
  ]);
});

test("close attempts every handle once and replays the first failure", async () => {
  const events: string[] = [];
  const runtime = await createGrowthCommercialApplication(options({
    modules: [
      module("catalog", events),
      module("quote", events, { failClose: true })
    ],
    projectIntegrations: () => ({ ready: true })
  }));
  await assert.rejects(runtime.close(), /close failed:quote/u);
  await assert.rejects(runtime.close(), /close failed:quote/u);
  assert.deepEqual(events, [
    "install:catalog", "install:quote",
    "close:quote", "close:catalog"
  ]);
});

test("failed install and failed projection clean every returned handle in reverse", async () => {
  const installEvents: string[] = [];
  await assert.rejects(createGrowthCommercialApplication(options({
    modules: [
      module("catalog", installEvents),
      module("quote", installEvents, { failInstall: true })
    ],
    projectIntegrations: () => ({})
  })), /install failed:quote/u);
  assert.deepEqual(installEvents, [
    "install:catalog", "install:quote", "close:catalog"
  ]);

  const projectionEvents: string[] = [];
  await assert.rejects(createGrowthCommercialApplication(options({
    modules: [
      module("catalog", projectionEvents),
      module("quote", projectionEvents)
    ],
    projectIntegrations() {
      projectionEvents.push("project");
      throw new Error("projection failed");
    }
  })), /projection failed/u);
  assert.deepEqual(projectionEvents, [
    "install:catalog", "install:quote", "project",
    "close:quote", "close:catalog"
  ]);
});

test("duplicate module and tool registrations fail deterministically", async () => {
  const duplicate = module("catalog", []);
  await assert.rejects(createGrowthCommercialApplication(options({
    modules: [duplicate, duplicate],
    projectIntegrations: () => ({})
  })), /DUPLICATE_GROWTH_MODULE/u);

  const tools = createGrowthCommercialToolPorts();
  const handler = async () => "ok";
  tools.register("list_catalog_items", handler);
  assert.throws(
    () => tools.register("list_catalog_items", handler),
    /DUPLICATE_GROWTH_TOOL_PORT/u
  );
  await assert.rejects(tools.execute({
    name: "get_pricing_policy",
    input: {},
    stableCallHash: `sha256:${"b".repeat(64)}`
  }, {} as never), /FEATURE_NOT_ENABLED/u);
  await assert.rejects(tools.execute({
    name: "unknown" as never,
    input: {},
    stableCallHash: `sha256:${"b".repeat(64)}`
  }, {} as never), /UNKNOWN_GROWTH_TOOL/u);
});

test("a same-clock append advances one DATETIME(3) tick without changing an old view", () => {
  const serverNow = "2026-08-09T08:00:00.123Z";
  const firstRecordedAt = nextGrowthRecordedAt(
    serverNow,
    "1970-01-01T00:00:00.000Z",
    1
  );
  const oldAsOf = firstRecordedAt;
  const secondRecordedAt = nextGrowthRecordedAt(
    serverNow,
    firstRecordedAt,
    1
  );
  assert.equal(secondRecordedAt, "2026-08-09T08:00:00.124Z");
  assert.deepEqual(
    [firstRecordedAt, secondRecordedAt].filter((recordedAt) =>
      Date.parse(recordedAt) <= Date.parse(oldAsOf)),
    [firstRecordedAt]
  );
});

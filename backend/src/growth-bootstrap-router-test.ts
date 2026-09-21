import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { GrowthCapability } from "./growth-capabilities.js";
import {
  createGrowthBootstrapRouter,
  type GrowthFeature
} from "./growth-bootstrap-router.js";

const manifest = {
  name: "growth-advisor-quote-roi",
  contractVersion: "1.0.0",
  contractHash: `sha256:${"a".repeat(64)}`,
  openapiVersion: "3.1.0"
} as const;

function context(
  capabilities: ActiveWorkspaceContext["capabilities"] = [
    "catalog.read",
    "quote.draft.create"
  ]
): ActiveWorkspaceContext {
  return Object.freeze({
    workspaceId: "workspace-1",
    kind: "team",
    actorId: "user-1",
    role: "sales",
    teamId: "workspace-1",
    capabilities,
    capabilityRegistryVersion: "growth-capabilities.v1"
  });
}

async function getBootstrap(input: {
  context: ActiveWorkspaceContext | null;
  enabledFeatures: (context: ActiveWorkspaceContext) => readonly GrowthFeature[];
}) {
  const app = express();
  app.use(createGrowthBootstrapRouter({
    manifest,
    capabilityRegistryVersion: "growth-capabilities.v1",
    resolveContext: async () => input.context,
    enabledFeatures: input.enabledFeatures
  }));
  app.use((_error: unknown, _req, res, _next) => {
    res.status(500).json({ code: "internal_error" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/growth/bootstrap`
    );
    return { response, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
}

test("bootstrap returns only the authorized concrete workspace and release identity", async () => {
  const result = await getBootstrap({
    context: context(),
    enabledFeatures: () => ["catalog", "quotes"]
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.response.headers.get("cache-control"), "no-store");
  assert.deepEqual(result.body, {
    status: "ready",
    workspaceId: "workspace-1",
    capabilityRegistryVersion: "growth-capabilities.v1",
    capabilities: ["catalog.read", "quote.draft.create"],
    contractVersion: "1.0.0",
    contractHash: `sha256:${"a".repeat(64)}`,
    features: ["catalog", "quotes"]
  });
  assert.equal(JSON.stringify(result.body).includes("all"), false);
});

test("bootstrap filters internal capabilities and rejects unknown projection values", async () => {
  const internal = await getBootstrap({
    context: context([
      "catalog.read",
      "acquisition.outcome.reconcile.internal"
    ]),
    enabledFeatures: () => ["catalog", "catalog"]
  });
  assert.deepEqual(internal.body.capabilities, ["catalog.read"]);
  assert.deepEqual(internal.body.features, ["catalog"]);

  const invalidCapability = await getBootstrap({
    context: context(["unknown-capability" as GrowthCapability]),
    enabledFeatures: () => ["catalog"]
  });
  assert.equal(invalidCapability.response.status, 500);
  assert.equal(
    JSON.stringify(invalidCapability.body).includes("unknown-capability"),
    false
  );

  const invalid = await getBootstrap({
    context: context(),
    enabledFeatures: () => ["unknown-growth-feature" as GrowthFeature]
  });
  assert.equal(invalid.response.status, 500);
  assert.equal(JSON.stringify(invalid.body).includes("unknown-growth-feature"), false);
});

test("bootstrap publishes the authenticated financial council capability", async () => {
  const result = await getBootstrap({
    context: context(["catalog.read", "finance.council.run"]),
    enabledFeatures: () => ["finance"]
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.capabilities, [
    "catalog.read", "finance.council.run"
  ]);
});

test("workspace selection response never evaluates workspace features", async () => {
  const result = await getBootstrap({
    context: null,
    enabledFeatures: () => {
      throw new Error("must not run without a workspace");
    }
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body, {
    status: "workspace_selection_required",
    workspaceId: null,
    capabilityRegistryVersion: "growth-capabilities.v1",
    capabilities: [],
    contractVersion: "1.0.0",
    contractHash: `sha256:${"a".repeat(64)}`,
    features: []
  });
});

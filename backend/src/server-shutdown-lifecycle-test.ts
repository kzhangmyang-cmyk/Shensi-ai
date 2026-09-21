import assert from "node:assert/strict";
import test from "node:test";
import {
  closeServerRuntimeResources,
  enabledServerGrowthFeatures
} from "./server.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

test("server enables every current Growth feature for a concrete workspace", () => {
  const context: ActiveWorkspaceContext = Object.freeze({
    workspaceId: "team-1",
    kind: "team",
    actorId: "admin-1",
    role: "admin",
    teamId: "team-1",
    capabilities: Object.freeze([]),
    capabilityRegistryVersion: "growth-capabilities.v1"
  });

  assert.deepEqual(enabledServerGrowthFeatures(context), [
    "catalog",
    "quotes",
    "finance",
    "roi",
    "advisor"
  ]);
});

test("server shutdown attempts Growth, HTTP, and store cleanup after Acquisition rejects", async () => {
  const events: string[] = [];
  const acquisitionFailure = new Error("acquisition close failed");
  let growthCloseCount = 0;

  await assert.rejects(closeServerRuntimeResources({
    async stopScheduler() {
      events.push("scheduler");
    },
    async stopWorker() {
      events.push("worker");
    },
    async closeAcquisition() {
      events.push("acquisition");
      throw acquisitionFailure;
    },
    async closeGrowth() {
      growthCloseCount += 1;
      events.push("growth");
    },
    async closeHttpServer() {
      events.push("http");
    },
    async closeStore() {
      events.push("store");
    }
  }), (error) => error === acquisitionFailure);

  assert.deepEqual(events, [
    "scheduler",
    "worker",
    "acquisition",
    "growth",
    "http",
    "store"
  ]);
  assert.equal(growthCloseCount, 1);
});

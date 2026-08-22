import assert from "node:assert/strict";
import test from "node:test";
import { closeServerRuntimeResources } from "./server.js";

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

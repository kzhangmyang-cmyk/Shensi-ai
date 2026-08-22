import { strict as assert } from "node:assert";
import { GrowthApiError } from "../http";
import {
  createFinanceController
} from "./controller";
import type { FinanceApi } from "./api";

function apiFixture(overrides: Partial<FinanceApi> = {}): FinanceApi {
  return {
    async listCostEntries() {
      return {
        status: 200,
        etag: null,
        body: { items: [], nextCursor: null }
      } as never;
    },
    async listCostEstimates() {
      return {
        status: 200,
        etag: null,
        body: { items: [], nextCursor: null }
      } as never;
    },
    async verifyCostEntry() {
      throw new Error("unused");
    },
    async reverseCostEntry() {
      throw new Error("unused");
    },
    async listFinancialFacts() {
      return {
        status: 200,
        etag: null,
        body: { items: [], nextCursor: null }
      } as never;
    },
    async verifyFinancialFact() {
      throw new Error("unused");
    },
    async correctFinancialFact() {
      throw new Error("unused");
    },
    async previewImport() {
      throw new Error("unused");
    },
    async commitImport() {
      throw new Error("unused");
    },
    async getImport() {
      throw new Error("unused");
    },
    ...overrides
  };
}

const controller = createFinanceController({
  api: apiFixture(),
  hasFeature: () => true,
  hasCapability: () => true
});

const ready = await controller.load();
assert.equal(ready.kind, "ready");
assert.equal(ready.canVerify, true);

const forbidden = await createFinanceController({
  api: apiFixture(),
  hasFeature: () => false,
  hasCapability: () => false
}).load();
assert.deepEqual(forbidden, { kind: "forbidden" });

const conflicting = await createFinanceController({
  api: apiFixture({
    async listCostEntries() {
      throw new GrowthApiError(409, "idempotency_conflict");
    }
  }),
  hasFeature: () => true,
  hasCapability: () => true
}).load();
assert.deepEqual(conflicting, {
  kind: "conflict",
  message: "idempotency_conflict"
});

const withImport = controller.setImportState({ kind: "idle" });
assert.equal(withImport.kind, "ready");
assert.equal(withImport.importState.kind, "idle");
assert.match(
  controller.nextIdempotencyKey("finance-correct"),
  /^finance-correct:/u
);

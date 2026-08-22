import { strict as assert } from "node:assert";
import { createFinanceApi } from "./api";
import type {
  GrowthHttpClient,
  GrowthHttpRequestOptions
} from "../http";
import type { FinancialFactCorrectionInput } from "./api";

const calls: Array<{ path: string; options?: GrowthHttpRequestOptions }> = [];
const http: GrowthHttpClient = {
  async request(path, options) {
    calls.push({ path, options });
    return {
      status: 200,
      etag: '"2"',
      body: { id: "fact-1", status: "verified", revision: 3 }
    } as never;
  }
};

const api = createFinanceApi(http);
const expectedCorrection: FinancialFactCorrectionInput = {
  reason: "银行回单金额录入错误",
  replacement: {
    factType: "payment_received",
    amountMinor: 125_000,
    currency: "CNY",
    businessOccurredAt: "2026-08-09T01:00:00.000Z",
    provenance: "manual_verified",
    evidenceHash: `sha256:${"e".repeat(64)}`,
    candidateId: null,
    customerId: null,
    dealId: null,
    externalId: null,
    sourceIdentityRoot: "fact-1",
    sourceRef: null
  }
};
await api.correctFinancialFact(
  "fact-1",
  expectedCorrection,
  '"fact-3"',
  "finance-correct:key-1"
);
assert.deepEqual(calls[0], {
  path: "/api/v1/finance/facts/fact-1/correct",
  options: {
    method: "POST",
    body: expectedCorrection,
    ifMatch: '"fact-3"',
    idempotencyKey: "finance-correct:key-1"
  }
});

await api.verifyCostEntry("cost-1", '"1"', "finance-verify:key-1");
assert.equal(
  calls[1]?.path,
  "/api/v1/acquisition/cost-entries/cost-1/verify"
);

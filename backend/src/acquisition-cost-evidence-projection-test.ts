import assert from "node:assert/strict";
import test from "node:test";
import { AcquisitionCostEvidenceProjector } from "./acquisition-cost-evidence-projection.js";
import { MysqlProviderRequestAccountingEvidenceSource } from "./acquisition-cost-evidence-source.js";
import { foundationServicesFixture } from "./growth-finance-test-fixtures.js";
import { InMemoryFinancialLedgerRepository } from "./financial-ledger-repository.js";

test("provider reported evidence becomes pending actual while estimated evidence remains estimate-only", async () => {
  const repository = new InMemoryFinancialLedgerRepository(
    {}, "2026-08-09T00:00:02.000Z"
  );
  const foundation = foundationServicesFixture({
    temporalTransactions: repository
  });
  const projector = new AcquisitionCostEvidenceProjector({
    repository,
    foundation,
    source: {
      async listAfter() {
        return [
          {
            id: "ev-1", workspaceId: "workspace-a", ledgerId: "ledger-1",
            runId: "run-1", providerId: "baidu",
            provenance: "provider_reported" as const,
            costAmountMajor: "1.23", currency: "CNY",
            evidenceHash: `sha256:${"1".repeat(64)}`,
            recordedAt: "2026-08-09T00:00:00.000Z"
          },
          {
            id: "ev-2", workspaceId: "workspace-a", ledgerId: "ledger-2",
            runId: "run-1", providerId: "baidu",
            provenance: "estimated" as const,
            costAmountMajor: "2.34", currency: "CNY",
            evidenceHash: `sha256:${"2".repeat(64)}`,
            recordedAt: "2026-08-09T00:00:01.000Z"
          }
        ];
      }
    }
  });

  const result = await projector.projectAfter("workspace-a", null, 100);

  assert.deepEqual(result, {
    projectedCostEntries: 1,
    projectedEstimates: 1,
    nextCheckpoint: {
      recordedAt: "2026-08-09T00:00:01.000Z", id: "ev-2"
    }
  });
  assert.equal((await repository.getCostEntryBySource(
    "workspace-a", "provider-request:ev-1"
  ))?.amountMinor, 123);
  assert.equal(await repository.getCostEntryBySource(
    "workspace-a", "provider-request:ev-2"
  ), null);
});

test("provider projection replay is economically idempotent", async () => {
  const repository = new InMemoryFinancialLedgerRepository(
    {}, "2026-08-09T00:00:02.000Z"
  );
  const foundation = foundationServicesFixture({ temporalTransactions: repository });
  const row = {
    id: "ev-repeat", workspaceId: "workspace-a", ledgerId: "ledger-repeat",
    runId: "run-repeat", providerId: "baidu",
    provenance: "provider_reported" as const,
    costAmountMajor: "4.56", currency: "CNY",
    evidenceHash: `sha256:${"a".repeat(64)}`,
    recordedAt: "2026-08-09T00:00:00.000Z",
    requestHash: "request-immutable", responseHash: "response-immutable",
    normalizedResultHash: "result-immutable", ledgerVersion: 7
  };
  const projector = new AcquisitionCostEvidenceProjector({
    repository, foundation,
    source: { async listAfter() { return [row]; } }
  });

  await projector.projectAfter("workspace-a", null, 100);
  await projector.projectAfter("workspace-a", null, 100);

  const projected = await repository.getCostEntryBySource(
    "workspace-a", "provider-request:ev-repeat"
  );
  assert.equal(projected?.sourceVersion, 1);
  assert.equal(projected?.amountMinor, 456);
});

test("provider projection rejects floating precision and safe-integer overflow", async () => {
  const repository = new InMemoryFinancialLedgerRepository();
  const foundation = foundationServicesFixture({ temporalTransactions: repository });
  const projector = new AcquisitionCostEvidenceProjector({
    repository, foundation,
    source: { async listAfter() {
      return [{
        id: "ev-invalid", workspaceId: "workspace-a", ledgerId: "ledger-invalid",
        runId: "run-invalid", providerId: "baidu",
        provenance: "estimated" as const,
        costAmountMajor: "90071992547409.92", currency: "CNY",
        evidenceHash: `sha256:${"b".repeat(64)}`,
        recordedAt: "2026-08-09T00:00:00.000Z"
      }];
    } }
  });

  await assert.rejects(
    projector.projectAfter("workspace-a", null, 100),
    (error: unknown) => (error as { code?: string }).code === "amount_out_of_range"
  );
  assert.equal(await repository.getCostEntryBySource(
    "workspace-a", "provider-request:ev-invalid"
  ), null);
});

test("MySQL evidence source freezes request, result, hash, and version without Number money", async () => {
  const statements: string[] = [];
  const values: unknown[][] = [];
  const source = new MysqlProviderRequestAccountingEvidenceSource({
    async query(statement: string, parameters?: unknown[]) {
      statements.push(statement.replace(/\s+/gu, " ").trim());
      values.push(parameters ?? []);
      return [[{
        id: "evidence-1", team_id: "workspace-a", ledger_id: "ledger-1",
        provenance: "estimated", cost_amount: "123456789012.345678",
        currency: "KWD", evidence_hash: "c".repeat(64),
        estimation_method_version: "estimate-v4", sequence_no: "8",
        created_at: "2026-08-09 01:02:03.004", run_id: "run-1",
        provider_code: "baidu", request_hash: "request-hash",
        response_hash: "response-hash", normalized_result_hash: "result-hash",
        version_no: "9"
      }], []] as never;
    }
  });

  const [row] = await source.listAfter("workspace-a", {
    recordedAt: "2026-08-09T00:00:00.000Z", id: "evidence-0"
  }, 25);

  assert.equal(row?.costAmountMajor, "123456789012.345678");
  assert.equal(row?.evidenceHash, `sha256:${"c".repeat(64)}`);
  assert.equal(row?.requestHash, "request-hash");
  assert.equal(row?.normalizedResultHash, "result-hash");
  assert.equal(row?.ledgerVersion, 9);
  assert.equal(row?.evidenceSequence, 8);
  assert.match(statements[0]!, /JOIN prospect_provider_request_ledgers/u);
  assert.match(statements[0]!, /ORDER BY evidence\.created_at ASC, evidence\.id ASC/u);
  assert.equal(values[0]?.at(-1), 25);
});

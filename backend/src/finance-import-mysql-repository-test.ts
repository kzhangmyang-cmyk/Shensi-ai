import assert from "node:assert/strict";
import test from "node:test";
import { MysqlFinanceImportRepository } from "./finance-import-mysql-repository.js";
import { projectFinanceImportPreviewRow } from "./finance-import-service.js";

test("MySQL append writes field metadata in existing errors_json and reopens it", async () => {
  const tables = new Map<string, Record<string, unknown>[]>();
  const connection = { async beginTransaction() {}, async commit() {}, async rollback() {}, release() {},
    async query(sql: string, values: unknown[]) {
      const insert = /INSERT INTO (finance_import_\w+)\s*\(([\s\S]*?)\)\s*VALUES/u.exec(sql);
      if (insert) {
        const columns = insert[2]!.split(",").map(column => column.trim().replaceAll("`", ""));
        const rows = tables.get(insert[1]!) ?? [];
        rows.push(Object.fromEntries(columns.map((column, index) => [column, values[index]])));
        tables.set(insert[1]!, rows);
        return [{ affectedRows: 1 }, []];
      }
      const table = /FROM (finance_import_\w+)/u.exec(sql)?.[1];
      return [tables.get(table!) ?? [], []];
    } };
  const source = { query: connection.query, async getConnection() { return connection; } };
  const now = "2026-08-08T00:00:00.000Z";
  const repository = new MysqlFinanceImportRepository(source as never,
    { async allocateAppend() { return { recordedAt: now, temporalSequence: 1 }; } } as never);
  const detail = { code: "money_invalid" as const, field: "amount", message: "金额无效" };
  await repository.appendPreview({ id: "p", workspaceId: "workspace-a", createdBy: "finance-a", previewRequestHash: "hash",
    fileHash: "file", templateVersion: "finance-cost-import.v1", kind: "acquisition_cost", resolvedTimeZone: "Asia/Shanghai",
    workspaceSettingsRevision: "settings-1", workspaceSettingsRecordedAt: now, workspaceSettingsEventSequence: 1,
    validRows: 0, invalidRows: 1, authorityEffectiveAsOf: now, authorityTemporalSequence: 1 },
  [{ id: "r", previewId: "p", rowNumber: 1, sheetName: "CSV", status: "invalid", sourceIdentityRoot: "stable-identity",
    normalized: null, errors: [detail.code], errorDetails: [detail] }]);
  assert.deepEqual(JSON.parse(String(tables.get("finance_import_rows")![0]!.errors_json)), [detail]);
  const reopened = new MysqlFinanceImportRepository(source as never, {} as never);
  assert.deepEqual((await reopened.getStoredRow("p", 1))?.errorDetails, [detail]);
});

test("MySQL row reader preserves structured field errors and legacy errors_json strings", async () => {
  const detail = { code: "money_invalid", field: "amount", message: "金额：格式无效" };
  const row = { id: "row-1", preview_id: "preview-1", row_number: 1, sheet_name: "CSV", status: "invalid",
    source_identity_root: "finance-import-row:legacy-identity", normalized_json: null,
    errors_json: JSON.stringify(["required_field_missing", detail]), recorded_at: "2026-08-08 00:00:00.000", temporal_sequence: 1 };
  const repository = new MysqlFinanceImportRepository({ async query() { return [[row], []]; } } as never, {} as never);
  const stored = (await repository.getStoredRow("preview-1", 1))!;
  assert.deepEqual(stored.errors, ["required_field_missing", "money_invalid"]);
  assert.deepEqual(stored.errorDetails, [{ code: "required_field_missing", field: null, message: "required_field_missing" }, detail]);
  assert.deepEqual(projectFinanceImportPreviewRow(stored).errorDetails, stored.errorDetails);
  assert.equal(stored.sourceIdentityRoot, row.source_identity_root);
  row.errors_json = JSON.stringify(["money_invalid"]);
  const legacy = (await repository.getStoredRow("preview-1", 1))!;
  assert.deepEqual(legacy.errors, ["money_invalid"]);
  assert.equal(legacy.errorDetails, undefined);
});

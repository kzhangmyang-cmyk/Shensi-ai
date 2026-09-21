import assert from "node:assert/strict";
import test from "node:test";
import XLSX from "xlsx-js-style";
import { projectFinanceImportPreview } from "./finance-import-router.js";
import {
  mountGrowthFinanceRouters
} from "./growth-finance-router-test-support.js";

test("preview projection preserves persisted field errors and reads legacy code arrays", () => {
  const base = { previewId: "p", kind: "acquisition_cost" as const, validRows: 0, invalidRows: 1,
    rows: [{ rowNumber: 1, status: "invalid" as const, errors: ["money_invalid" as const],
      errorDetails: [{ code: "money_invalid" as const, field: "amount", message: "金额：格式无效" }] }] };
  const view = projectFinanceImportPreview(base as never);
  assert.deepEqual(view.errors, [{ rowNumber: 1, code: "money_invalid", field: "amount", message: "金额：格式无效" }]);
  assert.equal(projectFinanceImportPreview({ ...base, rows: [{ ...base.rows[0], errorDetails: undefined }] } as never).errors[0]?.field, null);
});

test("downloaded XLSX templates round-trip through empty-mapping preview", async () => {
  const app = await mountGrowthFinanceRouters();
  try {
    for (const kind of ["financial_fact", "acquisition_cost"]) {
      const path = `/api/v1/finance/import-templates/${kind}`;
      const probe = await app.request(path, { headers: { "Idempotency-Key": `template-${kind}` } });
      assert.equal(probe.response.status, 200);
      const response = await fetch(probe.response.url, { headers: {
        "X-Workspace-Id": "workspace-a", "Idempotency-Key": `download-${kind}`
      } });
      const book = XLSX.read(Buffer.from(await response.arrayBuffer()), { type: "buffer" });
      XLSX.utils.sheet_add_aoa(book.Sheets[book.SheetNames[0]!]!, [["template-row", kind === "financial_fact" ? "已收款" : "运营费用",
        "12.50", "人民币", "2026-08-08", "", ...(kind === "financial_fact" ? ["", ""] : []), "待核验"]], { origin: "A2" });
      const preview = await app.request("/api/v1/finance/imports/preview", { method: "POST",
        headers: { "Idempotency-Key": `roundtrip-${kind}` }, body: { kind, fileName: "template.xlsx",
          mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          contentBase64: XLSX.write(book, { type: "buffer", bookType: "xlsx" }).toString("base64"), mapping: {} } });
      assert.equal(preview.response.status, 200);
      assert.equal(preview.body.acceptedRows, 1);
      assert.equal(preview.body.rejectedRows, 0);
    }
  } finally { await app.close(); }
});

test("finance import router previews, commits and lists row errors", async () => {
  const app = await mountGrowthFinanceRouters();
  try {
    const preview = await app.previewContractWon("import-router-preview");
    assert.equal(preview.response.status, 200);
    assert.equal(preview.body.kind, "financial_fact");
    assert.equal(preview.body.totalRows, 1);
    assert.equal(preview.body.acceptedRows, 1);
    assert.equal(preview.body.errors.length, 0);
    const committed = await app.commitPreview(
      preview.body.previewId, "import-router-commit"
    );
    assert.equal(committed.response.status, 202);
    assert.equal(committed.body.status, "queued");
    const fetched = await app.request(
      `/api/v1/finance/imports/${committed.body.id}`
    );
    assert.equal(fetched.response.status, 200);
    assert.equal(fetched.body.id, committed.body.id);
    const errors = await app.request(
      `/api/v1/finance/imports/${committed.body.id}/errors`
    );
    assert.equal(errors.response.status, 200);
    assert.deepEqual(errors.body.items, []);
  } finally {
    await app.close();
  }
});

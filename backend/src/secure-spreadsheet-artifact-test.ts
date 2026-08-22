import assert from "node:assert/strict";
import test from "node:test";
import XLSX from "xlsx-js-style";
import {
  escapeSpreadsheetCell,
  parseSecureSpreadsheetArtifact
} from "./secure-spreadsheet-artifact.js";

const limits = {
  maxBytes: 5_000_000,
  maxSheets: 10,
  maxRows: 10_000,
  maxColumns: 100,
  maxCellLength: 10_000
};

test("finance parser exposes formulas so callers can reject them", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([["amount"], [{ f: "1+1", v: 2 }]]),
    "Costs"
  );
  const artifact = parseSecureSpreadsheetArtifact({
    content: XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx"
    }),
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    limits
  });
  assert.equal(artifact.sheets[0]?.rows[1]?.[0]?.text, "2");
  assert.equal(artifact.sheets[0]?.rows[1]?.[0]?.formula, "1+1");
  assert.match(artifact.fileHash, /^sha256:[a-f0-9]{64}$/u);
});

test("error export neutralizes spreadsheet formula injection", () => {
  assert.equal(
    escapeSpreadsheetCell("=HYPERLINK(\"https://evil\")"),
    "'=HYPERLINK(\"https://evil\")"
  );
  assert.equal(escapeSpreadsheetCell("+SUM(A1:A2)"), "'+SUM(A1:A2)");
  assert.equal(escapeSpreadsheetCell("-1+2"), "'-1+2");
  assert.equal(escapeSpreadsheetCell("@cmd"), "'@cmd");
  assert.equal(escapeSpreadsheetCell("normal"), "normal");
});

test("CSV parser returns cells with null formulas and enforces shape", () => {
  const artifact = parseSecureSpreadsheetArtifact({
    content: Buffer.from("\ufeff标题,摘要\n公开商机,客户需求\n"),
    mediaType: "text/csv",
    limits
  });
  assert.equal(artifact.mediaType, "text/csv");
  assert.equal(artifact.sheets[0]?.name, "CSV");
  assert.deepEqual(
    artifact.sheets[0]?.rows.map((row) => row.map((cell) => cell.text)),
    [["标题", "摘要"], ["公开商机", "客户需求"]]
  );
  assert.equal(artifact.sheets[0]?.rows[1]?.[0]?.formula, null);
});

test("parser rejects oversized artifacts and bad media types", () => {
  assert.throws(() => parseSecureSpreadsheetArtifact({
    content: Buffer.alloc(limits.maxBytes + 1),
    mediaType: "text/csv",
    limits
  }), (error: unknown) =>
    (error as { code?: string }).code === "IMPORT_LIMIT_EXCEEDED");
  assert.throws(() => parseSecureSpreadsheetArtifact({
    content: Buffer.from("a,b\n"),
    mediaType: "application/pdf",
    limits
  }), (error: unknown) =>
    (error as { code?: string }).code === "IMPORT_ARTIFACT_INVALID");
});

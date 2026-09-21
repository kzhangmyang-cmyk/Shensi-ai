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

test('legacy BIFF Excel preserves Chinese, multiple sheets and numeric source values', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['利润表', '本期'], ['营业收入', 1234.5]]), '中文利润');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['现金流量表'], ['余额', -20]]), '现金流');
  const content = XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' });
  const result = parseSecureSpreadsheetArtifact({ content, mediaType: 'application/vnd.ms-excel', limits });
  assert.deepEqual(result.sheets.map(sheet => sheet.name), ['中文利润', '现金流']);
  assert.equal(result.sheets[0].rows[1][1].text, '1234.5');
  assert.equal(result.sheets[1].rows[1][1].text, '-20');
  assert.throws(() => parseSecureSpreadsheetArtifact({ content, mediaType: 'application/vnd.ms-excel', limits: { ...limits, maxBytes: 10 } }), /LIMIT/);
});

test('legacy static HTML and SpreadsheetML are parsed, arbitrary renamed text and active content rejected', () => {
  const parse = (text: string) => parseSecureSpreadsheetArtifact({ content: Buffer.from(text), mediaType: 'application/vnd.ms-excel', limits });
  assert.equal(parse('<html><body><table><tr><td>利润</td><td>123.5</td></tr></table></body></html>').sheets[0].rows[0][0].text, '利润');
  const xml = '<?xml version="1.0"?><Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="中文"><Table><Row><Cell><Data ss:Type="String">收入</Data></Cell><Cell><Data ss:Type="Number">12.5</Data></Cell></Row></Table></Worksheet></Workbook>';
  assert.equal(parse(xml).sheets[0].rows[0][1].text, '12.5');
  for (const invalid of ['not an Excel file', '<html><script>alert(1)</script><table></table></html>', '<!DOCTYPE Workbook [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + xml]) assert.throws(() => parse(invalid), /INVALID/);
});

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
  assert.equal(artifact.sheets[0]?.rows[1]?.[0]?.hasCachedValue, true);
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

test("source coordinates retain sparse XLSX offsets without changing row text", () => {
  const workbook = XLSX.utils.book_new();
  const sheet = { C4: { t: "s", v: "资产负债表" }, C7: { t: "s", v: "营业收入" },
    E7: { t: "n", v: 123.45 }, "!ref": "C4:E7" } as XLSX.WorkSheet;
  XLSX.utils.book_append_sheet(workbook, sheet, "原表");
  const parsed = parseSecureSpreadsheetArtifact({ content: XLSX.write(workbook,
    { type: "buffer", bookType: "xlsx" }),
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", limits });
  assert.deepEqual(parsed.sheets[0]!.rows.map(row => row.map(cell => cell.text)),
    [["资产负债表", "", ""], ["营业收入", "", "123.45"]]);
  assert.deepEqual(parsed.sheets[0]!.rows.map(row => row.map(cell =>
    [cell.sourceRow, cell.sourceColumn])), [[[4, 3], [4, 4], [4, 5]], [[7, 3], [7, 4], [7, 5]]]);
});

test("formulas without a cached value retain their source and remain unknown", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, { A1: { t: "s", v: "金额" },
    B2: { t: "n", f: "123+456" }, "!ref": "A1:B2" }, "公式表");
  const parsed = parseSecureSpreadsheetArtifact({ content: XLSX.write(workbook,
    { type: "buffer", bookType: "xlsx" }),
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", limits });
  const cell = parsed.sheets[0]!.rows.flat().find(cell => cell.formula === "123+456");
  assert.ok(cell);
  assert.equal(cell.hasCachedValue, false);
  assert.equal(cell.sourceRow, 2);
  assert.equal(cell.sourceColumn, 2);
  assert.equal(cell.text, "");
});

test("CSV coordinates are logical table cells, not quoted multiline text lines", () => {
  const parsed = parseSecureSpreadsheetArtifact({ content: Buffer.from('名称,金额\n"跨\n行",10\n\n次行,20'),
    mediaType: "text/csv", limits });
  assert.deepEqual(parsed.sheets[0]!.rows.map(row => row.map(cell =>
    [cell.sourceRow, cell.sourceColumn])), [[[1, 1], [1, 2]], [[2, 1], [2, 2]], [[3, 1]], [[4, 1], [4, 2]]]);
});

test("oversized sparse XLSX ranges are bounded before cell traversal", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, { A1: { t: "s", v: "标题" },
    "!ref": "A1:C100" }, "稀疏表");
  const content = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  assert.throws(() => parseSecureSpreadsheetArtifact({ content,
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", limits: { ...limits, maxRows: 50 } }),
  (error: unknown) => (error as { code?: string }).code === "IMPORT_LIMIT_EXCEEDED");
});

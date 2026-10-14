import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.SHENSI_SKIP_LOCAL_ENV = "true";
delete process.env.JSON_BODY_LIMIT;
const { app } = await import("./server.js");

test("server parses maximum-size finance preview uploads before normal Growth dispatch", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const upload = { fileName: "maximum.xlsx",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    contentBase64: Buffer.alloc(5 * 1024 * 1024).toString("base64") };
  for (const [pathname, payload] of [
    ["/api/v1/finance/documents/inspect", { ...upload, readWithModel: false }],
    ["/api/v1/finance/imports/preview", { ...upload, kind: "financial_fact", mapping: {} }],
    ["/api/v1/finance/statement-packages/preview", { statements:
      ["balance_sheet", "income_statement", "cash_flow_statement"].map((kind) => ({ ...upload, kind })) }],
  ] as const) {
    await t.test(pathname, async () => {
      const response = await fetch(`${origin}${pathname}?request=preview`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      // No business runtime or database is installed: parsing must reach the
      // unchanged fail-closed Growth bridge, never execute an import/commit.
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { code: "GROWTH_RUNTIME_NOT_READY" });
    });
  }
  const ordinaryBody = JSON.stringify({ contentBase64: "A".repeat(2 * 1024 * 1024) });
  for (const [method, pathname] of [
    ["POST", "/api/write"],
    ["POST", "/api/v1/finance/documents/inspect/"],
    ["PUT", "/api/v1/finance/documents/inspect"],
    ["POST", "/api/v1/finance/imports/preview/"],
    ["POST", "/api/v1/finance/imports/preview-other"],
    ["POST", "/api/v1/finance/imports/preview/commit"],
    ["PUT", "/api/v1/finance/imports/preview"],
    ["POST", "/api/v1/finance/statement-packages/preview/"],
    ["POST", "/api/v1/finance/statement-packages/preview/commit"],
    ["PATCH", "/api/v1/finance/statement-packages/preview"],
  ]) {
    await t.test(`${method} ${pathname} retains the default JSON limit`, async () => {
      const response = await fetch(`${origin}${pathname}`, {
        method, headers: { "content-type": "application/json" }, body: ordinaryBody,
      });
      assert.equal(response.status, 413);
      await response.arrayBuffer();
    });
  }
  for (const [pathname, size] of [
    ["/api/v1/finance/documents/inspect", 7 * 1024 * 1024],
    ["/api/v1/finance/imports/preview", 7 * 1024 * 1024],
    ["/api/v1/finance/statement-packages/preview", 21 * 1024 * 1024],
  ] as const) {
    await t.test(`${pathname} retains a bounded upload envelope`, async () => {
      const response = await fetch(`${origin}${pathname}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ contentBase64: "A".repeat(size) }),
      });
      assert.equal(response.status, 413);
      await response.arrayBuffer();
    });
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthQuoteMysqlTestDatabase } from "./growth-quote-mysql-test-support.js";
import { mutateAuthoritativeQuoteProjectionMysql } from "./quote-crm-command-mysql.js";
import { publicationVersion } from "./quote-crm-command-test.js";
import { createMemoryStore } from "./store.js";

test("MySQL PI publication preserves approved currency and amount with ISO timestamps", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
}, async () => {
  await withGrowthQuoteMysqlTestDatabase(async ({ pool }) => {
    const store = createMemoryStore({ tradeDocuments: [], dealEvents: [], deals: [] });
    await pool.query("INSERT INTO customers (id,company) VALUES ('customer-1','Synthetic')");
    await pool.query(`INSERT INTO deals
      (id,customer_id,owner_id,team_id,stage)
      VALUES ('deal-1','customer-1','sales-1','team-a','询盘')`);
    const result = await mutateAuthoritativeQuoteProjectionMysql(pool, {
      kind: "pi", stableId: "pi-native-test", workspaceId: "team-a",
      dealId: "deal-1", quoteCaseId: "case-1",
      quoteVersion: { ...publicationVersion, currency: "CNY" },
      dealAuthorityRevision: 2,
      commercialAmountHash: `sha256:${"a".repeat(64)}`,
      stableKey: "native-pi-test", recordedAt: "2026-09-30T08:00:00.000Z",
      temporalSequence: 1
    }, undefined, store);
    assert.equal(result.kind, "pi");
    if (result.kind !== "pi") throw new Error("PI required");
    assert.equal(result.document.currency, "CNY");
    assert.equal(result.document.quotedAmountMinor, 29800);
    assert.equal(store.tradeDocuments.length, 1, "PI must be visible without restarting store");
    assert.equal(store.tradeDocuments[0]?.currency, "CNY");
    const event = await mutateAuthoritativeQuoteProjectionMysql(pool, {
      kind: "crm", stableId: "event-native-test", workspaceId: "team-a",
      dealId: "deal-1", quoteCaseId: "case-1",
      quoteVersion: { ...publicationVersion, currency: "CNY" },
      dealAuthorityRevision: 2,
      commercialAmountHash: `sha256:${"a".repeat(64)}`,
      stableKey: "native-pi-test", recordedAt: "2026-09-30T08:00:00.000Z",
      temporalSequence: 2, piDocumentId: result.document.id, actorId: "sales-1"
    }, undefined, store);
    assert.equal(event.kind, "crm");
    if (event.kind !== "crm") throw new Error("event required");
    assert.equal(event.event.currencySnapshot, "CNY");
    assert.equal(event.event.amountMinorSnapshot, 29800);
    assert.equal(store.dealEvents.length, 1, "event must be visible without restarting store");
  });
});

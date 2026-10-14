import assert from "node:assert/strict";
import test from "node:test";
import XLSX from "xlsx-js-style";
import { financeImportFieldValue } from "./finance-import-columns.js";
import {
  FinanceImportService,
  parseFinancePreviewBody
} from "./finance-import-service.js";
import { InMemoryFinanceImportRepository } from "./finance-import-repository.js";
import {
  contractWonImportFixture,
  financePreviewFixture,
  foundationServicesFixture,
  ledgerCommandContext,
  wonQuoteFixture
} from "./growth-finance-test-fixtures.js";

test("closed value aliases match existing finance UI labels without guessing currency symbols", () => {
  for (const [label, code] of [["API 调用", "api"], ["媒体投放", "media"], ["内容制作", "content"], ["代理服务", "agency"], ["运营支出", "operation"]]) {
    assert.equal(financeImportFieldValue("category", label!), code);
  }
  assert.equal(financeImportFieldValue("factType", "合同赢单"), "contract_won");
  assert.equal(financeImportFieldValue("factType", "回款"), "payment_received");
  assert.equal(financeImportFieldValue("factType", "销售成本确认"), "cogs_recognized");
  assert.equal(financeImportFieldValue("status", "待核对"), "pending");
  for (const symbol of ["$", "¥", "￥"]) assert.equal(financeImportFieldValue("currency", symbol), symbol);
});

test("empty mapping accepts closed Chinese and bilingual headers for CSV and XLSX", async () => {
  for (const xlsx of [false, true]) {
    const rows = [[" 外部ID ", "事实类型", " Ａｍｏｕｎｔ （ 金额 ） ", "币种", "业务发生时间"],
      ["cn-1", "已收款", "100.00", "人民币", "2026-08-08"]];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "客户资料");
    const service = new FinanceImportService({ repository: new InMemoryFinanceImportRepository(),
      foundation: foundationServicesFixture({ timeZone: "Asia/Shanghai" }) });
    const preview = await service.preview(ledgerCommandContext("workspace-a", "finance-a"), {
      kind: "financial_fact", fileName: xlsx ? "客户.xlsx" : "客户.csv",
      mediaType: xlsx ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv",
      content: xlsx ? XLSX.write(book, { type: "buffer", bookType: "xlsx" }) : Buffer.from(rows.map(row => row.join(",")).join("\n")), mapping: {}
    });
    assert.equal(preview.validRows, 1);
    assert.equal(preview.rows[0]?.normalized?.currency, "CNY");
  }
});

test("auto mapping rejects ambiguous aliases while explicit mapping selects the named column", async () => {
  const content = Buffer.from("事实类型,金额,amount,币种,业务发生时间\n已收款,12.50,100.00,CNY,2026-08-08");
  const service = new FinanceImportService({ repository: new InMemoryFinanceImportRepository(), foundation: foundationServicesFixture() });
  const input = { kind: "financial_fact" as const, fileName: "ambiguous.csv", mediaType: "text/csv", content, mapping: {} };
  await assert.rejects(service.preview(ledgerCommandContext("workspace-a", "finance-a", "ambiguous"), input), /invalid_finance_import_mapping/);
  const preview = await service.preview(ledgerCommandContext("workspace-a", "finance-a", "explicit"), { ...input,
    mapping: { factType: "事实类型", amount: "金额", currency: "币种", businessOccurredAt: "业务发生时间" } });
  assert.equal(preview.validRows, 1);
  assert.equal(preview.rows[0]?.normalized?.kind === "financial_fact" && preview.rows[0].normalized.derivedFacts[0]?.amountMinor, 1250);
});

test("short rows preserve precise missing fields and negative costs have amount errors", async () => {
  const service = new FinanceImportService({ repository: new InMemoryFinanceImportRepository(), foundation: foundationServicesFixture() });
  const input = { kind: "acquisition_cost" as const, fileName: "short.csv", mediaType: "text/csv",
    content: Buffer.from("费用类别,金额,币种,业务发生时间\n运营费用\n运营费用,−1.00,CNY,2026-08-08\n运营费用,1.00,$,2026-08-08"), mapping: {} };
  const preview = await service.preview(ledgerCommandContext("workspace-a", "finance-a", "short"), input);
  assert.equal(preview.invalidRows, 3);
  assert.deepEqual(preview.rows[0]?.errorDetails?.map(error => error.field), ["currency", "amount", "businessOccurredAt"]);
  assert.ok(preview.rows[1]?.errorDetails?.some(error => error.field === "amount" && error.code === "money_invalid"));
  assert.ok(preview.rows[2]?.errorDetails?.some(error => error.field === "currency" && error.code === "currency_invalid"));
  const replay = await service.preview(ledgerCommandContext("workspace-a", "finance-a", "short"), input);
  assert.deepEqual(replay.rows, preview.rows);
  assert.equal(replay.replayed, true);
});

test("automatic versus explicit English mapping retains the same file-row identity", async () => {
  const service = new FinanceImportService({ repository: new InMemoryFinanceImportRepository(), foundation: foundationServicesFixture() });
  const input = { kind: "financial_fact" as const, fileName: "old.csv", mediaType: "text/csv",
    content: Buffer.from("factType,amount,currency,businessOccurredAt\npayment_received,1.00,CNY,2026-08-08"), mapping: {} };
  const automatic = await service.preview(ledgerCommandContext("workspace-a", "finance-a", "auto-identity"), input);
  const explicit = await service.preview(ledgerCommandContext("workspace-a", "finance-a", "explicit-identity"), { ...input,
    mapping: { factType: "factType", amount: "amount", currency: "currency", businessOccurredAt: "businessOccurredAt" } });
  assert.equal(automatic.rows[0]?.sourceIdentityRoot, explicit.rows[0]?.sourceIdentityRoot);
  assert.equal(automatic.rows[0]?.rowNumber, 1);
  assert.deepEqual(automatic.rows[0]?.normalized, explicit.rows[0]?.normalized);
});

test("preview separates valid rows, rejects verified and formula cells, and derives COGS", async () => {
  const csv = Buffer.from([
    "externalId,factType,amount,currency,businessOccurredAt,provenance,revenue,grossProfit,status",
    "bank-1,payment_received,100.00,CNY,2026-08-08T10:00:00+08:00,portal_export,,,pending",
    "invoice-1,revenue_recognized,1000.00,CNY,2026-08-08,derived_from_import,1000.00,400.00,pending",
    "bad-1,payment_received,=1+1,CNY,2026-08-08,portal_export,,,verified"
  ].join("\n"));
  const service = new FinanceImportService({
    repository: new InMemoryFinanceImportRepository(),
    foundation: foundationServicesFixture({
      timeZone: "Asia/Shanghai", settingsRevision: "settings-1"
    })
  });
  const preview = await service.preview(
    ledgerCommandContext("workspace-a", "finance-a"),
    {
      kind: "financial_fact",
      fileName: "facts.csv",
      mediaType: "text/csv",
      content: csv,
      mapping: {
        externalId: "externalId",
        factType: "factType",
        amount: "amount",
        currency: "currency",
        businessOccurredAt: "businessOccurredAt",
        provenance: "provenance",
        revenue: "revenue",
        grossProfit: "grossProfit",
        status: "status"
      }
    }
  );
  assert.equal(preview.validRows, 2);
  assert.equal(preview.invalidRows, 1);
  const normalized = preview.rows[1]?.normalized;
  assert.equal(normalized?.kind, "financial_fact");
  if (normalized?.kind !== "financial_fact") {
    throw new Error("expected_financial_fact_preview");
  }
  assert.deepEqual(normalized.derivedFacts, [
    { factType: "revenue_recognized", amountMinor: 100000 },
    {
      factType: "cogs_recognized",
      amountMinor: 60000,
      provenance: "derived_from_import"
    }
  ]);
  assert.ok(preview.rows[2]?.errors.includes("spreadsheet_formula_forbidden"));
  assert.ok(preview.rows[2]?.errors.includes("verified_import_forbidden"));
  assert.equal(preview.resolvedTimeZone, "Asia/Shanghai");
  assert.equal(preview.workspaceSettingsRevision, "settings-1");
  assert.throws(() => parseFinancePreviewBody({
    kind: "financial_fact",
    fileName: "facts.csv",
    mediaType: "text/csv",
    content: csv,
    mapping: {},
    tenantTimeZone: "UTC"
  }), /additionalProperties/);
});

test("preview auto-maps standard template headers when the client omits mapping overrides", async () => {
  const csv = Buffer.from([
    "externalId,factType,amount,currency,businessOccurredAt,provenance,revenue,grossProfit,status",
    "bank-1,payment_received,100.00,CNY,2026-08-08T10:00:00+08:00,portal_export,,,pending",
    "invoice-1,revenue_recognized,1000.00,CNY,2026-08-08,derived_from_import,1000.00,400.00,pending"
  ].join("\n"));
  const service = new FinanceImportService({
    repository: new InMemoryFinanceImportRepository(),
    foundation: foundationServicesFixture({
      timeZone: "Asia/Shanghai", settingsRevision: "settings-1"
    })
  });

  const preview = await service.preview(
    ledgerCommandContext(
      "workspace-a", "finance-a", "finance-preview-auto-map-0001"
    ),
    {
      kind: "financial_fact",
      fileName: "facts.csv",
      mediaType: "text/csv",
      content: csv,
      mapping: {}
    }
  );

  assert.equal(preview.validRows, 2);
  assert.equal(preview.invalidRows, 0);
  assert.equal(preview.rows[0]?.status, "valid");
  assert.deepEqual(preview.rows[1]?.normalized?.kind === "financial_fact"
    ? preview.rows[1].normalized.derivedFacts
    : null, [
    { factType: "revenue_recognized", amountMinor: 100000 },
    {
      factType: "cogs_recognized",
      amountMinor: 60000,
      provenance: "derived_from_import"
    }
  ]);
});

test("import preview shares bigint COGS derivation for loss invalid and overflow rows", async () => {
  const state = financePreviewFixture({
    financialRows: [
      { externalId: "loss", revenueMinor: 1000, grossProfitMinor: -400 },
      {
        externalId: "negative-cogs",
        revenueMinor: 1000,
        grossProfitMinor: 1001
      },
      {
        externalId: "overflow",
        revenueMinor: Number.MAX_SAFE_INTEGER,
        grossProfitMinor: -1
      }
    ]
  });
  const preview = await state.service.preview(state.command, state.input);
  assert.deepEqual(
    preview.rows[0]?.normalized?.kind === "financial_fact"
      ? preview.rows[0].normalized.derivedFacts
      : null,
    [
      { factType: "revenue_recognized", amountMinor: 1000 },
      {
        factType: "cogs_recognized",
        amountMinor: 1400,
        provenance: "derived_from_import"
      }
    ]
  );
  assert.ok(preview.rows[1]?.errors.includes("financial_fact_amount_invalid"));
  assert.ok(preview.rows[2]?.errors.includes("amount_out_of_range"));
  assert.equal(state.deriveHelperCallCount(), 3);
  assert.equal(await state.countLedgerRows(), 0);
});

test("date-only values use trusted workspace timezone and DST ambiguity fails closed", async () => {
  const service = new FinanceImportService({
    repository: new InMemoryFinanceImportRepository(),
    foundation: foundationServicesFixture({
      timeZone: "America/New_York", settingsRevision: "settings-2"
    })
  });
  const result = await service.preview(
    ledgerCommandContext("workspace-a", "finance-a"),
    financePreviewFixture({}).input({ businessOccurredAt: "2026-11-01 01:30:00" })
  );
  assert.ok(result.rows[0]?.errors.includes("business_time_invalid"));
});

test("preview reads workspace timezone at the same sealed cutoff exactly once", async () => {
  const state = financePreviewFixture({
    timeZone: "Asia/Shanghai",
    settingsRevision: "settings-1",
    pauseAfterSeal: true,
    physicalConnections: 2
  });
  const oldPreviewPromise = state.service.preview(
    state.command("preview-old-settings"),
    state.input({ businessOccurredAt: "2026-08-09" })
  );
  await state.waitForPreviewSeal();
  await state.appendWorkspaceSettingsOnConnectionB({
    timeZone: "America/New_York",
    revision: "settings-2"
  });
  state.releasePreviewAfterSeal();
  const oldPreview = await oldPreviewPromise;
  const oldRecord = await state.repository.getPreview(oldPreview.previewId);
  assert.equal(oldPreview.resolvedTimeZone, "Asia/Shanghai");
  assert.equal(oldRecord?.workspaceSettingsRevision, "settings-1");
  assert.equal(oldRecord?.workspaceSettingsEventSequence, 1);
  assert.strictEqual(
    state.workspaceSettingsGetAtTokens()[0],
    state.previewCutoffs()[0]
  );

  const newPreview = await state.service.preview(
    state.command("preview-new-settings"),
    state.input({ businessOccurredAt: "2026-08-09" })
  );
  const newRecord = await state.repository.getPreview(newPreview.previewId);
  assert.equal(newPreview.resolvedTimeZone, "America/New_York");
  assert.equal(newRecord?.workspaceSettingsRevision, "settings-2");
  assert.equal(newRecord?.workspaceSettingsEventSequence, 2);
  assert.equal(state.previewSealCallCount("preview-old-settings"), 1);
  assert.equal(state.previewSealCallCount("preview-new-settings"), 1);
  assert.equal(state.workspaceSettingsCurrentGetCallCount(), 0);
});

test("contract_won import preview requires the frozen won amount and currency", async () => {
  const state = contractWonImportFixture({ wonQuote: wonQuoteFixture() });
  const wrongAmount = await state.service.preview(
    state.command("preview-wrong-amount"),
    state.input({ amountMinor: 1, currency: "CNY" })
  );
  const wrongCurrency = await state.service.preview(
    state.command("preview-wrong-currency"),
    state.input({ amountMinor: 298000, currency: "USD" })
  );
  assert.ok(wrongAmount.rows[0]?.errors.includes("financial_fact_conflict"));
  assert.ok(wrongCurrency.rows[0]?.errors.includes("financial_fact_conflict"));
  assert.equal(await state.countLedgerRows(), 0);
  const exact = await state.service.preview(
    state.command("preview-exact-contract"),
    state.input({ amountMinor: 298000, currency: "CNY" })
  );
  assert.equal(exact.rows[0]?.status, "valid");
  const normalized = exact.rows[0]?.normalized;
  assert.equal(normalized?.kind, "financial_fact");
  if (normalized?.kind !== "financial_fact") {
    throw new Error("expected_financial_fact");
  }
  assert.equal("authoritativeDecision" in normalized, false);
  assert.equal("commercialBindingSnapshot" in normalized, false);
  const stored = await state.repository.getStoredRow(exact.previewId, 1);
  assert.equal(stored?.normalized?.kind, "financial_fact");
  if (stored?.normalized?.kind !== "financial_fact") {
    throw new Error("expected_stored_financial_fact");
  }
  assert.equal(
    stored.normalized.authoritativeDecision?.quotedAmountMinor,
    298000
  );
  assert.equal(
    stored.normalized.authoritativeDecision?.commercialBindingEvidence
      .candidateId,
    "candidate-1"
  );
  assert.match(
    stored.normalized.authoritativeDecision?.commercialBindingSnapshot
      .bindingHash ?? "",
    /^sha256:[a-f0-9]{64}$/u
  );
});

test("import preview rejects current rebinding instead of reattributing the frozen decision", async () => {
  const state = contractWonImportFixture();
  state.replaceCurrentBinding({
    candidateId: "candidate-rebound",
    customerId: "customer-rebound",
    dealId: "deal-1",
    handoffContentHash: "sha256:rebound-handoff",
    bindingHash: "sha256:rebound-binding"
  });
  const preview = await state.service.preview(
    state.command("preview-rebound-binding"),
    state.input()
  );
  assert.ok(preview.rows[0]?.errors.includes("financial_fact_conflict"));
  assert.equal(preview.rows[0]?.normalized, null);
  assert.equal(await state.countLedgerRows(), 0);
});

test("multi-row preview seals authority once and every Quote lookup sees one token", async () => {
  const state = contractWonImportFixture({ rows: 3 });
  await state.service.preview(state.command("preview-one-cutoff"), state.input());
  assert.equal(state.foundationSealCallCount(), 1);
  assert.equal(state.quoteReaderSealCallCount(), 0);
  assert.equal(state.quoteReaderCutoffs().length, 3);
  assert.equal(
    state.quoteReaderCutoffs().every(
      (cutoff) => cutoff === state.lastFoundationCutoff()
    ),
    true
  );
});

test("queueCommit replays by exact IDs with current authorization and blocks another actor", async () => {
  const state = financePreviewFixture({ createdBy: "finance-a" });
  const context = state.command({
    actorId: "finance-a",
    idempotencyKey: "finance-commit-0001"
  });
  const first = await state.service.queueCommit(context, state.previewId);
  const replay = await state.service.queueCommit(context, state.previewId);
  assert.equal(replay.operation.id, first.operation.id);
  assert.equal(replay.replayed, true);
  state.revoke("finance-a", "ledger.pending.create");
  await assert.rejects(
    () => state.service.queueCommit(context, state.previewId),
    (error: unknown) =>
      (error as { code?: string }).code === "capability_forbidden"
  );
  await assert.rejects(
    () => state.service.queueCommit(
      state.command({
        actorId: "finance-b",
        idempotencyKey: "finance-commit-0002"
      }),
      state.previewId
    ),
    (error: unknown) =>
      (error as { code?: string }).code === "finance_import_authority_mismatch"
  );
  assert.equal(state.repository.countOperations(), 1);
});

test("one key cannot queue two preview path IDs", async () => {
  const state = financePreviewFixture({
    previews: ["preview-a", "preview-b"],
    createdBy: "finance-a"
  });
  const request = (previewId: string) => state.command({
    actorId: "finance-a",
    idempotencyKey: "finance-cross-preview-0001",
    method: "POST",
    canonicalPath: "/api/v1/finance/imports/:previewId/commit",
    pathParams: { previewId },
    payload: {}
  });
  await state.service.queueCommit(request("preview-a"), "preview-a");
  await assert.rejects(
    () => state.service.queueCommit(request("preview-b"), "preview-b"),
    (error: unknown) =>
      (error as { code?: string }).code === "idempotency_conflict"
  );
  assert.equal(state.repository.countOperationsFor("preview-b"), 0);
});

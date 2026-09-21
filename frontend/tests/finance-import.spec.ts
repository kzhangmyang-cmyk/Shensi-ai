import { expect, test, type Page } from "@playwright/test";

const csv = "category,amount,currency,businessOccurredAt,externalId\napi,12.50,CNY,2026-09-09T08:00:00.000Z,fixture-cost-1\n";

async function mountFinance(page: Page) {
  const requests: { path: string; body: unknown }[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    requests.push({ path, body });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(
      path.endsWith("/documents/inspect")
        ? { documentId: "fixture-document", fileName: body.fileName, fileHash: `sha256:${"a".repeat(64)}`,
            expiresAt: "2026-09-10T12:00:00.000Z", selectedForConversation: false, classification: "ledger",
            regions: [{ regionId: "ledger", sheetName: "CSV", kind: "ledger", startRow: 1, endRow: 2, headerRow: 1, sourceRefs: ["cell:1:1:1"], uncertain: [] }],
            cells: [{ sourceRef: "cell:1:1:1", sheetName: "CSV", row: 1, column: 1, text: "category" }],
            missingStatements: ["balance_sheet", "income_statement", "cash_flow_statement"], uncertain: [], observations: [], modelStatus: "not_requested" }
        : path.endsWith("/imports/preview")
        ? { previewId: "fixture-preview", kind: body.kind, totalRows: 1,
            acceptedRows: 1, rejectedRows: 0, errors: [], expiresAt: "2026-09-10T12:00:00.000Z" }
        : path.endsWith("/commit") || path.endsWith("/imports/fixture-operation")
          ? { id: "fixture-operation", workspaceId: "fixture-finance", kind: "acquisition_cost",
              status: "succeeded", totalRows: 1, acceptedRows: 1, rejectedRows: 0,
              createdAt: "2026-09-09T08:00:00.000Z", completedAt: "2026-09-09T08:00:00.000Z" }
        : { items: [] }
    ) });
  });
  await page.route("**/__finance_fixture", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
      <link rel="stylesheet" href="/src/replica-dashboard.css">
      <link rel="stylesheet" href="/src/growth/styles.css">
      <body data-session-mode="real"><main class="replica-shell is-growth-finance-route" style="display:block"><div id="demoModuleMain"></div></main>
      <script type="module">
        document.body.dataset.unhandledFinanceSubmits = '0';
        document.body.addEventListener('submit', () => {
          document.body.dataset.unhandledFinanceSubmits = String(Number(document.body.dataset.unhandledFinanceSubmits) + 1);
        });
        import { startGrowthRuntime, resetGrowthRuntime } from '/src/growth/runtime.ts';
        window.disposeFinance = resetGrowthRuntime;
        import manifest from '/contracts/pinned/growth-advisor-quote-roi.manifest.json';
        await startGrowthRuntime({requested:'real',bootstrapLoader:{load:async()=>({
          status:'ready',workspaceId:'fixture-finance',capabilityRegistryVersion:'growth-capabilities.v1',
          capabilities:['ledger.pending.create','ledger.verify'],features:['finance'],
          contractVersion:manifest.contractVersion,contractHash:manifest.contractHash
        })}});
      </script></html>`
  }));
  await page.goto("/__finance_fixture#growth/finance");
  await expect(page.locator("[data-finance-import-form]")).toBeVisible();
  return requests;
}

async function previewLedger(page: Page) {
  await expect(page.locator('[data-finance-import-kind]')).toBeEnabled();
  if (await page.locator('[data-finance-import-kind]').inputValue() === 'readonly') {
    await page.locator('[data-finance-import-kind]').selectOption('acquisition_cost');
  }
  await page.getByRole('button', { name: '预览导入', exact: true }).click();
}

test("file selection inspects readonly without uploading a ledger preview", async ({ page }) => {
  const requests = await mountFinance(page);
  await page.locator("[data-finance-import-file]").setInputFiles({
    name: "isolated-costs.csv", mimeType: "text/csv", buffer: Buffer.from(csv)
  });
  await expect(page.locator(".finance-import")).toContainText("isolated-costs.csv");
  await expect(page.locator('[aria-label="只读资料预览"]')).toBeVisible();
  expect(requests.filter(({ path }) => path.endsWith('/documents/inspect'))).toHaveLength(1);
  expect(requests.find(({ path }) => path.endsWith('/documents/inspect'))?.body).toMatchObject({ readWithModel: false });
  expect(requests.filter(({ path }) => path.endsWith("/imports/preview"))).toHaveLength(0);
});

test("selected file preview sends the bytes and displays parsed feedback", async ({ page }) => {
  const requests = await mountFinance(page);
  await page.locator("[data-finance-import-file]").setInputFiles({
    name: "isolated-costs.csv", mimeType: "text/csv", buffer: Buffer.from(csv)
  });
  await previewLedger(page);
  await expect(page.locator(".finance-import")).toContainText("接受 1");
  await expect(page.locator("body")).toHaveAttribute("data-unhandled-finance-submits", "0");
  expect(requests.filter(({ path }) => path.endsWith("/imports/preview"))).toEqual([{
    path: "/api/v1/finance/imports/preview",
    body: { kind: "acquisition_cost", fileName: "isolated-costs.csv", mediaType: "text/csv",
      contentBase64: Buffer.from(csv).toString("base64"), mapping: {} }
  }]);
});

test("preview without a file displays a visible actionable validation message", async ({ page }) => {
  await mountFinance(page);
  await previewLedger(page);
  await expect(page.locator(".finance-import")).toContainText("请选择 CSV、XLSX、含文字的 PDF 或 DOCX 文件");
});

test("changing kind preserves the selected file across render and invalidates an earlier preview", async ({ page }) => {
  const requests = await mountFinance(page);
  await page.locator("[data-finance-import-file]").setInputFiles({
    name: "isolated-costs.csv", mimeType: "text/csv", buffer: Buffer.from(csv)
  });
  await previewLedger(page);
  await expect(page.getByRole("button", { name: "确认并写入账本" })).toBeVisible();
  await page.locator("[data-finance-import-kind]").selectOption("financial_fact");
  await expect(page.getByRole("button", { name: "确认并写入账本" })).toHaveCount(0);
  await expect(page.locator("[data-finance-import-selection]")).toContainText("isolated-costs.csv");
  await previewLedger(page);
  await expect(page.locator(".finance-import")).toContainText("接受 1");
  expect(requests.filter(({ path }) => path.endsWith("/imports/preview")).at(-1)?.body)
    .toMatchObject({ kind: "financial_fact", fileName: "isolated-costs.csv" });
});

test("dropping a file selects it without navigating and previews its contents", async ({ page }) => {
  const requests = await mountFinance(page);
  const transfer = await page.evaluateHandle((content) => {
    const data = new DataTransfer();
    data.items.add(new File([content], "dropped.csv", { type: "text/csv" }));
    return data;
  }, csv);
  await page.locator("[data-finance-import-dropzone]").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.locator("[data-finance-import-selection]")).toContainText("dropped.csv");
  await previewLedger(page);
  await expect(page.locator(".finance-import")).toContainText("接受 1");
  expect(requests.filter(({ path }) => path.endsWith("/imports/preview"))).toHaveLength(1);
  await transfer.dispose();
});

for (const file of [
  { name: "wrong.pptx", size: 1, message: "请选择 CSV、XLSX、含文字的 PDF 或 DOCX 文件" },
  { name: "empty.csv", size: 0, message: "文件为空" },
  { name: "large.csv", size: 5 * 1024 * 1024 + 1, message: "文件超过 5 MB" }
]) {
  test(`invalid selection ${file.name} gives a local error without upload`, async ({ page }) => {
    const requests = await mountFinance(page);
    await page.locator("[data-finance-import-file]").setInputFiles({
      name: file.name, mimeType: "application/octet-stream", buffer: Buffer.alloc(file.size)
    });
    await expect(page.getByRole("alert")).toContainText(file.message);
    await page.getByRole('button', { name: '只读识别', exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(file.message);
    expect(requests.filter(({ path }) => path.endsWith("/imports/preview"))).toHaveLength(0);
  });
}

test("parser failures give readable feedback and retain the selected file for retry", async ({ page }) => {
  await mountFinance(page);
  await page.route("**/api/v1/finance/imports/preview", route => route.fulfill({
    status: 422, contentType: "application/json",
    body: JSON.stringify({ code: "IMPORT_ARTIFACT_INVALID", requestId: "fixture-error" })
  }));
  await page.locator("[data-finance-import-file]").setInputFiles({
    name: "broken.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from("invalid")
  });
  await previewLedger(page);
  await expect(page.getByRole("alert")).toContainText("无法解析文件");
  await expect(page.locator("[data-finance-import-selection]")).toContainText("broken.xlsx");
  await expect(page.locator(".finance-import")).not.toContainText("fixture-error");
});

test("rejected rows show their errors and cannot be committed when none are accepted", async ({ page }) => {
  await mountFinance(page);
  await page.route("**/api/v1/finance/imports/preview", route => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ previewId: "bad-preview", kind: "acquisition_cost",
      totalRows: 1, acceptedRows: 0, rejectedRows: 1, expiresAt: "2026-09-10T12:00:00.000Z",
      errors: [{ rowNumber: 1, code: "money_invalid", field: "amount", message: "money_invalid" }] })
  }));
  await page.locator("[data-finance-import-file]").setInputFiles({
    name: "bad-costs.csv", mimeType: "text/csv", buffer: Buffer.from(csv)
  });
  await previewLedger(page);
  await expect(page.locator(".finance-import-errors")).toContainText("金额：金额格式无效");
  await expect(page.locator(".finance-import-errors")).toContainText("影响 1 行");
  await expect(page.getByRole("button", { name: "确认并写入账本" })).toBeDisabled();
});

test("only explicit confirmation writes the preview and refreshes the ledger", async ({ page }) => {
  const requests = await mountFinance(page);
  await page.locator("[data-finance-import-file]").setInputFiles({
    name: "costs.csv", mimeType: "text/csv", buffer: Buffer.from(csv)
  });
  await previewLedger(page);
  const confirm = page.getByRole("button", { name: "确认并写入账本" });
  await expect(confirm).toBeVisible();
  expect(requests.filter(({ path }) => path.endsWith("/commit"))).toHaveLength(0);
  await confirm.click();
  await expect(page.locator(".finance-import")).toContainText("导入成功：1 行");
  expect(requests.filter(({ path }) => path.endsWith("/commit"))).toHaveLength(1);
  expect(requests.filter(({ path }) => path.endsWith("/finance/facts"))).toHaveLength(2);
});

test("leaving finance aborts an outstanding preview and does not render into the next page", async ({ page }) => {
  await mountFinance(page);
  let started!: () => void;
  let release!: () => void;
  const didStart = new Promise<void>(resolve => { started = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/v1/finance/imports/preview", async (route) => {
    started();
    await released;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      previewId: "late-preview", kind: "acquisition_cost", totalRows: 1,
      acceptedRows: 1, rejectedRows: 0, errors: [], expiresAt: "2026-09-10T12:00:00.000Z"
    }) }).catch(() => {});
  });
  await page.locator("[data-finance-import-file]").setInputFiles({
    name: "costs.csv", mimeType: "text/csv", buffer: Buffer.from(csv)
  });
  await previewLedger(page);
  await didStart;
  await page.evaluate(async () => {
    await (window as unknown as { disposeFinance(): Promise<void> }).disposeFinance();
    document.getElementById("demoModuleMain")!.textContent = "下一页面";
  });
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.locator("#demoModuleMain")).toHaveText("下一页面");
});

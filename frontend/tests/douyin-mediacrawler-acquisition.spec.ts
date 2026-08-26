import { expect, test } from "@playwright/test";

const FIXTURE = "http://127.0.0.1:5391";

type FixtureAttempt =
  | {
      kind: "collection";
      runId: string | null;
      candidateId: string | null;
      limit: string | null;
    }
  | {
      kind: "create";
      runId: string;
      candidateIds: string[];
      candidateIdsShape: "string_array" | "invalid";
    };

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-08-25T09:30:00.000Z"));
  const response = await fetch(`${FIXTURE}/__fixture/reset`, { method: "POST" });
  expect(response.ok).toBe(true);
});

test("desktop Chrome wheel input scrolls the real Douyin workspace to performance content", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto("/#acquisition");
  await page.locator("#loginEmail").fill("admin@example.com");
  await page.locator("#loginPassword").fill("fixture-password");
  await page.getByRole("button", { name: "登录工作台" }).click();

  const workspace = page.getByRole("region", { name: "抖音自动获客工作台" });
  const performance = page.locator("#replicaAcquisitionPerformance");
  const shell = page.locator(".replica-shell");
  await expect(workspace).toBeVisible();
  await expect(performance).toBeVisible();
  const shellOverflow = await shell.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(shellOverflow.scrollHeight).toBeGreaterThan(shellOverflow.clientHeight);
  expect(await performance.evaluate((element) => (
    element.getBoundingClientRect().top > window.innerHeight
  ))).toBe(true);

  await page.mouse.move(900, 650);
  for (let step = 0; step < 8; step += 1) {
    await page.mouse.wheel(0, 600);
  }
  await expect.poll(() => shell.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const reach = await shell.evaluate((element) => {
    const target = document.querySelector<HTMLElement>("#replicaAcquisitionPerformance");
    if (!target) throw new Error("acquisition performance target not found");
    const shellRect = element.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    return {
      scrollTop: element.scrollTop,
      viewportBottom: element.scrollTop + element.clientHeight,
      targetBottom: element.scrollTop + targetRect.bottom - shellRect.top
    };
  });

  expect(reach.scrollTop).toBeGreaterThan(0);
  expect(reach.viewportBottom).toBeGreaterThanOrEqual(reach.targetBottom - 2);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

test("real session controls automatic Douyin acquisition, approval, receipts, and responsive access", async ({ page }) => {
  test.setTimeout(60_000);
  const consoleProblems: string[] = [];
  const unexpectedHttpErrors: string[] = [];
  const expectedConflicts: string[] = [];
  const genericDependencyRequests: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/acquisition/provider-connections" || path === "/api/v1/ai/connections") {
      genericDependencyRequests.push(path);
    }
  });
  page.on("console", (entry) => {
    if (["error", "warning"].includes(entry.type()) && !/status of 412/iu.test(entry.text())) {
      consoleProblems.push(`${entry.type()}: ${entry.text()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const item = `${response.status()}:${new URL(response.url()).pathname}`;
    if (response.status() === 412 && response.url().includes("/approve")) expectedConflicts.push(item);
    else unexpectedHttpErrors.push(item);
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#acquisition");
  await expect(page).toHaveTitle("GoodJob 自动营销系统");
  await expect(page.getByRole("region", { name: "Shensi 登录" })).toBeVisible();
  await page.locator("#loginEmail").fill("admin@example.com");
  await page.locator("#loginPassword").fill("fixture-password");
  await page.getByRole("button", { name: "登录工作台" }).click();

  const workspace = page.getByRole("region", { name: "抖音自动获客工作台" });
  await expect(workspace).toBeVisible();
  await expect(workspace.getByRole("heading", { name: "抖音自动获客" })).toBeVisible();
  await expect(workspace).toContainText("连接抖音账号");
  await expect(workspace).toContainText("尚未保存");
  await expect(workspace).toContainText("手工关键词无需搜索 API 或 AI 模型");
  await expect(page.getByRole("heading", { name: "公开搜索增强（可选）" })).toBeVisible();
  await expect(workspace).not.toContainText(/cookie|accountHandle|browserProfile|leaseToken|account-fixture|candidate-creator/iu);

  await expect(page.locator("#replicaNewTaskButtonLabel")).toHaveText("新建抖音采集计划");
  await page.locator("#replicaNewTaskButton").click();
  await expect(page.locator("#replicaRealTaskModal")).toBeHidden();
  await expect(workspace.getByLabel("计划名称")).toBeFocused();
  expect(genericDependencyRequests).toEqual([]);

  await workspace.getByRole("button", { name: "扫码连接" }).click();
  const qrDialog = page.getByRole("dialog", { name: "请使用抖音扫码" });
  await expect(qrDialog).toBeVisible();
  const qrImage = qrDialog.getByRole("img", { name: "抖音登录二维码" });
  await expect(qrImage).toBeVisible();
  await expect.poll(() => qrImage.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThanOrEqual(128);
  await expect.poll(() => qrImage.evaluate((image) => (image as HTMLImageElement).naturalHeight)).toBeGreaterThanOrEqual(128);
  await expect(page.getByText("测试模拟账号")).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: "关闭", exact: true }).click();

  await workspace.getByLabel("计划名称").fill("工业需求计划");
  await workspace.getByLabel("新关键词").fill("工业除尘改造");
  await workspace.getByLabel("每日候选人 建议 50").fill("50");
  await workspace.getByLabel("每日时间").fill("09:30");
  await expect(workspace.getByRole("button", { name: "保存并立即运行" })).toBeEnabled();
  await workspace.getByRole("button", { name: "保存并立即运行" }).click();
  await expect(workspace).toContainText("部分完成", { timeout: 8_000 });
  await expect(workspace).toContainText("当前计划：工业需求计划");
  await expect(workspace).toContainText("内容创作者");
  await expect(workspace).toContainText("需求评论者");
  await expect(workspace).toContainText("安全暂停原因：douyin_collection_partial");

  const firstCandidate = workspace.locator(".douyin-candidate-row").first();
  await firstCandidate.focus();
  await page.keyboard.press("Space");
  await expect(workspace).toContainText("已选 1 人");
  const secondCandidate = workspace.locator(".douyin-candidate-row").nth(1);
  await secondCandidate.focus();
  await page.keyboard.press("Space");
  await expect(workspace).toContainText("已选 2 人");
  await workspace.getByRole("button", { name: "生成待审批批次" }).click();

  const outreach = page.getByRole("region", { name: "批次审批与执行回执" });
  await expect(outreach).toContainText("今日剩余限额");
  const exactMessage = "您好，这是人工修订后的精确私信，可以为您整理能耗与交付对比。";
  await outreach.getByLabel("精确私信").first().fill(exactMessage);
  await outreach.getByRole("button", { name: "保存为新修订" }).click();
  await expect(outreach).toContainText("文案修订 2");
  await expect(outreach.getByLabel("精确私信").first()).toHaveValue(exactMessage);

  await outreach.getByLabel("我已逐条核对评论、私信与剩余限额").check();
  await outreach.getByRole("button", { name: "确认审批并排队" }).click();
  await expect(outreach).toContainText("修订冲突已刷新");
  await outreach.getByLabel("我已逐条核对评论、私信与剩余限额").check();
  await outreach.getByRole("button", { name: "确认审批并排队" }).click();
  await expect(outreach).toContainText("平台回执：DY-COMMENT-RECEIPT", { timeout: 10_000 });
  await expect(outreach).toContainText("平台回执：DY-MESSAGE-RECEIPT", { timeout: 10_000 });

  await outreach.getByRole("button", { name: "暂停批次" }).click();
  await expect(outreach.getByRole("button", { name: "恢复批次" })).toBeVisible();
  await outreach.getByRole("button", { name: "恢复批次" }).click();
  await expect(outreach.getByRole("button", { name: "暂停批次" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("region", { name: "投放批次审批与执行回执" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "批次审批与执行回执" })).toContainText("DY-MESSAGE-RECEIPT", { timeout: 10_000 });
  await expect(page.locator("body")).not.toContainText(/cookie|accountHandle|browserProfile|leaseToken|account-fixture|candidate-creator/iu);

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      const shell = document.querySelector<HTMLElement>(".replica-shell");
      if (shell) shell.scrollTop = 0;
    });
    await expect(workspace).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (viewport.width > 900) {
      const shell = page.locator(".replica-shell");
      const metrics = await shell.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight
      }));
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
      await shell.evaluate((element) => element.scrollTo(0, element.scrollHeight));
      await expect.poll(() => shell.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      const bottom = await shell.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollHeight: element.scrollHeight,
        scrollTop: element.scrollTop
      }));
      expect(bottom.scrollTop + bottom.clientHeight).toBeGreaterThanOrEqual(bottom.scrollHeight - 2);
      expect(await page.evaluate(() => ({
        rootScrollTop: document.scrollingElement?.scrollTop ?? -1,
        windowScrollY: window.scrollY
      }))).toEqual({ rootScrollTop: 0, windowScrollY: 0 });
    } else {
      const rootOverflow = await page.evaluate(() => ({
        innerHeight: window.innerHeight,
        scrollHeight: document.scrollingElement?.scrollHeight ?? 0
      }));
      expect(rootOverflow.scrollHeight).toBeGreaterThan(rootOverflow.innerHeight);
      await page.evaluate(() => window.scrollTo(0, document.scrollingElement?.scrollHeight ?? 0));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      const bottom = await page.evaluate(() => ({
        clientHeight: document.scrollingElement?.clientHeight ?? 0,
        rootScrollTop: document.scrollingElement?.scrollTop ?? 0,
        scrollHeight: document.scrollingElement?.scrollHeight ?? 0,
        shellScrollTop: document.querySelector<HTMLElement>(".replica-shell")?.scrollTop ?? -1,
        windowScrollY: window.scrollY
      }));
      expect(bottom.rootScrollTop + bottom.clientHeight).toBeGreaterThanOrEqual(bottom.scrollHeight - 2);
      expect(bottom.windowScrollY).toBeGreaterThan(0);
      expect(bottom.shellScrollTop).toBe(0);
    }
  }

  expect(expectedConflicts).toHaveLength(1);
  expect(genericDependencyRequests).toEqual([]);
  expect(unexpectedHttpErrors).toEqual([]);
  expect(consoleProblems).toEqual([]);
});

test("social conversations creates and recovers one exact-video outreach batch without external writes", async ({ page }) => {
  test.setTimeout(60_000);
  const browserOrigins = new Set<string>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.protocol === "http:" || url.protocol === "https:") {
      browserOrigins.add(url.origin);
    }
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#acquisition");
  await page.locator("#loginEmail").fill("admin@example.com");
  await page.locator("#loginPassword").fill("fixture-password");
  await page.getByRole("button", { name: "登录工作台" }).click();

  const acquisition = page.getByRole("region", { name: "抖音自动获客工作台" });
  await expect(acquisition).toBeVisible();
  await acquisition.getByRole("button", { name: "扫码连接" }).click();
  await expect(page.getByText("测试模拟账号")).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await acquisition.getByLabel("计划名称").fill("社媒对话外联计划");
  await acquisition.getByLabel("新关键词").fill("工厂除尘改造");
  await acquisition.getByRole("button", { name: "保存并立即运行" }).click();
  await expect(acquisition).toContainText("部分完成", { timeout: 8_000 });

  const overviewRead = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/acquisition/overview"
      && response.request().method() === "GET");
  const candidatesRead = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/acquisition/runs/run-fixture/candidates"
      && response.request().method() === "GET");
  const emptyCollectionRead = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/v1/acquisition/outreach-batches"
      && url.searchParams.get("runId") === "run-fixture"
      && url.searchParams.get("candidateId") === "candidate-creator"
      && url.searchParams.get("limit") === "1";
  });
  await page.getByRole("button", { name: "社媒对话", exact: true }).click();

  const overviewBody = await (await overviewRead).json() as {
    tasks: Array<{ latestRun: { id: string } | null }>;
  };
  expect(overviewBody.tasks[0]?.latestRun?.id).toBe("run-fixture");
  const candidatesBody = await (await candidatesRead).json() as {
    items: Array<{ id: string; evidence: { sourceUrl: string } }>;
  };
  expect(candidatesBody.items.map((candidate) => candidate.id)).toEqual([
    "candidate-creator",
    "candidate-commenter",
    "candidate-profile"
  ]);
  expect(candidatesBody.items[2]?.evidence.sourceUrl).toBe(
    "https://www.douyin.com/user/profile-only-fixture"
  );
  expect(await (await emptyCollectionRead).json()).toEqual({
    items: [],
    nextCursor: null
  });

  const conversations = page.getByRole("region", { name: "抖音公开互动" });
  await expect(conversations).toBeVisible();
  await expect(page.getByRole("heading", { name: "公开证据外联 · 非官方 inbox" })).toBeVisible();

  await conversations.getByRole("button", { name: /主页证据观察员/u }).click();
  await expect(conversations.getByRole("button", {
    name: "无法创建待审批批次"
  })).toBeDisabled();
  const profileState = await (await fetch(`${FIXTURE}/__fixture/state`)).json() as {
    createdCandidateIds: string[][];
  };
  expect(profileState.createdCandidateIds).toEqual([]);

  const exactCandidateCollection = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/v1/acquisition/outreach-batches"
      && url.searchParams.get("candidateId") === "candidate-creator";
  });
  await conversations.getByRole("button", { name: /节能设备观察员/u }).click();
  expect(await (await exactCandidateCollection).json()).toEqual({
    items: [],
    nextCursor: null
  });

  const createResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/acquisition/runs/run-fixture/outreach-batches"
      && response.request().method() === "POST");
  await conversations.getByRole("button", {
    name: "创建单候选待审批批次"
  }).click();
  const created = await createResponse;
  expect(created.request().postDataJSON()).toEqual({
    candidateIds: ["candidate-creator"]
  });
  const createdBody = await created.json() as {
    id: string;
    candidates: Array<{ candidateId: string }>;
  };
  expect(createdBody.id).toBe("batch-fixture");
  expect(createdBody.candidates.map((candidate) => candidate.candidateId)).toEqual([
    "candidate-creator"
  ]);

  const outreach = page.getByRole("region", { name: "批次审批与执行回执" });
  await expect(outreach.locator(".outreach-editor")).toHaveCount(1);
  const exactComment = "您好，看到您公开分享了工厂除尘改造，想与您核对能耗与交付需求。";
  const exactMessage = "您好，这是仅针对本次公开证据的人工修订私信。";
  await outreach.getByLabel("精确公开评论").fill(exactComment);
  await outreach.getByLabel("精确私信").fill(exactMessage);
  await outreach.getByRole("button", { name: "保存为新修订" }).click();
  await expect(outreach).toContainText("文案修订 2");
  await expect(outreach.getByLabel("精确公开评论")).toHaveValue(exactComment);
  await expect(outreach.getByLabel("精确私信")).toHaveValue(exactMessage);

  const finalReview = outreach.getByLabel("我已逐条核对评论、私信与剩余限额");
  const approveButton = outreach.getByRole("button", { name: "确认审批并排队" });
  await finalReview.check();
  await expect(finalReview).toBeChecked();
  await expect(approveButton).toBeEnabled();
  const staleApprovalResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname
      === "/api/v1/acquisition/outreach-batches/batch-fixture/approve"
      && response.request().method() === "POST");
  await approveButton.click();
  expect((await staleApprovalResponse).status()).toBe(412);
  await expect(outreach).toContainText("修订冲突已刷新");
  await expect(finalReview).not.toBeChecked();
  await expect(approveButton).toBeDisabled();

  const finalActionsResponse = page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname
      !== "/api/v1/acquisition/outreach-batches/batch-fixture/actions") return false;
    const body = await response.json().catch(() => null) as {
      items?: Array<{ status?: string }>;
    } | null;
    return body?.items?.length === 2
      && body.items.every((action) => action.status === "succeeded");
  });
  await finalReview.check();
  await expect(finalReview).toBeChecked();
  await expect(approveButton).toBeEnabled();
  const approvedResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname
      === "/api/v1/acquisition/outreach-batches/batch-fixture/approve"
      && response.request().method() === "POST");
  await approveButton.click();
  expect((await approvedResponse).status()).toBe(200);
  await expect(outreach).toContainText("平台回执：DY-COMMENT-RECEIPT", {
    timeout: 10_000
  });
  await expect(outreach).not.toContainText("平台回执：DY-MESSAGE-RECEIPT");
  const finalActions = await (await finalActionsResponse).json() as {
    items: Array<{
      kind: "comment" | "direct_message";
      sequence: number;
      predecessorActionId: string | null;
      occurredAt: string;
      platformReceiptReference: string;
    }>;
  };
  await expect(outreach).toContainText("平台回执：DY-MESSAGE-RECEIPT", {
    timeout: 10_000
  });
  const comment = finalActions.items.find((action) => action.kind === "comment");
  const directMessage = finalActions.items.find((action) =>
    action.kind === "direct_message");
  expect(comment?.sequence).toBe(1);
  expect(directMessage?.sequence).toBe(2);
  expect(directMessage?.predecessorActionId).toBe("action-comment");
  expect(Date.parse(directMessage?.occurredAt ?? "")
    - Date.parse(comment?.occurredAt ?? "")).toBeGreaterThanOrEqual(180_000);

  await page.evaluate(() => sessionStorage.clear());
  const recoveredOverview = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/acquisition/overview");
  const recoveredCandidates = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/v1/acquisition/runs/run-fixture/candidates");
  const recoveredCollection = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/v1/acquisition/outreach-batches"
      && url.searchParams.get("runId") === "run-fixture"
      && url.searchParams.get("candidateId") === "candidate-creator"
      && url.searchParams.get("limit") === "1";
  });
  const recoveredBatch = page.waitForResponse((response) =>
    new URL(response.url()).pathname
      === "/api/v1/acquisition/outreach-batches/batch-fixture"
      && response.request().method() === "GET");
  await page.reload();
  const [overviewAfterReload, candidatesAfterReload, collectionAfterReload, batchAfterReload]
    = await Promise.all([
      recoveredOverview,
      recoveredCandidates,
      recoveredCollection,
      recoveredBatch
    ]);
  expect((await overviewAfterReload.json() as { tasks: Array<{ latestRun: { id: string } | null }> })
    .tasks[0]?.latestRun?.id).toBe("run-fixture");
  expect((await candidatesAfterReload.json() as { items: Array<{ id: string }> })
    .items.some((candidate) => candidate.id === "candidate-creator")).toBe(true);
  const recoveredCollectionBody = await collectionAfterReload.json() as {
    items: Array<{ id: string; candidates: Array<{ candidateId: string }> }>;
  };
  expect(recoveredCollectionBody.items).toHaveLength(1);
  expect(recoveredCollectionBody.items[0]?.id).toBe("batch-fixture");
  expect(recoveredCollectionBody.items[0]?.candidates.map((candidate) =>
    candidate.candidateId)).toEqual(["candidate-creator"]);
  const recoveredBatchBody = await batchAfterReload.json() as {
    id: string;
    revision: number;
  };
  expect(recoveredBatchBody.id).toBe("batch-fixture");
  expect(recoveredBatchBody.revision).toBe(2);
  const recoveredOutreach = page.getByRole("region", {
    name: "批次审批与执行回执"
  });
  await expect(recoveredOutreach).toContainText(exactComment, { timeout: 10_000 });
  await expect(recoveredOutreach).toContainText(exactMessage);
  await expect(recoveredOutreach).toContainText("文案修订 2");
  await expect(recoveredOutreach).toContainText("平台回执：DY-COMMENT-RECEIPT");
  await expect(recoveredOutreach).toContainText("平台回执：DY-MESSAGE-RECEIPT");
  const fixtureState = await (await fetch(`${FIXTURE}/__fixture/state`)).json() as {
    createdCandidateIds: string[][];
    approvedCandidateIds: string[];
    attemptLedger: FixtureAttempt[];
    externalWriteCount: number;
  };
  expect(fixtureState.createdCandidateIds).toEqual([["candidate-creator"]]);
  expect(fixtureState.approvedCandidateIds).toEqual(["candidate-creator"]);
  expect(fixtureState.attemptLedger.filter((attempt) =>
    attempt.kind === "create")).toEqual([{
    kind: "create",
    runId: "run-fixture",
    candidateIds: ["candidate-creator"],
    candidateIdsShape: "string_array"
  }]);
  const collectionAttempts = fixtureState.attemptLedger.filter((attempt) =>
    attempt.kind === "collection");
  expect(collectionAttempts.length).toBeGreaterThan(0);
  expect(collectionAttempts.every((attempt) =>
    attempt.runId === "run-fixture"
      && attempt.candidateId === "candidate-creator"
      && attempt.limit === "1")).toBe(true);
  expect(fixtureState.attemptLedger.some((attempt) =>
    attempt.kind === "collection"
      ? attempt.candidateId === "candidate-profile"
      : attempt.candidateIds.includes("candidate-profile"))).toBe(false);
  expect(fixtureState.externalWriteCount).toBe(0);
  expect([...browserOrigins]).toEqual(["http://127.0.0.1:5388"]);
});

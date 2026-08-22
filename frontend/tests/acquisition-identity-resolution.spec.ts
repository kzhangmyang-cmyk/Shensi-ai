import { expect, test, type Page, type Route } from "@playwright/test";

const NOW = "2026-08-09T08:00:00.000Z";

type JsonRecord = Record<string, unknown>;

interface Scenario {
  candidateId: string;
  candidate(read: number): JsonRecord;
  identity(read: number): JsonRecord;
  intelligence(read: number): JsonRecord | null;
  qualification?(read: number): JsonRecord | null;
  financial?(read: number): JsonRecord | null;
  battleCard?(read: number): JsonRecord | null;
  onRetry?(route: Route): Promise<JsonRecord> | JsonRecord;
}

function identityOperation(
  candidateId: string,
  overrides: JsonRecord = {}
): JsonRecord {
  return {
    id: "identity-operation-1",
    candidateId,
    candidateVersion: 1,
    status: "running",
    currentStage: "independent_search",
    outcome: null,
    retryable: false,
    canonicalProfileUrl: null,
    profileCandidates: [{
      publicProfileUrl: "https://www.douyin.com/user/example",
      evidenceIds: ["identity-public-page", "identity-search-result"]
    }],
    evidence: [{
      evidenceId: "identity-public-page",
      evidenceClass: "douyin_public_page",
      publicProfileUrl: "https://www.douyin.com/user/example",
      sourceUrl: "https://www.douyin.com/user/example",
      sourceFingerprint: "sha256:identity-public-page",
      accessStatus: "public_content",
      fetchedAt: NOW
    }, {
      evidenceId: "identity-search-result",
      evidenceClass: "independent_search_result",
      publicProfileUrl: "https://www.douyin.com/user/example",
      sourceUrl: "https://www.baidu.com/s?wd=douyin",
      sourceFingerprint: "sha256:identity-search-result",
      accessStatus: "indexed_summary",
      fetchedAt: NOW
    }],
    intelligenceOperationId: null,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides
  };
}

function intelligenceOperation(
  candidateId: string,
  overrides: JsonRecord = {}
): JsonRecord {
  return {
    id: "intelligence-operation-1",
    candidateId,
    status: "queued",
    currentStage: null,
    completedStages: [],
    skippedStages: [],
    research: null,
    qualification: null,
    battleCardId: null,
    failure: null,
    createdAt: NOW,
    startedAt: null,
    updatedAt: NOW,
    completedAt: null,
    failedAt: null,
    ...overrides
  };
}

function unresolvedCandidate(candidateId: string, resolved = false): JsonRecord {
  return {
    id: candidateId,
    subjectKind: "individual",
    publicActorKey: resolved
      ? "public:douyin:sha256:resolved"
      : "unresolved-public-signal:douyin:sha256:unresolved",
    publicDisplayName: "抖音公开线索",
    publicProfileUrl: resolved
      ? "https://www.douyin.com/user/example"
      : "https://www.douyin.com/video/741234567890",
    sourcePlatform: "douyin",
    status: "normalized",
    version: resolved ? 2 : 1,
    identityResolved: resolved,
    latestDecisionVersion: resolved ? "qualification-v1" : null,
    approvedDecisionVersion: null,
    createdAt: NOW,
    updatedAt: NOW
  };
}

function qualification(candidateId: string): JsonRecord {
  return {
    id: "qualification-1",
    candidateId,
    decisionVersion: "qualification-v1",
    decisionEngine: "model",
    grade: "A",
    score: 88,
    recommendedAction: "priority_review",
    evidence: [{ evidenceId: "identity-search-result", excerpt: "公开表达采购需求" }],
    positiveSignals: [{ name: "明确采购需求", score: 35 }],
    negativeSignals: [],
    reasons: ["公开内容出现明确采购与比选信号"],
    confidence: 0.92,
    ruleVersion: "qualification-rules-v1",
    promptVersion: "qualification-prompt-v1",
    modelProvider: "zhipu",
    model: "glm-5.2",
    hardGateFailures: [],
    createdAt: NOW
  };
}

function financialValue(candidateId: string): JsonRecord {
  return {
    id: "financial-1",
    candidateId,
    qualificationDecisionId: "qualification-1",
    version: "financial-v1",
    grade: "A",
    score: 84,
    currency: "CNY",
    expectedRevenueMinor: 6800000,
    expectedGrossProfitMinor: 3600000,
    expectedContributionMinor: 2800000,
    factors: {
      profitability: 84,
      cashFlow: 79,
      creditQuality: 82,
      repeatPotential: 76,
      referralPotential: 71,
      closeProbability: 73
    },
    createdAt: NOW
  };
}

function battleCard(candidateId: string): JsonRecord {
  return {
    id: "battle-card-1",
    candidateId,
    qualificationDecisionId: "qualification-1",
    partyType: "individual",
    evidenceIds: ["identity-public-page", "identity-search-result"],
    confidence: 0.9,
    modelProvider: "zhipu",
    model: "glm-5.2",
    promptVersion: "battle-card-prompt-v1",
    schemaVersion: "battle-card.v1",
    sections: [{
      label: "推荐切入点",
      kind: "inference",
      content: "先用诊断式开场确认目标客户和预算。",
      evidenceIds: ["identity-search-result"],
      confidence: 0.88
    }],
    intelligence: null,
    createdAt: NOW
  };
}

async function installScenario(page: Page, scenario: Scenario) {
  const reads = {
    candidate: 0,
    identity: 0,
    intelligence: 0,
    qualification: 0,
    financial: 0,
    battleCard: 0
  };
  const retryRequests: Array<{
    body: unknown;
    csrf: string | undefined;
    idempotencyKey: string | undefined;
  }> = [];

  await page.addInitScript(() => {
    document.cookie = "gj_csrf=e2e-csrf; path=/";
    localStorage.setItem("gj_user", JSON.stringify({
      id: "demo-admin",
      name: "Admin",
      email: "admin@goodjob.com",
      role: "admin",
      teamId: "demo-team",
      avatar: "AD"
    }));
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const base = `/api/v1/acquisition/candidates/${scenario.candidateId}`;
    const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers,
        body: JSON.stringify(value)
      });
    const nullable = (value: JsonRecord | null) => value === null
      ? json({
          code: "resource_not_found",
          message: "资源不存在",
          details: null,
          requestId: "identity-e2e",
          retryable: false
        }, 404)
      : json(value);

    if (path === "/api/v1/acquisition/overview") {
      return void await json({
        generatedAt: NOW,
        platform: "douyin",
        totals: { tasks: 0 },
        statusCounts: {},
        discoveryMethodCounts: {},
        tasks: []
      });
    }
    if (path === base && request.method() === "GET") {
      reads.candidate += 1;
      return void await json(scenario.candidate(reads.candidate), 200, {
        ETag: `"candidate-v${reads.candidate}"`
      });
    }
    if (path === `${base}/evidence`) {
      return void await json({ items: [], nextCursor: null });
    }
    if (path === `${base}/qualification`) {
      reads.qualification += 1;
      return void await nullable(scenario.qualification?.(reads.qualification) ?? null);
    }
    if (path === `${base}/financial-value`) {
      reads.financial += 1;
      return void await nullable(scenario.financial?.(reads.financial) ?? null);
    }
    if (path === `${base}/battle-card`) {
      reads.battleCard += 1;
      return void await nullable(scenario.battleCard?.(reads.battleCard) ?? null);
    }
    if (path === `${base}/reviews`) {
      return void await json({ items: [], nextCursor: null });
    }
    if (path === `${base}/douyin-identity-resolution-operation`) {
      reads.identity += 1;
      return void await json(scenario.identity(reads.identity));
    }
    if (path === `${base}/intelligence-operation`) {
      reads.intelligence += 1;
      return void await nullable(scenario.intelligence(reads.intelligence));
    }
    if (path === `${base}/douyin-identity-resolution-operations`
      && request.method() === "POST") {
      retryRequests.push({
        body: request.postDataJSON(),
        csrf: request.headers()["x-csrf-token"],
        idempotencyKey: request.headers()["idempotency-key"]
      });
      return void await json(await scenario.onRetry?.(route) ?? identityOperation(
        scenario.candidateId,
        { id: "identity-operation-retry", status: "running", currentStage: "public_page" }
      ), 202);
    }
    if (path === `${base}/private-domain-handoff`) {
      return void await nullable(null);
    }
    if (path === "/api/dashboard/summary") {
      return void await json({ message: "E2E skips legacy dashboard" }, 503);
    }
    return void await json({
      code: "resource_not_found",
      message: "测试路由未配置",
      details: { path },
      requestId: "identity-e2e",
      retryable: false
    }, 404);
  });

  return { reads, retryRequests };
}

async function openCandidate(page: Page, candidateId: string) {
  await page.goto("/#acquisition");
  await expect(page.locator("body")).toHaveClass(/is-authenticated/);
  await page.evaluate((id) => {
    document.dispatchEvent(new CustomEvent("goodjob:acquisition-mode-changed", {
      detail: { mode: "real" }
    }));
    document.dispatchEvent(new CustomEvent(
      "goodjob:acquisition-detail-open-requested",
      { detail: { mode: "candidates", candidateId: id } }
    ));
  }, candidateId);
  const dialog = page.locator("#replicaAcquisitionDetailCenter");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("automatic Douyin identity progresses into AI decisions and stops polling", async ({ page }) => {
  await page.clock.install({ time: new Date(NOW) });
  const candidateId = "candidate-identity-success";
  const scenario = await installScenario(page, {
    candidateId,
    candidate: (read) => unresolvedCandidate(candidateId, read >= 2),
    identity: (read) => read === 1
      ? identityOperation(candidateId)
      : identityOperation(candidateId, {
          status: "succeeded",
          currentStage: null,
          outcome: "verified_consensus",
          canonicalProfileUrl: "https://www.douyin.com/user/example",
          intelligenceOperationId: "intelligence-operation-1",
          completedAt: NOW
        }),
    intelligence: (read) => read === 1
      ? null
      : read === 2
        ? intelligenceOperation(candidateId, { status: "running", currentStage: "qualification" })
        : intelligenceOperation(candidateId, {
            status: "succeeded",
            currentStage: null,
            completedStages: ["research", "qualification", "battle_card"],
            battleCardId: "battle-card-1",
            completedAt: NOW
          }),
    qualification: (read) => read >= 3 ? qualification(candidateId) : null,
    financial: (read) => read >= 3 ? financialValue(candidateId) : null,
    battleCard: (read) => read >= 3 ? battleCard(candidateId) : null
  });

  const dialog = await openCandidate(page, candidateId);
  await expect(dialog).toContainText("正在自动核验");

  await page.clock.fastForward(3_000);
  await expect(dialog).toContainText("已自动确认，正在进行 AI 研判");

  await page.clock.fastForward(3_000);
  await expect(dialog).toContainText("意向等级 A");
  await expect(dialog).toContainText("财务等级 A");
  await expect(dialog).toContainText("客户作战建议");
  await expect(dialog).toContainText("先用诊断式开场确认目标客户和预算");

  const terminalIdentityReads = scenario.reads.identity;
  await page.clock.fastForward(30_000);
  expect(scenario.reads.identity).toBe(terminalIdentityReads);
});

test("provider failure retries only through the authoritative server operation", async ({ page }) => {
  const candidateId = "candidate-identity-retry";
  let retried = false;
  const scenario = await installScenario(page, {
    candidateId,
    candidate: () => unresolvedCandidate(candidateId),
    identity: () => retried
      ? identityOperation(candidateId, {
          id: "identity-operation-retry",
          status: "running",
          currentStage: "public_page"
        })
      : identityOperation(candidateId, {
          status: "failed",
          currentStage: null,
          outcome: "provider_unavailable",
          retryable: true,
          completedAt: NOW
        }),
    intelligence: () => null,
    onRetry: () => {
      retried = true;
      return identityOperation(candidateId, {
        id: "identity-operation-retry",
        status: "running",
        currentStage: "public_page"
      });
    }
  });

  const dialog = await openCandidate(page, candidateId);
  await expect(dialog).toContainText("自动核验暂时失败，可重试");
  await dialog.locator('[data-acquisition-detail-action="retry-identity-resolution"]').click();
  await expect(dialog).toContainText("正在自动核验");

  expect(scenario.retryRequests).toHaveLength(1);
  expect(scenario.retryRequests[0]?.body).toEqual({});
  expect(scenario.retryRequests[0]?.csrf).toBe("e2e-csrf");
  expect(scenario.retryRequests[0]?.idempotencyKey).toBeTruthy();
});

test("ambiguous identities preserve the manual fallback without unsafe prefill", async ({ page }) => {
  const candidateId = "candidate-identity-ambiguous";
  await installScenario(page, {
    candidateId,
    candidate: () => unresolvedCandidate(candidateId),
    identity: () => identityOperation(candidateId, {
      status: "requires_review",
      currentStage: null,
      outcome: "ambiguous",
      retryable: false,
      canonicalProfileUrl: null,
      profileCandidates: [{
        publicProfileUrl: "https://www.douyin.com/user/a",
        evidenceIds: ["identity-public-page"]
      }, {
        publicProfileUrl: "https://www.douyin.com/user/b",
        evidenceIds: ["identity-search-result"]
      }],
      completedAt: NOW
    }),
    intelligence: () => null
  });

  const dialog = await openCandidate(page, candidateId);
  await expect(dialog).toContainText("证据不足，需要人工确认");
  const form = dialog.locator('[data-acquisition-detail-form="identity-verification"]');
  await expect(form).toBeVisible();
  await expect(form.locator('input[name="identityProfileUrl"]')).toHaveValue("");
  await expect(form).not.toContainText("https://www.douyin.com/video/741234567890");
});

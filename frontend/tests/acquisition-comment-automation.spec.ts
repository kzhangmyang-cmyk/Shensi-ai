import { expect, test, type Page } from "@playwright/test";
import type {
  AcquisitionRunPresentation,
  CandidateEvidence,
  CandidateQualification,
  CursorPage,
  IndividualCandidate,
  RunCandidatePresentationEvent
} from "../src/acquisition/detail-center-api";
import type { AcquisitionTaskDetail } from "../src/acquisition/runtime-api";
import type {
  AcquisitionTaskLatestRun,
  AcquisitionTaskOverview,
  AcquisitionTaskSummary
} from "../src/acquisition/runtime-model";

const NOW = "2026-08-15T08:00:00.000Z";
const PLAN_ID = "plan-public-comment-automation";
const RUN_ID = "run-public-comment-automation";
const CANDIDATE_ID = "candidate-public-comment";
const EVIDENCE_ID = "evidence-public-comment-original";
const SOURCE_URL = `https://www.douyin.com/video/7480000000000000000/${Array.from({ length: 80 }, () => "source").join("/")}`;
const ORIGINAL_COMMENT = `我们正在比较获客系统，预算和交付周期都想了解。连续不可断公开评论标记-${"x".repeat(360)}`;

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "laptop", width: 1024, height: 768 },
  { name: "tablet", width: 768, height: 900 }
];

type RunRevision = "queued" | "running" | "partial_success";

type RecordedRequest = {
  method: string;
  origin: string;
  path: string;
  body: string | null;
};

type AutomationStepStatus = "pending" | "running" | "succeeded" | "partial_success" | "failed" | "skipped";
type AutomationStep = Omit<NonNullable<AcquisitionRunPresentation["automationSteps"]>[number], "status"> & {
  status: AutomationStepStatus;
};
type TaskRunSnapshot = AcquisitionTaskLatestRun & NonNullable<AcquisitionTaskDetail["latestRun"]>;
type TaskSnapshot = Omit<AcquisitionTaskDetail, "task" | "latestRun" | "presentation"> & {
  task: AcquisitionTaskSummary & { latestRun: TaskRunSnapshot };
  latestRun: TaskRunSnapshot;
  presentation: NonNullable<AcquisitionTaskDetail["presentation"]>;
};
type RevisionFixture = { task: TaskSnapshot; presentation: AcquisitionRunPresentation };
type PresentedCandidateEvidence = CandidateEvidence & { sourceUrl: string; content: string };

function toRecord(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value));
}

function budget() {
  return { requests: 3, results: 5, amountMinor: 120, durationSeconds: 9 };
}

function automationSteps(revision: RunRevision): AutomationStep[] {
  const statuses: AutomationStepStatus[] = revision === "queued"
    ? ["pending", "pending", "pending", "pending", "pending", "pending", "pending"]
    : revision === "running"
      ? ["succeeded", "succeeded", "running", "pending", "pending", "pending", "pending"]
      : ["succeeded", "succeeded", "partial_success", "partial_success", "partial_success", "partial_success", "succeeded"];
  const ids = [
    "discover_video_urls",
    "resolve_video_ids",
    "fetch_public_comment_samples",
    "normalize_platform_events",
    "aggregate_actor_signals",
    "qualify_candidates",
    "refresh_run_presentation"
  ];
  return ids.map((id, index) => ({
    id,
    status: statuses[index],
    startedAt: revision === "queued" ? null : NOW,
    completedAt: revision === "partial_success" || (revision === "running" && index < 2) ? NOW : null,
    durationMs: revision === "queued" ? null : index < 2 ? 1000 : null,
    processedCount: revision === "queued" ? 0 : index < 2 ? 3 : index === 2 ? 1 : 0,
    errorCode: revision === "partial_success"
      ? index === 2 ? "access_restricted" : index === 3 ? "rate_limited" : null
      : null,
    message: revision === "queued"
      ? "等待服务端开始"
      : revision === "running" && index === 2
        ? "已读取第一条一级公开评论"
        : revision === "partial_success"
          ? "服务端已保留可用公开样本"
          : "服务端步骤完成"
  }));
}

function summary(revision: RunRevision) {
  return {
    sourcesSearched: revision === "queued" ? 0 : 1,
    pagesAnalyzed: revision === "queued" ? 0 : 3,
    organizationsFound: 0,
    dedupedCandidates: revision === "queued" ? 0 : 1,
    validOpportunities: revision === "queued" ? 0 : 1,
    highIntent: 0,
    financialEvaluatedHighIntentCount: 0,
    financialPendingHighIntentCount: 0,
    expectedRevenueByCurrency: [],
    discoveredVideos: revision === "queued" ? 0 : 3,
    commentsSampled: revision === "queued" ? 0 : 1,
    validDemandSignals: revision === "queued" ? 0 : 1,
    unresolvedActors: revision === "queued" ? 0 : 1,
    highPotentialSignals: revision === "queued" ? 0 : 1
  };
}

function candidateEvent(): RunCandidatePresentationEvent {
  return {
    eventId: "candidate-event-public-comment",
    createdAt: NOW,
    candidateId: CANDIDATE_ID,
    candidate: {
      id: CANDIDATE_ID,
      subjectKind: "individual",
      displayName: "公开评论用户",
      industry: null,
      region: "福建",
      domain: null,
      status: "pending_review",
      version: 1,
      identityResolved: false,
      updatedAt: NOW
    },
    qualification: {
      id: "qualification-public-comment",
      candidateId: CANDIDATE_ID,
      decisionVersion: "qualification-v1",
      decisionEngine: "rules",
      grade: "B",
      score: 72,
      recommendedAction: "priority_review",
      evidence: [{ evidenceId: EVIDENCE_ID, excerpt: ORIGINAL_COMMENT }],
      positiveSignals: [{ name: "明确咨询获客方案", score: 20 }],
      negativeSignals: [],
      reasons: ["原始评论表达了明确的方案比较意愿"],
      confidence: 0.81,
      ruleVersion: "qualification-rules-v1",
      promptVersion: null,
      modelProvider: null,
      model: null,
      hardGateFailures: ["identity_unresolved"],
      createdAt: NOW
    },
    financialValue: null,
    sourcePlatforms: ["douyin"],
    evidenceCount: 1
  } satisfies RunCandidatePresentationEvent;
}

function taskRevision(revision: RunRevision): RevisionFixture {
  const terminal = revision === "partial_success";
  const run = {
    id: RUN_ID,
    status: revision,
    updatedAt: NOW,
    completedAt: terminal ? NOW : null,
    evidenceCount: revision === "queued" ? 0 : 1,
    consumedBudget: budget(),
    etag: `\"${RUN_ID}:${revision}\"`,
    planVersion: 1,
    revision: revision === "queued" ? 1 : revision === "running" ? 2 : 3,
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 10,
      maxResults: 30,
      maxAmountMinor: 500,
      maxDurationSeconds: 120
    },
    modelSnapshotRef: {}
  } satisfies TaskRunSnapshot;
  const presentation = {
    run: {
      id: RUN_ID,
      status: revision,
      etag: run.etag,
      updatedAt: NOW,
      completedAt: run.completedAt
    },
    providers: [],
    summary: summary(revision),
    automationSteps: automationSteps(revision),
    commentSignals: revision === "queued" ? [] : [{
      eventId: "comment-event-public-comment",
      candidateId: CANDIDATE_ID,
      displayName: "公开评论用户",
      handle: "@public-commenter",
      text: ORIGINAL_COMMENT,
      occurredAt: NOW,
      likeCount: 2,
      replyCount: 0,
      ipLabel: "福建",
      sourceUrl: SOURCE_URL,
      intentBand: "strong_signal",
      reasons: ["明确咨询预算和交付周期"],
      confidence: 0.81,
      identityStatus: "needs_research",
      evidenceId: EVIDENCE_ID
    }],
    candidateEvents: revision === "queued" ? [] : [candidateEvent()],
    nextAfter: "",
    hasMore: false
  } satisfies AcquisitionRunPresentation;
  const task = {
    task: {
      id: "task-public-comment-automation",
      planId: PLAN_ID,
      name: "抖音公开评论样本",
      objective: "从一级公开评论中识别需要人工核验的获客线索",
      platform: "douyin",
      discoveryMethods: ["public_search"],
      planStatus: "approved",
      latestRun: run,
      updatedAt: NOW
    },
    plan: {
      id: PLAN_ID,
      status: "approved",
      version: 1,
      payload: {
        targetPlatform: "douyin",
        name: "抖音公开评论样本",
        objective: "从一级公开评论中识别需要人工核验的获客线索",
        icp: { industries: ["企业服务"], regions: ["福建"] },
        operations: [],
        providerConnections: [],
        budgetSnapshot: run.budgetSnapshot,
        modelSnapshotRef: {},
        stopConditions: { stopWhenBudgetExhausted: true, stopWhenNoMoreResults: true }
      }
    },
    latestRun: run,
    shards: [],
    presentation: {
      ...presentation,
      providers: presentation.providers.map(toRecord),
      automationSteps: presentation.automationSteps?.map(toRecord),
      commentSignals: presentation.commentSignals?.map(toRecord),
      candidateEvents: presentation.candidateEvents.map(toRecord),
      summary: toRecord(presentation.summary)
    }
  } satisfies TaskSnapshot;
  return { task, presentation };
}

function candidate(): IndividualCandidate {
  return {
    id: CANDIDATE_ID,
    subjectKind: "individual",
    publicActorKey: "unresolved-public-signal:douyin:sha256:public-comment",
    publicDisplayName: "公开评论用户",
    publicProfileUrl: SOURCE_URL,
    sourcePlatform: "douyin",
    demandCategory: "获客系统采购",
    demandSummary: ORIGINAL_COMMENT,
    locationHint: "福建",
    buyingStage: "comparison",
    negativeSignals: [],
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    evidenceIds: [EVIDENCE_ID],
    status: "pending_review",
    version: 1,
    identityResolved: false,
    latestDecisionVersion: "qualification-v1",
    approvedDecisionVersion: null,
    updatedAt: NOW
  } satisfies IndividualCandidate;
}

function qualification(): CandidateQualification {
  const value = candidateEvent().qualification;
  if (value === null) throw new Error("comment fixture requires a qualification decision");
  return value;
}

function candidateEvidence(): PresentedCandidateEvidence {
  return {
    id: EVIDENCE_ID,
    targetType: "individual_signal",
    sourcePlatform: "douyin",
    sourceTitle: "抖音一级公开评论",
    sourceSnippet: ORIGINAL_COMMENT,
    sourceUrl: SOURCE_URL,
    publishedAt: NOW,
    fetchedAt: NOW,
    locale: "zh-CN",
    rawArtifactHash: "sha256:public-comment-raw",
    contentHash: "sha256:public-comment-content",
    provenance: {
      kind: "search_result",
      provider: "douyin-public-comments",
      providerConnectionId: "experimental_public_sample",
      requestId: "public-comment-read-1",
      providerRecordId: "comment-record-1",
      queryText: "企业服务 获客",
      sourceUrl: SOURCE_URL,
      resultRank: 1,
      sourceType: "public_comment"
    },
    accessStatus: "public_content",
    content: ORIGINAL_COMMENT
  } satisfies PresentedCandidateEvidence;
}

async function installFixture(page: Page) {
  let committed: RunRevision = "queued";
  const requests: RecordedRequest[] = [];
  const undeclaredAcquisitionGets: string[] = [];
  const servedPlanIds: string[] = [];
  const servedRunIds: string[] = [];
  const revisions = {
    queued: taskRevision("queued"),
    running: taskRevision("running"),
    partial_success: taskRevision("partial_success")
  } as const;

  await page.addInitScript(() => {
    document.cookie = "gj_csrf=e2e-comment-csrf; path=/";
    localStorage.setItem("gj_user", JSON.stringify({
      id: "e2e-comment-owner",
      name: "Comment Owner",
      email: "comment-owner@goodjob.test",
      role: "admin",
      teamId: "team-e2e",
      avatar: "CO"
    }));
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    requests.push({
      method: request.method(),
      origin: url.origin,
      path: url.pathname,
      body: request.postData()
    });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body)
    });
    const path = url.pathname;
    const candidateBase = `/api/v1/acquisition/candidates/${CANDIDATE_ID}`;

    if (request.method() !== "GET") {
      return void await json({ code: "read_only_fixture", message: "E2E fixture only permits reads" }, 501);
    }
    if (path === "/api/v1/acquisition/overview") {
      const overview = {
        generatedAt: NOW,
        platform: "douyin",
        totals: { tasks: 1 },
        statusCounts: { [committed]: 1 },
        discoveryMethodCounts: { public_search: 1 },
        tasks: [revisions[committed].task.task]
      } satisfies AcquisitionTaskOverview;
      return void await json(overview);
    }
    if (path === "/api/v1/acquisition/performance") return void await json({});
    if (path === `/api/v1/acquisition/tasks/${PLAN_ID}`) {
      servedPlanIds.push(String(revisions[committed].task.plan.id));
      servedRunIds.push(revisions[committed].task.latestRun.id);
      return void await json(revisions[committed].task);
    }
    if (path === `/api/v1/acquisition/runs/${RUN_ID}/presentation`) {
      return void await json(revisions[committed].presentation);
    }
    if (path === candidateBase) return void await json(candidate());
    if (path === `${candidateBase}/evidence`) {
      const evidence = {
        items: [candidateEvidence()],
        nextCursor: null
      } satisfies CursorPage<PresentedCandidateEvidence>;
      return void await json(evidence);
    }
    if (path === `${candidateBase}/qualification`) return void await json(qualification());
    if (path === `${candidateBase}/financial-value`) return void await json({ code: "not_found" }, 404);
    if (path === `${candidateBase}/battle-card`) return void await json({ code: "not_found" }, 404);
    if (path === `${candidateBase}/reviews`) return void await json({ items: [], nextCursor: null });
    if (path === `${candidateBase}/douyin-identity-resolution-operation`) {
      return void await json({
        id: "identity-public-comment",
        candidateId: CANDIDATE_ID,
        candidateVersion: 1,
        status: "requires_review",
        currentStage: null,
        outcome: "insufficient_evidence",
        retryable: false,
        canonicalProfileUrl: null,
        profileCandidates: [],
        evidence: [],
        intelligenceOperationId: null,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: NOW
      });
    }
    if (path === `${candidateBase}/intelligence-operation`) return void await json({ code: "not_found" }, 404);
    if (path === `${candidateBase}/private-domain-handoff`) return void await json({ code: "not_found" }, 404);
    undeclaredAcquisitionGets.push(`${path}${url.search}`);
    return void await json({ code: "unconfigured_acquisition_api", message: `No fixture for ${path}` }, 501);
  });

  return {
    commit(revision: RunRevision) {
      committed = revision;
    },
    requests,
    undeclaredAcquisitionGets,
    servedPlanIds,
    servedRunIds,
    taskRequestCount() {
      return requests.filter((request) => request.path === `/api/v1/acquisition/tasks/${PLAN_ID}`).length;
    }
  };
}

async function openPlan(page: Page, options: { navigate?: boolean } = {}) {
  if (options.navigate !== false) await page.goto("/#acquisition", { waitUntil: "load" });
  await expect(page.locator("body")).toHaveClass(/is-authenticated/);
  await page.evaluate((planId) => {
    document.dispatchEvent(new CustomEvent("goodjob:acquisition-mode-changed", {
      detail: { mode: "real" }
    }));
    document.dispatchEvent(new CustomEvent("goodjob:acquisition-detail-open-requested", {
      detail: { mode: "plan", planId }
    }));
  }, PLAN_ID);
  await expect(page.locator("#replicaAcquisitionDetailCenter")).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const detail = document.querySelector("#replicaAcquisitionDetailCenter");
    const automation = document.querySelector(".replica-acquisition-comment-automation");
    const steps = document.querySelector(".replica-acquisition-automation-steps");
    const comment = document.querySelector(".replica-acquisition-comment-signal");
    const commentCopy = document.querySelector(".replica-acquisition-comment-copy");
    const inspector = document.querySelector(".replica-acquisition-candidate-inspector");
    const evidenceList = document.querySelector(".replica-acquisition-evidence-list");
    const checks = [
      document.documentElement,
      document.body,
      detail,
      automation,
      steps,
      comment,
      commentCopy,
      inspector,
      evidenceList
    ]
      .filter((element): element is HTMLElement => element instanceof HTMLElement)
      .map((element) => ({
        selector: element.id ? `#${element.id}` : element.className,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth
      }));
    return checks.filter(({ scrollWidth, clientWidth }) => scrollWidth > clientWidth + 1);
  });
  expect(overflow).toEqual([]);
}

for (const viewport of viewports) {
  test(`public comment automation is read-only, persistent, and responsive at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(30_000);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.clock.install({ time: new Date(NOW) });
    const fixture = await installFixture(page);

    await openPlan(page);
    const detail = page.locator("#replicaAcquisitionDetailCenter");
    const automation = detail.getByLabel("公开评论自动化进程");
    await expect(detail).toContainText("排队中");
    await expect(automation.locator("[data-automation-step-id]")).toHaveCount(7);
    await expect(automation.getByLabel("公开评论计数带").locator("span")).toHaveCount(5);

    fixture.commit("running");
    await page.clock.fastForward(3_000);
    await expect(detail).toContainText("运行中");
    await expect(automation).toContainText("已读取第一条一级公开评论");
    await expect(automation).toContainText(ORIGINAL_COMMENT);
    await expect(automation).toContainText("身份待核验");
    await expectNoHorizontalOverflow(page);

    fixture.commit("partial_success");
    await page.clock.fastForward(3_000);
    await expect(detail).toContainText("部分完成");
    await expect(automation).toContainText("访问受限，已保留可用公开样本");
    await expect(automation).toContainText("访问或频率受限，已保留可用公开样本");
    await expect(automation).toContainText(ORIGINAL_COMMENT);
    expect(ORIGINAL_COMMENT.length).toBeGreaterThan(300);
    const terminalTaskRequests = fixture.taskRequestCount();
    await page.clock.fastForward(30_000);
    expect(fixture.taskRequestCount()).toBe(terminalTaskRequests);

    const commentButton = automation.locator("[data-acquisition-detail-action='select-candidate']");
    await expect(commentButton).toBeVisible();
    await expect(commentButton).toContainText(ORIGINAL_COMMENT);
    await expect(commentButton).toContainText(SOURCE_URL);
    await commentButton.focus();
    await expect(commentButton).toBeFocused();
    await commentButton.press("Enter");
    const inspector = detail.locator(".replica-acquisition-candidate-inspector");
    await expect(inspector).toContainText(EVIDENCE_ID);
    await expect(inspector).toContainText(ORIGINAL_COMMENT);
    await expect(inspector).toContainText(SOURCE_URL);
    await expect(inspector).toContainText("主体身份尚未确认");
    await expectNoHorizontalOverflow(page);

    await page.reload({ waitUntil: "load" });
    await expect(page.locator("body")).toHaveClass(/is-authenticated/);
    await openPlan(page, { navigate: false });
    await expect(detail).toContainText("抖音公开评论样本");
    await expect(detail).toContainText("部分完成");
    await expect(detail.getByLabel("公开评论自动化进程")).toContainText(ORIGINAL_COMMENT);
    expect(fixture.servedPlanIds).toEqual(expect.arrayContaining([PLAN_ID]));
    expect(fixture.servedRunIds).toEqual(expect.arrayContaining([RUN_ID]));
    expect(new Set(fixture.servedPlanIds)).toEqual(new Set([PLAN_ID]));
    expect(new Set(fixture.servedRunIds)).toEqual(new Set([RUN_ID]));
    await expectNoHorizontalOverflow(page);

    const writes = fixture.requests.filter((request) => !["GET", "HEAD", "OPTIONS"].includes(request.method));
    expect(writes).toEqual([]);
    const prohibitedWrites = fixture.requests.filter((request) =>
      !["GET", "HEAD", "OPTIONS"].includes(request.method)
      && /(?:comment|reply|dm|message|friend|follow|broadcast|bulk|mass|crm|customer|lead|deal|handoff)/i.test(request.path)
    );
    expect(prohibitedWrites).toEqual([]);
    expect(fixture.undeclaredAcquisitionGets).toEqual([]);
    const externalDouyin = fixture.requests.filter((request) => /(?:^|\.)douyin\.com$|(?:^|\.)iesdouyin\.com$/i.test(new URL(request.origin).hostname));
    expect(externalDouyin).toEqual([]);
  });
}

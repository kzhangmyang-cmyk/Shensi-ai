import { expect, test, type Page, type Request } from "@playwright/test";
import type {
  VisualObservationSubmission,
  VisualReaderSession,
  VisualReaderUsage
} from "../src/acquisition/visual-reader-api";
import {
  installVisualReaderExtensionHarness,
  type VisualReaderExtensionHarness
} from "./fixtures/visual-reader-extension-harness";

const NOW = "2026-08-16T08:00:00.000Z";
const EXPIRES_AT = "2026-08-16T08:02:00.000Z";
const PLAN_ID = "plan-visual-reader-e2e";
const PLAN_VERSION_ID = "plan-version-visual-reader-e2e";
const RUN_ID = "run-visual-reader-e2e";
const SESSION_ID = "session-visual-reader-e2e";
const CANDIDATE_ID = "candidate-visual-reader-e2e";
const EVIDENCE_ID = `visual:visual-observation:${"9".repeat(64)}:evidence:sha256:${"8".repeat(64)}`;
const ARTIFACT_ID = "visual-artifact:e2e-redacted";
const FORBIDDEN_ARTIFACT_ID = "visual-artifact:e2e-forbidden";
const VIDEO_ID = "7480000000000000000";
const SOURCE_URL = `https://www.douyin.com/video/${VIDEO_ID}`;
const COOKIE_SECRET = "e2e-visual-cookie-secret";
const RAW_SCREENSHOT_SENTINEL = "RAW_SCREENSHOT_SENTINEL_e2e_private_pixels";
const BROWSER_CONFIG_SENTINEL = "BROWSER_CONFIG_SENTINEL_e2e_private_runtime";
const NONCE_SENTINEL = "NONCE_SENTINEL_e2e_private_channel";
const LOCAL_VITE_ORIGIN = "http://127.0.0.1:5388";
const MASKED_WEBP_BASE64 = "UklGRgACAABXRUJQVlA4WAoAAAAgAAAAAQAAAQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDhMEQAAAC8BQAAAB9CeRnSm/4GI6H8AAA==";
const LONG_DOM_COMMENT = `需要比较出海获客方案的预算和交付周期，这是仅当前可见的一级评论样本。${"long-visible-comment-".repeat(24)}`;

const performance = {
  counts: { discovered: 1, highIntent: 0, approved: 0, converted: 0, contacted: 0, quoted: 0, won: 0, lost: 0 },
  rates: { highIntentRate: 0, approvalRate: 0, crmConversionRate: 0, contactRate: 0, quoteRate: 0, winRate: 0 },
  valuesByCurrency: [],
  cost: { status: "unavailable", reason: "no_recorded_api_execution_cost" },
  roi: { status: "not_computable", reason: "channel_cost_or_verified_margin_unavailable" },
  dataQuality: { missingAttribution: 0, missingFinancial: 0, truncated: false, lastReconciledAt: NOW },
  briefingFacts: { headlines: [], risks: [], actions: [], metricIds: [] }
};

const viewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 900 }
];

type RecordedRequest = {
  method: string;
  origin: string;
  path: string;
  body: string | null;
};

type FixtureState = {
  session: VisualReaderSession | null;
  observations: VisualObservationSubmission[];
  candidateAvailable: boolean;
  artifactExpired: boolean;
  artifactForbidden?: boolean;
  evidenceArtifactId?: string;
  artifactVariant?: "valid" | "wrong_mime" | "fake_webp";
};

function usage(overrides: Partial<VisualReaderUsage> = {}): VisualReaderUsage {
  return {
    videoCount: 0,
    observationCount: 0,
    scrollCount: 0,
    ocrCallCount: 0,
    domObservationCount: 0,
    accessibilityObservationCount: 0,
    ocrObservationCount: 0,
    lowConfidenceObservationCount: 0,
    artifactCount: 0,
    ...overrides
  };
}

function activeSession(overrides: Partial<VisualReaderSession> = {}): VisualReaderSession {
  return {
    sessionId: SESSION_ID,
    runId: RUN_ID,
    planId: PLAN_ID,
    planVersionId: PLAN_VERSION_ID,
    platform: "douyin",
    coverage: "authorized_visible_top_level_sample",
    status: "created",
    artifactUploadEnabled: true,
    limits: {
      maxVideos: 10,
      maxCommentsPerVideo: 30,
      maxScrolls: 5,
      maxOcrCalls: 10,
      maxDurationMs: 120_000
    },
    usage: usage(),
    outcome: null,
    lastErrorCode: null,
    createdAt: NOW,
    authorizedAt: NOW,
    updatedAt: NOW,
    expiresAt: EXPIRES_AT,
    completedAt: null,
    ...overrides
  };
}

function terminalSession(
  current: VisualReaderSession,
  status: "completed" | "partial_success" | "aborted",
  errorCodes: VisualReaderSession["outcome"] extends infer _T ? string[] : never
): VisualReaderSession {
  return {
    ...current,
    status,
    lastErrorCode: (errorCodes[0] as VisualReaderSession["lastErrorCode"]) ?? null,
    outcome: {
      status,
      videoCount: current.usage.videoCount,
      observationCount: current.usage.observationCount,
      domObservationCount: current.usage.domObservationCount,
      accessibilityObservationCount: current.usage.accessibilityObservationCount,
      ocrObservationCount: current.usage.ocrObservationCount,
      lowConfidenceObservationCount: current.usage.lowConfidenceObservationCount,
      artifactCount: current.usage.artifactCount,
      errorCodes: errorCodes as NonNullable<VisualReaderSession["outcome"]>["errorCodes"]
    },
    updatedAt: NOW,
    completedAt: NOW
  };
}

function domObservation(
  overrides: Partial<VisualObservationSubmission> = {}
): VisualObservationSubmission {
  return {
    clientObservationKey: "dom-observation-e2e",
    sourceUrl: SOURCE_URL,
    videoId: VIDEO_ID,
    visibleText: LONG_DOM_COMMENT,
    domTextHash: `sha256:${"1".repeat(64)}`,
    ocrTextHash: null,
    displayName: "可见评论者",
    visibleTimeText: "1天前",
    likeCount: 3,
    replyCount: 0,
    platformCommentId: "7480000000000000001",
    publicProfileUrl: "https://www.douyin.com/user/secuid-e2e",
    secUid: "secuid-e2e",
    extractionMethod: "dom",
    fieldConfidences: {
      visibleText: 0.99,
      displayName: 0.99,
      visibleTimeText: 0.99,
      likeCount: 0.99,
      replyCount: 0.99,
      platformCommentId: 0.99,
      publicProfileUrl: 0.99,
      secUid: 0.99
    },
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    cardBounds: { x: 100, y: 120, width: 640, height: 180 },
    readerVersion: "goodjob-visual-reader/e2e",
    capturedAt: NOW,
    redactedCrop: null,
    ...overrides
  };
}

function ocrObservation(
  overrides: Partial<VisualObservationSubmission> = {}
): VisualObservationSubmission {
  return {
    clientObservationKey: "ocr-observation-e2e",
    sourceUrl: SOURCE_URL,
    videoId: VIDEO_ID,
    visibleText: "需要获客方案，请说明交付周期。",
    domTextHash: `sha256:${"2".repeat(64)}`,
    ocrTextHash: `sha256:${"3".repeat(64)}`,
    displayName: null,
    visibleTimeText: "刚刚",
    likeCount: 1,
    replyCount: 0,
    platformCommentId: null,
    publicProfileUrl: null,
    secUid: null,
    extractionMethod: "ocr",
    fieldConfidences: {
      visibleText: 0.96,
      visibleTimeText: 0.96,
      likeCount: 0.96,
      replyCount: 0.96
    },
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    cardBounds: { x: 100, y: 320, width: 640, height: 180 },
    readerVersion: "goodjob-visual-reader/e2e",
    capturedAt: NOW,
    redactedCrop: {
      mediaType: "image/webp",
      contentBase64: MASKED_WEBP_BASE64,
      redactionProof: {
        version: "opaque-rect-v1",
        maskColorRgba: [17, 61, 51, 255],
        avatarBounds: { x: 0, y: 0, width: 1, height: 1 },
        visibleRegions: [{ x: 1, y: 0, width: 1, height: 1 }],
        maskedRegions: [{ x: 0, y: 0, width: 1, height: 1 }]
      }
    },
    ...overrides
  };
}

function visualSteps(state: FixtureState) {
  const count = state.session?.usage.observationCount ?? 0;
  const lowConfidence = state.session?.usage.lowConfidenceObservationCount ?? 0;
  const status = state.session?.status ?? "created";
  const terminal = ["completed", "partial_success", "aborted"].includes(status);
  return [
    ["authorize_visual_reader", "已由客户确认短时授权"],
    ["read_visible_comment_cards", `已读取 ${count} 条当前可见一级评论`],
    ["extract_visible_text", lowConfidence > 0
      ? "低置信度观察仅供人工复核"
      : "DOM 优先，OCR 仅处理已遮挡裁剪"],
    ["persist_visual_observations", `已持久化 ${count} 条观察`],
    ["review_visual_signal_confidence", lowConfidence > 0
      ? "检出低置信度，未自动资格判定"
      : "置信度门禁已完成"]
  ].map(([id, message], index) => ({
    id,
    status: terminal ? "succeeded" : index === 4 ? "running" : "succeeded",
    startedAt: NOW,
    completedAt: terminal ? NOW : null,
    durationMs: terminal ? 100 : null,
    processedCount: index >= 1 ? count : 1,
    errorCode: lowConfidence > 0 && index === 4
      ? "visual_extraction_low_confidence"
      : null,
    message
  }));
}

function presentation(state: FixtureState) {
  const session = state.session;
  return {
    run: {
      id: RUN_ID,
      status: "running",
      etag: `"${RUN_ID}:1"`,
      updatedAt: NOW,
      completedAt: null
    },
    providers: [],
    summary: {
      sourcesSearched: 0,
      pagesAnalyzed: 0,
      organizationsFound: 0,
      dedupedCandidates: state.candidateAvailable ? 1 : 0,
      validOpportunities: 0,
      highIntent: 0,
      financialEvaluatedHighIntentCount: 0,
      financialPendingHighIntentCount: 0,
      expectedRevenueByCurrency: [],
      discoveredVideos: session?.usage.videoCount ?? 0,
      commentsSampled: session?.usage.observationCount ?? 0,
      validDemandSignals: state.candidateAvailable ? 1 : 0,
      unresolvedActors: state.candidateAvailable ? 1 : 0,
      highPotentialSignals: state.candidateAvailable ? 1 : 0
    },
    automationSteps: [],
    authorizedVisualReader: session ? {
      sessionId: session.sessionId,
      coverage: session.coverage,
      status: session.status,
      limits: session.limits,
      usage: session.usage,
      outcome: session.outcome,
      lastErrorCode: session.lastErrorCode,
      sessionCount: 1,
      aggregateStatus: ["created", "collecting"].includes(session.status)
        ? "active"
        : session.status,
      aggregateUsage: session.usage,
      visualSteps: visualSteps(state)
    } : undefined,
    commentSignals: state.candidateAvailable ? [{
      eventId: "visual-signal-e2e",
      candidateId: CANDIDATE_ID,
      displayName: "可见需求信号",
      handle: null,
      text: "需要获客方案，请说明交付周期。",
      occurredAt: NOW,
      likeCount: 1,
      replyCount: 0,
      ipLabel: null,
      sourceUrl: SOURCE_URL,
      intentBand: "strong_signal",
      reasons: ["可见需求文字"],
      confidence: 0.96,
      identityStatus: "needs_research",
      evidenceId: EVIDENCE_ID
    }] : [],
    candidateEvents: state.candidateAvailable ? [{
      eventId: "visual-candidate-event-e2e",
      createdAt: NOW,
      candidateId: CANDIDATE_ID,
      candidate: {
        id: CANDIDATE_ID,
        subjectKind: "individual",
        displayName: "可见需求信号",
        industry: null,
        region: null,
        domain: null,
        status: "needs_research",
        version: 1,
        identityResolved: false,
        updatedAt: NOW
      },
      qualification: null,
      financialValue: null,
      sourcePlatforms: ["douyin"],
      evidenceCount: 1
    }] : [],
    nextAfter: "",
    hasMore: false
  };
}

function taskDetail(state: FixtureState) {
  const currentPresentation = presentation(state);
  const latestRun = {
    id: RUN_ID,
    status: "running",
    updatedAt: NOW,
    completedAt: null,
    evidenceCount: state.candidateAvailable ? 1 : 0,
    consumedBudget: { requests: 0, results: 0, amountMinor: 0, durationSeconds: 0 },
    etag: `"${RUN_ID}:1"`,
    planVersion: 1,
    planVersionId: PLAN_VERSION_ID,
    revision: 1,
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 10,
      maxResults: 30,
      maxAmountMinor: 500,
      maxDurationSeconds: 120
    },
    modelSnapshotRef: {}
  };
  return {
    task: {
      id: "task-visual-reader-e2e",
      planId: PLAN_ID,
      name: "授权可见评论读取",
      objective: "在用户授权的当前页面读取可见一级评论",
      platform: "douyin",
      discoveryMethods: ["public_search"],
      planStatus: "approved",
      latestRun,
      updatedAt: NOW
    },
    plan: {
      id: PLAN_ID,
      status: "approved",
      version: 1,
      currentVersionId: PLAN_VERSION_ID,
      approvedVersionId: PLAN_VERSION_ID,
      payload: {
        targetPlatform: "douyin",
        name: "授权可见评论读取",
        objective: "只读当前可见一级评论样本",
        icp: { industries: ["企业服务"], regions: ["厦门"] },
        operations: [],
        providerConnections: [],
        douyinPublicCommentSample: { enabled: true },
        budgetSnapshot: latestRun.budgetSnapshot,
        modelSnapshotRef: {},
        stopConditions: { stopWhenBudgetExhausted: true, stopWhenNoMoreResults: true }
      }
    },
    latestRun,
    shards: [],
    presentation: {
      ...currentPresentation,
      providers: currentPresentation.providers,
      automationSteps: currentPresentation.automationSteps,
      commentSignals: currentPresentation.commentSignals,
      candidateEvents: currentPresentation.candidateEvents,
      summary: currentPresentation.summary
    }
  };
}

function normalizedObservation(input: VisualObservationSubmission, index: number) {
  return {
    observationId: `visual-observation:${String(index + 1).padStart(64, "0")}`,
    sessionId: SESSION_ID,
    sourceUrl: input.sourceUrl,
    videoId: input.videoId,
    visibleText: input.visibleText,
    textHash: `sha256:${String(index + 4).padStart(64, "0")}`,
    domTextHash: input.domTextHash,
    ocrTextHash: input.ocrTextHash,
    displayName: input.displayName,
    visibleTimeText: input.visibleTimeText,
    likeCount: input.likeCount,
    replyCount: input.replyCount,
    platformCommentId: input.platformCommentId,
    publicProfileUrl: input.publicProfileUrl,
    secUid: input.secUid,
    extractionMethod: input.extractionMethod,
    fieldConfidences: input.fieldConfidences,
    viewportHash: `sha256:${String(index + 5).padStart(64, "0")}`,
    cardBounds: input.cardBounds,
    redactedCropHash: input.redactedCrop ? `sha256:${"7".repeat(64)}` : null,
    readerVersion: input.readerVersion,
    capturedAt: input.capturedAt
  };
}

function candidate() {
  return {
    id: CANDIDATE_ID,
    subjectKind: "individual",
    publicActorKey: `unmergeable:douyin:visual:visual-observation:${"9".repeat(64)}`,
    publicDisplayName: "可见需求信号",
    publicProfileUrl: SOURCE_URL,
    sourcePlatform: "douyin",
    demandCategory: "获客方案",
    demandSummary: "需要获客方案，请说明交付周期。",
    locationHint: null,
    buyingStage: "comparison",
    negativeSignals: [],
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    evidenceIds: [EVIDENCE_ID],
    status: "needs_research",
    version: 1,
    identityResolved: false,
    latestDecisionVersion: null,
    approvedDecisionVersion: null,
    updatedAt: NOW
  };
}

async function installApiFixture(page: Page, state: FixtureState) {
  const requests: RecordedRequest[] = [];
  const consoleMessages: string[] = [];
  const undeclared: string[] = [];
  await page.addInitScript(({ cookieSecret }) => {
    document.cookie = `gj_csrf=${cookieSecret}; path=/`;
    localStorage.setItem("gj_user", JSON.stringify({
      id: "visual-e2e-owner",
      name: "Visual E2E Owner",
      email: "visual-e2e@goodjob.test",
      role: "admin",
      teamId: "visual-e2e-team",
      avatar: "VE"
    }));
  }, { cookieSecret: COOKIE_SECRET });
  page.on("console", (message) => consoleMessages.push(message.text()));
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    requests.push({
      method: request.method(),
      origin: url.origin,
      path: url.pathname,
      body: request.postData()
    });
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== LOCAL_VITE_ORIGIN) return void await route.abort("blockedbyclient");
    return void await route.fallback();
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== LOCAL_VITE_ORIGIN) return void await route.abort("blockedbyclient");
    const path = url.pathname;
    const json = (value: unknown, status = 200) => route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(value)
    });
    if (path === "/api/v1/acquisition/overview" && request.method() === "GET") {
      return void await json({
        generatedAt: NOW,
        platform: "douyin",
        totals: { tasks: 1 },
        statusCounts: { running: 1 },
        discoveryMethodCounts: { public_search: 1 },
        tasks: [taskDetail(state).task]
      });
    }
    if (path === "/api/v1/acquisition/performance" && request.method() === "GET") {
      return void await json(performance);
    }
    if (path === `/api/v1/acquisition/tasks/${PLAN_ID}` && request.method() === "GET") {
      return void await json(taskDetail(state));
    }
    if (path === `/api/v1/acquisition/runs/${RUN_ID}/presentation`
      && request.method() === "GET") {
      return void await json(presentation(state));
    }
    if (path === "/api/v1/acquisition/visual-reader-sessions"
      && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "null") as Record<string, unknown>;
      if (Object.keys(body).sort().join(",") !== "artifactUploadEnabled,runId"
        || body.runId !== RUN_ID || typeof body.artifactUploadEnabled !== "boolean") {
        return void await json({ code: "visual_observation_invalid" }, 400);
      }
      state.session = activeSession({ artifactUploadEnabled: body.artifactUploadEnabled });
      return void await json(state.session, 201);
    }
    if (path === `/api/v1/acquisition/visual-reader-sessions/${SESSION_ID}`
      && request.method() === "GET") {
      return void await json(state.session ?? { code: "resource_not_found" }, state.session ? 200 : 404);
    }
    if (path === `/api/v1/acquisition/visual-reader-sessions/${SESSION_ID}/observations:batch`
      && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "null") as { observations?: unknown[] };
      const observations = Array.isArray(body.observations) ? body.observations : [];
      const serialized = JSON.stringify(observations);
      if (observations.length < 1 || observations.length > 20
        || /cookie|rawScreenshot|fullPageScreenshot|browserConfig|networkResponse|avatarUrl/iu.test(serialized)) {
        return void await json({ code: "visual_observation_invalid", message: "视觉读取数据未通过安全校验" }, 400);
      }
      if (!state.session) return void await json({ code: "resource_not_found" }, 404);
      const accepted = (observations as VisualObservationSubmission[]).map((item) => {
        const low = item.fieldConfidences.visibleText < (item.extractionMethod === "ocr" ? 0.9 : 0.85);
        const previous = state.session!.usage;
        state.session = activeSession({
          ...state.session!,
          status: "collecting",
          usage: usage({
            ...previous,
            videoCount: 1,
            observationCount: previous.observationCount + 1,
            ocrCallCount: previous.ocrCallCount + (item.extractionMethod === "ocr" ? 1 : 0),
            domObservationCount: previous.domObservationCount + (item.extractionMethod === "dom" ? 1 : 0),
            accessibilityObservationCount: previous.accessibilityObservationCount
              + (item.extractionMethod === "accessibility" ? 1 : 0),
            ocrObservationCount: previous.ocrObservationCount + (item.extractionMethod === "ocr" ? 1 : 0),
            lowConfidenceObservationCount: previous.lowConfidenceObservationCount + (low ? 1 : 0),
            artifactCount: previous.artifactCount + (item.redactedCrop ? 1 : 0)
          })
        });
        state.observations.push(structuredClone(item));
        if (item.extractionMethod === "ocr" && !low) state.candidateAvailable = true;
        return {
          clientObservationKey: item.clientObservationKey,
          observation: normalizedObservation(item, state.observations.length - 1)
        };
      });
      return void await json({ session: state.session, accepted, duplicates: [] });
    }
    if (path === `/api/v1/acquisition/visual-reader-sessions/${SESSION_ID}:complete`
      && request.method() === "POST") {
      if (!state.session) return void await json({ code: "resource_not_found" }, 404);
      const body = JSON.parse(request.postData() ?? "null") as {
        status: "completed" | "partial_success";
        errorCodes: string[];
      };
      state.session = terminalSession(state.session, body.status, body.errorCodes);
      return void await json(state.session);
    }
    if (path === `/api/v1/acquisition/visual-reader-sessions/${SESSION_ID}:abort`
      && request.method() === "POST") {
      if (!state.session) return void await json({ code: "resource_not_found" }, 404);
      if (request.postData() !== '{"reasonCode":"user_requested"}') {
        return void await json({ code: "visual_observation_invalid" }, 400);
      }
      state.session = terminalSession(state.session, "aborted", []);
      return void await json(state.session);
    }
    const evidenceArtifactId = state.evidenceArtifactId ?? ARTIFACT_ID;
    if (path === `/api/v1/acquisition/visual-reader-artifacts/${encodeURIComponent(evidenceArtifactId)}`
      && request.method() === "GET") {
      if (state.artifactForbidden) {
        return void await json({ code: "artifact_forbidden", message: "private artifact policy detail" }, 403);
      }
      if (state.artifactExpired) {
        return void await json({ code: "resource_not_found", message: "制品已到期" }, 404);
      }
      if (state.artifactVariant === "wrong_mime") {
        return void await route.fulfill({
          status: 200,
          contentType: "application/octet-stream",
          headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
          body: Buffer.from(MASKED_WEBP_BASE64, "base64")
        });
      }
      if (state.artifactVariant === "fake_webp") {
        return void await route.fulfill({
          status: 200,
          contentType: "image/webp",
          headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
          body: Buffer.from([82, 73, 70, 70, 4, 0, 0, 0, 70, 65, 75, 69])
        });
      }
      return void await route.fulfill({
        status: 200,
        contentType: "image/webp",
        headers: {
          "cache-control": "private, no-store",
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff"
        },
        body: Buffer.from(MASKED_WEBP_BASE64, "base64")
      });
    }
    if (path.startsWith("/api/v1/acquisition/visual-reader-artifacts/")
      && request.method() === "GET") {
      return void await json({ code: "resource_not_found" }, 404);
    }
    if (path === `/api/v1/acquisition/candidates/${CANDIDATE_ID}`
      && request.method() === "GET") return void await json(candidate());
    if (path === `/api/v1/acquisition/candidates/${CANDIDATE_ID}/evidence`
      && request.method() === "GET") {
      return void await json({
        items: [{
          id: EVIDENCE_ID,
          targetType: "individual_signal",
          sourcePlatform: "douyin",
          sourceTitle: "已授权可见评论观察",
          sourceSnippet: "需要获客方案，请说明交付周期。",
          publishedAt: NOW,
          fetchedAt: NOW,
          locale: "zh-CN",
          rawArtifactHash: `sha256:${"7".repeat(64)}`,
          contentHash: `sha256:${"8".repeat(64)}`,
          provenance: {
            kind: "authorized_visual_observation",
            sourceUrl: SOURCE_URL,
            observationId: `visual-observation:${"9".repeat(64)}`,
            sessionId: SESSION_ID,
            extractionMethod: "ocr",
            visibleTextConfidence: 0.96,
            coverage: "authorized_visible_top_level_sample",
            artifactId: evidenceArtifactId,
            domTextHash: `sha256:${"2".repeat(64)}`,
            ocrTextHash: `sha256:${"3".repeat(64)}`
          },
          accessStatus: "access_restricted"
        }],
        nextCursor: null
      });
    }
    if (path === `/api/v1/acquisition/candidates/${CANDIDATE_ID}/qualification`
      || path === `/api/v1/acquisition/candidates/${CANDIDATE_ID}/financial-value`
      || path === `/api/v1/acquisition/candidates/${CANDIDATE_ID}/battle-card`
      || path === `/api/v1/acquisition/candidates/${CANDIDATE_ID}/intelligence-operation`
      || path === `/api/v1/acquisition/candidates/${CANDIDATE_ID}/private-domain-handoff`) {
      return void await json({ code: "resource_not_found" }, 404);
    }
    if (path === `/api/v1/acquisition/candidates/${CANDIDATE_ID}/reviews`) {
      return void await json({ items: [], nextCursor: null });
    }
    if (path === `/api/v1/acquisition/candidates/${CANDIDATE_ID}/douyin-identity-resolution-operation`) {
      return void await json({
        id: "identity-visual-e2e",
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
    undeclared.push(`${request.method()} ${path}`);
    return void await json({ code: "unconfigured_acquisition_api", message: `No fixture for ${path}` }, 501);
  });
  return { requests, consoleMessages, undeclared };
}

async function openPlan(page: Page, navigate = true) {
  if (navigate) await page.goto("/#acquisition", { waitUntil: "load" });
  await expect(page.locator("body")).toHaveClass(/is-authenticated/u);
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

async function authorize(
  page: Page,
  harness: VisualReaderExtensionHarness,
  fixture: Awaited<ReturnType<typeof installApiFixture>>
) {
  const card = page.locator("[data-acquisition-visual-reader]");
  await expect(card).toHaveAttribute("data-extension-status", "ready");
  const consent = card.getByRole("checkbox", { name: "上传已遮挡的单张评论卡 WebP" });
  await consent.focus();
  await expect(consent).toBeFocused();
  await consent.press("Space");
  await expect(consent).not.toBeChecked();
  await consent.press("Space");
  await expect(consent).toBeChecked();
  const button = card.getByRole("button", { name: "授权读取当前抖音页面" });
  await button.focus();
  await expect(button).toBeFocused();
  await button.press("Enter");
  await expect.poll(async () => (await harness.commands()).filter((item) => item.type === "start").length)
    .toBe(1);
  const create = fixture.requests.filter((request) => request.method === "POST"
    && request.path === "/api/v1/acquisition/visual-reader-sessions");
  expect(create).toHaveLength(1);
  expect(create[0]?.body).toBe(JSON.stringify({ runId: RUN_ID, artifactUploadEnabled: true }));
  expect((await harness.commands()).find((item) => item.type === "start")?.artifactUploadEnabled)
    .toBe(true);
  await expect(card).toHaveAttribute("data-session-status", /created|collecting/u);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => {
    const candidates = [
      document.documentElement,
      document.body,
      document.querySelector("#replicaAcquisitionDetailCenter"),
      document.querySelector("[data-acquisition-visual-reader]"),
      document.querySelector(".replica-acquisition-evidence-list")
    ].filter((item): item is HTMLElement => item instanceof HTMLElement);
    return candidates.filter((item) => item.scrollWidth > item.clientWidth + 1)
      .map((item) => item.id || item.className);
  })).toEqual([]);
}

async function securityAudit(
  page: Page,
  fixture: Awaited<ReturnType<typeof installApiFixture>>,
  state: FixtureState
) {
  const writes = fixture.requests.filter((request) =>
    !["GET", "HEAD", "OPTIONS"].includes(request.method));
  expect(writes.filter((request) =>
    /(?:comment|reply|dm|message|friend|follow|publish|broadcast|bulk|mass|crm|customer|lead|deal|handoff)/iu
      .test(request.path)
    && !request.path.includes("visual-reader"))).toEqual([]);
  expect(fixture.requests.filter((request) => request.origin !== LOCAL_VITE_ORIGIN)).toEqual([]);
  const bodies = writes.map((request) => request.body ?? "").join("\n");
  expect(bodies).not.toContain(COOKIE_SECRET);
  expect(bodies).not.toMatch(/rawScreenshot|fullPageScreenshot|browserConfig|networkResponse/iu);
  expect(fixture.consoleMessages.join("\n")).not.toContain(COOKIE_SECRET);
  expect(fixture.consoleMessages.join("\n")).not.toContain(MASKED_WEBP_BASE64);
  const storage = await page.evaluate(() => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    session: Object.fromEntries(Object.entries(sessionStorage)),
    harness: window.__GOODJOB_VISUAL_READER_E2E_HARNESS__ ?? null
  }));
  expect(JSON.stringify(storage)).not.toContain(COOKIE_SECRET);
  expect(JSON.stringify(storage)).not.toContain(MASKED_WEBP_BASE64);
  expect(JSON.stringify(state)).not.toContain(COOKIE_SECRET);
  expect(JSON.stringify(state)).not.toMatch(/rawScreenshot|fullPageScreenshot|browserConfig/iu);
  assertSentinelsAbsent({
    body: bodies,
    console: fixture.consoleMessages.join("\n"),
    storage: JSON.stringify(storage),
    fixture: JSON.stringify(state)
  });
  expect(fixture.undeclared).toEqual([]);
}

function assertSentinelsAbsent(surfaces: Record<"body" | "console" | "storage" | "fixture", string>) {
  for (const sentinel of [RAW_SCREENSHOT_SENTINEL, BROWSER_CONFIG_SENTINEL, NONCE_SENTINEL]) {
    for (const value of Object.values(surfaces)) expect(value).not.toContain(sentinel);
  }
}

test("security audit rejects every non-local network origin", async ({ page }) => {
  const state: FixtureState = {
    session: null,
    observations: [],
    candidateAvailable: false,
    artifactExpired: false
  };
  const fixture = await installApiFixture(page, state);
  await page.goto("/", { waitUntil: "load" });
  const externalResult = await page.evaluate(async ({ url, body }) => {
    try {
      await fetch(url, { method: "POST", mode: "no-cors", body });
      return "resolved";
    } catch (error) {
      return error instanceof TypeError ? error.message : String(error);
    }
  }, {
    url: "https://evil.example/api/v1/acquisition/visual-reader-sessions",
    body: JSON.stringify({ runId: RUN_ID, artifactUploadEnabled: true })
  });
  expect(externalResult).toBe("Failed to fetch");
  expect(state.session).toBeNull();
  expect(fixture.requests.filter((request) => request.origin === "https://evil.example"))
    .toHaveLength(1);
  await expect(securityAudit(page, fixture, state)).rejects.toThrow();

  for (const sentinel of [RAW_SCREENSHOT_SENTINEL, BROWSER_CONFIG_SENTINEL, NONCE_SENTINEL]) {
    for (const surface of ["body", "console", "storage", "fixture"] as const) {
      expect(() => assertSentinelsAbsent({
        body: "",
        console: "",
        storage: "",
        fixture: "",
        [surface]: sentinel
      })).toThrow();
    }
  }
});

for (const viewport of viewports) {
  test(`authorized DOM/OCR observations restore and open redacted Evidence at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(30_000);
    await page.setViewportSize(viewport);
    const state: FixtureState = {
      session: null,
      observations: [],
      candidateAvailable: false,
      artifactExpired: false
    };
    const harness = await installVisualReaderExtensionHarness(page);
    const fixture = await installApiFixture(page, state);
    await openPlan(page);
    const card = page.locator("[data-acquisition-visual-reader]");
    await expect(card).toContainText("只上传已遮挡的单张评论卡 WebP");
    await authorize(page, harness, fixture);

    await harness.emitObservationBatch("batch-dom-e2e", [domObservation({
      viewport: { width: viewport.width, height: viewport.height, deviceScaleFactor: 1 }
    })]);
    await expect.poll(() => harness.commands()).toContainEqual(expect.objectContaining({
      type: "acknowledge_batch",
      batchId: "batch-dom-e2e"
    }));
    await expect(card.getByLabel("服务端视觉读取计数")).toContainText("DOM1 条");

    await harness.emitObservationBatch("batch-ocr-e2e", [ocrObservation({
      viewport: { width: viewport.width, height: viewport.height, deviceScaleFactor: 1 }
    })]);
    await expect.poll(async () => (await harness.commands())
      .some((item) => item.type === "acknowledge_batch" && item.batchId === "batch-ocr-e2e"))
      .toBe(true);
    await expect(card.getByLabel("服务端视觉读取计数")).toContainText("OCR1 条");
    await expect(card.getByLabel("服务端视觉读取计数")).toContainText("制品1 个");

    await harness.emitTerminal("completed", []);
    await expect(card).toHaveAttribute("data-session-status", "completed");
    await expect(card.getByLabel("服务端视觉读取步骤").locator("li")).toHaveCount(5);
    const signal = page.locator("[data-acquisition-detail-action='select-candidate']", {
      hasText: "需要获客方案"
    });
    await expect(signal).toBeVisible();
    await signal.focus();
    await signal.press("Enter");
    const evidence = page.locator(".replica-acquisition-evidence-list").filter({
      hasText: EVIDENCE_ID
    });
    await expect(evidence).toBeVisible();
    const viewArtifact = evidence.getByRole("button", { name: "查看遮挡裁剪" });
    await viewArtifact.focus();
    const artifactResponse = page.waitForResponse((response) =>
      response.url().includes(`/visual-reader-artifacts/${encodeURIComponent(ARTIFACT_ID)}`));
    await viewArtifact.press("Enter");
    const response = await artifactResponse;
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("image/webp");
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(response.headers()["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(response.headers()["x-content-type-options"]).toBe("nosniff");
    const image = page.getByRole("img", { name: "已遮挡的评论卡裁剪" });
    await expect(image).toBeVisible();
    await expect(image).toHaveAttribute("src", /^blob:/u);
    await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
    await expectNoHorizontalOverflow(page);

    await page.reload({ waitUntil: "load" });
    await openPlan(page, false);
    await expect(card).toHaveAttribute("data-session-status", "completed");
    await expect(card.getByLabel("服务端视觉读取计数")).toContainText("OCR1 条");
    await expectNoHorizontalOverflow(page);
    await securityAudit(page, fixture, state);
  });
}

test("extension missing and malformed bridge events fail closed before persistence", async ({ page }) => {
  const state: FixtureState = {
    session: null,
    observations: [],
    candidateAvailable: false,
    artifactExpired: false
  };
  const harness = await installVisualReaderExtensionHarness(page, { available: false });
  const fixture = await installApiFixture(page, state);
  await openPlan(page);
  const card = page.locator("[data-acquisition-visual-reader]");
  await expect(card).toHaveAttribute("data-extension-status", "unavailable", { timeout: 5_000 });
  await expect(card.getByRole("button", { name: "授权读取当前抖音页面" })).toBeDisabled();
  expect(fixture.requests.filter((item) =>
    item.method === "POST" && item.path === "/api/v1/acquisition/visual-reader-sessions"))
    .toHaveLength(0);

  await harness.setAvailable(true);
  await card.getByRole("button", { name: "重新检测读取器" }).click();
  await authorize(page, harness, fixture);
  const appendPath = `/api/v1/acquisition/visual-reader-sessions/${SESSION_ID}/observations:batch`;
  const appendCount = () => fixture.requests.filter((item) => item.path === appendPath).length;
  const valid = domObservation();
  await harness.emitObservationBatch("wrong-nonce", [valid], {
    channelNonce: NONCE_SENTINEL
  });
  await harness.emitRaw({
    type: "observation_batch",
    channelNonce: (await page.evaluate(() =>
      window.__GOODJOB_VISUAL_READER_E2E_HARNESS__?.channelNonce)),
    sessionId: SESSION_ID,
    batchId: "cookie-field",
    observations: [{ ...valid, cookie: COOKIE_SECRET }]
  });
  await harness.emitRaw({
    type: "observation_batch",
    channelNonce: (await page.evaluate(() =>
      window.__GOODJOB_VISUAL_READER_E2E_HARNESS__?.channelNonce)),
    sessionId: SESSION_ID,
    batchId: "raw-screenshot-field",
    observations: [{ ...valid, rawScreenshot: RAW_SCREENSHOT_SENTINEL }]
  });
  await harness.emitRaw({
    type: "observation_batch",
    channelNonce: (await page.evaluate(() =>
      window.__GOODJOB_VISUAL_READER_E2E_HARNESS__?.channelNonce)),
    sessionId: SESSION_ID,
    batchId: "browser-config-field",
    observations: [{ ...valid, browserConfig: BROWSER_CONFIG_SENTINEL }]
  });
  await harness.emitObservationBatch("over-limit", Array.from({ length: 21 }, (_, index) =>
    domObservation({ clientObservationKey: `over-limit-${index}` })));
  await harness.emitObservationBatch("ocr-forged-identity", [ocrObservation({
    platformCommentId: "7480000000000000002"
  })]);
  await harness.emitObservationBatch("crop-over-limit", Array.from({ length: 6 }, (_, index) =>
    ocrObservation({ clientObservationKey: `crop-over-limit-${index}` })));
  await page.waitForTimeout(100);
  expect(appendCount()).toBe(0);
  expect(state.observations).toEqual([]);
  await securityAudit(page, fixture, state);
});

test("low confidence, unredacted avatar, and explicit stop remain manual and read-only", async ({ page }) => {
  const state: FixtureState = {
    session: null,
    observations: [],
    candidateAvailable: false,
    artifactExpired: false
  };
  const harness = await installVisualReaderExtensionHarness(page);
  const fixture = await installApiFixture(page, state);
  await openPlan(page);
  await authorize(page, harness, fixture);
  const card = page.locator("[data-acquisition-visual-reader]");

  await harness.emitObservationBatch("low-confidence", [domObservation({
    clientObservationKey: "low-confidence-dom",
    fieldConfidences: {
      visibleText: 0.6,
      displayName: 0.6,
      visibleTimeText: 0.6,
      likeCount: 0.6,
      replyCount: 0.6,
      platformCommentId: 0.6,
      publicProfileUrl: 0.6,
      secUid: 0.6
    }
  })]);
  await expect.poll(async () => (await harness.commands())
    .some((item) => item.batchId === "low-confidence" && item.type === "acknowledge_batch"))
    .toBe(true);
  await expect(card.getByLabel("服务端视觉读取计数")).toContainText("低置信度1 条");
  await expect(card).toContainText("仅供人工复核");
  expect(state.candidateAvailable).toBe(false);

  const invalidCrop = ocrObservation({
    clientObservationKey: "unredacted-avatar",
    redactedCrop: {
      ...ocrObservation().redactedCrop!,
      redactionProof: {
        ...ocrObservation().redactedCrop!.redactionProof,
        maskedRegions: [{ x: 1, y: 0, width: 1, height: 1 }]
      }
    }
  });
  const appendPath = `/api/v1/acquisition/visual-reader-sessions/${SESSION_ID}/observations:batch`;
  const appendCountBeforeInvalidCrop = fixture.requests.filter((item) => item.path === appendPath).length;
  await harness.emitObservationBatch("unredacted-avatar", [invalidCrop]);
  await page.waitForTimeout(100);
  expect(fixture.requests.filter((item) => item.path === appendPath)).toHaveLength(
    appendCountBeforeInvalidCrop
  );
  expect((await harness.commands()).some((item) =>
    item.type === "acknowledge_batch" && item.batchId === "unredacted-avatar"))
    .toBe(false);

  const stop = card.getByRole("button", { name: "停止读取" });
  await stop.focus();
  await stop.press("Enter");
  await expect.poll(async () => (await harness.commands()).some((item) => item.type === "abort"))
    .toBe(true);
  await expect(card).toHaveAttribute("data-session-status", "aborted");
  await expect(card).toContainText("视觉读取已停止");
  const abort = fixture.requests.filter((item) => item.method === "POST"
    && item.path === `/api/v1/acquisition/visual-reader-sessions/${SESSION_ID}:abort`);
  expect(abort).toHaveLength(1);
  expect(abort[0]?.body).toBe('{"reasonCode":"user_requested"}');
  await securityAudit(page, fixture, state);
});

test("expired redacted artifact keeps the Evidence hash and shows a stable message", async ({ page }) => {
  const state: FixtureState = {
    session: terminalSession(activeSession({
      status: "collecting",
      usage: usage({
        videoCount: 1,
        observationCount: 1,
        ocrCallCount: 1,
        ocrObservationCount: 1,
        artifactCount: 1
      })
    }), "completed", []),
    observations: [ocrObservation()],
    candidateAvailable: true,
    artifactExpired: true
  };
  await installVisualReaderExtensionHarness(page);
  const fixture = await installApiFixture(page, state);
  await openPlan(page);
  const signal = page.locator("[data-acquisition-detail-action='select-candidate']", {
    hasText: "需要获客方案"
  });
  await signal.click();
  const evidence = page.locator(".replica-acquisition-evidence-list").filter({
    hasText: EVIDENCE_ID
  });
  await evidence.getByRole("button", { name: "查看遮挡裁剪" }).click();
  await expect(page.getByText("制品已到期，证据哈希仍保留")).toBeVisible();
  await expect(evidence).toContainText(`sha256:${"7".repeat(64)}`);
  await expect(evidence).toBeVisible();
  await securityAudit(page, fixture, state);
});

test("forbidden redacted artifact never renders or leaks policy detail", async ({ page }) => {
  const state: FixtureState = {
    session: terminalSession(activeSession({
      status: "collecting",
      usage: usage({ observationCount: 1, ocrObservationCount: 1, artifactCount: 1 })
    }), "completed", []),
    observations: [ocrObservation()],
    candidateAvailable: true,
    artifactExpired: false,
    artifactForbidden: true,
    evidenceArtifactId: FORBIDDEN_ARTIFACT_ID
  };
  await installVisualReaderExtensionHarness(page);
  const fixture = await installApiFixture(page, state);
  await openPlan(page);
  await page.locator("[data-acquisition-detail-action='select-candidate']", {
    hasText: "需要获客方案"
  }).click();
  const evidence = page.locator(".replica-acquisition-evidence-list").filter({ hasText: EVIDENCE_ID });
  const responsePromise = page.waitForResponse((response) =>
    response.url().includes(encodeURIComponent(FORBIDDEN_ARTIFACT_ID)));
  await evidence.getByRole("button", { name: "查看遮挡裁剪" }).click();
  expect((await responsePromise).status()).toBe(403);
  await expect(page.getByText("遮挡裁剪暂不可用，证据哈希仍保留")).toBeVisible();
  await expect(page.getByRole("img", { name: "已遮挡的评论卡裁剪" })).toHaveCount(0);
  await expect(evidence).toContainText(`sha256:${"7".repeat(64)}`);
  await expect(bodyText(page)).resolves.not.toContain("private artifact policy detail");
  await securityAudit(page, fixture, state);
});

for (const artifactVariant of ["wrong_mime", "fake_webp"] as const) {
  test(`${artifactVariant} artifact fails closed before display`, async ({ page }) => {
    const state: FixtureState = {
      session: terminalSession(activeSession({ status: "collecting" }), "completed", []),
      observations: [ocrObservation()],
      candidateAvailable: true,
      artifactExpired: false,
      artifactVariant
    };
    await installVisualReaderExtensionHarness(page);
    const fixture = await installApiFixture(page, state);
    await openPlan(page);
    await page.locator("[data-acquisition-detail-action='select-candidate']", {
      hasText: "需要获客方案"
    }).click();
    const evidence = page.locator(".replica-acquisition-evidence-list").filter({ hasText: EVIDENCE_ID });
    await evidence.getByRole("button", { name: "查看遮挡裁剪" }).click();
    await expect(page.getByText("遮挡裁剪暂不可用，证据哈希仍保留")).toBeVisible();
    await expect(page.getByRole("img", { name: "已遮挡的评论卡裁剪" })).toHaveCount(0);
    await expect(evidence).toContainText(`sha256:${"7".repeat(64)}`);
    await securityAudit(page, fixture, state);
  });
}

async function bodyText(page: Page): Promise<string> {
  return await page.locator("body").innerText();
}

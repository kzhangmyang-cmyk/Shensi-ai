import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const PORT = Number(process.env.PORT ?? 5391);
const NOW = "2026-08-25T09:30:00.000Z";
const hash = (char: string) => `sha256:${char.repeat(64)}`;
const TEST_QR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240" shape-rendering="crispEdges">
  <rect width="240" height="240" fill="#fff"/>
  <g fill="#111">
    <path d="M12 12h64v64H12zM164 12h64v64h-64zM12 164h64v64H12z"/>
    <path d="M92 12h12v12H92zM116 12h24v12h-24zM92 36h12v24H92zM116 36h12v12h-12zM140 36h12v24h-12zM92 72h24v12H92zM128 72h24v12h-24zM84 96h12v24H84zM108 96h12v12h-12zM132 96h24v12h-24zM168 96h12v24h-12zM204 96h24v12h-24zM84 132h24v12H84zM120 120h12v24h-12zM144 132h24v12h-24zM180 132h12v24h-12zM216 120h12v24h-12zM96 156h24v12H96zM132 156h12v24h-12zM156 168h24v12h-24zM192 168h36v12h-36zM84 192h12v36H84zM108 192h24v12h-24zM144 204h12v24h-12zM168 192h12v12h-12zM192 204h24v12h-24z"/>
  </g>
  <g fill="#fff"><path d="M24 24h40v40H24zM176 24h40v40h-40zM24 176h40v40H24z"/></g>
  <g fill="#111"><path d="M32 32h24v24H32zM184 32h24v24h-24zM32 184h24v24H32z"/></g>
  <rect x="50" y="103" width="140" height="34" rx="4" fill="#fff" stroke="#d71935" stroke-width="4"/>
  <text x="120" y="126" fill="#d71935" font-family="Arial, sans-serif" font-size="17" font-weight="700" text-anchor="middle" shape-rendering="auto">TEST ONLY</text>
</svg>`;
const TEST_QR_IMAGE_DATA_URL = `data:image/svg+xml;base64,${Buffer.from(TEST_QR_SVG).toString("base64")}`;
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
    }
  | {
      kind: "direct_message_approve";
      candidateIds: string[];
      dailyLimit: number | null;
    };
type FixtureState = {
  loginPolls: number;
  runPolls: number;
  actionPolls: number;
  approvalConflicted: boolean;
  policyRevision: number;
  batchRevision: number;
  batchState: "awaiting_approval" | "approved" | "paused";
  planCreated: boolean;
  planApproved: boolean;
  planName: string;
  runStarted: boolean;
  batchCreated: boolean;
  activeCandidateIds: string[];
  approvedCandidateIds: string[];
  directMessageApprovedCandidateIds: string[];
  directMessageDailyLimit: number | null;
  directMessageApprovedDrafts: Record<string, string>;
  createdCandidateIds: string[][];
  attemptLedger: FixtureAttempt[];
  drafts: Record<string, { comment: string; directMessage: string }>;
};
let state: FixtureState;
const reset = () => {
  state = {
    loginPolls: 0,
    runPolls: 0,
    actionPolls: 0,
    approvalConflicted: false,
    policyRevision: 0,
    batchRevision: 1,
    batchState: "awaiting_approval",
    planCreated: false,
    planApproved: false,
    planName: "",
    runStarted: false,
    batchCreated: false,
    activeCandidateIds: [],
    approvedCandidateIds: [],
    directMessageApprovedCandidateIds: [],
    directMessageDailyLimit: null,
    directMessageApprovedDrafts: {},
    createdCandidateIds: [],
    attemptLedger: [],
    drafts: {}
  };
};
reset();

const readBody = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) as Record<string, unknown> : {};
};
const send = (response: ServerResponse, body: unknown, status = 200, headers: Record<string, string | string[]> = {}) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(body));
};
const error = (response: ServerResponse, status: number, code: string, message: string) => send(response, { error: { code, message, requestId: "fixture-request" } }, status);
const authenticated = (request: IncomingMessage) => /(?:^|;\s*)gj_session=fixture-session(?:;|$)/u.test(request.headers.cookie ?? "");
const writeAuthorized = (request: IncomingMessage) => request.headers["x-csrf-token"] === "fixture-csrf";

const account = (accountState: "active" | "risk_paused" = "active") => ({ id: "account-fixture", workspaceId: "workspace-fixture", platform: "douyin" as const, displayName: "测试模拟账号", state: accountState, loginStateVersion: 3, revision: 3, etag: '"account:3"', lastValidatedAt: NOW, createdAt: NOW, updatedAt: NOW });
const limits = { maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3, maxDurationSeconds: 3600 };
const policy = () => ({ id: state.policyRevision ? "policy-fixture" : null, source: state.policyRevision ? "version" : "default", workspaceId: "workspace-fixture", planId: "plan-fixture", planVersionId: "plan-version-fixture", planVersion: 1, planSnapshotHash: hash("1"), accountId: state.loginPolls > 1 ? "account-fixture" : null, accountLoginStateVersion: state.loginPolls > 1 ? 3 : null, version: state.policyRevision, revision: state.policyRevision, etag: `"policy:${state.policyRevision}"`, policyHash: hash("2"), keywords: state.policyRevision ? ["工业除尘改造", "工厂节能"] : ["工业除尘"], schedule: { enabled: state.policyRevision > 0, localTime: "09:30", timeZone: "Asia/Shanghai" }, dailyCandidateLimit: state.policyRevision ? 50 : 50, collectCreators: true, collectDemandComments: true, limits, createdBy: state.policyRevision ? "user-fixture" : null, createdAt: state.policyRevision ? NOW : null });
const candidates = [
  { id: "candidate-creator", status: "creator_candidate", displayName: "节能设备观察员", evidence: { sourceUrl: "https://www.douyin.com/video/741234567890", excerpt: "正在对比工厂除尘改造的能耗与交付周期。" } },
  { id: "candidate-commenter", status: "commenter_candidate", displayName: "需求评论者", evidence: { sourceUrl: "https://www.douyin.com/video/741234567891", excerpt: "想了解一下工业除尘方案的预算和实施周期。" } },
  { id: "candidate-profile", status: "creator_candidate", displayName: "主页证据观察员", evidence: { sourceUrl: "https://www.douyin.com/user/profile-only-fixture", excerpt: "安全暂停原因：douyin_collection_partial；仅保存公开主页证据。" } }
];
const defaultDraft = (candidateId: string) => candidateId === "candidate-creator"
  ? {
      comment: "您好，看到您在对比工厂除尘改造的能耗与交付周期。",
      directMessage: "您好，可以为您整理一份与公开需求对应的方案参考。"
    }
  : {
      comment: "您好，看到您在了解工业除尘方案的预算和实施周期。",
      directMessage: "您好，可以为您整理一份与公开需求对应的方案参考。"
    };
const batchCandidates = () => state.activeCandidateIds.map((candidateId) => {
  const draft = state.drafts[candidateId] ?? defaultDraft(candidateId);
  return {
    candidateId,
    selected: true,
    candidateRevision: 1,
    evidenceHashes: [hash(candidateId === "candidate-creator" ? "3" : "4")],
    publicProfileUrl: `https://www.douyin.com/user/${candidateId}`,
    commentTargetPublicUrl: candidates.find((candidate) =>
      candidate.id === candidateId)?.evidence.sourceUrl,
    draftRevision: state.batchRevision,
    comment: draft.comment,
    commentHash: hash("5"),
    directMessage: draft.directMessage,
    directMessageHash: hash("6"),
    rationaleCodes: ["evidence_grounded", "manual_review_required"],
    modelSnapshotId: "model-snapshot-public",
    sourceModelSnapshotId: "model-snapshot-public",
    contentHash: hash("7")
  };
});
const batch = () => ({ id: "batch-fixture", workspaceId: "workspace-fixture", runId: "run-fixture", planId: "plan-fixture", planVersionId: "plan-version-fixture", planVersion: 1, planSnapshotHash: hash("1"), policyVersionId: "policy-fixture", policyHash: hash("2"), accountId: "account-fixture", accountLoginStateVersion: 3, dailyBudgetId: hash("9"), localDate: "2026-08-25", dailyCandidateLimit: 50, dailyRemainingLimit: 48, revision: state.batchRevision, etag: `"batch:${state.batchRevision}:${state.batchState}"`, state: state.batchState, candidates: batchCandidates(), batchHash: hash(String(Math.min(9, state.batchRevision))), approvedBy: state.batchState === "approved" ? "reviewer-fixture" : null, approvedAt: state.batchState === "approved" ? NOW : null, approvalHash: state.batchState === "approved" ? hash("8") : null, rejectedBy: null, rejectedAt: null, rejectionReason: null, pauseReason: state.batchState === "paused" ? "人工暂停" : null, createdBy: "reviewer-fixture", createdAt: NOW, updatedBy: "reviewer-fixture", updatedAt: NOW });
const latestRun = () => ({ id: "run-fixture", status: "partial_success", updatedAt: NOW, completedAt: NOW, evidenceCount: 3, consumedBudget: { requests: 1, results: 3, durationSeconds: 12 } });

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/healthz") return send(response, { ok: true });
  if (url.pathname === "/__fixture/reset" && request.method === "POST") { reset(); return send(response, { ok: true }); }
  if (url.pathname === "/__fixture/state" && request.method === "GET") return send(response, {
    createdCandidateIds: state.createdCandidateIds,
    activeCandidateIds: state.activeCandidateIds,
    approvedCandidateIds: state.approvedCandidateIds,
    directMessageApprovedCandidateIds: state.directMessageApprovedCandidateIds,
    directMessageDailyLimit: state.directMessageDailyLimit,
    attemptLedger: state.attemptLedger,
    externalWriteCount: 0
  });
  if (url.pathname === "/api/auth/login" && request.method === "POST") return send(response, { user: { id: "user-fixture", name: "默认管理员", email: "admin@example.com", role: "admin", teamId: "team-fixture", avatar: "AD" } }, 200, { "set-cookie": ["gj_session=fixture-session; Path=/; HttpOnly; SameSite=Lax", "gj_csrf=fixture-csrf; Path=/; SameSite=Lax"] });
  if (url.pathname === "/api/auth/logout" && request.method === "POST") return send(response, { ok: true }, 200, { "set-cookie": ["gj_session=; Path=/; Max-Age=0", "gj_csrf=; Path=/; Max-Age=0"] });
  if (!authenticated(request)) return error(response, 401, "unauthorized", "请先登录");
  if (url.pathname === "/api/auth/me") return send(response, { user: { id: "user-fixture", name: "默认管理员", email: "admin@example.com", role: "admin", teamId: "team-fixture", avatar: "AD" } });
  if (!["GET", "HEAD"].includes(request.method ?? "GET") && !writeAuthorized(request)) return error(response, 403, "csrf_invalid", "请求校验失败");
  if (url.pathname === "/api/v1/acquisition/overview") return send(response, { generatedAt: NOW, platform: "douyin", totals: { tasks: state.planCreated ? 1 : 0 }, statusCounts: state.planCreated ? state.runStarted ? { partial_success: 1 } : { not_started: 1 } : {}, discoveryMethodCounts: state.planCreated ? { official_authorized: 1 } : {}, tasks: state.planCreated ? [{ id: "task-fixture", planId: "plan-fixture", name: state.planName, objective: "通过 MediaCrawler 采集抖音公开内容", platform: "douyin", discoveryMethods: ["official_authorized"], planStatus: state.planApproved ? "approved" : "draft", latestRun: state.runStarted ? latestRun() : null, latestResultRunId: state.runStarted ? "run-fixture" : null, updatedAt: NOW }] : [] });
  if (url.pathname === "/api/v1/acquisition/tasks/plan-fixture" && state.planCreated) return send(response, { task: { id: "task-fixture", planId: "plan-fixture", name: state.planName, objective: "通过 MediaCrawler 采集抖音公开内容", platform: "douyin", discoveryMethods: ["official_authorized"], planStatus: state.planApproved ? "approved" : "draft", latestRun: state.runStarted ? latestRun() : null, latestResultRunId: state.runStarted ? "run-fixture" : null, updatedAt: NOW }, plan: { id: "plan-fixture", status: state.planApproved ? "approved" : "draft", version: 1 }, latestRun: state.runStarted ? latestRun() : null, shards: [], presentation: null });
  if (url.pathname === "/api/v1/acquisition/performance") return send(response, { counts: { discovered: 2, highIntent: 2, approved: 0, converted: 0, contacted: 0, quoted: 0, won: 0, lost: 0 }, rates: { highIntentRate: 1, approvalRate: 0, crmConversionRate: 0, contactRate: 0, quoteRate: 0, winRate: 0 }, valuesByCurrency: [], cost: { status: "not_aggregatable", executionCostMinor: null, currency: null, coverage: "recorded_api_execution_only" }, roi: { status: "not_computable", reason: "channel_cost_or_verified_margin_unavailable" }, dataQuality: { missingAttribution: 0, missingFinancial: 2, truncated: false, lastReconciledAt: NOW }, briefingFacts: { headlines: [], risks: [], actions: [], metricIds: [] } });
  if (url.pathname === "/api/v1/acquisition/social-accounts/douyin" && request.method === "GET") return send(response, { items: state.loginPolls > 1 ? [account()] : [] });
  if (url.pathname === "/api/v1/acquisition/social-accounts/douyin/login-sessions" && request.method === "POST") return send(response, { id: "login-fixture", platform: "douyin", state: "awaiting_scan", qrImageDataUrl: TEST_QR_IMAGE_DATA_URL, expiresAt: "2026-08-25T10:30:00.000Z", account: null }, 201);
  if (url.pathname === "/api/v1/acquisition/social-accounts/douyin/login-sessions/login-fixture") { state.loginPolls += 1; const active = state.loginPolls > 1; return send(response, { id: "login-fixture", platform: "douyin", state: active ? "active" : "awaiting_scan", qrImageDataUrl: active ? null : TEST_QR_IMAGE_DATA_URL, expiresAt: "2026-08-25T10:30:00.000Z", account: active ? account() : null }); }
  if (url.pathname === "/api/v1/acquisition/plans" && request.method === "POST") {
    const body = await readBody(request);
    if (body.executionMode !== "douyin_mediacrawler" || body.targetPlatform !== "douyin"
      || !Array.isArray(body.providerConnections) || body.providerConnections.length !== 0
      || !Array.isArray(body.operations) || body.operations.length !== 0
      || "modelConnectionId" in body) return error(response, 400, "invalid_mediacrawler_plan", "MediaCrawler 计划契约无效");
    state.planCreated = true;
    state.planName = typeof body.name === "string" ? body.name : "MediaCrawler 抖音计划";
    return send(response, { id: "plan-fixture", payload: { name: state.planName }, status: "draft", version: 1 }, 201, { ETag: '"plan:1"' });
  }
  if (url.pathname === "/api/v1/acquisition/plans/plan-fixture/approval" && request.method === "POST") {
    state.planApproved = true;
    return send(response, { id: "plan-fixture", payload: { name: state.planName }, status: "approved", version: 1 }, 200, { ETag: '"plan:2"' });
  }
  if (url.pathname === "/api/v1/acquisition/plans/plan-fixture/automation" && request.method === "GET") return send(response, policy());
  if (url.pathname === "/api/v1/acquisition/plans/plan-fixture/automation/keyword-suggestions" && request.method === "POST") return send(response, { keywords: ["工业除尘改造", "工厂节能"], modelSnapshotId: "model-snapshot-public" });
  if (url.pathname === "/api/v1/acquisition/plans/plan-fixture/automation" && request.method === "PUT") { await readBody(request); state.policyRevision += 1; return send(response, policy()); }
  if (url.pathname === "/api/v1/acquisition/plans/plan-fixture/run-now" && request.method === "POST") { state.runStarted = true; return send(response, { id: "intent-fixture", acquisitionRunId: "run-fixture", workspaceId: "workspace-fixture", planId: "plan-fixture", planVersionId: "plan-version-fixture", planVersion: 1, planSnapshotHash: hash("1"), policyVersionId: "policy-fixture", policyHash: hash("2"), accountId: "account-fixture", accountLoginStateVersion: 3, dailyBudgetId: hash("9"), localDate: "2026-08-25", trigger: "run_now", collectCreators: true, collectDemandComments: true, status: "queued", reason: null, createdBy: "user-fixture", createdAt: NOW }, 202); }
  if (url.pathname === "/api/v1/acquisition/runs/run-fixture/crawler-status") { state.runPolls += 1; const running = state.runPolls < 2; return send(response, { runId: "run-fixture", state: running ? "running" : "partial", attempt: 1, cursorPersisted: true, recordCount: running ? 12 : 26, candidateBudgetUsed: running ? 0 : 2, candidateBudgetLimit: 50, candidateProjectionState: running ? "pending" : "ready", lastErrorCode: running ? null : "mediacrawler_partial", createdAt: NOW, updatedAt: NOW, completedAt: running ? null : NOW, activity: { phase: running ? "collecting_comments" : "completed", currentKeyword: running ? "工业除尘" : null, browserMode: "visible", sequence: running ? 4 : 5 } }); }
  if (url.pathname === "/api/v1/acquisition/runs/run-fixture/candidates") return send(response, { items: state.runPolls < 2 ? [] : candidates, nextCursor: null });
  if (url.pathname === "/api/v1/acquisition/outreach-batches" && request.method === "GET") {
    const lookup = {
      runId: url.searchParams.get("runId"),
      candidateId: url.searchParams.get("candidateId"),
      limit: url.searchParams.get("limit")
    };
    state.attemptLedger.push({ kind: "collection", ...lookup });
    const matches = state.batchCreated
      && lookup.runId === "run-fixture"
      && lookup.limit === "1"
      && lookup.candidateId !== null
      && state.activeCandidateIds.includes(lookup.candidateId);
    return send(response, {
      items: matches ? [batch()] : [],
      nextCursor: null
    });
  }
  if (url.pathname === "/api/v1/acquisition/runs/run-fixture/outreach-batches" && request.method === "POST") {
    const body = await readBody(request).catch(() => null);
    const rawCandidateIds = body?.candidateIds;
    const candidateIds = Array.isArray(rawCandidateIds)
      ? rawCandidateIds.filter((candidateId): candidateId is string =>
          typeof candidateId === "string")
      : [];
    const candidateIdsShape = Array.isArray(rawCandidateIds)
      && rawCandidateIds.every((candidateId) => typeof candidateId === "string")
      ? "string_array"
      : "invalid";
    state.attemptLedger.push({
      kind: "create",
      runId: "run-fixture",
      candidateIds,
      candidateIdsShape
    });
    const knownEligible = candidateIdsShape === "string_array"
      && candidateIds.length > 0
      && candidateIds.length === new Set(candidateIds).size
      && candidateIds.every((candidateId) => candidateId !== "candidate-profile"
        && candidates.some((candidate) => candidate.id === candidateId));
    if (!knownEligible) return error(response, 400, "candidate_not_outreach_eligible", "候选人缺少精确视频证据");
    state.batchCreated = true;
    state.activeCandidateIds = [...candidateIds];
    state.createdCandidateIds.push([...candidateIds]);
    state.approvedCandidateIds = [];
    state.directMessageApprovedCandidateIds = [];
    state.directMessageDailyLimit = null;
    state.directMessageApprovedDrafts = {};
    state.batchRevision = 1;
    state.batchState = "awaiting_approval";
    state.approvalConflicted = false;
    state.actionPolls = 0;
    state.drafts = Object.fromEntries(candidateIds.map((candidateId) => [
      candidateId,
      defaultDraft(candidateId)
    ]));
    return send(response, batch(), 201, { ETag: batch().etag });
  }
  if (url.pathname === "/api/v1/acquisition/outreach-batches/batch-fixture" && request.method === "GET" && state.batchCreated) return send(response, batch(), 200, { ETag: batch().etag });
  if (url.pathname === "/api/v1/acquisition/outreach-batches/batch-fixture" && request.method === "PUT" && state.batchCreated) {
    const body = await readBody(request);
    if (!Array.isArray(body.candidates)) return error(response, 400, "invalid_batch_revision", "修订候选人无效");
    const revisions = body.candidates.filter((candidate): candidate is Record<string, unknown> =>
      typeof candidate === "object" && candidate !== null && !Array.isArray(candidate));
    if (revisions.length !== state.activeCandidateIds.length
      || revisions.some((candidate) => typeof candidate.candidateId !== "string"
        || !state.activeCandidateIds.includes(candidate.candidateId)
        || typeof candidate.comment !== "string"
        || typeof candidate.directMessage !== "string")) {
      return error(response, 400, "invalid_batch_revision", "修订候选人无效");
    }
    state.drafts = Object.fromEntries(revisions.map((candidate) => [
      candidate.candidateId as string,
      {
        comment: candidate.comment as string,
        directMessage: candidate.directMessage as string
      }
    ]));
    state.batchRevision += 1;
    return send(response, batch(), 200, { ETag: batch().etag });
  }
  if (url.pathname === "/api/v1/acquisition/outreach-batches/batch-fixture/approve" && request.method === "POST" && state.batchCreated) { if (!state.approvalConflicted) { state.approvalConflicted = true; return error(response, 412, "outreach_batch_stale", "批次修订已变更"); } state.batchState = "approved"; state.approvedCandidateIds = [...state.activeCandidateIds]; return send(response, batch(), 200, { ETag: batch().etag }); }
  if (url.pathname === "/api/v1/acquisition/outreach-batches/batch-fixture/direct-messages/approve" && request.method === "POST" && state.batchCreated) {
    const body = await readBody(request);
    const requested = Array.isArray(body.candidates)
      ? body.candidates.filter((candidate): candidate is Record<string, unknown> =>
          typeof candidate === "object" && candidate !== null
          && !Array.isArray(candidate))
      : [];
    const candidateIds = requested.flatMap((candidate) =>
      typeof candidate.candidateId === "string" ? [candidate.candidateId] : []);
    const dailyLimit = typeof body.dailyLimit === "number" ? body.dailyLimit : null;
    state.attemptLedger.push({
      kind: "direct_message_approve",
      candidateIds,
      dailyLimit
    });
    const valid = state.batchState === "approved"
      && body.batchRevision === state.batchRevision
      && body.batchHash === batch().batchHash
      && body.commentApprovalHash === batch().approvalHash
      && body.confirm === true
      && Number.isInteger(dailyLimit)
      && (dailyLimit ?? 0) >= 1
      && (dailyLimit ?? 0) <= 100
      && requested.length > 0
      && requested.length <= (dailyLimit ?? 0)
      && candidateIds.length === requested.length
      && candidateIds.length === new Set(candidateIds).size
      && state.actionPolls >= 2
      && candidateIds.every((candidateId) =>
        candidateId === state.activeCandidateIds[0])
      && candidateIds.every((candidateId) =>
        state.approvedCandidateIds.includes(candidateId))
      && requested.every((candidate) => typeof candidate.directMessage === "string"
        && candidate.directMessage.length > 0
        && candidate.directMessage.length <= 800);
    if (!valid) {
      return error(response, 400, "invalid_request", "私信审批命令无效");
    }
    state.directMessageApprovedCandidateIds = [...candidateIds];
    state.directMessageDailyLimit = dailyLimit;
    state.directMessageApprovedDrafts = Object.fromEntries(requested.map(
      (candidate) => [
        candidate.candidateId as string,
        candidate.directMessage as string
      ]
    ));
    return send(response, batch(), 200, { ETag: batch().etag });
  }
  if (url.pathname === "/api/v1/acquisition/outreach-batches/batch-fixture/pause" && request.method === "POST") { state.batchState = "paused"; return send(response, batch(), 200, { ETag: batch().etag }); }
  if (url.pathname === "/api/v1/acquisition/outreach-batches/batch-fixture/resume" && request.method === "POST") { state.batchState = "approved"; return send(response, batch(), 200, { ETag: batch().etag }); }
  if (url.pathname === "/api/v1/acquisition/outreach-batches/batch-fixture/actions" && state.batchCreated) {
    if (state.batchState !== "approved") return send(response, { items: [] });
    state.actionPolls += 1;
    const commentSucceeded = state.actionPolls >= 2;
    const candidateId = state.activeCandidateIds[0] ?? "candidate-creator";
    const draft = state.drafts[candidateId] ?? defaultDraft(candidateId);
    const comment = { id: "action-comment", workspaceId: "workspace-fixture", batchId: "batch-fixture", batchRevision: state.batchRevision, candidateId, accountId: "account-fixture", accountLoginStateVersion: 3, policyVersionId: "policy-fixture", localDate: "2026-08-25", kind: "comment", sequence: 1, status: commentSucceeded ? "succeeded" : "queued", predecessorActionId: null, targetPublicUrl: "https://www.douyin.com/video/741234567890", content: draft.comment, contentHash: hash("5"), approvalHash: hash("8"), createdAt: NOW, attemptCount: commentSucceeded ? 1 : 0, platformReceiptReference: commentSucceeded ? "DY-COMMENT-RECEIPT" : null, occurredAt: commentSucceeded ? NOW : null, failureCode: null };
    const directMessages = state.directMessageApprovedCandidateIds.map(
      (approvedCandidateId, index) => {
        const approvedDraft = state.directMessageApprovedDrafts[
          approvedCandidateId
        ] ?? defaultDraft(approvedCandidateId).directMessage;
        return { id: `action-message-${approvedCandidateId}`, workspaceId: "workspace-fixture", batchId: "batch-fixture", batchRevision: state.batchRevision, candidateId: approvedCandidateId, accountId: "account-fixture", accountLoginStateVersion: 3, policyVersionId: "policy-fixture", localDate: "2026-08-25", kind: "direct_message", sequence: 2, status: "queued", predecessorActionId: "action-comment", targetPublicUrl: `https://www.douyin.com/user/${approvedCandidateId}`, content: approvedDraft, contentHash: hash("6"), approvalHash: hash("a"), authorizationVersion: 2, approvedBy: "reviewer-fixture", approvedAt: NOW, directMessageDailyLimit: state.directMessageDailyLimit, directMessageDailyOrdinal: index + 1, createdAt: NOW, attemptCount: 0, platformReceiptReference: null, occurredAt: null, failureCode: null };
      }
    );
    return send(response, { items: [comment, ...directMessages] });
  }
  return error(response, 404, "fixture_route_missing", `${request.method} ${url.pathname}`);
});

server.listen(PORT, "127.0.0.1");
const close = () => server.close(() => process.exit(0));
process.on("SIGINT", close);
process.on("SIGTERM", close);

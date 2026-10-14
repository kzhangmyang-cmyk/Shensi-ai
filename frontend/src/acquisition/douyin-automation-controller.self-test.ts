import { strict as assert } from "node:assert";
import { createDouyinAutomationController } from "./douyin-automation-controller";
import {
  AcquisitionHttpError,
  type DouyinAutomationApi
} from "./douyin-automation-api";

const now = new Date().toISOString();
const activeAccount = { id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const, displayName: "测试账号", state: "active" as const, loginStateVersion: 1, revision: 1, etag: '"account:1"', lastValidatedAt: null, createdAt: now, updatedAt: now };
const defaultPolicy = { id: null, source: "default" as const, workspaceId: "workspace-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", accountId: null, accountLoginStateVersion: null, version: 0, revision: 0, etag: '"policy:0"', policyHash: "hash", keywords: [], schedule: { enabled: false, localTime: "09:30", timeZone: "Asia/Shanghai" }, dailyCandidateLimit: 50, collectCreators: true, collectDemandComments: true, limits: { maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3, maxDurationSeconds: 3600 }, createdBy: null, createdAt: null };
const liveCandidate = { id: "candidate-live-1", status: "comment_candidate", displayName: "袜子采购用户", evidence: { sourceUrl: "https://www.douyin.com/video/live-1", excerpt: "公开评论中询问袜子批发" } };
const profileOnlyCandidate = { id: "candidate-profile-1", status: "creator_candidate", displayName: "内容创作者", evidence: { sourceUrl: "https://www.douyin.com/user/creator-1", excerpt: "公开主页资料" } };
const unusedLoginInteraction = async (): Promise<never> => { throw new Error("not used"); };
const unusedLoginCancellation = async (): Promise<void> => undefined;
const unusedPlanNameSave: DouyinAutomationApi["savePlanName"] = async () => { throw new Error("not used"); };

const controller = createDouyinAutomationController({
  api: {
    savePlanName: unusedPlanNameSave,
    createPlan: async () => ({ id: "plan-1", name: "测试计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "测试计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [] }),
    createLoginSession: async () => ({ id: "login-1", platform: "douyin", state: "awaiting_scan", qrImageDataUrl: "data:image/png;base64,AA==", qrStatus: "ready", loginPage: { imageDataUrl: "data:image/png;base64,UEFHRQ==", width: 800, height: 400 }, failureCode: null, expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null }),
    getLoginSession: async () => ({ id: "login-1", platform: "douyin", state: "active", qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null, expiresAt: new Date(Date.now() + 60_000).toISOString(), account: activeAccount }),
    interactLoginSession: unusedLoginInteraction,
    cancelLoginSession: unusedLoginCancellation,
    disconnectAccount: async () => undefined,
    getAutomation: async () => defaultPolicy,
    suggestKeywords: async () => ({ keywords: ["工业除尘"], modelSnapshotId: "model-1" }),
    putAutomation: async (_planId, input) => ({ ...input, id: "policy-1", source: "version", workspaceId: "workspace-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', policyHash: "hash", createdBy: "user-1", createdAt: new Date().toISOString() }),
    runNow: async () => ({ id: "intent-1", acquisitionRunId: "run-1", workspaceId: "workspace-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", policyVersionId: "policy-1", policyHash: "hash", accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: "budget-1", localDate: "2026-08-25", trigger: "run_now", collectCreators: true, collectDemandComments: true, status: "queued", reason: null, createdBy: "user-1", createdAt: new Date().toISOString() }),
    getCrawlerStatus: async () => ({ runId: "run-1", state: "running", attempt: 1, cursorPersisted: true, recordCount: 8, candidateBudgetUsed: 2, candidateBudgetLimit: 50, candidateProjectionState: "pending", lastErrorCode: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null, activity: { phase: "collecting_comments", currentKeyword: "袜子", browserMode: "visible", sequence: 4 } }),
    listRunCandidates: async () => ({ items: [], nextCursor: null })
  },
  pollDelayMs: 1
});
await controller.load("plan-1");
assert.equal(controller.getState().policy?.dailyCandidateLimit, 50);
const first = controller.runNow();
const second = controller.runNow();
assert.equal(first, second, "run-now must be single-flight");
await first;
controller.close();
assert.equal(controller.getState().closed, true);
console.log(JSON.stringify({ ok: true, suite: "douyin-automation-controller" }));

const calls: string[] = [];
let refreshedPlanId = "";
let failSavedRun = false;
const zeroPlanController = createDouyinAutomationController({
  api: {
    savePlanName: unusedPlanNameSave,
    createPlan: async (input) => { calls.push(`create:${input.name}:${input.keywords.join("|")}`); return { id: "plan-new", name: input.name, status: "draft", version: 1, etag: '"plan:1"' }; },
    approvePlan: async (planId) => { calls.push(`approve:${planId}`); return { id: planId, name: "工业需求计划", status: "approved", version: 1, etag: '"plan:2"' }; },
    listAccounts: async () => { calls.push("accounts"); return { items: [activeAccount] }; },
    createLoginSession: async () => { throw new Error("not used"); },
    getLoginSession: async () => { throw new Error("not used"); },
    interactLoginSession: unusedLoginInteraction,
    cancelLoginSession: unusedLoginCancellation,
    disconnectAccount: async () => undefined,
    getAutomation: async (planId) => { calls.push(`policy:${planId}`); return { ...defaultPolicy, planId }; },
    suggestKeywords: async () => { calls.push("suggest"); return { keywords: ["不应调用"], modelSnapshotId: "model-1" }; },
    putAutomation: async (planId, input) => { calls.push(`save:${planId}:${input.keywords.join("|")}`); return { ...defaultPolicy, ...input, id: "policy-1", source: "version", planId, accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', createdBy: "user-1", createdAt: now }; },
    runNow: async (planId) => { calls.push(`run:${planId}`); if (failSavedRun) throw new Error("desktop_login_identity_unavailable"); return { id: "intent-1", acquisitionRunId: "run-1", workspaceId: "workspace-1", planId, planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", policyVersionId: "policy-1", policyHash: "hash", accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: "budget-1", localDate: "2026-08-25", trigger: "run_now", collectCreators: true, collectDemandComments: true, status: "queued", reason: null, createdBy: "user-1", createdAt: now }; },
    getCrawlerStatus: async () => ({ runId: "run-1", state: "succeeded", attempt: 1, cursorPersisted: true, recordCount: 0, candidateBudgetUsed: 0, candidateBudgetLimit: 50, candidateProjectionState: "ready", lastErrorCode: null, createdAt: now, updatedAt: now, completedAt: now, activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 5 } }),
    listRunCandidates: async () => ({ items: [], nextCursor: null })
  },
  onPlanSaved(planId) { refreshedPlanId = planId; },
  pollDelayMs: 1
});
await zeroPlanController.load(null);
assert.equal(zeroPlanController.getState().account?.state, "active");
assert.equal(zeroPlanController.getState().planId, null);
await zeroPlanController.saveAndRun({
  planName: "工业需求计划",
  policy: { ...defaultPolicy, keywords: ["工业除尘", "工厂节能"] }
});
assert.deepEqual(calls.slice(0, 6), [
  "accounts",
  "create:工业需求计划:工业除尘|工厂节能",
  "approve:plan-new",
  "policy:plan-new",
  "save:plan-new:工业除尘|工厂节能",
  "run:plan-new"
]);
assert.equal(calls.includes("suggest"), false, "manual save-and-run must not call AI keyword suggestions");
assert.equal(refreshedPlanId, "plan-new");
assert.equal(zeroPlanController.getState().planName, "工业需求计划");
assert.equal(zeroPlanController.getState().planStatus, "approved");
await zeroPlanController.load(null);
failSavedRun = true;
refreshedPlanId = "";
await zeroPlanController.saveAndRun({ planName: "失败启动", policy: { ...defaultPolicy, keywords: ["工业除尘"] } });
assert.equal(zeroPlanController.getState().phase, "error");
assert.equal(zeroPlanController.getState().crawlerStatus, null);
assert.match(zeroPlanController.getState().error ?? "", /desktop_login_identity_unavailable/u);
assert.equal(refreshedPlanId, "", "failed startup must not refresh overview and restore an old completed run");
zeroPlanController.close();

const scheduledRunPolls: Array<() => void> = [];
let liveCandidateReads = 0;
let liveRunStarts = 0;
let liveCandidateItems = [liveCandidate, profileOnlyCandidate];
const liveCandidateController = createDouyinAutomationController({
  api: {
    savePlanName: unusedPlanNameSave,
    createPlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); },
    getLoginSession: async () => { throw new Error("not used"); },
    interactLoginSession: unusedLoginInteraction,
    cancelLoginSession: unusedLoginCancellation,
    disconnectAccount: async () => undefined,
    getAutomation: async () => ({ ...defaultPolicy, keywords: ["袜子"] }),
    suggestKeywords: async () => ({ keywords: ["袜子"], modelSnapshotId: "model-1" }),
    putAutomation: async (_planId, input) => ({ ...defaultPolicy, ...input, id: "policy-1", source: "version", accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', createdBy: "user-1", createdAt: now }),
    runNow: async () => { liveRunStarts += 1; return { id: "intent-live-1", acquisitionRunId: "run-live-1", workspaceId: "workspace-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", policyVersionId: "policy-1", policyHash: "hash", accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: "budget-1", localDate: "2026-08-25", trigger: "run_now", collectCreators: true, collectDemandComments: true, status: "queued", reason: null, createdBy: "user-1", createdAt: now }; },
    getCrawlerStatus: async () => ({ runId: "run-live-1", state: "running", attempt: 1, cursorPersisted: true, recordCount: 25, candidateBudgetUsed: 1, candidateBudgetLimit: 50, candidateProjectionState: "pending", lastErrorCode: null, createdAt: now, updatedAt: now, completedAt: null, activity: { phase: "collecting_comments", currentKeyword: "袜子", browserMode: "visible", sequence: 4 } }),
    listRunCandidates: async () => {
      liveCandidateReads += 1;
      return { items: liveCandidateItems, nextCursor: null };
    }
  },
  pollDelayMs: 250,
  setTimer: ((callback: unknown, delay?: number) => {
    assert.equal(delay, 250);
    assert.equal(typeof callback, "function");
    scheduledRunPolls.push(callback as () => void);
    return 1;
  }) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await liveCandidateController.load("plan-1", "袜子获客计划");
await liveCandidateController.runNow();
assert.equal(liveCandidateController.getState().crawlerStatus?.state, "running");
await liveCandidateController.runNow();
assert.equal(liveRunStarts, 1, "a non-terminal crawler status must block direct duplicate launches");
assert.deepEqual(liveCandidateController.getState().candidates, [liveCandidate, profileOnlyCandidate]);
liveCandidateController.toggleCandidate(profileOnlyCandidate.id);
assert.deepEqual(liveCandidateController.getState().selectedCandidateIds, [],
  "a profile-only candidate must not enter a comment-then-message approval batch");
liveCandidateController.toggleCandidate(liveCandidate.id);
assert.deepEqual(liveCandidateController.getState().selectedCandidateIds, [liveCandidate.id]);
liveCandidateController.selectAllCandidates(false);
assert.deepEqual(liveCandidateController.getState().selectedCandidateIds, []);
liveCandidateController.selectAllCandidates(true);
liveCandidateController.selectAllCandidates(true);
assert.deepEqual(liveCandidateController.getState().selectedCandidateIds, [liveCandidate.id], "bulk selection skips profile-only candidates and is idempotent");
assert.equal(liveRunStarts, 1, "selection must not start collection");
assert.equal(liveCandidateReads, 1);
assert.equal(scheduledRunPolls.length, 1, "running crawl must schedule another poll after publishing candidates");
scheduledRunPolls.shift()?.();
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.equal(liveCandidateReads, 2, "scheduled polling must continue while candidates are already visible");
assert.equal(scheduledRunPolls.length, 1, "each running refresh must schedule the next poll");
liveCandidateItems = [profileOnlyCandidate];
await liveCandidateController.refreshRun();
assert.deepEqual(liveCandidateController.getState().selectedCandidateIds, [], "refresh removes no-longer-present selections");
liveCandidateController.close();

const failedPollTimers: Array<() => void> = [];
let failedPollRunStarts = 0;
const failedPollController = createDouyinAutomationController({
  api: {
    savePlanName: unusedPlanNameSave,
    createPlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); },
    getLoginSession: async () => { throw new Error("not used"); },
    interactLoginSession: unusedLoginInteraction,
    cancelLoginSession: unusedLoginCancellation,
    disconnectAccount: async () => undefined,
    getAutomation: async () => ({ ...defaultPolicy, keywords: ["袜子"] }),
    suggestKeywords: async () => ({ keywords: ["袜子"], modelSnapshotId: "model-1" }),
    putAutomation: async (_planId, input) => ({ ...defaultPolicy, ...input, id: "policy-1", source: "version", accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', createdBy: "user-1", createdAt: now }),
    runNow: async () => { failedPollRunStarts += 1; return { id: "intent-failed-poll", acquisitionRunId: "run-failed-poll", workspaceId: "workspace-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", policyVersionId: "policy-1", policyHash: "hash", accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: "budget-1", localDate: "2026-08-25", trigger: "run_now", collectCreators: true, collectDemandComments: true, status: "queued", reason: null, createdBy: "user-1", createdAt: now }; },
    getCrawlerStatus: async () => { throw new Error("status timeout"); },
    listRunCandidates: async () => ({ items: [], nextCursor: null })
  },
  pollDelayMs: 250,
  setTimer: ((callback: unknown, delay?: number) => {
    assert.equal(delay, 250);
    failedPollTimers.push(callback as () => void);
    return 1;
  }) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await failedPollController.load("plan-1", "袜子获客计划");
await failedPollController.runNow();
assert.equal(failedPollController.getState().runIntent?.acquisitionRunId, "run-failed-poll");
assert.equal(failedPollController.getState().crawlerStatus, null);
assert.equal(failedPollTimers.length, 1, "a non-abort first-poll failure must schedule a status retry");
await failedPollController.runNow();
assert.equal(failedPollRunStarts, 1, "an outstanding run intent must block a second direct launch after first-poll failure");
failedPollController.close();

const runningStatus = (runId: string) => ({ runId, state: "running" as const, attempt: 1, cursorPersisted: true, recordCount: 1, candidateBudgetUsed: 1, candidateBudgetLimit: 50, candidateProjectionState: "pending" as const, lastErrorCode: null, createdAt: now, updatedAt: now, completedAt: null, activity: { phase: "collecting_comments" as const, currentKeyword: "袜子", browserMode: "visible" as const, sequence: 4 } });
const queuedIntent = (id: string, acquisitionRunId: string) => ({ id, acquisitionRunId, workspaceId: "workspace-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", policyVersionId: "policy-1", policyHash: "hash", accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: "budget-1", localDate: "2026-08-25", trigger: "run_now" as const, collectCreators: true, collectDemandComments: true, status: "queued" as const, reason: null, createdBy: "user-1", createdAt: now });

const scheduledCallbacks = new Map<number, () => void>();
const clearedRunTimers: number[] = [];
let nextRunTimer = 0;
let scheduledStatusReads = 0;
const secondStatusGate: { resolve: (() => void) | null } = { resolve: null };
const scheduledRefreshController = createDouyinAutomationController({
  api: {
    savePlanName: unusedPlanNameSave,
    createPlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); }, getLoginSession: async () => { throw new Error("not used"); }, interactLoginSession: unusedLoginInteraction, cancelLoginSession: unusedLoginCancellation, disconnectAccount: async () => undefined,
    getAutomation: async () => ({ ...defaultPolicy, keywords: ["袜子"] }), suggestKeywords: async () => ({ keywords: ["袜子"], modelSnapshotId: "model-1" }),
    putAutomation: async (_planId, input) => ({ ...defaultPolicy, ...input, id: "policy-1", source: "version", accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', createdBy: "user-1", createdAt: now }),
    runNow: async () => queuedIntent("intent-scheduled", "run-scheduled"),
    getCrawlerStatus: async () => {
      scheduledStatusReads += 1;
      if (scheduledStatusReads === 2) await new Promise<void>((resolve) => { secondStatusGate.resolve = resolve; });
      return runningStatus("run-scheduled");
    },
    listRunCandidates: async () => ({ items: [], nextCursor: null })
  },
  pollDelayMs: 250,
  setTimer: ((callback: unknown) => {
    const id = ++nextRunTimer;
    scheduledCallbacks.set(id, callback as () => void);
    return id;
  }) as unknown as typeof setTimeout,
  clearTimer: ((timer: number) => { clearedRunTimers.push(timer); scheduledCallbacks.delete(timer); }) as unknown as typeof clearTimeout
});
await scheduledRefreshController.load("plan-1", "袜子获客计划");
await scheduledRefreshController.runNow();
const staleScheduledCallback = scheduledCallbacks.get(1)!;
assert.equal(scheduledCallbacks.size, 1);
const manualRefresh = scheduledRefreshController.refreshRun();
await Promise.resolve();
assert.equal(scheduledStatusReads, 2);
assert.deepEqual(clearedRunTimers, [1], "manual refresh must clear the pending status timer");
staleScheduledCallback();
await Promise.resolve();
assert.equal(scheduledStatusReads, 2, "a stale scheduled callback must join the active refresh instead of polling again");
const resumeSecondStatus = secondStatusGate.resolve;
assert.ok(resumeSecondStatus);
resumeSecondStatus();
await manualRefresh;
assert.equal(scheduledCallbacks.size, 1, "one current run may retain only one continuing poll timer");
scheduledRefreshController.close();

let staleRunStarts = 0;
const staleStatusController = createDouyinAutomationController({
  api: {
    savePlanName: unusedPlanNameSave,
    createPlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); }, getLoginSession: async () => { throw new Error("not used"); }, interactLoginSession: unusedLoginInteraction, cancelLoginSession: unusedLoginCancellation, disconnectAccount: async () => undefined,
    getAutomation: async () => ({ ...defaultPolicy, keywords: ["袜子"] }), suggestKeywords: async () => ({ keywords: ["袜子"], modelSnapshotId: "model-1" }),
    putAutomation: async (_planId, input) => ({ ...defaultPolicy, ...input, id: "policy-1", source: "version", accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', createdBy: "user-1", createdAt: now }),
    runNow: async () => { staleRunStarts += 1; return queuedIntent(`intent-${staleRunStarts}`, staleRunStarts === 1 ? "run-old" : "run-new"); },
    getCrawlerStatus: async (runId) => {
      if (runId === "run-old") return { ...runningStatus(runId), state: "succeeded" as const, candidateProjectionState: "ready" as const, completedAt: now, activity: { phase: "completed" as const, currentKeyword: null, browserMode: "headless" as const, sequence: 5 } };
      throw new Error("status timeout");
    },
    listRunCandidates: async () => ({ items: [liveCandidate], nextCursor: null })
  },
  pollDelayMs: 250,
  setTimer: (() => 1) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await staleStatusController.load("plan-1", "袜子获客计划");
await staleStatusController.runNow();
assert.equal(staleStatusController.getState().crawlerStatus?.state, "succeeded");
staleStatusController.toggleCandidate(liveCandidate.id);
await staleStatusController.runNow();
assert.equal(staleStatusController.getState().runIntent?.acquisitionRunId, "run-new");
assert.equal(staleStatusController.getState().crawlerStatus, null);
assert.deepEqual(staleStatusController.getState().candidates, []);
assert.deepEqual(staleStatusController.getState().selectedCandidateIds, []);
await staleStatusController.runNow();
assert.equal(staleRunStarts, 2, "a failed first poll for a new run must not allow a third launch");
staleStatusController.close();

const terminalPendingPolls: Array<() => void> = [];
let terminalPendingRunStarts = 0;
let terminalPendingStatusReads = 0;
const terminalPendingController = createDouyinAutomationController({
  api: {
    savePlanName: unusedPlanNameSave,
    createPlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); }, getLoginSession: async () => { throw new Error("not used"); }, interactLoginSession: unusedLoginInteraction, cancelLoginSession: unusedLoginCancellation, disconnectAccount: async () => undefined,
    getAutomation: async () => ({ ...defaultPolicy, keywords: ["袜子"] }), suggestKeywords: async () => ({ keywords: ["袜子"], modelSnapshotId: "model-1" }),
    putAutomation: async (_planId, input) => ({ ...defaultPolicy, ...input, id: "policy-1", source: "version", accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', createdBy: "user-1", createdAt: now }),
    runNow: async () => { terminalPendingRunStarts += 1; return queuedIntent("intent-terminal-pending", "run-terminal-pending"); },
    getCrawlerStatus: async () => {
      terminalPendingStatusReads += 1;
      return {
        ...runningStatus("run-terminal-pending"), state: "succeeded" as const,
        completedAt: now, candidateProjectionState: terminalPendingStatusReads === 1 ? "pending" as const : "ready" as const,
        activity: { phase: "completed" as const, currentKeyword: null, browserMode: "headless" as const, sequence: 5 }
      };
    },
    listRunCandidates: async () => ({ items: [], nextCursor: null })
  },
  pollDelayMs: 250,
  setTimer: ((callback: unknown) => { terminalPendingPolls.push(callback as () => void); return terminalPendingPolls.length; }) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await terminalPendingController.load("plan-1", "袜子获客计划");
await terminalPendingController.runNow();
assert.equal(terminalPendingController.getState().crawlerStatus?.candidateProjectionState, "pending");
assert.equal(terminalPendingPolls.length, 1, "a terminal crawl with pending candidate ingestion must continue polling");
await terminalPendingController.runNow();
assert.equal(terminalPendingRunStarts, 1, "a terminal crawl with pending candidate ingestion must block duplicate launches");
terminalPendingPolls.shift()?.();
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.equal(terminalPendingController.getState().crawlerStatus?.candidateProjectionState, "ready");
assert.equal(terminalPendingController.getState().candidates.length, 0, "a ready terminal run may legitimately have no candidates");
assert.equal(terminalPendingPolls.length, 0, "a ready candidate projection must stop polling");
terminalPendingController.close();

const readyStatusGate: { resolve: (() => void) | null } = { resolve: null };
let readyCandidateReads = 0;
const orderedReadyController = createDouyinAutomationController({
  api: {
    savePlanName: unusedPlanNameSave,
    createPlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); }, getLoginSession: async () => { throw new Error("not used"); }, interactLoginSession: unusedLoginInteraction, cancelLoginSession: unusedLoginCancellation, disconnectAccount: async () => undefined,
    getAutomation: async () => ({ ...defaultPolicy, keywords: ["袜子"] }), suggestKeywords: async () => ({ keywords: ["袜子"], modelSnapshotId: "model-1" }),
    putAutomation: async (_planId, input) => ({ ...defaultPolicy, ...input, id: "policy-1", source: "version", accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', createdBy: "user-1", createdAt: now }),
    runNow: async () => queuedIntent("intent-ordered-ready", "run-ordered-ready"),
    getCrawlerStatus: async () => {
      await new Promise<void>((resolve) => { readyStatusGate.resolve = resolve; });
      return {
        ...runningStatus("run-ordered-ready"), state: "succeeded" as const,
        candidateProjectionState: "ready" as const, completedAt: now,
        activity: { phase: "completed" as const, currentKeyword: null, browserMode: "headless" as const, sequence: 5 }
      };
    },
    listRunCandidates: async () => { readyCandidateReads += 1; return { items: [liveCandidate], nextCursor: null }; }
  },
  pollDelayMs: 250,
  setTimer: (() => 1) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await orderedReadyController.load("plan-1", "袜子获客计划");
const orderedReadyRun = orderedReadyController.runNow();
await Promise.resolve();
assert.equal(readyCandidateReads, 0, "candidate reads must wait for the crawler status ordering boundary");
const releaseReadyStatus = readyStatusGate.resolve;
assert.ok(releaseReadyStatus);
releaseReadyStatus();
await orderedReadyRun;
assert.equal(readyCandidateReads, 1);
assert.deepEqual(orderedReadyController.getState().candidates, [liveCandidate], "a ready status must load the candidates read after it");
orderedReadyController.close();

const terminalCandidateFailureTimers: Array<{ callback: () => void; delay: number }> = [];
let terminalCandidateReads = 0;
const terminalCandidateFailureController = createDouyinAutomationController({
  api: {
    savePlanName: unusedPlanNameSave,
    createPlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); }, getLoginSession: async () => { throw new Error("not used"); }, interactLoginSession: unusedLoginInteraction, cancelLoginSession: unusedLoginCancellation, disconnectAccount: async () => undefined,
    getAutomation: async () => ({ ...defaultPolicy, keywords: ["袜子"] }), suggestKeywords: async () => ({ keywords: ["袜子"], modelSnapshotId: "model-1" }),
    putAutomation: async (_planId, input) => ({ ...defaultPolicy, ...input, id: "policy-1", source: "version", accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', createdBy: "user-1", createdAt: now }),
    runNow: async () => queuedIntent("intent-terminal-candidate-failure", "run-terminal-candidate-failure"),
    getCrawlerStatus: async () => ({
      ...runningStatus("run-terminal-candidate-failure"), state: "succeeded" as const,
      candidateProjectionState: "ready" as const, completedAt: now,
      activity: { phase: "completed" as const, currentKeyword: null, browserMode: "headless" as const, sequence: 5 }
    }),
    listRunCandidates: async () => {
      terminalCandidateReads += 1;
      if (terminalCandidateReads === 1) throw new Error("candidate read failed");
      return { items: [liveCandidate], nextCursor: null };
    }
  },
  pollDelayMs: 250,
  setTimer: ((callback: unknown, delay?: number) => {
    terminalCandidateFailureTimers.push({
      callback: callback as () => void,
      delay: delay ?? 0
    });
    return terminalCandidateFailureTimers.length;
  }) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await terminalCandidateFailureController.load("plan-1", "袜子获客计划");
await terminalCandidateFailureController.runNow();
assert.equal(terminalCandidateFailureController.getState().crawlerStatus?.state, "succeeded", "a validated terminal status must survive a candidate-read failure");
assert.match(terminalCandidateFailureController.getState().error ?? "", /candidate read failed/u);
assert.equal(terminalCandidateFailureTimers.length, 1, "a transient terminal candidate failure must schedule a bounded retry");
assert.equal(terminalCandidateFailureTimers[0]?.delay, 250);
terminalCandidateFailureTimers.shift()?.callback();
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.deepEqual(terminalCandidateFailureController.getState().candidates, [liveCandidate]);
assert.equal(terminalCandidateFailureController.getState().error, null);
assert.equal(terminalCandidateFailureTimers.length, 0, "a successful retry must stop terminal candidate polling");
terminalCandidateFailureController.close();

const exhaustedCandidateTimers: Array<{ callback: () => void; delay: number }> = [];
let exhaustedCandidateReads = 0;
const exhaustedCandidateController = createDouyinAutomationController({
  api: {
    savePlanName: unusedPlanNameSave,
    createPlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); }, getLoginSession: async () => { throw new Error("not used"); }, interactLoginSession: unusedLoginInteraction, cancelLoginSession: unusedLoginCancellation, disconnectAccount: async () => undefined,
    getAutomation: async () => ({ ...defaultPolicy, keywords: ["袜子"] }), suggestKeywords: async () => ({ keywords: ["袜子"], modelSnapshotId: "model-1" }),
    putAutomation: async (_planId, input) => ({ ...defaultPolicy, ...input, id: "policy-1", source: "version", accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', createdBy: "user-1", createdAt: now }),
    runNow: async () => queuedIntent("intent-exhausted-candidates", "run-exhausted-candidates"),
    getCrawlerStatus: async () => ({
      ...runningStatus("run-exhausted-candidates"), state: "failed" as const,
      candidateProjectionState: "ready" as const, completedAt: now
    }),
    listRunCandidates: async () => {
      exhaustedCandidateReads += 1;
      throw new Error("candidate read remains unavailable");
    }
  },
  pollDelayMs: 250,
  terminalCandidateRetryLimit: 2,
  setTimer: ((callback: unknown, delay?: number) => {
    exhaustedCandidateTimers.push({ callback: callback as () => void, delay: delay ?? 0 });
    return exhaustedCandidateTimers.length;
  }) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await exhaustedCandidateController.load("plan-1", "袜子获客计划");
await exhaustedCandidateController.runNow();
const firstExhaustedRetry = exhaustedCandidateTimers.shift();
assert.equal(firstExhaustedRetry?.delay, 250);
firstExhaustedRetry?.callback();
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
const secondExhaustedRetry = exhaustedCandidateTimers.shift();
assert.equal(secondExhaustedRetry?.delay, 500);
secondExhaustedRetry?.callback();
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.equal(exhaustedCandidateReads, 3);
assert.equal(exhaustedCandidateTimers.length, 0, "terminal candidate retries must stop at the configured bound");
assert.equal(exhaustedCandidateController.getState().crawlerStatus?.state, "failed");
exhaustedCandidateController.close();

const recoveredRunStatusReads: string[] = [];
const recoveredRunCandidateReads: string[] = [];
const recoveredRunController = createDouyinAutomationController({
  api: {
    savePlanName: unusedPlanNameSave,
    createPlan: async () => ({ id: "plan-recovered", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-recovered", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); },
    getLoginSession: async () => { throw new Error("not used"); },
    interactLoginSession: unusedLoginInteraction,
    cancelLoginSession: unusedLoginCancellation,
    disconnectAccount: async () => undefined,
    getAutomation: async () => ({ ...defaultPolicy, planId: "plan-recovered", keywords: ["袜子"] }),
    suggestKeywords: async () => ({ keywords: ["袜子"], modelSnapshotId: "model-1" }),
    putAutomation: async (_planId, input) => ({ ...defaultPolicy, ...input, id: "policy-recovered", source: "version", planId: "plan-recovered", accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', createdBy: "user-1", createdAt: now }),
    runNow: async () => queuedIntent("intent-unexpected", "run-unexpected"),
    getCrawlerStatus: async (runId) => {
      recoveredRunStatusReads.push(runId);
      return {
        runId,
        state: "partial" as const,
        attempt: 4,
        cursorPersisted: true,
        recordCount: 64,
        candidateBudgetUsed: 50,
        candidateBudgetLimit: 50,
        candidateProjectionState: "ready" as const,
        lastErrorCode: "mediacrawler_partial",
        createdAt: now,
        updatedAt: now,
        completedAt: now,
        activity: { phase: "completed" as const, currentKeyword: null, browserMode: "headless" as const, sequence: 1 }
      };
    },
    listRunCandidates: async (runId) => {
      recoveredRunCandidateReads.push(runId);
      return { items: [liveCandidate], nextCursor: null };
    }
  },
  pollDelayMs: 250,
  setTimer: (() => 1) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await recoveredRunController.load("plan-recovered", "袜子获客计划", "run-recovered");
assert.deepEqual(
  recoveredRunStatusReads,
  ["run-recovered"],
  "loading a plan with a latest run must restore that run's crawler status"
);
assert.deepEqual(
  recoveredRunCandidateReads,
  ["run-recovered"],
  "loading a plan with a latest run must restore its persisted candidates"
);
assert.equal(recoveredRunController.getState().activeRunId, "run-recovered");
assert.equal(recoveredRunController.getState().crawlerStatus?.state, "partial");
assert.deepEqual(recoveredRunController.getState().candidates, [liveCandidate]);
await recoveredRunController.refreshRun();
assert.deepEqual(
  recoveredRunStatusReads,
  ["run-recovered", "run-recovered"],
  "manual refresh must use the restored active run even without a newly-created run intent"
);
await recoveredRunController.load(null, undefined, "run-stale-without-plan");
assert.equal(recoveredRunController.getState().activeRunId, null);
assert.deepEqual(
  recoveredRunStatusReads,
  ["run-recovered", "run-recovered"],
  "a run id without its owning plan must never be restored"
);
recoveredRunController.close();

const historicalRunStatusReads: string[] = [];
const historicalRunCandidateReads: string[] = [];
const historicalRunTimers: Array<() => void> = [];
const historicalRunController = createDouyinAutomationController({
  api: {
    savePlanName: unusedPlanNameSave,
    createPlan: async () => ({ id: "plan-historical", name: "历史展示", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-historical", name: "历史展示", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [] }),
    createLoginSession: async () => { throw new Error("not used"); },
    getLoginSession: async () => { throw new Error("not used"); },
    interactLoginSession: unusedLoginInteraction,
    cancelLoginSession: unusedLoginCancellation,
    disconnectAccount: async () => undefined,
    getAutomation: async () => ({ ...defaultPolicy, planId: "plan-historical", keywords: ["工业除尘"] }),
    suggestKeywords: async () => ({ keywords: ["工业除尘"], modelSnapshotId: "model-1" }),
    putAutomation: async (_planId, input) => ({ ...defaultPolicy, ...input, id: "policy-historical", source: "version", planId: "plan-historical", accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', createdBy: "user-1", createdAt: now }),
    runNow: async () => queuedIntent("intent-unexpected", "run-unexpected"),
    getCrawlerStatus: async (runId) => {
      historicalRunStatusReads.push(runId);
      throw new AcquisitionHttpError(
        404,
        "crawler_status_not_found",
        "crawler_status_not_found"
      );
    },
    listRunCandidates: async (runId) => {
      historicalRunCandidateReads.push(runId);
      return { items: [liveCandidate], nextCursor: null };
    }
  },
  pollDelayMs: 250,
  setTimer: ((callback: unknown) => {
    historicalRunTimers.push(callback as () => void);
    return historicalRunTimers.length;
  }) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await historicalRunController.load(
  "plan-historical",
  "历史展示",
  "run-historical"
);
assert.equal(historicalRunController.getState().phase, "ready");
assert.equal(historicalRunController.getState().error, null);
assert.equal(historicalRunController.getState().activeRunId, "run-historical");
assert.equal(historicalRunController.getState().crawlerStatus, null);
assert.equal(historicalRunController.getState().historicalRun, true);
assert.deepEqual(historicalRunController.getState().candidates, [liveCandidate]);
assert.deepEqual(historicalRunStatusReads, ["run-historical"]);
assert.deepEqual(historicalRunCandidateReads, ["run-historical"]);
assert.equal(
  historicalRunTimers.length,
  0,
  "a persisted historical run without a crawler job must not start an infinite status poll"
);
historicalRunController.close();

let recoveredUnknownStatusRunStarts = 0;
const recoveredUnknownStatusController = createDouyinAutomationController({
  api: {
    savePlanName: unusedPlanNameSave,
    createPlan: async () => ({ id: "plan-recovered", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-recovered", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); },
    getLoginSession: async () => { throw new Error("not used"); },
    interactLoginSession: unusedLoginInteraction,
    cancelLoginSession: unusedLoginCancellation,
    disconnectAccount: async () => undefined,
    getAutomation: async () => ({ ...defaultPolicy, planId: "plan-recovered", keywords: ["袜子"] }),
    suggestKeywords: async () => ({ keywords: ["袜子"], modelSnapshotId: "model-1" }),
    putAutomation: async (_planId, input) => ({ ...defaultPolicy, ...input, id: "policy-recovered", source: "version", planId: "plan-recovered", accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', createdBy: "user-1", createdAt: now }),
    runNow: async () => {
      recoveredUnknownStatusRunStarts += 1;
      return queuedIntent("intent-duplicate", "run-duplicate");
    },
    getCrawlerStatus: async () => { throw new Error("status temporarily unavailable"); },
    listRunCandidates: async () => ({ items: [], nextCursor: null })
  },
  pollDelayMs: 250,
  setTimer: (() => 1) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await recoveredUnknownStatusController.load("plan-recovered", "袜子获客计划", "run-recovered-unknown");
assert.equal(recoveredUnknownStatusController.getState().activeRunId, "run-recovered-unknown");
await recoveredUnknownStatusController.runNow();
assert.equal(
  recoveredUnknownStatusRunStarts,
  0,
  "a restored run without an observed status must block duplicate direct launches"
);
recoveredUnknownStatusController.close();

const loginTestApi = (
  overrides: Partial<DouyinAutomationApi>
): DouyinAutomationApi => ({
  savePlanName: unusedPlanNameSave,
  createPlan: async () => ({ id: "plan-login", name: "登录测试", status: "draft", version: 1, etag: '"plan:1"' }),
  approvePlan: async () => ({ id: "plan-login", name: "登录测试", status: "approved", version: 1, etag: '"plan:2"' }),
  listAccounts: async () => ({ items: [] }),
  createLoginSession: async () => ({
    id: "login-test", platform: "douyin", state: "awaiting_scan",
    qrImageDataUrl: "data:image/png;base64,AA==", qrStatus: "ready",
    loginPage: { imageDataUrl: "data:image/png;base64,UEFHRV8w", width: 800, height: 400 },
    failureCode: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
  }),
  getLoginSession: async () => ({
    id: "login-test", platform: "douyin", state: "active",
    qrImageDataUrl: null, qrStatus: null,
    loginPage: null,
    failureCode: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), account: activeAccount
  }),
  interactLoginSession: async () => ({
    id: "login-test", platform: "douyin", state: "awaiting_scan",
    qrImageDataUrl: "data:image/png;base64,AA==", qrStatus: "ready",
    loginPage: { imageDataUrl: "data:image/png;base64,UEFHRV8x", width: 800, height: 400 },
    failureCode: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
  }),
  cancelLoginSession: unusedLoginCancellation,
  disconnectAccount: async () => undefined,
  getAutomation: async () => defaultPolicy,
  suggestKeywords: async () => ({ keywords: ["工业除尘"], modelSnapshotId: "model-1" }),
  putAutomation: async (_planId, input) => ({
    ...defaultPolicy, ...input, id: "policy-login", source: "version",
    accountId: "account-1", accountLoginStateVersion: 1,
    version: 1, revision: 1, etag: '"policy:1"',
    createdBy: "user-1", createdAt: now
  }),
  runNow: async () => queuedIntent("intent-login", "run-login"),
  getCrawlerStatus: async () => runningStatus("run-login"),
  listRunCandidates: async () => ({ items: [], nextCursor: null }),
  ...overrides
});

{
  const remoteDisconnect = createDouyinAutomationController({ api: loginTestApi({
    cancelLoginSession: async () => { throw Error("remote_session_already_revoked"); }
  }) });
  await remoteDisconnect.connect();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(remoteDisconnect.getState().account?.id, activeAccount.id);
  await remoteDisconnect.disconnect();
  assert.equal(remoteDisconnect.getState().account, null);
  assert.equal(remoteDisconnect.getState().error, null,
    "Web disconnect must not append a second delete to its Backend-owned session lifecycle");
  remoteDisconnect.close();
}
const loginInternalError = () => new AcquisitionHttpError(
  500,
  "internal_error",
  "internal_error"
);

let finishScannedLoginPoll!: (
  session: Awaited<ReturnType<DouyinAutomationApi["getLoginSession"]>>
) => void;
const scannedLoginPoll = new Promise<
Awaited<ReturnType<DouyinAutomationApi["getLoginSession"]>>
>((resolve) => { finishScannedLoginPoll = resolve; });
let scannedLoginPollReads = 0;
const scannedLoginTimers: Array<() => void> = [];
const scannedLoginController = createDouyinAutomationController({
  api: loginTestApi({
    getLoginSession: async () => {
      scannedLoginPollReads += 1;
      return scannedLoginPoll;
    }
  }),
  setTimer: ((callback: () => void) => {
    scannedLoginTimers.push(callback);
    return scannedLoginTimers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await scannedLoginController.connect();
assert.equal(scannedLoginPollReads, 1,
  "opening the live surface must immediately begin binding-state polling");
finishScannedLoginPoll({
  id: "login-test", platform: "douyin", state: "active",
  qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), account: activeAccount
});
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.deepEqual({
  sessionState: scannedLoginController.getState().loginSession?.state,
  accountState: scannedLoginController.getState().account?.state,
  scheduledPolls: scannedLoginTimers.length
}, {
  sessionState: "active",
  accountState: "active",
  scheduledPolls: 0
}, "a scanned session must finish binding without another login-window action");
scannedLoginController.close();

let pendingLoginCalls = 0;
let finishPendingLogin!: (session: Awaited<ReturnType<DouyinAutomationApi["createLoginSession"]>>) => void;
const pendingLogin = new Promise<Awaited<ReturnType<DouyinAutomationApi["createLoginSession"]>>>((resolve) => {
  finishPendingLogin = resolve;
});
const singleFlightLoginController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async () => {
      pendingLoginCalls += 1;
      return pendingLogin;
    }
  })
});
const firstPendingConnect = singleFlightLoginController.connect();
const secondPendingConnect = singleFlightLoginController.connect();
assert.equal(pendingLoginCalls, 1,
  "repeated reconnect clicks must reuse the pending login request");
assert.equal(singleFlightLoginController.getState().connectionPending, true);
finishPendingLogin({
  id: "login-single-flight", platform: "douyin", state: "awaiting_scan",
  qrImageDataUrl: "data:image/png;base64,AA==", qrStatus: "ready" as const,
  loginPage: { imageDataUrl: "data:image/png;base64,UEFHRV8w", width: 800, height: 400 },
  failureCode: null,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
});
await Promise.all([firstPendingConnect, secondPendingConnect]);
assert.equal(singleFlightLoginController.getState().connectionPending, false);
singleFlightLoginController.close();

let openingSessionCreateCalls = 0;
const openingSessionController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async () => {
      openingSessionCreateCalls += 1;
      return {
        id: "login-opening", platform: "douyin", state: "awaiting_scan" as const,
        qrImageDataUrl: null, qrStatus: "opening" as const, loginPage: null,
        failureCode: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
      };
    },
    getLoginSession: async () => new Promise<never>(() => undefined)
  })
});
await openingSessionController.connect();
await openingSessionController.connect();
assert.equal(openingSessionCreateCalls, 1,
  "an opening login session must reject a second create request after the first response");
openingSessionController.close();

let externalSessionCreateCalls = 0;
let externalSessionCancelCalls = 0;
const externalSessionController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async () => {
      externalSessionCreateCalls += 1;
      return {
        id: "login-external", platform: "douyin", state: "awaiting_scan" as const,
        interactionSurface: "external_window" as const,
        runtimeState: "running" as const,
        authState: "waiting_for_user" as const,
        taskState: "idle" as const,
        diagnostic: null,
        screenshotAvailable: false,
        qrAvailable: false,
        qrImageDataUrl: null, qrStatus: null, loginPage: null,
        failureCode: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
      };
    },
    getLoginSession: async () => new Promise<never>(() => undefined),
    cancelLoginSession: async () => { externalSessionCancelCalls += 1; }
  })
});
await externalSessionController.connect();
await externalSessionController.connect();
assert.equal(externalSessionCreateCalls, 1,
  "an active external-window login must not send a duplicate create request");
assert.equal(externalSessionCancelCalls, 0,
  "a repeated external-window connect must not cancel its operable browser");
externalSessionController.close();

let resolveStaleLoginCreate!: (
  session: Awaited<ReturnType<DouyinAutomationApi["createLoginSession"]>>
) => void;
const staleLoginCreate = new Promise<
Awaited<ReturnType<DouyinAutomationApi["createLoginSession"]>>
>((resolve) => { resolveStaleLoginCreate = resolve; });
let replacementCreateCalls = 0;
const replacementCreateSignals: AbortSignal[] = [];
const replacementCreateDeletes: string[] = [];
const replacementSessionController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async (_idempotencyKey, signal) => {
      replacementCreateCalls += 1;
      if (signal) replacementCreateSignals.push(signal);
      if (replacementCreateCalls === 1) return staleLoginCreate;
      return {
        id: "login-replacement", platform: "douyin", state: "awaiting_scan" as const,
        qrImageDataUrl: null, qrStatus: "opening" as const, loginPage: null,
        failureCode: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
      };
    },
    getLoginSession: async () => new Promise<never>(() => undefined),
    cancelLoginSession: async (id) => { replacementCreateDeletes.push(id); }
  })
});
const staleConnect = replacementSessionController.connect();
await Promise.resolve();
await replacementSessionController.cancelLogin();
const replacementWhileCleanup = replacementSessionController.connect();
assert.equal(replacementCreateSignals[0]?.aborted, false,
  "a pending create must stay observable until its late session can be deleted");
assert.equal(replacementCreateCalls, 1,
  "replacement must wait for the cancelled create cleanup fence");
resolveStaleLoginCreate({
  id: "login-stale", platform: "douyin", state: "awaiting_scan",
  qrImageDataUrl: null, qrStatus: "ready", loginPage: null,
  failureCode: null,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
});
await Promise.all([staleConnect, replacementWhileCleanup]);
assert.deepEqual(replacementCreateDeletes, ["login-stale"]);
await replacementSessionController.connect();
assert.equal(replacementSessionController.getState().loginSession?.id, "login-replacement",
  "a replacement session may start only after the late session is deleted");
replacementSessionController.close();

let finishPlaceholderPoll!: (
  session: Awaited<ReturnType<DouyinAutomationApi["getLoginSession"]>>
) => void;
const placeholderPoll = new Promise<Awaited<ReturnType<DouyinAutomationApi["getLoginSession"]>>>((resolve) => {
  finishPlaceholderPoll = resolve;
});
let placeholderPollReads = 0;
const placeholderPollTimers: Array<() => void> = [];
const placeholderLoginController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async () => ({
      id: "login-placeholder", platform: "douyin", state: "awaiting_scan",
      qrImageDataUrl: null, qrStatus: null, loginPage: null,
      failureCode: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
    }),
    getLoginSession: async () => {
      placeholderPollReads += 1;
      return placeholderPoll;
    }
  }),
  pollDelayMs: 2_000,
  setTimer: ((callback: () => void, delay?: number) => {
    assert.equal(delay, 2_000);
    placeholderPollTimers.push(callback);
    return placeholderPollTimers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await placeholderLoginController.connect();
assert.equal(placeholderLoginController.getState().connectionPending, false,
  "a fast placeholder response must immediately release the connect button");
assert.equal(placeholderLoginController.getState().loginSession?.loginPage, null,
  "the controller must publish the placeholder while the login page is starting");
assert.equal(placeholderPollReads, 1,
  "an awaiting placeholder must immediately start login-session polling");
finishPlaceholderPoll({
  id: "login-placeholder", platform: "douyin", state: "awaiting_scan",
  qrImageDataUrl: null, qrStatus: null,
  loginPage: { imageDataUrl: "data:image/png;base64,UEFHRV9SRUFEWQ==", width: 1280, height: 720 },
  failureCode: null,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
});
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.equal(
  placeholderLoginController.getState().loginSession?.loginPage?.imageDataUrl,
  "data:image/png;base64,UEFHRV9SRUFEWQ==",
  "polling must replace the placeholder with the first real login page"
);
assert.equal(placeholderPollTimers.length, 1,
  "an awaiting login page must continue polling after the first real frame");
placeholderLoginController.close();

const terminalLoginTimers: Array<() => void> = [];
const terminalLoginController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async () => ({
      id: "login-terminal", platform: "douyin", state: "awaiting_scan",
      qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
    }),
    getLoginSession: async () => ({
      id: "login-terminal", platform: "douyin", state: "awaiting_scan",
      qrImageDataUrl: null, qrStatus: null, loginPage: null,
      failureCode: "douyin_login_ui_unsupported",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
    })
  }),
  setTimer: ((callback: () => void) => {
    terminalLoginTimers.push(callback);
    return terminalLoginTimers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await terminalLoginController.connect();
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.equal(
  terminalLoginController.getState().loginSession?.failureCode,
  "douyin_login_ui_unsupported",
  "the terminal login failure must remain available for actionable UI copy"
);
assert.equal(terminalLoginTimers.length, 0,
  "a sanitized terminal login failure must stop polling");
terminalLoginController.close();

const neverFinishingLoginPoll = new Promise<never>(() => undefined);
const cancelledLoginSessionIds: string[] = [];
const explicitCancelController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async () => ({
      id: "login-cancel", platform: "douyin", state: "awaiting_scan",
      qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
    }),
    getLoginSession: async () => neverFinishingLoginPoll,
    cancelLoginSession: async (sessionId) => { cancelledLoginSessionIds.push(sessionId); }
  })
});
await explicitCancelController.connect();
await explicitCancelController.cancelLogin();
assert.deepEqual(cancelledLoginSessionIds, ["login-cancel"]);
assert.equal(explicitCancelController.getState().loginSession, null,
  "closing login must clear the current login session immediately");
assert.equal(explicitCancelController.getState().connectionPending, false);
assert.equal(explicitCancelController.getState().interactionPending, false);
explicitCancelController.close();

const abortedLoginSessionIds: string[] = [];
const abortLoginNotifications: Array<string | null> = [];
const abortLoginController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async () => ({
      id: "login-abort", platform: "douyin", state: "awaiting_scan",
      qrImageDataUrl: null, qrStatus: "opening", loginPage: null, failureCode: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
    }),
    getLoginSession: async () => neverFinishingLoginPoll,
    cancelLoginSession: async (sessionId) => { abortedLoginSessionIds.push(sessionId); }
  })
});
await abortLoginController.connect();
const unsubscribeAbortLogin = abortLoginController.subscribe((snapshot) => {
  abortLoginNotifications.push(snapshot.loginSession?.id ?? null);
});
abortLoginController.abort();
abortLoginController.abort();
assert.equal(abortLoginNotifications.at(-1), null,
  "abort must publish a cleared login session so the view synchronously unmounts RFB");
assert.equal(abortLoginController.getState().closed, false,
  "abort must keep the controller reusable after logout or a mode switch");
await Promise.resolve();
assert.deepEqual(abortedLoginSessionIds, ["login-abort"],
  "repeated abort must best-effort cancel one awaiting server login session exactly once");
unsubscribeAbortLogin();
abortLoginController.close();

const closedLoginSessionIds: string[] = [];
const closeLoginNotifications: Array<{ closed: boolean; loginSessionId: string | null }> = [];
const neverFinishingCloseCancellation = new Promise<void>(() => undefined);
const closeLoginController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async () => ({
      id: "login-close", platform: "douyin", state: "awaiting_scan",
      qrImageDataUrl: null, qrStatus: "opening", loginPage: null, failureCode: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
    }),
    getLoginSession: async () => neverFinishingLoginPoll,
    cancelLoginSession: async (sessionId) => {
      closedLoginSessionIds.push(sessionId);
      return neverFinishingCloseCancellation;
    }
  })
});
await closeLoginController.connect();
closeLoginController.subscribe((snapshot) => {
  closeLoginNotifications.push({
    closed: snapshot.closed,
    loginSessionId: snapshot.loginSession?.id ?? null
  });
});
closeLoginController.close();
closeLoginController.close();
assert.deepEqual(closeLoginNotifications.at(-1), {
  closed: true,
  loginSessionId: null
}, "close must notify mounted views to disconnect RFB before listeners are released");
await Promise.resolve();
assert.deepEqual(closedLoginSessionIds, ["login-close"],
  "close must trigger one non-blocking best-effort server cancellation");

const loginAndRunTimers = new Map<number, () => void>();
const clearedLoginAndRunTimers: number[] = [];
let nextLoginAndRunTimer = 0;
const isolatedLoginCancelController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async () => ({
      id: "login-isolated-cancel", platform: "douyin", state: "awaiting_scan",
      qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
    }),
    getLoginSession: async () => ({
      id: "login-isolated-cancel", platform: "douyin", state: "awaiting_scan",
      qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
    })
  }),
  setTimer: ((callback: () => void) => {
    nextLoginAndRunTimer += 1;
    loginAndRunTimers.set(nextLoginAndRunTimer, callback);
    return nextLoginAndRunTimer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout,
  clearTimer: ((handle: number) => {
    clearedLoginAndRunTimers.push(handle);
    loginAndRunTimers.delete(handle);
  }) as unknown as typeof clearTimeout
});
await isolatedLoginCancelController.load("plan-login", "登录与运行隔离测试");
await isolatedLoginCancelController.connect();
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
await isolatedLoginCancelController.runNow();
assert.deepEqual([...loginAndRunTimers.keys()], [1, 2],
  "the pending login and crawler run must have independent poll timers");
await isolatedLoginCancelController.cancelLogin();
assert.deepEqual(clearedLoginAndRunTimers, [1],
  "closing login must not cancel an unrelated crawler-status poll");
assert.equal(loginAndRunTimers.has(2), true,
  "crawler monitoring must remain scheduled after the login surface closes");
isolatedLoginCancelController.close();

const reconnectOrder: string[] = [];
let reconnectCreateCount = 0;
const bestEffortReconnectController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async () => {
      reconnectCreateCount += 1;
      reconnectOrder.push(`create:${reconnectCreateCount}`);
      return {
        id: `login-reconnect-${reconnectCreateCount}`,
        platform: "douyin" as const,
        state: "awaiting_scan" as const,
        qrImageDataUrl: null, qrStatus: null,
        loginPage: null,
        failureCode: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        account: null
      };
    },
    getLoginSession: async () => neverFinishingLoginPoll,
    cancelLoginSession: async (sessionId) => {
      reconnectOrder.push(`cancel:${sessionId}`);
      throw new Error("cleanup unavailable");
    }
  })
});
await bestEffortReconnectController.connect();
await bestEffortReconnectController.connect();
assert.deepEqual(reconnectOrder, [
  "create:1",
  "cancel:login-reconnect-1"
], "reconnect must stop when the previous session cannot be deleted");
assert.equal(bestEffortReconnectController.getState().loginSession?.id, "login-reconnect-1",
  "a cleanup failure must preserve the known session instead of orphaning it");
assert.equal(bestEffortReconnectController.getState().errorRetry, "cancel");
bestEffortReconnectController.close();

let expiredInteractionCalls = 0;
const expiredInteractionSession = {
  id: "login-expired-interaction",
  platform: "douyin" as const,
  state: "awaiting_scan" as const,
  qrImageDataUrl: "data:image/png;base64,AA==", qrStatus: "ready" as const,
  loginPage: {
    imageDataUrl: "data:image/png;base64,UEFHRV9FWFBJUkVE",
    width: 800,
    height: 400
  },
  failureCode: null,
  expiresAt: new Date(Date.now() - 1_000).toISOString(),
  account: null
};
const expiredInteractionController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async () => expiredInteractionSession,
    getLoginSession: async () => neverFinishingLoginPoll,
    interactLoginSession: async () => {
      expiredInteractionCalls += 1;
      return expiredInteractionSession;
    }
  })
});
await expiredInteractionController.connect();
await expiredInteractionController.interactLogin({
  type: "click", normalizedX: 0.5, normalizedY: 0.5
});
assert.deepEqual({
  apiCalls: expiredInteractionCalls,
  sessionState: expiredInteractionController.getState().loginSession?.state,
  qrStatus: expiredInteractionController.getState().loginSession?.qrStatus,
  interactionPending: expiredInteractionController.getState().interactionPending
}, {
  apiCalls: 0,
  sessionState: "login_expired",
  qrStatus: null,
  interactionPending: false
}, "an expired awaiting-login session must become login_expired without sending an interaction");
expiredInteractionController.close();

let finishBoundaryExpiryPoll!: (
  session: Awaited<ReturnType<DouyinAutomationApi["getLoginSession"]>>
) => void;
const boundaryExpiryPoll = new Promise<
  Awaited<ReturnType<DouyinAutomationApi["getLoginSession"]>>
>((resolve) => {
  finishBoundaryExpiryPoll = resolve;
});
const boundaryExpiryController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async () => ({
      ...expiredInteractionSession,
      id: "login-boundary-expiry",
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }),
    getLoginSession: async () => boundaryExpiryPoll
  })
});
await boundaryExpiryController.connect();
finishBoundaryExpiryPoll({
  ...expiredInteractionSession,
  id: "login-boundary-expiry",
  expiresAt: new Date(Date.now() - 1).toISOString()
});
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.deepEqual({
  sessionState: boundaryExpiryController.getState().loginSession?.state,
  loginPage: boundaryExpiryController.getState().loginSession?.loginPage,
  interactionPending: boundaryExpiryController.getState().interactionPending
}, {
  sessionState: "login_expired",
  loginPage: null,
  interactionPending: false
}, "an awaiting-login poll that arrives after expiresAt must remove the stale page");
boundaryExpiryController.close();

const serverExpiredInteractionController = createDouyinAutomationController({
  api: loginTestApi({
    getLoginSession: async () => neverFinishingLoginPoll,
    interactLoginSession: async () => {
      throw new AcquisitionHttpError(
        410,
        "douyin_login_session_expired",
        "douyin_login_session_expired"
      );
    }
  }),
  setTimer: (() => 1) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await serverExpiredInteractionController.connect();
await serverExpiredInteractionController.interactLogin({
  type: "click", normalizedX: 0.5, normalizedY: 0.5
});
assert.deepEqual({
  sessionState: serverExpiredInteractionController.getState().loginSession?.state,
  loginPage: serverExpiredInteractionController.getState().loginSession?.loginPage,
  error: serverExpiredInteractionController.getState().error,
  interactionPending: serverExpiredInteractionController.getState().interactionPending
}, {
  sessionState: "login_expired",
  loginPage: null,
  error: null,
  interactionPending: false
}, "a server-expired interaction must replace the stale page with login_expired");
serverExpiredInteractionController.close();

const serializedInteractionInputs: unknown[] = [];
let finishFirstInteraction!: () => void;
const firstInteractionGate = new Promise<void>((resolve) => {
  finishFirstInteraction = resolve;
});
const serializedInteractionController = createDouyinAutomationController({
  api: loginTestApi({
    getLoginSession: async () => ({
      id: "login-test", platform: "douyin", state: "awaiting_scan",
      qrImageDataUrl: "data:image/png;base64,AA==", qrStatus: "ready",
      loginPage: { imageDataUrl: "data:image/png;base64,UEFHRV8w", width: 800, height: 400 },
      failureCode: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
    }),
    interactLoginSession: async (_sessionId, input) => {
      serializedInteractionInputs.push(input);
      if (serializedInteractionInputs.length === 1) await firstInteractionGate;
      return {
        id: "login-test", platform: "douyin", state: "awaiting_scan",
        qrImageDataUrl: "data:image/png;base64,AA==", qrStatus: "ready",
        loginPage: {
          imageDataUrl: serializedInteractionInputs.length === 1
            ? "data:image/png;base64,UEFHRV8x"
            : "data:image/png;base64,UEFHRV8y",
          width: 800,
          height: 400
        },
        failureCode: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
      };
    }
  }),
  setTimer: (() => 1) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await serializedInteractionController.connect();
await Promise.resolve();
const firstInteraction = serializedInteractionController.interactLogin({
  type: "click", normalizedX: 0.25, normalizedY: 0.75
});
const secondInteraction = serializedInteractionController.interactLogin({
  type: "text", text: "袜"
});
await Promise.resolve();
assert.deepEqual(serializedInteractionInputs, [
  { type: "click", normalizedX: 0.25, normalizedY: 0.75 }
], "only one login interaction may be in flight at a time");
assert.equal(serializedInteractionController.getState().interactionPending, true);
finishFirstInteraction();
await Promise.all([firstInteraction, secondInteraction]);
assert.deepEqual(serializedInteractionInputs, [
  { type: "click", normalizedX: 0.25, normalizedY: 0.75 },
  { type: "text", text: "袜" }
], "login interactions must preserve user input order");
assert.equal(
  serializedInteractionController.getState().loginSession?.loginPage?.imageDataUrl,
  "data:image/png;base64,UEFHRV8y",
  "the latest interaction response must replace the visible login page"
);
assert.equal(serializedInteractionController.getState().interactionPending, false);
serializedInteractionController.close();

let rejectObsoleteLoginPoll!: (reason?: unknown) => void;
const obsoleteLoginPoll = new Promise<Awaited<ReturnType<DouyinAutomationApi["getLoginSession"]>>>(
  (_resolve, reject) => {
    rejectObsoleteLoginPoll = reject;
  }
);
const obsoletePollAfterInteractionController = createDouyinAutomationController({
  api: loginTestApi({
    getLoginSession: async () => obsoleteLoginPoll
  }),
  setTimer: (() => 1) as unknown as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await obsoletePollAfterInteractionController.connect();
await obsoletePollAfterInteractionController.interactLogin({
  type: "click", normalizedX: 0.25, normalizedY: 0.75
});
assert.equal(obsoletePollAfterInteractionController.getState().phase, "ready");
assert.equal(obsoletePollAfterInteractionController.getState().error, null);
assert.equal(
  obsoletePollAfterInteractionController.getState().loginSession?.loginPage?.imageDataUrl,
  "data:image/png;base64,UEFHRV8x"
);
rejectObsoleteLoginPoll(loginInternalError());
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.equal(
  obsoletePollAfterInteractionController.getState().phase,
  "ready",
  "a poll superseded by a successful login interaction must not replace the ready phase"
);
assert.equal(
  obsoletePollAfterInteractionController.getState().error,
  null,
  "a poll superseded by a successful login interaction must not publish its failure"
);
assert.equal(
  obsoletePollAfterInteractionController.getState().loginSession?.loginPage?.imageDataUrl,
  "data:image/png;base64,UEFHRV8x",
  "an obsolete poll failure must preserve the fresh interaction frame"
);
obsoletePollAfterInteractionController.close();

const createLoginFailureController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async () => { throw loginInternalError(); }
  })
});
await createLoginFailureController.connect();
assert.equal(
  createLoginFailureController.getState().error,
  "抖音登录服务暂时不可用，请稍后重新打开登录页。"
);
assert.equal(
  (createLoginFailureController.getState() as { errorRetry?: string }).errorRetry,
  "reconnect",
  "creating an interactive login session after a server failure must expose reconnect retry intent"
);
createLoginFailureController.close();

let recoverableLoginPollReads = 0;
const recoverableLoginPollTimers: Array<() => void> = [];
const pollLoginFailureController = createDouyinAutomationController({
  api: loginTestApi({
    getLoginSession: async () => {
      recoverableLoginPollReads += 1;
      if (recoverableLoginPollReads === 1) throw loginInternalError();
      if (recoverableLoginPollReads === 2) {
        return {
          id: "login-test", platform: "douyin", state: "awaiting_scan",
          qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null,
          expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null
        };
      }
      return {
        id: "login-test", platform: "douyin", state: "active",
        qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null,
        expiresAt: new Date(Date.now() + 60_000).toISOString(), account: activeAccount
      };
    }
  }),
  pollDelayMs: 250,
  setTimer: ((callback: () => void, delay?: number) => {
    assert.equal(delay, 250);
    recoverableLoginPollTimers.push(callback);
    return recoverableLoginPollTimers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await pollLoginFailureController.connect();
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.deepEqual({
  phase: pollLoginFailureController.getState().phase,
  sessionState: pollLoginFailureController.getState().loginSession?.state,
  error: pollLoginFailureController.getState().error,
  errorRetry: pollLoginFailureController.getState().errorRetry,
  scheduledPolls: recoverableLoginPollTimers.length
}, {
  phase: "ready",
  sessionState: "awaiting_scan",
  error: "抖音登录状态暂时不可用，正在自动重试；请保持登录窗口打开。",
  errorRetry: null,
  scheduledPolls: 1
}, "a temporary login poll failure must preserve the live session and retry automatically");
recoverableLoginPollTimers.shift()?.();
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.deepEqual({
  reads: recoverableLoginPollReads,
  sessionState: pollLoginFailureController.getState().loginSession?.state,
  error: pollLoginFailureController.getState().error,
  scheduledPolls: recoverableLoginPollTimers.length
}, {
  reads: 2,
  sessionState: "awaiting_scan",
  error: null,
  scheduledPolls: 1
}, "a recovered awaiting response must clear the hint and keep polling");
recoverableLoginPollTimers.shift()?.();
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.deepEqual({
  reads: recoverableLoginPollReads,
  sessionState: pollLoginFailureController.getState().loginSession?.state,
  accountState: pollLoginFailureController.getState().account?.state,
  error: pollLoginFailureController.getState().error
}, {
  reads: 3,
  sessionState: "active",
  accountState: "active",
  error: null
}, "a successful retry must clear the recoverable hint and finish account binding");
pollLoginFailureController.close();

let expiredPollRetrySchedules = 0;
const expiredPollFailureController = createDouyinAutomationController({
  api: loginTestApi({
    createLoginSession: async () => ({
      id: "login-poll-expired", platform: "douyin", state: "awaiting_scan",
      qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null,
      expiresAt: new Date(Date.now() - 1_000).toISOString(), account: null
    }),
    getLoginSession: async () => { throw loginInternalError(); }
  }),
  setTimer: ((callback: () => void) => {
    expiredPollRetrySchedules += 1;
    return callback as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await expiredPollFailureController.connect();
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.deepEqual({
  sessionState: expiredPollFailureController.getState().loginSession?.state,
  loginPage: expiredPollFailureController.getState().loginSession?.loginPage,
  error: expiredPollFailureController.getState().error,
  scheduledPolls: expiredPollRetrySchedules
}, {
  sessionState: "login_expired",
  loginPage: null,
  error: null,
  scheduledPolls: 0
}, "a poll failure after local expiry must close the live session without retrying");
expiredPollFailureController.close();

let abortedPollRetrySchedules = 0;
const abortedPollController = createDouyinAutomationController({
  api: loginTestApi({
    getLoginSession: async (_sessionId, signal) => new Promise<
    Awaited<ReturnType<DouyinAutomationApi["getLoginSession"]>>
    >((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("aborted", "AbortError"));
        return;
      }
      signal?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    })
  }),
  setTimer: ((callback: () => void) => {
    abortedPollRetrySchedules += 1;
    return callback as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout,
  clearTimer: (() => undefined) as typeof clearTimeout
});
await abortedPollController.connect();
await abortedPollController.cancelLogin();
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.deepEqual({
  loginSession: abortedPollController.getState().loginSession,
  error: abortedPollController.getState().error,
  scheduledPolls: abortedPollRetrySchedules
}, {
  loginSession: null,
  error: null,
  scheduledPolls: 0
}, "an aborted login poll must not publish an error or schedule a retry");
abortedPollController.close();

let resolveCancelledCreate!: (value: Awaited<ReturnType<DouyinAutomationApi["createLoginSession"]>>) => void;
const cancelledCreateDeletes: string[] = [];
const cancelledCreateController = createDouyinAutomationController({ api: loginTestApi({
  createLoginSession: async () => new Promise((resolve) => { resolveCancelledCreate = resolve; }),
  getLoginSession: async () => new Promise<never>(() => undefined),
  cancelLoginSession: async (id) => { cancelledCreateDeletes.push(id); }
}) });
const pendingCreate = cancelledCreateController.connect();
await Promise.resolve();
const pendingCancel = cancelledCreateController.cancelLogin();
resolveCancelledCreate({ id: "late-created-login", platform: "douyin", state: "awaiting_scan",
  qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null });
await Promise.all([pendingCreate, pendingCancel]);
assert.deepEqual(cancelledCreateDeletes, ["late-created-login"],
  "cancelling an in-flight create must delete the late-created upstream session");
assert.equal(cancelledCreateController.getState().loginSession, null);
cancelledCreateController.close();

for (const lifecycleExit of ["abort", "close"] as const) {
  let resolveExitedCreate!: (value: Awaited<ReturnType<DouyinAutomationApi["createLoginSession"]>>) => void;
  const exitedCreateDeletes: string[] = [];
  const exitedCreateController = createDouyinAutomationController({ api: loginTestApi({
    createLoginSession: async () => new Promise((resolve) => { resolveExitedCreate = resolve; }),
    cancelLoginSession: async (id) => { exitedCreateDeletes.push(id); }
  }) });
  const exitedCreate = exitedCreateController.connect();
  await Promise.resolve();
  exitedCreateController[lifecycleExit]();
  resolveExitedCreate({ id: `late-${lifecycleExit}-login`, platform: "douyin", state: "awaiting_scan",
    qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null });
  await exitedCreate;
  assert.deepEqual(exitedCreateDeletes, [`late-${lifecycleExit}-login`],
    `${lifecycleExit} must delete a login session returned after the controller lifecycle ended`);
  exitedCreateController.close();
}

let serializedCreateCalls = 0;
let resolveSerializedCreate!: (value: Awaited<ReturnType<DouyinAutomationApi["createLoginSession"]>>) => void;
const serializedCreateDeletes: string[] = [];
const serializedCreateController = createDouyinAutomationController({ api: loginTestApi({
  createLoginSession: async () => {
    serializedCreateCalls += 1;
    if (serializedCreateCalls === 1) {
      return new Promise((resolve) => { resolveSerializedCreate = resolve; });
    }
    return { id: "replacement-login", platform: "douyin", state: "login_expired",
      qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null };
  },
  cancelLoginSession: async (id) => { serializedCreateDeletes.push(id); }
}) });
const serializedPendingCreate = serializedCreateController.connect();
await Promise.resolve();
await serializedCreateController.cancelLogin();
const reconnectWhileCleanupPending = serializedCreateController.connect();
assert.equal(serializedCreateCalls, 1,
  "a reconnect must wait until the cancelled create returns and its session is deleted");
resolveSerializedCreate({ id: "serialized-late-login", platform: "douyin", state: "awaiting_scan",
  qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null });
await Promise.all([serializedPendingCreate, reconnectWhileCleanupPending]);
assert.deepEqual(serializedCreateDeletes, ["serialized-late-login"]);
await serializedCreateController.connect();
assert.equal(serializedCreateCalls, 2,
  "a fresh login may start after cancelled-create cleanup completes");
assert.equal(serializedCreateController.getState().loginSession?.id, "replacement-login");
serializedCreateController.close();

let reconnectAfterDeleteFailureCreates = 0;
const reconnectAfterDeleteFailureController = createDouyinAutomationController({ api: loginTestApi({
  createLoginSession: async () => {
    reconnectAfterDeleteFailureCreates += 1;
    return { id: `delete-fence-login-${reconnectAfterDeleteFailureCreates}`,
      platform: "douyin", state: "awaiting_scan",
      qrImageDataUrl: null, qrStatus: "network_error", loginPage: null,
      failureCode: "douyin_login_page_unavailable",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null };
  },
  cancelLoginSession: async () => { throw new Error("delete unavailable"); }
}) });
await reconnectAfterDeleteFailureController.connect();
await reconnectAfterDeleteFailureController.connect();
assert.equal(reconnectAfterDeleteFailureCreates, 1,
  "reconnect must not create a replacement when deleting the known session fails");
assert.equal(reconnectAfterDeleteFailureController.getState().loginSession?.id,
  "delete-fence-login-1");
assert.equal(reconnectAfterDeleteFailureController.getState().errorRetry, "cancel");
reconnectAfterDeleteFailureController.close();

let rejectLateCreateDelete = true;
let resolveFailedLateCreate!: (value: Awaited<ReturnType<DouyinAutomationApi["createLoginSession"]>>) => void;
const failedLateCreateController = createDouyinAutomationController({ api: loginTestApi({
  createLoginSession: async () => new Promise((resolve) => { resolveFailedLateCreate = resolve; }),
  cancelLoginSession: async () => {
    if (rejectLateCreateDelete) throw new Error("late delete unavailable");
  }
}) });
const failedLateCreate = failedLateCreateController.connect();
await Promise.resolve();
await failedLateCreateController.cancelLogin();
const fencedReplacement = failedLateCreateController.connect();
resolveFailedLateCreate({ id: "failed-late-create", platform: "douyin", state: "awaiting_scan",
  qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null });
await Promise.all([failedLateCreate, fencedReplacement]);
assert.equal(failedLateCreateController.getState().loginSession?.id, "failed-late-create",
  "a late DELETE failure must preserve the returned session for retry");
assert.equal(failedLateCreateController.getState().errorRetry, "cancel");
rejectLateCreateDelete = false;
await failedLateCreateController.cancelLogin();
assert.equal(failedLateCreateController.getState().loginSession, null);
failedLateCreateController.close();

let cancelAttempts = 0;
const failedDeleteController = createDouyinAutomationController({ api: loginTestApi({
  createLoginSession: async () => ({ id: "retry-delete-login", platform: "douyin", state: "awaiting_scan",
    qrImageDataUrl: null, qrStatus: null, loginPage: null, failureCode: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null }),
  getLoginSession: async () => new Promise<never>(() => undefined),
  cancelLoginSession: async () => { cancelAttempts += 1; if (cancelAttempts === 1) throw new Error("delete unavailable"); }
}) });
await failedDeleteController.connect();
await failedDeleteController.cancelLogin();
assert.equal(failedDeleteController.getState().loginSession?.id, "retry-delete-login",
  "a failed DELETE must retain the session for retry");
assert.equal(failedDeleteController.getState().errorRetry, "cancel");
await failedDeleteController.cancelLogin();
assert.equal(failedDeleteController.getState().loginSession, null);
assert.equal(cancelAttempts, 2);
failedDeleteController.close();

// Both current and pre-crawler historical runs must consume every result page.
const fiftyCandidates = Array.from({ length: 50 }, (_, index) => ({
  ...liveCandidate, id: `candidate-paged-${index + 1}`, displayName: `候选 ${index + 1}`
}));
for (const historical of [false, true]) {
  const reads: Array<string | undefined> = [];
  const paged = createDouyinAutomationController({ api: loginTestApi({
    getCrawlerStatus: async (runId) => {
      if (historical) throw new AcquisitionHttpError(404, "crawler_status_not_found", "missing");
      return { ...runningStatus(runId), state: "succeeded", candidateProjectionState: "ready" };
    },
    listRunCandidates: async (_runId, _signal, query) => {
      reads.push(query?.cursor);
      if (query?.cursor === undefined) return { items: fiftyCandidates.slice(0, 20), nextCursor: "page-2" };
      if (query.cursor === "page-2") return { items: fiftyCandidates.slice(20, 40), nextCursor: "page-3" };
      assert.equal(query.cursor, "page-3");
      return { items: fiftyCandidates.slice(39), nextCursor: null };
    },
    runNow: async () => { throw new Error("reading candidates must not start a new run"); }
  }) });
  await paged.load("plan-1", "50 人计划", "run-paged");
  assert.equal(paged.getState().phase, "ready");
  assert.deepEqual(paged.getState().candidates, fiftyCandidates,
    `all 50 unique candidates must survive 20+20+11 pages (historical=${historical})`);
  assert.deepEqual(reads, [undefined, "page-2", "page-3"]);
  assert.equal(paged.getState().historicalRun, historical);
  paged.selectAllCandidates(true);
  assert.deepEqual(paged.getState().selectedCandidateIds, fiftyCandidates.map((candidate) => candidate.id),
    "all 50 real comment-eligible candidates must be selectable, including the last page");
  paged.selectAllCandidates(false);
  assert.deepEqual(paged.getState().selectedCandidateIds, []);
  assert.equal(paged.getState().candidates.length, 50, "clearing selection preserves candidates");
  await paged.load("plan-2", "另一个运行", "run-other");
  assert.deepEqual(paged.getState().selectedCandidateIds, [], "changing runs clears selection");
  paged.close();
}

{
  let reads = 0;
  const cyclic = createDouyinAutomationController({ api: loginTestApi({
    getCrawlerStatus: async (runId) => ({ ...runningStatus(runId), state: "succeeded", candidateProjectionState: "ready" }),
    listRunCandidates: async () => { reads += 1; return { items: [liveCandidate], nextCursor: "same-page" }; }
  }), terminalCandidateRetryLimit: 0 });
  await cyclic.load("plan-1", "游标检查", "run-cycle");
  assert.equal(reads, 2, "a repeating result cursor must stop rather than loop forever");
  assert.equal(cyclic.getState().phase, "error");
  assert.match(cyclic.getState().error ?? "", /候选人分页/u);
  assert.deepEqual(cyclic.getState().candidates, [], "partial pages must not masquerade as a complete read");
  cyclic.close();
}

{
  let resolvePage!: (page: Awaited<ReturnType<DouyinAutomationApi["listRunCandidates"]>>) => void;
  let pageSignal: AbortSignal | undefined;
  let reads = 0;
  const switching = createDouyinAutomationController({ api: loginTestApi({
    getCrawlerStatus: async (runId) => ({ ...runningStatus(runId), state: "succeeded", candidateProjectionState: "ready" }),
    listRunCandidates: async (_runId, signal) => {
      pageSignal = signal;
      reads += 1;
      return new Promise((resolve) => { resolvePage = resolve; });
    }
  }) });
  const oldLoad = switching.load("plan-1", "旧运行", "run-old-pages");
  while (!resolvePage) await Promise.resolve();
  await switching.load(null);
  resolvePage({ items: fiftyCandidates.slice(0, 20), nextCursor: "page-2" });
  await oldLoad;
  assert.equal(pageSignal?.aborted, true);
  assert.equal(reads, 1, "switching plans must stop subsequent candidate pages");
  assert.deepEqual(switching.getState().candidates, [], "late pages must not leak into the next plan");
  switching.close();
}

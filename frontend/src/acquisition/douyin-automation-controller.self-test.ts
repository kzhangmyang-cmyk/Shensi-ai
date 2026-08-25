import { strict as assert } from "node:assert";
import { createDouyinAutomationController } from "./douyin-automation-controller";

const now = new Date().toISOString();
const activeAccount = { id: "account-1", workspaceId: "workspace-1", platform: "douyin" as const, displayName: "测试账号", state: "active" as const, loginStateVersion: 1, revision: 1, etag: '"account:1"', lastValidatedAt: null, createdAt: now, updatedAt: now };
const defaultPolicy = { id: null, source: "default" as const, workspaceId: "workspace-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", accountId: null, accountLoginStateVersion: null, version: 0, revision: 0, etag: '"policy:0"', policyHash: "hash", keywords: [], schedule: { enabled: false, localTime: "09:30", timeZone: "Asia/Shanghai" }, dailyCandidateLimit: 50, collectCreators: true, collectDemandComments: true, limits: { maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3, maxDurationSeconds: 3600 }, createdBy: null, createdAt: null };
const liveCandidate = { id: "candidate-live-1", status: "comment_candidate", displayName: "袜子采购用户", evidence: { sourceUrl: "https://www.douyin.com/video/live-1", excerpt: "公开评论中询问袜子批发" } };

const controller = createDouyinAutomationController({
  api: {
    createPlan: async () => ({ id: "plan-1", name: "测试计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "测试计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [] }),
    createLoginSession: async () => ({ id: "login-1", platform: "douyin", state: "awaiting_scan", qrImageDataUrl: "data:image/png;base64,AA==", expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null }),
    getLoginSession: async () => ({ id: "login-1", platform: "douyin", state: "active", qrImageDataUrl: null, expiresAt: new Date(Date.now() + 60_000).toISOString(), account: activeAccount }),
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
const zeroPlanController = createDouyinAutomationController({
  api: {
    createPlan: async (input) => { calls.push(`create:${input.name}:${input.keywords.join("|")}`); return { id: "plan-new", name: input.name, status: "draft", version: 1, etag: '"plan:1"' }; },
    approvePlan: async (planId) => { calls.push(`approve:${planId}`); return { id: planId, name: "工业需求计划", status: "approved", version: 1, etag: '"plan:2"' }; },
    listAccounts: async () => { calls.push("accounts"); return { items: [activeAccount] }; },
    createLoginSession: async () => { throw new Error("not used"); },
    getLoginSession: async () => { throw new Error("not used"); },
    disconnectAccount: async () => undefined,
    getAutomation: async (planId) => { calls.push(`policy:${planId}`); return { ...defaultPolicy, planId }; },
    suggestKeywords: async () => { calls.push("suggest"); return { keywords: ["不应调用"], modelSnapshotId: "model-1" }; },
    putAutomation: async (planId, input) => { calls.push(`save:${planId}:${input.keywords.join("|")}`); return { ...defaultPolicy, ...input, id: "policy-1", source: "version", planId, accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', createdBy: "user-1", createdAt: now }; },
    runNow: async (planId) => { calls.push(`run:${planId}`); return { id: "intent-1", acquisitionRunId: "run-1", workspaceId: "workspace-1", planId, planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", policyVersionId: "policy-1", policyHash: "hash", accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: "budget-1", localDate: "2026-08-25", trigger: "run_now", collectCreators: true, collectDemandComments: true, status: "queued", reason: null, createdBy: "user-1", createdAt: now }; },
    getCrawlerStatus: async () => ({ runId: "run-1", state: "succeeded", attempt: 1, cursorPersisted: true, recordCount: 0, candidateBudgetUsed: 0, candidateBudgetLimit: 50, candidateProjectionState: "ready", lastErrorCode: null, createdAt: now, updatedAt: now, completedAt: now, activity: { phase: "completed", currentKeyword: null, browserMode: "headless", sequence: 5 } }),
    listRunCandidates: async () => ({ items: [], nextCursor: null })
  },
  onPlanCreated(planId) { refreshedPlanId = planId; },
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
zeroPlanController.close();

const scheduledRunPolls: Array<() => void> = [];
let liveCandidateReads = 0;
let liveRunStarts = 0;
const liveCandidateController = createDouyinAutomationController({
  api: {
    createPlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); },
    getLoginSession: async () => { throw new Error("not used"); },
    disconnectAccount: async () => undefined,
    getAutomation: async () => ({ ...defaultPolicy, keywords: ["袜子"] }),
    suggestKeywords: async () => ({ keywords: ["袜子"], modelSnapshotId: "model-1" }),
    putAutomation: async (_planId, input) => ({ ...defaultPolicy, ...input, id: "policy-1", source: "version", accountId: "account-1", accountLoginStateVersion: 1, version: 1, revision: 1, etag: '"policy:1"', createdBy: "user-1", createdAt: now }),
    runNow: async () => { liveRunStarts += 1; return { id: "intent-live-1", acquisitionRunId: "run-live-1", workspaceId: "workspace-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", policyVersionId: "policy-1", policyHash: "hash", accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: "budget-1", localDate: "2026-08-25", trigger: "run_now", collectCreators: true, collectDemandComments: true, status: "queued", reason: null, createdBy: "user-1", createdAt: now }; },
    getCrawlerStatus: async () => ({ runId: "run-live-1", state: "running", attempt: 1, cursorPersisted: true, recordCount: 25, candidateBudgetUsed: 1, candidateBudgetLimit: 50, candidateProjectionState: "pending", lastErrorCode: null, createdAt: now, updatedAt: now, completedAt: null, activity: { phase: "collecting_comments", currentKeyword: "袜子", browserMode: "visible", sequence: 4 } }),
    listRunCandidates: async () => {
      liveCandidateReads += 1;
      return { items: [liveCandidate], nextCursor: null };
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
assert.deepEqual(liveCandidateController.getState().candidates, [liveCandidate]);
assert.equal(liveCandidateReads, 1);
assert.equal(scheduledRunPolls.length, 1, "running crawl must schedule another poll after publishing candidates");
scheduledRunPolls.shift()?.();
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.equal(liveCandidateReads, 2, "scheduled polling must continue while candidates are already visible");
assert.equal(scheduledRunPolls.length, 1, "each running refresh must schedule the next poll");
liveCandidateController.close();

const failedPollTimers: Array<() => void> = [];
let failedPollRunStarts = 0;
const failedPollController = createDouyinAutomationController({
  api: {
    createPlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); },
    getLoginSession: async () => { throw new Error("not used"); },
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
    createPlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); }, getLoginSession: async () => { throw new Error("not used"); }, disconnectAccount: async () => undefined,
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
    createPlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); }, getLoginSession: async () => { throw new Error("not used"); }, disconnectAccount: async () => undefined,
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
    createPlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); }, getLoginSession: async () => { throw new Error("not used"); }, disconnectAccount: async () => undefined,
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
    createPlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "draft", version: 1, etag: '"plan:1"' }),
    approvePlan: async () => ({ id: "plan-1", name: "袜子获客计划", status: "approved", version: 1, etag: '"plan:2"' }),
    listAccounts: async () => ({ items: [activeAccount] }),
    createLoginSession: async () => { throw new Error("not used"); }, getLoginSession: async () => { throw new Error("not used"); }, disconnectAccount: async () => undefined,
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

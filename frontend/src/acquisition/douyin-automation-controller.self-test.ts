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
    getCrawlerStatus: async () => ({ runId: "run-1", state: "running", attempt: 1, cursorPersisted: true, recordCount: 8, candidateBudgetUsed: 2, candidateBudgetLimit: 50, lastErrorCode: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null }),
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
    getCrawlerStatus: async () => ({ runId: "run-1", state: "succeeded", attempt: 1, cursorPersisted: true, recordCount: 0, candidateBudgetUsed: 0, candidateBudgetLimit: 50, lastErrorCode: null, createdAt: now, updatedAt: now, completedAt: now }),
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
    runNow: async () => ({ id: "intent-live-1", acquisitionRunId: "run-live-1", workspaceId: "workspace-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", policyVersionId: "policy-1", policyHash: "hash", accountId: "account-1", accountLoginStateVersion: 1, dailyBudgetId: "budget-1", localDate: "2026-08-25", trigger: "run_now", collectCreators: true, collectDemandComments: true, status: "queued", reason: null, createdBy: "user-1", createdAt: now }),
    getCrawlerStatus: async () => ({ runId: "run-live-1", state: "running", attempt: 1, cursorPersisted: true, recordCount: 25, candidateBudgetUsed: 1, candidateBudgetLimit: 50, lastErrorCode: null, createdAt: now, updatedAt: now, completedAt: null }),
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
assert.deepEqual(liveCandidateController.getState().candidates, [liveCandidate]);
assert.equal(liveCandidateReads, 1);
assert.equal(scheduledRunPolls.length, 1, "running crawl must schedule another poll after publishing candidates");
scheduledRunPolls.shift()?.();
await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
assert.equal(liveCandidateReads, 2, "scheduled polling must continue while candidates are already visible");
assert.equal(scheduledRunPolls.length, 1, "each running refresh must schedule the next poll");
liveCandidateController.close();

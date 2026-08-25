import { strict as assert } from "node:assert";
import { createDouyinAutomationController } from "./douyin-automation-controller";

const controller = createDouyinAutomationController({
  api: {
    listAccounts: async () => ({ items: [] }),
    createLoginSession: async () => ({ id: "login-1", platform: "douyin", state: "awaiting_scan", qrImageDataUrl: "data:image/png;base64,AA==", expiresAt: new Date(Date.now() + 60_000).toISOString(), account: null }),
    getLoginSession: async () => ({ id: "login-1", platform: "douyin", state: "active", qrImageDataUrl: null, expiresAt: new Date(Date.now() + 60_000).toISOString(), account: { id: "account-1", workspaceId: "workspace-1", platform: "douyin", displayName: "测试账号", state: "active", loginStateVersion: 1, revision: 1, etag: '"account:1"', lastValidatedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } }),
    disconnectAccount: async () => undefined,
    getAutomation: async () => ({ id: null, source: "default", workspaceId: "workspace-1", planId: "plan-1", planVersionId: "version-1", planVersion: 1, planSnapshotHash: "hash", accountId: null, accountLoginStateVersion: null, version: 0, revision: 0, etag: '"policy:0"', policyHash: "hash", keywords: [], schedule: { enabled: false, localTime: "09:30", timeZone: "Asia/Shanghai" }, dailyCandidateLimit: 50, collectCreators: true, collectDemandComments: true, limits: { maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3, maxDurationSeconds: 3600 }, createdBy: null, createdAt: null }),
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

import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import type { OutreachBatch, OutreachBatchApi } from "../acquisition/outreach-batch-api";
import { createOutreachBatchSelectionStore } from "../acquisition/outreach-batch-selection";
import {
  createRealConversationsController,
  shouldUseRealConversations
} from "./real-controller";
import type { RealConversationsApi, RealConversationsSnapshot } from "./real-api";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function domFixture() {
  const { document, window } = parseHTML(
    "<main id='main'></main><aside id='inspector'></aside>"
  );
  return {
    main: document.querySelector<HTMLElement>("#main")!,
    inspector: document.querySelector<HTMLElement>("#inspector")!,
    window
  };
}

function selectionFixture() {
  const values = new Map<string, string>();
  return createOutreachBatchSelectionStore({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); }
  });
}

function batch(
  candidateId = "candidate-1",
  state: OutreachBatch["state"] = "awaiting_approval",
  id = "batch-1"
): OutreachBatch {
  return {
    id,
    workspaceId: "workspace-1",
    runId: "run-1",
    planId: "plan-1",
    planVersionId: "plan-version-1",
    planVersion: 1,
    planSnapshotHash: `sha256:${"0".repeat(64)}`,
    policyVersionId: "policy-version-1",
    policyHash: `sha256:${"1".repeat(64)}`,
    accountId: "account-1",
    accountLoginStateVersion: 1,
    dailyBudgetId: `sha256:${"2".repeat(64)}`,
    localDate: "2026-08-27",
    dailyCandidateLimit: 20,
    dailyRemainingLimit: 19,
    revision: 1,
    etag: '"batch:1"',
    state,
    candidates: [{
      candidateId,
      selected: true,
      candidateRevision: 1,
      evidenceHashes: [`sha256:${"3".repeat(64)}`],
      publicProfileUrl: "https://www.douyin.com/user/actor-1",
      commentTargetPublicUrl: "https://www.douyin.com/video/video-1",
      draftRevision: 1,
      comment: "您好，看到您的公开评论。",
      commentHash: `sha256:${"4".repeat(64)}`,
      directMessage: "您好，可以提供一份公开需求方案参考。",
      directMessageHash: `sha256:${"5".repeat(64)}`,
      rationaleCodes: ["evidence_grounded"],
      modelSnapshotId: "model-snapshot-1",
      sourceModelSnapshotId: "source-model-snapshot-1",
      contentHash: `sha256:${"6".repeat(64)}`
    }],
    batchHash: `sha256:${"7".repeat(64)}`,
    approvedBy: state === "approved" ? "operator-1" : null,
    approvedAt: state === "approved" ? "2026-08-27T00:01:00.000Z" : null,
    approvalHash: state === "approved" ? `sha256:${"8".repeat(64)}` : null,
    rejectedBy: null,
    rejectedAt: null,
    rejectionReason: null,
    pauseReason: null,
    createdBy: "operator-1",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedBy: "operator-1",
    updatedAt: "2026-08-27T00:00:00.000Z"
  };
}

function outreachApi(overrides: Partial<OutreachBatchApi> = {}): OutreachBatchApi {
  return {
    async listBatches() { return { items: [], nextCursor: null }; },
    async createBatch() { return batch(); },
    async getBatch() { return batch(); },
    async updateBatch() { return batch(); },
    async approveBatch() { return batch("candidate-1", "approved"); },
    async rejectBatch() { return batch("candidate-1", "rejected"); },
    async pauseBatch() { return batch("candidate-1", "paused"); },
    async resumeBatch() { return batch("candidate-1", "approved"); },
    async listActions() { return { items: [] }; },
    ...overrides
  };
}

const snapshot: RealConversationsSnapshot = {
  generatedAt: "2026-08-26T08:00:00.000Z",
  runsRead: 1,
  accounts: [{
    id: "account-1",
    displayName: "抖音测试账号",
    state: "active",
    loginStateVersion: 1
  }],
  receiptAccess: "known_batch_id_only",
  truncatedRunIds: [],
  failedRuns: [],
  interactions: [{
    key: "run-1:candidate-1",
    candidateId: "candidate-1",
    runId: "run-1",
    taskId: "task-1",
    taskName: "展厅公开需求",
    runStatus: "succeeded",
    runUpdatedAt: "2026-08-26T07:50:00.000Z",
    displayName: "公开用户 A",
    candidateStatus: "new",
    excerpt: "公开评论证据",
    sourceUrl: "https://www.douyin.com/video/123",
    outreachEligible: true
  }]
};

assert.equal(shouldUseRealConversations("conversations", "real"), true);
assert.equal(shouldUseRealConversations("conversations", "demo"), false);
assert.equal(shouldUseRealConversations("dashboard", "real"), false);

{
  const { main, inspector } = domFixture();
  const selection = selectionFixture();
  const listCalls: Array<{
    runId: string;
    candidateId: string;
    limit: number | undefined;
    cursor: string | null | undefined;
  }> = [];
  const createCalls: Array<{ runId: string; candidateIds: string[] }> = [];
  const controller = createRealConversationsController({
    api: { async load() { return snapshot; } },
    outreachApi: outreachApi({
      async listBatches(runId, candidateId, limit, cursor) {
        listCalls.push({ runId, candidateId, limit, cursor });
        return { items: [], nextCursor: null };
      },
      async createBatch(runId, candidateIds) {
        createCalls.push({ runId, candidateIds: [...candidateIds] });
        return batch();
      }
    }),
    batchSelection: selection,
    outreachPollDelayMs: 1,
    main,
    inspector
  });

  await controller.open();
  assert.deepEqual(listCalls, [{
    runId: "run-1",
    candidateId: "candidate-1",
    limit: 1,
    cursor: null
  }]);
  await controller.createOutreachForSelected();
  assert.deepEqual(createCalls, [{ runId: "run-1", candidateIds: ["candidate-1"] }]);
  assert.equal(selection.read(), "batch-1");
  assert.match(main.innerHTML, /精确公开评论/u);
  assert.doesNotMatch(main.innerHTML, /发送不可用|平台回复（未接入）/u);
  controller.destroy();
}

{
  const { main, inspector } = domFixture();
  let listCount = 0;
  let createCount = 0;
  const profileSnapshot: RealConversationsSnapshot = {
    ...snapshot,
    interactions: [{
      ...snapshot.interactions[0]!,
      key: "run-1:candidate-profile",
      candidateId: "candidate-profile",
      sourceUrl: "https://www.douyin.com/user/public-profile",
      outreachEligible: false
    }]
  };
  const controller = createRealConversationsController({
    api: { async load() { return profileSnapshot; } },
    outreachApi: outreachApi({
      async listBatches() { listCount += 1; return { items: [], nextCursor: null }; },
      async createBatch() { createCount += 1; return batch(); }
    }),
    batchSelection: selectionFixture(),
    main,
    inspector
  });
  await controller.open();
  await controller.createOutreachForSelected();
  assert.equal(listCount, 0, "profile-only evidence must remain readable without batch recovery");
  assert.equal(createCount, 0, "profile-only evidence must never create outreach");
  assert.match(main.innerHTML, /公开来源不符合精确评论条件/u);
  controller.destroy();
}

{
  const { main, inspector } = domFixture();
  const listCalls: Array<[string, string, number | undefined, string | null | undefined]> = [];
  const getCalls: string[] = [];
  const selection = selectionFixture();
  const latest = batch();
  const controller = createRealConversationsController({
    api: { async load() { return snapshot; } },
    outreachApi: outreachApi({
      async listBatches(runId, candidateId, limit, cursor) {
        listCalls.push([runId, candidateId, limit, cursor]);
        return { items: [latest], nextCursor: null };
      },
      async getBatch(batchId) { getCalls.push(batchId); return latest; }
    }),
    batchSelection: selection,
    main,
    inspector
  });
  await controller.open();
  assert.deepEqual(listCalls, [["run-1", "candidate-1", 1, null]]);
  assert.deepEqual(getCalls, ["batch-1"]);
  assert.equal(controller.getState().outreach.batch?.id, "batch-1");
  assert.equal(selection.read(), "batch-1");
  controller.destroy();
}

{
  const { main, inspector } = domFixture();
  const reopened = deferred<RealConversationsSnapshot>();
  let loadCount = 0;
  const controller = createRealConversationsController({
    api: {
      load() {
        loadCount += 1;
        return loadCount === 1 ? Promise.resolve(snapshot) : reopened.promise;
      }
    },
    outreachApi: outreachApi({
      async listBatches() { return { items: [batch()], nextCursor: null }; }
    }),
    batchSelection: selectionFixture(),
    main,
    inspector
  });
  await controller.open();
  assert.equal(controller.getState().outreach.batch?.id, "batch-1");
  const pendingOpen = controller.open();
  const outreachDuringReopen = controller.getState().outreach;
  const htmlDuringReopen = main.innerHTML;
  reopened.resolve(snapshot);
  await pendingOpen;
  controller.destroy();
  assert.equal(outreachDuringReopen.phase, "loading");
  assert.equal(outreachDuringReopen.batch, null,
    "reopen must hide the previously loaded batch before snapshot recovery finishes");
  assert.doesNotMatch(htmlDuringReopen, /data-outreach-confirm|精确公开评论/u);
}

{
  const { main, inspector } = domFixture();
  const selection = selectionFixture();
  let listCount = 0;
  let getCount = 0;
  const controller = createRealConversationsController({
    api: { async load() { return snapshot; } },
    outreachApi: outreachApi({
      async listBatches() {
        listCount += 1;
        return {
          items: [listCount === 1
            ? batch("candidate-1", "awaiting_approval", "batch-old")
            : batch("candidate-1", "awaiting_approval", "batch-latest")],
          nextCursor: null
        };
      },
      async getBatch() {
        getCount += 1;
        if (getCount === 1) {
          return batch("candidate-1", "awaiting_approval", "batch-old");
        }
        throw new Error("latest batch unavailable");
      }
    }),
    batchSelection: selection,
    main,
    inspector
  });
  await controller.open();
  assert.equal(selection.read(), "batch-old");
  await controller.open();
  assert.equal(controller.getState().outreach.phase, "error");
  assert.equal(controller.getState().outreach.batch, null,
    "getBatch failure must not retain the previously approvable batch");
  assert.deepEqual(controller.getState().outreach.drafts, {});
  assert.deepEqual(controller.getState().outreach.actions, []);
  assert.equal(selection.read(), null);
  assert.doesNotMatch(main.innerHTML, /data-outreach-confirm|精确公开评论/u);
  controller.destroy();
}

{
  const { main, inspector } = domFixture();
  const selection = selectionFixture();
  let wrongIdActionReads = 0;
  const controller = createRealConversationsController({
    api: { async load() { return snapshot; } },
    outreachApi: outreachApi({
      async listBatches() {
        return {
          items: [batch("candidate-1", "awaiting_approval", "batch-latest")],
          nextCursor: null
        };
      },
      async getBatch() {
        return batch("candidate-1", "awaiting_approval", "batch-wrong");
      },
      async listActions() {
        wrongIdActionReads += 1;
        return { items: [] };
      }
    }),
    batchSelection: selection,
    main,
    inspector
  });
  await controller.open();
  assert.equal(controller.getState().outreach.batch, null,
    "same run/candidate must not permit a batch id different from the listed latest id");
  assert.deepEqual(controller.getState().outreach.drafts, {});
  assert.deepEqual(controller.getState().outreach.actions, []);
  assert.equal(selection.read(), null);
  assert.equal(wrongIdActionReads, 0,
    "a mismatched getBatch response must not start receipt polling");
  assert.doesNotMatch(main.innerHTML, /data-outreach-confirm|精确公开评论/u);
  controller.destroy();
}

{
  const { main, inspector } = domFixture();
  const selection = selectionFixture();
  selection.remember("batch-stale");
  const controller = createRealConversationsController({
    api: { async load() { return snapshot; } },
    outreachApi: outreachApi({
      async listBatches() {
        return { items: [batch("candidate-other", "awaiting_approval", "batch-other")], nextCursor: null };
      },
      async getBatch() {
        return batch("candidate-other", "awaiting_approval", "batch-other");
      }
    }),
    batchSelection: selection,
    main,
    inspector
  });
  await controller.open();
  assert.equal(controller.getState().outreach.batch, null);
  assert.doesNotMatch(main.innerHTML, /原始精确评论|候选人 1/u);
  controller.destroy();
}

{
  const { main, inspector } = domFixture();
  let actionSignal: AbortSignal | undefined;
  const controller = createRealConversationsController({
    api: { async load() { return snapshot; } },
    outreachApi: outreachApi({
      async listBatches() {
        return { items: [batch("candidate-1", "approved")], nextCursor: null };
      },
      async getBatch() { return batch("candidate-1", "approved"); },
      listActions(_batchId, signal) {
        actionSignal = signal;
        return new Promise(() => undefined);
      }
    }),
    batchSelection: selectionFixture(),
    outreachPollDelayMs: 1,
    main,
    inspector
  });
  await controller.open();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(actionSignal?.aborted, false);
  controller.deactivate();
  assert.equal(actionSignal?.aborted, true, "deactivate must abort receipt polling");
  controller.destroy();
}

{
  const first = deferred<RealConversationsSnapshot>();
  let reads = 0;
  const { main, inspector } = domFixture();
  const api: RealConversationsApi = {
    load() {
      reads += 1;
      return reads === 1
        ? first.promise
        : Promise.resolve({ ...snapshot, interactions: [] });
    }
  };
  const controller = createRealConversationsController({
    api,
    outreachApi: outreachApi(),
    batchSelection: selectionFixture(),
    main,
    inspector
  });
  const oldRequest = controller.open();
  await controller.open();
  first.resolve(snapshot);
  await oldRequest;
  assert.equal(controller.getState().snapshot?.interactions.length, 0);
  controller.destroy();
}

{
  const pending = deferred<RealConversationsSnapshot>();
  const { main, inspector } = domFixture();
  const controller = createRealConversationsController({
    api: { load: () => pending.promise },
    outreachApi: outreachApi(),
    batchSelection: selectionFixture(),
    main,
    inspector
  });
  const operation = controller.open();
  controller.deactivate();
  main.innerHTML = "<h2>其他模块</h2>";
  inspector.innerHTML = "<p>其他模块</p>";
  pending.resolve(snapshot);
  await operation;
  assert.equal(main.innerHTML, "<h2>其他模块</h2>");
  assert.equal(inspector.innerHTML, "<p>其他模块</p>");
  controller.destroy();
}

{
  const { main, inspector, window } = domFixture();
  let reads = 0;
  const controller = createRealConversationsController({
    api: { async load() { reads += 1; return snapshot; } },
    outreachApi: outreachApi({
      async listBatches() { return { items: [batch()], nextCursor: null }; }
    }),
    batchSelection: selectionFixture(),
    main,
    inspector
  });
  await controller.open();
  const originalDraft = controller.getState().outreach.drafts["candidate-1"]?.comment;
  controller.destroy();
  main.querySelector<HTMLElement>("[data-real-conversations-action=retry]")
    ?.dispatchEvent(new window.Event("click", { bubbles: true }));
  const textarea = main.querySelector<HTMLTextAreaElement>("[data-outreach-field=comment]");
  if (textarea) {
    textarea.value = "销毁后不应写入";
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reads, 1, "destroy must remove real-conversation click delegation");
  assert.equal(
    controller.getState().outreach.drafts["candidate-1"]?.comment,
    originalDraft,
    "destroy must remove outreach input delegation"
  );
}

{
  const controller = createRealConversationsController({
    api: { async load() { throw new Error("真实公开互动读取失败"); } },
    outreachApi: outreachApi(),
    batchSelection: selectionFixture()
  });
  await assert.rejects(() => controller.open(), /真实公开互动读取失败/u);
  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().error, "真实公开互动读取失败");
  controller.destroy();
}

{
  const { main, inspector, window } = domFixture();
  const approvedBatch = batch("candidate-1", "approved");
  const successfulComment = {
    id: "action-comment-success",
    workspaceId: "workspace-1",
    batchId: approvedBatch.id,
    batchRevision: approvedBatch.revision,
    candidateId: "candidate-1",
    accountId: approvedBatch.accountId,
    accountLoginStateVersion: approvedBatch.accountLoginStateVersion,
    policyVersionId: approvedBatch.policyVersionId,
    localDate: approvedBatch.localDate,
    kind: "comment" as const,
    sequence: 1 as const,
    status: "succeeded" as const,
    predecessorActionId: null,
    targetPublicUrl: approvedBatch.candidates[0]!.commentTargetPublicUrl,
    content: approvedBatch.candidates[0]!.comment,
    contentHash: approvedBatch.candidates[0]!.commentHash,
    approvalHash: approvedBatch.approvalHash!,
    createdAt: "2026-08-27T00:01:00.000Z",
    attemptCount: 1,
    platformReceiptReference: "douyin-comment:receipt-conversations",
    occurredAt: "2026-08-27T00:02:00.000Z",
    failureCode: null
  };
  const approvals: Array<{
    dailyLimit: number;
    candidates: Array<{ candidateId: string; directMessage: string }>;
  }> = [];
  const controller = createRealConversationsController({
    api: { async load() { return snapshot; } },
    outreachApi: outreachApi({
      async listBatches() {
        return { items: [approvedBatch], nextCursor: null };
      },
      async getBatch() { return approvedBatch; },
      async listActions() { return { items: [successfulComment] }; },
      async approveDirectMessages(_batchId, body) {
        approvals.push({
          dailyLimit: body.dailyLimit,
          candidates: body.candidates
        });
        return approvedBatch;
      }
    }),
    batchSelection: selectionFixture(),
    outreachPollDelayMs: 60_000,
    main,
    inspector
  });
  await controller.open();
  await new Promise((resolve) => setImmediate(resolve));
  const editor = main.querySelector<HTMLTextAreaElement>(
    "[data-outreach-field=directMessage]"
  )!;
  assert.equal(editor.disabled, false,
    "the social-conversations controller must share the DM editor unlock");
  editor.value = "社媒对话中人工修订的精确私信";
  editor.dispatchEvent(new window.Event("input", { bubbles: true }));
  const confirmation = main.querySelector<HTMLInputElement>(
    "[data-outreach-direct-message-confirm]"
  )!;
  const approvalButton = main.querySelector<HTMLButtonElement>(
    "[data-outreach-action=approve-direct-messages]"
  )!;
  confirmation.checked = true;
  confirmation.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(approvalButton.disabled, false);
  approvalButton.dispatchEvent(new window.Event("click", { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(approvals, [{
    dailyLimit: 20,
    candidates: [{
      candidateId: "candidate-1",
      directMessage: "社媒对话中人工修订的精确私信"
    }]
  }]);
  controller.destroy();
}

console.log(JSON.stringify({ ok: true, suite: "real-conversations-controller" }));

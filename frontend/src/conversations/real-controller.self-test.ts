import { strict as assert } from "node:assert";
import { parseHTML } from "linkedom";
import type { OutreachAction, OutreachBatch, OutreachBatchApi } from "../acquisition/outreach-batch-api";
import { createOutreachBatchSelectionStore } from "../acquisition/outreach-batch-selection";
import {
  createRealConversationsController,
  shouldUseRealConversations
} from "./real-controller";
import { createConversationCaptureFixture } from "./real-capture-fixture";
import { createRealConversationsApi, type RealConversationsApi, type RealConversationsSnapshot } from "./real-api";

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
    planId: "plan-1",
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
  const { main, inspector, window } = domFixture();
  const retainedBatch = batch("candidate-1", "approved");
  const receipts: OutreachAction[] = (["comment", "direct_message"] as const).map((kind) => ({
    id: `retained-${kind}`, workspaceId: retainedBatch.workspaceId,
    batchId: retainedBatch.id, batchRevision: retainedBatch.revision,
    candidateId: "candidate-1", accountId: retainedBatch.accountId,
    accountLoginStateVersion: retainedBatch.accountLoginStateVersion,
    policyVersionId: retainedBatch.policyVersionId, localDate: retainedBatch.localDate,
    kind, sequence: kind === "comment" ? 1 : 2, status: "succeeded", predecessorActionId: null,
    targetPublicUrl: kind === "comment" ? retainedBatch.candidates[0]!.commentTargetPublicUrl
      : retainedBatch.candidates[0]!.publicProfileUrl,
    content: kind === "comment" ? retainedBatch.candidates[0]!.comment : retainedBatch.candidates[0]!.directMessage,
    contentHash: kind === "comment" ? retainedBatch.candidates[0]!.commentHash : retainedBatch.candidates[0]!.directMessageHash,
    approvalHash: retainedBatch.approvalHash!, createdAt: retainedBatch.createdAt,
    attemptCount: 1, platformReceiptReference: `douyin:retained-${kind}`,
    occurredAt: retainedBatch.createdAt, failureCode: null
  }));
  const reads: string[] = [];
  const detailRequests: unknown[] = [];
  const captureDetailRequest = (event: Event) => {
    detailRequests.push((event as CustomEvent).detail);
  };
  main.ownerDocument.addEventListener("goodjob:acquisition-detail-open-requested", captureDetailRequest);
  const profileCandidates = Array.from({ length: 49 }, (_, index) => ({
    id: index === 0 ? "candidate-profile" : `candidate-profile-${index + 1}`,
    status: "creator_candidate",
    displayName: `公开主页 ${index + 1}`,
    evidence: { sourceUrl: `https://www.douyin.com/user/actor-${index + 2}`, excerpt: "公开资料" }
  }));
  const controller = createRealConversationsController({
    api: createRealConversationsApi(async (input, init) => {
      const path = String(input);
      reads.push(path);
      assert.equal(init?.method, "GET");
      assert.equal(init?.credentials, "same-origin");
      assert.equal(init?.body, undefined);
      let body: unknown;
      if (path.includes("/overview?")) body = {
        generatedAt: snapshot.generatedAt, platform: "douyin", totals: { tasks: 1 },
        statusCounts: { cancelled: 1 }, discoveryMethodCounts: { public_search: 1 },
        tasks: [{ id: "task-social-retained", planId: "plan-1", name: "保留采集结果", platform: "douyin",
          discoveryMethods: ["public_search"], latestResultRunId: "run-1",
          latestRun: { id: "run-later-cancelled", status: "cancelled", updatedAt: snapshot.generatedAt,
            consumedBudget: { requests: 0, results: 0, durationSeconds: 0 } } }]
      };
      else if (path.endsWith("/social-accounts/douyin")) body = { items: [] };
      else if (path.endsWith("/runs/run-1")) body = { id: "run-1", planId: "plan-1",
        status: "succeeded", updatedAt: "2026-08-25T08:00:00.000Z" };
      else if (path.endsWith("/runs/run-1/candidates")) body = {
        items: profileCandidates.slice(0, 25), nextCursor: "second-page"
      };
      else if (path.endsWith("/candidates?cursor=second-page")) body = { items: [
        { ...profileCandidates[0]!, evidence: {
          ...profileCandidates[0]!.evidence, excerpt: "最终公开资料"
        } },
        ...profileCandidates.slice(25),
        {
          id: "candidate-1", status: "new", displayName: "第二页已联系候选",
          evidence: { sourceUrl: "https://www.douyin.com/video/123", excerpt: "保留公开需求" }
        }
      ], nextCursor: null };
      else throw new Error(`Unexpected request ${path}`);
      return new Response(JSON.stringify(body), { status: 200 });
    }),
    outreachApi: outreachApi({
      async listBatches(runId, candidateId, limit) {
        reads.push(`batches:${runId}:${candidateId}`);
        assert.equal(runId, "run-1");
        assert.equal(candidateId, "candidate-1");
        assert.equal(limit, 50);
        return { items: [retainedBatch], nextCursor: null };
      },
      async getBatch(id) { reads.push(`batch:${id}`); return retainedBatch; },
      async listActions(id) { reads.push(`receipts:${id}`); return { items: receipts }; },
      async createBatch() { throw new Error("Opening retained data must never create a batch"); },
      async approveBatch() { throw new Error("Opening retained data must never approve outreach"); }
    }),
    main, inspector, batchSelection: selectionFixture(), outreachPollDelayMs: 60_000
  });
  try {
    await controller.open();
    const loaded = controller.getState().snapshot!;
    assert.equal(loaded.interactions.length, 50,
      "Social must retain all 50 persisted candidates across pages without counting an overlapping candidate twice");
    assert.equal(new Set(loaded.interactions.map((item) => item.key)).size, 50);
    assert.equal(loaded.interactions[0]?.excerpt, "最终公开资料",
      "a continuation page must update duplicate evidence without shifting the candidate's position");
    assert.ok(loaded.interactions.every((item) => item.runId === "run-1"));
    assert.deepEqual(loaded.failedRuns, []);
    assert.deepEqual(loaded.truncatedRunIds, []);
    assert.deepEqual(reads.filter((path) => path.includes("/candidates")), [
      "/api/v1/acquisition/runs/run-1/candidates",
      "/api/v1/acquisition/runs/run-1/candidates?cursor=second-page"
    ]);
    assert.deepEqual(detailRequests, [],
      "loading Social candidates must not implicitly open candidate review or hand off to CRM");
    const profileReviewEntry = main.querySelector<HTMLButtonElement>("[data-real-conversations-action=review-candidate]");
    assert.ok(profileReviewEntry, "a profile-only recipient needs a review/private-domain entry without sending outreach");
    assert.equal(profileReviewEntry.disabled, false);
    const readsBeforeProfileReview = reads.length;
    profileReviewEntry.click();
    assert.deepEqual(detailRequests, [{
      mode: "candidates", planId: "plan-1", candidateId: "candidate-profile",
      candidateRunId: "run-1"
    }], "Social must forward the real planId, not its distinct taskId");
    assert.equal(reads.length, readsBeforeProfileReview,
      "the entry must only dispatch the existing detail route, never start another acquisition or outreach command");
    const recipients = main.querySelectorAll<HTMLElement>("[data-real-conversations-action=select]");
    assert.equal(recipients.length, 50);
    assert.equal(recipients[49]?.dataset.interactionKey, "run-1:candidate-1");
    assert.match(main.textContent ?? "", /第二页已联系候选/u);
    recipients[49]!.dispatchEvent(new window.Event("click", { bubbles: true }));
    await controller.whenIdle();
    assert.equal(controller.getState().selectedInteractionKey, "run-1:candidate-1");
    assert.ok(reads.includes("batches:run-1:candidate-1"));
    assert.ok(reads.includes(`receipts:${retainedBatch.id}`));
    assert.equal(controller.getState().outreach.batch?.id, retainedBatch.id);
    assert.ok(main.querySelector("[data-real-conversations-outreach-host]"));
    assert.match(main.textContent ?? "", /douyin:retained-direct_message/u);
    const search = main.querySelector<HTMLInputElement>("[data-real-conversations-candidate-search]")!;
    search.value = "第二页已联系候选";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(main.querySelectorAll("[data-real-conversations-action=select]").length, 1);
    assert.match(main.querySelector(".real-conversation-list")?.textContent ?? "", /50 位已采集真实候选/u);
    assert.equal(controller.getState().selectedInteractionKey, "run-1:candidate-1");
    const currentSearch = main.querySelector<HTMLInputElement>("[data-real-conversations-candidate-search]")!;
    currentSearch.value = "";
    currentSearch.dispatchEvent(new window.Event("input", { bubbles: true }));
    for (const tab of ["comments", "history"] as const) {
      main.querySelector<HTMLElement>(`[data-real-conversations-tab="${tab}"]`)!
        .dispatchEvent(new window.Event("click", { bubbles: true }));
      assert.match(main.textContent ?? "", /第二页已联系候选/u);
      assert.ok(main.querySelector("[data-real-conversations-outreach-host]"));
      assert.equal(main.querySelectorAll("[data-real-conversations-action=select]").length, 50);
      assert.equal(controller.getState().selectedInteractionKey, "run-1:candidate-1");
      const readsBeforeReview = reads.length;
      main.querySelector<HTMLButtonElement>("[data-real-conversations-action=review-candidate]")!.click();
      assert.deepEqual(detailRequests.at(-1), {
        mode: "candidates", planId: "plan-1", candidateId: "candidate-1",
        candidateRunId: "run-1"
      }, `${tab} must route the current recipient through the same review entry`);
      assert.equal(reads.length, readsBeforeReview);
    }
    assert.ok(main.querySelector("[data-outreach-receipts]"));
    assert.match(main.textContent ?? "", /douyin:retained-comment/u);
    assert.match(main.textContent ?? "", /douyin:retained-direct_message/u);
    main.querySelector<HTMLElement>('[data-interaction-key="run-1:candidate-profile"]')!
      .dispatchEvent(new window.Event("click", { bubbles: true }));
    await controller.whenIdle();
    assert.equal(controller.getState().selectedInteractionKey, "run-1:candidate-profile");
    assert.equal(controller.getState().outreach.batch, null);
    assert.equal(reads.filter((path) => path.startsWith("batches:")).length, 1,
      "switching to a profile-only candidate must not issue outreach discovery");
    main.querySelector<HTMLElement>('[data-interaction-key="run-1:candidate-1"]')!
      .dispatchEvent(new window.Event("click", { bubbles: true }));
    await controller.whenIdle();
    assert.equal(controller.getState().selectedInteractionKey, "run-1:candidate-1");
    assert.equal(controller.getState().outreach.batch?.id, retainedBatch.id);
    const staleReviewEntry = main.querySelector<HTMLButtonElement>("[data-real-conversations-action=review-candidate]")!;
    const requestsBeforeDeactivation = detailRequests.length;
    controller.deactivate();
    staleReviewEntry.click();
    assert.equal(detailRequests.length, requestsBeforeDeactivation,
      "a deactivated Social route must not open a candidate from its stale DOM");
  } finally {
    controller.destroy();
    main.ownerDocument.removeEventListener("goodjob:acquisition-detail-open-requested", captureDetailRequest);
  }
}

{
  const { main, inspector, window } = domFixture();
  let loadCount = 0;
  let listCount = 0;
  const controller = createRealConversationsController({
    api: {
      async load() {
        loadCount += 1;
        throw new Error("capture fixture must not call the real conversations API");
      }
    },
    outreachApi: outreachApi({
      async listBatches() {
        listCount += 1;
        throw new Error("capture fixture must not recover outreach batches");
      }
    }),
    batchSelection: selectionFixture(),
    captureFixture: createConversationCaptureFixture(),
    main,
    inspector
  });
  await controller.open();
  assert.equal(loadCount, 0);
  assert.equal(listCount, 0);
  assert.match(main.innerHTML, /天选财税人/u);
  assert.match(main.innerHTML, /当前私信收件人/u);
  assert.match(main.innerHTML, /data-outreach-direct-message-compose/u);
  assert.match(main.innerHTML, /确认并排队私信/u);
  for (const tab of ["comments", "history"] as const) {
    inspector.hidden = false;
    inspector.innerHTML = "<section>旧路由技术详情</section>";
    main.querySelector<HTMLElement>(`[data-real-conversations-tab="${tab}"]`)!
      .dispatchEvent(new window.Event("click", { bubbles: true }));
    assert.equal(main.querySelector<HTMLElement>(
      `[data-real-conversations-tab="${tab}"]`
    )?.getAttribute("aria-current"), "page");
    assert.equal(main.querySelector("[data-outreach-direct-message-compose]"), null,
      `${tab} must retain its own workspace instead of the private-message composer`);
    assert.ok(main.querySelector("[data-real-conversations-help]"),
      `${tab} must keep the operational guidance inside the main workspace`);
    assert.equal(main.querySelector("[data-real-conversations-help]")?.hasAttribute("open"), false,
      `${tab} must keep operational guidance collapsed by default`);
    assert.equal(inspector.hidden, true,
      `${tab} must hide the shared technical inspector after a tab transition`);
    assert.equal(inspector.innerHTML, "",
      `${tab} must clear stale technical inspector content after a tab transition`);
  }
  controller.destroy();
}

{
  const { main, inspector, window } = domFixture();
  const history = [batch(), batch("candidate-1", "approved", "batch-older")];
  const gets: string[] = [];
  let writes = 0;
  const controller = createRealConversationsController({
    api: { async load() { return snapshot; } },
    outreachApi: outreachApi({
      async listBatches() { return { items: history, nextCursor: null }; },
      async getBatch(id) { gets.push(id); return history.find((item) => item.id === id)!; },
      async createBatch() { writes++; return batch(); },
      async approveBatch() { writes++; return history[1]!; }
    }),
    batchSelection: selectionFixture(), main, inspector, outreachPollDelayMs: 60_000
  });
  await controller.open();
  assert.equal(main.querySelector("[data-real-conversations-batch]"), null,
    "the private-message editor must not contain historical approval controls");
  main.querySelector<HTMLElement>('[data-real-conversations-tab="history"]')!
    .dispatchEvent(new window.Event("click", { bubbles: true }));
  const picker = main.querySelector<HTMLSelectElement>("[data-real-conversations-batch]");
  assert.ok(picker, "older actions must remain accessible when a newer draft exists");
  picker.querySelector<HTMLOptionElement>('[value="batch-older"]')!.selected = true;
  picker.dispatchEvent(new window.Event("change", { bubbles: true }));
  await controller.whenIdle();
  assert.equal(controller.getState().outreach.batch?.id, "batch-older");
  assert.deepEqual(gets, ["batch-1", "batch-older"]);
  assert.equal(writes, 0, "history selection must never create, approve or resend");
  assert.equal(main.querySelector<HTMLInputElement>("[data-outreach-confirm]")?.checked ?? false, false);
  controller.destroy();
}

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
    limit: 50,
    cursor: null
  }]);
  await controller.createOutreachForSelected();
  assert.deepEqual(createCalls, [{ runId: "run-1", candidateIds: ["candidate-1"] }]);
  assert.equal(selection.read(), "batch-1");
  assert.match(main.innerHTML, /私信独立授权/u);
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
  assert.deepEqual(listCalls, [["run-1", "candidate-1", 50, null]]);
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
  const { main, inspector, window } = domFixture();
  const controller = createRealConversationsController({
    api: { async load() { return snapshot; } },
    outreachApi: outreachApi({
      async listBatches() { return { items: [batch()], nextCursor: null }; }
    }),
    batchSelection: selectionFixture(), main, inspector
  });
  await controller.open();
  const editor = main.querySelector<HTMLTextAreaElement>(
    '[data-outreach-field="directMessage"]'
  )!;
  editor.value = "搜索和切换标签时必须保留的本地私信";
  editor.dispatchEvent(new window.Event("input", { bubbles: true }));
  const limit = main.querySelector<HTMLInputElement>(
    "[data-outreach-direct-message-limit]"
  )!;
  limit.value = "100";
  limit.dispatchEvent(new window.Event("input", { bubbles: true }));
  const query = main.querySelector<HTMLInputElement>(
    "[data-real-conversations-candidate-search]"
  )!;
  query.value = "公开用户";
  query.dispatchEvent(new window.Event("input", { bubbles: true }));
  assert.equal(editor.value, "搜索和切换标签时必须保留的本地私信",
    "search rendering must read silently updated drafts, not a stale subscriber snapshot");
  assert.equal(limit.value, "100");
  assert.equal(controller.getState().selectedInteractionKey, "run-1:candidate-1");
  for (const tab of ["history", "direct_messages"]) {
    main.querySelector<HTMLElement>(`[data-real-conversations-tab="${tab}"]`)!
      .dispatchEvent(new window.Event("click", { bubbles: true }));
  }
  assert.equal(main.querySelector<HTMLTextAreaElement>(
    '[data-outreach-field="directMessage"]'
  )?.value, "搜索和切换标签时必须保留的本地私信");
  assert.equal(main.querySelector<HTMLInputElement>(
    "[data-outreach-direct-message-limit]"
  )?.value, "100");
  assert.equal(main.querySelector<HTMLInputElement>(
    "[data-outreach-direct-message-confirm]"
  )?.hasAttribute("checked"), false);
  assert.equal(controller.getState().outreach.directMessageConfirmed, false);
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
    dailyLimit: 50,
    candidates: [{
      candidateId: "candidate-1",
      directMessage: "社媒对话中人工修订的精确私信"
    }]
  }]);
  controller.destroy();
}

{
  const { main, inspector } = domFixture();
  const multi = batch("candidate-1", "awaiting_approval");
  multi.candidates.push({
    ...multi.candidates[0]!,
    candidateId: "candidate-2",
    publicProfileUrl: "https://www.douyin.com/user/actor-2",
    commentTargetPublicUrl: "https://www.douyin.com/video/456"
  });
  const controller = createRealConversationsController({
    api: { async load() { return snapshot; } },
    outreachApi: outreachApi({
      async listBatches() { return { items: [multi], nextCursor: null }; },
      async getBatch() { return multi; }
    }),
    batchSelection: selectionFixture(),
    main,
    inspector
  });
  await controller.open();
  assert.deepEqual(controller.getState().outreach.directMessageSelectedCandidateIds,
    ["candidate-1"],
    "a recovered multi-candidate batch must scope DM approval to the current left-side recipient");
  assert.equal(main.querySelectorAll("[data-outreach-direct-message-state]").length, 1,
    "the single-recipient composer must not render other batch candidates");
  assert.match(main.textContent ?? "", /公开用户 A/u);
  controller.destroy();
}

console.log(JSON.stringify({ ok: true, suite: "real-conversations-controller" }));

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createAcquisitionDetailApi } from "./detail-center-api";
import { createAcquisitionDetailCenterController } from "./detail-center-controller";

const candidateId = "candidate-retained";
const historicalRunId = "run-september-5";
const latestRunId = "run-later-empty";
const summary = {
  sourcesSearched: 0, pagesAnalyzed: 0, organizationsFound: 0,
  dedupedCandidates: 0, validOpportunities: 0, highIntent: 0,
  financialEvaluatedHighIntentCount: 0, financialPendingHighIntentCount: 0,
  expectedRevenueByCurrency: []
};

function presentation(runId: string, events: unknown[] = [], nextAfter = "") {
  return {
    run: { id: runId, status: "cancelled", etag: '"run:1"',
      updatedAt: "2026-09-10T06:00:00.000Z", completedAt: "2026-09-10T06:00:00.000Z" },
    summary, providers: [], candidateEvents: events,
    hasMore: Boolean(nextAfter), nextAfter
  };
}

function fixture(options: {
  status?: "normalized" | "pending_review" | "approved";
  source?: "second_page" | "wrong_run" | "missing_candidate" | "repeated_cursor";
  sourceGate?: Promise<void>;
  onSourceRead?: () => void;
} = {}) {
  const { document } = parseHTML('<dialog id="detail"><div id="body"></div></dialog>');
  const root = document.querySelector<HTMLElement>("#detail")!;
  const body = document.querySelector<HTMLElement>("#body")!;
  const events = new EventTarget();
  const requests: string[] = [];
  const attemptedWrites: string[] = [];
  let readerBridgeCreates = 0;
  const latest = presentation(latestRunId);
  const api = createAcquisitionDetailApi(async (input, init) => {
    const path = String(input);
    if ((init?.method ?? "GET") !== "GET") {
      attemptedWrites.push(path);
      throw new Error(`Unexpected write: ${path}`);
    }
    requests.push(path);
    const url = new URL(path, "http://fixture.invalid");
    if (url.pathname.endsWith("/tasks/plan-retained")) return Response.json({
      task: { id: "task-retained", planId: "plan-retained", name: "工业除尘",
        platform: "douyin", discoveryMethods: ["public_search"], latestRun: latest.run,
        updatedAt: latest.run.updatedAt },
      plan: { id: "plan-retained", status: "approved" },
      latestRun: { ...latest.run, evidenceCount: 0,
        consumedBudget: { requests: 0, results: 0, amountMinor: 0, durationSeconds: 0 } },
      shards: [], presentation: latest
    });
    if (url.pathname.endsWith(`/runs/${historicalRunId}/presentation`)) {
      options.onSourceRead?.();
      await options.sourceGate;
      if (options.source === "wrong_run") return Response.json(presentation(latestRunId));
      if (options.source === "missing_candidate") return Response.json(presentation(historicalRunId));
      if (!url.searchParams.has("after") || options.source === "repeated_cursor") {
        return Response.json(presentation(historicalRunId, [{
          eventId: "event-unrelated", candidateId: "another-candidate"
        }], "after-first-page"));
      }
      return Response.json(presentation(historicalRunId, [{
        eventId: "event-retained-discovered", candidateId
      }]));
    }
    const requestedCandidate = url.pathname.match(/\/candidates\/(candidate-retained|candidate-other)$/)?.[1];
    if (requestedCandidate) return Response.json({
      id: requestedCandidate, publicDisplayName: requestedCandidate === candidateId ? "今日原理" : "另一候选", subjectKind: "individual",
      publicActorKey: "public-actor", publicProfileUrl: "https://www.douyin.com/user/public-actor",
      sourcePlatform: "douyin", evidenceIds: ["evidence-retained"],
      status: options.status ?? "normalized", identityResolved: true, version: 1,
      latestDecisionVersion: !options.status || options.status === "normalized" ? null : "decision-reviewed",
      approvedDecisionVersion: options.status === "approved" ? "decision-reviewed" : null,
      updatedAt: "2026-09-05T08:00:00.000Z"
    });
    if (url.pathname.endsWith("/evidence")) return Response.json({ items: [{
      id: "evidence-retained", candidateId, subjectKind: "individual",
      sourceUrl: "https://www.douyin.com/video/retained-public-video",
      sourceTitle: "工业除尘公开证据", sourceSnippet: "9月5日工业除尘公开需求",
      targetType: "individual_signal", sourcePlatform: "douyin", locale: "zh-CN",
      fetchedAt: "2026-09-05T08:00:00.000Z", publishedAt: "2026-09-05T08:00:00.000Z",
      rawArtifactHash: "artifact-retained", contentHash: "content-retained",
      provenance: { sourceUrl: "https://www.douyin.com/video/retained-public-video" }, accessStatus: "public_content"
    }], nextCursor: null });
    if (url.pathname.endsWith("/reviews")) return Response.json({ items: [], nextCursor: null });
    if (url.pathname.endsWith("/qualification") && options.status && options.status !== "normalized") {
      return Response.json({ decisionVersion: "decision-reviewed", grade: "A", score: 80,
        confidence: 0.8, hardGateFailures: [], reasons: [], positiveSignals: [], negativeSignals: [] });
    }
    if (/\/(qualification|financial-value|battle-card|intelligence-operation|douyin-identity-resolution-operation|private-domain-handoff)$/.test(url.pathname)) {
      return new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected read: ${path}`);
  });
  const controller = createAcquisitionDetailCenterController({ api, root, body, eventTarget: events,
    visualReaderBridgeFactory() {
      readerBridgeCreates += 1;
      throw new Error("Direct review must not connect the browser reader");
    }
  });
  async function open() {
    events.dispatchEvent(new CustomEvent("goodjob:acquisition-detail-open-requested", { detail: {
      mode: "candidates", planId: "plan-retained", candidateId, candidateRunId: historicalRunId
    } }));
    await controller.whenIdle();
    await controller.whenIdle();
  }
  return { controller, open, body, root, requests, attemptedWrites,
    readerBridgeCreates: () => readerBridgeCreates };
}

test("direct historical candidate renders its real evidence without a newer empty run's zero summary or list", async () => {
  const f = fixture();
  try {
    await f.open();
    assert.equal(f.body.querySelector("[data-selected-candidate-id]")?.getAttribute("data-selected-candidate-id"), candidateId);
    assert.match(f.body.textContent ?? "", /今日原理/);
    assert.match(f.body.textContent ?? "", /9月5日工业除尘公开需求/);
    assert.equal(Boolean(f.body.querySelector('[aria-label="候选统计"]')), false);
    assert.equal(Boolean(f.body.querySelector('[aria-label="候选列表"]')), false);
    assert.doesNotMatch(f.body.textContent ?? "", /未发现符合条件的候选|已发现 0 条公开证据/);
    assert.equal(f.controller.getState().detail?.latestRun?.id, latestRunId,
      "do not rewrite the latest run to pretend it produced the retained candidate");
    assert.equal(f.controller.getState().error, null);
    assert.equal(f.readerBridgeCreates(), 0, "direct review must not attach or resume a browser reader");
    assert.deepEqual(f.attemptedWrites, []);
  } finally { f.controller.destroy(); }
});

for (const status of ["normalized", "pending_review"] as const) {
  test(`${status} candidate can directly open handoff without intelligence or review requests`, async () => {
    const f = fixture({ status });
    try {
      await f.open();
      const section = f.body.querySelector(".replica-acquisition-handoff-section")!;
      assert.match(section.textContent ?? "", /创建或关联.*客户.*首次跟进待办/);
      assert.ok(section.querySelector('[data-acquisition-detail-action="open-private-domain-handoff"]'));
      assert.equal(f.requests.some(path => /\/(qualification|financial-value|battle-card|reviews|intelligence-operation|douyin-identity-resolution-operation)$/.test(path)), false);
      assert.equal(f.body.querySelector('[data-acquisition-detail-action="start-intelligence"]'), null);
      f.controller.openPrivateDomainHandoff();
      assert.equal(f.controller.getState().handoffDialog?.open, true);
      const title = f.body.querySelector<HTMLInputElement>('[name="followUpTitle"]')!;
      title.value = "保留未提交输入";
      const inputEvent = f.body.ownerDocument.createEvent("Event");
      inputEvent.initEvent("input", true, false);
      title.dispatchEvent(inputEvent);
      assert.equal(f.controller.getState().handoffDialog?.followUp.title, "保留未提交输入");
      assert.deepEqual(f.attemptedWrites, []);
    } finally { f.controller.destroy(); }
  });
}

for (const scenario of ["close", "newer_open"] as const) {
  test(`late historical source response after ${scenario} cannot restore an obsolete pin or change the DOM`, async () => {
    let release!: () => void;
    let reached!: () => void;
    const sourceGate = new Promise<void>(resolve => { release = resolve; });
    const sourceRead = new Promise<void>(resolve => { reached = resolve; });
    const f = fixture({ sourceGate, onSourceRead: reached });
    try {
      const opening = f.open();
      await sourceRead;
      if (scenario === "close") f.controller.close();
      else await f.controller.openCandidate(candidateId);
      const before = f.body.innerHTML;
      release();
      await opening;
      assert.equal(f.body.innerHTML, before);
      assert.equal(f.controller.getState().candidateFocus?.discoveredEventId ?? null, null);
      assert.equal(f.requests.filter(path => path.includes(`/runs/${historicalRunId}/presentation`)).length, 1);
      assert.deepEqual(f.attemptedWrites, []);
    } finally { release(); f.controller.destroy(); }
  });
}

test("a historical source network failure after candidate selection cannot overwrite the new selection's DOM", async () => {
  let rejectSource!: (error: Error) => void;
  let reached!: () => void;
  const sourceGate = new Promise<void>((_resolve, reject) => { rejectSource = reject; });
  const sourceRead = new Promise<void>(resolve => { reached = resolve; });
  const f = fixture({ sourceGate, onSourceRead: reached });
  try {
    const opening = f.open();
    await sourceRead;
    await f.controller.selectCandidate("candidate-other");
    const before = f.body.innerHTML;
    rejectSource(new Error("historical source unavailable"));
    await opening;
    assert.equal(f.controller.getState().selectedCandidateId, "candidate-other");
    assert.equal(f.body.innerHTML, before);
  } finally { f.controller.destroy(); }
});

test("approved retained candidate pins handoff to its historical discovery event on the second page", async () => {
  const f = fixture({ status: "approved" });
  try {
    await f.open();
    f.body.querySelector<HTMLElement>('[data-acquisition-detail-action="open-private-domain-handoff"]')!.click();
    const dialog = f.controller.getState().handoffDialog;
    assert.equal(dialog?.runId, historicalRunId);
    assert.equal(dialog?.discoveredEventId, "event-retained-discovered");
    assert.equal(dialog?.decisionVersion, "decision-reviewed");
    assert.equal(f.requests.filter(path => path.includes(`/runs/${historicalRunId}/presentation`)).length, 2);
    assert.deepEqual(f.attemptedWrites, [], "opening review or the confirmation form must not submit it");
  } finally { f.controller.destroy(); }
});

for (const source of ["wrong_run", "missing_candidate", "repeated_cursor"] as const) {
  test(`source ${source} cannot fabricate a discovery pin or discard the readable candidate`, async () => {
    const f = fixture({ status: "approved", source });
    try {
      await f.open();
      assert.match(f.body.textContent ?? "", /今日原理/);
      f.controller.openPrivateDomainHandoff();
      assert.equal(f.controller.getState().handoffDialog, null);
      assert.ok(f.controller.getState().error);
      assert.ok(f.requests.length < 20, "repeated cursors must terminate");
      assert.deepEqual(f.attemptedWrites, []);
    } finally { f.controller.destroy(); }
  });
}

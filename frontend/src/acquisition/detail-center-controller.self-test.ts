import { strict as assert } from "node:assert";
import type {
  AcquisitionDetailApi,
  CandidateDouyinIdentityResolutionOperation,
  CandidateIntelligenceOperation
} from "./detail-center-api";
import { createAcquisitionDetailCenterController } from "./detail-center-controller";
import * as detailControllerModule from "./detail-center-controller";
import { VisualReaderApiError, type VisualReaderApi } from "./visual-reader-api";
import type {
  AuthorizedVisualReaderProjection,
  VisualReaderControlState,
  VisualReaderController,
  VisualReaderOpenContext
} from "./visual-reader-controller";

function detailEvent<T>(name: string, detail: T): Event {
  return new CustomEvent<T>(name, { detail });
}

type FakeListener = EventListenerOrEventListenerObject;

class FakeDialogRoot {
  hidden = true;
  open = false;
  ownerDocument: { activeElement: { focus(): void } | null };
  readonly dataset: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  readonly classes = new Set<string>();
  private readonly listeners = new Map<string, Set<FakeListener>>();

  readonly classList = {
    add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name))
  };

  constructor(activeElement: { focus(): void } | null) {
    this.ownerDocument = { activeElement };
  }

  addEventListener(type: string, listener: FakeListener) {
    const entries = this.listeners.get(type) ?? new Set<FakeListener>();
    entries.add(listener);
    this.listeners.set(type, entries);
  }

  removeEventListener(type: string, listener: FakeListener) {
    this.listeners.get(type)?.delete(listener);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  contains() {
    return true;
  }

  querySelector() {
    return null;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
    this.emit("close", { target: this });
  }

  emitClick(target: Record<string, unknown>) {
    this.emit("click", {
      target,
      preventDefault() {}
    });
  }

  emitChange(target: Record<string, unknown>) {
    this.emit("change", { target });
  }

  nativeClose() {
    this.open = false;
    this.emit("close", { target: this });
  }

  private emit(type: string, event: Record<string, unknown>) {
    this.listeners.get(type)?.forEach((listener) => {
      if (typeof listener === "function") {
        listener(event as unknown as Event);
      } else {
        listener.handleEvent(event as unknown as Event);
      }
    });
  }
}

class ManualPollScheduler {
  private nextId = 1;
  private readonly entries = new Map<number, {
    callback: () => void;
    delay: number;
  }>();

  schedule = (callback: () => void, delay: number): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.entries.set(id, { callback, delay });
    return id;
  };

  cancel = (handle: unknown): void => {
    if (typeof handle === "number") this.entries.delete(handle);
  };

  pendingCount(): number {
    return this.entries.size;
  }

  nextDelay(): number | null {
    return this.entries.values().next().value?.delay ?? null;
  }

  runNext(): void {
    const entry = this.entries.entries().next().value as
      | [number, { callback: () => void; delay: number }]
      | undefined;
    if (!entry) throw new Error("没有待执行的轮询任务");
    this.entries.delete(entry[0]);
    entry[1].callback();
  }
}

class MemorySessionStorage {
  readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

{
  const mergeProjection = (detailControllerModule as Record<string, unknown>)
    .mergeRunPresentationProjection;
  assert.equal(typeof mergeProjection, "function");
  const merged = (mergeProjection as (current: Record<string, unknown>, incoming: Record<string, unknown>) => Record<string, unknown>)({
    summary: { commentsSampled: 18, highPotentialSignals: 1 },
    automationSteps: [{ id: "fetch_public_comment_samples", status: "running", processedCount: 18 }],
    commentSignals: [{ eventId: "comment-1", text: "旧投影" }]
  }, {
    summary: { commentsSampled: 18, highPotentialSignals: 1 },
    automationSteps: [{ id: "fetch_public_comment_samples", status: "partial_success", processedCount: 18 }],
    commentSignals: [{ eventId: "comment-1", text: "新投影" }, { eventId: "comment-2", text: "第二条" }]
  });
  assert.deepEqual(merged.automationSteps, [{
    id: "fetch_public_comment_samples", status: "partial_success", processedCount: 18
  }]);
  assert.deepEqual(merged.commentSignals, [
    { eventId: "comment-1", text: "新投影" },
    { eventId: "comment-2", text: "第二条" }
  ]);
  assert.deepEqual(merged.summary, { commentsSampled: 18, highPotentialSignals: 1 });
}

function fakeAction(dataset: Record<string, string>) {
  const action = {
    dataset,
    closest(selector: string) {
      return selector === "[data-acquisition-detail-action]" ? action : null;
    }
  };
  return action;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const taskDetail = {
  task: {
    planId: "plan-1",
    name: "抖音线索研判",
    platform: "douyin"
  },
  plan: { id: "plan-1", status: "approved" },
  latestRun: null,
  shards: [],
  presentation: null
};

function taskDetailWithCandidateSource(...candidateIds: string[]) {
  return {
    ...taskDetail,
    latestRun: { id: "run-handoff" },
    presentation: {
      candidateEvents: candidateIds.map((candidateId) => ({
        eventId: `event-${candidateId}`,
        candidateId
      }))
    }
  };
}

function automaticIdentityOperation(
  overrides: Partial<CandidateDouyinIdentityResolutionOperation> = {}
): CandidateDouyinIdentityResolutionOperation {
  return {
    id: "identity-operation-1",
    candidateId: "candidate-auto-identity",
    candidateVersion: 1,
    status: "queued",
    currentStage: null,
    outcome: null,
    retryable: false,
    canonicalProfileUrl: null,
    profileCandidates: [],
    evidence: [],
    intelligenceOperationId: null,
    createdAt: "2026-08-08T12:00:00.000Z",
    updatedAt: "2026-08-08T12:00:00.000Z",
    completedAt: null,
    ...overrides
  };
}

function automaticIntelligenceOperation(
  overrides: Partial<CandidateIntelligenceOperation> = {}
): CandidateIntelligenceOperation {
  return {
    id: "intelligence-operation-1",
    candidateId: "candidate-auto-identity",
    status: "queued",
    currentStage: null,
    completedStages: [],
    skippedStages: [],
    research: null,
    qualification: null,
    battleCardId: null,
    failure: null,
    createdAt: "2026-08-08T12:00:02.000Z",
    startedAt: null,
    updatedAt: "2026-08-08T12:00:02.000Z",
    completedAt: null,
    failedAt: null,
    ...overrides
  };
}

{
  const oldTask = deferred<typeof taskDetail>();
  const newTask = deferred<typeof taskDetail>();
  const api = {
    getTask(planId: string) {
      return planId === "plan-old" ? oldTask.promise : newTask.promise;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({ api });

  const oldRequest = controller.open("plan", "plan-old");
  const newRequest = controller.open("plan", "plan-new");
  newTask.resolve({
    ...taskDetail,
    plan: { ...taskDetail.plan, id: "plan-new" }
  });
  await newRequest;
  oldTask.resolve({
    ...taskDetail,
    plan: { ...taskDetail.plan, id: "plan-old" }
  });
  await oldRequest;

  assert.equal(controller.getState().detail?.plan.id, "plan-new");
  controller.destroy();
}

{
  const storage = new MemorySessionStorage();
  const eventTarget = new EventTarget();
  const completedEvents: Array<Record<string, unknown>> = [];
  eventTarget.addEventListener("goodjob:acquisition-candidate-changed", (event) => {
    const detail = (event as CustomEvent<Record<string, unknown>>).detail;
    if (detail.action === "private_domain_handoff_completed") {
      completedEvents.push(detail);
    }
  });
  const handoffKeys: string[] = [];
  let handoffAttempts = 0;
  const api = {
    async getTask() {
      return taskDetailWithCandidateSource("candidate-approved");
    },
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          status: "approved",
          identityResolved: true,
          latestDecisionVersion: "qualification-v2",
          approvedDecisionVersion: "qualification-v2"
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return { grade: "S", score: 94, hardGateFailures: [] };
    },
    async getCandidateFinancialValue() {
      return { currency: "CNY", expectedRevenueMinor: 1_288_000 };
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestIntelligenceOperation() {
      return null;
    },
    async getCandidatePrivateDomainHandoff() {
      return null;
    },
    async handoffCandidate(_candidateId: string, _input: unknown, key: string) {
      handoffKeys.push(key);
      handoffAttempts += 1;
      if (handoffAttempts === 1) throw new Error("CRM 暂时不可用");
      return {
        replayed: false,
        handoff: {
          id: "ach-1",
          candidateId: "candidate-approved",
          leadId: "lead-1",
          customerId: "customer-1",
          todoId: "todo-1",
          decisionVersion: "qualification-v2",
          createdAt: "2026-08-07T08:00:00.000Z"
        },
        lead: { id: "lead-1" },
        customer: { id: "customer-1" },
        todo: { id: "todo-1", dueAt: "2026-08-08T09:00:00.000Z" },
        intelligence: {
          qualificationGrade: "S",
          qualificationScore: 94,
          financialGrade: "A",
          currency: "CNY",
          expectedRevenueMinor: 1_288_000,
          expectedGrossProfitMinor: 708_400,
          expectedContributionMinor: 520_000
        }
      };
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget,
    storage,
    keyFactory: () => "handoff-stable-key"
  });
  await controller.open("candidates", "plan-1");
  await controller.selectCandidate("candidate-approved");
  controller.openPrivateDomainHandoff();
  const input = {
    mode: "create_new" as const,
    existingCustomerId: "",
    followUp: {
      title: "首次跟进：确认需求和预算",
      dueAt: "2026-08-08T09:00:00.000Z",
      priority: "high" as const
    }
  };
  await assert.rejects(
    () => controller.handoffCandidate(input),
    /CRM 暂时不可用/
  );
  assert.equal(controller.getState().handoffDialog?.open, true);
  assert.equal(controller.getState().handoffDialog?.followUp.dueAt, input.followUp.dueAt);
  assert.equal(storage.values.size, 1);
  await controller.handoffCandidate(input);
  assert.deepEqual(handoffKeys, ["handoff-stable-key", "handoff-stable-key"]);
  assert.equal(storage.values.size, 0);
  const completedHandoff = controller.getState().candidateDetail
    ?.privateDomainHandoff;
  assert.ok(completedHandoff && "handoff" in completedHandoff);
  assert.equal(completedHandoff.handoff.customerId, "customer-1");
  assert.equal(controller.getState().handoffDialog, null);
  assert.deepEqual({
    customerId: completedEvents[0]?.customerId,
    todoId: completedEvents[0]?.todoId,
    leadId: completedEvents[0]?.leadId,
    handoffId: completedEvents[0]?.handoffId
  }, {
    customerId: "customer-1",
    todoId: "todo-1",
    leadId: "lead-1",
    handoffId: "ach-1"
  });
  controller.destroy();
}

{
  const restoredRequest = {
    operationCode: "handoff_acquisition_candidate_v1" as const,
    runId: "run-handoff",
    discoveredEventId: "event-candidate-refresh",
    decisionVersion: "qualification-v2",
    mode: "link_existing" as const,
    existingCustomerId: "customer-original-target",
    followUp: {
      title: "原始刷新跟进",
      dueAt: "2026-08-09T10:30:00.000Z",
      priority: "medium" as const
    }
  };
  const submitted: Array<{ input: unknown; key: string }> = [];
  const api = {
    async getTask() {
      return taskDetail;
    },
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          status: "approved",
          identityResolved: true,
          latestDecisionVersion: "qualification-v2",
          approvedDecisionVersion: "qualification-v2"
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return { grade: "S", score: 94, hardGateFailures: [] };
    },
    async getCandidateFinancialValue() {
      return { currency: "CNY", expectedRevenueMinor: 1_288_000 };
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestIntelligenceOperation() {
      return null;
    },
    async getCandidatePrivateDomainHandoff() {
      return {
        replayed: false,
        inProgress: {
          id: "ach-operation-refresh",
          candidateId: "candidate-refresh",
          decisionVersion: restoredRequest.decisionVersion,
          mode: restoredRequest.mode,
          existingCustomerId: restoredRequest.existingCustomerId,
          stage: "customer_ready",
          request: restoredRequest,
          createdAt: "2026-08-07T08:00:00.000Z"
        }
      };
    },
    async handoffCandidate(_candidateId: string, input: unknown, key: string) {
      submitted.push({ input, key });
      return {
        replayed: false,
        handoff: {
          id: "ach-refresh",
          candidateId: "candidate-refresh",
          leadId: "lead-refresh",
          customerId: "customer-original-target",
          todoId: "todo-refresh",
          decisionVersion: "qualification-v2",
          createdAt: "2026-08-07T08:01:00.000Z"
        },
        lead: { id: "lead-refresh" },
        customer: { id: "customer-original-target" },
        todo: {
          id: "todo-refresh",
          dueAt: restoredRequest.followUp.dueAt
        },
        intelligence: {
          qualificationGrade: "S",
          qualificationScore: 94,
          financialGrade: "A",
          currency: "CNY",
          expectedRevenueMinor: 1_288_000,
          expectedGrossProfitMinor: 708_400,
          expectedContributionMinor: 520_000
        }
      };
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    storage: new MemorySessionStorage(),
    keyFactory: () => "handoff-refresh-key"
  });

  await controller.open("candidates", "plan-1");
  await controller.selectCandidate("candidate-refresh");
  controller.openPrivateDomainHandoff();
  assert.deepEqual(controller.getState().handoffDialog, {
    open: true,
    busy: false,
    recovering: true,
    runId: restoredRequest.runId,
    discoveredEventId: restoredRequest.discoveredEventId,
    decisionVersion: restoredRequest.decisionVersion,
    mode: "link_existing",
    existingCustomerId: "customer-original-target",
    followUp: restoredRequest.followUp
  });
  await controller.handoffCandidate({
    mode: "link_existing",
    existingCustomerId: "customer-original-target",
    followUp: restoredRequest.followUp
  });
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0]?.input, restoredRequest);
  assert.equal(submitted[0]?.key, "handoff-refresh-key");
  controller.destroy();
}

{
  const pending = deferred<any>();
  const api = {
    async getTask() {
      return taskDetailWithCandidateSource("candidate-old", "candidate-new");
    },
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          status: "approved",
          identityResolved: true,
          latestDecisionVersion: "qualification-v2",
          approvedDecisionVersion: "qualification-v2"
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return { grade: "S", hardGateFailures: [] };
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestIntelligenceOperation() {
      return null;
    },
    async getCandidatePrivateDomainHandoff() {
      return null;
    },
    handoffCandidate() {
      return pending.promise;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    keyFactory: () => "handoff-race-key"
  });
  await controller.open("candidates", "plan-1");
  await controller.selectCandidate("candidate-old");
  controller.openPrivateDomainHandoff();
  const oldRequest = controller.handoffCandidate({
    mode: "create_new",
    existingCustomerId: "",
    followUp: {
      title: "首次跟进",
      dueAt: "2026-08-08T09:00:00.000Z",
      priority: "high"
    }
  });
  await controller.selectCandidate("candidate-new");
  pending.resolve({
    replayed: false,
    handoff: {
      id: "ach-old",
      candidateId: "candidate-old",
      leadId: "lead-old",
      customerId: "customer-old",
      todoId: "todo-old",
      decisionVersion: "qualification-v2",
      createdAt: "2026-08-07T08:00:00.000Z"
    },
    lead: { id: "lead-old" },
    customer: { id: "customer-old" },
    todo: { id: "todo-old" },
    intelligence: {
      qualificationGrade: "S",
      qualificationScore: 94,
      financialGrade: "A",
      currency: "CNY",
      expectedRevenueMinor: 0,
      expectedGrossProfitMinor: 0,
      expectedContributionMinor: 0
    }
  });
  await oldRequest;
  assert.equal(controller.getState().selectedCandidateId, "candidate-new");
  assert.equal(
    controller.getState().candidateDetail?.privateDomainHandoff,
    null
  );
  controller.destroy();
}

// Automatic identity polling is independent from Run polling and owns the
// identity -> intelligence handoff without invoking either client mutation.
{
  const scheduler = new ManualPollScheduler();
  const identitySequence = [
    automaticIdentityOperation(),
    automaticIdentityOperation({
      status: "running",
      currentStage: "independent_search"
    }),
    automaticIdentityOperation({
      status: "succeeded",
      outcome: "verified_consensus",
      canonicalProfileUrl: "https://www.douyin.com/user/example",
      intelligenceOperationId: "intelligence-operation-1",
      completedAt: "2026-08-08T12:00:02.000Z"
    }),
    automaticIdentityOperation({
      status: "succeeded",
      outcome: "verified_consensus",
      canonicalProfileUrl: "https://www.douyin.com/user/example",
      intelligenceOperationId: "intelligence-operation-1",
      completedAt: "2026-08-08T12:00:02.000Z"
    }),
    automaticIdentityOperation({
      status: "succeeded",
      outcome: "verified_consensus",
      canonicalProfileUrl: "https://www.douyin.com/user/example",
      intelligenceOperationId: "intelligence-operation-1",
      completedAt: "2026-08-08T12:00:02.000Z"
    })
  ];
  const intelligenceSequence = [
    null,
    null,
    null,
    automaticIntelligenceOperation(),
    automaticIntelligenceOperation({
      status: "succeeded",
      completedStages: ["research", "qualification", "battle_card"],
      qualification: {
        grade: "A",
        score: 88,
        hardGateFailures: [],
        financialValueId: "financial-automatic"
      },
      battleCardId: "battle-card-automatic",
      completedAt: "2026-08-08T12:00:05.000Z"
    })
  ];
  let snapshotIndex = -1;
  let clientIdentityConfirmations = 0;
  let clientIntelligenceStarts = 0;
  const api = {
    async getCandidate(candidateId: string) {
      snapshotIndex = Math.min(snapshotIndex + 1, identitySequence.length - 1);
      return {
        candidate: {
          id: candidateId,
          subjectKind: "individual",
          sourcePlatform: "douyin",
          publicProfileUrl: snapshotIndex >= 2
            ? "https://www.douyin.com/user/example"
            : "https://www.douyin.com/video/1",
          status: "normalized",
          version: snapshotIndex >= 2 ? 2 : 1,
          identityResolved: snapshotIndex >= 2
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return snapshotIndex === 4 ? { grade: "A", score: 88 } : null;
    },
    async getCandidateFinancialValue() {
      if (snapshotIndex === 4) throw new Error("financial snapshot unavailable");
      return { id: "financial-before-terminal" };
    },
    async getCandidateBattleCard() {
      return snapshotIndex === 4 ? { id: "battle-card-automatic" } : null;
    },
    async getCandidateReviews() {
      if (snapshotIndex === 0) throw new Error("reviews initially unavailable");
      return { items: [], nextCursor: null };
    },
    async getLatestDouyinIdentityResolutionOperation() {
      return identitySequence[snapshotIndex] ?? null;
    },
    async getLatestIntelligenceOperation() {
      return intelligenceSequence[snapshotIndex] ?? null;
    },
    async confirmCandidateIdentity() {
      clientIdentityConfirmations += 1;
      throw new Error("automatic flow must not confirm identity from the client");
    },
    async startIntelligenceOperation() {
      clientIntelligenceStarts += 1;
      throw new Error("automatic flow must not start intelligence from the client");
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    pollIntervalMs: 100,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.openCandidate("candidate-auto-identity");
  assert.equal(
    controller.getState().candidateDetail?.identityResolutionOperation?.status,
    "queued"
  );
  assert.equal(scheduler.pendingCount(), 1);
  assert.equal(scheduler.nextDelay(), 2_000);
  const initialMessage = controller.getState().message;
  const initialError = controller.getState().error;
  assert.match(initialMessage ?? "", /部分资料暂不可用/);

  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(
    controller.getState().candidateDetail?.identityResolutionOperation?.status,
    "running"
  );
  assert.equal(controller.getState().message, initialMessage);
  assert.equal(controller.getState().error, initialError);
  assert.equal(scheduler.pendingCount(), 1);

  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(
    controller.getState().candidateDetail?.identityResolutionOperation?.status,
    "succeeded"
  );
  assert.equal(
    controller.getState().candidateDetail?.intelligenceOperation?.status,
    undefined
  );
  assert.equal(scheduler.pendingCount(), 1);

  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(
    controller.getState().candidateDetail?.intelligenceOperation?.status,
    "queued"
  );
  assert.equal(scheduler.pendingCount(), 1);

  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(
    controller.getState().candidateDetail?.intelligenceOperation?.status,
    "succeeded"
  );
  assert.equal(
    controller.getState().candidateDetail?.battleCard?.id,
    "battle-card-automatic"
  );
  assert.equal(
    controller.getState().candidateDetail?.financialValue?.id,
    "financial-before-terminal"
  );
  assert.match(controller.getState().error ?? "", /reviews initially unavailable/);
  assert.match(controller.getState().error ?? "", /financial snapshot unavailable/);
  assert.equal(controller.getState().message, initialMessage);
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(clientIdentityConfirmations, 0);
  assert.equal(clientIntelligenceStarts, 0);
  controller.destroy();
}

// A committed identity whose intelligence operation is temporarily invisible
// gets three bounded 2/4/8-second handoff reads, then stops instead of polling
// forever.
{
  const scheduler = new ManualPollScheduler();
  let identityReads = 0;
  const api = {
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          subjectKind: "individual",
          sourcePlatform: "douyin",
          publicProfileUrl: "https://www.douyin.com/user/example",
          status: "normalized",
          version: 2,
          identityResolved: true
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestDouyinIdentityResolutionOperation(candidateId: string) {
      identityReads += 1;
      return automaticIdentityOperation({
        id: "identity-handoff-bounded",
        candidateId,
        candidateVersion: 1,
        status: "succeeded",
        outcome: "verified_consensus",
        canonicalProfileUrl: "https://www.douyin.com/user/example",
        intelligenceOperationId: "intelligence-handoff-bounded",
        updatedAt: "2026-08-08T12:00:02.000Z",
        completedAt: "2026-08-08T12:00:02.000Z"
      });
    },
    async getLatestIntelligenceOperation() {
      return null;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    pollIntervalMs: 100,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.openCandidate("candidate-handoff-bounded");
  assert.equal(scheduler.nextDelay(), 2_000);
  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(scheduler.nextDelay(), 4_000);
  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(scheduler.nextDelay(), 8_000);
  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(identityReads, 4);
  controller.destroy();
}

// A single identity-to-intelligence handoff cannot renew its grace budget by
// alternating stale null snapshots with queued/running snapshots. The server
// can keep offering more than nine alternations, but the client stops after
// the original bounded budget; only a new identity operation may start over.
{
  const scheduler = new ManualPollScheduler();
  const eventTarget = new EventTarget();
  let snapshotReads = 0;
  let identityOperationId = "identity-handoff-oscillating";
  const api = {
    async getCandidate(candidateId: string) {
      snapshotReads += 1;
      return {
        candidate: {
          id: candidateId,
          subjectKind: "individual",
          sourcePlatform: "douyin",
          publicProfileUrl: "https://www.douyin.com/user/example",
          status: "normalized",
          version: 2,
          identityResolved: true
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestDouyinIdentityResolutionOperation(candidateId: string) {
      return automaticIdentityOperation({
        id: identityOperationId,
        candidateId,
        candidateVersion: 1,
        status: "succeeded",
        outcome: "verified_consensus",
        canonicalProfileUrl: "https://www.douyin.com/user/example",
        intelligenceOperationId: `${identityOperationId}-intelligence`,
        updatedAt: "2026-08-08T12:00:02.000Z",
        completedAt: "2026-08-08T12:00:02.000Z"
      });
    },
    async getLatestIntelligenceOperation(candidateId: string) {
      if (identityOperationId !== "identity-handoff-oscillating") return null;
      if (snapshotReads % 2 !== 0) return null;
      return automaticIntelligenceOperation({
        id: `${identityOperationId}-intelligence`,
        candidateId,
        status: snapshotReads % 4 === 0 ? "running" : "queued"
      });
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget,
    pollIntervalMs: 100,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.openCandidate("candidate-handoff-oscillating");
  let pollCallbacks = 0;
  while (pollCallbacks < 12 && scheduler.pendingCount() > 0) {
    scheduler.runNext();
    await controller.whenIdle();
    pollCallbacks += 1;
  }

  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(pollCallbacks, 6);
  assert.equal(snapshotReads, 7);

  eventTarget.dispatchEvent(detailEvent(
    "goodjob:acquisition-mode-changed",
    { mode: "demo" }
  ));
  eventTarget.dispatchEvent(detailEvent(
    "goodjob:acquisition-mode-changed",
    { mode: "real" }
  ));
  assert.equal(scheduler.pendingCount(), 0);

  identityOperationId = "identity-handoff-replacement";
  await controller.selectCandidate("candidate-handoff-oscillating");
  assert.equal(scheduler.pendingCount(), 1);
  controller.destroy();
}

// The operation ledger has a deterministic eight-entry FIFO bound: after nine
// exhausted operations, the oldest operation receives a fresh grace window,
// while a recent exhausted operation remains exhausted when revisited.
{
  const scheduler = new ManualPollScheduler();
  let operationIndex = 0;
  const api = {
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          subjectKind: "individual",
          sourcePlatform: "douyin",
          publicProfileUrl: "https://www.douyin.com/user/example",
          status: "normalized",
          version: 2,
          identityResolved: true
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestDouyinIdentityResolutionOperation(candidateId: string) {
      return automaticIdentityOperation({
        id: `identity-handoff-ledger-${operationIndex}`,
        candidateId,
        candidateVersion: 1,
        status: "succeeded",
        outcome: "verified_consensus",
        canonicalProfileUrl: "https://www.douyin.com/user/example",
        intelligenceOperationId: `intelligence-handoff-ledger-${operationIndex}`,
        updatedAt: "2026-08-08T12:00:02.000Z",
        completedAt: "2026-08-08T12:00:02.000Z"
      });
    },
    async getLatestIntelligenceOperation() {
      return null;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    pollIntervalMs: 100,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.openCandidate("candidate-handoff-ledger-bound");
  for (operationIndex = 0; operationIndex < 9; operationIndex += 1) {
    if (operationIndex > 0) {
      await controller.selectCandidate("candidate-handoff-ledger-bound");
    }
    assert.equal(scheduler.pendingCount(), 1);
    for (let poll = 0; poll < 3; poll += 1) {
      scheduler.runNext();
      await controller.whenIdle();
    }
    assert.equal(scheduler.pendingCount(), 0);
  }

  operationIndex = 0;
  await controller.selectCandidate("candidate-handoff-ledger-bound");
  assert.equal(scheduler.pendingCount(), 1);

  operationIndex = 8;
  await controller.selectCandidate("candidate-handoff-ledger-bound");
  assert.equal(scheduler.pendingCount(), 0);
  controller.destroy();
}

// Exhausting operation A, fully spending a fresh operation B, then reopening
// the same candidate on A cannot refresh A's operation-scoped handoff budget.
{
  const scheduler = new ManualPollScheduler();
  let operationName = "a";
  const api = {
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          subjectKind: "individual",
          sourcePlatform: "douyin",
          publicProfileUrl: "https://www.douyin.com/user/example",
          status: "normalized",
          version: 2,
          identityResolved: true
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestDouyinIdentityResolutionOperation(candidateId: string) {
      return automaticIdentityOperation({
        id: `identity-handoff-${operationName}`,
        candidateId,
        candidateVersion: 1,
        status: "succeeded",
        outcome: "verified_consensus",
        canonicalProfileUrl: "https://www.douyin.com/user/example",
        intelligenceOperationId: `intelligence-handoff-${operationName}`,
        updatedAt: "2026-08-08T12:00:02.000Z",
        completedAt: "2026-08-08T12:00:02.000Z"
      });
    },
    async getLatestIntelligenceOperation() {
      return null;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    pollIntervalMs: 100,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.openCandidate("candidate-handoff-revisit");
  for (let poll = 0; poll < 3; poll += 1) {
    scheduler.runNext();
    await controller.whenIdle();
  }
  assert.equal(scheduler.pendingCount(), 0);

  operationName = "b";
  await controller.selectCandidate("candidate-handoff-revisit");
  assert.equal(scheduler.pendingCount(), 1);
  for (let poll = 0; poll < 3; poll += 1) {
    scheduler.runNext();
    await controller.whenIdle();
  }
  assert.equal(scheduler.pendingCount(), 0);

  controller.close();
  operationName = "a";
  await controller.openCandidate("candidate-handoff-revisit");
  assert.equal(scheduler.pendingCount(), 0);
  controller.destroy();
}

// Alternating latest identity operations keep independent monotonic handoff
// budgets. Once A and B have each spent their three null-gap reads, revisiting
// either exhausted operation cannot keep the poll loop alive.
{
  const scheduler = new ManualPollScheduler();
  let snapshotReads = 0;
  const api = {
    async getCandidate(candidateId: string) {
      snapshotReads += 1;
      return {
        candidate: {
          id: candidateId,
          subjectKind: "individual",
          sourcePlatform: "douyin",
          publicProfileUrl: "https://www.douyin.com/user/example",
          status: "normalized",
          version: 2,
          identityResolved: true
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestDouyinIdentityResolutionOperation(candidateId: string) {
      const operationName = snapshotReads % 2 === 0 ? "new" : "old";
      return automaticIdentityOperation({
        id: `identity-handoff-${operationName}`,
        candidateId,
        candidateVersion: 1,
        status: "succeeded",
        outcome: "verified_consensus",
        canonicalProfileUrl: "https://www.douyin.com/user/example",
        intelligenceOperationId: `intelligence-handoff-${operationName}`,
        updatedAt: "2026-08-08T12:00:02.000Z",
        completedAt: "2026-08-08T12:00:02.000Z"
      });
    },
    async getLatestIntelligenceOperation() {
      return null;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    pollIntervalMs: 100,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.openCandidate("candidate-handoff-old-new");
  let pollCallbacks = 0;
  while (pollCallbacks < 12 && scheduler.pendingCount() > 0) {
    scheduler.runNext();
    await controller.whenIdle();
    pollCallbacks += 1;
  }

  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(pollCallbacks, 6);
  assert.equal(snapshotReads, 7);
  controller.destroy();
}

// A response from an old selected-candidate poll cannot replace a newer
// selection, even when it resolves after the new snapshot.
{
  const scheduler = new ManualPollScheduler();
  const staleOldCandidate = deferred<{
    candidate: Record<string, unknown>;
    etag: null;
  }>();
  let oldCandidateReads = 0;
  const api = {
    getCandidate(candidateId: string) {
      if (candidateId === "candidate-old-poll") {
        oldCandidateReads += 1;
        if (oldCandidateReads === 2) return staleOldCandidate.promise;
      }
      return Promise.resolve({
        candidate: {
          id: candidateId,
          subjectKind: "individual",
          sourcePlatform: "douyin",
          status: "normalized",
          version: 1,
          identityResolved: candidateId === "candidate-new-poll"
        },
        etag: null
      });
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestDouyinIdentityResolutionOperation(candidateId: string) {
      return candidateId === "candidate-old-poll"
        ? automaticIdentityOperation({ candidateId })
        : null;
    },
    async getLatestIntelligenceOperation() {
      return null;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.openCandidate("candidate-old-poll");
  scheduler.runNext();
  assert.equal(oldCandidateReads, 2);
  await controller.selectCandidate("candidate-new-poll");
  staleOldCandidate.resolve({
    candidate: {
      id: "candidate-old-poll",
      subjectKind: "individual",
      sourcePlatform: "douyin",
      status: "normalized",
      version: 1,
      identityResolved: false
    },
    etag: null
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.getState().selectedCandidateId, "candidate-new-poll");
  assert.equal(
    controller.getState().candidateDetail?.candidate?.id,
    "candidate-new-poll"
  );
  assert.equal(scheduler.pendingCount(), 0);
  controller.destroy();
}

// Closing, switching to demo mode, and destroying each cancel the independent
// selected-candidate timer.
{
  const scheduler = new ManualPollScheduler();
  const eventTarget = new EventTarget();
  const api = {
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          subjectKind: "individual",
          sourcePlatform: "douyin",
          status: "normalized",
          version: 1,
          identityResolved: false
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestDouyinIdentityResolutionOperation(candidateId: string) {
      return automaticIdentityOperation({ candidateId });
    },
    async getLatestIntelligenceOperation() {
      return null;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.openCandidate("candidate-cancel-poll");
  assert.equal(scheduler.pendingCount(), 1);
  controller.close();
  assert.equal(scheduler.pendingCount(), 0);
  eventTarget.dispatchEvent(detailEvent(
    "goodjob:acquisition-mode-changed",
    { mode: "real" }
  ));
  assert.equal(scheduler.pendingCount(), 0);

  await controller.openCandidate("candidate-cancel-poll");
  assert.equal(scheduler.pendingCount(), 1);
  eventTarget.dispatchEvent(detailEvent(
    "goodjob:acquisition-mode-changed",
    { mode: "demo" }
  ));
  assert.equal(scheduler.pendingCount(), 0);

  await controller.openCandidate("candidate-cancel-poll");
  assert.equal(scheduler.pendingCount(), 0);
  eventTarget.dispatchEvent(detailEvent(
    "goodjob:acquisition-mode-changed",
    { mode: "real" }
  ));
  assert.equal(scheduler.pendingCount(), 1);
  controller.destroy();
  assert.equal(scheduler.pendingCount(), 0);
}

// A real-mode overview event while one selected-candidate poll is in flight
// cannot schedule a second nine-resource snapshot. The normal successor timer
// is armed only after the in-flight snapshot settles.
{
  const scheduler = new ManualPollScheduler();
  const eventTarget = new EventTarget();
  const inFlightCandidate = deferred<{
    candidate: Record<string, unknown>;
    etag: null;
  }>();
  let candidateReads = 0;
  let resourceReads = 0;
  const candidateResult = (candidateId: string) => ({
    candidate: {
      id: candidateId,
      subjectKind: "individual",
      sourcePlatform: "douyin",
      status: "normalized",
      version: 1,
      identityResolved: false
    },
    etag: null
  });
  const api = {
    getCandidate(candidateId: string) {
      resourceReads += 1;
      candidateReads += 1;
      return candidateReads === 2
        ? inFlightCandidate.promise
        : Promise.resolve(candidateResult(candidateId));
    },
    async getCandidateEvidence() {
      resourceReads += 1;
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      resourceReads += 1;
      return null;
    },
    async getCandidateFinancialValue() {
      resourceReads += 1;
      return null;
    },
    async getCandidateBattleCard() {
      resourceReads += 1;
      return null;
    },
    async getCandidateReviews() {
      resourceReads += 1;
      return { items: [], nextCursor: null };
    },
    async getLatestDouyinIdentityResolutionOperation(candidateId: string) {
      resourceReads += 1;
      return automaticIdentityOperation({
        id: "identity-in-flight-real-event",
        candidateId,
        status: "running",
        currentStage: "independent_search"
      });
    },
    async getLatestIntelligenceOperation() {
      resourceReads += 1;
      return null;
    },
    async getCandidatePrivateDomainHandoff() {
      resourceReads += 1;
      return null;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.openCandidate("candidate-in-flight-real-event");
  assert.equal(resourceReads, 9);
  scheduler.runNext();
  assert.equal(resourceReads, 18);

  eventTarget.dispatchEvent(detailEvent(
    "goodjob:acquisition-mode-changed",
    { mode: "real" }
  ));
  if (scheduler.pendingCount() > 0) scheduler.runNext();
  await Promise.resolve();
  assert.equal(resourceReads, 18);
  assert.equal(scheduler.pendingCount(), 0);

  inFlightCandidate.resolve(candidateResult("candidate-in-flight-real-event"));
  await controller.whenIdle();
  assert.equal(resourceReads, 18);
  assert.equal(scheduler.pendingCount(), 1);
  controller.close();
  assert.equal(scheduler.pendingCount(), 0);
  controller.destroy();
}

// Switching to demo while the initial selected-candidate read is in flight
// invalidates that read and prevents its late running operation from arming a
// new timer.
{
  const scheduler = new ManualPollScheduler();
  const eventTarget = new EventTarget();
  const candidateRead = deferred<{
    candidate: Record<string, unknown>;
    etag: null;
  }>();
  const api = {
    getCandidate() {
      return candidateRead.promise;
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestDouyinIdentityResolutionOperation() {
      return automaticIdentityOperation({
        id: "identity-demo-selection",
        candidateId: "candidate-demo-selection",
        status: "running",
        currentStage: "independent_search"
      });
    },
    async getLatestIntelligenceOperation() {
      return null;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  const opening = controller.openCandidate("candidate-demo-selection");
  eventTarget.dispatchEvent(detailEvent(
    "goodjob:acquisition-mode-changed",
    { mode: "demo" }
  ));
  candidateRead.resolve({
    candidate: {
      id: "candidate-demo-selection",
      subjectKind: "individual",
      sourcePlatform: "douyin",
      status: "normalized",
      version: 1,
      identityResolved: false
    },
    etag: null
  });
  await opening;

  assert.equal(controller.getState().candidateDetail, null);
  assert.equal(scheduler.pendingCount(), 0);
  controller.destroy();
}

// The same demo generation fence covers a mutation-owned authoritative
// refresh; its late snapshot cannot replace the visible candidate or re-arm
// polling after the POST has returned.
{
  const scheduler = new ManualPollScheduler();
  const eventTarget = new EventTarget();
  const lateCandidateRefresh = deferred<{
    candidate: Record<string, unknown>;
    etag: null;
  }>();
  let candidateReads = 0;
  let latestOperation = automaticIdentityOperation({
    id: "identity-demo-retry-failed",
    candidateId: "candidate-demo-retry",
    candidateVersion: 1,
    status: "failed",
    outcome: "provider_unavailable",
    retryable: true
  });
  const api = {
    getCandidate(candidateId: string) {
      candidateReads += 1;
      if (candidateReads === 2) return lateCandidateRefresh.promise;
      return Promise.resolve({
        candidate: {
          id: candidateId,
          subjectKind: "individual",
          sourcePlatform: "douyin",
          status: "normalized",
          version: 1,
          identityResolved: false
        },
        etag: null
      });
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestDouyinIdentityResolutionOperation() {
      return latestOperation;
    },
    async getLatestIntelligenceOperation() {
      return null;
    },
    async retryDouyinIdentityResolution(candidateId: string) {
      latestOperation = automaticIdentityOperation({
        id: "identity-demo-retry-queued",
        candidateId,
        candidateVersion: 1,
        status: "queued"
      });
      return latestOperation;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget,
    keyFactory: () => "identity-demo-retry-key",
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.openCandidate("candidate-demo-retry");
  const retrying = controller.retryIdentityResolution();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(candidateReads, 2);
  eventTarget.dispatchEvent(detailEvent(
    "goodjob:acquisition-mode-changed",
    { mode: "demo" }
  ));
  lateCandidateRefresh.resolve({
    candidate: {
      id: "candidate-demo-retry",
      subjectKind: "individual",
      sourcePlatform: "douyin",
      status: "normalized",
      version: 99,
      identityResolved: true
    },
    etag: null
  });
  await retrying;

  assert.equal(controller.getState().candidateDetail?.candidate?.version, 1);
  assert.equal(scheduler.pendingCount(), 0);
  controller.destroy();
}

// Retry keys bind candidate, version, and failed operation. An uncertain POST
// reuses its key, while a successful POST is the only point that forgets it.
{
  const scheduler = new ManualPollScheduler();
  let version = 7;
  let latestOperation = automaticIdentityOperation({
    id: "identity-failed-1",
    candidateId: "candidate-retry-identity",
    candidateVersion: version,
    status: "failed",
    outcome: "provider_unavailable",
    retryable: true,
    completedAt: "2026-08-08T12:00:01.000Z"
  });
  const retryKeys: string[] = [];
  let retryAttempt = 0;
  const api = {
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          subjectKind: "individual",
          sourcePlatform: "douyin",
          status: "normalized",
          version,
          identityResolved: false
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestDouyinIdentityResolutionOperation() {
      return latestOperation;
    },
    async getLatestIntelligenceOperation() {
      return null;
    },
    async retryDouyinIdentityResolution(
      candidateId: string,
      key: string
    ) {
      assert.equal(candidateId, "candidate-retry-identity");
      retryKeys.push(key);
      retryAttempt += 1;
      if (retryAttempt !== 2) throw new Error("POST result uncertain");
      latestOperation = automaticIdentityOperation({
        id: "identity-queued-2",
        candidateId,
        candidateVersion: version,
        status: "queued"
      });
      return latestOperation;
    }
  } as unknown as AcquisitionDetailApi;
  let keySerial = 0;
  const root = new FakeDialogRoot(null);
  const body = { innerHTML: "" };
  const controller = createAcquisitionDetailCenterController({
    api,
    keyFactory: () => `identity-retry-key-${++keySerial}`,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel,
    root: root as unknown as HTMLElement,
    body: body as unknown as HTMLElement
  });

  await controller.openCandidate("candidate-retry-identity");
  await assert.rejects(
    () => controller.retryIdentityResolution(),
    /POST result uncertain/
  );
  root.emitClick(fakeAction({
    acquisitionDetailAction: "retry-identity-resolution"
  }));
  await controller.whenIdle();
  assert.deepEqual(retryKeys.slice(0, 2), [
    "identity-retry-key-1",
    "identity-retry-key-1"
  ]);
  assert.equal(
    controller.getState().candidateDetail?.identityResolutionOperation?.status,
    "queued"
  );

  latestOperation = automaticIdentityOperation({
    id: "identity-failed-1",
    candidateId: "candidate-retry-identity",
    candidateVersion: version,
    status: "failed",
    outcome: "provider_unavailable",
    retryable: true
  });
  await controller.selectCandidate("candidate-retry-identity");
  await assert.rejects(
    () => controller.retryIdentityResolution(),
    /POST result uncertain/
  );
  assert.equal(retryKeys[2], "identity-retry-key-2");

  latestOperation = automaticIdentityOperation({
    ...latestOperation,
    id: "identity-failed-3"
  });
  await controller.selectCandidate("candidate-retry-identity");
  await assert.rejects(
    () => controller.retryIdentityResolution(),
    /POST result uncertain/
  );
  assert.equal(retryKeys[3], "identity-retry-key-3");

  version = 8;
  latestOperation = automaticIdentityOperation({
    ...latestOperation,
    candidateVersion: version
  });
  await controller.selectCandidate("candidate-retry-identity");
  await assert.rejects(
    () => controller.retryIdentityResolution(),
    /POST result uncertain/
  );
  assert.equal(retryKeys[4], "identity-retry-key-4");
  controller.destroy();
}

{
  const scheduler = new ManualPollScheduler();
  let taskReads = 0;
  const submitted: unknown[] = [];
  const taskForRead = () => ({
    ...taskDetail,
    latestRun: {
      id: "run-pinned",
      status: taskReads < 3 ? "running" as const : "paused" as const,
      updatedAt: `2026-08-07T09:0${taskReads}:00.000Z`,
      revision: taskReads
    },
    presentation: {
      candidateEvents: [{
        eventId: taskReads === 1 ? "event-reviewed-a" : "event-refreshed-b",
        candidateId: "candidate-pinned"
      }],
      providers: [],
      summary: {},
      hasMore: false,
      nextAfter: null
    }
  });
  const api = {
    async getTask() {
      taskReads += 1;
      return taskForRead();
    },
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          status: "approved",
          identityResolved: true,
          latestDecisionVersion: "qualification-v2",
          approvedDecisionVersion: "qualification-v2"
        },
        etag: null
      };
    },
    async getCandidateEvidence() { return { items: [], nextCursor: null }; },
    async getCandidateQualification() {
      return { grade: "S", score: 94, hardGateFailures: [] };
    },
    async getCandidateFinancialValue() { return null; },
    async getCandidateBattleCard() { return null; },
    async getCandidateReviews() { return { items: [], nextCursor: null }; },
    async getLatestIntelligenceOperation() { return null; },
    async getCandidatePrivateDomainHandoff() { return null; },
    async handoffCandidate(_candidateId: string, input: unknown) {
      submitted.push(input);
      return {
        replayed: false,
        handoff: {
          id: "handoff-pinned",
          candidateId: "candidate-pinned",
          leadId: "lead-pinned",
          customerId: "customer-pinned",
          todoId: "todo-pinned",
          runId: "run-pinned",
          discoveredEventId: "event-reviewed-a",
          decisionVersion: "qualification-v2",
          createdAt: "2026-08-07T09:30:00.000Z"
        },
        lead: { id: "lead-pinned" },
        customer: { id: "customer-pinned" },
        todo: { id: "todo-pinned" },
        intelligence: {
          qualificationGrade: "S",
          qualificationScore: 94,
          financialGrade: "A",
          currency: "CNY",
          expectedRevenueMinor: 0,
          expectedGrossProfitMinor: 0,
          expectedContributionMinor: 0
        }
      };
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    pollIntervalMs: 1,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });
  await controller.open("candidates", "plan-1");
  await controller.selectCandidate("candidate-pinned");
  controller.openPrivateDomainHandoff();
  assert.equal(
    controller.getState().handoffDialog?.discoveredEventId,
    "event-reviewed-a"
  );

  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(
    controller.getState().detail?.presentation?.candidateEvents[0]?.eventId,
    "event-refreshed-b"
  );
  assert.equal(
    controller.getState().handoffDialog?.discoveredEventId,
    "event-reviewed-a"
  );

  await controller.handoffCandidate({
    mode: "create_new",
    existingCustomerId: "",
    followUp: {
      title: "保持已审核来源",
      dueAt: "2026-08-08T09:00:00.000Z",
      priority: "high"
    }
  });
  assert.deepEqual(submitted[0], {
    operationCode: "handoff_acquisition_candidate_v1",
    runId: "run-pinned",
    discoveredEventId: "event-reviewed-a",
    decisionVersion: "qualification-v2",
    mode: "create_new",
    existingCustomerId: "",
    followUp: {
      title: "保持已审核来源",
      dueAt: "2026-08-08T09:00:00.000Z",
      priority: "high"
    }
  });
  controller.destroy();
}

{
  const eventTarget = new EventTarget();
  const candidateReads: string[] = [];
  let taskReads = 0;
  const api = {
    async getTask() {
      taskReads += 1;
      return taskDetail;
    },
    async getCandidate(candidateId: string) {
      candidateReads.push(candidateId);
      return {
        candidate: {
          id: candidateId,
          publicDisplayName: "用户导入的公开抖音链接",
          publicProfileUrl: "https://www.douyin.com/video/1",
          sourcePlatform: "douyin",
          subjectKind: "individual",
          status: "normalized",
          version: 1,
          identityResolved: false
        },
        etag: '"candidate-v1"'
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestIntelligenceOperation() {
      return null;
    },
    async getCandidatePrivateDomainHandoff() {
      return null;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({ api, eventTarget });

  eventTarget.dispatchEvent(detailEvent(
    "goodjob:acquisition-detail-open-requested",
    { mode: "candidates", candidateId: "candidate-imported-1" }
  ));
  await controller.whenIdle();

  assert.equal(taskReads, 0, "task-independent candidate opening must not read a missing plan");
  assert.deepEqual(candidateReads, ["candidate-imported-1"]);
  assert.equal(controller.getState().status, "ready");
  assert.equal(controller.getState().detail, null);
  assert.equal(controller.getState().selectedCandidateId, "candidate-imported-1");
  assert.equal(
    controller.getState().candidateDetail?.candidate?.id,
    "candidate-imported-1"
  );
  controller.destroy();
}

{
  const legacyRequest = {
    operationCode: "handoff_acquisition_candidate_v1" as const,
    decisionVersion: "qualification-v2",
    mode: "link_existing" as const,
    existingCustomerId: "customer-legacy-in-flight",
    followUp: {
      title: "保留历史未完成请求",
      dueAt: "2026-08-10T10:00:00.000Z",
      priority: "medium" as const
    }
  };
  const submitted: unknown[] = [];
  const api = {
    async getTask() {
      return taskDetailWithCandidateSource("candidate-legacy-in-flight");
    },
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          status: "converted_to_lead",
          identityResolved: true,
          latestDecisionVersion: "qualification-v2",
          approvedDecisionVersion: "qualification-v2"
        },
        etag: null
      };
    },
    async getCandidateEvidence() { return { items: [], nextCursor: null }; },
    async getCandidateQualification() {
      return { grade: "S", score: 94, hardGateFailures: [] };
    },
    async getCandidateFinancialValue() { return null; },
    async getCandidateBattleCard() { return null; },
    async getCandidateReviews() { return { items: [], nextCursor: null }; },
    async getLatestIntelligenceOperation() { return null; },
    async getCandidatePrivateDomainHandoff() {
      return {
        replayed: false,
        inProgress: {
          id: "operation-legacy-in-flight",
          candidateId: "candidate-legacy-in-flight",
          decisionVersion: legacyRequest.decisionVersion,
          mode: legacyRequest.mode,
          existingCustomerId: legacyRequest.existingCustomerId,
          stage: "customer_ready",
          request: legacyRequest,
          createdAt: "2026-08-07T08:00:00.000Z"
        }
      };
    },
    async handoffCandidate(_candidateId: string, input: unknown) {
      submitted.push(input);
      return {
        replayed: false,
        handoff: {
          id: "handoff-legacy-in-flight",
          candidateId: "candidate-legacy-in-flight",
          leadId: "lead-legacy-in-flight",
          customerId: legacyRequest.existingCustomerId,
          todoId: "todo-legacy-in-flight",
          runId: "run-handoff",
          discoveredEventId: "event-candidate-legacy-in-flight",
          decisionVersion: legacyRequest.decisionVersion,
          createdAt: "2026-08-07T08:00:00.000Z"
        },
        lead: { id: "lead-legacy-in-flight" },
        customer: { id: legacyRequest.existingCustomerId },
        todo: { id: "todo-legacy-in-flight" },
        intelligence: {
          qualificationGrade: "S",
          qualificationScore: 94,
          financialGrade: "A",
          currency: "CNY",
          expectedRevenueMinor: 0,
          expectedGrossProfitMinor: 0,
          expectedContributionMinor: 0
        }
      };
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({ api });
  await controller.open("candidates", "plan-1");
  await controller.selectCandidate("candidate-legacy-in-flight");
  controller.openPrivateDomainHandoff();
  assert.deepEqual(controller.getState().handoffDialog, {
    open: true,
    busy: false,
    recovering: true,
    runId: "run-handoff",
    discoveredEventId: "event-candidate-legacy-in-flight",
    decisionVersion: legacyRequest.decisionVersion,
    mode: legacyRequest.mode,
    existingCustomerId: legacyRequest.existingCustomerId,
    followUp: legacyRequest.followUp
  });
  await controller.handoffCandidate({
    mode: "create_new",
    existingCustomerId: "customer-do-not-use",
    followUp: {
      title: "不得覆盖历史请求",
      dueAt: "2026-08-31T00:00:00.000Z",
      priority: "high"
    }
  });
  assert.deepEqual(submitted[0], {
    ...legacyRequest,
    runId: "run-handoff",
    discoveredEventId: "event-candidate-legacy-in-flight"
  });
  controller.destroy();

  let partialPinSubmitted = false;
  const partialPinApi = {
    ...api,
    async getCandidatePrivateDomainHandoff() {
      return {
        replayed: false,
        inProgress: {
          id: "operation-partial-pin-in-flight",
          candidateId: "candidate-legacy-in-flight",
          decisionVersion: legacyRequest.decisionVersion,
          mode: legacyRequest.mode,
          existingCustomerId: legacyRequest.existingCustomerId,
          stage: "customer_ready" as const,
          request: { ...legacyRequest, runId: "run-partial-only" },
          createdAt: "2026-08-07T08:00:00.000Z"
        }
      };
    },
    async handoffCandidate() {
      partialPinSubmitted = true;
      throw new Error("部分归因不得提交");
    }
  } as unknown as AcquisitionDetailApi;
  const partialPinController = createAcquisitionDetailCenterController({
    api: partialPinApi
  });
  await partialPinController.open("candidates", "plan-1");
  await partialPinController.selectCandidate("candidate-legacy-in-flight");
  partialPinController.openPrivateDomainHandoff();
  assert.equal(partialPinController.getState().handoffDialog, null);
  assert.match(partialPinController.getState().error ?? "", /历史交接.*不完整/);
  assert.equal(partialPinSubmitted, false);
  partialPinController.destroy();
}

{
  const legacyRequest = {
    operationCode: "handoff_acquisition_candidate_v1" as const,
    decisionVersion: "qualification-v2",
    mode: "create_new" as const,
    existingCustomerId: "",
    followUp: {
      title: "验证已完成历史交接",
      dueAt: "2026-08-10T11:00:00.000Z",
      priority: "normal" as const
    }
  };
  const submitted: unknown[] = [];
  const api = {
    async getTask() {
      return taskDetailWithCandidateSource("candidate-legacy-completed");
    },
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          status: "converted_to_lead",
          identityResolved: true,
          latestDecisionVersion: "qualification-v2",
          approvedDecisionVersion: "qualification-v2"
        },
        etag: null
      };
    },
    async getCandidateEvidence() { return { items: [], nextCursor: null }; },
    async getCandidateQualification() {
      return { grade: "S", score: 94, hardGateFailures: [] };
    },
    async getCandidateFinancialValue() { return null; },
    async getCandidateBattleCard() { return null; },
    async getCandidateReviews() { return { items: [], nextCursor: null }; },
    async getLatestIntelligenceOperation() { return null; },
    async getCandidatePrivateDomainHandoff() {
      return {
        replayed: false,
        handoff: {
          id: "handoff-legacy-completed",
          candidateId: "candidate-legacy-completed",
          leadId: "lead-legacy-completed",
          customerId: "customer-legacy-completed",
          todoId: "todo-legacy-completed",
          runId: null,
          discoveredEventId: null,
          decisionVersion: legacyRequest.decisionVersion,
          createdAt: "2026-08-07T08:00:00.000Z"
        },
        lead: { id: "lead-legacy-completed" },
        customer: { id: "customer-legacy-completed" },
        todo: { id: "todo-legacy-completed" },
        intelligence: {
          qualificationGrade: "S",
          qualificationScore: 94,
          financialGrade: "A",
          currency: "CNY",
          expectedRevenueMinor: 0,
          expectedGrossProfitMinor: 0,
          expectedContributionMinor: 0
        },
        recovery: { request: legacyRequest }
      };
    },
    async handoffCandidate(_candidateId: string, input: unknown) {
      submitted.push(input);
      return {
        replayed: true,
        handoff: {
          id: "handoff-legacy-completed",
          candidateId: "candidate-legacy-completed",
          leadId: "lead-legacy-completed",
          customerId: "customer-legacy-completed",
          todoId: "todo-legacy-completed",
          runId: "run-handoff",
          discoveredEventId: "event-candidate-legacy-completed",
          decisionVersion: legacyRequest.decisionVersion,
          createdAt: "2026-08-07T08:00:00.000Z"
        },
        lead: { id: "lead-legacy-completed" },
        customer: { id: "customer-legacy-completed" },
        todo: { id: "todo-legacy-completed" },
        intelligence: {
          qualificationGrade: "S",
          qualificationScore: 94,
          financialGrade: "A",
          currency: "CNY",
          expectedRevenueMinor: 0,
          expectedGrossProfitMinor: 0,
          expectedContributionMinor: 0
        }
      };
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({ api });
  await controller.open("candidates", "plan-1");
  await controller.selectCandidate("candidate-legacy-completed");
  controller.openPrivateDomainHandoff();
  assert.equal(controller.getState().handoffDialog?.recovering, true);
  assert.equal(controller.getState().handoffDialog?.runId, "run-handoff");
  assert.equal(
    controller.getState().handoffDialog?.discoveredEventId,
    "event-candidate-legacy-completed"
  );
  await controller.handoffCandidate({
    mode: "link_existing",
    existingCustomerId: "customer-do-not-use",
    followUp: {
      title: "不得覆盖已完成历史请求",
      dueAt: "2026-08-31T00:00:00.000Z",
      priority: "high"
    }
  });
  assert.deepEqual(submitted[0], {
    ...legacyRequest,
    runId: "run-handoff",
    discoveredEventId: "event-candidate-legacy-completed"
  });
  controller.destroy();

  for (const invalidRecoveryRequest of [
    { ...legacyRequest, runId: "run-partial-only" },
    { ...legacyRequest, runId: "   ", discoveredEventId: "   " }
  ]) {
    let invalidRecoverySubmitted = false;
    const invalidRecoveryApi = {
      ...api,
      async getCandidatePrivateDomainHandoff() {
        const completed = await api.getCandidatePrivateDomainHandoff(
          "candidate-legacy-completed"
        );
        if (!completed || !("handoff" in completed)) {
          throw new Error("缺少完成态交接");
        }
        return {
          ...completed,
          recovery: { request: invalidRecoveryRequest }
        };
      },
      async handoffCandidate() {
        invalidRecoverySubmitted = true;
        throw new Error("无效历史归因不得提交");
      }
    } as unknown as AcquisitionDetailApi;
    const invalidRecoveryController = createAcquisitionDetailCenterController({
      api: invalidRecoveryApi
    });
    await invalidRecoveryController.open("candidates", "plan-1");
    await invalidRecoveryController.selectCandidate(
      "candidate-legacy-completed"
    );
    invalidRecoveryController.openPrivateDomainHandoff();
    assert.equal(invalidRecoveryController.getState().handoffDialog, null);
    assert.match(
      invalidRecoveryController.getState().error ?? "",
      /历史交接.*不完整/
    );
    assert.equal(invalidRecoverySubmitted, false);
    invalidRecoveryController.destroy();
  }
}

{
  const oldCandidate = deferred<Record<string, unknown>>();
  const newCandidate = deferred<Record<string, unknown>>();
  const api = {
    async getTask() {
      return taskDetail;
    },
    getCandidate(candidateId: string) {
      return candidateId === "candidate-old"
        ? oldCandidate.promise
        : newCandidate.promise;
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestIntelligenceOperation() {
      return null;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({ api });

  await controller.open("candidates", "plan-1");
  const oldRequest = controller.selectCandidate("candidate-old");
  const newRequest = controller.selectCandidate("candidate-new");
  newCandidate.resolve({
    candidate: { id: "candidate-new", identityResolved: true },
    etag: null
  });
  await newRequest;
  oldCandidate.resolve({
    candidate: { id: "candidate-old", identityResolved: true },
    etag: null
  });
  await oldRequest;

  assert.equal(controller.getState().selectedCandidateId, "candidate-new");
  assert.equal(controller.getState().candidateDetail?.candidate?.id, "candidate-new");
  controller.destroy();
}

{
  const candidateLoads: string[] = [];
  const api = {
    async getTask() {
      return {
        ...taskDetail,
        latestRun: { id: "run-comment-click", status: "succeeded", evidenceCount: 1 },
        presentation: {
          candidateEvents: [{
            eventId: "event-auto-1",
            candidateId: "candidate-auto-1",
            candidate: { id: "candidate-auto-1", displayName: "自动选中候选" },
            qualification: { grade: "A", reasons: ["明确需求"] }
          }],
          providers: [],
          summary: null,
          hasMore: false,
          nextAfter: null
        }
      };
    },
    async getCandidate(candidateId: string) {
      candidateLoads.push(candidateId);
      return {
        candidate: {
          id: candidateId,
          status: "pending_review",
          identityResolved: true,
          latestDecisionVersion: "decision-auto-1"
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return { grade: "A", reasons: ["明确需求"] };
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestIntelligenceOperation() {
      return null;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({ api });

  await controller.open("plan", "plan-1");
  controller.switchMode("candidates");
  await controller.whenIdle();

  assert.deepEqual(candidateLoads, ["candidate-auto-1"]);
  assert.equal(controller.getState().selectedCandidateId, "candidate-auto-1");
  assert.equal(controller.getState().candidateDetail?.candidate?.id, "candidate-auto-1");
  controller.destroy();
}

{
  let focusReturns = 0;
  const opener = { focus: () => { focusReturns += 1; } };
  const root = new FakeDialogRoot(opener);
  const body = { innerHTML: "" };
  const api = {
    async getTask() {
      return taskDetail;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    root: root as unknown as HTMLElement,
    body: body as unknown as HTMLElement
  });

  await controller.open("plan", "plan-1");
  assert.equal(root.open, true);
  assert.equal(root.hidden, false);
  assert.equal(root.attributes.get("aria-hidden"), "false");

  root.emitClick(fakeAction({
    acquisitionDetailAction: "switch-mode",
    mode: "candidates"
  }));
  assert.equal(controller.getState().mode, "candidates");

  root.emitClick(fakeAction({ acquisitionDetailAction: "close" }));
  assert.equal(root.open, false);
  assert.equal(root.hidden, true);
  assert.equal(focusReturns, 1);

  await controller.open("plan", "plan-1");
  root.nativeClose();
  assert.equal(root.hidden, true);
  assert.equal(focusReturns, 2, "native Escape close must return focus");

  controller.destroy();
}

{
  const root = new FakeDialogRoot(null);
  const body = { innerHTML: "" };
  const api = {
    async getTask() {
      return {
        ...taskDetail,
        latestRun: { id: "run-comment-click", status: "succeeded", evidenceCount: 1 },
        presentation: {
          candidateEvents: [{ eventId: "comment-event-click", candidateId: "candidate-comment-click" }],
          providers: [],
          summary: {},
          hasMore: false,
          nextAfter: null
        }
      };
    },
    async getCandidate() {
      return { candidate: { id: "candidate-comment-click", status: "pending_review", identityResolved: false }, etag: null };
    },
    async getCandidateEvidence() {
      return { items: [{ id: "evidence-comment-click", sourceSnippet: "评论公开证据" }], nextCursor: null };
    },
    async getCandidateQualification() { return null; },
    async getCandidateFinancialValue() { return null; },
    async getCandidateBattleCard() { return null; },
    async getCandidateReviews() { return { items: [], nextCursor: null }; },
    async getLatestIntelligenceOperation() { return null; }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    root: root as unknown as HTMLElement,
    body: body as unknown as HTMLElement
  });
  await controller.open("plan", "plan-1");
  root.emitClick(fakeAction({
    acquisitionDetailAction: "select-candidate",
    candidateId: "candidate-comment-click"
  }));
  await controller.whenIdle();
  assert.equal(controller.getState().mode, "candidates");
  assert.equal(controller.getState().selectedCandidateId, "candidate-comment-click");
  assert.match(body.innerHTML, /data-acquisition-detail-panel="candidates"/);
  assert.match(body.innerHTML, /评论公开证据/);
  controller.destroy();
}

for (const scenario of [{
  label: "empty-candidate-page",
  candidateEvents: []
}, {
  label: "different-candidate-page",
  candidateEvents: [{
    eventId: "comment-event-other-candidate",
    candidateId: "candidate-other-page"
  }]
}]) {
  const root = new FakeDialogRoot(null);
  const body = { innerHTML: "" };
  const evidenceId = `evidence-comment-${scenario.label}`;
  const evidenceSnippet = `分页外评论公开证据-${scenario.label}`;
  const api = {
    async getTask() {
      return {
        ...taskDetail,
        latestRun: { id: `run-${scenario.label}`, status: "succeeded", evidenceCount: 1 },
        presentation: {
          candidateEvents: scenario.candidateEvents,
          commentSignals: [{
            eventId: `comment-signal-${scenario.label}`,
            candidateId: "candidate-comment-pagination",
            displayName: "评论公开主体",
            text: "想了解企业获客方案",
            intentBand: "strong_signal",
            reasons: ["明确询价"],
            confidence: 0.9,
            identityStatus: "needs_research"
          }],
          providers: [],
          summary: {},
          hasMore: false,
          nextAfter: null
        }
      };
    },
    async getCandidate() {
      return {
        candidate: {
          id: "candidate-comment-pagination",
          displayName: "评论公开主体",
          status: "pending_review",
          subjectKind: "individual",
          sourcePlatform: "douyin",
          identityResolved: false
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return {
        items: [{
          id: evidenceId,
          sourceTitle: "抖音公开评论",
          sourcePlatform: "douyin",
          sourceSnippet: evidenceSnippet,
          fetchedAt: "2026-08-15T10:00:00.000Z"
        }],
        nextCursor: null
      };
    },
    async getCandidateQualification() { return null; },
    async getCandidateFinancialValue() { return null; },
    async getCandidateBattleCard() { return null; },
    async getCandidateReviews() { return { items: [], nextCursor: null }; },
    async getLatestIntelligenceOperation() { return null; }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    root: root as unknown as HTMLElement,
    body: body as unknown as HTMLElement
  });
  await controller.open("plan", "plan-1");
  assert.match(body.innerHTML, /高潜需求信号 · 评论公开主体/);
  root.emitClick(fakeAction({
    acquisitionDetailAction: "select-candidate",
    candidateId: "candidate-comment-pagination"
  }));
  await controller.whenIdle();
  assert.equal(controller.getState().mode, "candidates");
  assert.equal(controller.getState().selectedCandidateId, "candidate-comment-pagination");
  assert.match(body.innerHTML, new RegExp(evidenceSnippet));
  assert.match(body.innerHTML, new RegExp(evidenceId));
  assert.match(body.innerHTML, /当前候选来自抖音公开内容/);
  assert.doesNotMatch(body.innerHTML, /comment-event-comment-pagination/);
  controller.destroy();
}

{
  const eventTarget = new EventTarget();
  const requestedPlanIds: string[] = [];
  const api = {
    async getTask(planId: string) {
      requestedPlanIds.push(planId);
      return taskDetail;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget
  });

  eventTarget.dispatchEvent(detailEvent(
    "goodjob:acquisition-detail-open-requested",
    { mode: "plan", planId: "plan-1" }
  ));
  await controller.whenIdle();

  assert.deepEqual(requestedPlanIds, ["plan-1"]);
  assert.equal(controller.getState().mode, "plan");
  assert.equal(controller.getState().status, "ready");
  assert.equal(controller.getState().detail?.plan.id, "plan-1");

  controller.destroy();
}

{
  const eventTarget = new EventTarget();
  const changed: Array<Record<string, unknown>> = [];
  eventTarget.addEventListener("goodjob:acquisition-candidate-changed", (event) => {
    changed.push((event as CustomEvent<Record<string, unknown>>).detail);
  });
  const reviewKeys: string[] = [];
  let reviewAttempts = 0;
  const api = {
    async getTask() {
      return taskDetail;
    },
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          status: "pending_review",
          identityResolved: true,
          latestDecisionVersion: "decision-v1"
        },
        etag: '"candidate-v1"'
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return { decisionVersion: "decision-v1", grade: "A" };
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestIntelligenceOperation() {
      return null;
    },
    async reviewCandidate(
      candidateId: string,
      input: { action: string; decisionVersion: string; reason: string | null },
      idempotencyKey: string
    ) {
      assert.equal(candidateId, "candidate-review");
      assert.deepEqual(input, {
        action: "rejected",
        decisionVersion: "decision-v1",
        reason: "需要补充预算证据"
      });
      reviewKeys.push(idempotencyKey);
      reviewAttempts += 1;
      if (reviewAttempts === 1) throw new Error("审核网络失败");
      return { candidate: { id: candidateId }, review: { action: input.action }, research: null };
    }
  } as unknown as AcquisitionDetailApi;
  let keySerial = 0;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget,
    keyFactory: () => `review-key-${++keySerial}`
  });

  await controller.open("candidates", "plan-1");
  await controller.selectCandidate("candidate-review");
  await assert.rejects(
    () => controller.reviewCandidate("rejected", "  "),
    /原因/
  );
  assert.equal(reviewAttempts, 0);
  assert.match(controller.getState().error ?? "", /原因/);

  await assert.rejects(
    () => controller.reviewCandidate("rejected", "需要补充预算证据"),
    /审核网络失败/
  );
  await controller.reviewCandidate("rejected", "需要补充预算证据");
  assert.equal(reviewKeys[0], reviewKeys[1]);
  assert.deepEqual(changed.at(-1), {
    planId: "plan-1",
    candidateId: "candidate-review",
    action: "rejected"
  });

  await controller.reviewCandidate("rejected", "需要补充预算证据");
  assert.notEqual(reviewKeys[1], reviewKeys[2]);

  controller.destroy();
}

{
  const started: string[] = [];
  const api = {
    async getTask() {
      return {
        ...taskDetail,
        presentation: {
          candidateEvents: [],
          providers: [],
          summary: null,
          hasMore: false,
          nextAfter: null
        }
      };
    },
    async getCandidate(candidateId: string) {
      started.push("candidate");
      return {
        candidate: {
          id: candidateId,
          status: "pending_review",
          identityResolved: true,
          latestDecisionVersion: "decision-v1"
        },
        etag: '"candidate-v1"'
      };
    },
    async getCandidateEvidence() {
      started.push("evidence");
      return { items: [{ id: "evidence-1" }], nextCursor: null };
    },
    async getCandidateQualification() {
      started.push("qualification");
      return { decisionVersion: "decision-v1", grade: "A" };
    },
    async getCandidateFinancialValue() {
      started.push("financial");
      return { expectedAmountMinor: 100_000, currency: "CNY" };
    },
    async getCandidateBattleCard() {
      started.push("battle-card");
      return { schemaVersion: "battle-card.v2" };
    },
    async getCandidateReviews() {
      started.push("reviews");
      return { items: [{ id: "review-1", action: "approved" }], nextCursor: null };
    },
    async getLatestIntelligenceOperation() {
      started.push("intelligence-operation");
      return { id: "operation-1", status: "succeeded" };
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({ api });

  await controller.open("candidates", "plan-1");
  await controller.selectCandidate("candidate-1");

  assert.deepEqual(started.sort(), [
    "battle-card",
    "candidate",
    "evidence",
    "financial",
    "intelligence-operation",
    "qualification",
    "reviews"
  ]);
  assert.equal(controller.getState().selectedCandidateId, "candidate-1");
  assert.equal(controller.getState().candidateDetail?.candidate?.id, "candidate-1");
  assert.equal(controller.getState().candidateDetail?.evidence.length, 1);
  assert.equal(controller.getState().candidateDetail?.reviews.length, 1);

  controller.destroy();
}

{
  const operationKeys: string[] = [];
  let operationAttempts = 0;
  const api = {
    async getTask() {
      return taskDetail;
    },
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          status: "normalized",
          identityResolved: true,
          latestDecisionVersion: null
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestIntelligenceOperation() {
      return null;
    },
    async startIntelligenceOperation(candidateId: string, idempotencyKey: string) {
      assert.equal(candidateId, "candidate-ai");
      operationKeys.push(idempotencyKey);
      operationAttempts += 1;
      if (operationAttempts === 1) throw new Error("AI 任务创建失败");
      return { id: `operation-${operationAttempts}`, status: "queued" };
    }
  } as unknown as AcquisitionDetailApi;
  let keySerial = 0;
  const controller = createAcquisitionDetailCenterController({
    api,
    keyFactory: () => `operation-key-${++keySerial}`
  });

  await controller.open("candidates", "plan-1");
  await controller.selectCandidate("candidate-ai");
  await assert.rejects(
    () => controller.startIntelligence(),
    /AI 任务创建失败/
  );
  await controller.startIntelligence();
  assert.equal(operationKeys[0], operationKeys[1]);
  await controller.startIntelligence();
  assert.notEqual(operationKeys[1], operationKeys[2]);

  controller.destroy();
}

{
  let identityResolved = false;
  const contentFetches: Array<Record<string, unknown>> = [];
  const confirmations: Array<Record<string, unknown>> = [];
  const intelligenceStarts: string[] = [];
  const changed: Array<Record<string, unknown>> = [];
  const eventTarget = new EventTarget();
  eventTarget.addEventListener("goodjob:acquisition-candidate-changed", (event) => {
    changed.push((event as CustomEvent<Record<string, unknown>>).detail);
  });
  const individualCandidate = () => ({
    id: "candidate-douyin-identity",
    subjectKind: "individual",
    publicActorKey: "unknown-public-actor",
    publicDisplayName: "陈经理",
    publicProfileUrl: identityResolved
      ? "https://www.douyin.com/user/example"
      : "",
    sourcePlatform: "douyin",
    demandCategory: "获客",
    demandSummary: "公开表达获客需求",
    locationHint: "厦门",
    buyingStage: "solution_research",
    negativeSignals: [],
    firstSeenAt: "2026-08-07T05:00:00.000Z",
    lastSeenAt: "2026-08-07T05:04:00.000Z",
    status: "normalized",
    version: identityResolved ? 2 : 1,
    identityResolved,
    latestDecisionVersion: null,
    approvedDecisionVersion: null,
    evidenceIds: ["original-evidence-1"],
    updatedAt: "2026-08-07T05:04:00.000Z"
  });
  const api = {
    async getTask() {
      return {
        ...taskDetail,
        latestRun: { id: "run-identity" },
        presentation: {
          candidateEvents: [{
            eventId: "event-douyin-identity",
            candidateId: "candidate-douyin-identity",
            candidate: {
              id: "candidate-douyin-identity",
              subjectKind: "individual",
              displayName: "陈经理",
              status: "normalized",
              version: identityResolved ? 2 : 1,
              identityResolved,
              updatedAt: "2026-08-07T05:04:00.000Z"
            },
            qualification: null,
            financialValue: null,
            evidenceCount: 1
          }],
          providers: [],
          summary: { validOpportunities: 1 },
          hasMore: false,
          nextAfter: null
        }
      };
    },
    async getCandidate() {
      return { candidate: individualCandidate(), etag: null };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestIntelligenceOperation() {
      return null;
    },
    async createContentFetchOperation(input: Record<string, unknown>) {
      contentFetches.push(input);
      return {
        id: "content-fetch-identity",
        sourceUrl: input.sourceUrl,
        finalUrl: input.sourceUrl,
        subjectChannel: "individual",
        status: "succeeded",
        accessStatus: "public_content",
        httpStatus: 200,
        contentType: "text/html",
        title: "陈经理的抖音主页",
        rawArtifactHash: "sha256:raw-profile",
        contentHash: "sha256:profile",
        evidenceCount: 1,
        evidenceIds: ["identity-evidence-1"],
        candidateCount: 1,
        candidateIds: ["candidate-douyin-identity"],
        errorCode: null,
        createdAt: "2026-08-07T05:04:00.000Z",
        startedAt: "2026-08-07T05:04:01.000Z",
        completedAt: "2026-08-07T05:04:02.000Z"
      };
    },
    async getContentFetchOperation() {
      throw new Error("succeeded create response should not poll");
    },
    async confirmCandidateIdentity(
      _candidateId: string,
      version: number,
      input: Record<string, unknown>
    ) {
      confirmations.push({ version, input });
      identityResolved = true;
      return {
        candidate: individualCandidate(),
        resolution: {
          status: "resolved",
          basis: "provider_public_actor",
          resolverVersion: "identity-resolution.v1",
          evidenceIds: ["identity-evidence-1"],
          resolvedAt: "2026-08-07T05:04:03.000Z",
          resolvedBy: "user-1"
        }
      };
    },
    async startIntelligenceOperation(candidateId: string) {
      intelligenceStarts.push(candidateId);
      return {
        id: "intelligence-after-identity",
        candidateId,
        status: "queued",
        currentStage: null,
        completedStages: [],
        skippedStages: [],
        research: null,
        qualification: null,
        battleCardId: null,
        failure: null,
        createdAt: "2026-08-07T05:04:04.000Z",
        startedAt: null,
        updatedAt: "2026-08-07T05:04:04.000Z",
        completedAt: null,
        failedAt: null
      };
    }
  } as unknown as AcquisitionDetailApi;
  let keySerial = 0;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget,
    keyFactory: () => `identity-flow-key-${++keySerial}`
  });

  await controller.open("candidates", "plan-identity");
  assert.equal(
    controller.getState().identityVerification?.status,
    "idle"
  );

  await controller.fetchCandidateIdentityProfile(
    "https://www.douyin.com/user/example",
    "公开主页与候选主体一致"
  );
  assert.deepEqual(contentFetches, [{
    sourceUrl: "https://www.douyin.com/user/example",
    subjectChannel: "individual"
  }]);
  assert.equal(
    controller.getState().identityVerification?.status,
    "ready_to_confirm"
  );
  assert.deepEqual(
    controller.getState().identityVerification?.evidenceIds,
    ["identity-evidence-1"]
  );

  await controller.confirmCandidateIdentity({
    profileUrl: "https://www.douyin.com/user/example",
    rationale: "公开主页与候选主体一致",
    evidenceIds: ["identity-evidence-1"]
  });
  assert.deepEqual(confirmations, [{
    version: 1,
    input: {
      subjectKind: "individual",
      publicProfileUrl: "https://www.douyin.com/user/example",
      sourcePlatform: "douyin",
      evidenceIds: ["identity-evidence-1"],
      rationale: "公开主页与候选主体一致"
    }
  }]);
  assert.deepEqual(intelligenceStarts, ["candidate-douyin-identity"]);
  assert.equal(
    controller.getState().identityVerification?.status,
    "confirmed"
  );
  assert.equal(
    controller.getState().candidateDetail?.candidate?.identityResolved,
    true
  );
  assert.equal(
    changed.at(-1)?.action,
    "identity_confirmed_and_intelligence_started"
  );

  controller.destroy();
}

{
  const presentationCalls: Array<{ runId: string; after?: string; limit?: number }> = [];
  const firstCandidateEvent = {
    eventId: "event-more-1",
    candidateId: "candidate-more-1",
    candidate: { id: "candidate-more-1", displayName: "首批候选" },
    qualification: null,
    financialValue: null,
    evidenceCount: 1
  };
  const api = {
    async getTask() {
      return {
        ...taskDetail,
        latestRun: {
          id: "run-more-1",
          status: "succeeded",
          updatedAt: "2026-08-07T10:00:00.000Z",
          completedAt: "2026-08-07T10:00:00.000Z",
          evidenceCount: 2,
          consumedBudget: {
            requests: 2,
            results: 2,
            amountMinor: 20,
            durationSeconds: 2
          }
        },
        presentation: {
          candidateEvents: [firstCandidateEvent],
          providers: [{ shardId: "shard-more-1" }],
          summary: { validOpportunities: 2 },
          hasMore: true,
          nextAfter: "candidate-cursor-1"
        }
      };
    },
    async getRunPresentation(
      runId: string,
      query?: { after?: string; limit?: number }
    ) {
      presentationCalls.push({ runId, ...query });
      return {
        run: {
          id: runId,
          status: "succeeded",
          etag: "run-more-etag",
          updatedAt: "2026-08-07T10:00:00.000Z",
          completedAt: "2026-08-07T10:00:00.000Z"
        },
        providers: [{
          shardId: "shard-more-2",
          connectionId: "connection-more-1",
          providerId: "baidu_ai_search",
          status: "succeeded",
          rawResultCount: 1,
          acceptedResultCount: 1,
          duplicateResultCount: 0,
          failedResultCount: 0,
          errorCode: null,
          retryAfterAt: null
        }],
        summary: {
          sourcesSearched: 1,
          pagesAnalyzed: 2,
          organizationsFound: 2,
          dedupedCandidates: 2,
          validOpportunities: 2,
          highIntent: 1,
          financialEvaluatedHighIntentCount: 0,
          financialPendingHighIntentCount: 1,
          expectedRevenueByCurrency: []
        },
        candidateEvents: [{
          ...firstCandidateEvent,
          eventId: "event-more-1-refreshed"
        }, {
          eventId: "event-more-2",
          candidateId: "candidate-more-2",
          candidate: { id: "candidate-more-2", displayName: "更多候选" },
          qualification: null,
          financialValue: null,
          evidenceCount: 1
        }],
        nextAfter: "",
        hasMore: false
      };
    },
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          status: "normalized",
          identityResolved: true,
          latestDecisionVersion: null
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestIntelligenceOperation() {
      return null;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({ api });

  await controller.open("candidates", "plan-more-1");
  await controller.loadMoreCandidates();

  assert.deepEqual(presentationCalls, [{
    runId: "run-more-1",
    after: "candidate-cursor-1",
    limit: 100
  }]);
  assert.deepEqual(
    controller.getState().detail?.presentation?.candidateEvents.map(
      (event) => event.candidateId
    ),
    ["candidate-more-1", "candidate-more-2"]
  );
  assert.equal(controller.getState().detail?.presentation?.hasMore, false);
  controller.destroy();
}

{
  const evidenceCursors: Array<string | null> = [];
  const reviewCursors: Array<string | null> = [];
  const api = {
    async getTask() {
      return taskDetail;
    },
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          status: "pending_review",
          identityResolved: true,
          latestDecisionVersion: "decision-page-1"
        },
        etag: null
      };
    },
    async getCandidateEvidence(
      _candidateId: string,
      query?: { cursor?: string; limit?: number }
    ) {
      evidenceCursors.push(query?.cursor ?? null);
      if (!query?.cursor) {
        return {
          items: [{ id: "evidence-page-1" }],
          nextCursor: "evidence-cursor-1"
        };
      }
      assert.equal(query.cursor, "evidence-cursor-1");
      return {
        items: [{ id: "evidence-page-2" }],
        nextCursor: "evidence-cursor-1"
      };
    },
    async getCandidateQualification() {
      return { decisionVersion: "decision-page-1", grade: "A" };
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews(
      _candidateId: string,
      query?: { cursor?: string; limit?: number }
    ) {
      reviewCursors.push(query?.cursor ?? null);
      if (!query?.cursor) {
        return {
          items: [{ id: "review-page-1", action: "approved" }],
          nextCursor: "review-cursor-1"
        };
      }
      assert.equal(query.cursor, "review-cursor-1");
      return {
        items: [{ id: "review-page-2", action: "rejected" }],
        nextCursor: null
      };
    },
    async getLatestIntelligenceOperation() {
      return null;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({ api });

  await controller.open("candidates", "plan-1");
  await controller.selectCandidate("candidate-pages");

  assert.deepEqual(evidenceCursors, [null, "evidence-cursor-1"]);
  assert.deepEqual(reviewCursors, [null, "review-cursor-1"]);
  assert.deepEqual(
    controller.getState().candidateDetail?.evidence.map((item) => item.id),
    ["evidence-page-1", "evidence-page-2"]
  );
  assert.deepEqual(
    controller.getState().candidateDetail?.reviews.map((item) => item.id),
    ["review-page-1", "review-page-2"]
  );
  controller.destroy();
}

// Catches an older in-flight poll rolling a run back after a later candidate
// refresh has already observed the terminal state.
{
  const scheduler = new ManualPollScheduler();
  const stalePoll = deferred<Record<string, unknown>>();
  let taskReads = 0;
  const candidateId = "candidate-freshness";
  const detailAt = (status: "running" | "succeeded", updatedAt: string) => ({
    ...taskDetail,
    latestRun: {
      id: "run-freshness",
      status,
      etag: status === "running" ? '"run-freshness:1"' : '"run-freshness:2"',
      updatedAt,
      completedAt: status === "succeeded" ? updatedAt : null,
      evidenceCount: status === "succeeded" ? 4 : 1,
      consumedBudget: {
        requests: status === "succeeded" ? 4 : 1,
        results: status === "succeeded" ? 3 : 1,
        amountMinor: 0,
        durationSeconds: status === "succeeded" ? 8 : 1
      }
    },
    presentation: {
      candidateEvents: [{
        eventId: "event-freshness",
        candidateId,
        candidate: { id: candidateId, displayName: "时序候选" }
      }],
      providers: [],
      summary: { validOpportunities: 1 },
      hasMore: false,
      nextAfter: null
    }
  });
  const api = {
    getTask() {
      taskReads += 1;
      if (taskReads === 2) return stalePoll.promise;
      return Promise.resolve(taskReads >= 3
        ? detailAt("succeeded", "2026-08-07T17:02:00.000Z")
        : detailAt("running", "2026-08-07T17:00:00.000Z"));
    },
    async getCandidate() {
      return {
        candidate: {
          id: candidateId,
          status: "pending_review",
          identityResolved: true,
          latestDecisionVersion: "decision-freshness"
        },
        etag: '"candidate-freshness:1"'
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return { decisionVersion: "decision-freshness", grade: "A" };
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestIntelligenceOperation() {
      return null;
    },
    async reviewCandidate() {
      return { candidate: { id: candidateId }, review: {}, research: null };
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.open("candidates", "plan-1");
  scheduler.runNext();
  await controller.reviewCandidate("approved");
  assert.equal(controller.getState().detail?.latestRun?.status, "succeeded");

  stalePoll.resolve(detailAt("running", "2026-08-07T17:00:00.000Z"));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.getState().detail?.latestRun?.status, "succeeded");
  assert.equal(controller.getState().detail?.latestRun?.evidenceCount, 4);
  assert.equal(scheduler.pendingCount(), 0);
  controller.destroy();
}

// Catches a closed dialog carrying a previous page-load spinner into the next
// plan after the stale response is intentionally ignored.
{
  const scheduler = new ManualPollScheduler();
  const oldPage = deferred<Record<string, unknown>>();
  const api = {
    async getTask(planId: string) {
      if (planId === "plan-new-after-page") {
        return {
          ...taskDetail,
          plan: { ...taskDetail.plan, id: planId },
          latestRun: null,
          presentation: null
        };
      }
      return {
        ...taskDetail,
        plan: { ...taskDetail.plan, id: planId },
        latestRun: {
          id: "run-close-page",
          status: "running" as const,
          etag: '"run-close-page:1"',
          updatedAt: "2026-08-07T16:00:00.000Z",
          completedAt: null,
          evidenceCount: 1,
          consumedBudget: {
            requests: 1,
            results: 1,
            amountMinor: 0,
            durationSeconds: 1
          }
        },
        presentation: {
          candidateEvents: [{
            eventId: "event-close-page",
            candidateId: "candidate-close-page",
            candidate: { id: "candidate-close-page", displayName: "旧计划候选" }
          }],
          providers: [],
          summary: { validOpportunities: 1 },
          automationSteps: [{ id: "fetch_public_comment_samples", status: "running" }],
          commentSignals: [{ eventId: "comment-tail-1", text: "旧投影" }],
          hasMore: true,
          nextAfter: "cursor-close-page"
        }
      };
    },
    getRunPresentation() {
      return oldPage.promise;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.open("plan", "plan-old-page");
  const oldPageRequest = controller.loadMoreCandidates();
  assert.equal(controller.getState().loadingMoreCandidates, true);
  controller.close();
  await controller.open("plan", "plan-new-after-page");
  assert.equal(controller.getState().loadingMoreCandidates, false);

  oldPage.resolve({
    run: {},
    providers: [],
    summary: {},
    candidateEvents: [],
    hasMore: false,
    nextAfter: null
  });
  await oldPageRequest;
  assert.equal(controller.getState().detail?.plan.id, "plan-new-after-page");
  controller.destroy();
}

{
  let evidencePage = 0;
  const api = {
    async getTask() {
      return taskDetail;
    },
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          status: "pending_review",
          identityResolved: true,
          latestDecisionVersion: "decision-partial-1"
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      evidencePage += 1;
      if (evidencePage === 1) {
        return {
          items: [{ id: "evidence-preserved" }],
          nextCursor: "evidence-next"
        };
      }
      throw new Error("证据第二页暂不可用");
    },
    async getCandidateQualification() {
      return {
        decisionVersion: "decision-partial-1",
        grade: "A",
        reasons: ["资格研判已完成"]
      };
    },
    async getCandidateFinancialValue() {
      throw new Error("财务价值暂不可用");
    },
    async getCandidateBattleCard() {
      return { schemaVersion: "battle-card.v2", id: "battle-preserved" };
    },
    async getCandidateReviews() {
      throw new Error("审核记录暂不可用");
    },
    async getLatestIntelligenceOperation() {
      return { id: "operation-preserved", status: "succeeded" };
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({ api });

  await controller.open("candidates", "plan-1");
  await controller.selectCandidate("candidate-partial");

  const loaded = controller.getState().candidateDetail;
  assert.equal(loaded?.candidate?.id, "candidate-partial");
  assert.deepEqual(loaded?.evidence.map((item) => item.id), [
    "evidence-preserved"
  ]);
  assert.equal(loaded?.qualification?.grade, "A");
  assert.equal(loaded?.financialValue, null);
  assert.equal(loaded?.battleCard?.id, "battle-preserved");
  assert.deepEqual(loaded?.reviews, []);
  assert.equal(loaded?.intelligenceOperation?.id, "operation-preserved");
  assert.match(controller.getState().error ?? "", /证据/);
  assert.match(controller.getState().error ?? "", /财务价值/);
  assert.match(controller.getState().error ?? "", /审核记录/);
  controller.destroy();
}

{
  const review = deferred<Record<string, unknown>>();
  const changed: Array<Record<string, unknown>> = [];
  const eventTarget = new EventTarget();
  eventTarget.addEventListener(
    "goodjob:acquisition-candidate-changed",
    (event) => changed.push(
      (event as CustomEvent<Record<string, unknown>>).detail
    )
  );
  const taskReads: string[] = [];
  const api = {
    async getTask(planId: string) {
      taskReads.push(planId);
      return {
        ...taskDetail,
        task: { ...taskDetail.task, planId },
        plan: { ...taskDetail.plan, id: planId }
      };
    },
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          status: "pending_review",
          identityResolved: true,
          latestDecisionVersion: `decision-${candidateId}`
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification(candidateId: string) {
      return { decisionVersion: `decision-${candidateId}`, grade: "A" };
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestIntelligenceOperation() {
      return null;
    },
    reviewCandidate() {
      return review.promise;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget
  });

  await controller.open("candidates", "plan-old");
  await controller.selectCandidate("candidate-old");
  const staleMutation = controller.reviewCandidate("approved");
  controller.close();
  await controller.open("candidates", "plan-new");
  await controller.selectCandidate("candidate-new");
  review.resolve({ candidate: { id: "candidate-old" } });
  await staleMutation;

  assert.equal(controller.getState().detail?.plan.id, "plan-new");
  assert.equal(controller.getState().selectedCandidateId, "candidate-new");
  assert.equal(
    controller.getState().candidateDetail?.candidate?.id,
    "candidate-new"
  );
  assert.deepEqual(changed, []);
  assert.deepEqual(taskReads, ["plan-old", "plan-new"]);
  controller.destroy();
}

{
  const intelligence = deferred<Record<string, unknown>>();
  const changed: Array<Record<string, unknown>> = [];
  const eventTarget = new EventTarget();
  eventTarget.addEventListener(
    "goodjob:acquisition-candidate-changed",
    (event) => changed.push(
      (event as CustomEvent<Record<string, unknown>>).detail
    )
  );
  const api = {
    async getTask() {
      return taskDetail;
    },
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          status: "normalized",
          identityResolved: true,
          latestDecisionVersion: null
        },
        etag: null
      };
    },
    async getCandidateEvidence() {
      return { items: [], nextCursor: null };
    },
    async getCandidateQualification() {
      return null;
    },
    async getCandidateFinancialValue() {
      return null;
    },
    async getCandidateBattleCard() {
      return null;
    },
    async getCandidateReviews() {
      return { items: [], nextCursor: null };
    },
    async getLatestIntelligenceOperation() {
      return null;
    },
    startIntelligenceOperation() {
      return intelligence.promise;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget
  });

  await controller.open("candidates", "plan-1");
  await controller.selectCandidate("candidate-intelligence-old");
  const staleMutation = controller.startIntelligence();
  await controller.selectCandidate("candidate-intelligence-new");
  intelligence.resolve({ id: "operation-old", status: "queued" });
  await staleMutation;

  assert.equal(
    controller.getState().candidateDetail?.candidate?.id,
    "candidate-intelligence-new"
  );
  assert.equal(controller.getState().message, null);
  assert.deepEqual(changed, []);
  controller.destroy();
}

{
  const startKeys: string[] = [];
  const refreshes: Array<Record<string, unknown>> = [];
  const eventTarget = new EventTarget();
  eventTarget.addEventListener(
    "goodjob:acquisition-refresh-requested",
    (event) => refreshes.push(
      (event as CustomEvent<Record<string, unknown>>).detail
    )
  );
  let createAttempts = 0;
  let taskReads = 0;
  const completedRun = {
    id: "run-start-1",
    status: "succeeded" as const,
    etag: '"run-start-1:2"',
    updatedAt: "2026-08-07T12:00:00.000Z",
    completedAt: "2026-08-07T12:00:00.000Z",
    evidenceCount: 4,
    consumedBudget: {
      requests: 2,
      results: 4,
      amountMinor: 40,
      durationSeconds: 12
    }
  };
  const api = {
    async getTask() {
      taskReads += 1;
      return taskReads === 1
        ? taskDetail
        : { ...taskDetail, latestRun: completedRun };
    },
    async createRun(
      planId: string,
      input: { reason?: string },
      idempotencyKey: string
    ) {
      assert.equal(planId, "plan-1");
      assert.deepEqual(input, { reason: "开始公开检索" });
      startKeys.push(idempotencyKey);
      createAttempts += 1;
      if (createAttempts === 1) throw new Error("运行创建网络失败");
      return {
        run: {
          ...completedRun,
          status: "queued",
          completedAt: null
        },
        etag: '"run-start-1:1"'
      };
    }
  } as unknown as AcquisitionDetailApi;
  let keySerial = 0;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget,
    keyFactory: () => `run-start-key-${++keySerial}`
  });

  await controller.open("plan", "plan-1");
  await assert.rejects(
    () => controller.startRun("  开始公开检索  "),
    /运行创建网络失败/
  );
  assert.equal(controller.getState().runControlBusy, false);
  assert.equal(controller.getState().runControlReason, "开始公开检索");
  await controller.startRun();
  assert.equal(startKeys[0], startKeys[1]);
  assert.equal(controller.getState().detail?.latestRun?.status, "succeeded");
  assert.equal(controller.getState().runControlBusy, false);
  assert.equal(controller.getState().runControlReason, "");
  assert.deepEqual(refreshes.at(-1), {
    planId: "plan-1",
    action: "start",
    runId: "run-start-1"
  });

  await controller.startRun("  开始公开检索  ");
  assert.notEqual(startKeys[1], startKeys[2]);
  controller.destroy();
}

{
  let taskReads = 0;
  const createInputs: Array<Record<string, unknown>> = [];
  const budgetRun = {
    id: "run-budget-parent",
    status: "budget_exhausted" as const,
    planVersion: 1,
    etag: '"run-budget-parent:2"',
    updatedAt: "2026-08-07T12:00:00.000Z",
    completedAt: "2026-08-07T12:00:00.000Z",
    evidenceCount: 8,
    consumedBudget: {
      requests: 10,
      results: 8,
      amountMinor: 1_000,
      durationSeconds: 100
    }
  };
  const continuedRun = {
    ...budgetRun,
    id: "run-budget-child",
    status: "queued" as const,
    planVersion: 2,
    etag: '"run-budget-child:1"',
    completedAt: null,
    consumedBudget: {
      requests: 0,
      results: 0,
      amountMinor: 0,
      durationSeconds: 0
    }
  };
  const api = {
    async getTask() {
      taskReads += 1;
      return {
        ...taskDetail,
        plan: { ...taskDetail.plan, version: 2 },
        latestRun: taskReads === 1 ? budgetRun : continuedRun
      };
    },
    async createRun(
      planId: string,
      input: Record<string, unknown>,
      idempotencyKey: string
    ) {
      assert.equal(planId, "plan-1");
      assert.match(idempotencyKey, /budget-key/);
      createInputs.push(input);
      return {
        run: {
          ...continuedRun,
          ownerId: "user-1",
          teamId: "team-1",
          planId,
          planVersionId: "plan-version-2",
          planSnapshotHash: "sha256:plan-2",
          parentRunId: budgetRun.id,
          terminationIntent: null,
          revision: 1,
          budgetSnapshotId: "budget-2",
          budgetSnapshot: {
            billingCurrency: "CNY",
            maxRequests: 20,
            maxResults: 20,
            maxAmountMinor: 2_000,
            maxDurationSeconds: 200
          },
          budgetSnapshotHash: "sha256:budget-2",
          billingCurrency: "CNY",
          modelSnapshotRef: {
            jobSnapshotId: "snapshot-2",
            connectionId: "model-2",
            credentialVersion: 1,
            provider: "zhipu",
            model: "glm-5.2",
            capabilitySnapshotHash: "sha256:capability",
            promptVersion: "prompt-v1",
            schemaVersion: "schema-v1",
            promptHash: "sha256:prompt",
            schemaHash: "sha256:schema"
          },
          reason: "追加预算后继续",
          createdBy: "user-1",
          createdAt: "2026-08-07T12:01:00.000Z",
          updatedBy: "user-1"
        },
        etag: continuedRun.etag
      };
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    keyFactory: () => "budget-key-0001"
  });

  await controller.open("plan", "plan-1");
  await controller.startRun(" 追加预算后继续 ");
  assert.deepEqual(createInputs, [{
    parentRunId: "run-budget-parent",
    reason: "追加预算后继续"
  }]);
  assert.equal(controller.getState().detail?.latestRun?.id, "run-budget-child");
  controller.destroy();
}

{
  let taskReads = 0;
  const oldRun = {
    id: "run-old",
    status: "succeeded" as const,
    etag: '"run-old:2"',
    updatedAt: "2026-08-07T12:00:00.000Z",
    completedAt: "2026-08-07T12:00:00.000Z",
    evidenceCount: 5,
    consumedBudget: {
      requests: 2,
      results: 5,
      amountMinor: 20,
      durationSeconds: 20
    }
  };
  const api = {
    async getTask() {
      taskReads += 1;
      if (taskReads > 1) throw new Error("详情刷新失败");
      return {
        ...taskDetail,
        latestRun: oldRun,
        shards: [{ id: "old-shard" }],
        presentation: {
          candidateEvents: [{ candidateId: "old-candidate" }],
          providers: [],
          hasMore: false,
          nextAfter: null
        }
      };
    },
    async createRun(planId: string) {
      return {
        run: {
          id: "run-new",
          ownerId: "user-1",
          teamId: "team-1",
          planId,
          planVersionId: "plan-version-1",
          planVersion: 1,
          planSnapshotHash: "sha256:plan",
          parentRunId: null,
          status: "queued" as const,
          terminationIntent: null,
          revision: 1,
          etag: '"run-new:1"',
          budgetSnapshotId: "budget-1",
          budgetSnapshot: {
            billingCurrency: "CNY",
            maxRequests: 10,
            maxResults: 10,
            maxAmountMinor: 1_000,
            maxDurationSeconds: 100
          },
          budgetSnapshotHash: "sha256:budget",
          billingCurrency: "CNY",
          modelSnapshotRef: {
            jobSnapshotId: "snapshot-1",
            connectionId: "model-1",
            credentialVersion: 1,
            provider: "zhipu",
            model: "glm-5.2",
            capabilitySnapshotHash: "sha256:capability",
            promptVersion: "prompt-v1",
            schemaVersion: "schema-v1",
            promptHash: "sha256:prompt",
            schemaHash: "sha256:schema"
          },
          consumedBudget: {
            requests: 0,
            results: 0,
            amountMinor: 0,
            durationSeconds: 0
          },
          evidenceCount: 0,
          reason: null,
          createdBy: "user-1",
          createdAt: "2026-08-07T12:01:00.000Z",
          updatedBy: "user-1",
          updatedAt: "2026-08-07T12:01:00.000Z",
          completedAt: null
        },
        etag: '"run-new:1"'
      };
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({ api });

  await controller.open("plan", "plan-1");
  await controller.startRun("新的独立运行");
  assert.equal(controller.getState().detail?.latestRun?.id, "run-new");
  assert.deepEqual(controller.getState().detail?.latestRun?.budgetSnapshot, {
    billingCurrency: "CNY",
    maxRequests: 10,
    maxResults: 10,
    maxAmountMinor: 1_000,
    maxDurationSeconds: 100
  });
  assert.deepEqual(controller.getState().detail?.shards, []);
  assert.equal(controller.getState().detail?.presentation, null);
  assert.match(controller.getState().error ?? "", /详情刷新失败/);
  controller.destroy();
}

{
  const oldRun = {
    id: "run-lag-old",
    status: "succeeded" as const,
    etag: '"run-lag-old:2"',
    planVersion: 1,
    updatedAt: "2026-08-07T12:00:00.000Z",
    completedAt: "2026-08-07T12:00:00.000Z",
    evidenceCount: 3,
    consumedBudget: {
      requests: 2,
      results: 3,
      amountMinor: 30,
      durationSeconds: 10
    }
  };
  const newRun = {
    id: "run-lag-new",
    status: "queued" as const,
    etag: '"run-lag-new:1"',
    planVersion: 1,
    revision: 1,
    updatedAt: "2026-08-07T12:01:00.000Z",
    completedAt: null,
    evidenceCount: 0,
    consumedBudget: {
      requests: 0,
      results: 0,
      amountMinor: 0,
      durationSeconds: 0
    },
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 10,
      maxResults: 20,
      maxAmountMinor: 1_000,
      maxDurationSeconds: 120
    },
    modelSnapshotRef: {
      provider: "zhipu",
      model: "glm-5.2"
    }
  };
  const laggedDetail = {
    ...taskDetail,
    latestRun: oldRun,
    shards: [{ id: "old-shard" }],
    presentation: {
      candidateEvents: [{ candidateId: "old-candidate" }],
      providers: [],
      hasMore: false,
      nextAfter: null
    }
  };
  const api = {
    async getTask() {
      return laggedDetail;
    },
    async createRun() {
      return { run: newRun, etag: newRun.etag };
    }
  } as unknown as AcquisitionDetailApi;
  const scheduler = new ManualPollScheduler();
  const controller = createAcquisitionDetailCenterController({
    api,
    pollIntervalMs: 25,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.open("plan", "plan-1");
  await controller.startRun("新的独立运行");

  assert.equal(controller.getState().detail?.latestRun?.id, "run-lag-new");
  assert.deepEqual(controller.getState().detail?.shards, []);
  assert.equal(controller.getState().detail?.presentation, null);
  assert.match(controller.getState().error ?? "", /任务详情仍在同步/);
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(controller.getState().detail?.latestRun?.id, "run-lag-new");
  assert.deepEqual(controller.getState().detail?.shards, []);
  assert.equal(controller.getState().detail?.presentation, null);
  controller.destroy();
}

{
  const refreshes: Array<Record<string, unknown>> = [];
  const eventTarget = new EventTarget();
  eventTarget.addEventListener(
    "goodjob:acquisition-refresh-requested",
    (event) => refreshes.push(
      (event as CustomEvent<Record<string, unknown>>).detail
    )
  );
  let currentRun = {
    id: "run-control-1",
    status: "running" as "running" | "paused" | "queued" | "cancelled",
    etag: '"run-control-1:2"',
    updatedAt: "2026-08-07T12:00:00.000Z",
    completedAt: null,
    evidenceCount: 3,
    consumedBudget: {
      requests: 2,
      results: 3,
      amountMinor: 30,
      durationSeconds: 10
    }
  };
  const calls: Array<{
    runId: string;
    action: string;
    etag: string;
    reason: string;
  }> = [];
  let confirmCalls = 0;
  const api = {
    async getTask() {
      return { ...taskDetail, latestRun: { ...currentRun } };
    },
    async controlRun(
      runId: string,
      action: "pause" | "resume" | "cancel",
      etag: string,
      reason: string
    ) {
      calls.push({ runId, action, etag, reason });
      const nextStatus = action === "pause"
        ? "paused"
        : action === "resume"
          ? "queued"
          : "cancelled";
      currentRun = {
        ...currentRun,
        status: nextStatus,
        etag: `"run-control-1:${calls.length + 2}"`
      };
      return { run: currentRun, etag: currentRun.etag };
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget,
    confirm: () => {
      confirmCalls += 1;
      return confirmCalls > 1;
    }
  });

  await controller.open("plan", "plan-1");
  await assert.rejects(() => controller.controlRun("pause", "  "), /理由/);
  assert.equal(calls.length, 0);
  await controller.controlRun("pause", " 人工检查 ");
  assert.deepEqual(calls[0], {
    runId: "run-control-1",
    action: "pause",
    etag: '"run-control-1:2"',
    reason: "人工检查"
  });
  assert.equal(controller.getState().detail?.latestRun?.status, "paused");

  await controller.controlRun("resume", " 检查完成 ");
  assert.deepEqual(calls[1], {
    runId: "run-control-1",
    action: "resume",
    etag: '"run-control-1:3"',
    reason: "检查完成"
  });
  assert.equal(controller.getState().detail?.latestRun?.status, "queued");

  await controller.controlRun("cancel", " 不再继续 ");
  assert.equal(calls.length, 2);
  await controller.controlRun("cancel", " 不再继续 ");
  assert.deepEqual(calls[2], {
    runId: "run-control-1",
    action: "cancel",
    etag: '"run-control-1:4"',
    reason: "不再继续"
  });
  assert.equal(controller.getState().detail?.latestRun?.status, "cancelled");
  assert.deepEqual(refreshes.map((item) => item.action), [
    "pause",
    "resume",
    "cancel"
  ]);
  controller.destroy();
}

{
  const invalidCalls: string[] = [];
  const api = {
    async getTask(planId: string) {
      if (planId === "budget-plan") {
        return {
          ...taskDetail,
          plan: { ...taskDetail.plan, id: planId },
          latestRun: {
            id: "run-budget",
            status: "budget_exhausted",
            etag: '"run-budget:2"',
            updatedAt: "2026-08-07T12:00:00.000Z",
            completedAt: "2026-08-07T12:00:00.000Z",
            evidenceCount: 0,
            consumedBudget: {
              requests: 4,
              results: 0,
              amountMinor: 400,
              durationSeconds: 60
            }
          }
        };
      }
      return {
        ...taskDetail,
        plan: { ...taskDetail.plan, id: planId },
        latestRun: {
          id: "run-no-etag",
          status: "running",
          updatedAt: "2026-08-07T12:00:00.000Z",
          completedAt: null,
          evidenceCount: 0,
          consumedBudget: {
            requests: 1,
            results: 0,
            amountMinor: 0,
            durationSeconds: 1
          }
        }
      };
    },
    async createRun() {
      invalidCalls.push("start");
      throw new Error("不应调用");
    },
    async controlRun() {
      invalidCalls.push("control");
      throw new Error("不应调用");
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({ api });

  await controller.open("plan", "no-etag-plan");
  await assert.rejects(
    () => controller.controlRun("pause", "人工检查"),
    /ETag|刷新/
  );
  await assert.rejects(
    () => controller.controlRun("resume", "人工检查"),
    /只有已暂停/
  );
  await controller.open("plan", "budget-plan");
  await assert.rejects(
    () => controller.startRun("追加预算"),
    /预算|审批/
  );
  assert.deepEqual(invalidCalls, []);
  controller.destroy();
}

{
  const control = deferred<Record<string, unknown>>();
  const refreshes: Array<Record<string, unknown>> = [];
  const eventTarget = new EventTarget();
  eventTarget.addEventListener(
    "goodjob:acquisition-refresh-requested",
    (event) => refreshes.push(
      (event as CustomEvent<Record<string, unknown>>).detail
    )
  );
  const api = {
    async getTask(planId: string) {
      return {
        ...taskDetail,
        task: { ...taskDetail.task, planId },
        plan: { ...taskDetail.plan, id: planId },
        latestRun: {
          id: `run-${planId}`,
          status: "running",
          etag: `"run-${planId}:1"`,
          updatedAt: "2026-08-07T12:00:00.000Z",
          completedAt: null,
          evidenceCount: 0,
          consumedBudget: {
            requests: 1,
            results: 0,
            amountMinor: 0,
            durationSeconds: 1
          }
        }
      };
    },
    controlRun() {
      return control.promise;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({ api, eventTarget });

  await controller.open("plan", "plan-old");
  const staleControl = controller.controlRun("pause", "人工检查");
  controller.close();
  await controller.open("plan", "plan-new");
  control.resolve({
    run: { id: "run-plan-old", status: "paused" },
    etag: '"run-plan-old:2"'
  });
  await staleControl;

  assert.equal(controller.getState().detail?.plan.id, "plan-new");
  assert.equal(controller.getState().detail?.latestRun?.id, "run-plan-new");
  assert.deepEqual(refreshes, []);
  controller.destroy();
}

{
  const scheduler = new ManualPollScheduler();
  const refreshes: Array<Record<string, unknown>> = [];
  const eventTarget = new EventTarget();
  eventTarget.addEventListener(
    "goodjob:acquisition-refresh-requested",
    (event) => refreshes.push(
      (event as CustomEvent<Record<string, unknown>>).detail
    )
  );
  let taskReads = 0;
  const run = (status: "running" | "paused", evidenceCount: number) => ({
    id: "run-poll-1",
    status,
    etag: `"run-poll-1:${taskReads}"`,
    updatedAt: `2026-08-07T12:0${taskReads}:00.000Z`,
    completedAt: null,
    evidenceCount,
    consumedBudget: {
      requests: evidenceCount,
      results: evidenceCount,
      amountMinor: evidenceCount * 10,
      durationSeconds: evidenceCount * 2
    }
  });
  const detailForRead = () => {
    const status = taskReads >= 3 ? "paused" as const : "running" as const;
    const candidateEvents = taskReads === 1
      ? [{
          eventId: "event-poll-1",
          candidateId: "candidate-poll-1",
          candidate: { id: "candidate-poll-1", displayName: "首屏候选" }
        }]
      : [{
          eventId: "event-poll-1",
          candidateId: "candidate-poll-1",
          candidate: { id: "candidate-poll-1", displayName: "首屏候选 · 已更新" }
        }, {
          eventId: "event-poll-3",
          candidateId: "candidate-poll-3",
          candidate: { id: "candidate-poll-3", displayName: "轮询新增候选" }
        }];
    return {
      ...taskDetail,
      latestRun: run(status, taskReads),
      presentation: {
        candidateEvents,
        providers: [{
          shardId: "shard-poll-1",
          connectionId: "search-poll-1",
          providerId: "baidu_ai_search",
          status
        }],
        summary: { validOpportunities: candidateEvents.length },
        hasMore: true,
        nextAfter: "cursor-poll-1"
      }
    };
  };
  const api = {
    async getTask() {
      taskReads += 1;
      return detailForRead();
    },
    async getRunPresentation(runId: string, query: { after?: string }) {
      assert.equal(runId, "run-poll-1");
      assert.equal(query.after, "cursor-poll-1");
      return {
        run: run("running", 1),
        providers: [],
        summary: { validOpportunities: 2 },
        candidateEvents: [{
          eventId: "event-poll-2",
          candidateId: "candidate-poll-2",
          candidate: { id: "candidate-poll-2", displayName: "翻页候选" }
        }],
        hasMore: false,
        nextAfter: null
      };
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget,
    pollIntervalMs: 1_234,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.open("plan", "plan-1");
  assert.equal(scheduler.pendingCount(), 1);
  assert.equal(scheduler.nextDelay(), 1_234);
  await controller.loadMoreCandidates();
  assert.deepEqual(
    controller.getState().detail?.presentation?.candidateEvents.map(
      (event) => event.candidateId
    ),
    ["candidate-poll-1", "candidate-poll-2"]
  );

  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(controller.getState().detail?.latestRun?.evidenceCount, 2);
  assert.deepEqual(
    controller.getState().detail?.presentation?.candidateEvents.map(
      (event) => event.candidateId
    ),
    ["candidate-poll-1", "candidate-poll-2", "candidate-poll-3"]
  );
  assert.equal(
    controller.getState().detail?.presentation?.candidateEvents[0]?.candidate
      && (controller.getState().detail?.presentation?.candidateEvents[0]?.candidate as
        Record<string, unknown>).displayName,
    "首屏候选 · 已更新"
  );
  assert.equal(controller.getState().detail?.presentation?.hasMore, false);
  assert.equal(scheduler.pendingCount(), 1);
  assert.equal(refreshes.length, 1);

  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(controller.getState().detail?.latestRun?.status, "paused");
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(refreshes.length, 2);
  controller.destroy();
}

{
  const scheduler = new ManualPollScheduler();
  let presentationReads = 0;
  const liveRun = {
    id: "run-tail-poll",
    status: "succeeded" as const,
    etag: '"run-tail-poll:1"',
    updatedAt: "2026-08-07T12:00:00.000Z",
    completedAt: null,
    evidenceCount: 2,
    consumedBudget: {
      requests: 1,
      results: 2,
      amountMinor: 20,
      durationSeconds: 3
    }
  };
  const api = {
    async getTask() {
      return {
        ...taskDetail,
        latestRun: liveRun,
        presentation: {
          candidateEvents: [{
            eventId: "event-tail-1",
            candidateId: "candidate-tail-1"
          }],
          providers: [],
          summary: { validOpportunities: 1 },
          automationSteps: [{ id: "fetch_public_comment_samples", status: "running" }],
          commentSignals: [{ eventId: "comment-tail-1", text: "旧投影" }],
          hasMore: true,
          nextAfter: "cursor-tail-1"
        }
      };
    },
    async getRunPresentation(runId: string, query: { after?: string }) {
      presentationReads += 1;
      assert.equal(runId, "run-tail-poll");
      assert.equal(
        query.after,
        presentationReads === 1 ? "cursor-tail-1" : "cursor-tail-2"
      );
      return {
        run: liveRun,
        providers: [{
          shardId: "shard-tail-1",
          connectionId: "search-tail",
          providerId: "baidu_ai_search",
          status: "running"
        }],
        summary: { validOpportunities: presentationReads + 1 },
        automationSteps: [{
          id: "fetch_public_comment_samples",
          status: presentationReads === 1 ? "partial_success" : "succeeded"
        }],
        commentSignals: [{
          eventId: "comment-tail-1",
          text: presentationReads === 1 ? "已更新投影" : "最终投影"
        }],
        candidateEvents: [{
          eventId: `event-tail-${presentationReads + 1}`,
          candidateId: `candidate-tail-${presentationReads + 1}`
        }],
        hasMore: presentationReads === 1,
        nextAfter: presentationReads === 1
          ? "cursor-tail-2"
          : "cursor-tail-3"
      };
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.open("plan", "plan-1");
  assert.equal(scheduler.pendingCount(), 1);
  scheduler.runNext();
  await controller.whenIdle();

  assert.equal(presentationReads, 2);
  assert.deepEqual(
    controller.getState().detail?.presentation?.candidateEvents.map(
      (event) => event.candidateId
    ),
    ["candidate-tail-1", "candidate-tail-2", "candidate-tail-3"]
  );
  assert.equal(
    controller.getState().detail?.presentation?.nextAfter,
    "cursor-tail-3"
  );
  assert.equal(
    controller.getState().detail?.presentation?.summary?.validOpportunities,
    3
  );
  assert.deepEqual(controller.getState().detail?.presentation?.automationSteps, [{
    id: "fetch_public_comment_samples", status: "succeeded"
  }]);
  assert.deepEqual(controller.getState().detail?.presentation?.commentSignals, [{
    eventId: "comment-tail-1", text: "最终投影"
  }]);
  assert.equal(controller.getState().detail?.presentation?.hasMore, false);
  assert.equal(scheduler.pendingCount(), 0);
  controller.destroy();
}

{
  const scheduler = new ManualPollScheduler();
  const oldPoll = deferred<typeof taskDetail>();
  let oldReads = 0;
  const api = {
    getTask(planId: string) {
      if (planId === "plan-old") {
        oldReads += 1;
        if (oldReads > 1) return oldPoll.promise;
        return Promise.resolve({
          ...taskDetail,
          plan: { ...taskDetail.plan, id: planId },
          latestRun: {
            id: "run-old-poll",
            status: "running" as const,
            etag: '"run-old-poll:1"',
            updatedAt: "2026-08-07T12:00:00.000Z",
            completedAt: null,
            evidenceCount: 1,
            consumedBudget: {
              requests: 1,
              results: 1,
              amountMinor: 10,
              durationSeconds: 1
            }
          }
        });
      }
      return Promise.resolve({
        ...taskDetail,
        plan: { ...taskDetail.plan, id: planId },
        latestRun: null
      });
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.open("plan", "plan-old");
  scheduler.runNext();
  controller.close();
  await controller.open("plan", "plan-new");
  oldPoll.resolve({
    ...taskDetail,
    plan: { ...taskDetail.plan, id: "plan-old" }
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.getState().detail?.plan.id, "plan-new");
  assert.equal(controller.getState().detail?.latestRun, null);
  assert.equal(scheduler.pendingCount(), 0);
  controller.destroy();
}

// Catches background polling moving a manually advanced candidate cursor back
// to the first page while more pages still remain.
{
  const scheduler = new ManualPollScheduler();
  let taskReads = 0;
  const activeDetail = (status: "running" | "paused") => ({
    ...taskDetail,
    latestRun: {
      id: "run-pagination-poll",
      status,
      etag: `"run-pagination-poll:${taskReads}"`,
      updatedAt: `2026-08-07T13:0${taskReads}:00.000Z`,
      completedAt: null,
      evidenceCount: taskReads,
      consumedBudget: {
        requests: taskReads,
        results: taskReads,
        amountMinor: 0,
        durationSeconds: taskReads
      }
    },
    presentation: {
      candidateEvents: [{
        eventId: "event-pagination-1",
        candidateId: "candidate-pagination-1",
        candidate: {
          id: "candidate-pagination-1",
          displayName: taskReads > 1 ? "第一页候选 · 已刷新" : "第一页候选"
        }
      }],
      providers: [],
      summary: { validOpportunities: 3 },
      hasMore: true,
      nextAfter: "cursor-first-page"
    }
  });
  const api = {
    async getTask() {
      taskReads += 1;
      return activeDetail(taskReads > 1 ? "paused" : "running");
    },
    async getRunPresentation() {
      return {
        run: activeDetail("running").latestRun,
        providers: [],
        summary: { validOpportunities: 3 },
        candidateEvents: [{
          eventId: "event-pagination-2",
          candidateId: "candidate-pagination-2",
          candidate: { id: "candidate-pagination-2", displayName: "第二页候选" }
        }],
        hasMore: true,
        nextAfter: "cursor-second-page"
      };
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.open("plan", "plan-1");
  await controller.loadMoreCandidates();
  assert.equal(
    controller.getState().detail?.presentation?.nextAfter,
    "cursor-second-page"
  );

  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(
    controller.getState().detail?.presentation?.nextAfter,
    "cursor-second-page"
  );
  assert.equal(controller.getState().detail?.presentation?.hasMore, false);
  assert.match(controller.getState().error ?? "", /分页游标未前进/);
  assert.equal(scheduler.pendingCount(), 0);
  assert.deepEqual(
    controller.getState().detail?.presentation?.candidateEvents.map(
      (event) => event.candidateId
    ),
    ["candidate-pagination-1", "candidate-pagination-2"]
  );
  controller.destroy();
}

// Catches a transient API failure causing tight-loop polling or erasing the
// last trustworthy run state.
{
  const scheduler = new ManualPollScheduler();
  const refreshes: Event[] = [];
  const eventTarget = new EventTarget();
  eventTarget.addEventListener(
    "goodjob:acquisition-refresh-requested",
    (event) => refreshes.push(event)
  );
  let taskReads = 0;
  const runningDetail = {
    ...taskDetail,
    latestRun: {
      id: "run-retry-poll",
      status: "running" as const,
      etag: '"run-retry-poll:1"',
      updatedAt: "2026-08-07T14:00:00.000Z",
      completedAt: null,
      evidenceCount: 1,
      consumedBudget: {
        requests: 1,
        results: 1,
        amountMinor: 0,
        durationSeconds: 1
      }
    }
  };
  const api = {
    async getTask() {
      taskReads += 1;
      if (taskReads === 2) throw new Error("temporary upstream failure");
      if (taskReads === 3) {
        return {
          ...runningDetail,
          latestRun: {
            ...runningDetail.latestRun,
            status: "paused" as const,
            etag: '"run-retry-poll:2"',
            updatedAt: "2026-08-07T14:01:00.000Z"
          }
        };
      }
      return runningDetail;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget,
    pollIntervalMs: 400,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.open("plan", "plan-1");
  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(controller.getState().detail?.latestRun?.status, "running");
  assert.equal(controller.getState().error, null);
  assert.equal(refreshes.length, 0);
  assert.equal(scheduler.pendingCount(), 1);
  assert.equal(scheduler.nextDelay(), 800);

  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(controller.getState().detail?.latestRun?.status, "paused");
  assert.equal(scheduler.pendingCount(), 0);
  assert.equal(refreshes.length, 1);
  controller.destroy();
}

// Catches a presentation-tail failure being treated as a fully successful
// poll, which would otherwise hammer a terminal backlog at the base interval.
{
  const scheduler = new ManualPollScheduler();
  const runningDetail = {
    ...taskDetail,
    latestRun: {
      id: "run-tail-retry",
      status: "running" as const,
      etag: '"run-tail-retry:1"',
      updatedAt: "2026-08-07T14:30:00.000Z",
      completedAt: null,
      evidenceCount: 1,
      consumedBudget: {
        requests: 1,
        results: 1,
        amountMinor: 0,
        durationSeconds: 1
      }
    },
    presentation: {
      candidateEvents: [{
        eventId: "event-tail-retry",
        candidateId: "candidate-tail-retry"
      }],
      providers: [],
      summary: { validOpportunities: 1 },
      hasMore: true,
      nextAfter: "cursor-tail-retry"
    }
  };
  const api = {
    async getTask() {
      return runningDetail;
    },
    async getRunPresentation() {
      throw new Error("temporary presentation failure");
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    pollIntervalMs: 400,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.open("plan", "plan-1");
  scheduler.runNext();
  await controller.whenIdle();

  assert.equal(controller.getState().detail?.presentation?.hasMore, true);
  assert.equal(controller.getState().error, null);
  assert.equal(scheduler.pendingCount(), 1);
  assert.equal(scheduler.nextDelay(), 800);
  controller.destroy();
}

// Catches a late manual page response rolling back a cursor already advanced
// by the automatic presentation tail.
{
  const scheduler = new ManualPollScheduler();
  const manualPage = deferred<Record<string, unknown>>();
  let presentationReads = 0;
  const run = {
    id: "run-page-race",
    status: "running" as const,
    etag: '"run-page-race:1"',
    updatedAt: "2026-08-07T14:40:00.000Z",
    completedAt: null,
    evidenceCount: 3,
    consumedBudget: {
      requests: 1,
      results: 3,
      amountMinor: 0,
      durationSeconds: 2
    }
  };
  const task = {
    ...taskDetail,
    latestRun: run,
    presentation: {
      candidateEvents: [{
        eventId: "event-page-race-1",
        candidateId: "candidate-page-race-1"
      }],
      providers: [],
      summary: { validOpportunities: 1 },
      hasMore: true,
      nextAfter: "cursor-page-race-1"
    }
  };
  const page = (number: 2 | 3) => ({
    run,
    providers: [],
    summary: { validOpportunities: number },
    candidateEvents: [{
      eventId: `event-page-race-${number}`,
      candidateId: `candidate-page-race-${number}`
    }],
    hasMore: number === 2,
    nextAfter: `cursor-page-race-${number}`
  });
  const api = {
    async getTask() {
      return task;
    },
    getRunPresentation(_runId: string, query: { after?: string }) {
      presentationReads += 1;
      if (presentationReads === 1) return manualPage.promise;
      if (presentationReads === 2) {
        assert.equal(query.after, "cursor-page-race-1");
        return Promise.resolve(page(2));
      }
      assert.equal(query.after, "cursor-page-race-2");
      return Promise.resolve(page(3));
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.open("plan", "plan-1");
  const manualRequest = controller.loadMoreCandidates();
  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(
    controller.getState().detail?.presentation?.nextAfter,
    "cursor-page-race-3"
  );

  manualPage.resolve(page(2));
  await manualRequest;

  assert.equal(controller.getState().loadingMoreCandidates, false);
  assert.equal(
    controller.getState().detail?.presentation?.nextAfter,
    "cursor-page-race-3"
  );
  assert.deepEqual(
    controller.getState().detail?.presentation?.candidateEvents.map(
      (event) => event.candidateId
    ),
    [
      "candidate-page-race-1",
      "candidate-page-race-2",
      "candidate-page-race-3"
    ]
  );
  controller.destroy();
}

{
  const eventTarget = new EventTarget();
  const candidateLoads: string[] = [];
  const api = {
    async getTask() {
      return taskDetailWithCandidateSource("candidate-import-1");
    },
    async getCandidate(candidateId: string) {
      candidateLoads.push(candidateId);
      return {
        candidate: {
          id: candidateId,
          displayName: "用户导入候选",
          identityResolved: false
        },
        evidence: [],
        reviews: [],
        research: null,
        qualification: null,
        financialValue: null,
        battleCard: null,
        intelligenceOperation: null,
        privateDomainHandoff: null,
        etag: '"candidate-v1"'
      };
    },
    getCandidateEvidence() {
      return Promise.resolve({ items: [], nextCursor: null });
    },
    getCandidateReviews() {
      return Promise.resolve({ items: [], nextCursor: null });
    },
    getCandidateQualification() {
      return Promise.resolve(null);
    },
    getCandidateFinancialValue() {
      return Promise.resolve(null);
    },
    getCandidateBattleCard() {
      return Promise.resolve(null);
    },
    getLatestIntelligenceOperation() {
      return Promise.resolve(null);
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    eventTarget
  });

  eventTarget.dispatchEvent(new CustomEvent(
    "goodjob:acquisition-detail-open-requested",
    {
      detail: {
        mode: "candidates",
        planId: "plan-1",
        candidateId: "candidate-import-1"
      }
    }
  ));
  await controller.whenIdle();

  assert.deepEqual(candidateLoads, ["candidate-import-1"]);
  assert.equal(controller.getState().selectedCandidateId, "candidate-import-1");
  controller.destroy();
}

// Catches a page request from the previous run leaving the candidate pane
// permanently busy after polling discovers a newer run.
{
  const scheduler = new ManualPollScheduler();
  const oldPage = deferred<Record<string, unknown>>();
  let taskReads = 0;
  const runDetail = (runId: string, candidateId: string) => ({
    ...taskDetail,
    latestRun: {
      id: runId,
      status: "running" as const,
      etag: `"${runId}:1"`,
      updatedAt: `2026-08-07T15:0${taskReads}:00.000Z`,
      completedAt: null,
      evidenceCount: taskReads,
      consumedBudget: {
        requests: taskReads,
        results: taskReads,
        amountMinor: 0,
        durationSeconds: taskReads
      }
    },
    presentation: {
      candidateEvents: [{
        eventId: `event-${candidateId}`,
        candidateId,
        candidate: { id: candidateId, displayName: candidateId }
      }],
      providers: [],
      summary: { validOpportunities: 1 },
      hasMore: runId === "run-page-old",
      nextAfter: runId === "run-page-old" ? "cursor-page-old" : null
    }
  });
  const api = {
    async getTask() {
      taskReads += 1;
      return taskReads === 1
        ? runDetail("run-page-old", "candidate-page-old")
        : runDetail("run-page-new", "candidate-page-new");
    },
    getRunPresentation() {
      return oldPage.promise;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    schedulePoll: scheduler.schedule,
    cancelPoll: scheduler.cancel
  });

  await controller.open("plan", "plan-1");
  const stalePageRequest = controller.loadMoreCandidates();
  assert.equal(controller.getState().loadingMoreCandidates, true);
  scheduler.runNext();
  await controller.whenIdle();
  assert.equal(controller.getState().detail?.latestRun?.id, "run-page-new");

  oldPage.resolve({
    run: runDetail("run-page-old", "candidate-page-old").latestRun,
    providers: [],
    summary: { validOpportunities: 2 },
    candidateEvents: [{
      eventId: "event-stale-page",
      candidateId: "candidate-stale-page",
      candidate: { id: "candidate-stale-page", displayName: "旧运行翻页结果" }
    }],
    hasMore: false,
    nextAfter: null
  });
  await stalePageRequest;

  assert.equal(controller.getState().loadingMoreCandidates, false);
  assert.deepEqual(
    controller.getState().detail?.presentation?.candidateEvents.map(
      (event) => event.candidateId
    ),
    ["candidate-page-new"]
  );
  controller.destroy();
}

class FakeVisualReaderController implements VisualReaderController {
  readonly openContexts: VisualReaderOpenContext[] = [];
  readonly reconciled: Array<AuthorizedVisualReaderProjection | undefined> = [];
  authorizeCalls = 0;
  stopCalls = 0;
  probeCalls = 0;
  closeCalls = 0;
  destroyCalls = 0;
  artifactValues: boolean[] = [];
  private listener: ((state: Readonly<VisualReaderControlState>) => void) | null = null;
  private state: VisualReaderControlState = {
    extensionStatus: "ready",
    extensionVersion: "1.0.0",
    artifactUploadEnabled: true,
    busy: false,
    session: null,
    projection: null,
    message: null,
    error: null
  };

  getState() { return this.state; }
  subscribe(listener: (state: Readonly<VisualReaderControlState>) => void) {
    this.listener = listener;
    listener(this.state);
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }
  whenIdle() { return Promise.resolve(); }
  async open(context: VisualReaderOpenContext) { this.openContexts.push(context); }
  async reconcile(value?: AuthorizedVisualReaderProjection) { this.reconciled.push(value); }
  setArtifactUploadEnabled(value: boolean) {
    this.artifactValues.push(value);
    this.state = { ...this.state, artifactUploadEnabled: value };
    this.listener?.(this.state);
  }
  async authorize() { this.authorizeCalls += 1; }
  async stop() { this.stopCalls += 1; }
  retryProbe() { this.probeCalls += 1; }
  close() { this.closeCalls += 1; }
  destroy() { this.destroyCalls += 1; }
  emit(overrides: Partial<VisualReaderControlState>) {
    this.state = { ...this.state, ...overrides };
    this.listener?.(this.state);
  }
}

function visualEvidence(
  kind: "authorized_visual_observation" | "search_result" = "authorized_visual_observation",
  artifactId: string | null = "artifact-authorized"
) {
  return {
    id: `evidence-${kind}-${artifactId ?? "none"}`,
    sourceTitle: "已授权可见评论观察",
    sourcePlatform: "douyin",
    sourceSnippet: "仅用于 controller 制品生命周期测试",
    fetchedAt: "2026-08-16T08:00:00.000Z",
    rawArtifactHash: `sha256:${"7".repeat(64)}`,
    provenance: kind === "authorized_visual_observation" ? {
      kind,
      sourceUrl: "https://www.douyin.com/video/7480000000000000000",
      observationId: `visual-observation:${"9".repeat(64)}`,
      sessionId: "visual-session-controller-test",
      extractionMethod: "ocr",
      visibleTextConfidence: 0.96,
      coverage: "authorized_visible_top_level_sample",
      artifactId,
      domTextHash: `sha256:${"2".repeat(64)}`,
      ocrTextHash: `sha256:${"3".repeat(64)}`
    } : {
      kind,
      provider: "fixture",
      queryText: "fixture",
      sourceUrl: "https://example.test/public",
      resultRank: 1
    }
  };
}

function visualCandidateApi(evidence: unknown[]): AcquisitionDetailApi {
  return {
    async getCandidate(candidateId: string) {
      return {
        candidate: {
          id: candidateId,
          subjectKind: "individual",
          sourcePlatform: "douyin",
          status: "needs_research",
          identityResolved: false,
          version: 1
        },
        etag: null
      };
    },
    async getCandidateEvidence() { return { items: evidence, nextCursor: null }; },
    async getCandidateQualification() { return null; },
    async getCandidateFinancialValue() { return null; },
    async getCandidateBattleCard() { return null; },
    async getCandidateReviews() { return { items: [], nextCursor: null }; },
    async getLatestDouyinIdentityResolutionOperation() { return null; },
    async getLatestIntelligenceOperation() { return null; },
    async getCandidatePrivateDomainHandoff() { return null; }
  } as unknown as AcquisitionDetailApi;
}

function artifactAction(action: string, artifactId?: string) {
  return fakeAction({
    acquisitionDetailAction: action,
    ...(artifactId ? { artifactId } : {})
  });
}

{
  const projection: AuthorizedVisualReaderProjection = {
    sessionId: "visual-session-1",
    coverage: "authorized_visible_top_level_sample",
    status: "collecting",
    usage: {
      videoCount: 1,
      observationCount: 2,
      scrollCount: 1,
      ocrCallCount: 0,
      domObservationCount: 2,
      accessibilityObservationCount: 0,
      ocrObservationCount: 0,
      lowConfidenceObservationCount: 0,
      artifactCount: 0
    },
    lastErrorCode: null,
    visualSteps: []
  };
  const detailWithVisualProjection = {
    ...taskDetail,
    latestRun: {
      id: "run-visual-1",
      status: "running" as const,
      etag: '"run-visual-1:1"',
      updatedAt: "2026-08-15T08:00:00.000Z",
      completedAt: null,
      evidenceCount: 0,
      consumedBudget: { requests: 0, results: 0, amountMinor: 0, durationSeconds: 0 }
    },
    presentation: {
      candidateEvents: [],
      providers: [],
      summary: {},
      authorizedVisualReader: projection
    }
  };
  const root = new FakeDialogRoot(null);
  const body = { innerHTML: "" } as HTMLElement;
  const visual = new FakeVisualReaderController();
  const api = {
    async getTask() {
      return detailWithVisualProjection;
    }
  } as unknown as AcquisitionDetailApi;
  const controller = createAcquisitionDetailCenterController({
    api,
    root: root as unknown as HTMLElement,
    body,
    visualReaderController: visual
  });

  await controller.open("plan", "plan-1");
  assert.deepEqual(visual.openContexts, [{
    planId: "plan-1",
    runId: "run-visual-1",
    projection
  }]);
  assert.equal(controller.getState().visualReader?.extensionStatus, "ready");
  assert.match(body.innerHTML, /data-acquisition-visual-reader/u);

  root.emitClick(fakeAction({ acquisitionDetailAction: "authorize-visual-reader" }));
  root.emitClick(fakeAction({ acquisitionDetailAction: "stop-visual-reader" }));
  root.emitClick(fakeAction({ acquisitionDetailAction: "retry-visual-reader-probe" }));
  await controller.whenIdle();
  assert.equal(visual.authorizeCalls, 1);
  assert.equal(visual.stopCalls, 1);
  assert.equal(visual.probeCalls, 1);

  root.emitChange({
    name: "visualReaderArtifactUpload",
    checked: false,
    matches(selector: string) {
      return selector === 'input[name="visualReaderArtifactUpload"]';
    }
  });
  assert.deepEqual(visual.artifactValues, [false]);
  assert.equal(controller.getState().visualReader?.artifactUploadEnabled, false);

  visual.emit({ message: "服务端会话已刷新" });
  assert.match(body.innerHTML, /服务端会话已刷新/u);
  controller.close();
  assert.equal(visual.closeCalls, 1);
  assert.equal(visual.stopCalls, 1, "closing the detail view does not stop the server session");
  controller.destroy();
  assert.equal(visual.destroyCalls, 1);
}

{
  const root = new FakeDialogRoot(null);
  const body = { innerHTML: "" } as HTMLElement;
  const visual = new FakeVisualReaderController();
  const gets: string[] = [];
  const created: Array<{ url: string; type: string }> = [];
  const revoked: string[] = [];
  const visualReaderApi = {
    async getArtifact(artifactId: string) {
      gets.push(artifactId);
      return { mediaType: "image/webp" as const, content: new Uint8Array([1, 2, 3]).buffer };
    }
  } as VisualReaderApi;
  const controller = createAcquisitionDetailCenterController({
    api: visualCandidateApi([
      visualEvidence("search_result", "artifact-search"),
      visualEvidence("authorized_visual_observation", null),
      visualEvidence("authorized_visual_observation", "artifact-authorized")
    ]),
    root: root as unknown as HTMLElement,
    body,
    visualReaderController: visual,
    visualReaderApi,
    artifactDecoder: async () => undefined,
    artifactObjectUrl: {
      createObjectURL(blob) {
        const url = `blob:controller-${created.length + 1}`;
        created.push({ url, type: blob.type });
        return url;
      },
      revokeObjectURL(url) { revoked.push(url); }
    }
  });

  await controller.openCandidate("candidate-artifact");
  assert.doesNotMatch(body.innerHTML, /data-artifact-id="artifact-search"/u);
  assert.doesNotMatch(body.innerHTML, /data-artifact-id="null"/u);
  assert.match(body.innerHTML, /data-artifact-id="artifact-authorized"/u);
  root.emitClick(artifactAction("view-visual-artifact", "artifact-search"));
  root.emitClick(artifactAction("view-visual-artifact", "artifact-other"));
  await controller.whenIdle();
  assert.deepEqual(gets, [], "only exact authorized visual provenance may fetch an artifact");

  root.emitClick(artifactAction("view-visual-artifact", "artifact-authorized"));
  await controller.whenIdle();
  assert.deepEqual(gets, ["artifact-authorized"]);
  assert.deepEqual(created, [{ url: "blob:controller-1", type: "image/webp" }]);
  assert.match(body.innerHTML, /src="blob:controller-1"/u);

  root.emitClick(artifactAction("view-visual-artifact", "artifact-authorized"));
  await controller.whenIdle();
  assert.deepEqual(revoked, ["blob:controller-1"], "replacement revokes the old object URL once");
  assert.match(body.innerHTML, /src="blob:controller-2"/u);
  root.emitClick(artifactAction("close-visual-artifact"));
  assert.deepEqual(revoked, ["blob:controller-1", "blob:controller-2"]);
  assert.doesNotMatch(body.innerHTML, /src="blob:controller-2"/u);

  root.emitClick(artifactAction("view-visual-artifact", "artifact-authorized"));
  await controller.whenIdle();
  controller.close();
  assert.deepEqual(revoked, [
    "blob:controller-1", "blob:controller-2", "blob:controller-3"
  ], "detail close revokes the active object URL exactly once");
  controller.destroy();
  assert.equal(revoked.filter((url) => url === "blob:controller-3").length, 1);
}

{
  const oldArtifact = deferred<{ mediaType: "image/webp"; content: ArrayBuffer }>();
  const replacementArtifact = deferred<{ mediaType: "image/webp"; content: ArrayBuffer }>();
  let call = 0;
  let decoderCalls = 0;
  const created: string[] = [];
  const revoked: string[] = [];
  const root = new FakeDialogRoot(null);
  const body = { innerHTML: "" } as HTMLElement;
  const controller = createAcquisitionDetailCenterController({
    api: visualCandidateApi([visualEvidence()]),
    root: root as unknown as HTMLElement,
    body,
    visualReaderController: new FakeVisualReaderController(),
    visualReaderApi: {
      getArtifact() {
        call += 1;
        return call === 1 ? oldArtifact.promise : replacementArtifact.promise;
      }
    } as unknown as VisualReaderApi,
    artifactDecoder: async () => {
      decoderCalls += 1;
    },
    artifactObjectUrl: {
      createObjectURL() {
        const url = `blob:late-${created.length + 1}`;
        created.push(url);
        return url;
      },
      revokeObjectURL(url) { revoked.push(url); }
    }
  });
  await controller.openCandidate("candidate-late-artifact");
  root.emitClick(artifactAction("view-visual-artifact", "artifact-authorized"));
  root.emitClick(artifactAction("view-visual-artifact", "artifact-authorized"));
  replacementArtifact.resolve({
    mediaType: "image/webp",
    content: new Uint8Array([2]).buffer
  });
  await Promise.resolve();
  oldArtifact.resolve({
    mediaType: "image/webp",
    content: new Uint8Array([1]).buffer
  });
  await controller.whenIdle();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(decoderCalls, 1, "a stale API response is rejected before decode");
  assert.match(body.innerHTML, /src="blob:late-1"/u);
  assert.deepEqual(created, ["blob:late-1"],
    "late superseded bytes are discarded after decode and before object URL creation");
  assert.deepEqual(revoked, []);

  const pendingReload = deferred<{ mediaType: "image/webp"; content: ArrayBuffer }>();
  const reloadRoot = new FakeDialogRoot(null);
  const reloadController = createAcquisitionDetailCenterController({
    api: visualCandidateApi([visualEvidence()]),
    root: reloadRoot as unknown as HTMLElement,
    body,
    visualReaderController: new FakeVisualReaderController(),
    visualReaderApi: { getArtifact: () => pendingReload.promise } as unknown as VisualReaderApi,
    artifactDecoder: async () => undefined,
    artifactObjectUrl: {
      createObjectURL() { created.push("blob:reload-late"); return "blob:reload-late"; },
      revokeObjectURL() { return; }
    }
  });
  await reloadController.openCandidate("candidate-reload");
  reloadRoot.emitClick(artifactAction("view-visual-artifact", "artifact-authorized"));
  const pending = reloadController.whenIdle();
  await reloadController.openCandidate("candidate-reload");
  pendingReload.resolve({ mediaType: "image/webp", content: new Uint8Array([3]).buffer });
  await pending;
  assert.equal(reloadController.getState().visualArtifact, null);
  assert.equal(created.length, 1,
    "reload reauthorizes before creating an object URL");
  reloadController.destroy();

  for (const disposal of ["close", "destroy"] as const) {
    const pendingDisposal = deferred<{ mediaType: "image/webp"; content: ArrayBuffer }>();
    const disposalRoot = new FakeDialogRoot(null);
    const disposalBody = { innerHTML: "" } as HTMLElement;
    const disposalController = createAcquisitionDetailCenterController({
      api: visualCandidateApi([visualEvidence()]),
      root: disposalRoot as unknown as HTMLElement,
      body: disposalBody,
      visualReaderController: new FakeVisualReaderController(),
      visualReaderApi: { getArtifact: () => pendingDisposal.promise } as unknown as VisualReaderApi,
      artifactDecoder: async () => undefined,
      artifactObjectUrl: {
        createObjectURL() {
          const url = `blob:${disposal}-late`;
          created.push(url);
          return url;
        },
        revokeObjectURL() { return; }
      }
    });
    await disposalController.openCandidate(`candidate-${disposal}`);
    disposalRoot.emitClick(artifactAction("view-visual-artifact", "artifact-authorized"));
    const disposalPending = disposalController.whenIdle();
    if (disposal === "close") disposalController.close();
    else disposalController.destroy();
    pendingDisposal.resolve({ mediaType: "image/webp", content: new Uint8Array([4]).buffer });
    await disposalPending;
    assert.equal(disposalController.getState().visualArtifact, null);
    assert.equal(created.length, 1,
      `late ${disposal} result cannot create an object URL or revive`);
    if (disposal === "close") disposalController.destroy();
  }

  controller.destroy();
  assert.equal(revoked.filter((url) => url === "blob:late-1").length, 1,
    "destroy revokes the surviving replacement URL exactly once");
}

{
  const firstDecode = deferred<void>();
  const secondDecode = deferred<void>();
  const firstDecodeStarted = deferred<void>();
  const secondDecodeStarted = deferred<void>();
  let decodeCall = 0;
  const created: string[] = [];
  const root = new FakeDialogRoot(null);
  const body = { innerHTML: "" } as HTMLElement;
  const controller = createAcquisitionDetailCenterController({
    api: visualCandidateApi([visualEvidence()]),
    root: root as unknown as HTMLElement,
    body,
    visualReaderController: new FakeVisualReaderController(),
    visualReaderApi: {
      async getArtifact() {
        return { mediaType: "image/webp", content: new Uint8Array([1]).buffer };
      }
    } as unknown as VisualReaderApi,
    artifactDecoder() {
      decodeCall += 1;
      if (decodeCall === 1) {
        firstDecodeStarted.resolve();
        return firstDecode.promise;
      }
      secondDecodeStarted.resolve();
      return secondDecode.promise;
    },
    artifactObjectUrl: {
      createObjectURL() {
        const url = `blob:decoder-${created.length + 1}`;
        created.push(url);
        return url;
      },
      revokeObjectURL() { return; }
    }
  });
  await controller.openCandidate("candidate-late-decoder");
  root.emitClick(artifactAction("view-visual-artifact", "artifact-authorized"));
  await firstDecodeStarted.promise;
  root.emitClick(artifactAction("view-visual-artifact", "artifact-authorized"));
  await secondDecodeStarted.promise;
  secondDecode.resolve();
  await controller.whenIdle();
  assert.deepEqual(created, ["blob:decoder-1"]);
  firstDecode.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(created, ["blob:decoder-1"],
    "a superseded decoder cannot create or replace an object URL");

  const closingDecode = deferred<void>();
  const closingDecodeStarted = deferred<void>();
  const closingRoot = new FakeDialogRoot(null);
  const closingController = createAcquisitionDetailCenterController({
    api: visualCandidateApi([visualEvidence()]),
    root: closingRoot as unknown as HTMLElement,
    body,
    visualReaderController: new FakeVisualReaderController(),
    visualReaderApi: {
      async getArtifact() {
        return { mediaType: "image/webp", content: new Uint8Array([1]).buffer };
      }
    } as unknown as VisualReaderApi,
    artifactDecoder() {
      closingDecodeStarted.resolve();
      return closingDecode.promise;
    },
    artifactObjectUrl: {
      createObjectURL() { created.push("blob:closed-decoder"); return "blob:closed-decoder"; },
      revokeObjectURL() { return; }
    }
  });
  await closingController.openCandidate("candidate-closing-decoder");
  closingRoot.emitClick(artifactAction("view-visual-artifact", "artifact-authorized"));
  const closingIdle = closingController.whenIdle();
  await closingDecodeStarted.promise;
  closingController.close();
  closingDecode.resolve();
  await closingIdle;
  assert.doesNotMatch(created.join("\n"), /closed-decoder/u,
    "a decoder completing after close cannot create an object URL");
  closingController.destroy();
  controller.destroy();
}

{
  const root = new FakeDialogRoot(null);
  const body = { innerHTML: "" } as HTMLElement;
  const evidence = visualEvidence();
  const controller = createAcquisitionDetailCenterController({
    api: visualCandidateApi([evidence]),
    root: root as unknown as HTMLElement,
    body,
    visualReaderController: new FakeVisualReaderController(),
    visualReaderApi: {
      async getArtifact() {
        throw new VisualReaderApiError(
          "visual_reader_request_failed",
          "视觉读取制品请求失败（HTTP 404）",
          404
        );
      }
    } as unknown as VisualReaderApi,
    artifactObjectUrl: {
      createObjectURL() { throw new Error("404 must not create an object URL"); },
      revokeObjectURL() { throw new Error("404 has no object URL to revoke"); }
    }
  });
  await controller.openCandidate("candidate-expired-artifact");
  root.emitClick(artifactAction("view-visual-artifact", "artifact-authorized"));
  await controller.whenIdle();
  assert.match(body.innerHTML, /制品已到期，证据哈希仍保留/u);
  assert.match(body.innerHTML, new RegExp(String(evidence.id), "u"));
  assert.match(body.innerHTML, new RegExp(String(evidence.rawArtifactHash), "u"));
  controller.destroy();
}

{
  const root = new FakeDialogRoot(null);
  const body = { innerHTML: "" } as HTMLElement;
  let objectUrlCount = 0;
  const controller = createAcquisitionDetailCenterController({
    api: visualCandidateApi([visualEvidence()]),
    root: root as unknown as HTMLElement,
    body,
    visualReaderController: new FakeVisualReaderController(),
    visualReaderApi: {
      async getArtifact() {
        return { mediaType: "image/webp", content: new Uint8Array([1]).buffer };
      }
    } as unknown as VisualReaderApi,
    async artifactDecoder() {
      throw new Error("syntactically valid but undecodable WebP");
    },
    artifactObjectUrl: {
      createObjectURL() { objectUrlCount += 1; return "blob:must-not-exist"; },
      revokeObjectURL() { throw new Error("an undecodable artifact has no URL to revoke"); }
    }
  });
  await controller.openCandidate("candidate-undecodable-artifact");
  root.emitClick(artifactAction("view-visual-artifact", "artifact-authorized"));
  await controller.whenIdle();
  assert.equal(objectUrlCount, 0, "decode must succeed before an object URL is created");
  assert.match(body.innerHTML, /遮挡裁剪暂不可用，证据哈希仍保留/u);
  assert.doesNotMatch(body.innerHTML, /blob:must-not-exist/u);
  controller.destroy();
}

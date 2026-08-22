import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  AcquisitionDouyinCommentIngestionService,
  classifyDouyinCommentIntent
} from "./acquisition-douyin-comment-ingestion.js";
import {
  AcquisitionDouyinCommentIngestionRecoverySweeper
} from "./acquisition-douyin-comment-ingestion-recovery-sweeper.js";
import {
  InMemoryAcquisitionDouyinCommentIngestionUnitOfWork
} from "./acquisition-douyin-comment-ingestion-unit-of-work.js";
import {
  InMemoryAcquisitionDouyinCommentEventRepository,
  type AcquisitionDouyinCommentEventRepository
} from "./acquisition-douyin-comment-events.js";
import {
  InMemoryAcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import { AcquisitionDomainService } from "./acquisition-domain-service.js";
import {
  AcquisitionIndividualSignalIngestionService,
  type AcquisitionIndividualSignalIngestionPort
} from "./acquisition-individual-signal-ingestion.js";
import {
  InMemoryAcquisitionCandidateDirectory
} from "./acquisition-tool-support-repositories.js";
import type {
  DouyinPublicComment,
  DouyinPublicCommentSamplePage
} from "./douyin-public-comment-provider.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import {
  createGrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";

const scopeA = { ownerId: "owner-a", teamId: "team-a", actorId: "worker-a" };
const scopeB = { ownerId: "owner-b", teamId: "team-a", actorId: "worker-b" };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class FirstDirectoryTransactionBarrier
extends InMemoryAcquisitionCandidateDirectory {
  readonly entered = deferred();
  readonly releaseFirst = deferred();
  private first = true;

  override transaction<T>(work: () => Promise<T>): Promise<T> {
    return super.transaction(async () => {
      if (this.first) {
        this.first = false;
        this.entered.resolve();
        await this.releaseFirst.promise;
      }
      return work();
    });
  }
}

class ArmableDomainTransactionTracker
extends InMemoryAcquisitionDomainRepository {
  readonly entered = deferred();
  private armed = false;

  arm() {
    this.armed = true;
  }

  override transaction<T>(work: () => Promise<T>): Promise<T> {
    return super.transaction(async () => {
      if (this.armed) this.entered.resolve();
      return work();
    });
  }
}

async function within<T>(promise: Promise<T>, milliseconds: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("LOCK_ORDER_TIMEOUT")),
          milliseconds);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function comment(
  commentId: string,
  text: string,
  actor: Partial<DouyinPublicComment["actor"]> = {}
): DouyinPublicComment {
  return {
    commentId,
    text,
    occurredAt: "2026-08-15T01:00:00.000Z",
    likeCount: 3,
    replyCount: 1,
    ipLabel: "上海",
    actor: {
      displayName: "公开用户",
      handle: null,
      secUid: null,
      ...actor
    }
  };
}

function page(
  comments: unknown[],
  overrides: Partial<DouyinPublicCommentSamplePage> = {}
): DouyinPublicCommentSamplePage {
  return {
    comments: comments as DouyinPublicComment[],
    nextCursor: null,
    hasMore: false,
    reportedCommentCount: comments.length,
    capturedAt: "2026-08-15T02:00:00.000Z",
    rawArtifactHash: `sha256:${"a".repeat(64)}`,
    providerId: "experimental_public_sample",
    providerVersion: "douyin-public-comment-provider-v1",
    coverage: "public_top_level_sample",
    metadata: {
      requestedCommentCount: 20,
      returnedCommentCount: comments.length,
      duplicateCommentCount: 0,
      partial: false,
      cursorProgressed: true
    },
    replyBodiesIncluded: false,
    ...overrides
  };
}

type FailureStage = "after_event" | "after_evidence" | "after_candidate";

function createHarness(options: {
  failOnceAt?: FailureStage;
  failCommitOnce?: boolean;
  candidateDirectory?: InMemoryAcquisitionCandidateDirectory;
  domainRepository?: InMemoryAcquisitionDomainRepository;
} = {}) {
  let sequence = 0;
  const domainRepository = options.domainRepository
    ?? new InMemoryAcquisitionDomainRepository();
  const domain = new AcquisitionDomainService({
    repository: domainRepository,
    leadConversionPort: {
      async createLead() {
        throw new Error("not used");
      }
    },
    growthAcquisitionWorkspace: createGrowthAcquisitionWorkspaceResolver({
      async resolve(input) {
        return {
          workspaceId: input.teamId,
          kind: "team" as const,
          bindingRevision: `binding:${input.ownerId}:${input.teamId}`
        };
      }
    }),
    growthTemporalBarrier: new DefaultGrowthTemporalBarrier(
      new InMemoryGrowthTemporalTransactionRunner()
    ),
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    now: () => "2026-08-15T02:01:00.000Z"
  });
  const eventRepository =
    new InMemoryAcquisitionDouyinCommentEventRepository();
  const candidateDirectory = options.candidateDirectory
    ?? new InMemoryAcquisitionCandidateDirectory({
      now: () => "2026-08-15T02:01:00.000Z"
    });
  const individualSignalIngestion =
    new AcquisitionIndividualSignalIngestionService({
      domain,
      candidateDirectory
    });
  const unitOfWork =
    new InMemoryAcquisitionDouyinCommentIngestionUnitOfWork(
      domainRepository,
      eventRepository,
      candidateDirectory
    );
  const mutationCounts = {
    eventAppends: 0,
    evidenceAppends: 0,
    signalIngestions: 0,
    links: 0
  };
  let failureConsumed = false;
  const shouldFail = (stage: FailureStage) => {
    if (failureConsumed || options.failOnceAt !== stage) return false;
    failureConsumed = true;
    return true;
  };
  const eventPort = new Proxy(eventRepository, {
    get(target, property, receiver) {
      if (property === "appendObservation") {
        return async (...args: Parameters<typeof target.appendObservation>) => {
          mutationCounts.eventAppends += 1;
          return target.appendObservation(...args);
        };
      }
      if (property === "commitIngestionSaga") {
        return async (...args: Parameters<typeof target.commitIngestionSaga>) => {
          mutationCounts.links += 1;
          const result = await target.commitIngestionSaga(...args);
          if (options.failCommitOnce && !failureConsumed) {
            failureConsumed = true;
            throw new Error("FAIL_COMMIT_INGESTION_SAGA");
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as AcquisitionDouyinCommentEventRepository;
  const domainPort = new Proxy(domain, {
    get(target, property, receiver) {
      if (property === "appendEvidence") {
        return async (...args: Parameters<typeof target.appendEvidence>) => {
          mutationCounts.evidenceAppends += 1;
          return target.appendEvidence(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as AcquisitionDomainService;
  const individualSignalPort: AcquisitionIndividualSignalIngestionPort = {
    async ingest(signalInput) {
      mutationCounts.signalIngestions += 1;
      return individualSignalIngestion.ingest(signalInput);
    }
  };
  const service = new AcquisitionDouyinCommentIngestionService({
    events: eventPort,
    domain: domainPort,
    individualSignals: individualSignalPort,
    unitOfWork,
    failureInjector: async (stage) => {
      if (shouldFail(stage)) {
        throw new Error(`FAIL_${stage.toLocaleUpperCase("en-US")}`);
      }
    }
  });
  const restartService = () => new AcquisitionDouyinCommentIngestionService({
    events: eventRepository,
    domain,
    individualSignals: individualSignalIngestion,
    unitOfWork,
    now: () => "2026-08-15T02:01:00.000Z"
  });
  return {
    service,
    domain,
    domainRepository,
    eventRepository,
    candidateDirectory,
    individualSignalIngestion,
    unitOfWork,
    mutationCounts,
    restartService
  };
}

function input(
  samplePage: DouyinPublicCommentSamplePage,
  overrides: Record<string, unknown> = {}
) {
  return {
    scope: scopeA,
    runId: "run-1",
    shardId: "shard-1",
    discoveryOperationId: "operation-1",
    sourceUrl: "https://www.douyin.com/video/7536012345678909876",
    videoId: "7536012345678909876",
    page: samplePage,
    ...overrides
  } as Parameters<AcquisitionDouyinCommentIngestionService["ingestSample"]>[0];
}

test("classifier golden rules are deterministic, bounded, and negative-first", () => {
  const golden = [
    ["想咨询一下你们的解决方案", "potential_signal", "solution_research"],
    ["预算 10 万，需要采购 200 套，请报价", "strong_signal", "purchase_ready"],
    ["正在找供应商，这周就要采购", "strong_signal", "purchase_ready"],
    ["想加盟合作，可以先试用吗", "strong_signal", "comparison"],
    ["项目下周急着上线，交付周期多久", "strong_signal", "purchase_ready"],
    ["获客成本太高，正在找解决方案", "potential_signal", "solution_research"],
    ["不需要，请勿联系，多少钱", "negative", "awareness"],
    ["😀！！！", "noise", "awareness"],
    ["点赞关注抽奖送好礼", "noise", "awareness"],
    ["好好好好好好好好", "noise", "awareness"],
    ["多少钱", "potential_signal", "comparison"]
  ] as const;

  for (const [text, band, buyingStage] of golden) {
    const first = classifyDouyinCommentIntent(text);
    const replay = classifyDouyinCommentIntent(text);
    assert.deepEqual(first, replay, text);
    assert.equal(first.band, band, text);
    assert.equal(first.buyingStage, buyingStage, text);
    assert.equal(Number.isFinite(first.confidence), true, text);
    assert.equal(first.confidence >= 0 && first.confidence <= 1, true, text);
    assert.equal(first.positiveSignals.length <= 12, true, text);
    assert.equal(first.negativeSignals.length <= 12, true, text);
    assert.equal(first.reasons.length <= 12, true, text);
    assert.equal(new Set(first.reasons).size, first.reasons.length, text);
  }
});

test("secUid aggregation crosses videos, separates actors, and stays tenant isolated", async () => {
  const harness = createHarness();
  const first = await harness.service.ingestSample(input(page([
    comment("cid-1", "预算 10 万，采购 20 套，请报价", {
      secUid: "MS4wLjABAAAA_actor-1"
    })
  ])));
  const replayActor = await harness.service.ingestSample(input(page([
    comment("cid-2", "项目下周上线，交付多久", {
      secUid: "MS4wLjABAAAA_actor-1"
    })
  ], { rawArtifactHash: `sha256:${"b".repeat(64)}` }), {
    runId: "run-2",
    sourceUrl: "https://www.douyin.com/video/7536012345678909999",
    videoId: "7536012345678909999"
  }));
  const different = await harness.service.ingestSample(input(page([
    comment("cid-3", "想咨询解决方案", {
      secUid: "MS4wLjABAAAA_actor-2"
    })
  ], { rawArtifactHash: `sha256:${"c".repeat(64)}` })));
  const otherTenant = await harness.service.ingestSample(input(page([
    comment("cid-4", "想咨询解决方案", {
      secUid: "MS4wLjABAAAA_actor-1"
    })
  ], { rawArtifactHash: `sha256:${"d".repeat(64)}` }), {
    scope: scopeB,
    runId: "run-b"
  }));

  assert.deepEqual(replayActor.candidateIds, first.candidateIds);
  assert.notDeepEqual(different.candidateIds, first.candidateIds);
  assert.notDeepEqual(otherTenant.candidateIds, first.candidateIds);
  assert.equal(first.unresolvedActorCount, 1);
  assert.equal(replayActor.unresolvedActorCount, 1);
});

test("same secUid merges later strong and rejection signals without downgrading stage", async () => {
  const harness = createHarness();
  const potential = await harness.service.ingestSample(input(page([
    comment("cid-merge-1", "想咨询一下解决方案", {
      secUid: "MS4wLjABAAAA_merge-actor"
    })
  ])));
  const strong = await harness.service.ingestSample(input(page([
    comment("cid-merge-2", "预算 10 万，采购 20 套，请报价", {
      secUid: "MS4wLjABAAAA_merge-actor"
    })
  ], { rawArtifactHash: `sha256:${"b".repeat(64)}` }), {
    sourceUrl: "https://www.douyin.com/video/7536012345678909999",
    videoId: "7536012345678909999"
  }));
  const negativePage = page([
    comment("cid-merge-3", "不需要，请勿联系", {
      secUid: "MS4wLjABAAAA_merge-actor"
    })
  ], { rawArtifactHash: `sha256:${"c".repeat(64)}` });
  const negative = await harness.service.ingestSample(input(negativePage));
  const beforeReplay = await harness.domain.getCandidate(
    scopeA,
    potential.candidateIds[0]!
  );
  const replay = await harness.service.ingestSample(input(negativePage));
  const afterReplay = await harness.domain.getCandidate(
    scopeA,
    potential.candidateIds[0]!
  );

  assert.deepEqual(strong.candidateIds, potential.candidateIds);
  assert.deepEqual(negative.candidateIds, potential.candidateIds);
  assert.deepEqual(replay.candidateIds, potential.candidateIds);
  assert.equal(beforeReplay.profile.kind, "individual");
  assert.equal(afterReplay.profile.kind, "individual");
  if (beforeReplay.profile.kind !== "individual"
    || afterReplay.profile.kind !== "individual") return;
  assert.equal(beforeReplay.profile.buyingStage, "purchase_ready");
  assert.deepEqual(beforeReplay.profile.negativeSignals, [
    "explicit_rejection", "no_contact"
  ]);
  assert.match(beforeReplay.profile.demandSummary, /想咨询一下解决方案/u);
  assert.match(beforeReplay.profile.demandSummary, /预算 10 万/u);
  assert.match(beforeReplay.profile.demandSummary, /请勿联系/u);
  assert.equal(beforeReplay.evidenceIds.length, 3);
  assert.equal(afterReplay.version, beforeReplay.version);
  assert.deepEqual(afterReplay, beforeReplay);
});

test("handle is temporary, never aliases secUid, and identity-less cid replay is safe", async () => {
  const harness = createHarness();
  const handle = await harness.service.ingestSample(input(page([
    comment("cid-handle-1", "想咨询解决方案", { handle: "Public_User" })
  ])));
  const handleAgain = await harness.service.ingestSample(input(page([
    comment("cid-handle-2", "多少钱", { handle: "public_user" })
  ], { rawArtifactHash: `sha256:${"b".repeat(64)}` }), {
    sourceUrl: "https://www.douyin.com/video/7536012345678909999",
    videoId: "7536012345678909999"
  }));
  const secUid = await harness.service.ingestSample(input(page([
    comment("cid-sec", "多少钱", { secUid: "public_user" })
  ], { rawArtifactHash: `sha256:${"c".repeat(64)}` })));
  const noIdentity = page([
    comment("cid-none-1", "想咨询"),
    comment("cid-none-2", "想咨询")
  ], { rawArtifactHash: `sha256:${"d".repeat(64)}` });
  const noIdentityResult = await harness.service.ingestSample(input(noIdentity));
  const exactReplay = await harness.service.ingestSample(input(page(
    noIdentity.comments,
    {
      capturedAt: "2026-08-15T03:00:00.000Z",
      rawArtifactHash: `sha256:${"e".repeat(64)}`
    }
  )));

  assert.deepEqual(handleAgain.candidateIds, handle.candidateIds);
  assert.notDeepEqual(secUid.candidateIds, handle.candidateIds);
  assert.equal(noIdentityResult.candidateIds.length, 2);
  assert.deepEqual(exactReplay.candidateIds, noIdentityResult.candidateIds);
  assert.equal((await harness.eventRepository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 50 }
  )).filter((item) => item.event.platformEventId.startsWith("cid-none-")).length, 2);
});

test("noise remains evidence, negative remains suppressive, and malformed neighbors are skipped", async () => {
  const harness = createHarness();
  const result = await harness.service.ingestSample(input(page([
    comment("cid-noise", "😀！！！"),
    comment("cid-negative", "不需要，请勿联系"),
    { ...comment("cid-empty", ""), text: "   " },
    null,
    {
      ...comment("cid-malformed-actor", "想咨询"),
      actor: { displayName: "用户", handle: null, secUid: 123 }
    },
    comment("cid-strong", "预算 10 万，采购 20 套，请报价")
  ])));

  assert.deepEqual(result, {
    eventCount: 3,
    evidenceCount: 3,
    candidateIds: result.candidateIds,
    unresolvedActorCount: 2,
    strongSignalCount: 1,
    invalidCommentCount: 3
  });
  assert.equal(result.candidateIds.length, 2);
  const signals = await harness.eventRepository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 50 }
  );
  assert.equal(signals.length, 3);
  assert.equal(signals.find((item) => item.event.platformEventId === "cid-noise")
    ?.link.candidateId, null);
  const negativeId = signals.find((item) =>
    item.event.platformEventId === "cid-negative")?.link.candidateId;
  assert.ok(negativeId);
  const negative = await harness.domain.getCandidate(scopeA, negativeId);
  assert.deepEqual(
    negative.profile.kind === "individual"
      ? negative.profile.negativeSignals
      : [],
    ["explicit_rejection", "no_contact"]
  );
});

test("event, observation, evidence, and link preserve exact public provenance", async () => {
  const harness = createHarness();
  const sample = page([
    comment("cid-provenance", "  预算 10 万，采购 20 套\n请报价  ", {
      displayName: "采购用户",
      handle: "buyer_01",
      secUid: "MS4wLjABAAAA_buyer-1"
    })
  ]);
  const result = await harness.service.ingestSample(input(sample));
  const [signal] = await harness.eventRepository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 50 }
  );

  assert.ok(signal);
  assert.equal(signal.event.platformEventId, "cid-provenance");
  assert.equal(signal.event.text, "  预算 10 万，采购 20 套\n请报价  ");
  assert.equal(signal.event.actor.secUid, "MS4wLjABAAAA_buyer-1");
  assert.equal(signal.latestObservation.observationId, signal.link.observationId);
  assert.equal(signal.link.candidateId, result.candidateIds[0]);
  assert.ok(signal.link.evidenceId);
  const evidence = await harness.domain.getEvidence(scopeA, signal.link.evidenceId);
  assert.deepEqual(evidence.provenance, {
    kind: "platform_public_event",
    sourceUrl: "https://www.douyin.com/video/7536012345678909876",
    platformEventId: "cid-provenance",
    providerVersion: "douyin-public-comment-provider-v1",
    coverage: "public_top_level_sample"
  });
  assert.equal(evidence.accessStatus, "public_content");
  assert.equal(evidence.contentHash, signal.event.textHash);
  assert.equal(evidence.rawArtifactHash, sample.rawArtifactHash);
  assert.equal(signal.latestObservation.rawArtifactHash, sample.rawArtifactHash);
  assert.equal(evidence.sourceSnippet, "  预算 10 万，采购 20 套\n请报价  ");
});

test("changed comment content forms one replay-safe version with the immutable actor", async () => {
  const harness = createHarness();
  const actorA = {
    displayName: "原始用户",
    handle: "original_user",
    secUid: "MS4wLjABAAAA_original-actor"
  };
  const original = await harness.service.ingestSample(input(page([
    comment("cid-versioned", "想咨询解决方案", actorA)
  ])));
  const firstProjection = (await harness.eventRepository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 50 }
  ))[0]!;
  const changed = await harness.service.ingestSample(input(page([
    comment("cid-versioned", "预算 10 万，采购 20 套，请报价", {
      displayName: "来源后来返回的其他昵称",
      handle: "other_user",
      secUid: "MS4wLjABAAAA_other-actor"
    })
  ], {
    capturedAt: "2026-08-15T03:00:00.000Z",
    rawArtifactHash: `sha256:${"b".repeat(64)}`
  })));
  const changedProjection = (await harness.eventRepository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 50 }
  ))[0]!;
  const replay = await harness.service.ingestSample(input(page([
    comment("cid-versioned", "预算 10 万，采购 20 套，请报价", {
      displayName: "第三次返回的昵称",
      handle: "third_user",
      secUid: "MS4wLjABAAAA_third-actor"
    })
  ], {
    capturedAt: "2026-08-15T04:00:00.000Z",
    rawArtifactHash: `sha256:${"c".repeat(64)}`
  })));
  const replayProjection = (await harness.eventRepository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 50 }
  ))[0]!;

  assert.deepEqual(changed.candidateIds, original.candidateIds);
  assert.deepEqual(replay.candidateIds, original.candidateIds);
  assert.equal(replayProjection.event.text, "想咨询解决方案");
  assert.deepEqual(replayProjection.event.actor, actorA);
  assert.notEqual(firstProjection.link.evidenceId, changedProjection.link.evidenceId);
  assert.equal(replayProjection.link.evidenceId, changedProjection.link.evidenceId);
  assert.equal(
    replayProjection.latestObservation.rawArtifactHash,
    `sha256:${"c".repeat(64)}`
  );
  assert.equal(
    replayProjection.latestObservation.observedTextHash,
    changedProjection.latestObservation.observedTextHash
  );
  const changedEvidence = await harness.domain.getEvidence(
    scopeA,
    changedProjection.link.evidenceId!
  );
  assert.equal(changedEvidence.sourceSnippet, "预算 10 万，采购 20 套，请报价");
  assert.equal(changedEvidence.rawArtifactHash, `sha256:${"b".repeat(64)}`);
  assert.notEqual(changedEvidence.rawArtifactHash, `sha256:${"c".repeat(64)}`);
  const candidate = await harness.domain.getCandidate(
    scopeA,
    original.candidateIds[0]!
  );
  assert.equal(candidate.profile.kind, "individual");
  if (candidate.profile.kind === "individual") {
    assert.equal(candidate.profile.publicActorKey,
      "douyin:sec_uid:MS4wLjABAAAA_original-actor");
  }
  assert.equal(candidate.evidenceIds.length, 2);
});

test("recovery completes every pending failure boundary without caller replay", async () => {
  for (const failOnceAt of [
    "after_event", "after_evidence", "after_candidate"
  ] as const) {
    const harness = createHarness({ failOnceAt });
    const sampleInput = input(page([
      comment(`cid-saga-${failOnceAt}`, "预算 10 万，采购 20 套，请报价", {
        secUid: `MS4wLjABAAAA_${failOnceAt}`
      })
    ]));

    await assert.rejects(
      harness.service.ingestSample(sampleInput),
      new RegExp(`FAIL_${failOnceAt.toLocaleUpperCase("en-US")}`)
    );
    assert.deepEqual(await harness.eventRepository.listRunCommentSignals(
      scopeA,
      "run-1",
      { limit: 50 }
    ), [], failOnceAt);
    assert.equal((await harness.domainRepository.listCandidates(
      scopeA,
      { limit: 100 }
    )).items.length, 0, failOnceAt);
    assert.equal((await harness.eventRepository.listPendingIngestionSagas({
      limit: 100
    })).length, 1, failOnceAt);

    const recoveredService = harness.restartService();
    const sweeper = new AcquisitionDouyinCommentIngestionRecoverySweeper({
      service: recoveredService,
      intervalMs: 60_000,
      setTimer() {
        return { unref() {} };
      },
      clearTimer() {}
    });
    await sweeper.start();
    await sweeper.close();
    const signals = await harness.eventRepository.listRunCommentSignals(
      scopeA,
      "run-1",
      { limit: 50 }
    );
    const candidates = await harness.domainRepository.listCandidates(
      scopeA,
      { limit: 100 }
    );

    assert.equal(signals.length, 1, failOnceAt);
    assert.equal(candidates.items.length, 1, failOnceAt);
    assert.deepEqual(candidates.items[0]?.evidenceIds, [
      signals[0]?.link.evidenceId
    ], failOnceAt);
    assert.deepEqual(await harness.eventRepository.getRunCommentSummary(
      scopeA,
      "run-1"
    ), {
      linkedEventCount: 1,
      observationCount: 1,
      fetchAttemptCount: 0,
      discoveredVideoCount: 0,
      returnedCommentCount: 0,
      validDemandSignalCount: 1,
      unresolvedActorCount: 0,
      strongSignalCount: 0
    }, failOnceAt);
    assert.equal((await harness.eventRepository.listPendingIngestionSagas({
      limit: 100
    })).length, 0, failOnceAt);
  }
});

test("after-candidate failure rolls an approved candidate back before recovery", async () => {
  const harness = createHarness();
  const initial = await harness.service.ingestSample(input(page([
    comment("cid-approved-base", "想咨询解决方案", {
      secUid: "MS4wLjABAAAA_approved-actor"
    })
  ])));
  const candidate = await harness.domain.getCandidate(
    scopeA,
    initial.candidateIds[0]!
  );
  const approved = {
    ...candidate,
    status: "approved" as const,
    latestDecisionId: "decision-approved",
    latestDecisionVersion: "decision-version-approved",
    approvedDecisionVersion: "decision-version-approved",
    version: candidate.version + 1
  };
  await harness.domainRepository.saveCandidate(approved);
  const beforeSignals = await harness.eventRepository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 50 }
  );

  // Reuse the real stores to model a later process handling the same actor.
  const failingService = new AcquisitionDouyinCommentIngestionService({
    events: harness.eventRepository,
    domain: harness.domain,
    individualSignals: new AcquisitionIndividualSignalIngestionService({
      domain: harness.domain,
      candidateDirectory: harness.candidateDirectory
    }),
    unitOfWork: harness.unitOfWork,
    failureInjector: async (stage) => {
      if (stage === "after_candidate") throw new Error("FAIL_AFTER_CANDIDATE");
    }
  });
  await assert.rejects(failingService.ingestSample(input(page([
    comment("cid-approved-new", "预算 10 万，采购 20 套，请报价", {
      secUid: "MS4wLjABAAAA_approved-actor"
    })
  ], { rawArtifactHash: `sha256:${"d".repeat(64)}` }))), /FAIL_AFTER_CANDIDATE/u);

  assert.deepEqual(await harness.domain.getCandidate(scopeA, approved.id), approved);
  assert.deepEqual(await harness.eventRepository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 50 }
  ), beforeSignals);

  const sweeper = new AcquisitionDouyinCommentIngestionRecoverySweeper({
    service: harness.restartService(),
    intervalMs: 60_000,
    setTimer() { return { unref() {} }; },
    clearTimer() {}
  });
  await sweeper.start();
  await sweeper.close();
  const recovered = await harness.domain.getCandidate(scopeA, approved.id);
  assert.equal(recovered.status, "pending_review");
  assert.equal(recovered.evidenceIds.length, 2);
});

test("commit-side failure rolls every domain and directory write back before restart recovery", async () => {
  const harness = createHarness();
  const initial = await harness.service.ingestSample(input(page([
    comment("cid-commit-base", "想咨询解决方案", {
      secUid: "MS4wLjABAAAA_commit-actor"
    })
  ])));
  const candidate = await harness.domain.getCandidate(
    scopeA,
    initial.candidateIds[0]!
  );
  const approved = {
    ...candidate,
    status: "approved" as const,
    latestDecisionId: "decision-commit-approved",
    latestDecisionVersion: "decision-version-commit-approved",
    approvedDecisionVersion: "decision-version-commit-approved",
    version: candidate.version + 1
  };
  await harness.domainRepository.saveCandidate(approved);
  const auditsBefore = await harness.domainRepository.listAuditEvents(
    scopeA,
    approved.id
  );
  const signalsBefore = await harness.eventRepository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 50 }
  );
  let failed = false;
  const commitFailingEvents = new Proxy(harness.eventRepository, {
    get(target, property, receiver) {
      if (property === "commitIngestionSaga") {
        return async (...args: Parameters<typeof target.commitIngestionSaga>) => {
          const result = await target.commitIngestionSaga(...args);
          if (!failed) {
            failed = true;
            throw new Error("FAIL_REAL_COMMIT_SIDE");
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as AcquisitionDouyinCommentEventRepository;
  const service = new AcquisitionDouyinCommentIngestionService({
    events: commitFailingEvents,
    domain: harness.domain,
    individualSignals: new AcquisitionIndividualSignalIngestionService({
      domain: harness.domain,
      candidateDirectory: harness.candidateDirectory
    }),
    unitOfWork: harness.unitOfWork
  });

  await assert.rejects(service.ingestSample(input(page([
    comment("cid-commit-new", "预算 10 万，采购 20 套，请报价", {
      secUid: "MS4wLjABAAAA_commit-actor"
    })
  ], { rawArtifactHash: `sha256:${"e".repeat(64)}` }))), /FAIL_REAL_COMMIT_SIDE/u);

  assert.deepEqual(await harness.domain.getCandidate(scopeA, approved.id), approved);
  assert.deepEqual(
    await harness.domainRepository.listAuditEvents(scopeA, approved.id),
    auditsBefore
  );
  assert.deepEqual(await harness.eventRepository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 50 }
  ), signalsBefore);
  assert.equal((await harness.eventRepository.listPendingIngestionSagas({
    limit: 100
  })).length, 1);

  const sweeper = new AcquisitionDouyinCommentIngestionRecoverySweeper({
    service: harness.restartService(),
    intervalMs: 60_000,
    setTimer() { return { unref() {} }; },
    clearTimer() {}
  });
  await sweeper.start();
  await sweeper.close();
  const recovered = await harness.domain.getCandidate(scopeA, approved.id);
  assert.equal(recovered.status, "pending_review");
  assert.equal(recovered.evidenceIds.length, 2);
});

test("standalone individual ingestion and comment UoW share one finite memory lock order", async () => {
  const candidateDirectory = new FirstDirectoryTransactionBarrier({
    now: () => "2026-08-15T02:01:00.000Z"
  });
  const domainRepository = new ArmableDomainTransactionTracker();
  const harness = createHarness({
    candidateDirectory,
    domainRepository,
    failOnceAt: "after_candidate"
  });
  const sourceUrl = "https://www.douyin.com/video/7536012345678909876";
  const standaloneEvidence = await harness.domain.appendEvidence(scopeA, {
    targetType: "individual_signal",
    sourcePlatform: "douyin",
    sourceTitle: "独立公开需求信号",
    sourceSnippet: "正在采购独立的一批设备",
    publishedAt: "2026-08-15T01:00:00.000Z",
    locale: "zh-CN",
    rawArtifactHash: `sha256:${"d".repeat(64)}`,
    contentHash: `sha256:${"e".repeat(64)}`,
    provenance: {
      kind: "platform_public_event",
      sourceUrl,
      platformEventId: "standalone-lock-order",
      providerVersion: "douyin-public-comment-provider-v1",
      coverage: "public_top_level_sample"
    },
    accessStatus: "public_content"
  }, "standalone-lock-order-evidence");
  const standalone = harness.individualSignalIngestion.ingest({
    scope: scopeA,
    provider: "experimental_public_sample",
    sourceUrl,
    sourceType: "video",
    subject: {
      publicActorKey:
        "douyin:sec_uid:MS4wLjABAAAA_lock-order-standalone",
      publicDisplayName: "独立公开用户",
      publicProfileUrl: sourceUrl,
      sourcePlatform: "douyin",
      demandCategory: "独立需求",
      demandSummary: "正在采购独立的一批设备",
      locationHint: "上海",
      buyingStage: "purchase_ready",
      negativeSignals: []
    },
    evidence: standaloneEvidence,
    idempotencyKey: "standalone-lock-order"
  });
  await candidateDirectory.entered.promise;
  domainRepository.arm();

  const commentIngestion = harness.service.ingestSample(input(page([
    comment("cid-lock-order-comment", "预算 10 万，采购 20 套，请报价", {
      secUid: "MS4wLjABAAAA_lock-order-comment"
    })
  ])));
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await harness.eventRepository.listPendingIngestionSagas({ limit: 10 }))
      .length > 0) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const domainEnteredBeforeDirectoryRelease = await Promise.race([
    domainRepository.entered.promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 25))
  ]);
  candidateDirectory.releaseFirst.resolve();
  assert.equal(
    domainEnteredBeforeDirectoryRelease,
    false,
    "comment UoW must not hold Domain while waiting for CandidateDirectory"
  );

  const results = await within(Promise.allSettled([
    standalone,
    commentIngestion
  ]), 500);
  assert.deepEqual(results.map((result) => result.status), [
    "fulfilled",
    "rejected"
  ]);
  assert.match(
    String(results[1]?.status === "rejected" ? results[1].reason : ""),
    /FAIL_AFTER_CANDIDATE/u
  );
  const standaloneResult = results[0]?.status === "fulfilled"
    ? results[0].value
    : null;
  assert.ok(standaloneResult);

  const candidates = await harness.domainRepository.listCandidates(scopeA, {
    limit: 100,
    subjectKind: "individual"
  });
  assert.deepEqual(
    candidates.items.map((candidate) => candidate.id),
    [standaloneResult.candidate.id]
  );
  const directoryReplay = await candidateDirectory.upsertCandidate({
    ownerId: scopeA.ownerId,
    teamId: scopeA.teamId,
    dedupeKey: standaloneResult.identityResolution.dedupeKey,
    partyType: "individual",
    idempotencyKey: "standalone-lock-order-directory-replay",
    createCandidate: async () => {
      throw new Error("standalone directory entry must survive comment rollback");
    }
  });
  assert.equal(directoryReplay.created, false);
  assert.equal(directoryReplay.entry.candidateId, standaloneResult.candidate.id);

  const pending = await harness.eventRepository.listPendingIngestionSagas({
    limit: 10
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.saga.status, "pending");
  assert.equal(pending[0]?.event.platformEventId, "cid-lock-order-comment");
  assert.deepEqual(await harness.eventRepository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 10 }
  ), []);
});

test("recovery isolates poison and failure-recording errors from later tenant work", async () => {
  const harness = createHarness();
  const seeder = new AcquisitionDouyinCommentIngestionService({
    events: harness.eventRepository,
    domain: harness.domain,
    individualSignals: new AcquisitionIndividualSignalIngestionService({
      domain: harness.domain,
      candidateDirectory: harness.candidateDirectory
    }),
    unitOfWork: harness.unitOfWork,
    failureInjector: async (stage) => {
      if (stage === "after_event") throw new Error("SEED_PENDING");
    }
  });
  await assert.rejects(seeder.ingestSample(input(page([
    comment("cid-poison", "预算 10 万，采购 20 套，请报价", {
      secUid: "MS4wLjABAAAA_poison"
    })
  ]))), /SEED_PENDING/u);
  await assert.rejects(seeder.ingestSample(input(page([
    comment("cid-healthy-tenant", "想咨询解决方案", {
      secUid: "MS4wLjABAAAA_healthy"
    })
  ], { capturedAt: "2026-08-15T02:00:01.000Z" }), {
    scope: scopeB,
    runId: "run-b"
  })), /SEED_PENDING/u);

  const realSignals = new AcquisitionIndividualSignalIngestionService({
    domain: harness.domain,
    candidateDirectory: harness.candidateDirectory
  });
  const sensitiveFailure = [
    "预算 10 万，采购 20 套，请报价",
    "MS4wLjABAAAA_poison",
    "https://www.douyin.com/video/1234567890123456789"
  ].join(" | ");
  let first = true;
  const diagnostics: unknown[] = [];
  let failRecordThrows = true;
  const recoveryEvents = new Proxy(harness.eventRepository, {
    get(target, property, receiver) {
      if (property === "failIngestionSaga") {
        return async (...args: Parameters<typeof target.failIngestionSaga>) => {
          const result = await target.failIngestionSaga(...args);
          if (failRecordThrows) {
            failRecordThrows = false;
            throw new Error(sensitiveFailure);
          }
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as AcquisitionDouyinCommentEventRepository;
  const recovery = new AcquisitionDouyinCommentIngestionService({
    events: recoveryEvents,
    domain: harness.domain,
    individualSignals: {
      async ingest(signalInput) {
        if (first) {
          first = false;
          throw new Error(sensitiveFailure);
        }
        return realSignals.ingest(signalInput);
      }
    },
    unitOfWork: harness.unitOfWork,
    recoveryWorkerId: "fair-worker",
    now: () => "2026-08-15T02:01:00.000Z",
    onRecoveryError: (diagnostic) => {
      diagnostics.push(diagnostic);
      if (diagnostics.length === 1) throw new Error(sensitiveFailure);
    }
  });

  await recovery.recoverPendingIngestionSagas({ limit: 2 });
  assert.equal(diagnostics.length, 2);
  const poisonSaga = (await harness.eventRepository
    .listPendingIngestionSagas({ limit: 10 }))[0]!.saga;
  const expectedSagaHash = `sha256:${createHash("sha256")
    .update(poisonSaga.sagaId)
    .digest("hex")}`;
  assert.deepEqual(diagnostics, [
    {
      code: "RECOVERY_FAILED",
      stage: "resume_saga",
      sagaHash: expectedSagaHash,
      attempt: 1
    },
    {
      code: "RECOVERY_FAILED",
      stage: "persist_failure",
      sagaHash: expectedSagaHash,
      attempt: 1
    }
  ]);
  const diagnosticJson = JSON.stringify(diagnostics);
  for (const secret of [
    sensitiveFailure,
    "预算 10 万，采购 20 套，请报价",
    "MS4wLjABAAAA_poison",
    "https://www.douyin.com/video/1234567890123456789",
    "stack",
    "message"
  ]) assert.equal(diagnosticJson.includes(secret), false);
  assert.equal((await harness.eventRepository.listRunCommentSignals(
    scopeB,
    "run-b",
    { limit: 10 }
  )).length, 1);
  assert.equal((await harness.eventRepository.listRunCommentSignals(
    scopeA,
    "run-1",
    { limit: 10 }
  )).length, 0);
  const pending = await harness.eventRepository.listPendingIngestionSagas({
    limit: 10
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.saga.lastErrorCode, "RECOVERY_FAILED");
  assert.equal(JSON.stringify(pending).includes(sensitiveFailure), false);
});

test("invalid sample literals and overlong context fail before mutation", async () => {
  const invalidInputs = [
    input(page([comment("cid-invalid-version", "想咨询")], {
      providerVersion: "another-version" as never
    })),
    input(page([comment("cid-invalid-replies", "想咨询")], {
      replyBodiesIncluded: true as never
    })),
    input(page([comment("cid-invalid-provider", "想咨询")], {
      providerId: "another-provider" as never
    })),
    input(page([comment("cid-invalid-coverage", "想咨询")], {
      coverage: "all_comments" as never
    })),
    input(page([comment("cid-invalid-context", "想咨询")]), {
      runId: "r".repeat(161)
    }),
    input(page([comment("cid-invalid-shard", "想咨询")]), {
      shardId: "s".repeat(161)
    }),
    input(page([comment("cid-invalid-operation", "想咨询")]), {
      discoveryOperationId: "o".repeat(161)
    }),
    input(page([comment("cid-invalid-video", "想咨询")]), {
      videoId: "not-a-video"
    })
  ];

  for (const invalidInput of invalidInputs) {
    const harness = createHarness();
    await assert.rejects(
      harness.service.ingestSample(invalidInput),
      /ACQUISITION_DOUYIN_COMMENT_INVALID_SAMPLE/u
    );
    assert.deepEqual(harness.mutationCounts, {
      eventAppends: 0,
      evidenceAppends: 0,
      signalIngestions: 0,
      links: 0
    });
    assert.equal((await harness.domainRepository.listCandidates(
      scopeA,
      { limit: 100 }
    )).items.length, 0);
  }
});

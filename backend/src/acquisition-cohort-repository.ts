import { createHash } from "node:crypto";
import type { OutcomeAttributionInput } from "./acquisition-domain.js";
import type { CanonicalSubjectResolution } from "./acquisition-canonical-subject.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner,
  type GrowthTemporalBarrier,
  type GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";

export interface AcquisitionCohort {
  id: string;
  workspaceId: string;
  platform: string;
  cohortFrom: string;
  cohortTo: string;
  definitionVersion: string;
  firstTouchRuleVersion: string;
  status: "active" | "superseded";
  createdAt: string;
  temporalSequence: number;
  domainCommandHash: `sha256:${string}`;
  requestHash: string;
  requestedBy: string;
}

export interface AcquisitionCanonicalSubject {
  id: string;
  workspaceId: string;
  platform: string;
  subjectStableKey: string;
  canonicalProfileUrl: string | null;
  createdAt: string;
}

export interface AcquisitionCohortMember {
  id: string;
  cohortId: string;
  workspaceId: string;
  platform: string;
  canonicalSubjectId: string;
  subjectStableKey: string;
  primaryCandidateId: string;
  firstEventId: string;
  firstDiscoveredAt: string;
  firstSourceRecordedAt: string;
  firstSourceTemporalSequence: number;
  firstPlanId: string;
  firstRunId: string;
  firstShardId: string;
  attributionSnapshot: OutcomeAttributionInput;
  ownershipVersionId: string;
  appendRevision: number;
  projectionRecordedAt: string;
  projectionTemporalSequence: number;
}

export interface AcquisitionCohortMembershipVersion {
  id: string;
  cohortMemberId: string;
  workspaceId: string;
  platform: string;
  subjectStableKey: string;
  cohortId: string;
  appendRevision: number;
  eventId: string;
  candidateId: string;
  planId: string;
  runId: string;
  discoveredAt: string;
  sourceRecordedAt: string;
  sourceTemporalSequence: number;
  attributionSnapshot: OutcomeAttributionInput;
  becameHead: boolean;
  previousHeadVersionId: string | null;
  projectionRecordedAt: string;
  projectionTemporalSequence: number;
}

export interface AcquisitionCohortMemberSource {
  cohortMemberId: string;
  eventId: string;
  candidateId: string;
  evidenceId: string | null;
  ownerId: string;
  discoveredAt: string;
  sourceRecordedAt: string;
  sourceTemporalSequence: number;
  projectionRecordedAt: string;
  projectionTemporalSequence: number;
}

export interface AuthoritativeDiscoveryEvent {
  eventId: string;
  candidateId: string;
  ownerId: string;
  discoveredAt: string;
  sourceRecordedAt: string;
  sourceTemporalSequence: number;
  material: { kind: string; platform: string };
  attribution: OutcomeAttributionInput;
  planId: string;
  runId: string;
  shardId: string;
  evidenceId: string | null;
}

export type FirstTouchOutcome = "inserted" | "reassigned" | "aliased";

export interface AcquisitionCohortCatchUpOperation {
  id: string;
  workspaceId: string;
  cohortId: string;
  cutoffEffectiveAsOf: string;
  initialCutoffTemporalSequence: number;
  requestedBy: string;
  authorityKind: "roi_close" | "performance_read";
  parentClosureOperationId: string | null;
  requestIdentityHash: `sha256:${string}`;
  status: "queued" | "running" | "succeeded" | "failed";
  checkpoint: { sourceRecordedAt: string; eventId: string } | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  fencingToken: number;
  errorCode: "capability_forbidden" | "stale_fencing_token" | null;
}

export interface CohortCatchUpResult {
  inserted: number;
  reassigned: number;
  aliased: number;
  unassignable: number;
  complete: boolean;
  sourceWatermark: {
    lastSourceRecordedAt: string | null;
    lastEventId: string | null;
    lastSourceTemporalSequence: number | null;
    eventCount: number;
    eventSetHash: `sha256:${string}`;
  };
}

export interface AcquisitionCohortRepository {
  requireActive(
    workspaceId: string,
    cohortId: string
  ): Promise<AcquisitionCohort>;
  getCohort(
    workspaceId: string,
    cohortId: string
  ): Promise<AcquisitionCohort | null>;
  listCohorts(workspaceId: string): Promise<AcquisitionCohort[]>;
  createCohort(input: {
    id: string;
    workspaceId: string;
    platform: string;
    cohortFrom: string;
    cohortTo: string;
    definitionVersion: string;
    firstTouchRuleVersion: string;
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
    requestedBy: string;
    now: string;
  }): Promise<AcquisitionCohort>;
  findCohortByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<AcquisitionCohort | null>;
  upsertFirstTouch(input: {
    cohort: AcquisitionCohort;
    event: AuthoritativeDiscoveryEvent;
    resolution: CanonicalSubjectResolution;
    now: string;
  }): Promise<FirstTouchOutcome>;
  listMembersAt(
    workspaceId: string,
    cohortId: string,
    cutoff: { effectiveAsOf: string }
  ): Promise<Array<AcquisitionCohortMember & {
    sources: AcquisitionCohortMemberSource[];
  }>>;
  listMembershipVersions(
    workspaceId: string
  ): Promise<AcquisitionCohortMembershipVersion[]>;
  listMemberSources(
    workspaceId: string
  ): Promise<AcquisitionCohortMemberSource[]>;
  createOrReplayCatchUp(input: {
    workspaceId: string;
    cohortId: string;
    cutoff: { effectiveAsOf: string; temporalSequence: number };
    requestedBy: string;
    authorityKind: "roi_close" | "performance_read";
    parentClosureOperationId: string | null;
    requestIdentity: string;
  }): Promise<AcquisitionCohortCatchUpOperation>;
  claimCatchUp(
    operationId: string,
    workerId: string,
    now: string,
    leaseDurationMs: number
  ): Promise<AcquisitionCohortCatchUpOperation | null>;
  readCheckpoint(
    operationId: string,
    lease: AcquisitionCohortCatchUpOperation
  ): Promise<{ sourceRecordedAt: string; eventId: string } | null>;
  advanceCheckpoint(
    operationId: string,
    checkpoint: { sourceRecordedAt: string; eventId: string } | null,
    lease: AcquisitionCohortCatchUpOperation
  ): Promise<void>;
  renewCatchUp(
    lease: AcquisitionCohortCatchUpOperation,
    now: string,
    leaseDurationMs: number
  ): Promise<void>;
  recordUnassignable(
    operationId: string,
    eventId: string,
    lease: AcquisitionCohortCatchUpOperation
  ): Promise<void>;
  completeCatchUp(
    operationId: string,
    lease: AcquisitionCohortCatchUpOperation,
    result: CohortCatchUpResult
  ): Promise<void>;
  listCatchUpOperations(
    workspaceId: string
  ): Promise<AcquisitionCohortCatchUpOperation[]>;
}

export function discoveryOrder(event: {
  discoveredAt: string;
  sourceRecordedAt: string;
  eventId: string;
}): string {
  return `${event.discoveredAt}\u0000${event.sourceRecordedAt}\u0000${event.eventId}`;
}

export function compareDiscoveryOrder(
  left: string,
  right: string
): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class InMemoryAcquisitionCohortRepository
implements AcquisitionCohortRepository {
  private readonly transactions: GrowthTemporalTransactionRunner;
  private readonly barrier: GrowthTemporalBarrier;
  private readonly cohorts = new Map<string, AcquisitionCohort>();
  private readonly subjects = new Map<string, AcquisitionCanonicalSubject>();
  private readonly members = new Map<string, AcquisitionCohortMember>();
  private readonly versions = new Map<string, AcquisitionCohortMembershipVersion>();
  private readonly sources = new Map<string, AcquisitionCohortMemberSource>();
  private readonly sourcesBySubject =
    new Map<string, AcquisitionCohortMemberSource[]>();
  private readonly heads = new Map<string, string>();
  private readonly catchUps = new Map<string, AcquisitionCohortCatchUpOperation>();
  private readonly unassignable = new Set<string>();
  private sequence = 0;

  constructor(
    temporalTransactions?: GrowthTemporalTransactionRunner,
    temporalBarrier?: GrowthTemporalBarrier
  ) {
    this.transactions = temporalTransactions
      ?? new InMemoryGrowthTemporalTransactionRunner();
    this.barrier = temporalBarrier
      ?? new DefaultGrowthTemporalBarrier(this.transactions);
  }

  private key(workspaceId: string, id: string): string {
    return `${workspaceId}\u0000${id}`;
  }

  private async nextId(): Promise<string> {
    this.sequence += 1;
    return `roi-${this.sequence}`;
  }

  async requireActive(
    workspaceId: string,
    cohortId: string
  ): Promise<AcquisitionCohort> {
    const cohort = this.cohorts.get(this.key(workspaceId, cohortId));
    if (!cohort) throw new Error("cohort_not_found");
    return cohort;
  }

  async getCohort(
    workspaceId: string,
    cohortId: string
  ): Promise<AcquisitionCohort | null> {
    return this.cohorts.get(this.key(workspaceId, cohortId)) ?? null;
  }

  async listCohorts(workspaceId: string): Promise<AcquisitionCohort[]> {
    return [...this.cohorts.values()]
      .filter((cohort) => cohort.workspaceId === workspaceId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async createCohort(input: {
    id: string;
    workspaceId: string;
    platform: string;
    cohortFrom: string;
    cohortTo: string;
    definitionVersion: string;
    firstTouchRuleVersion: string;
    domainCommandHash: `sha256:${string}`;
    requestHash: string;
    requestedBy: string;
    now: string;
  }): Promise<AcquisitionCohort> {
    const existing = await this.findCohortByDomainHash(
      input.workspaceId, input.domainCommandHash
    );
    if (existing) return existing;
    const stamp = await this.transactions.run(async (tx) =>
      this.barrier.allocateAppend(tx, input.workspaceId));
    const overlapping = [...this.cohorts.values()].some((cohort) =>
      cohort.workspaceId === input.workspaceId
      && cohort.platform === input.platform
      && cohort.status === "active"
      && cohort.cohortFrom < input.cohortTo
      && input.cohortFrom < cohort.cohortTo);
    if (overlapping) throw new Error("cohort_window_overlap");
    const cohort = Object.freeze({
      id: input.id,
      workspaceId: input.workspaceId,
      platform: input.platform,
      cohortFrom: input.cohortFrom,
      cohortTo: input.cohortTo,
      definitionVersion: input.definitionVersion,
      firstTouchRuleVersion: input.firstTouchRuleVersion,
      status: "active",
      createdAt: stamp.recordedAt,
      temporalSequence: stamp.temporalSequence,
      domainCommandHash: input.domainCommandHash,
      requestHash: input.requestHash,
      requestedBy: input.requestedBy
    }) as AcquisitionCohort;
    this.cohorts.set(this.key(cohort.workspaceId, cohort.id), cohort);
    return cohort;
  }

  async findCohortByDomainHash(
    workspaceId: string,
    domainCommandHash: `sha256:${string}`
  ): Promise<AcquisitionCohort | null> {
    return [...this.cohorts.values()].find((cohort) =>
      cohort.workspaceId === workspaceId
      && cohort.domainCommandHash === domainCommandHash) ?? null;
  }

  async upsertFirstTouch(input: {
    cohort: AcquisitionCohort;
    event: AuthoritativeDiscoveryEvent;
    resolution: CanonicalSubjectResolution;
    now: string;
  }): Promise<FirstTouchOutcome> {
    if (input.resolution.status !== "resolved"
      || input.resolution.subjectStableKey === null) {
      throw new Error("canonical_subject_unassignable");
    }
    const key = `${input.cohort.workspaceId}\u0000${input.cohort.platform}\u0000${input.resolution.subjectStableKey}`;
    const order = discoveryOrder(input.event);
    const stamp = await this.transactions.run(async (tx) =>
      this.barrier.allocateAppend(tx, input.cohort.workspaceId));
    const existingVersions = [...this.versions.values()]
      .filter((version) => version.subjectStableKey
        === input.resolution.subjectStableKey
        && version.workspaceId === input.cohort.workspaceId
        && version.eventId === input.event.eventId);
    if (existingVersions.length > 0) return "aliased";
    const headVersionId = this.heads.get(key) ?? null;
    const previousHead = headVersionId
      ? this.versions.get(headVersionId) ?? null : null;
    const becameHead = previousHead === null
      || compareDiscoveryOrder(order, discoveryOrder(previousHead)) < 0;
    const versionId = await this.nextId();
    const version: AcquisitionCohortMembershipVersion = Object.freeze({
      id: versionId,
      cohortMemberId: "",
      workspaceId: input.cohort.workspaceId,
      platform: input.cohort.platform,
      subjectStableKey: input.resolution.subjectStableKey,
      cohortId: input.cohort.id,
      appendRevision: (previousHead?.appendRevision ?? 0) + 1,
      eventId: input.event.eventId,
      candidateId: input.event.candidateId,
      planId: input.event.planId,
      runId: input.event.runId,
      discoveredAt: input.event.discoveredAt,
      sourceRecordedAt: input.event.sourceRecordedAt,
      sourceTemporalSequence: input.event.sourceTemporalSequence,
      attributionSnapshot: Object.freeze(
        structuredClone(input.event.attribution)
      ),
      becameHead,
      previousHeadVersionId: becameHead ? headVersionId : null,
      projectionRecordedAt: stamp.recordedAt,
      projectionTemporalSequence: stamp.temporalSequence
    });
    this.versions.set(versionId, version);
    const subjectId = await this.nextId();
    const subject: AcquisitionCanonicalSubject = Object.freeze({
      id: subjectId,
      workspaceId: input.cohort.workspaceId,
      platform: input.cohort.platform,
      subjectStableKey: input.resolution.subjectStableKey,
      canonicalProfileUrl: input.resolution.canonicalProfileUrl,
      createdAt: stamp.recordedAt
    });
    this.subjects.set(
      `${input.cohort.workspaceId}\u0000${input.resolution.subjectStableKey}`,
      subject
    );
    if (becameHead) {
      const memberId = await this.nextId();
      const member: AcquisitionCohortMember = Object.freeze({
        id: memberId,
        cohortId: input.cohort.id,
        workspaceId: input.cohort.workspaceId,
        platform: input.cohort.platform,
        canonicalSubjectId: subjectId,
        subjectStableKey: input.resolution.subjectStableKey,
        primaryCandidateId: input.event.candidateId,
        firstEventId: input.event.eventId,
        firstDiscoveredAt: input.event.discoveredAt,
        firstSourceRecordedAt: input.event.sourceRecordedAt,
        firstSourceTemporalSequence: input.event.sourceTemporalSequence,
        firstPlanId: input.event.planId,
        firstRunId: input.event.runId,
        firstShardId: input.event.shardId,
        attributionSnapshot: Object.freeze(
          structuredClone(input.event.attribution)
        ),
        ownershipVersionId: versionId,
        appendRevision: version.appendRevision,
        projectionRecordedAt: stamp.recordedAt,
        projectionTemporalSequence: stamp.temporalSequence
      });
      this.members.set(memberId, member);
      this.heads.set(key, versionId);
      this.versions.set(versionId, {
        ...version,
        cohortMemberId: memberId
      });
      this.appendSource(
        input.resolution.subjectStableKey, input.event, stamp
      );
      return previousHead === null ? "inserted" : "reassigned";
    }
    this.versions.set(versionId, version);
    this.appendSource(
      input.resolution.subjectStableKey, input.event, stamp
    );
    return "aliased";
  }

  private appendSource(
    subjectStableKey: string,
    event: AuthoritativeDiscoveryEvent,
    stamp: { recordedAt: string; temporalSequence: number }
  ): void {
    const source: AcquisitionCohortMemberSource = Object.freeze({
      cohortMemberId: "",
      eventId: event.eventId,
      candidateId: event.candidateId,
      evidenceId: event.evidenceId,
      ownerId: event.ownerId,
      discoveredAt: event.discoveredAt,
      sourceRecordedAt: event.sourceRecordedAt,
      sourceTemporalSequence: event.sourceTemporalSequence,
      projectionRecordedAt: stamp.recordedAt,
      projectionTemporalSequence: stamp.temporalSequence
    });
    this.sources.set(
      `${event.ownerId}\u0000${subjectStableKey}\u0000${event.eventId}`,
      source
    );
    const bySubject = this.sourcesBySubject.get(subjectStableKey) ?? [];
    bySubject.push(source);
    this.sourcesBySubject.set(subjectStableKey, bySubject);
  }

  async listMembersAt(
    workspaceId: string,
    cohortId: string,
    cutoff: { effectiveAsOf: string }
  ): Promise<Array<AcquisitionCohortMember & {
    sources: AcquisitionCohortMemberSource[];
  }>> {
    const visible = [...this.versions.values()].filter((version) =>
      version.workspaceId === workspaceId
      && version.sourceRecordedAt <= cutoff.effectiveAsOf);
    const bySubject = new Map<string, AcquisitionCohortMembershipVersion>();
    for (const version of visible) {
      const current = bySubject.get(version.subjectStableKey);
      if (!current || compareDiscoveryOrder(
        discoveryOrder(version), discoveryOrder(current)
      ) < 0) {
        bySubject.set(version.subjectStableKey, version);
      }
    }
    const rows: Array<AcquisitionCohortMember & {
      sources: AcquisitionCohortMemberSource[];
    }> = [];
    for (const version of bySubject.values()) {
      if (version.cohortId !== cohortId) continue;
      const subject = [...this.subjects.values()].find((candidate) =>
        candidate.workspaceId === workspaceId
        && candidate.subjectStableKey === version.subjectStableKey);
      const member: AcquisitionCohortMember = Object.freeze({
        id: `member:${version.id}`,
        cohortId: version.cohortId,
        workspaceId: version.workspaceId,
        platform: version.platform,
        canonicalSubjectId: subject?.id ?? "",
        subjectStableKey: version.subjectStableKey,
        primaryCandidateId: version.candidateId,
        firstEventId: version.eventId,
        firstDiscoveredAt: version.discoveredAt,
        firstSourceRecordedAt: version.sourceRecordedAt,
        firstSourceTemporalSequence: version.sourceTemporalSequence,
        firstPlanId: version.planId,
        firstRunId: version.runId,
        firstShardId: version.attributionSnapshot.shardId,
        attributionSnapshot: version.attributionSnapshot,
        ownershipVersionId: version.id,
        appendRevision: version.appendRevision,
        projectionRecordedAt: version.projectionRecordedAt,
        projectionTemporalSequence: version.projectionTemporalSequence
      });
      const sources = (this.sourcesBySubject.get(version.subjectStableKey) ?? [])
        .filter((source) =>
          source.sourceRecordedAt <= cutoff.effectiveAsOf)
        .sort((left, right) =>
          left.sourceRecordedAt.localeCompare(right.sourceRecordedAt)
          || left.eventId.localeCompare(right.eventId));
      rows.push({ ...member, sources });
    }
    return rows.sort((left, right) =>
      left.firstDiscoveredAt.localeCompare(right.firstDiscoveredAt)
      || left.subjectStableKey.localeCompare(right.subjectStableKey));
  }

  async listMembershipVersions(
    workspaceId: string
  ): Promise<AcquisitionCohortMembershipVersion[]> {
    return [...this.versions.values()]
      .filter((version) => version.workspaceId === workspaceId)
      .sort((left, right) =>
        left.appendRevision - right.appendRevision);
  }

  async listMemberSources(
    workspaceId: string
  ): Promise<AcquisitionCohortMemberSource[]> {
    return [...this.sources.values()]
      .sort((left, right) =>
        left.sourceRecordedAt.localeCompare(right.sourceRecordedAt));
  }

  async createOrReplayCatchUp(input: {
    workspaceId: string;
    cohortId: string;
    cutoff: { effectiveAsOf: string; temporalSequence: number };
    requestedBy: string;
    authorityKind: "roi_close" | "performance_read";
    parentClosureOperationId: string | null;
    requestIdentity: string;
  }): Promise<AcquisitionCohortCatchUpOperation> {
    const existing = [...this.catchUps.values()].find((operation) =>
      operation.workspaceId === input.workspaceId
      && operation.cohortId === input.cohortId
      && operation.requestIdentityHash === hashIdentity(input.requestIdentity));
    if (existing) return existing;
    const stamp = await this.transactions.run(async (tx) =>
      this.barrier.allocateAppend(tx, input.workspaceId));
    const operation: AcquisitionCohortCatchUpOperation = Object.freeze({
      id: await this.nextId(),
      workspaceId: input.workspaceId,
      cohortId: input.cohortId,
      cutoffEffectiveAsOf: input.cutoff.effectiveAsOf,
      initialCutoffTemporalSequence: input.cutoff.temporalSequence,
      requestedBy: input.requestedBy,
      authorityKind: input.authorityKind,
      parentClosureOperationId: input.parentClosureOperationId,
      requestIdentityHash: hashIdentity(input.requestIdentity),
      status: "queued",
      checkpoint: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      fencingToken: 0,
      errorCode: null
    });
    this.catchUps.set(operation.id, operation);
    return operation;
  }

  async claimCatchUp(
    operationId: string,
    workerId: string,
    now: string,
    leaseDurationMs: number
  ): Promise<AcquisitionCohortCatchUpOperation | null> {
    const current = this.catchUps.get(operationId);
    if (!current) return null;
    const claimable = current.status === "queued"
      || (current.status === "running"
        && current.leaseExpiresAt !== null
        && current.leaseExpiresAt <= now);
    if (!claimable) return null;
    const next: AcquisitionCohortCatchUpOperation = Object.freeze({
      ...current,
      status: "running",
      leaseOwner: workerId,
      leaseExpiresAt: new Date(
        Date.parse(now) + leaseDurationMs
      ).toISOString(),
      fencingToken: current.fencingToken + 1
    });
    this.catchUps.set(operationId, next);
    return next;
  }

  async readCheckpoint(
    operationId: string,
    lease: AcquisitionCohortCatchUpOperation
  ): Promise<{ sourceRecordedAt: string; eventId: string } | null> {
    this.assertLive(operationId, lease);
    return this.catchUps.get(operationId)?.checkpoint ?? null;
  }

  async advanceCheckpoint(
    operationId: string,
    checkpoint: { sourceRecordedAt: string; eventId: string } | null,
    lease: AcquisitionCohortCatchUpOperation
  ): Promise<void> {
    this.assertLive(operationId, lease);
    const current = this.catchUps.get(operationId)!;
    this.catchUps.set(operationId, Object.freeze({
      ...current,
      checkpoint
    }));
  }

  async renewCatchUp(
    lease: AcquisitionCohortCatchUpOperation,
    now: string,
    leaseDurationMs: number
  ): Promise<void> {
    this.assertLive(lease.id, lease);
    const current = this.catchUps.get(lease.id)!;
    this.catchUps.set(lease.id, Object.freeze({
      ...current,
      leaseExpiresAt: new Date(
        Date.parse(now) + leaseDurationMs
      ).toISOString()
    }));
  }

  async recordUnassignable(
    operationId: string,
    eventId: string,
    lease: AcquisitionCohortCatchUpOperation
  ): Promise<void> {
    this.assertLive(operationId, lease);
    this.unassignable.add(`${operationId}:${eventId}`);
  }

  async completeCatchUp(
    operationId: string,
    lease: AcquisitionCohortCatchUpOperation,
    result: CohortCatchUpResult
  ): Promise<void> {
    this.assertLive(operationId, lease);
    const current = this.catchUps.get(operationId)!;
    this.catchUps.set(operationId, Object.freeze({
      ...current,
      status: "succeeded",
      leaseOwner: null,
      leaseExpiresAt: null
    }));
    void result;
  }

  async listCatchUpOperations(
    workspaceId: string
  ): Promise<AcquisitionCohortCatchUpOperation[]> {
    return [...this.catchUps.values()]
      .filter((operation) => operation.workspaceId === workspaceId);
  }

  private assertLive(
    operationId: string,
    lease: AcquisitionCohortCatchUpOperation
  ): void {
    const current = this.catchUps.get(operationId);
    if (!current || current.leaseOwner !== lease.leaseOwner
      || current.fencingToken !== lease.fencingToken) {
      throw new Error("stale_fencing_token");
    }
  }
}

export function hashIdentity(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

import { createHash } from "node:crypto";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner,
  type GrowthSealedReadCutoff,
  type GrowthTemporalBarrier,
  type GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";

export interface AdvisorCandidateAuthorityEvent {
  id: string;
  workspaceId: string;
  workspaceBindingRevision: string;
  candidateId: string;
  eventSequence: number;
  recordedAt: string;
  temporalSequence: number;
  ownerId: string;
  teamId: string;
  qualificationDecisionId: string;
  qualificationDecisionVersion: string;
  qualificationSnapshotHash: string;
  financialValueDecisionId: string;
  financialValueDecisionVersion: string;
  financialValueInputSnapshotHash: string;
  grade: string;
  score: number;
  evidence: readonly {
    evidenceId: string;
    contentHash: string;
    fetchedAt: string;
  }[];
}

export interface AdvisorCandidateAuthorityProjectionInput {
  workspaceId: string;
  workspaceBindingRevision: string;
  candidateId: string;
  ownerId: string;
  teamId: string;
  qualificationDecisionId: string;
  qualificationDecisionVersion: string;
  qualificationSnapshotHash: string;
  financialValueDecisionId: string;
  financialValueDecisionVersion: string;
  financialValueInputSnapshotHash: string;
  grade: string;
  score: number;
  evidence: readonly {
    evidenceId: string;
    contentHash: string;
    fetchedAt: string;
  }[];
}

export interface AdvisorAuthorityAppendStamp {
  recordedAt: string;
  temporalSequence: number;
}

export function advisorAuthorityEventFromInput(
  input: AdvisorCandidateAuthorityProjectionInput,
  stamp: AdvisorAuthorityAppendStamp,
  eventSequence: number
): AdvisorCandidateAuthorityEvent {
  if (input.workspaceId === "all" || !input.workspaceId.trim()
    || input.teamId === "all" || !input.teamId.trim()
    || !input.ownerId.trim() || !input.candidateId.trim()) {
    throw new Error("growth_workspace_required");
  }
  if (!Number.isSafeInteger(eventSequence) || eventSequence < 1) {
    throw new Error("advisor_candidate_authority_sequence_invalid");
  }
  return Object.freeze({
    ...input,
    id: `advisor-authority-${input.workspaceId}-${input.candidateId}-${eventSequence}`,
    eventSequence,
    recordedAt: stamp.recordedAt,
    temporalSequence: stamp.temporalSequence,
    evidence: Object.freeze(input.evidence.map((item) => Object.freeze({
      evidenceId: item.evidenceId,
      contentHash: item.contentHash,
      fetchedAt: item.fetchedAt
    })))
  });
}

export interface AdvisorCandidateAuthorityRepository {
  append(
    input: AdvisorCandidateAuthorityProjectionInput
  ): Promise<AdvisorCandidateAuthorityEvent>;
  getAt(
    workspaceId: string,
    candidateId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<AdvisorCandidateAuthorityEvent | null>;
  listAt(
    workspaceId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<readonly AdvisorCandidateAuthorityEvent[]>;
  seal(workspaceId: string, asOf: string): Promise<GrowthSealedReadCutoff>;
}

export class InMemoryAdvisorCandidateAuthorityRepository
implements AdvisorCandidateAuthorityRepository {
  private readonly transactions: GrowthTemporalTransactionRunner;
  private readonly barrier: GrowthTemporalBarrier;
  readonly events = new Map<string, AdvisorCandidateAuthorityEvent[]>();
  readonly guards = new Set<string>();
  private now: string;

  constructor(
    options: {
      now?: string;
      temporalTransactions?: GrowthTemporalTransactionRunner;
      temporalBarrier?: GrowthTemporalBarrier;
    } = {}
  ) {
    this.now = options.now ?? "2026-08-09T00:00:00.000Z";
    this.transactions = options.temporalTransactions
      ?? new InMemoryGrowthTemporalTransactionRunner(this.now);
    this.barrier = options.temporalBarrier
      ?? new DefaultGrowthTemporalBarrier(this.transactions);
  }

  setNow(value: string): void {
    this.now = value;
    if (this.transactions instanceof InMemoryGrowthTemporalTransactionRunner) {
      this.transactions.setDatabaseNow(value);
    }
  }

  private key(workspaceId: string, candidateId: string): string {
    return `${workspaceId}\u0000${candidateId}`;
  }

  async append(
    input: AdvisorCandidateAuthorityProjectionInput
  ): Promise<AdvisorCandidateAuthorityEvent> {
    if (input.workspaceId === "all" || !input.workspaceId.trim()
      || input.teamId === "all" || !input.teamId.trim()) {
      throw new Error("growth_workspace_required");
    }
    const stamp = await this.transactions.run(async (tx) => {
      const allocated = await this.barrier.allocateAppend(
        tx, input.workspaceId
      );
      this.acquireGuard(input.workspaceId, input.candidateId);
      return allocated;
    });
    return this.appendFromBundle(input, stamp);
  }

  /** Appends an authority event with a caller-allocated workspace temporal
   *  stamp. Used by the acquisition qualification bundle so the authority
   *  event, Candidate, QualificationDecision and FinancialValueDecision stay
   *  in one barrier-first transaction. */
  appendFromBundle(
    input: AdvisorCandidateAuthorityProjectionInput,
    stamp: AdvisorAuthorityAppendStamp
  ): AdvisorCandidateAuthorityEvent {
    if (!this.guards.has(this.key(input.workspaceId, input.candidateId))) {
      this.acquireGuard(input.workspaceId, input.candidateId);
    }
    const events = this.events.get(this.key(input.workspaceId, input.candidateId))
      ?? [];
    const event = advisorAuthorityEventFromInput(
      input, stamp, events.length + 1
    );
    events.push(event);
    this.events.set(this.key(input.workspaceId, input.candidateId), events);
    this.guards.delete(this.key(input.workspaceId, input.candidateId));
    return event;
  }

  private acquireGuard(workspaceId: string, candidateId: string): void {
    const guard = this.key(workspaceId, candidateId);
    if (this.guards.has(guard)) {
      throw new Error("advisor_candidate_authority_guard_busy");
    }
    this.guards.add(guard);
  }

  async getAt(
    workspaceId: string,
    candidateId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<AdvisorCandidateAuthorityEvent | null> {
    if (cutoff.workspaceId !== workspaceId) {
      throw new Error("sealed_cutoff_workspace_mismatch");
    }
    const events = (this.events.get(this.key(workspaceId, candidateId)) ?? [])
      .filter((event) => event.recordedAt <= cutoff.effectiveAsOf)
      .sort((left, right) => left.eventSequence - right.eventSequence);
    return events.at(-1) ?? null;
  }

  async listAt(
    workspaceId: string,
    cutoff: GrowthSealedReadCutoff
  ): Promise<readonly AdvisorCandidateAuthorityEvent[]> {
    if (cutoff.workspaceId !== workspaceId) {
      throw new Error("sealed_cutoff_workspace_mismatch");
    }
    const rows: AdvisorCandidateAuthorityEvent[] = [];
    for (const [key, events] of this.events) {
      if (!key.startsWith(`${workspaceId}\u0000`)) continue;
      const visible = events
        .filter((event) =>
          event.recordedAt <= cutoff.effectiveAsOf)
        .sort((left, right) => left.eventSequence - right.eventSequence);
      const last = visible.at(-1);
      if (last) rows.push(last);
    }
    return Object.freeze(rows.sort((left, right) =>
      left.candidateId.localeCompare(right.candidateId)));
  }

  async seal(workspaceId: string, asOf: string): Promise<GrowthSealedReadCutoff> {
    const context = Object.freeze({
      workspaceId,
      kind: "team",
      actorId: "advisor",
      role: "admin",
      teamId: workspaceId,
      capabilities: Object.freeze([]),
      capabilityRegistryVersion: "growth-capabilities.v1"
    });
    return this.barrier.sealReadCutoff(context, asOf);
  }
}

export function advisorAuthoritySnapshotHash(
  event: AdvisorCandidateAuthorityEvent
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(event)).digest("hex")}`;
}

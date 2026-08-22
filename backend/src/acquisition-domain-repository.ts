import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AcquisitionAuditEvent,
  AcquisitionCandidate,
  AcquisitionCandidateIdentityAlias,
  BattleCard,
  DiscoveryEvidence,
  FinancialValueDecision,
  IdempotencyRecord,
  LeadConversionIntent,
  LeadConversionRecord,
  LiveOutcomeFeedbackEvent,
  OutcomeFeedbackEvent,
  QualificationDecision,
  ResearchAttempt,
  ReviewEvent
} from "./acquisition-domain.js";
import type {
  AcquisitionPlanRunRepository
} from "./acquisition-plan-run-repository.js";
import type {
  AdvisorCandidateAuthorityEvent,
  AdvisorCandidateAuthorityProjectionInput
} from "./growth-advisor-candidate-authority-projection.js";
import {
  InMemoryAdvisorCandidateAuthorityRepository
} from "./growth-advisor-candidate-authority-projection.js";
import {
  DefaultGrowthTemporalBarrier,
  InMemoryGrowthTemporalTransactionRunner,
  assertGrowthTemporalBarrier,
  type GrowthTemporalBarrier,
  type GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";

export interface AcquisitionDataScope {
  ownerId: string;
  teamId: string;
}

export interface AcquisitionCandidateListQuery {
  cursor?: string;
  snapshot?: string;
  limit: number;
  subjectKind?: "organization" | "individual";
  status?: AcquisitionCandidate["status"];
}

export interface AcquisitionCandidateListPage {
  items: AcquisitionCandidate[];
  nextCursor: string | null;
  snapshot: string;
}

export interface AcquisitionPresentationEventCursor {
  createdAt: string;
  eventId: string;
}

export interface AcquisitionPresentationCandidateSnapshot {
  candidate: AcquisitionCandidate;
  qualification: QualificationDecision | null;
  financial: FinancialValueDecision | null;
  sourcePlatforms: string[];
}

export interface AcquisitionPresentationCandidateSummary {
  organizationsFound: number;
  dedupedCandidates: number;
  validOpportunities: number;
  highIntent: number;
  financialEvaluatedHighIntentCount: number;
  financialPendingHighIntentCount: number;
  expectedRevenueByCurrency: Array<{
    currency: string;
    amountMinor: number;
  }>;
}

export interface QualificationBundleWorkspace {
  workspaceId: string;
  workspaceBindingRevision: string;
}

export interface QualificationBundleEvidenceReference {
  evidenceId: string;
  contentHash: string;
  fetchedAt: string;
}

/** One application-owned atomic qualification commit. The repository takes
 *  the workspace temporal barrier as its first lock, guards the candidate,
 *  verifies the frozen versions under the guard, then writes Candidate,
 *  QualificationDecision, FinancialValueDecision, audit events and the
 *  Advisor candidate authority event all-or-nothing. */
export interface QualificationBundleCommit {
  workspace: QualificationBundleWorkspace;
  candidate: AcquisitionCandidate;
  qualification: QualificationDecision;
  financialValue: FinancialValueDecision;
  auditEvents: readonly AcquisitionAuditEvent[];
  authority: AdvisorCandidateAuthorityProjectionInput;
}

export interface QualificationBundleResult {
  candidate: AcquisitionCandidate;
  qualification: QualificationDecision;
  financialValue: FinancialValueDecision;
  authorityEvent: AdvisorCandidateAuthorityEvent;
}

export interface AcquisitionDomainRepository {
  transaction<T>(work: () => Promise<T>): Promise<T>;
  findEvidence(
    scope: AcquisitionDataScope,
    evidenceId: string
  ): Promise<DiscoveryEvidence | null>;
  appendEvidence(evidence: DiscoveryEvidence): Promise<void>;
  findCandidate(
    scope: AcquisitionDataScope,
    candidateId: string
  ): Promise<AcquisitionCandidate | null>;
  listCandidates(
    scope: AcquisitionDataScope,
    query: AcquisitionCandidateListQuery
  ): Promise<AcquisitionCandidateListPage>;
  insertCandidate(candidate: AcquisitionCandidate): Promise<void>;
  saveCandidate(candidate: AcquisitionCandidate): Promise<void>;
  findCandidateIdentityAlias(
    scope: AcquisitionDataScope,
    dedupeKey: string
  ): Promise<AcquisitionCandidateIdentityAlias | null>;
  bindCandidateIdentityAliases(
    aliases: AcquisitionCandidateIdentityAlias[]
  ): Promise<void>;
  appendQualificationDecision(decision: QualificationDecision): Promise<void>;
  commitQualificationBundle(
    input: QualificationBundleCommit
  ): Promise<QualificationBundleResult>;
  findQualificationDecision(
    scope: AcquisitionDataScope,
    candidateId: string,
    decisionId: string
  ): Promise<QualificationDecision | null>;
  listQualificationDecisions(
    scope: AcquisitionDataScope,
    candidateId: string
  ): Promise<QualificationDecision[]>;
  appendFinancialValue(decision: FinancialValueDecision): Promise<void>;
  listFinancialValues(
    scope: AcquisitionDataScope,
    candidateId: string
  ): Promise<FinancialValueDecision[]>;
  appendBattleCard(card: BattleCard): Promise<void>;
  listBattleCards(
    scope: AcquisitionDataScope,
    candidateId: string
  ): Promise<BattleCard[]>;
  appendReviewEvent(event: ReviewEvent): Promise<void>;
  listReviewEvents(
    scope: AcquisitionDataScope,
    candidateId: string
  ): Promise<ReviewEvent[]>;
  appendResearchAttempt(attempt: ResearchAttempt): Promise<void>;
  saveResearchAttempt(attempt: ResearchAttempt): Promise<void>;
  findResearchAttempt(
    scope: AcquisitionDataScope,
    candidateId: string,
    researchId: string
  ): Promise<ResearchAttempt | null>;
  appendConversionIntent(intent: LeadConversionIntent): Promise<void>;
  saveConversionIntent(intent: LeadConversionIntent): Promise<void>;
  findConversionIntent(
    scope: AcquisitionDataScope,
    candidateId: string
  ): Promise<LeadConversionIntent | null>;
  listRecoverableConversionIntents(
    limit: number
  ): Promise<LeadConversionIntent[]>;
  appendConversion(record: LeadConversionRecord): Promise<void>;
  findConversion(
    scope: AcquisitionDataScope,
    candidateId: string
  ): Promise<LeadConversionRecord | null>;
  appendOutcome(event: LiveOutcomeFeedbackEvent): Promise<void>;
  listOutcomes(
    scope: AcquisitionDataScope,
    candidateId: string
  ): Promise<OutcomeFeedbackEvent[]>;
  appendAuditEvent(event: AcquisitionAuditEvent): Promise<void>;
  listAuditEvents(
    scope: AcquisitionDataScope,
    candidateId: string | null
  ): Promise<AcquisitionAuditEvent[]>;
  listPresentationAuditEvents(
    scope: AcquisitionDataScope,
    query: {
      runId: string;
      after?: AcquisitionPresentationEventCursor;
      limit: number;
    }
  ): Promise<AcquisitionAuditEvent[]>;
  getPresentationCandidateSnapshots(
    scope: AcquisitionDataScope,
    candidateIds: string[]
  ): Promise<AcquisitionPresentationCandidateSnapshot[]>;
  getPresentationEvidenceSnapshots(
    scope: AcquisitionDataScope,
    evidenceIds: string[]
  ): Promise<DiscoveryEvidence[]>;
  getPresentationCandidateSummary(
    scope: AcquisitionDataScope,
    runId: string
  ): Promise<AcquisitionPresentationCandidateSummary>;
  findIdempotency(
    scope: AcquisitionDataScope,
    operation: string,
    idempotencyKey: string
  ): Promise<IdempotencyRecord | null>;
  appendIdempotency(record: IdempotencyRecord): Promise<void>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function belongs(
  value: { ownerId: string; teamId: string },
  scope: AcquisitionDataScope
) {
  return value.ownerId === scope.ownerId && value.teamId === scope.teamId;
}

function idempotencyMapKey(
  scope: AcquisitionDataScope,
  operation: string,
  idempotencyKey: string
) {
  return `${scope.ownerId}\u0000${scope.teamId}\u0000${operation}\u0000${idempotencyKey}`;
}

function candidateSnapshot(candidates: AcquisitionCandidate[]) {
  const identity = candidates.map((candidate) => [
    candidate.id,
    candidate.version,
    candidate.status,
    candidate.updatedAt
  ]);
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
}

function candidateCursor(value: string | undefined) {
  if (value === undefined) return 0;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error("CANDIDATE_CURSOR_INVALID");
  }
  const offset = Number(value);
  if (!Number.isSafeInteger(offset)) {
    throw new Error("CANDIDATE_CURSOR_INVALID");
  }
  return offset;
}

export class InMemoryAcquisitionDomainRepository
implements AcquisitionDomainRepository {
  private readonly evidence = new Map<string, DiscoveryEvidence>();
  private readonly candidates = new Map<string, AcquisitionCandidate>();
  private readonly candidateIdentityAliases =
    new Map<string, AcquisitionCandidateIdentityAlias>();
  private readonly qualificationDecisions: QualificationDecision[] = [];
  private readonly financialValues: FinancialValueDecision[] = [];
  private readonly battleCards: BattleCard[] = [];
  private readonly reviewEvents: ReviewEvent[] = [];
  private readonly researchAttempts = new Map<string, ResearchAttempt>();
  private readonly conversionIntents = new Map<string, LeadConversionIntent>();
  private readonly conversions: LeadConversionRecord[] = [];
  private readonly outcomes: LiveOutcomeFeedbackEvent[] = [];
  private readonly auditEvents: AcquisitionAuditEvent[] = [];
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private readonly transactionContext =
    new AsyncLocalStorage<{ active: boolean }>();
  private transactionTail: Promise<void> = Promise.resolve();
  private readonly temporalTransactions: GrowthTemporalTransactionRunner;
  private readonly temporalBarrier: GrowthTemporalBarrier;
  readonly advisorAuthority: InMemoryAdvisorCandidateAuthorityRepository;

  constructor(
    optionsOrPresentationRuns:
      | {
          temporalTransactions?: GrowthTemporalTransactionRunner;
          temporalBarrier?: GrowthTemporalBarrier;
          advisorAuthority?: InMemoryAdvisorCandidateAuthorityRepository;
        }
      | Pick<AcquisitionPlanRunRepository, "listRunCandidateLinks"> = {},
    presentationRuns?: Pick<
      AcquisitionPlanRunRepository,
      "listRunCandidateLinks"
    >
  ) {
    const options = "listRunCandidateLinks" in optionsOrPresentationRuns
      ? { presentationRuns: optionsOrPresentationRuns }
      : { ...optionsOrPresentationRuns, presentationRuns };
    this.presentationRuns = options.presentationRuns;
    this.temporalTransactions = options.temporalTransactions
      ?? new InMemoryGrowthTemporalTransactionRunner();
    this.temporalBarrier = options.temporalBarrier
      ?? new DefaultGrowthTemporalBarrier(this.temporalTransactions);
    this.advisorAuthority = options.advisorAuthority
      ?? new InMemoryAdvisorCandidateAuthorityRepository({
          now: "2026-08-09T00:00:00.000Z",
          temporalTransactions: this.temporalTransactions,
          temporalBarrier: this.temporalBarrier
        });
  }

  private presentationRuns?: Pick<
    AcquisitionPlanRunRepository,
    "listRunCandidateLinks"
  >;

  bindPresentationRunRepository(
    presentationRuns: Pick<
      AcquisitionPlanRunRepository,
      "listRunCandidateLinks"
    >
  ) {
    this.presentationRuns = presentationRuns;
  }

  private async presentationCandidateLinks(runId: string) {
    if (!this.presentationRuns) {
      throw new Error("PRESENTATION_RUN_REPOSITORY_REQUIRED");
    }
    return this.presentationRuns.listRunCandidateLinks(runId);
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionContext.getStore()?.active) return work();
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const snapshot = {
      evidence: new Map(
        [...this.evidence.entries()].map(([key, value]) => [key, copy(value)])
      ),
      candidates: new Map(
        [...this.candidates.entries()].map(([key, value]) => [key, copy(value)])
      ),
      candidateIdentityAliases: new Map(
        [...this.candidateIdentityAliases.entries()]
          .map(([key, value]) => [key, copy(value)])
      ),
      qualificationDecisions: copy(this.qualificationDecisions),
      financialValues: copy(this.financialValues),
      battleCards: copy(this.battleCards),
      reviewEvents: copy(this.reviewEvents),
      researchAttempts: new Map(
        [...this.researchAttempts.entries()]
          .map(([key, value]) => [key, copy(value)])
      ),
      conversionIntents: new Map(
        [...this.conversionIntents.entries()]
          .map(([key, value]) => [key, copy(value)])
      ),
      conversions: copy(this.conversions),
      outcomes: copy(this.outcomes),
      auditEvents: copy(this.auditEvents),
      idempotency: new Map(
        [...this.idempotency.entries()].map(([key, value]) => [key, copy(value)])
      ),
      authorityEvents: new Map(
        [...this.advisorAuthority.events.entries()]
          .map(([key, value]) => [key, copy(value)])
      ),
      authorityGuards: new Set(this.advisorAuthority.guards)
    };
    const context = { active: true };
    try {
      return await this.transactionContext.run(context, work);
    } catch (error) {
      this.evidence.clear();
      snapshot.evidence.forEach((value, key) => this.evidence.set(key, value));
      this.candidates.clear();
      snapshot.candidates.forEach(
        (value, key) => this.candidates.set(key, value)
      );
      this.candidateIdentityAliases.clear();
      snapshot.candidateIdentityAliases.forEach(
        (value, key) => this.candidateIdentityAliases.set(key, value)
      );
      this.qualificationDecisions.splice(
        0,
        this.qualificationDecisions.length,
        ...snapshot.qualificationDecisions
      );
      this.financialValues.splice(
        0,
        this.financialValues.length,
        ...snapshot.financialValues
      );
      this.battleCards.splice(
        0,
        this.battleCards.length,
        ...snapshot.battleCards
      );
      this.reviewEvents.splice(
        0,
        this.reviewEvents.length,
        ...snapshot.reviewEvents
      );
      this.researchAttempts.clear();
      snapshot.researchAttempts.forEach(
        (value, key) => this.researchAttempts.set(key, value)
      );
      this.conversionIntents.clear();
      snapshot.conversionIntents.forEach(
        (value, key) => this.conversionIntents.set(key, value)
      );
      this.conversions.splice(
        0,
        this.conversions.length,
        ...snapshot.conversions
      );
      this.outcomes.splice(0, this.outcomes.length, ...snapshot.outcomes);
      this.auditEvents.splice(
        0,
        this.auditEvents.length,
        ...snapshot.auditEvents
      );
      this.idempotency.clear();
      snapshot.idempotency.forEach(
        (value, key) => this.idempotency.set(key, value)
      );
      this.advisorAuthority.events.clear();
      snapshot.authorityEvents.forEach(
        (value, key) => this.advisorAuthority.events.set(key, value)
      );
      this.advisorAuthority.guards.clear();
      for (const guard of snapshot.authorityGuards) {
        this.advisorAuthority.guards.add(guard);
      }
      throw error;
    } finally {
      context.active = false;
      release();
    }
  }

  async findEvidence(scope: AcquisitionDataScope, evidenceId: string) {
    const evidence = this.evidence.get(evidenceId);
    return evidence && belongs(evidence, scope) ? copy(evidence) : null;
  }

  async appendEvidence(evidence: DiscoveryEvidence) {
    if (this.evidence.has(evidence.id)) {
      throw new Error(`duplicate evidence id: ${evidence.id}`);
    }
    this.evidence.set(evidence.id, copy(evidence));
  }

  async findCandidate(scope: AcquisitionDataScope, candidateId: string) {
    const candidate = this.candidates.get(candidateId);
    return candidate && belongs(candidate, scope) ? copy(candidate) : null;
  }

  async listCandidates(
    scope: AcquisitionDataScope,
    query: AcquisitionCandidateListQuery
  ) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw new Error("CANDIDATE_LIMIT_INVALID");
    }
    const candidates = [...this.candidates.values()]
      .filter((candidate) =>
        belongs(candidate, scope)
        && (!query.subjectKind || candidate.profile.kind === query.subjectKind)
        && (!query.status || candidate.status === query.status)
      )
      .sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt)
        || left.id.localeCompare(right.id)
      );
    const snapshot = candidateSnapshot(candidates);
    if (query.snapshot && query.snapshot !== snapshot) {
      throw new Error("CANDIDATE_SNAPSHOT_CHANGED");
    }
    const offset = candidateCursor(query.cursor);
    const items = candidates.slice(offset, offset + query.limit).map(copy);
    const nextOffset = offset + items.length;
    return {
      items,
      nextCursor: nextOffset < candidates.length ? String(nextOffset) : null,
      snapshot
    };
  }

  async insertCandidate(candidate: AcquisitionCandidate) {
    if (this.candidates.has(candidate.id)) {
      throw new Error(`duplicate candidate id: ${candidate.id}`);
    }
    this.candidates.set(candidate.id, copy(candidate));
  }

  async saveCandidate(candidate: AcquisitionCandidate) {
    const current = this.candidates.get(candidate.id);
    if (!current || !belongs(current, candidate)) {
      throw new Error(`candidate not found: ${candidate.id}`);
    }
    this.candidates.set(candidate.id, copy(candidate));
  }

  async findCandidateIdentityAlias(
    scope: AcquisitionDataScope,
    dedupeKey: string
  ) {
    const alias = this.candidateIdentityAliases.get(
      idempotencyMapKey(scope, "candidate_identity_alias", dedupeKey)
    );
    return alias ? copy(alias) : null;
  }

  async bindCandidateIdentityAliases(
    aliases: AcquisitionCandidateIdentityAlias[]
  ) {
    for (const alias of aliases) {
      const key = idempotencyMapKey(
        alias,
        "candidate_identity_alias",
        alias.dedupeKey
      );
      const existing = this.candidateIdentityAliases.get(key);
      if (existing && (
        existing.candidateId !== alias.candidateId
        || existing.partyType !== alias.partyType
      )) {
        throw new Error("CANDIDATE_IDENTITY_ALIAS_CONFLICT");
      }
    }
    for (const alias of aliases) {
      this.candidateIdentityAliases.set(
        idempotencyMapKey(
          alias,
          "candidate_identity_alias",
          alias.dedupeKey
        ),
        copy(alias)
      );
    }
  }

  async appendQualificationDecision(decision: QualificationDecision) {
    this.qualificationDecisions.push(copy(decision));
  }

  async commitQualificationBundle(
    input: QualificationBundleCommit
  ): Promise<QualificationBundleResult> {
    const workspaceId = input.workspace.workspaceId.trim();
    if (!workspaceId || workspaceId === "all"
      || input.candidate.teamId === "all"
      || input.qualification.teamId === "all"
      || input.financialValue.teamId === "all") {
      throw new Error("growth_workspace_required");
    }
    const scope: AcquisitionDataScope = {
      ownerId: input.candidate.ownerId,
      teamId: input.candidate.teamId
    };
    const candidate = this.candidates.get(input.candidate.id);
    if (!candidate || !belongs(candidate, scope)
      || !belongs(input.qualification, scope)
      || !belongs(input.financialValue, scope)
      || input.qualification.candidateId !== input.candidate.id
      || input.financialValue.candidateId !== input.candidate.id
      || input.financialValue.qualificationDecisionId
        !== input.qualification.id) {
      throw new Error("growth_workspace_mismatch");
    }
    return this.temporalTransactions.run(async (tx) => {
      const stamp = await this.temporalBarrier.allocateAppend(
        tx, workspaceId
      );
      const previous = this.qualificationDecisions.filter((item) =>
        item.candidateId === input.candidate.id
        && belongs(item, scope));
      const expectedSequence = previous.length + 1;
      if (input.qualification.decisionVersion
          !== `decision-v${expectedSequence}`
        || input.financialValue.version
          !== `financial-value-v${expectedSequence}`) {
        throw new Error("stale_decision");
      }
      for (const reference of input.qualification.evidence) {
        const evidence = this.evidence.get(reference.evidenceId);
        if (!evidence || !belongs(evidence, scope)) {
          throw new Error("growth_workspace_mismatch");
        }
      }
      for (const reference of input.authority.evidence) {
        const evidence = this.evidence.get(reference.evidenceId);
        if (!evidence || !belongs(evidence, scope)
          || evidence.contentHash !== reference.contentHash
          || evidence.fetchedAt !== reference.fetchedAt) {
          throw new Error("growth_workspace_mismatch");
        }
      }
      this.qualificationDecisions.push(copy(input.qualification));
      this.financialValues.push(copy(input.financialValue));
      this.candidates.set(input.candidate.id, copy(input.candidate));
      for (const event of input.auditEvents) {
        if (!belongs(event, scope)) {
          throw new Error("growth_workspace_mismatch");
        }
        this.auditEvents.push(copy(event));
      }
      const authorityEvent = this.advisorAuthority.appendFromBundle(
        input.authority, stamp
      );
      return {
        candidate: copy(input.candidate),
        qualification: copy(input.qualification),
        financialValue: copy(input.financialValue),
        authorityEvent
      };
    });
  }

  async findQualificationDecision(
    scope: AcquisitionDataScope,
    candidateId: string,
    decisionId: string
  ) {
    const decision = this.qualificationDecisions.find((item) =>
      item.id === decisionId
      && item.candidateId === candidateId
      && belongs(item, scope)
    );
    return decision ? copy(decision) : null;
  }

  async listQualificationDecisions(
    scope: AcquisitionDataScope,
    candidateId: string
  ) {
    return this.qualificationDecisions
      .filter((item) => item.candidateId === candidateId && belongs(item, scope))
      .map(copy);
  }

  async appendFinancialValue(decision: FinancialValueDecision) {
    this.financialValues.push(copy(decision));
  }

  async listFinancialValues(
    scope: AcquisitionDataScope,
    candidateId: string
  ) {
    return this.financialValues
      .filter((item) => item.candidateId === candidateId && belongs(item, scope))
      .map(copy);
  }

  async appendBattleCard(card: BattleCard) {
    this.battleCards.push(copy(card));
  }

  async listBattleCards(scope: AcquisitionDataScope, candidateId: string) {
    return this.battleCards
      .filter((item) => item.candidateId === candidateId && belongs(item, scope))
      .map(copy);
  }

  async appendReviewEvent(event: ReviewEvent) {
    this.reviewEvents.push(copy(event));
  }

  async listReviewEvents(scope: AcquisitionDataScope, candidateId: string) {
    return this.reviewEvents
      .filter((item) => item.candidateId === candidateId && belongs(item, scope))
      .map(copy);
  }

  async appendResearchAttempt(attempt: ResearchAttempt) {
    if (this.researchAttempts.has(attempt.id)) {
      throw new Error(`duplicate research id: ${attempt.id}`);
    }
    this.researchAttempts.set(attempt.id, copy(attempt));
  }

  async saveResearchAttempt(attempt: ResearchAttempt) {
    const current = this.researchAttempts.get(attempt.id);
    if (!current || !belongs(current, attempt)) {
      throw new Error(`research attempt not found: ${attempt.id}`);
    }
    this.researchAttempts.set(attempt.id, copy(attempt));
  }

  async findResearchAttempt(
    scope: AcquisitionDataScope,
    candidateId: string,
    researchId: string
  ) {
    const attempt = this.researchAttempts.get(researchId);
    return attempt
      && attempt.candidateId === candidateId
      && belongs(attempt, scope)
      ? copy(attempt)
      : null;
  }

  async appendConversionIntent(intent: LeadConversionIntent) {
    const existing = [...this.conversionIntents.values()].find((item) =>
      belongs(item, intent)
      && (
        item.candidateId === intent.candidateId
        || item.idempotencyKey === intent.idempotencyKey
      )
    );
    if (existing) {
      throw new Error(`duplicate conversion intent: ${intent.candidateId}`);
    }
    this.conversionIntents.set(intent.id, copy(intent));
  }

  async saveConversionIntent(intent: LeadConversionIntent) {
    const existing = this.conversionIntents.get(intent.id);
    if (!existing || !belongs(existing, intent)) {
      throw new Error(`conversion intent not found: ${intent.id}`);
    }
    this.conversionIntents.set(intent.id, copy(intent));
  }

  async findConversionIntent(
    scope: AcquisitionDataScope,
    candidateId: string
  ) {
    const result = [...this.conversionIntents.values()].find((item) =>
      belongs(item, scope) && item.candidateId === candidateId
    );
    return result ? copy(result) : null;
  }

  async listRecoverableConversionIntents(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("CONVERSION_INTENT_LIMIT_INVALID");
    }
    return [...this.conversionIntents.values()]
      .filter((item) => item.status !== "completed")
      .sort((left, right) =>
        left.updatedAt.localeCompare(right.updatedAt)
        || left.id.localeCompare(right.id)
      )
      .slice(0, limit)
      .map(copy);
  }

  async appendConversion(record: LeadConversionRecord) {
    if (this.conversions.some((item) =>
      belongs(item, record)
      && (
        item.candidateId === record.candidateId
        || item.idempotencyKey === record.idempotencyKey
      )
    )) {
      throw new Error(`duplicate conversion: ${record.candidateId}`);
    }
    this.conversions.push(copy(record));
  }

  async findConversion(scope: AcquisitionDataScope, candidateId: string) {
    const result = this.conversions.find((item) =>
      item.candidateId === candidateId && belongs(item, scope)
    );
    return result ? copy(result) : null;
  }

  async appendOutcome(event: LiveOutcomeFeedbackEvent) {
    this.outcomes.push(copy(event));
  }

  async listOutcomes(scope: AcquisitionDataScope, candidateId: string) {
    return this.outcomes
      .filter((item) => item.candidateId === candidateId && belongs(item, scope))
      .map(copy);
  }

  async appendAuditEvent(event: AcquisitionAuditEvent) {
    this.auditEvents.push(copy(event));
  }

  async listAuditEvents(
    scope: AcquisitionDataScope,
    candidateId: string | null
  ) {
    return this.auditEvents
      .filter((item) =>
        belongs(item, scope)
        && (candidateId === null || item.candidateId === candidateId)
      )
      .map(copy);
  }

  async listPresentationAuditEvents(
    scope: AcquisitionDataScope,
    query: {
      runId: string;
      after?: AcquisitionPresentationEventCursor;
      limit: number;
    }
  ) {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1) {
      throw new Error("PRESENTATION_AUDIT_LIMIT_INVALID");
    }
    const links = await this.presentationCandidateLinks(query.runId);
    const watermarks = new Map(links.map((item) => [
      item.candidateId,
      item
    ]));
    const after = query.after;
    return this.auditEvents
      .filter((item) => {
        if (!belongs(item, scope) || !item.candidateId) return false;
        const discovered = watermarks.get(item.candidateId);
        if (!discovered) return false;
        const afterDiscovery =
          item.createdAt > discovered.createdAt
          || (
            item.createdAt === discovered.createdAt
            && item.id > discovered.eventId
          );
        const afterCursor = !after
          || item.createdAt > after.createdAt
          || (
            item.createdAt === after.createdAt
            && item.id > after.eventId
          );
        return afterDiscovery && afterCursor;
      })
      .sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || left.id.localeCompare(right.id)
      )
      .slice(0, query.limit)
      .map(copy);
  }

  async getPresentationCandidateSnapshots(
    scope: AcquisitionDataScope,
    candidateIds: string[]
  ): Promise<AcquisitionPresentationCandidateSnapshot[]> {
    const uniqueIds = [...new Set(candidateIds)];
    return uniqueIds.flatMap((candidateId) => {
      const candidate = this.candidates.get(candidateId);
      if (!candidate || !belongs(candidate, scope)) return [];
      const qualification = candidate.latestDecisionId
        ? this.qualificationDecisions.find((item) =>
            item.id === candidate.latestDecisionId
            && item.candidateId === candidateId
            && belongs(item, scope)
          ) ?? null
        : null;
      const financial = qualification
        ? this.financialValues
            .filter((item) =>
              item.candidateId === candidateId
              && item.qualificationDecisionId === qualification.id
              && belongs(item, scope)
            )
            .sort((left, right) =>
              left.createdAt.localeCompare(right.createdAt)
              || left.id.localeCompare(right.id)
            )
            .at(-1) ?? null
        : null;
      const sourcePlatforms = [
        ...new Set(candidate.evidenceIds.flatMap((evidenceId) => {
          const item = this.evidence.get(evidenceId);
          return item && belongs(item, scope) ? [item.sourcePlatform] : [];
        }))
      ].sort();
      return [{
        candidate: copy(candidate),
        qualification: qualification ? copy(qualification) : null,
        financial: financial ? copy(financial) : null,
        sourcePlatforms
      }];
    });
  }

  async getPresentationEvidenceSnapshots(
    scope: AcquisitionDataScope,
    evidenceIds: string[]
  ): Promise<DiscoveryEvidence[]> {
    return [...new Set(evidenceIds)].flatMap((evidenceId) => {
      const item = this.evidence.get(evidenceId);
      return item && belongs(item, scope) ? [copy(item)] : [];
    });
  }

  async getPresentationCandidateSummary(
    scope: AcquisitionDataScope,
    runId: string
  ): Promise<AcquisitionPresentationCandidateSummary> {
    const candidateIds = (await this.presentationCandidateLinks(runId))
      .map((link) => link.candidateId);
    const candidates = [...new Set(candidateIds)].flatMap((candidateId) => {
      const candidate = this.candidates.get(candidateId);
      if (!candidate || !belongs(candidate, scope)) return [];
      const qualification = candidate.latestDecisionId
        ? this.qualificationDecisions.find((item) =>
            item.id === candidate.latestDecisionId
            && item.candidateId === candidateId
            && belongs(item, scope)
          ) ?? null
        : null;
      const financial = qualification
        ? this.financialValues
            .filter((item) =>
              item.candidateId === candidateId
              && item.qualificationDecisionId === qualification.id
              && belongs(item, scope)
            )
            .sort((left, right) =>
              left.createdAt.localeCompare(right.createdAt)
              || left.id.localeCompare(right.id)
            )
            .at(-1) ?? null
        : null;
      return [{ candidate, qualification, financial }];
    });
    const highIntent = candidates.filter((item) =>
      (item.qualification?.grade === "S"
        || item.qualification?.grade === "A")
      && item.qualification.hardGateFailures.length === 0
      && item.candidate.status !== "do_not_contact"
    );
    const revenue = new Map<string, number>();
    for (const item of highIntent) {
      if (!item.financial) continue;
      revenue.set(
        item.financial.currency,
        (revenue.get(item.financial.currency) ?? 0)
          + item.financial.expectedRevenueMinor
      );
    }
    return {
      organizationsFound: candidates.filter(
        (item) => item.candidate.profile.kind === "organization"
      ).length,
      dedupedCandidates: candidates.length,
      validOpportunities: candidates.filter((item) =>
        item.qualification
        && ["S", "A", "B"].includes(item.qualification.grade)
        && item.qualification.hardGateFailures.length === 0
        && item.candidate.status !== "do_not_contact"
      ).length,
      highIntent: highIntent.length,
      financialEvaluatedHighIntentCount: highIntent.filter(
        (item) => item.financial !== null
      ).length,
      financialPendingHighIntentCount: highIntent.filter(
        (item) => item.financial === null
      ).length,
      expectedRevenueByCurrency: [...revenue.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, amountMinor]) => ({ currency, amountMinor }))
    };
  }

  async findIdempotency(
    scope: AcquisitionDataScope,
    operation: string,
    idempotencyKey: string
  ) {
    const result = this.idempotency.get(
      idempotencyMapKey(scope, operation, idempotencyKey)
    );
    return result ? copy(result) : null;
  }

  async appendIdempotency(record: IdempotencyRecord) {
    const key = idempotencyMapKey(
      record,
      record.operation,
      record.idempotencyKey
    );
    if (this.idempotency.has(key)) {
      throw new Error(`duplicate idempotency key: ${record.idempotencyKey}`);
    }
    this.idempotency.set(key, copy(record));
  }
}

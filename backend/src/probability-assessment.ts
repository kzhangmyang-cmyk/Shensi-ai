import { createHash } from "node:crypto";
import type mysql from "mysql2/promise";
import { canonicalJsonStringify } from "./canonical-json.js";
import { normalizeGrowthInstant } from "./growth-as-of.js";
import {
  assertConcreteGrowthWorkspaceId,
  assertGrowthTemporalBarrier,
  type GrowthTemporalBarrier,
  type GrowthTemporalTransactionRunner
} from "./growth-temporal-barrier.js";
import { MysqlProbabilityAssessmentRepository } from "./probability-assessment-mysql-repository.js";

export type ProbabilityAssessmentHash = `sha256:${string}`;

export interface ProbabilityAssessmentV2 {
  readonly id: string;
  readonly workspaceId: string;
  readonly candidateId: string;
  readonly dealId: string | null;
  readonly closeProbabilityBps: number;
  readonly qualificationDecisionId: string;
  readonly qualificationDecisionVersion: string;
  readonly evidenceRefs: readonly string[];
  readonly ruleVersion: string;
  readonly modelSnapshotRef: string | null;
  readonly inputSnapshotHash: ProbabilityAssessmentHash;
  readonly assessedAt: string;
  readonly recordedAt: string;
  readonly temporalSequence: number;
  readonly precision: "bps";
}

export interface ProbabilityAssessmentQualificationInput {
  workspaceId: string;
  candidateId: string;
  dealId: string | null;
  qualificationDecisionId: string;
  qualificationDecisionVersion: string;
  qualificationInputHash: ProbabilityAssessmentHash;
  evidenceRefs: readonly string[];
  ruleVersion: string;
  modelSnapshotRef: string | null;
  financial: { closeProbabilityBps: number };
  assessedAt: string;
}

export interface ProbabilityAssessmentWriter {
  recordFromQualification(
    input: ProbabilityAssessmentQualificationInput
  ): Promise<ProbabilityAssessmentV2>;
}

export interface ProbabilityAssessmentRepository {
  append(record: ProbabilityAssessmentV2): Promise<ProbabilityAssessmentV2>;
  findCurrent(
    workspaceId: string,
    candidateId: string,
    dealId?: string
  ): Promise<ProbabilityAssessmentV2 | null>;
  bindDeal(
    workspaceId: string,
    id: string,
    dealId: string,
    bindingHash: ProbabilityAssessmentHash
  ): Promise<ProbabilityAssessmentV2>;
}

export type ProbabilityAssessmentPersistence =
  ProbabilityAssessmentRepository & ProbabilityAssessmentWriter;

function assessmentError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) throw assessmentError(code);
  return normalized;
}

function hash(value: unknown): ProbabilityAssessmentHash {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value) ?? "")
    .digest("hex")}`;
}

function assertHash(value: string): ProbabilityAssessmentHash {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw assessmentError("invalid_probability_assessment_hash");
  }
  return value as ProbabilityAssessmentHash;
}

function normalizeBps(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw assessmentError("invalid_probability_assessment_bps");
  }
  return value;
}

function immutable(record: ProbabilityAssessmentV2): ProbabilityAssessmentV2 {
  return Object.freeze({
    ...record,
    evidenceRefs: Object.freeze([...record.evidenceRefs])
  });
}

export function normalizeProbabilityAssessment(
  record: ProbabilityAssessmentV2
): ProbabilityAssessmentV2 {
  const normalized: ProbabilityAssessmentV2 = {
    id: required(record.id, "invalid_probability_assessment_id"),
    workspaceId: assertConcreteGrowthWorkspaceId(record.workspaceId),
    candidateId: required(
      record.candidateId,
      "invalid_probability_assessment_candidate"
    ),
    dealId: record.dealId === null
      ? null
      : required(record.dealId, "invalid_probability_assessment_deal"),
    closeProbabilityBps: normalizeBps(record.closeProbabilityBps),
    qualificationDecisionId: required(
      record.qualificationDecisionId,
      "invalid_probability_assessment_decision"
    ),
    qualificationDecisionVersion: required(
      record.qualificationDecisionVersion,
      "invalid_probability_assessment_decision_version"
    ),
    evidenceRefs: [...new Set(record.evidenceRefs.map((value) => required(
      value,
      "invalid_probability_assessment_evidence"
    )))],
    ruleVersion: required(
      record.ruleVersion,
      "invalid_probability_assessment_rule_version"
    ),
    modelSnapshotRef: record.modelSnapshotRef === null
      ? null
      : required(
          record.modelSnapshotRef,
          "invalid_probability_assessment_model_snapshot"
        ),
    inputSnapshotHash: assertHash(record.inputSnapshotHash),
    assessedAt: normalizeGrowthInstant(record.assessedAt),
    recordedAt: normalizeGrowthInstant(record.recordedAt),
    temporalSequence: record.temporalSequence,
    precision: record.precision
  };
  if (normalized.precision !== "bps"
    || !Number.isSafeInteger(normalized.temporalSequence)
    || normalized.temporalSequence < 1) {
    throw assessmentError("invalid_probability_assessment_v2");
  }
  return immutable(normalized);
}

export function probabilityAssessmentStableIdentity(
  record: Pick<ProbabilityAssessmentV2,
    "workspaceId" | "candidateId" | "qualificationDecisionId"
    | "qualificationDecisionVersion" | "inputSnapshotHash">
): string {
  return [
    record.workspaceId,
    record.candidateId,
    record.qualificationDecisionId,
    record.qualificationDecisionVersion,
    record.inputSnapshotHash
  ].join("\u0000");
}

export function assertProbabilityAssessmentReplay(
  existing: ProbabilityAssessmentV2,
  candidate: ProbabilityAssessmentV2
): ProbabilityAssessmentV2 {
  const content = (record: ProbabilityAssessmentV2) => ({
    closeProbabilityBps: record.closeProbabilityBps,
    qualificationDecisionId: record.qualificationDecisionId,
    qualificationDecisionVersion: record.qualificationDecisionVersion,
    evidenceRefs: record.evidenceRefs,
    ruleVersion: record.ruleVersion,
    modelSnapshotRef: record.modelSnapshotRef,
    inputSnapshotHash: record.inputSnapshotHash,
    assessedAt: record.assessedAt,
    precision: record.precision
  });
  if (canonicalJsonStringify(content(existing))
    !== canonicalJsonStringify(content(candidate))) {
    throw assessmentError("probability_assessment_identity_conflict");
  }
  return existing;
}

export function probabilityAssessmentId(
  input: Pick<ProbabilityAssessmentQualificationInput,
    "workspaceId" | "candidateId" | "qualificationDecisionId"
    | "qualificationDecisionVersion" | "qualificationInputHash">
): string {
  return `probability-assessment-${hash(input).slice("sha256:".length)}`;
}

export function assertFormalProbabilityAssessment(
  input: unknown
): ProbabilityAssessmentV2 {
  try {
    if (!input || typeof input !== "object"
      || (input as { precision?: unknown }).precision !== "bps") {
      throw assessmentError("probability_assessment_v2_required");
    }
    return normalizeProbabilityAssessment(input as ProbabilityAssessmentV2);
  } catch (error) {
    if ((error as { code?: string }).code
      === "probability_assessment_v2_required") throw error;
    throw assessmentError("probability_assessment_v2_required");
  }
}

export class InMemoryProbabilityAssessmentRepository
implements ProbabilityAssessmentPersistence {
  private readonly records = new Map<string, ProbabilityAssessmentV2>();
  private readonly identities = new Map<string, string>();
  private readonly bindings = new Map<string, ProbabilityAssessmentHash>();
  private readonly transactions: GrowthTemporalTransactionRunner;
  private readonly temporalBarrier: GrowthTemporalBarrier;

  constructor(options: {
    transactions: GrowthTemporalTransactionRunner;
    temporalBarrier: GrowthTemporalBarrier;
  }) {
    this.transactions = options.transactions;
    this.temporalBarrier = assertGrowthTemporalBarrier(
      options.temporalBarrier
    );
  }

  async append(record: ProbabilityAssessmentV2) {
    const candidate = normalizeProbabilityAssessment(record);
    return this.transactions.run(async (transaction) => {
      const stamp = await this.temporalBarrier.allocateAppend(
        transaction,
        candidate.workspaceId
      );
      const identity = probabilityAssessmentStableIdentity(candidate);
      const existingId = this.identities.get(identity);
      if (existingId) {
        return assertProbabilityAssessmentReplay(
          this.records.get(existingId)!,
          candidate
        );
      }
      const existingById = this.records.get(candidate.id);
      if (existingById) {
        throw assessmentError("probability_assessment_identity_conflict");
      }
      const stored = immutable({ ...candidate, ...stamp });
      this.records.set(stored.id, stored);
      this.identities.set(identity, stored.id);
      return stored;
    });
  }

  async recordFromQualification(
    input: ProbabilityAssessmentQualificationInput
  ) {
    return this.append({
      id: probabilityAssessmentId(input),
      workspaceId: input.workspaceId,
      candidateId: input.candidateId,
      dealId: input.dealId,
      closeProbabilityBps: input.financial.closeProbabilityBps,
      qualificationDecisionId: input.qualificationDecisionId,
      qualificationDecisionVersion: input.qualificationDecisionVersion,
      evidenceRefs: input.evidenceRefs,
      ruleVersion: input.ruleVersion,
      modelSnapshotRef: input.modelSnapshotRef,
      inputSnapshotHash: input.qualificationInputHash,
      assessedAt: input.assessedAt,
      recordedAt: input.assessedAt,
      temporalSequence: 1,
      precision: "bps"
    });
  }

  async findCurrent(
    workspaceId: string,
    candidateId: string,
    dealId?: string
  ) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const candidate = required(
      candidateId,
      "invalid_probability_assessment_candidate"
    );
    return [...this.records.values()]
      .filter((record) => record.workspaceId === workspace
        && record.candidateId === candidate
        && (dealId === undefined || record.dealId === dealId))
      .sort((left, right) => right.temporalSequence - left.temporalSequence
        || right.id.localeCompare(left.id))[0] ?? null;
  }

  async bindDeal(
    workspaceId: string,
    id: string,
    dealId: string,
    bindingHash: ProbabilityAssessmentHash
  ) {
    const workspace = assertConcreteGrowthWorkspaceId(workspaceId);
    const assessmentId = required(id, "invalid_probability_assessment_id");
    const deal = required(dealId, "invalid_probability_assessment_deal");
    const binding = assertHash(bindingHash);
    const current = this.records.get(assessmentId);
    if (current?.workspaceId === workspace
      && current.dealId === deal
      && this.bindings.get(assessmentId) === binding) return current;
    return this.transactions.run(async (transaction) => {
      const stamp = await this.temporalBarrier.allocateAppend(
        transaction,
        workspace
      );
      const record = this.records.get(assessmentId);
      if (!record || record.workspaceId !== workspace) {
        throw assessmentError("probability_assessment_not_found");
      }
      if (record.dealId !== null) {
        throw assessmentError("probability_assessment_deal_already_bound");
      }
      const stored = immutable({ ...record, dealId: deal, ...stamp });
      this.records.set(assessmentId, stored);
      this.bindings.set(assessmentId, binding);
      return stored;
    });
  }
}

export type ProbabilityAssessmentRepositoryOptions =
  | {
      mode: "memory";
      transactions: GrowthTemporalTransactionRunner;
      temporalBarrier: GrowthTemporalBarrier;
    }
  | {
      mode: "mysql";
      pool: mysql.Pool;
      temporalBarrier: GrowthTemporalBarrier;
    };

export function createProbabilityAssessmentRepository(
  options: ProbabilityAssessmentRepositoryOptions
): ProbabilityAssessmentPersistence {
  return options.mode === "mysql"
    ? new MysqlProbabilityAssessmentRepository(
        options.pool,
        options.temporalBarrier
      )
    : new InMemoryProbabilityAssessmentRepository(options);
}

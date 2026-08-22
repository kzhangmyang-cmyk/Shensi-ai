import { createHash } from "node:crypto";
import type {
  AcquisitionOperationShard,
  AcquisitionRun
} from "./acquisition-plan-run-repository.js";
import type {
  AcquisitionAgentToolExecutor,
  AcquisitionToolExecutionInput,
  AcquisitionAgentToolName
} from "./acquisition-pi-tools.js";
import type {
  AcquisitionScope
} from "./acquisition-plan-run-service.js";
import {
  AcquisitionToolExecutorError,
  type AcquisitionToolExecutorErrorCode
} from "./acquisition-tool-executor.js";
import type {
  AcquisitionCandidateResearchPort
} from "./acquisition-candidate-research.js";
import type {
  AcquisitionCandidateIntelligenceOperation
} from "./acquisition-candidate-intelligence-operations.js";

export interface AcquisitionCandidateProcessingInput {
  scope: AcquisitionScope;
  run: AcquisitionRun;
  shard: AcquisitionOperationShard;
  candidateIds: string[];
  signal: AbortSignal;
}

export interface AcquisitionCandidateProcessingResult {
  processedCandidateIds: string[];
  battleCardCandidateIds: string[];
  failures: Array<{
    candidateId: string;
    stage: "research" | "qualification" | "battle_card";
    errorCode: string;
  }>;
}

export interface AcquisitionCandidateProcessingPipelineOptions {
  executor: AcquisitionAgentToolExecutor;
  research?: AcquisitionCandidateResearchPort;
  identityResolutionStage?: AcquisitionCandidateIdentityResolutionStagePort;
}

export interface AcquisitionCandidateIdentityResolutionStagePort {
  resolveBeforeIntelligence(
    input: AcquisitionCandidateProcessingInput & { candidateId: string }
  ): Promise<
    | { status: "not_required" }
    | {
        status: "completed";
        operationId: string;
        intelligence: AcquisitionCandidateIntelligenceOperation;
      }
    | {
        status: "requires_review";
        operationId: string;
        errorCode: string;
      }
  >;
}

type CandidateStage =
  AcquisitionCandidateProcessingResult["failures"][number]["stage"];

const RESEARCH_QUESTIONS = Object.freeze([
  "该主体最近有哪些与目标产品相关的明确需求或经营变化？",
  "哪些公开信息支持或反驳采购可能性？",
  "可能参与采购决策的部门和商务角色有哪些？",
  "是否存在现有供应商、比价、拒绝联系或勿扰信号？"
]);

const GRADES = new Set(["S", "A", "B", "C", "D"]);
const HARD_GATE_FAILURES = new Set([
  "missing_original_source",
  "identity_unresolved",
  "do_not_contact",
  "explicit_rejection",
  "non_public_or_sensitive_data",
  "stale_evidence",
  "schema_invalid"
]);
const TRUSTED_TOOL_ERROR_CODES = new Set<AcquisitionToolExecutorErrorCode>([
  "ABORTED",
  "INVALID_IDENTITY",
  "IDENTITY_RESEARCH_REQUIRED",
  "INVALID_PAYLOAD",
  "UNKNOWN_TOOL",
  "SEARCH_PROVIDER_CONNECTION_REQUIRED",
  "SEARCH_ALL_PROVIDERS_FAILED",
  "RESOURCE_NOT_FOUND",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_STATE",
  "HARD_GATE_BLOCKED",
  "EVIDENCE_REQUIRED",
  "STALE_DECISION",
  "CONVERSION_FAILED",
  "ELIGIBILITY_BLOCKED",
  "ACTION_NOT_EXECUTED",
  "ACTION_EXECUTION_MISMATCH",
  "INVALID_JUDGMENT_RESULT",
  "UNSUPPORTED_CURRENCY",
  "TOOL_EXECUTION_FAILED"
]);

function stageKey(input: {
  runId: string;
  shardId: string;
  candidateId: string;
  stage: string;
}) {
  return `acquisition-stage:${createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 48)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value);
}

function qualificationSnapshot(value: unknown) {
  if (!isRecord(value) || !isRecord(value.qualification)) return null;
  const { grade, score, hardGateFailures } = value.qualification;
  if (typeof grade !== "string"
    || !GRADES.has(grade)
    || typeof score !== "number"
    || !Number.isFinite(score)
    || score < 0
    || score > 100
    || !Array.isArray(hardGateFailures)
    || hardGateFailures.some((failure) =>
      typeof failure !== "string" || !HARD_GATE_FAILURES.has(failure)
    )
    || new Set(hardGateFailures).size !== hardGateFailures.length) {
    return null;
  }
  return {
    grade: grade as "S" | "A" | "B" | "C" | "D",
    score,
    hardGateFailures
  };
}

function stableErrorCode(error: unknown) {
  if (error instanceof AcquisitionToolExecutorError
    && TRUSTED_TOOL_ERROR_CODES.has(error.code)) {
    return error.code;
  }
  return "TOOL_EXECUTION_FAILED";
}

function abortReason(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("aborted", "AbortError");
}

function assertNotAborted(signal: AbortSignal) {
  if (signal.aborted) throw abortReason(signal);
}

export class AcquisitionCandidateProcessingPipeline {
  private readonly executor: AcquisitionAgentToolExecutor;
  private readonly research: AcquisitionCandidateResearchPort | null;
  private readonly identityResolutionStage:
    AcquisitionCandidateIdentityResolutionStagePort | null;

  constructor(options: AcquisitionCandidateProcessingPipelineOptions) {
    this.executor = options.executor;
    this.research = options.research ?? null;
    this.identityResolutionStage = options.identityResolutionStage ?? null;
  }

  async process(
    input: AcquisitionCandidateProcessingInput
  ): Promise<AcquisitionCandidateProcessingResult> {
    const result: AcquisitionCandidateProcessingResult = {
      processedCandidateIds: [],
      battleCardCandidateIds: [],
      failures: []
    };
    for (const candidateId of input.candidateIds) {
      assertNotAborted(input.signal);
      if (this.identityResolutionStage) {
        const identity = await this.identityResolutionStage
          .resolveBeforeIntelligence({ ...input, candidateId });
        assertNotAborted(input.signal);
        if (identity.status === "requires_review") {
          result.failures.push({
            candidateId,
            stage: "research",
            errorCode: "IDENTITY_RESEARCH_REQUIRED"
          });
          continue;
        }
        if (identity.status === "completed") {
          if (identity.intelligence.status === "succeeded") {
            result.processedCandidateIds.push(candidateId);
            if (identity.intelligence.battleCardId) {
              result.battleCardCandidateIds.push(candidateId);
            }
          } else {
            result.failures.push({
              candidateId,
              stage: identity.intelligence.failure?.stage ?? "research",
              errorCode: identity.intelligence.failure?.errorCode
                ?? "TOOL_EXECUTION_FAILED"
            });
          }
          continue;
        }
      }
      if (this.research) {
        try {
          const supplemental = await this.research.research({
            scope: input.scope,
            run: input.run,
            shard: input.shard,
            candidateId,
            questions: [...RESEARCH_QUESTIONS],
            signal: input.signal
          });
          assertNotAborted(input.signal);
          if (supplemental.status === "failed") {
            result.failures.push({
              candidateId,
              stage: "research",
              errorCode: "SUPPLEMENTAL_RESEARCH_FAILED"
            });
            continue;
          }
        } catch (error) {
          if (input.signal.aborted) throw abortReason(input.signal);
          result.failures.push({
            candidateId,
            stage: "research",
            errorCode: "SUPPLEMENTAL_RESEARCH_FAILED"
          });
          continue;
        }
      }
      const researched = await this.executeStage(
        input,
        candidateId,
        "research",
        "research_candidate",
        {
          candidateId,
          depth: "standard",
          researchQuestions: [...RESEARCH_QUESTIONS]
        },
        result
      );
      if (!researched.ok) continue;

      const qualificationExecution = await this.executeStage(
        input,
        candidateId,
        "qualification",
        "qualify_candidate",
        {
          candidateId,
          policyVersion: "qualification.v2"
        },
        result
      );
      if (!qualificationExecution.ok) continue;
      const snapshot = qualificationSnapshot(qualificationExecution.value);
      if (!snapshot) {
        result.failures.push({
          candidateId,
          stage: "qualification",
          errorCode: "INVALID_QUALIFICATION_RESULT"
        });
        continue;
      }
      result.processedCandidateIds.push(candidateId);

      const eligible = snapshot.hardGateFailures.length === 0
        && (snapshot.grade === "S"
          || snapshot.grade === "A"
          || snapshot.score >= 70);
      if (!eligible) continue;
      const battleCard = await this.executeStage(
        input,
        candidateId,
        "battle_card",
        "build_battle_card",
        {
          candidateId,
          templateVersion: "battle-card.v2"
        },
        result
      );
      if (battleCard.ok) {
        result.battleCardCandidateIds.push(candidateId);
      }
    }
    return result;
  }

  private async executeStage(
    input: AcquisitionCandidateProcessingInput,
    candidateId: string,
    stage: CandidateStage,
    toolName: AcquisitionAgentToolName,
    payload: Record<string, unknown>,
    result: AcquisitionCandidateProcessingResult
  ) {
    assertNotAborted(input.signal);
    const key = stageKey({
      runId: input.run.id,
      shardId: input.shard.id,
      candidateId,
      stage
    });
    const execution: AcquisitionToolExecutionInput = {
      identity: {
        ...input.scope,
        sessionId: `acquisition-plan:${input.run.id}`
      },
      toolName,
      toolCallId: key,
      idempotencyKey: key,
      payload,
      signal: input.signal
    };
    try {
      const value = await this.executor.execute(execution);
      assertNotAborted(input.signal);
      return { ok: true as const, value };
    } catch (error) {
      if (input.signal.aborted) throw abortReason(input.signal);
      result.failures.push({
        candidateId,
        stage,
        errorCode: stableErrorCode(error)
      });
      return { ok: false as const };
    }
  }
}

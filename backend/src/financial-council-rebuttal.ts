import {
  financialCouncilCanonicalHash,
  financialCouncilError,
  immutableFinancialCouncilInput,
  immutableFinancialCouncilValue
} from "./financial-council-domain.js";
import { buildFinancialCouncilModelContent } from
  "./financial-council-model-content.js";
import type {
  FinancialCouncilModelPort,
  FinancialCouncilRebutInput,
  FinancialCouncilRebutOutput
} from "./financial-council-model-port.js";
import type {
  CompleteFinancialCouncilRebuttalInput,
  FinancialCouncilCommandResult,
  FinancialCouncilRebuttalAttempt,
  FinancialCouncilLeaseWrite,
  FinancialCouncilRepository
} from "./financial-council-repository.js";
import type { ActiveWorkspaceContext } from
  "./growth-workspace-context.js";
import type {
  FinancialCouncilAgentRole,
  FinancialCouncilFinding
} from "./growth-contract-types.js";
import type {
  FinancialCouncilAuditGraph,
  FinancialCouncilRebuttalTarget
} from "./financial-council-audit.js";

export interface RunFinancialCouncilRebuttalInput {
  readonly context: ActiveWorkspaceContext;
  readonly graph: FinancialCouncilAuditGraph;
  readonly target: FinancialCouncilRebuttalTarget;
  readonly originalFinding: FinancialCouncilFinding;
  readonly peerFinding: FinancialCouncilFinding;
  readonly baseInput: FinancialCouncilRebutInput;
}

export interface FinancialCouncilRebuttalCoordinatorOptions {
  readonly repository: FinancialCouncilRepository;
  readonly model: FinancialCouncilModelPort;
  readonly now: () => string;
  readonly validateOutput: (
    role: FinancialCouncilAgentRole,
    output: FinancialCouncilRebutOutput
  ) => FinancialCouncilRebutOutput;
}

function rebuttalInput(
  request: RunFinancialCouncilRebuttalInput
): FinancialCouncilRebutInput {
  const { graph, target, originalFinding, peerFinding } = request;
  if (target.round !== 1 || target.role !== originalFinding.agentRole
    || target.findingId !== originalFinding.findingId
    || target.peerFindingId !== peerFinding.findingId
    || graph.runId !== originalFinding.runId
    || graph.snapshotId !== originalFinding.snapshotId
    || graph.runId !== peerFinding.runId
    || graph.snapshotId !== peerFinding.snapshotId) {
    throw financialCouncilError("financial_council_rebuttal_invalid");
  }
  return immutableFinancialCouncilValue({
    ...request.baseInput,
    runId: graph.runId,
    snapshotId: graph.snapshotId,
    snapshotHash: graph.snapshotHash,
    role: target.role,
    attempt: 1,
    targetFindingId: target.findingId,
    conflictData: {
      edgeId: target.edgeId,
      kind: target.kind,
      sharedRefs: target.sharedRefs,
      validatorReason: target.validatorReason,
      originalClaim: {
        findingId: originalFinding.findingId,
        role: originalFinding.agentRole,
        conclusion: originalFinding.conclusion,
        evidenceRefs: originalFinding.evidenceRefs,
        formulaRef: originalFinding.formulaRef
      },
      peerClaim: {
        findingId: peerFinding.findingId,
        role: peerFinding.agentRole,
        conclusion: peerFinding.conclusion,
        evidenceRefs: peerFinding.evidenceRefs,
        formulaRef: peerFinding.formulaRef
      }
    }
  });
}

function reservation(
  request: RunFinancialCouncilRebuttalInput,
  input: FinancialCouncilRebutInput,
  createdAt: string
): FinancialCouncilRebuttalAttempt {
  const identity = {
    workspaceId: request.context.workspaceId,
    runId: request.graph.runId,
    graphId: request.graph.graphId,
    role: request.target.role,
    round: 1,
    edgeId: request.target.edgeId,
    targetFindingId: request.target.findingId
  } as const;
  const preimage = {
    attemptId: financialCouncilCanonicalHash(identity),
    ...identity,
    snapshotId: request.graph.snapshotId,
    snapshotHash: request.graph.snapshotHash,
    inputHash: financialCouncilCanonicalHash(input),
    input,
    status: "reserved" as const,
    result: null,
    outputHash: null,
    createdAt,
    completedAt: null
  };
  return immutableFinancialCouncilValue({
    ...preimage,
    attemptHash: financialCouncilCanonicalHash(preimage)
  });
}

export class FinancialCouncilRebuttalCoordinator {
  constructor(private readonly options: FinancialCouncilRebuttalCoordinatorOptions) {}

  async run(rawRequest: RunFinancialCouncilRebuttalInput,
    write?: FinancialCouncilLeaseWrite): Promise<
  FinancialCouncilCommandResult<FinancialCouncilRebuttalAttempt>> {
    const request = immutableFinancialCouncilInput(rawRequest);
    const requestedInput = rebuttalInput(request);
    const requestedReservation = reservation(
      request, requestedInput, this.options.now()
    );
    const reserved = await this.options.repository.reserveRebuttalAttempt(
      request.context, requestedReservation,
      write ? { lease: write.lease, completedAt: this.options.now() } : undefined
    );
    if (reserved.value.status === "completed") {
      return { value: reserved.value, replayed: true };
    }
    const input = reserved.value.input;
    const expectedContent = buildFinancialCouncilModelContent("rebut", input);
    let modelResult;
    let failure: unknown;
    for (let transportAttempt = 0; transportAttempt < 2;
      transportAttempt += 1) {
      try {
        modelResult = await this.options.model.rebut(input);
        break;
      } catch (error) {
        failure = error;
        if (!(error as { retryable?: unknown } | null)?.retryable) throw error;
      }
    }
    if (!modelResult) throw failure;
    if (modelResult.binding.jobId !== expectedContent.jobId
      || modelResult.binding.contentHash !== expectedContent.contentHash
      || modelResult.binding.runId !== input.runId
      || modelResult.binding.snapshotId !== input.snapshotId
      || modelResult.binding.snapshotHash !== input.snapshotHash
      || modelResult.binding.role !== input.role
      || modelResult.binding.phase !== "rebut"
      || modelResult.binding.attempt !== 1) {
      throw financialCouncilError("financial_council_rebuttal_invalid");
    }
    const output = this.options.validateOutput(
      input.role, modelResult.value
    );
    if (output.findingId !== input.targetFindingId) {
      throw financialCouncilError("financial_council_rebuttal_invalid");
    }
    const blocking = request.graph.edges.filter((edge) =>
      edge.findingIds.includes(input.targetFindingId))
      .map((edge) => edge.edgeId);
    const status = output.decision === "withdraw" ? "withdrawn"
      : output.decision === "revise" ? "revised" : "upheld";
    const completedAt = this.options.now();
    const completion: CompleteFinancialCouncilRebuttalInput = {
      attemptId: reserved.value.attemptId,
      inputHash: reserved.value.inputHash,
      result: immutableFinancialCouncilValue({ ...modelResult, value: output }),
      completedAt,
      disposition: {
        status,
        blockingConflictIds: output.decision === "withdraw" ? []
          : output.decision === "revise"
            ? blocking.filter((id) => id !== request.target.edgeId)
            : blocking
      }
    };
    return this.options.repository.completeRebuttalAttempt(
      request.context, completion,
      write ? { lease: write.lease, completedAt } : undefined
    );
  }
}

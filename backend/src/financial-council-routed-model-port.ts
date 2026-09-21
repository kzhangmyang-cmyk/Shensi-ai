import {
  FinancialCouncilModelError,
  type FinancialCouncilAnalyzeInput,
  type FinancialCouncilAnalyzeOutput,
  type FinancialCouncilAttemptModelPort,
  type FinancialCouncilModelPhase,
  type FinancialCouncilModelPort,
  type FinancialCouncilModelResult,
  type FinancialCouncilModelRole,
  type FinancialCouncilRebutInput,
  type FinancialCouncilRebutOutput,
  type FinancialCfoNarrativeInput,
  type FinancialCfoNarrativeOutput
} from "./financial-council-model-port.js";
import type { FinancialCouncilModelSelectionPort } from
  "./financial-council-model-selection.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { DurableModelRuntimeStore } from "./model-providers/runtime.js";
import { parseFinancialCouncilModelCallJobId } from
  "./financial-council-model-routing.js";

export interface FinancialCouncilAttemptFence {
  assertCurrent(input: {
    readonly runId: string;
    readonly role: FinancialCouncilModelRole;
    readonly phase: FinancialCouncilModelPhase;
    readonly attempt: number;
  }): Promise<void>;
}

export interface RoutedFinancialCouncilModelPortOptions {
  readonly selection: FinancialCouncilModelSelectionPort;
  readonly delegate: FinancialCouncilAttemptModelPort;
  readonly fence: FinancialCouncilAttemptFence;
}

function unavailable(): never {
  throw new FinancialCouncilModelError(
    "not_computable:model_connection_unavailable", false
  );
}

export function isRetryableFinancialCouncilProviderFailure(
  error: unknown
): error is FinancialCouncilModelError {
  return error instanceof FinancialCouncilModelError && error.retryable === true
    && ["financial_council_model_timeout",
      "financial_council_model_rate_limited",
      "financial_council_model_provider_failed"].includes(error.code);
}

export class RoutedFinancialCouncilModelPort implements FinancialCouncilModelPort {
  constructor(private readonly options: RoutedFinancialCouncilModelPortOptions) {
    if (!options?.selection || !options.delegate || !options.fence) {
      throw new TypeError("invalid_routed_financial_council_model_port");
    }
  }

  analyze(input: FinancialCouncilAnalyzeInput, workspace?: ActiveWorkspaceContext) {
    return this.run("analyze", input.role, input, workspace,
      (next, route) => this.options.delegate.analyze(next, route));
  }

  rebut(input: FinancialCouncilRebutInput, workspace?: ActiveWorkspaceContext) {
    return this.run("rebut", input.role, input, workspace,
      (next, route) => this.options.delegate.rebut(next, route));
  }

  synthesize(input: FinancialCfoNarrativeInput,
    workspace?: ActiveWorkspaceContext) {
    return this.run("synthesize", "cfo", input, workspace,
      (next, route) => this.options.delegate.synthesize(next, route));
  }

  private async run<Input extends { readonly ownerId: string;
    readonly teamId: string; readonly runId: string; readonly attempt: number },
  Output>(phase: FinancialCouncilModelPhase, role: FinancialCouncilModelRole,
    input: Input, workspace: ActiveWorkspaceContext | undefined,
    call: (input: Input, route: { readonly connectionId: string;
      readonly routingPolicyVersionId: string;
      readonly reasonCodes: readonly string[] }) => Promise<
      FinancialCouncilModelResult<Output>>): Promise<
      FinancialCouncilModelResult<Output>> {
    if (!workspace) unavailable();
    const selection = await this.options.selection.resolve({
      workspace, ownerId: input.ownerId, teamId: input.teamId,
      runId: input.runId, role, phase
    });
    if (selection.role !== role || selection.phase !== phase) unavailable();
    const routes = [...new Set(selection.orderedConnectionIds)].slice(0, 3);
    if (!routes.length) unavailable();
    let failure: unknown;
    for (const [index, connectionId] of routes.entries()) {
      const attempt = index + 1;
      try {
        const value = await call({ ...input, attempt } as Input, {
          connectionId,
          routingPolicyVersionId: selection.routingPolicyVersionId,
          reasonCodes: selection.reasonCodes
        });
        await this.options.fence.assertCurrent({
          runId: input.runId, role, phase, attempt
        });
        return value;
      } catch (error) {
        await this.options.fence.assertCurrent({
          runId: input.runId, role, phase, attempt
        });
        failure = error;
        if (!isRetryableFinancialCouncilProviderFailure(error)
          || attempt === 3) throw error;
      }
    }
    throw failure ?? new FinancialCouncilModelError(
      "not_computable:model_connection_unavailable", false
    );
  }
}

export class DurableFinancialCouncilAttemptFence
implements FinancialCouncilAttemptFence {
  constructor(private readonly store: Pick<DurableModelRuntimeStore,
    "aiJobModelSnapshots">) {}

  async assertCurrent(input: {
    readonly runId: string;
    readonly role: FinancialCouncilModelRole;
    readonly phase: FinancialCouncilModelPhase;
    readonly attempt: number;
  }): Promise<void> {
    const attempts = this.store.aiJobModelSnapshots.flatMap((snapshot) => {
      const parsed = parseFinancialCouncilModelCallJobId(snapshot.jobId);
      return parsed?.runId === input.runId && parsed.role === input.role
        && parsed.phase === input.phase ? [parsed.attempt] : [];
    });
    if (attempts.length && Math.max(...attempts) > input.attempt) {
      throw new FinancialCouncilModelError(
        "financial_council_model_snapshot_mismatch", false
      );
    }
  }
}

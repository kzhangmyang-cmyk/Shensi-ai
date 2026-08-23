import { requireGrowthCapabilities } from "./growth-capabilities.js";
import { financialCouncilError, type FinancialCouncilRun } from
  "./financial-council-domain.js";
import { FINANCIAL_COUNCIL_MODEL_ROLES } from
  "./financial-council-model-routing.js";
import type { FinancialCouncilModelRoutingRepository } from
  "./financial-council-model-routing-repository.js";
import type { FinancialCouncilRepository } from
  "./financial-council-repository.js";
import type { FinancialStatementPackageRepository } from
  "./financial-statement-package-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { FinancialCouncilModelRoutingRuntimeState } from
  "./model-providers/runtime.js";
import { parseFinancialCouncilModelCallJobId, type ModelCallRecord } from
  "./model-providers/call-ledger.js";

const ERROR_CODES = new Set([
  "MODEL_RATE_LIMITED", "MODEL_TIMEOUT", "MODEL_UNAVAILABLE",
  "MODEL_AUTH_FAILED", "MODEL_OUTPUT_INVALID", "MODEL_POLICY_CONFLICT",
  "MODEL_ERROR"
]);

function instant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function completedAt(call: ModelCallRecord): string | null {
  if (!instant(call.createdAt) || !Number.isSafeInteger(call.latencyMs)
    || call.latencyMs < 0) return null;
  const value = Date.parse(call.createdAt) + call.latencyMs;
  if (!Number.isSafeInteger(value) || value < 0
    || value > 8_640_000_000_000_000) return null;
  try { return new Date(value).toISOString(); } catch { return null; }
}

function scopeMatches(value: { ownerId: string; teamId: string | null },
  context: ActiveWorkspaceContext) {
  return context.kind === "team" ? value.teamId === context.workspaceId
    : value.ownerId === context.actorId && value.teamId === context.teamId;
}

function publicErrorCode(call: ModelCallRecord): string | null {
  if (call.status === "succeeded") return null;
  const code = call.error?.code;
  return typeof code === "string" && ERROR_CODES.has(code) ? code : "MODEL_ERROR";
}

function centerStatus(run: Pick<FinancialCouncilRun, "status"> | null,
  hasPackage: boolean, hasModels: boolean) {
  if (!hasPackage) return "not_connected" as const;
  if (!hasModels) return "model_error" as const;
  if (!run) return "ready" as const;
  if (["snapshot_frozen", "analyzing"].includes(run.status)) return "running" as const;
  if (["auditing", "synthesizing", "optimizing"].includes(run.status)) {
    return "waiting" as const;
  }
  if (["awaiting_approval", "approved"].includes(run.status)) return "completed" as const;
  if (["rejected", "stale", "expired", "not_computable"].includes(run.status)) {
    return "manual_review" as const;
  }
  return "model_error" as const;
}

function roleStatus(run: Pick<FinancialCouncilRun, "status"> | null,
  role: (typeof FINANCIAL_COUNCIL_MODEL_ROLES)[number], calls: readonly ModelCallRecord[]) {
  if (calls.some((call) => call.status === "succeeded")) return "completed" as const;
  if (calls.some((call) => call.status === "failed")) return "model_error" as const;
  if (!run) return "ready" as const;
  if (role === "cfo") {
    return ["synthesizing", "optimizing"].includes(run.status)
      ? "running" as const : "waiting" as const;
  }
  return ["analyzing", "auditing"].includes(run.status)
    ? "running" as const : "waiting" as const;
}

export class FinancialCouncilAgentCenter {
  constructor(private readonly dependencies: {
    readonly latestPackage: Pick<FinancialStatementPackageRepository,
      "getLatestVerified">;
    readonly latestRun: Pick<FinancialCouncilRepository,
      "findLatestRun" | "findRun">;
    readonly routing: Pick<FinancialCouncilModelRoutingRepository, "getCurrent">;
    readonly runtimeState: () => FinancialCouncilModelRoutingRuntimeState;
  }) {}

  private async state(context: ActiveWorkspaceContext) {
    requireGrowthCapabilities(context, ["finance.council.run"]);
    const [statementPackage, rawRun, routing] = await Promise.all([
      this.dependencies.latestPackage.getLatestVerified(context.workspaceId,
        Object.freeze({ limit: 1 })),
      this.dependencies.latestRun.findLatestRun(context,
        Object.freeze({ limit: 1 })),
      this.dependencies.routing.getCurrent(context)
    ]);
    const run = rawRun?.workspaceId === context.workspaceId ? rawRun : null;
    const runtime = this.dependencies.runtimeState();
    const eligible = runtime.connections.filter((connection) =>
      scopeMatches(connection, context) && connection.status === "active"
      && connection.capabilitySnapshot?.structuredOutput === true);
    return { statementPackage, run, routing, runtime, eligible };
  }

  async get(context: ActiveWorkspaceContext) {
    const { statementPackage, run, routing, runtime, eligible } =
      await this.state(context);
    return Object.freeze({
      data: Object.freeze({ status: statementPackage ? "ready" : "not_connected",
        packageId: statementPackage?.packageId ?? null,
        companyName: statementPackage?.companyName ?? null,
        period: statementPackage?.period ?? null,
        verifiedAt: statementPackage?.createdAt ?? null,
        warningCodes: Object.freeze(statementPackage?.warnings.map((item) =>
          item.code) ?? []) }),
      models: Object.freeze({ status: routing && eligible.length
        ? "ready" : "not_connected",
        routingPolicyVersionId: routing?.policyVersionId ?? null,
        roles: Object.freeze(FINANCIAL_COUNCIL_MODEL_ROLES.map((role) => {
          const calls = this.calls(runtime.recentCalls, context, run?.runId, role);
          const latest = calls.at(-1);
          const connection = latest
            ? runtime.connections.find((item) => item.id === latest.connectionId)
            : eligible[0];
          return Object.freeze({ role, status: roleStatus(run, role, calls),
            provider: connection?.provider ?? null,
            model: connection?.model ?? null,
            connectionDisplayName: connection ? this.displayName(connection) : null });
        })) }),
      latestRun: run ? Object.freeze({ runId: run.runId, status: run.status,
        revision: run.revision, updatedAt: run.updatedAt }) : null,
      capabilities: Object.freeze({
        canRun: context.capabilities.includes("finance.council.run"),
        canApprove: context.capabilities.includes("finance.council.approve"),
        canManageRouting: context.capabilities.includes(
          "finance.council.policy.manage")
      })
    });
  }

  async getRunAgents(context: ActiveWorkspaceContext, runId: string) {
    requireGrowthCapabilities(context, ["finance.council.run"]);
    if (typeof runId !== "string" || !runId.trim() || runId.length > 255) {
      throw financialCouncilError("financial_council_input_invalid");
    }
    const repository = this.dependencies.latestRun;
    const raw = typeof repository.findRun === "function"
      ? await repository.findRun(context, runId)
      : await repository.findLatestRun(context, Object.freeze({ limit: 1 }));
    if (!raw || raw.workspaceId !== context.workspaceId || raw.runId !== runId) {
      throw financialCouncilError("financial_council_run_not_found");
    }
    const runtime = this.dependencies.runtimeState();
    return Object.freeze({ runId: raw.runId, status: raw.status,
      revision: raw.revision, updatedAt: raw.updatedAt,
      roles: Object.freeze(FINANCIAL_COUNCIL_MODEL_ROLES.map((role) => {
        const calls = this.calls(runtime.recentCalls, context, runId, role);
        return Object.freeze({ role,
          phase: role === "cfo" ? "consensus" : "analysis",
          status: roleStatus(raw, role, calls),
          attempts: Object.freeze(calls.map((call) => {
            const parsed = parseFinancialCouncilModelCallJobId(call.jobId)!;
            const connection = runtime.connections.find((item) =>
              item.id === call.connectionId && scopeMatches(item, context));
            return Object.freeze({ attempt: parsed.attempt,
              provider: call.provider, model: call.model,
              connectionDisplayName: connection
                ? this.displayName(connection) : call.model,
              status: call.status, errorCode: publicErrorCode(call),
              startedAt: instant(call.createdAt) ? call.createdAt : null,
              completedAt: completedAt(call) });
          })) });
      })) });
  }

  private calls(calls: readonly ModelCallRecord[], context: ActiveWorkspaceContext,
    runId: string | undefined,
    role: (typeof FINANCIAL_COUNCIL_MODEL_ROLES)[number]) {
    if (!runId) return [];
    return calls.filter((call) => {
      const parsed = parseFinancialCouncilModelCallJobId(call.jobId);
      return parsed?.runId === runId && parsed.role === role
        && scopeMatches(call, context);
    }).sort((left, right) => {
      const a = parseFinancialCouncilModelCallJobId(left.jobId)!.attempt;
      const b = parseFinancialCouncilModelCallJobId(right.jobId)!.attempt;
      return a - b || left.id.localeCompare(right.id);
    });
  }

  private displayName(connection: object) {
    const name = Reflect.get(connection, "name");
    return typeof name === "string" && name.trim()
      ? name : String(Reflect.get(connection, "model"));
  }
}

import { randomUUID } from "node:crypto";
import type {
  AgentMessage
} from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage
} from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  acquisitionPublicPlanCreateSchema,
  type AcquisitionPublicPlanCreateInput
} from "./acquisition-plan-contract.js";
import {
  ACQUISITION_MODEL_CONTENT_BUNDLE,
  ACQUISITION_PLAN_DRAFT_PROMPT_ID,
  ACQUISITION_PLAN_DRAFT_SUBMIT_TOOL,
  ACQUISITION_PLAN_DRAFT_TOOL_SCHEMA_ID,
  acquisitionModelContentForSnapshot
} from "./acquisition-model-content.js";
import {
  planReadinessIssues
} from "./acquisition-plan-readiness.js";
import type {
  AcquisitionBudgetSnapshot,
  AcquisitionPlanPayload,
  AcquisitionProviderConnectionSnapshot,
  AcquisitionSubjectChannel,
  AcquisitionTargetPlatform
} from "./acquisition-plan-run-repository.js";
import {
  ACQUISITION_SEARCH_PROVIDER_IDS
} from "./acquisition-discovery-providers.js";
import {
  compileAcquisitionDiscoveryQueries
} from "./acquisition-douyin-discovery-plan.js";
import type {
  CreateAcquisitionJudgmentPortOptions
} from "./acquisition-judgment-port.js";
import {
  acquisitionPiModelSnapshotFromStored
} from "./acquisition-pi-runtime-factory.js";

export interface AcquisitionPlanDraftIntent {
  name: string;
  objective: string;
  icp: AcquisitionPlanPayload["icp"];
  subjectChannels: AcquisitionPlanPayload["subjectChannels"];
  queryIntents: Array<{
    subjectChannel: AcquisitionSubjectChannel;
    query: string;
  }>;
  budgetIntent: AcquisitionBudgetSnapshot;
  stopConditions: AcquisitionPlanPayload["stopConditions"];
}

const requiredText = (max: number) =>
  z.string().trim().min(1).max(max);
const safeNonNegativeInteger = z.number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const acquisitionPlanDraftIntentSchema:
z.ZodType<AcquisitionPlanDraftIntent> = z.object({
  name: requiredText(200),
  objective: requiredText(2_000),
  icp: z.object({
    industries: z.array(requiredText(120)).min(1).max(100),
    regions: z.array(requiredText(120)).min(1).max(100),
    organizationCriteria:
      z.array(requiredText(500)).min(1).max(100),
    individualCriteria:
      z.array(requiredText(500)).min(1).max(100),
    exclusionRules: z.array(requiredText(500)).max(200)
  }).strict(),
  subjectChannels: z.object({
    organization: z.boolean(),
    individual: z.boolean()
  }).strict(),
  queryIntents: z.array(z.object({
    subjectChannel: z.enum(["organization", "individual"]),
    query: requiredText(4_000)
  }).strict()).min(1).max(500),
  budgetIntent: z.object({
    billingCurrency: z.string().trim().length(3),
    maxRequests: safeNonNegativeInteger,
    maxResults: safeNonNegativeInteger,
    maxAmountMinor: safeNonNegativeInteger,
    maxDurationSeconds: safeNonNegativeInteger
  }).strict(),
  stopConditions: z.object({
    stopWhenBudgetExhausted: z.boolean(),
    stopWhenNoMoreResults: z.boolean()
  }).strict()
}).strict();

export interface AcquisitionActiveSearchConnectionDirectory {
  list(scope: {
    ownerId: string;
    teamId: string;
  }): Promise<AcquisitionProviderConnectionSnapshot[]>;
}

export interface AcquisitionPlanDraftGenerator {
  generate(input: {
    ownerId: string;
    teamId: string;
    actorId: string;
    sessionId: string;
    transcript: AgentMessage[];
    prompt: string;
    targetPlatform?: AcquisitionTargetPlatform;
  }): Promise<{
    summary: string;
    planDraft: AcquisitionPublicPlanCreateInput;
    assistantMessage: AgentMessage;
  }>;
}

export type AcquisitionPlanDraftErrorCode =
  | "MODEL_CONTENT_UPGRADE_REQUIRED"
  | "MODEL_RESPONSE_INVALID"
  | "MODEL_SNAPSHOT_MISMATCH"
  | "MODEL_TOOL_CALLING_UNAVAILABLE"
  | "PLAN_DRAFT_INTENT_INVALID"
  | "SEARCH_PROVIDER_CONNECTION_REQUIRED"
  | "PLAN_DRAFT_TOO_MANY_OPERATIONS"
  | "PLAN_DRAFT_BUDGET_TOO_SMALL"
  | "PLAN_DRAFT_NOT_READY";

export class AcquisitionPlanDraftError extends Error {
  readonly details: readonly string[] | null;

  constructor(
    readonly code: AcquisitionPlanDraftErrorCode,
    details: readonly string[] | null = null
  ) {
    super(code);
    this.name = "AcquisitionPlanDraftError";
    this.details = details ? Object.freeze([...details]) : null;
  }
}

function fail(
  code: AcquisitionPlanDraftErrorCode,
  details: readonly string[] | null = null
): never {
  throw new AcquisitionPlanDraftError(code, details);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function activeOfficialSearchConnections(
  rows: AcquisitionProviderConnectionSnapshot[],
  scope: { ownerId: string; teamId: string }
) {
  const approved = new Set<string>(ACQUISITION_SEARCH_PROVIDER_IDS);
  const filtered = rows.filter((row) => {
    const scoped = row as AcquisitionProviderConnectionSnapshot & {
      ownerId?: unknown;
      teamId?: unknown;
      scope?: unknown;
    };
    return row.kind === "search"
      && row.status === "active"
      && approved.has(row.providerId)
      && row.connectionId.trim().length > 0
      && Number.isSafeInteger(row.credentialVersion)
      && row.credentialVersion > 0
      && (scoped.ownerId === undefined
        || scoped.ownerId === scope.ownerId)
      && (scoped.teamId === undefined
        || scoped.teamId === scope.teamId)
      && (scoped.scope === undefined || scoped.scope === "personal");
  }).sort((left, right) =>
    compareText(left.providerId, right.providerId)
    || compareText(left.connectionId, right.connectionId)
  );
  const connectionIds = new Set<string>();
  return filtered.flatMap((row) => {
    if (connectionIds.has(row.connectionId)) return [];
    connectionIds.add(row.connectionId);
    return [{
      connectionId: row.connectionId,
      providerId: row.providerId,
      kind: "search" as const,
      status: "active" as const,
      credentialVersion: row.credentialVersion
    }];
  });
}

function distributedBudget(
  total: number,
  operationCount: number
) {
  const quotient = Math.floor(total / operationCount);
  const remainder = total % operationCount;
  return Array.from(
    { length: operationCount },
    (_, index) => quotient + (index < remainder ? 1 : 0)
  );
}

function assertSufficientBudget(
  budget: AcquisitionBudgetSnapshot,
  operationCount: number
) {
  if (budget.maxRequests < operationCount
    || budget.maxResults < operationCount
    || budget.maxDurationSeconds < operationCount) {
    fail("PLAN_DRAFT_BUDGET_TOO_SMALL");
  }
}

function immutableModelSnapshot(
  snapshot: Parameters<
    typeof acquisitionPiModelSnapshotFromStored
  >[0]
) {
  const stored = acquisitionPiModelSnapshotFromStored(snapshot);
  return {
    jobSnapshotId: stored.jobId,
    connectionId: stored.connectionId,
    credentialVersion: stored.credentialVersion,
    provider: stored.provider,
    model: stored.model,
    capabilitySnapshotHash: stored.capabilitySnapshotHash,
    promptVersion: stored.promptVersion,
    schemaVersion: stored.schemaVersion,
    promptHash: stored.promptHash,
    schemaHash: stored.schemaHash
  };
}

function assistantMessage(
  snapshot: Parameters<
    typeof acquisitionPiModelSnapshotFromStored
  >[0],
  summary: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  }
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: summary }],
    api: "goodjob-gateway",
    provider: snapshot.provider,
    model: snapshot.model,
    usage: {
      input: usage.inputTokens,
      output: usage.outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: usage.reasoningTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason: "stop",
    timestamp: Date.now()
  };
}

export function createAcquisitionPlanDraftGenerator(options: {
  resolveSession:
    CreateAcquisitionJudgmentPortOptions["resolveSession"];
  connections: AcquisitionActiveSearchConnectionDirectory;
  idFactory?: (prefix: string) => string;
}): AcquisitionPlanDraftGenerator {
  const idFactory = options.idFactory
    ?? ((prefix: string) => `${prefix}_${randomUUID()}`);
  return {
    async generate(input) {
      const targetPlatform = input.targetPlatform ?? "web";
      const resolved = await options.resolveSession({
        ownerId: input.ownerId,
        teamId: input.teamId,
        sessionId: input.sessionId
      });
      if (resolved.snapshot.ownerId !== input.ownerId
        || resolved.snapshot.teamId !== input.teamId) {
        fail("MODEL_SNAPSHOT_MISMATCH");
      }
      const contentBundle =
        acquisitionModelContentForSnapshot(resolved.snapshot);
      if (contentBundle !== ACQUISITION_MODEL_CONTENT_BUNDLE) {
        fail("MODEL_CONTENT_UPGRADE_REQUIRED");
      }
      if (!resolved.snapshot.capabilitySnapshot.toolCalling) {
        fail("MODEL_TOOL_CALLING_UNAVAILABLE");
      }

      const connections = activeOfficialSearchConnections(
        await options.connections.list({
          ownerId: input.ownerId,
          teamId: input.teamId
        }),
        {
          ownerId: input.ownerId,
          teamId: input.teamId
        }
      );
      if (!connections.length) {
        fail("SEARCH_PROVIDER_CONNECTION_REQUIRED");
      }

      const result = await resolved.gateway.callTools({
        contentBinding: {
          promptId: ACQUISITION_PLAN_DRAFT_PROMPT_ID,
          toolSchemaId: ACQUISITION_PLAN_DRAFT_TOOL_SCHEMA_ID,
          dynamicData: {
            conversation: structuredClone(input.transcript),
            prompt: input.prompt,
            targetPlatform
          }
        },
        parallelToolCalls: false
      });
      if (result.toolCalls.length !== 1
        || result.toolCalls[0]?.name
          !== ACQUISITION_PLAN_DRAFT_SUBMIT_TOOL) {
        fail("MODEL_RESPONSE_INVALID");
      }
      const intent = acquisitionPlanDraftIntentSchema.safeParse(
        result.toolCalls[0].arguments
      );
      if (!intent.success) {
        fail("PLAN_DRAFT_INTENT_INVALID");
      }

      let compiledQueryIntents: ReturnType<
        typeof compileAcquisitionDiscoveryQueries
      >;
      try {
        compiledQueryIntents = compileAcquisitionDiscoveryQueries({
          targetPlatform,
          queryIntents: intent.data.queryIntents
        });
      } catch {
        fail("PLAN_DRAFT_INTENT_INVALID");
      }
      const operationCount =
        compiledQueryIntents.length * connections.length;
      if (!Number.isSafeInteger(operationCount)
        || operationCount > 500) {
        fail("PLAN_DRAFT_TOO_MANY_OPERATIONS");
      }
      if (operationCount < 1) {
        fail("PLAN_DRAFT_NOT_READY", ["operation_required"]);
      }
      assertSufficientBudget(intent.data.budgetIntent, operationCount);
      const requests = distributedBudget(
        intent.data.budgetIntent.maxRequests,
        operationCount
      );
      const results = distributedBudget(
        intent.data.budgetIntent.maxResults,
        operationCount
      );
      const amounts = distributedBudget(
        intent.data.budgetIntent.maxAmountMinor,
        operationCount
      );
      const durations = distributedBudget(
        intent.data.budgetIntent.maxDurationSeconds,
        operationCount
      );
      let operationIndex = 0;
      const operations = compiledQueryIntents.flatMap((queryIntent) =>
        connections.map((connection) => {
          const index = operationIndex;
          operationIndex += 1;
          return {
            operationId: idFactory("operation"),
            subjectChannel: queryIntent.subjectChannel,
            kind: "search" as const,
            connectionId: connection.connectionId,
            query: queryIntent.query,
            allocatedBudget: {
              requests: requests[index]!,
              results: results[index]!,
              amountMinor: amounts[index]!,
              durationSeconds: durations[index]!
            }
          };
        })
      );
      const candidate: AcquisitionPublicPlanCreateInput = {
        targetPlatform,
        name: intent.data.name,
        objective: intent.data.objective,
        icp: structuredClone(intent.data.icp),
        subjectChannels:
          structuredClone(intent.data.subjectChannels),
        providerConnections: connections.map(
          (connection) => ({ ...connection })
        ),
        operations,
        budgetSnapshot: structuredClone(intent.data.budgetIntent),
        modelConnectionId: resolved.snapshot.connectionId,
        stopConditions:
          structuredClone(intent.data.stopConditions)
      };
      const parsed = acquisitionPublicPlanCreateSchema.safeParse(candidate);
      if (!parsed.success) {
        fail("PLAN_DRAFT_NOT_READY", ["public_plan_schema_invalid"]);
      }
      const readinessIssues = planReadinessIssues({
        ...parsed.data,
        modelSnapshotRef: immutableModelSnapshot(resolved.snapshot)
      });
      if (readinessIssues.length) {
        fail("PLAN_DRAFT_NOT_READY", readinessIssues);
      }
      const summary = [
        `已生成可审批的获客计划草稿“${intent.data.name}”`,
        `，包含 ${operations.length} 个公开搜索操作。`
      ].join("");
      return {
        summary,
        planDraft: parsed.data,
        assistantMessage: assistantMessage(
          resolved.snapshot,
          summary,
          result.usage
        )
      };
    }
  };
}

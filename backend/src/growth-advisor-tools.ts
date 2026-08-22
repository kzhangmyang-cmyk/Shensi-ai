import { createHash } from "node:crypto";
import {
  Type,
  type TSchema
} from "typebox";
import { z } from "zod";
import { canonicalJsonStringify } from "./canonical-json.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { CommandContext } from "./growth-command-context.js";
import {
  assertResolvedAcquisitionWorkspace,
  type GrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";
import type {
  AcquisitionAgentIdentity,
  AcquisitionAgentToolExecutor,
  AcquisitionToolExecutionInput
} from "./acquisition-pi-tools.js";
import type {
  GrowthAcquisitionToolDelegate,
  AcquisitionToolResultLedgerPort
} from "./acquisition-tool-executor.js";
import type {
  AcquisitionCopilotRepository,
  AcquisitionCopilotSession
} from "./acquisition-copilot-service.js";
import type {
  GrowthCapability
} from "./growth-capabilities.js";
import type { GrowthCommercialToolPorts } from "./growth-commercial-application.js";

export const ADVISOR_TOOL_NAMES = Object.freeze([
  "get_growth_performance",
  "list_financial_data_gaps",
  "create_advisor_recommendation",
  "create_sales_todo",
  "record_recommendation_outcome"
] as const);

export type AdvisorToolName = typeof ADVISOR_TOOL_NAMES[number];

export interface GrowthAdvisorToolBlueprint {
  readonly name: AdvisorToolName;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly executionMode: "parallel" | "sequential";
  readonly schemaVersion: "growth-advisor-tool.v1";
}

const token = () => Type.String({ minLength: 1, maxLength: 191 });
const hash = () => Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const dateTime = () => Type.String({ format: "date-time" });

const growthPerformanceInput = () => Type.Object({
  currency: Type.String({ pattern: "^[A-Z]{3}$" }),
  asOf: dateTime(),
  planId: Type.Optional(Type.Union([token(), Type.Null()])),
  cohortId: Type.Optional(token())
}, { additionalProperties: false });

const financialDataGapsInput = () => Type.Object({
  currency: Type.String({ pattern: "^[A-Z]{3}$" }),
  asOf: dateTime(),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
}, { additionalProperties: false });

const advisorRecommendationInput = () => Type.Object({
  audienceRole: Type.Union([
    Type.Literal("sales"), Type.Literal("manager"),
    Type.Literal("admin"), Type.Literal("super_admin")
  ]),
  type: Type.Union([
    Type.Literal("priority_customer"), Type.Literal("quote_risk"),
    Type.Literal("roi_opportunity"), Type.Literal("data_gap")
  ]),
  summary: Type.String({ minLength: 1, maxLength: 4_000 }),
  rationale: Type.String({ minLength: 1, maxLength: 8_000 }),
  metricRefs: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  evidenceRefs: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  entityRefs: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  confidenceBps: Type.Integer({ minimum: 0, maximum: 10_000 }),
  riskLevel: Type.Union([
    Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")
  ]),
  recommendedAction: Type.Record(Type.String(), Type.Unknown()),
  assignedTo: Type.Optional(Type.Union([token(), Type.Null()])),
  dataAsOf: dateTime(),
  modelSnapshotRef: token(),
  promptVersion: Type.String({ minLength: 1 }),
  generationIdempotencyKey: token()
}, { additionalProperties: false });

const salesTodoInput = () => Type.Object({
  customerId: token(),
  dueAt: dateTime()
}, { additionalProperties: false });

const recommendationOutcomeInput = () => Type.Object({
  recommendationId: token(),
  recommendationRevision: Type.Integer({ minimum: 1 })
}, { additionalProperties: false });

const zText = z.string().trim().min(1).max(191);

export const ADVISOR_TOOL_INPUT_SCHEMAS = Object.freeze({
  get_growth_performance: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    asOf: z.string().min(20).max(35),
    planId: zText.nullable().optional(),
    cohortId: zText.optional()
  }).strict(),
  list_financial_data_gaps: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    asOf: z.string().min(20).max(35),
    limit: z.number().int().min(1).max(100).optional()
  }).strict(),
  create_advisor_recommendation: z.object({
    audienceRole: z.enum(["sales", "manager", "admin", "super_admin"]),
    type: z.enum([
      "priority_customer", "quote_risk", "roi_opportunity", "data_gap"
    ]),
    summary: z.string().min(1).max(4_000),
    rationale: z.string().min(1).max(8_000),
    metricRefs: z.array(z.record(z.string(), z.unknown())),
    evidenceRefs: z.array(z.record(z.string(), z.unknown())),
    entityRefs: z.array(z.record(z.string(), z.unknown())),
    confidenceBps: z.number().int().min(0).max(10_000),
    riskLevel: z.enum(["low", "medium", "high"]),
    recommendedAction: z.record(z.string(), z.unknown()),
    assignedTo: zText.nullable().optional(),
    dataAsOf: z.string().min(20).max(35),
    modelSnapshotRef: zText,
    promptVersion: z.string().min(1),
    generationIdempotencyKey: zText
  }).strict(),
  create_sales_todo: z.object({
    customerId: zText,
    dueAt: z.string().min(20).max(35)
  }).strict(),
  record_recommendation_outcome: z.object({
    recommendationId: zText,
    recommendationRevision: z.number().int().min(1)
  }).strict()
});

function blueprint(
  name: AdvisorToolName,
  label: string,
  description: string,
  parameters: TSchema,
  executionMode: "parallel" | "sequential"
): GrowthAdvisorToolBlueprint {
  return Object.freeze({
    name, label, description, parameters, executionMode,
    schemaVersion: "growth-advisor-tool.v1"
  });
}

export const ADVISOR_TOOL_BLUEPRINTS:
readonly GrowthAdvisorToolBlueprint[] = Object.freeze([
  blueprint("get_growth_performance", "读取增长绩效",
    "读取权威的预计/实际 ROI；不会修改任何状态。",
    growthPerformanceInput(), "parallel"),
  blueprint("list_financial_data_gaps", "列出财务数据缺口",
    "列出当前可见绑定范围内的未核验/缺失财务数据缺口。",
    financialDataGapsInput(), "parallel"),
  blueprint("create_advisor_recommendation", "创建增长建议",
    "把权威事实组织成一条可追溯、引用强校验的建议。",
    advisorRecommendationInput(), "sequential"),
  blueprint("create_sales_todo", "创建销售待办",
    "为指定客户创建一条受控销售待办。",
    salesTodoInput(), "sequential"),
  blueprint("record_recommendation_outcome", "记录建议结果",
    "按冻结 revision 分发建议的唯一受控动作并记录回执。",
    recommendationOutcomeInput(), "sequential")
]);

function sha(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value) ?? "")
    .digest("hex")}`;
}

export interface GrowthAdvisorToolResultEnvelope {
  readonly kind: "growth_advisor_tool_result";
  readonly toolName: AdvisorToolName;
  readonly workspaceId: string;
  readonly dataAsOf: string;
  readonly authorityRefs: readonly unknown[];
  readonly internalSnapshot: unknown;
  readonly modelSnapshotRef: unknown;
  readonly promptSnapshotRef: unknown;
  readonly toolSchemaVersion: "growth-advisor-tool.v1";
  readonly stableCallHash: `sha256:${string}`;
}

function redactedExpectedView(view: {
  currency: string;
  status: string;
  reason: string | null;
  roiBps: number | null;
  formulaVersion: string;
  amountVisibility?: string;
  probabilityWeightedGrossProfitMinor?: number | null;
  attributedEstimatedCostMinor?: number | null;
}): unknown {
  return Object.freeze({
    currency: view.currency,
    status: view.status,
    reason: view.reason,
    roiBps: view.roiBps,
    formulaVersion: view.formulaVersion,
    amountVisibility: "redacted"
  });
}

export class GrowthAdvisorToolReplayProjector {
  authorizeAndProjectCached(
    context: ActiveWorkspaceContext,
    envelope: GrowthAdvisorToolResultEnvelope
  ): unknown {
    if (envelope.workspaceId !== context.workspaceId) {
      throw new Error("FORBIDDEN");
    }
    if (envelope.toolName === "get_growth_performance") {
      if (!context.capabilities.includes("growth.performance.workspace.read")
        && !context.capabilities.includes("growth.performance.team.read")) {
        throw new Error("FORBIDDEN");
      }
      const snapshot = envelope.internalSnapshot as {
        expectedRoiByCurrency?: Array<{
          currency: string;
          status: string;
          reason: string | null;
          roiBps: number | null;
          formulaVersion: string;
          amountVisibility?: string;
        }>;
        actualRoiByCurrency?: unknown[];
      };
      const sensitive = context.capabilities.includes("pricing.sensitive.read");
      const expectedRoiByCurrency = (snapshot.expectedRoiByCurrency ?? [])
        .map((view) => sensitive ? view : redactedExpectedView(view));
      return Object.freeze({
        ...snapshot,
        expectedRoiByCurrency: Object.freeze(expectedRoiByCurrency),
        amountVisibility: sensitive ? "full" : "redacted"
      });
    }
    return envelope.internalSnapshot;
  }
}

export interface GrowthAdvisorToolExecutorOptions {
  toolPorts: GrowthCommercialToolPorts;
  resultLedger: AcquisitionToolResultLedgerPort;
  modelSnapshotRef?: unknown;
  promptSnapshotRef?: unknown;
  now?: () => string;
}

export class GrowthAdvisorToolExecutor implements AcquisitionAgentToolExecutor {
  private readonly options: GrowthAdvisorToolExecutorOptions;
  private readonly projector = new GrowthAdvisorToolReplayProjector();
  private readonly now: () => string;

  constructor(options: GrowthAdvisorToolExecutorOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async executeResolved(
    call: {
      name: AdvisorToolName;
      input: unknown;
      stableCallHash: `sha256:${string}`;
    },
    context: ActiveWorkspaceContext,
    attempt: Readonly<{
      identity: AcquisitionAgentIdentity;
      idempotencyKey: string;
      modelSnapshotRef?: unknown;
      promptSnapshotRef?: unknown;
    }> = {
      identity: {
        ownerId: context.actorId, teamId: context.teamId,
        actorId: context.actorId, sessionId: "growth-advisor-direct"
      },
      idempotencyKey: `growth-advisor:${call.stableCallHash}`
    }
  ): Promise<unknown> {
    if (!ADVISOR_TOOL_NAMES.includes(call.name)) {
      throw new Error("unknown_growth_advisor_tool");
    }
    const parsed: Record<string, unknown> =
      ADVISOR_TOOL_INPUT_SCHEMAS[call.name].parse(call.input);
    const revision = call.name === "record_recommendation_outcome"
      ? Number(parsed.recommendationRevision) : null;
    const domainInput = { ...parsed };
    delete domainInput.recommendationRevision;
    const command: CommandContext = Object.freeze({
      workspace: context,
      actorId: context.actorId,
      idempotencyKey: `growth-advisor:${call.stableCallHash}`,
      requestHash: sha({
        toolName: call.name,
        payload: domainInput,
        expectedRevision: revision
      }),
      expectedRevision: revision
    });
    const envelope = await this.options.resultLedger.executeOnce<
      GrowthAdvisorToolResultEnvelope
    >({
      ...attempt.identity,
      toolName: call.name,
      idempotencyKey: `growth-advisor:${attempt.idempotencyKey}`,
      requestHash: call.stableCallHash
    }, async () => {
      const rawSnapshot = await this.options.toolPorts.execute({
        ...call,
        name: call.name,
        input: domainInput
      }, command);
      const snapshot = rawSnapshot && typeof rawSnapshot === "object"
        && Object.hasOwn(rawSnapshot, "value")
        && typeof Reflect.get(rawSnapshot, "replayed") === "boolean"
        ? Reflect.get(rawSnapshot, "value") : rawSnapshot;
      const dataAsOf = snapshot && typeof snapshot === "object"
        && typeof Reflect.get(snapshot, "dataAsOf") === "string"
        ? String(Reflect.get(snapshot, "dataAsOf")) : this.now();
      return Object.freeze({
        kind: "growth_advisor_tool_result",
        toolName: call.name,
        workspaceId: context.workspaceId,
        dataAsOf,
        authorityRefs: Object.freeze([]),
        internalSnapshot: structuredClone(snapshot),
        modelSnapshotRef: structuredClone(
          attempt.modelSnapshotRef ?? this.options.modelSnapshotRef
        ),
        promptSnapshotRef: structuredClone(
          attempt.promptSnapshotRef ?? this.options.promptSnapshotRef
        ),
        toolSchemaVersion: "growth-advisor-tool.v1",
        stableCallHash: call.stableCallHash
      });
    });
    return this.projector.authorizeAndProjectCached(context, envelope);
  }

  async execute(input: AcquisitionToolExecutionInput): Promise<unknown> {
    if (!ADVISOR_TOOL_NAMES.includes(input.toolName as AdvisorToolName)) {
      throw new Error("UNKNOWN_TOOL");
    }
    const name = input.toolName as AdvisorToolName;
    const parsed = ADVISOR_TOOL_INPUT_SCHEMAS[name].parse(input.payload);
    const stableCallHash = sha({
      schemaVersion: "growth-advisor-tool-call.v1",
      workspaceId: input.identity.teamId,
      toolName: name,
      idempotencyKey: input.idempotencyKey,
      input: parsed
    });
    const context: ActiveWorkspaceContext = Object.freeze({
      workspaceId: input.identity.teamId,
      kind: "team",
      actorId: input.identity.actorId,
      role: "manager",
      teamId: input.identity.teamId,
      capabilities: Object.freeze([]),
      capabilityRegistryVersion: "growth-capabilities.v1"
    });
    return this.executeResolved({
      name, input: parsed, stableCallHash
    }, context, {
      identity: input.identity,
      idempotencyKey: input.idempotencyKey
    });
  }
}

export interface GrowthAdvisorCurrentActor {
  readonly id: string;
  readonly teamId: string;
  readonly role: ActiveWorkspaceContext["role"];
  readonly status: "active" | "disabled";
  readonly capabilities: readonly GrowthCapability[];
  readonly capabilityRegistryVersion: string;
}

export interface GrowthAdvisorAcquisitionToolDelegateOptions {
  workspaceResolver: GrowthAcquisitionWorkspaceResolver;
  sessions: Pick<AcquisitionCopilotRepository, "findSession">;
  resolveCurrentActor(identity: AcquisitionAgentIdentity):
    Promise<GrowthAdvisorCurrentActor | null>;
  executor: GrowthAdvisorToolExecutor;
}

export class GrowthAdvisorAcquisitionToolDelegate
implements GrowthAcquisitionToolDelegate {
  constructor(
    private readonly options: GrowthAdvisorAcquisitionToolDelegateOptions
  ) {}

  owns(toolName: string): boolean {
    return ADVISOR_TOOL_NAMES.includes(toolName as AdvisorToolName);
  }

  async execute(input: AcquisitionToolExecutionInput): Promise<unknown> {
    if (!this.owns(input.toolName)) throw new Error("UNKNOWN_TOOL");
    const session: AcquisitionCopilotSession | undefined =
      await this.options.sessions.findSession(
        input.identity, input.identity.sessionId
      );
    if (!session || session.status !== "active"
      || session.actorId !== input.identity.actorId) {
      throw new Error("invalid_copilot_identity");
    }
    const [resolved, actor] = await Promise.all([
      this.options.workspaceResolver.resolve(input.identity),
      this.options.resolveCurrentActor(input.identity)
    ]);
    const workspace = assertResolvedAcquisitionWorkspace(resolved);
    if (!actor || actor.status !== "active" || actor.id !== session.actorId
      || actor.teamId !== input.identity.teamId
      || workspace.ownerId !== input.identity.ownerId
      || workspace.teamId !== input.identity.teamId) {
      throw new Error("invalid_copilot_identity");
    }
    const context: ActiveWorkspaceContext = Object.freeze({
      workspaceId: workspace.workspaceId,
      kind: workspace.kind,
      actorId: actor.id,
      role: actor.role,
      teamId: actor.teamId,
      capabilities: Object.freeze([...actor.capabilities]),
      capabilityRegistryVersion: actor.capabilityRegistryVersion
    });
    const name = input.toolName as AdvisorToolName;
    const parsed = ADVISOR_TOOL_INPUT_SCHEMAS[name].parse(input.payload);
    const stableCallHash = sha({
      schemaVersion: "growth-advisor-tool-call.v1",
      workspaceId: context.workspaceId,
      toolName: name,
      idempotencyKey: input.idempotencyKey,
      input: parsed
    });
    return this.options.executor.executeResolved({
      name, input: parsed, stableCallHash
    }, context, {
      identity: input.identity,
      idempotencyKey: input.idempotencyKey,
      modelSnapshotRef: session.modelSnapshot,
      promptSnapshotRef: Object.freeze({
        promptVersion: session.modelSnapshot.promptVersion,
        promptHash: session.modelSnapshot.promptHash
      })
    });
  }
}

export function composeGrowthAcquisitionToolDelegates(
  quote: GrowthAcquisitionToolDelegate,
  advisor: GrowthAcquisitionToolDelegate
): GrowthAcquisitionToolDelegate {
  const owned = new Map<string, GrowthAcquisitionToolDelegate>();
  for (const delegate of [quote, advisor]) {
    for (const name of GROWTH_ALL_DELEGATE_NAMES) {
      if (!delegate.owns(name)) continue;
      if (owned.has(name)) {
        throw new Error("GROWTH_TOOL_DELEGATE_OWNERSHIP_OVERLAP");
      }
      owned.set(name, delegate);
    }
  }
  return Object.freeze({
    owns(toolName: string): boolean {
      return owned.has(toolName);
    },
    async execute(input: AcquisitionToolExecutionInput): Promise<unknown> {
      const delegate = owned.get(input.toolName);
      if (!delegate) throw new Error("UNKNOWN_TOOL");
      return delegate.execute(input);
    }
  });
}

export const GROWTH_ALL_DELEGATE_NAMES = Object.freeze([
  "list_catalog_items",
  "get_pricing_policy",
  "preview_quote",
  "create_quote_draft",
  "list_pending_quote_approvals",
  "get_quote_decision",
  "create_quote_approval_task",
  ...ADVISOR_TOOL_NAMES
] as const);

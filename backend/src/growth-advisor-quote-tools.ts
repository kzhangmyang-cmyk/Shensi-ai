import { createHash } from "node:crypto";
import { z } from "zod";
import { Type, type TSchema } from "typebox";
import { canonicalJsonStringify } from "./canonical-json.js";
import type {
  AcquisitionAgentIdentity,
  AcquisitionToolExecutionInput
} from "./acquisition-pi-tools.js";
import type {
  AcquisitionToolResultLedgerPort,
  GrowthAcquisitionToolDelegate
} from "./acquisition-tool-executor.js";
import type {
  AcquisitionCopilotRepository,
  AcquisitionCopilotSession
} from "./acquisition-copilot-service.js";
import {
  requireGrowthCapabilities,
  type GrowthCapability
} from "./growth-capabilities.js";
import type {
  GrowthCommercialToolCall,
  GrowthCommercialToolName,
  GrowthCommercialToolPorts
} from "./growth-commercial-application.js";
import type { GrowthCatalogServices } from "./growth-catalog-module.js";
import type { CommandContext } from "./growth-command-context.js";
import type { GrowthTemporalBarrier } from "./growth-temporal-barrier.js";
import {
  assertResolvedAcquisitionWorkspace,
  type ActiveWorkspaceContext,
  type GrowthAcquisitionWorkspaceResolver
} from "./growth-workspace-context.js";
import type {
  QuoteApprovalAsOfReader,
  QuoteVersionEvidenceReader
} from "./authoritative-quote-reader.js";
import type { QuoteCommandExecution } from "./quote-case-service.js";
import type {
  CreateQuoteVersionInput,
  QuotePreviewInput,
  QuotePreviewResult
} from "./quote-version-service.js";
import type { QuoteApproval, QuoteVersion } from "./quote-repository.js";

export const GROWTH_QUOTE_TOOL_NAMES = Object.freeze([
  "list_catalog_items",
  "get_pricing_policy",
  "preview_quote",
  "create_quote_draft",
  "list_pending_quote_approvals",
  "get_quote_decision",
  "create_quote_approval_task"
] as const);

export type GrowthQuoteToolName = typeof GROWTH_QUOTE_TOOL_NAMES[number];

export interface GrowthQuoteToolBlueprint {
  readonly name: GrowthQuoteToolName;
  readonly label: string;
  readonly description: string;
  readonly parameters: TSchema;
  readonly executionMode: "parallel" | "sequential";
  readonly schemaVersion: "growth-quote-tool.v1";
}

const token = () => Type.String({ minLength: 1, maxLength: 191 });
const hash = () => Type.String({ pattern: "^sha256:[a-f0-9]{64}$" });
const money = () => Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const nullableText = () => Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
const quoteInput = () => Type.Object({
  catalogItemId: token(),
  pricingPolicyVersionId: token(),
  quantityMicros: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  offeredUnitPriceMinor: money(),
  orderDiscountMinor: money(),
  paymentTermDays: money(),
  giftItems: Type.Array(Type.Object({
    catalogItemId: token(),
    quantityMicros: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
  }, { additionalProperties: false })),
  surchargeContext: Type.Object({
    region: nullableText(),
    deliveryMethod: nullableText()
  }, { additionalProperties: false }),
  customerTargetPriceMinor: Type.Union([money(), Type.Null()]),
  creditRiskBps: Type.Union([
    Type.Integer({ minimum: 0, maximum: 10_000 }), Type.Null()
  ]),
  manualEscalation: Type.Boolean()
}, { additionalProperties: false });
const previewIdentity = () => Type.Object({
  inputSnapshotHash: hash(),
  calculationHash: hash(),
  pricingPolicyVersionId: token(),
  pricingPolicyRevision: Type.Integer({ minimum: 1 }),
  packageVersionId: Type.Union([token(), Type.Null()]),
  formulaVersion: Type.Literal("quote-calculation.v1")
}, { additionalProperties: false });

function blueprint(
  name: GrowthQuoteToolName,
  label: string,
  description: string,
  parameters: TSchema,
  executionMode: "parallel" | "sequential"
): GrowthQuoteToolBlueprint {
  return Object.freeze({
    name, label, description, parameters, executionMode,
    schemaVersion: "growth-quote-tool.v1"
  });
}

export const GROWTH_QUOTE_TOOL_BLUEPRINTS:
readonly GrowthQuoteToolBlueprint[] = Object.freeze([
  blueprint("list_catalog_items", "列出报价目录",
    "读取当前工作区的可报价目录；不会修改目录。",
    Type.Object({
      cursor: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
      limit: Type.Integer({ minimum: 1, maximum: 100 }),
      sort: Type.Optional(Type.Union([
        Type.Literal("code"), Type.Literal("name"), Type.Literal("updatedAt")
      ]))
    }, { $id: "growth-quote.list-catalog-items.input.v1",
      additionalProperties: false }), "parallel"),
  blueprint("get_pricing_policy", "读取定价政策",
    "读取一个当前工作区定价政策；敏感金额按当前权限投影。",
    Type.Object({ pricingPolicyVersionId: token() },
      { $id: "growth-quote.get-pricing-policy.input.v1",
        additionalProperties: false }), "parallel"),
  blueprint("preview_quote", "预览报价",
    "按服务端目录和计算规则生成确定性报价预览。",
    Type.Object({
      quoteCaseId: token(),
      quoteCaseRevision: Type.Integer({ minimum: 1 }),
      quoteInput: quoteInput()
    }, { $id: "growth-quote.preview.input.v1",
      additionalProperties: false }), "sequential"),
  blueprint("create_quote_draft", "创建报价草稿",
    "保存服务端重新计算的报价草稿；不会提交、审批或发送。",
    Type.Object({
      quoteCaseId: token(),
      quoteCaseRevision: Type.Integer({ minimum: 1 }),
      quoteInput: quoteInput(),
      previewIdentity: previewIdentity()
    }, { $id: "growth-quote.create-draft.input.v1",
      additionalProperties: false }), "sequential"),
  blueprint("list_pending_quote_approvals", "列出待审批报价",
    "按冻结时点读取当前工作区可见的待审批报价。",
    Type.Object({ limit: Type.Integer({ minimum: 1, maximum: 100 }) },
      { $id: "growth-quote.list-pending-approvals.input.v1",
        additionalProperties: false }), "parallel"),
  blueprint("get_quote_decision", "读取报价决定证据",
    "按冻结时点读取报价版本的权威生命周期与金额证据。",
    Type.Object({ quoteVersionId: token() },
      { $id: "growth-quote.get-decision.input.v1",
        additionalProperties: false }), "parallel"),
  blueprint("create_quote_approval_task", "创建报价审批任务",
    "从不可变草稿追加正式已提交版本和审批任务；不会批准报价。",
    Type.Object({
      quoteVersionId: token(),
      quoteVersionRevision: Type.Integer({ minimum: 1 })
    }, { $id: "growth-quote.create-approval-task.input.v1",
      additionalProperties: false }), "sequential")
]);

const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const text = z.string().trim().min(1).max(191);
const moneySchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const quoteInputSchema = z.object({
  catalogItemId: text,
  pricingPolicyVersionId: text,
  quantityMicros: positive,
  offeredUnitPriceMinor: moneySchema,
  orderDiscountMinor: moneySchema,
  paymentTermDays: moneySchema,
  giftItems: z.array(z.object({
    catalogItemId: text, quantityMicros: positive
  }).strict()),
  surchargeContext: z.object({
    region: z.string().trim().min(1).nullable(),
    deliveryMethod: z.string().trim().min(1).nullable()
  }).strict(),
  customerTargetPriceMinor: moneySchema.nullable(),
  creditRiskBps: z.number().int().min(0).max(10_000).nullable(),
  manualEscalation: z.boolean()
}).strict();
const previewIdentitySchema = z.object({
  inputSnapshotHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  calculationHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  pricingPolicyVersionId: text,
  pricingPolicyRevision: positive,
  packageVersionId: text.nullable(),
  formulaVersion: z.literal("quote-calculation.v1")
}).strict();
const inputSchemas = {
  list_catalog_items: z.object({
    cursor: z.string().trim().min(1).nullable().optional(),
    limit: z.number().int().min(1).max(100),
    sort: z.enum(["code", "name", "updatedAt"]).optional()
  }).strict(),
  get_pricing_policy: z.object({ pricingPolicyVersionId: text }).strict(),
  preview_quote: z.object({
    quoteCaseId: text, quoteCaseRevision: positive, quoteInput: quoteInputSchema
  }).strict(),
  create_quote_draft: z.object({
    quoteCaseId: text, quoteCaseRevision: positive,
    quoteInput: quoteInputSchema, previewIdentity: previewIdentitySchema
  }).strict(),
  list_pending_quote_approvals: z.object({
    limit: z.number().int().min(1).max(100)
  }).strict(),
  get_quote_decision: z.object({ quoteVersionId: text }).strict(),
  create_quote_approval_task: z.object({
    quoteVersionId: text, quoteVersionRevision: positive
  }).strict()
} as const;

export interface GrowthAdvisorQuoteServices {
  readonly catalog: GrowthCatalogServices;
  readonly temporalBarrier: Pick<GrowthTemporalBarrier, "sealReadCutoff">;
  readonly quotes: {
    preview(context: CommandContext, caseId: string, input: QuotePreviewInput):
      Promise<QuoteCommandExecution<QuotePreviewResult>>;
    createDraft(context: CommandContext, caseId: string,
      input: CreateQuoteVersionInput): Promise<QuoteCommandExecution<QuoteVersion>>;
    submitDraft(context: CommandContext, draftVersionId: string):
      Promise<QuoteCommandExecution<{
        sourceDraftVersion: QuoteVersion;
        submittedVersion: QuoteVersion;
        approval: QuoteApproval;
      }>>;
    quoteApprovals: Pick<QuoteApprovalAsOfReader, "listPendingAsOf">;
    quoteVersions: Pick<QuoteVersionEvidenceReader, "getAt">;
  };
  readonly now?: () => string;
}

function withDataAsOf(value: unknown, cutoff: {
  effectiveAsOf: string; temporalSequence: number
}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.freeze({
      ...(value as Record<string, unknown>),
      dataAsOf: cutoff.effectiveAsOf,
      temporalSequence: cutoff.temporalSequence
    });
  }
  return Object.freeze({ data: value, dataAsOf: cutoff.effectiveAsOf,
    temporalSequence: cutoff.temporalSequence });
}

export function registerGrowthAdvisorQuoteTools(
  toolPorts: GrowthCommercialToolPorts,
  services: GrowthAdvisorQuoteServices
): void {
  const now = services.now ?? (() => new Date().toISOString());
  toolPorts.register("list_catalog_items", async (raw, command) => {
    const input = inputSchemas.list_catalog_items.parse(raw);
    const cutoff = await services.temporalBarrier.sealReadCutoff(
      command.workspace, now()
    );
    const value = await services.catalog.catalogItems.list(command.workspace, {
      cursor: input.cursor ?? null,
      limit: input.limit,
      sort: input.sort ?? "updatedAt"
    });
    return withDataAsOf(value, cutoff);
  });
  toolPorts.register("get_pricing_policy", async (raw, command) => {
    const input = inputSchemas.get_pricing_policy.parse(raw);
    const cutoff = await services.temporalBarrier.sealReadCutoff(
      command.workspace, now()
    );
    return withDataAsOf(await services.catalog.pricingPolicies.get(
      command.workspace, input.pricingPolicyVersionId
    ), cutoff);
  });
  toolPorts.register("preview_quote", async (raw, command) => {
    const input = z.object({ quoteCaseId: text, quoteInput: quoteInputSchema })
      .strict().parse(raw);
    return (await services.quotes.preview(
      command, input.quoteCaseId, input.quoteInput as QuotePreviewInput
    )).value;
  });
  toolPorts.register("create_quote_draft", async (raw, command) => {
    const input = z.object({
      quoteCaseId: text, quoteInput: quoteInputSchema,
      previewIdentity: previewIdentitySchema
    }).strict().parse(raw);
    return (await services.quotes.createDraft(command, input.quoteCaseId, {
      quoteInput: input.quoteInput as QuotePreviewInput,
      previewIdentity: input.previewIdentity as CreateQuoteVersionInput["previewIdentity"]
    })).value;
  });
  toolPorts.register("list_pending_quote_approvals", async (raw, command) => {
    const input = inputSchemas.list_pending_quote_approvals.parse(raw);
    const cutoff = await services.temporalBarrier.sealReadCutoff(
      command.workspace, now()
    );
    const items = await services.quotes.quoteApprovals.listPendingAsOf(
      command.workspace, { cutoff, limit: input.limit }
    );
    return Object.freeze({ items, dataAsOf: cutoff.effectiveAsOf,
      temporalSequence: cutoff.temporalSequence });
  });
  toolPorts.register("get_quote_decision", async (raw, command) => {
    const input = inputSchemas.get_quote_decision.parse(raw);
    const cutoff = await services.temporalBarrier.sealReadCutoff(
      command.workspace, now()
    );
    const value = await services.quotes.quoteVersions.getAt(
      command.workspace, input.quoteVersionId, cutoff
    );
    if (!value) throw new Error("quote_version_not_found");
    return withDataAsOf(value, cutoff);
  });
  toolPorts.register("create_quote_approval_task", async (raw, command) => {
    const input = z.object({ quoteVersionId: text }).strict().parse(raw);
    return (await services.quotes.submitDraft(
      command, input.quoteVersionId
    )).value;
  });
}

export interface GrowthQuoteToolResultEnvelope {
  readonly kind: "growth_quote_authority_snapshot";
  readonly toolName: GrowthQuoteToolName;
  readonly workspaceId: string;
  readonly dataAsOf: string;
  readonly temporalSequence: number;
  readonly authorityRefs: Readonly<Record<string, unknown>>;
  readonly internalSnapshot: unknown;
  readonly modelSnapshotRef: unknown;
  readonly promptSnapshotRef: unknown;
  readonly toolSchemaVersion: "growth-quote-tool.v1";
  readonly stableCallHash: `sha256:${string}`;
}

const baseCapabilities: Record<GrowthQuoteToolName, readonly GrowthCapability[]> = {
  list_catalog_items: ["catalog.read"],
  get_pricing_policy: ["catalog.read"],
  preview_quote: ["quote.draft.create", "catalog.read"],
  create_quote_draft: ["quote.draft.create", "catalog.read"],
  list_pending_quote_approvals: ["quote.draft.create"],
  get_quote_decision: ["quote.draft.create"],
  create_quote_approval_task: ["quote.draft.create"]
};

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") return value;
  const sensitive = /(?:standardCost|costMinor|grossProfitMinor|contributionMinor|marginMinor)/iu;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !sensitive.test(key))
    .map(([key, nested]) => [key, redactSensitive(nested)]));
}

function salesOwnerAllowed(
  context: ActiveWorkspaceContext,
  value: unknown
): boolean {
  if (context.role !== "sales") return true;
  if (!value || typeof value !== "object") return true;
  const record = value as Record<string, unknown>;
  if (typeof record.salesOwnerActorId === "string") {
    return record.salesOwnerActorId === context.actorId;
  }
  if (Array.isArray(record.items)) {
    return record.items.every((item) => salesOwnerAllowed(context, item));
  }
  return true;
}

export class GrowthQuoteToolReplayProjector {
  async authorizeAndProjectCached(
    context: ActiveWorkspaceContext,
    envelope: GrowthQuoteToolResultEnvelope
  ): Promise<unknown> {
    if (context.workspaceId !== envelope.workspaceId) {
      throw new Error("growth_quote_workspace_mismatch");
    }
    requireGrowthCapabilities(context, baseCapabilities[envelope.toolName]);
    if (!salesOwnerAllowed(context, envelope.internalSnapshot)) {
      throw new Error("quote_resource_forbidden");
    }
    return context.capabilities.includes("pricing.sensitive.read")
      ? structuredClone(envelope.internalSnapshot)
      : redactSensitive(envelope.internalSnapshot);
  }
}

function sha(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value) ?? "")
    .digest("hex")}`;
}

function refs(input: Record<string, unknown>, snapshot: unknown) {
  const result: Record<string, unknown> = {};
  for (const key of ["quoteCaseId", "quoteVersionId",
    "pricingPolicyVersionId", "catalogItemId"] as const) {
    if (typeof input[key] === "string") result[key] = input[key];
  }
  if (snapshot && typeof snapshot === "object") {
    for (const key of ["quoteCaseId", "quoteVersionId", "approvalId",
      "salesOwnerActorId"] as const) {
      const value = Reflect.get(snapshot, key);
      if (typeof value === "string") result[key] = value;
    }
  }
  return Object.freeze(result);
}

export interface GrowthAdvisorQuoteToolExecutorOptions {
  toolPorts: GrowthCommercialToolPorts;
  resultLedger: AcquisitionToolResultLedgerPort;
  projector?: GrowthQuoteToolReplayProjector;
  modelSnapshotRef: unknown;
  promptSnapshotRef: unknown;
  now?: () => string;
}

export class GrowthAdvisorQuoteToolExecutor {
  private readonly projector: GrowthQuoteToolReplayProjector;
  private readonly now: () => string;

  constructor(private readonly options: GrowthAdvisorQuoteToolExecutorOptions) {
    this.projector = options.projector ?? new GrowthQuoteToolReplayProjector();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async executeResolved(
    call: GrowthCommercialToolCall,
    context: ActiveWorkspaceContext,
    attempt: Readonly<{
      identity: AcquisitionAgentIdentity;
      idempotencyKey: string;
      modelSnapshotRef?: unknown;
      promptSnapshotRef?: unknown;
    }> = {
      identity: {
        ownerId: context.actorId, teamId: context.teamId,
        actorId: context.actorId, sessionId: "growth-quote-direct"
      },
      idempotencyKey: `growth-quote:${call.stableCallHash}`
    }
  ): Promise<unknown> {
    if (!GROWTH_QUOTE_TOOL_NAMES.includes(call.name as GrowthQuoteToolName)) {
      throw new Error("unknown_growth_quote_tool");
    }
    const name = call.name as GrowthQuoteToolName;
    const parsed = inputSchemas[name].parse(call.input) as Record<string, unknown>;
    const revision = name === "preview_quote" || name === "create_quote_draft"
      ? Number(parsed.quoteCaseRevision)
      : name === "create_quote_approval_task"
        ? Number(parsed.quoteVersionRevision) : null;
    const domainInput = { ...parsed };
    delete domainInput.quoteCaseRevision;
    delete domainInput.quoteVersionRevision;
    const command: CommandContext = Object.freeze({
      workspace: context,
      actorId: context.actorId,
      idempotencyKey: `growth-quote:${call.stableCallHash}`,
      requestHash: sha({
        toolName: name, pathParams: refs(parsed, null),
        payload: domainInput, expectedRevision: revision
      }),
      expectedRevision: revision
    });
    const envelope = await this.options.resultLedger.executeOnce<
      GrowthQuoteToolResultEnvelope
    >({
      ...attempt.identity,
      toolName: name,
      idempotencyKey: `growth-quote:${attempt.idempotencyKey}`,
      requestHash: call.stableCallHash
    }, async () => {
      const rawSnapshot = await this.options.toolPorts.execute({
        ...call, name, input: domainInput
      }, command);
      const snapshot = rawSnapshot && typeof rawSnapshot === "object"
        && Object.hasOwn(rawSnapshot, "value")
        && typeof Reflect.get(rawSnapshot, "replayed") === "boolean"
        ? Reflect.get(rawSnapshot, "value") : rawSnapshot;
      const dataAsOf = snapshot && typeof snapshot === "object"
        && typeof Reflect.get(snapshot, "dataAsOf") === "string"
        ? String(Reflect.get(snapshot, "dataAsOf")) : this.now();
      const temporalSequence = snapshot && typeof snapshot === "object"
        && Number.isSafeInteger(Reflect.get(snapshot, "temporalSequence"))
        ? Number(Reflect.get(snapshot, "temporalSequence")) : 0;
      return Object.freeze({
        kind: "growth_quote_authority_snapshot",
        toolName: name,
        workspaceId: context.workspaceId,
        dataAsOf,
        temporalSequence,
        authorityRefs: refs(parsed, snapshot),
        internalSnapshot: structuredClone(snapshot),
        modelSnapshotRef: structuredClone(
          attempt.modelSnapshotRef ?? this.options.modelSnapshotRef
        ),
        promptSnapshotRef: structuredClone(
          attempt.promptSnapshotRef ?? this.options.promptSnapshotRef
        ),
        toolSchemaVersion: "growth-quote-tool.v1",
        stableCallHash: call.stableCallHash
      });
    });
    return this.projector.authorizeAndProjectCached(context, envelope);
  }
}

export interface GrowthQuoteCurrentActor {
  readonly id: string;
  readonly teamId: string;
  readonly role: ActiveWorkspaceContext["role"];
  readonly status: "active" | "disabled";
  readonly capabilities: readonly GrowthCapability[];
  readonly capabilityRegistryVersion: string;
}

export interface GrowthQuoteAcquisitionToolDelegateOptions {
  workspaceResolver: GrowthAcquisitionWorkspaceResolver;
  sessions: Pick<AcquisitionCopilotRepository, "findSession">;
  resolveCurrentActor(identity: AcquisitionAgentIdentity):
    Promise<GrowthQuoteCurrentActor | null>;
  executor: GrowthAdvisorQuoteToolExecutor;
}

export class GrowthQuoteAcquisitionToolDelegate
implements GrowthAcquisitionToolDelegate {
  constructor(private readonly options: GrowthQuoteAcquisitionToolDelegateOptions) {}

  owns(toolName: string): boolean {
    return GROWTH_QUOTE_TOOL_NAMES.includes(toolName as GrowthQuoteToolName);
  }

  async execute(input: AcquisitionToolExecutionInput): Promise<unknown> {
    if (!this.owns(input.toolName)) throw new Error("UNKNOWN_TOOL");
    const session: AcquisitionCopilotSession | undefined =
      await this.options.sessions.findSession(input.identity, input.identity.sessionId);
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
    const name = input.toolName as GrowthQuoteToolName;
    const parsed = inputSchemas[name].parse(input.payload);
    const stableCallHash = sha({
      schemaVersion: "growth-quote-tool-call.v1",
      workspaceId: context.workspaceId,
      toolName: name,
      idempotencyKey: input.idempotencyKey,
      input: parsed
    });
    return this.options.executor.executeResolved({
      name: name as GrowthCommercialToolName,
      input: parsed,
      stableCallHash
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

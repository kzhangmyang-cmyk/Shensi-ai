import {
  createHmac,
  randomUUID
} from "node:crypto";
import type {
  AgentTool,
  AgentToolResult
} from "@earendil-works/pi-agent-core";
import {
  Type,
  type TSchema
} from "typebox";
import {
  GROWTH_QUOTE_TOOL_BLUEPRINTS,
  GROWTH_QUOTE_TOOL_NAMES
} from "./growth-advisor-quote-tools.js";
import {
  ADVISOR_TOOL_BLUEPRINTS,
  ADVISOR_TOOL_NAMES
} from "./growth-advisor-tools.js";

export const ACQUISITION_AGENT_TOOL_NAMES = [
  "search_public_sources",
  "get_candidate_evidence",
  "research_candidate",
  "qualify_candidate",
  "build_battle_card",
  "estimate_financial_value",
  "draft_connection_strategy",
  "list_priority_candidates",
  "create_review_task",
  "record_outcome",
  "get_acquisition_performance",
  ...GROWTH_QUOTE_TOOL_NAMES,
  ...ADVISOR_TOOL_NAMES
] as const;

export type AcquisitionAgentToolName =
  (typeof ACQUISITION_AGENT_TOOL_NAMES)[number];

export interface AcquisitionAgentIdentity {
  ownerId: string;
  teamId: string;
  actorId: string;
  sessionId: string;
}

export interface AcquisitionToolExecutionInput {
  identity: AcquisitionAgentIdentity;
  toolName: AcquisitionAgentToolName;
  toolCallId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  /** Internal run workers may request tenant-scoped facts for validation. */
  resultProjection?: "internal_run";
  signal?: AbortSignal;
}

export interface AcquisitionAgentToolExecutor {
  execute(input: AcquisitionToolExecutionInput): Promise<unknown>;
}

export interface AcquisitionToolAuditRecord {
  id: string;
  ownerId: string;
  teamId: string;
  actorId: string;
  sessionId: string;
  toolName: AcquisitionAgentToolName;
  toolCallIdHash: string;
  idempotencyKeyHash: string;
  parameterHash: string;
  resultHash: string | null;
  status: "succeeded" | "failed" | "aborted";
  errorCode: string | null;
  startedAt: string;
  completedAt: string;
}

export interface AcquisitionToolAuditScope {
  ownerId: string;
  teamId: string;
  sessionId: string;
}

export interface AcquisitionToolAuditLedger {
  append(record: AcquisitionToolAuditRecord): Promise<void>;
  list(
    scope: AcquisitionToolAuditScope
  ): Promise<AcquisitionToolAuditRecord[]>;
}

export class InMemoryAcquisitionToolAuditLedger
implements AcquisitionToolAuditLedger {
  readonly #records: AcquisitionToolAuditRecord[] = [];

  async append(record: AcquisitionToolAuditRecord) {
    this.#records.push(Object.freeze({ ...record }));
  }

  async list(scope: AcquisitionToolAuditScope) {
    return this.#records
      .filter((record) =>
        record.ownerId === scope.ownerId
        && record.teamId === scope.teamId
        && record.sessionId === scope.sessionId
      )
      .map((record) => ({ ...record }));
  }
}

export interface CreateAcquisitionAgentToolsOptions {
  identity: AcquisitionAgentIdentity;
  executor: AcquisitionAgentToolExecutor;
  audit: AcquisitionToolAuditLedger;
  auditSecret: string;
  now?: () => number;
  idFactory?: () => string;
}

interface ToolBlueprint {
  name: AcquisitionAgentToolName;
  label: string;
  description: string;
  parameters: TSchema;
  executionMode: "parallel" | "sequential";
}

export interface AcquisitionAgentToolDefinition {
  name: AcquisitionAgentToolName;
  description: string;
  parameters: Record<string, unknown>;
}

const SUBJECT_KINDS = Type.Union([
  Type.Literal("organization"),
  Type.Literal("individual")
]);

const TOOL_BLUEPRINTS: readonly ToolBlueprint[] = [
  {
    name: "search_public_sources",
    label: "搜索公开商机",
    description: "通过已授权的官方搜索连接发现公开商机；未指定连接时自动使用当前客户已启用的连接，只返回来源与候选，不执行触达。",
    parameters: Type.Object({
      query: Type.String({ minLength: 2, maxLength: 1000 }),
      providerConnectionIds: Type.Optional(Type.Array(
        Type.String({ minLength: 1, maxLength: 255 }),
        { minItems: 1, maxItems: 10, uniqueItems: true }
      )),
      subjectKinds: Type.Array(SUBJECT_KINDS, {
        minItems: 1,
        maxItems: 2,
        uniqueItems: true
      }),
      maxResults: Type.Integer({ minimum: 1, maximum: 100 })
    }, { additionalProperties: false }),
    executionMode: "parallel"
  },
  {
    name: "get_candidate_evidence",
    label: "读取候选证据",
    description: "读取当前租户候选的来源、证据片段、置信度和核验状态。",
    parameters: Type.Object({
      candidateId: Type.String({ minLength: 1, maxLength: 255 })
    }, { additionalProperties: false }),
    executionMode: "parallel"
  },
  {
    name: "research_candidate",
    label: "研究候选客户",
    description: "基于公开来源补充候选与主体身份研究；不抓取私密或敏感个人数据，不自动绑定身份或执行触达。",
    parameters: Type.Object({
      candidateId: Type.String({ minLength: 1, maxLength: 255 }),
      depth: Type.Union([
        Type.Literal("standard"),
        Type.Literal("deep")
      ]),
      researchQuestions: Type.Optional(Type.Array(
        Type.String({ minLength: 2, maxLength: 500 }),
        { maxItems: 12 }
      ))
    }, { additionalProperties: false }),
    executionMode: "parallel"
  },
  {
    name: "qualify_candidate",
    label: "评估客户意向",
    description: "依据证据、ICP、购买信号和负向信号生成可解释的资格评分。",
    parameters: Type.Object({
      candidateId: Type.String({ minLength: 1, maxLength: 255 }),
      policyVersion: Type.String({ minLength: 1, maxLength: 100 })
    }, { additionalProperties: false }),
    executionMode: "parallel"
  },
  {
    name: "build_battle_card",
    label: "生成客户作战卡",
    description: "生成包含需求、供应商、决策链、采购偏好和行动建议的作战卡草稿。",
    parameters: Type.Object({
      candidateId: Type.String({ minLength: 1, maxLength: 255 }),
      templateVersion: Type.Optional(
        Type.String({ minLength: 1, maxLength: 100 })
      )
    }, { additionalProperties: false }),
    executionMode: "parallel"
  },
  {
    name: "estimate_financial_value",
    label: "评估财务价值",
    description: "基于成交概率、毛利、获客成本、服务复杂度和回款风险估算线索价值。",
    parameters: Type.Object({
      candidateId: Type.String({ minLength: 1, maxLength: 255 }),
      currency: Type.String({
        minLength: 3,
        maxLength: 3,
        pattern: "^[A-Z]{3}$"
      }),
      policyVersion: Type.Optional(
        Type.String({ minLength: 1, maxLength: 100 })
      )
    }, { additionalProperties: false }),
    executionMode: "parallel"
  },
  {
    name: "draft_connection_strategy",
    label: "生成连接策略",
    description: "按决策角色与沟通偏好生成开场草稿；草稿必须经人工审核后使用。",
    parameters: Type.Object({
      candidateId: Type.String({ minLength: 1, maxLength: 255 }),
      targetRole: Type.String({ minLength: 1, maxLength: 100 }),
      channels: Type.Array(Type.Union([
        Type.Literal("public_reply"),
        Type.Literal("enterprise_wechat"),
        Type.Literal("phone"),
        Type.Literal("email"),
        Type.Literal("referral"),
        Type.Literal("meeting")
      ]), { minItems: 1, maxItems: 6, uniqueItems: true })
    }, { additionalProperties: false }),
    executionMode: "parallel"
  },
  {
    name: "list_priority_candidates",
    label: "列出优先客户",
    description: "按意向和财务价值读取当前租户优先候选清单。",
    parameters: Type.Object({
      subjectKinds: Type.Optional(Type.Array(SUBJECT_KINDS, {
        minItems: 1,
        maxItems: 2,
        uniqueItems: true
      })),
      minimumGrade: Type.Optional(Type.Union([
        Type.Literal("S"),
        Type.Literal("A"),
        Type.Literal("B"),
        Type.Literal("C"),
        Type.Literal("D")
      ])),
      limit: Type.Integer({ minimum: 1, maximum: 100 })
    }, { additionalProperties: false }),
    executionMode: "parallel"
  },
  {
    name: "create_review_task",
    label: "创建人工审核任务",
    description: "为建议动作创建人工审核任务；不会自动发送消息或转换客户。",
    parameters: Type.Object({
      candidateId: Type.String({ minLength: 1, maxLength: 255 }),
      proposedAction: Type.Union([
        Type.Literal("public_reply"),
        Type.Literal("private_domain_invitation"),
        Type.Literal("phone_call"),
        Type.Literal("email"),
        Type.Literal("meeting"),
        Type.Literal("convert")
      ]),
      rationale: Type.String({ minLength: 2, maxLength: 2000 })
    }, { additionalProperties: false }),
    executionMode: "sequential"
  },
  {
    name: "get_acquisition_performance",
    label: "读取获客经营事实",
    description: "只读取后端已确定计算的漏斗、分币种合同额、执行成本覆盖、ROI 可用性和简报事实；不写 CRM 或 Outcome，不补造数值。",
    parameters: Type.Object({
      platform: Type.Optional(Type.Union([
        Type.Literal("douyin"),
        Type.Literal("web")
      ])),
      from: Type.String({
        minLength: 10,
        maxLength: 10,
        format: "date"
      }),
      to: Type.String({
        minLength: 10,
        maxLength: 10,
        format: "date"
      })
    }, { additionalProperties: false }),
    executionMode: "parallel"
  },
  ...GROWTH_QUOTE_TOOL_BLUEPRINTS
  ,...ADVISOR_TOOL_BLUEPRINTS
];

const LEGACY_RECORD_OUTCOME_BLUEPRINT: ToolBlueprint = {
  name: "record_outcome",
  label: "记录获客结果",
  description: "只在已审核动作存在可信执行凭证后记录结果，用于闭环优化；本工具不执行任何外部触达。",
  parameters: Type.Object({
    candidateId: Type.String({ minLength: 1, maxLength: 255 }),
    reviewTaskId: Type.String({ minLength: 1, maxLength: 255 }),
    outcome: Type.Union([
      Type.Literal("contacted"),
      Type.Literal("replied"),
      Type.Literal("qualified"),
      Type.Literal("converted"),
      Type.Literal("won"),
      Type.Literal("lost"),
      Type.Literal("do_not_contact")
    ]),
    occurredAt: Type.String({
      minLength: 20,
      maxLength: 35,
      format: "date-time"
    }),
    amountMinor: Type.Optional(Type.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER
    })),
    currency: Type.Optional(Type.String({
      minLength: 3,
      maxLength: 3,
      pattern: "^[A-Z]{3}$"
    })),
    notes: Type.Optional(Type.String({ maxLength: 2000 }))
  }, { additionalProperties: false }),
  executionMode: "sequential"
};

export function acquisitionAgentToolDefinitions():
AcquisitionAgentToolDefinition[] {
  return TOOL_BLUEPRINTS.map((blueprint) => ({
    name: blueprint.name,
    description: blueprint.description,
    parameters: structuredClone(
      blueprint.parameters
    ) as Record<string, unknown>
  }));
}

export function legacyAcquisitionAgentToolDefinitions():
AcquisitionAgentToolDefinition[] {
  return [
    ...TOOL_BLUEPRINTS.filter((blueprint) =>
      blueprint.name !== "get_acquisition_performance"
      && !GROWTH_QUOTE_TOOL_NAMES.includes(blueprint.name as never)
      && !ADVISOR_TOOL_NAMES.includes(blueprint.name as never)),
    LEGACY_RECORD_OUTCOME_BLUEPRINT
  ].map((blueprint) => ({
    name: blueprint.name,
    description: blueprint.description,
    parameters: structuredClone(
      blueprint.parameters
    ) as Record<string, unknown>
  }));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(object[key])}`
  ).join(",")}}`;
}

function digest(secret: string, value: unknown) {
  return createHmac("sha256", secret)
    .update(stableJson(value))
    .digest("hex");
}

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|credential|password|secret|token)/i;

function sanitizedValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value;
  }
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => sanitizedValue(item, seen));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 200)
      .map(([key, nested]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitizedValue(nested, seen)
      ])
  );
}

function safeResultText(value: unknown) {
  const serialized = stableJson(sanitizedValue(value));
  return serialized.length <= 16_000
    ? serialized
    : `${serialized.slice(0, 15_900)}…[TRUNCATED]`;
}

function safeErrorCode(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") {
    return "ABORTED";
  }
  const raw = error instanceof Error ? error.message : "";
  const code = raw.match(/^[A-Z][A-Z0-9_]{2,63}/)?.[0];
  return code || "TOOL_EXECUTION_FAILED";
}

function createAbortError() {
  return new DOMException("Acquisition tool execution aborted", "AbortError");
}

function resultDetails(value: unknown) {
  return sanitizedValue(value) as Record<string, unknown>;
}

async function appendAuditOrFail(
  audit: AcquisitionToolAuditLedger,
  record: AcquisitionToolAuditRecord
) {
  try {
    await audit.append(record);
  } catch {
    throw new Error("ACQUISITION_TOOL_AUDIT_WRITE_FAILED");
  }
}

function createTool(
  blueprint: ToolBlueprint,
  options: Required<
    Pick<CreateAcquisitionAgentToolsOptions, "now" | "idFactory">
  > & CreateAcquisitionAgentToolsOptions
): AgentTool {
  return {
    name: blueprint.name,
    label: blueprint.label,
    description: blueprint.description,
    parameters: blueprint.parameters,
    executionMode: blueprint.executionMode,
    async execute(
      toolCallId,
      params,
      signal
    ): Promise<AgentToolResult<Record<string, unknown>>> {
      const payload = params as Record<string, unknown>;
      const startedAt = new Date(options.now()).toISOString();
      const parameterHash = digest(options.auditSecret, {
        toolName: blueprint.name,
        payload
      });
      const idempotencyKey = `pi-tool:${digest(options.auditSecret, {
        sessionId: options.identity.sessionId,
        toolName: blueprint.name,
        toolCallId
      })}`;
      const baseRecord = {
        id: options.idFactory(),
        ownerId: options.identity.ownerId,
        teamId: options.identity.teamId,
        actorId: options.identity.actorId,
        sessionId: options.identity.sessionId,
        toolName: blueprint.name,
        toolCallIdHash: digest(options.auditSecret, toolCallId),
        idempotencyKeyHash: digest(options.auditSecret, idempotencyKey),
        parameterHash,
        startedAt
      };
      if (signal?.aborted) {
        await appendAuditOrFail(options.audit, {
          ...baseRecord,
          resultHash: null,
          status: "aborted",
          errorCode: "ABORTED",
          completedAt: new Date(options.now()).toISOString()
        });
        throw createAbortError();
      }
      let sanitized: Record<string, unknown>;
      try {
        const value = await options.executor.execute({
          identity: { ...options.identity },
          toolName: blueprint.name,
          toolCallId,
          idempotencyKey,
          payload,
          signal
        });
        sanitized = resultDetails(value);
      } catch (error) {
        const aborted = signal?.aborted
          || (error instanceof DOMException && error.name === "AbortError");
        const errorCode = aborted ? "ABORTED" : safeErrorCode(error);
        await appendAuditOrFail(options.audit, {
          ...baseRecord,
          resultHash: null,
          status: aborted ? "aborted" : "failed",
          errorCode,
          completedAt: new Date(options.now()).toISOString()
        });
        if (aborted) throw createAbortError();
        throw new Error(errorCode);
      }
      await appendAuditOrFail(options.audit, {
        ...baseRecord,
        resultHash: digest(options.auditSecret, sanitized),
        status: "succeeded",
        errorCode: null,
        completedAt: new Date(options.now()).toISOString()
      });
      return {
        content: [{ type: "text", text: safeResultText(sanitized) }],
        details: sanitized
      };
    }
  };
}

export function createAcquisitionAgentTools(
  options: CreateAcquisitionAgentToolsOptions
): AgentTool[] {
  if (options.auditSecret.length < 32) {
    throw new TypeError("auditSecret must contain at least 32 characters");
  }
  for (const [name, value] of Object.entries(options.identity)) {
    if (!value.trim()) {
      throw new TypeError(`identity.${name} is required`);
    }
  }
  const resolved = {
    ...options,
    identity: Object.freeze({ ...options.identity }),
    now: options.now ?? Date.now,
    idFactory: options.idFactory ?? (() => `pi_tool_audit_${randomUUID()}`)
  };
  return TOOL_BLUEPRINTS.map((blueprint) =>
    createTool(blueprint, resolved)
  );
}

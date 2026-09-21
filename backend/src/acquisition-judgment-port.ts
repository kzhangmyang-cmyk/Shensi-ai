import { z } from "zod";
import type {
  AcquisitionCandidate,
  BattleCardInput,
  BattleCardIntelligenceV2,
  DiscoveryEvidence
} from "./acquisition-domain.js";
import type {
  AcquisitionConnectionDraft,
  AcquisitionJudgmentPort
} from "./acquisition-tool-executor.js";
import {
  ACQUISITION_JUDGMENT_PROMPT_ID,
  ACQUISITION_JUDGMENT_SUBMIT_TOOL,
  ACQUISITION_JUDGMENT_TOOL_SCHEMA_ID,
  ACQUISITION_MODEL_SCHEMA_VERSION,
  acquisitionModelContentForSnapshot
} from "./acquisition-model-content.js";
import type {
  AcquisitionPiGatewayPort
} from "./acquisition-pi-gateway-runtime.js";
import type {
  AcquisitionCopilotRepository
} from "./acquisition-copilot-service.js";
import {
  createAcquisitionModelGatewayForSnapshot,
  resolveStoredAcquisitionModelSnapshot,
  type AcquisitionModelSnapshotStore
} from "./acquisition-pi-runtime-factory.js";
import type {
  StoredAiJobModelSnapshot
} from "./model-providers/types.js";

export interface AcquisitionJudgmentSessionResolution {
  snapshot: StoredAiJobModelSnapshot;
  gateway: AcquisitionPiGatewayPort;
}

export interface CreateAcquisitionJudgmentPortOptions {
  resolveSession(input: {
    ownerId: string;
    teamId: string;
    sessionId: string;
  }): Promise<AcquisitionJudgmentSessionResolution>;
}

export interface CreateAcquisitionJudgmentSessionResolverOptions {
  repository: Pick<AcquisitionCopilotRepository, "findSession">;
  store: AcquisitionModelSnapshotStore;
  gatewayFactory?: (
    snapshot: StoredAiJobModelSnapshot
  ) => AcquisitionPiGatewayPort;
}

export function createAcquisitionJudgmentSessionResolver(
  options: CreateAcquisitionJudgmentSessionResolverOptions
): CreateAcquisitionJudgmentPortOptions["resolveSession"] {
  return async (input) => {
    const session = await options.repository.findSession(
      {
        ownerId: input.ownerId,
        teamId: input.teamId
      },
      input.sessionId
    );
    if (!session || session.status !== "active") {
      fail("MODEL_SNAPSHOT_UNAVAILABLE");
    }
    const stored = resolveStoredAcquisitionModelSnapshot(
      options.store,
      {
        identity: {
          ownerId: input.ownerId,
          teamId: input.teamId,
          actorId: session.actorId,
          sessionId: session.id
        },
        snapshot: session.modelSnapshot
      }
    );
    return {
      snapshot: stored,
      gateway: options.gatewayFactory
        ? options.gatewayFactory(stored)
        : createAcquisitionModelGatewayForSnapshot(options.store, stored)
    };
  };
}

const evidenceIdsSchema = z.array(
  z.string().trim().min(1).max(100)
).max(100).refine(
  (ids) => new Set(ids).size === ids.length
);

const findingSchema = z.object({
  kind: z.enum(["fact", "inference", "unknown"]),
  label: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(4_000),
  evidenceIds: evidenceIdsSchema,
  confidence: z.number().min(0).max(1).nullable()
}).strict().superRefine((finding, context) => {
  if (finding.kind === "fact" && finding.evidenceIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "facts require evidence"
    });
  }
  if (finding.kind === "inference"
    && (finding.evidenceIds.length === 0 || finding.confidence === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "inferences require evidence and confidence"
    });
  }
  if (finding.kind === "unknown"
    && (finding.evidenceIds.length > 0 || finding.confidence !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "unknowns cannot claim evidence or confidence"
    });
  }
});

const battleCardClaimSchema = z.object({
  kind: z.enum(["fact", "inference", "unknown"]),
  text: z.string().trim().min(1).max(4_000),
  evidenceIds: evidenceIdsSchema,
  confidence: z.number().min(0).max(1).nullable()
}).strict().superRefine((claim, context) => {
  if (claim.kind === "fact" && claim.evidenceIds.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "facts require evidence"
    });
  }
  if (claim.kind === "inference"
    && (claim.evidenceIds.length === 0 || claim.confidence === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "inferences require evidence and confidence"
    });
  }
  if (claim.kind === "unknown"
    && (claim.evidenceIds.length > 0 || claim.confidence !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "unknowns cannot claim evidence or confidence"
    });
  }
});

const dimensionsSchema = z.object({
  demandStrength: z.number().min(0).max(100),
  fit: z.number().min(0).max(100),
  identityConfidence: z.number().min(0).max(100),
  buyingStage: z.number().min(0).max(100),
  budgetPotential: z.number().min(0).max(100),
  decisionReachability: z.number().min(0).max(100),
  freshness: z.number().min(0).max(100),
  evidenceDiversity: z.number().min(0).max(100),
  negativeSignalRisk: z.number().min(0).max(100),
  contactRisk: z.number().min(0).max(100)
}).strict();

const financialSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/u),
  predictedDealAmountMinor: z.number().int().min(0)
    .max(Number.MAX_SAFE_INTEGER),
  grossMarginBps: z.number().int().min(0).max(10_000),
  closeProbabilityBps: z.number().int().min(0).max(10_000),
  acquisitionCostMinor: z.number().int().min(0)
    .max(Number.MAX_SAFE_INTEGER),
  salesCostMinor: z.number().int().min(0)
    .max(Number.MAX_SAFE_INTEGER),
  serviceCostMinor: z.number().int().min(0)
    .max(Number.MAX_SAFE_INTEGER),
  benchmarkDealAmountMinor: z.number().int().min(1)
    .max(Number.MAX_SAFE_INTEGER),
  collectionDays: z.number().int().min(0).max(36_500),
  creditRisk: z.number().min(0).max(100),
  repeatPotential: z.number().min(0).max(100),
  referralPotential: z.number().min(0).max(100)
}).strict();

const researchOutputSchema = z.object({
  operation: z.literal("research"),
  result: z.object({
    summary: z.string().trim().min(1).max(8_000),
    findings: z.array(findingSchema).max(100)
  }).strict()
}).strict();

const qualifyOutputSchema = z.object({
  operation: z.literal("qualify"),
  result: z.object({
    dimensions: dimensionsSchema,
    evidenceExcerpts: z.array(z.object({
      evidenceId: z.string().trim().min(1).max(100),
      excerpt: z.string().trim().min(1).max(500)
    }).strict()).max(100).refine((items) =>
      new Set(items.map((item) => item.evidenceId)).size === items.length
    ),
    reasons: z.array(
      z.string().trim().min(1).max(2_000)
    ).min(1).max(50),
    financial: financialSchema
  }).strict()
}).strict();

const battleCardOutputSchema = z.object({
  operation: z.literal("build_battle_card"),
  result: z.object({
    sections: z.array(findingSchema).min(1).max(100),
    confidence: z.number().min(0).max(1)
  }).strict()
}).strict();

const battleCardV2OutputSchema = z.object({
  operation: z.literal("build_battle_card"),
  result: z.object({
    accountOverview: z.array(battleCardClaimSchema).max(100),
    needAssessment: z.array(battleCardClaimSchema).max(100),
    supplierHypotheses: z.array(battleCardClaimSchema).max(100),
    buyingCommittee: z.array(z.object({
      role: z.string().trim().min(1).max(200),
      priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
      influence: z.enum([
        "decision_maker",
        "influencer",
        "user",
        "gatekeeper"
      ]),
      concerns: z.array(
        z.string().trim().min(1).max(500)
      ).max(100).refine((items) => new Set(items).size === items.length),
      claim: battleCardClaimSchema
    }).strict()).max(100),
    procurementPreferences: z.array(battleCardClaimSchema).max(100),
    connectionStrategies: z.array(z.object({
      channel: z.enum([
        "public_reply",
        "wecom",
        "phone",
        "email",
        "referral"
      ]),
      targetRole: z.string().trim().min(1).max(200),
      rationale: battleCardClaimSchema,
      openingDraft: z.string().trim().min(1).max(8_000)
    }).strict()).max(100),
    roleSpecificOpeners: z.array(z.object({
      role: z.string().trim().min(1).max(200),
      channel: z.enum([
        "public_reply",
        "wecom",
        "phone",
        "email",
        "referral"
      ]),
      text: z.string().trim().min(1).max(8_000)
    }).strict()).max(100),
    doNotActions: z.array(
      z.string().trim().min(1).max(1_000)
    ).max(100).refine((items) => new Set(items).size === items.length)
  }).strict()
}).strict();

const channelSchema = z.enum([
  "public_reply",
  "enterprise_wechat",
  "phone",
  "email",
  "referral",
  "meeting"
]);

const connectionOutputSchema = z.object({
  operation: z.literal("draft_connection_strategy"),
  result: z.object({
    drafts: z.array(z.object({
      channel: channelSchema,
      draft: z.string().trim().min(1).max(8_000),
      rationale: z.string().trim().min(1).max(2_000)
    }).strict()).min(1).max(6).refine((drafts) =>
      new Set(drafts.map((draft) => draft.channel)).size === drafts.length
    )
  }).strict()
}).strict();

const judgmentOutputSchema = z.union([
  researchOutputSchema,
  qualifyOutputSchema,
  battleCardOutputSchema,
  battleCardV2OutputSchema,
  connectionOutputSchema
]);

type JudgmentOutput = z.infer<typeof judgmentOutputSchema>;
type JudgmentOperation = JudgmentOutput["operation"];

const SENSITIVE_CONTENT = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /(?:\+?86[-\s]?)?1[3-9]\d{9}/u,
  /\b\d{17}[0-9X]\b/iu,
  /\b(?:sk|key|token|secret)[-_][A-Za-z0-9_-]{12,}\b/u
];

function fail(code: string): never {
  throw new Error(code);
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw new DOMException("Acquisition judgment aborted", "AbortError");
  }
}

function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(stringsIn);
  }
  return [];
}

function assertNoSensitiveContent(value: unknown) {
  if (stringsIn(value).some((text) =>
    SENSITIVE_CONTENT.some((pattern) => pattern.test(text))
  )) {
    fail("MODEL_JUDGMENT_SENSITIVE_CONTENT");
  }
}

function candidateProjection(candidate: AcquisitionCandidate) {
  if (candidate.profile.kind === "organization") {
    return {
      id: candidate.id,
      partyType: candidate.partyType,
      status: candidate.status,
      profile: {
        kind: candidate.profile.kind,
        name: candidate.profile.name,
        domain: candidate.profile.domain,
        region: candidate.profile.region
      }
    };
  }
  return {
    id: candidate.id,
    partyType: candidate.partyType,
    status: candidate.status,
    profile: {
      kind: candidate.profile.kind,
      sourcePlatform: candidate.profile.sourcePlatform,
      demandCategory: candidate.profile.demandCategory,
      demandSummary: candidate.profile.demandSummary,
      locationHint: candidate.profile.locationHint,
      buyingStage: candidate.profile.buyingStage,
      negativeSignals: [...candidate.profile.negativeSignals]
    }
  };
}

function evidenceProjection(evidence: DiscoveryEvidence[]) {
  return evidence.map((item) => ({
    id: item.id,
    targetType: item.targetType,
    sourcePlatform: item.sourcePlatform,
    sourceTitle: item.sourceTitle,
    sourceSnippet: item.sourceSnippet,
    publishedAt: item.publishedAt,
    locale: item.locale,
    accessStatus: item.accessStatus,
    fetchedAt: item.fetchedAt
  }));
}

function validatedEvidenceIds(
  candidate: AcquisitionCandidate,
  evidence: DiscoveryEvidence[],
  ownerId: string,
  teamId: string
) {
  if (candidate.ownerId !== ownerId || candidate.teamId !== teamId) {
    fail("MODEL_SNAPSHOT_MISMATCH");
  }
  const ids = new Set<string>();
  for (const item of evidence) {
    if (item.ownerId !== ownerId
      || item.teamId !== teamId
      || !candidate.evidenceIds.includes(item.id)
      || ids.has(item.id)) {
      fail("MODEL_JUDGMENT_INVALID");
    }
    ids.add(item.id);
  }
  return ids;
}

function assertEvidenceWhitelist(
  output: JudgmentOutput,
  allowedEvidenceIds: Set<string>
) {
  const referenced = output.operation === "research"
    ? output.result.findings.flatMap((item) => item.evidenceIds)
    : output.operation === "qualify"
      ? output.result.evidenceExcerpts.map((item) => item.evidenceId)
      : output.operation === "build_battle_card"
        ? "sections" in output.result
          ? output.result.sections.flatMap((item) => item.evidenceIds)
          : [
              ...output.result.accountOverview,
              ...output.result.needAssessment,
              ...output.result.supplierHypotheses,
              ...output.result.procurementPreferences,
              ...output.result.buyingCommittee.map((role) => role.claim),
              ...output.result.connectionStrategies.map((strategy) =>
                strategy.rationale)
            ].flatMap((item) => item.evidenceIds)
        : [];
  if (referenced.some((id) => !allowedEvidenceIds.has(id))) {
    fail("MODEL_JUDGMENT_INVALID");
  }
}

function validateSnapshot(
  snapshot: StoredAiJobModelSnapshot,
  ownerId: string,
  teamId: string
) {
  if (snapshot.ownerId !== ownerId || snapshot.teamId !== teamId) {
    fail("MODEL_SNAPSHOT_MISMATCH");
  }
  acquisitionModelContentForSnapshot(snapshot);
  if (!snapshot.capabilitySnapshot.toolCalling) {
    fail("MODEL_TOOL_CALLING_UNAVAILABLE");
  }
}

function hardGatesUnknown() {
  return {
    hasOriginalSource: false,
    identityResolved: false,
    notDoNotContact: false,
    noExplicitRejection: false,
    publicDataOnly: false,
    evidenceFresh: false,
    schemaValid: false
  };
}

function claimLabel(
  kind: "fact" | "inference" | "unknown",
  label: string
) {
  const prefix = {
    fact: "事实",
    inference: "推断",
    unknown: "未知"
  }[kind];
  return `${prefix}｜${label}`;
}

export function createAcquisitionJudgmentPort(
  options: CreateAcquisitionJudgmentPortOptions
): Required<AcquisitionJudgmentPort> {
  async function run(
    input: {
      scope: {
        ownerId: string;
        teamId: string;
      };
      sessionId: string;
      candidate: AcquisitionCandidate;
      evidence: DiscoveryEvidence[];
      signal?: AbortSignal;
    },
    operation: JudgmentOperation,
    operationInput: Record<string, unknown>
  ) {
    assertNotAborted(input.signal);
    const allowedEvidenceIds = validatedEvidenceIds(
      input.candidate,
      input.evidence,
      input.scope.ownerId,
      input.scope.teamId
    );
    const resolved = await options.resolveSession({
      ownerId: input.scope.ownerId,
      teamId: input.scope.teamId,
      sessionId: input.sessionId
    });
    validateSnapshot(
      resolved.snapshot,
      input.scope.ownerId,
      input.scope.teamId
    );
    const dynamicData = {
      operation,
      candidate: candidateProjection(input.candidate),
      evidence: evidenceProjection(input.evidence),
      operationInput
    };
    assertNoSensitiveContent(dynamicData);
    const result = await resolved.gateway.callTools({
      contentBinding: {
        promptId: ACQUISITION_JUDGMENT_PROMPT_ID,
        toolSchemaId: ACQUISITION_JUDGMENT_TOOL_SCHEMA_ID,
        dynamicData
      },
      parallelToolCalls: false
    });
    assertNotAborted(input.signal);
    if (result.toolCalls.length !== 1
      || result.toolCalls[0]?.name !== ACQUISITION_JUDGMENT_SUBMIT_TOOL) {
      fail("MODEL_JUDGMENT_INVALID");
    }
    const parsed = judgmentOutputSchema.safeParse(
      result.toolCalls[0].arguments
    );
    if (!parsed.success || parsed.data.operation !== operation) {
      fail("MODEL_JUDGMENT_INVALID");
    }
    if (operation === "build_battle_card"
      && parsed.data.operation === "build_battle_card") {
      const isV2 = !("sections" in parsed.data.result);
      if (isV2
        !== (resolved.snapshot.schemaVersion
          === ACQUISITION_MODEL_SCHEMA_VERSION)) {
        fail("MODEL_JUDGMENT_INVALID");
      }
    }
    assertNoSensitiveContent(parsed.data);
    assertEvidenceWhitelist(parsed.data, allowedEvidenceIds);
    return {
      output: parsed.data,
      snapshot: resolved.snapshot
    };
  }

  return {
    async research(input) {
      const { output } = await run(input, "research", {
        depth: input.depth,
        researchQuestions: [...input.researchQuestions]
      });
      if (output.operation !== "research") {
        fail("MODEL_JUDGMENT_INVALID");
      }
      return {
        summary: output.result.summary,
        findings: output.result.findings.map((finding) => ({
          label: claimLabel(finding.kind, finding.label),
          content: finding.content,
          evidenceIds: [...finding.evidenceIds],
          confidence: finding.confidence
        }))
      };
    },

    async qualify(input) {
      const { output, snapshot } = await run(input, "qualify", {
        policyVersion: input.policyVersion
      });
      if (output.operation !== "qualify") {
        fail("MODEL_JUDGMENT_INVALID");
      }
      return {
        qualification: {
          decisionEngine: "model",
          ruleVersion: input.policyVersion,
          promptVersion: snapshot.promptVersion,
          modelProvider: snapshot.provider,
          model: snapshot.model,
          dimensions: output.result.dimensions,
          hardGates: hardGatesUnknown(),
          evidenceExcerpts: Object.fromEntries(
            output.result.evidenceExcerpts.map((item) => [
              item.evidenceId,
              item.excerpt
            ])
          ),
          reasons: [...output.result.reasons]
        },
        financial: { ...output.result.financial }
      };
    },

    async buildBattleCard(input): Promise<BattleCardInput> {
      const { output, snapshot } = await run(
        input,
        "build_battle_card",
        {
          templateVersion: input.templateVersion,
          financialSummary: structuredClone(input.financialSummary)
        }
      );
      if (output.operation !== "build_battle_card") {
        fail("MODEL_JUDGMENT_INVALID");
      }
      if (!("sections" in output.result)) {
        return {
          schemaVersion: "battle-card.v2",
          intelligence: structuredClone(
            output.result
          ) as Omit<BattleCardIntelligenceV2, "financialSummary">,
          confidence: input.financialSummary
            ? Math.min(1, Math.max(0, input.financialSummary.score / 100))
            : 0.5,
          modelProvider: snapshot.provider,
          model: snapshot.model,
          promptVersion: snapshot.promptVersion
        };
      }
      return {
        schemaVersion: "battle-card.v1",
        sections: output.result.sections.map((section) => ({
          label: section.label,
          kind: section.kind,
          content: section.content,
          evidenceIds: [...section.evidenceIds],
          confidence: section.confidence
        })),
        confidence: output.result.confidence,
        modelProvider: snapshot.provider,
        model: snapshot.model,
        promptVersion: snapshot.promptVersion
      };
    },

    async draftConnectionStrategy(
      input
    ): Promise<AcquisitionConnectionDraft[]> {
      const { output } = await run(
        input,
        "draft_connection_strategy",
        {
          targetRole: input.targetRole,
          channels: [...input.channels]
        }
      );
      if (output.operation !== "draft_connection_strategy") {
        fail("MODEL_JUDGMENT_INVALID");
      }
      const byChannel = new Map(
        output.result.drafts.map((draft) => [draft.channel, draft])
      );
      if (byChannel.size !== input.channels.length
        || input.channels.some((channel) => !byChannel.has(channel))) {
        fail("MODEL_JUDGMENT_INVALID");
      }
      return input.channels.map((channel) => {
        const draft = byChannel.get(channel);
        if (!draft) fail("MODEL_JUDGMENT_INVALID");
        return { ...draft };
      });
    }
  };
}

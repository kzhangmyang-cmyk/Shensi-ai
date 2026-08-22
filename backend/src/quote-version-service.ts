import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJsonStringify } from "./canonical-json.js";
import type { GrowthCatalogServices } from "./growth-catalog-module.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import type { CommandContext } from "./growth-command-context.js";
import { requireExpectedRevision } from "./growth-command-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import { executeGrowthIdempotentCommand } from "./growth-http-idempotency-repository.js";
import { QuoteCalculationService } from "./quote-calculation-service.js";
import type {
  QuoteCalculationInput,
  QuoteCalculationResult,
  QuotePreviewIdentity
} from "./quote-domain.js";
import {
  assertFormalProbabilityAssessment,
  type ProbabilityAssessmentRepository
} from "./probability-assessment.js";
import type { CommercialBindingVerifier } from "./commercial-binding-snapshot.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type {
  QuoteApproval,
  QuotePreviewEvidenceRecord,
  QuoteRepository,
  QuoteVersion
} from "./quote-repository.js";
import type { QuoteCommandExecution } from "./quote-case-service.js";

const money = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const quantity = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const token = z.string().trim().min(1).max(191);
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const previewInputSchema = z.object({
  catalogItemId: token,
  pricingPolicyVersionId: token,
  quantityMicros: quantity,
  offeredUnitPriceMinor: money,
  orderDiscountMinor: money,
  paymentTermDays: money,
  giftItems: z.array(z.object({
    catalogItemId: token,
    quantityMicros: quantity
  }).strict()),
  surchargeContext: z.object({
    region: z.string().trim().min(1).nullable(),
    deliveryMethod: z.string().trim().min(1).nullable()
  }).strict(),
  customerTargetPriceMinor: money.nullable(),
  creditRiskBps: z.number().int().min(0).max(10_000).nullable(),
  manualEscalation: z.boolean()
}).strict();
const previewIdentitySchema = z.object({
  inputSnapshotHash: hashSchema,
  calculationHash: hashSchema,
  pricingPolicyVersionId: token,
  pricingPolicyRevision: z.number().int().min(1),
  packageVersionId: token.nullable(),
  formulaVersion: z.literal("quote-calculation.v1")
}).strict();
const createVersionInputSchema = z.object({
  previewIdentity: previewIdentitySchema,
  quoteInput: previewInputSchema
}).strict();

export type QuotePreviewInput = Omit<QuoteCalculationInput, "workspaceId">;
export type QuotePreviewResult = QuoteCalculationResult;

export interface CreateQuoteVersionInput {
  readonly previewIdentity: Readonly<QuotePreviewIdentity>;
  readonly quoteInput: QuotePreviewInput;
}

export interface QuoteQualificationAuthority {
  findCurrent(workspaceId: string, candidateId: string): Promise<Readonly<{
    qualificationDecisionId: string;
    qualificationDecisionVersion: string;
    inputSnapshotHash: `sha256:${string}`;
  }> | null>;
}

export class QuoteVersionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "QuoteVersionError";
  }
}

function fail(code: string): never {
  throw new QuoteVersionError(code);
}

function sha(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value) ?? "")
    .digest("hex")}`;
}

function stableHash(kind: string, value: unknown): `sha256:${string}` {
  return sha({ schemaVersion: "quote-command.v1", kind, value });
}

function parsePreviewInput(input: unknown): QuotePreviewInput {
  const parsed = previewInputSchema.safeParse(input);
  if (!parsed.success) fail("quote_input_contains_authoritative_field");
  return parsed.data;
}

function parseCreateVersionInput(input: unknown): CreateQuoteVersionInput {
  const parsed = createVersionInputSchema.safeParse(input);
  if (!parsed.success) fail("quote_input_contains_authoritative_field");
  return parsed.data as CreateQuoteVersionInput;
}

function assertCommand(command: CommandContext): ActiveWorkspaceContext {
  requireGrowthCapabilities(command.workspace, ["quote.draft.create"]);
  if (command.actorId !== command.workspace.actorId) {
    fail("growth_actor_context_mismatch");
  }
  if (!command.workspace.workspaceId.trim()
    || command.workspace.workspaceId === "all") {
    fail("invalid_growth_workspace_id");
  }
  return command.workspace;
}

function instant(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) fail("invalid_quote_effective_at");
  return parsed.toISOString();
}

function previewFromEvidence(
  evidence: QuotePreviewEvidenceRecord
): QuotePreviewResult {
  const result = evidence.frozenCalculationResult;
  if (result.inputSnapshotHash !== evidence.inputSnapshotHash
    || result.calculationHash !== evidence.calculationHash
    || canonicalJsonStringify(result.previewIdentity)
      !== canonicalJsonStringify(evidence.previewIdentity)) {
    fail("quote_preview_evidence_corrupt");
  }
  return result;
}

function exactPreview(
  calculated: QuoteCalculationResult,
  preview: QuotePreviewIdentity
): boolean {
  return canonicalJsonStringify(calculated.previewIdentity)
    === canonicalJsonStringify(preview);
}

export interface QuoteVersionServiceOptions {
  readonly repository: QuoteRepository;
  readonly probabilityAssessments: ProbabilityAssessmentRepository;
  readonly bindingVerifier: CommercialBindingVerifier;
  readonly catalog: GrowthCatalogServices;
  readonly foundation: GrowthFoundationServices;
  readonly calculator?: QuoteCalculationService;
  readonly qualificationAuthority?: QuoteQualificationAuthority;
  readonly now?: () => string;
  readonly idFactory?: (prefix: string) => string;
  readonly requestExecutionId?: () => string;
}

export class QuoteVersionService {
  private readonly calculator: QuoteCalculationService;
  private readonly now: () => string;
  private readonly requestExecutionId: () => string;

  constructor(private readonly options: QuoteVersionServiceOptions) {
    this.calculator = options.calculator ?? new QuoteCalculationService();
    this.now = options.now ?? (() => new Date().toISOString());
    this.requestExecutionId = options.requestExecutionId
      ?? (() => options.idFactory?.("quote-execution")
        ?? `quote-execution-${randomUUID()}`);
  }

  private reservation(
    command: CommandContext,
    canonicalPath: string,
    attemptedAt: string
  ) {
    return {
      workspaceId: command.workspace.workspaceId,
      actorId: command.actorId,
      method: "POST",
      canonicalPath,
      key: command.idempotencyKey,
      requestHash: command.requestHash,
      attemptedAt,
      leaseOwner: this.requestExecutionId(),
      leaseDurationMs: 30_000
    };
  }

  private async calculate(
    context: ActiveWorkspaceContext,
    input: QuotePreviewInput,
    effectiveAt: string
  ) {
    const authority = await this.options.catalog.quoteCatalog.resolveAt(
      context,
      {
        catalogItemId: input.catalogItemId,
        pricingPolicyVersionId: input.pricingPolicyVersionId,
        effectiveAt
      }
    );
    return this.calculator.preview(
      { workspaceId: context.workspaceId, ...input },
      authority.pricingPolicy,
      {
        giftPolicies: authority.pricingPolicy.giftPolicies,
        packageSnapshot: authority.packageCostSnapshot
      }
    );
  }

  async preview(
    command: CommandContext,
    quoteCaseId: string,
    rawInput: QuotePreviewInput
  ): Promise<QuoteCommandExecution<QuotePreviewResult>> {
    const context = assertCommand(command);
    const input = parsePreviewInput(rawInput);
    if (command.expectedRevision === null) fail("precondition_required");
    const effectiveAt = instant(this.now());
    const commandHash = stableHash("preview", {
      workspaceId: context.workspaceId,
      actorId: command.actorId,
      quoteCaseId,
      expectedRevision: command.expectedRevision,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash
    });
    return executeGrowthIdempotentCommand({
      repository: this.options.foundation.httpIdempotency,
      reservation: this.reservation(
        command,
        "/api/v1/quotes/cases/:id/preview",
        effectiveAt
      )
    }, async (resourceId, operationId) => {
      assertCommand(command);
      await this.options.repository.assertCaseAccessible(
        context.workspaceId,
        quoteCaseId,
        command.actorId
      );
      if (!resourceId || operationId !== null) {
        fail("idempotency_reference_invalid");
      }
      const evidence = await this.options.repository.findPreviewEvidence(
        context.workspaceId,
        resourceId
      );
      if (!evidence || evidence.quoteCaseId !== quoteCaseId
        || evidence.createdBy !== command.actorId
        || evidence.requestHash !== command.requestHash
        || evidence.stableCommandHash !== commandHash) {
        fail("idempotency_reference_invalid");
      }
      return previewFromEvidence(evidence);
    }, async () => {
      const committed = await this.options.repository
        .findPreviewEvidenceByStableCommandHash(
          context.workspaceId,
          commandHash
        );
      if (committed) return { resourceId: committed.id, operationId: null };
      const calculated = await this.calculate(context, input, effectiveAt);
      const evidence = await this.options.repository.appendOrGetPreviewEvidence({
        workspaceId: context.workspaceId,
        quoteCaseId,
        expectedQuoteCaseRevision: command.expectedRevision!,
        createdBy: command.actorId,
        requestHash: command.requestHash,
        stableCommandHash: commandHash,
        effectiveAt,
        calculated
      });
      return { resourceId: evidence.id, operationId: null };
    });
  }

  async createVersion(
    command: CommandContext,
    quoteCaseId: string,
    rawInput: CreateQuoteVersionInput
  ): Promise<QuoteCommandExecution<QuoteVersion>> {
    const context = assertCommand(command);
    const expectedRevision = requireExpectedRevision(command);
    const input = parseCreateVersionInput(rawInput);
    const effectiveAt = instant(this.now());
    const commandHash = stableHash("draft", {
      workspaceId: context.workspaceId,
      actorId: command.actorId,
      quoteCaseId,
      expectedRevision,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash
    });
    return executeGrowthIdempotentCommand({
      repository: this.options.foundation.httpIdempotency,
      reservation: this.reservation(
        command,
        "/api/v1/quotes/cases/:id/versions",
        effectiveAt
      )
    }, async (resourceId, operationId) => {
      assertCommand(command);
      if (!resourceId || operationId !== null) {
        fail("idempotency_reference_invalid");
      }
      const frozen = await this.options.repository.getVersion(
        context.workspaceId,
        resourceId
      );
      if (!frozen || frozen.quoteCaseId !== quoteCaseId
        || frozen.versionKind !== "draft"
        || frozen.createdBy !== command.actorId
        || frozen.stableCommandHash !== commandHash) {
        fail("idempotency_reference_invalid");
      }
      await this.options.repository.assertCaseAccessible(
        context.workspaceId,
        quoteCaseId,
        command.actorId
      );
      return frozen;
    }, async () => {
      const committed = await this.options.repository.findDraftByStableCommandHash(
        context.workspaceId,
        commandHash
      );
      if (committed) return { resourceId: committed.id, operationId: null };
      const calculated = await this.calculate(context, input.quoteInput, effectiveAt);
      if (calculated.amountState !== "actionable") fail("quote_not_actionable");
      if (!exactPreview(calculated, input.previewIdentity)) {
        fail("pricing_policy_stale");
      }
      const appended = await this.options.repository.appendVersionFromCalculation({
        workspaceId: context.workspaceId,
        quoteCaseId,
        expectedQuoteCaseRevision: expectedRevision,
        stableCommandHash: commandHash,
        versionKind: "draft",
        sourceDraftVersionId: null,
        effectiveAt,
        calculated,
        probabilityAssessmentSnapshot: null,
        actorId: command.actorId,
        idempotencyKey: command.idempotencyKey,
        requestHash: command.requestHash
      });
      return { resourceId: appended.version.id, operationId: null };
    });
  }

  async listVersions(context: ActiveWorkspaceContext, quoteCaseId: string) {
    requireGrowthCapabilities(context, ["quote.draft.create"]);
    await this.options.repository.assertCaseAccessible(
      context.workspaceId,
      quoteCaseId,
      context.actorId
    );
    return this.options.repository.listVersions(context.workspaceId, quoteCaseId);
  }

  async getVersion(context: ActiveWorkspaceContext, id: string) {
    requireGrowthCapabilities(context, ["quote.draft.create"]);
    const version = await this.options.repository.getVersion(context.workspaceId, id);
    if (!version) fail("quote_version_not_found");
    await this.options.repository.assertCaseAccessible(
      context.workspaceId,
      version.quoteCaseId,
      context.actorId
    );
    return version;
  }

  private async currentProbability(
    context: ActiveWorkspaceContext,
    version: QuoteVersion
  ) {
    const candidateId = version.subjectEvidence
      && typeof version.subjectEvidence === "object"
      ? (version.subjectEvidence as { candidateId?: unknown }).candidateId
      : null;
    const dealId = version.subjectEvidence
      && typeof version.subjectEvidence === "object"
      ? (version.subjectEvidence as { dealId?: unknown }).dealId
      : null;
    if (typeof candidateId !== "string" || typeof dealId !== "string") {
      fail("quote_deal_binding_required");
    }
    const binding = version.commercialBindingSnapshot as
      | QuoteVersion["commercialBindingSnapshot"]
      | null;
    if (!binding || typeof binding !== "object") fail("quote_deal_binding_required");
    const verified = await this.options.bindingVerifier.verify(context, {
      candidateId,
      customerId: String(Reflect.get(binding, "customerId")),
      dealId
    });
    if (verified.bindingHash !== Reflect.get(binding, "bindingHash")) {
      fail("commercial_binding_authority_mismatch");
    }
    let assessment;
    try {
      assessment = assertFormalProbabilityAssessment(
        await this.options.probabilityAssessments.findCurrent(
          context.workspaceId,
          candidateId,
          dealId
        )
      );
    } catch {
      fail("probability_assessment_v2_required");
    }
    const authority = this.options.qualificationAuthority
      ? await this.options.qualificationAuthority.findCurrent(
          context.workspaceId,
          candidateId
        )
      : {
          qualificationDecisionId: Reflect.get(
            Reflect.get(binding, "attributionSnapshot") ?? {},
            "qualificationDecisionId"
          ),
          qualificationDecisionVersion: Reflect.get(
            Reflect.get(binding, "attributionSnapshot") ?? {},
            "decisionVersion"
          ),
          inputSnapshotHash: assessment.inputSnapshotHash
        };
    if (!authority
      || assessment.qualificationDecisionId !== authority.qualificationDecisionId
      || assessment.qualificationDecisionVersion
        !== authority.qualificationDecisionVersion
      || assessment.inputSnapshotHash !== authority.inputSnapshotHash
      || assessment.dealId !== dealId) {
      fail("probability_assessment_v2_required");
    }
    return assessment;
  }

  async submit(
    command: CommandContext,
    draftVersionId: string
  ): Promise<QuoteCommandExecution<{
    sourceDraftVersion: QuoteVersion;
    submittedVersion: QuoteVersion;
    approval: QuoteApproval;
  }>> {
    const context = assertCommand(command);
    const expectedRevision = requireExpectedRevision(command);
    const effectiveAt = instant(this.now());
    const commandHash = stableHash("submit", {
      workspaceId: context.workspaceId,
      actorId: command.actorId,
      draftVersionId,
      expectedRevision,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash
    });
    const project = async (resourceId: string | null, operationId: string | null) => {
      assertCommand(command);
      if (!resourceId || !operationId) fail("idempotency_reference_invalid");
      const [submittedVersion, approval, sourceDraftVersion] = await Promise.all([
        this.options.repository.getVersion(context.workspaceId, resourceId),
        this.options.repository.getApproval(context.workspaceId, operationId),
        this.options.repository.getVersion(context.workspaceId, draftVersionId)
      ]);
      if (!submittedVersion || !approval || !sourceDraftVersion
        || submittedVersion.versionKind !== "formal"
        || submittedVersion.sourceDraftVersionId !== sourceDraftVersion.id
        || submittedVersion.stableCommandHash !== commandHash
        || approval.quoteVersionId !== submittedVersion.id) {
        fail("idempotency_reference_invalid");
      }
      await this.options.repository.assertCaseAccessible(
        context.workspaceId,
        submittedVersion.quoteCaseId,
        command.actorId
      );
      return { sourceDraftVersion, submittedVersion, approval };
    };
    return executeGrowthIdempotentCommand({
      repository: this.options.foundation.httpIdempotency,
      reservation: this.reservation(
        command,
        "/api/v1/quotes/versions/:id/submit",
        effectiveAt
      )
    }, project, async () => {
      const source = await this.options.repository.getVersion(
        context.workspaceId,
        draftVersionId
      );
      if (!source || source.versionKind !== "draft") fail("quote_draft_not_found");
      const already = (await this.options.repository.listVersions(
        context.workspaceId,
        source.quoteCaseId
      )).find((row) => row.sourceDraftVersionId === source.id);
      if (already) {
        if (already.stableCommandHash !== commandHash) {
          fail("quote_draft_already_submitted");
        }
        const approval = await this.options.repository.findApprovalByQuoteVersion(
          context.workspaceId,
          already.id
        );
        if (!approval) fail("idempotency_reference_invalid");
        return { resourceId: already.id, operationId: approval.id };
      }
      if (source.lifecycleRevision !== expectedRevision) fail("revision_conflict");
      const probability = await this.currentProbability(context, source);
      const quoteInput = parsePreviewInput(source.inputSnapshot);
      const calculated = await this.calculate(context, quoteInput, effectiveAt);
      if (calculated.amountState !== "actionable"
        || calculated.gate.status === "hard_blocked") {
        fail("quote_not_actionable");
      }
      if (canonicalJsonStringify(calculated.previewIdentity)
        !== canonicalJsonStringify(source.previewIdentity)) {
        fail("pricing_policy_stale");
      }
      const policySnapshotHash = sha({
        schemaVersion: "pricing-policy-snapshot.v1",
        pricingPolicySnapshot: calculated.pricingPolicySnapshot
      });
      const appended = await this.options.repository.appendVersionFromCalculation({
        workspaceId: context.workspaceId,
        quoteCaseId: source.quoteCaseId,
        expectedQuoteCaseRevision: expectedRevision,
        stableCommandHash: commandHash,
        versionKind: "formal",
        sourceDraftVersionId: source.id,
        effectiveAt,
        calculated,
        probabilityAssessmentSnapshot: probability,
        actorId: command.actorId,
        idempotencyKey: command.idempotencyKey,
        requestHash: command.requestHash,
        approval: {
          approvalKind: calculated.gate.status === "confirmation_required"
            ? "confirmation" : "exception",
          requiredCapabilities: calculated.gate.requiredCapabilities,
          triggeredRules: calculated.gate.reasons.map((reason) => reason.code),
          pricingPolicyVersionId: calculated.pricingPolicySnapshot.id,
          policySnapshotHash,
          capabilityRegistryVersion: context.capabilityRegistryVersion
        }
      });
      if (!appended.approval) fail("quote_approval_append_failed");
      return {
        resourceId: appended.version.id,
        operationId: appended.approval.id
      };
    });
  }

}

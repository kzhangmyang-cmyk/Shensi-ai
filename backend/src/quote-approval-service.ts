import { createHash, randomUUID } from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";
import type { CommercialBindingSnapshot,
  CommercialBindingVerifier } from "./commercial-binding-snapshot.js";
import {
  GROWTH_CAPABILITIES,
  GROWTH_CAPABILITY_REGISTRY_VERSION,
  requireGrowthCapabilities,
  type GrowthCapability
} from "./growth-capabilities.js";
import { requireExpectedRevision,
  type CommandContext } from "./growth-command-context.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import type { GrowthCatalogServices } from "./growth-catalog-module.js";
import { executeGrowthIdempotentCommand } from "./growth-http-idempotency-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { QuoteCommandExecution } from "./quote-case-service.js";
import type {
  QuoteApproval,
  QuoteApprovalDecisionPersistenceResult,
  QuoteRepository,
  QuoteVersion
} from "./quote-repository.js";
import { QuoteCalculationService } from "./quote-calculation-service.js";
import type { QuoteCalculationInput } from "./quote-domain.js";

export type QuoteApprovalDecisionResult = QuoteApprovalDecisionPersistenceResult;

export class QuoteApprovalError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "QuoteApprovalError";
  }
}

function fail(code: string): never {
  throw new QuoteApprovalError(code);
}

function stableHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(canonicalJsonStringify(value) ?? "")
    .digest("hex")}`;
}

function bindingFrom(version: QuoteVersion): CommercialBindingSnapshot {
  const binding = version.commercialBindingSnapshot;
  if (!binding || typeof binding !== "object") fail("quote_deal_binding_required");
  return binding as CommercialBindingSnapshot;
}

function authorizeApproval(
  context: ActiveWorkspaceContext,
  approval: QuoteApproval
) {
  if (context.capabilityRegistryVersion !== GROWTH_CAPABILITY_REGISTRY_VERSION
    || approval.capabilityRegistryVersion
      !== GROWTH_CAPABILITY_REGISTRY_VERSION) {
    fail("capability_registry_version_unknown");
  }
  const required = approval.approvalKind === "confirmation"
    ? ["quote.confirm" as const]
    : approval.requiredCapabilities;
  const known = new Set<string>(GROWTH_CAPABILITIES);
  if (required.some((capability) => !known.has(capability))) {
    fail("capability_key_unknown");
  }
  requireGrowthCapabilities(context, required as readonly GrowthCapability[]);
}

export interface QuoteApprovalServiceOptions {
  readonly repository: QuoteRepository;
  readonly bindingVerifier: CommercialBindingVerifier;
  readonly foundation: GrowthFoundationServices;
  readonly catalog?: GrowthCatalogServices;
  readonly calculator?: QuoteCalculationService;
  readonly now?: () => string;
  readonly executionId?: () => string;
}

export class QuoteApprovalService {
  private readonly now: () => string;
  private readonly executionId: () => string;
  private readonly calculator: QuoteCalculationService;

  constructor(private readonly options: QuoteApprovalServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.executionId = options.executionId
      ?? (() => `quote-approval-execution-${randomUUID()}`);
    this.calculator = options.calculator ?? new QuoteCalculationService();
  }

  async listForVersion(
    context: ActiveWorkspaceContext,
    versionId: string
  ): Promise<readonly QuoteApproval[]> {
    requireGrowthCapabilities(context, ["quote.draft.create"]);
    const version = await this.options.repository.getVersion(
      context.workspaceId, versionId
    );
    if (!version) fail("quote_version_not_found");
    await this.options.repository.assertCaseAccessible(
      context.workspaceId, version.quoteCaseId, context.actorId
    );
    const approval = await this.options.repository.findApprovalByQuoteVersion(
      context.workspaceId, versionId
    );
    return Object.freeze(approval ? [approval] : []);
  }

  private async decide(
    command: CommandContext,
    versionId: string,
    input: { reason?: string | null },
    decision: "approve" | "reject" | "expire"
  ): Promise<QuoteCommandExecution<QuoteApprovalDecisionResult>> {
    if (command.actorId !== command.workspace.actorId) {
      fail("growth_actor_context_mismatch");
    }
    const expectedRevision = requireExpectedRevision(command);
    const version = await this.options.repository.getVersion(
      command.workspace.workspaceId, versionId
    );
    if (!version) fail("quote_version_not_found");
    if (version.versionKind !== "formal" || !version.sourceDraftVersionId
      || version.probabilityAssessmentSnapshot?.precision !== "bps") {
      fail("formal_quote_version_required");
    }
    const approval = await this.options.repository.findApprovalByQuoteVersion(
      command.workspace.workspaceId, versionId
    );
    if (!approval) fail("quote_approval_not_found");
    authorizeApproval(command.workspace, approval);
    if (approval.submittedBy === command.actorId) {
      fail("approval_self_decision_forbidden");
    }
    const reason = input.reason?.trim() || null;
    if (decision !== "approve" && !reason) fail("approval_reason_required");
    const binding = bindingFrom(version);
    if (this.options.catalog) {
      const line = Array.isArray(version.lineItems) ? version.lineItems[0] : null;
      const frozenInput = version.inputSnapshot;
      if (!line || typeof line !== "object" || !frozenInput
        || typeof frozenInput !== "object") {
        fail("quote_authority_revalidation_failed");
      }
      const effectiveAt = this.now();
      const authority = await this.options.catalog.quoteCatalog.resolveAt(
        command.workspace,
        {
          catalogItemId: String(Reflect.get(line, "catalogItemId")),
          pricingPolicyVersionId: String(Reflect.get(
            line, "pricingPolicyVersionId"
          )),
          effectiveAt
        }
      );
      const calculated = this.calculator.preview({
        workspaceId: command.workspace.workspaceId,
        ...(frozenInput as Omit<QuoteCalculationInput, "workspaceId">)
      }, authority.pricingPolicy, {
        giftPolicies: authority.pricingPolicy.giftPolicies,
        packageSnapshot: authority.packageCostSnapshot
      });
      if (calculated.amountState !== "actionable"
        || calculated.gate.status === "hard_blocked") {
        fail("quote_hard_blocked");
      }
      if (calculated.commercialAmountHash !== version.commercialAmountHash
        || calculated.inputSnapshotHash !== version.inputSnapshotHash
        || calculated.calculationHash !== version.calculationHash) {
        fail("quote_authority_revalidation_failed");
      }
    }
    const verified = await this.options.bindingVerifier.verify(
      command.workspace,
      { candidateId: binding.candidateId, customerId: binding.customerId,
        dealId: binding.dealId }
    );
    const commandHash = stableHash({
      schemaVersion: "quote-approval-command.v1",
      workspaceId: command.workspace.workspaceId,
      actorId: command.actorId,
      versionId,
      expectedRevision,
      decision,
      reason,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash
    });
    const project = async (resourceId: string | null,
      operationId: string | null) => {
      const currentApproval = await this.options.repository
        .findApprovalByQuoteVersion(command.workspace.workspaceId, versionId);
      if (!currentApproval) fail("idempotency_reference_invalid");
      authorizeApproval(command.workspace, currentApproval);
      const result = await this.options.repository
        .findApprovalDecisionByStableCommandHash(
          command.workspace.workspaceId, commandHash
        );
      if (!result || resourceId !== result.quoteVersion.id
        || operationId !== result.publicationOperation.id) {
        fail("idempotency_reference_invalid");
      }
      return result;
    };
    return executeGrowthIdempotentCommand({
      repository: this.options.foundation.httpIdempotency,
      reservation: {
        workspaceId: command.workspace.workspaceId,
        actorId: command.actorId,
        method: "POST",
        canonicalPath: `/api/v1/quotes/versions/:id/${decision}`,
        key: command.idempotencyKey,
        requestHash: command.requestHash,
        attemptedAt: this.now(),
        leaseOwner: this.executionId(),
        leaseDurationMs: 30_000
      }
    }, project, async () => {
      const committed = await this.options.repository
        .findApprovalDecisionByStableCommandHash(
          command.workspace.workspaceId, commandHash
        );
      const result = committed ?? await this.options.repository.decideApproval({
        workspaceId: command.workspace.workspaceId,
        actorId: command.actorId,
        quoteVersionId: versionId,
        expectedRevision,
        decision,
        reason,
        stableCommandHash: commandHash,
        requestHash: command.requestHash,
        verifiedBindingSnapshot: verified
      });
      return { resourceId: result.quoteVersion.id,
        operationId: result.publicationOperation.id };
    });
  }

  approve(
    context: CommandContext,
    versionId: string,
    input: { reason?: string | null }
  ) {
    return this.decide(context, versionId, input, "approve");
  }

  reject(
    context: CommandContext,
    versionId: string,
    input: { reason: string }
  ) {
    return this.decide(context, versionId, input, "reject");
  }

  expire(
    context: CommandContext,
    versionId: string,
    input: { reason: string }
  ) {
    return this.decide(context, versionId, input, "expire");
  }
}

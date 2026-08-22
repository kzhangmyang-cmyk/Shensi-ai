import { randomUUID } from "node:crypto";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import {
  executeGrowthIdempotentCommand,
  type GrowthHttpIdempotencyRepository,
  type GrowthHttpIdempotencyReservationInput
} from "./growth-http-idempotency-repository.js";
import { requireExpectedRevision, type CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { ProbabilityAssessmentRepository } from "./probability-assessment.js";
import type { CommercialBindingVerifier } from "./commercial-binding-snapshot.js";
import type { GrowthWorkspaceMemberAssignabilityReader } from "./growth-workspace-member-assignability.js";
import type {
  QuoteCase,
  QuoteCaseListQuery,
  QuoteCasePage,
  QuoteRepository
} from "./quote-repository.js";

export interface QuoteCommandExecution<T> {
  readonly value: T;
  readonly replayed: boolean;
}

export interface QuoteCaseCreateInput {
  readonly candidateId?: string;
  readonly customerId?: string;
  readonly dealId?: string;
  readonly assignedTo: string;
}

export interface BindQuoteCaseDealInput {
  readonly dealId: string;
}

export interface QuoteSubjectReader {
  resolve(
    context: ActiveWorkspaceContext,
    input: { candidateId?: string; customerId?: string; dealId?: string }
  ): Promise<{
    candidateId: string | null;
    customerId: string | null;
    dealId: string | null;
  } | null>;
}

function quoteError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function text(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

export interface QuoteCaseServiceOptions {
  readonly repository: QuoteRepository;
  readonly httpIdempotency: GrowthHttpIdempotencyRepository;
  readonly assignments: GrowthWorkspaceMemberAssignabilityReader;
  readonly subjects: QuoteSubjectReader;
  readonly bindingVerifier: CommercialBindingVerifier;
  readonly probabilityAssessments: ProbabilityAssessmentRepository;
  readonly now?: () => string;
  readonly idFactory?: () => string;
  readonly leaseOwner?: string;
  readonly leaseDurationMs?: number;
}

export class QuoteCaseService {
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly leaseOwner: string;
  private readonly leaseDurationMs: number;

  constructor(private readonly options: QuoteCaseServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => `quote-case-${randomUUID()}`);
    this.leaseOwner = options.leaseOwner ?? `quote-case-service-${randomUUID()}`;
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
  }

  private authorize(context: ActiveWorkspaceContext) {
    requireGrowthCapabilities(context, ["quote.draft.create"]);
    if (!context.workspaceId.trim() || context.workspaceId === "all") {
      throw quoteError("invalid_growth_workspace_id");
    }
  }

  private commandIdentity(command: CommandContext) {
    this.authorize(command.workspace);
    if (command.actorId !== command.workspace.actorId) {
      throw quoteError("growth_actor_context_mismatch");
    }
    return command.workspace;
  }

  private reservation(
    command: CommandContext,
    method: string,
    canonicalPath: string
  ): GrowthHttpIdempotencyReservationInput {
    return {
      workspaceId: command.workspace.workspaceId,
      actorId: command.workspace.actorId,
      method,
      canonicalPath,
      key: command.idempotencyKey,
      requestHash: command.requestHash,
      attemptedAt: this.now(),
      leaseOwner: this.leaseOwner,
      leaseDurationMs: this.leaseDurationMs
    };
  }

  async list(
    context: ActiveWorkspaceContext,
    query: QuoteCaseListQuery
  ): Promise<QuoteCasePage> {
    this.authorize(context);
    return this.options.repository.listCases(context.workspaceId, query);
  }

  async get(
    context: ActiveWorkspaceContext,
    id: string
  ): Promise<QuoteCase> {
    this.authorize(context);
    const quoteCase = await this.options.repository.findCase(
      context.workspaceId,
      id
    );
    if (!quoteCase) throw quoteError("quote_case_not_found");
    return quoteCase;
  }

  async create(
    command: CommandContext,
    input: QuoteCaseCreateInput
  ): Promise<QuoteCommandExecution<QuoteCase>> {
    const context = this.commandIdentity(command);
    const requested = {
      candidateId: text(input.candidateId),
      customerId: text(input.customerId),
      dealId: text(input.dealId)
    };
    if (!requested.candidateId && !requested.customerId && !requested.dealId) {
      throw quoteError("quote_case_subject_required");
    }
    const assignedTo = text(input.assignedTo);
    if (!assignedTo) throw quoteError("quote_assignee_invalid");
    return executeGrowthIdempotentCommand({
      repository: this.options.httpIdempotency,
      reservation: this.reservation(command, "POST", "/growth/quote-cases")
    }, async (resourceId) => {
      await this.options.assignments.assertAssignable(context, assignedTo);
      if (!resourceId) throw quoteError("idempotency_reference_invalid");
      return this.get(context, resourceId);
    }, async () => {
      const assignment = await this.options.assignments.assertAssignable(
        context,
        assignedTo
      );
      const subject = await this.options.subjects.resolve(context, {
        candidateId: requested.candidateId ?? undefined,
        customerId: requested.customerId ?? undefined,
        dealId: requested.dealId ?? undefined
      });
      if (!subject || (!subject.candidateId && !subject.customerId
        && !subject.dealId)) throw quoteError("quote_subject_not_found");
      let bindingSnapshot = null;
      let probabilityAssessment = null;
      if (subject.dealId) {
        if (!subject.candidateId || !subject.customerId) {
          throw quoteError("commercial_binding_authority_mismatch");
        }
        bindingSnapshot = await this.options.bindingVerifier.verify(context, {
          candidateId: subject.candidateId,
          customerId: subject.customerId,
          dealId: subject.dealId
        });
        const current = await this.options.probabilityAssessments.findCurrent(
          context.workspaceId,
          subject.candidateId
        );
        if (!current) throw quoteError("probability_assessment_v2_required");
        probabilityAssessment = await this.options.probabilityAssessments.bindDeal(
          context.workspaceId,
          current.id,
          subject.dealId,
          bindingSnapshot.bindingHash
        );
      }
      const id = this.idFactory();
      const createdAt = this.now();
      const quoteCase: QuoteCase = {
        id,
        workspaceId: context.workspaceId,
        candidateId: subject.candidateId,
        customerId: subject.customerId,
        dealId: subject.dealId,
        assignedTo: assignment.actorId,
        status: "open",
        currentDraftVersionId: null,
        revision: 1,
        commercialBindingSnapshot: bindingSnapshot,
        createdAt,
        updatedAt: createdAt
      };
      const result = await this.options.repository.createCase({
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        commandKey: command.idempotencyKey,
        requestHash: command.requestHash,
        expectedRevision: null,
        quoteCase,
        bindingSnapshot,
        probabilityAssessment
      });
      return { resourceId: result.quoteCase.id, operationId: null };
    });
  }

  async bindDeal(
    command: CommandContext,
    id: string,
    input: BindQuoteCaseDealInput
  ): Promise<QuoteCommandExecution<QuoteCase>> {
    const context = this.commandIdentity(command);
    const expectedRevision = requireExpectedRevision(command);
    const dealId = text(input.dealId);
    if (!dealId) throw quoteError("invalid_quote_deal_id");
    return executeGrowthIdempotentCommand({
      repository: this.options.httpIdempotency,
      reservation: this.reservation(command, "POST",
        `/growth/quote-cases/${id}/bind-deal`)
    }, async (resourceId) => {
      if (resourceId !== id) throw quoteError("idempotency_reference_invalid");
      return this.get(context, id);
    }, async () => {
      const currentCase = await this.get(context, id);
      if (currentCase.dealId && currentCase.dealId !== dealId) {
        throw quoteError("quote_case_rebind_forbidden");
      }
      const subject = await this.options.subjects.resolve(context, {
        candidateId: currentCase.candidateId ?? undefined,
        customerId: currentCase.customerId ?? undefined,
        dealId
      });
      if (!subject?.candidateId || !subject.customerId
        || subject.dealId !== dealId) {
        throw quoteError("commercial_binding_authority_mismatch");
      }
      const snapshot = await this.options.bindingVerifier.verify(context, {
        candidateId: subject.candidateId,
        customerId: subject.customerId,
        dealId
      });
      const currentAssessment = await this.options.probabilityAssessments
        .findCurrent(context.workspaceId, subject.candidateId);
      if (!currentAssessment) {
        throw quoteError("probability_assessment_v2_required");
      }
      const boundAssessment = await this.options.probabilityAssessments.bindDeal(
        context.workspaceId,
        currentAssessment.id,
        dealId,
        snapshot.bindingHash
      );
      const result = await this.options.repository.bindCaseDeal({
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        commandKey: command.idempotencyKey,
        requestHash: command.requestHash,
        expectedRevision,
        quoteCaseId: id,
        dealId,
        bindingSnapshot: snapshot,
        probabilityAssessment: boundAssessment
      });
      return { resourceId: result.quoteCase.id, operationId: null };
    });
  }

  private transition(
    command: CommandContext,
    id: string,
    operation: "close" | "cancel"
  ): Promise<QuoteCommandExecution<QuoteCase>> {
    const context = this.commandIdentity(command);
    const expectedRevision = requireExpectedRevision(command);
    return executeGrowthIdempotentCommand({
      repository: this.options.httpIdempotency,
      reservation: this.reservation(command, "POST",
        `/growth/quote-cases/${id}/${operation}`)
    }, async (resourceId) => {
      if (resourceId !== id) throw quoteError("idempotency_reference_invalid");
      return this.get(context, id);
    }, async () => {
      const execute = operation === "close"
        ? this.options.repository.closeCase.bind(this.options.repository)
        : this.options.repository.cancelCase.bind(this.options.repository);
      const result = await execute({
        workspaceId: context.workspaceId,
        actorId: context.actorId,
        commandKey: command.idempotencyKey,
        requestHash: command.requestHash,
        expectedRevision,
        quoteCaseId: id
      });
      return { resourceId: result.quoteCase.id, operationId: null };
    });
  }

  close(command: CommandContext, id: string) {
    return this.transition(command, id, "close");
  }

  cancel(command: CommandContext, id: string) {
    return this.transition(command, id, "cancel");
  }
}

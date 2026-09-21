import type { QuoteCrmCommand } from "./quote-crm-command.js";
import type {
  QuotePublicationClaim,
  QuotePublicationOperation,
  QuoteRepository
} from "./quote-repository.js";

export type QuotePublicationRunResult = Readonly<{
  status: "succeeded" | "busy" | "cancelled" | "lease_lost"
    | "failed" | "partial_failure";
  operationId: string;
}>;

function errorCode(error: unknown) {
  if (error && typeof error === "object" && "code" in error
    && typeof error.code === "string" && error.code.trim()) return error.code;
  return "quote_publication_failed";
}

export class QuotePublicationWorker {
  private readonly leaseDurationMs: number;

  constructor(private readonly options: {
    repository: QuoteRepository;
    crm: QuoteCrmCommand;
    workerId: string;
    leaseDurationMs?: number;
    now?: () => Date;
  }) {
    this.leaseDurationMs = options.leaseDurationMs ?? 30_000;
    if (!options.workerId.trim() || !Number.isSafeInteger(this.leaseDurationMs)
      || this.leaseDurationMs < 1_000) {
      throw new Error("invalid_quote_publication_worker_options");
    }
  }

  private now() {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private nextExpiry(now: string) {
    return new Date(Date.parse(now) + this.leaseDurationMs).toISOString();
  }

  private result(status: QuotePublicationRunResult["status"], operationId: string) {
    return Object.freeze({ status, operationId });
  }

  private async currentOrCancel(claim: QuotePublicationClaim) {
    if (await this.options.repository.isPublicationAuthorityCurrent(claim)) {
      return true;
    }
    const cancelled = await this.options.repository.cancelPublication(
      claim,
      "publication_authority_changed",
      this.now()
    );
    return cancelled ? false : null;
  }

  async runOne(operationId: string): Promise<QuotePublicationRunResult> {
    const startedAt = this.now();
    const claim = await this.options.repository.claimPublication(
      operationId,
      this.options.workerId,
      startedAt,
      this.nextExpiry(startedAt)
    );
    if (!claim) return this.result("busy", operationId);
    return this.runClaimed(claim);
  }

  async resumeClaimed(operationId: string): Promise<QuotePublicationRunResult> {
    const operation = await this.options.repository.getPublication(operationId);
    if (!operation?.leaseOwner || !operation.leaseExpiresAt) {
      return this.result("lease_lost", operationId);
    }
    return this.runClaimed(Object.freeze({ operationId,
      leaseOwner: operation.leaseOwner, fencingToken: operation.fencingToken,
      leaseExpiresAt: operation.leaseExpiresAt,
      authorityRevision: operation.dealAuthorityRevision }));
  }

  private async runClaimed(
    claim: QuotePublicationClaim
  ): Promise<QuotePublicationRunResult> {
    const operationId = claim.operationId;
    try {
      const authority = await this.currentOrCancel(claim);
      if (authority === false) return this.result("cancelled", operationId);
      if (authority === null) return this.result("lease_lost", operationId);
      let operation = await this.options.repository.getPublication(operationId);
      if (!operation || operation.status !== "running") {
        return this.result("lease_lost", operationId);
      }
      const version = await this.options.repository.getVersion(
        operation.workspaceId,
        operation.quoteVersionId
      );
      if (!version || version.versionKind !== "formal"
        || version.status !== "approved") {
        const cancelled = await this.options.repository.cancelPublication(
          claim,
          "publication_version_not_approved",
          this.now()
        );
        return this.result(cancelled ? "cancelled" : "lease_lost", operationId);
      }
      if (!operation.piDocumentId) {
        const beforePi = await this.currentOrCancel(claim);
        if (beforePi !== true) {
          return this.result(beforePi === false ? "cancelled" : "lease_lost",
            operationId);
        }
        const pi = await this.options.crm.ensurePiProjection(
          this.piInput(operation, version)
        );
        const afterPi = await this.currentOrCancel(claim);
        if (afterPi !== true) {
          return this.result(afterPi === false ? "cancelled" : "lease_lost",
            operationId);
        }
        if (!await this.options.repository.recordPiPublished(
          claim,
          pi.piDocumentId,
          this.now()
        )) return this.result("lease_lost", operationId);
      }
      const heartbeatAt = this.now();
      if (!await this.options.repository.renewPublicationLease(
        claim,
        heartbeatAt,
        this.nextExpiry(heartbeatAt)
      )) return this.result("lease_lost", operationId);
      operation = await this.options.repository.getPublication(operationId);
      if (!operation) return this.result("lease_lost", operationId);
      if (!operation.dealEventId) {
        const beforeCrm = await this.currentOrCancel(claim);
        if (beforeCrm !== true) {
          return this.result(beforeCrm === false ? "cancelled" : "lease_lost",
            operationId);
        }
        const crm = await this.options.crm.publishQuotedDeal({
          ...this.piInput(operation, version),
          piDocumentId: operation.piDocumentId!,
          actorId: version.createdBy
        });
        const afterCrm = await this.currentOrCancel(claim);
        if (afterCrm !== true) {
          return this.result(afterCrm === false ? "cancelled" : "lease_lost",
            operationId);
        }
        if (!await this.options.repository.recordCrmPublished(
          claim,
          crm.dealEventId,
          this.now()
        )) return this.result("lease_lost", operationId);
      }
      const beforeFinish = await this.currentOrCancel(claim);
      if (beforeFinish !== true) {
        return this.result(beforeFinish === false ? "cancelled" : "lease_lost",
          operationId);
      }
      if (!await this.options.repository.finishPublication(claim, this.now())) {
        return this.result("lease_lost", operationId);
      }
      return this.result("succeeded", operationId);
    } catch (error) {
      const failed = await this.options.repository.failPublication(
        claim,
        errorCode(error),
        this.now()
      ).catch(() => false);
      if (!failed) return this.result("lease_lost", operationId);
      const operation = await this.options.repository.getPublication(operationId);
      return this.result(operation?.status === "partial_failure"
        ? "partial_failure" : "failed", operationId);
    }
  }

  private piInput(
    operation: QuotePublicationOperation,
    quoteVersion: Awaited<ReturnType<QuoteRepository["getVersion"]>> & {}
  ) {
    return {
      workspaceId: operation.workspaceId, dealId: operation.dealId,
      quoteCaseId: operation.quoteCaseId, quoteVersion,
      dealAuthorityRevision: operation.dealAuthorityRevision,
      commercialAmountHash: operation.commercialAmountHash,
      stableKey: operation.idempotencyKey
    };
  }
}

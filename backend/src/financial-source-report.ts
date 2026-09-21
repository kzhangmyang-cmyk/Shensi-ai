import { randomUUID } from "node:crypto";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import {
  GrowthHttpError,
  type CommandContext
} from "./growth-command-context.js";
import { hashCanonicalJson } from "./growth-roi-command-executor.js";
import type {
  RoiCommandExecutor
} from "./growth-roi-command-executor.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export class FinancialSourceReportError extends GrowthHttpError {
  constructor(code: string, status = 400) {
    super(status, code);
    this.name = "FinancialSourceReportError";
  }
}

export interface FinancialSourceReport {
  id: string;
  workspaceId: string;
  currency: string;
  sourceSystem: string;
  sourceCursor: string | null;
  reportHash: string;
  declaredTotalMinor: number;
  periodFrom: string;
  periodTo: string;
  createdBy: string;
  createdAt: string;
}

export interface FinancialSourceReportService {
  create(
    context: CommandContext,
    input: {
      currency: string;
      sourceSystem: string;
      sourceCursor: string | null;
      reportHash: `sha256:${string}`;
      declaredTotalMinor: number;
      periodFrom: string;
      periodTo: string;
    }
  ): Promise<FinancialSourceReport>;
  get(
    workspace: ActiveWorkspaceContext,
    id: string
  ): Promise<FinancialSourceReport | null>;
}

interface PersistedFinancialSourceReport extends FinancialSourceReport {
  domainCommandHash: `sha256:${string}`;
  requestHash: string;
  requestedBy: string;
}

export class DefaultFinancialSourceReportService
implements FinancialSourceReportService {
  private readonly commandExecutor: RoiCommandExecutor;
  private readonly now: () => string;
  private readonly ids: { next(): string };
  private readonly reports = new Map<string, PersistedFinancialSourceReport>();
  private reportCount = 0;

  constructor(input: {
    commandExecutor: RoiCommandExecutor;
    now?: () => string;
    ids?: { next(): string };
  }) {
    this.commandExecutor = input.commandExecutor;
    this.now = input.now ?? (() => new Date().toISOString());
    this.ids = input.ids ?? { next: randomUUID };
  }

  private key(workspaceId: string, id: string): string {
    return `${workspaceId}\u0000${id}`;
  }

  async create(
    context: CommandContext,
    input: {
      currency: string;
      sourceSystem: string;
      sourceCursor: string | null;
      reportHash: `sha256:${string}`;
      declaredTotalMinor: number;
      periodFrom: string;
      periodTo: string;
    }
  ): Promise<FinancialSourceReport> {
    requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
    const domainCommandHash = hashCanonicalJson({
      workspaceId: context.workspace.workspaceId,
      actorId: context.actorId,
      canonicalPath: "/api/v1/finance/source-reports",
      idempotencyKey: context.idempotencyKey,
      requestHash: context.requestHash,
      ...input
    });
    return this.commandExecutor.execute(
      context,
      {
        method: "POST",
        canonicalPath: "/api/v1/finance/source-reports",
        resourceKind: "source_report"
      },
      {
        authorizeAndProject: async (ids) => {
          requireGrowthCapabilities(context.workspace, ["ledger.pending.create"]);
          if (!ids.resourceId || ids.operationId !== null) {
            throw new FinancialSourceReportError(
              "idempotency_reference_invalid", 409
            );
          }
          const report = this.reports.get(
            this.key(context.workspace.workspaceId, ids.resourceId)
          );
          if (!report) {
            throw new FinancialSourceReportError("idempotency_conflict", 409);
          }
          return this.project(report);
        },
        executeClaimed: async (hash) => {
          const replay = [...this.reports.values()].find((report) =>
            report.workspaceId === context.workspace.workspaceId
            && report.domainCommandHash === hash);
          if (replay) {
            if (replay.requestedBy !== context.actorId
              || replay.requestHash !== context.requestHash) {
              throw new FinancialSourceReportError(
                "idempotency_conflict", 409
              );
            }
            return { resourceId: replay.id, operationId: null };
          }
          const existing = [...this.reports.values()].find((report) =>
            report.workspaceId === context.workspace.workspaceId
            && report.reportHash === input.reportHash);
          if (existing) {
            return { resourceId: existing.id, operationId: null };
          }
          const id = this.ids.next();
          this.reportCount += 1;
          const report: PersistedFinancialSourceReport = Object.freeze({
            id,
            workspaceId: context.workspace.workspaceId,
            currency: input.currency,
            sourceSystem: input.sourceSystem,
            sourceCursor: input.sourceCursor,
            reportHash: input.reportHash,
            declaredTotalMinor: input.declaredTotalMinor,
            periodFrom: input.periodFrom,
            periodTo: input.periodTo,
            createdBy: context.actorId,
            createdAt: this.now(),
            domainCommandHash: hash,
            requestHash: context.requestHash,
            requestedBy: context.actorId
          });
          this.reports.set(this.key(report.workspaceId, report.id), report);
          return { resourceId: report.id, operationId: null };
        }
      }
    );
  }

  async get(
    workspace: ActiveWorkspaceContext,
    id: string
  ): Promise<FinancialSourceReport | null> {
    requireGrowthCapabilities(workspace, ["ledger.pending.create"]);
    const report = this.reports.get(this.key(workspace.workspaceId, id));
    return report ? this.project(report) : null;
  }

  private project(
    report: PersistedFinancialSourceReport
  ): FinancialSourceReport {
    return Object.freeze({
      id: report.id,
      workspaceId: report.workspaceId,
      currency: report.currency,
      sourceSystem: report.sourceSystem,
      sourceCursor: report.sourceCursor,
      reportHash: report.reportHash,
      declaredTotalMinor: report.declaredTotalMinor,
      periodFrom: report.periodFrom,
      periodTo: report.periodTo,
      createdBy: report.createdBy,
      createdAt: report.createdAt
    });
  }

  countReports(): number {
    return this.reportCount;
  }
}

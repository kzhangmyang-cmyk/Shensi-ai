import type mysql from "mysql2/promise";
import {
  createFinancialCouncilDraft,
  type FinancialCouncilDraft
} from "./financial-council-draft.js";
import type {
  FinancialCouncilDraftCommandResult,
  FinancialCouncilDraftDispatchResult,
  FinancialCouncilDraftRepository
} from "./financial-council-draft-repository.js";
import { financialCouncilDraftDispatchResult } from
  "./financial-council-draft-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

type MysqlRow = Record<string, unknown>;

export const FINANCIAL_COUNCIL_DRAFT_MYSQL_SCHEMA_STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS financial_council_drafts (
    workspace_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    draft_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    run_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    portfolio_revision BIGINT UNSIGNED NOT NULL,
    action_id CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    draft_kind VARCHAR(48) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    approval_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    portfolio_output_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    dispatch_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL,
    content_hash CHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    draft_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, draft_id),
    UNIQUE KEY uq_financial_council_draft_dispatch (workspace_id, dispatch_hash),
    CONSTRAINT chk_financial_council_draft_kind CHECK (draft_kind IN
      ('budget_adjustment_draft','finance_todo','tax_review_task','data_completion_plan')),
    CONSTRAINT chk_financial_council_draft_json CHECK (JSON_VALID(draft_json))
  ) ENGINE=InnoDB`
] as const);

export async function ensureFinancialCouncilDraftMysqlSchema(
  pool: mysql.Pool
): Promise<void> {
  for (const statement of FINANCIAL_COUNCIL_DRAFT_MYSQL_SCHEMA_STATEMENTS) {
    await pool.query(statement);
  }
}

function conflict(): Error & { code: string } {
  return Object.assign(new Error("financial_council_draft_conflict"), {
    code: "financial_council_draft_conflict"
  });
}

function assertDispatchHash(value: string): asserts value is `sha256:${string}` {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw Object.assign(new Error("financial_council_draft_invalid"), {
      code: "financial_council_draft_invalid"
    });
  }
}

function sqlDate(value: string): string {
  return value.slice(0, 23).replace("T", " ");
}

function parseJson(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function stableDraft(raw: unknown): FinancialCouncilDraft {
  const value = parseJson(raw) as FinancialCouncilDraft;
  return createFinancialCouncilDraft({
    workspaceId: value.workspaceId, runId: value.runId,
    portfolioRevision: value.portfolioRevision, actionId: value.actionId,
    actionKind: value.actionKind, kind: value.kind,
    approvalId: value.approvalId, approvalHash: value.approvalHash,
    portfolioOutputHash: value.portfolioOutputHash,
    snapshotHash: value.snapshotHash, policyHash: value.policyHash,
    approvedAt: value.approvedAt, createdAt: value.createdAt,
    ...(value.kind === "budget_adjustment_draft" ? { lines: value.lines }
      : value.kind === "finance_todo"
        ? { assigneeId: value.assigneeId, dueAt: value.dueAt }
        : value.kind === "tax_review_task"
          ? { disclaimer: value.disclaimer }
          : { targetRef: value.targetRef })
  });
}

function rowDraft(row: MysqlRow): FinancialCouncilDraft {
  const draft = stableDraft(row.draft_json);
  if (draft.workspaceId !== row.workspace_id || draft.draftId !== row.draft_id
    || draft.contentHash !== row.content_hash) throw conflict();
  return draft;
}

export class MysqlFinancialCouncilDraftRepository
implements FinancialCouncilDraftRepository {
  constructor(private readonly pool: mysql.Pool) {}

  async create(
    raw: FinancialCouncilDraft
  ): Promise<FinancialCouncilDraftCommandResult<FinancialCouncilDraft>> {
    const draft = stableDraft(raw);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const existing = await this.select(connection, draft.workspaceId, draft.draftId,
        true);
      if (existing) {
        if (existing.contentHash !== draft.contentHash) throw conflict();
        await connection.commit();
        return { value: existing, replayed: true };
      }
      await connection.query(
        `INSERT INTO financial_council_drafts (
          workspace_id, draft_id, run_id, portfolio_revision, action_id,
          draft_kind, approval_hash, portfolio_output_hash, dispatch_hash,
          content_hash, draft_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [draft.workspaceId, draft.draftId, draft.runId, draft.portfolioRevision,
          draft.actionId, draft.kind, draft.approvalHash,
          draft.portfolioOutputHash, null, draft.contentHash,
          JSON.stringify(draft), sqlDate(draft.createdAt)]
      );
      await connection.commit();
      return { value: draft, replayed: false };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async findById(
    context: ActiveWorkspaceContext,
    draftId: string
  ): Promise<FinancialCouncilDraft | null> {
    const [rows] = await this.pool.query(
      `SELECT workspace_id, draft_id, content_hash, draft_json
       FROM financial_council_drafts WHERE workspace_id = ? AND draft_id = ?`,
      [context.workspaceId, draftId]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? rowDraft(row) : null;
  }

  async probeByDispatchHash(
    context: ActiveWorkspaceContext,
    dispatchHash: `sha256:${string}`
  ): Promise<FinancialCouncilDraftDispatchResult | null> {
    assertDispatchHash(dispatchHash);
    const [rows] = await this.pool.query(
      `SELECT workspace_id, draft_id, content_hash, draft_json
       FROM financial_council_drafts
       WHERE workspace_id = ? AND dispatch_hash = ?`,
      [context.workspaceId, dispatchHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? financialCouncilDraftDispatchResult(rowDraft(row)) : null;
  }

  async createFromApprovedDispatch(input: {
    readonly dispatchHash: `sha256:${string}`;
    readonly draft: FinancialCouncilDraft;
  }): Promise<FinancialCouncilDraftCommandResult<FinancialCouncilDraftDispatchResult>> {
    assertDispatchHash(input.dispatchHash);
    const draft = stableDraft(input.draft);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const dispatched = await this.selectByDispatchHash(
        connection, draft.workspaceId, input.dispatchHash, true
      );
      if (dispatched) {
        if (dispatched.contentHash !== draft.contentHash) throw conflict();
        await connection.commit();
        return {
          value: financialCouncilDraftDispatchResult(dispatched), replayed: true
        };
      }
      const existing = await this.select(
        connection, draft.workspaceId, draft.draftId, true
      );
      if (existing) {
        if (existing.contentHash !== draft.contentHash) throw conflict();
        const existingDispatch = await this.dispatchHashForDraft(
          connection, draft.workspaceId, draft.draftId
        );
        if (existingDispatch && existingDispatch !== input.dispatchHash) {
          throw conflict();
        }
        if (!existingDispatch) {
          await connection.query(
            `UPDATE financial_council_drafts SET dispatch_hash = ?
             WHERE workspace_id = ? AND draft_id = ? AND dispatch_hash IS NULL`,
            [input.dispatchHash, draft.workspaceId, draft.draftId]
          );
        }
        await connection.commit();
        return {
          value: financialCouncilDraftDispatchResult(existing), replayed: true
        };
      }
      await connection.query(
        `INSERT INTO financial_council_drafts (
          workspace_id, draft_id, run_id, portfolio_revision, action_id,
          draft_kind, approval_hash, portfolio_output_hash, dispatch_hash,
          content_hash, draft_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [draft.workspaceId, draft.draftId, draft.runId, draft.portfolioRevision,
          draft.actionId, draft.kind, draft.approvalHash,
          draft.portfolioOutputHash, input.dispatchHash, draft.contentHash,
          JSON.stringify(draft), sqlDate(draft.createdAt)]
      );
      await connection.commit();
      return {
        value: financialCouncilDraftDispatchResult(draft), replayed: false
      };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  private async select(
    connection: mysql.PoolConnection,
    workspaceId: string,
    draftId: string,
    lock: boolean
  ): Promise<FinancialCouncilDraft | null> {
    const [rows] = await connection.query(
      `SELECT workspace_id, draft_id, content_hash, draft_json
       FROM financial_council_drafts WHERE workspace_id = ? AND draft_id = ?${
        lock ? " FOR UPDATE" : ""}`,
      [workspaceId, draftId]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? rowDraft(row) : null;
  }

  private async selectByDispatchHash(
    connection: mysql.PoolConnection,
    workspaceId: string,
    dispatchHash: `sha256:${string}`,
    lock: boolean
  ): Promise<FinancialCouncilDraft | null> {
    const [rows] = await connection.query(
      `SELECT workspace_id, draft_id, content_hash, draft_json
       FROM financial_council_drafts
       WHERE workspace_id = ? AND dispatch_hash = ?${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, dispatchHash]
    );
    const row = (rows as MysqlRow[])[0];
    return row ? rowDraft(row) : null;
  }

  private async dispatchHashForDraft(
    connection: mysql.PoolConnection,
    workspaceId: string,
    draftId: string
  ): Promise<`sha256:${string}` | null> {
    const [rows] = await connection.query(
      `SELECT dispatch_hash FROM financial_council_drafts
       WHERE workspace_id = ? AND draft_id = ? FOR UPDATE`,
      [workspaceId, draftId]
    );
    const value = (rows as MysqlRow[])[0]?.dispatch_hash;
    if (value === null || value === undefined) return null;
    if (typeof value !== "string") throw conflict();
    assertDispatchHash(value);
    return value;
  }
}

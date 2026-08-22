import type mysql from "mysql2/promise";
import { createHash } from "node:crypto";
import type {
  EnsurePiProjectionInput,
  DecideDealInput,
  PublishQuotedDealInput,
  QuoteCrmCommand,
  AuthoritativeQuoteProjectionMutation,
  AuthoritativeQuoteProjectionMutationResult
} from "./quote-crm-command.js";
import type { QuoteRepository } from "./quote-repository.js";
import {
  assertGrowthTemporalBarrier,
  type GrowthTemporalBarrier
} from "./growth-temporal-barrier.js";
import { MysqlGrowthTemporalTransaction } from "./growth-temporal-barrier-mysql-repository.js";

/**
 * MySQL's store adapter supplies the dedicated transaction. This small port is
 * intentionally separate from global store persistence so projected rows can
 * never be replaced by persistAll.
 */
export async function mutateAuthoritativeQuoteProjectionMysql(
  pool: mysql.Pool,
  input: AuthoritativeQuoteProjectionMutation,
  temporalBarrier?: GrowthTemporalBarrier
): Promise<AuthoritativeQuoteProjectionMutationResult> {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (temporalBarrier) {
      const temporal = new MysqlGrowthTemporalTransaction(connection);
      const stamp = await temporalBarrier.allocateAppend(temporal,
        input.workspaceId);
      input = { ...input, ...stamp } as AuthoritativeQuoteProjectionMutation;
      const [guardRows] = await connection.query(
        `SELECT * FROM deal_authoritative_quotes
         WHERE workspace_id = ? AND deal_id = ? FOR UPDATE`,
        [input.workspaceId, input.dealId]
      );
      const guard = (guardRows as Record<string, unknown>[])[0];
      if (!guard || Number(guard.authority_revision)
        !== input.dealAuthorityRevision
        || guard.open_quote_case_id !== input.quoteCaseId
        || guard.quote_version_id !== input.quoteVersion.id
        || guard.commercial_amount_hash !== input.commercialAmountHash) {
        throw new Error("publication_authority_changed");
      }
      const stableHash = `sha256:${createHash("sha256")
        .update(JSON.stringify(input.stableKey)).digest("hex")}`;
      const [operationRows] = await connection.query(
        `SELECT status,authority_revision FROM quote_publication_operations
         WHERE workspace_id = ? AND stable_key_hash = ? FOR UPDATE`,
        [input.workspaceId, stableHash]
      );
      const operation = (operationRows as Record<string, unknown>[])[0];
      if (!operation || operation.status !== "running"
        || Number(operation.authority_revision)
          !== input.dealAuthorityRevision) {
        throw new Error("publication_lease_lost");
      }
    }
    if (input.kind === "pi") {
      const [existingRows] = await connection.query(
        `SELECT * FROM trade_documents WHERE id = ? FOR UPDATE`,
        [input.stableId]
      );
      const existing = (existingRows as Record<string, unknown>[])[0];
      if (!existing) {
        await connection.query(
          `UPDATE trade_documents SET projection_state = 'superseded'
           WHERE team_id = ? AND deal_id = ? AND doc_type = 'PI'
             AND commercial_authority = 'quote_projection'
             AND projection_state = 'current' AND id <> ?`,
          [input.workspaceId, input.dealId, input.stableId]
        );
        const line = input.quoteVersion.lineSnapshot as Record<string, unknown>;
        const item = [{ id: `${input.stableId}-line-1`,
          product: String(line.catalogItemId), model: "", hsCode: "",
          quantity: Number(line.quantityMicros) / 1_000_000, unit: "PCS",
          unitPrice: Number(line.offeredUnitPriceMinor) / 100,
          originCountry: "", weightKg: 0, packageCount: 0 }];
        await connection.query(
          `INSERT INTO trade_documents
           (id,customer_id,deal_id,revision,commercial_authority,quote_case_id,
            quote_version_id,commercial_amount_hash,deal_authority_revision,
            projection_state,quoted_amount_minor,quote_line_snapshot_json,
            quote_package_snapshot_json,recorded_at,temporal_sequence,doc_type,
            title,doc_number,issue_date,buyer,buyer_address,buyer_contact,seller,
            seller_address,currency,incoterm,payment_term,shipping_method,
            port_loading,port_discharge,validity_date,bank_info,notes,
            template_style,status,audits_json,send_records_json,owner_id,team_id,
            items_json,updated_at)
           SELECT ?,d.customer_id,d.id,1,'quote_projection',?,?,?,?,
             'current',?,?,?,?,?,'PI',?,?,'',c.company,c.billing_address,
             c.document_contact,'','','USD','FOB','','','','','','','',
             'executive','draft',JSON_ARRAY(),JSON_ARRAY(),d.owner_id,d.team_id,
             ?,?
           FROM deals d JOIN customers c ON c.id = d.customer_id
           WHERE d.id = ? AND d.team_id = ?`,
          [input.stableId, input.quoteCaseId, input.quoteVersion.id,
            input.commercialAmountHash, input.dealAuthorityRevision,
            Number(input.quoteVersion.quotedAmountMinor),
            JSON.stringify(input.quoteVersion.lineSnapshot),
            JSON.stringify(input.quoteVersion.packageSnapshot ?? null),
            input.recordedAt, input.temporalSequence,
            `PI ${input.quoteVersion.id}`, input.stableId,
            JSON.stringify(item), input.recordedAt, input.dealId,
            input.workspaceId]
        );
      }
      const document = await loadProjectedDocument(connection, input.stableId);
      await connection.commit();
      return { kind: "pi", document };
    }
    const [existingRows] = await connection.query(
      `SELECT id FROM deal_events WHERE id = ? FOR UPDATE`, [input.stableId]
    );
    if (!(existingRows as unknown[]).length) {
      const line = input.quoteVersion.lineSnapshot as Record<string, unknown>;
      const binding = input.quoteVersion.commercialBindingSnapshot as
        import("./commercial-binding-snapshot.js").CommercialBindingSnapshot
        | null;
      const evidence = binding ? { candidateId: binding.candidateId,
        customerId: binding.customerId, dealId: binding.dealId,
        handoffContentHash: binding.handoffContentHash,
        dealContentHash: binding.dealContentHash,
        bindingHashSchemaVersion: binding.bindingHashSchemaVersion,
        bindingHash: binding.bindingHash } : null;
      await connection.query(
        `UPDATE deals SET stage = '已报价',product = ?,quantity = ?,unit_price = ?,
         amount = ?,currency = ?,amount_type = 'quoted',stage_changed_at = ?
         WHERE id = ? AND team_id = ?`,
        [String(line.catalogItemId), Number(line.quantityMicros) / 1_000_000,
          Number(line.offeredUnitPriceMinor) / 100,
          Number(input.quoteVersion.quotedAmountMinor) / 100,
          String(input.quoteVersion.currency), input.recordedAt, input.dealId,
          input.workspaceId]
      );
      await connection.query(
        `INSERT INTO deal_events
         (id,deal_id,event_type,content,operator_id,owner_id_snapshot,
          team_id_snapshot,customer_id_snapshot,lead_id_snapshot,
          handoff_id_snapshot,candidate_id_snapshot,amount_minor_snapshot,
          currency_snapshot,commercial_authority,quote_case_id_snapshot,
          quote_version_id_snapshot,commercial_amount_hash,
          deal_authority_revision_snapshot,commercial_binding_evidence_json,
          commercial_binding_snapshot_json,related_document_id,recorded_at,
          temporal_sequence,created_at)
         SELECT ?,d.id,'quote','Authoritative quote published',?,d.owner_id,
          d.team_id,?,?,?,?,? ,?,'quote_projection',?,?,?,?,?,?,?,?,?,?
         FROM deals d WHERE d.id = ? AND d.team_id = ?`,
        [input.stableId, input.actorId, binding?.customerId ?? null,
          binding?.leadId ?? null, binding?.handoffId ?? null,
          binding?.candidateId ?? null,
          Number(input.quoteVersion.quotedAmountMinor),
          String(input.quoteVersion.currency), input.quoteCaseId,
          input.quoteVersion.id, input.commercialAmountHash,
          input.dealAuthorityRevision, evidence ? JSON.stringify(evidence) : null,
          binding ? JSON.stringify(binding) : null, input.piDocumentId,
          input.recordedAt,
          input.temporalSequence, input.recordedAt, input.dealId,
          input.workspaceId]
      );
    }
    const [rows] = await connection.query(
      `SELECT * FROM deal_events WHERE id = ?`, [input.stableId]
    );
    const row = (rows as Record<string, unknown>[])[0];
    if (!row) throw new Error("authoritative_deal_event_not_created");
    await connection.commit();
    return { kind: "crm", event: mysqlEvent(row) };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function stableId(kind: "pi" | "event", key: string) {
  return `quote-${kind}-${createHash("sha256").update(key).digest("hex")
    .slice(0, 40)}`;
}

export function createMysqlQuoteCrmCommand(options: {
  pool: mysql.Pool;
  temporalBarrier: GrowthTemporalBarrier;
  repository: Pick<QuoteRepository, "decideDeal">;
}): QuoteCrmCommand {
  const barrier = assertGrowthTemporalBarrier(options.temporalBarrier);
  return Object.freeze({
    async ensurePiProjection(input: EnsurePiProjectionInput) {
      const result = await mutateAuthoritativeQuoteProjectionMysql(options.pool,
        { ...input, kind: "pi", stableId: stableId("pi", input.stableKey),
          commercialAmountHash: input.commercialAmountHash as `sha256:${string}`,
          recordedAt: input.quoteVersion.recordedAt, temporalSequence: 0 },
        barrier);
      if (result.kind !== "pi") throw new Error("invalid_pi_projection_result");
      return { piDocumentId: result.document.id };
    },
    async publishQuotedDeal(input: PublishQuotedDealInput) {
      const result = await mutateAuthoritativeQuoteProjectionMysql(options.pool,
        { ...input, kind: "crm", stableId: stableId("event", input.stableKey),
          commercialAmountHash: input.commercialAmountHash as `sha256:${string}`,
          recordedAt: input.quoteVersion.recordedAt, temporalSequence: 0 },
        barrier);
      if (result.kind !== "crm") {
        throw new Error("invalid_crm_projection_result");
      }
      return { dealEventId: result.event.id };
    },
    async decideDeal(input: DecideDealInput) {
      return options.repository.decideDeal(input);
    }
  });
}

async function loadProjectedDocument(
  connection: mysql.PoolConnection,
  id: string
) {
  const [rows] = await connection.query(
    `SELECT * FROM trade_documents WHERE id = ?`, [id]
  );
  const row = (rows as Record<string, any>[])[0];
  if (!row) throw new Error("authoritative_pi_projection_not_created");
  return {
    id: row.id, customerId: row.customer_id || "", dealId: row.deal_id,
    revision: Number(row.revision), commercialAuthority: row.commercial_authority,
    quoteCaseId: row.quote_case_id, quoteVersionId: row.quote_version_id,
    commercialAmountHash: row.commercial_amount_hash,
    dealAuthorityRevision: Number(row.deal_authority_revision),
    projectionState: row.projection_state,
    quotedAmountMinor: Number(row.quoted_amount_minor),
    quoteLineSnapshot: parseJson(row.quote_line_snapshot_json),
    quotePackageSnapshot: parseJson(row.quote_package_snapshot_json),
    recordedAt: iso(row.recorded_at), temporalSequence: Number(row.temporal_sequence),
    type: "PI" as const, title: row.title, number: row.doc_number,
    issueDate: row.issue_date || "", buyer: row.buyer || "",
    buyerAddress: row.buyer_address || "", buyerContact: row.buyer_contact || "",
    seller: row.seller || "", sellerAddress: row.seller_address || "",
    currency: row.currency, incoterm: row.incoterm || "FOB",
    paymentTerm: row.payment_term || "", shippingMethod: row.shipping_method || "",
    portLoading: row.port_loading || "", portDischarge: row.port_discharge || "",
    validityDate: row.validity_date || "", bankInfo: row.bank_info || "",
    notes: row.notes || "", templateStyle: row.template_style || "executive",
    status: row.status || "draft", approvalNote: row.approval_note || "",
    approvedAt: row.approved_at || undefined, approvedBy: row.approved_by || undefined,
    audits: parseJson(row.audits_json) ?? [],
    sendRecords: parseJson(row.send_records_json) ?? [], ownerId: row.owner_id,
    teamId: row.team_id, updatedAt: iso(row.updated_at),
    items: parseJson(row.items_json) ?? []
  };
}

function parseJson(value: unknown) {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function iso(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function mysqlEvent(row: Record<string, any>) {
  return {
    id: row.id, dealId: row.deal_id, type: "quote" as const,
    content: row.content || "", operatorId: row.operator_id,
    ownerIdSnapshot: row.owner_id_snapshot ?? null,
    teamIdSnapshot: row.team_id_snapshot ?? null,
    customerIdSnapshot: row.customer_id_snapshot ?? null,
    leadIdSnapshot: row.lead_id_snapshot ?? null,
    handoffIdSnapshot: row.handoff_id_snapshot ?? null,
    candidateIdSnapshot: row.candidate_id_snapshot ?? null,
    amountMinorSnapshot: Number(row.amount_minor_snapshot),
    currencySnapshot: row.currency_snapshot,
    commercialAuthority: "quote_projection" as const,
    quoteCaseIdSnapshot: row.quote_case_id_snapshot,
    quoteVersionIdSnapshot: row.quote_version_id_snapshot,
    commercialAmountHash: row.commercial_amount_hash,
    dealAuthorityRevisionSnapshot: Number(row.deal_authority_revision_snapshot),
    commercialBindingEvidence: parseJson(
      row.commercial_binding_evidence_json) ?? null,
    commercialBindingSnapshot: parseJson(
      row.commercial_binding_snapshot_json) ?? null,
    relatedDocumentId: row.related_document_id,
    recordedAt: iso(row.recorded_at), temporalSequence: Number(row.temporal_sequence),
    createdAt: iso(row.created_at)
  };
}

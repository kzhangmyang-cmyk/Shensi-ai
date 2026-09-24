import { randomUUID, createHash } from 'node:crypto';
import type { CfoConversationProgress } from './cfo-conversation-progress.js';
import { z } from 'zod';
import { GrowthHttpError } from './growth-command-context.js';
import { requireGrowthCapabilities } from './growth-capabilities.js';
import type { ActiveWorkspaceContext } from './growth-workspace-context.js';
import type { CfoQuestion } from './cfo-conversation.js';
import { inspectFinanceDocument, type FinanceDocumentInspection } from './finance-document-inspection.js';
import { inspectFinanceTextDocument } from './secure-finance-document-text.js';
import { FINANCIAL_COUNCIL_MODEL_ROLES } from './financial-council-model-routing.js';

const MAX_BYTES = 5 * 1024 * 1024;
const attachmentScopeSchema = z.object({ conversationKey: z.string().uuid(), role: z.enum(FINANCIAL_COUNCIL_MODEL_ROLES) }).strict();
const attachmentClearSchema = attachmentScopeSchema.extend({ documentId: z.string().uuid() }).strict();
const fileSchema = z.object({ fileName: z.string().trim().min(1).max(255),
  mediaType: z.enum(['text/csv', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  contentBase64: z.string().min(4).max(4 * Math.ceil(MAX_BYTES / 3)) }).strict();
const bodySchema = fileSchema.extend({ readWithModel: z.boolean(), additionalFiles: z.array(fileSchema).max(9).optional(),
  attachmentScope: attachmentScopeSchema.optional(),
  analysisPurpose: z.enum(['finance', 'roi', 'management']).optional() }).strict();

export interface ReadonlyFinanceDocumentMaterial {
  readonly kind: 'readonly_document'; readonly documentId: string; readonly fileName: string; readonly fileHash: string;
  readonly classification: FinanceDocumentInspection['classification'];
  readonly missingStatements: FinanceDocumentInspection['missingStatements']; readonly expiresAt: string;
}
export type FinanceDocumentReadModel = (input: { inspection: FinanceDocumentInspection; context: ActiveWorkspaceContext;
  consent: boolean; question: string; role?: CfoQuestion['role']; connectionId?: string; signal?: AbortSignal;
  history?: CfoQuestion['history']; onProgress?: CfoConversationProgress;personalPreferences?:OperatingPreferences;publicEvidence?:PublicResearchEvidence }) => Promise<{ inspection: FinanceDocumentInspection; provider: string | null; model: string | null;citationIds?:string[] }>;
type Selection = { material: ReadonlyFinanceDocumentMaterial; inspection: FinanceDocumentInspection; bytes: number };

/** Process-local explicit selections, not a knowledge base or verified accounting source. */
export class FinanceDocumentService {
  private readonly selections = new Map<string, Selection>();
  private readonly attachments = new Map<string, Selection & { conversationKey: string; role: NonNullable<CfoQuestion['role']> }>();
  private readonly now: () => number;
  constructor(private readonly options: { model?: FinanceDocumentReadModel; now?: () => number;
    connectionFor?: (context: ActiveWorkspaceContext, role: NonNullable<CfoQuestion['role']>) => Promise<string | undefined>;
    maxScopes?: number; maxStoredBytes?: number } = {}) { this.now = options.now ?? Date.now; }

  private key(context: ActiveWorkspaceContext) {
    if (!context.workspaceId || context.workspaceId === 'all' || !context.actorId) throw new GrowthHttpError(403, 'workspace_required');
    return JSON.stringify([context.workspaceId, context.actorId]);
  }
  private expire() {
    for (const [key, value] of this.selections) if (Date.parse(value.material.expiresAt) <= this.now()) {
      this.selections.delete(key);
    }
    for (const [key, value] of this.attachments) if (Date.parse(value.material.expiresAt) <= this.now()) this.attachments.delete(key);
  }
  selected(context: ActiveWorkspaceContext, documentId?: string, binding?: Pick<CfoQuestion, 'conversationKey' | 'role'>): { material: ReadonlyFinanceDocumentMaterial; inspection: FinanceDocumentInspection } | null {
    this.expire();
    const value = this.selections.get(this.key(context));
    if (documentId !== undefined && (!value || value.material.documentId !== documentId)) {
      const attached = this.attachments.get(JSON.stringify([this.key(context), documentId]));
      if (!attached || attached.conversationKey !== binding?.conversationKey || attached.role !== (binding?.role ?? 'cfo')) throw new GrowthHttpError(409, 'finance_document_expired');
      return structuredClone({ material: attached.material, inspection: attached.inspection });
    }
    if (!value) return null;
    return structuredClone({ material: value.material, inspection: value.inspection });
  }
  clearSelection(context: ActiveWorkspaceContext): void {
    requireGrowthCapabilities(context, ['finance.council.run']);
    this.selections.delete(this.key(context));
  }
  clearAttachment(context: ActiveWorkspaceContext, raw: unknown): void {
    requireGrowthCapabilities(context, ['finance.council.run']);
    const parsed = attachmentClearSchema.safeParse(raw);
    if (!parsed.success) throw new GrowthHttpError(422, 'finance_document_input_invalid');
    this.expire();
    const key = JSON.stringify([this.key(context), parsed.data.documentId]);
    const attachment = this.attachments.get(key);
    if (!attachment || attachment.conversationKey !== parsed.data.conversationKey || attachment.role !== parsed.data.role) {
      throw new GrowthHttpError(409, 'finance_document_expired');
    }
    this.attachments.delete(key);
  }
  async inspect(context: ActiveWorkspaceContext, raw: unknown, signal?: AbortSignal) {
    const key = this.key(context);
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) throw new GrowthHttpError(422, 'finance_document_input_invalid');
    const input = parsed.data;
    if (input.attachmentScope && input.readWithModel) throw new GrowthHttpError(422, 'finance_document_input_invalid');
    if (input.attachmentScope) requireGrowthCapabilities(context, ['finance.council.run']);
    if (input.readWithModel || !context.capabilities.includes('ledger.pending.create')) requireGrowthCapabilities(context, ['finance.council.run']);
    const content = Buffer.from(input.contentBase64, 'base64');
    if (content.toString('base64') !== input.contentBase64) throw new GrowthHttpError(422, 'finance_document_content_invalid');
    if (content.length > MAX_BYTES) throw new GrowthHttpError(413, 'finance_document_limit_exceeded');
    signal?.throwIfAborted();
    let inspection: FinanceDocumentInspection;
    if (input.mediaType === 'application/pdf' || input.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const parsedText = await inspectFinanceTextDocument({ content, mediaType: input.mediaType, signal });
      signal?.throwIfAborted();
      inspection = { ...parsedText, classification: 'unknown', regions: [],
        missingStatements: ['balance_sheet', 'income_statement', 'cash_flow_statement'],
        uncertain: [...new Set([...parsedText.uncertain, 'document_structure_unverified', 'currency_not_verified', 'period_not_verified', 'unit_not_verified'])],
        observations: [], modelStatus: 'not_requested' };
    } else inspection = inspectFinanceDocument({ content, mediaType: input.mediaType });
    if (input.additionalFiles?.length) {
      const bytes = content.length + input.additionalFiles.reduce((sum, file) => sum + Buffer.byteLength(file.contentBase64, 'base64'), 0);
      if (bytes > MAX_BYTES) throw new GrowthHttpError(413, 'finance_document_limit_exceeded');
      const parsedFiles = [{ fileName: input.fileName, inspection }];
      for (const file of input.additionalFiles) {
        signal?.throwIfAborted();
        const parsedFile = await this.inspect(context, { ...file, readWithModel: false }, signal);
        parsedFiles.push({ fileName: file.fileName, inspection: parsedFile });
      }
      // The selected set is atomic: a changed/unreadable member prevents model traffic,
      // while the frontend keeps the independent successful previews for selection.
      const quota = Math.floor(2000 / parsedFiles.length);
      const files = parsedFiles.map((file, index) => ({ fileName: file.fileName, fileHash: file.inspection.fileHash, prefix: `file:${index + 1}:` }));
      inspection = { ...inspection, files,
        fileHash: `sha256:${createHash('sha256').update(JSON.stringify(files)).digest('hex')}`,
        cells: parsedFiles.flatMap((file, index) => file.inspection.cells.slice(0, quota).map(cell => ({ ...cell, sourceRef: `${files[index].prefix}${cell.sourceRef}` }))),
        regions: [], observations: [], classification: 'unknown',
        uncertain: [...new Set([...parsedFiles.flatMap(file => file.inspection.uncertain), 'batch_sources_selected',
          ...(parsedFiles.some(file => file.inspection.cells.length > quota) ? ['source_cells_omitted'] : [])])],
        missingStatements: ['balance_sheet', 'income_statement', 'cash_flow_statement'] };
      input.fileName = `${parsedFiles.length}份资料：${parsedFiles.map(file => file.fileName).join('、')}`.slice(0, 255);
    }
    const documentId = randomUUID();
    const expiresAt = new Date(this.now() + 3_600_000).toISOString();
    const material: ReadonlyFinanceDocumentMaterial = { kind: 'readonly_document', documentId,
      fileName: input.fileName, fileHash: inspection.fileHash, classification: inspection.classification,
      missingStatements: [...inspection.missingStatements], expiresAt };
    if (input.attachmentScope) {
      this.expire();
      const bytes = Buffer.byteLength(JSON.stringify(inspection));
      const used = [...this.selections.values(), ...this.attachments.values()].reduce((sum, value) => sum + value.bytes, 0);
      if (this.selections.size + this.attachments.size >= (this.options.maxScopes ?? 64)
        || used + bytes > (this.options.maxStoredBytes ?? 16 * 1024 * 1024)) throw new GrowthHttpError(429, 'finance_document_session_limit');
      this.attachments.set(JSON.stringify([key, documentId]), { material, inspection: structuredClone(inspection), bytes, ...input.attachmentScope });
    }
    if (input.readWithModel) {
      this.expire();
      const bytes = Buffer.byteLength(JSON.stringify(inspection));
      const used = [...this.selections.entries()].reduce((sum, [existingKey, value]) => sum + (existingKey === key ? 0 : value.bytes), 0)
        + [...this.attachments.values()].reduce((sum, value) => sum + value.bytes, 0);
      const active = [...this.selections.keys()].filter(existingKey => existingKey !== key).length + this.attachments.size;
      if (active >= (this.options.maxScopes ?? 64)
        || used + bytes > (this.options.maxStoredBytes ?? 16 * 1024 * 1024)) throw new GrowthHttpError(429, 'finance_document_session_limit');
      // Retain the explicit ID before model traffic; asking for that ID never falls back to verified material.
      this.selections.set(key, { material, inspection: structuredClone(inspection), bytes });
      const connectionId = await this.options.connectionFor?.(context, 'cfo');
      if (this.options.model) {
        const result = await this.options.model({ inspection: structuredClone(inspection), context, consent: true,
          question: input.analysisPurpose === 'roi'
            ? '请根据现有企业资料分析投入、产出、期间及归因口径，给出有来源的经营建议。缺少投入、产出或可比期间时明确无法计算ROI，并给出可做的定性观察及需补的明细；不得编造ROI或跨口径计算，不要求凑齐三张报表。'
            : input.analysisPurpose === 'management'
            ? '请自动识别这份企业资料的内容，概括有依据的经营观察、风险与下一步建议。现有资料能支持的部分先分析，不要求三张报表齐全；明确来源与缺项，不推断缺失数字。'
            : '请自动识别这份企业资料的内容，概括能够支持的财务与经营观察、风险、建议及仍缺少的明细；先分析现有资料，不要求凑齐三张报表，不推断缺失数字。', role: 'cfo', connectionId, signal });
        inspection = result.inspection;
      } else inspection = { ...inspection, modelStatus: 'unavailable' };
      signal?.throwIfAborted();
    }
    return { documentId, fileName: input.fileName, expiresAt,
      selectedForConversation: Boolean(input.attachmentScope) || (input.readWithModel && this.selections.get(key)?.material.documentId === documentId), ...inspection };
  }
  async askSelected(context: ActiveWorkspaceContext, question: CfoQuestion, connectionId?: string, signal?: AbortSignal, onProgress?: CfoConversationProgress,personalPreferences?:OperatingPreferences,publicEvidence?:PublicResearchEvidence) {
    requireGrowthCapabilities(context, ['finance.council.run']);
    if (!question.documentId) throw new GrowthHttpError(409, 'finance_document_not_selected');
    const selected = this.selected(context, question.documentId, question);
    if (!selected) throw new GrowthHttpError(409, 'finance_document_not_selected');
    if (!this.options.model) throw new GrowthHttpError(503, 'finance_document_model_unavailable');
    signal?.throwIfAborted();
    const result = await this.options.model({ inspection: selected.inspection, context, consent: true,
      question: question.question, role: question.role ?? 'cfo', history: question.history, connectionId, signal, onProgress,personalPreferences,publicEvidence });
    signal?.throwIfAborted();
    this.selected(context, question.documentId, question);
    if (result.inspection.modelStatus !== 'completed') throw new GrowthHttpError(503,
      result.inspection.modelStatus === 'invalid_output' ? 'finance_document_model_output_invalid' : 'finance_document_model_unavailable');
    if (!result.provider || !result.model) throw new GrowthHttpError(503, 'finance_document_model_output_invalid');
    const answer = result.inspection.observations.map(item => item.text).join('\n\n')
      || '当前资料不足以形成有来源的财务观察，请补充相关明细或说明需核对的项目。';
    if (answer.length > 4000) throw new GrowthHttpError(503, 'finance_document_model_output_invalid');
    const research=completedResearch(publicEvidence,result.citationIds);
    return { answer, provider: result.provider, ...(research?{research}:{}),
      model: result.model, material: selected.material, answeredAt: new Date(this.now()).toISOString() };
  }
}
import type {OperatingPreferences} from './agent-operating-memory.js';
import { completedResearch, type PublicResearchEvidence } from './agent-conversation-research.js';

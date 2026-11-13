import { requireGrowthCapabilities } from "./growth-capabilities.js";
import { completedResearch, type AgentConversationResearch } from './agent-conversation-research.js';
import {operatingMemorySelectionSchema,type AgentOperatingMemoryService,type OperatingPreferences} from './agent-operating-memory.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { assertKnowledgeScope, type KnowledgeEvidence, type KnowledgeAnswer } from './knowledge/domain.js';
import type { KnowledgeRetrievalPort } from './knowledge/retrieval.js';
import { CompositeReferenceRetriever, type ReferenceRetrievalPort } from './system-reference/composite-retrieval.js';
import type { ReferenceEvidence, PreparedReferences } from './system-reference/domain.js';
import { knowledgeAnswerSchema, knowledgeFallback } from './knowledge/answer.js';
import type { CfoConversationSessionRepository } from './cfo-conversation-session-repository.js';
import { observeCfoStage, type CfoConversationProgress } from './cfo-conversation-progress.js';
import type { FinanceDocumentService } from './finance-document-service.js';
import { GrowthHttpError } from './growth-command-context.js';
import { cfoQuestionSchema, cfoQuestionObjectSchema, type CfoChatModel } from './cfo-conversation.js';
import { selectFinancialCouncilModelRoute } from './financial-council-model-routing.js';
import { financialCouncilError, type FinancialCouncilRun } from
  "./financial-council-domain.js";
import { FINANCIAL_COUNCIL_MODEL_ROLES } from
  "./financial-council-model-routing.js";
import type { FinancialCouncilModelRoutingRepository } from
  "./financial-council-model-routing-repository.js";
import type { FinancialCouncilRepository } from
  "./financial-council-repository.js";
import type { FinancialStatementPackageRepository } from
  "./financial-statement-package-repository.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";
import type { FinancialCouncilModelRoutingRuntimeState } from
  "./model-providers/runtime.js";
import { parseFinancialCouncilModelCallJobId, type ModelCallRecord } from
  "./model-providers/call-ledger.js";

const ERROR_CODES = new Set([
  "MODEL_RATE_LIMITED", "MODEL_TIMEOUT", "MODEL_UNAVAILABLE",
  "MODEL_AUTH_FAILED", "MODEL_OUTPUT_INVALID", "MODEL_POLICY_CONFLICT",
  "MODEL_ERROR"
]);

function instant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function completedAt(call: ModelCallRecord): string | null {
  if (!instant(call.createdAt) || !Number.isSafeInteger(call.latencyMs)
    || call.latencyMs < 0) return null;
  const value = Date.parse(call.createdAt) + call.latencyMs;
  if (!Number.isSafeInteger(value) || value < 0
    || value > 8_640_000_000_000_000) return null;
  try { return new Date(value).toISOString(); } catch { return null; }
}

function scopeMatches(value: { ownerId: string; teamId: string | null },
  context: ActiveWorkspaceContext) {
  return context.kind === "team" ? value.teamId === context.workspaceId
    : value.ownerId === context.actorId && value.teamId === context.teamId;
}

function publicErrorCode(call: ModelCallRecord): string | null {
  if (call.status === "succeeded") return null;
  const code = call.error?.code;
  return typeof code === "string" && ERROR_CODES.has(code) ? code : "MODEL_ERROR";
}

function centerStatus(run: Pick<FinancialCouncilRun, "status"> | null,
  hasPackage: boolean, hasModels: boolean) {
  if (!hasPackage) return "not_connected" as const;
  if (!hasModels) return "model_error" as const;
  if (!run) return "ready" as const;
  if (["snapshot_frozen", "analyzing"].includes(run.status)) return "running" as const;
  if (["auditing", "synthesizing", "optimizing"].includes(run.status)) {
    return "waiting" as const;
  }
  if (["awaiting_approval", "approved"].includes(run.status)) return "completed" as const;
  if (["rejected", "stale", "expired", "not_computable"].includes(run.status)) {
    return "manual_review" as const;
  }
  return "model_error" as const;
}

function roleStatus(run: Pick<FinancialCouncilRun, "status"> | null,
  role: (typeof FINANCIAL_COUNCIL_MODEL_ROLES)[number], calls: readonly ModelCallRecord[]) {
  if (calls.some((call) => call.status === "succeeded")) return "completed" as const;
  if (calls.some((call) => call.status === "failed")) return "model_error" as const;
  if (!run) return "ready" as const;
  if (role === "cfo") {
    return ["synthesizing", "optimizing"].includes(run.status)
      ? "running" as const : "waiting" as const;
  }
  return ["analyzing", "auditing"].includes(run.status)
    ? "running" as const : "waiting" as const;
}

export class FinancialCouncilAgentCenter {
  private readonly publicTopics = new Map<string, {query?:string; expiresAt:number}>();
  private readonly referenceRelease = new WeakMap<object, () => Promise<void>>();
  constructor(private readonly dependencies: {
    readonly latestPackage: Pick<FinancialStatementPackageRepository,
      "getLatestVerified">;
    readonly latestRun: Pick<FinancialCouncilRepository,
      "findLatestRun" | "findRun">;
    readonly routing: Pick<FinancialCouncilModelRoutingRepository, "getCurrent">;
    readonly runtimeState: () => FinancialCouncilModelRoutingRuntimeState;
    readonly chatModel?: CfoChatModel;
    readonly research?: AgentConversationResearch;
    readonly documents?: FinanceDocumentService;
    readonly sessions?: CfoConversationSessionRepository;
    readonly operatingMemory?: AgentOperatingMemoryService;
    readonly knowledge?: KnowledgeRetrievalPort;
    readonly references?: ReferenceRetrievalPort;
  }) {}

  async askWithOperatingMemory(context:ActiveWorkspaceContext,raw:unknown,signal?:AbortSignal){
    requireGrowthCapabilities(context,['finance.council.run']);
    const input=z.object({selection:operatingMemorySelectionSchema,input:cfoQuestionSchema,
      session:z.object({sessionId:z.string().uuid(),revision:z.number().int().min(1)}).strict().optional()}).strict().safeParse(raw);
    if(!input.success)throw new GrowthHttpError(422,'decision_memory_input_invalid');
    if(!this.dependencies.operatingMemory)throw new GrowthHttpError(503,'decision_memory_unavailable');
    const preferences=await this.dependencies.operatingMemory.confirmed(context,input.data.selection);
    if(input.data.session){
      if(input.data.input.role&&input.data.input.role!=='cfo')throw new GrowthHttpError(422,'cfo_session_input_invalid');
      const reply=await this.askInSession(context,input.data.session.sessionId,{question:input.data.input.question,
        revision:input.data.session.revision,documentId:input.data.input.documentId??null,history:input.data.input.history,
        knowledgeMode:input.data.input.knowledgeMode,webSearchMode:input.data.input.webSearchMode,
        referenceProtocol:input.data.input.referenceProtocol,referenceTopicIds:input.data.input.referenceTopicIds},signal,undefined,preferences);
      return {answer:reply.answer,session:{sessionId:reply.session.sessionId,revision:reply.session.revision}};
    }
    return {answer:await this.ask(context,input.data.input,signal,undefined,preferences)};
  }

  private sessionRepository(context: ActiveWorkspaceContext) {
    requireGrowthCapabilities(context, ['finance.council.run']);
    if (!this.dependencies.sessions) throw new GrowthHttpError(503, 'cfo_sessions_unavailable');
    return this.dependencies.sessions;
  }
  async listSessions(context: ActiveWorkspaceContext) {
    const sessions = await this.sessionRepository(context).list(context);
    return sessions.map(({ turns, ...session }) => ({ ...session, turnCount: turns.length }));
  }
  async getSession(context: ActiveWorkspaceContext, sessionId: string, referenceProtocol?: unknown) {
    if (!z.literal('system-v1').optional().safeParse(referenceProtocol).success)
      throw new GrowthHttpError(422, 'cfo_session_input_invalid');
    const value = await this.sessionRepository(context).get(context, sessionId);
    if (!value) throw new GrowthHttpError(404, 'cfo_session_not_found');
    if (referenceProtocol !== 'system-v1' && value.turns.some(turn =>
      turn.knowledge?.sources.some(source => source.sourceType === 'system')))
      throw new GrowthHttpError(409, 'reference_client_upgrade_required');
    return value;
  }
  async createSession(context: ActiveWorkspaceContext, raw: unknown) {
    const repository = this.sessionRepository(context);
    const parsed = z.object({ documentId: z.string().min(1).max(191).nullable() }).strict().safeParse(raw);
    if (!parsed.success) throw new GrowthHttpError(422, 'cfo_session_input_invalid');
    if (parsed.data.documentId && !this.dependencies.documents?.selected(context, parsed.data.documentId))
      throw new GrowthHttpError(409, 'finance_document_not_selected');
    const now = new Date().toISOString();
    const value = { sessionId: randomUUID(), revision: 1, title: '新对话', documentId: parsed.data.documentId,
      createdAt: now, updatedAt: now, turns: [] };
    await repository.save(context, value, 0); return value;
  }
  async askInSession(context: ActiveWorkspaceContext, sessionId: string, raw: unknown, signal?: AbortSignal, onProgress?: CfoConversationProgress, personalPreferences?:OperatingPreferences) {
    const parsed = z.object({ question: z.string().trim().min(1).max(2000), revision: z.number().int().min(1),
      documentId: z.string().min(1).max(191).nullable(), history: cfoQuestionObjectSchema.shape.history.optional(),
      knowledgeMode: cfoQuestionObjectSchema.shape.knowledgeMode, webSearchMode: cfoQuestionObjectSchema.shape.webSearchMode,
      referenceProtocol: cfoQuestionObjectSchema.shape.referenceProtocol, referenceTopicIds: cfoQuestionObjectSchema.shape.referenceTopicIds })
      .strict().refine(value => value.referenceTopicIds === undefined || value.referenceProtocol === 'system-v1').safeParse(raw);
    if (!parsed.success) throw new GrowthHttpError(422, 'cfo_session_input_invalid');
    const session = await this.getSession(context, sessionId, parsed.data.referenceProtocol);
    if (session.revision !== parsed.data.revision) throw new GrowthHttpError(409, 'cfo_session_revision_conflict');
    if (session.documentId !== parsed.data.documentId) throw new GrowthHttpError(409, 'cfo_session_source_changed');
    if (session.turns.length > 98) throw new GrowthHttpError(409, 'cfo_session_full');
    const answer = await this.ask(context, { question: parsed.data.question, role: 'cfo', documentId: session.documentId, knowledgeMode: parsed.data.knowledgeMode, webSearchMode: parsed.data.webSearchMode,
      referenceProtocol: parsed.data.referenceProtocol, referenceTopicIds: parsed.data.referenceTopicIds,
      history: parsed.data.history ?? session.turns.slice(-10).map(({ role, text }) => ({ role, text })) }, signal, onProgress,personalPreferences,
      [...session.turns].reverse().find(turn=>turn.role==='assistant'&&turn.research)?.research?.query);
    signal?.throwIfAborted();
    const material = answer.material;
    const sourceLabel = !material ? '无已验证报表' : 'kind' in material
      ? `${material.fileName} · 只读资料` : `${material.companyName} · ${material.period} · 已确认报表`;
    const next = { ...session, revision: session.revision + 1,
      title: session.turns.length ? session.title : parsed.data.question.slice(0, 120), updatedAt: new Date().toISOString(),
      turns: [...session.turns, { role: 'user' as const, text: parsed.data.question },
        { role: 'assistant' as const, text: answer.answer, model: answer.model, sourceLabel: sourceLabel.slice(0, 1000),
          ...(answer.research?{research:answer.research}:{}), ...(answer.knowledge ? { knowledge: answer.knowledge } : {}),
          ...(answer.libraryStatus ? { libraryStatus: answer.libraryStatus } : {}) }] };
    await this.referenceRelease.get(answer)?.();
    signal?.throwIfAborted();
    await this.sessionRepository(context).save(context, next, session.revision);
    return { session: next, answer };
  }

  async ask(context: ActiveWorkspaceContext, raw: unknown, signal?: AbortSignal, onProgress?: CfoConversationProgress, personalPreferences?:OperatingPreferences, previousPublicTopic?:string) {
    requireGrowthCapabilities(context, ['finance.council.run']);
    const parsed = cfoQuestionSchema.safeParse(raw);
    if (!parsed.success) throw new GrowthHttpError(422, 'cfo_conversation_input_invalid');
    signal?.throwIfAborted();
    if (parsed.data.documentId && !this.dependencies.documents) throw new GrowthHttpError(409, 'finance_document_expired');
    const selectedDocument = parsed.data.documentId ? this.dependencies.documents!.selected(context, parsed.data.documentId, parsed.data) : null;
    if (!selectedDocument && !this.dependencies.chatModel) throw new GrowthHttpError(503, 'cfo_conversation_model_not_ready');
    // Register arrival before material/routing IO; completion order is not request order.
    const topicKey=parsed.data.conversationKey?JSON.stringify([context.workspaceId,context.actorId,parsed.data.role??'cfo',parsed.data.conversationKey]):undefined;
    for(const [key,value] of this.publicTopics)if(value.expiresAt<Date.now())this.publicTopics.delete(key);
    const topicState={query:topicKey?this.publicTopics.get(topicKey)?.query:undefined,expiresAt:Date.now()+3600000};
    if(topicKey){
      this.publicTopics.delete(topicKey);this.publicTopics.set(topicKey,topicState);
      if(this.publicTopics.size>5000)this.publicTopics.delete(this.publicTopics.keys().next().value!);
    }
    const material = selectedDocument ? null : await this.dependencies.latestPackage.getLatestVerified(context.workspaceId, { limit: 1 });
    if (material && material.workspaceId !== context.workspaceId)
      throw new GrowthHttpError(409, 'cfo_conversation_material_unavailable');
    const observer = (parsed.data.role ?? 'cfo') === 'cfo' ? onProgress : undefined;
    observeCfoStage(observer, 'material_ready', signal);
    const policy = await this.dependencies.routing.getCurrent(context);
    let connectionId: string | undefined;
    if (policy) {
      const runtime = this.dependencies.runtimeState();
      connectionId = selectFinancialCouncilModelRoute({ role: parsed.data.role ?? 'cfo', policy,
        connections: runtime.connections, recentCalls: runtime.recentCalls, prices: [], activeWorkspace: context }).orderedConnectionIds[0];
      if (!connectionId) throw new GrowthHttpError(409, 'cfo_conversation_model_not_ready');
    }
    const source = material ? { packageId: material.packageId, companyName: material.companyName,
      period: material.period, currency: material.currency } : null;
    signal?.throwIfAborted();
    // Public research is best-effort: when planning/search is unavailable or not applicable the agent answers
    // without web evidence (response carries no `research`), instead of failing the whole turn.
    let publicEvidence: Awaited<ReturnType<AgentConversationResearch['prepare']>> = null;
    if (parsed.data.webSearchMode !== 'off' && this.dependencies.research) {
      try {
        publicEvidence = await this.dependencies.research.prepare({context,role:parsed.data.role??'cfo',question:parsed.data.question,signal,webSearchMode:parsed.data.webSearchMode,
          previousPublicTopic:previousPublicTopic??topicState.query});
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof GrowthHttpError) || !/^agent_(research|web)_/u.test(error.code)) throw error;
        console.warn('[cfo-conversation] public research skipped', error.code);
        publicEvidence = null;
      }
    }
    signal?.throwIfAborted();
    let privateEvidence: KnowledgeEvidence | undefined, prepared: PreparedReferences | undefined;
    if (parsed.data.referenceProtocol === 'system-v1') {
      prepared = await (this.dependencies.references ?? new CompositeReferenceRetriever({ private: this.dependencies.knowledge }))
        .prepare(context, { ...parsed.data, role: parsed.data.role ?? 'cfo' }, signal);
    } else if (parsed.data.knowledgeMode === 'auto') {
      assertKnowledgeScope(context, 'knowledge.read');
      privateEvidence = this.dependencies.knowledge
        ? await this.dependencies.knowledge.retrieve(context, { question: parsed.data.question, role: parsed.data.role ?? 'cfo' }, signal)
        : { status: 'unavailable', sources: [] };
    }
    // Off/omitted knowledge must not change legacy model repair semantics.
    const knowledgeEvidence: ReferenceEvidence | undefined = parsed.data.knowledgeMode === 'auto'
      ? prepared?.evidence ?? privateEvidence : undefined;
    const finishReferences = async <T extends { answer: string; knowledge?: KnowledgeAnswer }>(reply: T) => {
      const recheck = async () => {
        signal?.throwIfAborted();
        try {
          if (prepared) await prepared.assertCurrent(signal);
          else if (privateEvidence) {
            assertKnowledgeScope(context, 'knowledge.read');
            await this.dependencies.knowledge?.assertCurrent(context, { role: parsed.data.role ?? 'cfo', evidence: privateEvidence }, signal);
          }
        } catch {
          signal?.throwIfAborted(); throw new GrowthHttpError(409, 'knowledge_reference_stale');
        }
      };
      await recheck();
      let knowledge: KnowledgeAnswer | undefined;
      if (knowledgeEvidence?.status === 'used') {
        knowledge = knowledgeAnswerSchema.parse(reply.knowledge);
        if (knowledge.status !== 'used' || knowledge.sources.some(source => !knowledgeEvidence!.sources.some(
          allowed => isDeepStrictEqual(allowed, source)))) throw new GrowthHttpError(502, 'knowledge_reference_invalid');
      } else if (knowledgeEvidence) knowledge = knowledgeFallback(knowledgeEvidence, reply.answer);
      const result = { ...reply, ...(knowledge ? { knowledge } : {}),
        ...(prepared ? { libraryStatus: structuredClone(prepared.libraryStatus) } : {}) };
      this.referenceRelease.set(result, recheck); return result;
    };
    if (selectedDocument) {
      const answer = await this.dependencies.documents!.askSelected(context, parsed.data, connectionId, signal, observer,personalPreferences,publicEvidence??undefined,knowledgeEvidence);
      observeCfoStage(observer, 'answer_validated', signal);
      if(topicKey&&answer.research&&this.publicTopics.get(topicKey)===topicState)topicState.query=answer.research.query;
      return finishReferences(answer);
    }
    const result = await this.dependencies.chatModel!({ ...parsed.data, context, connectionId, signal, onProgress: observer,personalPreferences,publicEvidence:publicEvidence??undefined,knowledgeEvidence,
      material: material && source ? { ...source, businessReport: material.businessReport,
        provenance: { parserVersion: material.parserVersion, packageHash: material.packageHash,
          createdAt: material.createdAt, unit: 'minor', warnings: material.warnings,
          sourceFiles: material.sourceFiles.map(file => ({ kind: file.kind, fileHash: file.fileHash })) } } : null });
    observeCfoStage(observer, 'answer_validated', signal);
    const research=completedResearch(publicEvidence,result.citationIds);
    if(topicKey&&research&&this.publicTopics.get(topicKey)===topicState)topicState.query=research.query;
    const {citationIds:_citations,...reply}=result;
    return finishReferences({ ...reply, ...(research?{research}:{}), material: source, answeredAt: new Date().toISOString() });
  }

  private async state(context: ActiveWorkspaceContext) {
    requireGrowthCapabilities(context, ["finance.council.run"]);
    const [rawStatementPackage, rawRun, routing] = await Promise.all([
      this.dependencies.latestPackage.getLatestVerified(context.workspaceId,
        Object.freeze({ limit: 1 })),
      this.dependencies.latestRun.findLatestRun(context,
        Object.freeze({ limit: 1 })),
      this.dependencies.routing.getCurrent(context)
    ]);
    const statementPackage = rawStatementPackage?.workspaceId === context.workspaceId
      ? rawStatementPackage : null;
    const run = rawRun?.workspaceId === context.workspaceId ? rawRun : null;
    const runtime = this.dependencies.runtimeState();
    const eligible = runtime.connections.filter((connection) =>
      scopeMatches(connection, context) && connection.status === "active"
      && connection.capabilitySnapshot?.structuredOutput === true);
    return { statementPackage, run, routing, runtime, eligible };
  }

  async get(context: ActiveWorkspaceContext) {
    const { statementPackage, run, routing, runtime, eligible } =
      await this.state(context);
    return Object.freeze({
      data: Object.freeze({ status: statementPackage ? "ready" : "not_connected",
        packageId: statementPackage?.packageId ?? null,
        companyName: statementPackage?.companyName ?? null,
        period: statementPackage?.period ?? null,
        verifiedAt: statementPackage?.createdAt ?? null,
        warningCodes: Object.freeze(statementPackage?.warnings.map((item) =>
          item.code) ?? []) }),
      models: Object.freeze({ status: routing && eligible.length
        ? "ready" : "not_connected",
        routingPolicyVersionId: routing?.policyVersionId ?? null,
        roles: Object.freeze(FINANCIAL_COUNCIL_MODEL_ROLES.map((role) => {
          const calls = this.calls(runtime.recentCalls, context, run?.runId, role);
          const latest = calls.at(-1);
          const connection = latest
            ? runtime.connections.find((item) => item.id === latest.connectionId)
            : eligible[0];
          return Object.freeze({ role, status: roleStatus(run, role, calls),
            provider: connection?.provider ?? null,
            model: connection?.model ?? null,
            connectionDisplayName: connection ? this.displayName(connection) : null });
        })) }),
      latestRun: run ? Object.freeze({ runId: run.runId, status: run.status,
        revision: run.revision, updatedAt: run.updatedAt }) : null,
      capabilities: Object.freeze({
        canRun: context.capabilities.includes("finance.council.run"),
        canApprove: context.capabilities.includes("finance.council.approve"),
        canManageRouting: context.capabilities.includes(
          "finance.council.policy.manage")
      })
    });
  }

  async getRunAgents(context: ActiveWorkspaceContext, runId: string) {
    requireGrowthCapabilities(context, ["finance.council.run"]);
    if (typeof runId !== "string" || !runId.trim() || runId.length > 255) {
      throw financialCouncilError("financial_council_input_invalid");
    }
    const repository = this.dependencies.latestRun;
    const raw = typeof repository.findRun === "function"
      ? await repository.findRun(context, runId)
      : await repository.findLatestRun(context, Object.freeze({ limit: 1 }));
    if (!raw || raw.workspaceId !== context.workspaceId || raw.runId !== runId) {
      throw financialCouncilError("financial_council_run_not_found");
    }
    const runtime = this.dependencies.runtimeState();
    return Object.freeze({ runId: raw.runId, status: raw.status,
      revision: raw.revision, updatedAt: raw.updatedAt,
      roles: Object.freeze(FINANCIAL_COUNCIL_MODEL_ROLES.map((role) => {
        const calls = this.calls(runtime.recentCalls, context, runId, role);
        return Object.freeze({ role,
          phase: role === "cfo" ? "consensus" : "analysis",
          status: roleStatus(raw, role, calls),
          attempts: Object.freeze(calls.map((call) => {
            const parsed = parseFinancialCouncilModelCallJobId(call.jobId)!;
            const connection = runtime.connections.find((item) =>
              item.id === call.connectionId && scopeMatches(item, context));
            return Object.freeze({ attempt: parsed.attempt,
              provider: call.provider, model: call.model,
              connectionDisplayName: connection
                ? this.displayName(connection) : call.model,
              status: call.status, errorCode: publicErrorCode(call),
              startedAt: instant(call.createdAt) ? call.createdAt : null,
              completedAt: completedAt(call) });
          })) });
      })) });
  }

  private calls(calls: readonly ModelCallRecord[], context: ActiveWorkspaceContext,
    runId: string | undefined,
    role: (typeof FINANCIAL_COUNCIL_MODEL_ROLES)[number]) {
    if (!runId) return [];
    return calls.filter((call) => {
      const parsed = parseFinancialCouncilModelCallJobId(call.jobId);
      return parsed?.runId === runId && parsed.role === role
        && scopeMatches(call, context);
    }).sort((left, right) => {
      const a = parseFinancialCouncilModelCallJobId(left.jobId)!.attempt;
      const b = parseFinancialCouncilModelCallJobId(right.jobId)!.attempt;
      return a - b || left.id.localeCompare(right.id);
    });
  }

  private displayName(connection: object) {
    const name = Reflect.get(connection, "name");
    return typeof name === "string" && name.trim()
      ? name : String(Reflect.get(connection, "model"));
  }
}

import { z } from 'zod';
import { GrowthHttpError } from './growth-command-context.js';
import { requireGrowthCapabilities } from './growth-capabilities.js';
import type { ActiveWorkspaceContext } from './growth-workspace-context.js';
import { FINANCIAL_COUNCIL_MODEL_ROLES } from './financial-council-model-routing.js';

export const agentWebResearchInput = z.object({ query: z.string().trim().min(2).max(500),
  connectionId: z.string().trim().min(1).max(191), role: z.enum(FINANCIAL_COUNCIL_MODEL_ROLES) }).strict();
export interface AgentWebSource { title: string; url: string; snippet: string; fetchedAt: string }
export interface AgentWebCitation extends AgentWebSource { id: string }
export interface AgentSearchConnection { id: string; provider: string; name: string }
export interface AgentWebAnswer { answer: string; citationIds: string[]; model: string; provider: string }
export interface AgentWebResearchDependencies {
  connections(context: ActiveWorkspaceContext): Promise<AgentSearchConnection[]>;
  search(input: { context: ActiveWorkspaceContext; connectionId: string; query: string; signal?: AbortSignal }): Promise<{ provider: string; sources: AgentWebSource[] }>;
  answer(input: { context: ActiveWorkspaceContext; query: string; role: z.infer<typeof agentWebResearchInput>['role']; sources: AgentWebCitation[]; signal?: AbortSignal }): Promise<AgentWebAnswer>;
}

function publicSource(source: AgentWebSource): AgentWebSource | null {
  try {
    const url = new URL(source.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
      || /^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[::1\])/iu.test(url.hostname)
      || /\.(?:local|internal)$/iu.test(url.hostname) || !Number.isFinite(Date.parse(source.fetchedAt))) return null;
    const title = source.title.trim().slice(0, 300); const snippet = source.snippet.trim().slice(0, 3000);
    if (!title || !snippet) return null;
    return { title, snippet, url: url.href, fetchedAt: new Date(source.fetchedAt).toISOString() };
  } catch { return null; }
}

/** Explicit public-keyword tool. It never accepts files, conversation history or company records. */
export class AgentWebResearchService {
  constructor(private readonly options: AgentWebResearchDependencies) {}
  async connections(context: ActiveWorkspaceContext) {
    requireGrowthCapabilities(context, ['finance.council.run']);
    return this.options.connections(context);
  }
  async run(context: ActiveWorkspaceContext, raw: unknown, signal?: AbortSignal) {
    requireGrowthCapabilities(context, ['finance.council.run']);
    const parsed = agentWebResearchInput.safeParse(raw);
    if (!parsed.success) throw new GrowthHttpError(422, 'agent_web_input_invalid');
    signal?.throwIfAborted();
    const connection = (await this.connections(context)).find(value => value.id === parsed.data.connectionId);
    if (!connection) throw new GrowthHttpError(409, 'agent_web_connection_unavailable');
    const result = await this.options.search({ context, connectionId: connection.id, query: parsed.data.query, signal });
    signal?.throwIfAborted();
    const seen = new Set<string>(); const sources: AgentWebCitation[] = [];
    for (const rawSource of result.sources) {
      const source = publicSource(rawSource);
      if (!source || seen.has(source.url)) continue;
      seen.add(source.url); sources.push({ ...source, id: `S${sources.length + 1}` });
      if (sources.length === 5) break;
    }
    if (!sources.length) throw new GrowthHttpError(409, 'agent_web_no_sources');
    const answer = await this.options.answer({ context, query: parsed.data.query, role: parsed.data.role, sources, signal });
    signal?.throwIfAborted();
    const valid = z.object({ answer: z.string().trim().min(1).max(4000), model: z.string().min(1), provider: z.string().min(1),
      citationIds: z.array(z.string()).min(1).max(5) }).strict().safeParse(answer);
    if (!valid.success || valid.data.citationIds.some(id => !sources.some(source => source.id === id))) throw new GrowthHttpError(502, 'agent_web_answer_invalid');
    return { ...valid.data, citationIds: [...new Set(valid.data.citationIds)], query: parsed.data.query, searchProvider: result.provider, sources,
      retrievedAt: new Date().toISOString(), evidenceKind: 'search_index_snippets' as const };
  }
}

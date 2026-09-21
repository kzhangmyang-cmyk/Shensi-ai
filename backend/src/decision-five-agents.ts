import { GrowthHttpError } from './growth-command-context.js';
import { OPERATING_DECISION_ROLES, type OperatingDecisionRole, type FinanceDocumentModelInput,
  type FinanceDocumentModelResult } from './finance-document-model.js';
import type { FinanceDocumentInspection, FinanceDocumentObservation } from './finance-document-inspection.js';
import type { ActiveWorkspaceContext } from './growth-workspace-context.js';

export interface DecisionAgentResult {
  role: OperatingDecisionRole;
  state: 'queued' | 'running' | 'completed' | 'insufficient' | 'failed' | 'cancelled';
  observations: FinanceDocumentObservation[];
  provider: string | null; model: string | null; errorCode: string | null;
}
export type DecisionSourceModel = (input: FinanceDocumentModelInput) => Promise<FinanceDocumentModelResult>;

/** Each role calls the configured gateway. Earlier public summaries are context, never new source facts. */
export async function analyzeDecisionSources(input: {
  context: ActiveWorkspaceContext; inspection: FinanceDocumentInspection; consent: boolean;
  model: DecisionSourceModel; signal?: AbortSignal;
  onUpdate?: (records: DecisionAgentResult[]) => void;
}): Promise<DecisionAgentResult[]> {
  if (input.consent !== true) throw new GrowthHttpError(422, 'decision_model_consent_required');
  const records: DecisionAgentResult[] = OPERATING_DECISION_ROLES.map(role => ({
    role, state: 'queued', observations: [], provider: null, model: null, errorCode: null,
  }));
  const publish = () => input.onUpdate?.(structuredClone(records));
  publish();
  for (const record of records) {
    if (input.signal?.aborted) {
      for (const pending of records.filter(item => item.state === 'queued')) pending.state = 'cancelled';
      publish(); break;
    }
    record.state = 'running'; publish();
    try {
      const history = records.filter(item => item.state === 'completed').map(item => ({
        role: 'assistant' as const,
        text: `${item.role}的公开摘要（非新增事实）：\n${item.observations.map(observation => observation.text).join('\n')}`.slice(0, 4000),
      }));
      const result = await input.model({ context: input.context, inspection: structuredClone(input.inspection),
        consent: true, operatingRole: record.role, question: '请按当前角色分析这些企业资料。核对可支持的经营事实、风险、缺项与下一步验证行动；结合此前角色的公开摘要复核，但只引用原始资料。不要求三表齐全，不执行任何业务写入。',
        history, signal: input.signal });
      input.signal?.throwIfAborted();
      if (result.inspection.modelStatus !== 'completed' || !result.provider || !result.model)
        throw new GrowthHttpError(503, 'decision_model_unavailable');
      record.provider = result.provider; record.model = result.model;
      record.observations = structuredClone(result.inspection.observations);
      record.state = record.observations.length ? 'completed' : 'insufficient';
    } catch {
      record.state = input.signal?.aborted ? 'cancelled' : 'failed';
      record.errorCode = input.signal?.aborted ? 'decision_analysis_cancelled' : 'decision_model_unavailable';
    }
    publish();
  }
  return structuredClone(records);
}

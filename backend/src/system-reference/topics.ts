import { z } from 'zod';

export const REFERENCE_VOCABULARY_VERSION = 'finance-topics.v1' as const;
// The only query vocabulary. No user text or model-authored synonym is added.
export const REFERENCE_TOPICS = [
  { id: 'budget_variance', label: '预算偏差', phrases: ['预算偏差', '预算执行偏差', 'budget variance'] },
  { id: 'budget_planning', label: '预算编制', phrases: ['预算编制', '编制预算', 'budget planning'] },
  { id: 'cost_driver', label: '成本动因', phrases: ['成本动因', '成本动因分析', 'cost driver'] },
  { id: 'cost_structure', label: '成本结构', phrases: ['成本结构', 'cost structure'] },
  { id: 'cashflow_forecast', label: '现金流预测', phrases: ['现金流预测', '现金流量预测', 'cash flow forecast'] },
  { id: 'working_capital', label: '营运资金', phrases: ['营运资金', '营运资本', 'working capital'] },
  { id: 'profitability_analysis', label: '盈利分析', phrases: ['盈利分析', '盈利能力分析', 'profitability analysis'] },
  { id: 'break_even', label: '盈亏平衡', phrases: ['盈亏平衡', '保本点', 'break even'] },
  { id: 'statement_analysis', label: '报表分析', phrases: ['报表分析', '财务报表解读', 'statement analysis'] },
  { id: 'ratio_analysis', label: '财务比率', phrases: ['财务比率', '比率分析', 'ratio analysis'] },
  { id: 'tax_document_review', label: '税务资料核对', phrases: ['税务资料核对', '税务凭证核对', 'tax document review'] },
  { id: 'tax_risk_review', label: '税务风险核对', phrases: ['税务风险核对', '税务风险检查', 'tax risk review'] }
] as const;
export type ReferenceTopicId = typeof REFERENCE_TOPICS[number]['id'];
export const REFERENCE_TOPIC_IDS = REFERENCE_TOPICS.map(topic => topic.id) as [ReferenceTopicId, ...ReferenceTopicId[]];
export const referenceTopicIdSchema = z.enum(REFERENCE_TOPIC_IDS);
export const referenceTopicSelectionSchema = z.array(referenceTopicIdSchema).max(3)
  .refine(values => new Set(values).size === values.length, 'reference_topics_invalid');
Object.freeze(REFERENCE_TOPIC_IDS);
for (const topic of REFERENCE_TOPICS) { Object.freeze(topic.phrases); Object.freeze(topic); }
Object.freeze(REFERENCE_TOPICS);

export function projectReferenceTopics(question: string, selected?: ReferenceTopicId[]): ReferenceTopicId[] {
  if (selected !== undefined) return referenceTopicSelectionSchema.parse(selected);
  const normalized = question.normalize('NFKC').toLowerCase();
  return REFERENCE_TOPICS.map((topic, order) => ({ id: topic.id, order,
    score: topic.phrases.filter(phrase => normalized.includes(phrase)).length }))
    .filter(topic => topic.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 3).map(topic => topic.id);
}

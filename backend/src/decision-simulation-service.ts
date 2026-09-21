import { z } from 'zod';
import { GrowthHttpError } from './growth-command-context.js';
import { generateOperatingPaths, validateOperatingEvents } from './decision-simulation-engine.js';
import { analyzeOperatingPlans } from './decision-simulation-analysis.js';
import type { DecisionAgentResult } from './decision-five-agents.js';
import {assessDecisionPreferences} from './decision-preferences.js';

export interface DecisionAnalysisEvidence {
  files: Array<{fileName:string;fileHash:string;prefix:string}>;
  sources: Array<{sourceRef:string;text:string}>;
  agents: DecisionAgentResult[];
  uncertain: string[];
}

const money = z.number().int().nonnegative().max(1e12);
const units = z.number().int().nonnegative().max(1e6);
const scheduled = z.object({ dueMonth: z.number().int().min(1).max(48), amountMinor: money }).strict();
const multiplier = z.number().min(0).max(10);
const range = z.tuple([z.number().min(0).max(24), z.number().min(0).max(24)]).refine(([low, high]) => low <= high);
const operatingEventSchema=z.object({
  template:z.enum(['staffing_shortage','staffing_recovery','sales_gain','sales_loss','cost_rise','cost_fall','payment_delay','payment_recovery']),
  startMonth:z.number().int().min(1).max(24),durationMonths:z.number().int().min(1).max(24),
  value:z.number().min(0).max(24),probability:z.number().min(0).max(1),assumption:z.string().trim().min(1).max(500),
}).strict();
export const decisionSimulationInputSchema = z.object({
  runId: z.string().uuid(), title: z.string().trim().min(1).max(100),
  dataKind: z.enum(['synthetic', 'user_defined']), assumptionNote: z.string().trim().min(1).max(1000),
  decisionPreferences:z.object({priority:z.enum(['cash','profit','delivery']),cashFloorMinor:money.optional(),pilotFirst:z.boolean(),reviewCadence:z.enum(['weekly','monthly']),learningEnabled:z.boolean(),confirmedFrom:z.enum(['self_report','explicit_feedback'])}).strict().optional(),
  baseline: z.object({ cashMinor: z.number().int().min(-1e12).max(1e12), monthlyOrders: units,
    backlogUnits: units, capacityUnits: units, priceMinor: money, unitCostMinor: money, fixedCostMinor: money,
    collectionMonths: z.number().int().min(0).max(24), receivables: z.array(scheduled).max(100), payables: z.array(scheduled).max(100) }).strict(),
  alternatives: z.array(z.object({ id: z.string().trim().min(1).max(100).refine(id => id !== 'baseline'),
    demandMultiplier: multiplier, capacityMultiplier: multiplier, priceMultiplier: multiplier,
    costMultiplier: multiplier, extraFixedCostMinor: money }).strict()).max(3),
  options: z.object({ seed: z.number().int().min(0).max(4294967295), samples: z.number().int().min(1).max(100),
    months: z.number().int().min(1).max(24), events:z.array(operatingEventSchema).max(8).optional(), assumptions: z.object({ demand: range, procurement: range, delivery: range,
      collectionDelay: range.refine(values => values.every(Number.isInteger)), persistence: z.number().min(0).max(1), commonWeight: z.number().min(0).max(1) }).strict() }).strict().refine(options=>{try{validateOperatingEvents(options.events??[],options.months);return true;}catch{return false;}},'Events must have valid directions, fit horizon and not overlap on the same factor'),
}).strict();
export type DecisionSimulationInput = z.infer<typeof decisionSimulationInputSchema>;
export interface DecisionSimulationScope { workspaceId: string; actorId: string }
export interface DecisionSimulationRecord {
  runId: string; createdAt: string; recordVersion: 'decision-simulation.v1';
  input: DecisionSimulationInput; paths: ReturnType<typeof generateOperatingPaths>;
  report: Omit<ReturnType<typeof analyzeOperatingPlans>,'recommendations'> & {recommendations?:ReturnType<typeof analyzeOperatingPlans>['recommendations'];preferenceAssessment?:ReturnType<typeof assessDecisionPreferences>};
  analysis?: DecisionAnalysisEvidence;
}
export interface DecisionSimulationListItem { runId: string; title: string; dataKind: DecisionSimulationInput['dataKind']; createdAt: string }
export interface DecisionSimulationRepository {
  get(scope: DecisionSimulationScope, id: string): Promise<DecisionSimulationRecord | null>;
  list(scope: DecisionSimulationScope): Promise<DecisionSimulationListItem[]>;
  insert(scope: DecisionSimulationScope, record: DecisionSimulationRecord): Promise<boolean>;
}
export function assertDecisionScope(scope: DecisionSimulationScope) {
  if (!scope?.workspaceId || !scope.actorId || scope.workspaceId === 'all' || scope.workspaceId.length > 160 || scope.actorId.length > 160)
    throw new GrowthHttpError(403, 'workspace_required');
}
const key = (scope: DecisionSimulationScope, id: string) => JSON.stringify([scope.workspaceId, scope.actorId, id]);
export class MemoryDecisionSimulationRepository implements DecisionSimulationRepository {
  private rows = new Map<string, DecisionSimulationRecord>();
  async get(scope: DecisionSimulationScope, id: string) { return structuredClone(this.rows.get(key(scope, id)) ?? null); }
  async list(scope: DecisionSimulationScope) {
    return [...this.rows.entries()].filter(([rowKey]) => { const [workspace, actor] = JSON.parse(rowKey); return workspace === scope.workspaceId && actor === scope.actorId; })
      .map(([, row]) => ({ runId: row.runId, title: row.input.title, dataKind: row.input.dataKind, createdAt: row.createdAt }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.runId.localeCompare(b.runId)).slice(0, 50);
  }
  async insert(scope: DecisionSimulationScope, record: DecisionSimulationRecord) {
    const id = key(scope, record.runId); if (this.rows.has(id)) return false;
    this.rows.set(id, structuredClone(record)); return true;
  }
}
export class DecisionSimulationService {
  constructor(private readonly repository: DecisionSimulationRepository) {}
  async create(scope: DecisionSimulationScope, raw: unknown, analysis?: DecisionAnalysisEvidence): Promise<DecisionSimulationRecord> {
    assertDecisionScope(scope);
    const parsed = decisionSimulationInputSchema.safeParse(raw);
    if (!parsed.success) throw new GrowthHttpError(422, 'decision_simulation_input_invalid');
    const input = parsed.data;
    const existing = await this.repository.get(scope, input.runId);
    if (existing) return this.replay(existing, input, analysis);
    let paths: DecisionSimulationRecord['paths']; let report: DecisionSimulationRecord['report'];
    try { paths = generateOperatingPaths(input.options); report = analyzeOperatingPlans(input.baseline, input.alternatives, paths); }
    catch { throw new GrowthHttpError(422, 'decision_simulation_input_invalid'); }
    if(input.decisionPreferences)report.preferenceAssessment=assessDecisionPreferences(input.decisionPreferences,report.plans);
    const record: DecisionSimulationRecord = { runId: input.runId, createdAt: new Date().toISOString(), recordVersion: 'decision-simulation.v1', input, paths, report, ...(analysis?{analysis:structuredClone(analysis)}:{}) };
    if (await this.repository.insert(scope, record)) return record;
    const winner = await this.repository.get(scope, input.runId);
    if (!winner) throw new GrowthHttpError(503, 'decision_simulation_unavailable');
    return this.replay(winner, input, analysis);
  }
  private replay(record: DecisionSimulationRecord, input: DecisionSimulationInput, analysis?: DecisionAnalysisEvidence) {
    if (JSON.stringify(record.input) !== JSON.stringify(input)) throw new GrowthHttpError(409, 'decision_simulation_conflict');
    if (analysis && JSON.stringify(record.analysis)!==JSON.stringify(analysis)) throw new GrowthHttpError(409, 'decision_simulation_conflict');
    return record;
  }
  async get(scope: DecisionSimulationScope, id: string) {
    assertDecisionScope(scope);
    if (!z.string().uuid().safeParse(id).success) throw new GrowthHttpError(422, 'decision_simulation_input_invalid');
    const record = await this.repository.get(scope, id);
    if (!record) throw new GrowthHttpError(404, 'decision_simulation_not_found');
    return record;
  }
  async list(scope: DecisionSimulationScope) { assertDecisionScope(scope); return this.repository.list(scope); }
}

import { z } from 'zod';
import { GrowthHttpError } from './growth-command-context.js';
import { generateOperatingPaths, validateOperatingEvents, externalEnvironmentImpacts, usesEnhancedOperatingModel, type OperatingPathOptions } from './decision-simulation-engine.js';
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
  startMonthMax:z.number().int().min(1).max(24).optional(),
  valueMin:z.number().min(0).max(24).optional(),
  valueMax:z.number().min(0).max(24).optional(),
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
  options: z.object({ seed: z.number().int().min(0).max(4294967295), samples: z.number().int().min(1).max(500),
    months: z.number().int().min(1).max(24), events:z.array(operatingEventSchema).max(8).optional(),
    yearRegime: z.enum(['normal','tight','storm']).optional(),
    seasonality: z.enum(['none','general_ecommerce','home_textile']).optional(),
    externalEnvironment: z.array(z.enum(['tariff','credit_tight','price_war','fx','material','key_account_delay','shipping','weather_power','labor_cost'])).max(12).optional(),
    randomizePrice: z.boolean().optional(), randomizeFixedCost: z.boolean().optional(),
    fatTailProbability: z.number().min(0).max(0.2).optional(),
    assumptions: z.object({ demand: range, procurement: range, delivery: range,
      collectionDelay: range.refine(values => values.every(Number.isInteger)), persistence: z.number().min(0).max(1), commonWeight: z.number().min(0).max(1) }).strict() }).strict().refine(options=>{try{validateOperatingEvents(options.events??[],options.months);return true;}catch{return false;}},'Events must have valid directions, fit horizon and not overlap on the same factor'),
}).strict();
export type DecisionSimulationInput = z.infer<typeof decisionSimulationInputSchema>;
export interface DecisionSimulationScope { workspaceId: string; actorId: string }
export interface DecisionSimulationRecord {
  runId: string; createdAt: string; recordVersion: 'decision-simulation.v1';
  input: DecisionSimulationInput; paths: ReturnType<typeof generateOperatingPaths>;
  report: Omit<ReturnType<typeof analyzeOperatingPlans>,'recommendations'> & {recommendations?:ReturnType<typeof analyzeOperatingPlans>['recommendations'];preferenceAssessment?:ReturnType<typeof assessDecisionPreferences>;externalFactorImpact?:Array<{id:string;label:string;impact:string}>};
  analysis?: DecisionAnalysisEvidence;
}
export interface DecisionSimulationListItem { runId: string; title: string; dataKind: DecisionSimulationInput['dataKind']; createdAt: string }
export interface DecisionSimulationRepository {
  get(scope: DecisionSimulationScope, id: string): Promise<DecisionSimulationRecord | null>;
  list(scope: DecisionSimulationScope): Promise<DecisionSimulationListItem[]>;
  insert(scope: DecisionSimulationScope, record: DecisionSimulationRecord): Promise<boolean>;
}

function selectRepresentativeSampleIndexes(sampleCount: number, baselineRun?: { samples: Array<{ minimumCashMinor: number; fundingGapMinor: number }> }): number[] {
  if (sampleCount <= 24) return Array.from({ length: sampleCount }, (_, index) => index);
  const indexed = Array.from({ length: sampleCount }, (_, index) => ({
    index,
    cash: baselineRun?.samples[index]?.minimumCashMinor ?? 0,
    gap: baselineRun?.samples[index]?.fundingGapMinor ?? 0,
  }));
  const byCash = [...indexed].sort((a, b) => a.cash - b.cash);
  const picks = new Set<number>();
  for (const row of byCash.slice(0, 8)) picks.add(row.index);
  for (const row of byCash.slice(-4)) picks.add(row.index);
  const mid = byCash[Math.floor(byCash.length / 2)]; if (mid) picks.add(mid.index);
  for (const row of indexed.filter(item => item.gap > 0).slice(0, 6)) picks.add(row.index);
  for (let step = 0; picks.size < 24 && step < sampleCount; step += Math.max(1, Math.floor(sampleCount / 24))) picks.add(step);
  return [...picks].sort((a, b) => a - b);
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
    try {
      paths = generateOperatingPaths(input.options as OperatingPathOptions);
      report = analyzeOperatingPlans(input.baseline, input.alternatives, paths);
      report.externalFactorImpact = externalEnvironmentImpacts(input.options as OperatingPathOptions);
    } catch { throw new GrowthHttpError(422, 'decision_simulation_input_invalid'); }
    if(input.decisionPreferences)report.preferenceAssessment=assessDecisionPreferences(input.decisionPreferences,report.plans);
    // Keep MEDIUMTEXT safe: store representative paths/replays only (worst/median/best + gaps).
    const representative = selectRepresentativeSampleIndexes(report.plans[0]?.sampleCount ?? paths.length, report.replays[0]);
    const slimPaths = representative.map(index => paths[index]);
    const slimReport = {
      ...report,
      replays: report.replays.map(run => ({
        ...run,
        samples: representative.map(index => run.samples[index]),
        retainedSampleIndexes: representative,
      })),
    };
    const record: DecisionSimulationRecord = { runId: input.runId, createdAt: new Date().toISOString(), recordVersion: 'decision-simulation.v1', input, paths: slimPaths, report: slimReport as DecisionSimulationRecord['report'], ...(analysis?{analysis:structuredClone(analysis)}:{}) };
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

import {z} from 'zod';
import {GrowthHttpError} from './growth-command-context.js';
import {assertDecisionScope,type DecisionSimulationScope,type DecisionSimulationService} from './decision-simulation-service.js';
import type {DecisionMemoryRepository} from './decision-memory-repository.js';
import {defineGrowthPrivateServiceKey} from './growth-commercial-private-services.js';

const priority=z.enum(['cash','profit','delivery']);
export const savedPreferencesSchema=z.object({priority,cashFloorMinor:z.number().int().min(0).max(1e12).optional(),pilotFirst:z.boolean(),reviewCadence:z.enum(['weekly','monthly']),learningEnabled:z.boolean(),confirmedFrom:z.enum(['self_report','explicit_feedback'])}).strict();
export type OperatingPreferences=z.infer<typeof savedPreferencesSchema>;
export function operatingPreferenceEvidence(value:OperatingPreferences|undefined){
  // Personal trade-offs, never company facts or executable instructions. The
  // cash threshold stays in the deterministic simulation, not numeric evidence.
  return value?{domain:'operating',priority:value.priority,pilotFirst:value.pilotFirst,reviewCadence:value.reviewCadence,source:'explicit_personal_confirmation'}:undefined;
}
const revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1);
export const operatingMemorySelectionSchema=z.object({domain:z.literal('operating'),revision}).strict();
const text=z.string().trim().min(1).max(2000);
const numeric=z.number().finite().min(-1e12).max(1e12);
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{try{return new Date(value).toISOString().slice(0,10)===value;}catch{return false;}});
const planSchema=z.object({action:text,metric:z.string().trim().min(1).max(120),unit:z.string().trim().min(1).max(40),baseline:numeric,target:numeric,dueDate:date,source:text}).strict();
const resultSchema=z.object({actual:numeric,observedDate:date,source:text,attribution:text,feedbackPriority:priority.optional()}).strict();
const address={runId:z.string().uuid(),recommendationId:z.string().regex(/^[a-z_]{1,60}$/)};
const reviewSchema=z.object({...address,plan:planSchema,result:resultSchema.optional(),expectedRevision:revision}).strict();
const actionSchema=z.object({...address,expectedRevision:revision}).strict();
export interface DecisionReview {
  runId:string;recommendationId:string;recommendationTitle:string;originalEvidence:string;
  originalAction:string;claimedAt:string;recordedAt:string;state:'planned'|'reviewed';sourceKind:'manual_observation';
  plan:z.infer<typeof planSchema>;result?:z.infer<typeof resultSchema>;
  comparison:{actualMinusTarget:number;actualMinusBaseline:number}|null;
  candidate:z.infer<typeof priority>|null;
}
export interface DecisionMemory {
  revision:number;updatedAt:string|null;
  profile:{enabled:boolean;preferences:z.infer<typeof savedPreferencesSchema>}|null;
  reviews:DecisionReview[];
}
export const emptyDecisionMemory=():DecisionMemory=>({revision:0,updatedAt:null,profile:null,reviews:[]});
function parse<T>(schema:z.ZodType<T>,raw:unknown):T {const parsed=schema.safeParse(raw);if(!parsed.success)throw new GrowthHttpError(422,'decision_memory_input_invalid');return parsed.data;}
const learning=(record:DecisionMemory)=>!!(record.profile?.enabled&&record.profile.preferences.learningEnabled);

/** Personal typed data only: never used as prompt instructions or business receipts. */
export class AgentOperatingMemoryService {
  constructor(private readonly repository:DecisionMemoryRepository,private readonly reports:DecisionSimulationService){}
  async get(scope:DecisionSimulationScope){assertDecisionScope(scope);return await this.repository.get(scope)??emptyDecisionMemory();}
  async confirmed(scope:DecisionSimulationScope,raw:unknown){
    const selection=parse(operatingMemorySelectionSchema,raw);
    const current=await this.edit(scope,selection.revision);
    if(!current.profile?.enabled)throw new GrowthHttpError(409,'decision_profile_disabled');
    return structuredClone(current.profile.preferences);
  }
  async export(scope:DecisionSimulationScope){return {format:'shensi-personal-decision-memory.v1' as const,exportedAt:new Date().toISOString(),...await this.get(scope)};}
  private async edit(scope:DecisionSimulationScope,expected:number){
    const current=await this.get(scope);if(current.revision!==expected)throw new GrowthHttpError(409,'decision_memory_revision_conflict');return current;
  }
  private async save(scope:DecisionSimulationScope,record:DecisionMemory){
    const expected=record.revision;record.revision++;record.updatedAt=new Date().toISOString();
    await this.repository.save(scope,record,expected);return structuredClone(record);
  }
  async saveProfile(scope:DecisionSimulationScope,raw:unknown){
    const input=parse(z.object({expectedRevision:revision,enabled:z.boolean(),preferences:savedPreferencesSchema}).strict(),raw);
    const record=await this.edit(scope,input.expectedRevision);
    record.profile={enabled:input.enabled,preferences:input.preferences};
    if(!learning(record))for(const review of record.reviews)review.candidate=null;
    return this.save(scope,record);
  }
  async deleteProfile(scope:DecisionSimulationScope,raw:unknown){
    const input=parse(z.object({expectedRevision:revision}).strict(),raw),record=await this.edit(scope,input.expectedRevision);
    record.profile=null;for(const review of record.reviews)review.candidate=null;
    return this.save(scope,record);
  }
  async saveReview(scope:DecisionSimulationScope,raw:unknown){
    const input=parse(reviewSchema,raw),record=await this.edit(scope,input.expectedRevision);
    const report=await this.reports.get(scope,input.runId);
    const suggestion=report.report.recommendations?.find(item=>item.id===input.recommendationId);
    if(!suggestion)throw new GrowthHttpError(404,'decision_recommendation_not_found');
    const previous=record.reviews.find(item=>item.runId===input.runId&&item.recommendationId===input.recommendationId);
    if(!previous&&record.reviews.length>=200)throw new GrowthHttpError(409,'decision_review_capacity');
    // A result never rewrites the plan against which it is being compared.
    if(input.result&&!previous)throw new GrowthHttpError(409,'decision_review_plan_required');
    if(previous&&(previous.result||input.result)&&JSON.stringify(previous.plan)!==JSON.stringify(input.plan))throw new GrowthHttpError(409,'decision_review_plan_locked');
    if(previous?.result&&!input.result)throw new GrowthHttpError(409,'decision_review_result_required');
    const now=new Date().toISOString();
    const review:DecisionReview={runId:input.runId,recommendationId:input.recommendationId,recommendationTitle:suggestion.title,
      originalEvidence:suggestion.evidence,originalAction:suggestion.action,claimedAt:previous?.claimedAt??now,recordedAt:now,
      plan:input.plan,...(input.result?{result:input.result}:{}),state:input.result?'reviewed':'planned',sourceKind:'manual_observation',
      comparison:input.result?{actualMinusTarget:input.result.actual-input.plan.target,actualMinusBaseline:input.result.actual-input.plan.baseline}:null,
      candidate:learning(record)&&input.result?.feedbackPriority&&(input.result.feedbackPriority!==previous?.result?.feedbackPriority||previous?.candidate===input.result.feedbackPriority)?input.result.feedbackPriority:null};
    record.reviews=record.reviews.filter(item=>item!==previous);record.reviews.push(review);
    return this.save(scope,record);
  }
  async adopt(scope:DecisionSimulationScope,raw:unknown){
    const input=parse(actionSchema,raw),record=await this.edit(scope,input.expectedRevision);
    if(!learning(record))throw new GrowthHttpError(409,'decision_learning_disabled');
    const review=record.reviews.find(item=>item.runId===input.runId&&item.recommendationId===input.recommendationId);
    if(!review?.candidate)throw new GrowthHttpError(409,'decision_candidate_unavailable');
    record.profile!.preferences={...record.profile!.preferences,priority:review.candidate,confirmedFrom:'explicit_feedback'};
    review.candidate=null;
    return this.save(scope,record);
  }
}
export const AGENT_OPERATING_MEMORY=defineGrowthPrivateServiceKey<AgentOperatingMemoryService>('agent-operating-memory');

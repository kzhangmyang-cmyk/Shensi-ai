import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GrowthHttpError } from './growth-command-context.js';
import type { ActiveWorkspaceContext } from './growth-workspace-context.js';
import { inspectDecisionSources } from './decision-source-material.js';
import { proposeDecisionFacts } from './decision-source-facts.js';
import { analyzeDecisionSources, type DecisionAgentResult, type DecisionSourceModel } from './decision-five-agents.js';
import { assertDecisionScope, decisionSimulationInputSchema, type DecisionSimulationService } from './decision-simulation-service.js';
import type { FinanceDocumentInspection } from './finance-document-inspection.js';
import {decisionCalculationCells} from './decision-calculation-material.js';

type Material = Awaited<ReturnType<typeof inspectDecisionSources>>;
export interface DecisionPreparation {
  id: string; expiresAt: string; dataKind: Material['dataKind'];
  state: 'awaiting_confirmation'|'analyzing'|'completed'|'failed'|'cancelled';
  files: Material['files']; sources: Array<{sourceRef:string;text:string}>;
  facts: ReturnType<typeof proposeDecisionFacts>; uncertain: string[];
  agents: DecisionAgentResult[]; runId: string|null; errorCode: string|null;
}
const command = z.object({confirm:z.literal(true),input:decisionSimulationInputSchema}).strict();
export class DecisionPreparationService {
  private rows = new Map<string,{view:DecisionPreparation;inspection:FinanceDocumentInspection;controller:AbortController;fingerprint?:string}>();
  constructor(private readonly options:{simulations:DecisionSimulationService;model:DecisionSourceModel;now?:()=>number}){}
  private now(){return this.options.now?.()??Date.now();}
  private key(context:ActiveWorkspaceContext,id:string){assertDecisionScope(context);return JSON.stringify([context.workspaceId,context.actorId,id]);}
  private purge(){for(const [key,row]of this.rows)if(Date.parse(row.view.expiresAt)<=this.now()){row.controller.abort();this.rows.delete(key);}}
  async create(context:ActiveWorkspaceContext,raw:unknown,signal?:AbortSignal){
    assertDecisionScope(context);this.purge();
    if(this.rows.size>=16)throw new GrowthHttpError(429,'decision_preparation_limit');
    const material=await inspectDecisionSources(context,raw,signal);
    // Recheck after asynchronous parsing before retaining memory.
    if(this.rows.size>=16)throw new GrowthHttpError(429,'decision_preparation_limit');
    const id=randomUUID();
    const view:DecisionPreparation={id,expiresAt:new Date(this.now()+3600000).toISOString(),dataKind:material.dataKind,
      state:'awaiting_confirmation',files:material.files,sources:material.cells.map(({sourceRef,text})=>({sourceRef,text})),
      facts:proposeDecisionFacts(material.cells),uncertain:material.uncertain,agents:[],runId:null,errorCode:null};
    const inspection:FinanceDocumentInspection={...material,fileHash:`sha256:${createHash('sha256').update(JSON.stringify(material.files)).digest('hex')}`,
      classification:'unknown',regions:[],missingStatements:['balance_sheet','income_statement','cash_flow_statement']};
    this.rows.set(this.key(context,id),{view,inspection,controller:new AbortController()});return structuredClone(view);
  }
  private row(context:ActiveWorkspaceContext,id:string){this.purge();const row=this.rows.get(this.key(context,id));if(!row)throw new GrowthHttpError(404,'decision_preparation_not_found');return row;}
  get(context:ActiveWorkspaceContext,id:string){return structuredClone(this.row(context,id).view);}
  start(context:ActiveWorkspaceContext,id:string,raw:unknown){
    const parsed=command.safeParse(raw);if(!parsed.success)throw new GrowthHttpError(422,'decision_preparation_input_invalid');
    const row=this.row(context,id);const {input}=parsed.data;
    if(input.dataKind!==row.view.dataKind||input.options.samples!==100)throw new GrowthHttpError(422,'decision_preparation_input_invalid');
    const fingerprint=JSON.stringify(input);
    if(row.fingerprint){if(row.fingerprint!==fingerprint)throw new GrowthHttpError(409,'decision_preparation_conflict');if(row.view.state!=='failed')return structuredClone(row.view);}
    row.controller=new AbortController();row.view.errorCode=null;row.view.agents=[];
    row.fingerprint=fingerprint;row.view.state='analyzing';
    void this.run(context,row,input);
    return structuredClone(row.view);
  }
  private async run(context:ActiveWorkspaceContext,row:ReturnType<DecisionPreparationService['row']>,input:z.infer<typeof decisionSimulationInputSchema>){
    try{
      const derived=decisionCalculationCells(input);
      const inspection={...row.inspection,cells:[...row.inspection.cells,...derived]};
      const agents=await analyzeDecisionSources({context,inspection,consent:true,model:this.options.model,
        signal:row.controller.signal,onUpdate:records=>{row.view.agents=records;}});
      row.controller.signal.throwIfAborted();
      if(agents.some(agent=>agent.state==='failed'||agent.state==='cancelled'))throw new GrowthHttpError(503,'decision_model_unavailable');
      const saved=await this.options.simulations.create(context,input,{files:row.view.files,sources:[...row.view.sources,...derived.map(({sourceRef,text})=>({sourceRef,text}))],agents,uncertain:row.view.uncertain});
      row.view.runId=saved.runId;row.view.state='completed';
    }catch(error){row.view.state=row.controller.signal.aborted?'cancelled':'failed';row.view.errorCode=error instanceof GrowthHttpError?error.code:'decision_analysis_unavailable';}
  }
  close(){for(const row of this.rows.values())row.controller.abort();this.rows.clear();}
}

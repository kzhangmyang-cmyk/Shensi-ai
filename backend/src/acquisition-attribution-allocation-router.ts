import express from "express";
import { z } from "zod";
import type { AttributionAllocationServiceLike, AttributionAllocationSet } from "./acquisition-attribution-allocation.js";
import type { GrowthWorkspaceContextResolver } from "./growth-http-preconditions.js";
import { commandContextFromRequest, parseIfMatchRevision } from "./growth-http-preconditions.js";
import { GrowthHttpError } from "./growth-command-context.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const id=z.string().min(1).max(191);
const hash=z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const evidence=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("cohort_member"),cohortMemberId:id}).strict(),
  z.object({kind:z.literal("source_report"),sourceReportId:id,reportHash:hash}).strict(),
  z.object({kind:z.literal("commercial_binding"),dealId:id,bindingHash:hash}).strict(),
  z.object({kind:z.literal("ledger_source"),ledgerType:z.enum(["cost","financial"]),ledgerEntryId:id,evidenceHash:hash}).strict()
]);
const schema=z.object({sourceType:z.enum(["cost_entry","cost_estimate","financial_fact","source_report"]),sourceId:id,
  items:z.array(z.object({cohortId:id,candidateId:id.nullable(),planId:id.nullable(),runId:id.nullable(),
    allocationBps:z.number().int().min(0).max(10000),allocationRule:z.enum(["first_touch","direct","manual","equal_split","evidence_weighted"]),
    ruleVersion:id,evidenceRefs:z.array(evidence).min(1).max(100),targetStableKey:id}).strict()).min(1).max(500)
}).strict().refine(input=>new Set(input.items.map(item=>item.targetStableKey)).size===input.items.length);

function project(set:AttributionAllocationSet) {
  return {...set,items:set.items.map(({effectiveAmountMinor:_amount,evidenceRefs,...item})=>({
    ...item,allocationSetId:set.id,evidenceRefs:evidenceRefs.map(ref=>JSON.stringify(ref))
  }))};
}

export function createAttributionAllocationRouter(options:{service:AttributionAllocationServiceLike;
  workspaceContext:GrowthWorkspaceContextResolver;
  validate(scope:ActiveWorkspaceContext,input:z.infer<typeof schema>):Promise<void>}) {
  const router=express.Router();
  const base="/api/v1/acquisition/attribution-allocation-sets";
  const scope=(req:express.Request,capability:"ledger.pending.create"|"ledger.verify")=>{
    const workspace=options.workspaceContext(req);
    if(req.header("X-Workspace-Id")!==workspace.workspaceId || workspace.workspaceId==="all") throw new GrowthHttpError(403,"workspace_required");
    requireGrowthCapabilities(workspace,[capability]);return workspace;
  };
  router.post(base,(req,res,next)=>{void(async()=>{
    const workspace=scope(req,"ledger.pending.create");
    const parsed=schema.safeParse(req.body);
    if(!parsed.success) throw new GrowthHttpError(400,"invalid_allocation_input");
    const context=commandContextFromRequest(req,{canonicalPath:base,pathParams:Object.freeze({}),payload:parsed.data,expectedRevision:null});
    await options.validate(workspace,parsed.data);
    res.status(201).json(project(await options.service.createDraft(context,parsed.data)));
  })().catch(next);});
  router.get(`${base}/:id`,(req,res,next)=>{void(async()=>{
    const workspace=scope(req,"ledger.pending.create");
    const set=await options.service.get(workspace,id.parse(req.params.id));
    if(!set) throw new GrowthHttpError(404,"allocation_set_not_found");
    res.setHeader("ETag",`"attribution-set:${set.id}:${set.revision}"`);res.json(project(set));
  })().catch(next);});
  router.post(`${base}/:id/activate`,(req,res,next)=>{void(async()=>{
    const workspace=scope(req,"ledger.verify");const setId=id.parse(req.params.id);
    const payload=z.object({}).strict().parse(req.body??{});
    const revision=parseIfMatchRevision(req,`attribution-set:${setId}`);
    const context=commandContextFromRequest(req,{canonicalPath:`${base}/:id/activate`,pathParams:Object.freeze({id:setId}),payload,expectedRevision:revision});
    const set=await options.service.get(workspace,setId);
    if(!set) throw new GrowthHttpError(404,"allocation_set_not_found");
    await options.validate(workspace,set);
    const result=await options.service.activate(context,setId);
    res.setHeader("ETag",`"attribution-set:${setId}:${result.revision}"`);res.json(project(result));
  })().catch(next);});
  return router;
}

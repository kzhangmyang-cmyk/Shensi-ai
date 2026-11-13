import express from "express";
import { z } from "zod";
import { GrowthHttpError } from "./growth-command-context.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import { commandContextFromRequest, parseIfMatchRevision, type GrowthWorkspaceContextResolver } from "./growth-http-preconditions.js";
import { publicCashSettlementAllocationSet, type CashSettlementAllocationServiceLike, type CashSettlementAllocationRepository, type CashSettlementFactReader } from "./financial-settlement-allocation.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const id=z.string().min(1).max(191);
const itemSchema=z.object({targetRevenueFactId:id,dealId:id,quoteVersionId:id,
  amountMinor:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),currency:z.string().regex(/^[A-Z]{3}$/),
  originalPaymentFactId:id.nullable(),originalPaymentAllocationSetId:id.nullable(),originalPaymentAllocationItemId:id.nullable()
}).strict();
const schema=z.object({sourceFactId:id,items:z.array(itemSchema).min(1).max(500)}).strict();

export function createCashSettlementAllocationRouter(options:{service:CashSettlementAllocationServiceLike;
  repository:CashSettlementAllocationRepository;facts:CashSettlementFactReader;workspaceContext:GrowthWorkspaceContextResolver}) {
  const router=express.Router();
  const base="/api/v1/finance/settlement-allocation-sets";
  const scope=(req:express.Request,capability:"ledger.pending.create"|"ledger.verify")=>{
    const workspace=options.workspaceContext(req);
    if(req.header("X-Workspace-Id")!==workspace.workspaceId || workspace.workspaceId==="all") throw new GrowthHttpError(403,"workspace_required");
    requireGrowthCapabilities(workspace,[capability]);return workspace;
  };
  async function hydrate(workspace:ActiveWorkspaceContext,input:z.infer<typeof schema>) {
    const source=await options.facts.requireFact(workspace,input.sourceFactId);
    if(!["payment_received","bad_debt_written_off","refund"].includes(source.factType)) throw new GrowthHttpError(422,"settlement_source_type_unsupported");
    let total=0n;
    const items=[];
    for(const item of input.items) {
      const target=await options.facts.requireFact(workspace,item.targetRevenueFactId);
      if(target.factType!=="revenue_recognized" || !target.commercialBindingSnapshot ||
        source.dealId!==item.dealId || target.dealId!==item.dealId || source.quoteVersionId!==item.quoteVersionId || target.quoteVersionId!==item.quoteVersionId ||
        source.currency!==item.currency || target.currency!==item.currency ||
        source.commercialBindingSnapshot?.bindingHash!==target.commercialBindingSnapshot.bindingHash) {
        throw new GrowthHttpError(422,"settlement_target_invalid");
      }
      if(source.factType==="refund") {
        const paymentSet=item.originalPaymentAllocationSetId?await options.repository.get(workspace.workspaceId,item.originalPaymentAllocationSetId):null;
        const paymentItem=paymentSet?.items.find(candidate=>candidate.id===item.originalPaymentAllocationItemId);
        const payment=item.originalPaymentFactId?await options.facts.requireFact(workspace,item.originalPaymentFactId):null;
        if(payment?.factType!=="payment_received" || paymentSet?.status!=="active" || paymentSet.sourceFactId!==payment.id ||
          paymentItem?.targetRevenueFactId!==item.targetRevenueFactId || paymentItem.currency!==item.currency ||
          paymentItem.dealId!==item.dealId || paymentItem.quoteVersionId!==item.quoteVersionId || item.amountMinor>paymentItem.amountMinor) {
          throw new GrowthHttpError(422,"refund_payment_item_invalid");
        }
      } else if(item.originalPaymentFactId!==null || item.originalPaymentAllocationSetId!==null || item.originalPaymentAllocationItemId!==null) {
        throw new GrowthHttpError(422,"settlement_target_invalid");
      }
      total+=BigInt(item.amountMinor);
      items.push({...item,commercialBindingSnapshot:target.commercialBindingSnapshot});
    }
    if(total>BigInt(source.amountMinor)) throw new GrowthHttpError(422,"settlement_source_overallocated");
    return {sourceFactId:input.sourceFactId,items};
  }
  router.post(base,(req,res,next)=>{void(async()=>{
    const workspace=scope(req,"ledger.pending.create");
    const parsed=schema.safeParse(req.body);
    if(!parsed.success) throw new GrowthHttpError(400,"invalid_settlement_input");
    const context=commandContextFromRequest(req,{canonicalPath:base,pathParams:Object.freeze({}),payload:parsed.data,expectedRevision:null});
    res.status(201).json(publicCashSettlementAllocationSet(await options.service.createDraft(context,await hydrate(workspace,parsed.data))));
  })().catch(next);});
  router.get(`${base}/:id`,(req,res,next)=>{void(async()=>{
    const workspace=scope(req,"ledger.pending.create");
    const set=await options.repository.get(workspace.workspaceId,id.parse(req.params.id));
    if(!set) throw new GrowthHttpError(404,"settlement_set_not_found");
    res.setHeader("ETag",`"settlement-set:${set.id}:${set.revision}"`);
    res.json(publicCashSettlementAllocationSet(set));
  })().catch(next);});
  router.post(`${base}/:id/activate`,(req,res,next)=>{void(async()=>{
    const workspace=scope(req,"ledger.verify");const setId=id.parse(req.params.id);
    const payload=z.object({}).strict().parse(req.body??{});
    const context=commandContextFromRequest(req,{canonicalPath:`${base}/:id/activate`,pathParams:Object.freeze({id:setId}),payload,expectedRevision:parseIfMatchRevision(req,`settlement-set:${setId}`)});
    const set=await options.repository.get(workspace.workspaceId,setId);
    if(!set) throw new GrowthHttpError(404,"settlement_set_not_found");
    await hydrate(workspace,set);
    const result=await options.service.activate(context,setId);
    res.setHeader("ETag",`"settlement-set:${setId}:${result.revision}"`);
    res.json(publicCashSettlementAllocationSet(result));
  })().catch(next);});
  return router;
}

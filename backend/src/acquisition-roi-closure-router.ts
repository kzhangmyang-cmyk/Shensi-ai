import express from "express";
import { z } from "zod";
import type { RoiClosureService } from "./acquisition-roi-closure.js";
import type { GrowthFoundationServices } from "./growth-foundation-module.js";
import { GrowthHttpError } from "./growth-command-context.js";
import { commandContextFromRequest, parseIfMatchRevision } from "./growth-http-preconditions.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import { assertGrowthAsOfNotFuture } from "./growth-as-of.js";

const id=z.string().min(1).max(191);
const date=z.string().datetime({offset:true});
const currency=z.string().regex(/^[A-Z]{3}$/u);
const ref=z.discriminatedUnion("kind",[
  z.object({kind:z.literal("source_report"),sourceReportId:id,reportHash:z.string().min(1)}).strict(),
  z.object({kind:z.literal("ledger_entry"),ledgerType:z.enum(["cost","financial"]),ledgerEntryId:id,evidenceHash:z.string().min(1)}).strict(),
  z.object({kind:z.literal("verification"),ledgerType:z.enum(["cost","financial"]),ledgerEntryId:id,verificationEventId:id}).strict(),
  z.object({kind:z.literal("allocation_set"),allocationKind:z.enum(["attribution","settlement"]),allocationSetId:id,version:z.number().int().positive()}).strict()
]);
const attestation=z.object({currency,aspect:z.enum(["acquisition_cost","revenue","cogs","cash","refund_bad_debt","attribution"]),
  periodFrom:date,periodTo:date,asOf:date,declaredTotalMinor:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  sourceSystem:id,sourceCursor:id.nullable(),sourceReportId:id.nullable(),reportAllocationSetId:id.nullable(),
  reportHash:z.string().regex(/^sha256:[a-f0-9]{64}$/u),evidenceRefs:z.array(ref).min(1).max(500)}).strict();
const close=z.object({currency,asOf:date,attestationIds:z.array(id).min(1).max(500).refine(ids=>new Set(ids).size===ids.length)}).strict();

export function createRoiClosureRouter(options:{service:RoiClosureService;foundation:GrowthFoundationServices;now?:()=>string}) {
  const router=express.Router();
  const workspace=(req:express.Request)=>{
    const scope=options.foundation.workspaceContext(req);
    if(req.header("X-Workspace-Id")!==scope.workspaceId || scope.workspaceId==="all") throw new GrowthHttpError(403,"workspace_required");
    requireGrowthCapabilities(scope,["roi.close"]);
    return scope;
  };
  for(const action of ["attestations","close"] as const) {
    router.post(`/api/v1/acquisition/cohorts/:id/${action}`,(req,res,next)=>{
      void(async()=>{
        const started=(options.now??(()=>new Date().toISOString()))();
        const scope=workspace(req);
        const cohortId=id.parse(req.params.id);
        if(action==="attestations") {
          const payload=attestation.parse(req.body);
          const asOf=assertGrowthAsOfNotFuture(payload.asOf,started,1000);
          const context=commandContextFromRequest(req,{canonicalPath:"/api/v1/acquisition/cohorts/:id/attestations",pathParams:Object.freeze({id:cohortId}),payload,expectedRevision:null});
          const cutoff=await options.foundation.temporalBarrier.sealReadCutoff(scope,asOf);
          res.status(201).json(await options.service.createAttestationAt(context,{...payload,cohortId},cutoff));
        } else {
          const payload=close.parse(req.body);
          const asOf=assertGrowthAsOfNotFuture(payload.asOf,started,1000);
          const etagScope=`roi-series:${cohortId}:${payload.currency}`;
          const expectedRevision=parseIfMatchRevision(req,etagScope);
          const context=commandContextFromRequest(req,{canonicalPath:"/api/v1/acquisition/cohorts/:id/close",pathParams:Object.freeze({id:cohortId}),payload,expectedRevision});
          const cutoff=await options.foundation.temporalBarrier.sealReadCutoff(scope,asOf);
          const version=await options.service.closeAt(context,{cohortId,currency:payload.currency,attestationIds:payload.attestationIds},cutoff);
          res.setHeader("ETag",`"${etagScope}:${version.version+1}"`);
          res.status(201).json(version);
        }
      })().catch(next);
    });
  }
  return router;
}

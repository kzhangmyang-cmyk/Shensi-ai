import express from "express";
import { z } from "zod";
import { GrowthHttpError } from "./growth-command-context.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";
import { commandContextFromRequest, type GrowthWorkspaceContextResolver } from "./growth-http-preconditions.js";
import type { FinancialSourceReportService } from "./financial-source-report.js";

const text = z.string().min(1).max(191);
const inputSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/u),
  sourceSystem: text,
  sourceCursor: text.nullable(),
  reportHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  declaredTotalMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  periodFrom: z.string().datetime({offset:true}),
  periodTo: z.string().datetime({offset:true})
}).strict().refine(row => Date.parse(row.periodFrom) < Date.parse(row.periodTo));

export function createFinancialSourceReportRouter(options: {
  service: FinancialSourceReportService;
  workspaceContext: GrowthWorkspaceContextResolver;
}) {
  const router=express.Router();
  router.use("/api/v1/finance/source-reports", (req,_res,next)=>{
    try {
      const workspace=options.workspaceContext(req);
      if (req.header("X-Workspace-Id")!==workspace.workspaceId || workspace.workspaceId==="all") {
        throw new GrowthHttpError(403,"workspace_required");
      }
      requireGrowthCapabilities(workspace,["ledger.pending.create"]);
      next();
    } catch(error) {next(error);}
  });
  router.post("/api/v1/finance/source-reports",(req,res,next)=>{
    void (async()=>{
      const parsed=inputSchema.safeParse(req.body);
      if (!parsed.success) throw new GrowthHttpError(400,"invalid_source_report_input");
      const payload={...parsed.data,reportHash:parsed.data.reportHash as `sha256:${string}`};
      const context=commandContextFromRequest(req,{
        canonicalPath:"/api/v1/finance/source-reports",pathParams:Object.freeze({}),payload,expectedRevision:null
      });
      res.status(201).json(await options.service.create(context,payload));
    })().catch(next);
  });
  router.get("/api/v1/finance/source-reports/:id",(req,res,next)=>{
    void (async()=>{
      const parsed=text.safeParse(req.params.id);
      if (!parsed.success) throw new GrowthHttpError(400,"invalid_source_report_id");
      const report=await options.service.get(options.workspaceContext(req),parsed.data);
      if (!report) throw new GrowthHttpError(404,"source_report_not_found");
      res.json(report);
    })().catch(next);
  });
  return router;
}

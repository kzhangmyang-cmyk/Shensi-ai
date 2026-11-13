import assert from "node:assert/strict";
import test from "node:test";
import { RoiClosureRuntimeReader } from "./roi-closure-runtime-reader.js";
import { calculateActualRoiForClosure } from "./acquisition-roi-calculation.js";
import { financialFactProjectionFixture, verifiedCostLedgerFixture } from "./growth-finance-test-fixtures.js";
import { projectVerifiedFinancialFact, projectVerifiedCost } from "./financial-ledger-as-of-reader.js";
import type { AttributionAllocationSet } from "./acquisition-attribution-allocation.js";
import type { CashSettlementAllocationSet } from "./financial-settlement-allocation.js";
import type { ClosureAttestation } from "./acquisition-roi-closure.js";
import { InMemoryAcquisitionCohortRepository } from "./acquisition-cohort-repository.js";
import { DefaultGrowthTemporalBarrier, InMemoryGrowthTemporalTransactionRunner } from "./growth-temporal-barrier.js";
import { discoverySource, workspaceContext } from "./growth-roi-test-fixtures.js";
import { canonicalSubjectStableKey } from "./acquisition-canonical-subject.js";

async function fixture() {
  const workspace=workspaceContext("workspace-a");
  const runner=new InMemoryGrowthTemporalTransactionRunner("2026-08-11T00:00:00.000Z");
  const barrier=new DefaultGrowthTemporalBarrier(runner);
  const cohorts=new InMemoryAcquisitionCohortRepository(runner,barrier);
  const hash=`sha256:${"a".repeat(64)}` as const;
  const cohort=await cohorts.createCohort({id:"cohort-a",workspaceId:workspace.workspaceId,platform:"douyin",
    cohortFrom:"2026-08-01T00:00:00.000Z",cohortTo:"2026-08-08T00:00:00.000Z",definitionVersion:"weekly.v1",
    firstTouchRuleVersion:"first.v1",domainCommandHash:hash,requestHash:hash,requestedBy:"finance-a",now:"2026-08-09T00:00:00.000Z"});
  const source=discoverySource([{eventId:"event-a",candidateId:"candidate-a",ownerId:"sales-a",actorKey:"actor-a",planId:"plan-a",
    discoveredAt:"2026-08-01T01:00:00.000Z",recordedAt:"2026-08-01T01:00:01.000Z"}]);
  const initial=await barrier.sealReadCutoff(workspace,"2026-08-11T00:00:00.000Z");
  const row=(await source.listDiscoveries(workspace.workspaceId,{platform:"douyin",from:cohort.cohortFrom,to:cohort.cohortTo,cutoff:initial,limit:10,after:null})).items[0]!;
  await cohorts.upsertFirstTouch({cohort,event:{...row,planId:row.attribution.planId,runId:row.attribution.runId,shardId:null,evidenceId:null},
    resolution:canonicalSubjectStableKey(workspace.workspaceId,row.material),now:"2026-08-09T00:00:00.000Z"});
  const cutoff=await barrier.sealReadCutoff(workspace,"2026-08-11T00:00:00.000Z");
  const fact=financialFactProjectionFixture();
  const cost=verifiedCostLedgerFixture();
  const ledger=[projectVerifiedCost({...cost.entry,amountMinor:200}, {...fact.verification,ledgerType:"cost",ledgerEntryId:cost.entry.id}),
    ...(["revenue_recognized","cogs_recognized","payment_received","refund","contract_won"] as const).map((factType,i)=>
      projectVerifiedFinancialFact({...fact.fact,id:factType,factType,amountMinor:[1000,200,1000,10,1000][i]!},
        {...fact.verification,ledgerEntryId:factType}))];
  const attribution:AttributionAllocationSet[]=ledger.map(row=>({id:`alloc-${row.entryId}`,workspaceId:workspace.workspaceId,
    sourceType:row.ledgerType==="cost"?"cost_entry":"financial_fact",sourceId:row.entryId,version:1,status:"active",revision:2,
    createdBy:"finance-a",createdAt:"2026-08-09T00:00:00.000Z",activatedBy:"finance-b",activatedAt:"2026-08-09T01:00:00.000Z",
    items:[{cohortId:cohort.id,candidateId:null,planId:null,runId:null,allocationBps:10000,allocationRule:"direct",ruleVersion:"v1",evidenceRefs:[],targetStableKey:cohort.id,effectiveAmountMinor:row.amountMinor}]}));
  assert.ok(fact.fact.commercialBindingSnapshot);
  const settlement:CashSettlementAllocationSet[]=["payment_received","refund"].map(id=>({id:`settle-${id}`,workspaceId:workspace.workspaceId,
    sourceFactId:id,version:1,status:"active",revision:2,createdBy:"finance-a",createdAt:"2026-08-09T00:00:00.000Z",activatedBy:"finance-b",activatedAt:"2026-08-09T01:00:00.000Z",
    items:[{id:`item-${id}`,targetRevenueFactId:"revenue_recognized",dealId:fact.fact.dealId!,quoteVersionId:fact.fact.quoteVersionId!,
      amountMinor:id==="refund"?10:1000,currency:"CNY",originalPaymentFactId:id==="refund"?"payment_received":null,
      originalPaymentAllocationSetId:id==="refund"?"settle-payment_received":null,originalPaymentAllocationItemId:id==="refund"?"item-payment_received":null,
      commercialBindingSnapshot:fact.fact.commercialBindingSnapshot!}]}));
  const aspects=["acquisition_cost","revenue","cogs","cash","refund_bad_debt","attribution"] as const;
  const attestations:ClosureAttestation[]=aspects.map((aspect,i)=>({id:aspect,workspaceId:workspace.workspaceId,cohortId:cohort.id,currency:"CNY",aspect,
    periodFrom:"2026-08-01T00:00:00.000Z",periodTo:"2026-08-10T00:00:00.000Z",asOf:"2026-08-10T00:00:00.000Z",
    declaredTotalMinor:[200,1000,200,1000,10,1000][i]!,sourceSystem:"synthetic-acceptance",sourceCursor:null,sourceReportId:`report-${aspect}`,reportAllocationSetId:null,
    reportHash:hash,evidenceRefs:[],status:"signed",signedBy:"finance-a",signedAt:"2026-08-10T00:00:00.000Z"}));
  const reports=attestations.map(a=>({id:a.sourceReportId!,workspaceId:a.workspaceId,currency:a.currency,sourceSystem:a.sourceSystem,sourceCursor:null,
    reportHash:a.reportHash,declaredTotalMinor:a.declaredTotalMinor!,periodFrom:a.periodFrom,periodTo:a.periodTo,createdBy:"finance-a",createdAt:a.signedAt}));
  const reader=new RoiClosureRuntimeReader({cohorts,inputs:{async read(){return {ledger,reports,attribution,settlement};}}});
  return {reader,input:{workspace,cutoff,attestations},attribution,settlement};
}

test("runtime aggregation calculates from resolved evidence without counting repeated references",async()=>{
  const f=await fixture();
  const result=await f.reader.freezeEvidence(f.input);
  assert.equal(result.verifiedRevenueMinor,1000);
  assert.equal(result.verifiedAcquisitionCostMinor,200);
  assert.equal(result.netCashMinor,990);
  const actual=calculateActualRoiForClosure(result);
  assert.equal(actual.status,"computed");
  assert.equal(actual.status==="computed" && actual.roiBps,29500);
});

test("runtime aggregation refuses totals, attribution or cash reconciliation gaps",async()=>{
  const f=await fixture();
  await assert.rejects(()=>f.reader.freezeEvidence({...f.input,attestations:f.input.attestations.map(a=>({...a,declaredTotalMinor:999}))}),/attestation_total_mismatch/);
  const payment=f.settlement.shift()!;
  await assert.rejects(()=>f.reader.freezeEvidence(f.input),/cash_reconciliation_incomplete/);
  f.settlement.unshift(payment);
  f.attribution[0]!.items[0]!.effectiveAmountMinor=1;
  await assert.rejects(()=>f.reader.freezeEvidence(f.input),/attribution_incomplete/);
});

test("runtime refund reconciliation requires the original matched payment",async()=>{
  const f=await fixture();
  f.settlement[1]!.items[0]!.originalPaymentAllocationItemId="unrelated-payment";
  await assert.rejects(()=>f.reader.freezeEvidence(f.input),/cash_reconciliation_incomplete/);
});

import { RoiClosureError, type ClosureFixtureReader } from "./acquisition-roi-closure.js";
import type { AcquisitionCohortRepository } from "./acquisition-cohort-repository.js";
import type { RoiClosureInputReader } from "./roi-closure-input-reader.js";
import { hashCanonicalJson } from "./growth-roi-command-executor.js";
import { safeSignedInteger } from "./growth-money.js";
import { requireGrowthCapabilities } from "./growth-capabilities.js";

/** Aggregate only explicit, verified, fully assigned closure evidence. */
export class RoiClosureRuntimeReader implements ClosureFixtureReader {
  constructor(private readonly dependencies:{inputs:Pick<RoiClosureInputReader,"read">;cohorts:Pick<AcquisitionCohortRepository,"getCohort"|"listMembersAt">}) {}

  async freezeEvidence(input:Parameters<ClosureFixtureReader["freezeEvidence"]>[0]) {
    requireGrowthCapabilities(input.workspace,["roi.close"]);
    const fail=(code="closure_evidence_incomplete"):never=>{throw new RoiClosureError(code,422);};
    const first=input.attestations[0];
    if (!first || input.attestations.length!==6 || new Set(input.attestations.map(a=>a.aspect)).size!==6) return fail();
    const cohort=await this.dependencies.cohorts.getCohort(input.workspace.workspaceId,first.cohortId);
    if (!cohort || cohort.status!=="active") return fail("cohort_not_found");
    for(const a of input.attestations) {
      if(a.workspaceId!==input.workspace.workspaceId || a.cohortId!==cohort.id || a.currency!==first.currency
        || a.periodFrom!==first.periodFrom || a.periodTo!==first.periodTo || a.asOf!==first.asOf) return fail();
    }
    const evidence=await Promise.all(input.attestations.map(a=>this.dependencies.inputs.read(input.cutoff,a)));
    const amounts=new Map<string,number>();
    const allLedger=new Map(evidence.flatMap(e=>e.ledger.map(row=>[`${row.ledgerType}:${row.entryId}`,row] as const)));
    const allocations=new Map(evidence.flatMap(e=>e.attribution.map(row=>[row.id,row] as const)));
    const settlements=new Map(evidence.flatMap(e=>e.settlement.map(row=>[row.id,row] as const)));
    const sum=(values:readonly number[])=>safeSignedInteger(values.reduce((total,value)=>total+BigInt(value),0n),"closureAmount");
    for(const row of allLedger.values()) {
      const type=row.ledgerType==="cost"?"cost_entry":"financial_fact";
      const matches=[...allocations.values()].filter(set=>set.sourceType===type && set.sourceId===row.entryId);
      if(matches.length!==1) return fail("attribution_incomplete");
      const set=matches[0]!;
      if(sum(set.items.map(item=>item.effectiveAmountMinor))!==row.netAmountMinor
        || sum(set.items.map(item=>item.allocationBps))!==10000) return fail("attribution_incomplete");
      // Partial financial allocations require proportional cash reconciliation;
      // reject them until that calculation is supported, rather than overcount.
      if(row.ledgerType==="financial" && set.items.some(item=>item.cohortId!==cohort.id)) return fail("attribution_incomplete");
      amounts.set(`${row.ledgerType}:${row.entryId}`,sum(set.items.filter(item=>item.cohortId===cohort.id).map(item=>item.effectiveAmountMinor)));
    }
    const factTotal=(type:string)=>sum([...allLedger.values()].filter(row=>row.ledgerType==="financial" && row.factType===type).map(row=>amounts.get(`financial:${row.entryId}`)!));
    const cost=sum([...allLedger.values()].filter(row=>row.ledgerType==="cost").map(row=>amounts.get(`cost:${row.entryId}`)!));
    const totals:Record<string,number>={acquisition_cost:cost,revenue:factTotal("revenue_recognized"),cogs:factTotal("cogs_recognized"),
      cash:factTotal("payment_received"),refund_bad_debt:sum([factTotal("refund"),factTotal("bad_debt_written_off")]),attribution:factTotal("contract_won")};
    for(const [index,a] of input.attestations.entries()) {
      const refs=evidence[index]!;
      const report=refs.reports.find(r=>r.id===a.sourceReportId);
      if(!report || report.reportHash!==a.reportHash || report.sourceSystem!==a.sourceSystem
        || report.declaredTotalMinor!==a.declaredTotalMinor || a.declaredTotalMinor!==totals[a.aspect]) return fail("attestation_total_mismatch");
    }
    const revenues=[...allLedger.values()].filter(row=>row.ledgerType==="financial" && row.factType==="revenue_recognized");
    const paid=new Map<string,number>();
    const refunded=new Map<string,number>();
    for(const row of allLedger.values()) {
      if(row.ledgerType!=="financial" || !["payment_received","refund","bad_debt_written_off"].includes(row.factType)) continue;
      const sets=[...settlements.values()].filter(set=>set.sourceFactId===row.entryId);
      if(sets.length!==1 || sum(sets[0]!.items.map(item=>item.amountMinor))!==row.netAmountMinor) return fail("cash_reconciliation_incomplete");
      for(const item of sets[0]!.items) {
        const revenue=revenues.find(target=>target.entryId===item.targetRevenueFactId);
        if(!revenue || revenue.ledgerType!=="financial" || revenue.dealId!==item.dealId || revenue.quoteVersionId!==item.quoteVersionId
          || revenue.commercialBindingHash!==item.commercialBindingSnapshot.bindingHash
          || row.dealId!==item.dealId || row.quoteVersionId!==item.quoteVersionId
          || row.commercialBindingHash!==item.commercialBindingSnapshot.bindingHash
          || item.amountMinor<=0) return fail("cash_reconciliation_incomplete");
        if(row.factType==="refund") {
          const original=settlements.get(item.originalPaymentAllocationSetId??"");
          const payment=allLedger.get(`financial:${item.originalPaymentFactId}`);
          const originalItem=original?.items.find(candidate=>candidate.id===item.originalPaymentAllocationItemId);
          if(!original || original.sourceFactId!==item.originalPaymentFactId || !payment || payment.ledgerType!=="financial"
            || payment.factType!=="payment_received" || !originalItem || originalItem.targetRevenueFactId!==item.targetRevenueFactId
            || originalItem.dealId!==item.dealId || originalItem.quoteVersionId!==item.quoteVersionId) return fail("cash_reconciliation_incomplete");
          const key=`${original.id}:${originalItem.id}`;
          const total=sum([refunded.get(key)??0,item.amountMinor]);
          if(total>originalItem.amountMinor) return fail("cash_reconciliation_incomplete");
          refunded.set(key,total);
        }
        if(row.factType==="payment_received" || row.factType==="bad_debt_written_off") {
          paid.set(revenue.entryId,sum([paid.get(revenue.entryId)??0,item.amountMinor]));
        }
      }
    }
    if(revenues.some(row=>paid.get(row.entryId)!==row.netAmountMinor)) return fail("cash_reconciliation_incomplete");
    const members=await this.dependencies.cohorts.listMembersAt(input.workspace.workspaceId,cohort.id,input.cutoff);
    if(members.length===0 || members.some(m=>m.projectionTemporalSequence>input.cutoff.temporalSequence || m.firstSourceTemporalSequence>input.cutoff.temporalSequence)) return fail("attribution_incomplete");
    const stable=<T>(rows:Iterable<T>)=>[...rows].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {
      closureEvidence:{membershipSnapshotHash:hashCanonicalJson(stable(members)),attestationSetHash:hashCanonicalJson(stable(input.attestations)),
        factSetHash:hashCanonicalJson(stable([...allLedger.values()].filter(row=>row.ledgerType==="financial"))),
        costSetHash:hashCanonicalJson(stable([...allLedger.values()].filter(row=>row.ledgerType==="cost"))),
        allocationSetHash:hashCanonicalJson(stable(allocations.values())),settlementSetHash:hashCanonicalJson(stable(settlements.values()))},
      verifiedRevenueMinor:totals.revenue!,verifiedCogsMinor:totals.cogs!,verifiedRefundMinor:factTotal("refund"),
      verifiedBadDebtMinor:factTotal("bad_debt_written_off"),verifiedAcquisitionCostMinor:cost,allCoverageBps:10000,cashReconciled:true,
      members:members.map(m=>({cohortMemberId:m.id,ownershipVersionId:m.ownershipVersionId,firstPlanId:m.firstPlanId})),
      verifiedContractWonMinor:totals.attribution!,allocatedPaymentMinor:totals.cash!,netCashMinor:sum([totals.cash!,-factTotal("refund")])
    };
  }
}

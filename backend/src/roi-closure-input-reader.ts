import { RoiClosureError, type ClosureAttestation } from "./acquisition-roi-closure.js";
import type { VerifiedFinancialLedgerSealedReader, VerifiedLedgerRow } from "./financial-ledger-as-of-reader.js";
import type { FinancialSourceReport, FinancialSourceReportRepository } from "./financial-source-report.js";
import type { AttributionAllocationRepository, AttributionAllocationSet } from "./acquisition-attribution-allocation.js";
import { activeAttributionSetIdAsOf } from "./acquisition-attribution-allocation-as-of-reader.js";
import { activeSettlementSetIdAsOf, type CashSettlementAllocationRepository, type CashSettlementAllocationSet } from "./financial-settlement-allocation.js";
import { assertGrowthSealedReadCutoff, type GrowthSealedReadCutoff } from "./growth-temporal-barrier.js";
import { growthInstantMilliseconds } from "./growth-as-of.js";

/** Resolve persisted evidence, never amounts supplied by the attestation signer. */
export class RoiClosureInputReader {
  constructor(private readonly dependencies: {
    ledger: VerifiedFinancialLedgerSealedReader;
    reports: Pick<FinancialSourceReportRepository,"getReport">;
    attribution: Pick<AttributionAllocationRepository,"get"|"listLifecycleEvents">;
    settlement: Pick<CashSettlementAllocationRepository,"get"|"listLifecycleEvents">;
  }) {}

  async read(cutoff: GrowthSealedReadCutoff, attestation: ClosureAttestation) {
    assertGrowthSealedReadCutoff(cutoff,attestation.workspaceId);
    const before=(date:string)=>growthInstantMilliseconds(date)<=growthInstantMilliseconds(cutoff.effectiveAsOf);
    const invalid=()=>new RoiClosureError("closure_evidence_invalid",422);
    if (attestation.status!=="signed" || !before(attestation.signedAt)
      || !before(attestation.asOf) || !before(attestation.periodTo)
      || growthInstantMilliseconds(attestation.periodFrom)>=growthInstantMilliseconds(attestation.periodTo)) throw invalid();
    const ledger=new Map<string,VerifiedLedgerRow>();
    const reports=new Map<string,FinancialSourceReport>();
    const attribution=new Map<string,AttributionAllocationSet>();
    const settlement=new Map<string,CashSettlementAllocationSet>();
    for (const ref of attestation.evidenceRefs) {
      if (ref.kind==="ledger_entry" || ref.kind==="verification") {
        const key=`${ref.ledgerType}:${ref.ledgerEntryId}`;
        const row=ledger.get(key) ?? await this.dependencies.ledger.getVerifiedAt(cutoff,{
          ledgerType:ref.ledgerType,entryId:ref.ledgerEntryId,currency:attestation.currency
        });
        if (!row || row.workspaceId!==attestation.workspaceId
          || growthInstantMilliseconds(row.businessOccurredAt)<growthInstantMilliseconds(attestation.periodFrom)
          || growthInstantMilliseconds(row.businessOccurredAt)>=growthInstantMilliseconds(attestation.periodTo)
          || (ref.kind==="ledger_entry" && row.evidenceHash!==ref.evidenceHash)
          || (ref.kind==="verification" && row.verificationEventId!==ref.verificationEventId)) throw invalid();
        ledger.set(key,row);
      } else if (ref.kind==="source_report") {
        const row=await this.dependencies.reports.getReport(attestation.workspaceId,ref.sourceReportId);
        if (!row || row.workspaceId!==attestation.workspaceId || row.currency!==attestation.currency
          || row.reportHash!==ref.reportHash || !before(row.createdAt)
          || growthInstantMilliseconds(row.periodFrom)!==growthInstantMilliseconds(attestation.periodFrom)
          || growthInstantMilliseconds(row.periodTo)!==growthInstantMilliseconds(attestation.periodTo)) throw invalid();
        reports.set(row.id,row);
      } else if (ref.allocationKind==="attribution") {
        const row=await this.dependencies.attribution.get(attestation.workspaceId,ref.allocationSetId);
        if (!row || row.workspaceId!==attestation.workspaceId || row.version!==ref.version || !before(row.createdAt)) throw invalid();
        const events=await this.dependencies.attribution.listLifecycleEvents(attestation.workspaceId,row.sourceType,row.sourceId);
        const active=activeAttributionSetIdAsOf(events.filter(event=>event.temporalSequence<=cutoff.temporalSequence),cutoff.effectiveAsOf);
        if (active!==row.id) throw invalid();
        attribution.set(row.id,row);
      } else {
        const row=await this.dependencies.settlement.get(attestation.workspaceId,ref.allocationSetId);
        if (!row || row.workspaceId!==attestation.workspaceId || row.version!==ref.version || !before(row.createdAt)
          || row.items.some(item=>item.currency!==attestation.currency)) throw invalid();
        const events=await this.dependencies.settlement.listLifecycleEvents(attestation.workspaceId,row.sourceFactId);
        const active=activeSettlementSetIdAsOf(events.filter(event=>event.temporalSequence<=cutoff.temporalSequence),cutoff.effectiveAsOf);
        if (active!==row.id) throw invalid();
        settlement.set(row.id,row);
      }
    }
    return {ledger:[...ledger.values()],reports:[...reports.values()],attribution:[...attribution.values()],settlement:[...settlement.values()]};
  }
}

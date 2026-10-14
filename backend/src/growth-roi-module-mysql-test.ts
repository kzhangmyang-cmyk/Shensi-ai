import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";
import { createGrowthRoiModule, GROWTH_ROI_DISCOVERY_SERVICES, GROWTH_ROI_SERVICES } from "./growth-roi-module.js";
import { completeClosureFixture } from "./growth-roi-test-fixtures.js";
import { createGrowthPrivateServiceRegistry } from "./growth-commercial-private-services.js";
import { createGrowthCommercialToolPorts } from "./growth-commercial-application.js";
import { GROWTH_FOUNDATION_SERVICES } from "./growth-foundation-module.js";
import type { AddressInfo } from "node:net";
import { approvalFixture, managerDecisionContext } from "./growth-quote-test-fixtures.js";
import { GROWTH_QUOTE_AUTHORITY_READERS } from "./growth-quote-module.js";
import { discoverySource } from "./growth-roi-test-fixtures.js";
import { canonicalSubjectStableKey } from "./acquisition-canonical-subject.js";
import { createGrowthFinanceModule } from "./growth-finance-module.js";
import { AcquisitionCostEstimateService } from "./acquisition-cost-estimate-service.js";
import { MysqlFinancialLedgerRepository } from "./financial-ledger-mysql-repository.js";
import { RoiClosureInputReader } from "./roi-closure-input-reader.js";
import type { ClosureAttestation } from "./acquisition-roi-closure.js";

test("closure input resolves verified ledger evidence and rejects tampered or out-of-scope references", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
},async()=>{
  await withGrowthFinanceMysqlTestDatabase(async db=>{
    await db.seedWonAuthority({quotedAmountMinor:1000,currency:"CNY",commercialAmountHash:`sha256:${"7".repeat(64)}`});
    const created=await db.createDirectRevenueAndGrossProfit({revenueMinor:1000,grossProfitMinor:800,currency:"CNY"});
    const early=await db.foundation.temporalBarrier.sealReadCutoff(db.workspaceContext("workspace-a"),new Date().toISOString());
    await db.verifyFacts(created.ids,{expectedRevision:1});
    const cutoff=await db.foundation.temporalBarrier.sealReadCutoff(db.workspaceContext("workspace-a"),new Date(Date.now()+1000).toISOString());
    const row=await db.verifiedSealedReader.getVerifiedAt(cutoff,{ledgerType:"financial",entryId:created.ids[0]!,currency:"CNY"});
    assert.ok(row);
    const reader=new RoiClosureInputReader({ledger:db.verifiedSealedReader,reports:db.repository,attribution:db.repository,settlement:db.settlementRepository});
    const attestation:ClosureAttestation={id:"acceptance-proof",workspaceId:"workspace-a",cohortId:"cohort-a",currency:"CNY",aspect:"revenue",
      periodFrom:"2026-08-01T00:00:00.000Z",periodTo:"2026-08-09T00:00:00.000Z",asOf:"2026-08-09T00:00:00.000Z",
      declaredTotalMinor:1000,sourceSystem:"local-acceptance",sourceCursor:null,sourceReportId:null,reportAllocationSetId:null,
      reportHash:`sha256:${"8".repeat(64)}`,status:"signed",signedBy:"finance-a",signedAt:"2026-08-09T00:00:00.000Z",
      evidenceRefs:[{kind:"ledger_entry",ledgerType:"financial",ledgerEntryId:row.entryId,evidenceHash:row.evidenceHash},
        {kind:"verification",ledgerType:"financial",ledgerEntryId:row.entryId,verificationEventId:row.verificationEventId}]};
    const evidence=await reader.read(cutoff,attestation);
    assert.equal(evidence.ledger.length,1);
    assert.equal(evidence.ledger[0]?.amountMinor,1000);
    await assert.rejects(()=>reader.read(early,attestation),/closure_evidence_invalid/);
    await assert.rejects(()=>reader.read(cutoff,{...attestation,currency:"USD"}),/closure_evidence_invalid/);
    await assert.rejects(()=>reader.read(cutoff,{...attestation,evidenceRefs:[{kind:"ledger_entry",ledgerType:"financial",ledgerEntryId:row.entryId,evidenceHash:"tampered"}]}),/closure_evidence_invalid/);
    await assert.rejects(()=>reader.read(cutoff,{...attestation,evidenceRefs:[{kind:"verification",ledgerType:"financial",ledgerEntryId:row.entryId,verificationEventId:"wrong"}]}),/closure_evidence_invalid/);
    const foreign=await db.foundation.temporalBarrier.sealReadCutoff(db.workspaceContext("workspace-b"),new Date(Date.now()+1000).toISOString());
    await assert.rejects(()=>reader.read(foreign,{...attestation,workspaceId:"workspace-b"}),/closure_evidence_invalid/);
    const report=await db.repository.createReport({id:"acceptance-source",workspaceId:"workspace-a",currency:"CNY",
      sourceSystem:"local-acceptance",sourceCursor:null,reportHash:attestation.reportHash,declaredTotalMinor:1000,
      periodFrom:attestation.periodFrom,periodTo:attestation.periodTo,createdBy:"finance-a",createdAt:new Date().toISOString(),
      domainCommandHash:`sha256:${"9".repeat(64)}`,requestHash:"acceptance",requestedBy:"finance-a"});
    const reported=await db.foundation.temporalBarrier.sealReadCutoff(db.workspaceContext("workspace-a"),new Date(Date.now()+1000).toISOString());
    const proof={...attestation,evidenceRefs:[...attestation.evidenceRefs,{kind:"source_report" as const,sourceReportId:report.id,reportHash:report.reportHash}]};
    assert.equal((await reader.read(reported,proof)).reports[0]?.declaredTotalMinor,1000);
    await assert.rejects(()=>reader.read(reported,{...proof,evidenceRefs:[{kind:"source_report",sourceReportId:report.id,reportHash:"wrong"}]}),/closure_evidence_invalid/);
  });
});

test("ROI source reports persist through module recreation with idempotent creation", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
}, async () => {
  await withGrowthFinanceMysqlTestDatabase(async db => {
    let reportId="";
    for (let restart=0;restart<2;restart++) {
      const registry=createGrowthPrivateServiceRegistry();
      registry.provide(GROWTH_FOUNDATION_SERVICES,db.foundation);
      const app=express();
      app.use(express.json());
      app.use((req,_res,next)=>{req.activeWorkspace=db.workspaceContext("workspace-a");next();});
      const handle=await createGrowthRoiModule({mode:"mysql",pool:db.pool}).install({
        router:app,privateServices:registry,toolPorts:createGrowthCommercialToolPorts()});
      app.use((error:{status?:number;code?:string},_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
        res.status(error.status??400).json({code:error.code});
      });
      const server=app.listen(0,"127.0.0.1");
      await new Promise<void>(resolve=>server.once("listening",resolve));
      const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/finance/source-reports`;
      try {
        const service=registry.require(GROWTH_ROI_SERVICES).sourceReports;
        const payload={
          currency:"CNY",sourceSystem:"local-acceptance",sourceCursor:null,
          reportHash:`sha256:${"5".repeat(64)}`,declaredTotalMinor:1000,
          periodFrom:"2026-08-01T00:00:00.000Z",periodTo:"2026-08-08T00:00:00.000Z"};
        const headers={"Content-Type":"application/json","X-Workspace-Id":"workspace-a","Idempotency-Key":"local-acceptance-report"};
        const response=await fetch(url,{method:"POST",headers,body:JSON.stringify(payload)});
        assert.equal(response.status,201,response.status===201?undefined:await response.text());
        const report=await response.json() as {id:string};
        if (restart===0) reportId=report.id;
        assert.equal(report.id,reportId);
        assert.equal((await fetch(`${url}/${reportId}`,{headers})).status,200);
        assert.equal((await fetch(url,{method:"POST",headers,body:JSON.stringify({...payload,declaredTotalMinor:0})})).status,400);
        assert.equal((await fetch(url,{method:"POST",headers:{...headers,"X-Workspace-Id":"workspace-b"},body:JSON.stringify(payload)})).status,403);
        assert.equal((await service.get(db.workspaceContext("workspace-a"),reportId))?.declaredTotalMinor,1000);
        assert.equal(await service.get(db.workspaceContext("workspace-b"),reportId),null);
        await assert.rejects(()=>service.get({...db.workspaceContext("workspace-a"),capabilities:[]},reportId),{code:"capability_forbidden"});
      } finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await handle.close();}
    }
  });
});

test("ROI module uses approved authoritative quotes instead of an empty contribution source", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
}, async () => {
  await withGrowthFinanceMysqlTestDatabase(async db => {
    const quotes=approvalFixture();
    await quotes.service.approve(managerDecisionContext(),quotes.formalVersion.id,{reason:"同意"});
    const registry=createGrowthPrivateServiceRegistry();
    registry.provide(GROWTH_FOUNDATION_SERVICES,db.foundation);
    registry.provide(GROWTH_QUOTE_AUTHORITY_READERS,{
      commercialBindingVerifier:quotes.bindingVerifier,dealAuthoritativeQuotes:quotes.dealReader,
      authoritativeContributions:quotes.asOfReader,quoteApprovals:quotes.approvalReader,
      quoteVersions:quotes.versionReader,quotePreviews:quotes.previewReader
    });
    const finance=await createGrowthFinanceModule({mode:"mysql",pool:db.pool,startRecovery:false,
      processWorkerId:"roi-test",recoveryAuthorizer:{async authorize(){throw new Error("unexpected recovery");}}
    }).install({router:express.Router(),privateServices:registry,toolPorts:createGrowthCommercialToolPorts()});
    const handle=await createGrowthRoiModule({mode:"mysql",pool:db.pool}).install({
      router:express.Router(),privateServices:registry,toolPorts:createGrowthCommercialToolPorts()});
    try {
      const services=registry.require(GROWTH_ROI_DISCOVERY_SERVICES);
      const cohort=await services.cohorts.createCohort({
        id:"quote-cohort",workspaceId:"team-a",platform:"douyin",cohortFrom:"2026-08-01T00:00:00.000Z",cohortTo:"2026-08-08T00:00:00.000Z",
        definitionVersion:"weekly.v1",firstTouchRuleVersion:"first-authoritative-discovery.v1",
        domainCommandHash:`sha256:${"1".repeat(64)}`,requestHash:"cohort",requestedBy:"finance-a",now:"2026-08-09T00:00:00.000Z"});
      const context=db.workspaceContext("team-a");
      const cutoff=await db.foundation.temporalBarrier.sealReadCutoff(context,"2026-08-10T00:00:00.000Z");
      const source=discoverySource([{eventId:"quote-discovery",candidateId:"candidate-primary",ownerId:"sales-a",
        discoveredAt:"2026-08-01T01:00:00.000Z",recordedAt:"2026-08-01T01:00:01.000Z",actorKey:"quote-actor",planId:"plan-a"},
        {eventId:"quote-alias",candidateId:"candidate-1",ownerId:"sales-a",discoveredAt:"2026-08-02T01:00:00.000Z",
          recordedAt:"2026-08-02T01:00:01.000Z",actorKey:"quote-actor",planId:"plan-b"}]);
      const page=await source.listDiscoveries("team-a",{platform:"douyin",from:cohort.cohortFrom,to:cohort.cohortTo,cutoff,limit:100,after:null});
      assert.equal(page.items.length,2);
      for(const row of page.items) {
      await services.cohorts.upsertFirstTouch({cohort,event:{...row,planId:row.attribution.planId,runId:row.attribution.runId,shardId:row.attribution.shardId,evidenceId:null},
        resolution:canonicalSubjectStableKey("team-a",row.material),now:"2026-08-09T00:00:00.000Z"});
      }
      const latest=await db.foundation.temporalBarrier.sealReadCutoff(context,new Date(Date.now()+1000).toISOString());
      const result=await services.growthPerformance.getAt(context,{cohortId:cohort.id,currency:quotes.formalVersion.currency,planId:null,closureVersionId:null},latest);
      assert.deepEqual(result.expectedRoiByCurrency[0]?.quoteVersionIds,[quotes.formalVersion.id]);
      assert.equal(result.expectedRoiByCurrency[0]?.reason,"cost_missing");
      const otherCurrency=await services.growthPerformance.getAt(context,{cohortId:cohort.id,currency:quotes.formalVersion.currency==="CNY"?"USD":"CNY",planId:null,closureVersionId:null},latest);
      assert.deepEqual(otherCurrency.expectedRoiByCurrency[0]?.quoteVersionIds,[]);
      const budgets=new AcquisitionCostEstimateService({repository:new MysqlFinancialLedgerRepository(db.pool),foundation:db.foundation});
      const draft=await budgets.createDraft(db.command("team-a","roi-budget"),{
        cohortId:cohort.id,planId:null,runId:null,amountMinor:300,currency:quotes.formalVersion.currency,
        source:"approved_budget",sourceStableKey:"cohort-budget",inputSnapshotHash:`sha256:${"4".repeat(64)}`,
        validFrom:"2026-08-01T00:00:00.000Z",validTo:null});
      await budgets.activate(db.command("team-a","roi-budget-activate",1),{estimateId:draft.id,effectiveAt:"2026-08-01T00:00:00.000Z"});
      const withBudget=await services.growthPerformance.getAt(context,{cohortId:cohort.id,currency:quotes.formalVersion.currency,planId:null,closureVersionId:null},
        await db.foundation.temporalBarrier.sealReadCutoff(context,new Date(Date.now()+2000).toISOString()));
      assert.equal(withBudget.expectedRoiByCurrency[0]?.status,"computed");
      assert.deepEqual(withBudget.expectedRoiByCurrency[0]?.costEstimateIds,[draft.id]);
      assert.equal("attributedEstimatedCostMinor" in withBudget.expectedRoiByCurrency[0]! && withBudget.expectedRoiByCurrency[0].attributedEstimatedCostMinor,300);
      const budgetCutoff=await db.foundation.temporalBarrier.sealReadCutoff(context,new Date(Date.now()+2000).toISOString());
      for (const scope of [
        {cohortId:cohort.id,currency:quotes.formalVersion.currency,planId:"plan-a"},
        {cohortId:"unrelated-cohort",currency:quotes.formalVersion.currency,planId:null},
        {cohortId:cohort.id,currency:quotes.formalVersion.currency==="CNY"?"USD":"CNY",planId:null}
      ]) {
        const excluded=await services.growthPerformance.getAt(context,{...scope,closureVersionId:null},budgetCutoff);
        assert.deepEqual(excluded.expectedRoiByCurrency[0]?.costEstimateIds,[]);
        assert.equal(excluded.expectedRoiByCurrency[0]?.status,"not_computable");
      }
      assert.equal((await services.growthPerformance.getAt(context,{cohortId:cohort.id,currency:quotes.formalVersion.currency,planId:null,closureVersionId:null},latest)).expectedRoiByCurrency[0]?.reason,"cost_missing");
    } finally {await handle.close();await finance.close();}
  });
});

test("MySQL ROI module reads persisted closure evidence after recreation", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
}, async () => {
  await withGrowthFinanceMysqlTestDatabase(async database => {
    const fixture = await completeClosureFixture({costMinor:200,revenueMinor:1000,cogsMinor:200});
    const version = await fixture.close(fixture.service, {
      ...fixture.context("module-closure"), expectedRevision:1
    }, {cohortId:fixture.cohortId,currency:"CNY",asOf:"2026-08-09T00:00:00.000Z",attestationIds:fixture.attestationIds});
    const evidence = await fixture.service.getVersion(fixture.workspace, version.id);
    assert.ok(evidence);
    await database.closureRepository().appendClosureVersion({version,
      snapshots:evidence.snapshots,sliceMembers:evidence.sliceMembers,entries:evidence.entries,
      domainCommandHash:`sha256:${"a".repeat(64)}`,requestHash:`sha256:${"b".repeat(64)}`,requestedBy:version.closedBy});
    const series={id:"module-series",workspaceId:version.workspaceId,cohortId:version.cohortId,
      currency:"CNY",status:"open" as const,currentClosureVersionId:null,revision:1,updatedAt:version.closedAt};
    await database.closureRepository().createSeries(series);
    await database.closureRepository().markClosed(series,version.id);
    for (let restart=0;restart<2;restart++) {
      const registry = createGrowthPrivateServiceRegistry();
      registry.provide(GROWTH_FOUNDATION_SERVICES, database.foundation);
      const handle = await createGrowthRoiModule({mode:"mysql",pool:database.pool}).install({
        router:express.Router(),privateServices:registry,toolPorts:createGrowthCommercialToolPorts()});
      try {
        const reader=registry.require(GROWTH_ROI_SERVICES).closureEvidence;
        const context=database.workspaceContext("workspace-a");
        const cutoff=await database.foundation.temporalBarrier.sealReadCutoff(context,"2026-08-09T01:00:00.000Z");
        assert.equal((await reader.getAt(context,{closureVersionId:version.id,sliceKey:"all",cutoff}))?.closureVersionId,version.id);
        const other=database.workspaceContext("workspace-b");
        const otherCutoff=await database.foundation.temporalBarrier.sealReadCutoff(other,"2026-08-09T01:00:00.000Z");
        assert.equal(await reader.getAt(other,{closureVersionId:version.id,sliceKey:"all",cutoff:otherCutoff}),null);
        const query=registry.require(GROWTH_ROI_SERVICES).growthPerformance;
        const latest=await database.foundation.temporalBarrier.sealReadCutoff(context,new Date(Date.now()+1000).toISOString());
        const input={cohortId:version.cohortId,currency:"CNY",planId:null,closureVersionId:null};
        const result=await query.getAt(context,input,latest);
        assert.equal(result.actualRoiByCurrency[0]?.status,"computed");
        assert.equal("roiBps" in result.actualRoiByCurrency[0]! && result.actualRoiByCurrency[0].roiBps,30000);
        assert.equal((await query.getAt(context,{...input,closureVersionId:"missing"},latest)).actualRoiByCurrency[0]?.status,"not_computable");
        assert.equal((await query.getAt(context,{...input,currency:"USD"},latest)).actualRoiByCurrency[0]?.status,"not_computable");
        assert.equal((await query.getAt(context,input,cutoff)).actualRoiByCurrency[0]?.status,"not_computable");
        const redacted=await query.getAt({...context,capabilities:context.capabilities.filter(c=>c!=="pricing.sensitive.read")},input,latest);
        assert.equal("amountVisibility" in redacted.actualRoiByCurrency[0]! && redacted.actualRoiByCurrency[0].amountVisibility,"redacted");
        assert.ok(!JSON.stringify(redacted).includes("Minor"));
      } finally { await handle.close(); }
    }
  });
});

test("MySQL ROI module retains cohorts across module recreation and isolates workspaces", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
}, async () => {
  await withGrowthFinanceMysqlTestDatabase(async fixture => {
    const install = async () => {
      const registry = createGrowthPrivateServiceRegistry();
      registry.provide(GROWTH_FOUNDATION_SERVICES, fixture.foundation);
      const handle = await createGrowthRoiModule({ mode: "mysql", pool: fixture.pool }).install({
        router: express.Router(), privateServices: registry,
        toolPorts: createGrowthCommercialToolPorts()
      });
      return { handle, services: registry.require(GROWTH_ROI_DISCOVERY_SERVICES) };
    };
    const first = await install();
    await first.services.cohorts.createCohort({
      id: "cohort-persist", workspaceId: "workspace-a", platform: "douyin",
      cohortFrom: "2026-08-01T00:00:00.000Z", cohortTo: "2026-08-08T00:00:00.000Z",
      definitionVersion: "weekly.v1", firstTouchRuleVersion: "first-authoritative-discovery.v1",
      domainCommandHash: `sha256:${"a".repeat(64)}`, requestHash: `sha256:${"b".repeat(64)}`,
      requestedBy: "finance-a", now: "2026-08-09T00:00:00.000Z"
    });
    await first.handle.close();
    const second = await install();
    try {
      assert.equal((await second.services.cohorts.listCohorts("workspace-a")).length, 1);
      assert.equal((await second.services.cohorts.listCohorts("workspace-b")).length, 0);
    } finally { await second.handle.close(); }
  });
});

test("MySQL ROI HTTP creates an idempotent cohort and reads its detail", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
}, async () => {
  await withGrowthFinanceMysqlTestDatabase(async fixture => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.activeWorkspace = fixture.workspaceContext("workspace-a");
      if (req.header("X-Test-Read-Only")) req.activeWorkspace = {...req.activeWorkspace, capabilities: []};
      next(); });
    const registry = createGrowthPrivateServiceRegistry();
    registry.provide(GROWTH_FOUNDATION_SERVICES, fixture.foundation);
    const router = express.Router();
    const handle = await createGrowthRoiModule({mode: "mysql", pool: fixture.pool}).install({
      router, privateServices: registry, toolPorts: createGrowthCommercialToolPorts()
    });
    app.use(router);
    app.use((error: {status?:number;code?:string}, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error.code === "capability_forbidden" ? 403 : error.status ?? 500).json({code:error.code}); });
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const headers = {"Content-Type":"application/json", "X-Workspace-Id":"workspace-a", "Idempotency-Key":"cohort-http-create"};
      const body = JSON.stringify({platform:"douyin",cohortFrom:"2026-08-01T00:00:00.000Z",cohortTo:"2026-08-08T00:00:00.000Z",definitionVersion:"weekly.v1",firstTouchRuleVersion:"first-authoritative-discovery.v1"});
      const first = await fetch(`${base}/api/v1/acquisition/cohorts`, {method:"POST",headers,body});
      assert.equal(first.status, 201);
      const created = await first.json() as {id:string};
      const replay = await fetch(`${base}/api/v1/acquisition/cohorts`, {method:"POST",headers,body});
      assert.equal(replay.status, 201);
      assert.equal((await replay.json() as {id:string}).id, created.id);
      const read = await fetch(`${base}/api/v1/acquisition/cohorts/${created.id}`, {headers});
      assert.equal(read.status, 200);
      const ledger=fixture.costLedgerOnConnection("a");
      const cost=await ledger.createPending(fixture.command("workspace-a","allocation-cost"),fixture.newCostInput({amountMinor:200,evidenceHash:`sha256:${"c".repeat(64)}`}));
      await ledger.verify(fixture.command("workspace-a","allocation-cost-verify",1),{entryId:cost.entry.id,reason:"synthetic acceptance"});
      const allocationInput={sourceType:"cost_entry",sourceId:cost.entry.id,items:[{cohortId:created.id,candidateId:null,planId:null,runId:null,
        allocationBps:10000,allocationRule:"direct",ruleVersion:"acceptance.v1",targetStableKey:created.id,
        evidenceRefs:[{kind:"ledger_source",ledgerType:"cost",ledgerEntryId:cost.entry.id,evidenceHash:cost.entry.evidenceHash}]}]};
      const allocationUrl=`${base}/api/v1/acquisition/attribution-allocation-sets`;
      const allocationResponse=await fetch(allocationUrl,{method:"POST",headers:{...headers,"Idempotency-Key":"allocation-create"},body:JSON.stringify(allocationInput)});
      assert.equal(allocationResponse.status,201);
      const allocation=await allocationResponse.json() as {id:string};
      const activate=await fetch(`${allocationUrl}/${allocation.id}/activate`,{method:"POST",headers:{...headers,"Idempotency-Key":"allocation-activate","If-Match":`"attribution-set:${allocation.id}:1"`},body:"{}"});
      assert.equal(activate.status,200);
      assert.equal((await fixture.repository.get("workspace-a",allocation.id))?.items[0]?.effectiveAmountMinor,200);
      const activationReplay=await fetch(`${allocationUrl}/${allocation.id}/activate`,{method:"POST",headers:{...headers,"Idempotency-Key":"allocation-activate","If-Match":`"attribution-set:${allocation.id}:1"`},body:"{}"});
      assert.equal(activationReplay.status,200);
      assert.equal(await fixture.repository.activationCount(allocation.id),1);
      const [activationRows]=await fixture.pool.query("SELECT activation_domain_command_hash, activation_request_hash, actor_id FROM attribution_allocation_lifecycle_events WHERE allocation_set_id = ? AND event_type = 'activated'",[allocation.id]);
      const activationRecord=(activationRows as Array<{activation_domain_command_hash:`sha256:${string}`;activation_request_hash:string;actor_id:string}>)[0]!;
      assert.match(activationRecord.activation_domain_command_hash,/^sha256:[a-f0-9]{64}$/);
      assert.equal(activationRecord.actor_id,fixture.workspaceContext("workspace-a").actorId);
      assert.equal((await fixture.repository.findActivationByDomainCommandHash("workspace-a",activationRecord.activation_domain_command_hash))?.id,allocation.id);
      const directReplay=await fixture.repository.activate({workspaceId:"workspace-a",allocationSetId:allocation.id,expectedRevision:1,
        amounts:[{targetStableKey:created.id,amountMinor:200}],activatedBy:activationRecord.actor_id,activatedAt:new Date().toISOString(),temporalSequence:1,
        domainCommandHash:activationRecord.activation_domain_command_hash,requestHash:activationRecord.activation_request_hash});
      assert.equal(directReplay.items[0]?.effectiveAmountMinor,200);
      assert.equal(await fixture.repository.activationCount(allocation.id),1);
      const stale=await fetch(`${allocationUrl}/${allocation.id}/activate`,{method:"POST",headers:{...headers,"Idempotency-Key":"allocation-stale","If-Match":`"attribution-set:${allocation.id}:1"`},body:"{}"});
      assert.equal(stale.status,412);
      assert.equal(await fixture.repository.activationCount(allocation.id),1);
      await fixture.seedWonAuthority({quotedAmountMinor:1000,currency:"CNY",commercialAmountHash:`sha256:${"7".repeat(64)}`});
      const facts=fixture.factServiceOnConnection("a");
      const factIds:string[]=[];
      for(const factType of ["revenue_recognized","payment_received"] as const) {
        const result=await facts.createPending(fixture.command("workspace-a",`settlement-${factType}`),{
          candidateId:"candidate-1",customerId:"customer-1",dealId:"deal-1",factType,amountMinor:1000,currency:"CNY",
          businessOccurredAt:"2026-08-08T00:00:00.000Z",provenance:"manual_verified",sourceRef:null,
          evidenceHash:`sha256:${"a".repeat(64)}`,externalId:null,sourceIdentityRoot:`external:settlement:${factType}`});
        factIds.push(result.fact.id);
      }
      await fixture.verifyFacts(factIds,{expectedRevision:1});
      const settlementUrl=`${base}/api/v1/finance/settlement-allocation-sets`;
      const settlementInput={sourceFactId:factIds[1],items:[{targetRevenueFactId:factIds[0],dealId:"deal-1",quoteVersionId:"quote-1",
        amountMinor:1000,currency:"CNY",originalPaymentFactId:null,originalPaymentAllocationSetId:null,originalPaymentAllocationItemId:null}]};
      const settlementResponse=await fetch(settlementUrl,{method:"POST",headers:{...headers,"Idempotency-Key":"settlement-create"},body:JSON.stringify(settlementInput)});
      assert.equal(settlementResponse.status,201);
      const settlement=await settlementResponse.json() as {id:string;items:Array<{id:string;allocationSetId:string}>};
      assert.ok(settlement.items[0]?.id);
      assert.equal(settlement.items[0]?.allocationSetId,settlement.id);
      const settled=await fetch(`${settlementUrl}/${settlement.id}/activate`,{method:"POST",headers:{...headers,"Idempotency-Key":"settlement-activate","If-Match":`"settlement-set:${settlement.id}:1"`},body:"{}"});
      assert.equal(settled.status,200);
      assert.equal((await fixture.settlementRepository.get("workspace-a",settlement.id))?.status,"active");
      const refund=await facts.createPending(fixture.command("workspace-a","settlement-refund"),{
        candidateId:"candidate-1",customerId:"customer-1",dealId:"deal-1",factType:"refund",amountMinor:100,currency:"CNY",
        businessOccurredAt:"2026-08-08T00:00:00.000Z",provenance:"manual_verified",sourceRef:null,
        evidenceHash:`sha256:${"b".repeat(64)}`,externalId:null,sourceIdentityRoot:"external:settlement:refund"});
      await fixture.verifyFacts([refund.fact.id],{expectedRevision:1});
      const refundInput={sourceFactId:refund.fact.id,items:[{...settlementInput.items[0],amountMinor:100,
        originalPaymentFactId:factIds[1],originalPaymentAllocationSetId:settlement.id,originalPaymentAllocationItemId:settlement.items[0]!.id}]};
      const refundResponse=await fetch(settlementUrl,{method:"POST",headers:{...headers,"Idempotency-Key":"refund-create"},body:JSON.stringify(refundInput)});
      assert.equal(refundResponse.status,201);
      const refundSet=await refundResponse.json() as {id:string};
      const refunded=await fetch(`${settlementUrl}/${refundSet.id}/activate`,{method:"POST",headers:{...headers,"Idempotency-Key":"refund-activate","If-Match":`"settlement-set:${refundSet.id}:1"`},body:"{}"});
      assert.equal(refunded.status,200);
      const replayRefund=await fetch(`${settlementUrl}/${refundSet.id}/activate`,{method:"POST",headers:{...headers,"Idempotency-Key":"refund-activate","If-Match":`"settlement-set:${refundSet.id}:1"`},body:"{}"});
      assert.equal(replayRefund.status,200);
      assert.equal(await fixture.settlementRepository.activationCount(refundSet.id),1);
      for(const [key,body] of [
        ["wrong-currency",{...settlementInput,items:[{...settlementInput.items[0],currency:"USD"}]}],
        ["too-much",{...settlementInput,items:[{...settlementInput.items[0],amountMinor:1001}]}],
        ["wrong-payment",{...refundInput,items:[{...refundInput.items[0],originalPaymentAllocationItemId:"missing"}]}]
      ] as const) {
        const rejected=await fetch(settlementUrl,{method:"POST",headers:{...headers,"Idempotency-Key":key},body:JSON.stringify(body)});
        assert.equal(rejected.status,422,key);
      }
      const extraRefund=await facts.createPending(fixture.command("workspace-a","extra-refund"),{
        candidateId:"candidate-1",customerId:"customer-1",dealId:"deal-1",factType:"refund",amountMinor:950,currency:"CNY",
        businessOccurredAt:"2026-08-08T00:00:00.000Z",provenance:"manual_verified",sourceRef:null,
        evidenceHash:`sha256:${"c".repeat(64)}`,externalId:null,sourceIdentityRoot:"external:settlement:extra-refund"});
      const extraInput={...refundInput,sourceFactId:extraRefund.fact.id,items:[{...refundInput.items[0],amountMinor:950}]};
      assert.equal((await fetch(settlementUrl,{method:"POST",headers:{...headers,"Idempotency-Key":"unverified-refund"},body:JSON.stringify(extraInput)})).status,422);
      await fixture.verifyFacts([extraRefund.fact.id],{expectedRevision:1});
      const extraResponse=await fetch(settlementUrl,{method:"POST",headers:{...headers,"Idempotency-Key":"extra-refund-create"},body:JSON.stringify(extraInput)});
      assert.equal(extraResponse.status,201);
      const extraSet=await extraResponse.json() as {id:string};
      const overRefund=await fetch(`${settlementUrl}/${extraSet.id}/activate`,{method:"POST",headers:{...headers,"Idempotency-Key":"extra-refund-activate","If-Match":`"settlement-set:${extraSet.id}:1"`},body:"{}"});
      assert.equal(overRefund.status,422);
      assert.equal((await overRefund.json() as {code:string}).code,"refund_overallocated");
      assert.equal((await fixture.settlementRepository.get("workspace-a",extraSet.id))?.status,"draft");
      assert.equal(await fixture.settlementRepository.activationCount(extraSet.id),0);
      const proof={currency:"CNY",aspect:"revenue",periodFrom:"2026-08-01T00:00:00.000Z",periodTo:"2026-08-08T00:00:00.000Z",
        asOf:"2026-08-09T00:00:00.000Z",declaredTotalMinor:1000,sourceSystem:"local-acceptance",sourceCursor:null,
        sourceReportId:null,reportAllocationSetId:null,reportHash:`sha256:${"b".repeat(64)}`,
        evidenceRefs:[{kind:"ledger_entry",ledgerType:"financial",ledgerEntryId:"missing",evidenceHash:"missing"}]};
      const signed=await fetch(`${base}/api/v1/acquisition/cohorts/${created.id}/attestations`,{
        method:"POST",headers:{...headers,"Idempotency-Key":"proof-http"},body:JSON.stringify(proof)});
      assert.equal(signed.status,201);
      const attestationId=(await signed.json() as {id:string}).id;
      const closeBody=JSON.stringify({currency:"CNY",asOf:new Date().toISOString(),attestationIds:[attestationId]});
      const closeUrl=`${base}/api/v1/acquisition/cohorts/${created.id}/close`;
      assert.equal((await fetch(closeUrl,{method:"POST",headers:{...headers,"Idempotency-Key":"close-no-revision"},body:closeBody})).status,428);
      assert.equal((await fetch(closeUrl,{method:"POST",headers:{...headers,"Idempotency-Key":"close-incomplete","If-Match":`"roi-series:${created.id}:CNY:1"`},body:closeBody})).status,422);
      assert.equal((await read.json() as {id:string}).id, created.id);
      const missingKey = await fetch(`${base}/api/v1/acquisition/cohorts`, {method:"POST",headers:{"Content-Type":"application/json","X-Workspace-Id":"workspace-a"},body});
      assert.equal(missingKey.status, 400);
      const malformed = await fetch(`${base}/api/v1/acquisition/cohorts`, {method:"POST",headers,body:JSON.stringify({unexpected:true})});
      assert.equal(malformed.status, 400);
      const forbidden = await fetch(`${base}/api/v1/acquisition/cohorts`, {method:"POST",headers:{...headers,"X-Test-Read-Only":"1"},body});
      assert.equal(forbidden.status, 403);
      // Synthetic discovery/quote authority fixtures; allocations, reports,
      // attestations and closure below use the real HTTP/MySQL implementation.
      const cohorts=registry.require(GROWTH_ROI_DISCOVERY_SERVICES).cohorts;
      const cohort=(await cohorts.getCohort("workspace-a",created.id))!;
      const discoveryCutoff=await fixture.foundation.temporalBarrier.sealReadCutoff(fixture.workspaceContext("team-a"),new Date().toISOString());
      const discoveries=discoverySource([{eventId:"closure-member",candidateId:"candidate-1",ownerId:"sales-a",actorKey:"closure-actor",
        planId:"plan-1",discoveredAt:"2026-08-01T01:00:00.000Z",recordedAt:"2026-08-01T01:00:01.000Z"}]);
      const discovered=(await discoveries.listDiscoveries("team-a",{platform:"douyin",from:cohort.cohortFrom,to:cohort.cohortTo,cutoff:discoveryCutoff,limit:10,after:null})).items[0]!;
      await cohorts.upsertFirstTouch({cohort,event:{...discovered,workspaceId:"workspace-a",planId:discovered.attribution.planId,runId:discovered.attribution.runId,shardId:discovered.attribution.shardId,evidenceId:null},
        resolution:canonicalSubjectStableKey("workspace-a",discovered.material),now:new Date().toISOString()});
      const ledgerRefs:ClosureAttestation["evidenceRefs"]=[{kind:"ledger_entry",ledgerType:"cost",ledgerEntryId:cost.entry.id,evidenceHash:cost.entry.evidenceHash},
        {kind:"allocation_set",allocationKind:"attribution",allocationSetId:allocation.id,version:1},
        {kind:"allocation_set",allocationKind:"settlement",allocationSetId:settlement.id,version:1},
        {kind:"allocation_set",allocationKind:"settlement",allocationSetId:refundSet.id,version:1}];
      const closureFactIds=[...factIds,refund.fact.id];
      for(const [factType,amountMinor] of [["contract_won",1000],["cogs_recognized",200]] as const) {
        const result=await facts.createPending(fixture.command("workspace-a",`closure-${factType}`),{
          candidateId:"candidate-1",customerId:"customer-1",dealId:"deal-1",factType,amountMinor,currency:"CNY",
          businessOccurredAt:"2026-08-08T00:00:00.000Z",provenance:"manual_verified",sourceRef:null,
          evidenceHash:`sha256:${"d".repeat(64)}`,externalId:null,sourceIdentityRoot:`external:closure:${factType}`});
        await fixture.verifyFacts([result.fact.id],{expectedRevision:1});closureFactIds.push(result.fact.id);
      }
      const ledgerRepository=new MysqlFinancialLedgerRepository(fixture.pool);
      for(const factId of closureFactIds) {
        const fact=(await ledgerRepository.getFinancialFact("workspace-a",factId))!;
        const response=await fetch(allocationUrl,{method:"POST",headers:{...headers,"Idempotency-Key":`closure-allocation-${factId}`},body:JSON.stringify({
          ...allocationInput,sourceType:"financial_fact",sourceId:factId,items:[{...allocationInput.items[0],evidenceRefs:[{kind:"ledger_source",ledgerType:"financial",ledgerEntryId:factId,evidenceHash:fact.evidenceHash}]}]})});
        assert.equal(response.status,201);
        const set=await response.json() as {id:string};
        assert.equal((await fetch(`${allocationUrl}/${set.id}/activate`,{method:"POST",headers:{...headers,"Idempotency-Key":`closure-activate-${factId}`,"If-Match":`"attribution-set:${set.id}:1"`},body:"{}"})).status,200);
        ledgerRefs.push({kind:"ledger_entry",ledgerType:"financial",ledgerEntryId:factId,evidenceHash:fact.evidenceHash},
          {kind:"allocation_set",allocationKind:"attribution",allocationSetId:set.id,version:1});
      }
      const proofIds:string[]=[];
      const proofAsOf=new Date().toISOString();
      const totals={acquisition_cost:200,revenue:1000,cogs:200,cash:1000,refund_bad_debt:100,attribution:1000};
      for(const [index,[aspect,total]] of Object.entries(totals).entries()) {
        const reportInput={currency:"CNY",sourceSystem:"synthetic-acceptance",sourceCursor:null,reportHash:`sha256:${String(index+1).repeat(64)}`,
          declaredTotalMinor:total,periodFrom:"2026-08-01T00:00:00.000Z",periodTo:"2026-08-10T00:00:00.000Z"};
        const reportResponse=await fetch(`${base}/api/v1/finance/source-reports`,{method:"POST",headers:{...headers,"Idempotency-Key":`closure-report-${aspect}`},body:JSON.stringify(reportInput)});
        assert.equal(reportResponse.status,201);
        const report=await reportResponse.json() as {id:string};
        const signedResponse=await fetch(`${base}/api/v1/acquisition/cohorts/${created.id}/attestations`,{method:"POST",headers:{...headers,"Idempotency-Key":`closure-proof-${aspect}`},
          body:JSON.stringify({...reportInput,aspect,asOf:proofAsOf,sourceReportId:report.id,reportAllocationSetId:null,evidenceRefs:[...ledgerRefs,{kind:"source_report",sourceReportId:report.id,reportHash:reportInput.reportHash}]})});
        assert.equal(signedResponse.status,201);proofIds.push((await signedResponse.json() as {id:string}).id);
      }
      const successfulCloseBody=JSON.stringify({currency:"CNY",asOf:new Date().toISOString(),attestationIds:proofIds});
      const closingHeaders={...headers,"Idempotency-Key":"close-complete","If-Match":`"roi-series:${created.id}:CNY:1"`};
      const closedResponse=await fetch(closeUrl,{method:"POST",headers:closingHeaders,body:successfulCloseBody});
      const closed=await closedResponse.json() as {id:string;code?:string};
      assert.equal(closedResponse.status,201,JSON.stringify(closed));
      const replayClosed=await fetch(closeUrl,{method:"POST",headers:closingHeaders,body:successfulCloseBody});
      assert.equal(replayClosed.status,201);
      assert.equal((await replayClosed.json() as {id:string}).id,closed.id);
      const snapshot=(await fixture.closureRepository().listSnapshots("workspace-a",closed.id))[0]!;
      assert.equal(snapshot.computedMetrics.status,"computed");
      assert.equal("roiBps" in snapshot.computedMetrics && snapshot.computedMetrics.roiBps,25000);
      assert.equal(snapshot.commercialRatios.netCashMinor,900);
      const restartedRegistry=createGrowthPrivateServiceRegistry();
      restartedRegistry.provide(GROWTH_FOUNDATION_SERVICES,fixture.foundation);
      const restarted=await createGrowthRoiModule({mode:"mysql",pool:fixture.pool}).install({
        router:express.Router(),privateServices:restartedRegistry,toolPorts:createGrowthCommercialToolPorts()});
      try {
        const context=fixture.workspaceContext("workspace-a");
        const cutoff=await fixture.foundation.temporalBarrier.sealReadCutoff(context,new Date().toISOString());
        const restored=await restartedRegistry.require(GROWTH_ROI_SERVICES).growthPerformance.getAt(context,{
          cohortId:created.id,currency:"CNY",planId:null,closureVersionId:closed.id},cutoff);
        const metric=restored.actualRoiByCurrency[0]!;
        assert.equal(metric.status,"computed");
        assert.equal("roiBps" in metric && metric.roiBps,25000);
        assert.equal((await fixture.closureRepository().listSnapshots("workspace-a",closed.id)).length,1);
      } finally {await restarted.close();}
    } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); await handle.close(); }
  });
});

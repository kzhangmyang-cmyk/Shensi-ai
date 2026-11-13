import assert from "node:assert/strict";
import test from "node:test";
import { withGrowthFinanceMysqlTestDatabase } from "./growth-finance-mysql-test-support.js";
import {
  ROI_CLOSURE_MYSQL_SCHEMA_STATEMENTS
} from "./acquisition-roi-closure-mysql-repository.js";
import { completeClosureFixture } from "./growth-roi-test-fixtures.js";

test("MySQL closure round-trips ISO dates and isolates frozen evidence by workspace", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (database) => {
    const fixture = await completeClosureFixture({
      costMinor: 200, revenueMinor: 1000, cogsMinor: 200, paymentMinor: 1000
    });
    const version = await fixture.close(fixture.service, {
      ...fixture.context("mysql-close"), expectedRevision: 1
    }, { cohortId: fixture.cohortId, currency: "CNY",
      asOf: "2026-08-09T00:00:00.000Z", attestationIds: fixture.attestationIds });
    const evidence = await fixture.service.getVersion(fixture.workspace, version.id);
    assert.ok(evidence);
    const repository = database.closureRepository();
    await repository.appendClosureVersion({
      version, snapshots: evidence.snapshots, sliceMembers: evidence.sliceMembers,
      entries: evidence.entries, domainCommandHash: `sha256:${"a".repeat(64)}`,
      requestHash: `sha256:${"b".repeat(64)}`, requestedBy: version.closedBy
    });
    const reopenedRepository = database.closureRepository();
    assert.deepEqual(await reopenedRepository.getVersion(version.workspaceId, version.id), version);
    assert.deepEqual(await reopenedRepository.listSnapshots(version.workspaceId, version.id), evidence.snapshots);
    assert.ok((await reopenedRepository.listSliceMembers(version.workspaceId, version.id)).length > 0);
    assert.ok((await reopenedRepository.listEntries(version.workspaceId, version.id)).length > 0);
    assert.equal(await reopenedRepository.getVersion("other-workspace", version.id), null);
    assert.deepEqual(await reopenedRepository.listSnapshots("other-workspace", version.id), []);
    assert.deepEqual(await reopenedRepository.listSliceMembers("other-workspace", version.id), []);
    assert.deepEqual(await reopenedRepository.listEntries("other-workspace", version.id), []);
    assert.equal((await reopenedRepository.findClosureVersionByDomainHash(
      version.workspaceId, `sha256:${"a".repeat(64)}`))?.id, version.id);
    assert.equal(await reopenedRepository.findClosureVersionByDomainHash(
      "other-workspace", `sha256:${"a".repeat(64)}`), null);
    await assert.rejects(repository.appendClosureVersion({
      version: { ...version, id: "duplicate-command", version: 2 },
      snapshots: [], sliceMembers: [], entries: [],
      domainCommandHash: `sha256:${"a".repeat(64)}`,
      requestHash: `sha256:${"b".repeat(64)}`, requestedBy: version.closedBy
    }), { code: "ER_DUP_ENTRY" });
    assert.equal(await repository.getVersion(version.workspaceId, "duplicate-command"), null);
    const failedEntry = { closureVersionId: "rolled-back", sourceType: "cost" as const,
      sourceId: "duplicated", effectiveAmountMinor: 200, sourceHash: `sha256:${"c".repeat(64)}` };
    await assert.rejects(repository.appendClosureVersion({
      version: { ...version, id: "rolled-back", version: 2 },
      snapshots: [], sliceMembers: [], entries: [failedEntry, failedEntry],
      domainCommandHash: `sha256:${"d".repeat(64)}`,
      requestHash: `sha256:${"b".repeat(64)}`, requestedBy: version.closedBy
    }), { code: "ER_DUP_ENTRY" });
    assert.equal(await repository.getVersion(version.workspaceId, "rolled-back"), null);
    assert.equal(await repository.findClosureVersionByDomainHash(
      version.workspaceId, `sha256:${"d".repeat(64)}`), null);
    const series = {
      id: "lifecycle-series", workspaceId: version.workspaceId, cohortId: version.cohortId,
      currency: "CNY", status: "open" as const, currentClosureVersionId: null,
      revision: 1, updatedAt: version.closedAt
    };
    await repository.createSeries(series);
    const closed = await repository.markClosed(series, version.id);
    assert.equal(closed.revision, 2);
    await assert.rejects(repository.markClosed(series, version.id), /revision_mismatch/);
    await assert.rejects(repository.appendReopenEvent(
      closed, version.id, `sha256:${"9".repeat(64)}`, "a".repeat(192)
    ), {code:"ER_DATA_TOO_LONG"});
    assert.equal((await repository.getSeries(version.workspaceId, version.cohortId, "CNY"))?.revision, 2);
    assert.equal(await repository.countReopenEvents(version.id), 0);
    const reopened = await repository.appendReopenEvent(
      closed, version.id, `sha256:${"e".repeat(64)}`, "finance-reviewer"
    );
    assert.equal(reopened.revision, 3);
    assert.equal(await repository.countReopenEvents(version.id), 1);
    assert.equal((await repository.findReopenByDomainHash(
      version.workspaceId, `sha256:${"e".repeat(64)}`))?.id, series.id);
    assert.equal(await repository.findReopenByDomainHash(
      "other-workspace", `sha256:${"e".repeat(64)}`), null);
    assert.equal((await repository.getVersion(version.workspaceId, version.id))?.status, "superseded");
    assert.equal((await repository.findClosureVersionByDomainHash(
      version.workspaceId, `sha256:${"a".repeat(64)}`))?.status, "superseded");
    await assert.rejects(repository.appendReopenEvent(
      closed, version.id, `sha256:${"f".repeat(64)}`, "finance-reviewer"
    ), /revision_mismatch/);
    assert.equal(await repository.countReopenEvents(version.id), 1);
    assert.deepEqual(await repository.listSnapshots(version.workspaceId, version.id), evidence.snapshots);
    const [attestation] = await fixture.repository.listAttestations(
      version.workspaceId, version.cohortId, "CNY"
    );
    assert.ok(attestation);
    await repository.appendAttestation(attestation, `sha256:${"1".repeat(64)}`);
    assert.deepEqual(await database.closureRepository().findAttestationByDomainHash(
      version.workspaceId, `sha256:${"1".repeat(64)}`), attestation);
    await repository.appendClosureVersion({
      version:{...version,id:"closure-atomic",version:2,previousClosureVersionId:version.id},
      snapshots:[],sliceMembers:[],entries:[],series:reopened,
      domainCommandHash:`sha256:${"2".repeat(64)}`,requestHash:"atomic-request",requestedBy:version.closedBy
    });
    assert.equal((await repository.getSeries(version.workspaceId,version.cohortId,"CNY"))?.currentClosureVersionId,"closure-atomic");
    await assert.rejects(repository.appendClosureVersion({
      version:{...version,id:"closure-stale",version:3,previousClosureVersionId:version.id},
      snapshots:[],sliceMembers:[],entries:[],series:reopened,
      domainCommandHash:`sha256:${"3".repeat(64)}`,requestHash:"stale-request",requestedBy:version.closedBy
    }),/revision_mismatch/);
    assert.equal(await repository.getVersion(version.workspaceId,"closure-stale"),null);
    assert.equal(await repository.findClosureVersionByDomainHash(version.workspaceId,`sha256:${"3".repeat(64)}`),null);
  });
});

test("MySQL closure schema is idempotent DDL with uniqueness guards", () => {
  const ddl = ROI_CLOSURE_MYSQL_SCHEMA_STATEMENTS.join("\n");
  assert.match(ddl, /uk_roi_closure_operation_command/u);
  assert.match(ddl, /uk_roi_closure_operation_input/u);
  assert.match(ddl, /uk_roi_series/u);
  assert.match(ddl, /uk_roi_series_revision/u);
  assert.match(ddl, /uk_roi_closure_version/u);
  assert.match(ddl, /uk_closure_attestation_command/u);
  assert.match(ddl, /roi_snapshot_slice_members/u);
});

test("MySQL closure repository persists series and versions", async () => {
  await withGrowthFinanceMysqlTestDatabase(async (fixture) => {
    const repository = fixture.closureRepository();
    const series = Object.freeze({
      id: "series-cny",
      workspaceId: "workspace-a",
      cohortId: "cohort-a",
      currency: "CNY",
      status: "open",
      currentClosureVersionId: null,
      revision: 1,
      updatedAt: "2026-08-09T00:00:00.000Z"
    });
    await repository.createSeries(series);
    const read = await repository.getSeries(
      "workspace-a", "cohort-a", "CNY"
    );
    assert.equal(read?.id, "series-cny");
    assert.equal(read?.status, "open");
  });
});

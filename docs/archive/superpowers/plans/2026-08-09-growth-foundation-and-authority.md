# Growth Foundation and Commercial Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the workspace/capability context, command idempotency, legacy-commercial-write guard, and append-only catalog persistence foundation that every catalog, quote, ledger, ROI, and advisor operation must use.

**Architecture:** A versioned closed capability registry resolves each authenticated request to one concrete `ActiveWorkspaceContext`. This plan supplies that context to the C0-owned bootstrap/application/runtime bridge rather than creating another contract or runtime. HTTP idempotency stores only request identity and resource/operation references, while commercial authority guards prevent acquisition-linked Deals, PI documents, and Outcomes from bypassing the new quote chain. Catalog and migration tables are created as dedicated append-oriented repositories and never enter `CrmStore.persistAll/replaceRows`.

**Tech Stack:** TypeScript 5.7, Node.js 22 test runner, Express 4, Zod 3.23, TypeBox 1.1, MySQL 8 through mysql2 3.22, OpenAPI 3.1, JSON Schema Draft 2020-12, SHA-256, npm workspaces.

## Global Constraints

- `workspaceId` is the only tenant isolation key for every new domain object; `ownerId` remains a creator or assignee identity and is never reused as a tenant key.
- `super_admin` with `teamId="all"` cannot write until the server authorizes one concrete ActiveWorkspaceContext; the literal value `all` is never persisted as a workspace ID.
- Personal workspaces use the stable ID `personal:<userId>`.
- Capability keys come from a versioned, closed registry; unknown keys are rejected and `acquisition.outcome.reconcile.internal` is never granted to a human or AI identity.
- Users without `pricing.sensitive.read` never receive standard cost, absolute floor, or detailed margin fields.
- Every command requires `Idempotency-Key`; mutable-resource commands also require `If-Match` with an exact positive revision.
- HTTP idempotency is scoped by workspace, actor, method, canonical path, and key; same-key/different-payload requests return `409 idempotency_conflict`.
- A replay is re-authorized and re-projected with the caller's current capabilities; no sensitive response body is stored in the idempotency record.
- Business stable keys remain separate from HTTP idempotency keys.
- New quote, catalog, outbox, and migration records use dedicated repositories and tables; they are not added to the legacy `CrmStore` arrays or `persistAll/replaceRows` flow.
- New acquisition-linked commercial writes cannot use legacy Deal, DealEvent, CommissionProduct-price, or PI mutation routes.
- Historical Deal quote events and PI documents remain readable as `legacy_unverified`; they are not converted into fabricated QuoteVersions.
- Public acquisition Outcome writes cannot create `quoted`, `won`, or `lost`; only the internal Outcome Reconciler identity can create those events from a verified authoritative DealEvent.
- GoodJob-1.09 OpenAPI and JSON Schema files are the sole contract authority. Every published contract has an immutable semantic version and SHA-256 hash.
- The standalone frontend repository is `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend`; no new growth page is copied into GoodJob-1.09's legacy `frontend`.
- Real mode never falls back to frontend demo amounts, AI-invented financial facts, or model-calculated authoritative prices.
- All writes are audited; new capabilities, hashes, revisions, and authority markers are returned as closed fields rather than arbitrary JSON.
- Cross-plan execution order is exact: Contract Tasks 1-2 → Foundation Task 0.1 → Contract Task 3 → Foundation Tasks 0.2-0.4 → Catalog/Quote. Contract Task 3 exclusively owns `growth-commercial-application.ts`, `growth-commercial-runtime-bridge.ts`, bootstrap, and runtime/static parity; later foundation tasks only extend its established composition point.

---

### Task 0.1: Closed capability registry and concrete workspace resolution

**Depends:** `2026-08-09-growth-contract-and-frontend.md` Tasks 1-2 only. This task must finish before Contract Task 3.

**Files:**
- Create: `backend/src/growth-capabilities.ts`
- Create: `backend/src/growth-capabilities-test.ts`
- Create: `backend/src/growth-workspace-context.ts`
- Create: `backend/src/growth-workspace-context-test.ts`
- Create: `backend/src/growth-workspace-settings.ts`
- Create: `backend/src/growth-workspace-settings-test.ts`
- Create: `backend/src/growth-workspace-settings-mysql-repository.ts`
- Create: `backend/src/growth-workspace-settings-mysql-repository-test.ts`
- Create: `backend/src/growth-as-of.ts`
- Create: `backend/src/growth-as-of-test.ts`
- Create: `backend/src/growth-temporal-barrier.ts`
- Create: `backend/src/growth-temporal-barrier-test.ts`
- Create: `backend/src/growth-temporal-barrier-mysql-repository.ts`
- Create: `backend/src/growth-temporal-barrier-mysql-repository-test.ts`
- Create: `backend/src/growth-foundation-mysql-test-support.ts`
- Create: `backend/src/growth-foundation-mysql-integration-test.ts`
- Create: `backend/src/growth-command-context.ts`
- Modify: `backend/src/auth.ts`
- Modify: `backend/src/types.ts`

**Interfaces:**
- Produces: `GrowthCapability`, the literal union derived from `GROWTH_CAPABILITIES`.
- Produces: `GROWTH_CAPABILITY_REGISTRY_VERSION = "growth-capabilities.v1"`.
- Produces: `capabilitiesForHumanRole(role: Role): readonly GrowthCapability[]`; it never returns `acquisition.outcome.reconcile.internal`.
- Produces: `requireGrowthCapabilities(context: ActiveWorkspaceContext, required: readonly GrowthCapability[]): void`; it throws `GrowthAuthorizationError` with `code="capability_forbidden"` when any required capability is absent.
- Produces: `ActiveWorkspaceContext { workspaceId: string; kind: "team" | "personal"; actorId: string; role: Role; teamId: string; capabilities: readonly GrowthCapability[]; capabilityRegistryVersion: string }`.
- Produces: `GrowthWorkspaceDirectory { canAccess(user: SessionUser, workspaceId: string): Promise<boolean> }`.
- Produces: trusted internal `GrowthAcquisitionWorkspaceDirectory.resolve(scope: { ownerId: string; teamId: string }): Promise<{ workspaceId: string; kind: "team" | "personal"; bindingRevision: string } | null>`, branded immutable `ResolvedAcquisitionWorkspace { workspaceId; kind; bindingRevision; ownerId; teamId }`, and the single `GrowthAcquisitionWorkspaceResolver` that wraps the raw directory result as that branded value. It accepts only persisted Acquisition scope fields, rejects blank values and `teamId="all"` before directory access, requires a concrete non-`all` result, freezes the exact input owner/team beside its binding revision, and never derives a workspace by string convention alone. A personal workspace is valid only when the trusted directory explicitly binds that exact owner/team scope to it. Internal Run/ingestion/projection code consumes this narrow value; it never fabricates an `ActiveWorkspaceContext`, role, or capabilities for background work.
- Produces: trusted `GrowthWorkspaceSettingsReader.get(context)` and token-only `.getAt(context, cutoff: GrowthSealedReadCutoff)` returning `{ timeZone; revision; recordedAt; eventSequence }`; settings are append-only per concrete workspace, ordered by `(recordedAt,eventSequence)`, and `getAt` chooses the last server-owned event with `recordedAt<=cutoff.effectiveAsOf` after verifying the opaque token belongs to the exact context workspace. `timeZone` is a validated IANA zone sourced from server-owned workspace configuration (default `Asia/Shanghai`), never from a command/query body. The current `.get` is for nonhistorical configuration; public historical boundaries seal once before calling `.getAt`.
- Produces: memory/MySQL behavior parity, `GROWTH_WORKSPACE_SETTINGS_MYSQL_SCHEMA_STATEMENTS`, `ensureGrowthWorkspaceSettingsMysqlSchema(pool)`, and an internal deployment-only `appendTrustedSettingsEvent` port; it locks the last workspace event and uses the shared strict recorded-time allocator below so clock rollback cannot backdate a later setting. There is no public/Pi mutation route.
- Produces: one shared `assertGrowthAsOfNotFuture(asOf, startedAt, toleranceMs = 1_000): string` boundary. It accepts only strict RFC 3339 instants, throws `GrowthHttpError(422,"invalid_as_of")` when `asOf` is more than one second after the server-frozen request/command start, and returns the immutable effective cutoff `min(normalizedAsOf, normalizedStartedAt)`. The tolerance absorbs client clock skew only; no accepted future instant is passed to readers or persisted into an operation. Advisor Today, Growth Performance, and Closure import this helper instead of implementing local clock comparisons.
- Produces: `nextGrowthRecordedAt(serverNow,lastRecordedAt,storageTickMs = 1): string`, using the exact persisted DATETIME(3)/ISO millisecond precision and returning `max(serverNow,lastRecordedAt + one storage tick)`. It is the pure timestamp allocator used inside the workspace-global temporal barrier. Business repositories do not call it against only a local stream tail: they obtain their authoritative `{recordedAt,temporalSequence}` from `GrowthTemporalBarrier.allocateAppend` while the global row lock is held, then use local event sequence/revision only for integrity. Non-decreasing `max(now,last)` plus a sequence tie-break is forbidden because it rewrites a previously queried cutoff.
- Produces: the one workspace-global `GrowthTemporalTransactionRunner` and `GrowthTemporalBarrier`. Foundation exposes the exact runner singleton to later repositories and injects it into the barrier. In memory mode, the workspace-settings repository also receives that exact `temporalTransactions` object. In MySQL mode, workspace settings receives the pool plus the singleton barrier and shares the runner through that barrier; it does not receive the runner as a separate constructor argument. Every Growth append and read seal therefore shares one workspace-global temporal sequence. `MysqlGrowthTemporalTransactionRunner` is exported and injected into `MysqlGrowthTemporalBarrier` instead of the barrier constructing a second runner. `allocateAppend(tx, workspaceId)` must be the first lock in every Growth append transaction; it locks `growth_workspace_temporal_barriers`, obtains DB `CURRENT_TIMESTAMP(3)`, allocates `{ recordedAt, temporalSequence }` strictly after the workspace-global tail, and holds that row lock until the caller's business commit. `sealReadCutoff(context,effectiveAsOf)` waits for every earlier writer holding the row, advances the global tail to at least the cutoff, commits the barrier, and returns an opaque immutable `GrowthSealedReadCutoff`. All later writers therefore receive `recordedAt>effectiveAsOf`; all earlier writers are committed and visible before multi-reader Today/Performance/Closure queries begin. Each public query/command boundary seals exactly once and passes that exact branded token to every internal as-of reader; internal readers never seal again and cannot accept a naked string cutoff. Memory/MySQL implementations share one behavior contract; callers cannot construct a token or supply recorded time, sequence, or workspace other than their concrete authorized context.
- Produces: `GROWTH_TEMPORAL_BARRIER_MYSQL_SCHEMA_STATEMENTS`, `ensureGrowthTemporalBarrierMysqlSchema(pool)`, mandatory real-MySQL foundation fixture/suite, and marker `GROWTH_REAL_MYSQL foundation connections=2 tests=<positive>`. The table has one row per concrete workspace and rejects `workspace_id="all"`.
- Produces: `resolveActiveWorkspace(user: SessionUser, requestedWorkspaceId: string | null, directory: GrowthWorkspaceDirectory): Promise<ActiveWorkspaceContext | null>`; null means a concrete workspace selection is required.
- Produces: Express request field `req.activeWorkspace?: ActiveWorkspaceContext` and `createGrowthWorkspaceMiddleware(directory): RequestHandler`, reading only `X-Workspace-Id`.
- Produces: `CommandContext { workspace: ActiveWorkspaceContext; actorId: string; idempotencyKey: string; requestHash: string; expectedRevision: number | null }` and `requireExpectedRevision(context: CommandContext): number`. Mutable services consume this value as the sole `If-Match` authority; command payloads and parallel method parameters never contain a second expected revision.

```ts
export interface GrowthTemporalTransaction {
  lockWorkspaceTemporalBarrierForUpdate(workspaceId: string): Promise<{
    lastRecordedAt: string;
    temporalSequence: number;
  }>;
  currentTimestamp3(): Promise<string>;
  saveWorkspaceTemporalBarrier(
    workspaceId: string,
    expectedSequence: number,
    next: { lastRecordedAt: string; temporalSequence: number }
  ): Promise<void>;
}

export interface GrowthTemporalTransactionRunner {
  run<T>(work: (tx: GrowthTemporalTransaction) => Promise<T>): Promise<T>;
}

export interface GrowthTemporalBarrier {
  allocateAppend(tx: GrowthTemporalTransaction, workspaceId: string): Promise<{
    recordedAt: string;
    temporalSequence: number;
  }>;
  sealReadCutoff(context: ActiveWorkspaceContext, effectiveAsOf: string): Promise<GrowthSealedReadCutoff>;
}

declare const growthSealedReadCutoffBrand: unique symbol;
export interface GrowthSealedReadCutoff {
  readonly [growthSealedReadCutoffBrand]: true;
  readonly workspaceId: string;
  readonly effectiveAsOf: string;
  readonly temporalSequence: number;
}
```

Every domain transaction implements the exact structural `GrowthTemporalTransaction`; it does not receive the barrier table/repository itself. Lock order is universally `workspace temporal barrier -> domain aggregate guards/heads -> rows`. `allocateAppend` is called before any domain lock and may be called repeatedly on the same transaction to allocate consecutive global stamps. `sealReadCutoff` owns one short transaction and returns only after prior writers release/commit the same barrier row. `GrowthSealedReadCutoff` is Foundation-owned and branded: domain modules import the type, public wrappers create it only by calling the singleton barrier, and internal `...AsOfReader` ports require it by identity. Tests must prove one boundary seal call across a multi-reader response and reject an object literal, a token from another workspace, or any attempt to reseal in a nested reader.

- [ ] **Step 1: Write the failing capability and workspace tests**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capabilitiesForHumanRole,
  requireGrowthCapabilities
} from "./growth-capabilities.js";
import { resolveActiveWorkspace } from "./growth-workspace-context.js";
import { InMemoryGrowthWorkspaceSettingsReader } from "./growth-workspace-settings.js";
import { assertGrowthAsOfNotFuture, nextGrowthRecordedAt } from "./growth-as-of.js";
import type { SessionUser } from "./types.js";

const baseUser: SessionUser = {
  id: "user-1", name: "销售", email: "sales@example.com",
  role: "sales", teamId: "team-a", avatar: "S", authVersion: 1
};

test("human grants are closed and never include the reconciler identity", () => {
  assert.deepEqual(capabilitiesForHumanRole("sales"), [
    "catalog.read", "quote.draft.create"
  ]);
  for (const role of ["sales", "manager", "admin", "super_admin"] as const) {
    assert.equal(
      capabilitiesForHumanRole(role).includes(
        "acquisition.outcome.reconcile.internal"
      ),
      false
    );
  }
  assert.throws(
    () => requireGrowthCapabilities({
      workspaceId: "team-a", kind: "team", actorId: "user-1",
      role: "sales", teamId: "team-a",
      capabilities: capabilitiesForHumanRole("sales"),
      capabilityRegistryVersion: "growth-capabilities.v1"
    }, ["catalog.manage"]),
    (error: unknown) => (error as { code?: string }).code === "capability_forbidden"
  );
});

test("super admin all requires an authorized concrete workspace", async () => {
  const user = { ...baseUser, role: "super_admin" as const, teamId: "all" };
  const directory = {
    async canAccess(_user: SessionUser, workspaceId: string) {
      return workspaceId === "team-b";
    }
  };
  assert.equal(await resolveActiveWorkspace(user, null, directory), null);
  assert.equal(await resolveActiveWorkspace(user, "all", directory), null);
  assert.equal(
    (await resolveActiveWorkspace(user, "team-b", directory))?.workspaceId,
    "team-b"
  );
  assert.equal(await resolveActiveWorkspace(user, "team-c", directory), null);
});

test("ordinary users default to their team and may select only their personal workspace", async () => {
  const directory = { async canAccess() { return false; } };
  assert.equal(
    (await resolveActiveWorkspace(baseUser, null, directory))?.workspaceId,
    "team-a"
  );
  assert.equal(
    (await resolveActiveWorkspace(baseUser, "personal:user-1", directory))?.kind,
    "personal"
  );
  assert.equal(await resolveActiveWorkspace(baseUser, "team-b", directory), null);
});

test("workspace timezone comes only from trusted server settings", async () => {
  const reader = new InMemoryGrowthWorkspaceSettingsReader({ "team-a": [
    { timeZone: "Asia/Shanghai", revision: "settings-1", recordedAt: "2026-08-09T08:00:00.000Z", eventSequence: 1 },
    { timeZone: "Asia/Hong_Kong", revision: "settings-2", recordedAt: "2026-08-09T09:00:00.000Z", eventSequence: 2 }
  ] });
  const workspace = await resolveActiveWorkspace(baseUser, "team-a", { async canAccess() { return false; } });
  if (workspace === null) throw new Error("workspace_required");
  assert.equal((await reader.get(workspace)).revision, "settings-2");
  assert.deepEqual(await reader.getAt(workspace, await sealedCutoff(workspace, "2026-08-09T08:30:00.000Z")), {
    timeZone: "Asia/Shanghai", revision: "settings-1",
    recordedAt: "2026-08-09T08:00:00.000Z", eventSequence: 1
  });
  assert.throws(() => new InMemoryGrowthWorkspaceSettingsReader({ "team-a": [{ timeZone: "Not/AZone", revision: "settings-3", recordedAt: "2026-08-09T10:00:00.000Z", eventSequence: 3 }] }), /invalid_workspace_time_zone/);
});

test("one server-owned as-of boundary permits only the frozen one-second tolerance", () => {
  assert.equal(
    assertGrowthAsOfNotFuture("2026-08-09T08:00:01.000Z", "2026-08-09T08:00:00.000Z"),
    "2026-08-09T08:00:00.000Z"
  );
  assert.throws(
    () => assertGrowthAsOfNotFuture("2026-08-09T08:00:01.001Z", "2026-08-09T08:00:00.000Z"),
    (error: unknown) => (error as { status?: number; code?: string }).status === 422 &&
      (error as { code?: string }).code === "invalid_as_of"
  );
});

test("recorded time advances one persisted tick after the last event", () => {
  assert.equal(
    nextGrowthRecordedAt("2026-08-09T08:00:00.000Z", "2026-08-09T09:00:00.000Z"),
    "2026-08-09T09:00:00.001Z"
  );
});

test("a sealed cutoff waits for prior writers and fences every later append", async () => {
  const fixture = temporalBarrierFixture("workspace-a");
  const priorWriter = fixture.beginAppend("2026-08-09T07:00:00.000Z");
  await priorWriter.allocate();
  const sealing = fixture.sealReadCutoff("2026-08-09T08:00:00.000Z");
  assert.equal(await fixture.isSettled(sealing), false);
  await priorWriter.commit();
  const sealed = await sealing;
  assert.equal(sealed.effectiveAsOf, "2026-08-09T08:00:00.000Z");
  fixture.setDatabaseNow("2026-08-09T06:00:00.000Z");
  const laterWriter = fixture.beginAppend();
  const stamp = await laterWriter.allocate();
  assert.equal(stamp.recordedAt, "2026-08-09T08:00:00.001Z");
  await laterWriter.commit();
});

test("new streams and interleaved readers cannot rewrite one sealed as-of", async () => {
  await withGrowthFoundationMysqlTestDatabase(async ({ connectionA, connectionB, barrier, views }) => {
    const started = await views.beginUncommittedNewAggregate(connectionA, "workspace-a", {
      databaseNow: "2026-08-09T07:59:59.000Z"
    });
    const sealing = barrier.sealReadCutoff(workspace("workspace-a"), "2026-08-09T08:00:00.000Z");
    await started.commit();
    const token = await sealing;
    const before = await views.readAll(connectionB, token);
    await views.appendNewStreamWithClockRollback(connectionA, token.effectiveAsOf);
    const after = await views.readAll(connectionB, token);
    assert.deepEqual(after, before);
    assert.ok((await views.lastAppendStamp()).recordedAt > token.effectiveAsOf);
  });
});

test("sealing the same cutoff again never changes business projection identity", async () => {
  const fixture = temporalBarrierFixture("workspace-a");
  const first = await fixture.sealReadCutoff("2026-08-09T08:00:00.000Z");
  const firstProjection = await fixture.readBusinessProjection(first);
  const second = await fixture.sealReadCutoff("2026-08-09T08:00:00.000Z");
  assert.ok(second.temporalSequence >= first.temporalSequence);
  assert.equal((await fixture.readBusinessProjection(second)).calculationHash, firstProjection.calculationHash);
  const writer = fixture.beginAppend("2026-08-09T09:00:00.000Z");
  await writer.allocate(); await writer.commit();
  const third = await fixture.sealReadCutoff("2026-08-09T08:00:00.000Z");
  assert.equal((await fixture.readBusinessProjection(third)).calculationHash, firstProjection.calculationHash);
});

test("a trusted settings append cannot backdate history when the server clock moves backward", async () => {
  const repository = workspaceSettingsRepositoryFixture({ now: "2026-08-09T09:00:00.000Z" });
  await repository.appendTrustedSettingsEvent("team-a", { timeZone: "Asia/Shanghai", revision: "settings-1" });
  repository.setNow("2026-08-09T08:00:00.000Z");
  await repository.appendTrustedSettingsEvent("team-a", { timeZone: "Asia/Hong_Kong", revision: "settings-2" });
  assert.equal((await repository.getAt(workspace("team-a"), "2026-08-09T08:59:59.999Z"))?.revision, "growth-workspace-settings.v1");
  assert.equal((await repository.getAt(workspace("team-a"), "2026-08-09T09:00:00.000Z"))?.revision, "settings-1");
  assert.equal((await repository.getAt(workspace("team-a"), "2026-08-09T09:00:00.001Z"))?.revision, "settings-2");
});
```

- [ ] **Step 2: Run the focused tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/growth-capabilities-test.ts src/growth-workspace-context-test.ts src/growth-workspace-settings-test.ts src/growth-workspace-settings-mysql-repository-test.ts src/growth-as-of-test.ts src/growth-temporal-barrier-test.ts src/growth-temporal-barrier-mysql-repository-test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `growth-capabilities.js` or `growth-workspace-context.js`.

- [ ] **Step 3: Implement the closed registry and resolver**

```ts
// backend/src/growth-capabilities.ts
import type { Role } from "./types.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export const GROWTH_CAPABILITY_REGISTRY_VERSION =
  "growth-capabilities.v1" as const;
export const GROWTH_CAPABILITIES = [
  "catalog.read", "catalog.manage", "pricing.sensitive.read",
  "quote.draft.create", "quote.confirm",
  "quote.exception.discount.approve", "quote.exception.margin.approve",
  "quote.exception.payment_terms.approve", "quote.exception.gift.approve",
  "quote.exception.credit.approve", "quote.exception.manual.approve",
  "ledger.pending.create", "ledger.verify", "roi.close",
  "growth.performance.team.read", "growth.performance.workspace.read",
  "acquisition.outcome.reconcile.internal"
] as const;
export type GrowthCapability = typeof GROWTH_CAPABILITIES[number];

const HUMAN_GRANTS: Record<Role, readonly GrowthCapability[]> = {
  sales: ["catalog.read", "quote.draft.create"],
  manager: [
    "catalog.read", "pricing.sensitive.read", "quote.draft.create",
    "quote.confirm", "quote.exception.discount.approve",
    "quote.exception.margin.approve",
    "quote.exception.payment_terms.approve", "quote.exception.gift.approve",
    "quote.exception.credit.approve", "quote.exception.manual.approve",
    "ledger.pending.create", "growth.performance.team.read"
  ],
  admin: GROWTH_CAPABILITIES.filter((key) =>
    key !== "acquisition.outcome.reconcile.internal"),
  super_admin: GROWTH_CAPABILITIES.filter((key) =>
    key !== "acquisition.outcome.reconcile.internal")
};

export class GrowthAuthorizationError extends Error {
  readonly code = "capability_forbidden";
}
export function capabilitiesForHumanRole(role: Role) {
  return Object.freeze([...HUMAN_GRANTS[role]]);
}
export function requireGrowthCapabilities(
  context: ActiveWorkspaceContext,
  required: readonly GrowthCapability[]
) {
  const granted = new Set(context.capabilities);
  if (required.some((key) => !granted.has(key))) {
    throw new GrowthAuthorizationError("当前工作区能力不足");
  }
}
```

```ts
// backend/src/growth-workspace-context.ts
import type { RequestHandler } from "express";
import type { Role, SessionUser } from "./types.js";
import {
  capabilitiesForHumanRole,
  GROWTH_CAPABILITY_REGISTRY_VERSION,
  type GrowthCapability
} from "./growth-capabilities.js";

export interface ActiveWorkspaceContext {
  workspaceId: string;
  kind: "team" | "personal";
  actorId: string;
  role: Role;
  teamId: string;
  capabilities: readonly GrowthCapability[];
  capabilityRegistryVersion: string;
}
export interface GrowthWorkspaceDirectory {
  canAccess(user: SessionUser, workspaceId: string): Promise<boolean>;
}
export interface GrowthAcquisitionWorkspaceDirectory {
  resolve(scope: Readonly<{ ownerId: string; teamId: string }>): Promise<{
    workspaceId: string;
    kind: "team" | "personal";
    bindingRevision: string;
  } | null>;
}
declare const resolvedAcquisitionWorkspaceBrand: unique symbol;
export interface ResolvedAcquisitionWorkspace {
  readonly workspaceId: string;
  readonly kind: "team" | "personal";
  readonly bindingRevision: string;
  readonly ownerId: string;
  readonly teamId: string;
  readonly [resolvedAcquisitionWorkspaceBrand]: true;
}
export interface GrowthAcquisitionWorkspaceResolver {
  resolve(scope: Readonly<{ ownerId: string; teamId: string }>):
    Promise<ResolvedAcquisitionWorkspace | null>;
}
export async function resolveActiveWorkspace(
  user: SessionUser,
  requestedWorkspaceId: string | null,
  directory: GrowthWorkspaceDirectory
): Promise<ActiveWorkspaceContext | null> {
  const personal = `personal:${user.id}`;
  const requested = requestedWorkspaceId?.trim() || null;
  let workspaceId: string | null = null;
  if (requested === "all") return null;
  if (requested === personal) workspaceId = personal;
  else if (user.teamId !== "all" && (!requested || requested === user.teamId)) {
    workspaceId = user.teamId;
  } else if (requested && await directory.canAccess(user, requested)) {
    workspaceId = requested;
  }
  if (!workspaceId) return null;
  return Object.freeze({
    workspaceId,
    kind: workspaceId === personal ? "personal" : "team",
    actorId: user.id,
    role: user.role,
    teamId: user.teamId,
    capabilities: capabilitiesForHumanRole(user.role),
    capabilityRegistryVersion: GROWTH_CAPABILITY_REGISTRY_VERSION
  });
}
```

Add `activeWorkspace?: ActiveWorkspaceContext` to the existing Express `Request` declaration in `auth.ts`, implement `createGrowthWorkspaceMiddleware`, and export `CommandContext` from `growth-command-context.ts` with exactly the interface in this task's Interfaces block.

Implement `GrowthWorkspaceSettingsReader` in `growth-workspace-settings.ts` with `Intl.DateTimeFormat(undefined,{timeZone}).resolvedOptions()` validation and a server-owned per-workspace append-only history. `growth_workspace_settings_events` has unique `(workspace_id,event_sequence)` and `(workspace_id,revision)`, indexes `(workspace_id,recorded_at,event_sequence)`, and never updates old events. The trusted deployment default `Asia/Shanghai` is seeded once at the Unix epoch as revision `growth-workspace-settings.v1`; a deployment setting change locks the workspace temporal barrier first, receives its global append stamp, then locks/appends the settings event in that same transaction. Missing or invalid server configuration fails closed; request payloads are never an input to this reader. Memory/MySQL contract tests prove same-millisecond ordering, clock-rollback strict advancement, and that appending settings-2 cannot change `getAt(..., oldAsOf)`. The single Growth application injects the same reader into Finance preview and Advisor Today composition.

Implement `GrowthAcquisitionWorkspaceResolver` beside the request resolver in `growth-workspace-context.ts`, but keep their authorities distinct: the request resolver consumes an authenticated `SessionUser`, while this internal resolver consumes only a persisted `{ownerId,teamId}` and asks the trusted server directory for its exact binding. It rejects `teamId="all"`, blank/`all` results, missing binding revisions, and any directory response not tied to the supplied scope, then returns one frozen branded `ResolvedAcquisitionWorkspace` carrying the exact input owner/team. Tests cover a concrete team mapping, an explicitly registered personal mapping, cross-team/nonmember null, `all` with zero directory calls, runtime inability to construct the brand, and strict reference identity as the value enters background Run/ingestion adapters. No Advisor, Acquisition, import, backfill, or ROI projection code may synthesize `workspaceId=teamId`, `personal:${ownerId}`, `ActiveWorkspaceContext`, role, or capabilities itself.

Implement `growth-as-of.ts` as pure Foundation helpers over strict RFC 3339 parsing and integer epoch milliseconds. The default future tolerance is the C0-frozen `1_000` milliseconds and callers may not enlarge it. A client `asOf` within that positive skew is accepted but clamped to the frozen server start. The request then calls `temporalBarrier.sealReadCutoff(context,effectiveAsOf)` exactly once before any historical reader; all downstream readers accept the returned `GrowthSealedReadCutoff`, while hashes, DTO `dataAsOf`, HTTP/domain idempotency identities, and Closure operation identities use only `effectiveAsOf` plus actual frozen source IDs/versions/hashes. `temporalSequence` is an internal isolation/audit watermark and must never enter a business hash, response identity, or replay discriminator: consecutive seals of the same cutoff, with either no intervening write or only writes recorded after that cutoff, produce byte-identical business projections. The barrier waits out an uncommitted writer that already owns the workspace row and prevents a later writer—even for a brand-new aggregate under a rolled-back DB clock—from receiving a timestamp at or below the cutoff. `nextGrowthRecordedAt` validates DATETIME(3)/ISO precision and is called only by the barrier to allocate its global tail. Capture request/command start from the server clock before dependency reads; never accept a client-supplied clock.

Implement the MySQL barrier with `growth_workspace_temporal_barriers(workspace_id VARCHAR(191) PRIMARY KEY,last_recorded_at DATETIME(3) NOT NULL,temporal_sequence BIGINT UNSIGNED NOT NULL)`. `allocateAppend` runs on the caller's checked-out business connection, upserts/locks that row first, reads `CURRENT_TIMESTAMP(3)` on the same connection, advances one global tick/sequence, and updates it without committing; the domain transaction retains the lock until its own commit/rollback. `sealReadCutoff` uses a short checked-out transaction, locks the same row (therefore waiting for any earlier writer), advances the tail to `max(lastRecordedAt,effectiveAsOf)` with a new sequence, commits, and returns the token. All Growth and Acquisition-to-Growth projection writers follow the single lock order; attempting a domain lock before the temporal row is a tested invariant failure, not an alternate code path.

- [ ] **Step 4: Run focused and auth regression tests**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/growth-capabilities-test.ts src/growth-workspace-context-test.ts src/growth-workspace-settings-test.ts src/growth-workspace-settings-mysql-repository-test.ts src/growth-as-of-test.ts src/growth-temporal-barrier-test.ts src/growth-temporal-barrier-mysql-repository-test.ts && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" node --import tsx --test --test-concurrency=1 src/growth-foundation-mysql-integration-test.ts && npm run test:security`

Expected: PASS for both growth tests and the existing security suite.

- [ ] **Step 5: Commit the capability/workspace slice**

```bash
git add backend/src/growth-capabilities.ts backend/src/growth-capabilities-test.ts backend/src/growth-workspace-context.ts backend/src/growth-workspace-context-test.ts backend/src/growth-workspace-settings.ts backend/src/growth-workspace-settings-test.ts backend/src/growth-workspace-settings-mysql-repository.ts backend/src/growth-workspace-settings-mysql-repository-test.ts backend/src/growth-as-of.ts backend/src/growth-as-of-test.ts backend/src/growth-temporal-barrier.ts backend/src/growth-temporal-barrier-test.ts backend/src/growth-temporal-barrier-mysql-repository.ts backend/src/growth-temporal-barrier-mysql-repository-test.ts backend/src/growth-foundation-mysql-test-support.ts backend/src/growth-foundation-mysql-integration-test.ts backend/src/growth-command-context.ts backend/src/auth.ts backend/src/types.ts
git commit -m "feat: establish growth workspace capabilities"
```

### Task 0.2: Re-authorized HTTP idempotency and revision preconditions

**Depends:** Foundation Task 0.1 and `2026-08-09-growth-contract-and-frontend.md` Task 3.

**Files:**
- Create: `backend/src/growth-http-idempotency-repository.ts`
- Create: `backend/src/growth-http-idempotency-repository-test.ts`
- Create: `backend/src/growth-http-idempotency-mysql-repository.ts`
- Create: `backend/src/growth-http-idempotency-mysql-repository-test.ts`
- Create: `backend/src/growth-http-preconditions.ts`
- Create: `backend/src/growth-http-preconditions-test.ts`
- Create: `backend/src/growth-foundation-module.ts`
- Create: `backend/src/growth-foundation-module-test.ts`
- Modify: `backend/src/growth-foundation-mysql-integration-test.ts`
- Modify: `backend/src/growth-command-context.ts`
- Modify: `backend/src/growth-commercial-composition.ts`
- Modify: `backend/src/growth-commercial-composition-test.ts`

**Interfaces:**
- Consumes: `CommandContext` from Task 0.1.
- Produces: `GrowthHttpIdempotencyReservationInput { workspaceId; actorId; method; canonicalPath; key; requestHash; attemptedAt; leaseOwner; leaseDurationMs }`.
- Produces: `GrowthHttpIdempotencyRepository.reserve(input): Promise<{kind:"claimed"; reservationId:string; leaseOwner:string; leaseExpiresAt:string; fencingToken:number}|{kind:"in_progress"; retryAfterMs:number}|{kind:"replay"; resourceId:string|null; operationId:string|null}|{kind:"conflict"}>`.
- Produces: fenced `GrowthHttpIdempotencyRepository.complete(reservationId, leaseOwner, fencingToken, { resourceId, operationId }): Promise<void>` and `.release(reservationId, leaseOwner, fencingToken): Promise<void>`; an expired reservation is reclaimed by CAS with a strictly larger fencing token.
- Produces: `InMemoryGrowthHttpIdempotencyRepository` and `MysqlGrowthHttpIdempotencyRepository` with behavior parity.
- Produces: `canonicalGrowthRequestHash(value: unknown): string` using `canonicalJsonStringify` and SHA-256.
- Produces: `parseGrowthIdempotencyKey(req): string`, `parseIfMatchRevision(req, resourceScope: string): number`, `setRevisionEtag(res, resource, id, revision): void`. Revision ETags are `"<resource>:<id>:<revision>"`; mutable-resource routes parse against the exact `resource:id` scope, so an ETag issued for one item cannot authorize another item at the same revision.
- Produces: `commandContextFromRequest(req, { canonicalPath, pathParams, payload, expectedRevision }): CommandContext`; it requires `req.activeWorkspace`, derives `actorId` only from that context, parses `Idempotency-Key`, validates the router-supplied closed string `pathParams`, and hashes `{ method, canonicalPath, pathParams, payload, expectedRevision }` canonically so the same key/body against another resource or `If-Match` conflicts rather than replaying.
- Produces: the only cross-module request adapters, `GrowthWorkspaceContextResolver = (req: express.Request) => ActiveWorkspaceContext` and `GrowthCommandContextFactory = (req: express.Request, input: { canonicalPath: string; pathParams: Readonly<Record<string,string>>; payload: unknown; expectedRevision: number | null }) => CommandContext`. The resolver returns the exact `req.activeWorkspace` object or fails closed; the factory delegates to `commandContextFromRequest` and never accepts workspace, actor, capabilities, request hash or idempotency identity from caller JSON. Every command route supplies only its schema-validated path identifiers; collection commands pass `Object.freeze({})`.
- Produces: `executeGrowthIdempotentCommand<T>(input: { repository: GrowthHttpIdempotencyRepository; reservation: GrowthHttpIdempotencyReservationInput }, authorizeAndProject: (resourceId: string|null, operationId: string|null) => Promise<T>, execute: () => Promise<{ resourceId: string|null; operationId: string|null }>): Promise<{ value:T; replayed:boolean }>`; replay calls the current `authorizeAndProject` and claimed execution stores only IDs before projecting.
- Produces: `GrowthFoundationServices { httpIdempotency: GrowthHttpIdempotencyRepository; workspaceSettings: GrowthWorkspaceSettingsReader; workspaceContext: GrowthWorkspaceContextResolver; acquisitionWorkspace: GrowthAcquisitionWorkspaceResolver; temporalTransactions: GrowthTemporalTransactionRunner; temporalBarrier: GrowthTemporalBarrier; commandContextFactory: GrowthCommandContextFactory }`, typed key `GROWTH_FOUNDATION_SERVICES`, and `createGrowthFoundationModule(options): GrowthCommercialModule`. It is installed first by the sole production composition; later business modules require these exact singleton adapters instead of constructing HTTP idempotency, workspace settings, Acquisition-scope mapping, temporal ordering, or request-context parsing themselves.

- [ ] **Step 1: Write failing parity and replay-security tests**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InMemoryGrowthHttpIdempotencyRepository,
  executeGrowthIdempotentCommand
} from "./growth-http-idempotency-repository.js";
import type { GrowthHttpIdempotencyReservationInput } from "./growth-http-idempotency-repository.js";

const idempotencyReservation = (overrides: Partial<GrowthHttpIdempotencyReservationInput> = {}): GrowthHttpIdempotencyReservationInput => ({
  workspaceId: "team-a", actorId: "manager-1", method: "POST",
  canonicalPath: "/api/v1/quotes/versions/:id/approve",
  key: "approve-key-0001", requestHash: `sha256:${"c".repeat(64)}`,
  attemptedAt: "2026-08-09T08:00:00.000Z", leaseOwner: "request-a", leaseDurationMs: 30_000,
  ...overrides
});

test("same request replays by reference and different payload conflicts", async () => {
  const repository = new InMemoryGrowthHttpIdempotencyRepository();
  const input = {
    workspaceId: "team-a", actorId: "sales-1", method: "POST",
    canonicalPath: "/api/v1/quotes/cases", key: "case-key-0001",
    requestHash: `sha256:${"a".repeat(64)}`,
    attemptedAt: "2026-08-09T08:00:00.000Z", leaseOwner: "request-a", leaseDurationMs: 30_000
  };
  const first = await repository.reserve(input);
  assert.equal(first.kind, "claimed");
  if (first.kind === "claimed") {
    await repository.complete(first.reservationId, first.leaseOwner, first.fencingToken, {
      resourceId: "quote-case-1", operationId: null
    });
  }
  assert.deepEqual(await repository.reserve(input), {
    kind: "replay", resourceId: "quote-case-1", operationId: null
  });
  assert.deepEqual(await repository.reserve({
    ...input, requestHash: `sha256:${"b".repeat(64)}`
  }), { kind: "conflict" });
});

test("replay invokes current authorization instead of returning cached fields", async () => {
  const repository = new InMemoryGrowthHttpIdempotencyRepository();
  let allowed = true;
  const command = () => executeGrowthIdempotentCommand({
    repository,
    reservation: {
      workspaceId: "team-a", actorId: "manager-1", method: "POST",
      canonicalPath: "/api/v1/quotes/versions/:id/approve",
      key: "approve-key-0001", requestHash: `sha256:${"c".repeat(64)}`,
      attemptedAt: "2026-08-09T08:00:00.000Z", leaseOwner: crypto.randomUUID(), leaseDurationMs: 30_000
    }
  }, async () => {
    if (!allowed) throw Object.assign(new Error("forbidden"), {
      code: "capability_forbidden"
    });
    return { id: "approval-1", sensitiveCostMinor: 123 };
  }, async () => ({ resourceId: "approval-1", operationId: null }));
  await command();
  allowed = false;
  await assert.rejects(command, (error: unknown) =>
    (error as { code?: string }).code === "capability_forbidden");
});

test("one same-key attempt executes while an expired reservation is safely reclaimed", async () => {
  const repository = new InMemoryGrowthHttpIdempotencyRepository();
  const base = idempotencyReservation({ attemptedAt: "2026-08-09T08:00:00.000Z", leaseOwner: "worker-a", leaseDurationMs: 1000 });
  const first = await repository.reserve(base);
  assert.equal(first.kind, "claimed");
  assert.deepEqual(await repository.reserve({ ...base, leaseOwner: "worker-b", attemptedAt: "2026-08-09T08:00:00.500Z" }), { kind: "in_progress", retryAfterMs: 500 });
  const reclaimed = await repository.reserve({ ...base, leaseOwner: "worker-b", attemptedAt: "2026-08-09T08:00:01.001Z" });
  assert.equal(reclaimed.kind, "claimed");
  if (first.kind !== "claimed" || reclaimed.kind !== "claimed") throw new Error("expected_claims");
  assert.ok(reclaimed.fencingToken > first.fencingToken);
  await assert.rejects(() => repository.complete(first.reservationId, first.leaseOwner, first.fencingToken, { resourceId: "stale", operationId: null }), /stale_idempotency_fence/);
  await repository.complete(reclaimed.reservationId, reclaimed.leaseOwner, reclaimed.fencingToken, { resourceId: "resource-1", operationId: null });
});

test("reclaim after business commit and lost completion returns one domain resource", async () => {
  const repository = new InMemoryGrowthHttpIdempotencyRepository();
  const domain = new Map<string, { id: string }>();
  const base = idempotencyReservation({ attemptedAt: "2026-08-09T08:00:00.000Z", leaseOwner: "request-a", leaseDurationMs: 1000 });
  const first = await repository.reserve(base);
  assert.equal(first.kind, "claimed");
  domain.set("stable-command-key", { id: "resource-stable-key" });
  const replay = await executeGrowthIdempotentCommand({ repository, reservation: { ...base, attemptedAt: "2026-08-09T08:00:01.001Z", leaseOwner: "request-b" } },
    async (resourceId) => domain.get("stable-command-key") ?? { id: resourceId ?? "missing" },
    async () => {
      if (!domain.has("stable-command-key")) domain.set("stable-command-key", { id: "resource-stable-key" });
      return { resourceId: domain.get("stable-command-key")!.id, operationId: null };
    });
  assert.equal(replay.value.id, "resource-stable-key");
  assert.equal(domain.size, 1);
  assert.deepEqual(await repository.reserve({ ...base, attemptedAt: "2026-08-09T08:00:02.000Z", leaseOwner: "request-c" }), { kind: "replay", resourceId: "resource-stable-key", operationId: null });
});

test("same idempotency key and body with a different If-Match conflicts", () => {
  const first = canonicalGrowthRequestHash({ method: "POST", canonicalPath: "/api/v1/catalog/items/:id/retire", pathParams: { id: "item-1" }, payload: {}, expectedRevision: 1 });
  const second = canonicalGrowthRequestHash({ method: "POST", canonicalPath: "/api/v1/catalog/items/:id/retire", pathParams: { id: "item-1" }, payload: {}, expectedRevision: 2 });
  assert.notEqual(first, second);
});

test("same key and body for a different path resource conflicts", () => {
  const itemA = canonicalGrowthRequestHash({ method: "POST", canonicalPath: "/api/v1/catalog/items/:id/retire", pathParams: { id: "item-a" }, payload: {}, expectedRevision: 1 });
  const itemB = canonicalGrowthRequestHash({ method: "POST", canonicalPath: "/api/v1/catalog/items/:id/retire", pathParams: { id: "item-b" }, payload: {}, expectedRevision: 1 });
  assert.notEqual(itemA, itemB);
});
```

Add MySQL fake-pool tests that assert the reservation INSERT happens before any business callback, the unique key covers `workspace_id, actor_id, method, canonical_path, idempotency_key_hash`, and no `response_json` column exists. Add precondition tests for missing header (`428 revision_required`), malformed ETag (`400 invalid_if_match`), stale revision (`412 revision_conflict`), and exact revision success.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/growth-http-idempotency-repository-test.ts src/growth-http-idempotency-mysql-repository-test.ts src/growth-http-preconditions-test.ts`

Expected: FAIL because the idempotency and precondition modules do not exist.

- [ ] **Step 3: Implement the in-memory contract and precondition helpers**

```ts
export type GrowthHttpIdempotencyReservation =
  | { kind: "claimed"; reservationId: string; leaseOwner: string; leaseExpiresAt: string; fencingToken: number }
  | { kind: "in_progress"; retryAfterMs: number }
  | { kind: "replay"; resourceId: string | null; operationId: string | null }
  | { kind: "conflict" };

export interface GrowthHttpIdempotencyRepository {
  reserve(input: GrowthHttpIdempotencyReservationInput):
    Promise<GrowthHttpIdempotencyReservation>;
  complete(reservationId: string, leaseOwner: string, fencingToken: number, result: {
    resourceId: string | null;
    operationId: string | null;
  }): Promise<void>;
  release(reservationId: string, leaseOwner: string, fencingToken: number): Promise<void>;
}

export type GrowthWorkspaceContextResolver =
  (req: express.Request) => ActiveWorkspaceContext;

export type GrowthCommandContextFactory = (
  req: express.Request,
  input: {
    canonicalPath: string;
    pathParams: Readonly<Record<string, string>>;
    payload: unknown;
    expectedRevision: number | null;
  }
) => CommandContext;

export function commandContextFromRequest(
  req: express.Request,
  input: {
    canonicalPath: string;
    pathParams: Readonly<Record<string, string>>;
    payload: unknown;
    expectedRevision: number | null;
  }
): CommandContext {
  if (!req.activeWorkspace) throw new GrowthHttpError(400, "workspace_required");
  return {
    workspace: req.activeWorkspace,
    actorId: req.activeWorkspace.actorId,
    idempotencyKey: parseGrowthIdempotencyKey(req),
    requestHash: canonicalGrowthRequestHash({
      method: req.method.toUpperCase(),
      canonicalPath: input.canonicalPath,
      pathParams: input.pathParams,
      payload: input.payload,
      expectedRevision: input.expectedRevision
    }),
    expectedRevision: input.expectedRevision
  };
}

export function requireExpectedRevision(context: CommandContext): number {
  const revision = context.expectedRevision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    throw new GrowthHttpError(428, "revision_required");
  }
  return revision;
}
```

`pathParams` and `expectedRevision` are part of the canonical request hash: reusing one key/body with another path resource or `If-Match` conflicts instead of replaying an earlier command. Reject missing, extra, array, non-string, blank, or unvalidated path values before reservation; canonical JSON sorts keys. `executeGrowthIdempotentCommand` reserves first. On `conflict` it throws `GrowthHttpError(409,"idempotency_conflict")`; on `in_progress` it throws `GrowthHttpError(409,"idempotency_in_progress")` with `Retry-After`; on `replay` it calls the current `authorizeAndProject`; on `claimed` it runs the command, completes with IDs using the exact lease/fence, and projects the result. It releases an uncompleted reservation only with the exact lease/fence. Every business command uses its canonical idempotency key or stable command hash as a domain uniqueness key so an expired HTTP reservation reclaimed after business commit but before `complete` returns the same resource rather than duplicating side effects.

- [ ] **Step 4: Implement the dedicated MySQL table and repository**

```sql
CREATE TABLE IF NOT EXISTS growth_http_idempotency (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(191) NOT NULL,
  actor_id VARCHAR(191) NOT NULL,
  method VARCHAR(16) NOT NULL,
  canonical_path VARCHAR(255) NOT NULL,
  idempotency_key_hash CHAR(71) NOT NULL,
  request_hash CHAR(71) NOT NULL,
  status ENUM('reserved','completed') NOT NULL,
  lease_owner VARCHAR(128) NULL,
  lease_expires_at DATETIME(3) NULL,
  fencing_token BIGINT UNSIGNED NOT NULL DEFAULT 0,
  resource_id VARCHAR(191) NULL,
  operation_id VARCHAR(191) NULL,
  created_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  UNIQUE KEY uq_growth_http_idempotency_scope (
    workspace_id, actor_id, method, canonical_path, idempotency_key_hash
  )
) ENGINE=InnoDB;
```

Hash the raw idempotency key before persistence. Use a transaction with `INSERT ... ON DUPLICATE KEY UPDATE id=id`, then `SELECT ... FOR UPDATE`; a matching unexpired reservation returns `in_progress`, a matching expired reservation CAS-updates owner/expiry and increments `fencing_token`, completed rows replay, and mismatched request hashes conflict. `complete/release` update only `WHERE id=? AND lease_owner=? AND fencing_token=? AND status='reserved'`; stale workers fail closed. Never persist request or response bodies.

Extend `growth-foundation-mysql-integration-test.ts` after the idempotency repository exists: on two distinct physical connections it must prove one reservation winner, unexpired `in_progress`, expired CAS reclaim with a larger fence, stale complete rejection, and matching replay by IDs. Together with the Task-0.1 settings/barrier scenarios it prints exactly `GROWTH_REAL_MYSQL foundation connections=2 tests=<positive>` and fails before tests when `MYSQL_TEST_ADMIN_URL` is absent, both connections share a `CONNECTION_ID()`, any case is skipped, or the executed count is zero.

`createGrowthFoundationModule.install({ privateServices })` initializes the dedicated HTTP-idempotency, workspace temporal barrier, and append-only workspace-settings schemas/repositories once (MySQL mode runs all ensure functions; memory mode uses their in-memory counterparts), creates exactly one mode-specific temporal transaction runner, injects that exact runner into the barrier, and in memory mode injects it into workspace settings as well. It pairs them with the request adapters and trusted Acquisition-scope resolver above, constructs the module-local idempotent close handle before provision, and provides one frozen `GrowthFoundationServices` under `GROWTH_FOUNDATION_SERVICES` inside a local try/catch. Any schema/repository initialization or `provide` failure awaits closure of every already-created current-module resource before rethrowing. Add it first in `growth-commercial-composition.ts`. It mounts no route and returns its own idempotent close handle. The module test proves duplicate installation/provision fails, the exact repositories/adapters are visible to later modules, exposed runner/settings/barrier operations preserve one continuous temporal sequence, a read resolver returns the same `req.activeWorkspace` object by identity, a write factory derives the same object/actor/idempotency/precondition without body overrides, the Acquisition resolver and temporal barrier are identical trusted singletons, `all`/unmapped scopes fail, `workspaceSettings.getAt` remains historical after a later trusted append, initialization midway/provide failure locally closes current resources once, failed later installation triggers one reverse close, and neither `growth-commercial-application.ts` nor `server.ts` constructs a repository or second context/scope/barrier adapter.

- [ ] **Step 5: Verify GREEN**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/growth-http-idempotency-repository-test.ts src/growth-http-idempotency-mysql-repository-test.ts src/growth-http-preconditions-test.ts src/growth-foundation-module-test.ts src/growth-commercial-composition-test.ts && MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" node --import tsx --test --test-concurrency=1 src/growth-foundation-mysql-integration-test.ts && npm run build`

Expected: all focused tests and build PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/growth-http-idempotency-repository.ts backend/src/growth-http-idempotency-repository-test.ts backend/src/growth-http-idempotency-mysql-repository.ts backend/src/growth-http-idempotency-mysql-repository-test.ts backend/src/growth-http-preconditions.ts backend/src/growth-http-preconditions-test.ts backend/src/growth-foundation-module.ts backend/src/growth-foundation-module-test.ts backend/src/growth-foundation-mysql-integration-test.ts backend/src/growth-command-context.ts backend/src/growth-commercial-composition.ts backend/src/growth-commercial-composition-test.ts
git commit -m "feat: add growth command idempotency foundation"
```

### Task 0.3: Trusted acquisition binding extraction and legacy commercial-write gate

**Depends:** Foundation Task 0.2 and `2026-08-09-growth-contract-and-frontend.md` Task 3.

**Files:**
- Create: `backend/src/acquisition-deal-binding.ts`
- Create: `backend/src/acquisition-deal-binding-test.ts`
- Create: `backend/src/commercial-authority-guard.ts`
- Create: `backend/src/commercial-authority-guard-test.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/src/types.ts`
- Modify: `backend/src/acquisition-v1-router.ts`
- Modify: `backend/src/acquisition-v1-router-test.ts`
- Modify: `backend/src/acquisition-domain-service.ts`
- Modify: `backend/src/acquisition-domain-test.ts`
- Modify: `backend/src/acquisition-crm-outcome-reconciliation.ts`
- Modify: `backend/src/acquisition-crm-outcome-reconciliation-test.ts`
- Modify: `backend/src/acquisition-application.ts`

**Interfaces:**
- Produces: `TrustedAcquisitionDealBinding { handoff: AcquisitionCustomerHandoff; lead: Lead }`.
- Produces: `resolveTrustedAcquisitionDealBinding(store: Pick<CrmStore,"acquisitionCustomerHandoffs"|"leads">, lookup: AcquisitionDealBindingLookup): TrustedAcquisitionDealBinding | null`; behavior is extracted unchanged from `server.ts` and becomes the single binding resolver.
- Produces: `CommercialAuthorityAction = "deal_commercial_patch" | "deal_quote_event" | "deal_won" | "deal_lost" | "pi_create" | "pi_commercial_patch" | "pi_revision" | "pi_submit_approval" | "pi_approve" | "pi_send" | "pi_export"`.
- Produces: Foundation-owned `QuoteProjectedDocumentAction = "submit_approval"|"approve"|"send"|"export"`, `QuoteProjectedDocumentAuthority { documentId; documentRevision; dealId; quoteCaseId; quoteVersionId; commercialAmountHash; dealAuthorityRevision }`, and `QuoteProjectedDocumentAuthorityValidator.assertAuthorized(context,{ documentId; action; expectedDocumentRevision }): Promise<QuoteProjectedDocumentAuthority>` as the only Stage-2 extension seam for legitimate human PI transitions. Quote later imports/implements this exact interface and supplies one instance through the sole Growth integration projection.
- Produces: `assertLegacyCommercialWriteAllowed(store, context, dealId, action, options?): Promise<void>`; it throws `CommercialAuthorityError` with status `409` and code `authoritative_quote_required` for a trusted acquisition-bound Deal unless the action is a noncommercial PI lifecycle transition on an existing `quote_projection` document and the injected authority validator accepts the exact frozen quote authority.
- Extends: `TradeDocument` with `commercialAuthority: "legacy_unverified" | "quote_projection"`, `quoteCaseId?: string`, `quoteVersionId?: string`, `commercialAmountHash?: string`, and `dealAuthorityRevision?: number`. Existing rows normalize to `legacy_unverified`.
- Extends: `DealEvent` with the same authority marker and nullable quote case/version/hash/revision snapshots. Existing rows normalize to `legacy_unverified`.
- Produces: `AcquisitionOutcomeWriteAuthority { capability: "acquisition.outcome.reconcile.internal"; sourceStableKey: string }`.
- Changes: `AcquisitionDomainService.recordOutcome(scope, input, authority?)`; commercial event types require the internal authority.
- Changes: public `POST /api/v1/acquisition/outcomes` schema excludes `quoted`, `won`, and `lost` while GET remains backward-compatible.
- Test-only `bindingFixture(overrides)` is defined locally in `acquisition-deal-binding-test.ts`; mounted legacy-route fixtures remain local to `commercial-authority-guard-test.ts`.

- [ ] **Step 1: Write failing extraction and route-gate tests**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveTrustedAcquisitionDealBinding
} from "./acquisition-deal-binding.js";
import {
  assertLegacyCommercialWriteAllowed,
  CommercialAuthorityError
} from "./commercial-authority-guard.js";

test("only one complete candidate to handoff to lead to deal chain is trusted", () => {
  const store = bindingFixture({ dealId: "deal-1" });
  const binding = resolveTrustedAcquisitionDealBinding(store, {
    dealId: "deal-1"
  });
  assert.equal(binding?.handoff.candidateId, "candidate-1");
  assert.equal(binding?.lead.convertedDealId, "deal-1");
});

test("legacy commercial writes are blocked only for trusted acquisition deals", async () => {
  const store = bindingFixture({ dealId: "deal-1" });
  await assert.rejects(
    assertLegacyCommercialWriteAllowed(
      store, managerWorkspace(), "deal-1", "deal_commercial_patch"
    ),
    (error: unknown) => error instanceof CommercialAuthorityError
      && error.code === "authoritative_quote_required"
  );
  await assert.doesNotReject(assertLegacyCommercialWriteAllowed(
    store, managerWorkspace(), "legacy-deal", "deal_commercial_patch"
  ));
});

test("only an exact quote projection can use the existing human PI lifecycle", async () => {
  const store = bindingFixture({ dealId: "deal-1" });
  const projected = tradeDocumentFixture({
    commercialAuthority: "quote_projection", quoteVersionId: "quote-v1",
    commercialAmountHash: `sha256:${"a".repeat(64)}`, dealAuthorityRevision: 3
  });
  await assert.doesNotReject(assertLegacyCommercialWriteAllowed(
    store, managerWorkspace(), "deal-1", "pi_submit_approval", {
      document: projected,
      projectedDocumentAuthority: acceptingExactProjectionValidator
    }
  ));
  await assert.rejects(assertLegacyCommercialWriteAllowed(
    store, managerWorkspace(), "deal-1", "pi_send", {
      document: { ...projected, commercialAuthority: "legacy_unverified" },
      projectedDocumentAuthority: acceptingExactProjectionValidator
    }
  ), hasCode("authoritative_quote_required"));
});
```

In the mounted `server.ts` route test fixture, issue these writes against an acquisition Deal and assert `409 authoritative_quote_required`: PATCH commercial fields, stage to `已报价` or `成交`, POST `quote/won/lost` events, POST lost, arbitrary PI create, PI commercial patch, and PI revision. Historical `legacy_unverified` PI rows must also return 409 for submit-for-approval, approve, send, and export; they may only be read for audit. A valid `quote_projection` fixture with exact current/frozen Quote authority must be able to follow the original human submit/approve/send/export path, while a stale hash/revision, changed commercial field, wrong workspace, or missing human capability fails closed. Assert non-acquisition legacy Deal/PI writes still succeed. In acquisition router tests, POST a public `quoted`, `won`, or `lost` Outcome and assert `400 invalid_request`.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-deal-binding-test.ts src/commercial-authority-guard-test.ts src/acquisition-v1-router-test.ts src/acquisition-crm-outcome-reconciliation-test.ts`

Expected: FAIL because the extracted resolver/guard are absent and legacy routes still accept acquisition commercial writes.

- [ ] **Step 3: Extract the trusted resolver and implement the guard**

```ts
export interface QuoteProjectedDocumentAuthority {
  documentId: string;
  documentRevision: number;
  dealId: string;
  quoteCaseId: string;
  quoteVersionId: string;
  commercialAmountHash: `sha256:${string}`;
  dealAuthorityRevision: number;
}

export interface QuoteProjectedDocumentAuthorityValidator {
  assertAuthorized(
    context: ActiveWorkspaceContext,
    input: {
      documentId: string;
      action: "submit_approval" | "approve" | "send" | "export";
      expectedDocumentRevision: number;
    }
  ): Promise<QuoteProjectedDocumentAuthority>;
}

export class CommercialAuthorityError extends Error {
  readonly status = 409;
  readonly code = "authoritative_quote_required";
  constructor(readonly action: CommercialAuthorityAction) {
    super("获客商机必须通过正式 QuoteVersion 执行商业变更");
  }
}

export async function assertLegacyCommercialWriteAllowed(
  store: Pick<CrmStore, "acquisitionCustomerHandoffs" | "leads">,
  context: ActiveWorkspaceContext,
  dealId: string,
  action: CommercialAuthorityAction,
  options: {
    document?: TradeDocument;
    projectedDocumentAuthority?: QuoteProjectedDocumentAuthorityValidator;
  } = {}
) {
  if (!resolveTrustedAcquisitionDealBinding(store, { dealId })) return;
  if (["pi_submit_approval", "pi_approve", "pi_send", "pi_export"].includes(action)
    && options.document?.commercialAuthority === "quote_projection"
    && options.projectedDocumentAuthority) {
    const verified = await options.projectedDocumentAuthority.assertAuthorized(context, {
      documentId: options.document.id,
      expectedDocumentRevision: options.document.revision,
      action: ({
        pi_submit_approval: "submit_approval",
        pi_approve: "approve",
        pi_send: "send",
        pi_export: "export"
      } as const)[action as "pi_submit_approval" | "pi_approve" | "pi_send" | "pi_export"]
    });
    if (verified.dealId !== dealId || verified.documentId !== options.document.id) {
      throw new CommercialAuthorityError(action);
    }
    return;
  }
  throw new CommercialAuthorityError(action);
}
```

Remove the local resolver from `server.ts`, import the extracted function, and call the guard before every listed Deal or PI mutation/action endpoint. A PATCH that changes only `nextAction`, `nextActionAt`, or `expectedCloseAt` remains allowed; compare the parsed commercial fields against the stored Deal before rejecting. Normalize historical PI and DealEvent rows to `legacy_unverified` on read without mutating the stored historical record. Arbitrary PI create/commercial patch/revision always remain blocked for acquisition Deals; only Stage 2's publication port creates a `quote_projection` PI. Existing PI submit-for-approval/approve/send/export routes may continue solely after the injected Quote validator reloads the document and exact Deal authority, verifies `quote_projection + quoteCaseId + quoteVersionId + commercialAmountHash + dealAuthorityRevision`, checks the current human capability, and confirms no commercial field changed. No legacy route can upgrade `legacy_unverified` to `quote_projection`, and no AI/Pi tool receives this validator or document lifecycle capability. Before Quote is installed, a missing validator fails closed.

- [ ] **Step 4: Close the public Outcome bypass and create an internal identity**

```ts
export interface AcquisitionOutcomeWriteAuthority {
  capability: "acquisition.outcome.reconcile.internal";
  sourceStableKey: string;
}

const COMMERCIAL_OUTCOMES = new Set(["quoted", "won", "lost"] as const);
if (COMMERCIAL_OUTCOMES.has(raw.eventType as "quoted" | "won" | "lost")
  && authority?.capability !== "acquisition.outcome.reconcile.internal") {
  fail("capability_forbidden", "商业结果只能由 CRM Reconciler 写入", 403);
}
```

Construct the Reconciler recorder in `acquisition-application.ts` with the internal literal capability and `sourceStableKey=deal-event:<eventId>`. Do not put this capability in `SessionUser`, the Pi tool identity, or the HTTP workspace context. Until Stage 2 adds authoritative DealEvent fields, Reconciler records a diagnostic `commercial_authority_unverified` and skips commercial historical events; noncommercial events continue unchanged.

- [ ] **Step 5: Verify GREEN and broad acquisition regressions**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/acquisition-deal-binding-test.ts src/commercial-authority-guard-test.ts src/acquisition-v1-router-test.ts src/acquisition-domain-test.ts src/acquisition-crm-outcome-reconciliation-test.ts && npm run test:acquisition`

Expected: focused suites and the complete acquisition suite PASS; public commercial Outcome writes are absent, and legacy non-acquisition workflows remain usable.

- [ ] **Step 6: Commit**

```bash
git add backend/src/acquisition-deal-binding.ts backend/src/acquisition-deal-binding-test.ts backend/src/commercial-authority-guard.ts backend/src/commercial-authority-guard-test.ts backend/src/server.ts backend/src/types.ts backend/src/acquisition-v1-router.ts backend/src/acquisition-v1-router-test.ts backend/src/acquisition-domain-service.ts backend/src/acquisition-domain-test.ts backend/src/acquisition-crm-outcome-reconciliation.ts backend/src/acquisition-crm-outcome-reconciliation-test.ts backend/src/acquisition-application.ts
git commit -m "feat: enforce authoritative acquisition commercial writes"
```

### Task 0.4: Append-only catalog persistence skeleton and CommissionProduct migration

**Depends:** Foundation Task 0.3 and `2026-08-09-growth-contract-and-frontend.md` Task 3.

**Files:**
- Create: `backend/src/growth-money.ts`
- Create: `backend/src/growth-money-test.ts`
- Create: `backend/src/catalog-domain.ts`
- Create: `backend/src/catalog-repository.ts`
- Create: `backend/src/catalog-mysql-repository.ts`
- Create: `backend/src/catalog-mysql-repository-test.ts`
- Create: `backend/src/commission-catalog-migration.ts`
- Create: `backend/src/commission-catalog-migration-test.ts`
- Create: `backend/src/migrate-commission-products-to-catalog.ts`
- Modify: `backend/src/types.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Produces: `ISO_4217_EXPONENT_V1`, `currencyExponent(currency): number | null`, strict nonnegative `roundHalfUpDiv(numerator: bigint, denominator: bigint): bigint`, signed `roundSignedHalfUpDiv(numerator: bigint, denominator: bigint): bigint`, `ceilDiv(numerator: bigint, denominator: bigint): bigint`, nonnegative `safeMinor(value: bigint, field: string): number`, signed `safeSignedInteger(value: bigint, field: string): number`, and `multiplyQuantityMinor(unitMinor: number, quantityMicros: number, rounding: "half_up" | "ceil"): number` from the sole `growth-money.ts` implementation consumed by all later stages.
- Produces foundation records used unchanged by Stage 1: `CatalogItem`, `PricingPolicyVersion`, `PackageVersion`, and `PackageComponent` with the field names in the approved design.
- Produces: `CatalogRepository` with `appendCatalogItem`, `findCatalogItem`, `appendPricingPolicyVersion`, `findPricingPolicyVersion`, `appendPackageVersion`, `replaceDraftPackageComponents`, and transaction command methods implemented in Stage 1.
- Produces: `InMemoryCatalogRepository` and `MysqlCatalogRepository`; both preserve immutable policy/version rows.
- Extends: `CommissionProduct` with `catalogItemId?: string` and `catalogMigrationStatus?: "pending" | "migrated" | "repair_required"`.
- Produces: `CommissionProductCatalogLink { workspaceId; commissionProductId; catalogItemId; pricingPolicyVersionId; migratedAt }`.
- Produces: `CommissionCatalogMigrationRun { id; startedAt; completedAt; status; scanned; migrated; repairRequired; reportHash }` and immutable item results with exact failure codes.
- Produces: `CommissionCatalogMigrationService.preview(workspaceId)` and `.execute(workspaceId, actorId, idempotencyKey)`; execution creates one CatalogItem and one initial PricingPolicyVersion with `source="legacy_commission_product"` per valid product.
- Produces CLI: `npm run migrate:commission-catalog --workspace backend -- --workspace team-a --actor admin-id --idempotency migration-key`.
- Test-only `migrationFixture(overrides)` is defined locally in `commission-catalog-migration-test.ts` and returns the typed service/repository pair used below.

- [ ] **Step 1: Write the failing migration and dedicated-table tests**

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ceilDiv, currencyExponent, multiplyQuantityMinor, roundHalfUpDiv,
  roundSignedHalfUpDiv, safeMinor, safeSignedInteger
} from "./growth-money.js";

test("fixed-point money and ISO exponents are deterministic", () => {
  assert.equal(currencyExponent("JPY"), 0);
  assert.equal(currencyExponent("CNY"), 2);
  assert.equal(currencyExponent("KWD"), 3);
  assert.equal(currencyExponent("RMB"), null);
  assert.equal(multiplyQuantityMinor(333, 1_500_000, "half_up"), 500);
  assert.equal(multiplyQuantityMinor(1, 1, "ceil"), 1);
  assert.equal(roundHalfUpDiv(5n, 2n), 3n);
  assert.equal(roundSignedHalfUpDiv(1n, 2n), 1n);
  assert.equal(roundSignedHalfUpDiv(-1n, 2n), -1n);
  assert.equal(roundSignedHalfUpDiv(5n, 2n), 3n);
  assert.equal(roundSignedHalfUpDiv(-5n, 2n), -3n);
  assert.equal(roundSignedHalfUpDiv(-4n, 3n), -1n);
  assert.equal(safeSignedInteger(-30_000n, "roiBps"), -30_000);
  assert.equal(ceilDiv(1n, 1_000_000n), 1n);
  assert.throws(
    () => safeMinor(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "amount"),
    (error: unknown) => (error as { code?: string }).code
      === "amount_out_of_range"
  );
});
```

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CommissionCatalogMigrationService
} from "./commission-catalog-migration.js";
import { InMemoryCatalogRepository } from "./catalog-repository.js";

test("migration creates one traceable catalog item and initial policy", async () => {
  const repository = new InMemoryCatalogRepository();
  const service = new CommissionCatalogMigrationService({
    repository,
    products: async () => [{
      id: "cp-1", ownerId: "admin-1", teamId: "team-a",
      name: "标准服务", category: "服务", model: "标准",
      defaultPrice: 29800, costPrice: 8000, currency: "CNY",
      status: "active", remark: "", updatedAt: "2026-08-09T08:00:00.000Z"
    }],
    now: () => "2026-08-09T08:00:00.000Z",
    idFactory: (prefix) => `${prefix}-1`
  });
  const result = await service.execute(
    "team-a", "admin-1", "commission-migration-0001"
  );
  assert.equal(result.migrated, 1);
  const link = await repository.findCommissionProductLink("team-a", "cp-1");
  assert.ok(link);
  assert.equal(
    (await repository.findPricingPolicyVersion(
      "team-a", link.pricingPolicyVersionId
    ))?.source,
    "legacy_commission_product"
  );
});

test("invalid currency enters repair queue and cannot be quoted", async () => {
  const state = migrationFixture({ currency: "RMB" });
  const result = await state.service.execute(
    "team-a", "admin-1", "commission-migration-0002"
  );
  assert.equal(result.repairRequired, 1);
  assert.equal(result.items[0]?.code, "invalid_currency");
  assert.equal(await state.repository.findCommissionProductLink(
    "team-a", "cp-1"
  ), null);
});
```

Add a repository schema test asserting dedicated tables exist and no SQL statement references a generic payload replacement table:

```ts
assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS catalog_items/u);
assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS pricing_policy_versions/u);
assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS package_versions/u);
assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS package_components/u);
assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS commission_product_catalog_links/u);
assert.match(schemaSql, /CREATE TABLE IF NOT EXISTS commission_catalog_migration_runs/u);
assert.doesNotMatch(schemaSql, /replaceRows|persistAll/u);
```

- [ ] **Step 2: Run tests to verify RED**

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/growth-money-test.ts src/catalog-domain-contract-test.ts src/catalog-mysql-repository-test.ts src/commission-catalog-migration-test.ts`

Expected: FAIL because `growth-money.ts`, catalog repository, and migration modules do not exist.

- [ ] **Step 3: Define the stable catalog records and append-only repository**

```ts
export function roundHalfUpDiv(numerator: bigint, denominator: bigint) {
  if (numerator < 0n || denominator <= 0n) throw new RangeError("invalid ratio");
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

export function ceilDiv(numerator: bigint, denominator: bigint) {
  if (numerator < 0n || denominator <= 0n) throw new RangeError("invalid ratio");
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

export function roundSignedHalfUpDiv(
  numerator: bigint,
  denominator: bigint
) {
  if (denominator <= 0n) throw new RangeError("invalid ratio");
  return numerator < 0n
    ? -roundHalfUpDiv(-numerator, denominator)
    : roundHalfUpDiv(numerator, denominator);
}

export function safeSignedInteger(value: bigint, field: string) {
  const minimum = BigInt(Number.MIN_SAFE_INTEGER);
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (value < minimum || value > maximum) {
    throw Object.assign(new RangeError(field), { code: "amount_out_of_range" });
  }
  return Number(value);
}

export function multiplyQuantityMinor(
  unitMinor: number,
  quantityMicros: number,
  rounding: "half_up" | "ceil"
) {
  const numerator = BigInt(unitMinor) * BigInt(quantityMicros);
  return safeMinor(
    rounding === "ceil"
      ? ceilDiv(numerator, 1_000_000n)
      : roundHalfUpDiv(numerator, 1_000_000n),
    "quantity amount"
  );
}
```

Freeze the versioned ISO registry in this module and reject unsupported codes. `safeMinor` always rejects negative values and out-of-range monetary amounts; `safeSignedInteger` permits signed ratios such as negative ROI BPS but enforces the same safe integer bounds. No later stage creates another rounding, range, or currency-exponent implementation.

```ts
export interface CatalogItem {
  id: string;
  workspaceId: string;
  type: "product" | "service" | "package";
  code: string;
  name: string;
  description: string;
  unit: string;
  status: "active" | "retired";
  revision: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type ApprovalCapability =
  | "quote.confirm"
  | "quote.exception.discount.approve"
  | "quote.exception.margin.approve"
  | "quote.exception.payment_terms.approve"
  | "quote.exception.gift.approve"
  | "quote.exception.credit.approve"
  | "quote.exception.manual.approve";

export interface ApprovalThresholds {
  discountCapability: ApprovalCapability;
  marginCapability: ApprovalCapability;
  paymentTermsCapability: ApprovalCapability;
  giftCapability: ApprovalCapability;
  creditCapability: ApprovalCapability;
  manualCapability: ApprovalCapability;
  creditRiskThresholdBps: number;
  manualEscalationEnabled: boolean;
}

export interface SurchargePolicy {
  kind: "region" | "delivery" | "payment_term";
  condition: string;
  fixedAmountMinor: number;
  unitAmountMinor: number;
}

export interface GiftPolicy {
  catalogItemId: string;
  unitStandardCostMinor: number;
  standardQuantityMicros: number;
  absoluteQuantityMicros: number;
  standardCostLimitMinor: number;
  absoluteCostLimitMinor: number;
}

export interface PricingPolicyVersion {
  id: string;
  workspaceId: string;
  catalogItemId: string;
  version: number;
  packageVersionId: string | null;
  currency: string;
  listUnitPriceMinor: number;
  unitStandardCostMinor: number;
  defaultOrderDeliveryCostMinor: number;
  defaultOrderSalesCostMinor: number;
  defaultOrderServiceCostMinor: number;
  absoluteFloorUnitPriceMinor: number;
  standardDiscountLimitBps: number;
  absoluteDiscountLimitBps: number;
  targetGrossMarginBps: number;
  absoluteMinimumGrossMarginBps: number;
  standardPaymentTermDays: number;
  absolutePaymentTermDays: number;
  approvalThresholds: ApprovalThresholds;
  surchargePolicies: readonly SurchargePolicy[];
  giftPolicies: readonly GiftPolicy[];
  validFrom: string;
  validTo: string | null;
  status: "draft" | "active" | "retired";
  source: "native" | "legacy_commission_product";
  capabilityRegistryVersion: string;
  revision: number;
  createdBy: string;
  createdAt: string;
}
```

Define `PackageVersion`, `PackageComponent`, the exact closed approval-threshold, surcharge, and gift objects above, migration link/run/item records, and immutable clone-on-read behavior in the same domain/repository files. `capabilityRegistryVersion` is internal persisted audit metadata and every later DTO projector omits it. Stage 1 reuses these exported names without introducing a second catalog model.

- [ ] **Step 4: Implement safe migration and freeze the legacy-link authority**

Convert legacy decimal unit values to minor units only when `currency` is an ISO code and the decimal has no precision beyond that currency's fixed exponent. Preserve the original product snapshot and its SHA-256 in each migration result. Map price/cost to unit minor values, set order costs to zero, set absolute floor to cost, copy the legacy enabled state into CatalogItem active/retired, and leave the PricingPolicyVersion as `draft` until an admin reviews and activates it in Stage 1. A rerun with the same key returns the existing run; a different snapshot under the same key conflicts.

`CatalogRepository` exposes the exact immutable link/policy reader needed by the later Catalog module: `findCommissionProductLink(workspaceId, commissionProductId)` and `findPricingPolicyVersion(workspaceId, pricingPolicyVersionId)`. This task does not wire legacy HTTP routes or construct a catalog repository in the C0 application kernel. Catalog Task 2 owns the one runtime repository and projects a narrow `CommissionCatalogProjectionPort` to `server.ts`; only there do migrated products reject legacy price/cost/currency writes and read through the linked policy. Keeping that wiring in the Catalog module prevents a second repository/service graph during the Foundation stage.

- [ ] **Step 5: Register schemas, CLI, and verify GREEN**

Add these exact scripts to `backend/package.json` only after every referenced test file exists:

```json
{
  "scripts": {
    "migrate:commission-catalog": "tsx src/migrate-commission-products-to-catalog.ts",
    "test:growth-foundation": "NODE_ENV=test node --import tsx --test --test-concurrency=1 src/growth-capabilities-test.ts src/growth-workspace-context-test.ts src/growth-workspace-settings-test.ts src/growth-workspace-settings-mysql-repository-test.ts src/growth-as-of-test.ts src/growth-temporal-barrier-test.ts src/growth-temporal-barrier-mysql-repository-test.ts src/growth-http-idempotency-repository-test.ts src/growth-http-idempotency-mysql-repository-test.ts src/growth-http-preconditions-test.ts src/growth-foundation-module-test.ts src/acquisition-deal-binding-test.ts src/commercial-authority-guard-test.ts src/growth-money-test.ts src/catalog-domain-contract-test.ts src/commission-catalog-migration-test.ts",
    "test:growth-foundation:mysql": "NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 src/growth-foundation-mysql-integration-test.ts"
  }
}
```

The migration CLI constructs one short-lived `MysqlCatalogRepository`, runs `ensureCatalogMysqlSchema(pool)`, executes the requested migration, prints only the immutable run summary, and closes its pool. Memory repositories are test-only. Do not add catalog arrays to `CrmStore`, do not edit `growth-commercial-application.ts`, and do not install a runtime module in this task; Catalog Task 2 creates the sole long-lived repository/service graph through `createGrowthCatalogModule`.

Run: `cd backend && NODE_ENV=test node --import tsx --test --test-concurrency=1 src/growth-money-test.ts src/catalog-domain-contract-test.ts src/catalog-mysql-repository-test.ts src/commission-catalog-migration-test.ts && npm run test:growth-foundation && npm run build`

Expected: repository, migration, complete foundation suite, and build PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/growth-money.ts backend/src/growth-money-test.ts backend/src/catalog-domain.ts backend/src/catalog-repository.ts backend/src/catalog-mysql-repository.ts backend/src/catalog-mysql-repository-test.ts backend/src/commission-catalog-migration.ts backend/src/commission-catalog-migration-test.ts backend/src/migrate-commission-products-to-catalog.ts backend/src/types.ts backend/package.json
git commit -m "feat: add append-only catalog migration foundation"
```

## Final verification

- [ ] Run the complete Stage 0 gate:

```bash
npm run check:growth-contracts
npm run test:growth-foundation --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:growth-foundation:mysql --workspace backend
npm run test:security --workspace backend
npm run test:acquisition --workspace backend
npm run build --workspace backend
git diff --check
```

Expected: every command exits 0; no generated contract drift, workspace bypass, public commercial Outcome write, acquisition Deal/PI legacy commercial write, or catalog `persistAll/replaceRows` integration remains.

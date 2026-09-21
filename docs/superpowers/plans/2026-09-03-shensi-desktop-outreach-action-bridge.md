# Shensi Desktop Outreach Action Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move human-approved Douyin comments and private messages from the central Backend Worker/remote Sidecar path to a fenced desktop pull protocol in which Electron Main claims immutable actions, executes them through the local Sidecar and durable Profile, and reports idempotent receipts to the central API.

**Architecture:** The central Backend remains the approval, policy, quota, device-binding, lease, action-state, and receipt authority. Electron Main owns device credentials and a `DesktopOutreachActionCoordinator`; it recovers the local Douyin identity, claims only actions bound to that installation, calls the loopback Sidecar, and submits a sanitized receipt. The existing server worker and current Sidecar comment/DM executors remain available behind explicit `server` and `desktop` execution targets so migration cannot create competing consumers.

**Tech Stack:** Node.js 22.22.3, TypeScript 5.7.2, Express, Zod, MySQL 8/InnoDB, Electron 44.1.1, Python 3.11, FastAPI 0.110.2, Pydantic 2.13.4, Playwright 1.61+, pnpm 11.18.0, Node test runner, pytest.

**Spec:** `docs/superpowers/specs/2026-09-03-shensi-desktop-only-api-migration-design.md`

## Global Constraints

- Preserve every tracked and untracked user change. The current desktop migration exists only in the shared dirty workspace, so execute task-scoped edits in that workspace after recording `git status --short`; never reset, clean, stash, checkout over, stage, or commit unrelated work. Do not create an isolated worktree unless the current uncommitted migration has first been materialized there without data loss and that move is separately reviewed.
- The only user UI is the latest `frontend/` build inside Electron. Do not restore an older frontend and do not delete `frontend/`.
- Renderer business requests continue through same-origin `/api`; Renderer never receives a Sidecar token, Sidecar port, Profile path, Cookie, long-term device credential, action task capability, lease token, arbitrary selector, command, path, URL, or script capability.
- Electron Main is the only owner of the local Sidecar, device credential, action coordinator, and local action recovery journal.
- Desktop Douyin work uses the local external visible Chromium and the same persistent Profile. It never uses Xvfb, VNC, websockify, noVNC, `/live-sessions`, iframe, webview, or a remote browser canvas.
- Backend and MySQL remain central. Do not package Backend, MySQL, Docker, Redis, or business secrets into `Shensi.app`.
- Never upload Douyin Cookies, browser storage, Profile data, screenshots, Sidecar token/port, or local filesystem paths.
- Comment and private-message approvals remain two independent human confirmations. A private message still requires its exact successful predecessor-comment receipt and its independently frozen version-2 approval.
- Automated tests use fakes only and must never invoke a live Douyin write. A live comment or private message requires a later, explicit user-selected target and content.
- No slider/CAPTCHA bypass, fingerprint spoofing, hidden write path, or automatic repeat after a possibly completed platform write.
- One action may enter the platform-write phase at most once automatically. `claimed` expiry may requeue only before the central `started` transition; `executing` expiry becomes `reconciliation_required`.
- Enrollment tokens expire after 60 seconds and are single-use. Device credentials are 256-bit random values stored by a Keychain-backed Main-process credential store; the Backend stores only domain-separated hashes.
- Device binding lease is 90 seconds and is renewed by each authenticated claim poll; no-work polling waits 3–5 seconds, while transport failures back off from 2 seconds to at most 60 seconds.
- The action deadline remains `DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS` (30–300, default 120) plus 30 seconds. The central lease is the action deadline plus a further 30-second receipt-upload allowance.
- Existing private-message daily default stays 20 and the accepted range stays 1–100. Existing comment spacing, DM spacing, predecessor, DNC, evidence, content-hash, target, account, and login-version checks remain central authority.
- Historical actions without `executionTarget` remain `server` and are never silently moved to a desktop device. Before server execution is retired, every such non-terminal action must either finish through the still-enabled historical path or be resolved through an explicit audited operator workflow; migration/cutover preflight fails while any remain.
- Current black/gray/green visual tokens, responsive layout, normal document scrolling, and action-card information hierarchy remain unchanged.
- Current Web/noVNC code remains present and isolated behind the web/remote mode until the separate retirement plan is executed.
- Update README, architecture, status, API index, acquisition module, desktop guide, deployment/configuration, and Sidecar provenance documentation truthfully before declaring the bridge implementation complete: pre-accept documents call it staged/disabled and preserve the actual Trial operating path; present-tense API-only/Web-retired claims activate only at the later receipt gates.
- The plan-authoring turn creates only this document. A later implementation session may change only the reviewed task-owned files and still must not stage or commit unrelated work.

---

## Locked protocol decisions

### Public central endpoints

```text
POST /api/v1/acquisition/desktop-installations/enrollments
POST /api/v1/acquisition/desktop-installations/register
POST /api/v1/acquisition/social-accounts/{accountId}/desktop-binding
POST /api/v1/acquisition/desktop-outreach-actions/claim
POST /api/v1/acquisition/desktop-outreach-actions/{actionId}/complete
POST /api/v1/acquisition/desktop-outreach-actions/{actionId}/reconcile
```

- `enrollments` and `desktop-binding` use the authenticated Renderer session, active workspace, CSRF protection, capability checks, `Idempotency-Key`, and strict JSON.
- `register` is authenticated only by the 60-second single-use enrollment token bound to its installation/workspace/user/protocol tuple; no device credential exists yet. `claim`, `complete`, and desktop `reconcile` use `X-Shensi-Desktop-Installation-Id` plus `X-Shensi-Desktop-Device-Token`. Device authentication resolves a workspace/user/team principal and rechecks that the user and workspace membership remain active; these routes do not accept browser cookies as device proof.
- `complete` accepts a strict discriminated command. `{ event: "started" }` moves `claimed -> executing` before Main invokes the Sidecar. `{ event: "receipt" }` persists a terminal or reconciliation receipt. This keeps the public endpoint set minimal while making `claimed` and `executing` observably distinct.
- The existing user route `POST /outreach-batches/{batchId}/actions/{actionId}/reconcile` becomes a manual reconciliation request in desktop mode; it never calls a remote Sidecar. The device `reconcile` endpoint may also recover the same device's own persisted in-flight action automatically after a crash. Normal same-process reconciliation uses the original fence. Post-restart recovery submits the durable action/request/lease/binding/login snapshot; central authority verifies it against the original execution record, then issues a new process-bound recovery fence that is read-only and cannot call the write executor.

### Device and task headers

```text
X-Shensi-Desktop-Installation-Id: <43-character base64url installation id>
X-Shensi-Desktop-Device-Token: <43-character base64url credential>
X-Shensi-Desktop-Task-Token: <base64url action/fence capability>
X-Shensi-Desktop-Build-Manifest-SHA256: <64 lowercase hex characters>
Idempotency-Key: <8..200 characters>
```

The installation ID and build-manifest digest are non-secret compatibility identities; neither replaces session, CSRF, device, task-token, tenant, or authorization checks. The device token and task token must be redacted from logs and error bodies. Main stores the long-term device token through Electron `safeStorage`; on macOS its encryption key is protected by Keychain, and only encrypted ciphertext is written below Electron `userData` with mode `0600`.

Electron Main reads the strict packaged `Contents/Resources/desktop-build-manifest.json` once and supplies its exact canonical-file SHA-256 to both the same-origin Renderer proxy and `DesktopCentralApiClient`. `renderer-server.ts` always removes a Renderer-provided `X-Shensi-Desktop-Build-Manifest-SHA256` before setting the Main-owned value; the Renderer cannot select or override an admitted build. The Backend admission modes are exactly `migration_locked` and `exact`: `migration_locked` rejects every business mutation plus enrollment, registration, binding, claim, complete, and reconcile before a repository/service call; `exact` requires the header to equal the one active-version digest for those paths. Login/logout and reads remain governed by their existing authentication/read-only policy. The normal Gateway applies the same mode/digest check as defense in depth, while the Backend remains authoritative. This public digest prevents accidental stale-client use but is not presented as a local-hostile-process security secret.

### Cross-language hashes

- Canonical target algorithm ID is exactly `douyin-target-url-v1`. Only the central Backend runs it, using Node's WHATWG `URL` parser and serializer. It first rejects credentials, every raw/percent-encoded C0 or NUL byte, backslash, encoded `/` or `\\`, malformed percent triplets, any raw path segment whose single percent-decoding is `.` or `..`, and any path/query component whose single percent-decoding still contains a `%HH` triplet (double-decode ambiguity). It then requires scheme `https`, no non-default port, and the post-WHATWG ASCII hostname exactly `www.douyin.com`; Unicode or look-alike host input is rejected even if punycode conversion produces a different host. The final path must be exactly `/video/<1..300 ASCII letters, digits, underscore, or hyphen>` for comments or `/user/<same token>` for private messages. A single trailing slash is removed; every other path shape is rejected.
- `douyin-target-url-v1` removes fragments and the HTTPS default port, uses the WHATWG-serialized path/query, uppercases hexadecimal letters in every retained percent triplet, and never decodes then re-encodes application data. Query pairs are not sorted: duplicate pairs, empty names/values, empty segments, and their original serialized order are retained exactly; an explicit empty `?` is retained. A second canonicalization must return the byte-identical string. The Backend freezes this result as `canonicalTargetPublicUrl`; it is the only target string hashed or sent to Electron/Sidecar. Electron and Python validate the exact canonical string plus algorithm ID against shared vectors and must reject rather than normalize a non-canonical value.
- `occurredAt` is produced only as canonical UTC RFC3339 with exactly three fractional digits and `Z` (`YYYY-MM-DDTHH:mm:ss.sssZ`). Parsers accept no alternate serialization on the signed protocol boundary; a Sidecar `datetime` must be converted to this canonical string before hashing or model serialization.
- `requestHash` is 64 lowercase hex characters over UTF-8 canonical JSON with lexicographically ordered keys `account_handle`, `action_id`, `approved_content_hash`, `canonical_target_public_url`, `content`, `kind`, and `login_state_version`; JSON uses no insignificant whitespace and does not include the deadline.
- `receiptHash` is 64 lowercase hex characters over UTF-8 canonical JSON with lexicographically ordered keys `action_id`, `failure_code`, `occurred_at`, `platform_receipt_reference`, and `state`; nullable values are explicit JSON `null`.
- Add identical fixed vectors to Backend, Electron, and Python for Unicode comment/DM content, trailing slash, percent encoding, query order, `Z` versus `+00:00`, and fractional precision. Invalid alternate timestamp or non-canonical target vectors fail before a hash is accepted. None of the three implementations may invent its own serializer, URL canonicalizer, or timestamp representation.

### Action state and recovery rules

```text
blocked_by_predecessor --(predecessor succeeded with exact receipt)--> queued
blocked_by_predecessor --(predecessor terminal non-success)-----------> failed(predecessor_failed)
queued -> claimed -> executing -> succeeded
                         |------> failed
                         |------> risk_paused
                         |------> reconciliation_required

claimed lease expiry  -> queued
executing lease expiry -> reconciliation_required
```

Only direct-message actions use `blocked_by_predecessor`. They are ineligible for every server/desktop claim until the exact predecessor comment succeeds with the frozen receipt; predecessor success releases them to `queued` atomically, while predecessor terminal non-success marks them `failed` with `predecessor_failed`. Sweep/cleanup logic may not silently skip, requeue, or execute a blocked dependent.

- A claim increments lease/fencing generation but does not increment `platformWriteAttemptCount`.
- The idempotent `started` command reserves `platformWriteAttemptCount` by changing it from 0 to 1. A second start with a different request hash is rejected; a second start with the same hash is replayed.
- `douyin_profile_busy` returned by the trusted Sidecar proves its `started` journal was not written. Central completion may therefore return the action to `queued` with bounded backoff and atomically restore `platformWriteAttemptCount` to 0; no other result can roll that counter back.
- `action_unavailable`, `douyin_action_timeout`, and `douyin_action_receipt_ambiguous` after `started` become `reconciliation_required`; they never return to `queued` automatically.
- A completed receipt with the same action, fence, device, binding generation, request hash, and receipt hash replays the original response. A different receipt conflicts.
- Explicit handoff is rejected while the account has `claimed`, `executing`, or `reconciliation_required` actions. Forced cleanup of an unresolved action remains an existing/manual risk-recovery decision, not an implicit handoff side effect.

## File responsibility map

### Central domain and persistence

- `backend/src/acquisition-outreach-batch.ts`: action target/status/public shape and canonical hashes.
- `backend/src/acquisition-outreach-action-authority.ts`: one reusable authority resolver shared by the server worker and desktop claim service.
- `backend/src/acquisition-outreach-action-worker.ts`: server-target worker and shared receipt classification.
- `backend/src/acquisition-outreach-batch-repository.ts`: Memory repository plus server/desktop claim, fence, start, completion, recovery, and reconciliation contracts.
- `backend/src/acquisition-outreach-batch-mysql-repository.ts`: InnoDB locking, target-filtered claims, fenced transitions, attempt ledger, and exact completion replay.
- `backend/src/acquisition-desktop-installation.ts`: installation/enrollment/binding domain types and hashes.
- `backend/src/acquisition-desktop-installation-repository.ts`: Memory installation, enrollment, device-authentication, and executor-binding repository.
- `backend/src/acquisition-desktop-installation-mysql-repository.ts`: MySQL implementation and schema upgrades for those records.
- `backend/src/acquisition-desktop-installation-service.ts`: 60-second one-time enrollment, registration, device authentication, binding, renewal, and handoff policy.
- `backend/src/acquisition-desktop-outreach-sync.ts`: device claim/start/receipt/reconciliation application service.
- `backend/src/acquisition-desktop-outreach-sync-router.ts`: strict user/device HTTP boundaries and error mapping.

### Desktop and Sidecar

- `desktop/src/main/device-installation.ts`: stable random installation ID and process-instance ID.
- `desktop/src/main/device-credential-store.ts`: Keychain-backed encrypted credential persistence.
- `desktop/src/main/desktop-central-api-client.ts`: bounded, no-redirect central device API client.
- `desktop/src/main/outreach-action-journal.ts`: atomic, sanitized local recovery metadata without content or capabilities.
- `desktop/src/main/outreach-action-coordinator.ts`: state machine that restores identity, claims, starts, executes, completes, reconciles, and shuts down.
- `desktop/src/main/sidecar-client.ts`: strict local identity/action/acknowledgement client.
- `desktop/src/main/desktop-ipc.ts`, `desktop/src/preload/desktop-api.ts`, and shared contracts: enrollment/context/status-only Renderer bridge; no arbitrary action execution IPC.
- `services/media-crawler/shensi_adapter/accounts.py`: resolve a persisted account identity by stable account key.
- `services/media-crawler/shensi_adapter/action_jobs.py`: retain exact replay and expose acknowledgement of a centrally durable completed journal.
- `services/media-crawler/shensi_adapter/app.py`: bearer-protected local identity and acknowledgement routes.
- `services/media-crawler/shensi_adapter/runtime_config.py` and `desktop_entrypoint.py`: explicit desktop-action capability independent of the server-action flag.

### Renderer, contracts, and current documentation

- `contracts/openapi/ai-acquisition.v1.yaml`, `backend/src/acquisition-openapi.ts`, and generated frontend types: one authoritative protocol.
- `frontend/src/desktop/desktop-runtime.ts`: enrollment, workspace context, and coordinator status adapter.
- `frontend/src/acquisition/outreach-batch-*`: current approval and receipt UI adapted to desktop action states.
- `frontend/src/conversations/real-*`: shared action status/confirmation behavior without a parallel implementation.
- Current README/architecture/status/API/acquisition/desktop/deployment/Sidecar provenance documents: present-tense operating truth.

---

### Task 1: Freeze action execution target, add desktop states, and split feature gates

**Files:**
- Create: `contracts/fixtures/desktop-outreach-hashes.v1.json`
- Create: `contracts/test/desktop-outreach-hash-fixture.test.mjs`
- Create: `backend/src/acquisition-outreach-target-url.ts`
- Create: `backend/src/acquisition-outreach-target-url-test.ts`
- Create: `backend/src/acquisition-outreach-action-authority.ts`
- Create: `backend/src/acquisition-outreach-action-authority-test.ts`
- Modify: `backend/src/acquisition-outreach-batch.ts`
- Modify: `backend/src/acquisition-outreach-batch-service.ts`
- Modify: `backend/src/acquisition-outreach-batch-test.ts`
- Modify: `backend/src/acquisition-outreach-action-worker.ts`
- Modify: `backend/src/acquisition-outreach-action-worker-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-mediacrawler-server-configuration-test.ts`
- Modify: `backend/src/acquisition-outreach-batch-repository.ts`
- Modify: `backend/src/acquisition-outreach-batch-mysql-repository.ts`
- Modify: `backend/src/acquisition-outreach-batch-mysql-repository-test.ts`
- Modify: `backend/src/server.ts`

**Interfaces:**
- Produces `AcquisitionOutreachActionExecutionTarget = "server" | "desktop"` and adds `executionTarget` to every newly created `AcquisitionOutreachAction`. Task 1 accepts the target as an explicit action-creation argument and does not depend on the social-account executor fields introduced by Task 3.
- Extends action status with `claimed` and `reconciliation_required`; historical payloads without `executionTarget` parse as `server` and remain outside desktop claims.
- Produces an authority-scoped count/list query for non-terminal historical/server actions so cutover tooling can fail closed without exposing action content.
- Produces `DouyinOutreachFeatureFlags` and `resolveDouyinOutreachFeatureFlags(env,gateway)`; approval is never inferred from gateway presence.
- Produces `createAcquisitionOutreachActionAuthority(options)` with `resolve(action, actorId): Promise<OutreachActionAuthority | null>` so server and desktop consumers run identical batch/evidence/DNC/account/login checks.
- Server worker calls `claimNextAction({ executionTarget: "server", ... })` and cannot see desktop actions.

- [x] **Step 1: Write failing domain and gate tests**

Create the versioned cross-language fixture with `canonicalizerVersion: "douyin-target-url-v1"`, one Unicode comment request/receipt, and one private-message request/receipt, including raw input, exact canonical target, exact canonical JSON, request hash, and receipt hash. Add accepted/rejected URL vectors for a removable trailing slash, lowercase percent hex, duplicate and empty ordered query pairs, explicit empty `?`, credentials, Unicode/look-alike hosts, default/non-default ports, fragments, raw/encoded slash or backslash, malformed triplets, C0/NUL, raw/encoded dot segments, double-decode ambiguity, and wrong action/path kind. Make the contract test reject extra keys, non-lowercase hashes, a changed canonical payload, or an unknown canonicalizer version.

```ts
test("historical actions are server-only and an explicit new target is frozen", () => {
  assert.equal(parseAcquisitionOutreachAction(historicalPayload).executionTarget, "server");
  assert.equal(buildApprovedAction({ executionTarget: "desktop" }).executionTarget, "desktop");
});

test("approval and each execution mode are independent", () => {
  assert.deepEqual(resolveDouyinOutreachFeatureFlags({
    approvals: "true", serverExecution: "false", desktopExecution: "true"
  }, null), { approvalsEnabled: true, serverExecutionEnabled: false,
    desktopExecutionEnabled: true });
});
```

- [x] **Step 2: Run the focused red tests**

Run:

```bash
pnpm --dir backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-outreach-batch-test.ts \
  src/acquisition-outreach-action-worker-test.ts \
  src/acquisition-outreach-action-authority-test.ts \
  src/acquisition-outreach-target-url-test.ts \
  src/acquisition-mediacrawler-server-configuration-test.ts
```

Expected: failures identify the missing target/status types, coupled action flag, absent authority module, and unfiltered worker claim.

- [x] **Step 3: Add the minimal domain and gate implementation**

```ts
export type AcquisitionOutreachActionExecutionTarget = "server" | "desktop";
export type AcquisitionOutreachActionStatus =
  | "queued" | "blocked_by_predecessor" | "claimed" | "executing"
  | "succeeded" | "failed" | "risk_paused" | "reconciliation_required";

export interface DouyinOutreachFeatureFlags {
  approvalsEnabled: boolean;
  serverExecutionEnabled: boolean;
  desktopExecutionEnabled: boolean;
}
```

Read the exact three environment values, reject non-boolean strings, and fail startup when server execution is enabled without a gateway. In this task, action construction receives an explicit validated execution target so it compiles and can be tested without Task 3's account schema. Task 3 wires the account's authoritative executor mode into this argument: `desktop` requires desktop execution enabled; an unbound historical account uses `server` only while server execution is enabled.

- [x] **Step 4: Extract and reuse authority validation**

Move the authority logic currently embedded in `acquisition-application.ts:2801-2876` without weakening any check. Inject the resolver into the existing server worker and later desktop service. Keep actor/scope selection explicit so a desktop device cannot substitute a different workspace or account.

- [x] **Step 5: Run focused and aggregate backend verification**

```bash
pnpm --dir backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-outreach-batch-test.ts \
  src/acquisition-outreach-action-worker-test.ts \
  src/acquisition-outreach-action-authority-test.ts \
  src/acquisition-outreach-target-url-test.ts \
  src/acquisition-mediacrawler-server-configuration-test.ts
pnpm test:contracts
pnpm --filter ./backend build
```

Expected: all focused tests pass; build reports no unhandled action target or status branch.

---

### Task 2: Add one-time enrollment and durable desktop installation identity

**Files:**
- Create: `backend/src/acquisition-desktop-installation.ts`
- Create: `backend/src/acquisition-desktop-installation-repository.ts`
- Create: `backend/src/acquisition-desktop-installation-mysql-repository.ts`
- Create: `backend/src/acquisition-desktop-installation-service.ts`
- Create: `backend/src/acquisition-desktop-installation-test.ts`
- Create: `backend/src/acquisition-desktop-installation-mysql-repository-test.ts`
- Create: `backend/test/acquisition-desktop-installation-mysql-test-support.ts`
- Create: `scripts/verify-desktop-action-storage.mjs`
- Create: `scripts/verify-desktop-action-storage.test.mjs`
- Modify: `scripts/api-only-runtime.mjs`
- Modify: `scripts/api-only-runtime.test.mjs`
- Modify: `package.json`
- Modify: `backend/schema.mysql.sql`
- Modify: `backend/goodjob_crm.full.sql`

**Interfaces:**
- `desktopInstallationIdHash(id)` uses `sha256("shensi-desktop-installation\0" + id)` and returns `sha256:<64 lowercase hex>`.
- `desktopDeviceCredentialHash(credential)` uses a distinct `shensi-desktop-device-credential` domain separator.
- `AcquisitionDesktopInstallationService.createEnrollment(scope,input,key,requestHash)` accepts protocol version `1`, a 43-character base64url installation ID, and returns one 43-character base64url token expiring exactly 60 seconds later.
- `register(input)` consumes the enrollment once and returns one 43-character credential exactly once.
- `authenticate(input)` returns `{ workspaceId, userId, teamId, deviceIdHash, protocolVersion }` only for an active installation and current active membership.
- `verify-desktop-action-storage.mjs` accepts only the fixed suites `installation`, `binding`, `actions`, and `all`. It acquires the API plan's cross-process `disposable-5628-3312` lock before inspecting port `3312`, starts only a run-scoped disposable API-only MySQL project with fresh secrets/network/volume, injects `MYSQL_TEST_ADMIN_URL` plus an unguessable matching lock nonce into a fixed test whitelist, and destroys only that owned project/volume in `finally`. The low-level MySQL tests reject execution unless the nonce matches the live lock record. Root aliases are `api:verify:desktop-action-storage:installation`, `:binding`, `:actions`, and `:all`; none may use the retained API-only or Trial database.

- [x] **Step 1: Write failing Memory service tests**

```ts
test("enrollment is workspace-scoped, expires after sixty seconds, and is single-use", async () => {
  const enrollment = await service.createEnrollment(scope, installationInput, key, requestHash);
  const registered = await service.register({
    installationId, enrollmentToken: enrollment.token, protocolVersion: 1
  });
  assert.match(registered.deviceToken, /^[A-Za-z0-9_-]{43}$/u);
  await assert.rejects(() => service.register({
    installationId, enrollmentToken: enrollment.token, protocolVersion: 1
  }), /desktop_enrollment_consumed/u);
});
```

Cover expired token, wrong installation, wrong workspace, replayed enrollment command, request-hash conflict, revoked user/membership, wrong device token, protocol mismatch, timing-safe token comparison, and sanitized errors.

- [x] **Step 2: Run the focused red tests**

```bash
pnpm --dir backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-desktop-installation-test.ts \
  src/acquisition-desktop-installation-mysql-repository-test.ts
```

Expected: imports fail because the installation domain, repositories, and service do not exist.

- [x] **Step 3: Implement the domain and Memory repository**

```ts
export interface DesktopInstallationPrincipal {
  workspaceId: string;
  userId: string;
  teamId: string;
  deviceIdHash: string;
  protocolVersion: 1;
}

export interface DesktopInstallationRepository {
  createEnrollment(input: DesktopEnrollmentRecord): Promise<"created" | "replayed" | "conflict">;
  consumeEnrollment(input: ConsumeDesktopEnrollmentInput): Promise<DesktopInstallationRecord>;
  authenticate(input: AuthenticateDesktopInstallationInput): Promise<DesktopInstallationRecord | null>;
  revoke(workspaceId: string, deviceIdHash: string, revokedAt: string): Promise<boolean>;
}
```

Store only enrollment-token, device-ID, and device-credential hashes. Make response replay deterministic without persisting a plaintext token or credential; an enrollment-command replay returns its already issued token only while the service's protected replay record can deterministically derive it from the server secret.

- [x] **Step 4: Implement InnoDB tables and fenced consumption**

Create `acquisition_desktop_installation_enrollments` and `acquisition_desktop_installations`. Lock the enrollment row `FOR UPDATE`, check unused/expiry/workspace/device/protocol, mark it consumed, and insert/update the installation atomically. Add indexes for workspace/device lookup and expiry cleanup; add upgrade-column checks following existing repository conventions.

- [ ] **Step 5: Run Memory/MySQL tests and schema checks**

```bash
node --test scripts/verify-desktop-action-storage.test.mjs
pnpm --dir backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-desktop-installation-test.ts
pnpm api:verify:desktop-action-storage:installation
pnpm --filter ./backend build
```

Expected: Memory and owner-lock tests pass. MySQL tests receive `MYSQL_TEST_ADMIN_URL` only for the lock-owned disposable MySQL on `127.0.0.1:3312`, create a fresh random database matching `^goodjob_desktop_installation_[a-f0-9]{32}$`, explicitly reject database names `shensi` and `shensi_trial`, and drop only that exact test database in `finally`. Concurrent consume produces exactly one credential. The tests fail rather than fall back to `DATABASE_URL`, retained API-only MySQL, or Trial MySQL; no disposable project, volume, network, runtime root, or owner lock remains.

Non-live completion status: the focused suite passes 20/20, verifier fakes pass
6/6, API-only lifecycle regressions pass 87/87, contracts pass 102/102, the
Backend production import closure and build pass, and independent review is
approved with no blocker/major/minor finding. The lock-owned disposable MySQL
command remains intentionally unrun until that live resource lifecycle is
separately authorized, so Step 5 stays open while Task 3 implementation proceeds.

---

### Task 3: Bind one Douyin account to one installation with a fenced generation

**Files:**
- Modify: `backend/src/acquisition-social-account.ts`
- Modify: `backend/src/acquisition-social-account-repository.ts`
- Modify: `backend/src/acquisition-social-account-mysql-repository.ts`
- Modify: `backend/src/acquisition-social-account-service.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-outreach-batch-service.ts`
- Modify: `backend/src/acquisition-outreach-batch-repository.ts`
- Modify: `backend/src/acquisition-outreach-batch-mysql-repository.ts`
- Modify: `backend/src/acquisition-outreach-batch-test.ts`
- Modify: `backend/src/acquisition-outreach-batch-mysql-repository-test.ts`
- Modify: `backend/src/acquisition-social-account-test.ts`
- Modify: `backend/src/acquisition-social-account-mysql-repository-test.ts`
- Modify: `backend/src/acquisition-desktop-installation-repository.ts`
- Modify: `backend/src/acquisition-desktop-installation-mysql-repository.ts`
- Modify: `backend/src/acquisition-desktop-installation-service.ts`
- Modify: `backend/src/acquisition-desktop-installation-test.ts`
- Modify: `backend/schema.mysql.sql`
- Modify: `backend/goodjob_crm.full.sql`

**Interfaces:**
- Private social-account fields are `executorMode`, `executorDeviceIdHash`, `executorBindingGeneration`, and `executorLeaseExpiresAt`; public account views never expose the device hash.
- `bindDesktopExecutor(scope,accountId,input,key,requestHash)` accepts exact account handle/login version proof, installation ID, expected generation, and `handoff: boolean`.
- First binding sets generation `1`; idempotent renewal by the same device keeps the generation; explicit handoff increments it by exactly one.
- `renewDesktopExecutor(principal,bindings,now)` extends matching leases to `now + 90 seconds` and never changes generation.
- Disconnect, login-version change, installation revocation, or invalid identity makes old claims ineligible immediately.
- Batch action creation resolves the private account executor mode under the same workspace/account authority and passes the resulting explicit `executionTarget` into Task 1's constructor. This is the only production wiring from account binding to the frozen action target.

- [x] **Step 1: Write failing binding and handoff tests**

```ts
test("a second Mac cannot silently replace the bound executor", async () => {
  const first = await service.bindDesktopExecutor(scope, account.id,
    bindInput(deviceA, 0, false), keyA, hashA);
  assert.equal(first.bindingGeneration, 1);
  await assert.rejects(() => service.bindDesktopExecutor(scope, account.id,
    bindInput(deviceB, 1, false), keyB, hashB), /desktop_executor_handoff_required/u);
});
```

Add tests for exact handle/version, inactive account, wrong installation workspace, same-device replay, stale expected generation, 90-second lease, explicit handoff, unresolved-action handoff rejection, disconnect invalidation, and login-version generation change. Also add a batch-service test proving a desktop-bound account creates only `desktop` actions, a server-bound/historical account creates only `server` actions while that gate is enabled, and disabled target gates fail before action persistence.

- [x] **Step 2: Run the focused red tests**

```bash
pnpm --dir backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-social-account-test.ts \
  src/acquisition-social-account-mysql-repository-test.ts \
  src/acquisition-desktop-installation-test.ts
```

Expected: failures identify absent executor fields and binding operations.

- [x] **Step 3: Add strict private/public records**

```ts
export type AcquisitionSocialAccountExecutorMode = "desktop" | "server" | null;

export interface AcquisitionSocialAccountDesktopBindingView {
  accountId: string;
  executorMode: "desktop";
  bindingGeneration: number;
  leaseExpiresAt: string;
  ownedByInstallation: true;
}
```

Extend private-record validators and clone/equality helpers. Expose only mode, generation, expiry, and a request-relative ownership boolean.

- [x] **Step 4: Implement atomic bind/renew/handoff**

Lock the installation, social account, and outstanding account actions in one MySQL transaction. Reject handoff when any action for the account is `claimed`, `executing`, or `reconciliation_required`. Compare the expected generation before writing and increment exactly once for a different device or login version.

- [ ] **Step 5: Run focused tests and inspect migration SQL**

```bash
pnpm --dir backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-social-account-test.ts \
  src/acquisition-desktop-installation-test.ts
pnpm api:verify:desktop-action-storage:binding
git diff --check -- backend/schema.mysql.sql backend/goodjob_crm.full.sql \
  backend/src/acquisition-social-account-mysql-repository.ts
```

Expected: concurrent binding tests establish one owner and one monotonic generation; no public response includes `executorDeviceIdHash`.

Task 3's non-live implementation and final independent review are complete with
zero blocker, major, or minor findings. Atomic binding, InnoDB repair/parity,
recursive public secrecy, direct-message gate/no-write behavior, and production
application composition all pass their fake/injected gates. Task 4 may proceed.
This step remains open only until the separately authorized lock-owned
disposable MySQL command
`pnpm api:verify:desktop-action-storage:binding` is run.

---

### Task 4: Implement target-filtered, idempotent desktop action claim

**Files:**
- Modify: `backend/src/acquisition-outreach-batch-repository.ts`
- Modify: `backend/src/acquisition-outreach-batch-mysql-repository.ts`
- Modify: `backend/src/acquisition-outreach-batch-mysql-repository-test.ts`
- Modify: `backend/src/acquisition-outreach-action-mysql-integration-test.ts`
- Modify: `backend/src/acquisition-outreach-action-worker-test.ts`
- Modify: `backend/schema.mysql.sql`
- Modify: `backend/goodjob_crm.full.sql`

**Interfaces:**
- `claimNextAction` now requires `executionTarget`, preserving the existing server worker semantics.
- Adds `claimNextDesktopAction(input): Promise<DesktopOutreachClaimResult>` with device/process/binding snapshots, claim idempotency key hash, request hash, server time, action deadline, and lease duration.
- Claim result is `{ kind: "claimed", task, fence, replayed }` or `{ kind: "empty", replayed }`.
- Task capability is an HMAC over workspace, device hash, process hash, action ID, fencing token, binding generation, and immutable task request hash; only its hash is persisted.

- [ ] **Step 1: Write failing claim-race and replay tests**

```ts
test("only the bound device claims a desktop action and a lost response replays it", async () => {
  const first = await repository.claimNextDesktopAction(claimInput(deviceA, "key-1"));
  const replay = await repository.claimNextDesktopAction(claimInput(deviceA, "key-1"));
  const other = await repository.claimNextDesktopAction(claimInput(deviceB, "key-2"));
  assert.equal(first.kind, "claimed");
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.equal(other.kind, "empty");
});
```

Cover server/desktop target isolation, two-connection `SKIP LOCKED` race, wrong device/generation/login version, expired binding, risk pause, predecessor receipt, DNC/approval authority, content/target hash, DM daily limit, account cooldown, same-account serialization, no-work replay, and claim request-hash conflict. Also prove a historical/server action cannot be returned by a desktop claim even when the same account is now desktop-bound.

- [ ] **Step 2: Run the focused red tests**

```bash
pnpm --filter ./backend test:acquisition-outreach-actions
pnpm --dir backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-outreach-batch-mysql-repository-test.ts
```

Expected: failures show missing target filter, desktop claim contract, claim replay table, and device-binding predicates.

- [ ] **Step 3: Add exact claim/fence/task types**

```ts
export interface DesktopOutreachActionFence extends OutreachActionFence {
  workspaceId: string;
  deviceIdHash: string;
  processInstanceIdHash: string;
  executorBindingGeneration: number;
  taskTokenHash: string;
  requestHash: string;
}

export interface DesktopOutreachActionTask {
  actionId: string;
  workspaceId: string;
  accountId: string;
  accountHandle: string;
  loginStateVersion: number;
  executorBindingGeneration: number;
  kind: "comment" | "direct_message";
  canonicalTargetPublicUrl: string;
  content: string;
  approvedContentHash: string;
  deadlineAt: string;
  leaseVersion: number;
  leaseExpiresAt: string;
  predecessorReceipt: string | null;
}
```

The task is internal to Main and never appears in normal Renderer responses.

- [ ] **Step 4: Implement atomic claim and claim replay**

Add `execution_target`, `platform_write_attempt_count`, device/process/binding/task/request fields to the action/attempt persistence needed for fencing, plus `acquisition_desktop_outreach_claim_replays` for both claimed and empty responses. Use `FOR UPDATE SKIP LOCKED`; join the authoritative social account and installation binding; set status `claimed`; preserve all current daily/cooldown/predecessor checks. Historical rows default to `server` and are never silently retargeted.

- [ ] **Step 5: Run race, repository, and worker regression tests**

```bash
pnpm --filter ./backend test:acquisition-outreach-actions
pnpm --dir backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-outreach-action-worker-test.ts
pnpm api:verify:desktop-action-storage:actions
```

Expected: the server worker sees only `server`; the desktop repository returns exactly one task to the authoritative device and exact replay never advances the queue.

---

### Task 5: Fence start, completion, lease recovery, and read-only reconciliation

**Files:**
- Create: `backend/src/acquisition-desktop-outreach-sync.ts`
- Create: `backend/src/acquisition-desktop-outreach-sync-test.ts`
- Modify: `backend/src/acquisition-outreach-batch-repository.ts`
- Modify: `backend/src/acquisition-outreach-batch-mysql-repository.ts`
- Modify: `backend/src/acquisition-outreach-batch-mysql-repository-test.ts`
- Modify: `backend/src/acquisition-outreach-action-mysql-integration-test.ts`
- Modify: `backend/src/acquisition-outreach-action-recovery-sweeper.ts`
- Create: `backend/src/acquisition-outreach-action-recovery-sweeper-test.ts`
- Modify: `backend/src/acquisition-outreach-batch-service.ts`
- Modify: `backend/src/acquisition-outreach-batch-router.ts`
- Modify: `backend/src/acquisition-outreach-batch-router-test.ts`
- Modify: `backend/schema.mysql.sql`
- Modify: `backend/goodjob_crm.full.sql`

**Interfaces:**

```ts
export type DesktopOutreachCompletionCommand =
  | {
      event: "started";
      leaseVersion: number;
      requestHash: string;
      occurredAt: string;
    }
  | {
      event: "receipt";
      leaseVersion: number;
      requestHash: string;
      reconciliation: boolean;
      receipt: {
        actionId: string;
        state: "succeeded" | "failed";
        platformReceiptReference: string | null;
        occurredAt: string;
        failureCode: string | null;
      };
    };

export interface AcquisitionDesktopOutreachSync {
  claim(principal: DesktopInstallationPrincipal,
        input: DesktopOutreachClaimInput): Promise<DesktopOutreachClaimResult>;
  complete(principal: DesktopInstallationPrincipal, actionId: string,
           input: DesktopOutreachCompletionInput): Promise<DesktopOutreachCompletionResult>;
  reconcile(principal: DesktopInstallationPrincipal, actionId: string,
            input: DesktopOutreachReconcileInput): Promise<DesktopOutreachReconcileResult>;
}
```

Every command includes the task token and process-instance ID at the transport boundary. The service hashes both before repository use. Normal repository comparisons cover workspace, action, device, process, task-token hash, lease version, executor binding generation, login-state version, and immutable request hash. The only process change allowed is an explicit post-restart reconciliation takeover: it verifies the durable snapshot against the original execution fence and current device/binding/Profile identity, records a new reconciliation-only lease/process/token, and never authorizes `started` or a Sidecar write call.

The desktop claim repository invokes the sole outreach authority resolver inside the existing claim transaction, after locking installation, social account, action-account serialization, and the deterministic action rows, but before committing an attempt, claim replay, quota reservation, or cooldown. Task 4's claim-replay reservation may still occur at its documented earlier lock-order exception, but authorization rejection rolls that reservation back. The repository supplies the resolver with its locked core snapshot, so the resolver must not re-read those same repository rows. Candidate, evidence, DNC, run, crawler, and immutable policy authority are checked through the transaction-bound authority context. An authorization rejection or exception rolls back the entire claim; a committed claim is never compensated by a later best-effort release.

- [x] **Step 1: Write failing state-machine, exact-replay, and crash-window tests**

```ts
test("a started action is never automatically written a second time", async () => {
  const claim = await sync.claim(device, claimInput("claim-1"));
  assert.equal(claim.kind, "claimed");
  await sync.complete(device, claim.task.actionId,
    startInput(claim, "start-1"));
  clock.advanceBeyond(claim.task.leaseExpiresAt);
  await sweeper.runOnce();
  assert.equal((await repository.getAction(claim.task.actionId))?.status,
    "reconciliation_required");
});
```

Cover identical `started` replay, conflicting start hash, start after lease expiry, start from an old device/generation/process/fence, `platformWriteAttemptCount` changing exactly `0 -> 1`, identical terminal receipt replay, conflicting terminal receipt, receipt after binding handoff, receipt upload after lease expiry with the exact original fence, explicit same-device/new-process read-only recovery, rejection of a new-process normal completion, rejection of cross-device recovery, `douyin_profile_busy` before local start, all uncertain failure codes, definitive failure, success/predecessor release, comment/DM quotas, and concurrent complete calls.

- [x] **Step 2: Run the focused red tests**

```bash
pnpm --dir backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-desktop-outreach-sync-test.ts \
  src/acquisition-outreach-action-recovery-sweeper-test.ts \
  src/acquisition-outreach-batch-mysql-repository-test.ts \
  src/acquisition-outreach-action-mysql-integration-test.ts
```

Expected: failures identify missing start/receipt commands, terminal replay ledger, and claimed-versus-executing lease recovery.

- [x] **Step 3: Implement fenced start and completion persistence**

Add repository operations `markDesktopActionStarted`, `completeDesktopAction`, and `recordDesktopReconciliation`. In one transaction, lock the action, attempt, binding, and installation; recheck the complete fence; then persist both the transition and its replay response. Store request hash, receipt hash, sanitized receipt JSON, response JSON, idempotency-key hash, and outcome. Identical commands return the stored response even after terminal transition; any changed body under the same key or any changed receipt for the same fence returns `desktop_action_replay_conflict`.

The `started` command moves `claimed -> executing` and increments `platform_write_attempt_count` once. It does not claim that the local Sidecar has already written; the narrow crash gap between central start and local `started` journal is deliberately recovered as `reconciliation_required`, never as a second write.

- [x] **Step 4: Implement receipt classification without weakening existing policy**

Use one shared classifier from the server worker for central state effects:

```text
succeeded                                      -> succeeded
douyin_profile_busy after central start but before Sidecar journal
                                               -> queued, reset reserved count, bounded backoff
action_unavailable after central start         -> reconciliation_required
douyin_action_timeout after central start      -> reconciliation_required
douyin_action_receipt_ambiguous after start    -> reconciliation_required
explicit risk signal                           -> risk_paused
other proven pre-write rejection               -> failed
```

A receipt never alters another account, workspace, binding generation, or unrelated action. A successful comment releases only its exact approved private-message successor. A deterministic terminal comment failure closes only that exact successor as `failed/predecessor_failed`; an uncertain or reconciliation-required comment keeps it blocked.

- [x] **Step 5: Separate human reconciliation authorization from device reconciliation**

Change the existing user route so `AcquisitionOutreachBatchService.reconcileAction` records `{ requestedByUserId, requestedAt, expectedExecutionLeaseVersion }` for desktop actions and returns the updated action without calling `douyinMediaCrawlerGateway`. Independently, the device operation may recover an action referenced by that same installation's durable Main journal after a crash. It leases a read-only reconciliation task only to the current bound installation and only for the same account handle, Profile login version, action request hash, and binding generation that executed the write. A reconciler may return an observed success or `action_unavailable`; it must not call a write executor.

- [x] **Step 6: Implement deterministic lease recovery**

Update the sweeper so expired `claimed` actions with `platformWriteAttemptCount === 0` return to `queued`, while expired `executing` actions and any action with count `1` become `reconciliation_required`. Release process-instance ownership but preserve device, binding-generation, request-hash, attempt, and audit evidence. Make repeated sweeps idempotent.

- [ ] **Step 7: Run all receipt, recovery, and existing outreach regressions**

- [x] Non-live fake/injected implementation gates pass against the completed
  Memory/MySQL parity changes: Memory 198/198, MySQL 122 passed with four
  live-only skips, service/router 65/65, contracts 102/102, Backend build, and
  `git diff --check`. Independent bounded review reports zero blocker, major, or
  minor findings.
- [ ] Run the separately authorized disposable-MySQL verifier
  `pnpm api:verify:desktop-action-storage:actions`. It remains outside the
  current non-live authorization boundary.

```bash
pnpm --dir backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-desktop-outreach-sync-test.ts \
  src/acquisition-outreach-action-recovery-sweeper-test.ts \
  src/acquisition-outreach-batch-router-test.ts \
  src/acquisition-outreach-action-worker-test.ts
pnpm api:verify:desktop-action-storage:actions
pnpm --filter ./backend build
```

Expected: all state transitions, stale-writer rejection, exact replay, and predecessor tests pass; no automated path can produce a second platform-write attempt.

Task 5's internal repository/service implementation is complete. Public desktop
routes, production composition, Electron/Main wiring, deployment, migration, and
live Douyin acceptance remain outside this task; the routes and composition start
in Task 6.

---

### Task 6: Expose the strict central API, OpenAPI contract, and composition gates

**Files:**
- Create: `backend/src/desktop-client-admission.ts`
- Create: `backend/src/desktop-client-admission-test.ts`
- Create: `backend/src/acquisition-desktop-outreach-sync-router.ts`
- Create: `backend/src/acquisition-desktop-outreach-sync-router-test.ts`
- Modify: `backend/src/acquisition-v1-router.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/src/acquisition-mediacrawler-server-configuration-test.ts`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`
- Modify: `backend/src/acquisition-openapi-response-conformance-test.ts`
- Modify: `backend/src/acquisition-openapi-contract-drift-test.ts`
- Create: `scripts/desktop-outreach-schema-upgrade.mjs`
- Create: `scripts/desktop-outreach-schema-upgrade.test.mjs`
- Create: `contracts/fixtures/desktop-outreach-legacy-schema.v1.sql`
- Create: `contracts/fixtures/desktop-outreach-legacy-rows.v1.json`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify generated output: `frontend/src/generated/ai-acquisition.ts`
- Modify: `scripts/real-trial-config.test.mjs`
- Modify: `scripts/real-trial-runtime.test.mjs`
- Modify: `scripts/api-only-runtime.mjs`
- Modify: `scripts/api-only-runtime.test.mjs`
- Modify: `tools/start-real-local.mjs`
- Modify: `.env.example`
- Modify: `services/media-crawler/.env.example`
- Modify: `.env.production.example`

**HTTP request/response shapes:**

```text
POST desktop-installations/enrollments
  body: { protocolVersion: 1, installationId: string }
  201:  { enrollmentToken: string, expiresAt: RFC3339 }

POST desktop-installations/register
  body: { protocolVersion: 1, installationId: string, enrollmentToken: string }
  201/200 replay: { deviceToken: string, workspaceId: string, protocolVersion: 1 }

POST social-accounts/{accountId}/desktop-binding
  body: { installationId: string, accountHandle: string,
          loginStateVersion: integer, expectedBindingGeneration: integer,
          handoff: boolean }
  200:  { accountId: string, executorMode: "desktop",
          bindingGeneration: integer, leaseExpiresAt: RFC3339,
          ownedByInstallation: true }

POST desktop-outreach-actions/claim
  body: { protocolVersion: 1, processInstanceId: string, waitSeconds: 0,
          availableAccounts: [{ accountId, accountHandle,
            loginStateVersion, bindingGeneration }] }
  200:  { kind: "claimed", task, taskToken, serverTime, replayed }
      | { kind: "empty", serverTime, retryAfterMs, replayed }

POST desktop-outreach-actions/{actionId}/complete
  body: { protocolVersion: 1, processInstanceId: string,
          bindingGeneration: integer, command: DesktopOutreachCompletionCommand }
  200:  { actionId, state, replayed, accountPaused, occurredAt }

POST desktop-outreach-actions/{actionId}/reconcile
  body: { protocolVersion: 1, processInstanceId: string,
          bindingGeneration: integer, requestHash: string }
  200:  { kind: "reconcile", task, taskToken, replayed }
      | { kind: "terminal", status, receiptHash, replayed }
      | { kind: "waiting", retryAfterMs, replayed }
      | { kind: "not_authorized", replayed }
```

`register` uses `Idempotency-Key` as well as the enrollment token. Its credential is deterministically derived through an `ACQUISITION_MASTER_SECRET` domain-separated HMAC over the consumed enrollment identity and installation hash, so a lost successful response can replay the same credential without storing plaintext. The server persists only hashes. Every object is `.strict()`; UUID/hash/base64url/RFC3339/range validation is explicit.

`SHENSI_DESKTOP_CLIENT_ADMISSION_MODE` is required and is only `migration_locked|exact`. Exact mode additionally requires `SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256`; locked mode rejects a non-empty admitted digest. The central admission middleware validates these settings at startup, rejects ambiguous duplicate headers, and gates every non-read business request and every desktop installation/binding/action route before body parsing or repository access. The runtime verifier must prove the Backend and active Gateway snapshots contain the same mode and digest.

- [ ] **Step 1: Write failing transport, admission, auth, and OpenAPI tests**

Test the six paths, exact status codes, strict-body rejection, wrong content type, method mismatch, enrollment/session/CSRF boundary, device route cookie rejection as proof, missing/redacted device headers, inactive membership, cross-workspace account IDs, invalid process ID, task-token mismatch, idempotency conflict, and an error body that never echoes secrets. Add a complete route/method matrix proving `migration_locked` reaches zero mutation repositories, and exact mode rejects missing, duplicate, malformed, stale, or wrong build digests before device authentication/body parsing. Prove the exact admitted digest allows the request to continue to all existing auth/tenant/fence checks and never bypasses them. Include ordinary business mutations as well as enrollment/register/binding/claim/complete/reconcile.

```ts
test("Renderer cookies cannot substitute for a device credential", async () => {
  const response = await request(app).post(claimPath)
    .set("Cookie", authenticatedCookie)
    .send(validClaimBody);
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, { error: "desktop_device_authentication_required" });
});
```

- [ ] **Step 2: Run router and contract tests red**

```bash
pnpm --dir backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-desktop-outreach-sync-router-test.ts \
  src/desktop-client-admission-test.ts \
  src/acquisition-application-test.ts \
  src/acquisition-openapi-test.ts \
  src/acquisition-openapi-response-conformance-test.ts \
  src/acquisition-openapi-contract-drift-test.ts
```

Expected: failures identify absent routes, composition inputs, and contract operations.

- [ ] **Step 3: Implement the client-admission boundary, narrow router, and device-auth middleware**

Validate the server admission configuration at composition startup. For a gated request, reject `migration_locked` with stable `503 desktop_client_migration_locked`; in exact mode require one syntactically valid build header and compare it in constant time with the configured digest, otherwise return stable `409 desktop_client_build_not_admitted`. Do this before parsing a resource ID/body, authenticating a device, or calling a repository. Then authenticate device routes, resolve the device principal from the two device headers, and recheck installation, user, team, workspace membership, and protocol version. Hash task tokens and idempotency keys before persistence. Map version/fence/hash conflicts to `409`, expired leases/enrollments to `410`, disabled desktop execution to `503`, malformed input to `400`, device authentication to `401`, and cross-workspace/missing authority to the existing non-enumerating `404` policy. Never log the device/task credentials; the non-secret build digest may appear only in structured verifier evidence, not routine request logs.

- [ ] **Step 4: Wire repositories and split gates at the composition root**

Instantiate one installation service and one desktop sync service for Memory and MySQL modes. Derive enrollment, credential, task-capability, request, and idempotency keys from `ACQUISITION_MASTER_SECRET` using distinct labels. Start the existing worker only when `DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED=true`; mount claim/complete/reconcile only when `DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED=true`; allow approvals only when `DOUYIN_OUTREACH_APPROVALS_ENABLED=true`. Never infer any of these values from `MEDIACRAWLER_BASE_URL`.

- [ ] **Step 5: Implement and prove the versioned target-schema upgrade**

Define immutable schema version `desktop-outreach-action-bridge-v1` and a canonical SHA-256 over the ordered migration steps. The upgrade runs only against the offline/restored target selected by the API migration supervisor with a privileged target-only credential; it is never run implicitly by read-only Backend startup and never alters `shensi_trial`. It creates a resumable owner table, adds the installation/binding/action/fence/replay/journal-supporting tables, columns, constraints, and indexes, then records each completed step and the final version/hash.

Backfill rules are exact: historical actions missing `execution_target` become `server`; missing `platform_write_attempt_count` becomes `0`; social-account executor mode/device/lease remain `NULL` with binding generation `0`; no historical terminal action is reopened; existing IDs, account/login versions, content/approval hashes, receipts, timestamps, quotas, and tenant ownership remain byte-for-byte unchanged. Because MySQL DDL auto-commits, every step checks the information schema and a step hash before applying, and an interrupted rerun resumes idempotently. An unexpected column/index definition, unknown partial step, conflicting schema version/hash, or non-empty new replay table fails closed.

The legacy fixture contains representative queued, blocked, executing, terminal comment, terminal private-message, social-account, and tenant rows. Tests restore it into the lock-owned disposable MySQL, inject a stop after every DDL step, rerun, and compare row counts plus stable-field hashes to the pre-upgrade snapshot. They also run the upgrade twice, compare the fresh bootstrap schema to upgraded legacy schema, and prove read-only Backend startup emits zero DDL. The resulting schema version/hash becomes required migration, cutover, build, and acceptance evidence.

```bash
node --test scripts/desktop-outreach-schema-upgrade.test.mjs
pnpm api:verify:desktop-action-storage:all
```

Expected: the disposable legacy copy reaches exactly `desktop-outreach-action-bridge-v1`; every preservation/idempotency assertion passes; no retained or Trial database is contacted.

- [ ] **Step 6: Update OpenAPI and regenerate the sole frontend contract**

Add all schemas, security requirements, header definitions—including the non-secret desktop build-manifest digest—response unions, replay flags, admission error codes, and `additionalProperties: false` to `contracts/openapi/ai-acquisition.v1.yaml`; mirror operations in `acquisition-openapi.ts` according to the existing contract generation path. The contract must state that this digest is a compatibility gate and that device routes still require their normal credential/task-token scheme.

```bash
pnpm generate:frontend-contract-types
pnpm test:contracts
pnpm --filter ./backend test:contract-drift
pnpm --filter ./backend test:acquisition-openapi
pnpm check:generated-acquisition-types
```

Expected: generated output is clean on a second generation and every route response conforms to the published contract.

- [ ] **Step 7: Update runtime configuration and run composition tests**

Set the three feature flags and desktop-client admission settings explicitly in all environment examples, but default every unspecified execution role closed and admission to `migration_locked`. Preserve Trial behavior during migration: its launcher maps the existing explicit legacy action setting to approvals/server execution, fixes desktop execution `false`, and keeps admission locked, so old non-terminal server actions can finish and the new desktop consumer cannot compete. Add a guarded API-only configuration transformer for the exact owner-validated `.runtime/api-only/backend.env`; it validates the completed fake-action/fault-matrix evidence hash but must not run before or during `cutover_read_only`. The API-only plan's write-activation transaction is its sole caller: while the target is stopped and migration state is exactly `write_activation_pending` for the matching active attempt/evidence hash, it changes the reviewed action role from approvals `true`, server `false`, desktop `false` to approvals `true`, server `false`, desktop `true`, and writes admission mode `migration_locked` with no admitted digest; then the API supervisor restarts and verifies. Only the later joint App/Backend/Gateway milestone may replace this with `exact` plus its candidate App digest. Reject Trial roots, a running target, every other migration state, stale evidence, unknown keys, a digest in locked mode, missing digest in exact mode, engine mismatch, and symlinks. A future deployment may override roles deliberately through an equally bound version transaction. Add tests proving each of the eight boolean combinations either composes the expected components or fails with the exact missing dependency, and both admission modes obey their exact invariant.

```bash
pnpm --dir backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-desktop-outreach-sync-router-test.ts \
  src/acquisition-application-test.ts \
  src/acquisition-mediacrawler-server-configuration-test.ts
pnpm test:trial-runtime
pnpm --filter ./backend build
```

Expected: no remote Sidecar is required for desktop approval/claim, enabling server execution without a configured server gateway fails startup clearly, Trial retains its current server-only action role, and the retained API-only configuration remains desktop-disabled until the separate post-read-only, pre-`accepted` forward-only write-activation transaction validates this plan's evidence. Terminal API `accepted` has desktop routes composed but admission still `migration_locked`, so neither a stale installed App nor the Task 5 read-only App can mutate or claim. If that transaction stops in `write_activation_pending`, only `pnpm api:accept:resume` may continue it on the same attempt and evidence.

---

### Task 7: Restore Sidecar identity by account key and reuse its durable action executor

**Files:**
- Read fixture: `contracts/fixtures/desktop-outreach-hashes.v1.json`
- Modify: `services/media-crawler/shensi_adapter/schemas.py`
- Modify: `services/media-crawler/shensi_adapter/accounts.py`
- Modify: `services/media-crawler/shensi_adapter/action_jobs.py`
- Modify: `services/media-crawler/shensi_adapter/app.py`
- Modify: `services/media-crawler/shensi_adapter/runtime_config.py`
- Modify: `services/media-crawler/shensi_adapter/desktop_entrypoint.py`
- Modify: `services/media-crawler/tests/shensi_adapter/test_actions.py`
- Modify: `services/media-crawler/tests/shensi_adapter/test_desktop_runtime_integration.py`
- Modify: `services/media-crawler/tests/shensi_adapter/test_runtime_config.py`
- Modify: `services/media-crawler/tests/shensi_adapter/test_desktop_entrypoint.py`
- Create: `services/media-crawler/tests/shensi_adapter/test_desktop_action_recovery.py`
- Modify: `desktop/tests/test_frozen_sidecar_entrypoint.py`

**Loopback-only contracts:**

```text
POST /internal/v1/douyin/account-identities/resolve
  body: { account_key: 64-lowercase-hex }
  200:  { account_key, account_handle, account_display_name,
          login_state_version, profile_available: true }

POST /internal/v1/douyin/actions/{action_id}
  body: strict ActionRequest whose sole target field is canonical_target_public_url,
        plus request_hash
  200: existing sanitized ActionReceipt

POST /internal/v1/douyin/actions/{action_id}/reconcile
  body: the same strict ActionRequest; reconciliation is read-only
  200: existing sanitized ActionReceipt

POST /internal/v1/douyin/actions/{action_id}/acknowledgement
  body: { request_hash: sha256 hex, receipt_hash: sha256 hex }
  200: { action_id, acknowledged_at }
```

All four routes retain the per-process loopback bearer secret. They accept neither central device credentials nor task tokens. `ActionRequest` replaces the old wire-level `target_public_url` with the sole field `canonical_target_public_url`; no request may contain both. `request_hash` is recomputed locally from the locked canonical fields (excluding deadline and the hash field itself) and rejected on mismatch.

- [ ] **Step 1: Write failing cold-restart identity and journal tests**

```py
def test_account_identity_recovers_from_stable_account_key_after_restart(tmp_path):
    first = authenticated_account_manager(tmp_path, account_key=ACCOUNT_KEY)
    expected = first.resolve_account_identity(ACCOUNT_KEY)
    first.close()
    restored = new_account_manager(tmp_path)
    assert restored.resolve_account_identity(ACCOUNT_KEY) == expected
```

Cover wrong account key, missing/symlinked/corrupt metadata, two account keys, newest login version, version mismatch, request-hash mismatch, exact execute replay, `started` ambiguity, exact receipt replay after Sidecar restart, acknowledgement only after a completed receipt, acknowledgement hash conflict, and a completed journal surviving until acknowledgement.

- [ ] **Step 2: Run Sidecar tests red**

```bash
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/shensi_adapter/test_actions.py \
  services/media-crawler/tests/shensi_adapter/test_desktop_runtime_integration.py \
  services/media-crawler/tests/shensi_adapter/test_desktop_action_recovery.py
```

Expected: failures identify the missing stable identity resolver, request hash, and durable acknowledgement operation.

- [ ] **Step 3: Add the stable account-key resolver without exposing Profile paths**

Freeze Main's existing account-key algorithm byte-for-byte as lowercase hex `sha256(UTF8("douyin-profile:" + accountId))`; do not replace it with a device/workspace-dependent value during migration. Compute the established Sidecar profile directory key as lowercase hex `sha256(UTF8("shensi-douyin-profile\\0" + account_key))`, find exactly that non-symlink profile below the configured Profile root, validate `account.json`, and return the in-memory/reloaded account handle, display name, and login version. Add shared fixed vectors for ASCII/Unicode account IDs to Main and Python tests. Never return either derived key, path, Cookie, browser storage, or metadata contents. The existing `resolve_action_profile(account_handle, login_state_version)` remains the final executor authority check.

- [ ] **Step 4: Align the cross-language semantic hash and acknowledgement ledger**

Replace the wire-level `ActionRequest.target_public_url` field with strict `canonical_target_public_url` and add strict `request_hash`; reject the legacy field on this desktop protocol rather than accepting two sources of truth. Make `_semantic_hash` serialize exactly the locked canonical fields; it validates but does not normalize the central URL. Canonicalize `occurred_at` to the locked millisecond-UTC-`Z` representation before Pydantic serialization and receipt hashing. Before any Profile lease or `started` write, compare the supplied request hash. Persist a canonical receipt hash in completed journals. `ActionJobManager.acknowledge(action_id, request_hash, receipt_hash)` atomically removes only the exact completed journal; `started` and mismatched journals return conflict and remain on disk.

- [ ] **Step 5: Reuse existing comment, private-message, lease, and reconciliation code unchanged**

Keep this call chain intact:

```text
ActionJobManager.execute
 -> AccountManager.resolve_action_profile
 -> acquire_profile_lease
 -> persist started journal
 -> AccountManager.execute_action
 -> MediaCrawlerDouyinBrowserState.execute_douyin_action
 -> DouyinActionExecutor (comment)
    or DouyinSpiderPrivateMessageExecutor (direct_message)
 -> persist completed receipt
```

Keep `ActionJobManager.reconcile -> AccountManager.reconcile_action -> MediaCrawlerDouyinBrowserState.reconcile_douyin_action` read-only. Do not add selectors, clicks, alternative private-message libraries, CAPTCHA handling, or a second action implementation.

- [ ] **Step 6: Split desktop Sidecar capability from server Sidecar configuration**

For runtime mode `desktop`, read `SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED` and reject a non-boolean value; for runtime mode `web`, retain `DOUYIN_OUTREACH_ACTIONS_ENABLED`. The desktop entry point requires the desktop flag explicitly and still requires `external_window`, `headless=false`, loopback, and the protected secret file. This flag only mounts the local endpoint; it does not authorize a platform write without the central frozen task and local content-hash validation.

- [ ] **Step 7: Run the full relevant Sidecar and frozen-entrypoint suites**

```bash
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/shensi_adapter/test_actions.py \
  services/media-crawler/tests/shensi_adapter/test_douyin_action_controls.py \
  services/media-crawler/tests/shensi_adapter/test_desktop_action_recovery.py \
  services/media-crawler/tests/shensi_adapter/test_desktop_runtime_integration.py \
  services/media-crawler/tests/shensi_adapter/test_runtime_config.py \
  services/media-crawler/tests/shensi_adapter/test_desktop_entrypoint.py \
  desktop/tests/test_frozen_sidecar_entrypoint.py
```

Expected: all tests use fake executors; no test opens Douyin or performs a real platform write.

---

### Task 8: Add device credentials and the Electron Main action coordinator

**Files:**
- Read fixture: `contracts/fixtures/desktop-outreach-hashes.v1.json`
- Create: `desktop/src/main/desktop-build-identity.ts`
- Create: `desktop/src/main/device-installation.ts`
- Create: `desktop/src/main/device-credential-store.ts`
- Create: `desktop/src/main/desktop-central-api-client.ts`
- Create: `desktop/src/main/outreach-action-journal.ts`
- Create: `desktop/src/main/outreach-action-coordinator.ts`
- Create: `desktop/scripts/prepare-dev-build-identity.mjs`
- Create: `desktop/scripts/prepare-dev-build-identity.test.mjs`
- Create: `desktop/tests/device-installation.test.ts`
- Create: `desktop/tests/desktop-build-identity.test.ts`
- Create: `desktop/tests/device-credential-store.test.ts`
- Create: `desktop/tests/desktop-central-api-client.test.ts`
- Create: `desktop/tests/outreach-action-journal.test.ts`
- Create: `desktop/tests/outreach-action-coordinator.test.ts`
- Modify: `desktop/src/main/app-paths.ts`
- Modify: `desktop/src/main/runtime-config.ts`
- Modify: `desktop/src/main/sidecar-client.ts`
- Modify: `desktop/src/main/sidecar-process-manager.ts`
- Modify: `desktop/src/main/main.ts`
- Modify: `desktop/src/main/renderer-server.ts`
- Modify: `desktop/package.json`
- Modify: `desktop/tests/app-paths.test.ts`
- Modify: `desktop/tests/runtime-config.test.ts`
- Modify: `desktop/tests/sidecar-client.test.ts`
- Modify: `desktop/tests/sidecar-process-manager.test.ts`
- Modify: `desktop/tests/main-bootstrap.test.ts`
- Modify: `desktop/tests/renderer-server.test.ts`
- Modify: `desktop/tests/controlled-shutdown.test.ts`
- Modify: `desktop/tests/logger.test.ts`
- Modify: `desktop/tests/fixtures/fake-sidecar.mjs`

**Main-process interfaces:**

```ts
export interface DeviceInstallationStore {
  getOrCreateInstallationId(): Promise<string>;
}

export interface DeviceCredentialStore {
  save(value: DesktopWorkspaceCredential): Promise<void>;
  load(workspaceId: string): Promise<DesktopWorkspaceCredential | null>;
  recordBinding(workspaceId: string, binding: DesktopBindingReference): Promise<void>;
  remove(workspaceId: string): Promise<void>;
}

export interface DesktopCentralApiClient {
  register(input: RegisterInstallationInput): Promise<RegisteredDevice>;
  claim(context: DeviceContext, input: ClaimRequest): Promise<ClaimResponse>;
  complete(context: DeviceContext, actionId: string,
           input: CompletionRequest): Promise<CompletionResponse>;
  reconcile(context: DeviceContext, actionId: string,
            input: ReconcileRequest): Promise<ReconcileResponse>;
}

export type DesktopOutreachCoordinatorState =
  | "disabled" | "unenrolled" | "unbound" | "offline" | "idle"
  | "claiming" | "claimed" | "executing" | "reconciling"
  | "risk_paused" | "error" | "stopping";
```

`DesktopWorkspaceCredential` contains the workspace ID, device token, protocol version, and bound `{ accountId, bindingGeneration }` references. The complete record is encrypted with Electron `safeStorage`; its file contains only versioned ciphertext and has mode `0600`. The installation metadata file contains only the installation ID and protocol version. `OutreachActionJournalStore` persists at most one atomic `0600` recovery record per account below an owner-only directory; filenames are derived from a domain-separated account-ID hash. Each record contains action/workspace/account IDs, request hash, original lease version, binding generation, login-state version, phase, and receipt hash; it never stores content, target URL, account handle, process/device/task token, Cookie, Profile path, or platform message. Device-wide active account lanes are bounded at exactly two; the existing per-account/Profile lease remains the same-account serialization authority.

`readDesktopBuildIdentity(resourcesPath)` reads only the fixed non-symlink canonical embedded manifest, validates its exact versioned shape and exact regular-file mode `0644`, and returns its canonical-file SHA-256. Owner-write is permitted for normal build tooling; group/world-write is forbidden. Main passes this immutable value when constructing both `startRendererServer` and `DesktopCentralApiClient`; neither accepts a Renderer value or a per-request override.

Development mode has an explicit producer rather than inventing an identity inside Renderer or accepting an arbitrary environment digest. `desktop/scripts/prepare-dev-build-identity.mjs` uses Task 1's canonical `desktop-app` source-content manifest to create one canonical `0644` build manifest beneath an exclusive owner-only `.runtime/desktop-dev/<source-root-hash>/` root, then starts Electron with only that validated absolute manifest path. Main reads and freezes the file once through the same decoder used for packaged resources. A development digest may be admitted only by a disposable developer API runtime configured for that exact digest; the retained accepted runtime never admits a development build and remains bound to its fixed active-version record.

- [ ] **Step 1: Write failing credential, API boundary, and coordinator state tests**

Cover stable 32-byte base64url installation ID, exclusive/atomic `0600` writes, symlink refusal, corrupt ciphertext, unavailable `safeStorage`, one credential per workspace, binding update, exact HTTPS/loopback origin, manual redirect rejection, bounded response bodies/timeouts, header redaction, malformed central/Sidecar responses, no credential in Renderer, and logger redaction. Build-identity tests accept only exact regular-file mode `0644` and reject absent, symlinked, any other mode (including group/world-writable), non-canonical, extra-field, changed-after-read, and wrong-hash manifests. Development-producer tests prove the path is derived only from the canonical `desktop-app` source root hash under the validated runtime root, creation is exclusive/no-follow, changed inputs produce a different path/digest, and a caller cannot supply a digest or point Main outside that root. Renderer-proxy tests prove an incoming lower/upper/mixed-case or duplicate build header is removed and replaced exactly once with Main's digest; central-client tests prove every enrollment/binding/action request carries the same immutable digest and no API can override it.

Coordinator fakes must cover: no credential, no binding, central offline, Sidecar offline, cold identity recovery, empty claim cadence, lost claim response replay, central-start failure before Sidecar call, `douyin_profile_busy`, success, definitive failure, risk pause, ambiguous receipt, lost completion response, Main crash at every state edge, Sidecar crash, central restart, and app shutdown. Add two-account tests proving the same account never has two records/actions, a blocked/reconciling account does not block a different account, no more than two account lanes execute, and shutdown/restart recovers both without duplication.

- [ ] **Step 2: Run Electron Main tests red**

```bash
pnpm --dir desktop exec tsx --test \
  tests/desktop-build-identity.test.ts \
  tests/device-installation.test.ts \
  tests/device-credential-store.test.ts \
  tests/desktop-central-api-client.test.ts \
  tests/outreach-action-journal.test.ts \
  tests/outreach-action-coordinator.test.ts \
  tests/renderer-server.test.ts \
  tests/sidecar-client.test.ts \
  tests/sidecar-process-manager.test.ts
```

Expected: failures identify the absent stores, central client, local action methods, and coordinator.

- [ ] **Step 3: Implement installation and Keychain-backed credential storage**

Generate the installation ID once with `randomBytes(32).toString("base64url")`. Inject `safeStorage.isEncryptionAvailable`, `encryptString`, and `decryptString` for tests; fail closed when encryption is unavailable. Atomically replace ciphertext files through an owner-only temporary file plus file and directory `fsync`. Reject symlinks, unexpected JSON fields, unsupported versions, wrong workspace, and non-`0600` credential files. Do not fall back to plaintext or command-line Keychain tools.

- [ ] **Step 4: Implement the bounded central and Sidecar clients**

Resolve the central origin and embedded build identity once in both packaged and development modes and pass the same exact values to the Renderer proxy and `DesktopCentralApiClient`. Packaged mode reads `Contents/Resources/desktop-build-manifest.json`; `desktop:dev` first invokes the tested development producer and Main accepts only its validated owner-root path. Neither mode accepts a caller-provided digest. The proxy discards every Renderer-originated build header and injects the Main-owned digest on upstream `/api` requests. Central requests use `redirect: "manual"`, 10-second request timeouts, a 64 KiB normal body limit, strict response decoders, the immutable build digest, installation/device headers, task token where required, and a fresh idempotency key per logical operation retained across retries. Add to `SidecarClient`: `resolveDouyinIdentity(accountKey)`, `executeDouyinAction(task)`, `reconcileDouyinAction(task)`, and `acknowledgeDouyinAction(actionId, requestHash, receiptHash)` with strict request/response maps.

Set `SHENSI_DESKTOP_OUTREACH_ACTIONS_ENABLED=true` only in `SidecarProcessManager` desktop child environment. Never pass the central origin, device credential, task token, or action journal path to the Sidecar.

- [ ] **Step 5: Implement the atomic local recovery journal**

```ts
export interface OutreachActionRecoveryRecord {
  version: 1;
  actionId: string;
  workspaceId: string;
  accountId: string;
  requestHash: string;
  leaseVersion: number;
  bindingGeneration: number;
  loginStateVersion: number;
  phase: "claimed" | "central_started" | "sidecar_completed";
  receiptHash: string | null;
  updatedAt: string;
}
```

Permit monotonic phase transitions only. Refuse a second action for the same account while its record exists and refuse a third active account lane device-wide. A record for account A does not block account B. Clear each record only after the central terminal response is durable and the exact Sidecar acknowledgement succeeds; if acknowledgement fails, retain that account's record for recovery cleanup.

- [ ] **Step 6: Implement `DesktopOutreachActionCoordinator`**

On start, create a fresh random process-instance ID, load the active workspace credential/bindings, derive the frozen lowercase-hex `sha256(UTF8("douyin-profile:" + accountId))` account key, and recover every binding through the Sidecar identity endpoint. Load and recover every per-account journal before claiming new work for that account. For a recovered action, submit its exact durable lease/binding/login/request snapshot to central `reconcile`; central either returns a terminal response, a waiting response, or a new-process recovery fence whose capability is reconciliation-only. A terminal response supplies the receipt hash for Sidecar acknowledgement; a recovery task is sent only to the Sidecar read-only reconciler; a still-claimed action waits for bounded lease recovery. The coordinator never sends `complete` with the new process ID under the original execution fence and never calls `executeDouyinAction` while recovering.

For new work, claim only while fewer than two account lanes are active. Persist `claimed` in that account's lane, submit the idempotent central `started` command, persist `central_started`, then call the existing Sidecar action endpoint. Persist the returned receipt hash before submitting it centrally. Exact completion retries reuse the same logical idempotency key. After durable central completion, acknowledge the Sidecar journal, then clear that account's Main journal. Do not claim another action for an account whose lane exists; central and local checks both enforce this.

No-work polling uses injected jitter in `[3000, 5000]` ms. Transport failures back off `2000, 4000, 8000, 16000, 32000, 60000` ms and reset after a successful central response. `stop()` aborts an outstanding poll/request, refuses new claims, waits at most 10 seconds for receipt persistence/upload, and leaves unresolved journal state for restart.

- [ ] **Step 7: Wire Main lifecycle and verify every crash edge**

Start the coordinator only after Electron readiness and Sidecar readiness; Renderer creation does not own it. On Sidecar generation change, pause claims and recover identities rather than deleting durable bindings. During quit, call `coordinator.stop()` before `manager.stop()` and `renderer.close()`. Publish state changes through an injected listener for the narrow IPC in Task 9.

```bash
pnpm --dir desktop exec tsx --test \
  tests/desktop-build-identity.test.ts \
  tests/device-installation.test.ts \
  tests/device-credential-store.test.ts \
  tests/desktop-central-api-client.test.ts \
  tests/outreach-action-journal.test.ts \
  tests/outreach-action-coordinator.test.ts \
  tests/renderer-server.test.ts \
  tests/sidecar-client.test.ts \
  tests/sidecar-process-manager.test.ts \
  tests/main-bootstrap.test.ts \
  tests/controlled-shutdown.test.ts \
  tests/logger.test.ts
pnpm desktop:typecheck
```

Expected: the fake Sidecar records at most one write call per action under every crash and retry schedule, and Renderer/Sidecar fixtures never observe central credentials or task capabilities.

---

### Task 9: Expose narrow desktop status UI, run the fault matrix, and stage truthful migration documentation

**Files:**
- Modify: `desktop/src/shared/contracts.ts`
- Modify: `desktop/src/shared/validation.ts`
- Modify: `desktop/src/main/desktop-ipc.ts`
- Modify: `desktop/src/preload/desktop-api.ts`
- Modify: `desktop/src/preload/preload.ts`
- Modify: `desktop/tests/contracts.test.ts`
- Modify: `desktop/tests/desktop-ipc.test.ts`
- Modify: `desktop/tests/preload.test.ts`
- Create: `desktop/tests/outreach-action-bridge.integration.test.ts`
- Create: `desktop/tests/acquisition-scroll-stability.e2e.test.ts`
- Create: `scripts/verify-desktop-action-bridge.mjs`
- Create: `scripts/verify-desktop-action-bridge.test.mjs`
- Modify: `package.json`
- Modify: `frontend/src/desktop/desktop-bridge.ts`
- Modify: `frontend/src/desktop/desktop-bridge.self-test.ts`
- Modify: `frontend/src/desktop/desktop-runtime.ts`
- Modify: `frontend/src/desktop/desktop-runtime.self-test.ts`
- Modify: `frontend/src/acquisition/outreach-batch-api.ts`
- Modify: `frontend/src/acquisition/outreach-batch-api.self-test.ts`
- Modify: `frontend/src/acquisition/outreach-batch-controller.ts`
- Modify: `frontend/src/acquisition/outreach-batch-controller.self-test.ts`
- Modify: `frontend/src/acquisition/outreach-batch-view.ts`
- Modify: `frontend/src/acquisition/outreach-batch-view.self-test.ts`
- Modify: `frontend/src/conversations/real-api.ts`
- Modify: `frontend/src/conversations/real-api.self-test.ts`
- Modify: `frontend/src/conversations/real-controller.ts`
- Modify: `frontend/src/conversations/real-controller.self-test.ts`
- Modify: `frontend/src/conversations/real-view.ts`
- Modify: `frontend/src/conversations/real-view.self-test.ts`
- Create: `backend/src/acquisition-desktop-outreach-vertical-integration-test.ts`
- Modify: `README.md`
- Modify: `frontend/README.md`
- Modify: `docs/API_INDEX.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/SOURCE_PROVENANCE.md`
- Modify: `docs/modules/acquisition.md`
- Modify: `docs/desktop/macos-electron-client.md`
- Create: `docs/desktop/acceptance/aliyun-two-mac-checklist.md`

**Renderer bridge surface:**

```ts
getDesktopInstallationInfo(): Promise<{
  installationId: string; protocolVersion: 1; registeredWorkspaceIds: string[];
}>;
registerDesktopInstallation(input: {
  workspaceId: string; enrollmentToken: string;
}): Promise<{ workspaceId: string; registered: true }>;
recordDesktopBinding(input: {
  workspaceId: string; accountId: string; bindingGeneration: number;
}): Promise<{ recorded: true }>;
setDesktopWorkspace(input: { workspaceId: string | null }): Promise<void>;
getDesktopOutreachStatus(): Promise<DesktopOutreachCoordinatorView>;
onDesktopOutreachStatusChanged(
  listener: (value: DesktopOutreachCoordinatorView) => void
): () => void;
```

There is no IPC method to claim, start, execute, complete, reconcile, acknowledge, pass arbitrary action content, or select a URL/path/command. `DesktopOutreachCoordinatorView` contains only state, sanitized diagnostic, current action kind, timestamps, pending reconciliation count, and account-relative ownership state; it excludes action content, target, account handle, IDs, tokens, receipts, and Profile information.

- [ ] **Step 1: Write failing IPC, Renderer flow, and visible-state tests**

Test exact sender-frame/origin ownership, strict channel schemas, unsubscribe/dispose, credential non-return, wrong-workspace registration response, binding generation range, Renderer reload during execution, workspace switch, logout, coordinator status recovery, and no action-execution channel. In the focused Electron/Playwright scroll regression, place the acquisition document at a stable deep-scroll anchor, focus a candidate control, select a candidate, then deliver repeated account/coordinator/action-status updates and forced controller renders. Assert the same candidate remains selected, the focused element is unchanged, and `scrollY`/the scroll-container `scrollTop` stays within one device pixel. Fail on whole-page host replacement, implicit `focus()`, `scrollIntoView()`, hash rewrite, or a subscription that is recreated on every render.

Renderer assertions cover these Chinese states without changing visual tokens:

```text
未注册此设备
本机尚未绑定该抖音账号
等待桌面应用领取
桌面应用已领取
正在通过本机抖音执行
等待只读对账，绝不会自动重发
已完成
风险暂停
中心服务离线，未领取新动作
本地连接器不可用，未执行新动作
存在旧版服务器待执行动作，切换前需先处理
```

Keep comment and private-message checkboxes/buttons independent and preserve the exact frozen target/account/content review. Remove text that claims the server will execute a desktop-target action.

- [ ] **Step 2: Run desktop/Renderer tests red**

```bash
pnpm --dir desktop exec tsx --test \
  tests/contracts.test.ts tests/desktop-ipc.test.ts tests/preload.test.ts \
  tests/outreach-action-bridge.integration.test.ts
pnpm --filter ./frontend test
```

Expected: failures identify missing narrow bridge methods, desktop statuses, and latest-UI state mapping.

- [ ] **Step 3: Implement enrollment and binding UX through the existing page**

On authenticated workspace bootstrap, Renderer gets the non-secret installation ID, requests a 60-second enrollment through its normal CSRF/session API, and passes only that token plus expected workspace ID to Main. Main returns registration status, never the credential. After local Douyin login returns handle/version, Renderer submits the account binding route; only a successful central binding response is recorded in Main. A conflicting device shows an explicit handoff confirmation; handoff is disabled while unresolved actions exist.

Use the existing acquisition controller and card hierarchy. Do not add a second settings page, embedded browser, webview, old frontend, or new color. Status refresh uses the existing controller lifecycle and coordinator event subscription without focusing elements or calling `scrollIntoView`, so acquisition-page scrolling cannot jump.

- [ ] **Step 4: Implement status-only IPC and shared UI mappings**

Add the five invoke channels and one event channel above to contracts, validators, IPC, and preload. Authorize the exact Renderer webContents and same local origin. Keep coordinator lifetime in Main across Renderer reloads. Map the same backend action state and sanitized failure code in acquisition and conversations controllers; share a pure presenter instead of duplicating divergent strings.

- [ ] **Step 5: Run the deterministic two-device and fault-injection matrix**

`pnpm api:verify:desktop-action-bridge` is the sole operator-level matrix command. It acquires `disposable-5628-3312`, starts a run-scoped API-only MySQL/Backend/Gateway with fresh secrets and a clean disposable data volume, sets approvals `true`, server execution `false`, and desktop execution `true` only in that disposable environment, starts two independent temporary Electron user-data roots and recording fake Sidecars, runs the fixed Backend/Desktop/scroll suites, writes a sanitized evidence record, and destroys only its owner-validated project/network/volume/root in `finally`. Its unit test injects failures at every lifecycle edge. It never edits retained `.runtime/api-only/backend.env`, never starts/stops Trial, and never contacts Douyin.

The backend vertical test uses two installation credentials, two process IDs, one bound account, frozen comment then private-message actions, and controllable clock/database barriers. The desktop integration test uses two independent temporary Electron user-data roots, two fake credential stores, and fake Sidecars whose write method records every call.

Assert all of the following:

- bound device only; two claims yield one action;
- explicit handoff increments generation and rejects old-device claim/start/complete;
- same account has one active action while different accounts may proceed;
- private message is unavailable before the exact comment success receipt and independent version-2 approval;
- lost claim/start/complete responses replay exactly;
- disconnect before `started` requeues after lease; disconnect after `started` reconciles without a second write;
- Renderer crash has no effect on Main execution;
- Sidecar/Main/Backend restarts restore identity and receipt state;
- central offline or Sidecar unavailable performs no new platform write;
- completed journal is cleared only after durable central completion;
- log and HTTP fixtures contain none of the seeded credential, task token, Cookie, Profile path, account handle, or full private message.

```bash
node --test scripts/verify-desktop-action-bridge.test.mjs
pnpm api:verify:desktop-action-bridge
```

Expected: each fake action records zero or one platform-write call, never two; acquisition scroll/focus/selection remain stable; the evidence hash is retained under the owner-only API-only evidence directory; no disposable resource or shared lock remains.

- [ ] **Step 6: Stage truthful migration documentation and define its activation points**

Document the desktop-only target Renderer, central API/MySQL authority, enrollment/Keychain model, one-device binding generation, claim/start/receipt/reconcile protocol, separate approval/execution flags, local Sidecar boundary, shutdown/recovery behavior, UI statuses, and exact test commands. While Trial/Web remains the active runtime, current README/operator pages must say the bridge is implemented but disabled/staged and must keep the actual Trial startup path as current; they may not claim Web/noVNC is already retired. The API-only plan may switch API/MySQL/desktop-action operating text to present tense only after terminal `accepted`; the feature-retirement plan may mark Web/noVNC source removed only after its exact Task 7 receipt. Record the existing MediaCrawler and Douyin Spider provenance/license facts without changing vendored code.

`docs/desktop/acceptance/aliyun-two-mac-checklist.md` is the one canonical multi-Mac checklist shared with the feature-retirement plan. It must state that Alibaba resources are not provisioned yet and define evidence required before enabling production: HTTPS origin, certificate, security-group/API-only exposure, RDS migration/backup, secrets, device revocation, two-real-Mac handoff, offline/restart, one-write proof, rollback, and audit-log review. It must not invent a domain, IP, certificate, RDS instance, or passing evidence.

- [ ] **Step 7: Run the complete automated release gate without packaging an app**

```bash
pnpm test:contracts
pnpm --filter ./backend test:contract-drift
pnpm --filter ./backend test:security
pnpm --filter ./backend test:acquisition-openapi
pnpm check:generated-acquisition-types
pnpm --filter ./backend test:acquisition-outreach-actions
pnpm --filter ./backend test:acquisition
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/shensi_adapter \
  desktop/tests/test_frozen_sidecar_entrypoint.py
pnpm desktop:test
pnpm desktop:typecheck
pnpm desktop:build
pnpm --filter ./frontend test
pnpm --filter ./frontend test:types
pnpm --filter ./frontend build:desktop
pnpm api:verify:desktop-action-storage:all
pnpm api:verify:desktop-action-bridge
pnpm test:mediacrawler-provenance
pnpm test:trial-runtime
pnpm build
git diff --check
```

Expected: all commands exit `0`; a second contract generation has no diff; no `.app`, DMG, installer, or live Douyin action is produced by this gate.

- [ ] **Step 8: Review the non-live desktop acceptance evidence**

Run `pnpm api:verify:desktop-action-bridge` fresh and review its lock-owned disposable-runtime report. It must prove enrollment, fake account binding, independently approved fake comment/private-message, recording-fake execution, Renderer/Main/Sidecar restarts, central action/attempt/audit rows, and local journal cleanup. Do not flip flags in Trial or the retained target to manufacture this evidence. Record only the report path/hash and sanitized assertions in the implementation handoff. Real Douyin comment/private-message acceptance remains a separate explicitly authorized operation with user-selected account, target, and exact content.

---

## Completion evidence required from the implementing worker

- List every modified file and explain any deviation from this file map before making that deviation.
- Include red-test evidence for each task before its implementation and green-test evidence afterward.
- Report schema migrations and generated-contract diff separately from handwritten changes.
- Report the exact device/generation/fence and crash-window assertions from the two-device matrix.
- Report `git status --short` and `git diff --check`; do not commit, package, provision Alibaba resources, or perform a live Douyin action unless the user gives a separate explicit instruction.

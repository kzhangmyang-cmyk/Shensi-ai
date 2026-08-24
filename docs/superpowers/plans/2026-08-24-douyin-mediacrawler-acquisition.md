# Douyin MediaCrawler Acquisition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real, recoverable Douyin acquisition flow that connects an account by QR, performs scheduled MediaCrawler collection, produces evidence-bound candidates, requires batch approval, and executes exact approved comments followed by direct messages.

**Architecture:** Import the commercially authorized MediaCrawler fork at a pinned upstream commit as an isolated Python service. Keep workspace authority, plans, schedules, candidates, approvals, action ordering, idempotency, and audit in the existing Node/MySQL acquisition application; expose only closed public APIs and a private authenticated Node-to-Python contract. Extend the existing black-shell acquisition frontend instead of creating a second application.

**Tech Stack:** Node.js 22.22.3, TypeScript, Express, Zod, MySQL 8.4, Python 3.11, uv, FastAPI, Pydantic, Playwright, pnpm 11.18.0, Vite, OpenAPI 3.1, Node test runner, pytest, Playwright Test, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-24-douyin-mediacrawler-acquisition-design.md`

## Global Constraints

- First release supports only `douyin`; do not expose Kuaishou or other MediaCrawler platforms in public contracts.
- Import MediaCrawler from upstream commit `d6f7c5bb906b6dac40ddf343ef9e26438a3de092`; preserve its copyright and `NON-COMMERCIAL LEARNING LICENSE 1.1` text and record that commercial authorization is held outside Git.
- MediaCrawler runs as a private Python service; no browser request can select its URL, account handle, browser profile, or service credential.
- Existing `acquisition_plans`, runs, operation shards, evidence, candidates, CRM conversion, attribution, and ROI records remain authoritative.
- One workspace may connect one Douyin account in the first release.
- The default daily candidate limit is 50; accepted values are integers from 1 through 200.
- Keep acknowledged sidecar result pages for at most 24 hours, keep bounded unconverted candidate evidence for 90 days, and retain only the platform-scoped one-way do-not-contact identity hash until workspace deletion.
- A scheduled or run-now collection may create candidate drafts, but no comment or direct message may execute before an exact batch revision is approved.
- Each approved candidate receives at most one comment and one direct message; the message is not claimable until the comment receipt exists and the minimum server-owned delay elapsed.
- Enforce at least 60 seconds between any two outbound actions for one account and at least 180 seconds between a candidate's comment receipt and direct-message claim; workers may slow down further but never shorten these limits.
- Use one browser/action concurrency per account. CAPTCHA, sliding verification, login expiry, rate limiting, account warning, or three consecutive action failures pauses the account. Do not implement verification bypasses.
- Raw cookies, local storage, full browser profiles, raw platform response bodies, service secrets, and unbounded logs never enter public APIs, Node logs, or model prompts.
- Mutation routes require authentication, CSRF, capability checks, semantic `Idempotency-Key`, and current `If-Match` where the resource is revisioned.
- All workers use random lease tokens, exact expiries, fenced writes, bounded retries, cancellation, and restart sweepers.
- MySQL and Memory repositories have contract parity; real transaction/restart claims require live MySQL tests.
- The editable acquisition contract is `contracts/openapi/ai-acquisition.v1.yaml`; generated frontend types come only from the contract generator.
- Do not change immutable Growth releases `1.0.11` or `1.0.12` for this acquisition-only feature.
- Update `docs/PROJECT_STATUS.md`, `docs/ARCHITECTURE.md`, `docs/API_INDEX.md`, `docs/DEPLOYMENT.md`, and `docs/modules/acquisition.md` when their current truth changes.
- Preserve the uncommitted Task 8 cutover and Chrome-scroll changes until they are committed separately; every task stages only its declared files.
- Before Task 1, finish or separately checkpoint those pre-existing changes and execute this plan on a clean feature branch/worktree; `git subtree add` must never absorb an unrelated dirty tree.

---

### Task 1: Pin MediaCrawler and establish the private service contract

**Files:**
- Import: `services/media-crawler/**` from upstream commit `d6f7c5bb906b6dac40ddf343ef9e26438a3de092`
- Create: `services/media-crawler/SHENSI_UPSTREAM.md`
- Create: `services/media-crawler/shensi_adapter/__init__.py`
- Create: `services/media-crawler/shensi_adapter/app.py`
- Create: `services/media-crawler/shensi_adapter/schemas.py`
- Create: `services/media-crawler/shensi_adapter/security.py`
- Create: `services/media-crawler/tests/shensi_adapter/test_contracts.py`
- Create: `backend/src/acquisition-mediacrawler-gateway.ts`
- Create: `backend/src/acquisition-mediacrawler-gateway-test.ts`
- Create: `tools/mediacrawler-provenance.test.mjs`
- Create: `docs/THIRD_PARTY_NOTICES.md`
- Modify: `backend/package.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: pinned MediaCrawler source and a private `MEDIACRAWLER_SERVICE_SECRET` containing at least 32 non-whitespace bytes.
- Produces: `createDouyinMediaCrawlerGateway(options): DouyinMediaCrawlerGateway`, private `/internal/v1/health`, and closed internal Pydantic schemas used by Tasks 2, 4, and 8.

- [ ] **Step 1: Write the failing provenance and gateway tests**

Create `tools/mediacrawler-provenance.test.mjs` with these assertions:

```js
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("MediaCrawler is pinned with its license and Shensi boundary", () => {
  assert.equal(existsSync("services/media-crawler/LICENSE"), true);
  const upstream = readFileSync("services/media-crawler/SHENSI_UPSTREAM.md", "utf8");
  assert.match(upstream, /d6f7c5bb906b6dac40ddf343ef9e26438a3de092/u);
  assert.match(upstream, /commercial authorization is held outside Git/u);
});
```

Create `backend/src/acquisition-mediacrawler-gateway-test.ts` to start a local fake HTTP server and assert that `health()` sends `Authorization: Bearer <secret>`, rejects extra response fields, rejects a response larger than 64 KiB, maps timeouts to `mediacrawler_unavailable`, and never includes the secret in an error.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test tools/mediacrawler-provenance.test.mjs
pnpm --dir backend exec tsx --test src/acquisition-mediacrawler-gateway-test.ts
```

Expected: provenance fails because `services/media-crawler` is absent; gateway fails with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Import the exact upstream tree**

Run from the repository root after confirming the target prefix is absent:

```bash
test ! -e services/media-crawler
git subtree add --prefix=services/media-crawler \
  https://github.com/NanmiCoder/MediaCrawler.git \
  d6f7c5bb906b6dac40ddf343ef9e26438a3de092 --squash
```

Create `services/media-crawler/SHENSI_UPSTREAM.md` recording the repository URL, exact commit, preserved license, update command, local adapter directories, and the sentence `Commercial authorization is held outside Git by the operator.` Create `docs/THIRD_PARTY_NOTICES.md` with the same provenance and a link to the retained `services/media-crawler/LICENSE`.

- [ ] **Step 4: Define the closed Python service schemas**

In `shensi_adapter/schemas.py`, define strict Pydantic models with `extra="forbid"`:

```python
class HealthView(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ok: Literal[True]
    service: Literal["shensi-mediacrawler"]
    upstream_commit: Literal["d6f7c5bb906b6dac40ddf343ef9e26438a3de092"]

class LoginSessionView(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str
    state: Literal["awaiting_scan", "active", "expired", "failed"]
    qr_image_data_url: str | None
    expires_at: datetime
    account_handle: str | None
    account_display_name: str | None
    login_state_version: int | None

class CrawlJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    job_id: str
    account_handle: str
    login_state_version: int
    keywords: list[str]
    max_videos: int
    max_comments_per_video: int
    max_pages_per_video: int
    deadline_at: datetime

class NormalizedDouyinRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    record_id: str
    kind: Literal["video", "creator", "comment"]
    canonical_url: AnyHttpUrl
    public_display_name: str
    public_profile_url: AnyHttpUrl | None
    text_excerpt: str
    source_keyword: str
    observed_at: datetime
    content_hash: str
```

Add `ActionRequest` with `action_id`, `account_handle`, `kind` (`comment` or `direct_message`), `target_public_url`, `content`, `deadline_at`, and `approved_content_hash`; add a closed receipt containing only identifiers, state, platform receipt reference, timestamp, and safe failure code.

- [ ] **Step 5: Implement service authentication and health**

In `security.py`, require a bearer secret of at least 32 bytes and compare it with `hmac.compare_digest`. In `app.py`, create a FastAPI app whose `/internal/v1/health` uses that dependency and returns `HealthView`. Reject missing/invalid credentials with a closed 401 body and no echoed header.

- [ ] **Step 6: Implement the Node gateway foundation**

In `acquisition-mediacrawler-gateway.ts`, define:

```ts
export interface DouyinMediaCrawlerGateway {
  health(signal?: AbortSignal): Promise<Readonly<{
    ok: true;
    service: "shensi-mediacrawler";
    upstreamCommit: "d6f7c5bb906b6dac40ddf343ef9e26438a3de092";
  }>>;
}

export function createDouyinMediaCrawlerGateway(options: {
  baseUrl: string;
  serviceSecret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): DouyinMediaCrawlerGateway;
```

Require a loopback/private-network HTTP URL, attach bearer auth internally,
cap response bytes, parse a strict Zod schema, normalize all errors to closed
gateway codes, and never retain the secret on the returned object.

- [ ] **Step 7: Run focused GREEN and commit**

Run:

```bash
uv run --directory services/media-crawler pytest tests/shensi_adapter/test_contracts.py -q
node --test tools/mediacrawler-provenance.test.mjs
pnpm --dir backend exec tsx --test src/acquisition-mediacrawler-gateway-test.ts
pnpm --dir backend run build
git diff --check
```

Stage only Task 1 files and commit:

```bash
git commit -m "feat(acquisition): add authorized MediaCrawler service boundary"
```

---

### Task 2: Add QR login and workspace-scoped Douyin accounts

**Files:**
- Create: `services/media-crawler/shensi_adapter/accounts.py`
- Create: `services/media-crawler/shensi_adapter/browser_state.py`
- Create: `services/media-crawler/tests/shensi_adapter/test_accounts.py`
- Modify: `services/media-crawler/shensi_adapter/app.py`
- Modify: `services/media-crawler/shensi_adapter/schemas.py`
- Create: `backend/src/acquisition-social-account.ts`
- Create: `backend/src/acquisition-social-account-repository.ts`
- Create: `backend/src/acquisition-social-account-mysql-repository.ts`
- Create: `backend/src/acquisition-social-account-service.ts`
- Create: `backend/src/acquisition-social-account-router.ts`
- Create: `backend/src/acquisition-social-account-test.ts`
- Create: `backend/src/acquisition-social-account-mysql-repository-test.ts`
- Create: `backend/src/acquisition-social-account-router-test.ts`
- Modify: `backend/src/acquisition-mediacrawler-gateway.ts`
- Modify: `backend/src/acquisition-application.ts:1112-2290`
- Modify: `backend/schema.mysql.sql`
- Modify: `backend/goodjob_crm.full.sql`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify generated: `frontend/src/generated/ai-acquisition.ts`
- Modify: `contracts/test/acquisition-openapi.test.mjs`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`
- Modify: `backend/src/acquisition-openapi-response-conformance-test.ts`

**Interfaces:**
- Consumes: Task 1 gateway/authentication and existing `ActiveWorkspaceContext`.
- Produces: `AcquisitionSocialAccountService`, one-account-per-workspace repository contract, and its mounted public router consumed by later tasks.

- [ ] **Step 1: Write QR/account RED tests**

Cover these exact cases in the three Node test files and the Python account test:

```ts
await service.createLoginSession(context, { platform: "douyin" });
assert.equal(gateway.createLoginSessionCalls, 1);
assert.equal(view.state, "awaiting_scan");
assert.equal("accountHandle" in view, false);

await assert.rejects(
  service.bindActiveSession(otherWorkspace, session.id),
  { code: "douyin_login_session_not_found" }
);
```

Also assert QR expiry, exact replay, active account replacement conflict,
disconnect cleanup, restart read, MySQL rollback, and that raw cookie/profile
fields cannot be inserted or returned. Contract tests require the four account
routes below with closed request, response, and error schemas.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
uv run --directory services/media-crawler pytest tests/shensi_adapter/test_accounts.py -q
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/acquisition-social-account-test.ts \
  src/acquisition-social-account-mysql-repository-test.ts \
  src/acquisition-social-account-router-test.ts
```

Expected: Python route/manager and Node modules are missing.

- [ ] **Step 3: Implement the Python account manager**

`AccountManager` creates random opaque session/account IDs, stores state under
a service-owned root, opens MediaCrawler's Douyin QR login in a persistent
context, and emits only a short-lived QR data URL plus safe state. Use one
private directory per account, mode `0700` for directories and `0600` for
files. Store the profile under an encrypted deployment volume; never serialize
cookies into API models or logs. Expired sessions close their browser context.

- [ ] **Step 4: Implement Node domain and repositories**

Define the closed public shape:

```ts
export type AcquisitionSocialAccountState =
  | "awaiting_scan" | "active" | "login_expired"
  | "risk_paused" | "disconnected";

export interface AcquisitionSocialAccount {
  id: string;
  workspaceId: string;
  platform: "douyin";
  displayName: string | null;
  state: AcquisitionSocialAccountState;
  loginStateVersion: number | null;
  revision: number;
  etag: string;
  lastValidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
```

Keep `accountHandle` in a private repository record, never in the public view.
Implement Memory/MySQL unique `(workspace_id, platform)`, exact session replay,
and disconnect state. Add exact DDL to both schema snapshots.

- [ ] **Step 5: Implement service and router**

Mount routes relative to `/api/v1/acquisition`:

```text
POST   /social-accounts/douyin/login-sessions
GET    /social-accounts/douyin/login-sessions/:sessionId
GET    /social-accounts/douyin
DELETE /social-accounts/:accountId
```

POST/DELETE require CSRF and `Idempotency-Key`; DELETE also requires current
`If-Match`. Bind every read/write to the authenticated workspace. Polling a
session that became active atomically persists the opaque account handle and
returns the sanitized account view.

- [ ] **Step 6: Publish account schemas and regenerate types**

Add closed login-session/account schemas and the four account operations to
the editable acquisition OpenAPI and runtime schema. Add request/response
conformance fixtures, then regenerate:

```bash
pnpm generate:frontend-contract-types
pnpm check:acquisition-contracts
```

Do not hand-edit generated interfaces.

- [ ] **Step 7: Run GREEN, parity, build, and commit**

Run the focused command from Step 2, then:

```bash
pnpm --dir backend run test:acquisition
pnpm check:acquisition-contracts
pnpm --dir backend run build
git diff --check
```

Commit only Task 2 files:

```bash
git commit -m "feat(acquisition): connect Douyin accounts by QR"
```

---

### Task 3: Publish automation policy and schedule commands

**Files:**
- Create: `backend/src/acquisition-douyin-automation.ts`
- Create: `backend/src/acquisition-douyin-automation-repository.ts`
- Create: `backend/src/acquisition-douyin-automation-mysql-repository.ts`
- Create: `backend/src/acquisition-douyin-automation-service.ts`
- Create: `backend/src/acquisition-douyin-automation-router.ts`
- Create: `backend/src/acquisition-douyin-automation-test.ts`
- Create: `backend/src/acquisition-douyin-automation-mysql-repository-test.ts`
- Create: `backend/src/acquisition-douyin-automation-router-test.ts`
- Modify: `backend/src/acquisition-plan-run-repository.ts:1-120`
- Modify: `backend/src/acquisition-application.ts:1112-2290`
- Modify: `backend/schema.mysql.sql`
- Modify: `backend/goodjob_crm.full.sql`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify generated: `frontend/src/generated/ai-acquisition.ts`
- Modify: `contracts/test/acquisition-openapi.test.mjs`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`
- Modify: `backend/src/acquisition-openapi-response-conformance-test.ts`

**Interfaces:**
- Consumes: active social account from Task 2 and existing acquisition plan versions.
- Produces: immutable `DouyinAutomationPolicyVersion`, GET/PUT automation routes, and idempotent run-now command used by Task 4.

- [ ] **Step 1: Write policy/contract RED tests**

The policy test constructs:

```ts
const input = {
  keywords: ["工业除尘设备", "工厂环保改造"],
  schedule: { enabled: true, localTime: "09:30", timeZone: "Asia/Shanghai" },
  dailyCandidateLimit: 50,
  collectCreators: true,
  collectDemandComments: true,
  limits: { maxVideos: 30, maxCommentsPerVideo: 50, maxPagesPerVideo: 3,
    maxDurationSeconds: 3600 }
};
```

Assert default 50, rejection of 0/201, duplicate/empty/overlong keywords,
invalid IANA timezone/time, disabled collection, cross-workspace account,
missing active account, changed idempotent replay, and two-writer `If-Match`
single winner. Contract tests require GET/PUT automation and POST run-now with
closed schemas; Task 2 account operations must remain byte-compatible.

- [ ] **Step 2: Run focused RED**

Run:

```bash
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/acquisition-douyin-automation-test.ts \
  src/acquisition-douyin-automation-mysql-repository-test.ts \
  src/acquisition-douyin-automation-router-test.ts
pnpm test:contracts
```

Expected: missing modules and missing OpenAPI operations.

- [ ] **Step 3: Implement immutable policy versions**

Define `DouyinAutomationPolicyInput`, `DouyinAutomationPolicyVersion`,
canonical hash, and default. Persist a head plus append-only versions and
idempotency binding. Server owns IDs, revisions, timestamps, ETags, and the
active account/login-state binding. PUT creates a new version; it never edits a
prior version.

- [ ] **Step 4: Implement GET/PUT/run-now routes**

`GET /plans/:planId/automation` returns current policy or a server default only
when no version exists. PUT requires `If-Match` and `Idempotency-Key`.
`POST /plans/:planId/run-now` freezes current plan, automation, account, and
daily-budget identities and creates the same durable run intent used by the
scheduler. Repeated keys return the same run; changed bodies conflict.

- [ ] **Step 5: Update OpenAPI and generated types**

Add closed schemas for automation input/version, run-now input/result, and
failure enums. Regenerate with:

```bash
pnpm generate:frontend-contract-types
pnpm check:acquisition-contracts
```

Do not hand-edit generated interfaces.

- [ ] **Step 6: Run GREEN and commit**

Run the focused tests, contract gate, backend build, frontend typecheck, and
`git diff --check`. Commit:

```bash
git commit -m "feat(acquisition): version Douyin automation policies"
```

---

### Task 4: Execute scheduled crawl jobs with durable cursor recovery

**Files:**
- Create: `services/media-crawler/shensi_adapter/crawl_jobs.py`
- Create: `services/media-crawler/shensi_adapter/douyin_normalizer.py`
- Create: `services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py`
- Modify: `services/media-crawler/shensi_adapter/app.py`
- Create: `backend/src/acquisition-crawler-job.ts`
- Create: `backend/src/acquisition-crawler-job-repository.ts`
- Create: `backend/src/acquisition-crawler-job-mysql-repository.ts`
- Create: `backend/src/acquisition-crawler-worker.ts`
- Create: `backend/src/acquisition-crawler-recovery-sweeper.ts`
- Create: `backend/src/acquisition-douyin-scheduler.ts`
- Create: `backend/src/acquisition-crawler-job-router.ts`
- Create: `backend/src/acquisition-crawler-job-test.ts`
- Create: `backend/src/acquisition-crawler-job-mysql-repository-test.ts`
- Create: `backend/src/acquisition-crawler-worker-test.ts`
- Create: `backend/src/acquisition-douyin-scheduler-test.ts`
- Create: `backend/src/acquisition-crawler-job-router-test.ts`
- Modify: `backend/src/acquisition-mediacrawler-gateway.ts`
- Modify: `backend/src/acquisition-application.ts:1112-2290`
- Modify: `backend/schema.mysql.sql`
- Modify: `backend/goodjob_crm.full.sql`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify generated: `frontend/src/generated/ai-acquisition.ts`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`
- Modify: `backend/src/acquisition-openapi-response-conformance-test.ts`

**Interfaces:**
- Consumes: Task 3 frozen automation/run intent and Task 1 private schemas.
- Produces: leased `AcquisitionCrawlerJob`, cursor pages of `NormalizedDouyinRecord`, daily scheduler, worker, and recovery sweeper used by Task 5.

- [ ] **Step 1: Write crawl lifecycle RED tests**

Test `scheduled -> queued -> running -> succeeded/partial/paused`, exact daily
dedupe by `(workspace, plan, policyVersion, localDate)`, run-now sharing the
same daily candidate budget, random 64-hex lease token, exact-expiry rejection,
same-worker ABA fencing, cursor replay, reordered cursor rejection, cancellation,
late result rejection, and restart recovery.

Python tests feed bounded Douyin creator/video/comment fixtures and assert
closed normalized records, content hashes, no cookie/raw-response fields,
one active crawl per account, and safe cancellation.

- [ ] **Step 2: Run RED**

```bash
uv run --directory services/media-crawler pytest tests/shensi_adapter/test_crawl_jobs.py -q
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/acquisition-crawler-job-test.ts \
  src/acquisition-crawler-job-mysql-repository-test.ts \
  src/acquisition-crawler-worker-test.ts \
  src/acquisition-douyin-scheduler-test.ts \
  src/acquisition-crawler-job-router-test.ts
```

- [ ] **Step 3: Implement sidecar job manager and result cursor**

Launch the pinned MediaCrawler Douyin search command with an account-specific
browser directory, `search` mode, comments enabled, and frozen limits. Keep
keywords as an argument list, never shell text. Normalize outputs into an
append-only per-job result log with a monotonically increasing opaque cursor.
Do not acknowledge/delete a result page; Node owns its persisted cursor.

- [ ] **Step 4: Implement Node repository, worker, and scheduler**

The worker claims a job, starts or resumes the sidecar job, pulls pages,
validates account/job/cursor/content hashes, transactionally stores raw bounded
normalized records plus the new cursor, renews its lease, and completes the
job. The scheduler uses the policy timezone and local date to create one run.
The sweeper reclaims expired jobs and never reuses an expired fence.

- [ ] **Step 5: Publish persisted crawler status**

Add `GET /runs/:runId/crawler-status`. Read only the workspace-bound persisted
Node job projection; do not proxy the sidecar's live process state to browsers.
Publish its closed schema in the editable acquisition OpenAPI, regenerate
frontend types, and add runtime response-conformance fixtures.

- [ ] **Step 6: Run GREEN and commit**

Run focused Python/Node tests, `test:acquisition`, backend build, and diff check.
Commit:

```bash
git commit -m "feat(acquisition): run recoverable Douyin crawls"
```

---

### Task 5: Convert crawler records into evidence-bound candidates

**Files:**
- Create: `backend/src/acquisition-douyin-crawler-ingestion.ts`
- Create: `backend/src/acquisition-douyin-crawler-ingestion-test.ts`
- Create: `backend/src/acquisition-douyin-candidate-policy.ts`
- Create: `backend/src/acquisition-douyin-candidate-policy-test.ts`
- Create: `backend/src/acquisition-run-candidates-router.ts`
- Create: `backend/src/acquisition-run-candidates-router-test.ts`
- Modify: `backend/src/acquisition-discovery-candidate-ingestion-test.ts`
- Modify: `backend/src/acquisition-canonical-subject.ts`
- Modify: `backend/src/acquisition-douyin-public-source.ts`
- Modify: `backend/src/acquisition-application.ts:1850-2050`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify generated: `frontend/src/generated/ai-acquisition.ts`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`
- Modify: `backend/src/acquisition-openapi-response-conformance-test.ts`

**Interfaces:**
- Consumes: Task 4 persisted normalized records and existing acquisition evidence/candidate repositories.
- Produces: `ingestDouyinCrawlerPage(input): Promise<DouyinCrawlerIngestionResult>` and qualified creator/commenter candidates used by Task 6.

- [ ] **Step 1: Write candidate-ingestion RED tests**

Use fixtures for one creator, one demand comment, duplicate canonical IDs,
edited comment content, missing profile identity, negative statements (`勿扰`,
`不需要`, `拒绝推销`), complaint/minor signals, and cross-job forged records.
Assert one evidence row per content hash, stable subject identity, no duplicate
candidate, exact supersession, do-not-contact suppression, and bounded public
excerpt retention.

- [ ] **Step 2: Run RED**

```bash
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/acquisition-douyin-crawler-ingestion-test.ts \
  src/acquisition-douyin-candidate-policy-test.ts \
  src/acquisition-discovery-candidate-ingestion-test.ts \
  src/acquisition-run-candidates-router-test.ts
```

- [ ] **Step 3: Implement the adapter into existing evidence/candidate APIs**

Map creator records to public individual subjects and demand comments to
individual demand signals. Store the source URL, bounded excerpt, source
keyword, platform record ID, observed time, and content hash. Use existing
canonical subject logic and run-candidate links. Add a closed provenance kind
`mediacrawler_public_record` bound to job ID, record ID, cursor, and upstream
commit.

- [ ] **Step 4: Implement qualification guardrails**

Keep an allowlist of business-demand stages and a closed refusal/complaint/
minor policy. A model score cannot override a hard refusal or missing original
source. Persist a one-way do-not-contact identity hash and minimum reason;
exclude the candidate before Task 6 draft generation.

- [ ] **Step 5: Publish run-scoped candidates and retention cleanup**

Add `GET /runs/:runId/candidates` backed by run-candidate links with
workspace filtering and a cursor bound to the run and filter hash. Publish the
closed response schema and regenerate frontend types. Cleanup may remove an
acknowledged sidecar result page after 24 hours and bounded unconverted
candidate evidence after 90 days, but preserves the platform-scoped one-way
do-not-contact identity hash until workspace deletion.

- [ ] **Step 6: Run GREEN and commit**

Run focused tests, `test:acquisition`, backend build, and diff check. Commit:

```bash
git commit -m "feat(acquisition): qualify Douyin crawler candidates"
```

---

### Task 6: Generate editable keywords and evidence-grounded outreach drafts

**Files:**
- Create: `backend/src/acquisition-douyin-keyword-generator.ts`
- Create: `backend/src/acquisition-douyin-keyword-generator-test.ts`
- Create: `backend/src/acquisition-outreach-draft.ts`
- Create: `backend/src/acquisition-outreach-draft-test.ts`
- Create: `backend/src/acquisition-outreach-model-content.ts`
- Create: `backend/src/acquisition-outreach-model-content-test.ts`
- Create: `backend/src/acquisition-outreach-draft-service.ts`
- Create: `backend/src/acquisition-outreach-draft-service-test.ts`
- Create: `backend/src/acquisition-douyin-keyword-router.ts`
- Create: `backend/src/acquisition-douyin-keyword-router-test.ts`
- Modify: `backend/src/acquisition-application.ts:1500-1700`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify generated: `frontend/src/generated/ai-acquisition.ts`
- Modify: `contracts/test/acquisition-openapi.test.mjs`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`
- Modify: `backend/src/acquisition-openapi-response-conformance-test.ts`

**Interfaces:**
- Consumes: existing active model gateway, Task 3 automation context, and Task 5 verified candidates/evidence.
- Produces: a public keyword-suggestion command, `generateDouyinKeywords`, validated immutable `AcquisitionOutreachDraft` values, and draft service used by Task 7.

- [ ] **Step 1: Write model-contract RED tests**

Define closed structured output:

```ts
interface AcquisitionOutreachDraft {
  candidateId: string;
  candidateRevision: number;
  evidenceHashes: string[];
  comment: string;
  directMessage: string;
  rationaleCodes: string[];
  modelSnapshotId: string;
  contentHash: string;
}
```

Test keyword dedupe/NFKC/limits, prompt-data isolation, forged candidate/evidence
rejection, explicit-refusal rejection, unsupported claims, URLs/phone numbers,
forbidden words, empty drafts, excessive lengths, multiline tricks, and exact
server recomputation of `contentHash`.

- [ ] **Step 2: Run RED**

```bash
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/acquisition-douyin-keyword-generator-test.ts \
  src/acquisition-douyin-keyword-router-test.ts \
  src/acquisition-outreach-model-content-test.ts \
  src/acquisition-outreach-draft-test.ts \
  src/acquisition-outreach-draft-service-test.ts
```

- [ ] **Step 3: Implement keyword and draft generation**

Use the official active model snapshot and structured output. The trusted
system prompt defines output keys and prohibited content; business/ICP and
public evidence are separate user payloads. Server code canonicalizes
keywords, verifies candidate revision/evidence membership, applies the
negative policy again, validates comment/message length, and computes the
immutable content hash.

- [ ] **Step 4: Publish keyword suggestions and keep draft persistence single-owned**

Add `POST /plans/:planId/automation/keyword-suggestions`. It derives the
workspace business and ICP context on the server, returns bounded editable
keywords plus the frozen model snapshot identity, and accepts no caller model
or workspace authority. Publish the closed contract, regenerate frontend
types, and add response conformance. Task 6 returns validated immutable draft
values but does not create a second draft repository: Task 7 persists generated
and human-edited revisions in `acquisition_outreach_batch_candidates`. Raw
model output is discarded after validation.

- [ ] **Step 5: Run GREEN and commit**

Run focused tests, model gateway tests, acquisition contract checks,
acquisition aggregate, build, and diff check. Commit:

```bash
git commit -m "feat(acquisition): draft evidence-grounded Douyin outreach"
```

---

### Task 7: Persist versioned batch approval and ordered action outbox

**Files:**
- Create: `backend/src/acquisition-outreach-batch.ts`
- Create: `backend/src/acquisition-outreach-batch-repository.ts`
- Create: `backend/src/acquisition-outreach-batch-mysql-repository.ts`
- Create: `backend/src/acquisition-outreach-batch-service.ts`
- Create: `backend/src/acquisition-outreach-batch-router.ts`
- Create: `backend/src/acquisition-outreach-batch-test.ts`
- Create: `backend/src/acquisition-outreach-batch-mysql-repository-test.ts`
- Create: `backend/src/acquisition-outreach-batch-router-test.ts`
- Modify: `backend/src/acquisition-application.ts:1112-2290`
- Modify: `backend/schema.mysql.sql`
- Modify: `backend/goodjob_crm.full.sql`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify generated: `frontend/src/generated/ai-acquisition.ts`
- Modify: `contracts/test/acquisition-openapi.test.mjs`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`
- Modify: `backend/src/acquisition-openapi-response-conformance-test.ts`

**Interfaces:**
- Consumes: Task 6 immutable draft revisions and Task 3 daily policy limit.
- Produces: batch CRUD/approval routes and ordered `AcquisitionOutreachAction` rows consumed by Task 8.

- [ ] **Step 1: Write batch/outbox RED tests**

Assert draft creation, candidate removal, message edit creating revision 2,
stale revision approval rejection, exact approval replay, changed request
conflict, daily remaining-limit calculation, cross-workspace rejection,
do-not-contact recheck, two-approver single winner, and rollback when the second
action insert fails.

For each selected candidate assert exact action rows:

```ts
[
  { kind: "comment", sequence: 1, status: "queued" },
  { kind: "direct_message", sequence: 2, status: "blocked_by_predecessor" }
]
```

- [ ] **Step 2: Run RED**

```bash
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/acquisition-outreach-batch-test.ts \
  src/acquisition-outreach-batch-mysql-repository-test.ts \
  src/acquisition-outreach-batch-router-test.ts
```

- [ ] **Step 3: Implement immutable batch revisions**

Freeze run, policy, account/login version, candidate revisions, evidence
hashes, draft revisions, model snapshots, daily limit, and canonical batch
hash. Persist Task 6 generated drafts as batch-candidate revision 1. Human
edits pass the same validators, preserve source model provenance, recompute
content hashes, and create the next batch-candidate revision. PUT creates a new
batch revision. Approval atomically stores approver/time, approval hash, exact
comment/message contents and hashes, and ordered actions.

- [ ] **Step 4: Implement public routes and contract**

Add these routes relative to `/api/v1/acquisition`:

```text
POST /runs/:runId/outreach-batches
GET  /outreach-batches/:batchId
PUT  /outreach-batches/:batchId
POST /outreach-batches/:batchId/approve
POST /outreach-batches/:batchId/reject
POST /outreach-batches/:batchId/pause
POST /outreach-batches/:batchId/resume
GET  /outreach-batches/:batchId/actions
```

Apply authentication, CSRF, capability, idempotency, ETag, and closed error
mapping. Regenerate frontend types and pass contract drift and response
conformance.

- [ ] **Step 5: Run GREEN and commit**

Run focused tests, `check:acquisition-contracts`, backend build, frontend
typecheck, and diff check. Commit:

```bash
git commit -m "feat(acquisition): approve immutable outreach batches"
```

---

### Task 8: Execute comment-then-message actions with recovery and risk pause

**Files:**
- Create: `services/media-crawler/shensi_adapter/douyin_actions.py`
- Create: `services/media-crawler/shensi_adapter/action_jobs.py`
- Create: `services/media-crawler/tests/shensi_adapter/test_actions.py`
- Modify: `services/media-crawler/shensi_adapter/app.py`
- Create: `backend/src/acquisition-outreach-action-worker.ts`
- Create: `backend/src/acquisition-outreach-action-recovery-sweeper.ts`
- Create: `backend/src/acquisition-outreach-action-worker-test.ts`
- Create: `backend/src/acquisition-outreach-action-mysql-integration-test.ts`
- Modify: `backend/src/acquisition-outreach-batch-repository.ts`
- Modify: `backend/src/acquisition-outreach-batch-mysql-repository.ts`
- Modify: `backend/src/acquisition-mediacrawler-gateway.ts`
- Modify: `backend/src/acquisition-application.ts:1112-2290`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes: Task 7 ordered actions and Task 2 active account/login binding.
- Produces: exact comment/message receipts, account risk pause, worker/sweeper lifecycle, and action-list projections used by Task 9.

- [ ] **Step 1: Write executor/worker RED tests**

Python fake-page tests cover successful comment, successful message, missing
control, verification page, rate limit, account warning, login expiry, timeout,
late success, and sanitized receipts. Assert the executor never invokes a
message before a comment receipt and never logs raw content/cookies.

Node tests cover claim fencing, account concurrency one, minimum delay,
comment exact replay, message exact replay, comment-success/message-failure,
three consecutive failures causing account-wide pause, restart recovery, and
no repeat after receipt persistence.

- [ ] **Step 2: Run RED**

```bash
uv run --directory services/media-crawler pytest tests/shensi_adapter/test_actions.py -q
pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/acquisition-outreach-action-worker-test.ts \
  src/acquisition-outreach-action-mysql-integration-test.ts
```

- [ ] **Step 3: Implement the sidecar action port**

Reuse only the account's authenticated browser context. For a comment, open
the frozen public video URL, locate the native comment composer, submit the
exact approved text once, and return the platform receipt reference visible in
the resulting page. For a direct message, open the frozen public profile,
locate the native message composer, submit the exact approved text once, and
return its receipt. Centralize Douyin UI selectors and page-state detection in
`douyin_actions.py`. Verification, warning, rate-limit, missing-control, and
login pages return closed errors and never trigger alternate bypass paths.

- [ ] **Step 4: Implement Node worker and recovery**

Claim the earliest eligible action for an active account. Revalidate account,
approval, candidate, content hash, predecessor receipt, daily limit, and delay
before calling the sidecar. Use persisted server timestamps to enforce at least
60 seconds between any two actions for the account and at least 180 seconds
from a candidate's comment receipt to its direct-message claim; restart and
clock skew must never shorten either interval. Persist the receipt under the
lease fence, unblock the matching message, or apply the closed failure/risk-
pause transition. Register worker/sweeper start and bounded close in the
acquisition application.

- [ ] **Step 5: Run GREEN and commit**

Run Python/Node focused tests, live MySQL integration when
`MYSQL_TEST_ADMIN_URL` is configured, acquisition aggregate, backend build, and
diff check. Commit:

```bash
git commit -m "feat(acquisition): execute approved Douyin outreach"
```

---

### Task 9: Build the Shensi account, automation, candidate, and approval UI

**Files:**
- Create: `frontend/src/acquisition/douyin-automation-api.ts`
- Create: `frontend/src/acquisition/douyin-automation-api.self-test.ts`
- Create: `frontend/src/acquisition/douyin-automation-controller.ts`
- Create: `frontend/src/acquisition/douyin-automation-controller.self-test.ts`
- Create: `frontend/src/acquisition/douyin-automation-view.ts`
- Create: `frontend/src/acquisition/douyin-automation-view.self-test.ts`
- Create: `frontend/src/acquisition/outreach-batch-api.ts`
- Create: `frontend/src/acquisition/outreach-batch-api.self-test.ts`
- Create: `frontend/src/acquisition/outreach-batch-controller.ts`
- Create: `frontend/src/acquisition/outreach-batch-controller.self-test.ts`
- Create: `frontend/src/acquisition/outreach-batch-view.ts`
- Create: `frontend/src/acquisition/outreach-batch-view.self-test.ts`
- Modify: `frontend/src/acquisition/runtime.ts`
- Modify: `frontend/src/acquisition/runtime-api.ts`
- Modify: `frontend/index.html`
- Modify: `frontend/src/replica-dashboard.css`
- Modify: `frontend/src/growth/styles.css`
- Create: `frontend/tests/douyin-mediacrawler-acquisition.spec.ts`
- Modify: `frontend/playwright.config.ts`

**Interfaces:**
- Consumes: Tasks 2-7 generated public types and Task 8 action projections.
- Produces: real `#acquisition` account/login, automation, run, candidate, approval, and receipt experience.

- [ ] **Step 1: Write API/controller/view RED tests**

API tests assert exact paths, CSRF, idempotency, If-Match, closed request
stripping, 401/403/409/412 propagation, malformed response rejection, and
AbortSignal use. Controller tests assert QR expiry/retry, one poller, schedule
save, run-now single flight, logout/close abort, generation fencing, candidate
selection, message edit creating a new revision, stale approval reload, pause/
resume, and receipt polling. View tests assert empty/loading/error/paused/
partial states, labels, focus management, keyboard operation, and no raw cookie
or internal handle rendering.

- [ ] **Step 2: Run RED**

```bash
pnpm --dir frontend exec tsx \
  src/acquisition/douyin-automation-api.self-test.ts
pnpm --dir frontend exec tsx \
  src/acquisition/douyin-automation-controller.self-test.ts
pnpm --dir frontend exec tsx \
  src/acquisition/douyin-automation-view.self-test.ts
pnpm --dir frontend exec tsx \
  src/acquisition/outreach-batch-controller.self-test.ts
```

Expected: new modules do not exist.

- [ ] **Step 3: Implement account and automation surfaces**

Add the Douyin account card, QR dialog, status/reconnect controls, editable
keyword chips, daily time/timezone, candidate limit default 50/range 1-200,
save/enable, and run-now. Replace link-import as the primary path; preserve it
only as a secondary authorized fallback while real automatic acquisition is
configured.

- [ ] **Step 4: Implement run, candidate, and approval surfaces**

Render collection counters, safe pause reason, creator/commenter candidate
rows, evidence inspector, exclusion/do-not-contact, exact comment/message
editors, batch totals, remaining daily limit, confirmation, and action
timeline. Desktop uses table plus inspector; mobile uses one-column cards.

- [ ] **Step 5: Add browser behavior test**

The Playwright test uses a deterministic HTTP fixture server, no
`page.route()` or response fulfillment, and verifies login-session QR states,
automation save, run progress, candidates, draft edit, revision conflict,
approval, comment receipt, message receipt, reload identity, keyboard flow,
1440/1024/390 layouts, vertical scroll, and zero console/HTTP errors.

- [ ] **Step 6: Run GREEN and commit**

```bash
pnpm --dir frontend test
pnpm --dir frontend test:types
pnpm --dir frontend exec playwright test \
  tests/douyin-mediacrawler-acquisition.spec.ts --project=chromium
pnpm --dir frontend build
git diff --check
```

Commit:

```bash
git commit -m "feat(frontend): control automatic Douyin acquisition"
```

---

### Task 10: Deploy, verify, document, and accept the real Douyin flow

**Files:**
- Create: `services/media-crawler/Dockerfile.shensi`
- Create: `services/media-crawler/.dockerignore.shensi`
- Create: `backend/src/douyin-mediacrawler-real-e2e-server.ts`
- Create: `backend/src/douyin-mediacrawler-real-e2e-server-test.ts`
- Create: `backend/src/douyin-mediacrawler-mysql-integration-test.ts`
- Create: `frontend/playwright.douyin-mediacrawler-real.config.ts`
- Create: `frontend/tests/douyin-mediacrawler-real.spec.ts`
- Modify: `deploy/compose.yaml`
- Modify: `scripts/dev.mjs`
- Modify: `scripts/deploy.mjs`
- Modify: `scripts/verify.mjs`
- Modify: `package.json`
- Modify: `backend/package.json`
- Modify: `frontend/package.json`
- Modify: `.env.example`
- Modify: `.env.production.example`
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/API_INDEX.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/modules/acquisition.md`
- Modify: `docs/THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Consumes: Tasks 1-9 complete runtime and public UI.
- Produces: reproducible deployment, restart evidence, no-intercept browser evidence, operator runbook, and explicit real-account acceptance result.

- [ ] **Step 1: Write deployment and real-runtime RED tests**

Add static deployment tests requiring Python 3.11/uv, non-root runtime,
private-only service network, health check, read-only code, encrypted state
volume, protected service-secret file, CPU/memory limits, and bounded shutdown.

The live MySQL test creates an isolated random database and two physical Node
connections. It proves account/policy/job/cursor/candidate/batch/approval/
action/receipt identities across repository/runtime restart and verifies exact
lease races and rollback. Missing `MYSQL_TEST_ADMIN_URL` fails with an explicit
required-env code; it does not silently fake a pass.

- [ ] **Step 2: Run RED**

```bash
node --test tools/*mediacrawler*.test.mjs
pnpm --dir backend exec tsx --test \
  src/douyin-mediacrawler-real-e2e-server-test.ts \
  src/douyin-mediacrawler-mysql-integration-test.ts
```

- [ ] **Step 3: Add container and wrapper integration**

Build the Python service in a multi-stage image, install pinned uv dependencies
and Playwright Chromium, run as a non-root user, and expose only its internal
port. Compose supplies secret-file paths and an encrypted state volume; the
gateway remains the only public service. Development/deploy/verify wrappers
fail closed for missing Python/uv/Playwright/secret/state permissions or a
publicly bound MediaCrawler port.

- [ ] **Step 4: Add isolated real server and browser harness**

The test server uses real Shensi auth/session/CSRF, MySQL repositories, Node
workers, and a real MediaCrawler service. The fixture mode may provide a fake
Douyin page adapter for deterministic CI but may not intercept Shensi HTTP
routes. The dedicated real config starts backend, sidecar, and Vite on owned
ports with `workers: 1`, `retries: 0`, and `reuseExistingServer: false`.

- [ ] **Step 5: Run the deterministic release gates**

```bash
pnpm check:context
pnpm test
pnpm build
pnpm check:acquisition-contracts
pnpm --dir backend run test:acquisition
pnpm --dir frontend test:types
pnpm --dir frontend exec playwright test \
  -c playwright.douyin-mediacrawler-real.config.ts --project=chromium
git diff --check
```

If Docker is available, also run `docker compose -f deploy/compose.yaml config`
and image builds. If Docker is unavailable, record the exact environment
blocker and do not claim container verification.

- [ ] **Step 6: Perform one dedicated-account external acceptance**

Use a dedicated Douyin test account and test-owned video/profile. Require the
operator to scan the QR. Run one bounded collection and approve one test
candidate. Verify exact comment then direct-message receipts, no unrelated
user contact, account state after restart, no duplicate action, and no secret
in API/log/test artifacts. Stop immediately on any verification or account
warning. Never automate CAPTCHA.

- [ ] **Step 7: Update current documentation with exact evidence**

Document the pinned commit and authorization boundary, account operation,
daily limits, risk pause, backup/restore of encrypted browser state, upgrade,
rollback, troubleshooting, test counts, environment blockers, and whether the
dedicated-account acceptance passed. `docs/PROJECT_STATUS.md` remains the sole
progress ledger; do not copy test counts into competing status documents.

- [ ] **Step 8: Audit secrets, scope, and commit**

Run:

```bash
git diff --check
git status --short
git diff --name-only | rg '(\.env\.local|browser_data|user_data_dir|cookie|test-results)' && exit 1 || true
git diff -- frontend/pnpm-lock.yaml backend/package-lock.json pnpm-lock.yaml
```

Restore any mechanical lock drift with `apply_patch`, stage only declared Task
10 files, inspect `git diff --cached`, and commit:

```bash
git commit -m "feat(acquisition): deploy verified Douyin automation"
```

## Final completion gate

After Task 10, run the complete focused Python suite, acquisition aggregate,
contracts, backend/frontend builds, frontend self-tests, deterministic
no-intercept browser flow, live MySQL restart/race suite, context check, secret
audit, and diff check from a clean tracked worktree. Report dedicated-account
external acceptance separately from deterministic and MySQL evidence. A
missing QR scan, external account, MySQL admin URL, Docker runtime, or real
Douyin success remains an explicit blocker rather than a skipped success.

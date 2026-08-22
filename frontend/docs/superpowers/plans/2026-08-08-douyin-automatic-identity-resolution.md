# 抖音公开线索主体自动核验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将抖音公开视频、评论信号和短链接产生的未解析候选，在“抖音公开页证据 + 独立搜索证据”唯一一致时自动确认主体，并且只启动一条真实 AI 客户研究、意向评分、财务价值和作战卡链路。

**Architecture:** 新增一个独立、持久化、可恢复的 Douyin identity-resolution operation；它使用专用的受控公开页解析端口和现有真实搜索连接收集两类证据，再通过纯确定性门禁决定自动确认或转人工。核验成功后复用现有 `AcquisitionIdentityResolutionService.resolveCandidateIdentity()` 与 `AcquisitionCandidateIntelligenceOperationService.createAfterIdentity()`；搜索 Run 复用冻结的计划模型会话，并跳过旧的三阶段重复执行，独立链接导入则使用当前已激活的官方模型连接。

**Tech Stack:** TypeScript、Node.js 22、Express、MySQL 8 JSON payload repository、Zod、现有 provider HTTP 安全客户端、Vite、Playwright、Node test。

## Global Constraints

- 只有唯一规范化 HTTPS 抖音 `/user/<sec_uid>` 同时具备 `douyin_public_page` 与 `independent_search_result` 两类独立证据时，才允许自动确认。
- 大模型不得参与主体身份提交；身份门禁只使用 URL、证据类别、来源指纹、访问状态、冲突和候选版本。
- 证据门禁通过前只调用 `appendEvidence`，不得 `attachEvidenceToCandidate`，避免候选版本自行递增造成 `stale_candidate`。
- 自动提交幂等键固定由 operation `requestHash` 派生：`douyin-identity:commit:<hash>`；研判幂等键为 `douyin-identity:intelligence:<hash>`。
- 搜索 Run 内自动确认成功后，使用同一 `acquisition-plan:<runId>` 会话执行 candidate-intelligence，并跳过旧 research/qualification/battle-card 三阶段，禁止重复模型调用和重复决策。
- 用户单独导入公开链接时，自动确认后走 `createAfterIdentity()` 的默认官方模型快照会话。
- identity-resolution operation 的 `succeeded` 表示主体已确认且 candidate-intelligence 已安全创建；后续模型失败由现有 candidate-intelligence operation 记录和恢复，不得重新提交身份确认。
- 无搜索连接、页面受限、证据不足、歧义、冲突、越界重定向或版本变化均失败关闭；不修改身份，进入现有人工核验工作台。
- 不新增评论、私信、加好友、群发、自动 CRM 写入、新平台、OAuth、浏览器模拟或逆向协议。
- 不创建第二套评分、作战卡或人工审核系统；前端只展示服务端权威状态。
- 保留用户未提交改动：`GoodJob-marketing-system-frontend/pnpm-workspace.yaml`，以及 `GoodJob-1.09/frontend/src/features/ai-growth/**` 与未跟踪计划文档。

---

### Task 1: 受控抖音公开页解析与确定性证据门禁

**Files:**
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/provider-http-client.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/provider-http-client-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-public-profile-discovery.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-public-profile-discovery-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-identity-consensus.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-identity-consensus-test.ts`

**Interfaces:**
- Produces `fetchProviderHttpWithRedirectTrace(policy, url, init)` without changing existing `ProviderHttpClient.fetch()` behavior.
- Produces `AcquisitionDouyinPublicProfileDiscoveryPort.discover(input)` for explicit public author/profile links only.
- Produces `decideDouyinIdentityConsensus(input)` as a pure function; it never writes evidence or identity.

- [ ] **Step 1: Write failing redirect-trace security tests**

```ts
const traced = await fetchProviderHttpWithRedirectTrace(
  {
    allowedHosts: ["v.douyin.com"],
    redirectHosts: ["www.douyin.com"],
    allowedPathPrefixes: ["/"],
    allowedMethods: ["GET"]
  },
  "https://v.douyin.com/TraceMe/",
  { method: "GET" }
);
assert.deepEqual(traced.redirectChain, [
  "https://v.douyin.com/TraceMe/",
  "https://www.douyin.com/video/7521000000000000000"
]);
await assert.rejects(
  () => fetchProviderHttpWithRedirectTrace(policy, unsafeUrl, { method: "GET" }),
  /不在已批准|跨主机重定向/u
);
```

- [ ] **Step 2: Run the HTTP test and verify RED**

Run:

```bash
cd /Users/mac/Documents/外贸/GoodJob-1.09/backend
NODE_ENV=test node --import tsx --test src/provider-http-client-test.ts
```

Expected: FAIL because `fetchProviderHttpWithRedirectTrace` is not exported.

- [ ] **Step 3: Refactor the existing redirect loop once and expose trace output**

```ts
export interface ProviderHttpRedirectTrace {
  response: Response;
  redirectChain: string[];
}

export async function fetchProviderHttpWithRedirectTrace(
  policy: ProviderNetworkPolicy,
  rawUrl: string,
  init: RequestInit = {}
): Promise<ProviderHttpRedirectTrace>;
```

`createProviderHttpClient(policy).fetch()` must delegate to the same internal loop and return only `trace.response`. Preserve the current maximum of three redirects, DNS/public-IP validation, credential restrictions, size limit and timeout.

- [ ] **Step 4: Write failing public-profile discovery tests**

Cover all of these exact cases:

```ts
assert.deepEqual(
  await discovery.discover({
    sourceUrl: "https://www.douyin.com/video/7521000000000000000",
    sourceEvidenceId: "evidence-video",
    signal: new AbortController().signal
  }),
  {
    status: "succeeded",
    redirectChain: ["https://www.douyin.com/video/7521000000000000000"],
    publicProfileUrls: ["https://www.douyin.com/user/MS4wLjABAAAA-author"],
    rawArtifactHash: "sha256:fixture",
    contentHash: "sha256:fixture-content"
  }
);
```

Also assert: `/video/` and short URLs are never returned as profiles; duplicate links normalize to one URL; `douyin.com.evil.example`, non-HTTPS, login/verification pages and unapproved redirect hosts return `redirect_not_allowed` or `access_restricted`; nickname-only text produces no profile.

- [ ] **Step 5: Implement the dedicated discovery port**

```ts
export type DouyinPublicProfileDiscoveryResult =
  | {
      status: "succeeded";
      redirectChain: string[];
      publicProfileUrls: string[];
      rawArtifactHash: string;
      contentHash: string;
    }
  | {
      status: "access_restricted" | "redirect_not_allowed" | "not_found";
      redirectChain: string[];
      publicProfileUrls: [];
    };

export interface AcquisitionDouyinPublicProfileDiscoveryPort {
  discover(input: {
    sourceUrl: string;
    sourceEvidenceId: string;
    signal?: AbortSignal;
  }): Promise<DouyinPublicProfileDiscoveryResult>;
}
```

The production adapter must use a fixed exact-host allowlist containing `douyin.com`, `www.douyin.com`, `v.douyin.com`, `iesdouyin.com`, and `www.iesdouyin.com`; extract only explicit `href`, canonical or structured public URLs that pass `classifyDouyinPublicSource(...).sourceType === "profile"` and `isVerifiedAcquisitionPublicProfileUrl()`.

- [ ] **Step 6: Write failing consensus tests**

```ts
const verified = decideDouyinIdentityConsensus({
  expectedCandidateVersion: 3,
  currentCandidateVersion: 3,
  evidence: [
    publicPageEvidence("https://www.douyin.com/user/actor", "page-fingerprint"),
    searchEvidence("https://www.douyin.com/user/actor", "search-fingerprint")
  ]
});
assert.equal(verified.outcome, "verified_consensus");
assert.equal(verified.canonicalProfileUrl, "https://www.douyin.com/user/actor");
```

Add explicit assertions for one evidence class → `insufficient_evidence`; two profiles → `ambiguous`; A/B disagree → `conflicting`; restricted evidence → `access_restricted`; changed version → `stale_candidate`; repeated evidence with the same source fingerprint counts once.

- [ ] **Step 7: Implement the pure consensus function**

```ts
export type DouyinIdentityEvidenceClass =
  | "douyin_public_page"
  | "independent_search_result";

export type DouyinIdentityResolutionOutcome =
  | "verified_consensus"
  | "not_found"
  | "insufficient_evidence"
  | "ambiguous"
  | "conflicting"
  | "access_restricted"
  | "redirect_not_allowed"
  | "stale_candidate"
  | "provider_unavailable";

export function decideDouyinIdentityConsensus(input: {
  expectedCandidateVersion: number;
  currentCandidateVersion: number;
  evidence: DouyinIdentityEvidence[];
}): DouyinIdentityConsensusDecision;
```

Return `verified_consensus` only when exactly one normalized profile has at least one accessible, distinct source fingerprint from each evidence class and no valid conflicting profile.

- [ ] **Step 8: Run focused tests and commit Task 1**

```bash
cd /Users/mac/Documents/外贸/GoodJob-1.09/backend
NODE_ENV=test node --import tsx --test --test-concurrency=1 \
  src/provider-http-client-test.ts \
  src/acquisition-douyin-public-profile-discovery-test.ts \
  src/acquisition-douyin-identity-consensus-test.ts
git add src/provider-http-client.ts src/provider-http-client-test.ts \
  src/acquisition-douyin-public-profile-discovery.ts \
  src/acquisition-douyin-public-profile-discovery-test.ts \
  src/acquisition-douyin-identity-consensus.ts \
  src/acquisition-douyin-identity-consensus-test.ts
git commit -m "feat(acquisition): verify public Douyin profile evidence"
```

---

### Task 2: 持久化主体核验 Operation、证据来源与恢复机制

**Files:**
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-domain.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-v1-router.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-v1-router-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-identity-resolution-operations.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-identity-resolution-operations-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-identity-resolution-mysql-repository.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-identity-resolution-mysql-repository-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-identity-resolution-recovery-sweeper.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-identity-resolution-recovery-sweeper-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/contracts/json-schema/discovery-evidence.v1.schema.json`

**Interfaces:**
- Extends evidence provenance with an honest `controlled_public_page` variant.
- Produces a lease-backed `AcquisitionDouyinIdentityResolutionOperationRepository` with memory and MySQL implementations.
- Produces a recovery sweeper for queued and expired-running operations.

- [ ] **Step 1: Write failing evidence provenance tests**

```ts
const evidence = await domain.appendEvidence(scope, {
  targetType: "individual_signal",
  sourcePlatform: "douyin",
  sourceTitle: "抖音公开主页",
  sourceSnippet: "由公开视频中的明确作者链接解析并公开验证。",
  publishedAt: null,
  locale: "zh-CN",
  rawArtifactHash: "sha256:page",
  contentHash: "sha256:content",
  provenance: {
    kind: "controlled_public_page",
    sourceUrl: "https://www.douyin.com/user/actor",
    discoveredFromEvidenceId: "evidence-video",
    redirectChain: ["https://www.douyin.com/video/1"],
    extractorVersion: "douyin-public-profile-v1"
  },
  accessStatus: "public_content",
  supersedesEvidenceId: null
}, "page-evidence-key");
assert.equal(evidence.provenance.kind, "controlled_public_page");
```

Verify the router and JSON schema reject empty redirect chains, non-HTTPS URLs, unsupported final profile paths and more than four redirect entries.

- [ ] **Step 2: Add the provenance variant and make existing readers exhaustive**

```ts
type ControlledPublicPageEvidenceProvenance = {
  kind: "controlled_public_page";
  sourceUrl: string;
  discoveredFromEvidenceId: string;
  redirectChain: string[];
  extractorVersion: "douyin-public-profile-v1";
};
```

Update Zod/read schemas without changing existing `search_result`, `user_submitted_url`, or `import_artifact_row` payloads. The MySQL domain evidence record remains JSON and needs no table migration.

- [ ] **Step 3: Write failing in-memory operation tests**

Test exact transitions and invariants:

```ts
const created = await service.create(scope, {
  candidateId: "candidate-1",
  expectedCandidateVersion: 3,
  sourceEvidenceIds: ["evidence-video"],
  providerConnectionIds: ["search-connection-1"],
  planSessionId: "acquisition-plan:run-1"
}, "identity-create-key");
assert.equal(created.status, "queued");
assert.equal(created.candidateVersion, 3);
```

Also assert same key/same request replays; same key/different request conflicts; source evidence order does not alter `requestHash`; duplicate source evidence IDs are rejected; only lease owner can save; latest candidate lookup is tenant scoped; terminal operations are never claimed; expired running operations recover.

- [ ] **Step 4: Implement operation types and the in-memory repository**

```ts
export type AcquisitionDouyinIdentityResolutionStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "requires_review"
  | "failed";

export type AcquisitionDouyinIdentityResolutionStage =
  | "public_page"
  | "independent_search"
  | "consensus_gate"
  | "identity_confirmation"
  | "intelligence_dispatch";

export interface AcquisitionDouyinIdentityResolutionOperation {
  id: string;
  ownerId: string;
  teamId: string;
  actorId: string;
  candidateId: string;
  candidateVersion: number;
  sourceEvidenceFingerprint: string;
  providerConnectionIds: string[];
  planSessionId: string | null;
  status: AcquisitionDouyinIdentityResolutionStatus;
  currentStage: AcquisitionDouyinIdentityResolutionStage | null;
  outcome: DouyinIdentityResolutionOutcome | null;
  retryable: boolean;
  canonicalProfileUrl: string | null;
  profileCandidates: Array<{
    publicProfileUrl: string;
    evidenceIds: string[];
  }>;
  evidence: DouyinIdentityEvidence[];
  intelligenceOperationId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
```

The private record adds `idempotencyKeyHash`, `requestHash`, `leaseOwner`, `leaseToken`, and `leaseExpiresAt`. `requestHash` must contain candidate ID, candidate version, sorted source evidence content/raw hashes, sorted search connection IDs and plan session ID, but no timestamps.

- [ ] **Step 5: Write failing MySQL integrity tests**

Cover schema creation, create/replay/conflict, tenant-scoped latest lookup, claim/save/lease renewal, recovery ordering, and JSON/indexed-column mismatch rejection. Use the same disposable-MySQL convention as `acquisition-candidate-intelligence-mysql-repository-test.ts`.

- [ ] **Step 6: Implement the MySQL repository and schema**

Create `acquisition_douyin_identity_resolution_operations` with:

```sql
PRIMARY KEY (id),
UNIQUE KEY uk_douyin_identity_resolution_idempotency
  (owner_id, team_id, idempotency_key_hash),
KEY idx_douyin_identity_resolution_latest
  (owner_id, team_id, candidate_id, created_at, id),
KEY idx_douyin_identity_resolution_recovery
  (status, lease_expires_at, created_at, id)
```

Persist the full operation in `payload_json`, repeat scope/candidate/status/hash/lease columns for indexed integrity checks, and constrain statuses to `queued`, `running`, `succeeded`, `requires_review`, and `failed`.

- [ ] **Step 7: Write and implement recovery sweeper tests**

```ts
const sweeper = new AcquisitionDouyinIdentityResolutionRecoverySweeper({
  service,
  dispatch: async (scope, operationId) => dispatched.push({ scope, operationId }),
  intervalMs: 1_000,
  batchSize: 100,
  setTimer: fakeSetTimer,
  clearTimer: fakeClearTimer
});
await sweeper.start();
assert.deepEqual(dispatched.map((item) => item.operationId), ["queued", "expired"]);
```

Match the lifecycle guarantees of `AcquisitionCandidateIntelligenceRecoverySweeper`: one active sweep, bounded interval/batch, errors isolated per operation, `stop()` waits for the current sweep.

- [ ] **Step 8: Run focused tests and commit Task 2**

```bash
cd /Users/mac/Documents/外贸/GoodJob-1.09/backend
NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 \
  src/acquisition-v1-router-test.ts \
  src/acquisition-douyin-identity-resolution-operations-test.ts \
  src/acquisition-douyin-identity-resolution-mysql-repository-test.ts \
  src/acquisition-douyin-identity-resolution-recovery-sweeper-test.ts
git add src/acquisition-domain.ts src/acquisition-v1-router.ts \
  src/acquisition-v1-router-test.ts \
  src/acquisition-douyin-identity-resolution-operations.ts \
  src/acquisition-douyin-identity-resolution-operations-test.ts \
  src/acquisition-douyin-identity-resolution-mysql-repository.ts \
  src/acquisition-douyin-identity-resolution-mysql-repository-test.ts \
  src/acquisition-douyin-identity-resolution-recovery-sweeper.ts \
  src/acquisition-douyin-identity-resolution-recovery-sweeper-test.ts \
  ../contracts/json-schema/discovery-evidence.v1.schema.json
git commit -m "feat(acquisition): persist Douyin identity resolution"
```

---

### Task 3: 执行真实 A/B 证据核验并只启动一条 AI 研判链

**Files:**
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-identity-resolution-operations.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-identity-resolution-operations-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-candidate-intelligence-operations.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-candidate-intelligence-operations-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-candidate-processing-pipeline.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-candidate-processing-pipeline-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-application.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-application-test.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-baidu-tracer-bullet-test.ts`

**Interfaces:**
- `execute()` collects first-party and search evidence, applies the consensus gate, commits identity, then creates and executes one candidate-intelligence operation.
- `createAfterIdentity()` accepts an optional trusted plan session ID so Run-selected model snapshots remain frozen.
- Candidate pipeline treats an automatic identity operation as the owner of downstream intelligence and skips its old three stages.

- [ ] **Step 1: Write failing operation execution tests for every terminal outcome**

Test the complete success path:

```ts
const completed = await service.execute(scope, created.id);
assert.equal(completed.status, "succeeded");
assert.equal(completed.outcome, "verified_consensus");
assert.equal(completed.canonicalProfileUrl, profileUrl);
assert.equal(identityCommits.length, 1);
assert.equal(identityCommits[0]?.input.expectedCandidateVersion, 3);
assert.equal(intelligenceCreates.length, 1);
assert.equal(intelligenceExecutes.length, 1);
```

Then cover `not_found`, `insufficient_evidence`, `ambiguous`, `conflicting`, `access_restricted`, `redirect_not_allowed`, `stale_candidate`, and `provider_unavailable`. Assert that all `requires_review` and `failed` outcomes produce zero identity commits and zero intelligence operations.

- [ ] **Step 2: Implement evidence collection without mutating candidate version**

For each original source evidence:

1. Run `AcquisitionDouyinPublicProfileDiscoveryPort.discover()`.
2. Fetch each explicit profile URL and append an evidence record whose provenance kind is `controlled_public_page` and whose `provenance.sourceUrl` equals the canonical profile URL; expose it to the consensus gate as evidence class `douyin_public_page`.
3. Search each stored provider connection using a bounded query derived from the video ID, original URL, title and visible author clue.
4. Append only search results whose target is a verified Douyin `/user/` URL as `search_result` evidence with real provider/connection/request/result IDs.
5. Do not attach either evidence class to the candidate before the gate.

Provider connection failures are isolated. If no configured connection produces a valid audited response, return `provider_unavailable`; if responses succeed but no profile result exists, return `insufficient_evidence` or `not_found` according to the public-page result.

- [ ] **Step 3: Commit the verified identity with deterministic keys**

```ts
await identityResolutionService.resolveCandidateIdentity(
  scope,
  operation.candidateId,
  {
    expectedCandidateVersion: operation.candidateVersion,
    evidenceIds: verifiedEvidenceIds,
    rationale: "抖音公开页与独立搜索结果共同指向唯一公开主页。",
    subject: {
      kind: "individual",
      publicProfileUrl: decision.canonicalProfileUrl,
      sourcePlatform: "douyin"
    }
  },
  `douyin-identity:commit:${operation.requestHash}`
);
```

Re-read the candidate immediately before this call. If its version changed, save `requires_review/stale_candidate` and do not attempt the commit.

- [ ] **Step 4: Write a failing frozen-model-session test for candidate intelligence**

```ts
const operation = await service.createAfterIdentity(
  scope,
  candidateId,
  "plan-bound-key",
  { trustedSessionId: "acquisition-plan:run-123" }
);
assert.equal(operation.sessionId, "acquisition-plan:run-123");
assert.equal(sessionFactoryCalls.length, 0);
```

Also prove ordinary calls without `trustedSessionId` still create exactly one session through the existing factory and retain old idempotency behavior.

- [ ] **Step 5: Extend `createAfterIdentity` minimally**

```ts
async createAfterIdentity(
  scope: AcquisitionCandidateIntelligenceScope,
  candidateId: string,
  idempotencyKey: string,
  options: { trustedSessionId?: string } = {}
): Promise<AcquisitionCandidateIntelligenceOperation>
```

Only accept supplied values matching `^acquisition-plan:[A-Za-z0-9._:-]{1,200}$`. Bind the supplied session ID into the request hash. When absent, preserve the current session factory path unchanged.

- [ ] **Step 6: Start and finish exactly one intelligence operation**

```ts
const intelligence = await candidateIntelligence.createAfterIdentity(
  scope,
  operation.candidateId,
  `douyin-identity:intelligence:${operation.requestHash}`,
  operation.planSessionId
    ? { trustedSessionId: operation.planSessionId }
    : {}
);
const completedIntelligence = await candidateIntelligence.execute(
  scope,
  intelligence.id
);
```

Save `intelligenceOperationId` before executing so recovery can replay safely. A replay must return the same operation and must not create duplicate research, qualification, financial value or battle card decisions.

- [ ] **Step 7: Write failing candidate-pipeline tests for handoff and no duplication**

```ts
const pipeline = new AcquisitionCandidateProcessingPipeline({
  executor,
  research,
  identityResolutionStage
});
const result = await pipeline.process(inputWithUnresolvedDouyinCandidate);
assert.deepEqual(identityResolutionCalls, ["candidate-unresolved"]);
assert.equal(executorCalls.length, 0);
assert.deepEqual(result.processedCandidateIds, ["candidate-unresolved"]);
assert.deepEqual(result.battleCardCandidateIds, ["candidate-unresolved"]);
```

For `requires_review`, assert a single failure with stage `research` and error `IDENTITY_RESEARCH_REQUIRED`; for resolved or non-Douyin candidates, assert the existing pipeline behavior is unchanged.

- [ ] **Step 8: Add the identity stage port and skip duplicate stages**

```ts
export interface AcquisitionCandidateIdentityResolutionStagePort {
  resolveBeforeIntelligence(input: AcquisitionCandidateProcessingInput & {
    candidateId: string;
  }): Promise<
    | { status: "not_required" }
    | {
        status: "completed";
        operationId: string;
        intelligence: AcquisitionCandidateIntelligenceOperation;
      }
    | { status: "requires_review"; operationId: string; errorCode: string }
  >;
}
```

When `status === "completed"`, map the returned intelligence result into `processedCandidateIds`/`battleCardCandidateIds` and `continue`; do not call supplemental research or the old executor stages for that candidate.

- [ ] **Step 9: Wire application repositories, workers, recovery and direct-link triggers**

In `acquisition-application.ts`:

- add memory/MySQL identity-resolution repositories and schema initialization;
- construct the public-profile discovery adapter, operation service and recovery sweeper after candidate-intelligence service exists;
- inject `identityResolutionStage` into `AcquisitionCandidateProcessingPipeline`;
- for direct content-fetch/import completion, submit each unresolved Douyin `candidateId` with active search connection IDs and no plan session, then dispatch the identity operation in the background;
- for search Run processing, pass the shard connection and `acquisition-plan:<runId>`;
- track active identity tasks; wait for them and stop the sweeper during application close.

Do not invoke this workflow from `AcquisitionIndividualSignalIngestionService`; doing so would race with search pipeline processing.

- [ ] **Step 10: Run focused backend integration tests and commit Task 3**

```bash
cd /Users/mac/Documents/外贸/GoodJob-1.09/backend
NODE_ENV=test TZ=UTC JWT_SECRET=goodjob-acquisition-test-secret-at-least-32-characters \
ACQUISITION_MASTER_SECRET=goodjob-acquisition-master-test-secret-at-least-32-bytes \
node --import tsx --test --test-concurrency=1 \
  src/acquisition-douyin-identity-resolution-operations-test.ts \
  src/acquisition-candidate-intelligence-operations-test.ts \
  src/acquisition-candidate-processing-pipeline-test.ts \
  src/acquisition-application-test.ts \
  src/acquisition-douyin-baidu-tracer-bullet-test.ts
git add src/acquisition-douyin-identity-resolution-operations.ts \
  src/acquisition-douyin-identity-resolution-operations-test.ts \
  src/acquisition-candidate-intelligence-operations.ts \
  src/acquisition-candidate-intelligence-operations-test.ts \
  src/acquisition-candidate-processing-pipeline.ts \
  src/acquisition-candidate-processing-pipeline-test.ts \
  src/acquisition-application.ts src/acquisition-application-test.ts \
  src/acquisition-douyin-baidu-tracer-bullet-test.ts
git commit -m "feat(acquisition): auto-resolve Douyin candidate identity"
```

---

### Task 4: 查询、重试与 OpenAPI 合同

**Files:**
- Create: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-identity-resolution-router.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-identity-resolution-router-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-application.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-1.09/contracts/json-schema/douyin-identity-resolution-operation.v1.schema.json`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/contracts/test/openapi.test.mjs`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-openapi.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-openapi-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-openapi-response-conformance-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-openapi-contract-drift-test.ts`

**Interfaces:**
- GET latest operation for a candidate; 404 means none exists.
- POST safely creates/retries an operation and dispatches it; it never accepts a client-supplied profile or consensus result.

- [ ] **Step 1: Write failing router tests**

```ts
const latest = await fixture.request(
  "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operation"
);
assert.equal(latest.response.status, 200);
assert.equal(latest.json.outcome, "verified_consensus");

const retry = await fixture.request(
  "/api/v1/acquisition/candidates/candidate-1/douyin-identity-resolution-operations",
  {
    method: "POST",
    headers: { "Idempotency-Key": "retry-operation-1" },
    body: "{}"
  }
);
assert.equal(retry.response.status, 202);
```

Also cover tenant isolation, unauthenticated requests, invalid candidate, resolved/non-Douyin candidate, missing/duplicate idempotency key, replay header and retry of a non-retryable terminal operation.

- [ ] **Step 2: Implement the minimal router**

```ts
GET  /api/v1/acquisition/candidates/:candidateId/douyin-identity-resolution-operation
POST /api/v1/acquisition/candidates/:candidateId/douyin-identity-resolution-operations
```

The POST body is exactly `{}`. The server re-reads candidate version and source evidence, selects active tenant-owned search connections, creates a new operation only when allowed, returns `202`, then dispatches background execution. The client cannot provide `canonicalProfileUrl`, evidence classes, provider IDs, outcome or retryability.

- [ ] **Step 3: Write the operation JSON Schema**

The router must project a safe public DTO that omits `ownerId`, `teamId`, `actorId`, `providerConnectionIds`, `planSessionId`, `sourceEvidenceFingerprint`, idempotency/request hashes and lease fields. The schema requires every remaining public field, sets `additionalProperties: false`, caps profile candidates/evidence at 100, restricts URLs to strings with maximum 4096 characters, and uses exact enums for status, stage, outcome, evidence class and access status.

- [ ] **Step 4: Update canonical and generated OpenAPI surfaces**

Add both paths and response schema to `contracts/openapi/ai-acquisition.v1.yaml` and mirror them in `backend/src/acquisition-openapi.ts`. GET returns `200/401/404`; POST returns `202/400/401/404/409/422/429` and requires `Idempotency-Key`. Extend contract drift and response conformance tests before regenerating any derived types.

- [ ] **Step 5: Run contract tests and commit Task 4**

```bash
cd /Users/mac/Documents/外贸/GoodJob-1.09
npm run test:contracts
npm run test:contract-drift --workspace backend
npm run test:acquisition-openapi --workspace backend
npm run generate:frontend-contract-types
npm run check:generated-acquisition-types
git add backend/src/acquisition-douyin-identity-resolution-router.ts \
  backend/src/acquisition-douyin-identity-resolution-router-test.ts \
  backend/src/acquisition-application.ts \
  backend/src/acquisition-openapi.ts \
  backend/src/acquisition-openapi-test.ts \
  backend/src/acquisition-openapi-response-conformance-test.ts \
  backend/src/acquisition-openapi-contract-drift-test.ts \
  contracts/json-schema/douyin-identity-resolution-operation.v1.schema.json \
  contracts/openapi/ai-acquisition.v1.yaml contracts/test/openapi.test.mjs
git commit -m "feat(acquisition): expose Douyin identity resolution status"
```

---

### Task 5: 新前端显示自动核验状态、证据和安全重试

**Files:**
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/detail-center-api.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/detail-center-api.self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/detail-center-view.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/detail-center-view.self-test.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/detail-center-controller.ts`
- Test: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/src/acquisition/detail-center-controller.self-test.ts`

**Interfaces:**
- Frontend reads and renders `CandidateDouyinIdentityResolutionOperation`; it does not recompute consensus.
- Existing manual fetch/confirm form remains the fallback.
- Selected-candidate polling is independent of Run polling and stops at terminal state.

- [ ] **Step 1: Write failing API adapter tests**

```ts
const latest = await api.getLatestDouyinIdentityResolutionOperation("candidate/1");
assert.equal(latest?.status, "running");
assert.equal(requests[0]?.url,
  "/api/v1/acquisition/candidates/candidate%2F1/douyin-identity-resolution-operation");

await api.retryDouyinIdentityResolution("candidate/1", "retry-key");
assert.equal(requests[1]?.method, "POST");
assert.equal(requests[1]?.headers.get("Idempotency-Key"), "retry-key");
```

Cover GET 404 → `null`, full enum parsing, POST `{}`, CSRF/cookie behavior and error-envelope propagation.

- [ ] **Step 2: Add exact frontend DTOs and methods**

```ts
export type DouyinIdentityResolutionOutcome =
  | "verified_consensus"
  | "not_found"
  | "insufficient_evidence"
  | "ambiguous"
  | "conflicting"
  | "access_restricted"
  | "redirect_not_allowed"
  | "stale_candidate"
  | "provider_unavailable";

export interface DouyinIdentityEvidenceDto {
  evidenceId: string;
  evidenceClass: "douyin_public_page" | "independent_search_result";
  publicProfileUrl: string;
  sourceUrl: string;
  sourceFingerprint: string;
  accessStatus: "indexed_summary" | "public_content" | "access_restricted";
  fetchedAt: string;
}

export interface CandidateDouyinIdentityResolutionOperation {
  id: string;
  candidateId: string;
  candidateVersion: number;
  status: "queued" | "running" | "succeeded" | "requires_review" | "failed";
  currentStage: "public_page" | "independent_search" | "consensus_gate"
    | "identity_confirmation" | "intelligence_dispatch" | null;
  outcome: DouyinIdentityResolutionOutcome | null;
  retryable: boolean;
  canonicalProfileUrl: string | null;
  profileCandidates: Array<{ publicProfileUrl: string; evidenceIds: string[] }>;
  evidence: DouyinIdentityEvidenceDto[];
  intelligenceOperationId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}
```

Add `getLatestDouyinIdentityResolutionOperation(candidateId)` and `retryDouyinIdentityResolution(candidateId, idempotencyKey)` to `AcquisitionDetailApi`.

- [ ] **Step 3: Write failing view tests for the four product states**

Assert the rendered HTML contains:

- queued/running: `正在自动核验` and the readable current step; manual form disabled/hidden;
- succeeded/verified: `已自动确认，正在进行 AI 研判`, canonical `/user/` and both evidence classes;
- requires_review: `证据不足，需要人工确认`, exact outcome reason and the existing manual form;
- failed/retryable: `自动核验暂时失败，可重试` and `data-acquisition-detail-action="retry-identity-resolution"`.

Also prove conflicting profiles do not prefill the input, video/short URLs remain blank, all titles/URLs are HTML escaped, and a resolved candidate still shows the automatic success evidence.

- [ ] **Step 4: Extend the existing workbench without a new page or modal**

Add `identityResolutionOperation` to `AcquisitionCandidateDetail`. Keep `AcquisitionIdentityVerificationState` exclusively for the existing manual form. Split the current unresolved predicate so the read-only automatic-success panel can render for a resolved Douyin individual, while the editable manual form remains limited to unresolved candidates. Pass the automatic operation separately into `renderIdentityVerificationWorkbench(candidate, manualState, automaticOperation)`.

Do not add CSS unless an existing note, warning, evidence-list or action class cannot express a required state.

- [ ] **Step 5: Write failing controller polling and retry tests**

Use fake timers/API responses to prove:

```ts
queued -> running -> succeeded -> intelligence queued -> intelligence succeeded
```

The controller must automatically refresh the candidate snapshot, stop polling at terminal intelligence, and never call client-side `confirmCandidateIdentity` or `startIntelligenceOperation` for automatic success. Add tests for candidate switch, detail close and destroy cancelling stale polls; an old response must not overwrite a newly selected candidate.

For retry, prove the stable key includes `candidateId`, current candidate version and latest failed operation ID; the key is removed only after a successful POST, so uncertain failures replay safely.

- [ ] **Step 6: Implement silent selected-candidate polling**

Split the current snapshot loading into:

```ts
async function readCandidateSnapshot(candidateId: string): Promise<AcquisitionCandidateDetail>;
async function applyCandidateSnapshot(candidateId: string, requestSerial: number): Promise<void>;
```

Manual selection may show loading; background polling must not clear the candidate or top-level messages. Poll only while identity or intelligence status is queued/running, using the existing 2–30 second backoff convention. Cancel on candidate change, close, destroy, demo-mode switch or terminal state.

- [ ] **Step 7: Implement safe retry action**

The `retry-identity-resolution` click handler calls only the server retry endpoint. It must not accept or submit a profile URL, evidence list or consensus decision. After `202`, refresh the authoritative snapshot and let polling continue.

- [ ] **Step 8: Run focused frontend tests and commit Task 5**

```bash
cd /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend
npx tsx src/acquisition/detail-center-api.self-test.ts
npx tsx src/acquisition/detail-center-view.self-test.ts
npx tsx src/acquisition/detail-center-controller.self-test.ts
npm run test
npm run build
git add src/acquisition/detail-center-api.ts \
  src/acquisition/detail-center-api.self-test.ts \
  src/acquisition/detail-center-view.ts \
  src/acquisition/detail-center-view.self-test.ts \
  src/acquisition/detail-center-controller.ts \
  src/acquisition/detail-center-controller.self-test.ts
git commit -m "feat(acquisition): show automatic Douyin identity resolution"
```

---

### Task 6: 真实端到端闭环与回归验证

**Files:**
- Create: `/Users/mac/Documents/外贸/GoodJob-1.09/backend/src/acquisition-douyin-automatic-identity-tracer-bullet-test.ts`
- Create: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/tests/acquisition-identity-resolution.spec.ts`
- Modify: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/playwright.config.ts`

**Interfaces:**
- Backend tracer proves one real search adapter result can proceed from unresolved video to identity consensus and AI outputs.
- Browser test proves the new frontend shows authoritative progress and recovery states.

- [ ] **Step 1: Write the failing backend tracer-bullet test**

Build one deterministic fixture with:

1. a real Baidu-adapter response containing a Douyin `/video/` result;
2. controlled public HTML containing one explicit `/user/` author link;
3. an independent search result pointing to the same `/user/`;
4. a model gateway fixture returning research, qualification, financial value and battle card.

Assert the final candidate is resolved and has exactly one current qualification, one financial-value decision and one battle card; the automatic identity operation and candidate-intelligence operation both succeed; zero outreach/action/CRM writes occur.

- [ ] **Step 2: Implement only the missing integration wiring exposed by RED**

Do not add test-only production switches. Inject the existing page discovery/search/model ports through `createAcquisitionApplication()` options, matching current test dependency-injection patterns.

- [ ] **Step 3: Write the browser E2E test**

Create a focused test file rather than extending `demo-auth.spec.ts`. Mock only network boundaries and verify:

```text
正在自动核验
→ 已自动确认，正在进行 AI 研判
→ 意向评分 + 财务价值 + 客户作战卡可见
```

Add a second case for `provider_unavailable → 点击重试 → running` and a third for `ambiguous → 人工表单且无预填`.

- [ ] **Step 4: Run focused E2E and backend tracer**

```bash
cd /Users/mac/Documents/外贸/GoodJob-1.09/backend
NODE_ENV=test TZ=UTC JWT_SECRET=goodjob-acquisition-test-secret-at-least-32-characters \
ACQUISITION_MASTER_SECRET=goodjob-acquisition-master-test-secret-at-least-32-bytes \
node --import tsx --test --test-concurrency=1 \
  src/acquisition-douyin-automatic-identity-tracer-bullet-test.ts

cd /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend
npx playwright test tests/acquisition-identity-resolution.spec.ts --project=chromium
```

Expected: all tests PASS; terminal states stop polling and request counts remain unchanged after advancing fake time.

- [ ] **Step 5: Run full verification**

```bash
cd /Users/mac/Documents/外贸/GoodJob-1.09
npm run test:acquisition --workspace backend
npm run test:contracts
npm run test:contract-drift --workspace backend
npm run test:acquisition-openapi --workspace backend
npm run check:generated-acquisition-types
npm run build --workspace backend
cd backend && NODE_ENV=test node --import tsx --test \
  src/provider-http-client-test.ts && cd ..

cd /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend
npm run test
npm run build
npm run test:e2e

git -C /Users/mac/Documents/外贸/GoodJob-1.09 diff --check
git -C /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend diff --check
```

- [ ] **Step 6: Perform a broad read-only review**

Review for tenant isolation, SSRF/redirect policy, evidence independence, candidate-version races, idempotency/recovery, frozen model snapshot usage, duplicate AI outputs, stale frontend polling, XSS escaping and preservation of all existing manual fallbacks.

- [ ] **Step 7: Commit Task 6**

```bash
git -C /Users/mac/Documents/外贸/GoodJob-1.09 add \
  backend/src/acquisition-douyin-automatic-identity-tracer-bullet-test.ts
git -C /Users/mac/Documents/外贸/GoodJob-1.09 commit \
  -m "test(acquisition): verify automatic Douyin identity closed loop"

git -C /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend add \
  tests/acquisition-identity-resolution.spec.ts playwright.config.ts
git -C /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend commit \
  -m "test(acquisition): cover Douyin identity resolution UX"
```

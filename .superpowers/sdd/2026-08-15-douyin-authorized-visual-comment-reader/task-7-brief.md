### Task 7: 视觉观察转 Evidence、需求信号和 Run Presentation

**Status:** COMPLETED. Final code commit `73c515a` and reviewed documentation
baseline `37474c9` are independently `APPROVED` with 0 Critical, 0 Important,
and 0 Minor findings.

**Repository:** `/Users/mac/Documents/新项目/GoodJob-growth`

**Files:**
- Create: `backend/src/acquisition-visual-comment-ingestion.ts`
- Create: `backend/src/acquisition-visual-comment-ingestion-test.ts`
- Create: `backend/src/acquisition-visual-reader-recovery-sweeper.ts`
- Create: `backend/src/acquisition-visual-reader-recovery-sweeper-test.ts`
- Modify: `backend/src/acquisition-visual-reader-sessions.ts`
- Modify: `backend/src/acquisition-visual-reader-sessions-test.ts`
- Modify: `backend/src/acquisition-visual-reader-mysql-repository.ts`
- Modify: `backend/src/acquisition-visual-reader-mysql-repository-test.ts`
- Modify: `backend/src/acquisition-visual-reader-service.ts`
- Modify: `backend/src/acquisition-visual-reader-service-test.ts`
- Modify: `backend/src/acquisition-domain.ts`
- Modify: `backend/src/acquisition-domain-service.ts`
- Modify: `backend/src/acquisition-public-identity-resolver.ts`
- Modify: `backend/src/acquisition-individual-signal-ingestion.ts`
- Modify: `backend/src/acquisition-douyin-comment-ingestion.ts`
- Modify: `backend/src/acquisition-douyin-comment-ingestion-unit-of-work.ts`
- Modify: `backend/src/acquisition-douyin-comment-ingestion-unit-of-work-test.ts`
- Modify: `backend/src/acquisition-mysql-repositories.ts`
- Modify: `backend/src/acquisition-mysql-repositories-test.ts`
- Modify: `backend/src/acquisition-run-presentation.ts`
- Modify: `backend/src/acquisition-run-presentation-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `contracts/json-schema/acquisition-run-presentation.v1.schema.json`
- Modify: `contracts/json-schema/discovery-evidence.v1.schema.json`
- Modify: `contracts/json-schema/individual-demand-signal.v1.schema.json`
- Modify: `contracts/test/schema-registry.test.mjs`
- Modify: `contracts/README.md`
- Regenerate: `frontend/src/features/ai-growth/generated/ai-acquisition.ts`

**Ingestion rules:**

- 观察和包含 `actorId`、append-time disposition 的可租赁视觉工作项由视觉仓库原子持久化。独立的视觉 recovery sweeper 实现公平领取、退避、租约失效和 poison 隔离；Domain、候选、公开事件和工作完成共用现有 memory/MySQL unit of work。
- 自动工作先通过受限 Domain API 创建字面 ID `visual:<observationId>:evidence:<textHash>` 的 `authorized_visual_observation` Evidence。通用 Evidence append 不能伪造该 provenance 或 supersedes 链。
- 只有完整、高置信且 URL/作品/评论/时间/计数/公开身份都闭合的观察才调用现有 `ingestSample` 一次。升级后保留 platform 和 visual 两条 Evidence，附加 visual Evidence 不再合并第二次信号；负面新身份从创建起即 `do_not_contact`。
- 验证 `secUid` 与匹配主页使用现有 resolver 的稳定身份；昵称或其他不可验证观察仅使用 `unmergeable:douyin:visual:<observationId>` 且为 `needs_research`。`noise` 仅留 Evidence，不推断身份、收入、金额或敏感属性。
- DOM/ARIA 被使用字段缺少或低于 0.85、OCR 文字低于 0.90、DOM/OCR 冲突或截断都只能 `manual_review_only`；`vision` 失败关闭。fresh/replay 响应与仓库 disposition 共用同一 predicate。
- Run Presentation 保留控制会话的 `sessionId/status/limits/usage/outcome`，并必须输出 `sessionCount`、`aggregateStatus`和安全上限的 `aggregateUsage`。控制会话是最新 active，否则是 `(authorizedAt, sessionId)` 最新 terminal；最多 1000 会话，工作计数使用未截断 aggregate projection。五个视觉步骤严格固定顺序，零观察只表示 `no_visible_comments`。

## Phase 1 reuse-boundary audit (2026-08-16)

### Existing owners and exact symbols to reuse

- Visual fact persistence stays owned by
  `AcquisitionVisualReaderRepository` in
  `backend/src/acquisition-visual-reader-sessions.ts` and its memory/MySQL
  implementations. `AcquisitionVisualReaderService.appendObservationBatch`
  already calls `appendObservationBatchWithResult` before returning accepted
  observations. `listRunObservations`, `getSession`, and `getArtifact` are the
  existing scoped read boundaries; artifact expiry intentionally removes bytes
  without removing observation hashes.
- Verified public-comment promotion must call the existing
  `AcquisitionDouyinCommentIngestionService.ingestSample` and must not create a
  second public-event normalizer. `classifyDouyinCommentIntent` remains the one
  classifier. `AcquisitionDouyinCommentEventRepository`,
  `AcquisitionDouyinCommentIngestionUnitOfWork`, and
  `AcquisitionDouyinCommentIngestionRecoverySweeper` own the existing durable
  pending saga, atomic Domain/candidate/event completion, leasing, backoff, and
  restart recovery.
- Candidate identity and signal writes stay behind
  `AcquisitionIndividualSignalIngestionService.ingest`, which reuses
  `resolveAcquisitionPublicIdentity`; Evidence creation stays behind
  `AcquisitionDomainService.appendEvidence`. The Task 7 provenance addition
  must extend `EvidenceProvenance` plus
  `AcquisitionDomainService.normalizeEvidenceInput` and the two public JSON
  schemas, rather than bypassing Domain validation.
- Run projection stays owned by `AcquisitionRunPresentationService.get` in
  `backend/src/acquisition-run-presentation.ts`. Its visual projection must
  read the visual repository and the committed/pending ingestion facts; it
  must keep the existing seven `automationSteps` intact and emit the five
  contracted visual steps exactly once in the contracted order.

### Required contracts

- A visual-only Evidence key is exactly
  `visual:<observationId>:evidence:<textHash>`, with provenance kind
  `authorized_visual_observation` and persisted source URL, observation ID,
  extraction method, confidence facts, coverage, hashes, and nullable artifact
  ID. It is tenant scoped and idempotent.
- A public-event upgrade is permitted only after the persisted observation can
  form the complete existing `DouyinPublicCommentSamplePage`/comment input; it
  then goes through `ingestSample`. Nickname-only observations remain isolated
  as `unmergeable:douyin:visual:<observationId>` and `needs_research`; exact
  verified `secUid` plus matching public profile facts go through the existing
  public identity resolver.
- Manual-review-only disposition must be durable and must prevent automatic
  buying-stage advancement for DOM/ARIA critical confidence below `0.85`, OCR
  text confidence below `0.90`, DOM/OCR disagreement, or truncation. Errors and
  diagnostics may contain stable codes and irreversible IDs only, never
  observation text or public-person fields.
- Observation persistence precedes all downstream work. Downstream Evidence,
  candidate mutation, Run-success linkage, and saga completion share the
  existing atomic completion boundary; a crash must leave a durable claimable
  work item and no visible successful Run fact or partial approved-candidate
  mutation.

### Phase 1 audit questions resolved by the controller rulings below

1. **No durable visual ingestion work item exists.** The visual repository has
   no unprocessed/saga/outbox API and cannot enumerate pending work across
   tenants. The existing comment saga is created only together with a
   `DouyinCommentEvent` by `appendObservation`; its work item requires that
   public event and content version. An unverified visual observation therefore
   cannot enter that saga without fabricating a platform event. Decide whether
   to extend the existing comment-event saga with a visual-origin work-item
   variant, or add visual-origin saga records to the visual repository. The
   latter is acceptable only if it is an adapter over the existing unit-of-work,
   lease/backoff, and recovery semantics rather than a parallel kernel.
2. **Promotion and Evidence multiplicity are undefined.** `ingestSample`
   accepts only the fixed experimental public-provider page, creates
   `platform_public_event` Evidence, and uses the video URL as the signal's
   profile URL. A visual observation may instead contain a verified public
   profile and must also create the required
   `authorized_visual_observation` Evidence. Decide whether a promoted
   observation owns both Evidence records, which record is attached to the
   candidate/Run link, and what persisted hash supplies the provider page's
   required `rawArtifactHash` when no redacted crop exists. Also define whether
   nullable like/reply counts block promotion or are normalized to zero.
3. **Manual-review/truncation state is not represented durably.** Neither
   `DouyinVisualCommentObservationV1` nor the batch response contains
   `manualReviewOnly` or `textTruncated`. The service computes an internal
   `< 0.8` ID list that the router discards, while Task 7 requires `0.85/0.90`
   thresholds and explicit truncation handling. DOM/OCR disagreement can be
   derived from hashes, but truncation cannot. Decide the public/persisted DTO
   field (or an explicit canonical derivation rule) before ingestion behavior
   is implemented.
4. **The singular Run projection is ambiguous for multiple sessions.** Session
   IDs include the create `Idempotency-Key`, so the current service permits
   multiple sessions for one Run. The repository has no `listRunSessions`
   method, while `authorizedVisualReader` is singular. Define whether the
   projection rejects multiple sessions, selects one by a persisted rule, or
   aggregates them, including status/error/count/timestamp semantics for each
   of the five steps and for pending ingestion after a terminal session.
5. **The required Evidence ID is not expressible through the Domain port.**
   `AcquisitionDomainService.appendEvidence` accepts an idempotency key but
   always assigns `idFactory("evidence")` to `DiscoveryEvidence.id`. Decide
   whether `visual:<observationId>:evidence:<textHash>` is the literal public
   Evidence `id` or the internal idempotency key. If it is the literal ID, the
   Domain command/repository validation boundary must be extended explicitly.
6. **`needs_research` has two existing meanings.** The public identity resolver
   returns a `needs_research` disposition for weak identity, but
   `AcquisitionIndividualSignalIngestionService` creates the candidate with
   Domain status `normalized`; Run Presentation separately derives
   `identityStatus: needs_research`. Define whether nickname-only visual input
   must change the candidate/status DTO to `needs_research`, or whether the
   existing resolver disposition plus Presentation identity status satisfies
   the rule.

### Controller rulings — executable Task 7 boundary

No public DTO or business-rule question remains open. The implementation must
use these closed rules:

1. Add a durable visual-ingestion work item/outbox without fabricating a public
   platform event. Task 7 may extend the visual memory/MySQL repositories,
   their tests, and application composition. A work item is unique by
   owner/team/session/run/observation and has the closed lifecycle
   `queued | running | retry | succeeded | manual_review_only`, with durable
   lease, attempt, next-attempt, last-error, and completion timestamps. An
   accepted observation and its queued item commit in the same memory-state
   swap or MySQL transaction. Recovery uses a bounded fair cross-tenant claim,
   lease and backoff; every claim persists a fresh opaque 64-hex lease token
   and increments its attempt generation. Complete/fail atomically match the
   tenant/observation, owner, token, attempt, status, and require the result
   strictly before lease expiry, then clear the token. An old claim, including
   one submitted exactly at expiry, stays fenced after same-worker reclamation.
   Fresh queued rows have attempt zero; running, retry, and terminal rows have
   attempt at least one, and contradictory stored lifecycle facts fail closed
   in reads, claims, mutations, and aggregate projection. Legacy running rows
   without a token are safely reset to retry with attempt at least one during
   schema setup; poisoned connections are isolated.
2. Always create the unique `authorized_visual_observation` Evidence first.
   Its literal Evidence ID is
   `visual:<observationId>:evidence:<textHash>`. Extend `EvidenceProvenance` and
   its schema with observation/session IDs, extraction method,
   `visibleTextConfidence`, coverage, nullable artifact ID, and nullable
   DOM/OCR hashes. `contentHash = textHash`. `rawArtifactHash` is the current
   artifact plaintext hash when available, otherwise the persisted
   `redactedCropHash`, otherwise `textHash`. Artifact expiry never deletes
   Evidence facts.
3. Add a narrowly internal Domain append-with-ID boundary (or equivalent) that
   accepts only the exact visual Evidence ID plus authorized provenance and
   retains normal Domain validation, idempotency and audit. It must not bypass
   Domain audit or permit general caller-selected Evidence IDs.
4. Only a non-manual observation whose verified `platformCommentId`,
   `publicProfileUrl`, `secUid`, identity confidences, visible time, like count,
   and reply count satisfy the existing closed `douyin.comment.v1` rules may
   additionally enter the existing public-comment ingestion. That path creates
   a distinct `platform_public_event` Evidence. The authorized visual Evidence
   remains and its ID is merged onto the same candidate without replacing the
   platform Evidence or duplicating the demand signal. Null counts stay null
   and block promotion; they are never replaced with zero.
5. Do not add a public `manualReviewOnly` or truncation field. Derive and
   persist the work-item disposition from the immutable observation: for DOM or
   accessibility, any automatically used field confidence below `0.85` is
   manual; for OCR, `visibleText < 0.90` is manual;
   `extractionMethod === "ocr" && domTextHash !== null` is a truncated source
   and always manual; two non-null unequal DOM/OCR hashes are conflict/manual;
   `vision` is rejected. Manual observations create only Evidence and never
   create or upgrade a candidate or buying stage. The service's returned
   manual-review list must call this same shared predicate instead of the old
   private `< 0.8` rule.
6. Verified `secUid` plus matching public profile uses the exact public actor
   key `douyin:sec_uid:<secUid>` through the existing identity resolver.
   Nickname-only or otherwise unverified identity uses exactly
   `unmergeable:douyin:visual:<observationId>`; extend the resolver's closed
   allowlist and return `needs_research`. A high-confidence unmergeable visual
   observation may create a `needs_research` candidate; a manual observation
   never creates a candidate.
7. Non-promoted visual demand signals use `classifyDouyinCommentIntent`.
   `noise` creates only Evidence. Negative intent may create `do_not_contact`
   through existing ingestion semantics. Never infer identity, income, amount,
   or any sensitive attribute.
8. Aggregate all visual sessions for the same scoped Run into the singular Run
   Presentation. Add `listRunSessions` with a hard limit of 1000 and fail closed
   on a 1001st fact; include durable work-item facts. The five visual steps
   appear exactly once in their fixed order. Counters sum across sessions;
   timestamps come only from session/work persistence and are null with no
   fact. Keep the existing `sessionId/status/limits/usage/outcome` fields as the
   controlling-session projection for backward compatibility: select the most
   recent active `created | collecting` session, otherwise the latest terminal
   session ordered by `(authorizedAt, sessionId)`. Add required
   `sessionCount` (`1..1000`), `aggregateStatus` (`active | succeeded |
   partial_success | failed | stopped`), and `aggregateUsage` with the same
   fields as usage and safe-integer caps equal to each single-session cap times
   1000. Do not expose all session IDs. Aggregate status precedence is: any
   active session => `active`; otherwise any completed session together with
   any partial/aborted/expired/failed-work fact => `partial_success`; otherwise
   all completed => `succeeded`; otherwise all aborted/expired => `stopped`;
   an integrity or terminal failed-work fact with no success => `failed`.
   With no session the projection is absent. Plan-disabled `skipped` remains a
   higher-level step rule and does not fabricate a session. Zero observations
   is a factual `no_visible_comments` outcome, never “no customers.” Synchronize
   the static schema, runtime OpenAPI builder, generated frontend types, backend
   response/conformance fixtures, and compatible frontend consumers.
9. The visual recovery sweeper processes only persisted work items, has its own
   application startup/interval/close lifecycle independent of the artifact
   sweeper, and emits only redacted stable diagnostics.

These rulings are Task 7 internal/domain-contract scope. They authorize no
Task 8 work and no real Douyin traffic, raw screenshot handling, or sensitive
inference.

- [x] **Step 1: 写 ingestion/projection/recovery RED 测试**

  覆盖 DOM 高置信度、OCR 高置信度、低置信度、无 ID、真实评论 ID 升级、同昵称不合并、同 secUid 聚合、跨租户、制品到期仍保留证据哈希、每个 saga 故障边界和进程重启自动恢复。

- [x] **Step 2: 运行 RED**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-visual-comment-ingestion-test.ts src/acquisition-visual-reader-recovery-sweeper-test.ts src/acquisition-run-presentation-test.ts`

  Expected: FAIL。

- [x] **Step 3: 实现确定性 Evidence/信号转换和恢复**

  复用 `classifyDouyinCommentIntent`，但把 `extractionMethod/confidence/coverage/observationId/artifactId` 写入 provenance。视觉文字只作为公开需求信号，不推断身份、收入或敏感属性。

- [x] **Step 4: 实现真实 Run Presentation**

  进行中、部分成功、扩展缺失、用户停止、页面安全验证、低置信度和成功状态均由 session/observation/saga 记录组装；不把 0 条观察误写为“没有客户”。

- [x] **Step 5: 运行 GREEN、合同和构建**

  Run: `npm exec --workspace backend -- tsx --test src/acquisition-visual-comment-ingestion-test.ts src/acquisition-visual-reader-recovery-sweeper-test.ts src/acquisition-run-presentation-test.ts && npm run test:contracts && npm run build --workspace backend`

  Expected: PASS。

- [ ] **Step 6: 提交**

  独立审查前精确暂存本文件 Files 清单中的全部 Task 7 变更及当前计划、进度和报告；不包含 Task 8、外部前端工作树或任何 `package-lock.json`。

# Task 4 Report: 评论证据、主体聚合与确定性需求信号

## Status and commit

- Status: complete, including review rounds 1 through 5
- Base: `0ca58cdd4d2dd18040ccfb2a617cc2df47579240`
- Commit: the task commit containing this report, message
  `feat: aggregate douyin comment demand signals`
- Review round 1 commit: the follow-up commit containing this report, message
  `fix: harden douyin comment signal ingestion`
- Review round 2 commit: the follow-up commit containing this report, message
  `fix: persist and recover douyin comment ingestion`
- Review round 3 commit: the follow-up commit containing this report, message
  `fix: atomically recover douyin comment ingestion`
- Review round 4 commit: the follow-up commit containing this report, message
  `fix: harden douyin comment recovery storage`
- Review round 5 commit: the follow-up commit containing this report, message
  `fix: serialize douyin comment schema migration`
- Scope: backend and acquisition contracts only; no frontend or Task 5+
  orchestration changes

## Delivered behavior

- Added `AcquisitionDouyinCommentIngestionService.ingestSample` as a narrow,
  dependency-injected pipeline from bounded public top-level comment samples to
  immutable events/observations, exact public-event evidence, individual demand
  signals, candidates, and Run links.
- Added deterministic, bounded `classifyDouyinCommentIntent` output for strong,
  potential, noise, and negative bands. Negative/no-contact rules override
  positive terms; standalone `多少钱` remains potential; compound
  procurement, supplier, budget, quantity, timing, delivery, cooperation, and
  trial evidence is required for strong signals.
- Preserved bounded original public comment text while hashing normalized text.
  Noise persists as event/evidence without a candidate. Negative evidence
  creates/attaches a signal with stable suppression codes.
- Added the closed `platform_public_event` evidence provenance and restricted it
  to `individual_signal` plus `public_content` in TypeScript, domain validation,
  and JSON Schema.
- Added stable Douyin actor aggregation semantics:
  - strict `douyin:sec_uid:*` dedupe across videos and Runs while remaining
    `needs_research` for video-only evidence;
  - normalized `douyin:handle:*` temporary dedupe that never aliases secUid;
  - `unmergeable:douyin:comment:*` isolation for identity-less comments;
  - owner/team isolation and fail-closed non-Douyin or malformed contexts.
- Kept existing adapter-generated public actor hashes source-bound and fixed the
  stale candidate-research fixture with the same stable non-adapter
  `public:linkedin:alice` key on both sides.
- Did not copy or integrate Cookie, reverse-signature, browser-fingerprint,
  private-message, interaction, proxy, CAPTCHA, or platform-write code.

## Review round 1 fixes

- Added the internal `mergeIndividualDemandSignal` Domain command. Existing
  individual candidates now retain identity-bearing profile fields while later
  evidence merges bounded/deduplicated summaries, advances buying stage only by
  the explicit five-stage rank, and keeps a stable union of negative codes.
  Exact replay does not increment the candidate version or duplicate audit
  events. New evidence retains the existing approval/rejection invalidation
  semantics.
- Established `eventId + textHash` evidence-version stability and kept actor
  facts on the stored immutable event. Review round 2 replaced round 1's
  synthetic representation with the persisted real-artifact model below.
- Added the first restartable event → evidence → candidate → link sequence
  and deterministic step identities. Review round 2 replaced caller-driven
  retry as the recovery guarantee with durable pending state and an automatic
  restart sweeper.
- Prevalidates all scope, nullable Run context, source/video, page metadata,
  provider literals, reply-body literal, digests, bounds, and all comment
  records before the first mutation. Malformed comment records remain isolated
  and count as invalid; malformed page/context inputs fail with zero mutation.
- Restored v1 compatibility for `negativeSignals`: the schema no longer narrows
  legacy arrays by count, uniqueness, or item length. The deterministic comment
  classifier keeps its own internal code bounds.

## Review round 2 fixes

- Replaced the synthetic content-version artifact with a genuinely persisted,
  tenant-scoped `eventId + textHash` content version in both memory and MySQL.
  First-writer-wins state retains the exact bounded public text, first
  observation ID, real first provider-page `rawArtifactHash`, publication time,
  actor, source URL, platform event ID, Provider version, and coverage.
- Discovery Evidence now comes only from that persisted content version.
  `sourceSnippet` keeps exact whitespace and punctuation, and
  `rawArtifactHash` references a real provider-page artifact. A three-capture
  test proves original text, changed text, and the same changed text from a
  later page artifact retain two stable evidence versions, stable actor/link
  semantics, and observation-level traceability to each page.
- Added a durable pending/committed ingestion saga to the event repositories.
  Event, observation, content version, and pending saga are written in one
  event-repository transaction. Run projections see only links, and link plus
  committed saga state are written in one event-repository transaction.
- Added a Domain pre-commit barrier for individual candidate create/merge.
  Failure at `after_candidate` throws inside the Domain repository transaction,
  so a new candidate is absent and an existing approved candidate is restored
  byte-for-byte, including approval decision fields and version.
- Added an immediate, restart-safe recovery sweeper. It scans durable pending
  sagas and resumes deterministic evidence/candidate work without caller
  replay. Boundary tests cover `after_event`, `after_evidence`, and
  `after_candidate`; each failure instant has no Run success fact and no partial
  candidate, and recovery leaves one event/content version/evidence/candidate/
  link with no pending saga.
- Aligned prevalidation with persistence bounds: nullable Run/shard/discovery
  IDs are rejected above 160 characters before mutation, and the exact Task 1
  Provider/version/coverage/reply-body literals remain fail closed.
- Review round 3 replaced the separate completion transactions described above
  with the shared unit-of-work boundary below. The durable pending saga remains
  the restart record; completion is no longer best-effort cross-repository work.

## Review round 3 fixes

- Added a concrete ingestion unit of work. Memory coordinates serialized
  snapshots across Domain, the event repository, and the candidate directory;
  MySQL binds all three repositories to one connection and one database
  transaction. Evidence, idempotency, candidate/audit state, directory entry,
  event link, and committed saga therefore succeed or roll back together.
- Added a real commit-side failure regression whose event repository performs
  the link/saga mutation and then throws. The failed call leaves an approved
  candidate, audit stream, Run projection, and pending saga at their exact
  prior snapshots. Restart recovery completes without caller replay.
- Made memory saga commit serialization match MySQL row locking. Concurrent
  different candidate/evidence results now select one immutable winner; the
  other call returns a deterministic conflict, and the link matches the saga.
- Added durable recovery attempts, `nextAttemptAt`, leases, and the bounded
  non-PII `RECOVERY_FAILED` code. Recovery catches each work item separately,
  applies bounded exponential backoff, and lets later tenants progress even
  when `limit=1`. MySQL claims use `FOR UPDATE SKIP LOCKED`; memory claims use
  the same exactly-once lease semantics. Existing MySQL saga tables are upgraded
  in place before reads start.
- Wired the real ingestion service and recovery sweeper into both application
  compositions. Startup performs the first sweep, later sweeps are scheduled,
  sweep errors are isolated, and close cancels/drains recovery exactly once.
  Custom repository compositions must provide an explicit atomic unit of work.

## Review round 4 fixes

- Replaced unsupported MySQL 8 `ADD COLUMN IF NOT EXISTS` statements with an
  `information_schema.columns`/`DATABASE()` guard and fixed allowlisted ALTERs.
  Missing, present, nullable-mid-migration, and exact retry states are covered;
  `next_attempt_at` backfill remains restartable. Application startup completes
  schema creation/migration before starting the first recovery sweep.
- Serialized every standalone in-memory event-repository mutator and candidate
  directory upsert through the same transaction tail used by snapshot
  transactions. Barrier regressions cover both orderings: writes queued behind
  a failing snapshot survive its rollback, and a later failing snapshot waits
  for and preserves an already-started standalone write.
- Centralized MySQL named-lock cleanup. Both Domain and candidate-directory
  paths require `RELEASE_LOCK` to return exactly `1`; query errors, `0`, and
  `NULL` raise the stable
  `ACQUISITION_MYSQL_NAMED_LOCK_RELEASE_FAILED` error and poison/destroy the
  session. Direct and shared-UoW paths never return a poisoned session to the
  pool. Domain and CandidateDirectory track acquisitions independently, so any
  reentrant acquisition on their shared session is matched by one reviewed
  release in each repository cleanup. Successful sessions release normally,
  and post-commit cleanup failure does not double commit or report a rollback.
- Replaced raw recovery errors with a frozen diagnostic envelope containing
  only `RECOVERY_FAILED`, `resume_saga | persist_failure`, an irreversible saga
  hash, and the attempt count. Tests inject an Error containing exact comment
  text, secUid, and source URL and prove none reaches the callback or durable
  `lastErrorCode`; callback failure remains isolated.

## Review round 5 fixes

- Serialized the entire Douyin comment MySQL schema ensure/migration on one
  dedicated connection under the fixed
  `acquisition:douyin-comment-schema:v1` advisory lock. Acquisition requires
  `GET_LOCK` to return exactly `1`; release uses the reviewed named-lock helper,
  and timeout, query error, invalid release result, or release query error
  poisons/destroys the session instead of returning it to the pool.
- Added exact legacy pending-index repair under the same migration lock. Startup
  reads `information_schema.statistics` in `seq_in_index` order and accepts only
  `(status, next_attempt_at, lease_expires_at, created_at, saga_id)`. A missing
  or legacy `(status, created_at, saga_id)` index is rebuilt with fixed
  allowlisted SQL; current and newly created schemas perform no follow-up index
  ALTER. Concurrent starters serialize and the follower re-reads completed
  state, so DDL runs once.
- Unified memory composite completion lock order with standalone individual
  signal ingestion as `CandidateDirectory -> Domain -> Events`. A production
  barrier interleaves the real two entry points and proves finite completion,
  rollback preservation, durable pending saga visibility, and no lost
  directory/candidate/event state. Existing concurrent standalone event writes
  remain protected from snapshot rollback.
- Documented the actual MySQL completion cleanup: Domain and
  CandidateDirectory each keep their own named-lock acquisition list. A
  reentrant acquisition on their shared connection is matched by one reviewed
  release from each repository cleanup; duplicate acquisition is suppressed
  only within the owning repository context. Any unmatched/failed cleanup
  poisons the shared session.

## TDD evidence

### RED

- Resolver golden tests initially passed 6/8 and failed the two new stable-key
  invariants because secUid/handle fallback still included the video URL.
- The existing candidate-research focused run passed 5/6 and reproduced the
  stale fabricated source-bound adapter hash failure (`needs_research` instead
  of `resolved`).
- Domain evidence tests passed 22/23 and the schema registry passed 19/20 before
  `platform_public_event` existed.
- The ingestion suite first failed with `ERR_MODULE_NOT_FOUND`; after the first
  implementation pass, four vertical tests failed on overlong child
  idempotency keys, proving the real domain boundary was exercised.
- Follow-up RED cycles caught malformed actor fields being accepted, secUid
  digit runs being mistaken for phone material, original whitespace/punctuation
  being normalized away, and a later observation conflicting with the existing
  immutable evidence artifact.
- Review round 1 command:

  ```text
  NODE_ENV=test TZ=UTC npm exec --workspace backend -- node --import tsx \
    --test --test-concurrency=1 \
    src/acquisition-douyin-comment-ingestion-test.ts
  ```

  Result: 6/9 passed, 3 failed. The failures were the expected old behavior:
  the stage remained `solution_research` instead of `purchase_ready`, changed
  content used a transient actor and produced another candidate, and malformed
  Provider/context input was accepted instead of failing before mutation.
- The v1 compatibility regression was also run against the narrowed schema:

  ```text
  node --test --test-name-pattern \
    "individual demand signals bound profile fields without narrowing v1 negative signals" \
    contracts/test/schema-registry.test.mjs
  ```

  Result: 0/1 passed. AJV reported all three intended incompatibilities:
  `maxItems`, item `maxLength`, and `uniqueItems`.
- Review round 2 first introduced the durable provenance/recovery tests, then
  ran:

  ```text
  npm exec --workspace backend -- tsx --test \
    src/acquisition-douyin-comment-events-mysql-repository-test.ts
  ```

  Result: 6/9 passed, 3 failed. The expected failures proved that the MySQL
  schema lacked content-version/saga tables, append did not return a persisted
  content version, and a restarted repository could not list pending sagas.
- The ingestion RED command was:

  ```text
  npm exec --workspace backend -- tsx --test \
    src/acquisition-douyin-comment-ingestion-test.ts
  ```

  Result: file-level `ERR_MODULE_NOT_FOUND` for the new recovery sweeper before
  implementation. After the first MySQL pass, the later-observation restart
  regression independently failed 8/9 with
  `ACQUISITION_DOUYIN_COMMENT_MYSQL_INTEGRITY:ingestion_saga_work_item`, proving
  the persisted first content observation must differ safely from a later saga
  observation for the same text hash.
- Review round 3 started with the memory repository race and recovery-lease
  regressions:

  ```text
  npm exec --workspace backend -- tsx --test \
    src/acquisition-douyin-comment-events-test.ts
  ```

  Result: 12/14 passed and 2 failed. Concurrent different saga results both
  fulfilled instead of selecting one winner, and recovery had no
  `claimPendingIngestionSagas` operation. The later vertical REDs also proved
  that a real commit-side throw needed a shared completion transaction and that
  a poison item at `limit=1` needed durable backoff before later tenant work
  could progress.
- Review round 4 migration RED:

  ```text
  npm exec --workspace backend -- tsx --test \
    src/acquisition-douyin-comment-events-mysql-repository-test.ts
  ```

  Result: 9/12 passed and 3 failed. The schema still contained unsupported
  `ADD COLUMN IF NOT EXISTS`; the fake information-schema missing/present/retry
  branches proved there was no guarded fixed-ALTER migration.
- Review round 4 memory REDs:

  ```text
  npm exec --workspace backend -- tsx --test \
    src/acquisition-douyin-comment-events-test.ts
  npm exec --workspace backend -- tsx \
    src/acquisition-tool-support-repositories-test.ts
  ```

  The event suite passed 14/15; all four concurrent standalone event mutators
  settled while a failing snapshot still held its rollback copy. The directory
  script failed because a concurrent successful upsert was erased by rollback.
- Review round 4 lock REDs used the tool-support repository script, MySQL Domain
  repository script, and shared-UoW node:test file. The directory leaked the raw
  `scripted-query-failure` and released the session; Domain silently succeeded;
  the shared UoW passed 2/3 and released instead of destroying the committed but
  cleanup-poisoned session. A shared-session regression then independently
  failed with `ACQUISITION_CANDIDATE_DIRECTORY_LOCK_TIMEOUT` because the
  directory re-entered the same named lock but scheduled only one release.
- Review round 4 diagnostic RED:

  ```text
  npm exec --workspace backend -- tsx --test \
    --test-name-pattern "recovery isolates poison" \
    src/acquisition-douyin-comment-ingestion-test.ts
  ```

  Result: 0/1 passed. Both callback arguments were raw Error objects containing
  the exact comment, secUid, source URL, message, and stack.
- Review round 5 schema/index RED:

  ```text
  npm exec --workspace backend -- tsx --test \
    src/acquisition-douyin-comment-events-mysql-repository-test.ts
  ```

  Result: 12/20 passed and 8 failed. Concurrent startup rejected both callers;
  missing, legacy, current, and new index states did not use a dedicated locked
  connection; migration lock timeout/query-error/release-error paths lacked
  stable poison-session behavior.
- Review round 5 memory lock-order RED:

  ```text
  npm exec --workspace backend -- tsx --test \
    --test-name-pattern "standalone individual ingestion and comment UoW" \
    src/acquisition-douyin-comment-ingestion-test.ts
  ```

  Result: 0/1 passed. The comment completion boundary entered Domain while
  waiting for CandidateDirectory, proving its `Domain -> Events -> Directory`
  order was inverted relative to the real standalone individual-signal entry
  point.

### GREEN

Required focused command:

```text
npm exec --workspace backend -- tsx --test \
  src/acquisition-douyin-comment-ingestion-test.ts \
  src/acquisition-domain-test.ts \
  src/acquisition-public-identity-resolver-test.ts \
  src/acquisition-candidate-research-test.ts
```

Result for the required four files: 49/49 passed. The final expanded focused
command also included memory/MySQL event repositories and individual-signal
ingestion:

```text
npm exec --workspace backend -- tsx --test \
  src/acquisition-douyin-comment-ingestion-test.ts \
  src/acquisition-domain-test.ts \
  src/acquisition-public-identity-resolver-test.ts \
  src/acquisition-candidate-research-test.ts \
  src/acquisition-douyin-comment-events-test.ts \
  src/acquisition-douyin-comment-events-mysql-repository-test.ts \
  src/acquisition-individual-signal-ingestion-test.ts
```

Result: 70/70 passed. The ingestion file passed 10/10, memory event repository
12/12, and MySQL event repository 9/9.

Review round 3 expanded focused command:

```text
npm exec --workspace backend -- tsx --test \
  src/acquisition-douyin-comment-ingestion-test.ts \
  src/acquisition-domain-test.ts \
  src/acquisition-public-identity-resolver-test.ts \
  src/acquisition-candidate-research-test.ts \
  src/acquisition-douyin-comment-events-test.ts \
  src/acquisition-douyin-comment-events-mysql-repository-test.ts \
  src/acquisition-douyin-comment-ingestion-recovery-sweeper-test.ts \
  src/acquisition-douyin-comment-ingestion-unit-of-work-test.ts \
  src/acquisition-individual-signal-ingestion-test.ts \
  src/acquisition-mysql-repositories-test.ts
```

Result: 79/79 passed. The ingestion file passed 12/12, memory events 14/14,
MySQL events 10/10, and the new unit-of-work/recovery-sweeper tests 3/3.

Review round 4 storage/recovery focused command:

```text
npm exec --workspace backend -- tsx --test \
  src/acquisition-douyin-comment-events-test.ts \
  src/acquisition-douyin-comment-events-mysql-repository-test.ts \
  src/acquisition-douyin-comment-ingestion-test.ts \
  src/acquisition-douyin-comment-ingestion-unit-of-work-test.ts \
  src/acquisition-douyin-comment-ingestion-recovery-sweeper-test.ts
```

Result: 44/44 passed. The named-lock Domain and candidate-directory scripts
also passed independently. The final expanded command added Domain, resolver,
candidate research, individual signal, MySQL Domain, and tool-support
repositories; result: 85/85 passed.

Review round 5 MySQL focused command passed 20/20. The memory cross-entry
lock-order regression then passed 1/1. The final expanded command was:

```text
npm exec --workspace backend -- tsx --test \
  src/acquisition-douyin-comment-ingestion-test.ts \
  src/acquisition-domain-test.ts \
  src/acquisition-public-identity-resolver-test.ts \
  src/acquisition-candidate-research-test.ts \
  src/acquisition-douyin-comment-events-test.ts \
  src/acquisition-douyin-comment-events-mysql-repository-test.ts \
  src/acquisition-douyin-comment-ingestion-recovery-sweeper-test.ts \
  src/acquisition-douyin-comment-ingestion-unit-of-work-test.ts \
  src/acquisition-mysql-repositories-test.ts \
  src/acquisition-tool-support-repositories-test.ts
```

Result: 94/94 passed. This includes concurrent schema startup, all missing/
legacy/current/new pending-index states, migration-lock failure cleanup, the
real standalone/comment cross-entry barrier, and the round 4 concurrent event
append/rollback regressions.

Application lifecycle focused command:

```text
npm exec --workspace backend -- tsx --test \
  --test-name-pattern="application owns the comment ingestion recovery lifecycle|mysql acquisition application owns schema setup" \
  src/acquisition-application-test.ts
```

Result: 2/2 passed and exited naturally. The full application test file reaches
24/24 but retains the pre-existing deliberately unresolved gateway from
`application shutdown is bounded when a model call never returns`; full-suite
counting therefore uses Node's explicit `--test-force-exit`.

The existing MySQL Domain repository regression also passed:

```text
npm exec --workspace backend -- tsx --test \
  src/acquisition-mysql-repositories-test.ts
```

Result: 1/1 file suite passed.

Contracts:

```text
npm run test:contracts
```

Result: 65/65 passed.

OpenAPI, contract drift, and generated types:

```text
npm run test:acquisition-openapi --workspace backend
npm run test:contract-drift --workspace backend
npm run check:generated-acquisition-types
```

Results: 27/27 passed, 17/17 passed, and generated output was current.

Build:

```text
npm run build --workspace backend
```

Result: passed (`tsc -p tsconfig.json`).

`git diff --check` also passed.

## Broader regression observation

The optional full command was run exactly as follows:

```text
npm run test:acquisition --workspace backend
```

Result: 670 passed / 33 failed. These failures are outside Task 4 and were not
hidden or expanded into this task:

1. The first failure is
   `Cannot safely represent JSON Schema keyword in OpenAPI 3.0: contains`.
   Task 2's `acquisition-plan.v1.schema.json` provider binding uses `contains`,
   while `convertJsonSchema202012ToOpenApi30` explicitly rejects it. This causes
   the OpenAPI/middleware/provider-version cascade.
2. `acquisition-pi-gateway-runtime-test.ts` and
   `acquisition-pi-runtime-factory-test.ts` separately fail with the existing
   `MODEL_TOOL_DEFINITION_INVALID` condition.

Task 4's new classifier, ingestion, domain, resolver, candidate-research, and
contract tests all pass inside their required focused gates.

After independent commit `0e6269f` fixed Task 2's OpenAPI conversion, review
round 3 reran the complete command with `--test-force-exit` placed before the
file list:

```text
NODE_ENV=test TZ=UTC \
JWT_SECRET=goodjob-acquisition-test-secret-at-least-32-characters \
ACQUISITION_MASTER_SECRET=goodjob-acquisition-master-test-secret-at-least-32-bytes \
node --import tsx --test --test-force-exit --test-concurrency=1 \
  src/model-config-migration-test.ts \
  src/model-provider-endpoint-registry-test.ts \
  src/model-official-connection-profile-test.ts \
  src/model-connection-idempotency-test.ts \
  src/model-connection-service-test.ts \
  src/model-pending-appends-test.ts \
  src/model-gateway-test.ts \
  src/model-runtime-integration-test.ts \
  src/provider-connection-version-test.ts \
  src/acquisition-*-test.ts
```

Result: 727 passed / 2 failed. The only failures are the two pre-existing,
separate file-level `MODEL_TOOL_DEFINITION_INVALID` failures in
`acquisition-pi-gateway-runtime-test.ts` and
`acquisition-pi-runtime-factory-test.ts`. The former `contains`/OpenAPI failure
is absent.

Review round 4 final full count used the same command after every code/test
change. Result: 734 tests, 732 passed / 2 failed. The only failures remain the
same two file-level `MODEL_TOOL_DEFINITION_INVALID` baselines above; the new
migration, memory barriers, named-lock poisoning, diagnostic redaction, and
application startup-order regressions are all green in the full run.

Review round 5 final full count used that same explicit command with
`--test-force-exit`: 743 tests, 741 passed / 2 failed. The only failures remain
`acquisition-pi-gateway-runtime-test.ts` and
`acquisition-pi-runtime-factory-test.ts`, both with the pre-existing
`MODEL_TOOL_DEFINITION_INVALID` condition. No Task 4 or schema-migration test
failed.

## Files

- `backend/src/acquisition-douyin-comment-ingestion.ts`
- `backend/src/acquisition-douyin-comment-ingestion-test.ts`
- `backend/src/acquisition-douyin-comment-ingestion-recovery-sweeper.ts`
- `backend/src/acquisition-douyin-comment-ingestion-recovery-sweeper-test.ts`
- `backend/src/acquisition-douyin-comment-ingestion-unit-of-work.ts`
- `backend/src/acquisition-douyin-comment-ingestion-unit-of-work-test.ts`
- `backend/src/acquisition-douyin-comment-events.ts`
- `backend/src/acquisition-douyin-comment-events-test.ts`
- `backend/src/acquisition-douyin-comment-events-mysql-repository.ts`
- `backend/src/acquisition-douyin-comment-events-mysql-repository-test.ts`
- `backend/src/acquisition-domain.ts`
- `backend/src/acquisition-domain-service.ts`
- `backend/src/acquisition-domain-test.ts`
- `backend/src/acquisition-individual-signal-ingestion.ts`
- `backend/src/acquisition-public-identity-resolver.ts`
- `backend/src/acquisition-public-identity-resolver-test.ts`
- `backend/src/acquisition-candidate-research-test.ts`
- `backend/src/acquisition-application.ts`
- `backend/src/acquisition-application-test.ts`
- `backend/src/acquisition-mysql-repositories.ts`
- `backend/src/acquisition-mysql-repositories-test.ts`
- `backend/src/acquisition-mysql-named-lock.ts`
- `backend/src/acquisition-tool-support-repositories.ts`
- `backend/src/acquisition-tool-support-repositories-test.ts`
- `contracts/json-schema/discovery-evidence.v1.schema.json`
- `contracts/json-schema/individual-demand-signal.v1.schema.json`
- `contracts/test/schema-registry.test.mjs`
- `contracts/README.md`
- `docs/superpowers/plans/2026-08-15-douyin-public-comment-automation.md`
- `docs/superpowers/specs/2026-08-15-douyin-public-comment-automation-design.md`

## Documentation audit

`contracts/README.md`, the current Douyin automation design, and the execution
plan now describe persisted first content versions, exact original snippets,
real provider artifacts, the shared Domain/events/directory completion unit of
work, the exact memory lock order, serialized memory mutators, a dedicated
advisory-locked MySQL 8 migration, exact legacy pending-index repair, strict
advisory-lock cleanup, redacted recovery diagnostics, pending/committed
visibility, and the application lifecycle. The design's
separately approved BrowserAct/visual-reading sections were preserved unchanged.
No frontend documentation changed because review round 5 does not alter the
Task 5+ presentation contract.

## Concerns and final state

- The two Pi runtime `MODEL_TOOL_DEFINITION_INVALID` failures remain separate
  pre-existing regressions.
- No `MYSQL_TEST_ADMIN_URL` fixture was configured for this run; migration
  behavior is covered by the dedicated-connection, information-schema,
  concurrency-barrier, and poison-session repository tests.
- Expected final Task 4 paths after the enclosing commit: clean.

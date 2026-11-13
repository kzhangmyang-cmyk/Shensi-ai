# Task 7 report — authorized visual observation ingestion

## Status

`COMPLETED`. Final code commit `73c515a` and reviewed documentation baseline
`37474c9` contain the Task 7 backend, contracts, generated same-worktree
frontend type, lease fencing, schema migration, tests, current plan, and
authoritative brief. Final independent review is `APPROVED` with 0 Critical,
0 Important, and 0 Minor findings. Task 8 is not included.

## Reused ownership boundaries

- `AcquisitionVisualReaderRepository` owns the atomically persisted observation,
  append-time disposition, actor binding, durable work item, fair lease/backoff,
  untruncated Run work projection, and memory/MySQL recovery state.
- `AcquisitionDouyinCommentIngestionService.ingestSample`, its event repository,
  unit of work, and persisted saga remain the only public-comment promotion
  kernel. Visual promotion invokes it once and reuses its platform Evidence.
- `AcquisitionDomainService` owns literal authorized Evidence through the
  restricted `appendAuthorizedVisualEvidence` path. Generic Evidence append
  rejects authorized provenance. `AcquisitionIndividualSignalIngestionService`,
  `resolveAcquisitionPublicIdentity`, and `classifyDouyinCommentIntent` remain
  the candidate, identity, and classifier boundaries.
- `AcquisitionRunPresentationService.get` remains the only public projection.
  It selects one backward-compatible controller session while aggregating all
  scoped persisted visual sessions and untruncated work facts.

## Implemented behavior

- Observation plus work creation is atomic in memory/MySQL. Work stores the
  authenticated `actorId` and immutable `automatic | manual_review_only`
  disposition, rotates tenants fairly even for repeated `limit: 1` claims,
  and restarts through an independent application-owned visual sweeper. Every
  claim stores a fresh cryptographic 64-hex lease token and increments attempt;
  complete/fail atomically match tenant/observation, worker, token, attempt,
  running status, and require the result strictly before lease expiry before
  clearing the token. Exact-expiry results are stale, and same-worker reclaim
  cannot authorize a prior asynchronous result.
- MySQL schema setup adds the nullable token column to an existing Task 7 table
  and safely resets legacy tokenless running rows to `retry` with attempt at
  least one. Fresh queued work requires attempt zero; running, retry, and
  terminal work requires attempt at least one. Shared memory validation,
  MySQL parsing, scoped reads, claims, mutations, and aggregate projection
  reject contradictory lifecycle facts.
  Completion/failure first use the tenant+observation primary key and apply
  token+attempt as residual atomic predicates, so no wider recovery index is
  required; the existing recovery index remains aligned to status/time claims.
- Authorized Evidence is created first with exact ID
  `visual:<observationId>:evidence:<textHash>`, exact Douyin video provenance,
  canonical identifiers, SHA-256 hashes, no supersedes, and 255-byte SQL
  Evidence storage/join support. Stored terminal facts are cross-checked against
  the observation and cannot be forged through generic Domain APIs.
- Only complete, non-manual, verified public observations enter `ingestSample`.
  Promotion preserves both Evidence records on one candidate without a second
  signal merge. Incomplete/null-count, URL mismatch, weak identity, truncation,
  hash conflict, missing used-field confidence, and `vision` construct no public
  event. Negative new identities start `do_not_contact`; noise is Evidence-only.
- Verified secUid/profile facts use the existing stable resolver even when the
  display name is absent. Promotion separately requires a complete display
  name. Unverified observations use only the exact visual unmergeable key and
  produce `needs_research` semantics without cross-observation merging.
- Run Presentation emits the five visual steps once in exact order, selects the
  newest active or latest terminal controller, requires capped aggregate fields,
  rejects a 1001st session, persists expiry during Run listing, and uses an
  untruncated work aggregate. Zero observations yields `no_visible_comments`,
  never a statement about customers.

## RED evidence

Production changes followed observed failures. Representative load-bearing
RED checkpoints were:

- Initial work/manual slice failed because accepted observations had no durable
  work item/disposition and no shared manual predicate.
- Lease/integrity slices failed on tenant starvation, stale completion, forged
  result facts, and a memory transaction artifact self-wait.
- Domain/resolver slices failed because generic authorized provenance and
  supersedes were accepted, real visual observation resolver keys were rejected,
  closed literal/hash/Douyin URL validation was missing, and visual Evidence IDs
  exceeded the 120-byte MySQL boundary.
- Promotion/UOW slices failed on partial facts after injected completion errors,
  incomplete observations constructing public events, duplicate signal merges,
  promotable negatives remaining `normalized`, and null-display verified
  identities failing to merge.
- Presentation/contracts slices failed on representative-session projection,
  truncated work item 1001, aggregate precedence/caps, stale active sessions,
  missing aggregate DTO fields, generated-type drift, and authorized
  `sourcePlatform` accepting `xhs`.
- Final storage parity command
  `tsx --test --test-name-pattern='visual work rejects stale leases|visual MySQL work rows fail closed|visual MySQL Run work projection rejects' ...`
  first reported `tests 3, pass 1, fail 2`; the corrected stored-row candidate
  fixture separately failed `Missing expected rejection` for 121 characters.
  The same three-test command finished GREEN at `3/3` after closed optional-fact,
  parser, literal-Evidence, and aggregate-lifecycle validation.
- Lease-fencing review RED used
  `tsx --test --test-name-pattern='same-worker reclaim never authorizes' backend/src/acquisition-visual-comment-ingestion-test.ts`.
  Reclaiming the same observation with the same worker allowed both stale
  complete and stale fail results; TAP reported `tests 3, pass 0, fail 3` with
  `Missing expected rejection`. The equivalent MySQL fake-pool test reported
  `tests 3, pass 0, fail 3` because both claims returned no token. The existing
  table migration test then failed with a legacy row still `running` instead of
  the required safe `retry` state.
- Exact-expiry review RED ran the Memory and MySQL
  `visual lease results lose authority at the exact expiry instant` tests.
  Each reported `tests 3, pass 0, fail 3`; complete and fail both missed the
  expected rejection. Attempt-lifecycle RED reported Memory `tests 8, pass 3,
  fail 5` and MySQL `tests 12, pass 1, fail 11` for invalid zero-attempt stored
  states. The legacy migration RED then showed `attemptCount: 0` instead of 1.

## GREEN verification

- Required focused Task 7 command: `tests 63, pass 63, fail 0, skip 0`.
- Exact-expiry, lifecycle, and migration review matrix: `24/24`.
- Visual ingestion/MySQL matrix: `88 total, 87 pass, 0 fail, 1 skip`; the only skip
  is the conditional live-MySQL matrix because `MYSQL_TEST_ADMIN_URL` is absent.
- Public-comment ingestion and shared UOW: `19/19`.
- Application lifecycle with the repository convention `--test-force-exit`:
  `28/28`.
- Contracts: `79/79`; acquisition drift: `18/18`; runtime OpenAPI: `30/30`;
  generated acquisition type freshness: PASS.
- Backend TypeScript build: PASS. Same-worktree frontend build: PASS with only
  the existing Vite chunk-size warning. `git diff --check`: PASS.
- Complete acquisition gate with `--test-force-exit`: `977 total, 974 pass,
  2 fail, 1 skip`. The two failures are the unchanged baseline
  `acquisition-pi-gateway-runtime-test.ts` and
  `acquisition-pi-runtime-factory-test.ts`, both
  `MODEL_TOOL_DEFINITION_INVALID`; every Task 7 visual test passed. The default
  script emitted its first 34 application tests as passing, then retained the
  known handle and was stopped after 60 seconds without further output.

No real Douyin traffic, raw screenshot persistence, observation-text/personal
field logging, sensitive inference, package-lock edit, external frontend
worktree edit, or Task 8 work occurred.

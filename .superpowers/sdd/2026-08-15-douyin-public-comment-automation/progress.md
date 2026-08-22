# SDD ledger — plan: docs/superpowers/plans/2026-08-15-douyin-public-comment-automation.md

Workspace: backend `/Users/mac/Documents/新项目/GoodJob-growth/.worktrees/douyin-comment-automation` on `codex/douyin-comment-automation-backend`.

Workspace: frontend `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend/.worktrees/douyin-comment-automation` on `codex/douyin-comment-automation-frontend`.

Baseline frontend: complete — `npm run test` passed, 125 checks.

Baseline backend: existing failure — `npm run test:acquisition --workspace backend` produced 669 pass / 3 fail; isolated `acquisition-candidate-research-test.ts` reproduces expected `resolved`, actual `needs_research`. Investigation pending because Task 4 identity aggregation may depend on the same invariant.

Preflight resolution: the baseline test uses stale `public:<provider>:sha256:<constant>` fixture material that now correctly fails source-hash validation. Task 4 must (a) update that fixture without weakening fail-closed adapter-key checks, and (b) extend `acquisition-public-identity-resolver.ts` plus tests so strict `douyin:sec_uid:<value>` input contributes to distinct stable dedupe material; same-video comments from different secUid values must never merge. Handle-only and unmergeable signals remain `needs_research`.

Task 1: fix round 1/5 (3 addressed, 0 open — literal provider/coverage contract; atomic dedupe validation; explicit retryable transport errors; commits b1906cf..bb9cad9)

Task 1: complete (commits f55e206..bb9cad9, review clean)

Task 2: review conflict awaiting human ruling — brief defines strict four-field `douyinPublicCommentSample` policy and later server-side stricter-limit/runtime provider injection; reviewer requests every enabled plan bind `experimental_public_sample` in `providerConnections`. Controller recommendation: keep the provider server-controlled and immutable, because making it plan-supplied broadens the trust surface and contradicts the exact policy shape.

Task 2: human ruling — option 2 governs. Every enabled policy must bind an active `content_fetch` provider snapshot with `providerId=experimental_public_sample`; the four-field policy object itself remains unchanged.

Task 2: fix round 1/5 (1 addressed, 0 open — enabled plans now bind exact active content provider; commits 50f8fa6..49bf39e)

Task 2: complete (commits bb9cad9..49bf39e, review clean)

Open-source assessment: `cv-cat/DouYin_Spider` is reference-only, not a production dependency or copied-code source. The reviewed 2026-07-26 tree has no license, requires logged-in cookies plus browser-fingerprint/msToken/a_bogus material for comment reads, includes write-capable private-message/interaction APIs, and disables TLS verification in request paths. GoodJob may independently reuse the public protocol concepts (aweme/comment field mapping and cursor/has_more pagination), but must not import its source, signer/auth stack, fingerprint evasion, or write operations. The approved default remains the bounded, read-only, no-account `experimental_public_sample` provider with fuse/audit controls.

Task 3: review round 1/5 (4 Important open — Run-scoped observation snapshot stability; timezone/canonical instant replay; memory append atomicity; bounded fetch-attempt reads; commit 5e4f213)

Task 3: fix round 1/5 (4 addressed, 0 open — observation-linked Run snapshots; UTC millisecond canonicalization; atomic memory append; validated bounded fetch reads; commits 5e4f213..0ca58cd)

Task 3: complete (commits 49bf39e..0ca58cd, review clean)

Task 4: started at base 0ca58cd — brief includes strict Douyin secUid/handle/unmergeable dedupe semantics, the known stale candidate-research fixture correction, deterministic intent rules, event/evidence/candidate/link ingestion, schema parity, and the no-cookie/no-signature/no-fingerprint/no-write-action boundary.

Task 4: implementation commit a052a76 — required focused 42/42, contracts 65/65, backend build and diff check pass; independent review pending.

Cross-task regression: optional full acquisition suite at a052a76 reports 670 pass / 33 fail. Main cascade begins with Task 2 JSON Schema `contains` rejected by the OpenAPI 3.0 converter; two Pi runtime failures report pre-existing `MODEL_TOOL_DEFINITION_INVALID`. Read-only diagnosis is active; do not claim the branch fully green until resolved or isolated with evidence.

Task 4: review round 1/5 (5 Important open — later signal/profile aggregation; content-version evidence/replay authority; recoverable cross-repository saga and early validation; restore v1 negativeSignals compatibility; enforce exact provider version/top-level-only literal contract; commit a052a76)

Task 4: complete (commits 0ca58cd..ef0a396, review clean after five focused fix rounds)

Task 5: complete (commits ef0a396..f2d1dfc, review clean after two focused fix rounds)

Task 6: implementation commit 896bdbb — focused/affected 103/103; contracts, OpenAPI, generated types, frontend compatibility tests and builds green; full acquisition 799/797/2 with only the two known Pi MODEL_TOOL_DEFINITION_INVALID baseline failures.

Task 6: review round 1/5 (5 Important open — negative signals/unresolved actors miscounted; first-100 attempt truncation; non-corresponding fabricated step timing and aggregation completeness; dangling candidate/evidence traceability; non-Douyin discovery false positive; commit 896bdbb)

Task 6: fix round 1/5 (4 addressed, 1 open — exact candidate/evidence/event provenance and actor subject binding; commit 2717448)

Task 6: fix round 2/5 (1 addressed, 0 open — exact evidence provenance and strict actor subject binding; commit 3e80a6e)

Task 6: complete (commits f2d1dfc..3e80a6e, review clean)

Task 7: started at frontend base 34cc39b; user-owned untracked package-lock.json must remain untouched. Plan scope clarified by commit 13f452d to include index.html, shared AI/manual policy application, fixed server-controlled comment provider snapshot, and 1024/768 shell overflow remediation.

Task 7: implementation commit 660171a — frontend tests 125 checks, typecheck/build/diff-check green; worktree only retains user-owned untracked package-lock.json.

Task 7: review round 1/5 (3 Important open — AI approved preview differs from effective submitted policy and limit edits do not invalidate approval; comment card does not switch to candidate/evidence inspector; unresolved strong signal can be mislabeled high-intent and reasons are omitted; commit 660171a)

Task 7: fix round 1/5 (2 addressed, 1 open — selected comment candidate detail is hidden when the independent candidateEvents page omits that candidate; commit 7bd2ced)

Task 7: fix round 2/5 (1 addressed, 0 open — selected comment candidate detail renders independently of the current candidateEvents page; commit 77e7afe)

Task 7: minor (deferred): one controller test's no-fabricated-event assertion names a fixture ID that never existed; independent production counterexample confirms no event injection.

Task 7: complete (frontend commits 34cc39b..77e7afe, review clean with 1 deferred test-quality minor)

Task 8: preflight complete — explicit Playwright testMatch requires config update; fixture will explicitly commit immutable queued/running/partial_success revisions rather than advance on GET count; plan clarified by backend docs commit 98aa60e.

Task 8: implementation commit 3b489f2 — three viewport E2E initially reported green; real E2E RED added minimal escaped evidence source URL rendering; frontend tests/typecheck/build/diff-check green.

Task 8: review round 1/5 (5 Important open — reload double-navigation race; impossible queued automation status; incomplete untyped candidate fixture; undeclared GETs return 501 but are not asserted absent; short fixture does not prove long/unbroken text overflow; commit 3b489f2)

Task 8: fix round 1/5 (5 addressed, 0 open — deterministic reload; schema-valid typed fixtures; undeclared GET assertion; 300+ character overflow coverage; minimal evidence-list wrapping; commit 674b0ce)

Task 8: complete (frontend commits 77e7afe..674b0ce, independent review clean; three viewports 3/3 and 1024px repeat-each 5/5)

Task 9: complete — current README/execution guide/PRD now match the implemented read-only public top-level comment Beta; official Douyin OAuth/actions and persistent acquisition scheduling remain future work. Final gates: acquisition 816/814/2 with only the two approved Pi `MODEL_TOOL_DEFINITION_INVALID` baselines; contracts/check/build green; marketing frontend 125 checks, comment automation E2E 3/3, and build green. Optional real-network smoke not run because both opt-in environment variables were unset. Report: `.superpowers/sdd/2026-08-15-douyin-public-comment-automation/task-9-report.md`.

Task 9: review round 1/5 (3 Important open — strict sec_uid was overstated as resolved; cost/time were overstated as pre-request hard stops; high-intent label was incorrectly coupled to human approval; commit 77d7e5a)

Task 9: fix round 1/5 (3 addressed, 0 open — docs now match identity, budget-settlement, and UI-label gates)

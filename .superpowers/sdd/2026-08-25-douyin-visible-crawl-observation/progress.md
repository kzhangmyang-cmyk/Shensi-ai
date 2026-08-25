# SDD ledger — plan: docs/superpowers/plans/2026-08-25-douyin-visible-crawl-observation.md

## Pre-flight scan

| Scope | Producer / consumer | Finding |
| --- | --- | --- |
| Task 1 self-check | Failing sidecar behavior tests → Pydantic activity and runner hooks | Clean. The exact injection seam is not prescribed; behavior and closed fields are prescribed. |
| Task 2 self-check | Failing gateway/repository/worker tests → fenced activity persistence | Clean. Existing MySQL `payload_json` is sufficient and live MySQL may remain an explicit skip without credentials. |
| Task 3 self-check | Closed OpenAPI/UI tests → generated DTO and dashboard rendering | Clean. The generated type remains the frontend transport authority. |
| Task 4 self-check | Current docs → aggregate verification | Clean. Live Douyin and Docker gates are explicitly outside the deterministic change. |
| Tasks 1 → 2 | Sidecar snake_case `activity` → strict gateway camelCase `AcquisitionCrawlerActivity` | Clean. Both use the same closed phases, keyword, browser mode, and monotonic sequence. |
| Tasks 2 → 3 | Persisted `AcquisitionCrawlerStatus.activity` → public OpenAPI and frontend | Clean. Browser reads only the Node job projection, never the live sidecar. |
| Tasks 1 → 3 | Visible observation window → UI browser-mode wording | Clean. UI describes the actual sidecar-reported mode and does not promise a visible window in headless deployments. |
| Tasks 3 → 4 | Public/user behavior → README, architecture, module and deployment docs | Clean. Current docs will state observation-mirror semantics directly. |

Ruling: Task 1 may introduce focused internal helpers for browser-mode application and observation-hook installation — the plan requires behavior, not a particular test seam — if wrong, the cost is a small internal refactor without public-contract impact.

Ruling: Visible/headless mode remains deployment-configured through `MEDIACRAWLER_BROWSER_HEADLESS`, not a per-run public option — this matches the approved automatic-local-window design and avoids changing immutable policy/run-now semantics — if wrong, adding a per-run selector later requires a separate contract and idempotency change.

## Baseline

- Existing linked worktree: `feature/douyin-mediacrawler-acquisition`.
- Baseline commits: `12eaf17` (prior progressive runtime fixes), `888797d` (approved design and plan).
- Baseline tests: Python 21 passed; backend 47 passed and 1 credential-gated MySQL test skipped; frontend self-tests passed.

## Task progress

- Task 1: fix round 1/5 (2 addressed, 1 open; commits `b072fde..a7e6371`).
- Task 1: fix round 2/5 (1 addressed, 0 open; commit `03777a6`).
- Task 1: complete (commits `888797d..03777a6`; independent review clean).
- Task 2: fix round 1/5 (3 addressed, 0 open; commits `d5817cf..0d51e62`).
- Task 2: complete (commits `adda8e..0d51e62`; independent review clean).

Ruling: Node persists an internal `activityObserved` sentinel — this lets the
first real sequence-0 sidecar snapshot replace the conservative headless
default while preserving strict same-sequence conflict detection thereafter —
if wrong, removing it would make visible and headless initial snapshots
indistinguishable and reintroduce the reviewed startup failure.

- Task 3: fix round 1/5 (2 addressed, 2 open; commits `ac0561d..f3ede81`).
- Task 3: fix round 2/5 (2 addressed, 1 open; commits `f3ede81..c58c8b1`).
- Task 3: fix round 3/5 (1 addressed, 0 open; commits `c58c8b1..182edca`).
- Task 3: complete (commits `5a00022..182edca`; independent review clean).
- Task 4: complete (commits `1a38712..f118d31`; independent review clean).
- Final lifecycle, contract, and UI review fixes: complete (commits `d82890b`,
  `72494b1`, and `231823e7`). Manager terminal page/activity persistence is
  atomic, paused jobs requeue, the public projection adds the closed
  `candidateProjectionState`, and the UI handles terminal-pending projection.
- Candidate ordering and documentation fixes: complete (commits `9f5f94e` and
  `51d523a`). Every candidate read follows a validated crawler-status read;
  live candidates may appear before readiness, and `ready` is the ordering
  boundary for the final candidate read.
- Terminal candidate-read failure handling: complete (commit `c4523b2`). A
  failed candidate request retains its validated terminal status and does not
  schedule another automatic poll for `ready` or `failed`.
- Frontend decoder and queued-announcement hardening: complete (commit
  `011e92b`). Closed crawler enums require primitive strings, and the pre-status
  queued placeholder announces once per outstanding run.
- Frozen activity keyword validation: complete (commit `df8d8d5`). Persisted
  hydration, repository writes, and public projection require a null or approved
  keyword of at most 100 Unicode code points.
- Observation and restart isolation: complete (commit `0d7d852`). Observation
  navigation is a bounded best-effort task outside the collector critical path;
  attempt-local output excludes stale activity/JSONL, and paused restart seeds
  record de-duplication from persisted page IDs.
- Focused sidecar, backend, contract/generated-type, and frontend self-test/build
  checks are recorded in the final-fix reports. No browser, crawl, comment,
  direct message, or automatic external action was run for these fixes.

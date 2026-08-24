# Task 5 — Douyin crawler candidate conversion

Status: implemented; current verification evidence is recorded below.

## Delivered boundary

- Automation intent identity and acquisition run identity are distinct.
  `acquisition_douyin_run_bindings` commits each intent to a real
  `AcquisitionRun` for the exact approved plan/version/hash. The same
  transaction writes the queued run event, audit, intent, and idempotent replay.
- One daily crawler job can serve scheduled and run-now aliases. Authoritative
  run aliases and automation-intent aliases are stored separately; candidate
  links always use acquisition run IDs.
- Terminal ingestion reads only Task 4 persisted records and atomically writes
  the existing evidence, candidate, identity-alias, audit, run-event, and
  run-candidate repositories. Memory and MySQL use the same boundary. A retry
  with already-linked content is a no-op, and injected failure rolls evidence,
  candidates, and run links back together.
- Workspace content hashes are unique. Stable platform record edits supersede
  across jobs. Evidence stores the bounded source URL/excerpt/keyword,
  observed time, job/record/cursor, and exact pinned upstream commit
  `d6f7c5bb906b6dac40ddf343ef9e26438a3de092`.
- Creator and demand-comment policy paths are separate. Refusal, complaint,
  minor, and identity-known missing-source signals create permanent one-way
  Douyin DNC state; default candidate feeds exclude DNC and later positive
  content cannot re-admit the identity.
- Node acknowledges a sidecar job only after authoritative persistence.
  Acknowledgement time is durable and idempotent, survives restart, and starts
  the 24-hour page cleanup clock. A separate fenced ingestion claim handles
  crash, retry, same-worker ABA, and concurrent-worker recovery.
- Unlinked evidence expires 90 days after backend ingestion. Candidate-linked
  evidence, one-way DNC identity, and audit events remain. The application owns
  worker, recovery, retention, and graceful-close lifecycle.
- `GET /api/v1/acquisition/runs/{runId}/candidates` accepts only authoritative,
  workspace-owned runs, returns 404 for an automation intent ID, and exposes
  only the bounded public projection. The OpenAPI and generated frontend type
  publish `acquisitionRunId` on run-now results.

## Verification evidence

- Focused automation, crawler-job, and authoritative-ingestion MySQL suites:
  10 passed, 0 failed, and 3 optional live-MySQL tests skipped because
  `MYSQL_TEST_ADMIN_URL` was not supplied.
- Full MediaCrawler sidecar adapter suite: 33 passed.
- Acquisition aggregate: 1,068 passed, 0 failed, 5 environment-gated skips.
- Acquisition contract gate, root production build, backend TypeScript build,
  context check, and generated acquisition type check passed.

Live MySQL cases remain explicitly environment-gated; their fixture provisions
the authoritative plan, plan version, run, automation intent, and binding before
exercising crawler aliases. No live-provider or Docker result is claimed here.

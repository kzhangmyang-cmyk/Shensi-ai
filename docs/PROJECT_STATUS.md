# Project Status

This file is the sole current progress ledger for the canonical `shensi`
repository. Test results are evidence only for the commit and environment in
which they were run; historical checkboxes and reports do not update this
ledger.

## Completed

- The standalone repository was created on `main`; its imported source commit
  and legacy repository are recorded in `docs/SOURCE_PROVENANCE.md`.
- The root source boundaries remain `frontend/`, `backend/`, and `contracts/`.
- The checked-in Growth contract release remains `1.0.12`.
- The current AI reading path, machine-checkable context contract, and five
  module guides are present; older root `docs/superpowers/{plans,specs}` files
  are archived outside the current reading path.
- The obsolete unauthenticated surface has been replaced by the Shensi
  enterprise login. It starts with empty credentials, preserves the existing
  server authentication and CSRF interfaces, and restores only sessions
  validated by the server.
- The canonical production topology is `deploy/compose.yaml`: MySQL, backend,
  frontend, and a single public gateway service use an internal Compose
  network. Production backend persistence is MySQL only.
- Canonical `./scripts/dev`, `./scripts/deploy`, and `./scripts/verify`
  wrappers validate real MySQL/security configuration, fail closed for ports
  and production secret-file permissions, use file-only production settings,
  and keep verification output free of environment values.
- Encrypted backup, empty-target restore, source-to-`shensi` orchestration, and
  closed non-secret data-verification tooling are present. The tools stream
  through explicit child-process argument arrays, authenticate the complete
  anonymous ciphertext snapshot before restoring from that same FD, reject
  unsupported source objects and every target schema-object type, and never
  create a plaintext dump or provide a database-drop path. Verification uses
  allowlisted non-sensitive digests and aggregate ciphertext-row identities;
  password hashes and raw credential bytes are excluded.
- The restore-boundary database-copy stage from `shensi_sales` into the
  distinct `shensi` database completed at `a681c123`. Closed verification
  matched 237 tables and 170 rows plus stable identities, model projections,
  and aggregate encrypted-row identities. The first target-backend startup
  added one deterministic `system_migration` model-activation audit row; a
  second restart added nothing further. An operator-authorized target-only
  identity binding then preserved the restored connection owner/team and
  credential AAD while binding the supplied login to that owner. The bounded
  Task 7 verifier logged in once, loaded the exact restored
  `deepseek-v4-pro` connection, and made exactly one successful provider
  health call. That call added one immutable job snapshot and one model-call
  ledger row, leaving the current target at 237 tables and 173 rows while the
  unchanged source remains at 237 and 170. The task-owned backend was stopped
  and port `4192` released. Authenticated encrypted backups were retained and
  temporary migration accounts were removed. Current non-secret evidence is in
  `docs/migration/2026-08-24-live-migration-verification.md`.
- Task 7 is complete: its encrypted backup, distinct-target restore, closed
  restore-boundary comparison, isolated MySQL health, authenticated login,
  restored-connection visibility, and single bounded DeepSeek health gates
  all passed. No traffic cutover or legacy-process shutdown occurred.
- Acquisition publishes workspace-bound Douyin automation policy `GET`/`PUT`
  and idempotent run-now commands. Immutable policy versions sit behind a
  compare-and-swap head, while durable run intents freeze approved plan,
  policy, active-account/login, local-date, and daily-budget identities. The
  public contract excludes the private MediaCrawler account handle.

## Active

- Task 8 full-runtime acceptance and cutover planning are next. The legacy
  repository, source database, and user-facing processes remain rollback
  inputs; no cutover has occurred and none is authorized by Task 7.

## Blocked

- Docker Engine and Docker Compose are unavailable in the current execution
  environment (`docker: command not found`), so Compose rendering and image
  builds require verification in a Docker-equipped environment.

## Next

1. Run Task 8 full-runtime acceptance in a Docker-equipped environment.
2. Request explicit cutover approval only after Task 8 passes; Task 7 did not
   authorize cutover.

The two executing design/plan documents are retained under
`docs/superpowers/` until final acceptance, but they are not progress authority.

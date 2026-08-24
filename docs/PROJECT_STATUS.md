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
- The authorized live database copy from `shensi_sales` into the distinct
  `shensi` database completed at `a681c123`. Restore-boundary verification
  matched 237 tables and 170 rows plus stable identities, model projections,
  and aggregate encrypted-row identities. The first target-backend startup
  added one deterministic `system_migration` model-activation audit row; a
  second restart added nothing further, leaving the current target at 237
  tables and 171 rows while the unchanged source remains at 237 and 170. Both
  isolated starts passed MySQL health on `127.0.0.1:4192`. Authenticated
  encrypted backups were retained and temporary migration accounts were
  removed. Current non-secret evidence is in
  `docs/migration/2026-08-24-live-migration-verification.md`.

## Active

- The restored `shensi` database is awaiting authenticated login and
  restored-provider runtime acceptance. The task-owned isolated backend was
  stopped after its MySQL health evidence was captured. The legacy repository,
  source database, and user-facing processes remain rollback inputs; no
  cutover has occurred.

## Blocked

- No code or documentation blocker is recorded for the current task.
- Docker Engine and Docker Compose are unavailable in the current execution
  environment (`docker: command not found`), so Compose rendering and image
  builds require verification in a Docker-equipped environment.
- Login/session and restored DeepSeek credential health cannot be verified
  because the ignored environment contains no authorized test email/password
  pair. The restored `deepseek-v4-pro` projection and ciphertext identity match,
  but no external provider call was made. Cutover remains separately
  unauthorized.

## Next

1. Supply a valid test login pair through the ignored operator secret boundary,
   then run the bounded login/session and restored DeepSeek health check.
2. Run the remaining full-runtime acceptance gates and request explicit
   cutover approval.

The two executing design/plan documents are retained under
`docs/superpowers/` until final acceptance, but they are not progress authority.

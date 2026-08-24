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

## Active

- The clean-repository program is establishing a single AI-readable,
  deployable Shensi runtime while preserving the legacy repository and source
  database as rollback inputs. Repository gates, not historical completion
  prose, determine its status.

## Blocked

- No code or documentation blocker is recorded for the current task.
- Docker Engine and Docker Compose are unavailable in the current execution
  environment (`docker: command not found`), so Compose rendering and image
  builds require verification in a Docker-equipped environment.
- Live data migration, credential verification, and cutover cannot be claimed
  until an operator supplies the required local secrets and authorizes those
  later operational steps.

## Next

1. Have an authorized operator migrate into a distinct `shensi` target using
   the documented secret boundary.
2. Run full runtime acceptance and request explicit cutover approval.

The two executing design/plan documents are retained under
`docs/superpowers/` until final acceptance, but they are not progress authority.

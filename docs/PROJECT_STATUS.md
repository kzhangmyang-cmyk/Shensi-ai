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

## Active

- The clean-repository program is establishing a single AI-readable,
  deployable Shensi runtime while preserving the legacy repository and source
  database as rollback inputs.
- The next executable product change is the enterprise login replacement. The
  repository gates, not historical completion prose, determine its status.

## Blocked

- No code or documentation blocker is recorded for the current task.
- Live data migration, credential verification, and cutover cannot be claimed
  until an operator supplies the required local secrets and authorizes those
  later operational steps.

## Next

1. Replace the obsolete login with the Shensi enterprise login.
2. Add the production Docker Compose topology and canonical command wrappers.
3. Add encrypted backup, restore, migration, and verification tooling.
4. Migrate into a distinct target database, run full acceptance, and request
   explicit cutover approval.

The two executing design/plan documents are retained under
`docs/superpowers/` until final acceptance, but they are not progress authority.

# Live Migration Verification — 2026-08-24

## Scope and result

The authorized database copy from `shensi_sales` into the distinct `shensi`
database completed on local MySQL `8.4.11` at port `3307`. The source database
and legacy runtime were retained. No traffic cutover, legacy-process shutdown,
or GitHub push was performed.

The restore-boundary closed data verifier passed at repository commit
`a681c123ad213f44b960b967b9bba1737bbd5657`. The isolated backend then passed
`/api/health` on `127.0.0.1:4192` with `ok=true` and `store=mysql`. Its first
startup added one deterministic `system_migration` model-activation audit row;
a second bounded restart added no further row. Current post-runtime data is
237 tables and 173 rows in the target versus 237 tables and 170 rows in the
retained source: one target-only activation audit row plus the immutable job
snapshot and model-call ledger row created by the single bounded health call.
The supplied login authenticated once, the exact restored DeepSeek connection
was visible under its preserved owner/team, and the one authorized provider
health request passed in 1,255 ms. Overall Task 7 is complete; cutover remains
separately unauthorized.

## Preflight and controlled retry

The initial read-only preflight established all of the following before any
live mutation:

- source database `shensi_sales`: 237 base tables and 170 total rows;
- target database `shensi`: absent;
- source views, routines, and events: zero;
- temporary migration account and persistent `shensi_app` account: absent;
- source and target names: distinct.

The first restore attempt stopped with `PIPELINE_DESTINATION_EXIT:1` after
creating one empty table and importing zero rows. A read-only inspection found
that the authenticated dump emitted `LOCK TABLES` between the first and second
table, while the restricted database-scoped account correctly lacked that
privilege. A non-mutating permission probe returned
`ER_DBACCESS_DENIED_ERROR` (`1044`, SQLSTATE `42000`).

After the lock-suppression fix in `a681c123` passed independent review, a
controller ruling authorized one exact cleanup and retry. Immediately before
cleanup, the target was revalidated as exactly database `shensi`, containing
only `acquisition_action_execution_receipts`, zero rows, and zero views,
routines, events, or triggers. Source inventory and all encrypted artifacts
still matched preflight. The cleanup executed only the literal database target
`shensi`; it did not touch `shensi_sales`. The patched orchestrator then ran
once and completed. No second cleanup or retry was used.

## Encrypted artifacts

All artifacts and authenticated manifests are ignored by Git and mode `0600`.
The first artifact also passed negative checks proving that a wrong passphrase
and a one-byte ciphertext change are rejected before restore. No plaintext SQL
or dump file was created.

| Purpose | Encrypted artifact | SHA-256 | Authenticated |
| --- | --- | --- | --- |
| Pre-migration rollback | `2026-08-24T08-57-00-170Z-shensi_sales.sql.enc` | `ffe5a9aaed47a7ec3791bb093909f5098ad09e5a17691041fad67012a4980727` | yes |
| Retained failed-attempt evidence | `2026-08-24T08-57-25-854Z-shensi_sales.sql.enc` | `4929d0e9c44ee8d27527824152f9bca6adec081a41f2ad5d89541193bd779edf` | yes |
| Successful migration input | `2026-08-24T09-07-41-281Z-shensi_sales.sql.enc` | `c5fe296a76bcc4095ad1e10a810f0b1b5a9da28af7771a8a9a8919bf6fd11a36` | yes |

Each authenticated manifest records 237 observed source tables. The successful
restore-boundary closed verification report is
`2026-08-24T09-07-44-087Z-shensi-verification.json`; it remains ignored and
mode `0600` with the other migration evidence. The later
`2026-08-24T09-13-53-263Z-shensi-verification.json` intentionally records the
post-runtime `TABLE_COUNT_MISMATCH` described below rather than overwriting the
successful restore-boundary evidence.

## Restore-boundary closed data verification

| Check | Source | Target | Result |
| --- | ---: | ---: | --- |
| Base tables | 237 | 237 | pass |
| Total rows | 170 | 170 | pass |
| Stable user IDs | 5 | 5 | pass |
| Stable workspace IDs | 2 | 2 | pass |
| Acquisition runs | 0 | 0 | pass |
| Financial-council runs | 0 | 0 | pass |
| Model connections | 2 | 2 | pass |
| Encrypted-row identity tables | 3 | 3 | pass |
| Triggers | 0 | 0 | pass |

The verifier returned `VERIFICATION_PASSED`. Table sets and counts, column and
migration metadata, stable identities, workflow statuses, allowlisted
integrity hashes, model projections, and aggregate ciphertext identities all
matched. A fresh post-migration source snapshot was byte-for-byte equal to the
pre-migration normalized inventory.

The restored default model projection is:

- connection ID: `ai_72993f83-e6dc-4164-8ebb-8b9288227030`;
- provider: `deepseek`;
- model: `deepseek-v4-pro`;
- credential version: `1`;
- default: `true`.

This proves the encrypted row identity and non-secret model projection were
preserved at the restore boundary. Successful decryption and provider health
were then proved separately by the bounded runtime gate below.

## Post-runtime convergence

Starting the restored backend executed its existing legacy model-connection
normalization and inserted this target-only audit event:

- ID: `mca_migration_4daf49b09761f6b9aac3c404e2aaacad`;
- actor: `system_migration`;
- connection: `ai_72993f83-e6dc-4164-8ebb-8b9288227030`;
- reason: `legacy_migration_updated_at_desc_id_asc`.

A fresh strict source/target comparison after that startup passed every check
except `TABLE_COUNT_MISMATCH`: `ai_model_connection_activation_events` was 1
in the source and 2 in the target, making the totals 170 and 171. Table set,
schema and migration metadata, stable IDs, acquisition and council runs, model
projections, allowlisted hashes, and ciphertext identities still matched. No
row was deleted to force equality.

A second bounded backend restart returned HTTP `200`, `ok=true`, and
`store=mysql`; the target remained 237 tables, 171 rows, and exactly two model
activation events with the same single `mca_migration_*` event above. This
proves the startup migration is idempotent in the verified runtime. The strict
verifier remains a restore-boundary comparison and is expected to report the
one-row count difference after runtime initialization.

## Authorized identity binding and credential health

The operator supplied a login through the ignored mode-`0600` environment and
authorized target-only account preparation. The initially added empty login
account authenticated but could not see the restored connection because its
owner/team did not match; no provider call was made in that state.

A controller ruling then authorized one target transaction that preserved the
restored connection ID, provider, model, owner ID, team ID, and credential
version. Before mutation, it locked the exact connection, its existing owner,
and the empty login account; verified the owner was active in the connection's
team; proved the supplied email was unique; and dynamically scanned 1,084
relevant ID/owner/user/actor columns outside `users`, finding zero references
to the empty account. The transaction changed only the existing target owner's
name, email, password hash, active status, and incremented authentication
version, then deleted the exact unreferenced empty account. The source owner
identity remained unchanged, preserving rollback safety. This cost is limited
to the authorized target user identity/email/password change and deletion of
the temporary empty login; connection ownership, team binding, and credential
AAD did not change.

The final bounded verifier then established:

- backend health: HTTP `200`, `ok=true`, `store=mysql`;
- login: one successful attempt as owner `u_admin`, team `europe`;
- restored connection: exact ID
  `ai_72993f83-e6dc-4164-8ebb-8b9288227030`, provider `deepseek`, model
  `deepseek-v4-pro`, credential version `1`;
- provider health: exactly one request, HTTP `200`, result
  `PROVIDER_HEALTH_PASSED`, duration 1,255 ms;
- retries: zero.

The successful call created one immutable `ai_job_model_snapshots` row and one
`ai_model_call_records` ledger row. The target therefore moved from 171 to 173
rows without altering its 237-table set. The normalized source inventory still
matched the pre-migration capture exactly at 237 tables and 170 rows. Target
login uniqueness, the five-user count, connection owner/team/version, and
`last_test_status=passed` were rechecked after the call.

## Runtime and account evidence

- Every isolated backend session used the persistent
  `shensi_app@127.0.0.1` account on `127.0.0.1:4192`; the final session returned
  HTTP `200`, `ok=true`, and `store=mysql`. The task-owned process was stopped
  after evidence capture and port `4192` was confirmed released; legacy
  processes were not touched.
- `shensi_app` has database-scoped privileges only on `shensi`; its existing
  authorized password was not changed during the retry.
- Both random temporary migration accounts were database-scoped, had no global
  administrative privileges, and were deleted after their attempt. No
  `shensi_migrate_*` account remains.
- Final `.env.production.local` is ignored and mode `0600`; it points the
  source to `shensi_sales`, the target/runtime to `shensi`, has a blank local
  admin URL, and retains the backup passphrase outside Git.
- Test login secrets stayed only in the ignored mode-`0600` environment.
  Cookies, CSRF values, request headers, provider responses, and credential
  material stayed in memory and were not printed or written to tracked files.

## Residue and rollback audit

- The source repository, source database, and legacy processes were not
  deleted, stopped, or cut over.
- Three encrypted backups, their authenticated manifests, source inventories,
  the successful restore-boundary report, and the post-runtime comparison
  report remain ignored for rollback and audit.
- No plaintext dump, password, database URL, API key, provider response,
  cookie, or customer row is included in tracked evidence.
- Task 7 restore and runtime gates are complete. Cutover still requires the
  separate Task 8 acceptance flow and explicit approval.

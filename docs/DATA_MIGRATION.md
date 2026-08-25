# Data Migration

## Current state

This repository contains fail-closed tooling for an encrypted, source-to-new-
target MySQL migration. The authorized lock-free retry completed its
restore-boundary migration into the distinct `shensi` database: source and
target both had 237 base tables and 170 rows when closed verification passed.
The source remains unchanged at 237 tables and 170 rows. The first isolated
target-backend start then added one deterministic, idempotent
`system_migration` model-activation audit event. A second backend restart added
no row. The final bounded credential-health gate added one immutable model job
snapshot and one model-call ledger row, so the current target has 237 tables
and 173 rows.

Task 7 is complete. An operator-authorized target-only identity binding kept
the restored connection's original owner/team and credential AAD intact while
binding the supplied login to that owner. The isolated verifier authenticated
once, loaded the exact restored `deepseek-v4-pro` connection, and made exactly
one successful bounded health call without exposing credentials or provider
content. No cutover has occurred. Running any command in this document requires
operator-supplied credentials and explicit operational authorization. Dated
incident, retry, identity-binding, and health evidence is retained in
`docs/migration/2026-08-24-live-migration-verification.md`; it is not the
current execution procedure.

The source database remains `shensi_sales`. The only accepted restore target
database is a distinct database named `shensi`. The tools accept `mysql:` URLs
only, never drop a database, never write a plaintext dump to disk, and never
print full database URLs, passwords, passphrases, customer rows, or provider
keys.

## Prerequisites

- Node.js `22.22.3` and installed workspace dependencies.
- MySQL 8.4 client programs. Defaults:
  - `mysqldump`: `/Users/mac/.local/mysql-8.4.11-macos15-arm64/bin/mysqldump`
  - `mysql`: `/Users/mac/.local/mysql-8.4.11-macos15-arm64/bin/mysql`
- OpenSSL default: `/usr/bin/openssl`.
- A source account with consistent-dump and metadata/count read access only.
- A target account with schema/data restore privileges for the empty `shensi`
  database. `LOCK TABLES` privilege is not required.
- For `./scripts/migrate-data`, a local target-server administrator account
  that can inspect and create `shensi`. Its host and port must equal the target
  URL host and port.
- The original external `PROVIDER_CREDENTIAL_KEY` and
  `AGENT_JOB_ENCRYPTION_KEY`, supplied outside Git for post-restore runtime
  acceptance.

Do not put secrets in command arguments, shell history, Git, this document, or
verification reports. Inject them with the approved operator secret mechanism.

## Environment contract

Required values:

| Variable | Used by | Contract |
| --- | --- | --- |
| `SOURCE_DATABASE_URL` | all commands | `mysql:` URL for the read-only source; database must differ from target |
| `TARGET_DATABASE_URL` | restore, verify, migrate | `mysql:` URL whose database is exactly `shensi` |
| `MYSQL_LOCAL_ADMIN_URL` | migrate | `mysql:` URL with a concrete database (normally `mysql`) on the same host and port as the target |
| `SHENSI_BACKUP_PASSPHRASE` | backup, restore, migrate | OpenSSL passphrase; never logged or written to a manifest |
| `ENCRYPTED_BACKUP` | direct restore | Path to the selected `*.sql.enc` file |
| `BACKUP_MANIFEST` | direct restore | Optional path to the selected authenticated manifest; defaults to `<ENCRYPTED_BACKUP>.migration-manifest.json` |

Optional overrides:

| Variable | Default |
| --- | --- |
| `MYSQLDUMP_BIN` | MySQL 8.4 `mysqldump` path above |
| `MYSQL_BIN` | MySQL 8.4 `mysql` path above |
| `OPENSSL_BIN` | `/usr/bin/openssl` |
| `BACKUP_DIRECTORY` | repository `backups/` |
| `VERIFICATION_REPORT` | timestamped non-secret report under `backups/` |

The ignored `.env.local` and `.env.production.local` files are not loaded by
the shell wrappers. Environment injection is the operator's explicit boundary;
the documented `node --env-file` commands load the named file explicitly.
`scripts/backup` and `scripts/migrate-data` pass their documented flags through
unchanged, and every migration CLI rejects unknown flags. Direct restore is
intentionally env-only: `./scripts/restore` accepts an empty argument list and
rejects every command-line token.

## Encrypted backup

Run:

```bash
node --env-file=.env.production.local scripts/backup.mjs \
  --source-env SOURCE_DATABASE_URL --output-dir backups
```

Before starting `mysqldump`, the command fails closed if the source contains a
view, stored routine, or event. Those object forms cannot be reproduced by this
empty-target workflow while retaining the absolute no-DROP rule. Base tables,
data, and triggers are streamed from a single-transaction `mysqldump` directly
into OpenSSL AES-256-CBC with PBKDF2 and salt. The dump explicitly skips views,
routines, events, tablespaces, database/table/trigger DROP statements, and
REPLACE statements. It also uses `--skip-lock-tables` and `--skip-add-locks`,
so the source is not explicitly table-locked and the restore stream contains
no `LOCK TABLES` or `UNLOCK TABLES` statements. It creates no plaintext dump.
The encrypted file is opened with mode `0600`; an incomplete encrypted file is
deleted when either pipeline stage fails or the process receives
`SIGINT`/`SIGTERM`.

Child processes receive only a small safe base environment plus `MYSQL_PWD`
for MySQL programs or `SHENSI_BACKUP_PASSPHRASE` for OpenSSL. The Git source-
commit lookup receives only the same safe base. Database URLs, passphrases,
provider keys, agent-job keys, and unrelated secrets are not forwarded to Git.

The adjacent ignored mode-`0600` `*.migration-manifest.json` is an authenticated
encrypt-then-MAC sidecar. It binds the artifact basename, full encrypted-file
SHA-256, source commit, MySQL version, source database name, UTC creation time,
and all other manifest fields with HMAC-SHA256 under an independently salted
PBKDF2-derived key. Its `observedTableCounts` are a non-transactional source
observation, not counts from the exact dump transaction; exact source/target
counts are established by post-restore verification. The manifest contains no
password, passphrase, full URL, customer row, encrypted provider value, or
provider key.

## Direct restore

Provision an existing empty `shensi` target, select the encrypted artifact and
its sidecar with `ENCRYPTED_BACKUP` and optionally `BACKUP_MANIFEST`, then run:

```bash
./scripts/restore
```

The command copies ciphertext into a private mode-`0700` temporary directory,
opens the snapshot mode `0600`, unlinks its path, and removes the empty
directory. It authenticates the complete anonymous snapshot FD and manifest,
requires the authenticated `sourceDatabase` to equal `SOURCE_DATABASE_URL`,
then gives that same open FD to OpenSSL as stdin. It never reopens the mutable
original artifact path. A missing or modified sidecar, wrong passphrase, or
corrupt snapshot therefore cannot start or feed MySQL; later changes to the
original path cannot change the already authenticated restore bytes.

The command then rejects a target other than `shensi`, equal source/target
database names, and any target containing a table, view, routine, trigger, or
event. Authenticated ciphertext is streamed from OpenSSL directly into the
MySQL client. Either child failure or a signal fails the command; cleanup sends
`SIGTERM`, escalates to `SIGKILL` after a bounded wait, awaits both children,
and closes all anonymous temporary state. If a restore fails after MySQL has
begun reading, do not retry into that database: isolate it, provision a new
empty `shensi` target under incident control, and start again from the retained
ciphertext. Never drop or clean the source database.

## Orchestrated migration

After a reviewed preflight and operator authorization, run:

```bash
node --env-file=.env.production.local scripts/migrate-data.mjs \
  --source-env SOURCE_DATABASE_URL \
  --target-env TARGET_DATABASE_URL --target-database shensi
```

The orchestrator validates all URLs and the target administrator server,
proves the target is absent or empty, takes the encrypted backup, rechecks the
target to close the race window, creates `shensi` only when absent, restores,
and runs closed verification. It never drops a database. Any failed check
stops the sequence; it does not perform cutover.

## Verification

For a restored target, run:

```bash
node scripts/verify-data.mjs
```

Before migration, capture a source-only inventory without requiring a target:

```bash
node --env-file=.env.production.local scripts/verify-data.mjs \
  --source-env SOURCE_DATABASE_URL --inventory-only \
  --output backups/source-inventory.json
```

Verification compares the complete table set and exact row counts, column and
schema/migration-version metadata, stable user/workspace IDs, acquisition run
IDs/statuses, financial-council run IDs/statuses, model connection
ID/provider/model/credential-version/default state, and a bounded sample of
explicitly allowlisted non-sensitive integrity digests. It also compares
nonreversible aggregate digests derived from complete rows in model credential
versions, provider connections, and agent jobs, so ciphertext identity is
checked without returning ciphertext bytes to the report. Core identity,
acquisition, council, model config, credential-version, provider-connection,
and agent-job tables are mandatory.

The mode-`0600` JSON report is intentionally limited to counts, schema
metadata, explicitly classified non-sensitive IDs, provider/model labels,
credential version numbers, states, allowlisted integrity digests, aggregate
ciphertext-identity digests, and closed pass/fail codes. Password hashes,
idempotency hashes, and arbitrary columns merely ending in `_hash` are
explicitly excluded. The report must not be supplemented with customer rows,
raw ciphertext, or credential material.

Encrypted provider rows remain unusable and operationally unverified without
the original `PROVIDER_CREDENTIAL_KEY` and `AGENT_JOB_ENCRYPTION_KEY`. After
offline verification passes, runtime acceptance must separately prove login,
tenant boundaries, decryption/health of an existing model connection,
acquisition recovery, and financial-council recovery before cutover.

For the current Task 7 target, exact source/target row-count equality is the
restore-boundary gate. After the first backend start, the target has one
additional deterministic `ai_model_connection_activation_events` audit row.
Post-start verification must assert that this is the only count difference,
that every other closed check still passes, and that a second restart does not
add another event. The completed bounded provider-health gate then adds one
immutable `ai_job_model_snapshots` row and one `ai_model_call_records` ledger
row. The current 173-row target is therefore expected after Task 7 runtime
acceptance and must not be forced back to source equality.

## Douyin acquisition schema upgrade

Backend startup also creates the versioned outreach authority tables:
`acquisition_outreach_batches`, `acquisition_outreach_batch_candidates`,
`acquisition_outreach_batch_command_replays`, and
`acquisition_outreach_actions`. Apply this schema with no outreach worker
traffic after the normal encrypted backup. The action table's account/local
date/candidate uniqueness and batch-revision foreign key are approval and
daily-limit authority; do not remove or backfill them from mutable UI state.

Before enabling the MediaCrawler worker against an existing target, take the
normal encrypted backup and let backend schema setup finish with no worker
traffic. The upgrade widens `acquisition_douyin_run_bindings.acquisition_run_id`
and `acquisition_crawler_job_runs.run_id` from 120 to the authoritative
160-character `acquisition_runs.id` boundary. It then:

1. backfills old run-intent and run-now replay JSON with `acquisitionRunId`
   from `acquisition_douyin_run_bindings`;
2. identifies old crawler aliases whose value is an automation intent and
   differs from that intent's bound run, moves them to
   `acquisition_crawler_job_intents`, and inserts the bound authoritative run
   alias;
3. rebuilds the job payload's separate intent/run primary IDs and alias arrays;
4. validates every crawler run alias and installs the authoritative run FK on
   legacy tables that predate it.

The migration never guesses an `AcquisitionRun` from an intent string. An old
intent without an authoritative binding fails with
`acquisition_douyin_run_binding_migration_required:<intentId>`; an invalid
crawler alias fails with
`crawler_job_alias_migration_required:<jobId>:<alias>`. Resolve such a row by
recovering its exact approved-plan binding or quarantining the affected job
under an operator-reviewed migration; do not copy the intent ID into a run
column. Old crawler record JSON that lacks an exact page cursor is likewise
unusable for authoritative evidence and fails closed with
`crawler_record_cursor_migration_required:<jobId>`. A record from the previous
shape that has a page cursor but no discriminator derives the discriminator
only after its exact legacy content hash validates; a changed legacy hash is
rejected.

## Rollback

The source database and source runtime remain untouched and available through
acceptance. Before cutover, rollback is simply abandonment of the isolated
target and continued use of the source. After cutover, route traffic back to
the retained source runtime only under an approved incident plan; this tooling
does not reverse-sync writes from `shensi` to `shensi_sales`.

No command here authorizes deleting either database. A target created for a
failed attempt must be quarantined or removed only by an operator using a
separate, reviewed procedure.

## Retention

Keep the encrypted backup, its manifest, the verification report, the source
database, and the original external encryption keys until cutover acceptance
and the rollback retention window are explicitly closed. Store the passphrase
and encryption keys separately from the ciphertext. Repository ignore rules
cover backups, manifests, verification reports, SQL/dump artifacts, `.env*`,
and provider-key directories; ignore rules are not a backup or access-control
system.

## Incident response

On pipeline, checksum, restore, verification, or runtime-acceptance failure:

1. Stop the target runtime and prevent target traffic.
2. Keep the source runtime/database and encrypted backup unchanged.
3. Record only the emitted failure code, artifact basename, UTC time, and
   operator-safe diagnostics; never copy environment values or rows.
4. Treat a partially restored target as contaminated and do not retry it.
5. If an encryption key may be missing or wrong, halt provider/runtime tests;
   do not rotate a key against migrated ciphertext as a recovery shortcut.
6. Resume only with a new empty target and explicit operator approval.

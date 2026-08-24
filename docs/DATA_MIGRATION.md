# Data Migration

## Current state

This repository contains fail-closed tooling for an encrypted, source-to-new-
target MySQL migration. The tooling has not run a live migration. Running any
command in this document requires operator-supplied credentials and explicit
operational authorization.

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
- A target account for the empty `shensi` database.
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

Optional overrides:

| Variable | Default |
| --- | --- |
| `MYSQLDUMP_BIN` | MySQL 8.4 `mysqldump` path above |
| `MYSQL_BIN` | MySQL 8.4 `mysql` path above |
| `OPENSSL_BIN` | `/usr/bin/openssl` |
| `BACKUP_DIRECTORY` | repository `backups/` |
| `VERIFICATION_REPORT` | timestamped non-secret report under `backups/` |

The ignored `.env.local` and `.env.production.local` files are not loaded by
these wrappers. Environment injection is the operator's explicit boundary.

## Encrypted backup

Run:

```bash
./scripts/backup
```

The command streams a single-transaction `mysqldump` directly into OpenSSL
AES-256-CBC with PBKDF2 and salt. It creates no plaintext dump. The encrypted
file is opened with mode `0600`; an incomplete encrypted file is deleted when
either pipeline stage fails or the process receives `SIGINT`/`SIGTERM`.

The adjacent ignored `*.migration-manifest.json` contains the encrypted-file
SHA-256, source commit, MySQL version, source database name, UTC creation time,
and exact per-table counts. It contains no password, passphrase, full URL,
customer row, encrypted provider value, or provider key.

## Direct restore

Provision an existing empty `shensi` target, select the encrypted artifact by
setting `ENCRYPTED_BACKUP`, then run:

```bash
./scripts/restore
```

The command rejects a target other than `shensi`, equal source/target database
names, and a non-empty target. It streams OpenSSL decryption directly into the
MySQL client. A wrong passphrase, corrupt ciphertext, either child failure, or
a signal fails the command. If a restore fails after MySQL has begun reading,
do not retry into that database: isolate it, provision a new empty `shensi`
target under incident control, and start again from the retained ciphertext.
Never drop or clean the source database.

## Orchestrated migration

After a reviewed preflight and operator authorization, run:

```bash
./scripts/migrate-data
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

Verification compares the complete table set and exact row counts, column and
schema/migration-version metadata, stable user/workspace IDs, acquisition run
IDs/statuses, financial-council run IDs/statuses, model connection
ID/provider/model/credential-version/default state, and a bounded sample of
stored integrity hashes. Core identity, acquisition, council, model config,
and credential-version tables are mandatory.

The mode-`0600` JSON report is intentionally limited to counts, schema
metadata, explicitly classified non-sensitive IDs, provider/model labels,
credential version numbers, states, hashes, and closed pass/fail codes. It
must not be supplemented with customer rows or credential material.

Encrypted provider rows remain unusable and operationally unverified without
the original `PROVIDER_CREDENTIAL_KEY` and `AGENT_JOB_ENCRYPTION_KEY`. After
offline verification passes, runtime acceptance must separately prove login,
tenant boundaries, decryption/health of an existing model connection,
acquisition recovery, and financial-council recovery before cutover.

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

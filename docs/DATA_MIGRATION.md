# Data Migration

## Current state

Canonical live-data migration tooling is not yet present. The existing
`pnpm setup:mysql:local` command provisions a local application account and
database named `shensi_sales`; backend startup then creates or upgrades tables
through `mysql-store.ts` and module repository DDL. This is local setup, not a
source-to-target migration.

The Baota installer can bootstrap an empty database and has explicit
`REUSE_EXISTING_DATABASE` and destructive `REPLACE_DATABASE` modes. It is not
the planned Shensi migration path. Never use `REPLACE_DATABASE=true` against a
source or live database.

## Non-negotiable safety rules

- Treat the current source database as read-only and keep it available for
  rollback.
- Restore into a distinct target database. Reject equal source and target
  hosts/database names before any write.
- Keep dumps, manifests, passphrases, customer rows, and `.env*` files ignored
  by Git. Do not print their contents in commands, logs, reports, or chat.
- Preserve the external encryption keys used by provider credentials and agent
  jobs. Copying encrypted columns without the matching keys is not a verified
  migration.
- Do not cut over merely because row counts match. Authentication, tenant
  boundaries, encrypted model connections, workers, and financial-council
  recovery must also be exercised against the target.

## Schema sources

Migration review must include:

- `backend/src/mysql-store.ts` for core CRM, identity, provider, job, and
  startup migration DDL;
- `backend/schema.mysql.sql` for the tracked baseline schema;
- repository-local DDL in acquisition, catalog, quote, finance, ROI, advisor,
  financial-statement, and financial-council MySQL repositories;
- the two editable OpenAPI contracts for public shape, not database shape.

`backend/goodjob_crm.full.sql` is a historical full SQL artifact and must not
be assumed to contain every current module table. Raw SQL dumps are ignored by
the repository.

## Required migration sequence

The later migration task must implement and verify this fail-closed sequence:

1. Validate source and target identities and prove they differ.
2. Take a consistent encrypted backup plus a checksum/manifest without
   exposing row data.
3. Create or migrate the empty target schema with the canonical runtime.
4. Restore all tables and preserve encrypted credential bytes unchanged.
5. Compare schema inventory, table counts, selected aggregate invariants, and
   audit/event continuity without logging customer data.
6. Start the target runtime in isolation and verify login, permission scopes,
   model-connection decryption/health, acquisition recovery, and council
   recovery.
7. Keep the source runtime and backup untouched until explicit cutover and
   rollback approval.

No step in this document authorizes access to live credentials or a live
database. Those actions require an operator-supplied environment and the later
task's explicit approval boundary.

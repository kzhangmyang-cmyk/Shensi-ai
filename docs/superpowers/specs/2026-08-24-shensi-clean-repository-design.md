# Shensi Clean Repository Design

## Status

Approved in conversation on 2026-08-24. This document defines the creation of
`/Users/mac/Documents/新项目/shensi` as the single current development and
deployment repository. Implementation must not delete or mutate the legacy
`/Users/mac/Documents/新项目/shensi-sales` repository until migration and
rollback verification have passed.

## Problem

The existing `shensi-sales` directory contains two materially different code
lines:

- `main@c0d19cb` is an older surface and can still launch the obsolete login
  experience.
- `codex/real-financial-council@86c69e6` contains the current frontend,
  backend, contracts, real MySQL integration, DeepSeek connection support,
  financial council, and automatic-acquisition entry flow.

The split causes people and coding agents to open the wrong frontend, run the
wrong backend, and treat archived plans as current state. Deployment knowledge
and live-data migration are also distributed across historical task reports.

## Goals

1. Create a standalone Git repository at
   `/Users/mac/Documents/新项目/shensi` from the current code line at
   `86c69e6` or its verified descendant.
2. Preserve the stable top-level boundaries `frontend/`, `backend/`, and
   `contracts/`.
3. Replace the obsolete login surface with a new dark enterprise login that
   belongs to the current card-based application shell.
4. Migrate all current MySQL business data, identities, audit history, model
   configuration, and encrypted model credentials.
5. Provide local-development and Docker Compose production deployment paths.
6. Make the repository understandable to a new coding agent without requiring
   access to prior conversations.
7. Keep the legacy repository and database recoverable until the new runtime
   passes verification.

## Non-goals

- The migration does not redesign the financial council, acquisition engine,
  CRM domain, or public API contracts.
- The migration does not commit raw database dumps, customer data, API keys,
  session secrets, or encryption keys to Git.
- The migration does not delete the old repository, old database, or old
  runtime processes before cutover approval.
- The migration does not make generic web search mandatory for Douyin. The
  acquisition source boundary must permit a future official Douyin OpenAPI
  connector, with generic public search and manual links as fallbacks.
- The migration does not select a cloud vendor. Docker Compose must run on a
  normal Linux host and Docker Desktop without cloud-specific services.

## Source of Truth and Repository History

The import source is the clean working tree of
`codex/real-financial-council@86c69e6` plus only changes explicitly committed
after that point and verified as current. The implementation must record the
exact source commit in `docs/SOURCE_PROVENANCE.md` before copying code.

The new repository keeps useful Git history by cloning the current branch into
the new directory and making that branch the new `main`. The old GitHub remote
is renamed to `legacy-origin`; no push to a new GitHub repository occurs until
the user explicitly authorizes the target remote. Worktree metadata and the
old branch checkout are not copied as runtime artifacts.

The new repository is the only default reading and execution path after
cutover. The legacy repository remains a rollback source and must have an
explicit `LEGACY_READ_ONLY.md` marker added only after successful cutover.

## Repository Layout

```text
shensi/
├── frontend/                    # Current card-based browser application
├── backend/                     # HTTP API, domain services, workers, MySQL
├── contracts/                   # Versioned frontend/backend API contracts
├── deploy/
│   ├── compose.yaml             # Production topology
│   ├── docker/
│   │   ├── backend.Dockerfile
│   │   └── frontend.Dockerfile
│   └── nginx/
│       └── default.conf         # Static frontend and /api reverse proxy
├── scripts/
│   ├── dev                      # Local development entry point
│   ├── deploy                   # Validated Compose deployment
│   ├── backup                   # Consistent encrypted database backup
│   ├── restore                  # Explicit restore into a selected database
│   ├── migrate-data             # Source-to-target migration orchestration
│   ├── verify                   # Build, health, data, and secret gates
│   └── context-check            # Agent documentation/current-state gate
├── backups/                     # Git-ignored encrypted migration artifacts
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PROJECT_STATUS.md
│   ├── SOURCE_PROVENANCE.md
│   ├── DATA_MIGRATION.md
│   ├── DEPLOYMENT.md
│   ├── API_INDEX.md
│   ├── modules/
│   │   ├── acquisition.md
│   │   ├── crm.md
│   │   ├── financial-council.md
│   │   ├── model-connections.md
│   │   └── identity-and-permissions.md
│   └── archive/                 # Historical plans, clearly non-current
├── AGENTS.md
├── README.md
├── .env.example
└── .gitignore
```

Top-level source paths remain unchanged to preserve existing workspace scripts,
TypeScript references, tests, and contract generation.

## Login and Application Shell

The new login is part of the same dark visual system as the authenticated
card-based application. It must not render or briefly flash the old white CRM
shell.

The login contains:

- Shensi product identity and a concise description of the automation system.
- Account and password fields with correct labels and autocomplete metadata.
- Visible loading, invalid-credential, network-error, and retry states.
- Session restoration without showing an authenticated shell before identity
  validation finishes.
- Keyboard navigation, visible focus, responsive layouts at 390, 1024, 1366,
  and 1440 pixel widths, and no horizontal overflow.

Authentication remains server-authoritative. The frontend may not invent a
demo identity in real mode, store passwords, expose raw server errors, or
bypass CSRF/session handling. Logout destroys private controllers and returns
to the new login without leaving customer or model data in the DOM.

## Runtime and Deployment Architecture

### Local development

`./scripts/dev` validates prerequisites, loads `.env.local`, starts the backend
and frontend, and prints the exact origins. Vite proxies `/api` to the selected
backend. The script must reject occupied ports instead of silently starting a
different application.

### Production

`./scripts/deploy` validates `.env.production.local`, runs Compose validation,
builds immutable images, applies idempotent database schema initialization,
starts services, and runs health checks before reporting success.

The Compose topology contains:

- `mysql`: persistent MySQL 8.4 data volume and internal-only network access.
- `backend`: Node production build, non-root runtime user, health check, and no
  source bind mounts.
- `frontend`: multi-stage static build.
- `nginx`: public entry point, frontend static files, `/api` reverse proxy,
  security headers, request-size limits, and health endpoint.

Runtime secrets enter containers through environment or secret files and are
never baked into images. Backend and frontend images use multi-stage builds;
the Node process receives termination signals directly and does not run as
root.

## Data Migration

### Scope

The migration includes all tables in the current `shensi_sales` database,
including:

- accounts, workspaces, teams, roles, sessions, and audit events;
- customers, candidates, evidence, acquisition plans, runs, and CRM records;
- financial statements, cash forecasts, council runs, specialist results,
  policies, approvals, dispatches, and receipts;
- model provider connections, certifications, routing policies, durable model
  snapshots, and encrypted credentials;
- schema/migration metadata required to reopen the data safely.

### Backup and encryption

The backup command uses the installed MySQL 8.4 `mysqldump` with
`--single-transaction`, `--routines`, `--triggers`, and explicit UTF-8 settings.
The dump streams directly through `openssl enc -aes-256-cbc -pbkdf2 -salt` into
`backups/*.sql.enc`; no plaintext dump is written to disk. The passphrase is
read from `SHENSI_BACKUP_PASSPHRASE` in a Git-ignored environment file, not a
command-line argument.

Each backup has a non-secret manifest containing the creation time, source
database name, source commit, MySQL version, encrypted-file SHA-256, and table
counts. The manifest contains no row data or credentials.

### Restore and validation

Restore targets a new database name first. It never overwrites the source
database. After restore, the verifier compares:

- table names and migration versions;
- per-table row counts;
- workspace/account identities;
- counts and stable IDs for acquisition runs and financial council runs;
- model connection IDs, provider/model names, credential versions, and active
  default selection without decrypting or printing secrets;
- representative integrity hashes and terminal workflow states.

The target backend then runs against the restored database and must pass login,
health, acquisition, financial council, and model-connection smoke tests. The
DeepSeek connection must be loaded from the restored encrypted record and make
one bounded test request without logging the credential.

### Encryption-key handling

Encrypted provider credentials are only portable with their existing
credential-encryption key material. That key is copied into
`.env.production.local` with mode `0600`, never into Git. Migration stops before
cutover if the target cannot decrypt the stored DeepSeek credential.

### Rollback

The old runtime and source database remain unchanged during verification.
Cutover changes only the frontend/backend ports or reverse-proxy target. If any
post-cutover check fails, traffic returns to the old runtime and the new target
database is retained for diagnosis rather than deleted.

## AI Handoff Documentation

The repository root `AGENTS.md` is the mandatory entry point for coding agents.
It defines:

- the required reading order;
- current source-of-truth documents;
- module boundaries and prohibited cross-boundary shortcuts;
- exact install, test, build, deployment, and data-safety commands;
- secret-handling and destructive-operation rules;
- documentation synchronization requirements;
- the rule that `docs/archive/` is historical context, not current authority.

`docs/PROJECT_STATUS.md` is the sole current progress ledger. It contains four
closed sections: completed, active, blocked, and next. Each entry has an owner
boundary, evidence command, and relevant file links. It is rewritten to current
truth rather than accumulating correction notes.

`docs/ARCHITECTURE.md` explains runtime components and data flow. Each file in
`docs/modules/` uses the same template: responsibility, entry points,
dependencies, database tables, public interfaces, tests, operational checks,
and known limitations.

`scripts/context-check` fails when mandatory documents are missing, current
contract/release versions disagree, documented commands do not exist, or
`PROJECT_STATUS.md` still references the legacy repository as the execution
root.

## Error Handling and Safety

- All scripts use strict shell mode, resolve the repository root explicitly,
  validate target paths, and reject broad or unresolved deletion targets.
- Migration commands print identifiers and counts, never passwords, tokens,
  connection URLs, raw customer rows, or decrypted model credentials.
- Deployment does not report success until container health and application
  checks pass.
- Backup/restore commands require explicit source and target database names and
  reject identical names.
- Port conflicts fail closed with the owning PID and expected remediation.
- The production frontend cannot fall back to demo or memory data when the
  backend is unavailable.

## Testing and Acceptance Gates

Implementation is complete only when all applicable gates pass from the new
directory:

1. Backend tests, TypeScript build, and contract checks.
2. Frontend self-tests, TypeScript checks, production build, and focused login
   browser tests.
3. Docker Compose configuration validation and image builds.
4. New login tested at 390, 1024, 1366, and 1440 pixel widths with keyboard
   navigation and no legacy shell.
5. Encrypted backup creation and restore into a new database.
6. Migration row-count and stable-identity comparison.
7. Real login/session smoke test against the restored database.
8. Restored DeepSeek connection decrypts and completes one bounded model call.
9. `scripts/context-check` passes from a clean checkout.
10. Git secret scan confirms no dump, `.env.local`, `.env.production.local`,
    customer raw data, API key, or credential key is tracked.
11. `git diff --check` and a clean worktree after the migration commit.

## Documentation Lifecycle

Current entry documents are `README.md`, `AGENTS.md`, and the files directly
under `docs/`. Historical specs and plans move to `docs/archive/` only when they
are no longer executable truth. Archived documents keep their history but gain
a clear header pointing to `docs/PROJECT_STATUS.md`.

Any change to behavior, contracts, data structures, deployment, module
responsibility, or user interaction must update the relevant current document
in the same change. Internal refactors that do not affect these surfaces may
state that no documentation update is required.

## Cutover Sequence

1. Verify the source branch and clean working tree.
2. Create the standalone `shensi` repository and record provenance.
3. Add deployment, migration, and agent-context infrastructure.
4. Replace and test the login surface.
5. Run source test/build gates.
6. Produce an encrypted database backup.
7. Restore into a new target database and run data verification.
8. Start the new stack on non-conflicting ports.
9. Run browser, API, model, and migration acceptance gates.
10. Switch the user-facing origin to the new stack.
11. Mark the legacy repository read-only only after user acceptance.

## Success Criteria

- Opening the documented origin always shows the new Shensi login and current
  card application, never the old CRM login or a second shell.
- A new developer or coding agent can identify the architecture, current
  status, commands, and next task by following the documented reading order.
- Local development and production deployment each have one canonical command.
- Current business data and encrypted DeepSeek configuration are present and
  verified in the target database.
- The legacy repository and database remain recoverable, while all future work
  begins in `/Users/mac/Documents/新项目/shensi`.

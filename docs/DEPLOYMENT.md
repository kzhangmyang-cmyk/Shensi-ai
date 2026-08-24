# Deployment

## Current supported entry points

Local development uses root package scripts:

```bash
pnpm --filter ./backend dev
pnpm --filter ./backend dev:mysql
pnpm --filter ./frontend dev
pnpm setup:mysql:local
pnpm dev:real
```

`pnpm dev:real` validates `.env.real.local`, starts the MySQL-backed API at
`127.0.0.1:4188`, and starts Vite at `127.0.0.1:5188`. The setup script is
hard-coded to MySQL on `127.0.0.1:3307`, database `shensi_sales`, and the
least-privilege `shensi_sales_app` account.

`deploy/baota/` contains the existing Linux/Baota package builder, installer,
Nginx/systemd integration, configuration example, and service manager. The
backend is bound to localhost and health is checked at `/api/health`. Upgrade
mode must use `REUSE_EXISTING_DATABASE=true`; `REPLACE_DATABASE=true` is a
destructive reset that backs up and clears the selected database.

## Not yet available

There is no checked-in Docker Compose topology, Dockerfile set, canonical
`scripts/deploy` wrapper, or production `.env` validator in the current tree.
Do not describe the repository as Compose-deployable until those files and
their tests exist. The Baota package builder also expects an external ignored
`deploy/baota/database/bootstrap.sql.gz` and checksum when producing a real
installation archive.

## Configuration and secrets

Use `.env.example` only to discover variable names. Real local and production
values belong in ignored files or the deployment secret store. At minimum,
production must provide strong, distinct session, credential-encryption, job,
cursor, claim, and domain master secrets. Production must set
`CRM_STORE=mysql`; memory/demo fallback is not acceptable.

Never bake credentials or database contents into frontend assets, images,
archives, tracked Compose files, or CI logs. Preserve encryption keys during
an upgrade or data migration.

## Verification

Repository-wide deployment-affecting changes require:

```bash
./scripts/context-check
pnpm test
pnpm build
pnpm test:baota-package
git diff --check
```

MySQL, Chromium, and live-provider checks additionally require their documented
local environment. The GitHub quality workflow provisions MySQL 8.4 and Chrome
for the aggregate test, build, council, and browser suites. A local memory test
does not prove a MySQL migration or live-provider deployment.

For the existing Baota service, use `deploy/baota/manage-service.sh status`,
`health`, and controlled logs after installation. Do not run destructive
installer modes as a verification shortcut.

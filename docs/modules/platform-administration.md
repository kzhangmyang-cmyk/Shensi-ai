# Platform Administration

The independent `/admin.html` entry manages enterprise customers, accounts,
versioned trial/basic/pro plans and an operations log. Its API is
`/api/platform/v1`; transport types are generated from
`contracts/openapi/platform-admin.v1.yaml`. No real operator, customer grants
or deployment are provisioned by the implementation tests.

`frontend/admin.html` is a required desktop source-manifest input because the
shared Vite configuration builds it in desktop mode too. Its content changes
the desktop source identity; it is not excluded as a development-only preview.

## Identity and commands

Customer roles do not confer platform authority. Separate membership and TOTP
establish a 15-minute HttpOnly session, bound to customer authVersion and
platform sessionVersion. Cookie writes retain CSRF validation. Persisted OTP
counters prevent reuse; failed persistence does not consume a proof. Exiting
revokes all platform sessions for that operator. Bootstrap is offline only;
legacy `super_admin` identities cannot be used as platform operators.

Commands use the existing serialized persistence queue, require the current
aggregate revision and an operation reason, and commit users and platform state
in one MySQL transaction. Stale writes return 409. Failed writes restore memory
and database authority; concurrent requests reject provisional changes until
commit/rollback. This is optimistic concurrency, not idempotent response replay:
refresh after an uncertain network result before retrying. Audit records contain
actor, action, target, reason, time and revision, never passwords or MFA secrets.

Legacy create/password/disable/enable/revoke commands also use transactional
rollback and `account_administration_audit`. Decoded account IDs and normalized
workspace IDs are checked. Managed accounts and platform identities cannot be
changed through legacy account routes. Global super-admin writes are denied
after platform initialization; legacy global business-read privileges are not
automatically removed or migrated.

## Enterprise and packages

Creating an enterprise creates its primary customer admin and pending workspace
atomically. After owner bootstrap, public registration also creates pending
workspaces. Existing unmanaged workspaces preserve permissions and are not
silently imported into the console.

The three initial plans are unpublished drafts with no features, seats or days.
Publishing requires explicit values; each edit adds an immutable version without
changing existing grants. Activation requires a published plan, explicit dates
and sufficient seats. Saved enterprise dates govern authorization; plan days are
reference metadata, not an enforced maximum or automatic grant. Pricing/payments/usage quotas
are not implemented.

Pending/suspended workspaces cannot access business APIs. Expired active
workspaces retain reads within their plan but cannot execute new work. Business
roles, ownership and external-action approval remain required. Enterprise
changes and account disable/restore/revoke increment authVersion; restoration
does not revive old sessions.

Fresh execution checks cover model provider attempts/custom transports,
prospect claims/dispatch, server/desktop crawler claims and social outreach
claims/start. Workers read durable authority. Denied queued work stays retained.
Already transmitted requests cannot be recalled: terminal crawler results and
authenticated outreach receipts/reconciliation retain their scoped routes.
Subscription changes do not authorize automatic retries.

## Storage and operations

`platform_administration_state` stores the revision, memberships, encrypted MFA
secrets, plan versions, workspaces and audit as one JSON aggregate. Only the API
writes this aggregate; workers read it fresh. Single API instance locking and
snapshot persistence remain required. Enterprise/account/audit responses have
50-entry pagination; aggregate size and all-plan responses limit scale.

See [deployment](../DEPLOYMENT.md#platform-operator-bootstrap) and
[migration](../DATA_MIGRATION.md#platform-administration-migration). Current
progress and verification results live only in `../PROJECT_STATUS.md`.

## Remaining release work

This increment supports primary-account creation, grants, suspension/restoration
and session revocation. Existing-workspace onboarding, secondary account
creation, one-time customer password recovery, operator management/MFA recovery,
audit before/after details and filtered export remain unfinished. Recovery and
administration flows must be completed before paid-production release.

## Verification

- `pnpm --dir backend test:accounts`: synthetic rollback, MFA, HTTP lifecycle,
  legacy bypass and fresh execution authority tests.
- Root `pnpm test`, `pnpm build`, `pnpm typecheck:desktop` and context/diff gates.
- `backend/src/platform-admin-mysql-acceptance.ts`: opt-in isolated Docker MySQL
  restart, audit-write rollback and encrypted backup-to-distinct-target restore.
  Requires `SHENSI_ADMIN_SYNTHETIC_ACCEPTANCE=1` and explicit `DOCKER_HOST`.
  Creates/removes only its labeled temporary container/volume and private
  encrypted backup. It does not use an existing source database URL.

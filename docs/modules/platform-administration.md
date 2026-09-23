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

Public registration commits the new user, pending workspace and
`register_enterprise` audit in one serialized transaction. Deployment may require
an initialized active platform owner with `SHENSI_REQUIRE_PLATFORM_OWNER=true`;
until one exists, registration returns 503. The default remains compatible
with existing unmanaged development environments. Public registration never
grants an automatic trial. Login/register/me expose a safe `CustomerAccess`
summary for the customer's own workspace; operator grant changes still require
the customer to log in again because existing sessions are revoked.

Operators create `manager` and `sales` members through `POST /api/platform/v1/accounts`.
Pending enterprises may prepare members before choosing a package; activation
checks all active seats. When a published plan is attached, member creation and
restoration enforce its seat limit. Account names are normalized and globally
unique. Membership creation, user persistence and audit commit together.

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
The overview `q` query searches audit actor, action, target and reason as well
as enterprise/account lists.

## Recovery

An MFA-authenticated operator issues a customer reset using
`POST /api/platform/v1/accounts/:id/password-reset`. The 256-bit random token
is returned once, expires after 15 minutes, and only its SHA-256 hash is stored.
Issuance revokes existing sessions and replaces earlier tokens. Anonymous
`POST /api/auth/reset-password` consumes the token once and changes the password
transactionally with another session revocation and audit. Failure rolls back
both credential and consumption; disabled accounts stay disabled. Neither logs
nor audit contain plaintext tokens/passwords. Both HTTP paths require the
normal transport/CSRF protections and reset consumption is rate limited.

Lost operator MFA uses only the offline `backend/src/platform-admin-recover-mfa.ts`
CLI under production settings, with the same exclusive API database lock as
bootstrap. Set `SHENSI_PLATFORM_RECOVERY_CONFIRM_DATABASE` to the exact target
database, `SHENSI_PLATFORM_RECOVERY_USER_ID`, a privately supplied new base32
`SHENSI_PLATFORM_RECOVERY_TOTP_SECRET`, and `SHENSI_PLATFORM_RECOVERY_REASON`.
The stable encryption key is required. The operation replaces the encrypted
seed, resets its counter, revokes customer and operator sessions, and audits
the recovery. There is no public operator-recovery endpoint. Coordinate the
API maintenance window and deliver the new seed privately; never commit it.

See [deployment](../DEPLOYMENT.md#platform-operator-bootstrap) and
[migration](../DATA_MIGRATION.md#platform-administration-migration). Current
progress and verification results live only in `../PROJECT_STATUS.md`.

## Remaining release work

This increment supports enterprise/member creation, grants, suspension/restoration,
session revocation, one-time customer recovery, offline operator MFA recovery
and audit search. Existing-workspace onboarding, operator membership management,
audit before/after details and filtered export remain unfinished.

## Verification

- [Isolated admin development](../DEPLOYMENT.md#isolated-admin-development)
  provides a persistent synthetic-only MySQL runtime and actual browser
  enterprise/member/grant/customer-write/expiry/renewal/recovery acceptance.
- `pnpm --dir backend test:accounts`: synthetic rollback, MFA, HTTP lifecycle,
  legacy bypass and fresh execution authority tests.
- Root `pnpm test`, `pnpm build`, `pnpm typecheck:desktop` and context/diff gates.
- `backend/src/platform-admin-mysql-acceptance.ts`: opt-in isolated Docker MySQL
  restart, audit-write rollback and encrypted backup-to-distinct-target restore.
  Requires `SHENSI_ADMIN_SYNTHETIC_ACCEPTANCE=1` and explicit `DOCKER_HOST`.
  Creates/removes only its labeled temporary container/volume and private
  encrypted backup. It does not use an existing source database URL.

# Identity and Permissions

## Responsibility

Registers isolated tenant administrators, authenticates users, issues and
destroys sessions, enforces CSRF and role/team visibility, administers accounts,
derives Growth workspace capabilities, and prevents cross-tenant access to CRM,
acquisition, model, and finance data.

## Entry Points

- Security primitives and guards: `backend/src/auth.ts`.
- Session/profile/account routes and middleware: `backend/src/server.ts`.
- Growth capability mapping: `backend/src/growth-capabilities.ts` and
  `backend/src/growth-workspace-context.ts`.
- Frontend session lifecycle: `frontend/src/app-session.ts`; application boot
  begins in `frontend/src/app-entry.ts`.
- Frontend login markup and styling: `frontend/index.html` and
  `frontend/src/app-shell.css`.

## Dependencies

The `users` and workspace/team state in `CrmStore`, password hashing, JWT and
session/CSRF cookies, role hierarchy and visibility helpers, CORS/secure-cookie
configuration, idempotent command context, and each module's capability
registry.

## Database Tables

`users` is the primary identity table. Domain authorization also depends on
team/owner columns throughout CRM tables, Growth workspace settings and
temporal barriers, organization identity/coverage guards, model connection
scope columns, and immutable audit/event tables. `mysql-store.ts` is the core
startup authority; module repositories own additional capability/workspace
DDL.

## Public Interfaces

`POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`,
`GET /api/auth/me`, `GET/PATCH /api/profile`, and `/api/accounts`
administration are registered in `backend/src/server.ts`. Registration accepts
only `{ account, password }`: the account is trimmed, lowercased, 3–32
characters, starts with a letter or digit, and otherwise contains only letters,
digits, `_`, or `-`; the password is 8–128 characters. A normalized duplicate
returns `409`, and the public route is limited to five attempts per observed
client IP per hour. A successful `201` response persists an active `admin` with
a new workspace ID and returns the same session user, JWT, and CSRF token shape
as login. It does not seed or copy another tenant's credentials, social login,
candidates, tasks, CRM, Growth, finance, approval, comment, or private-message
data. Protected Growth and acquisition routes apply authentication and
active-workspace middleware before their routers. Browser writes send the CSRF
cookie value in `X-CSRF-Token`.

The current unauthenticated entry is the dark Shensi account form. It has login
and registration modes, starts with empty account/password fields, and uses one
semantic submit form. Login accepts a valid bare account or an email. During an
authentication request the form publishes `aria-busy`, disables submission and
mode switching, and restores controls only for the current authentication
generation. Registration success enters the newly created workspace without a
second login. All modules remain visible there, while empty domain collections
render as empty states. The frontend keeps `gj_user` only as a local session
hint; real-mode startup must validate it through `GET /api/auth/me` before
exposing the authenticated shell. Session and CSRF authority remain the
server-issued `gj_session` and `gj_csrf` cookies. Demo mode does not expose or
call public registration.

## Tests

- Registration, login, visibility, role, account, and CRM boundaries:
  `pnpm --filter ./backend test`
- Security-focused gate: `pnpm --filter ./backend test:security`
- Growth capability/workspace tests:
  `pnpm --filter ./backend test:growth-foundation`
- Frontend session state: `pnpm --filter ./frontend test`
- Shensi login and affected browser flows:
  `pnpm --filter ./frontend exec playwright test shensi-login.spec.ts agent-center-shell.spec.ts demo-auth.spec.ts --project=chromium`
- Frontend types and production build:
  `pnpm --filter ./frontend run test:types` and
  `pnpm --filter ./frontend build`

## Operational Checks

Production requires strong `JWT_SECRET`, secure cookies behind HTTPS, explicit
CORS origins, MySQL persistence, and no development seed credentials. The
Shensi form must remain empty in deployed HTML. Verify registration success,
normalized duplicate `409`, invalid-input rejection, per-IP registration
limiting, immediate session restoration, and an empty isolated workspace before
login/logout, disabled-account rejection, sales/manager/admin visibility, CSRF
failure behavior, and workspace capability checks after identity or proxy
changes.

## Platform operations and limitations

The [platform administration module](platform-administration.md) adds independent
operator membership/MFA, configurable trial/basic/pro grants, workspace expiry,
transactional account changes and audit. Once an owner is initialized, new
registrations enter pending workspaces and require an explicit grant. Existing
unmanaged customers preserve their prior permissions; the empty-workspace
registration description above applies before platform initialization.

Legacy `super_admin` business visibility remains broad and is not a
least-privilege operations role. Platform bootstrap refuses that role; legacy
global account writes are denied after initialization. Customer password and
operator MFA recovery, secondary-account creation and onboarding existing
workspaces remain release work.

Memory mode does not provide durable production identities. Swagger
availability does not bypass authentication/authorization, and frontend
hiding is never a permission boundary.

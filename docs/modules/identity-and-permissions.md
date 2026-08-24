# Identity and Permissions

## Responsibility

Authenticates users, issues and destroys sessions, enforces CSRF and role/team
visibility, administers accounts, derives Growth workspace capabilities, and
prevents cross-tenant access to CRM, acquisition, model, and finance data.

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

`POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`,
`GET/PATCH /api/profile`, and `/api/accounts` administration are registered in
`backend/src/server.ts`. Protected Growth and acquisition routes apply
authentication and active-workspace middleware before their routers. Browser
writes send the CSRF cookie value in `X-CSRF-Token`.

The current unauthenticated entry is the dark Shensi enterprise login. Its
email and password fields are empty by default and use a semantic submit form.
While login is pending, the form publishes `aria-busy`, disables the submit
button, and restores controls only for the current authentication generation.
The frontend keeps `gj_user` only as a local session hint; real-mode startup
must validate it through `GET /api/auth/me` before exposing the authenticated
shell. Session and CSRF authority remain the server-issued `gj_session` and
`gj_csrf` cookies.

## Tests

- Login, visibility, role, account, and CRM boundaries:
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
Shensi form must remain empty in deployed HTML. Verify login/logout/session
restoration, disabled-account rejection, sales/manager/admin visibility, CSRF
failure behavior, and workspace capability checks after identity or proxy
changes.

## Known Limitations

Memory mode does not provide durable production identities. Swagger
availability does not bypass authentication/authorization, and frontend
hiding is never a permission boundary.

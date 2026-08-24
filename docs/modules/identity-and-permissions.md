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

## Tests

- Login, visibility, role, account, and CRM boundaries:
  `pnpm --filter ./backend test`
- Security-focused gate: `pnpm --filter ./backend test:security`
- Growth capability/workspace tests:
  `pnpm --filter ./backend test:growth-foundation`
- Frontend session state: `pnpm --filter ./frontend test`

## Operational Checks

Production requires strong `JWT_SECRET`, secure cookies behind HTTPS, explicit
CORS origins, MySQL persistence, and no development seed credentials. Verify
login/logout/session restoration, disabled-account rejection, sales/manager/
admin visibility, CSRF failure behavior, and workspace capability checks after
identity or proxy changes.

## Known Limitations

The current frontend login is an obsolete surface scheduled for replacement;
backend authentication remains authoritative during that work. Memory mode
does not provide durable production identities. Swagger availability does not
bypass authentication/authorization, and frontend hiding is never a permission
boundary.

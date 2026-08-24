# Task 2 report — QR login and workspace-scoped Douyin accounts

## Implementation

- Added a private MediaCrawler account manager and browser-state boundary. QR
  sessions use random opaque identifiers, service-owned profile directories
  (`0700`), expiry cleanup, and only pass a QR data URL / safe state onward.
- Extended the internal gateway with strict create/poll login-session parsing.
- Added workspace-scoped account domain, in-memory and MySQL repositories,
  account service, and four-route Express router. The public DTO strips the
  private opaque account handle and rejects cookie/profile/browser/secret
  fields.
- Mounted the router from the acquisition application when its trusted
  MediaCrawler gateway is configured; server-level acquisition authentication
  supplies the CSRF protection for mutation routes.
- Added both schema snapshots, editable OpenAPI paths, runtime OpenAPI paths,
  route inventory assertions, response conformance coverage, regenerated
  frontend types, and the MediaCrawler boundary documentation.

## TDD evidence

RED (before implementation):

```text
pytest: ModuleNotFoundError: No module named 'shensi_adapter.accounts'
node: ERR_MODULE_NOT_FOUND acquisition-social-account-repository.js
node: ERR_MODULE_NOT_FOUND acquisition-social-account-router.js
```

GREEN:

```text
uv run --directory services/media-crawler pytest tests/shensi_adapter/test_accounts.py -q
1 passed

pnpm --dir backend exec tsx --test --test-concurrency=1 \
  src/acquisition-social-account-test.ts \
  src/acquisition-social-account-mysql-repository-test.ts \
  src/acquisition-social-account-router-test.ts
4 passed
```

## Verification

- `pnpm --filter ./contracts test`: 91 passed.
- `pnpm check:acquisition-contracts`: completed successfully, including
  contract drift, security, acquisition OpenAPI, generated types, frontend
  build/tests, and Baota package checks.
- `pnpm --dir backend run build`: passed.
- `git diff --check`: passed.
- `pnpm --dir backend run test:acquisition` started once but hung in the
  existing serial `acquisition-application-test.ts` process after its emitted
  application tests; it was terminated after roughly 160 seconds. Focused,
  contract, build, and package gates passed independently.

## Self-review

- Public account/login schemas are closed and do not contain `accountHandle`,
  cookies, profile/browser paths, service URL, or secrets.
- Every account repository lookup/bind/disconnect is workspace-bound; one
  `(workspace_id, platform)` record is enforced in the MySQL DDL.
- Polling an active internal session atomically reuses/replaces the workspace
  record and exact active-session replay returns the sanitized existing view.
- Immutable Growth releases and unrelated lockfiles were not touched.

## Concerns

The real browser adapter remains an injected private deployment seam; this is
intentional because the pinned upstream login implementation is asynchronous
and licensed separately. Operators must provide the encrypted deployment
volume and the browser adapter implementation at deployment time.

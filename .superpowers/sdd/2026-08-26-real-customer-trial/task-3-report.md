# Task 3 report

## RED evidence

- `node --test scripts/real-trial-config.test.mjs scripts/real-trial-runtime.test.mjs` initially failed with `ERR_MODULE_NOT_FOUND` for both absent modules.
- The gateway fixture initially returned `200` for `/internal/v1/health`; the new isolation assertion failed with `200 !== 404`.
- The identity-separation regression initially showed the customer fixture password persisted as `mysql_app_password`.
- The production-security-key regression initially failed because `SHENSI_MYSQL_APP_PASSWORD` and the deployment cursor/master keys were absent from the generated environment.

## GREEN evidence

- `node --test scripts/real-trial-config.test.mjs scripts/real-trial-runtime.test.mjs scripts/real-trial-gateway.test.mjs` passed: 4/4.
- `node --test tools/runtime-scripts.test.mjs tools/runtime-scripts-round1.test.mjs` passed: 19/19.
- `pnpm --filter ./backend build` and `git diff --check` passed.

## Files

- `.gitignore`, `package.json`
- `scripts/real-trial-config.mjs`, `scripts/real-trial-config.test.mjs`
- `scripts/real-trial-gateway.mjs`, `scripts/real-trial-gateway.test.mjs`
- `scripts/real-trial-runtime.mjs`, `scripts/real-trial-runtime.test.mjs`
- `scripts/real-trial-verify.mjs`
- `backend/scripts/setup-trial-mysql.ts`

## Commit

Final Task 3 commit: `HEAD` (resolved SHA in handoff).

## Self-review

- Configuration uses fixed loopback ports, 0700 runtime state, 0600 files, distinct generated production keys, and separate customer/DB password files; mismatched repeat customer input fails closed.
- The gateway only forwards `/api`, owns `/healthz`, and rejects internal/docs/openapi/runtime/dotfile/source paths.
- The supervisor is dependency-injected for fixture testing, obtains its Quick Tunnel origin before backend creation, passes it to CORS, records children, and stops only validated records.
- No public tunnel or real customer password was started or used.

## Lifecycle hardening fix

### RED evidence

- The new config regression first accepted an explicit relative runtime root and
  could follow a symlinked private directory.
- The new lifecycle regression initially failed because persisted PID records,
  exact `ps` validation, and symlink rejection were not implemented.

### GREEN evidence

- `node --test scripts/real-trial-config.test.mjs scripts/real-trial-runtime.test.mjs` passed: 7/7.
- `node --test scripts/real-trial-gateway.test.mjs` passed outside the filesystem sandbox because its fixture binds loopback ports.
- `node --test tools/runtime-scripts.test.mjs tools/runtime-scripts-round1.test.mjs` passed: 19/19 outside the filesystem sandbox for its loopback fixture.
- `pnpm --filter ./backend build` and `git diff --check` passed.

### Hardening delivered

- Trial preparation now uses a real loopback bind check by default, rejects an explicit relative root and private-directory/file symlinks, preserves the owner-only customer password for a later `trial:start`, generates a separate retained bootstrap password, and binds the backend to the loopback-only MediaCrawler URL.
- Long-running services use a detached nonce-bearing wrapper. PID records persist exact command/args/nonce metadata with owner-only atomic files; status and stop read them from disk and use exact `ps -p PID -o command=` matching before signalling. TERM has a bounded wait; KILL is only attempted after revalidation, so a reused PID is not signalled.
- Startup builds the backend and frontend under the generated trial environment, waits for MySQL initialization/readiness/schema setup, disables MySQL X Plugin and writes its PID/error files under the runtime, waits for the Quick Tunnel origin in its owner-only log, provisions/verifies the tenant admin through the real account API, then restarts backend without bootstrap environment variables.
- `trial:verify` checks unauthenticated `/api/auth/me` and reads the current owner-only status origin by default. No trial stack, public tunnel, browser, or customer password was started or used for this fix.

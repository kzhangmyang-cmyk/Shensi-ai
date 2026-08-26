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

# Shensi Trial to API-only migration evidence

## Current gate

The migration has **not** started. Trial remains the authoritative runtime and
this document does not authorize a database freeze, cutover, acceptance,
deployment, or real Douyin action.

Task 4's disposable empty-database verifier and real Docker/Compose gate are
complete. Task 5 now has a read-only migration preflight, crash-safe recovery
supervisor, and an encrypted migration runner wired to the CLI. The runner
starts only the exact attempt target, passes secrets only in child-process
environment variables, validates fresh owner-only artifacts, binds the
authenticated backup manifest to the frozen preflight Git commit, and retains
the target volume during recovery. Outreach bridge Task 1 is now complete: it
freezes each action's server/desktop execution target, adds desktop lifecycle
states, centralizes authority checks, and prevents the server worker from
claiming desktop actions. The enrollment and durable installation-identity
implementation passes its authorized non-live review and verification gates.
Fenced account binding is in a narrow schema/safety repair round; desktop claim,
receipt, protocol, and target-only schema-upgrade tasks also remain. The
enrollment and binding storage verifiers' live lock-owned disposable MySQL
receipts have not been produced. The sealed prerequisite evidence is
therefore still incomplete, so the executor fails closed before writer freeze.
This work does not prepare or activate the retained API-only runtime and does
not authorize writer freeze or migration execution.

## Task 5 read-only preflight

The real preflight run on 2026-09-04 completed its read-only inspection and
returned `authorized:false`. It verified the retained Trial process ownership,
the source endpoint `shensi_trial@127.0.0.1:3310`, the disposable empty-runtime
evidence, and the current action inventory without stopping a process or
copying data.

The Trial MySQL gate is an authenticated identity and SQL proof, not a TCP-port
occupancy check. It reads the owner-only retained `trial.env` and
`secrets/mysql_app_password`, authenticates as the configured Trial application
account, and verifies all of the following against the live server:

- port `3310` and database `shensi_trial`;
- the authenticated MySQL account;
- the retained `.runtime/real-trial/state/mysql` datadir;
- the live server UUID against the retained datadir identity;
- execution of the fixed read-only identity query.

Only a non-sensitive summary is returned: account identity, database, port,
the `retained-trial` datadir label, SQL status, and a SHA-256 digest of the
server identity. Database passwords, database URLs, and the raw server UUID
are not retained in the summary.

The current preflight is not ready. Its blockers are exactly:

- required desktop action-bridge and feature-parity prerequisite evidence is
  incomplete (bridge Tasks 1–3 have completed their non-live implementation and
  review gates; Tasks 2–3 still lack live disposable receipts, Task 4 is in
  progress, and later bridge tasks remain);
- six non-terminal legacy server outreach actions remain in Trial.

Accordingly, the preflight did not provision a migration attempt, freeze Trial
writers, stop Trial MySQL, start a target restore, or run the encrypted data
migration. Trial remains the active authoritative runtime.

Two preflight defects found during the real read-only run are fixed:

- macOS process attestation now reads `ps` under a UTF-8 locale, preserving the
  exact Chinese workspace path instead of falsely classifying its PID as
  reused;
- a missing directory encountered by a `readdir`-based preflight read is
  classified as an explicit absent/missing input instead of surfacing as an
  unhandled internal error.

## Disposable verifier contract

- Project: `shensi-api-empty-<12 lowercase hex>`
- Runtime root: `.runtime/api-only-empty/<same suffix>`
- Gateway: `127.0.0.1:5628`
- MySQL: `127.0.0.1:3312`
- Networks: service traffic remains on `shensi_internal`; Backend alone also
  joins `shensi_egress`; MySQL and Gateway additionally join the
  non-masqueraded `shensi_host` bridge so Docker Engine 29 can publish their
  loopback-only ports without granting them Internet egress
- Shared owner lock: `.runtime/api-only-empty/disposable-5628-3312`
- Test account: run-scoped and never written to evidence
- Secrets: generated independently from Trial and stored owner-only
- Public API proof: authenticated, read-only, 21-module smoke manifest
- Gateway proof: `/healthz` and `/api/health` only; Web/noVNC HTTP and Upgrade
  routes must return `404`
- Build proof: fresh `backend-runtime` source-manifest hash, running immutable
  Backend image digest, resolved Compose-config hash, and build timestamp
- Cleanup: exact project/engine/lock/root/volume validation, fixed
  `down --volumes --remove-orphans`, zero project-labelled container/network/
  volume residue, private per-run root removal, then matching lock release

The retained non-secret report is written to
`.runtime/api-only/evidence/empty/<run-id>.json`. Once private runtime
preparation has completed, a later failed run retains a redacted failure
report before cleanup. Failures before a run root exists fail closed without
creating evidence. Stale disposable-lock recovery writes a separate owner-only
audit containing hashes of the prior start token and nonce, never their raw
values. A failed report may include only a bounded allowlisted internal
`failureCode`; arbitrary exception text is discarded.

## Implementation evidence

Fresh regression verification on 2026-09-04:

```text
node --test scripts/api-only-runtime.test.mjs scripts/lib/api-only-authority.test.mjs
tests 78; pass 78; fail 0

node --test tools/deployment-contract.test.mjs scripts/source-content-manifest.test.mjs scripts/container-runtime.test.mjs
tests 88; pass 88; fail 0

pnpm --filter ./backend test:security
ok: true
```

The final Task 5 combined regression after the authenticated MySQL identity,
freeze-intent recovery, exact target-stop adapter, frozen-commit binding, and
encrypted migration-runner changes is:

```text
node --test scripts/api-only-runtime.test.mjs scripts/lib/api-only-authority.test.mjs \
  scripts/lib/process-ownership.test.mjs scripts/trial-cutover-adapter.test.mjs \
  scripts/task5-migration-runner.test.mjs tools/data-migration-scripts.test.mjs \
  scripts/real-trial-runtime.test.mjs
tests 210; pass 210; fail 0
```

The tests cover disposable identity and private modes, independent secrets,
owner-lock serialization and stale recovery, exact orchestration order,
success/start-failure/smoke-failure/signal cleanup, engine drift, project and
volume scoping, post-down residue detection, default loopback port probing,
running-image/config evidence, promoted runtime reload, and the live CLI
binding for `api:verify:empty`.

## Operational empty-database evidence

| Field | Value |
| --- | --- |
| Gate status | `passed` |
| Verified at | `2026-09-04T11:13:52.368Z` |
| Project suffix | `044aa35ac810` |
| Module/status list | `auth`, `dashboard`, `agents`, `growth bootstrap`, `acquisition`, `conversations/account`, `private domain`, `private-domain todos`, `conversion`, `scripts/knowledge`, `trade marketing`, `settings`, `search connections`, `AI connections`, `advisor`, `catalog`, `quotes`, `finance costs`, `finance facts`, `ROI`, `financial council`: all `200` |
| Forbidden-route results | HTTP `/`, `/live-sessions/probe`, `/douyin-live/<safe-id>`, `/novnc/vnc.html`: all `404`; Upgrade `/live-sessions/probe`, `/douyin-live/<safe-id>`: both `404` |
| Source-manifest hash | `ea58721d06b10bf769191739cbee6e8fdf2d1d2ba9f01e14e4a997d46be20bf2` |
| Backend image digest | `sha256:3f1e1add94486c00e273513737bf84aab9b92bd057b5d9033e5ada73bbbccb10` |
| Compose-config hash | `6f5ab1d846dfaac14981a0799f5510ed814f5da8c9e6b5e2c93500d3194760c1` |
| Retained-report SHA-256 | `10b40c11e39525b99966fc4971e9e5e12c9fa490b8b56ca96742c582cf7258c6` |
| Cleanup result | `complete`; zero matching container, network, volume, per-run root, or owner-lock residue |

The retained owner-only report is
`.runtime/api-only/evidence/empty/044aa35ac810.json` with mode `0600`; its bytes
were independently hashed to the value above. `pnpm api:status` returned
`API_ONLY_RUNTIME_NOT_PREPARED`, which is expected because this disposable gate
does not create or start the retained `shensi-api` project.

## Authorized verification sequence

The completed verification sequence was:

```bash
node --test scripts/api-only-runtime.test.mjs
pnpm api:verify:empty
pnpm api:status
git diff --check
```

The gate must not connect to Douyin, approve outreach, send comments or private
messages, test provider keys, stop Trial, use ports `5608/3310`, or delete any
retained/migration volume.

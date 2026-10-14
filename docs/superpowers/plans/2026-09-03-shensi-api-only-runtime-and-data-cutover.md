# Shensi API-only Runtime and Data Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Trial/Web runtime at `127.0.0.1:5608` with a local API-only Backend/MySQL/Gateway runtime, prove a clean database and every desktop business module through authenticated API smoke tests, then migrate `shensi_trial` into a new encrypted, verified `shensi` target with a bounded rollback window.

**Architecture:** `Shensi.app` keeps its existing `desktop-config.json` origin `http://127.0.0.1:5608`; an nginx loopback gateway exposes only `/healthz` and `/api/*`, proxies to the existing Backend, and stores all shared business state in MySQL. Docker Compose starts only `mysql`, `backend`, and `gateway`. The Trial source is frozen without deleting its datadir, existing encrypted migration tools restore into a fresh Compose project, and a persisted migration state machine permanently closes Trial rollback when `rollbackClosedAt` is durably written on entry to `write_activation_pending`, before any target write-capable process starts.

**Tech Stack:** Node.js 22.22.3, pnpm 11.18.0, Docker Compose v2 plugin or standalone `docker-compose`, Colima-compatible Docker Engine, MySQL 8.4.11, Express, nginx-unprivileged 1.27, Electron 44.1.1, Node test runner, OpenSSL AES-256-CBC/PBKDF2.

**Spec:** `docs/superpowers/specs/2026-09-03-shensi-desktop-only-api-migration-design.md`

## Global Constraints

- Preserve every tracked and untracked user change. Before each task run `git status --short` and review the scoped diff; do not reset, clean, stash, checkout over, stage, or commit the shared dirty worktree.
- This plan never restores an old frontend. `frontend/` remains the only Renderer source, and the existing `Shensi.app` remains the user entry point.
- Do not alter or delete `deploy/compose.yaml`, `deploy/nginx/default.conf`, `.runtime/real-trial/state/mysql`, Electron `userData`, the Trial secrets, encrypted backups, migration manifests, or verification reports.
- The API-only runtime must not start `frontend`, Cloudflare Tunnel, MediaCrawler, Xvfb, VNC, websockify, noVNC, or a remote-display WebSocket. It must not receive `MEDIACRAWLER_BASE_URL` or `MEDIACRAWLER_SERVICE_SECRET_FILE`.
- Canonical ports are Gateway `127.0.0.1:5608` and migration-only MySQL `127.0.0.1:3311`. Disposable empty-database verification uses Gateway `127.0.0.1:5628` and MySQL `127.0.0.1:3312`, so it can run while Trial still owns `5608` and `3310`.
- Tasks 1–4 may build and verify disposable API-only infrastructure now. Tasks 5–9 may add migration/cutover/GC tooling, but `migration-run` and `cutover` are blocked until the desktop outreach action bridge, desktop feature-parity Tasks 1, 2, 2A–2G, 3, and 4, and feature-parity Task 5's harness/unit tests have independently passed. Feature-parity Task 5's live cold-start audit runs only after read-only cutover; `accept` is blocked until that live audit and the installed-app read-only pass both pass. Only API Task 9's read-only GC audit may run without a purge authorization. Each operation still requires the separate authorization named at its step; this plan is not that authorization.
- Normal `api:stop` uses the resolved Compose runtime's `stop`; it never calls `down --volumes`. Outside Task 9's separately authorized, exact-set migration GC, volume deletion is allowed only for a run-scoped disposable project whose validated name begins `shensi-api-empty-`; normal stop, cutover, acceptance, and recovery never delete volumes.
- API smoke tests may register a run-scoped test account, read module state, and delete only their disposable volume. They must never connect to Douyin, approve outreach, send a comment, send a private message, test a real provider key, or print credentials/customer content.
- Preserve byte-for-byte the Trial values behind `JWT_SECRET`, `PROVIDER_CREDENTIAL_KEY`, `AGENT_JOB_ENCRYPTION_KEY`, `ACQUISITION_MASTER_SECRET`, `ACQUISITION_V1_CURSOR_SECRET`, `TRADE_OBSERVATION_CURSOR_SECRET`, `MARKET_OPPORTUNITY_CURSOR_SECRET`, `PROSPECT_RUN_IDEMPOTENCY_SECRET`, `PROSPECT_RUN_CURSOR_SECRET`, `PROSPECT_EXECUTION_CLAIM_SECRET`, `ORGANIZATION_IDENTITY_MASTER_SECRET`, `PROSPECT_SOURCE_RAW_ENVELOPE_SECRET`, and `PROSPECT_COVERAGE_MASTER_SECRET`. Do not migrate MediaCrawler secrets.
- Runtime directories are owner-only (`0700`); env, password, state, and evidence files are owner-only (`0600`). Reject symlinks and non-absolute runtime-root overrides before reading or writing.
- Never assume Docker Desktop or a working `docker` shim. Every Compose operation goes through the tested runtime resolver, which may select either an executable Docker Compose plugin or standalone `docker-compose`, pins one validated `DOCKER_HOST`/engine identity for the run, and never starts, stops, or deletes a Colima VM. A shared Trial engine is allowed only as a daemon: projects, ports, roots, locks, and volumes remain isolated, and API-only cleanup may not stop the engine itself.
- All workflows using disposable `5628/3312` acquire the same cross-process owner lock before checking ports or creating resources. They serialize route parity, business-flow, empty-database, and MySQL integration runs; fixed ports are never assumed safe merely because an in-process mutex is free.
- `shensi_trial` remains frozen and executable rollback remains available only through `cutover_read_only`. Once first-use `api:accept` durably enters `write_activation_pending`, Trial rollback is closed even if terminal `accepted` has not yet been reached; only `api:accept:resume` may recover forward on the same attempt/evidence. From terminal `accepted`, rollback commands fail closed with `API_ONLY_ROLLBACK_WINDOW_CLOSED`; recovery is forward from the retained target and encrypted backup.
- Each task follows red-green-refactor, ends with fresh focused tests and `git diff --check`, and ends at a review checkpoint instead of a commit.

---

### Task 1: Lock down the API-only Compose and nginx boundary

**Files:**
- Create: `scripts/container-runtime.mjs`
- Create: `scripts/container-runtime.test.mjs`
- Create: `scripts/source-content-manifest.mjs`
- Create: `scripts/source-content-manifest.test.mjs`
- Create: `deploy/compose.api-only.yaml`
- Create: `deploy/nginx/api-only.conf`
- Create: `scripts/api-only-runtime.test.mjs`

**Interfaces:**
- `discoverComposeRuntime(options)` returns an immutable executable argv prefix, sanitized child environment, Compose version, canonical Unix-socket identity, and daemon identity. It supports `docker compose` and standalone `docker-compose`, rejects broken symlinks/non-executables, and validates the selected daemon before any mutation. Daemon/socket identity and toolchain version are recorded and compared separately.
- `runResolvedCompose(runtime,args,options)` is the only process boundary for Compose in this plan. It uses `shell:false`, exact argv, a bounded deadline, and a redacted error. Runtime selection can be written to an owner-only record and a later command refuses an engine-identity mismatch.
- `createSourceContentManifest(repositoryRoot,scope)` hashes every regular build input—including relevant untracked files—into sorted path/mode/size/SHA-256 records. `backend-runtime` exactly covers the Dockerfile `COPY` inputs plus Compose/nginx/runtime scripts; `desktop-app` covers latest Renderer, Main/preload/config, Sidecar source/lock/build scripts, contracts, root lock/workspace files, and packaging inputs. Generated output, node_modules, `.git`, runtime state, secrets, Profiles, and unrelated files are forbidden or excluded by an explicit tested rule; an unclassified file under an included build root fails the manifest rather than disappearing silently.
- Compose services are exactly `mysql`, `backend`, and `gateway`.
- Compose receives absolute private paths through `SHENSI_API_BACKEND_ENV_FILE`, `SHENSI_API_MYSQL_APP_PASSWORD_FILE`, and `SHENSI_API_MYSQL_ROOT_PASSWORD_FILE`.
- Compose receives host ports through `SHENSI_API_HTTP_PORT` and `SHENSI_API_MYSQL_HOST_PORT`; the supervisor supplies `5608/3311` for the retained target and `5628/3312` for disposable verification.
- `gateway` binds only `127.0.0.1:${SHENSI_API_HTTP_PORT}:8080`, receives a supervisor-selected private `SHENSI_API_GATEWAY_IP`, and reaches `backend:4188` only. `SHENSI_API_INTERNAL_SUBNET` and the gateway address are unique per retained/disposable project and never reuse Trial's `172.30.0.0/24` on the same engine.
- nginx returns `200` with `ok\n` for `GET /healthz`, proxies `/api/`, and returns `404` for every other HTTP path and every non-API upgrade request.

- [ ] **Step 1: Write red runtime-discovery tests**

Use injected filesystem/process probes. Cover a valid `docker compose` plugin, fallback to a valid standalone `docker-compose`, a broken `/Users/mac/bin/docker`-style symlink, missing daemon, explicit owner-only `unix://` socket, invalid/TCP `DOCKER_HOST`, daemon/socket mismatch, harmless Compose-binary upgrade, command timeout, and secret redaction. Cover network allocation against daemon IPAM plus host routes: reject Trial's `172.30.0.0/24`, a VPN overlap, retained/disposable collision, gateway outside the selected subnet, and a foreign network claim between prepare/start; permit stop→start reuse only when daemon/socket identity plus exact Compose project/network labels and runtime nonce match the persisted owner. Add crash-before-status recovery tests. Test both content-manifest scopes with modified and untracked inputs, path order, mode changes, symlinks, generated exclusions, and a new unclassified build-root file. Assert no code path invokes `open Docker`, `colima start`, `colima stop`, `colima delete`, `docker context use`, a shell, or an unvalidated binary.

- [ ] **Step 2: Run runtime discovery red**

Run: `node --test scripts/container-runtime.test.mjs`

Expected: FAIL because the resolver does not exist.

- [ ] **Step 3: Implement and verify runtime discovery**

Resolve candidates by executable capability, not filename alone. An explicit `SHENSI_DOCKER_HOST` must be a canonical absolute owner-accessible Unix socket URL; otherwise read a current local engine endpoint from owner-controlled Docker/Colima metadata without mutating global context. Probe `/_ping` and `/info` directly over that validated Unix socket with Node's HTTP client. Persist a daemon identity hash derived from stable daemon fields plus canonical socket identity, and record Compose kind/version separately as toolchain evidence. A Compose upgrade may warn/revalidate but cannot strand an owner-validated `status`/`stop`; a daemon/socket change always fails closed. This must work when no executable `docker` CLI exists. If the only healthy daemon is the existing `shensi-trial` Colima socket, use it only as a shared engine with a distinct Compose project and never control that VM's lifecycle.

Run:

```bash
node --test scripts/container-runtime.test.mjs scripts/source-content-manifest.test.mjs
node scripts/container-runtime.mjs doctor
```

Expected: the doctor reports only binary kind/version, socket basename/profile label, and engine ID hash—never credentials or full environment—and exits 0 on the actual host. The source manifest command reports only scope, record count, and root hash.

- [ ] **Step 4: Write red static infrastructure contract tests**

In `scripts/api-only-runtime.test.mjs`, parse Compose with the repository's existing YAML dependency and read nginx as text. Assert all of the following:

```js
assert.deepEqual(Object.keys(compose.services).sort(), ["backend", "gateway", "mysql"]);
assert.equal(compose.services.frontend, undefined);
assert.equal(compose.services["media-crawler"], undefined);
assert.deepEqual(compose.services.backend.networks.sort(), ["shensi_egress", "shensi_internal"]);
assert.deepEqual(compose.services.mysql.networks, { shensi_internal: null, shensi_host: null });
assert.match(compose.services.gateway.networks.shensi_internal.ipv4_address, /^\$\{SHENSI_API_GATEWAY_IP:\?[^}]+\}$/u);
assert.equal(compose.services.gateway.networks.shensi_host, null);
assert.deepEqual(compose.networks.shensi_internal.ipam.config, [{ subnet: "${SHENSI_API_INTERNAL_SUBNET:?required}" }]);
assert.equal(compose.networks.shensi_internal.internal, true);
assert.deepEqual(compose.networks.shensi_host.driver_opts, {
  "com.docker.network.bridge.enable_ip_masquerade": "false",
  "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1"
});
assert.match(gatewayPort, /^127\.0\.0\.1:\$\{SHENSI_API_HTTP_PORT:\?[^}]+\}:8080$/u);
assert.match(mysqlPort, /^127\.0\.0\.1:\$\{SHENSI_API_MYSQL_HOST_PORT:\?[^}]+\}:3306$/u);
```

Also assert the Backend environment has `CRM_STORE=mysql`, `BACKEND_HOST=0.0.0.0`, `PORT=4188`, a required `TRUSTED_PROXY_CIDRS` value derived from the selected gateway IP, legacy `DOUYIN_OUTREACH_ACTIONS_ENABLED=false`, `DOUYIN_OUTREACH_APPROVALS_ENABLED=true`, `DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED=false`, `DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED=false` until the post-read-only, pre-`accepted` write-activation transaction, and `SHENSI_DESKTOP_CLIENT_ADMISSION_MODE=migration_locked` with no admitted digest until the final joint milestone; it has no `MEDIACRAWLER_*` key and no dependency on a frontend or MediaCrawler service. Assert nginx contains exact `/healthz` and `/api/` locations and no occurrence of `douyin-live`, `live-sessions`, `novnc`, `vnc`, `websockify`, or `proxy_set_header Upgrade`.

- [ ] **Step 5: Run the infrastructure test red**

Run: `node --test scripts/api-only-runtime.test.mjs`

Expected: FAIL because `deploy/compose.api-only.yaml` and `deploy/nginx/api-only.conf` do not exist.

- [ ] **Step 6: Create the three-service Compose file**

Use `mysql:8.4.11`, the existing `deploy/docker/backend.Dockerfile`, and `nginxinc/nginx-unprivileged:1.27-alpine`. Define a named `mysql_data` volume without an explicit global `name`, so `--project-name` isolates retained and disposable databases. Require `SHENSI_API_INTERNAL_SUBNET` and `SHENSI_API_GATEWAY_IP`; the runtime resolver inventories daemon network IPAM and host routes before mutation, rejects overlap (including Trial's existing network), and persists the selected subnet/IP in the owner-only runtime record. A stopped runtime may reuse its own existing network only when project/network Compose labels, daemon/socket identity, and runtime nonce all match; any foreign/stale claimant fails. Mount the two MySQL passwords as Compose secrets, mount the selected gateway config read-only, and make MySQL and Backend health checks mandatory dependencies. Backend alone joins the ordinary non-internal `shensi_egress` network for Internet egress. MySQL and Gateway instead join `shensi_host`, a separate non-masqueraded bridge whose host binding is fixed to `127.0.0.1`; this preserves loopback port publication on Docker Engine 29 without granting either service Internet egress. Do not put a top-level Compose project name in the file.

- [ ] **Step 7: Create the deny-by-default nginx configuration**

Set `server_tokens off`, the existing security headers, and bounded proxy timeouts. Use only these locations:

```nginx
location = /healthz { access_log off; default_type text/plain; return 200 "ok\n"; }
location ^~ /api/ {
    proxy_pass http://backend:4188;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
location / { return 404; }
```

Do not add an upgrade map, WebSocket headers, static root, SPA fallback, or proxy to any browser-display service.

- [ ] **Step 8: Validate generated Compose and run focused tests green**

Supply throwaway absolute file paths containing non-secret test values, then run:

```bash
SHENSI_API_BACKEND_ENV_FILE="$PWD/.runtime/api-only-contract/backend.env" \
SHENSI_API_MYSQL_APP_PASSWORD_FILE="$PWD/.runtime/api-only-contract/mysql_app_password" \
SHENSI_API_MYSQL_ROOT_PASSWORD_FILE="$PWD/.runtime/api-only-contract/mysql_root_password" \
SHENSI_API_HTTP_PORT=5628 SHENSI_API_MYSQL_HOST_PORT=3312 \
SHENSI_API_INTERNAL_SUBNET=198.18.250.0/24 SHENSI_API_GATEWAY_IP=198.18.250.254 \
node scripts/container-runtime.mjs compose -- \
  -f deploy/compose.api-only.yaml --project-name shensi-api-contract config --quiet
node --test scripts/container-runtime.test.mjs
node --test scripts/source-content-manifest.test.mjs
node --test scripts/api-only-runtime.test.mjs
git diff --check
```

Expected: Compose validation and tests exit 0. `198.18.250.0/24` is a render-only documentation/test value for `compose config`; no network is created. Every real start still uses the supervisor's daemon-IPAM/host-route allocator and may not reuse this value without normal ownership checks. Remove only `.runtime/api-only-contract` after confirming it is the exact test directory; do not touch `.runtime/real-trial`.

---

### Task 2: Build the private API-only supervisor and lifecycle CLI

**Files:**
- Create: `scripts/api-only-runtime.mjs`
- Modify: `scripts/api-only-runtime.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Export `API_ONLY_PORTS`, `API_ONLY_CRYPTO_SECRET_BINDINGS`, `parseApiOnlyCli(argv)`, `prepareApiOnlyRuntime(repositoryRoot, options)`, `apiOnlyComposeInvocation(runtime, args)`, `startApiOnlyDatabase(repositoryRoot, options)`, `startApiOnlyRuntime(repositoryRoot, options)`, `stopApiOnlyRuntime(repositoryRoot, options)`, and `apiOnlyStatus(repositoryRoot, options)`.
- Export `acquireApiOnlyOwnerLock(repositoryRoot,input)`, `releaseApiOnlyOwnerLock(lock,options)`, and `withApiOnlyOwnerLock(input,callback)`. The disposable lock name is exactly `disposable-5628-3312`; its record contains project, ports, PID, process-start token, random nonce, engine-ID hash, and creation time, but no secret.
- `API_ONLY_PORTS` is `{ gateway: 5608, mysql: 3311, emptyGateway: 5628, emptyMysql: 3312 }`.
- Default runtime root is `<repo>/.runtime/api-only`; default retained project is `shensi-api`; both have explicit absolute-path and symlink validation.
- `prepare` copies the selected nginx configuration into an immutable owner-only runtime snapshot, records its absolute no-follow path and hash together with the resolved Compose model, and makes Compose mount that snapshot rather than a mutable repository file. A later source edit cannot silently change or overwrite the active Gateway configuration; promotion must create a new snapshot and retain the previous one for bounded recovery.
- Lifecycle commands are migration-state aware. `prepare` is a pre-accept/bootstrap command and fails closed with `API_ONLY_ALREADY_ACCEPTED` after terminal `accepted`; `write_activation_pending` accepts only `api:accept:resume`. In terminal `accepted`, `api:start` resolves the active immutable Backend image digest, Gateway snapshot, desktop-client admission record, resolved Compose record, engine/project/network identity, and existing MySQL container/volume from accepted evidence. It may start the exact stopped MySQL container with Compose `start`, then start or recreate only Backend/Gateway with the persisted override and `up -d --no-build --no-deps backend gateway`; before the joint milestone the restored admission must remain exactly locked with no digest. It never renders from current source, refreshes the Gateway/admission snapshot, builds an image, includes `mysql` in `up`, initializes a database, or recreates a volume. `api:db:start` has the same accepted-state ownership checks and may only `start` the existing exact MySQL container. Missing or mismatched accepted resources require an explicit recovery/promotion workflow rather than implicit reconstruction.
- `api:verify:empty` is a disposable development/test gate only. It must use its separate ports, project suffix, runtime root, owner lock, and disposable volume; it rejects the active accepted project, canonical ports, and every accepted resource identity even when an operator passes overrides.
- Root commands are exact aliases:

```json
{
  "api:prepare": "node scripts/api-only-runtime.mjs prepare",
  "api:runtime:doctor": "node scripts/container-runtime.mjs doctor",
  "api:db:start": "node scripts/api-only-runtime.mjs db-start",
  "api:start": "node scripts/api-only-runtime.mjs start",
  "api:stop": "node scripts/api-only-runtime.mjs stop",
  "api:status": "node scripts/api-only-runtime.mjs status",
  "api:verify": "node scripts/api-only-runtime.mjs verify",
  "api:verify:empty": "node scripts/api-only-runtime.mjs verify-empty",
  "api:migration:preflight": "node scripts/api-only-runtime.mjs migration-preflight",
  "api:migration:run": "node scripts/api-only-runtime.mjs migration-run",
  "api:cutover": "node scripts/api-only-runtime.mjs cutover",
  "api:rollback": "node scripts/api-only-runtime.mjs rollback",
  "api:accept:prepare": "node scripts/api-only-runtime.mjs accept-prepare",
  "api:accept": "node scripts/api-only-runtime.mjs accept",
  "api:accept:resume": "node scripts/api-only-runtime.mjs accept-resume",
  "api:active-project": "node scripts/api-only-runtime.mjs active-project"
}
```

- [ ] **Step 1: Write red unit tests for preparation and CLI parsing**

Use a temporary repository fixture plus injected filesystem/port/Compose functions. Assert:

- only the commands listed above parse, every command rejects positional/unknown flags, and invalid input fails with `API_ONLY_CLI_ARGUMENT_INVALID`;
- relative roots, symlinked roots/files, group/world-readable secrets, a project name outside `^shensi-api(?:-[a-z0-9-]+)?$`, and occupied required ports fail before Compose runs;
- directories are `0700`, generated files are `0600`, and output contains paths/status codes but none of the secret byte sequences;
- the Gateway snapshot is created exclusively below the validated runtime root, is a regular non-symlink file, is content-addressed by its SHA-256, and remains byte-identical when the repository nginx source changes; restart refuses a missing/mismatched snapshot instead of falling back to the mutable source file;
- `apiOnlyComposeInvocation()` always includes `-f deploy/compose.api-only.yaml --project-name <validated-project>` and injects absolute env/secret paths plus exact ports;
- an accepted-state `start` with deliberate current-source/config drift still uses the accepted image digest and Gateway snapshot, contains `--no-build --no-deps backend gateway`, never includes `mysql` in that `up` invocation, and writes no source/config/build record; an accepted `db-start` uses only `start mysql`; missing/mismatched MySQL, volume, image, snapshot, resolved config, engine, project, or network fails closed;
- `prepare` rejects terminal `accepted`, ordinary `start` rejects `write_activation_pending` in favor of `api:accept:resume`, and disposable `verify-empty` can never resolve the accepted project, canonical ports, active network, or active volume;
- `stopApiOnlyRuntime()` produces resolved Compose arguments ending in `stop` and contains neither `down` nor `--volumes`;
- runtime invocation accepts either a resolved plugin argv prefix (`docker`, `compose`) or standalone (`docker-compose`) and never hard-codes either one;
- lock acquisition uses an atomic owner-only create, rejects a live owner, validates PID plus process-start token plus nonce before stale recovery, and only the exact owner can release it; signals and `finally` handlers release only after child cleanup finishes.

- [ ] **Step 2: Run the supervisor tests red**

Run: `node --test scripts/api-only-runtime.test.mjs`

Expected: FAIL because `scripts/api-only-runtime.mjs` and the package aliases do not exist.

- [ ] **Step 3: Implement private runtime preparation**

Create these paths without placing a secret in stdout, argv, Compose labels, or Git:

```text
.runtime/api-only/
├── backend.env
├── active-project.json
├── status.json
├── migration-state.json
├── logs/
├── evidence/
└── secrets/
    ├── mysql_app_password
    ├── mysql_root_password
    ├── bootstrap_admin_password
    ├── migration_reader_password
    ├── migration_backup_passphrase
    ├── smoke_login_password
    └── <preserved application secret files>
```

Map each uppercase application variable in `API_ONLY_CRYPTO_SECRET_BINDINGS` to the existing lowercase Trial file under `.runtime/real-trial/secrets`. Copy bytes with exclusive creation, or verify an existing target file has the same SHA-256 fingerprint; never silently rotate a preserved key. Generate new MySQL, bootstrap, migration-reader, and backup-passphrase values with `randomBytes(48).toString("base64url")`. Copy the private Trial application password to `smoke_login_password`; do not include it in `backend.env`.

Write `backend.env` with `DATABASE_URL=mysql://shensi_app:<encoded-password>@mysql:3306/shensi`, `CRM_STORE=mysql`, `CRM_SEED_DEVELOPMENT_DATA=false`, `NODE_ENV=production`, `BACKEND_HOST=0.0.0.0`, `PORT=4188`, `TRUSTED_PROXY_CIDRS=<selected-gateway-ip>/32`, `CORS_ORIGINS=http://127.0.0.1:<selected-gateway-port>`, `SESSION_COOKIE_SECURE=true`, legacy `DOUYIN_OUTREACH_ACTIONS_ENABLED=false`, `DOUYIN_OUTREACH_APPROVALS_ENABLED=true`, `DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED=false`, `DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED=false`, `SHENSI_DESKTOP_CLIENT_ADMISSION_MODE=migration_locked`, no admitted-build digest, generated bootstrap admin fields, and all preserved application secrets. Omit every `MEDIACRAWLER_*` variable. Desktop execution remains false throughout disposable verification, migration, and `cutover_read_only`; only Task 6's irreversible post-read-only, pre-`accepted` write-activation transaction may apply the action bridge transformer and enable it, while client admission remains locked until Task 8's final joint activation.

- [ ] **Step 4: Implement lifecycle behavior**

Before terminal acceptance, `db-start` may use the resolved Compose runtime to run `up -d mysql` for an owner-validated new target and wait for health. A bootstrap `start` acquires the retained-runtime owner lock, checks both canonical ports, renders and seals the selected Gateway snapshot/resolved Compose record, runs `up -d --build mysql backend gateway` only for that pre-accept target, waits for `/healthz` and `/api/health`, and atomically writes `status.json` with the pinned engine-ID hash plus active Backend image and Gateway snapshot hashes.

After terminal `accepted`, those same public aliases switch to restart-only behavior: revalidate the accepted state and receipts, start the existing exact MySQL container without create/recreate, and invoke Backend/Gateway only from the accepted immutable image/config/admission records with `--no-build`; current repository drift is intentionally ignored. Until Task 8 reaches `finalized`, each restart must reproduce `migration_locked` with no admitted build digest. `api:start` must not update a source manifest, admission record, or claim current-source equivalence. Task 8's joint milestone coordinator is the sole path that may build and activate a new Backend/Gateway/App version and exact client admission. `status` uses the same pinned runtime for `ps --format json`, probes both health endpoints, and emits one JSON object with `project`, `origin`, `services`, and `healthy`. `stop` uses Compose `stop`, verifies `5608` and `3311` are released, and preserves the project volume, immutable config snapshots, secrets, evidence, and migration state. No lifecycle function controls the Docker/Colima daemon.

- [ ] **Step 5: Add package scripts and ignored runtime paths**

Add the exact aliases above without changing existing Trial/Desktop scripts. Ensure `.runtime/api-only/` and `.runtime/api-only-empty/` are ignored while `docs/migration/*.md` remains trackable.

- [ ] **Step 6: Run focused lifecycle tests green**

```bash
node --test scripts/api-only-runtime.test.mjs
node -e 'const p=require("./package.json"); for (const n of ["api:start","api:stop","api:status","api:verify"]) if (!p.scripts[n]) process.exit(1)'
git diff --check
```

Expected: all exit 0; no real process or container is started by unit tests.

---

### Task 3: Add one authenticated, all-module API smoke contract

**Files:**
- Modify: `scripts/api-only-runtime.mjs`
- Modify: `scripts/api-only-runtime.test.mjs`

**Interfaces:**
- Export `API_ONLY_SMOKE_ROUTES`, `authenticateApiOnlySmoke(options)`, `runApiOnlyModuleSmoke(options)`, and `verifyApiOnlyGatewayBoundary(options)`.
- `authenticateApiOnlySmoke()` has exact modes `register` and `login`. It returns an in-memory Bearer token, CSRF token, user, and active workspace; it never returns them in a report.
- `runApiOnlyModuleSmoke()` issues only authenticated `GET` requests after authentication and emits `{ module, method, path, status, shape }` without response bodies.
- Every Growth request uses the `workspaceId` returned by `/api/v1/growth/bootstrap`; no workspace or user ID is hard-coded.

- [ ] **Step 1: Write the red smoke-manifest tests**

Assert the manifest contains these exact read contracts and top-level shapes:

| Module | Request | Required top-level keys/type |
| --- | --- | --- |
| auth | `GET /api/auth/me` | object: `user` |
| dashboard | `GET /api/dashboard/summary` | object: `scope`, `metrics` |
| agents | `GET /api/v1/business-advisor/agents` | object: `items` array |
| growth bootstrap | `GET /api/v1/growth/bootstrap` | object: `status`, `workspaceId`, `features` |
| acquisition | `GET /api/v1/acquisition/overview?platform=douyin` | object: `generatedAt`, `tasks` |
| conversations/account | `GET /api/v1/acquisition/social-accounts/douyin` | object: `items` array |
| private domain | `GET /api/customers?scope=mine` | object: `customers` array |
| private-domain todos | `GET /api/todos` | object: `todos` array |
| conversion | `GET /api/deals` | object: `deals`, `events` arrays |
| scripts/knowledge | `GET /api/knowledge/assets` | object: `assets` array |
| trade marketing | `GET /api/prospect-campaigns?includeArchived=false` | object: `campaigns` array, `total` number |
| settings | `GET /api/profile` | object: `user` |
| search connections | `GET /api/v1/acquisition/provider-connections` | object: `items` array, `nextCursor` |
| AI connections | `GET /api/v1/ai/connections` | object: `items` array, `nextCursor` |
| advisor | `GET /api/v1/acquisition/advisor/today?currency=CNY&asOf=<clock ISO>` | JSON object |
| catalog | `GET /api/v1/catalog/items?limit=1` | object: `items` array |
| quotes | `GET /api/v1/quotes/cases?limit=1` | object: `items` array |
| finance costs | `GET /api/v1/acquisition/cost-entries?limit=1` | object: `items` array |
| finance facts | `GET /api/v1/finance/facts?limit=1` | object: `items` array |
| ROI | `GET /api/v1/acquisition/cohorts?limit=1` | object: `items` array |
| financial council | `GET /api/v1/finance/council-policy` | object: `policyVersionId`, `revision` |

The advisor path builder receives an injected clock and uses the current ISO instant, preventing a future-date failure. Assert every manifest entry is `GET`, unique, and marked `realPlatformWrite: false`.

- [ ] **Step 2: Write red authentication, shape, and redaction tests**

With an injected `fetch`, prove `register` sends `{account,password}` to `/api/auth/register`, `login` sends `{email,password}` to `/api/auth/login`, subsequent requests carry `Authorization: Bearer <token>`, Growth requests carry the resolved workspace header, and neither the token nor password occurs in emitted JSON or thrown error text. Make a 401, non-JSON response, missing key, wrong array type, or non-200 module response identify only the module/path/status.

- [ ] **Step 3: Write red gateway-denial tests**

`verifyApiOnlyGatewayBoundary()` must assert:

- `GET /healthz` is exactly `200` and `ok\n`;
- `GET /api/health` is `200` with `{ ok: true, store: "mysql" }`;
- `GET /`, `GET /live-sessions/probe`, `GET /douyin-live/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, and `GET /novnc/vnc.html` are `404`;
- HTTP upgrade probes to `/live-sessions/probe` and the safe 43-character `/douyin-live/...` path never return `101` and return `404`.

- [ ] **Step 4: Implement the manifest and smoke runner**

Use an injected `fetch` for HTTP and an injected raw upgrade probe for unit tests. Apply a 10-second deadline per request and a 90-second suite deadline. Accept only exact loopback origins with protocol `http:`, hostname `127.0.0.1`, no credentials, and port `5608` or `5628`. Do not follow redirects outside that origin.

- [ ] **Step 5: Run smoke unit tests green**

```bash
node --test scripts/api-only-runtime.test.mjs
git diff --check
```

Expected: all simulated success/failure/redaction cases pass without contacting a real provider or Douyin.

---

### Task 4: Prove a disposable empty database end to end

**Files:**
- Modify: `scripts/api-only-runtime.mjs`
- Modify: `scripts/api-only-runtime.test.mjs`
- Modify: `package.json`
- Create: `docs/migration/2026-09-03-shensi-trial-to-api-only.md`

**Interfaces:**
- Export `createDisposableApiOnlyIdentity(randomBytes)`, `verifyEmptyApiOnlyRuntime(repositoryRoot, options)`, and `destroyDisposableApiOnlyRuntime(runtime, options)`.
- A disposable identity is `shensi-api-empty-<12 lowercase hex characters>`; its runtime root is `.runtime/api-only-empty/<same-suffix>`, Gateway port is `5628`, and MySQL port is `3312`. Every disposable orchestrator shares the exact `disposable-5628-3312` cross-process lock from Task 2.
- Cleanup accepts only a validated disposable project, exact matching runtime root, pinned engine identity, and matching owner lock, then uses the resolved Compose runtime with `down --volumes --remove-orphans`. The retained project name `shensi-api` and any migration project are rejected.

- [x] **Step 1: Write red disposable-safety tests**

Assert unique IDs, exact prefix/length, port selection, private file modes, and run-scoped account format `api_smoke_<12hex>`. Assert cleanup rejects `shensi-api`, `shensi-api-migration-*`, mismatched suffixes, a root outside `.runtime/api-only-empty`, a symlinked root, and a project whose volume list contains a volume not prefixed with the exact Compose project.

- [x] **Step 2: Write a red orchestration test with injected dependencies**

The expected sequence is exact:

1. atomically acquire `disposable-5628-3312` and pin the selected engine identity;
2. prove `5628` and `3312` are free while holding that lock;
3. create private config and a new project;
4. use the resolved Compose runtime to run `up -d --build mysql backend gateway`;
5. wait for MySQL, `/healthz`, and `/api/health`;
6. register the run-scoped account with a generated password;
7. run the complete Task 3 smoke manifest in the returned workspace;
8. run the forbidden-route/upgrade probes;
9. write an immutable build record `{ sourceManifestHash, imageIdDigest, composeConfigHash, builtAt }`; require its `sourceManifestHash` to equal the fresh pre-build `backend-runtime` source-content-manifest hash and require the running Backend image's immutable ID/digest to equal `imageIdDigest` (the source hash and image digest are different identifiers and are never compared to each other);
10. write a non-secret report under the disposable runtime's `evidence/`, copy it atomically to the retained owner-only `.runtime/api-only/evidence/empty/<run-id>.json`, and verify both SHA-256 values match;
11. in `finally`, validate exact project/root/volume/engine ownership, destroy only that project's containers, network, and volume, remove only its private runtime directory after the retained report is readable and hash-verified, then release only the matching owner lock.

Assert Step 11 runs after success, a module failure, a signal, and a Compose failure. A second process must fail before checking ports or creating a runtime; stale-lock recovery requires a dead/mismatched PID start token and leaves an audit record.

- [x] **Step 3: Implement disposable verification and wire `api:verify:empty`**

Do not use the retained `.runtime/api-only` secrets or volume. Generate all disposable values independently, set `CORS_ORIGINS=http://127.0.0.1:5628`, and require Backend health to report `store=mysql`. The generated bootstrap admin is allowed only inside this disposable database.

- [x] **Step 4: Run unit tests, then the real empty-database gate**

```bash
node --test scripts/api-only-runtime.test.mjs
pnpm api:verify:empty
pnpm api:status
git diff --check
```

Expected: the retained empty-database report lists every Task 3 module as `200`, all forbidden routes as `404`, includes the canonical `backend-runtime` content-manifest hash and immutable Backend image digest, no `shensi-api-empty-*` container/network/volume/runtime root or disposable owner lock remains, Trial continues to own `5608/3310`, and `api:status` reports the retained API-only runtime is not started.

- [x] **Step 5: Record the empty-database evidence without secrets**

Read the hash-verified retained report, then copy only its timestamp, project suffix, module/status list, forbidden-route results, retained-report SHA-256, and cleanup result into `docs/migration/2026-09-03-shensi-trial-to-api-only.md`. Do not copy account names, passwords, tokens, database URLs, response bodies, or generated secret fingerprints.

---

### Task 5: Freeze `shensi_trial` and run the existing encrypted migration

**Files:**
- Create: `scripts/lib/process-ownership.mjs`
- Create: `scripts/lib/process-ownership.test.mjs`
- Create: `scripts/trial-cutover-adapter.mjs`
- Create: `scripts/trial-cutover-adapter.test.mjs`
- Create: `scripts/task5-migration-runner.mjs`
- Create: `scripts/task5-migration-runner.test.mjs`
- Modify: `scripts/api-only-runtime.mjs`
- Modify: `scripts/api-only-runtime.test.mjs`
- Modify: `scripts/real-trial-runtime.mjs`
- Modify: `scripts/real-trial-runtime.test.mjs`
- Modify: `tools/data-migration-scripts.test.mjs`
- Modify: `docs/migration/2026-09-03-shensi-trial-to-api-only.md`

**Interfaces:**
- Export `provisionTrialMigrationReader(options)`, `freezeTrialWriters(repositoryRoot, options)`, `prepareTrialToApiOnlyMigration(repositoryRoot, options)`, and `runTrialToApiOnlyMigration(repositoryRoot, options)`.
- Extract the reusable PID-record, nonce/process-start, exact-command, and bounded TERM/KILL behavior from `scripts/real-trial-runtime.mjs` into `scripts/lib/process-ownership.mjs`. Both Trial and API-only migration code consume that one implementation. Keep Trial start/stop composition behind `scripts/trial-cutover-adapter.mjs`; the API-only core receives that adapter explicitly and steady-state `api:start|stop|status|verify` has no Trial import. After terminal acceptance, the retirement task removes the adapter and pre-accept CLI branches before deleting `real-trial-*`.
- Top-level migration states are exactly `prepared`, `source_frozen`, `target_restored`, `cutover_read_only`, `recovery_pending`, `write_activation_pending`, `failed_recovered`, `rolled_back`, and terminal `accepted`. The `0600` `.runtime/api-only/migration-state.json` also records `activeRuntime: "trial" | "target"`, one `activeAttemptId`, `rollbackClosedAt`, `desktopClientAdmission`, and an append-only array of attempt summaries. State writes are atomic; normal forward transitions are monotonic. `recovery_pending` is non-terminal and cannot authorize a new attempt or claim that Trial is active; only a verified `failed_recovered` or `rolled_back` state whose same atomic record contains `activeRuntime:"trial"` and the recovery-evidence hash may start a fresh attempt at `prepared`. `write_activation_pending|accepted` require the exact locked/null admission record until the later milestone owns an atomic active-version replacement.
- Each attempt and target use `shensi-api-migration-<12hex>`. Attempt states are `prepared`, `source_frozen`, `target_restored`, `cutover_read_only`, `recovery_pending`, `write_activation_pending`, `failed_recovered`, `rolled_back`, or `accepted`. A failed, rolled-back, or partial target project is retained and never reused; a subsequent authorized attempt gets a new ID, project, and volume. `write_activation_pending` and `accepted` permanently close Trial rollback; only `accepted` is the healthy terminal state.

- [x] **Step 1: Add red regression tests for the existing migration tools**

Extend `tools/data-migration-scripts.test.mjs` to prove:

- `SOURCE_DATABASE_URL=mysql://reader:<redacted>@127.0.0.1:3310/shensi_trial` is accepted;
- `TARGET_DATABASE_URL` must still name exactly `shensi`;
- source and target host/port/database tuples must differ;
- `MYSQL_LOCAL_ADMIN_URL` must match target host and port;
- backup/restore/migrate argument vectors never contain URL passwords or `SHENSI_BACKUP_PASSPHRASE`.

- [x] **Step 2: Add red migration supervisor tests**

Use injected MySQL and child-process adapters. Assert `migration-preflight`:

- requires `pnpm api:verify:empty` evidence with a signed build record `{ sourceManifestHash, imageIdDigest, composeConfigHash, builtAt }`; a fresh `backend-runtime` manifest must equal the recorded `sourceManifestHash`, the active image must equal the recorded `imageIdDigest`, and the resolved Compose config must equal `composeConfigHash`; commit ID alone is not evidence;
- requires the Trial `mysql` record to be live, nonce-owned, and healthy; for each writer record (`backend`, `gateway`, `frontend`, `sidecar`, `tunnel`), accepts either a live nonce-owned process that will be stopped or a PID/port/process-inventory-proven absence, and never starts an absent Web component merely to stop it;
- checks source database name `shensi_trial`, target name `shensi`, source port `3310`, target port `3311`, and free target/Gateway ports;
- queries only counts and stable IDs for non-terminal outreach actions whose effective target is `server`, reports them as `legacyServerActions`, and refuses migration/cutover preflight while the count is non-zero;
- reports `desktopNonTerminalActions` and `desktopInFlightWrites` (`claimed`, `executing`, `reconciliation_required`) and refuses freeze while either count is non-zero, so enabling the post-read-only desktop consumer during write activation cannot silently execute a pre-migration approval;
- creates/rotates only `'shensi_migration_reader'@'127.0.0.1'`, revokes its previous privileges, and grants only `SELECT`, `SHOW VIEW`, and `TRIGGER` on ``shensi_trial``.*;
- stores the reader password only in its `0600` secret file and passes it to mysql2 through memory, never SQL text interpolation, argv, state, evidence, or logs.

Assert `freezeTrialWriters()` passes only live, nonce-owned records among `backend`, `gateway`, `frontend`, `sidecar`, and `tunnel` to the neutral bounded stop helper through the explicit Trial adapter, treats already-proven-absent writers as no-ops, leaves the owned `mysql` record running, verifies ports `5608/5610/5611/5612` are released, and advances `prepared -> source_frozen`. A stale/reused PID, unowned live process, or surviving writer aborts before backup; the function never resurrects an absent frontend/tunnel/Sidecar. Add an import-graph test proving `scripts/api-only-runtime.mjs` contains no `real-trial-*` import and `trial-cutover-adapter.mjs` is the sole allowed composition edge.

Inject recovery crashes after entry to `recovery_pending`, after target stop, before/after Trial MySQL restart, after full Trial start, after health/login verification, and immediately before/after the final recovered-state commit. Re-entering `api:migration:run` in `recovery_pending` must resume only the same attempt's idempotent Trial recovery; it cannot rerun migration, mint a new attempt, or mark recovery complete early. No crash prefix may expose `failed_recovered` without `activeRuntime:"trial"` and the matching verified recovery-evidence hash in the same atomic state record.

- [x] **Step 3: Implement preflight and writer freeze**

Use the Trial root `.runtime/real-trial` and its existing `trial.env`, PID records, secrets, and MySQL datadir read-only except for the narrowly scoped reader account. Close the desktop app before freeze and verify no `Shensi` process holds `5608`. Build the migration environment in memory:

```text
SOURCE_DATABASE_URL=mysql://shensi_migration_reader:<encoded>@127.0.0.1:3310/shensi_trial
TARGET_DATABASE_URL=mysql://shensi_app:<encoded>@127.0.0.1:3311/shensi
MYSQL_LOCAL_ADMIN_URL=mysql://root:<encoded>@127.0.0.1:3311/mysql
SHENSI_BACKUP_PASSPHRASE=<bytes read from the private passphrase file>
BACKUP_DIRECTORY=<repo>/.runtime/api-only/evidence/backups
```

Never persist the four values together. Persist only database names, ports, project ID, source/target commit, transition time, and artifact basenames/hashes.

- [ ] **Step 4: Implement the encrypted migration orchestration**

After `source_frozen`, run the target project's `mysql` service on `3311`; verify `shensi` is absent or empty; then spawn the existing command exactly:

```bash
node scripts/migrate-data.mjs \
  --source-env SOURCE_DATABASE_URL \
  --target-env TARGET_DATABASE_URL \
  --target-database shensi
```

Pass the private environment through the child `env`, not command arguments. Require exit 0, an authenticated `*.migration-manifest.json`, an encrypted `*.sql.enc`, and a closed pre-upgrade verification report from `scripts/verify-data.mjs`. First validate the restored legacy source/target table sets, row counts, stable user/workspace IDs, acquisition IDs/statuses, financial-council IDs/statuses, model connection metadata, and aggregate ciphertext identity digests.

While only the target MySQL is running and before creating the read-only principal or starting Backend, invoke the action plan's versioned `desktop-outreach-action-bridge-v1` schema upgrader with the in-memory target admin URL. It must validate/resume each idempotent step, backfill historical action target `server` and the documented neutral binding/attempt defaults, preserve all legacy stable-field hashes, and record its schema version/hash. Run the post-upgrade preservation verifier: legacy table counts/stable-field/ciphertext hashes remain equal, the target-only schema additions exactly match the reviewed manifest, every new replay/journal table is empty, and a second upgrade is a no-op. Only that report may advance to `target_restored`; source `shensi_trial` remains on its original schema so pre-accept rollback remains viable.

- [x] **Step 5: Make failures recoverable without deleting data**

On any post-freeze failure, first atomically record the failure cause/evidence and enter `recovery_pending` for the same attempt without claiming `activeRuntime:"trial"`. Stop the failed target project without `--volumes`; stop only the retained Trial MySQL process through its owned PID record when an exact restart requires it; ask the explicit Trial adapter to idempotently restore the full Trial runtime against the unchanged Trial datadir; and verify `http://127.0.0.1:5608/api/health` reports MySQL and the original `test` login succeeds. Only after those proofs pass may one atomic state write set both attempt and top-level state to `failed_recovered`, set `activeRuntime:"trial"`, and bind the recovery-evidence hash. A crash leaves `recovery_pending`; re-running `api:migration:run` resumes only this recovery path from the persisted attempt/journal and never repeats backup/restore or creates a new attempt. Never reuse the failed target project. A retry is legal only after the final recovery proof and creates a new attempt/project/volume before returning to `prepared`.

- [ ] **Step 6: Run tests, review the preflight, and request the operational gate**

```bash
node --test scripts/api-only-runtime.test.mjs scripts/lib/process-ownership.test.mjs \
  scripts/trial-cutover-adapter.test.mjs scripts/task5-migration-runner.test.mjs \
  tools/data-migration-scripts.test.mjs
pnpm api:migration:preflight
git diff --check
```

Expected: tests exit 0 and preflight emits a redacted JSON summary with source `shensi_trial@127.0.0.1:3310`, target `shensi@127.0.0.1:3311`, exact writer PIDs/names, `legacyServerActions.count:0`, secret-file permissions, empty-verification evidence hash, and `authorized:false`. The executor must also attach passing hashes from the desktop outreach action bridge, desktop feature-parity Tasks 1, 2, 2A–2G, 3, and 4, and feature-parity Task 5 harness/unit tests. Only then may it present the summary and request separate operator authorization before running `pnpm api:migration:run`; the planning/implementation turn itself must not freeze Trial or migrate data.

- [ ] **Step 7: Run the authorized migration and record evidence**

After authorization, close `Shensi.app`, run `pnpm api:migration:run`, then run `node scripts/verify-data.mjs` with the same in-memory migration environment through the supervisor. Expected: state `target_restored`, Trial writers stopped, Trial MySQL still running on `3310`, target MySQL healthy on `3311`, Gateway `5608` still free, and the dated document records only artifact basenames, hashes, counts, stable non-sensitive IDs, status, and timestamps.

---

### Task 6: Enforce read-only cutover, bounded rollback, and irreversible write activation

**Files:**
- Create: `deploy/nginx/api-only-read-only.conf`
- Modify: `deploy/nginx/api-only.conf`
- Create: `backend/src/runtime-read-only.ts`
- Create: `backend/src/runtime-read-only-test.ts`
- Modify companion action-bridge file: `backend/src/desktop-client-admission.ts`
- Modify companion action-bridge test: `backend/src/desktop-client-admission-test.ts`
- Modify: `deploy/compose.api-only.yaml`
- Modify: `backend/src/server.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `scripts/api-only-runtime.mjs`
- Modify: `scripts/api-only-runtime.test.mjs`
- Modify: `package.json`
- Modify: `docs/migration/2026-09-03-shensi-trial-to-api-only.md`

**Interfaces:**
- Export `cutoverTrialToApiOnly(repositoryRoot, options)`, `rollbackApiOnlyCutover(repositoryRoot, options)`, `prepareApiOnlyAcceptanceToken(repositoryRoot, options)`, `acceptApiOnlyCutover(repositoryRoot, options)`, and `resumeApiOnlyWriteActivation(repositoryRoot, options)`.
- Top-level/attempt states add `write_activation_pending`. `api:cutover` is allowed only from `target_restored`; `api:rollback` only from `cutover_read_only`; first-use `api:accept` only from `cutover_read_only` with fresh evidence and an unconsumed one-use confirmation; `api:accept:resume` only from `write_activation_pending` with the same persisted attempt, engine, network, build, fingerprint, transformer, and evidence records and without accepting any token. Entering `write_activation_pending` records `rollbackClosedAt` before any write-capable process starts, permanently closes Trial rollback, and may only move forward to terminal `accepted`.
- `cutover_read_only` is an enforced runtime mode, not a label: the Gateway permits `GET`/`HEAD` plus exact stateless `POST /api/auth/login` and `POST /api/auth/logout`; Backend sets `SHENSI_RUNTIME_READ_ONLY=true`, skips every scheduler/worker/sweeper, and rejects every other mutating request; its MySQL principal has only `SELECT` and `SHOW VIEW` on `shensi`.
- The read-only login path verifies passwords without persisting a hash upgrade. Preflight requires the acceptance account's hash already use the current algorithm so the normal post-accept login does not depend on a migration-time upgrade.
- `api:cutover` starts the retained migration project on `5608` with `backend.read-only.env` and the read-only Gateway config; it never copies a MySQL datadir and never changes `desktop-config.json`.
- API acceptance deliberately does not admit an installed desktop build. `write_activation_pending` and terminal `accepted` persist `desktopClientAdmission:{ mode:"migration_locked", admittedBuildManifestSha256:null }`; normal business mutation and every desktop enrollment/binding/action route remain closed to all Apps until the later joint milestone atomically opens exactly its candidate digest. Login/logout and reads follow the ordinary API policy. `/Applications/Shensi.app` is stale/untrusted in this bounded interval even though the API-only Backend itself is write-capable for private supervisor acceptance and later migration coordination.
- Before terminal `accepted` is exposed, the acceptance coordinator writes and fsyncs an immutable initial accepted-version record plus an atomic active-version pointer. That record binds the accepted Backend image digest, Gateway/config hash, resolved Compose and engine/project/network identities, accepted-live schema hash, API-contract hash, the exact locked desktop admission, and the sealed Task 5 recovery-seed-candidate receipt; it does not claim that the stale installed App is active. After this pointer exists, it is the exclusive restart authority. `migration-state.json` remains the migration/rollback journal and may identify the accepted attempt, but it never independently selects post-accept runtime bytes.

- [ ] **Step 1: Write red read-only boundary and worker-quiescence tests**

Test the pure Backend policy, server middleware, and acquisition composition. In read-only mode, health, login/logout, and authenticated reads work; register, profile/deal/todo/campaign/action mutations return the exact read-only error before a repository call; password verification never upgrades/persists; no acquisition, prospect, finance, scheduler, recovery, or outreach worker starts. Test the read-only nginx config against every HTTP method and prove no encoded/alternate auth path bypass. Test target grants contain only `SELECT` and `SHOW VIEW`, with no DML/DDL/grant privilege. Separately prove the normal Gateway and Backend in `migration_locked` reject a mutation or any desktop installation/binding/action request regardless of a missing, Task 5, stale installed, candidate, duplicate, or forged build-digest header, while allowing only the existing login/logout/read paths. The rejection must happen before a repository call.

- [ ] **Step 2: Write red state-machine and crash-boundary tests**

Assert every invalid transition fails with a stable code. Cutover ordering is exact:

1. confirm Trial writers remain stopped and source MySQL is owned/healthy;
2. confirm target migration report, selected network/engine, and secret fingerprints still match;
3. while the target Backend is offline, require the recorded `desktop-outreach-action-bridge-v1` version/hash and post-upgrade preservation report, prove an upgrader rerun is a no-op, provision/rotate the target-only read principal, verify its grants, and capture a target data fingerprint;
4. stop source MySQL by its owned PID record and prove `3310` is released;
5. start target MySQL/Backend/Gateway with the read-only principal, `SHENSI_RUNTIME_READ_ONLY=true`, all action-execution flags false, and `api-only-read-only.conf`;
6. prove health, login-mode Task 3 reads, mutation denial, zero worker inventory, read-only grants, and an unchanged target fingerprint;
7. atomically advance to `cutover_read_only`.

Inject a failure after each step. Before `write_activation_pending`, recovery stops API-only without deleting its volume and restarts Trial. A stale PID, mismatched report hash, missing key fingerprint, engine/network change, occupied `5608`, writable DB grant, running worker, successful mutation probe, or changed fingerprint fails before the read-only state can be recorded.

- [ ] **Step 3: Write red rollback and write-activation tests**

Rollback must stop API-only with the pinned resolved Compose runtime's `stop`, prove `5608/3311` released, restart Trial from retained datadir/secrets, verify Trial login/MySQL, retain target volume/backups/reports, and persist `rolled_back` with `activeRuntime:"trial"`. A retry creates a new attempt.

Acceptance requires matching current-source app/content/embedded-build manifest, sealed Task 5 recovery-seed-candidate evidence, read-only API and cold-start evidence, zero non-terminal desktop actions, and the action bridge fault-matrix hash. Its exact order is:

1. consume the one-use confirmation and stop the read-only target;
2. recheck target fingerprint and all evidence;
3. atomically write `write_activation_pending`, `activeRuntime:"target"`, `rollbackClosedAt`, and `desktopClientAdmission:{ mode:"migration_locked", admittedBuildManifestSha256:null }`—after this point Trial rollback is forbidden;
4. select write-capable `backend.env` and normal `api-only.conf`, enable desktop execution only through the action plan's guarded transformer, keep server execution false, and encode the same locked admission in both Backend and Gateway snapshots;
5. start the target and prove health, expected worker inventory, matching locked admission, mutation/device-action denial for every App build digest, and Gateway policy;
6. use only the supervisor's non-exported in-process acceptance capability—not a public HTTP header, Renderer session, or desktop device route—to run one run-scoped non-platform create/read/delete acceptance record, confirm no platform action was claimed, bind the exact sealed Task 5 recovery-seed candidate evidence to the resulting accepted Backend image/Gateway config/API-contract/accepted-live-schema/locked-admission tuple, write/fsync the immutable initial accepted-version record and atomic active-version pointer for that tuple, then atomically mark `accepted` while retaining locked admission.

A failure after Step 3 remains `write_activation_pending` and is recovered forward only by idempotent `api:accept:resume`/`resumeApiOnlyWriteActivation`; it never starts Trial and never asks for, consumes, or recreates an acceptance token. Recovery reconciles a partially written initial version record/pointer by exact hash and never mints a different version ID. Replaying the original consumed-token `api:accept` request returns the recorded result only if the attempt and evidence hashes match; a lost response before `write_activation_pending` is resolved from the persisted token-consumption record and may neither consume a second token nor skip evidence checks.

- [ ] **Step 4: Implement the two-layer read-only runtime and rollback**

Provision `shensi_readonly` using a generated owner-only `mysql_readonly_password` secret after schema verification. Generate `backend.read-only.env` from `backend.env` by replacing only the database principal and locked runtime/action flags. Make Compose accept an owner-validated absolute Gateway config path. Reuse the neutral process-ownership helper and resolved Compose status; never signal an unverified PID, invoke Compose `down`, remove a volume, or delete source state. Fingerprint the selected tables/row counts/stable-ID/ciphertext aggregates before and after every read-only run.

- [ ] **Step 5: Implement safe acceptance-token creation and forward-only activation**

Add `api:accept:prepare` as a supervisor-owned command. It creates an unpredictable file inside the validated `0700` acceptance directory using exclusive/no-follow semantics (`O_CREAT|O_EXCL`, and `O_NOFOLLOW` where supported), writes/fsyncs random bytes with mode `0600`, fsyncs the directory, and outputs only the absolute path plus evidence digest. Reject collisions, symlinks, command-line token values, loose permissions, files outside the runtime, and reused confirmations. `api:accept` deletes the exact owned token after consumption and records only its SHA-256 digest.

- [ ] **Step 6: Run the state and enforcement gates green**

```bash
node --test scripts/container-runtime.test.mjs scripts/api-only-runtime.test.mjs
pnpm --dir backend exec node --import tsx --test --test-concurrency=1 src/runtime-read-only-test.ts
node -e 'const p=require("./package.json"); for (const n of ["api:cutover","api:rollback","api:accept:prepare","api:accept","api:accept:resume"]) if (!p.scripts[n]) process.exit(1)'
git diff --check
```

Expected: injected pre-accept crash points either remain truthfully `recovery_pending` or atomically expose a verified `failed_recovered` plus `activeRuntime:"trial"`; post-commit failures remain forward-only on target; read-only tests make zero durable mutations and start zero workers; accepted-state tests prove stale Apps cannot mutate or claim before the joint milestone; no test invokes a real container engine or signals a real PID.

- [ ] **Step 7: Execute the separately authorized read-only cutover after both companion gates pass, but do not accept writes yet**

Run:

```bash
pnpm api:cutover
pnpm api:status
SHENSI_INSTALLED_APP_PATH=/exact/task5-run/Shensi.app pnpm api:verify
node desktop/scripts/verify-package.mjs /exact/task5-run/Shensi.app development
```

Replace `/exact/task5-run/Shensi.app` with the manifest-bound path produced by feature Task 5. Expected: exactly target MySQL, read-only Backend, and read-only Gateway are healthy; state is `cutover_read_only`; mutation probes are denied; data fingerprint is unchanged; desktop execution is false; no Trial writer, frontend, tunnel, Sidecar, remote display, or background write worker runs. Only while state remains `cutover_read_only`, a failure uses `pnpm api:rollback`; after entry to `write_activation_pending`, recovery is forward-only through `api:accept:resume`.

---

### Task 7: Verify the installed app points to `5608` and the migrated API serves every module

**Files:**
- Modify: `scripts/api-only-runtime.mjs`
- Modify: `scripts/api-only-runtime.test.mjs`
- Modify companion package verifier: `desktop/scripts/verify-package.mjs`
- Modify companion acceptance coordinator: `scripts/desktop-acceptance-evidence.mjs`
- Modify companion visible route adapter: `desktop/scripts/installed-app-route-acceptance.mjs`
- Modify: `docs/migration/2026-09-03-shensi-trial-to-api-only.md`

**Interfaces:**
- Export `verifyInstalledDesktopConfig(appPath, options)` and `verifyApiOnlyRuntime(repositoryRoot, options)`.
- Default application path is `/Applications/Shensi.app`; the only override is the absolute `SHENSI_INSTALLED_APP_PATH` environment value.
- The installed resource must parse as the exact JSON object `{ "remoteOrigin": "http://127.0.0.1:5608" }`; missing keys, extra keys, credentials, paths, fragments, non-loopback hosts, HTTPS, or a different port fail.
- The selected App must also contain the strict canonical `desktop-build-manifest.json`; `api:verify` receives its recomputed SHA-256 from the package verifier and never trusts a CLI-supplied digest. In `cutover_read_only` this identifies the exact Task 5 acceptance App while all writes are denied; in `accepted` before a joint milestone it must prove active admission remains `migration_locked` with no admitted digest.
- `api:verify` combines installed-config validation, canonical Backend and desktop source-content-manifest/image/app hashes, Compose/service health, enforced runtime mode, gateway boundary checks, login-mode all-module smoke, migration artifact/hash checks, and a check that no forbidden Trial/Web/remote-display process is owned by the current runtime.

- [ ] **Step 1: Write red installed-config tests**

Use temporary `.app/Contents/Resources/desktop-config.json` and `desktop-build-manifest.json` fixtures. Cover the exact valid config and canonical manifest with normal packaged mode `0644`; reject either missing file, invalid JSON, extra fields, `localhost`, `0.0.0.0`, a `trycloudflare.com` origin, `5609`, query/fragment, symlinked resources, group/world-writable files (`mode & 0o022 !== 0`), non-canonical manifest bytes, or a manifest/package digest mismatch. Assert error messages contain no app login password or token.

- [ ] **Step 2: Write red aggregate verification tests**

Assert `verifyApiOnlyRuntime()` refuses a healthy API when the installed config/build identity is wrong, any module is non-200/wrong shape, `/` or a forbidden route is non-404, an upgrade is `101`, Backend reports a non-MySQL store, Compose has an unexpected service, migration report hashes differ, or the active project differs from migration state. In `accepted` before the joint milestone, reject any active admission other than exactly `migration_locked` with a null digest and prove stale/Task 5/candidate headers all fail mutation/device-action probes. Its success report contains statuses and hashes only.

- [ ] **Step 3: Implement installed and aggregate verification**

Read the exact app selected by `SHENSI_INSTALLED_APP_PATH` (default `/Applications/Shensi.app`) and its `Contents/Resources/desktop-config.json` plus `desktop-build-manifest.json` directly; this verification command itself must not rebuild, repackage, or regenerate a DMG. Recompute the embedded canonical-file digest and have `verify-package.mjs` prove its fields and external manifest binding. For migration acceptance, require the feature-parity Task 5 run-scoped `.app` manifest to match the current canonical `desktop-app` content-manifest hash (covering relevant tracked, modified, and untracked inputs) and pass that path explicitly, preventing an older or incompletely hashed bundle from satisfying the gate. Require the fresh `backend-runtime` content-manifest hash to equal the active build record's `sourceManifestHash`, and require the running Backend image's immutable ID/digest to equal that record's `imageIdDigest`; never compare the source hash directly with the image digest. Authenticate with `test@shensi.local` and the private `smoke_login_password`, keep credentials only in memory, and run every Task 3 route. Do not invoke any provider-connection test endpoint or any Douyin login/action endpoint. Before the final joint milestone, an accepted-runtime success also requires locked client admission; it never temporarily admits the selected test App.

- [ ] **Step 4: Run focused tests and real API verification**

```bash
node --test scripts/api-only-runtime.test.mjs
SHENSI_INSTALLED_APP_PATH=/exact/task5-run/Shensi.app pnpm api:verify
node desktop/scripts/verify-package.mjs /exact/task5-run/Shensi.app development
git diff --check
```

Replace `/exact/task5-run/Shensi.app` with the absolute path in the Task 5 manifest; never use the verifier's legacy default for this gate. Expected: installed origin is exactly `http://127.0.0.1:5608`; health/API checks pass; all module reads return their required shapes; forbidden routes are 404; package/source hashes match; reports contain no secret values.

- [ ] **Step 5: Perform the installed-app read-only acceptance**

With migration state still exactly `cutover_read_only`, set `SHENSI_INSTALLED_APP_PATH` to the feature-parity Task 5 run-scoped current-source `.app` and run the sole owner coordinator once:

```bash
SHENSI_INSTALLED_APP_PATH=/exact/task5-run/Shensi.app \
pnpm desktop:acceptance:seal -- \
  --app-manifest /exact/task5-run/app-manifest.json \
  --sha256 <exact-hash>
```

Replace every placeholder with the manifest-bound absolute path/hash; never use `/Applications/Shensi.app` or a newest-file lookup. The coordinator—not the operator—creates the run nonce and invokes the before package/API/cold-start checks, opens the exact App visibly, authenticates with the existing acceptance account held only in child memory, walks and verifies every canonical route/heading/API response through the current Renderer, allows observation or cancellation, closes the App/helpers, repeats package/API/cold-start, and seals the immutable Task 5 receipt. It performs no create/edit/approve/comment/message/provider/Douyin operation. It rejects caller-supplied report or route-result paths and emits no success receipt unless both API reports and the complete command-owned route result pass against the unchanged migration/App/service/schema/contract identities. Record only the receipt hash and sanitized route/status summary in the migration document. This does not replace or mutate `/Applications/Shensi.app` and creates no DMG/ZIP.

- [ ] **Step 6: Explicitly accept the target after review**

Only after the operator reviews the migration evidence, both live cold-start reports, installed-app read-only pass, desktop outreach action bridge evidence, and desktop feature-parity Tasks 1, 2, 2A–2G, 3, 4, and 5 evidence, run:

```bash
pnpm api:accept:prepare
SHENSI_API_ACCEPT_TOKEN_FILE=/exact/owner-only/path/printed/above pnpm api:accept
```

Do not construct or write the token file with shell redirection. Expected: state passes through durable `write_activation_pending` to healthy `accepted`, the token file is removed, Trial data and backups remain untouched, future `pnpm api:rollback` is rejected, and `desktopClientAdmission` remains exactly locked with no admitted digest. `/Applications/Shensi.app` and the Task 5 App may authenticate/read when otherwise allowed but cannot mutate, enroll/bind, claim, complete, or reconcile until the final joint promotion. If activation fails after rollback closure, run exactly `pnpm api:accept:resume`; do not rerun first-use `api:accept`, create another token, or start Trial.

---

### Task 8: Synchronize current documentation and run the final non-destructive gate

**Files:**
- Modify: `README.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/DATA_MIGRATION.md`
- Create: `docs/operations/api-only-runtime.md`
- Modify: `docs/migration/2026-09-03-shensi-trial-to-api-only.md`

**Interfaces:**
- Current-document activation in this task is blocked until migration state is durably `accepted` and the accepted runtime verifier passes. Before that point, only dated/staged migration documentation may be prepared; README and current operator runbooks must continue to identify the actual Trial/Web runtime.
- `README.md` identifies the desktop Renderer/App as the only user UI and `pnpm api:start|stop|status|verify` as the current local center-runtime commands, while making clear that the stale installed `/Applications/Shensi.app` is not admitted until the later joint milestone.
- `docs/operations/api-only-runtime.md` is the executable operator entry point for startup, verification, incident-safe stop, `cutover_read_only` rollback, `write_activation_pending` resume, terminal-accepted forward recovery, and log/evidence locations.
- `docs/DATA_MIGRATION.md` names the actual source `shensi_trial`, target `shensi`, ports `3310/3311`, encrypted toolchain, secret-preservation rule, and rollback boundary. Remove the stale `shensi_sales` current-state narrative from the default procedure; retain dated historical evidence only in dated migration documents.
- The dated migration record contains real command results and hashes but no credential, token, database URL, customer row, model prompt/output, provider content, or secret value.

- [ ] **Step 1: Write a red documentation contract in the runtime test**

Assert the current docs contain `Shensi.app`, `api:start`, `api:verify`, `shensi_trial`, `shensi`, `127.0.0.1:5608`, legacy `DOUYIN_OUTREACH_ACTIONS_ENABLED=false`, the three split approval/server/desktop flags, `desktopClientAdmission=migration_locked`, and the exact rule that only `cutover_read_only` permits Trial rollback while `write_activation_pending|accepted` are forward-only. They must say action-bridge service capability is deployed but no App can mutate or claim until the exact final build is admitted. Assert the API-only operator document does not instruct users to start a frontend, tunnel, MediaCrawler, noVNC, VNC, Xvfb, websockify, `/live-sessions`, Railway, or `docker compose down --volumes`.

- [ ] **Step 2: After verified acceptance, update current docs as current truth**

Revalidate exact state `accepted` and the persisted `{ mode:"migration_locked", admittedBuildManifestSha256:null }` immediately before editing. Describe daily development as `pnpm api:start` plus `pnpm desktop:dev`, identify action-bridge server capability as deployed but App mutation/action claim as deliberately locked, and identify installed-app use as unavailable during the bounded final-migration window until the later joint milestone is finalized; `/Applications/Shensi.app` remains closed/untrusted in that interval. State that ordinary code changes rebuild Renderer/Main only and do not produce a new DMG. Keep Alibaba Cloud explicitly deferred until resources exist. Link this plan's sibling `docs/superpowers/plans/2026-09-03-shensi-desktop-feature-parity-and-web-retirement.md` for deeper UI route parity and later Web artifact retirement; state that Web/noVNC source retirement is pending and do not claim those later cleanup tasks are complete here.

- [ ] **Step 3: Run the focused API-only and migration gates**

```bash
node --test scripts/api-only-runtime.test.mjs tools/data-migration-scripts.test.mjs
pnpm api:status
SHENSI_INSTALLED_APP_PATH=/exact/task5-run/Shensi.app pnpm api:verify
node desktop/scripts/verify-package.mjs /exact/task5-run/Shensi.app development
```

Replace `/exact/task5-run/Shensi.app` with the exact acceptance-manifest path. Expected: tests exit 0; `api:verify` reads the owner-validated persisted subnet/gateway/env/config paths and resolves `compose config` through the pinned engine, so no shell reconstructs runtime-only network values. Status/verify identify exactly the active migration project and three healthy services, and package verification proves the explicitly selected app rather than a stale default.

- [ ] **Step 4: Run repository regression gates**

```bash
pnpm test:contracts
pnpm --filter ./backend test
pnpm --filter ./frontend test
pnpm --dir desktop test
pnpm --dir desktop typecheck
pnpm build
git diff --check
```

Expected: all exit 0. A failure caused by a pre-existing dirty-worktree change is recorded with its exact command/output and owner; do not overwrite unrelated work to force green.

- [ ] **Step 5: Review the final change boundary**

Run:

```bash
git status --short
git diff -- deploy/compose.api-only.yaml deploy/nginx/api-only.conf scripts/api-only-runtime.mjs scripts/api-only-runtime.test.mjs package.json .gitignore README.md docs/DEPLOYMENT.md docs/PROJECT_STATUS.md docs/DATA_MIGRATION.md docs/operations/api-only-runtime.md docs/migration/2026-09-03-shensi-trial-to-api-only.md tools/data-migration-scripts.test.mjs
git diff --check
```

Expected: only the reviewed API-only runtime, migration test, package-script, ignore, and documentation paths are part of this plan's implementation diff; all unrelated dirty files remain byte-for-byte untouched. Do not stage or commit.

---

### Task 9: Audit and separately purge abandoned migration target volumes

**Files:**
- Modify: `scripts/api-only-runtime.mjs`
- Modify: `scripts/api-only-runtime.test.mjs`
- Modify: `package.json`
- Modify: `docs/operations/api-only-runtime.md`
- Modify: `docs/migration/2026-09-03-shensi-trial-to-api-only.md`

**Interfaces:**
- Produces read-only `pnpm api:migration:gc:audit`, one-use-confirmation `pnpm api:migration:gc:prepare`, and destructive `pnpm api:migration:gc:purge`.
- The audit reports reclaimable bytes but changes nothing. Purge accepts only the exact candidate-set hash printed by a fresh audit and a `0600` no-follow one-use token bound to that hash.
- Before the first resource deletion, purge writes/fsyncs an owner-only `gc_purge_pending` journal with the full ordered candidate/resource mapping and atomically consumes the token to a durable tombstone. Each candidate advances through an atomic per-item pending/completed record; only a fully reconciled journal may be sealed into the immutable purge receipt. A same-hash retry resumes from the journal/tombstone and never mints another token.

- [ ] **Step 1: Write red GC classification and ownership tests**

Only projects matching `^shensi-api-migration-[a-f0-9]{12}$` whose persisted attempt is `failed_recovered` or `rolled_back` may be candidates. Require matching engine/socket identity, project/network/volume Compose labels, runtime nonce, stopped containers, no active-project/state/evidence reference, and an existing verified encrypted source backup plus final target fingerprint. Reject the accepted/active target, every `prepared|source_frozen|target_restored|cutover_read_only|recovery_pending|write_activation_pending` attempt, Trial project/datadir/secrets, disposable test resources, Web-retirement staging, Electron Profiles, backups/evidence, symlinks, unknown labels, foreign volumes, and broad roots. Inject crashes before/after journal creation, before/after token tombstoning, immediately before/after each candidate deletion call, after partial engine removal, after absence verification, and before final receipt sealing. Retry must reconcile exact labels/IDs against that candidate's pending record; unknown, recreated, or foreign resources fail closed and preserve the journal/evidence.

- [ ] **Step 2: Implement dry-run, confirmation, and bounded purge**

`gc:audit` canonicalizes the candidate list and hashes project, volume, engine, nonce, terminal state, size, and evidence references. `gc:prepare` revalidates that list and creates an exclusive owner-only token in the API-only acceptance area. `gc:purge` acquires the owner lock, revalidates the exact set, writes/fsyncs `gc_purge_pending` with every ordered project/container/network/volume ID and initial state, atomically moves the token to a consumed tombstone, and fsyncs the containing directory before the first engine mutation. For each item it first atomically marks that exact candidate `deletion_pending`, invokes the pinned Compose runtime only for that exact stopped candidate with `down --volumes --remove-orphans`, reconciles partial engine outcomes, verifies only its labeled resources disappeared, and atomically marks the item completed. After all items are complete it retains state/evidence/backup metadata and seals a non-secret purge receipt. Any pre-journal mismatch stops before mutation; after journal creation, the same invocation and candidate-set hash resumes from the journal plus consumed tombstone without a new token. Unknown topology enters fail-closed manual recovery and never broadens the deletion set.

- [ ] **Step 3: Run safety tests and audit only**

```bash
node --test scripts/api-only-runtime.test.mjs
pnpm api:migration:gc:audit
git diff --check
```

Expected: tests pass and audit is read-only. Do not run `gc:prepare` or `gc:purge` without a later explicit review of the exact projects/volumes/bytes. Ordinary failed migration recovery never auto-deletes a target.

## Plan Completion Gate

This plan is complete only when the disposable empty-database gate, the desktop action-bridge fake/fault gate, the feature pre-cutover gate (Tasks 1, 2, 2A–2G, 3, 4, plus Task 5 harness/unit tests), encrypted `shensi_trial -> shensi` verification, canonical `5608` gateway boundary, authenticated all-module smoke, installed-app read-only pass, and post-accept API verification all pass with retained recovery evidence. Task 9 implementation and read-only audit must pass, but destructive GC remains a separately authorized storage-reclamation operation. Acceptance ends executable rollback to the Trial source. Trial PID/log/tunnel/frontend-release artifacts and current Web/noVNC source remain until the sibling retirement plan proves their exact eligibility and receives separate authorization. The Trial MySQL datadir and secrets, encrypted backups/manifests, migration reports/evidence, target data, and Electron Profiles are protected recovery/forensic assets outside that retirement plan's deletion authority. Alibaba Cloud and real multi-Mac acceptance remain deferred until those resources exist.

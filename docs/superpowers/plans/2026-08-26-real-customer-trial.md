# Real Customer Trial Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the latest Shensi frontend, backend and Douyin MediaCrawler integration as one isolated, real customer trial while showing every developed module truthfully.

**Architecture:** One dedicated local stack binds MySQL, MediaCrawler, backend, frontend and a same-origin gateway to `3310`, `5612`, `5611`, `5610` and `5608`. A Cloudflare Quick Tunnel publishes only the gateway. Trial-only frontend configuration maps the user-facing alias to a canonical tenant-admin email; preview modules stay visible and self-identify, while real external Douyin actions remain fail-closed until live acceptance.

**Tech Stack:** TypeScript, Node.js 22, Vite, Express, MySQL 8.4, Python 3.11+, FastAPI, Playwright, MediaCrawler, Cloudflare Quick Tunnel.

**Spec:** `docs/operations/real-customer-trial.md`

## Global Constraints

- Use only `/Users/mac/Documents/新项目/shensi/.worktrees/douyin-mediacrawler-acquisition` at commit `78ebc17` or its descendants.
- Do not modify or stop the existing services on `3307`, `5488`, `5492`, `5588` or `5590` until the new trial passes acceptance.
- Bind the new MySQL, gateway, frontend, backend and MediaCrawler services to `127.0.0.1:3310`, `127.0.0.1:5608`, `127.0.0.1:5610`, `127.0.0.1:5611` and `127.0.0.1:5612` respectively.
- Show every developed frontend module. Preview/local-only surfaces must remain clearly identified and must not claim live channel actions.
- The application login alias is `test`, the canonical backend email is `test@shensi.local`, the user is a tenant `admin`, and no customer receives `super_admin`.
- Never commit or print a password, provider key, JWT key, database key, service key, encrypted profile or crawl output.
- Do not reuse the previously pasted DeepSeek key or any credentials from another environment.
- Douyin manual-keyword collection must not require public-search or AI provider connections.
- External Douyin comments and direct messages default disabled and remain disabled for this launch.
- Test-first is mandatory for production code changes. Each new behavior must be observed failing for the intended reason before implementation.
- The public tunnel publishes only the gateway; backend, MySQL and MediaCrawler remain loopback-only.

---

### Task 1: Complete trial frontend surface and login alias

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/src/app-session.ts`
- Modify: `frontend/src/app-session.self-test.ts`
- Modify: `frontend/src/app-route.ts`
- Modify: `frontend/src/app-route.self-test.ts`
- Modify: `frontend/src/demo/demo-types.ts`
- Modify: `frontend/src/demo/demo-router.ts`
- Modify: `frontend/src/demo/demo-capabilities-view.ts`
- Modify: `frontend/src/demo/demo-app.ts`
- Modify: `frontend/src/demo/demo-conversations-view.ts`
- Modify: `frontend/src/demo/demo-conversion-view.ts`
- Modify: `frontend/src/demo/demo-store.self-test.ts`
- Modify: `frontend/src/demo/demo.css`
- Modify: `frontend/src/replica-dashboard.css`
- Modify: `frontend/src/self-test.ts`
- Modify: `frontend/src/growth/entry.ts`
- Modify: `frontend/src/growth/entry.self-test.ts`

**Interfaces:**
- Consumes: `VITE_REAL_TRIAL=true`, `VITE_TRIAL_LOGIN_ALIAS` and `VITE_TRIAL_LOGIN_EMAIL`; all three must be present before mapping is enabled.
- Produces: `resolveLoginIdentity(value: string, aliases: Readonly<Record<string, string>>): string`; visible sidebar links for every Growth route; a working `#dashboard` route; explicit preview labels on local-only modules.

- [ ] **Step 1: Write the failing login-alias tests**

  Add a real-controller test that passes `{ realTrial: true, loginAlias: "test", loginEmail: "test@shensi.local" }`, calls `login("test", password)`, parses the outgoing JSON body, and asserts the literal canonical email. Add assertions that ` TEST ` maps, unrelated emails remain unchanged, `test1`/`tester` do not map, disabled trial mode does not map, and enabled mode with incomplete canonical configuration rejects before making a network request.

- [ ] **Step 2: Run the frontend test and confirm RED**

  Run `pnpm --filter ./frontend test` outside the filesystem sandbox if the `tsx` IPC pipe is denied. Expected failure: `loginAliases` is not accepted and the submitted body still contains `test`.

- [ ] **Step 3: Implement the minimal alias boundary**

  Extend `AppSessionOptions` with injectable real-trial alias fields. Normalize only the login identifier with trim/lowercase and exact lookup; never alter the password. Build the default mapping only when `VITE_REAL_TRIAL=true` and both `VITE_TRIAL_LOGIN_ALIAS` and `VITE_TRIAL_LOGIN_EMAIL` are non-empty. Enabled-but-incomplete configuration fails closed before fetch. Change the login input from browser-enforced `type="email"` to a username-compatible text input while retaining `autocomplete="username"` and a bounded length.

- [ ] **Step 4: Write failing complete-navigation tests**

  Assert that `#dashboard` remains `#dashboard`, that `DemoModule` routing can select it, and that the sidebar exposes literal links for `#growth/advisor`, `#growth/catalog`, `#growth/quotes`, `#growth/finance`, `#growth/roi` and `#financial-council`. Assert that local-only dashboard/automation/overseas surfaces include the visible label `预览 · 待接入`.

- [ ] **Step 5: Run the frontend test and confirm RED**

  Run `pnpm --filter ./frontend test`. Expected failures: `#dashboard` normalizes to `#agents`, Growth links are not in the visible sidebar, and the preview label is absent.

- [ ] **Step 6: Implement the complete visible surface**

  Add `dashboard` to `DemoModule`, standalone hashes and `demoModuleMeta`; render a deterministic overview from the existing `DemoState` totals without inventing live API results. Place Growth route links inside the visible sidebar and synchronize their active state in `growth/entry.ts`; use route-specific page titles. Preserve all nine existing primary navigation entries and keep real acquisition accessible. A direct `#growth/quotes` visit without a case renders a customer-readable empty state rather than `quote_case_required`. Use `预览 · 待接入` on local-only surfaces; retain the real-mode labels for connected modules.

- [ ] **Step 7: Verify frontend GREEN**

  Run `pnpm --filter ./frontend test && pnpm --filter ./frontend test:types`. Expected: both commands exit `0`.

### Task 2: Isolate MediaCrawler output and fail-close external actions

**Files:**
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-application-test.ts`
- Modify: `backend/src/server.ts`
- Modify: `backend/src/douyin-mediacrawler-real-e2e-server-test.ts`
- Modify: `services/media-crawler/shensi_adapter/app.py`
- Modify: `services/media-crawler/shensi_adapter/crawl_jobs.py`
- Modify: `services/media-crawler/tests/shensi_adapter/test_contracts.py`
- Modify: `services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py`
- Modify: `services/media-crawler/.env.example`

**Interfaces:**
- Consumes: `MEDIACRAWLER_OUTPUT_ROOT` as an absolute owner-controlled directory and `MEDIACRAWLER_EXTERNAL_ACTIONS_ENABLED` as the only external-action enable flag.
- Produces: `deployment_external_actions_enabled() -> bool`; `readMediaCrawlerExternalActionsEnabled(environment) -> boolean`; `CreateAcquisitionApplicationOptions.outreachExternalActionsEnabled`; `MediaCrawlerRunner(..., output_root: Path | None = None)` whose creation and cleanup use the same resolved output root.

- [ ] **Step 1: Write the failing custom-output test**

  Construct `MediaCrawlerRunner(headless=False, service_root=service_root, output_root=tmp_path / "trial-output")`, execute a completed fake job, and assert its attempt directory is below `trial-output/<job-id>` and no `.shensi-crawl-output` directory appears below `service_root`.

- [ ] **Step 2: Run the focused crawler test and confirm RED**

  Run `uv run --frozen --project services/media-crawler pytest -q services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py`. Expected failure: `MediaCrawlerRunner` does not accept `output_root`.

- [ ] **Step 3: Implement one resolved output root**

  Resolve `output_root` once in the constructor, defaulting to the existing source-local directory for backward compatibility. Use it for both attempt creation and `cleanup(job_id)`. The deployment factory must require and pass `MEDIACRAWLER_OUTPUT_ROOT` so production-like trial runs never use the source-local default.

- [ ] **Step 4: Write the failing action-gate tests**

  Verify `deployment_external_actions_enabled()` is false when unset, false for every value except case-insensitive `true`, and true for `true`. Exercise the deployment app factory with the default disabled state and assert an authenticated POST to `/internal/v1/douyin/actions/<id>` returns `503` without invoking an executor.

  In the backend application test, configure a MediaCrawler gateway with `outreachExternalActionsEnabled: false`, seed an approved action, wait beyond the worker interval, and assert the repository action remains unclaimed. In the server configuration test, assert the environment parser returns true only for literal case-insensitive `true`.

- [ ] **Step 5: Run the focused contract test and confirm RED**

  Run `uv run --frozen --project services/media-crawler pytest -q services/media-crawler/tests/shensi_adapter/test_contracts.py`. Expected failure: the enable function/gated deployment factory does not exist.

- [ ] **Step 6: Implement both fail-closed boundaries**

  Create the deployment `ActionJobManager` only when `MEDIACRAWLER_EXTERNAL_ACTIONS_ENABLED=true`; otherwise leave it `None` so the existing route returns `action_job_manager_unconfigured`. In the backend, keep crawler collection workers enabled but create neither the outreach recovery sweeper nor outreach action worker unless `outreachExternalActionsEnabled` is true. Server composition passes the parsed environment flag. Do not change injected `create_app(...)` test behavior or the default of direct application tests that explicitly exercise the worker.

- [ ] **Step 7: Verify sidecar GREEN**

  Run `uv run --frozen --project services/media-crawler pytest -q services/media-crawler/tests/shensi_adapter` and `pnpm --filter ./backend test:acquisition`. Expected: both commands exit `0`.

### Task 3: Add repeatable isolated trial runtime tooling

**Files:**
- Create: `scripts/real-trial-config.mjs`
- Create: `scripts/real-trial-config.test.mjs`
- Create: `scripts/real-trial-gateway.mjs`
- Create: `scripts/real-trial-gateway.test.mjs`
- Create: `scripts/real-trial-runtime.mjs`
- Create: `scripts/real-trial-runtime.test.mjs`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `SHENSI_TRIAL_RUNTIME_ROOT`, `SHENSI_TRIAL_MYSQL_BASEDIR`, `SHENSI_TRIAL_CLOUDFLARED`, and the one-time `SHENSI_TRIAL_APP_PASSWORD`; defaults bind only the ports in Global Constraints.
- Produces: `prepareTrialRuntime(root, options)`, `createTrialGateway(options)`, `startTrialRuntime(root, options)`, and package scripts `trial:prepare`, `trial:start`, `trial:status`, `trial:stop`.

- [ ] **Step 1: Write failing configuration and permission tests**

  Use a temporary directory to assert that preparation creates `0700` runtime/secret/state directories and `0600` newline-free files, generates distinct values of at least 32 bytes, emits a canonical encoded `DATABASE_URL`, and refuses an already occupied port. Assert logs expose names and paths but not secret contents.

- [ ] **Step 2: Run the runtime unit tests and confirm RED**

  Run `node --test scripts/real-trial-config.test.mjs scripts/real-trial-runtime.test.mjs`. Expected failure: the modules do not exist.

- [ ] **Step 3: Implement deterministic preparation**

  Generate missing secrets with `randomBytes(48).toString("base64url")` and preserve existing secret files on repeat runs. Create `.runtime/real-trial` under the repository by default and ignore `.runtime/`. Write a `0600` environment file containing the required production variables, `CRM_STORE=mysql`, `CRM_SEED_DEVELOPMENT_DATA=false`, `SESSION_COOKIE_SECURE=true`, the five fixed ports, `VITE_REAL_TRIAL=true`, the two alias fields, `MEDIACRAWLER_BROWSER_HEADLESS=false`, `MEDIACRAWLER_BROWSER_CHANNEL=chrome`, `MEDIACRAWLER_EXTERNAL_ACTIONS_ENABLED=false`, and the dedicated output/profile paths. Never serialize the public URL until a tunnel is obtained.

- [ ] **Step 4: Write failing gateway behavior tests**

  Start two temporary HTTP upstreams and the gateway on ephemeral ports. Assert `/api/health` reaches the backend, `/` reaches the frontend, cookies and `x-csrf-token` survive, `x-forwarded-proto` is exactly `https`, unsupported MediaCrawler/internal paths are never routed to a sidecar, and `/healthz` is gateway-owned.

- [ ] **Step 5: Run the gateway test and confirm RED**

  Run `node --test scripts/real-trial-gateway.test.mjs`. Expected failure: the gateway module does not exist.

- [ ] **Step 6: Implement the transparent same-origin gateway**

  Use `node:http`; choose the backend only for `/api` and `/api/*`, otherwise choose the frontend. Stream request/response bodies, preserve status and safe headers, set `x-forwarded-for`, `x-forwarded-host` and `x-forwarded-proto=https`, remove hop-by-hop headers, and return sanitized `502` responses without upstream internals.

- [ ] **Step 7: Write failing lifecycle tests**

  Inject fake `spawn`, port checks, health polling and tunnel-output streams. Assert the runtime starts MySQL first, obtains the Quick Tunnel HTTPS origin before starting the backend, injects that exact origin into `CORS_ORIGINS`, starts only loopback listeners, provisions `test@shensi.local` as role `admin` in `trial-pilot-001`, writes PID/log metadata, and terminates only recorded child processes on stop.

- [ ] **Step 8: Implement the lifecycle supervisor**

  Initialize MySQL 8.4 with `--initialize-insecure` only for a new dedicated data directory, launch it with `--no-defaults`, create `shensi_trial` and `shensi_trial_app@127.0.0.1` through its private socket, then launch tunnel, sidecar, built backend, Vite preview, and gateway. Poll each health boundary. Bootstrap an internal random super-admin, create or verify the tenant admin through the real account API, and never log either password. Refuse to reuse PIDs not matching the recorded command metadata.

- [ ] **Step 9: Verify runtime tooling GREEN**

  Run `node --test scripts/real-trial-config.test.mjs scripts/real-trial-gateway.test.mjs scripts/real-trial-runtime.test.mjs`. Expected: all tests exit `0`.

### Task 4: Synchronize current operating documentation

**Files:**
- Modify: `README.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/modules/acquisition.md`
- Modify: `docs/operations/real-customer-trial.md`

**Interfaces:**
- Consumes: the exact package commands and environment boundaries delivered by Tasks 1-3.
- Produces: one current entry path for another AI or operator to understand what is live, what is preview, how to start/stop it, and what remains unaccepted.

- [ ] **Step 1: Update current documentation in present-tense form**

  Document the complete visible module surface, real-versus-preview labeling, alias mapping, dedicated ports, runtime directory, commands, tunnel lifetime, customer data retention, action gate and acceptance checklist. Replace the outdated raw `MEDIACRAWLER_SERVICE_SECRET` wording with `MEDIACRAWLER_SERVICE_SECRET_FILE`.

- [ ] **Step 2: Run documentation and context checks**

  Run `./scripts/context-check` and `git diff --check`. Expected: both exit `0` and current docs do not direct operators to the old source tree or old ports.

### Task 5: Build, launch and accept the public trial

**Files:**
- Runtime only: `.runtime/real-trial/**` (ignored, owner-only)
- Runtime only: `.env.real-trial.local` (ignored, owner-only)

**Interfaces:**
- Consumes: Tasks 1-4 and the customer-selected application password supplied out-of-band.
- Produces: one temporary HTTPS URL and a verified tenant-admin application login.

- [ ] **Step 1: Run source gates**

  Run `./scripts/context-check`, the focused frontend and MediaCrawler tests, `pnpm test`, `pnpm build`, and `git diff --check`. Every command must exit `0` using fresh output from the current tree.

- [ ] **Step 2: Prepare and start the isolated stack**

  Run `pnpm trial:prepare` with the app password supplied only through the process environment, then `pnpm trial:start`. Record the generated HTTPS origin without logging any secret. Confirm the old service PIDs and ports are unchanged.

- [ ] **Step 3: Verify authentication and persistence**

  Through the public gateway, assert a protected API returns `401`, log in with the alias, perform one CSRF-protected CRM write, restart only the trial backend, and assert the record still exists. Create a second internal test tenant and verify it cannot read the pilot record, then remove or disable that verification tenant.

- [ ] **Step 4: Verify complete frontend and network isolation**

  Inspect the local gateway URL in a browser: every developed primary and Growth module is reachable, preview labels are visible where appropriate, and body scrolling/navigation work. From the public origin assert MediaCrawler internal routes, source files, API docs and runtime files are not reachable.

- [ ] **Step 5: Verify real Douyin readiness without external send**

  Create and poll a Douyin QR session through the application. If the customer is not present to scan, stop at the visible QR-ready state. After a scan, run one manual-keyword collection and verify candidates persist after refresh. Assert the external action endpoint remains disabled for this launch.

- [ ] **Step 6: Retire the old static link only after acceptance**

  Stop only the old static gateway/tunnel processes after the new URL passes Steps 3-5. Leave all other existing local services untouched.

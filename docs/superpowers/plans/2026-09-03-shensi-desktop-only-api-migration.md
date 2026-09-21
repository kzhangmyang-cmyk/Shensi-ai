# Shensi Desktop-Only API Migration Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Shensi as a macOS application using the latest Renderer, a local visible-browser Sidecar for Douyin, and one central API/MySQL authority; prove complete local behavior before any Alibaba Cloud deployment, then retire only verified-obsolete Web runtime artifacts.

**Architecture:** `Shensi.app` serves the current `frontend/dist-desktop` build from a random loopback Renderer server. Business requests remain same-origin `/api` and are proxied to a central API-only Gateway; Electron Main owns the local Sidecar, persistent Douyin Profile, device credential, action coordinator, and recovery journal. The current Mac hosts the API/MySQL during development; a later Alibaba Cloud deployment changes only the configured HTTPS API origin and infrastructure, not the desktop or Sidecar protocol.

**Tech Stack:** Node.js 22.22.3, TypeScript 5.7.2, Express, Zod, MySQL 8/InnoDB, Electron 44.1.1, Python 3.11, FastAPI 0.110.2, Pydantic 2.13.4, Playwright 1.61+, Docker Compose, nginx, pnpm 11.18.0, Node test runner, pytest.

**Spec:** `docs/superpowers/specs/2026-09-03-shensi-desktop-only-api-migration-design.md`

## Companion plans

Detailed implementation steps live in these three plans and are authoritative within their scope:

1. `docs/superpowers/plans/2026-09-03-shensi-api-only-runtime-and-data-cutover.md`
2. `docs/superpowers/plans/2026-09-03-shensi-desktop-outreach-action-bridge.md`
3. `docs/superpowers/plans/2026-09-03-shensi-desktop-feature-parity-and-web-retirement.md`

This master plan controls their ordering. If a companion step conflicts with the order or authorization gates below, this document wins until the conflict is deliberately reviewed and corrected.

## Global constraints

- Preserve every tracked and untracked user change. At the start and end of every task, record `git status --short`, inspect only the task-owned diff, and run `git diff --check`. Never reset, clean, stash, checkout over, stage, or commit unrelated work.
- Use only the latest `frontend/` source as the Electron Renderer. Do not restore an older UI and do not delete `frontend/`.
- Do not repair or extend noVNC. Xvfb, VNC, websockify, noVNC, `/live-sessions`, remote browser canvases, public Web UI, and Cloudflare quick tunnels are excluded from the desktop path.
- Do not add Railway, a Railway SDK, or Railway deployment instructions. Alibaba Cloud is deferred until resources exist.
- Do not package Backend, MySQL, Docker, Redis, API secrets, or Douyin Profile/Cookies into `Shensi.app`.
- Do not run a real Douyin comment or private message during automated implementation. A later live write requires a separately confirmed account, exact target, exact content, and action-specific page confirmation.
- Do not bypass CAPTCHA, slider, QR, device verification, or other platform controls.
- Do not stop Trial, freeze writers, migrate real data, cut over `5608`, accept the new database, or delete old runtime artifacts merely because code/tests for those operations exist. Each operational gate below requires its own current evidence and explicit user authorization.
- Ordinary bug fixes build/test Renderer, Electron Main, Sidecar, Backend, and contracts in place. They do not generate a new DMG. Package one new application artifact only at an agreed milestone after the acceptance gates pass.
- `Shensi.app` is the only user-facing UI. Before Alibaba Cloud is available, `pnpm api:start` remains an operator-managed background prerequisite and must be verified separately; this is not a Web UI and is not bundled into the app. Only after the cloud API is live can normal users truly open only the app.

## Fixed local topology

| Purpose | Gateway | MySQL host port | Database/project | Lifecycle |
| --- | ---: | ---: | --- | --- |
| Existing Trial source | `5608` | `3310` | `shensi_trial` | Keep running/recoverable until authorized cutover |
| Retained API-only target | `5608` after cutover | `3311` | `shensi` / migration project | Must not compete with Trial before cutover |
| Disposable verification | `5628` | `3312` | run-scoped `shensi-api-empty-<12hex>` | Created and fully removed by guarded tests |
| Desktop Renderer | random loopback | — | latest `frontend/dist-desktop` | Owned by Electron/test helper |
| Desktop Sidecar | random loopback | — | local Profile only | Owned by Electron Main |

`Shensi.app` depends only on the configured API Gateway origin. It never connects directly to MySQL, the Trial supervisor, Docker, or a remote-display service.

---

### Phase 0: Protect the current workspace and capture a reproducible baseline

- [ ] **Step 1: Record the dirty-worktree and runtime baseline**

Run:

```bash
git status --short
git branch --show-current
git log -20 --oneline
git diff --check
lsof -nP -iTCP:5608 -sTCP:LISTEN
lsof -nP -iTCP:3310 -sTCP:LISTEN
lsof -nP -iTCP:3311 -sTCP:LISTEN
lsof -nP -iTCP:5628 -sTCP:LISTEN
lsof -nP -iTCP:3312 -sTCP:LISTEN
```

Store only non-secret process/port/status evidence in the implementation handoff. Do not kill a process based only on a port; ownership must be validated by the runtime's PID/Compose metadata.

- [ ] **Step 2: Run the current non-live baseline gates**

Run the current commands that exist before adding aliases:

```bash
pnpm test:contracts
pnpm --filter ./backend test
pnpm --filter ./frontend test
pnpm --dir desktop test
pnpm --dir desktop typecheck
pnpm build
cd services/media-crawler && uv run pytest -q tests/shensi_adapter
git diff --check
```

Record pre-existing failures exactly; do not mutate unrelated code to force green. Return to the repository root after the Python command.

---

### Phase 1: Build an isolated API-only runtime without touching Trial

- [ ] **Step 1: Execute companion API-only Tasks 1–4 only**

Implement Compose/nginx isolation, lifecycle supervision, authenticated all-module smoke, and disposable empty-database verification from `2026-09-03-shensi-api-only-runtime-and-data-cutover.md`.

- [ ] **Step 2: Prove the disposable topology and cleanup guard**

Required evidence:

- only `mysql`, `backend`, and `gateway` start for the disposable project;
- the Gateway exposes `/healthz` and `/api/*` only;
- `5628/3312` are used and `5608/3310` remain owned by Trial;
- every required business module authenticates and returns the expected shape;
- forbidden Web/noVNC/upgrade paths fail closed;
- cleanup accepts only the exact run-scoped project/root/volume and leaves no matching resource;
- no Trial or retained target file, process, database, or volume changes.

Do not execute `api:migration:run`, `api:cutover`, `api:accept`, or any cleanup of old Web/runtime artifacts in this phase.

---

### Phase 2: Implement the desktop comment/private-message action bridge with fakes

- [ ] **Step 1: Execute all nine tasks in the outreach action bridge plan**

Use the disposable API-only runtime, two isolated temporary Electron `userData` roots, and a recording fake Sidecar. Reuse the existing local Sidecar comment/DM executor; do not add a second platform-write implementation.

- [ ] **Step 2: Keep approval and execution authority separate**

The API-only defaults remain:

```text
DOUYIN_OUTREACH_ACTIONS_ENABLED=false
DOUYIN_OUTREACH_APPROVALS_ENABLED=true
DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED=false
DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED=false
SHENSI_DESKTOP_CLIENT_ADMISSION_MODE=migration_locked
# no SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256
```

Only the action-bridge acceptance fixture may enable desktop execution and exact-build admission, and only against fake targets/Sidecars. Passing that matrix never changes the retained target. The retained target stays desktop-disabled through `cutover_read_only`; only the first-use `api:accept` write-activation transaction, after it durably enters `write_activation_pending`, may invoke the evidence-bound transformer to set desktop execution `true`. It still persists `migration_locked` with no admitted App digest; only Phase 7 can open one exact candidate. Server execution stays `false`, preventing competing consumers.

- [ ] **Step 3: Require deterministic bridge evidence**

The bridge gate must prove enrollment, Keychain-backed `safeStorage`, account binding/generation, target-filtered claim, started fencing, one platform-write attempt, exact receipt replay, conflicting receipt rejection, crash recovery, response-loss recovery, stale-device rejection, handoff conflict, private-message predecessor/DNC/quota rules, Sidecar restart identity recovery, and sanitized logs. No test may access Douyin.

---

### Phase 3: Prove latest-Renderer feature parity and build the cold-start harness

- [ ] **Step 1: Execute desktop feature-parity Tasks 1, 2, 2A–2G, 3, and 4 plus Task 5 implementation/unit tests**

Build the canonical feature manifest, secure route-aware Renderer proxy, remove authenticated DemoStore/localStorage authority, implement every evidence-backed center/Sidecar route adapter, run disposable route and business mutation flows, and build the tested read-only cold-start harness from `2026-09-03-shensi-desktop-feature-parity-and-web-retirement.md`. Every App includes a strict embedded build manifest whose digest Main injects into Renderer-proxied and Main-direct central requests; tests prove Renderer spoofing is overwritten and Backend/Gateway admission never replaces normal auth. Do not require its live topology result before cutover; Trial still owns the old runtime at this point.

- [ ] **Step 2: Verify all current modules, not only Acquisition**

The gate covers authentication/registration, dashboard, agents/workflows, model connections without provider calls, Acquisition plans/candidates/evidence/approvals without platform writes, conversations, private domain, conversion/deals, scripts, trade marketing, settings, advisor, catalog, quotes, finance, ROI, and financial council. It must reload durable state, verify tenant isolation, test desktop and mobile layout widths, and reject demo/localStorage fallbacks.

- [ ] **Step 3: Prove Web independence**

The harness unit tests must prove exact forbidden-process/route detection without stopping anything. Live cold-start evidence showing the latest packaged/dev Renderer operates while no frontend dev server, static Web service, tunnel, noVNC, VNC, Xvfb, websockify, remote Sidecar, or `/live-sessions` endpoint is running is collected after authorized read-only cutover in Phase 5.

---

### Phase 4: Finish migration tooling, then stop for operational authorization

- [ ] **Step 1: Implement and test pre-accept API-only tooling without flipping current operating truth**

Add encrypted migration orchestration, cutover/rollback/accept state machines, installed-config verification, staged migration documentation/contracts, and abandoned-target GC safety tooling. Use injected processes/databases for tests. Keep README and current operator runbooks truthful that Trial/Web is still active; do not activate API-only/desktop-only present-tense instructions in this phase. Running unit tests, `migration-preflight`, and read-only `api:migration:gc:audit` is permitted; freezing Trial, dumping/restoring real data, occupying canonical `5608/3311`, or running `gc:prepare`/`gc:purge` is not.

- [ ] **Step 2: Produce the preflight packet**

The redacted packet must include:

- passing hashes/reports from Phases 1–3, including the cold-start harness unit tests but not a prematurely claimed live cold-start result;
- exact current source/target project and ports;
- validated source writer ownership;
- `legacyServerActions.count:0`, proving no historical server-target comment/private-message action will be stranded or silently retargeted;
- target emptiness and disposable verification hash;
- secret-file permissions and encrypted backup destination readiness;
- tested rollback commands and state;
- `authorized:false`.

Stop and ask the user for explicit permission to run the real-data migration. General instructions such as “continue” from an earlier turn do not satisfy this gate.

---

### Phase 5: Separately authorized migration, read-only cutover, and acceptance

- [ ] **Step 1: Run the real migration only after explicit authorization**

Close the app, freeze validated Trial writers, keep the Trial MySQL source recoverable on `3310`, create a fresh target on `3311`, run the encrypted migration, and verify schemas/counts/stable IDs/hashes. On any failure, follow the tested rollback path; do not improvise cleanup or reuse a partial target.

- [ ] **Step 2: Ask separately before canonical cutover**

Present migration verification and the exact process transition. After authorization, stop only validated Trial ownership, release `5608`, start the verified target Gateway on `5608`, and enter `cutover_read_only`.

- [ ] **Step 3: Perform installed-app read-only acceptance**

Use the exact feature Task 5 run-scoped App path from its manifest, never the default `/Applications` bundle, and invoke API companion Task 7 Step 5's sole `desktop:acceptance:seal` owner coordinator. It must itself run and nonce-bind both package/API/cold-start passes plus the visible current-Renderer route walk, close the App/helpers, and emit the immutable receipt; loose manual reports or route-result JSON cannot satisfy this gate. Inspect the visible run without creating, editing, approving, commenting, messaging, or contacting Douyin. A failure emits no success receipt and triggers rollback before any application writes.

- [ ] **Step 4: Ask separately before accepting writes**

Only after user review, run first-use `api:accept:prepare` and `api:accept` with a one-use confirmation through a private owner-only file. The transaction first durably enters `write_activation_pending`, closes Trial rollback, activates the reviewed target, and only then reaches `accepted`. Both states persist `desktopClientAdmission:{ mode:"migration_locked", admittedBuildManifestSha256:null }`: center-runtime private acceptance may write, but every App business mutation and desktop enrollment/binding/action route remains closed until Phase 7 admits one exact joint candidate. A failure after rollback closure may continue only through `pnpm api:accept:resume` with the same attempt/build/network/fingerprint/transformer/evidence; it must not mint a new token, rerun first-use acceptance, or start Trial. Acceptance does not authorize deleting Trial data, backups, migration evidence, Web source, Electron Profiles, or admitting `/Applications/Shensi.app`.

- [ ] **Step 5: Activate only the accepted-runtime documentation truth**

After `accepted` is durably verified, execute API companion Task 8's current-document update and gates. Current operator docs may now describe API-only MySQL/Backend/Gateway and the desktop action-bridge service capability as deployed, but must state that client admission remains `migration_locked`, `/Applications/Shensi.app` is stale/untrusted and cannot write or claim, and final App availability waits for Phase 7. They must also state that Web/noVNC source remains present and retirement is pending. Only Phase 6's source-retirement receipt may change that latter statement to removed. Preserve dated Trial/migration recovery facts as historical evidence rather than runnable current instructions.

---

### Phase 6: Audit and retire verified-obsolete Web runtime artifacts

- [ ] **Step 1: Run feature-parity Task 6 in audit/dry-run mode**

Generate a manifest that classifies every candidate artifact as retained source, runtime-only obsolete, remote-display source, or protected data. Any unknown path or missing acceptance hash fails closed.

- [ ] **Step 2: Ask for explicit deletion authorization**

Show the exact deletion/move set. The authorization must distinguish recoverable runtime-artifact retirement from later source deletion. Do not interpret migration acceptance as deletion consent.

- [ ] **Step 3: Execute guarded runtime retirement only if authorized**

Runtime artifacts first move to task-owned staging through Feature Task 6 and a hash-verified receipt. This recoverable execute step is distinct from its optional seven-day purge and from source deletion.

- [ ] **Step 4: Bootstrap the retirement gate, then ask separately before Feature Task 7 source/entrypoint retirement**

Execute Feature Task 7 Steps 1–3 first: capture the baseline, implement/test the non-destructive retirement controller, and extract/migrate neutral API-only process/environment helpers under the finite hash-recorded bootstrap allowlist. Those steps may not remove aliases, adapters, launchers, remote-display code, or deployment paths. Then run Step 4's read-only audit, show the exact before→after source set and audit/bootstrap hashes, stop, and request a second authorization through the one-use prepare protocol. Only after that exact authorization may Steps 5–9 apply the complete reviewed Task 7 set: remove the Trial cutover adapter, `api:prepare`, pre-accept migration/cutover/accept aliases, old `setup:mysql:local`/`dev:real` provisioner, runnable Web/Trial/Cloudflare/Baota/legacy Compose entrypoints, Renderer noVNC canvas code, only the remote branches of shared Backend/Sidecar files, server-Sidecar Dockerfiles, and—after import/package proof—the tracked MediaCrawler `api/**`, `webui/**`, and mixed API limit test. Update CI/provenance guards and future-bootstrap SQL/OpenAPI/generated contracts in that same exact set while leaving the accepted live schema unchanged. Preserve `frontend/`, MediaCrawler crawler/CLI/transitive desktop dependencies, `api:runtime:doctor`, `api:active-project`, accepted-safe `api:db:start`, accepted-target `api:start|stop|status|verify|verify:runtime`, disposable-only `api:verify:empty`, all three separately gated `api:migration:gc:audit|prepare|purge` commands and state/evidence readers, every `web:retirement:*` command until its staged recovery/purge lifecycle completes, generic backup/restore/data verification, all current desktop/API/collection/action behavior, data, secrets, backups, reports, Profiles, and evidence. Accepted restart uses only the active immutable image/config with `--no-build` and never recreates MySQL. Feature Task 7 Step 10 must make `source:retirement:record` run/hash the fixed full gate itself, then finish with the exact token-bound receipt, zero-executable-reference scan, and post-receipt runtime verification.

- [ ] **Step 5: Keep storage GC separate**

Run fresh read-only `api:migration:gc:audit` and Web-retirement purge audits as storage reports. `api:migration:gc:prepare|purge`, Web staged-artifact purge, unowned legacy build cleanup, rollback-app purge, and superseded Backend-image pruning each require their own later exact-set authorization and are not prerequisites for functional migration completion. Backend-image pruning must retain the active immutable digest and every digest named by protected rollback evidence.

---

### Phase 7: Build, activate, and safely promote one joint current-source milestone

- [ ] **Step 1: Build the Feature Task 8 joint candidate without runtime mutation**

Run `desktop:milestone:build` as the sole public coordinator, passing the exact absolute Task 7 source-retirement receipt path and SHA-256 rather than discovering a newest file. From stable before/after source manifests, build one immutable Backend candidate, one immutable Gateway configuration snapshot, and exactly one run-scoped development `Shensi.app`; bind all of them and the Task 7 receipt into one joint manifest and create no DMG/ZIP. Before sealing `candidate_built`, select exactly one `verifiedRollbackSeed`: either a current installed App with an immutable receipt bound to the complete prior service/schema/contract/admission tuple, or the retained Task 5 recovery-only App whose sealed evidence plus API acceptance bind that tuple. If neither qualifies, stop before service mutation. Record an unverified current installed App only as `nonRollbackDisplacedApp` with an explicit future quarantine/removal disposition. Do not switch services or touch `/Applications` in this step. Existing unowned `desktop/release/` or `dist/desktop/macos/` artifacts are inventoried but not silently deleted.

The coordinator owns one exclusive root with fixed `backend/`, `gateway/`, `app/`, and `evidence/` children. Standalone Task 5 `fixtureOnly:true` packages and direct low-level builders are not promotable. If the operator chooses not to activate this built candidate, run the exact `desktop:milestone:abort` path so the verified prior version remains active and the journal reaches terminal `abandoned` rather than blocking normal lifecycle commands.

- [ ] **Step 2: Activate candidate services and verify the candidate App as one version set**

Run `desktop:milestone:activate -- --dry-run` against the exact joint-manifest path/hash; it must show the selected seed, any displaced-App disposition, locked prior admission, maintenance/recovery set, and `authorized:false`. Present that report and obtain current explicit authorization. Then run `desktop:milestone:activate:prepare` and pass its owner-only token only through `SHENSI_DESKTOP_MILESTONE_ACTIVATION_TOKEN_FILE` to the mutating form. Before the first Gateway/Backend change, revalidate the seed and its compatibility receipt, persist the exact activation intent, enter `services_activation_pending`, and durably consume the token. Use a bounded maintenance/read-only window, drain writes, leave MySQL container/volume untouched, and validate the candidate Backend without DDL/business writes. Keep the bound maintenance Gateway, read-only database principal, and zero-worker candidate active while `desktop:milestone:verify` owns/runs every Task 8 candidate gate, seals their result hashes, and alone advances to `candidate_verified_pending_promotion`. If the operator declines to continue before App swap, use `desktop:milestone:abort`; any failure restores the prior immutable Backend/Gateway plus locked-admission set before traffic resumes. Neither path falls back to Trial or touches data.

- [ ] **Step 3: Ask separately before replacing the installed app**

Run the read-only promotion audit and show exact candidate/current/rollback App hashes, selected rollback-seed source/tree/build/compatibility hashes, any non-rollback displaced-App quarantine/removal set, active/prior Backend/Gateway/admission hashes, tested native-helper binary hash, cleanup paths, normal worker/Gateway activation plan, and the forward-only consequence once candidate writes may begin. Ask explicitly for authorization covering both the App swap and the post-read-only-smoke write activation. Only then may the one-use promotion transaction stage both candidate and verified seed on the `/Applications` filesystem and atomically swap exact `/Applications/Shensi.app` through the checked `RENAME_SWAP` helper. It may not invoke `sudo` or use sequential renames while claiming atomicity. Token-consumption and swap crashes reconcile from the fsynced journal and all bound candidate/seed/displaced/rollback path hashes without a new token.

- [ ] **Step 4: Smoke, finalize, and bound storage**

After manual installed-app read-only smoke, run every verifier with explicit `/Applications/Shensi.app` and the journal-bound `milestone-read-only` role. A smoke failure keeps maintenance closed, restores/verifies prior Backend behind it, atomically installs the selected verified seed—not a blind unverified old App—then restores the prior locked-admission Gateway last and records `failed_recovered`; any non-rollback displaced App follows only its authorized quarantine disposition. On success, atomically place the selected verified seed into the sole rollback slot, copy every active/rollback service/config/admission/manifest/receipt dependency into stable content-addressed version roots, and only then enter forward-only `normal_activation_pending`. Start the bound candidate normal Backend/workers behind maintenance, open the candidate Gateway last with Gateway and Backend both admitting only the candidate embedded build digest, pass normal-role verification plus a cold restart through the private journal-capability lifecycle adapter, remove only exact authorized temporary/displaced paths after stable quarantine proof, and mark `finalized`. Then execute Feature Task 8 Step 8 as the sole final current-document sync: all current product/runbook docs must move from the interim `migration_locked`/installed-unavailable truth to the active record's exact admitted digest, installed-App availability, and completed Web/noVNC retirement; a failure leaves runtime untouched and keeps the phase incomplete. Public lifecycle aliases remain blocked in every non-terminal milestone state. After normal activation begins, failures recover forward on the candidate and never auto-start old services. Deleting the sole rollback, its version dependencies, a displaced-App quarantine, or an unowned legacy artifact remains a separate authorization. Do not create a DMG/ZIP until a future signed release milestone.

---

### Phase 8: Defer Alibaba Cloud deployment until resources exist

- [ ] **Step 1: Prepare configuration and runbooks only**

Complete feature-parity Task 9: document API/Worker/RDS topology, TLS, security groups, secrets, backups, restore, health checks, observability, device revocation, data migration, rollback, and two-real-Mac acceptance. Extend the one canonical checklist created by the action-bridge plan; do not create a duplicate or invent a domain, IP, certificate, RDS instance, or passing evidence.

- [ ] **Step 2: Execute later as a separate deployment project**

When the user supplies the Alibaba Cloud account/resources, deploy the same API contracts, change only the desktop-configured HTTPS origin, migrate with a fresh verified backup, and run real two-Mac conflict/offline/recovery tests. Railway remains out of scope.

## Cross-plan completion matrix

| Gate | Required result | Blocks |
| --- | --- | --- |
| API disposable | API-only Tasks 1–4 green; cleanup proven | Action/feature integration |
| Desktop actions | Bridge Tasks 1–9 green with fake Sidecar only | Migration/cutover and live writes |
| Feature pre-cutover | Feature Tasks 1, 2, 2A–2G, 3, 4 + Task 5 harness/unit green using latest Renderer | Migration/cutover |
| Migration preflight | Redacted current evidence, `authorized:false` | Real migration |
| Migration verification | Encrypted backup + restored target checks green | Canonical cutover |
| Live cold-start + app pass | The sole Task 5 owner coordinator seals two package/API/cold-start passes plus a complete command-owned visible route result for the same App/migration identity | Write acceptance |
| Accepted target | One-use acceptance complete | Web retirement audit |
| Migration GC safety | API Task 9 tests + read-only audit green | Storage report; purge separately authorized |
| Runtime-retirement authorization | Exact Task 6 manifest approved | Recoverable runtime staging |
| Source-retirement authorization | Task 6 receipt + exact Task 7 set approved | Web/Trial/noVNC source deletion |
| Joint milestone | Build-only Backend/Gateway/App manifest green; one evidence-bound `verifiedRollbackSeed` selected; bounded service activation and coordinator-owned candidate verification green | Installed-app promotion audit |
| Installed-app authorization | Exact candidate/current/selected-seed/existing-rollback identities, any `nonRollbackDisplacedApp` quarantine disposition, active/prior service and admission records, helper binary, write-activation consequence, and cleanup set approved | Atomic promotion and manual smoke |
| Exact desktop admission | Installed candidate build-manifest digest is recomputed from the App; Gateway and Backend both enforce the same `exact` digest while prior/abort/recovered sets remain `migration_locked`; cold restart reproduces the admitted tuple | Finalized desktop business writes and action claims |
| Final current-document truth | State-aware contract binds all current product/runbook docs to the finalized active digest, admitted installed App, and completed Web/noVNC retirement | Local desktop-only completion claim |
| Alibaba resources | Real infrastructure exists | Cloud/two-Mac acceptance |

## Final implementation reporting

At the end of every phase, report:

- completed checkbox steps and exact commands run;
- tests that passed, failed, or were not run;
- task-owned files changed and why;
- current runtime/process/port state without secrets;
- whether current docs remain accurate;
- `git status --short` and `git diff --check`;
- the next blocked authorization, if any.

Never use “completed” for a phase whose required evidence is missing, and never equate a mocked action test with a successful real Douyin write or a local multi-device simulation with an Alibaba Cloud/two-Mac acceptance.

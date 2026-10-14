# Shensi macOS Electron Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a secure macOS Electron client that reuses the latest Shensi frontend, owns a local visible-browser MediaCrawler Sidecar, and keeps business data in the existing remote backend.

**Architecture:** Electron Main owns a random-port authenticated Sidecar and a loopback renderer/static API gateway. A sandboxed local Renderer reaches desktop-only login/collection through a narrow contextBridge API and reaches cloud business APIs through the same-origin gateway; desktop mode never enters the noVNC/live-session path.

**Tech Stack:** Electron 44.1.1, electron-builder 26.15.3, TypeScript 5.7.2, pnpm 11.18.0, Node.js 22.22.3, Python 3.11, FastAPI/Uvicorn, Playwright/MediaCrawler.

**Spec:** `docs/desktop/macos-electron-client.md`

## Global Constraints

- Preserve every existing tracked and untracked user change; do not reset, clean, stash, checkout over, stage, or commit the shared dirty workspace.
- Reuse the current frontend build; never restore or copy an older frontend snapshot.
- Electron BrowserWindow uses `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webviewTag: false`.
- Renderer receives no raw Electron/Node/process/filesystem/shell/token/port/path/command capability.
- Electron Main is the only Sidecar process owner; all IPC inputs and senders are validated in Main.
- Sidecar binds only `127.0.0.1:0`, reports its port on a dedicated ready pipe, and is ready only after authenticated health succeeds.
- Desktop mode uses external visible Playwright Chromium and never calls `/live-sessions`, loads noVNC, or starts Xvfb/VNC.
- Production does not depend on user-installed Python or Node and writes only below Electron-managed user directories.
- Remote user/CRM/acquisition/AI/permission/subscription services remain remote; cookies, Profile data and Sidecar secrets never sync.
- Follow red-green-refactor for every behavior change and update current architecture, module and status documentation before completion.

---

### Task 1: Desktop contracts, paths, logging and package boundary

**Files:**
- Create: `desktop/package.json`
- Create: `desktop/tsconfig.json`
- Create: `desktop/src/shared/contracts.ts`
- Create: `desktop/src/shared/validation.ts`
- Create: `desktop/src/main/app-paths.ts`
- Create: `desktop/src/main/logger.ts`
- Create: `desktop/tests/contracts.test.ts`
- Create: `desktop/tests/app-paths.test.ts`
- Create: `desktop/tests/logger.test.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces `DesktopRuntimeInfo`, `ConnectorStatus`, `DouyinLoginStatus`, `DouyinCollectionTask`, `DouyinCollectionStatus`, `DouyinCollectionPage`, `DESKTOP_CHANNELS`, `validateInvoke(channel,value)`, `createAppPaths(input)`, and `createDesktopLogger(path)`.
- `validateInvoke` accepts only bounded plain JSON values; `accountId` 1..200 chars, IDs 1..200 safe chars, keywords 1..20 of 1..100 chars, numeric limits within Sidecar schemas, ISO future deadline, no extra fields.

- [ ] Write Node tests that assert the exact channel allowlist, reject extra/arbitrary executable/path/URL/argv fields, separate dev/prod/test paths, keep profiles under userData, and redact authorization/token/secret/account identifiers.
- [ ] Run `pnpm --dir desktop test -- contracts.test.ts app-paths.test.ts logger.test.ts`; verify module-not-found/expected assertion failures.
- [ ] Add the exact locked desktop dependencies and minimal shared/path/logger implementation.
- [ ] Run the focused tests, then `pnpm --dir desktop typecheck`; both pass.

### Task 2: Dedicated Sidecar desktop entrypoint and shutdown contract

**Files:**
- Create: `services/media-crawler/shensi_adapter/desktop_entrypoint.py`
- Create: `services/media-crawler/tests/shensi_adapter/test_desktop_entrypoint.py`
- Modify: `services/media-crawler/shensi_adapter/runtime_config.py`
- Modify: `services/media-crawler/tests/shensi_adapter/test_runtime_config.py`
- Modify as evidence requires: `services/media-crawler/shensi_adapter/crawl_jobs.py`
- Modify as evidence requires: `services/media-crawler/shensi_adapter/action_jobs.py`

**Interfaces:**
- Produces `python -m shensi_adapter.desktop_entrypoint` and packaged executable behavior.
- Requires env `SHENSI_RUNTIME_MODE=desktop`, absolute `SHENSI_USER_DATA_DIR`, absolute `SHENSI_LOG_DIR`, `MEDIACRAWLER_SERVICE_SECRET_FILE`, `SHENSI_READY_FD`; rejects non-loopback host.
- Dedicated FD emits one JSON line `{ "type":"shensi-sidecar-ready", "protocolVersion":1, "pid":number, "port":number }` only after secret/path preflight and socket bind.
- `MEDIACRAWLER_BROWSER_CHANNEL=chromium` selects bundled Playwright Chromium (`browser_channel=None`) while existing `chrome` remains supported.

- [ ] Write tests for `127.0.0.1:0`, structured ready, bad/missing/symlink/loose secret preflight, invalid directories, explicit bundled Chromium selection, SIGTERM cleanup and no live/noVNC dependency.
- [ ] Run the focused pytest files and observe failures because the entrypoint/bundled-channel behavior does not exist.
- [ ] Implement the smallest dedicated entrypoint around the existing FastAPI lifespan and Uvicorn bound socket; do not duplicate AccountManager logic.
- [ ] Reconcile crawl/action child shutdown only where the new process-level tests prove an orphan path.
- [ ] Run focused tests and the complete Sidecar suite.

### Task 3: Sidecar client and sole-owner process manager

**Files:**
- Create: `desktop/src/main/sidecar-client.ts`
- Create: `desktop/src/main/sidecar-process-manager.ts`
- Create: `desktop/tests/sidecar-client.test.ts`
- Create: `desktop/tests/sidecar-process-manager.test.ts`
- Create: `desktop/tests/fixtures/fake-sidecar.mjs`

**Interfaces:**
- Produces `SidecarClient` methods matching the internal login/crawl endpoints without exposing token/port.
- Produces `SidecarProcessManager.start()`, `restart()`, `stop()`, `getStatus()`, `onStatus(listener)` and a `client` accessor available only while ready.
- Dev command is an explicit argv array using repo `uv`; packaged command is the fixed resources executable. Manager creates `0600` secret, passes ready FD 3, verifies authenticated health/protocol, restarts at most twice, and performs bounded TERM then KILL cleanup.

- [ ] Write fake-process tests for successful ready/health, invalid ready handshake, startup timeout, bad token, early exit, crash notification, two-restart cap, no `shell`, no secrets in argv/logs, graceful quit, forced quit, listener cleanup, and packaged/dev command selection.
- [ ] Run focused tests and verify failures.
- [ ] Implement the client and manager with injected spawn/fetch/clock dependencies so tests do not launch a real browser.
- [ ] Run focused tests, desktop typecheck, and a real development Sidecar health smoke.

### Task 4: Secure Electron lifecycle, local renderer gateway, IPC and preload

**Files:**
- Create: `desktop/src/main/renderer-server.ts`
- Create: `desktop/src/main/create-window.ts`
- Create: `desktop/src/main/desktop-ipc.ts`
- Create: `desktop/src/main/main.ts`
- Create: `desktop/src/preload/desktop-api.ts`
- Create: `desktop/src/preload/preload.ts`
- Create: `desktop/tests/renderer-server.test.ts`
- Create: `desktop/tests/electron-security.test.ts`
- Create: `desktop/tests/desktop-ipc.test.ts`
- Create: `desktop/tests/preload.test.ts`

**Interfaces:**
- `startRendererServer({distDir,remoteOrigin})` binds loopback random port, serves only files contained in distDir, applies SPA fallback, and proxies only `/api` to an allowlisted HTTP(S) origin with bounded bodies and rewritten response cookies.
- `createMainWindow` receives the local origin and preload path and returns a secure BrowserWindow; navigation/new windows outside the exact local origin are denied.
- `registerDesktopIpc` validates sender origin plus `validateInvoke`, maps exact channels to Sidecar manager/client, hashes account IDs with domain separation, and removes handlers on dispose.
- Preload exposes only the documented `ShensiDesktopApi` and returns unsubscribe closures for status events.

- [ ] Write tests for static path traversal, API target allowlist, local production build loading, exact BrowserWindow flags, navigation denial, preload allowlist/no raw ipc, invalid sender/payload rejection, duplicate login dedupe and IPC disposal.
- [ ] Run tests and verify failures.
- [ ] Implement the gateway, window, IPC and preload with Electron imports behind injectable interfaces where unit tests require it.
- [ ] Implement Main lifecycle: single-instance lock, focus second launch, ready/window creation, macOS activate, before-quit Sidecar cleanup, renderer crash survival, menu and Cmd+Q.
- [ ] Run focused tests, desktop typecheck and main build.

### Task 5: Latest frontend desktop runtime adapter and connector UI

**Files:**
- Create: `frontend/src/desktop/desktop-bridge.ts`
- Create: `frontend/src/desktop/desktop-bridge.self-test.ts`
- Create: `frontend/src/desktop/desktop-runtime.ts`
- Create: `frontend/src/desktop/desktop-runtime.self-test.ts`
- Modify: `frontend/src/acquisition/acquisition-browser-runtime.ts`
- Modify: `frontend/src/acquisition/acquisition-browser-runtime.self-test.ts`
- Modify: `frontend/src/acquisition/douyin-automation-controller.ts`
- Modify: `frontend/src/acquisition/douyin-automation-view.ts`
- Modify: `frontend/src/app-entry.ts`
- Modify: `frontend/src/self-test.ts`

**Interfaces:**
- `getDesktopBridge(window)` returns a typed bridge only when every required method is present; web returns null.
- `createAcquisitionBrowserRuntimes(api,{desktopBridge,accountId})` defaults null/new sessions to desktop only when the bridge exists; web remains API-backed remote.
- Desktop login maps Sidecar snake_case status to existing `DouyinLoginSession` with `interactionSurface: "external_window"`; status updates are generation-guarded.
- Connector state displays `starting/ready/crashed/stopped`, a restart action, and external-window instructions without a remote canvas.

- [ ] Write frontend self-tests proving web behavior is unchanged, desktop initial connect calls the bridge rather than remote login API, repeated connect starts one login, desktop makes zero `/live-sessions`/noVNC requests, stale session/status events cannot overwrite current state, and connector crash/restart copy is deterministic.
- [ ] Run focused frontend self-tests and observe failures.
- [ ] Implement the runtime adapter and minimal current-style UI wiring; do not fork or replace existing acquisition components.
- [ ] Run frontend tests, typecheck and production build.

### Task 6: Cloud desktop task/result synchronization

**Files:**
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-social-account-router.ts`
- Modify: `backend/src/acquisition-social-account-service.ts`
- Modify repository files only if the existing account/run state cannot represent the desktop connector states.
- Modify: `frontend/src/acquisition/douyin-automation-api.ts`
- Modify: `frontend/src/acquisition/acquisition-browser-runtime.ts`
- Add matching backend, contract and frontend self-tests next to the modified modules.

**Interfaces:**
- Produces authenticated, workspace-scoped, CSRF-protected, idempotent endpoints for desktop login completion, desktop crawl-intent creation, result-page upload and completion/acknowledgement.
- The server returns only bounded crawl configuration and opaque IDs; it never receives Profile paths, cookies, Sidecar token/port, browser storage or arbitrary local instructions.
- Renderer coordinates: create cloud intent → execute validated local task → upload normalized pages → finalize. Retries are idempotent and late/stale task updates are rejected.

- [ ] Write OpenAPI and backend red tests for auth, tenant isolation, CSRF, idempotency, schema bounds, stale account/login version, cursor/page replay, completion and sanitized persistence.
- [ ] Run contract/backend focused tests and verify failures.
- [ ] Implement the smallest service/router/repository additions using existing run/account projections.
- [ ] Write frontend red tests for end-to-end coordinator order, retry, cancellation and stale completion; implement the coordinator.
- [ ] Run contract, backend and frontend suites.

### Task 7: Builds, bundled resources, DMG configuration, docs and verification

**Files:**
- Create: `desktop/electron-builder.yml`
- Create: `desktop/build/entitlements.mac.plist`
- Create: `desktop/scripts/dev.mjs`
- Create: `desktop/scripts/build-sidecar.mjs`
- Create: `desktop/scripts/verify-package.mjs`
- Create: `desktop/tests/build-contract.test.ts`
- Modify: `desktop/package.json`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `frontend/README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/modules/acquisition.md`
- Modify: `docs/desktop/macos-external-browser-audit.md`
- Modify: `docs/THIRD_PARTY_NOTICES.md`

**Interfaces:**
- Commands: `desktop:dev`, `desktop:test`, `desktop:typecheck`, `desktop:build:renderer`, `desktop:build:main`, `desktop:build`, `desktop:package:mac`.
- Builder includes local frontend dist, compiled Main/Preload, fixed Sidecar executable, MediaCrawler resources and Playwright Chromium outside asar; excludes servers/databases/noVNC/Xvfb/VNC.
- Dev supervisor starts Vite and Electron (which owns Sidecar), waits for readiness, forwards signals, and leaves no child processes.

- [ ] Write build-contract tests for exact resources/exclusions, local renderer entry, dev/prod paths, no installed Python/Node dependency, no secret in artifacts, and command presence.
- [ ] Run tests and verify failures.
- [ ] Implement scripts/config with exact dependency versions and lockfile updates; build Sidecar through a pinned PyInstaller build environment and install a pinned Playwright Chromium into the staging resource directory.
- [ ] Run desktop tests/typecheck/build, frontend tests/build, complete Sidecar tests, backend/contracts tests, root build, package verification, `git diff --check`, and document exact results.
- [ ] Manually verify the 16 acceptance checks from `docs/desktop/macos-electron-client.md`/task request and report each as passed, failed, or not run; do not infer success from unit tests.

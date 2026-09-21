# Shensi Desktop Feature Parity and Web Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every latest-Renderer route and its visual hierarchy in the macOS app, replace every authenticated demo/localStorage authority with real center or local-Sidecar behavior, prove all currently implemented business capabilities without a Web frontend, then retire only verified-obsolete Web runtime and prepare an evidence-based Alibaba Cloud acceptance runbook. Preview-only controls with no Backend contract or platform adapter remain visibly and honestly unavailable; they may not masquerade as completed functionality.

**Architecture:** The existing latest frontend remains the Electron Renderer and reaches the center through Electron's loopback `/api` proxy. Route parity is enforced by one canonical desktop feature manifest and real API-only smoke tests. Web processes and generated artifacts are retired through a manifest-driven, dry-run-first cleanup that excludes business data, application Profiles, source code, and rollback assets.

**Tech Stack:** Electron 44.1.1, TypeScript 5.7.2, Node.js 22.22.3, Vite, Playwright 1.61.1, Express, MySQL, pnpm 11.18.0.

**Spec:** `docs/superpowers/specs/2026-09-03-shensi-desktop-only-api-migration-design.md`

## Global Constraints

- Preserve every existing tracked and untracked user change; do not reset, clean, stash, checkout over, stage, or commit the shared dirty workspace.
- Use only the latest `frontend/` source for the Electron Renderer; never restore or copy an older frontend snapshot.
- Do not delete `frontend/`, the MySQL datadir, secrets, encrypted backups, migration reports, or Electron `userData` Profiles.
- Do not permanently retire or delete the current Trial runtime until migration acceptance and all retirement prerequisites pass. A temporary, separately authorized writer freeze/cutover may stop its validated processes exactly as defined by the API-only migration state machine, while preserving source MySQL, secrets, evidence, and rollback assets.
- Desktop mode must make zero `/live-sessions`, noVNC, VNC, Xvfb, websockify, or remote-canvas requests.
- Keep the current black/green visual system and existing information architecture.
- Do not package a new DMG/ZIP during ordinary development; use `desktop:dev` and build the Renderer/Main only.
- Alibaba Cloud is a later deployment target, not a current dependency. Do not add Railway or a vendor SDK.
- A real comment or private message is never part of automated testing and requires a separate user-selected target plus page confirmation.
- Each task ends with fresh focused tests, `git diff --check`, and a review checkpoint instead of a commit.

---

### Task 1: Canonical desktop feature manifest

**Files:**
- Create: `frontend/src/desktop/desktop-feature-manifest.ts`
- Create: `frontend/src/desktop/desktop-feature-manifest.self-test.ts`
- Modify: `frontend/src/app-route.ts`
- Modify: `frontend/src/app-route.self-test.ts`
- Modify: `frontend/src/self-test.ts`

**Interfaces:**
- Produces `DesktopFeatureId`, `DesktopFeatureRoute`, `DESKTOP_FEATURE_ROUTES`, and `desktopFeatureForHash(hash)`.
- `DESKTOP_FEATURE_ROUTES` is the reviewable source for route-parity testing; it does not replace the existing UI navigation.
- Every entry declares an exact canonical hash, visible heading matcher, `authorities: readonly ("center" | "local-sidecar")[]`, exact `requiredApiOperations`, and `unsupportedCapabilities`. A route cannot be marked complete while an enabled control depends on demo/localStorage state or while a visible unsupported control lacks an explicit unavailable state.

- [ ] **Step 1: Write the failing manifest self-test**

```ts
import { strict as assert } from "node:assert";
import {
  DESKTOP_FEATURE_ROUTES,
  desktopFeatureForHash,
} from "./desktop-feature-manifest";

assert.deepEqual(
  DESKTOP_FEATURE_ROUTES.map(({ hash }) => hash),
  [
    "#dashboard", "#agents", "#acquisition", "#conversations",
    "#private-domain", "#conversion", "#scripts", "#trade-marketing",
    "#settings", "#growth/advisor", "#growth/catalog", "#growth/quotes",
    "#growth/finance", "#growth/roi", "#financial-council",
  ],
);
assert.equal(desktopFeatureForHash("#growth/agents/profit")?.id, "agents");
assert.equal(desktopFeatureForHash("#unknown"), null);
assert.ok(DESKTOP_FEATURE_ROUTES.every((route) => route.requiresCenterApi));
```

- [ ] **Step 2: Import the self-test from `frontend/src/self-test.ts` and run it red**

Run: `pnpm --filter ./frontend test`

Expected: FAIL because `desktop-feature-manifest.ts` does not exist.

- [ ] **Step 3: Implement the exact manifest and lookup**

```ts
export type DesktopFeatureId =
  | "dashboard" | "agents" | "acquisition" | "conversations"
  | "private-domain" | "conversion" | "scripts" | "trade-marketing"
  | "settings" | "advisor" | "catalog" | "quotes" | "finance"
  | "roi" | "financial-council";

export interface DesktopFeatureRoute {
  id: DesktopFeatureId;
  hash: `#${string}`;
  heading: RegExp;
  requiresCenterApi: true;
  requiresSidecar: boolean;
  authorities: readonly ("center" | "local-sidecar")[];
  requiredApiOperations: readonly string[];
  unsupportedCapabilities: readonly string[];
}
```

Populate the hashes in the exact order asserted above. Only `acquisition` requires Sidecar; comments and private messages remain views of center-authoritative outreach state and are executed by Electron Main, not by route code.

- [ ] **Step 4: Make route normalization consume the canonical hashes without changing behavior**

Keep `douyin-live-login` only as a compatibility parse branch until the Web removal task. Continue normalizing `#growth/agents` and `#growth/agents/:id` to `#agents`.

- [ ] **Step 5: Run focused and full frontend checks**

Run:

```bash
pnpm --filter ./frontend test
pnpm --filter ./frontend build:desktop
git diff --check
```

Expected: all exit 0; the existing black/green application build remains the only Renderer output.

---

### Task 2: Route-aware Renderer API proxy limits

**Files:**
- Create: `desktop/src/main/renderer-proxy-policy.ts`
- Create: `desktop/tests/renderer-proxy-policy.test.ts`
- Modify: `desktop/src/main/renderer-server.ts`
- Modify: `desktop/tests/renderer-server.test.ts`

**Interfaces:**
- Produces `RendererProxyPolicy` and `rendererProxyPolicyFor(method, pathname)`.
- `startRendererServer()` continues to accept explicit test overrides, but production requests use the more restrictive value from the matched route policy.
- The policy never permits WebSocket upgrade, unlimited bodies, unlimited responses, or unlimited timeouts.

- [ ] **Step 1: Write red policy tests for the known high-cost endpoints**

```ts
assert.deepEqual(rendererProxyPolicyFor("GET", "/api/v1/finance/council-runs/run-1/events"), {
  maxBodyBytes: 0,
  maxResponseBytes: 4_194_304,
  requestTimeoutMs: 10_000,
  upstreamTimeoutMs: 65_000,
});
assert.deepEqual(rendererProxyPolicyFor("POST", "/api/v1/finance/imports/preview"), {
  maxBodyBytes: 8_388_608,
  maxResponseBytes: 8_388_608,
  requestTimeoutMs: 30_000,
  upstreamTimeoutMs: 30_000,
});
assert.equal(
  rendererProxyPolicyFor("GET", "/api/auth/me").maxResponseBytes,
  1_048_576,
);
```

Also assert that `/api/v1/acquisition/desktop-crawler-jobs/:id/pages` permits a 2 MiB request and 2 MiB response with a 30-second upstream deadline, while unknown endpoints retain the 1 MiB/10-second default.

- [ ] **Step 2: Run the policy test red**

Run: `cd desktop/tests && ../node_modules/.bin/tsx --test renderer-proxy-policy.test.ts`

Expected: FAIL because the policy module does not exist.

- [ ] **Step 3: Implement exact-match and bounded-pattern policies**

Implement patterns as anchored regular expressions over one canonical raw pathname. Reject malformed percent encoding, encoded path separators (`%2f`, `%2F`, `%5c`, `%5C`), control/NUL bytes, dot segments, backslashes, and any value whose decode/re-encode check is ambiguous before policy lookup. Decode exactly once only for validation; never policy-match a twice-decoded value and never let normalization turn an unknown path into a privileged route. Use integers declared in one frozen policy table; do not read limits from Renderer input.

- [ ] **Step 4: Wire policies into request and response streaming**

For each `/api` request, calculate policy once and pass its limits to `readRequestBody`, the upstream abort timer, and `readResponseBody`. Keep explicit `RendererServerOptions` overrides available only to tests and apply the smaller of an override and route policy.

Lock the authentication proxy behavior instead of treating CORS/Cookie handling as a later compatibility patch:

- the BrowserWindow loads one random exact `http://127.0.0.1:<ephemeral>` Renderer origin in its isolated Electron session; incoming `Host` must equal that host, and any `Origin`/`Referer` must equal that Renderer origin while `Sec-Fetch-Site: cross-site` is rejected before proxying;
- strip incoming `Host`, `Origin`, `Referer`, every `Forwarded`/`X-Forwarded-*`, hop-by-hop, and response `Access-Control-*` header; set upstream `Origin` and `Referer` to the configured exact API origin and let the HTTP client set the upstream host. `CORS_ORIGINS` is that API origin (`http://127.0.0.1:5608` locally and the future HTTPS API origin in Alibaba Cloud), never the random Renderer origin;
- use `redirect: "manual"` and reject every upstream redirect. Forward browser cookies and `X-CSRF-Token` unchanged only after local provenance validation; never synthesize a CSRF value;
- accept `Set-Cookie` only for exact `gj_session` and `gj_csrf`, reject `Domain`, `Partitioned`, prefixes, duplicate attributes, malformed values, and unknown cookie names, then emit host-only `Path=/; SameSite=Strict`; preserve expiry/Max-Age, preserve `HttpOnly` only on `gj_session`, require it absent on `gj_csrf`, and remove `Secure` solely because the isolated Renderer endpoint is loopback HTTP. Any incompatible upstream cookie is a fail-closed `502`, not silently dropped or weakened;
- logout must forward both exact expiry cookies and clear both local cookies. Authentication responses are `Cache-Control: no-store`; no cookie, bearer token, CSRF token, or body is logged.

- [ ] **Step 5: Add integration tests for boundary bytes and timeouts**

Test exact-limit success, one-byte-over 413, partial upstream body 504, unknown-route default, malformed encoded path 404, and `Connection: upgrade` rejection without contacting upstream. Run register → `/api/auth/me` → authenticated CSRF mutation → logout → rejected stale session against a random local Renderer origin for both a loopback API target and an injected future HTTPS API target. Assert exact upstream Origin/Referer, two-cookie rewrite/expiry, multi-`Set-Cookie` preservation, no redirects/CORS leakage, and rejection of foreign Host/Origin/Referer, malformed cookies, wrong attributes, unknown cookies, and missing CSRF.

- [ ] **Step 6: Run the full desktop unit gate**

Run:

```bash
pnpm --dir desktop test
pnpm --dir desktop typecheck
git diff --check
```

Expected: all exit 0.

---

### Task 2A: Remove authenticated DemoStore authority before parity testing

**Files:**
- Create: `frontend/src/desktop/desktop-route-authority.ts`
- Create: `frontend/src/desktop/desktop-route-authority.self-test.ts`
- Modify: `frontend/src/desktop/desktop-feature-manifest.ts`
- Modify: `frontend/src/desktop/desktop-feature-manifest.self-test.ts`
- Modify: `frontend/src/demo/demo-app.ts`
- Modify: `frontend/src/demo/demo-router.ts`
- Modify: `frontend/src/app-route.self-test.ts`
- Modify: `frontend/src/self-test.ts`
- Modify: `frontend/tests/agent-center-shell.spec.ts`

**Interfaces:**
- `desktopRouteAuthority(sessionMode, feature)` returns only `center`, `local-sidecar`, or the reviewed combination declared in the manifest.
- In authenticated desktop/API-only mode, route startup must not instantiate, read, subscribe to, or write `createDemoStore`; explicit demo mode may remain only until Task 7 removes its unreachable code.
- Every rendered route root exposes `data-authority="center"`, `data-authority="local-sidecar"`, or `data-authority="center local-sidecar"` for deterministic testing. Legacy CSS names such as `demo-panel` are visual tokens and are not evidence of demo data.

- [ ] **Step 1: Write red authority and routing tests**

For all manifest routes, assert authenticated desktop mode resolves only declared authorities, all required operations are non-empty for center-backed routes, and every unsupported capability has a visible disabled-state matcher. Assert that a throwing `createDemoStore` test double is never touched while rendering any authenticated route. Fix the stale `agent-center-shell.spec.ts` expectation so `#dashboard` remains Dashboard and `#agents` remains the real agent center.

- [ ] **Step 2: Replace the catch-all demo renderer with explicit real route factories**

Route startup selects a named controller for each route. Header primary actions must invoke a real controller action or render an honest disabled explanation; remove generic “已模拟完成” toasts. Do not copy old HTML, change colors, or create a second navigation tree.

- [ ] **Step 3: Run the frontend authority gate**

```bash
pnpm --filter ./frontend test
pnpm --filter ./frontend build:desktop
git diff --check
```

Expected: all authenticated routes have an explicit non-demo authority and no test needs localStorage business seeds.

---

### Task 2B: Make Dashboard center-authoritative

**Files:**
- Create: `frontend/src/dashboard/runtime-api.ts`
- Create: `frontend/src/dashboard/runtime-api.self-test.ts`
- Create: `frontend/src/dashboard/controller.ts`
- Create: `frontend/src/dashboard/controller.self-test.ts`
- Create: `frontend/src/dashboard/view.ts`
- Create: `frontend/src/dashboard/view.self-test.ts`
- Modify: `frontend/src/demo/demo-app.ts`
- Modify: `frontend/src/self-test.ts`

**Existing Backend contracts:**
- `GET /api/dashboard/summary`
- `POST /api/dashboard/priority-tasks/batch-process`

- [ ] **Step 1: Write red API/controller/view tests**

Assert strict decoding, auth/abort/error states, reload persistence, and exact truthful mappings: `briefing.unreadWecom` is “企微待归档”, the sum of `pipelineHealth[].count` is “进行中商机”, `metrics.forecastAmount` is “活跃商机金额” unless a formal forecast contract is later added, and `metrics.todos` is “待办事项”. Do not infer multi-platform active conversations or probability-weighted revenue from unrelated fields.

- [ ] **Step 2: Render the current card hierarchy from the center response**

Keep the black/green layout and existing navigation actions. Batch-processing uses the existing endpoint with CSRF/idempotency behavior and refreshes from the server; it never updates a local optimistic business store as final truth.

- [ ] **Step 3: Run focused and Backend contract checks**

```bash
pnpm --filter ./frontend test
pnpm --filter ./backend build
git diff --check
```

Expected: a reload returns identical center-backed metrics and no Dashboard text claims browser-local demo data.

---

### Task 2C: Complete real Private Domain and Conversion flows

**Files:**
- Modify: `frontend/src/private-domain/runtime-api.ts`
- Modify: `frontend/src/private-domain/runtime-api.self-test.ts`
- Modify: `frontend/src/private-domain/controller.ts`
- Modify: `frontend/src/private-domain/controller.self-test.ts`
- Modify: `frontend/src/private-domain/view.ts`
- Modify: `frontend/src/private-domain/view.self-test.ts`
- Modify: `frontend/src/private-domain/deal-create-controller.ts`
- Modify: `frontend/src/private-domain/deal-create-controller.self-test.ts`
- Create: `frontend/src/conversion/runtime-api.ts`
- Create: `frontend/src/conversion/runtime-api.self-test.ts`
- Create: `frontend/src/conversion/controller.ts`
- Create: `frontend/src/conversion/controller.self-test.ts`
- Create: `frontend/src/conversion/view.ts`
- Create: `frontend/src/conversion/view.self-test.ts`
- Modify: `frontend/src/growth/quotes/entry.ts`
- Modify: `frontend/src/growth/quotes/entry.self-test.ts`
- Modify: `frontend/src/self-test.ts`
- Modify: `frontend/src/demo/demo-app.ts`

**Existing Backend contracts:** authenticated customer reads/updates, customer activities, customer-linked plan tasks, todos, the `/api/deals` lifecycle, and the existing quote workbench/lifecycle.

- [ ] **Step 1: Capture red persistence and navigation regressions**

Test customer edit, activity, follow-up task, deal creation, authoritative deal stages (`询盘/已联系/已报价/样品/谈判/成交/丢单`), lost reason, close/archive behavior, reload, and tenant isolation. Add the missing listener for `goodjob:quote-workbench-requested`; today `deal-create-controller.ts` dispatches it but `growth/quotes/entry.ts` does not consume it, so the visible button is not a completed integration.

- [ ] **Step 2: Replace seeded opportunities with `/api/deals`**

Use server IDs/revisions and refetch after mutations. Do not silently map the six old demo stages, report “报价已发送” without a send receipt, call won totals “待回款”, or offer editable probability when no authoritative deal-forecast contract exists. Preserve unsupported source/group/tag/summary fields read-only when supplied by a real response; otherwise show “暂未接入” rather than persisting them locally. Bulk outreach is enabled only for customers with current acquisition bindings and uses the existing human-approved acquisition batch flow.

- [ ] **Step 3: Run the real CRM/deal/quote gate**

```bash
pnpm --filter ./frontend test
pnpm --filter ./backend test:growth-quotes
pnpm --filter ./backend build
git diff --check
```

Expected: a created deal is visible after a full route reload, the quote workbench opens, and no enabled CRM/deal control depends on DemoState.

---

### Task 2D: Replace Scripts with real Douyin/prospect workflows

**Files:**
- Create: `frontend/src/workflows/runtime-api.ts`
- Create: `frontend/src/workflows/runtime-api.self-test.ts`
- Create: `frontend/src/workflows/controller.ts`
- Create: `frontend/src/workflows/controller.self-test.ts`
- Create: `frontend/src/workflows/view.ts`
- Create: `frontend/src/workflows/view.self-test.ts`
- Modify: `frontend/src/demo/demo-app.ts`
- Modify: `frontend/src/demo/demo-capabilities-view.ts`
- Modify: `frontend/src/self-test.ts`

**Existing Backend contracts:** Douyin plan automation under `/api/v1/acquisition/plans/:planId/automation` (including `run-now`) and prospect campaigns, strategies, schedules, and runs under their existing `/api/prospect-*` routes.

- [ ] **Step 1: Write red workflow contract tests**

Assert list/load/save/pause/run/reload behavior using exact existing methods, revisions, CSRF, idempotency, workspace scoping, and error states. Import the tests from `self-test.ts`.

- [ ] **Step 2: Render real workflows without inventing platform adapters**

Keep the five-platform card layout. Douyin and generic prospect strategies use real controllers. Xiaohongshu, Kuaishou, WeChat, and Weibo remain visible but disabled as “未接入平台执行器”; a toggle with only local persistence is forbidden. A registry row without a working adapter cannot be called complete.

- [ ] **Step 3: Run workflow gates**

```bash
pnpm --filter ./frontend test
pnpm --filter ./backend test:prospect-campaigns
pnpm --filter ./backend test:prospect-strategies
pnpm --filter ./backend test:prospect-runs
pnpm --filter ./backend test:prospect-scheduler
git diff --check
```

Expected: supported workflow changes survive reload; unsupported platforms cannot mutate fake state.

---

### Task 2E: Replace Trade Marketing preview with real market/campaign data

**Files:**
- Create: `frontend/src/trade-marketing/runtime-api.ts`
- Create: `frontend/src/trade-marketing/runtime-api.self-test.ts`
- Create: `frontend/src/trade-marketing/controller.ts`
- Create: `frontend/src/trade-marketing/controller.self-test.ts`
- Create: `frontend/src/trade-marketing/view.ts`
- Create: `frontend/src/trade-marketing/view.self-test.ts`
- Modify: `frontend/src/demo/demo-app.ts`
- Modify: `frontend/src/demo/demo-capabilities-view.ts`
- Modify: `frontend/src/self-test.ts`

**Existing Backend contracts:** prospect campaign snapshots/strategies, market-analysis runs, trade observations, market opportunities, prospect-to-lead/customer conversion, and one-off development-email draft/send.

- [ ] **Step 1: Write red strict-decoder and persistence tests**

Cover campaign/market cards, analysis creation/status, observations, opportunities, conversion, development-email draft, reload, and tenant isolation. Automated tests stop before real email send; a send UI requires its existing explicit confirmation and a server receipt.

- [ ] **Step 2: Preserve layout while narrowing unsupported claims**

Render real markets/languages/customer types and analysis results in the current hierarchy. A localized multi-step cadence/sequence remains visibly unavailable until a durable sequence contract and executor exist; never present a one-off email call as an active sequence.

- [ ] **Step 3: Run market and campaign gates**

```bash
pnpm --filter ./frontend test
pnpm --filter ./backend test:market-analysis-runs
pnpm --filter ./backend test:trade-observation-list
pnpm --filter ./backend test:market-opportunity-list
pnpm --filter ./backend test:prospect-customer-conversion
git diff --check
```

Expected: every enabled action has center persistence and unsupported sequence controls are non-interactive and explicit.

---

### Task 2F: Replace Settings demo data with real account, reminder, and connection state

**Files:**
- Create: `frontend/src/settings/runtime-api.ts`
- Create: `frontend/src/settings/runtime-api.self-test.ts`
- Create: `frontend/src/settings/controller.ts`
- Create: `frontend/src/settings/controller.self-test.ts`
- Create: `frontend/src/settings/view.ts`
- Create: `frontend/src/settings/view.self-test.ts`
- Modify: `frontend/src/connections/connection-api.ts`
- Modify: `frontend/src/connections/connection-controller.self-test.ts`
- Modify: `frontend/src/connections/connection-view.self-test.ts`
- Modify: `frontend/src/demo/demo-app.ts`
- Modify: `frontend/src/demo/demo-capabilities-view.ts`
- Modify: `frontend/src/self-test.ts`

**Existing Backend contracts:** `/api/auth/me`, `/api/profile`, email binding/test, `/api/company-profile`, `/api/reminders`, acquisition search/provider connections, and `/api/v1/ai/connections`.

- [ ] **Step 1: Write red Settings authority tests**

Cover strict read/update/reload, actual role display, reminder/SMTP state, secret redaction, disabled synthetic model connection creation/revocation without provider test, and connection modal integration. Seeded counts and “reset demo data” must be absent in authenticated desktop mode.

- [ ] **Step 2: Render current settings cards from real sources**

The fixed black/green desktop appearance is read-only, not a fake theme preference. Site/platform notification preferences and member permission-matrix editing remain explicitly unavailable until those Backend contracts exist; the current effective role and real reminder/email controls remain available.

- [ ] **Step 3: Run Settings and security gates**

```bash
pnpm --filter ./frontend test
pnpm --filter ./backend test:security
pnpm --filter ./backend build
git diff --check
```

Expected: connection secrets never reappear in DOM/log/response fixtures and every enabled setting survives reload.

---

### Task 2G: Lock honest Agents and Conversations semantics

**Files:**
- Modify: `frontend/src/growth/agents/controller.ts`
- Modify: `frontend/src/growth/agents/controller.self-test.ts`
- Modify: `frontend/src/growth/agents/real-api.ts`
- Modify: `frontend/src/growth/agents/real-controller.ts`
- Modify: `frontend/src/growth/agents/view.ts`
- Modify: `frontend/src/conversations/real-api.ts`
- Modify: `frontend/src/conversations/real-api.self-test.ts`
- Modify: `frontend/src/conversations/real-controller.ts`
- Modify: `frontend/src/conversations/real-controller.self-test.ts`
- Modify: `frontend/src/conversations/real-view.ts`
- Modify: `frontend/src/conversations/real-view.self-test.ts`
- Modify: `frontend/src/demo/demo-app.ts`
- Modify: `frontend/src/self-test.ts`

- [ ] **Step 1: Write red no-fallback and semantic tests**

`#agents` is the existing server-backed financial council/AI business-advisor surface; it may not fall back to the three fake marketing agents or show a fake “新建智能体” success. `#conversations` is public Douyin evidence, human approval, action state, and receipts; it may not label those records as a multi-platform inbound inbox or permit a local fake reply/transfer.

- [ ] **Step 2: Preserve every currently real operation**

Keep financial-council package/policy/model-routing/run operations and acquisition evidence/comment/private-message approval/status operations. Narrow headings and disabled copy to their real authority without changing the visual system. A future normalized social inbox or marketing-agent CRUD/policy requires both a separate reviewed Backend contract and working platform adapters; it is not fabricated inside this migration.

- [ ] **Step 3: Run agent/conversation/acquisition gates**

```bash
pnpm --filter ./frontend test
pnpm --filter ./backend test:financial-council
pnpm --filter ./backend test:business-advisor
pnpm --filter ./backend test:acquisition
git diff --check
```

Expected: both routes reload center state, all real actions remain available, and neither route reads DemoStore.

---

### Task 3: Disposable API-only route parity smoke

**Files:**
- Create: `frontend/playwright.desktop-api-only.config.ts`
- Create: `frontend/tests/desktop-api-only-route-parity.spec.ts`
- Create: `frontend/tests/fixtures/desktop-feature-routes.ts`
- Create: `desktop/scripts/serve-test-renderer.mjs`
- Create: `desktop/tests/serve-test-renderer.test.ts`
- Modify: `frontend/package.json`
- Modify: root `package.json`

**Interfaces:**
- Produces the low-level `pnpm test:e2e:desktop-api-only` and guarded orchestrator `pnpm api:verify:desktop-route-parity`.
- Consumes `SHENSI_TEST_ORIGIN`, `SHENSI_TEST_EMAIL`, and `SHENSI_TEST_PASSWORD`; values are supplied through the environment and never printed.
- Requires a disposable API-only runtime from the companion plan and the real desktop Renderer server implementation; it must reject a Trial/Web origin and must never target the retained database.

- [ ] **Step 1: Add a test fixture with the exact route and heading contracts**

```ts
import { DESKTOP_FEATURE_ROUTES } from "../../src/desktop/desktop-feature-manifest";

export const desktopRouteCases = DESKTOP_FEATURE_ROUTES.map(
  ({ id, hash, heading }) => ({ id, hash, heading }),
);
```

Populate each manifest heading matcher from the current real view and its existing view self-test, so the Playwright fixture covers all 15 canonical features without maintaining a second list. A heading change is accepted only together with a deliberate current UI copy change and its view self-test; do not weaken checks to generic `main` visibility.

- [ ] **Step 2: Write the red Playwright test**

The test must:

1. validate that `SHENSI_TEST_ORIGIN` is an exact loopback origin;
2. log in through the visible Shensi form;
3. visit each route case and assert its heading and authenticated shell;
4. record every `/api` response with status 400 or greater;
5. reject any request containing `/live-sessions`, `novnc`, `websockify`, `douyin-live`, or a WebSocket upgrade;
6. assert every route root's `data-authority` equals its manifest declaration, no authenticated route touches DemoStore/localStorage business keys, and every enabled control maps to a declared real operation;
7. reload `#acquisition` and `#agents` to prove server state, not route memory, restores them;
8. run at 1440×900 and 390×844 and assert no horizontal document overflow.

- [ ] **Step 3: Add the exact test commands**

```json
{
  "test:e2e:desktop-api-only": "playwright test --config=playwright.desktop-api-only.config.ts --project=chromium"
}
```

Add the root alias with `pnpm --filter ./frontend test:e2e:desktop-api-only`. Add `api:verify:desktop-route-parity` as the only operator-level command; it owns the disposable runtime, Renderer subprocess, private generated credentials, evidence file, and bounded cleanup.

- [ ] **Step 4: Run red against an intentionally stopped API-only origin**

Run:

```bash
SHENSI_TEST_ORIGIN=http://127.0.0.1:59999 \
SHENSI_TEST_EMAIL="$SHENSI_DESKTOP_TEST_EMAIL" \
SHENSI_TEST_PASSWORD="$SHENSI_DESKTOP_TEST_PASSWORD" \
pnpm test:e2e:desktop-api-only
```

Expected: FAIL before login because no Renderer owns the intentionally unused loopback port. Do not print the two secret environment values, and do not point this red test at Gateway `5608` or `5628` because a Gateway is not a Renderer origin.

- [ ] **Step 5: Implement the guarded test Renderer and route-parity orchestrator**

`serve-test-renderer.mjs` imports and invokes the real `startRendererServer()` implementation. It accepts only the built `frontend/dist-desktop` directory and exact disposable API origin `http://127.0.0.1:5628`, binds a random `127.0.0.1` port, prints one structured ready record, and closes on SIGTERM. Its tests reject a non-loopback bind, a retained/Trial API origin, a source directory outside `frontend/dist-desktop`, symlinks, redirects, and duplicate shutdown.

`api:verify:desktop-route-parity` builds `frontend/dist-desktop`, creates one validated disposable `shensi-api-empty-<12hex>` runtime on `5628/3312`, starts the test Renderer, captures its structured random origin, and passes that origin plus run-scoped generated credentials only through the Playwright child environment. In a `finally` path it terminates the Renderer and invokes only the companion plan's exact disposable-project cleanup guard. It writes a sanitized route/status report and never prints credentials, cookies, database URLs, or response bodies.

- [ ] **Step 6: Run the parity smoke green**

Run `pnpm api:verify:desktop-route-parity`. Expected: all route cases pass, no forbidden request or API error is recorded, and the task-owned Renderer, containers, network, runtime root, and disposable volume are gone. Trial and the retained API-only project remain untouched.

- [ ] **Step 7: Run regression gates**

```bash
pnpm --filter ./frontend test
pnpm --filter ./frontend build:desktop
pnpm --dir desktop test
pnpm --dir desktop typecheck
git diff --check
```

Expected: all exit 0.

---

### Task 4: Core business mutation smoke without real platform writes

**Files:**
- Create: `frontend/tests/desktop-api-only-business-flow.spec.ts`
- Create: `frontend/tests/fixtures/desktop-business-fixture.ts`
- Create: `backend/src/desktop-business-fixture.ts`
- Create: `backend/src/desktop-business-fixture-test.ts`
- Create: `backend/src/desktop-business-fixture-cli.ts`
- Modify: `scripts/api-only-runtime.mjs`
- Modify: `scripts/api-only-runtime.test.mjs`
- Modify: root `package.json`
- Modify: `frontend/playwright.desktop-api-only.config.ts`

**Interfaces:**
- Produces `pnpm api:verify:desktop-business-flow`, which creates a validated disposable `shensi-api-empty-<12hex>` project on `5628/3312`, serves `frontend/dist-desktop` through the real Electron Renderer server, runs the Playwright flow, and removes only that disposable project/volume.
- Uses ordinary public UI/API contracts for product mutations. A fixed test-only CLI seeds only the otherwise non-creatable public candidate/evidence projection through existing Backend repositories; it is never mounted as an HTTP route, never included as a user capability, and refuses every non-disposable database/lock nonce.
- It never connects to Douyin, sends email, calls a model/search provider, or confirms an outreach action.
- Emits only record IDs and route/status summaries, never credentials, API keys, prompts containing secrets, or customer content.

- [ ] **Step 1: Add a fixture API for isolated test data**

```ts
export interface DesktopBusinessFixture {
  workspaceId: string;
  acquisitionPlanId: string;
  candidateId: string;
  evidenceRecordIds: readonly string[];
  dealId: string;
  campaignId: string;
}
```

The browser fixture creates normal data through authenticated application APIs and uses a run-specific account/workspace name prefixed `e2e-desktop-api-only-`. `desktop-business-fixture-cli.ts` receives a generated nonce only from the supervisor, proves the matching live `disposable-5628-3312` owner record, requires host port `3312`, a database/project/root matching the current disposable suffix, and inserts a frozen synthetic public candidate/evidence projection through the same repositories used by acquisition. It has no cleanup/delete mode. Cleanup destroys the whole validated disposable volume only after Playwright exits; it never issues row deletes and cannot address retained API-only or Trial data.

- [ ] **Step 2: Write red UI/API flow tests**

Cover these exact center-data behaviors:

- register, log out, and log in again;
- load Dashboard summary and run only the existing safe priority-task batch operation;
- create a customer activity and follow-up, create one deal from Private Domain, open the real quote workbench, then reload and read the customer/deal back;
- change the deal through one authoritative `/api/deals` stage transition, reload Conversion, and verify the server revision;
- create/revise one prospect campaign/strategy/schedule and one Douyin plan automation revision, but do not run a platform executor;
- create one market-analysis run against deterministic fixture inputs and read trade observations/opportunities; do not send development email;
- create one disabled model connection with a synthetic non-working credential, never call its provider-test or enable endpoint, confirm the secret is redacted from DOM/response/console/logs, then revoke it through the public contract;
- create one acquisition plan and read its frozen version;
- seed one deterministic candidate/evidence projection through exact `backend/src/desktop-business-fixture-cli.ts`, open Acquisition and Conversations, and render the outreach approval review but stop before its confirmation checkbox/action;
- load the real financial-council Agent Center and verify readiness/current policy without starting a provider-backed run;
- verify tenant isolation with a second isolated workspace.

- [ ] **Step 3: Extend the disposable-cleanup safety tests**

Reuse the API-only plan's cleanup tests to reject retained project `shensi-api`, any mismatched suffix/root, any non-task-owned volume, and any attempt to remove `.runtime/real-trial`. Reuse, rather than duplicate, the tested `serve-test-renderer.mjs` lifecycle from Task 3.

- [ ] **Step 4: Implement the bounded business-flow orchestrator**

Add `api:verify:desktop-business-flow` to the root scripts. Its ordering is exact: build `frontend/dist-desktop`; create/start one disposable API-only runtime; start `serve-test-renderer.mjs`; wait for its structured origin; run the Playwright business-flow test with generated credentials held only in child environment; terminate the test Renderer; run the disposable gateway/module audit; destroy the validated disposable project and volume; write a sanitized report. A failure at any point still terminates the Renderer and attempts only validated disposable cleanup.

- [ ] **Step 5: Run red against the API-only E2E runtime**

Run: `pnpm api:verify:desktop-business-flow`

Expected: FAIL on the first unimplemented module integration, fixture guard, or proxy contract with route/method/status/request ID but no body/secret. Do not change production behavior until the failing request and its current contract are captured.

- [ ] **Step 6: Make only evidence-backed compatibility fixes**

Permitted fixes are limited to the files and real contracts named in Tasks 2A–2G, the locked Renderer proxy behavior in Task 2, and this task's disposable fixture/orchestrator. Any newly discovered missing Backend contract stops this task for plan review; it is not implemented under a generic “compatibility fix”. Do not add demo fallbacks, localStorage business state, an alternate desktop-only Backend, production fixture routes, or route-specific fake results.

- [ ] **Step 7: Run the flow and reload assertions green**

Run: `pnpm api:verify:desktop-business-flow`

Expected: all route and business-flow cases pass; the outreach approval confirmation remains untouched; the task-owned Renderer, containers, network, runtime root and disposable volume are gone; Trial and retained API-only data are untouched.

- [ ] **Step 8: Run full non-platform-write gates**

```bash
pnpm test:contracts
pnpm test:layout
pnpm test:mediacrawler-provenance
pnpm --filter ./backend test
pnpm --filter ./frontend test
pnpm --dir desktop test
pnpm --dir desktop typecheck
pnpm --filter ./contracts check:types
pnpm --filter ./backend build
pnpm --filter ./frontend build:desktop
node --test scripts/api-only-runtime.test.mjs
cd desktop/tests && ../node_modules/.bin/tsx --test serve-test-renderer.test.ts
git diff --check
```

Expected: all exit 0.

---

### Task 5: Installed-app cold-start acceptance harness

**Files:**
- Create: `scripts/desktop-cold-start-audit.mjs`
- Create: `scripts/desktop-cold-start-audit.test.mjs`
- Create: `scripts/desktop-acceptance-evidence.mjs`
- Create: `scripts/desktop-acceptance-evidence.test.mjs`
- Create: `desktop/scripts/installed-app-route-acceptance.mjs`
- Create: `desktop/scripts/installed-app-route-acceptance.test.mjs`
- Create: `desktop/scripts/package-macos-dir.sh`
- Modify: `desktop/scripts/verify-package.mjs`
- Modify: `desktop/electron-builder.yml`
- Modify: `desktop/package.json`
- Modify: `desktop/tests/build-contract.test.ts`
- Modify: `desktop/tests/package-content-policy.test.ts`
- Modify: root `package.json`
- Create: `docs/desktop/acceptance/macos-api-only-checklist.md`

**Interfaces:**
- Produces `pnpm desktop:audit:cold-start`.
- Produces non-destructive `pnpm desktop:acceptance:seal`, the sole public live-acceptance coordinator. It creates the owner run/nonce, invokes the package, API, cold-start, and visible installed-App route checks itself, repeats the required checks after closing the App, hash-copies the command-owned results to stable evidence, and only then emits the immutable receipt consumed by API acceptance and Task 8. It never seals loose reports produced by an earlier manual command sequence.
- The coordinator invokes `desktop/scripts/installed-app-route-acceptance.mjs` through an inherited owner capability. That adapter opens the exact packaged App visibly, authenticates with the existing acceptance credential held only in child memory, walks every `DESKTOP_FEATURE_ROUTES` entry through the current Renderer, verifies the expected heading and API status at each step, permits operator observation/cancel, closes the App, and returns a nonce-bound structured result. It cannot run headless, perform a mutation, contact Douyin, or accept operator-authored route-result JSON.
- Produces `pnpm desktop:package:dir`, which builds one run-scoped, explicitly `fixtureOnly:true` development `.app` from the current source without producing a DMG/ZIP or replacing `/Applications/Shensi.app`. This standalone Task 5 artifact is non-promotable and cannot write into or masquerade as a Task 8 joint-milestone root.
- Every built App contains strict canonical `Contents/Resources/desktop-build-manifest.json`. Its versioned fields bind the scoped source, Renderer, Main, Sidecar, runtime-config, architecture, and bundle ID hashes; `desktopBuildManifestSha256` is the SHA-256 of those canonical bytes and is also recorded in the external App manifest. The package tree hash is recorded separately, so the embedded identity is not self-referential. The manifest must be a regular non-symlink file with exact mode `0644`; owner-write is permitted for normal build tooling, while every group/world-write bit is rejected. `verify-package.mjs` recomputes both and rejects a missing, extra-field, symlinked, non-`0644`, stale, or mismatched embedded manifest.
- The sealed Task 5 receipt may mark this `fixtureOnly:true` App only as `recoverySeedCandidate:true`, never promotable/current. It binds the migration attempt, target image/config/API-contract/schema identities and both read-only acceptance passes. Task 8 may treat it as `verifiedRollbackSeed` only when the later API-acceptance receipt proves that exact attempt/App evidence became the prior active service tuple without an incompatible contract/schema change.
- The audit is read-only: it checks process ownership, ports, API routes, app runtime config, and forbidden remote-display processes/requests.
- It never launches a real comment/private-message action and never deletes or stops a process.

- [ ] **Step 1: Write red tests around injected process and HTTP inspectors**

```js
const result = await auditDesktopColdStart({
  appConfig: { remoteOrigin: "http://127.0.0.1:5608" },
  listeningPorts: [5608],
  processes: ["Shensi", "shensi-sidecar", "Chromium", "docker"],
  request: fakeRequest({ root: 404, healthz: 200, apiHealth: 200 }),
});
assert.equal(result.ok, true);
assert.deepEqual(result.forbiddenProcesses, []);
```

Add failures for `vite preview`, `cloudflared`, `Xvfb`, `x11vnc`, `websockify`, `novnc_proxy`, a server MediaCrawler port, `/` returning 200, and `/live-sessions/test` returning anything other than 404. Add package-dir tests that reject output outside exact `.runtime/desktop-acceptance/<12hex>`, symlinks, existing unrelated contents, a source/build commit mismatch, and any electron-builder argument containing `dmg` or `zip`. Assert standalone mode exclusively creates its own root and emits `fixtureOnly:true`; the later coordinator mode requires the already-held milestone owner lock plus an inherited private capability, creates only its fixed absent `app/` child, and cannot be selected by a public package alias, argv, or environment flag. Add embedded-build-manifest fixtures that accept exact regular-file mode `0644` and reject every other mode, plus canonical bytes, exact field set, external/embedded digest mismatch, changed Renderer/Main/Sidecar/config input, and the separate non-circular App-tree hash. Test the route adapter against a fake packaged Electron process and API inspector: reject a missing/duplicate route, wrong heading, mutation, forbidden request, headless launch, early exit, open helper, or forged result. Test `desktop:acceptance:seal` rejects any caller-supplied report/result path, a newest-file lookup, missing owner nonce, mismatched App/source/config/build-manifest hash, incomplete before/after pair, failed route, report replay, symlink, non-`cutover_read_only` state, changed migration attempt, target image/Gateway/API-contract/schema identity drift, or destination collision; success with injected command adapters atomically writes an immutable receipt whose hashes resolve to every stable copy and whose recovery flag cannot be misread as promotion eligibility.

- [ ] **Step 2: Implement the pure audit and a macOS adapter**

The adapter may use `ps`, `lsof`, app bundle JSON reads, and HTTP GET/HEAD. It must use exact executable/argument matching and structured JSON output. Do not kill processes or read environment variables of unrelated processes.

In standalone mode, `package-macos-dir.sh` creates an exclusive owner-only `.runtime/desktop-acceptance/<12hex>` root, builds the latest Renderer/Main/Sidecar, writes the exact loopback runtime config and canonical embedded build manifest, invokes electron-builder with `--dir` and an output override inside that root, and records source commit, scoped source-diff hash, app path, config hash, embedded build-manifest hash, bundle tree hash, architecture, build time, and `fixtureOnly:true`. Electron Builder copies the two generated resources by fixed basename; packaging fails if either is absent or changed after its pre-build hash. It must produce exactly one `Shensi.app` and no DMG/ZIP. Its internal coordinator mode is not a public CLI contract: Task 8 invokes it while holding the owner lock and an inherited pipe/file-descriptor capability, and it exclusively creates only the fixed absent `app/` child beneath a pre-created joint root. A caller cannot request coordinator mode through a path argument, environment flag, or package alias.

Only while migration state is exactly `cutover_read_only`, `desktop:acceptance:seal` acquires the Task 5 owner lock and creates a fresh owner-only evidence run/nonce. It invokes, through explicit argv and inherited nonce/capability, package verification, `api:verify`, and cold-start audit; launches the exact packaged App through the visible route adapter; closes it and every helper; then repeats package/API/cold-start verification. Each child writes only beneath the coordinator run and returns a structured result bound to its nonce, exact App manifest/tree/build digest, target image/Gateway/schema/API-contract identities, and migration attempt. The coordinator validates both package results, both cold-start reports, both API-verification reports, the complete route result, unchanged state/identities, and zero live App/helper before hash-copying/fsyncing them into fixed owner-only `.runtime/api-only/evidence/desktop-acceptance/<run-id>/`. It then atomically writes/fsyncs `desktop-acceptance-receipt.json` containing every source/destination hash plus `fixtureOnly:true`, `promotable:false`, and `recoverySeedCandidate:true`. It never accepts operator-authored pass JSON, caller-supplied report paths, or a newest result. Verify that immutable receipt before deleting anything. Cleanup may remove only the exact closed `Shensi.app` and owner-manifested temporary build children that no later manifest references; it never deletes the whole run root or any original/stable evidence record. Retain the candidate App until Task 8 either selects and binds it as the verified recovery seed or terminally records a different verified seed.

- [ ] **Step 3: Add the operator checklist**

The checklist must record pass/fail/not-run for:

- installed app launch and authentication;
- every route from `DESKTOP_FEATURE_ROUTES`;
- model connection secret redaction;
- agent/workflow persistence;
- external visible Douyin login and manual verification;
- one collection and center persistence across restart;
- separately authorized one-comment and one-private-message checks after the action-bridge plan passes;
- network loss, Sidecar restart, Backend restart, and app restart;
- absence of Web frontend, Tunnel, server Sidecar, Xvfb/VNC/noVNC, and `/live-sessions`.

- [ ] **Step 4: Run the harness unit tests before migration/cutover**

```bash
node --test scripts/desktop-cold-start-audit.test.mjs scripts/desktop-acceptance-evidence.test.mjs desktop/scripts/installed-app-route-acceptance.test.mjs
pnpm --dir desktop exec tsx --test tests/build-contract.test.ts
SHENSI_REMOTE_ORIGIN=http://127.0.0.1:5608 pnpm desktop:package:dir
node desktop/scripts/verify-package.mjs /exact/task5-run/Shensi.app development
git diff --check
```

Replace `/exact/task5-run/Shensi.app` with the absolute app path printed by `desktop:package:dir`; never rely on the verifier's legacy default path. Expected: unit tests pass and one current-source run-scoped `.app` exists with a structured manifest and no DMG/ZIP. This pre-cutover step does not open the app or claim the live cold-start topology is ready while Trial/Web processes still exist.

- [ ] **Step 5: Run the live read-only audit only after authorized read-only cutover**

This operational step is executed exactly once by API companion Task 7 Step 5 after `cutover_read_only`; do not run or seal it earlier from this feature plan. That step invokes the sole `desktop:acceptance:seal` coordinator against the manifest-bound run-scoped App, so the two package/API/cold-start passes and route evidence share one command-owned nonce and immutable target identity. A failure rolls back before write acceptance and retains the exact structured diagnostics without emitting a success receipt. Retain this one task-owned acceptance App until Task 8 has produced and verified the final post-retirement current-source App and stable evidence copies; then remove only the exact old App/build-temporary children after run ID/path/hash/process and no-reference validation. Preserve the run/evidence records; never delete the whole Task 5 run root. Do not touch `/Applications/Shensi.app` in this task.

---

### Task 6: Manifest-driven Web runtime retirement

**Files:**
- Create: `scripts/web-runtime-retirement.mjs`
- Create: `scripts/web-runtime-retirement.test.mjs`
- Create: `docs/operations/web-runtime-retirement.md`
- Modify: root `package.json`

**Interfaces:**
- Produces `pnpm web:retirement:audit`, `pnpm web:retirement:dry-run`, `pnpm web:retirement:execute`, `pnpm web:retirement:purge:prepare`, and `pnpm web:retirement:purge`.
- Default mode is read-only and emits a versioned JSON manifest.
- Execute mode requires an exact previously generated manifest hash and refuses to cross repository/runtime roots or touch protected paths.
- Recoverable execution stages only below owner-only `.runtime/web-retirement/staging/<UTC-basic>-<12hex>` on the repository filesystem. Before the first move it writes/fsyncs a `0600` `staging_pending` journal binding the run/owner, manifest hash, and complete original→staged mapping; each completed move advances that journal atomically. Only a fully completed journal may be sealed into the immutable receipt copied to `.runtime/api-only/evidence/web-retirement/<run-id>.json`; the evidence copy is never staged or purged.

- [ ] **Step 1: Write red path-classification tests**

```js
assert.equal(classifyRetirementPath(".runtime/real-trial/pids/backend.json"), "removable-runtime");
assert.equal(classifyRetirementPath(".runtime/real-trial/release/frontend"), "removable-runtime");
assert.equal(classifyRetirementPath(".runtime/real-trial/state/mysql"), "protected-data");
assert.equal(classifyRetirementPath(".runtime/real-trial/secrets"), "protected-secret");
assert.equal(classifyRetirementPath("frontend/src/app-entry.ts"), "protected-source");
```

Also reject absolute paths, `..`, symlinks escaping an allowed root, unresolved environment-variable paths, broad workspace roots, and any recursive target equal to `.runtime`, `frontend`, `services`, `desktop`, or the repository root. Add disk-space and purge tests: audit reports bytes reclaimable/staged/currently free; execute requires staging to be on the same filesystem and enough free metadata headroom; purge rejects age under seven days, missing one-use confirmation, changed receipt/hash, an active/open file, unknown label/type, symlink, protected path, Trial datadir/secrets, database backup, migration evidence, Profile, current source/build input, or the active target. Inject crashes before the first move, after every individual move/journal update, and after the final move but before immutable-receipt sealing; retry must reconcile each exact source/staged hash from the journal and manifest, while any unknown or duplicated topology fails closed without moving or deleting another path.

- [ ] **Step 2: Write red prerequisite-gate tests**

Execution must fail unless the supplied acceptance record proves:

- API-only health is green;
- route parity and business-flow smoke are green;
- desktop action bridge gates are green;
- `desktop:audit:cold-start` reports no old Web dependency;
- an encrypted database backup and verification report exist;
- migration state is exactly `accepted` with `activeRuntime:"target"`;
- the Trial runtime is stopped;
- the operator explicitly supplied the exact manifest hash.

- [ ] **Step 3: Implement audit and dry-run modes**

The manifest records path, type, byte size, last-modified time, expected owner category, and SHA-256 for regular files. It lists protected assets separately. Audit may recommend stopping services but cannot stop them.

- [ ] **Step 4: Implement recoverable execution**

Create the staging root exclusively with mode `0700`; its run ID and manifest hash must match the acceptance attempt. Before the first mutation, write and fsync a `0600` `staging_pending` journal containing the owner/run ID, complete immutable approved mapping, original path metadata/hashes, manifest hash, and active-project/build/evidence hashes. For each item, reconcile that exact original/staged pair, move it by same-filesystem atomic rename to the exact mirrored relative path, fsync both directories, and atomically replace/fsync the journal with its completed index and observed staged hash. After every item is proven moved and the final journal is fsynced, seal a separate immutable receipt containing the full mapping and results; copy/hash-verify that receipt into the protected API-only evidence directory before reporting success. A partial execution is resumable only from the same journal plus exact manifest and never broadens its target set; the final receipt cannot be used as a prerequisite before it exists. Do not move database, backups, secrets, Profiles, source, package locks, documentation, the accepted app, or active API-only resources.

- [ ] **Step 5: Add operator commands and recovery instructions**

```text
pnpm web:retirement:audit
pnpm web:retirement:dry-run -- --manifest <absolute-manifest-path>
pnpm web:retirement:execute -- --manifest <absolute-manifest-path> --sha256 <exact-hash>
pnpm web:retirement:purge:prepare -- --receipt <absolute-evidence-receipt>
SHENSI_WEB_RETIREMENT_PURGE_TOKEN_FILE=<printed-owner-only-path> \
  pnpm web:retirement:purge -- --receipt <absolute-evidence-receipt> --sha256 <exact-hash>
```

Document how to resume an interrupted execute from `staging_pending`, how to restore a completed staged runtime item from the immutable receipt, and how an unknown source/staged hash combination enters manual recovery without guessing. This is separate from database rollback: execute mode is forbidden before migration state `accepted`, and restoring staged Web artifacts never changes the accepted database state. Purge is a second destructive transaction permitted only after seven full days, exact active-project/engine/source/build/acceptance revalidation, zero open references, and a newly prepared one-use confirmation bound to the receipt hash. It unlinks only receipt-listed staged files and removes only empty receipt-listed directories; it can never follow symlinks or recursively target a broad root. Report reclaimed bytes and preserve the evidence receipt.

- [ ] **Step 6: Run focused safety gates**

```bash
node --test scripts/web-runtime-retirement.test.mjs
pnpm web:retirement:audit
git diff --check
```

Expected: tests pass; audit is read-only. Do not run execute mode until all prerequisite evidence exists.

---

### Task 7: Retire runnable Web/Trial entrypoints and remote-display implementation after acceptance

**Files:**
- Modify: `scripts/lib/process-ownership.mjs`
- Modify: `scripts/lib/process-ownership.test.mjs`
- Create: `scripts/lib/runtime-environment.mjs`
- Create: `scripts/lib/runtime-environment.test.mjs`
- Modify: `scripts/api-only-runtime.mjs`
- Modify: `scripts/api-only-runtime.test.mjs`
- Create: `scripts/source-entrypoint-retirement.mjs`
- Create: `scripts/source-entrypoint-retirement.test.mjs`
- Delete after terminal-acceptance and zero-reference proof: `scripts/trial-cutover-adapter.mjs` and `scripts/trial-cutover-adapter.test.mjs`
- Modify or delete after replacement coverage: `scripts/dev`, `scripts/dev.mjs`, `scripts/deploy`, `scripts/deploy.mjs`, `scripts/mediacrawler-runtime.mjs`, `scripts/verify`, `scripts/verify.mjs`, `scripts/real-trial-child.mjs`, `scripts/real-trial-config.mjs`, `scripts/real-trial-config.test.mjs`, `scripts/real-trial-gateway.mjs`, `scripts/real-trial-gateway.test.mjs`, `scripts/real-trial-runtime.mjs`, `scripts/real-trial-runtime.test.mjs`, `scripts/real-trial-showcase.mjs`, `scripts/real-trial-showcase.test.mjs`, `scripts/real-trial-sidecar-container.mjs`, `scripts/real-trial-sidecar-container.test.mjs`, `scripts/real-trial-verify.mjs`, `tools/start-real-local.mjs`, `backend/scripts/setup-trial-mysql.ts`, `backend/scripts/setup-local-mysql.ts`, `backend/scripts/local-real-runtime.ts`, and `backend/scripts/local-real-runtime-test.ts`
- Modify or delete after replacement coverage: `tools/runtime-scripts.test.mjs`, `tools/runtime-scripts-round1.test.mjs`, `tools/mediacrawler-deployment.test.mjs`, `tools/deployment-contract.test.mjs`, and `deploy/baota/build-package.test.mjs`; modify `tools/github-actions-workflow.test.mjs` to assert the replacement desktop/API-only CI gates and no Linux macOS-Sidecar package step, and modify `tools/mediacrawler-provenance.test.mjs` to fail if a future upstream sync reintroduces tracked `services/media-crawler/api/` or `webui/`
- Modify: root `package.json`, `backend/package.json`, root `pnpm-lock.yaml`, `.env.example`, `.github/workflows/quality.yml`, and `README.md`
- Modify: `docs/operations/api-only-runtime.md`, `docs/migration/2026-09-03-shensi-trial-to-api-only.md`, and `docs/PROJECT_STATUS.md` so no current operator path advertises a retired pre-accept command
- Modify: `frontend/package.json`, `frontend/pnpm-lock.yaml`, `frontend/README.md`, `frontend/vite.config.ts`, `frontend/src/app-entry.ts`, `frontend/src/app-route.ts`, `frontend/src/app-route.self-test.ts`, `frontend/src/app-session.ts`, `frontend/src/app-session.self-test.ts`, `frontend/src/self-test.ts`, `frontend/src/acquisition/acquisition-browser-runtime.ts`, `frontend/src/acquisition/acquisition-browser-runtime.self-test.ts`, `frontend/src/acquisition/douyin-automation-api.ts`, `frontend/src/acquisition/douyin-automation-api.self-test.ts`, `frontend/src/acquisition/douyin-automation-controller.ts`, `frontend/src/acquisition/douyin-automation-controller.self-test.ts`, `frontend/src/acquisition/douyin-automation-view.ts`, `frontend/src/acquisition/douyin-automation-view.self-test.ts`, `frontend/src/desktop/desktop-runtime.ts`, `frontend/src/desktop/desktop-runtime.self-test.ts`, and `frontend/src/replica-dashboard.css`
- Modify: `frontend/playwright.config.ts`, `frontend/tests/douyin-mediacrawler-acquisition.spec.ts`, and `frontend/tests/fixtures/douyin-mediacrawler-http-fixture.ts` so the default E2E no longer implements or expects the public QR/login-session contract
- Modify or replace with an Electron-owned bounded fixture: `scripts/run-task10-mysql-gate.mjs`, `frontend/playwright.douyin-mediacrawler-real.config.ts`, `frontend/tests/douyin-mediacrawler-real.spec.ts`, root `test:task10:browser`, and frontend `test:e2e:douyin-mediacrawler:real`; preserve a MySQL-only Task 10 fixture only if it has no browser/public-server branch, and no retained test alias may double as a production/public Web launcher
- Delete after verified zero runtime reference: `frontend/src/acquisition/douyin-rfb-runtime.ts`, `frontend/src/acquisition/douyin-live-login.ts`, `frontend/src/acquisition/douyin-live-login-entry.ts`, their two self-tests, `frontend/src/novnc.d.ts`, and eventually `frontend/src/desktop/remote-canvas-disabled.ts` after its denial assertion moves to the bundle scanner
- Modify only the remote-login surface in `backend/src/acquisition-application.ts`, `backend/src/acquisition-mediacrawler-gateway.ts`, `backend/src/acquisition-mediacrawler-gateway-test.ts`, `backend/src/acquisition-social-account.ts`, `backend/src/acquisition-social-account-repository.ts`, `backend/src/acquisition-social-account-mysql-repository.ts`, their focused tests, `backend/src/acquisition-social-account-router.ts`, `backend/src/acquisition-social-account-router-test.ts`, `backend/src/acquisition-social-account-service.ts`, `backend/src/acquisition-social-account-test.ts`, `backend/src/acquisition-openapi.ts`, `backend/src/acquisition-openapi-test.ts`, `backend/src/acquisition-openapi-response-conformance-test.ts`, `backend/src/acquisition-openapi-contract-drift-test.ts`, `backend/schema.mysql.sql`, `backend/goodjob_crm.full.sql`, `contracts/openapi/ai-acquisition.v1.yaml`, `contracts/test/openapi.test.mjs`, and regenerated `frontend/src/generated/ai-acquisition.ts`
- Modify only the remote-display surface in `services/media-crawler/shensi_adapter/app.py`, `accounts.py`, `browser_state.py`, `runtime_config.py`, and `schemas.py`; modify `services/media-crawler/tests/shensi_adapter/test_accounts.py`, `test_browser_state.py`, `test_desktop_runtime_integration.py`, `test_local_browser_session_manager.py`, `test_login_interactions.py`, `test_runtime_config.py`, and `test_contracts.py`; delete `services/media-crawler/tests/shensi_adapter/test_live_login.py` only after replacement external-window tests cover every retained invariant
- Delete after zero-reference proof: `services/media-crawler/Dockerfile.shensi`, `services/media-crawler/Dockerfile.shensi.dockerignore`, and `services/media-crawler/.dockerignore.shensi`
- Delete after a desktop-package/import proof: tracked `services/media-crawler/api/`, tracked `services/media-crawler/webui/`, and `services/media-crawler/tests/test_api_limits.py`; first move its retained `cmd_arg.parse_cmd` crawler/comment limit coverage into new `services/media-crawler/tests/test_cmd_arg_limits.py`. Modify `services/media-crawler/README.md`, `README_en.md`, and `README_es.md` to remove those upstream Web control-plane launch instructions while retaining crawler/CLI instructions
- Create: `services/media-crawler/tests/test_cmd_arg_limits.py`
- Modify: `desktop/shensi-sidecar.spec` and `desktop/tests/build-contract.test.ts` to prove the packaged Sidecar collects no `api` module or `webui` data. Within the tracked `services/media-crawler/` subtree, deletion authority is limited to `api/**`, `webui/**`, and `tests/test_api_limits.py`; every other tracked path is retained by default. Explicitly preserve `main.py`, `cmd_arg/`, `database/`, `var.py`, `model/`, `proxy/`, `cache/`, `config/`, `media_platform/`, `store/`, `base/`, `tools/`, `libs/`, `shensi_adapter/`, `tests/shensi_adapter/`, Python manifests/lockfiles, and the upstream license
- Delete after zero-reference proof: legacy `deploy/compose.yaml`, `deploy/nginx/default.conf`, `deploy/docker/frontend.Dockerfile`, and `deploy/baota/`; preserve `deploy/compose.api-only.yaml`, `deploy/nginx/api-only.conf`, `deploy/nginx/api-only-read-only.conf`, and `deploy/docker/backend.Dockerfile`
- Modify: `docs/API_INDEX.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `docs/PROJECT_STATUS.md`, `docs/THIRD_PARTY_NOTICES.md`, `docs/modules/acquisition.md`, `docs/desktop/macos-electron-client.md`, `docs/operations/real-customer-trial.md`, and `services/media-crawler/SHENSI_UPSTREAM.md`; archive the Trial runbook or mark it historical so it cannot remain a current operator entry point

**Interfaces:**
- Steps 1–4 require migration state exactly `accepted`, passing Task 5 live evidence, and Task 6 recoverable execute's hash-verified receipt, but they are deliberately non-destructive and must run before source-retirement authorization. The reviewed production mutations in Steps 5–9 and receipt recording in Step 10 are additionally blocked until the operator separately approves the exact Step 4 source/entrypoint before→after set and hash. Task 6 purge is not a prerequisite and remains optional after its seven-day gate.
- Removes executable public-Web, Trial-launcher, and remote-display paths only. It preserves the latest `frontend/` source, API-only runtime, Backend business services, the Sidecar internal `POST/GET/DELETE /internal/v1/douyin/login-sessions` endpoints used by Electron Main, external visible Chromium login, persistent Profiles, collection, comments, private messages, contracts, database migration tools, encrypted backups, evidence, and both source/target database data.
- Historical database rows and the already accepted live database's physical legacy default may retain `remote_canvas` for forensic/schema compatibility, but no current executable route, repository writer, configuration factory, or session factory may omit the field or create/serve a remote canvas. New bootstrap SQL explicitly defaults to `external_window`; changing the accepted physical default requires a future separately authorized DDL migration and is not hidden in this source-retirement task.
- Adds retained `pnpm api:verify:runtime`, which verifies accepted migration state, active Compose ownership, running Backend/Gateway image/config records, health/routes/schema, and protected stable data without checking current source or any app bundle. It is the only verifier allowed during the intentional Task 7 source-drift interval; strict `pnpm api:verify` remains unchanged and must fail until Task 8 supplies the final current-source app and service records.
- Accepted-state lifecycle aliases are deliberately asymmetric. Retain `api:runtime:doctor`, `api:active-project`, `api:db:start`, `api:start|stop|status|verify|verify:runtime`, `api:verify:empty`, migration GC, and Web-retirement commands; remove `api:prepare` with the pre-accept control surface. In accepted state, `api:db:start` may only start the existing owner-bound MySQL container and `api:start` may only use the accepted immutable Backend image/Gateway snapshot with `--no-build`; neither may recreate MySQL, initialize/alter data, refresh active configuration, or consume current source. `api:verify:empty` remains disposable-test-only and hard-rejects canonical ports/project/network/volume. Only Task 8 may build or activate current Backend/Gateway source.
- Adds read-only `source:retirement:audit`, one-use `source:retirement:prepare`, and post-gate `source:retirement:record`. The audit binds the accepted attempt, Task 5/6 receipt hashes, exact proposed path set, pre-retirement content manifest, current commit plus scoped dirty-diff hash, runtime/stable-data fingerprints, and categorized full-repository reference scan. Only after the operator reviews that report and explicitly authorizes its exact hash/set may `prepare` create an exclusive, owner-only, no-follow token beneath `.runtime/api-only/evidence/source-retirement/<run-id>/`; it prints only the token path and evidence hash. After the authorized edits and complete gate, `record` consumes that exact token through an environment-provided absolute path, permits only the reviewed before→after modifications/deletions, rejects every extra drift, and writes an atomic, non-secret `source-retirement-receipt.json` containing before/after manifests, exact changed/deleted path hashes, zero-executable-reference scan digest, verification-command/result hashes, and unchanged runtime/data identities. None of the three commands deletes source. Task 8 must consume and bind this exact receipt/hash; no generic or hand-written JSON satisfies the gate.

- [ ] **Step 1: Capture a full-repository source, manifest, and runtime-reference baseline**

Run the scan over manifests, locks, executable source, deployment files, tests, and current docs—not only `frontend/src`:

```bash
rg -n --glob '!**/node_modules/**' --glob '!frontend/dist*/**' \
  "live-sessions|(?i:novnc)|Xvfb|x11vnc|websockify|douyin-live|douyin-rfb|remote.canvas|cloudflared|vite preview|real-trial|dev:real|deploy:shensi|trial:|setup:mysql:local|local-real-runtime|\.env\.real\.local" \
  package.json pnpm-lock.yaml pnpm-workspace.yaml .env.example scripts tools deploy \
  backend contracts frontend desktop services/media-crawler .github/workflows README.md docs
```

Record every match by category: executable dependency, runnable entrypoint, retained desktop/API code, denial test, historical document, generated artifact, or protected data reference. Classify `shensi_sales` references individually: remove only the retired `dev:real` provisioning path, while preserving generic source-database fixtures and migration evidence. Preserve `.env.real.local` and any existing database/secret bytes as protected user data; removing an alias never authorizes deleting them. Also capture the accepted source manifests/build records, active Compose project/image/network identities, open processes/files, Task 6 receipt, and `git status --short`. An uncategorized match or a runtime reference from current desktop/API code blocks deletion.

- [ ] **Step 2: Build and test the non-destructive source-retirement controller**

Before changing or deleting any reviewed production path, implement the read-only `source:retirement:audit`, one-use `source:retirement:prepare`, and post-edit `source:retirement:record` controller plus package aliases. Write red tests proving the controller rejects every state other than `accepted`; a missing/mismatched Task 5 or Task 6 receipt; drift from the Step 1 baseline outside the finite Step 2–3 bootstrap allowlist; an active Trial/Web process; an open file in the deletion set; an unknown/symlink path; or a requested before→after change not exactly bound to the reviewed set hash. The bootstrap allowlist contains only the new retirement controller/tests, the three additive `source:retirement:*` root package aliases, and neutral helper/caller migrations named in Steps 2–3; it is hash-recorded as a separate pre-audit delta and may not include any alias removal, adapter/launcher deletion, remote-display edit, deployment edit, or other retirement target. Migration acceptance is not source-deletion consent. The guarded transaction must never touch `.runtime/real-trial/state/mysql`, `.runtime/real-trial/secrets`, the accepted target volume, encrypted backups, migration/retirement evidence, Electron Application Support/Profiles, or any current API/desktop source outside the reviewed set.

Test `source-entrypoint-retirement` with injected Git/filesystem/runtime probes. It must reject an incomplete or extra change/deletion set, a changed audit/set hash at prepare time, any post-audit change outside the authorized before→after set, an uncategorized match, missing command evidence, changed accepted runtime/data identities, symlinks, loose evidence permissions, token replay, a hand-authored receipt, or a Task 6 runtime-retirement receipt being substituted for source authorization. The exact reviewed modifications/deletions are allowed; unrelated dirty files must remain byte-identical and outside the scoped diff. `record` succeeds only after the authorized set and all required gates match. It never deletes source and never performs process-control, container mutation, database mutation, or platform mutation; it may spawn only the fixed verification argv listed in Step 10 and capture their bounded redacted results. Run `node --test scripts/source-entrypoint-retirement.test.mjs` here; do not run `prepare`, edit a reviewed production path, or delete anything in this step.

- [ ] **Step 3: Extract neutral helpers and migrate callers without retiring entrypoints**

Move the reusable PID-record parsing, owner nonce/process-start validation, exact `ps` command matching, TERM → bounded wait → KILL policy, and owner-only record cleanup into `scripts/lib/process-ownership.mjs`. Move still-needed generic environment parsing, exact port probing/process-tree termination, and action-visual-locator validation out of `scripts/dev.mjs` into a separately tested neutral helper rather than deleting their only implementation. Keep Trial-specific process names, Colima/container cleanup, ports, and restart composition out of neutral modules. Update `scripts/api-only-runtime.mjs` and its tests first; while Trial migration code still exists, update it to consume the same helper and prove behavior equivalence. Because this task runs only from terminal `accepted`, separate immutable accepted-state/evidence readers from mutable pre-accept control flow and migrate every steady-state/GC caller to the neutral modules. Produce and test a zero-retained-import candidate for `trial-cutover-adapter.mjs`, `real-trial-*`, and `scripts/dev.mjs`, but do not remove package aliases, CLI branches, adapters, launchers, remote-display code, or any other reviewed retirement path before Step 4 authorization.

Preserve generic backup/restore/data-verification tools, accepted migration evidence, read-only status/verification, all three separately gated `api:migration:gc:audit|prepare|purge` commands and their state/evidence readers, plus `web:retirement:audit|dry-run|execute|purge:prepare|purge` until every staged recovery or seven-day purge lifecycle has completed. Terminal acceptance retires `api:accept:resume` with the rest of the pre-accept control surface; it does not retire generic backup/restore tools or evidence readers.

- [ ] **Step 4: Generate the exact audit and obtain source-retirement authorization**

Run the implemented read-only audit against the exact proposed before→after path set:

```bash
pnpm source:retirement:audit -- --reviewed-set /exact/source-retirement-set.json
```

The audit must first verify the Step 1 baseline plus exact bootstrap-delta manifest, then establish the post-bootstrap tree as the pre-retirement manifest. Stop and present the complete categorized audit, exact path set, bootstrap-delta hash, accepted-attempt and Task 5/6 receipt identities, runtime/data fingerprints, scoped dirty-diff hash, and audit SHA-256. Only after the operator explicitly authorizes that exact set/hash may the one-use token be minted:

```bash
pnpm source:retirement:prepare -- --audit /exact/source-retirement-audit.json --sha256 <exact-hash>
```

Steps 5–9 may change or delete only the exact token-bound before→after set. Any source drift, extra path, changed runtime/data identity, new executable reference, or token mismatch invalidates authorization and requires a fresh audit and explicit review; it must not be auto-expanded.

- [ ] **Step 5: Rewire package scripts to desktop/API-only current truth**

Remove root aliases `dev:shensi`, `dev:mysql`, `deploy:shensi`, `dev:real`, `setup:mysql:local`, every `trial:*`, `test:trial-*`, `test:baota-package`, and `verify:shensi`, plus backend alias `setup:mysql:local`. From terminal `accepted`, also remove `api:prepare` and the now-invalid pre-accept aliases `api:migration:preflight`, `api:migration:run`, `api:cutover`, `api:rollback`, `api:accept:prepare`, `api:accept`, and `api:accept:resume`; keep `api:runtime:doctor`, `api:active-project`, accepted-safe `api:db:start`, `api:start|stop|status|verify|verify:runtime`, disposable-only `api:verify:empty`, commands that read immutable evidence, generic backup/restore, separately authorized migration GC, and the complete still-live `web:retirement:*` recovery/purge lifecycle. Add tests that source drift followed by `api:start` still resolves the accepted immutable image/config, emits `--no-build`, never writes an active snapshot/build record, and never creates/recreates MySQL; `api:db:start` must fail if its exact container/volume is absent rather than provisioning it.

In the same token-bound change, remove the matching CLI dispatch/handler branches so no alias points at a missing handler. Re-run the Step 3 zero-import proof, then delete `scripts/trial-cutover-adapter.mjs` and its test; only after all remaining callers use the neutral helpers may the reviewed Trial/dev launcher files be deleted. Every edit and deletion must match the exact Step 4 before→after set.

Make root `dev` invoke only `desktop:dev`; API startup remains the separate operator command `pnpm api:start`, avoiding a hidden second lifecycle owner. Remove the generic frontend Web `dev` entry and preserve `dev:desktop`/`build:desktop`. Change frontend's ordinary `build` to delegate to `build:desktop`, make root `build` invoke the desktop Renderer build explicitly, and update `verify:visual-reader-build-order` to run `build:visual-reader`, `build:desktop`, then the visual-reader bundle check. No normal build/test/CI alias may create or consume `frontend/dist`; `frontend/dist-desktop` remains the Electron Renderer output. Rewire the remaining test/contract gates to desktop Renderer/API-only checks and remove all imports of deleted Web/Trial modules. Regenerate both lockfiles after removing `@novnc/novnc`; do not hand-edit dependency graph entries.

- [ ] **Step 6: Remove Renderer remote-canvas code while preserving the latest UI**

Remove the dynamic live-login import, `#douyin-live-login` compatibility route, embedded screenshot/canvas markup and interactions, public login-session create/poll/cancel/live calls, noVNC dependency/types, and remote-canvas-only CSS. Keep the existing black/green Acquisition hierarchy and route content. `window.shensiDesktop.startDouyinLogin()` remains the only login action and must return `interactionSurface:"external_window"`; Electron Main continues to poll the local Sidecar and then syncs the authenticated account through `/desktop-login-completions`. First move the fail-closed assertions from `remote-canvas-disabled.ts` into the feature manifest, route tests, and final bundle scanner; then delete that adapter only when it has zero runtime/test import.

Update the default Playwright fixture/spec at the same time: remove its fake public `POST/GET /social-accounts/douyin/login-sessions` handlers and QR-dialog assertions, then either inject the bounded Electron-owned `window.shensiDesktop` external-window bridge or preseed a completed desktop-login account through the existing fixture-only repository seam. Assert that clicking connect reaches `interactionSurface:"external_window"`, no public login-session request is made, and every non-login Acquisition workflow/visual assertion remains unchanged. The default E2E server remains test-only and cannot become a product Web launcher.

- [ ] **Step 7: Remove the Backend public Web-login operations while preserving desktop sync**

Remove the complete public Backend Web-login surface: create/get/delete `/social-accounts/douyin/login-sessions`, `/interactions`, `/live`, the `socketPath` response schema, and the corresponding MediaCrawler gateway methods and OpenAPI/generated client operations. Remove or isolate the live login-session entities/repository writers and every executable default that creates `remote_canvas`; require every retained writer to persist `external_window` explicitly. Update both canonical bootstrap SQL source snapshots so future databases default to `external_window`, and record their separate `bootstrapSchemaHash`. This source-retirement task runs no DDL against the accepted target, does not drop the physical compatibility column, does not change the accepted live default, and does not rewrite historical values; its receipt separately records the unchanged `acceptedLiveSchemaHash`. Preserve social-account list/disconnect, `/desktop-login-completions`, local desktop crawler sync, collection, evidence, approval, action, and receipt behavior. The desktop app talks directly to its local Sidecar for login and only posts the authenticated completion to the center. Preserve legacy stored `interaction_surface` values/table rows for audit and migration compatibility without exposing an executable canvas path; new sessions are external-window only. Test the candidate against both a disposable database created from the new bootstrap snapshots and a fixture matching the accepted live schema, proving no retained insert can fall through to the legacy default.

- [ ] **Step 8: Remove only Sidecar virtual-display/live-token branches**

Remove Xvfb/x11vnc display creation, VNC-port exposure, screenshot/input forwarding, live-token issuance/claim, `/interactions`, `/live-sessions`, live WebSocket proxy, `supports_live_sessions`, and `SHENSI_RUNTIME_MODE=web`. In `browser_state.py`, remove only `_LiveDisplay`, `_start_live_display`, `_ManagedLoginContext`, remote prepare/poll/interact/QR/screenshot paths, `live_vnc_port`, and the remote constructor branch. Preserve `MediaCrawlerDouyinBrowserState` as the `LocalBrowserSessionManager` factory, its external-window `_open_context`/login poll, identity extraction, action/reconcile behavior, IPC worker/process isolation, Chromium sandbox/profile/proxy handling, and persistent context ownership. The desktop entrypoint must fail closed for any mode other than `desktop`.

Preserve the Sidecar internal login-session create/status/cancel endpoints consumed by `desktop/src/main/sidecar-client.ts`, `accounts.py` session fencing/identity, `local_browser_session_manager.py`, crawl jobs, action jobs, comment/private-message controls, login diagnostics, FastAPI local boundary, and persistent Profile ownership. Update `test_browser_state.py` and `test_desktop_runtime_integration.py` away from removed live-display fields, extend `test_local_browser_session_manager.py` as the replacement external-window/session-ownership proof, and retain `test_desktop_entrypoint.py` as the no-Xvfb/noVNC denial gate. Keep the status fields that Electron still validates even if QR/screenshot values become consistently unavailable. Remove the server Sidecar Dockerfiles only after no retained build references them; desktop PyInstaller/Playwright packaging remains unchanged.

Add an explicit retained-boundary regression: Sidecar internal POST/GET login-session flows always report `interactionSurface:"external_window"`; Electron Main can cancel through internal DELETE; `/interactions` and `/live-sessions` return 404; and the Acquisition DOM/route manifest outside the removed remote-login canvas remains unchanged.

- [ ] **Step 9: Remove legacy Web/Trial deployment and launch entrypoints**

After Steps 5–8 and an exact token/set revalidation, delete the legacy Web Compose/nginx/frontend image/Baota packaging and Trial/dev/deploy launchers listed above with `apply_patch`. After both `setup:mysql:local` aliases and every import are gone, also delete `backend/scripts/setup-local-mysql.ts`, `backend/scripts/local-real-runtime.ts`, and its test; these are the retired `.env.real.local`/`127.0.0.1:3307` `dev:real` provisioner, not the accepted API-only database lifecycle. Do not delete `.env.real.local`, an existing `shensi_sales` database, credentials, or generic migration fixtures/evidence.

The desktop frozen entrypoint imports `shensi_adapter`, and its PyInstaller spec packages crawler dependencies directly rather than the upstream `api`/`webui` control plane. Prove that import/data boundary first. Move the `cmd_arg.parse_cmd` assertions for `CRAWLER_MAX_NOTES_COUNT` and `MAX_COMMENTS_COUNT_SINGLENOTES` out of `tests/test_api_limits.py` into `tests/test_cmd_arg_limits.py` and run that retained test; only the remaining tests are API-control-plane coverage. Then delete tracked `services/media-crawler/api/`, tracked `services/media-crawler/webui/`, and the old mixed test; remove their launch/build instructions from all three upstream READMEs and record the intentional Shensi divergence in `SHENSI_UPSTREAM.md` so a future upstream sync cannot silently reintroduce them. Do not remove FastAPI/Uvicorn because the local desktop Sidecar still needs them, and do not remove crawler/export dependencies merely because the upstream Web UI is gone. Ignored `__pycache__` or other generated bytes are not source-patch targets; any later cleanup must use an exact no-follow retirement manifest.

Update CI to run contracts, Backend, desktop Renderer/Main, Sidecar tests, and API-only static gates without trying to package a macOS Sidecar on Linux. Do not remove or rewrite API-only Compose/nginx/backend image inputs. Task 6 has already moved runtime-generated PIDs/logs/tunnel metadata/frontend releases; this step removes repository source entrypoints only and never recursively deletes a runtime or workspace directory.

- [ ] **Step 10: Prove the authorized retirement and record its receipt**

Add a repository contract that scans package aliases, manifests/locks, `scripts/`, `tools/`, `deploy/`, `.github/workflows/`, Backend, Renderer, Desktop, and Sidecar. Forbidden strings are allowed only in explicit denial tests, migration/retirement history, and protected evidence schemas; no remaining production/public command may start a standalone Web frontend, Tunnel, Trial supervisor, server Sidecar, Xvfb/VNC/websockify/noVNC, `/live-sessions`, `/douyin-live`, the Trial cutover adapter, a pre-accept migration/cutover command, the `setup:mysql:local`/`local-real-runtime` provisioner, or the legacy Compose file. The Electron-owned loopback-only Renderer dev server and bounded Playwright/Electron fixtures remain allowed only behind test/dev aliases that cannot bind a public address or be selected by production configuration. Port or remove the current real-browser Web Playwright config and inspect `test:task10:browser`; retain it only if this bounded-fixture contract is proven, otherwise replace it with an Electron-owned test. Assert root/frontend normal builds and the visual-reader build-order gate create no `frontend/dist` Web output.

`source:retirement:record` is the owner of the verification evidence: while holding the owner lock and the exact live token, it revalidates the audit/set and invokes the following fixed argv itself, capturing exit status plus redacted stdout/stderr digests. Shell history, timestamps, operator claims, and hand-written result JSON are not accepted as command evidence:

```bash
pnpm test:contracts
pnpm test:layout
pnpm test:mediacrawler-provenance
pnpm --filter ./backend test
pnpm --filter ./frontend test
pnpm --filter ./frontend test:types
pnpm --dir desktop test
pnpm --dir desktop typecheck
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/test_cmd_arg_limits.py \
  services/media-crawler/tests/shensi_adapter
pnpm desktop:build:renderer
node --test scripts/api-only-runtime.test.mjs scripts/lib/process-ownership.test.mjs \
  scripts/lib/runtime-environment.test.mjs scripts/source-entrypoint-retirement.test.mjs \
  tools/data-migration-scripts.test.mjs \
  scripts/web-runtime-retirement.test.mjs
node -e 'const p=require("./package.json"); for (const n of ["api:runtime:doctor","api:active-project","api:db:start","api:start","api:stop","api:status","api:verify","api:verify:runtime","api:verify:empty","api:migration:gc:audit","api:migration:gc:prepare","api:migration:gc:purge","web:retirement:audit","web:retirement:dry-run","web:retirement:execute","web:retirement:purge:prepare","web:retirement:purge","source:retirement:audit","source:retirement:prepare","source:retirement:record"]) if (!p.scripts[n]) process.exit(1); for (const n of ["api:prepare","api:migration:preflight","api:migration:run","api:cutover","api:rollback","api:accept:prepare","api:accept","api:accept:resume","setup:mysql:local","dev:real","deploy:shensi"]) if (p.scripts[n]) process.exit(1); const b=require("./backend/package.json"); if (b.scripts?.["setup:mysql:local"]) process.exit(1)'
pnpm api:status
pnpm api:migration:gc:audit
pnpm web:retirement:audit
git diff --check
```

Run the evidence-owning coordinator once, then run the receipt-dependent verifier:

```bash
SHENSI_SOURCE_RETIREMENT_TOKEN_FILE=/exact/owner-only/token \
  pnpm source:retirement:record -- \
  --audit /exact/source-retirement-audit.json \
  --reviewed-set-sha256 <exact-hash>
pnpm api:verify:runtime -- \
  --expected-source-drift-receipt /exact/.runtime/api-only/evidence/source-retirement/<run-id>/source-retirement-receipt.json \
  --sha256 <exact-receipt-hash>
```

Expected: all pass; the accepted recorded runtime remains healthy; source scan has no executable legacy path; active target volume, schema hash, protected stable-data fingerprint, Profiles, secrets, backups, and evidence are unchanged. The source-retirement receipt binds the controller-executed `test:layout`/workflow, MediaCrawler provenance, package/entrypoint, and remaining pre-record verification result hashes rather than merely listing unexecuted test files. The post-record verifier binds that exact receipt hash and does not weaken strict `api:verify`. Do not claim the installed app or running Backend/Gateway is current-source yet—Task 8 performs the joint post-cleanup rebuild.

---

### Task 8: Rebuild current source and safely promote the final local application

**Files:**
- Create: `scripts/desktop-milestone.mjs`
- Create: `scripts/desktop-milestone.test.mjs`
- Create: `scripts/desktop-app-promotion.mjs`
- Create: `scripts/desktop-app-promotion.test.mjs`
- Create: `desktop/native/macos-app-swap.c`
- Modify: `scripts/api-only-runtime.mjs`
- Modify: `scripts/api-only-runtime.test.mjs`
- Modify companion action-bridge file: `backend/src/desktop-client-admission.ts`
- Modify companion action-bridge test: `backend/src/desktop-client-admission-test.ts`
- Modify: `deploy/compose.api-only.yaml`
- Modify: `deploy/nginx/api-only.conf`
- Create: `deploy/nginx/api-only-maintenance.conf`
- Modify: `desktop/scripts/package-macos-dir.sh`
- Modify: `desktop/package.json`
- Modify: `desktop/tests/build-contract.test.ts`
- Modify: root `package.json`
- Modify: `docs/operations/api-only-runtime.md`
- Modify: `README.md`
- Modify: `frontend/README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/modules/acquisition.md`
- Modify: `docs/desktop/macos-electron-client.md`
- Create: `docs/desktop/acceptance/local-milestone-promotion.md`

**Interfaces:**
- Produces joint non-installing `pnpm desktop:milestone:build`, bounded `pnpm desktop:milestone:activate` with read-only `--dry-run`, one-use `pnpm desktop:milestone:activate:prepare`, evidence-binding `pnpm desktop:milestone:verify`, pre-boundary `pnpm desktop:milestone:abort`, read-only `pnpm desktop:promote:audit`, one-use-confirmation `pnpm desktop:promote:prepare`, mutating `pnpm desktop:promote`, post-smoke/forward-only `pnpm desktop:promote:finalize`, and pre-normal-activation failure-only `pnpm desktop:promote:rollback`. Backend/App build primitives are implementation-only functions or inherited-capability child modes, not public package aliases.
- `desktop:milestone:build` is the sole public coordinator that can create a promotable joint candidate. It requires explicit absolute `--source-retirement-receipt <path>` and `--source-retirement-sha256 <64-lowercase-hex>` arguments; it never selects a newest/first evidence file. It exclusively creates the owner-only joint root and fixed absent `backend/`, `gateway/`, `app/`, and `evidence/` children, creates one immutable Backend candidate, one immutable Gateway configuration snapshot, and exactly one run-scoped `Shensi.app` from stable before/after source manifests, then writes one joint manifest without changing the running services or `/Applications/Shensi.app`. Direct low-level build/activation is rejected, and a standalone Task 5 `fixtureOnly:true` package can never satisfy promotion.
- The owner-only milestone journal has exact durable states `candidate_built`, `services_activation_pending`, `services_activated_pending_candidate_smoke`, `candidate_verified_pending_promotion`, `staging`, `prepared_to_swap`, `app_swapped_pending_smoke`, `rollback_slot_finalizing`, `normal_activation_pending`, `recovery_required`, and terminal `abandoned`, `finalized`, or `failed_recovered`. Every transition is atomic and fsynced; an interrupted command must reconcile bound hashes before moving forward and may never create a second concurrent milestone. `services_activation_pending` is written before the first Gateway/Backend mutation and authorizes only idempotent completion or restoration of the exact bound service set. `abandoned` is legal only when no candidate service/App mutation occurred and the prior active set is verified. `recovery_required` is a fail-closed terminal quarantine for this plan: it permits only read-only status/evidence export and blocks build, activate, verify, abort, promote, rollback, finalize, normal activation, and cleanup. Unknown hashes receive no automated transition; a new operator-reviewed recovery plan and authorization are required. `normal_activation_pending` is forward-only because a write-capable candidate or worker may already have changed data.
- Promotion is a separately authorized, receipt-driven filesystem transaction. Before `normal_activation_pending`, failure recovery installs the bound verified rollback seed with the prior Backend image, locked admission, and Gateway snapshot as one compatible version set while maintenance remains closed; it never blindly restores an unverified displaced App. From `normal_activation_pending`, old-version rollback is forbidden and the same idempotent finalize command may only recover forward on the bound candidate. No path edits the target database, Profile, Keychain credential, API secret, or Trial archive directly.
- Before service activation, the joint build must select exactly one `verifiedRollbackSeed`. A currently installed App qualifies only when its strict embedded build identity and an immutable command-owned compatibility receipt bind it to the exact prior active-version ID, Backend image digest, Gateway/config hash, accepted-live schema hash, API-contract hash, and desktop-admission mode. Otherwise the only fallback is the still-retained Task 5 App whose stable receipt plus API-acceptance receipt prove that same tuple; its `fixtureOnly:true` status permits recovery use only and never promotion. If neither candidate passes, build/activation is blocked before maintenance or service mutation. An unverified current installed App is recorded as `nonRollbackDisplacedApp`, preserved until the forward-only boundary, then removed from `/Applications` only under the later exact promotion authorization after its metadata/evidence is durably quarantined; it is never labeled or installed as rollback.
- `api:verify[:runtime] --expected-role milestone-read-only` is not a general bypass. It resolves the one active owner journal plus exact joint-manifest and activation-receipt hashes and is accepted only in `services_activated_pending_candidate_smoke`, `candidate_verified_pending_promotion`, `staging`, `prepared_to_swap`, `app_swapped_pending_smoke`, or `rollback_slot_finalizing`, with the maintenance Gateway hash active, the candidate read-only principal active, zero write-capable workers/schedulers, and denied mutation probes. It rejects `candidate_built`, `services_activation_pending`, `normal_activation_pending`, `abandoned`, `finalized`, `failed_recovered`, `recovery_required`, a second journal, or a CLI-supplied unbound manifest.
- The mutating service activation has its own authorization boundary. `desktop:milestone:activate:prepare` creates an exclusive owner-only, no-follow one-use token only after the dry-run report is explicitly approved; it binds the exact joint manifest, prior/candidate/maintenance service identities, locked prior/candidate admission records, selected verified rollback seed, displaced-App disposition, MySQL identity, recovery set, and source-retirement receipt. `desktop:milestone:activate` accepts that token only through `SHENSI_DESKTOP_MILESTONE_ACTIVATION_TOKEN_FILE`, writes/fsyncs the activation-intent receipt and `services_activation_pending` journal, then durably consumes the token before the first Gateway or Backend change. A general “continue”, build authorization, retirement token, or later App-promotion token cannot substitute for it.
- Candidate normal role is exact, not inferred from a generic health response: `DOUYIN_OUTREACH_APPROVALS_ENABLED=true`, `DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED=false`, and `DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED=true`; `MEDIACRAWLER_BASE_URL` and `MEDIACRAWLER_SERVICE_SECRET_FILE` are absent; the desktop claim/complete routes and guarded transformer version match the action-bridge receipt; Backend and Gateway both use `desktopClientAdmission:{ mode:"exact", admittedBuildManifestSha256:<candidate> }`; and the worker/scheduler inventory equals the joint manifest. `--expected-role normal` verifies this combination through configuration/route/inventory probes that do not claim or execute a real action. Until the candidate normal Gateway is opened as finalize's last traffic-opening commit, the accepted prior runtime remains `desktopClientAdmission:{ mode:"migration_locked", admittedBuildManifestSha256:null }`, so a stale `/Applications/Shensi.app`, the Task 5 seed, or a different candidate cannot perform a business mutation or claim an action. Abort/`failed_recovered` must restore that exact locked prior record; final cold restart must restore only the exact candidate digest from the active immutable version record.
- Extend the current-document contract in `scripts/api-only-runtime.test.mjs` as a state-aware two-stage rule: accepted/pre-milestone fixtures require `migration_locked`, unavailable installed App, and pending Web/noVNC source retirement; finalized fixtures require the active record's exact admitted build-manifest digest, available `/Applications/Shensi.app`, and completed Web/noVNC retirement while still marking Alibaba Cloud/two-Mac evidence not run. The live `api:verify --expected-role normal` applies the finalized branch only after the journal is durably `finalized`; pure tests use injected records and never depend on a developer machine's `.runtime` state.
- While any milestone journal is non-terminal, public `api:start`, `api:stop`, and `api:db:start` fail closed with `API_ONLY_MILESTONE_IN_PROGRESS`; read-only `status`/role-bound verification remain available. Milestone activate/verify/abort/finalize/rollback use a non-exported lifecycle adapter that requires the exact run ID, journal hash, joint-manifest hash, and in-process owner-lock capability. No package alias, environment variable, or arbitrary CLI flag can mint that capability. Only after journal state is `abandoned`, `finalized`, or `failed_recovered` do normal public lifecycle aliases resume against the corresponding verified active-version pointer.
- `desktop:milestone:abort` is the explicit refusal/cancel exit before App swap. From `candidate_built`, it proves no live service/App mutation and records terminal `abandoned` without deleting the candidate/evidence. From `services_activation_pending`, `services_activated_pending_candidate_smoke`, `candidate_verified_pending_promotion`, `staging`, or `prepared_to_swap`, it reasserts maintenance, reconciles the exact live/consumed token plus candidate-stage/rollback-seed-stage/next hashes, proves `/Applications/Shensi.app` is still the prior tree, removes only exact owner-bound pre-swap residues after no-process checks, restores and verifies the exact prior Backend/Gateway/locked-admission active pointer, and then records `failed_recovered`; it never falls back to Trial or deletes MySQL/data/evidence. Unknown or post-swap hashes enter `recovery_required`. Abort is rejected from `app_swapped_pending_smoke` and `rollback_slot_finalizing`, where `desktop:promote:rollback` applies, and from `normal_activation_pending` onward, where recovery is candidate-forward only.

- [ ] **Step 1: Write red joint-milestone, recovery, and native-swap tests**

Require a fresh `backend-runtime` content manifest, fresh `desktop-app` content manifest, candidate image ID/digest, prior image ID/digest, candidate/prior immutable Gateway snapshot hashes, resolved Compose config hash, unchanged accepted-live schema hash, current bootstrap-schema hash, a compatibility-report hash covering both schema shapes, accepted migration attempt, exact Task 7 source-retirement receipt/path/hash, exact locked prior desktop-admission record, and the exact current installed-app/rollback/Task 5 seed inventory. Compare source manifest hash only to `sourceManifestHash`, running immutable image ID/digest only to `imageIdDigest`, resolved Compose config only to `composeConfigHash`, the physical target only to `acceptedLiveSchemaHash`, and the source bootstrap snapshots only to `bootstrapSchemaHash`; never compare unlike identifiers or require those two schema hashes to equal. Require selection of one `verifiedRollbackSeed` before `candidate_built`: accept the installed App only with its embedded manifest and a command-owned receipt bound to the entire prior version tuple; otherwise accept only the exact retained Task 5 App whose sealed evidence and API-acceptance receipt jointly bind that tuple. Reject both missing/invalid, an unverified installed App selected as rollback, a Task 5 App selected as promotable/current, source drift during either build, a missing/hand-authored/mismatched Task 7 receipt, a receipt whose after-manifest differs from current source, reused candidate tags/run IDs, mutable image references, missing prior service snapshots, accepted-live schema drift, bootstrap-schema drift, missing/failed dual-schema compatibility evidence, any Compose plan that recreates/removes MySQL or its volume, DDL-on-start, Trial references, or an unbound candidate App. Add O_EXCL/no-follow tests for an existing joint root, pre-existing/wrong-type `backend|gateway|app|evidence` child, child replacement race, standalone `fixtureOnly:true` package substitution, and direct invocation of either low-level builder without the lock-held inherited capability.

Drive every milestone state and injected crash edge. Prove a failure before service activation leaves the old version set untouched; a service/candidate-App failure restores the prior Backend image, locked admission, and Gateway snapshot before traffic resumes; and an `app_swapped_pending_smoke` failure keeps maintenance closed, restores/verifies prior Backend behind it, atomically installs the selected verified seed, restores the prior locked Gateway last, and records `failed_recovered`. When the seed differs from the unverified displaced App, require the explicit substitution/quarantine receipt. Inject crashes immediately before and after writing the activation receipt, after its fsync but before the journal transition, and after entry to `services_activated_pending_candidate_smoke` but before role verification. Recovery must reconcile the exact receipt/journal hashes, never invoke the role verifier from `candidate_built`, and restore the compatible prior-service/verified-seed set with `failed_recovered` if the first permitted role verification fails. Prove rollback is rejected at and after `normal_activation_pending`; failures there reassert maintenance and resume only the bound candidate forward. Recovery must use the existing journal rather than minting a run or confirmation token. Unknown path/service hashes enter terminal `recovery_required`, where every mutating command is rejected.

Test the role verifier state matrix explicitly. The read-only role flag passes only for the bound maintenance/read-only candidate in its six allowed journal states and rejects `candidate_built`, `services_activation_pending`, normal activation/finalization, a source-only manifest, a forged activation receipt, enabled workers, a writable principal, or a successful mutation probe. With an active milestone journal, normal role passes only for the bound candidate in `normal_activation_pending` and `finalized`, while `abandoned` and `failed_recovered` resolve and verify only the exact prior active-version pointer; it rejects every earlier state and all `recovery_required` states. The finalization gate must pass candidate normal role while still in `normal_activation_pending`, and the post-finalized/cold-restart check must pass against the same candidate active pointer. Reject every permutation that changes one of the three action flags, exposes a remote MediaCrawler URL/secret, omits desktop claim/complete routes or the guarded transformer, enables the server action worker, changes the candidate admission build hash, or changes the exact expected worker/scheduler inventory; the verifier itself must not claim a real queued action. Test that prior/abort/recovered roles remain `migration_locked` across restart, that every App digest is denied there, and that final normal mode admits only the candidate embedded digest at both Gateway and Backend while still enforcing normal session/device/task authorization.

Test activation authorization and intent durability: reject a missing, loose, symlinked, out-of-root, replayed, or wrong-manifest token; reject argv/environment attempts to invent an owner capability; and inject crashes before/after activation-intent receipt fsync, before/after `services_activation_pending`, before/after token consumption, and around every Gateway/Backend mutation. No service mutation may occur before the pending journal and consumed marker are durable. Retry may only finish the exact activation or restore the exact prior service set; unknown runtime hashes enter `recovery_required`.

Test `desktop:milestone:verify` as the sole transition from `services_activated_pending_candidate_smoke` to `candidate_verified_pending_promotion`: it requires the exact manifest/hash and run-scoped App path, executes and hashes every Step 4 gate, repeats the explicit package/cold-start/API checks after App close, atomically stores a candidate-verification receipt, and only then advances state. A failed/partial gate invokes the same exact prior-service recovery and records `failed_recovered`; replay returns the bound result. Test `desktop:milestone:abort` from each allowed pre-swap state, including refusal after build, after candidate verification, before/after candidate-stage and rollback-seed-stage creation, before/after `.next` creation, and before/after token consumption. It must prove the installed prior App hash never changed, reconcile and clean only exact pre-swap residue, restore prior services plus locked admission, and reject `app_swapped_pending_smoke|rollback_slot_finalizing|normal_activation_pending|finalized|recovery_required`.

Test that public `api:start|stop|db:start` reject every non-terminal milestone state, including `normal_activation_pending`, and cannot accept a run ID/capability from argv or environment. Inject crashes before/after staged-version creation, `normal_activation_pending`, active-pointer replacement, internal stop/start, normal Gateway activation, and final journal commit. Before the forward-only boundary the active pointer must remain prior; afterward journal reconciliation must install/verify only the candidate pointer and recover forward.

Drive both rollback-seed modes through every filesystem edge. For an evidence-bound installed seed, prove it alone becomes rollback. For a Task 5 seed, prove the unverified installed App is marked `nonRollbackDisplacedApp`, never becomes current/rollback, and is removed only after its exact metadata/evidence quarantine is fsynced and the forward-only candidate succeeds. Bind seed source/path/tree/build-manifest/compatibility-receipt hashes, existing rollback hash, displaced-App hash and disposition into the joint manifest, promotion token, and journal. Inject crashes before/after seed copy, seed verification, rollback-slot exchange, quarantine copy, each fsync, and each exact removal. Unknown combinations enter `recovery_required`; no retry guesses a seed, restores an unverified App, or deletes an unbound path.

On Darwin, compile `desktop/native/macos-app-swap.c` once in the owner-only run root by executing `/usr/bin/xcrun` with `clang` argv. Record source hash, compiler identity, and binary hash; use that exact binary for both a same-filesystem temporary-directory exchange/restore integration test and production. Bind the binary hash to the promotion token. Test unavailable compiler/API, different filesystems, non-exclusive staging, symlinked parent/path, app/helper executable still open, token replay, and injected pre/post-swap crashes. The integration test proves host support and correct exchange/restore behavior; atomicity comes from the checked `renameatx_np(..., RENAME_SWAP)` syscall, not from a mock or timing claim.

- [ ] **Step 2: Build one joint Backend/Gateway/App candidate without activating it**

Run:

```bash
SHENSI_REMOTE_ORIGIN=http://127.0.0.1:5608 pnpm desktop:milestone:build -- \
  --source-retirement-receipt /absolute/source-retirement-receipt.json \
  --source-retirement-sha256 <64-lowercase-hex>
```

The coordinator first requires the exact Task 7 source-retirement receipt path/hash, verifies its accepted attempt, authorization-set hash, zero-reference digest, command evidence, unchanged runtime/data identities including `acceptedLiveSchemaHash`, and `afterSourceManifestHash` against current source, and binds that receipt into the run. It exclusively creates exact owner-only `.runtime/desktop-acceptance/<12hex>` plus a root owner manifest, acquires its lock, and creates the fixed empty child layout. It captures pre-build source manifests, calls an implementation-only Backend builder to create only `backend/`, seals the candidate and maintenance Gateway snapshots under `gateway/`, and invokes the existing package implementation in inherited-capability coordinator mode to create only `app/Shensi.app`; every child uses exclusive/no-follow creation and refuses collisions or unrelated existing content. Public `api:rebuild:current` is not retained, public `desktop:package:dir` always creates a separate `fixtureOnly:true` root, and neither can write a milestone child or produce a promotable manifest. The coordinator executes `node desktop/scripts/verify-package.mjs /exact/run-scoped/app/Shensi.app development`. In disposable test databases only, it proves the candidate supports both the accepted live schema shape and a fresh database created from the current bootstrap snapshots, with every new login-session writer explicitly producing `external_window`; it runs no DDL against the accepted target. It recomputes both source manifests and fails if either changed. Before sealing, it selects and revalidates the exact `verifiedRollbackSeed` from either the evidence-bound installed App or the retained Task 5 candidate plus API-acceptance binding; if neither matches the prior service/admission/schema/contract tuple, it fails before `candidate_built`. The joint manifest binds the Task 7 receipt, prior active Backend ref/digest and Gateway snapshot, candidate image ref/digest and Gateway snapshot, maintenance snapshot, locked prior and exact candidate admission records, `acceptedLiveSchemaHash`, `bootstrapSchemaHash`, dual-schema compatibility-report hash, contract hashes, candidate app/config/tree/build-manifest hashes, selected rollback-seed source/path/tree/build-manifest/receipt hashes, any `nonRollbackDisplacedApp` identity/disposition, source-manifest hashes, architecture, bundle ID, exact normal-role action flags, worker/scheduler inventory, root/child ownership records, and exact run paths. Only after all static checks pass may the journal enter `candidate_built`. No service, database, `/Applications` path, DMG, or ZIP changes in this step.

- [ ] **Step 3: Activate services through a bounded maintenance/read-only window**

First run with `--dry-run`; it emits the exact prior/candidate Backend and Gateway identities, selected verified rollback seed and displaced-App disposition, maintenance impact, drained-work requirements, recovery set, and `authorized:false` without changing services:

```bash
pnpm desktop:milestone:activate -- --dry-run --manifest /exact/run-scoped/joint-manifest.json --sha256 <exact-hash>
```

Present that report and obtain current explicit authorization. Then prepare and consume only the exact reviewed service-activation capability:

```bash
pnpm desktop:milestone:activate:prepare -- --manifest /exact/run-scoped/joint-manifest.json --sha256 <exact-hash>
SHENSI_DESKTOP_MILESTONE_ACTIVATION_TOKEN_FILE=/exact/owner-only/token \
  pnpm desktop:milestone:activate -- --manifest /exact/run-scoped/joint-manifest.json --sha256 <exact-hash>
```

Close Shensi and verify executable paths for all Electron helpers, not process names alone. Acquire the API-only owner lock, revalidate the token, joint manifest, selected rollback seed and compatibility receipt, displaced-App disposition, locked prior admission, prior live service hashes, and exact MySQL identity, then write/fsync the immutable activation-intent receipt and atomically enter `services_activation_pending`. Atomically move the token to its consumed tombstone and fsync the evidence directory. Only after the pending journal and consumed marker are durable may the first service mutation occur. If the rollback seed or its receipt changed, activation fails while the prior runtime is still untouched.

Switch/recreate the canonical Gateway from its prior immutable snapshot to the manifest-bound deny-write maintenance snapshot, reject new writes, and drain active HTTP mutations, workers, crawler/action claims, leases, and reconciliation jobs to zero. Stop only the prior Backend, leaving the maintenance Gateway and exact MySQL container, volume, mount, engine, project, and network in place. Capture `acceptedLiveSchemaHash` and the full protected-data fingerprint. Start the candidate Backend with the existing read-only principal and all workers/schedulers disabled; the maintenance Gateway proxies allowed read/authentication routes to this candidate while denying every business mutation. Perform only bounded internal bootstrap checks of routes and accepted-live-schema compatibility, with no DDL or business write, and prove the fingerprint is unchanged. Then write and fsync the immutable activation receipt binding the activation intent, candidate-build receipt, joint manifest, active maintenance Gateway, read-only principal, zero-worker inventory, exact accepted live schema/MySQL identity, and bootstrap evidence; atomically transition the journal from `services_activation_pending` to `services_activated_pending_candidate_smoke` with that exact receipt hash. Only after this durable transition may retained `pnpm api:verify:runtime -- --expected-role milestone-read-only` run. Keep the maintenance Gateway and read-only/worker-disabled candidate in place through candidate-App verification, installed-App promotion, and installed-App smoke; normal writes are not reopened in this step.

Any failure—including a role-verifier failure after the durable transition—keeps or restores maintenance mode, stops only the candidate services, restores the prior immutable Backend ref and prior Gateway snapshot, verifies their exact hashes/routes and the unchanged MySQL identity, then reopens traffic and records `failed_recovered`. A crash in `services_activation_pending` reconciles only the intent-bound prior/maintenance/candidate topology and either completes that exact activation or restores prior services; a crash after activation-receipt fsync but before journal transition may only reconcile that exact receipt and either complete the transition or restore prior services. Neither path may run the role verifier before state is `services_activated_pending_candidate_smoke`. Generated Compose argv may never contain `mysql`, `down`, or `--volumes`. Once normal traffic resumes, legitimate business rows may change; later checks therefore compare MySQL/container/volume/mount identity, `acceptedLiveSchemaHash`, and explicitly stable protected invariants rather than falsely claiming the entire live database remains byte-identical.

- [ ] **Step 4: Verify the candidate and durably advance the milestone**

Use `desktop:milestone:verify` as the sole command allowed to bind the gate evidence and move `services_activated_pending_candidate_smoke -> candidate_verified_pending_promotion`. It receives the exact joint manifest/hash and manifest-bound run-scoped App path, then invokes contracts, Backend, latest desktop Renderer, Electron, Sidecar, action storage/bridge fake matrices, route/business flows, scroll stability, package verification, runtime verification, and cold-start audits through explicit argv. Its Electron-owned read-only route harness opens only the run-scoped candidate, authenticates, verifies every current route, and closes the App without contacting Douyin or performing a real platform write. Strict `api:verify` receives the candidate path and explicit `--expected-role milestone-read-only`; it may pass because both app and services belong to the same joint manifest while all mutation/worker probes remain denied.

```bash
node --test scripts/desktop-milestone.test.mjs scripts/desktop-app-promotion.test.mjs
pnpm test:contracts
pnpm --filter ./backend test
pnpm --filter ./frontend test
pnpm --filter ./frontend test:types
pnpm --dir desktop test
pnpm --dir desktop typecheck
uv run --frozen --project services/media-crawler pytest -q services/media-crawler/tests/shensi_adapter
pnpm api:verify:desktop-action-storage:all
pnpm api:verify:desktop-action-bridge
pnpm api:verify:desktop-business-flow
node desktop/scripts/verify-package.mjs /exact/run-scoped/app/Shensi.app development
SHENSI_INSTALLED_APP_PATH=/exact/run-scoped/app/Shensi.app pnpm desktop:audit:cold-start
SHENSI_INSTALLED_APP_PATH=/exact/run-scoped/app/Shensi.app pnpm api:verify -- --expected-role milestone-read-only
git diff --check
```

The public invocation below causes the coordinator to execute and hash the complete command set above, close the candidate App, repeat the three explicit package/cold-start/API verifiers, and only then attempt the state transition:

```bash
pnpm desktop:milestone:verify -- \
  --manifest /exact/run-scoped/joint-manifest.json \
  --sha256 <exact-hash> \
  --app /exact/run-scoped/app/Shensi.app
```

It verifies that every recorded subprocess belongs to this invocation, writes/fsyncs an immutable candidate-verification receipt with the before/after close result hashes, and atomically advances the journal. It never accepts externally hand-written “pass” JSON or a newest App/report lookup. If any check fails or the user invokes `desktop:milestone:abort` instead of continuing, the milestone recovery path restores the bound prior Backend/Gateway version set and writes `failed_recovered`; it does not touch the installed app. Only a fully passing receipt makes `candidate_verified_pending_promotion` reachable.

- [ ] **Step 5: Audit the installed destination without mutation**

`desktop:promote:audit` requires journal state `candidate_verified_pending_promotion` and proves the active Backend image/Gateway snapshot still match that milestone. It resolves `/Applications`, candidate, and selected rollback-seed paths without following symlinks; confirms both candidate and seed are closed and hash-identical to the joint manifest; records their architecture/bundle ID/config/tree/build-manifest and compatibility-receipt hashes; and inventories exactly `/Applications/Shensi.app`, `/Applications/.Shensi.rollback.app` if present, and every prohibited `.Shensi.next-*`/stage/rollback-seed residue. Process checks resolve executable/bundle paths for Shensi and every Electron helper rather than relying on names. The currently installed App may predate manifests; in that first-upgrade case the audit accepts it only as `nonRollbackDisplacedApp` after exact non-symlink-path and `com.shensi.desktop` checks plus a full tree hash, never as current-source or rollback. It rejects a changed/missing selected seed, foreign bundle IDs, multiple rollback copies, any pending residue, open processes, insufficient space for candidate staging plus a verified seed and any required quarantine, or a destination outside exact `/Applications/Shensi.app`. It emits `authorized:false` with the exact candidate stage, `.Shensi.rollback-seed-<run-id>.app`, swap, pre-boundary recovery, existing-rollback disposition, non-rollback displaced-App quarantine/removal, and future-finalize sets. Existing unowned `desktop/release/`, `dist/desktop/macos/`, and orphaned/failed run roots are reported separately and are never included in automatic cleanup.

- [ ] **Step 6: Ask separately before replacing `/Applications/Shensi.app`**

After the operator reviews the joint candidate, active/prior Backend and Gateway records, audit, selected verified rollback-seed source/path/tree/build/compatibility hashes, any non-rollback installed-App hash and quarantine/removal disposition, prior rollback hash, rollback consequences, helper binary hash, exact future-finalize cleanup set, normal candidate worker/Gateway/admission plan, and the irreversible consequence of entering `normal_activation_pending`, ask explicitly for authorization covering both the App swap and post-read-only-smoke normal-write activation. Only then run `desktop:promote:prepare` to create an `O_EXCL`, no-follow, owner-only `0600` token at `.runtime/api-only/evidence/desktop-promotion/<run-id>/authorization.token`; pass only that printed absolute path through `SHENSI_DESKTOP_PROMOTION_TOKEN_FILE`. The token binds every reviewed hash, seed/displacement decision, path, quarantine/cleanup operation, activation step, and forward-only boundary but never contains a credential. Earlier migration, service activation, retirement, app-replacement-only, or general “continue” authorization does not authorize this combined promotion/write activation. The existing rollback slot remains untouched throughout staging, candidate swap, and smoke; its later exact replacement/removal must be listed in this token or finalize will refuse.

`desktop:promote` must not invoke `sudo`. Before its first `/Applications` mutation, it validates the token and version set, fsyncs journal state `staging`, and binds the absent candidate-stage, rollback-seed-stage, and next basenames. Beneath an already opened and validated `/Applications` directory it creates exclusive non-symlink `/Applications/.Shensi.stage-<run-id>/` and `/Applications/.Shensi.rollback-seed-<run-id>.app`, copies the candidate and selected seed with `ditto`, revalidates lstat/realpath/tree/build-manifest hashes, and fsyncs both plus the directory. The checked native helper operates on the already opened directory descriptor and fixed basenames: it moves the validated candidate stage to absent `.Shensi.next-<run-id>.app` with `RENAME_EXCL`, preventing merge/overwrite races. After all candidate/seed/service/helper/token hashes still match, the controller fsyncs the `prepared_to_swap` journal and containing directories, atomically moves the token to a non-reusable consumed tombstone, fsyncs it, and writes a separate metadata receipt containing only the token digest/manifest hashes—not token bytes. It invokes that exact tested helper binary once with `RENAME_SWAP` between `Shensi.app` and `.Shensi.next-<run-id>.app`, fsyncs `/Applications`, securely removes any retained token bytes after the consumed marker is durable, and records `app_swapped_pending_smoke`; the old installed App is now at the bound `.Shensi.next-*`, the verified recovery seed remains at its own stage path, and the prior `.Shensi.rollback.app` is still unchanged.

Plain `rename`, `mv`, or two sequential renames may not be described as atomic replacement. Missing compiler/API support, write access, same-filesystem identity, exclusive candidate/seed staging, helper-hash evidence, or any other precondition fails before token consumption and before the installed path changes. If staging crashes before token consumption, only the same run may resume: it revalidates the still-live token and bound `staging` journal, removes a partial candidate/seed stage only when its exact owner/path is proven, or continues from hash-valid stages/`.next-*`; unknown residue enters `recovery_required`. If any pre-swap precondition fails or the user cancels, invoke the exact `desktop:milestone:abort` path rather than leaving a non-terminal journal. If the process dies after token consumption, retry does not request or consume a new token: it reconciles the exact bound hashes at `Shensi.app`, `.Shensi.next-*`, rollback-seed stage, and existing rollback to determine pre-swap versus post-swap state, completes the missing fsync/journal transition, and otherwise enters `recovery_required`. Unknown hash combinations never trigger a guessed rename or deletion.

- [ ] **Step 7: Smoke, rollback on failure, and bound storage**

While the maintenance Gateway and read-only/worker-disabled candidate remain active, open the installed app, authenticate, visit every route, close it, and run exactly:

```bash
SHENSI_INSTALLED_APP_PATH=/Applications/Shensi.app pnpm api:verify -- --expected-role milestone-read-only
SHENSI_INSTALLED_APP_PATH=/Applications/Shensi.app pnpm desktop:audit:cold-start
node desktop/scripts/verify-package.mjs /Applications/Shensi.app development
```

A failed smoke or pre-boundary finalize permits `desktop:promote:rollback` from `app_swapped_pending_smoke` or `rollback_slot_finalizing` and only after the candidate App/helpers close. Maintenance is already active and must remain active; rollback reasserts its exact hash and zero in-flight mutations, stops the read-only candidate Backend, starts the prior immutable Backend behind maintenance, and verifies its digest, internal routes, schema compatibility, and unchanged MySQL/container/volume identity. It then atomically restores the selected verified rollback seed to `Shensi.app`, never an unverified displaced App, and returns an older rollback to its original slot when one existed. If the seed came from the old installed App, this is byte-identical restoration; if it came from Task 5, the recovery receipt explicitly records `recoverySeedSubstituted:true`, keeps the unverified displaced App at its bound path until its authorized owner-only quarantine copy is hash-verified/fsynced, and only then removes that exact `/Applications` residue. After the seed App and prior Backend are proven, restore a prior-version pointer that binds the same prior services, locked desktop admission, and selected seed identity; restore the prior Gateway snapshot as the last step; verify the complete recovered set; reopen traffic; and atomically record `failed_recovered`. Candidate App/version staging is removed only after joint recovery succeeds, and the pre-existing rollback slot is restored. Any interruption resumes from the same journal and hash reconciliation. An unknown combination enters `recovery_required`; it never guesses, reopens traffic, restores an unverified App, or falls back to Trial.

On successful read-only smoke, keep the App closed and run `desktop:promote:finalize` under the consumed authorization receipt. Before any write-capable process starts, finalize revalidates maintenance, zero in-flight work, the candidate's exact normal action-role flags (`approvals=true`, `server=false`, `desktop=true`), absent remote MediaCrawler configuration, guarded transformer and desktop claim/complete routes, Backend/Gateway candidate-only desktop-admission build hash, exact worker/scheduler inventory, MySQL/schema identity, selected seed and compatibility receipt, the existing rollback slot, the non-rollback displaced App, and every manifest hash, then durably enters `rollback_slot_finalizing`. These are configuration/inventory checks only and may not claim a real action. If a prior rollback exists, use the tested helper to atomically exchange `.Shensi.rollback-seed-<run-id>.app` with `.Shensi.rollback.app`; if none exists, use `RENAME_EXCL` from the verified seed stage into the absent rollback slot. Keep the displaced older rollback at the exact bound seed-stage path and keep the old installed App at the exact `.Shensi.next-<run-id>.app` path until normal activation succeeds. Fsync `/Applications` and verify every tree/build-manifest hash.

Resume from `rollback_slot_finalizing` recognizes only token-bound seed topologies: pre-exchange (`seedStage=verifiedSeed`, `rollback=older-or-absent`, `next=oldInstalled`), post-exchange (`rollback=verifiedSeed`, `seedStage=older`, `next=oldInstalled`), or no-prior-slot completion (`rollback=verifiedSeed`, `seedStage=absent`, `next=oldInstalled`). It completes or reverses only those exact states. A pre-boundary coordinated rollback places the selected verified seed at `Shensi.app`, returns an older rollback to its original slot when present, quarantines/removes a non-rollback old installed App only as explicitly authorized, removes only candidate residue, and restores prior services as specified above. Unknown hashes enter `recovery_required`; no broad deletion is permitted.

Still behind maintenance, hash-copy the joint/Task 7 manifests; the original Task 5 acceptance manifest, both package/cold-start/API reports, migration-acceptance binding, and selected-seed compatibility receipt; candidate and rollback Backend/Gateway/admission/maintenance snapshots and Compose records; source/build/activation/candidate-verification/promotion receipts; any non-rollback displaced-App quarantine tree plus its provenance; and tested native-helper identity into fixed owner-only content-addressed `.runtime/api-only/versions/<milestone-id>/` and evidence roots. Verify every copy and its source hash before writing only a journal-bound pending-version pointer; the authoritative active-version pointer remains on the prior set throughout `rollback_slot_finalizing`. Prove neither the pending candidate nor retained rollback/evidence manifest points only into a disposable Task 5 or Task 8 run root. A pre-boundary failure removes only its exact pending pointer/copies after restoring the prior set; it never leaves `api:start` pointing at the candidate and never deletes original evidence.

Finalize then durably enters `normal_activation_pending` before enabling a write-capable principal or worker. The journal transition is the forward-only authority; after it is fsynced, finalize atomically promotes the already verified pending-version pointer to active and reconciles that pointer on every retry. From this state, rollback is closed: retrying the same idempotent finalize operation reasserts maintenance, starts only the bound candidate Backend in normal mode with the expected worker inventory, verifies it behind maintenance, switches to the bound candidate normal Gateway—with `desktopClientAdmission:{ mode:"exact", admittedBuildManifestSha256:<candidate> }` identically enforced by Gateway and Backend—as the last traffic-opening commit, and runs `SHENSI_INSTALLED_APP_PATH=/Applications/Shensi.app pnpm api:verify -- --expected-role normal`. It then performs one bounded cold restart through the private journal-capability lifecycle adapter, proving the fixed active record uses the immutable image/Gateway/admission snapshot with `--no-build`, preserves the exact MySQL container/volume, and passes the same normal-role verifier. Public `api:start|stop|db:start` remain blocked until completion. A failure at or after this boundary immediately reasserts maintenance when possible and recovers forward on the same candidate; it never swaps back the App or starts the prior Backend/Gateway because candidate writes may already exist. Only both healthy normal-role verifications and verified stable quarantine copies may remove the token-bound old installed App at `.next` and any displaced older rollback at the seed-stage path, fsync `/Applications`, and atomically record `finalized`; public accepted-state lifecycle aliases are enabled only after that durable final state.

Completion requires `/Applications` to contain exactly current `Shensi.app` plus one `.Shensi.rollback.app`, zero `.Shensi.next-*`/candidate-stage/rollback-seed-stage paths, zero live authorization token, and a retained consumed receipt. The current manifest binds the candidate Backend/Gateway and exact admitted build digest; the rollback manifest binds the selected verified seed to its compatible prior Backend/Gateway and locked admission record. “One app plus one rollback” applies to `/Applications`, not the whole disk. Any quarantined non-rollback App and retained prior service set are evidence for a future separately authorized compatibility-reviewed recovery, not an automatic rollback target after normal traffic has opened.

After fixed active/rollback version records and both cold-restart checks pass, remove only the owner-manifested candidate App and temporary build subdirectories that no retained manifest references; never delete the whole final run root merely because promotion succeeded. Joint/source manifests, active or rollback Gateway snapshots, immutable image records, Compose records, receipts, selected-seed evidence, displaced-App quarantine, and helper/test evidence remain in the stable version/evidence roots. Audit failed/interrupted run roots only by their exact owner manifests after confirming no process uses them; never run a broad build-directory clean. Existing unowned `desktop/release/` and `dist/desktop/macos/` require a separate reviewed manifest and authorization. Purging the sole rollback App, a displaced-App quarantine, or a superseded immutable Backend image/Gateway snapshot are later, separately audited and separately confirmed storage-reclamation operations; none may remove the active version or any version named by retained rollback evidence. Post-finalize use of `.Shensi.rollback.app` is a new recovery transaction requiring its own reviewed authorization, not a replay of the consumed promotion token. Do not generate a DMG/ZIP until a future signed release milestone.

- [ ] **Step 8: Synchronize final current-document truth after durable finalization**

Only after the milestone journal is durably `finalized`, the active-version pointer contains `desktopClientAdmission:{ mode:"exact", admittedBuildManifestSha256:<current> }`, and the no-build cold restart plus normal-role verification pass, update `README.md`, `frontend/README.md`, `docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`, `docs/PROJECT_STATUS.md`, `docs/modules/acquisition.md`, `docs/desktop/macos-electron-client.md`, and `docs/operations/api-only-runtime.md` together. Record the non-secret current embedded build-manifest SHA-256 from the finalized active record and state that `/Applications/Shensi.app` is the admitted UI, local API-only Backend/Gateway/MySQL remain the current pre-cloud center runtime, and Web/noVNC/Trial executable entrypoints are retired. Remove the temporary claims that client admission is `migration_locked`, the installed App is unavailable, or source retirement is pending; preserve dated migration/recovery evidence as history. Do not claim Alibaba Cloud, RDS/TLS, two-Mac, or a real Douyin write passed unless separately evidenced.

Run the state-aware current-document contract and final runtime verifier:

```bash
node --test scripts/api-only-runtime.test.mjs
SHENSI_INSTALLED_APP_PATH=/Applications/Shensi.app pnpm api:verify -- --expected-role normal
rg -n "migration_locked|installed App.*unavailable|Web/noVNC.*pending" \
  README.md frontend/README.md docs/ARCHITECTURE.md docs/DEPLOYMENT.md \
  docs/PROJECT_STATUS.md docs/modules/acquisition.md \
  docs/desktop/macos-electron-client.md docs/operations/api-only-runtime.md
git diff --check
```

Expected: the test and verifier exit 0; the `rg` command has no current-state matches (historical/migration links alone are explicitly classified by the contract); all eight documents agree on `exact` admission and the active digest. If documentation update or verification fails after runtime finalization, leave the verified runtime untouched, report Task 8 incomplete, and rerun only this idempotent documentation step—never replay promotion or change the active pointer.

---

### Task 9: Alibaba Cloud readiness and deferred real-environment acceptance

**Files:**
- Create: `docs/operations/aliyun-api-deployment.md`
- Modify the canonical file created by the action-bridge plan: `docs/desktop/acceptance/aliyun-two-mac-checklist.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/desktop/macos-electron-client.md`

**Interfaces:**
- Documentation only until actual Alibaba Cloud resources exist.
- Defines the same API-only image/config contract used locally; no Alibaba SDK is introduced.
- Separates prerequisites, deploy commands, rollback commands, and evidence fields so missing real evidence cannot be marked passed.

- [ ] **Step 1: Document exact future infrastructure boundaries**

Require HTTPS 443 at the public edge, a fixed trusted reverse-proxy hop, private Backend networking, private RDS/MySQL with TLS, encrypted backups, log retention/redaction, and a stable API DNS name. Explicitly prohibit public Backend and RDS ports.

- [ ] **Step 2: Document immutable deployment inputs**

List image digests, schema version, OpenAPI release hash, required secret names, RDS CA bundle path, expected `CORS_ORIGINS`, expected `TRUSTED_PROXY_CIDRS`, and the desktop `remoteOrigin`. Use environment-variable names and evidence slots; do not invent a domain, IP, certificate, account ID, or secret value.

- [ ] **Step 3: Document migration and rollback commands**

Reuse `scripts/migrate-data.mjs`, encrypted backups, and `scripts/verify-data.mjs`. Require a write freeze, target-empty check, post-restore counts/IDs/ciphertext validation, application health, and an explicit rollback decision before the old database is retired.

- [ ] **Step 4: Validate and extend the one canonical two-Mac checklist**

Do not create a second checklist. Validate the action-bridge plan's canonical file and extend it only where the cloud topology needs additional evidence. Require two separate installation IDs and Profiles. Verify shared business data, one active execution owner per Douyin account, explicit handoff generation, rejection of stale completion, API disconnect recovery, response-loss idempotency, and one separately authorized real comment/private message without duplication.

- [ ] **Step 5: Mark current status accurately**

`docs/PROJECT_STATUS.md` must say that local API-only and simulated multi-device verification can complete before purchase, while real Alibaba Cloud/RDS/TLS/two-Mac evidence remains not run until resources exist.

- [ ] **Step 6: Validate documentation and repository state**

```bash
rg -n "Railway|TODO|TBD|待定" docs/operations/aliyun-api-deployment.md \
  docs/desktop/acceptance/aliyun-two-mac-checklist.md
node --test scripts/api-only-runtime.test.mjs
SHENSI_INSTALLED_APP_PATH=/Applications/Shensi.app pnpm api:verify -- --expected-role normal
git diff --check
git status --short
```

Expected: the first command has no matches; the state-aware current-document contract and normal-role verifier still bind all Task 9 edits to the finalized `exact` admission record; `git diff --check` exits 0; status shows only preserved user changes plus this plan's intended implementation/docs changes.

---

## Plan Completion Gate

Before migration/cutover, this plan's prerequisite is Tasks 1, 2, 2A–2G, 3, and 4 plus Task 5's implemented harness and passing unit tests, with Trial still recoverable. Task 5 becomes complete only when both live audits pass after authorized read-only cutover. Local desktop-only migration is complete only after write acceptance, Task 6 recoverable runtime retirement, separately authorized Task 7 source/entrypoint removal, and Task 8's post-retirement current-source Backend/App build, local promotion evidence, durable `finalized` state, and synchronized final current-document contract all pass. Task 6 execute and Task 7 deletion happen only after recorded cold-start and write-acceptance evidence; Task 6 purge remains optional after seven days and separate authorization. Task 9's runbooks/static validation must pass, while real Alibaba Cloud deployment and two-Mac evidence remain deferred until those resources exist and must not be reported as passed.

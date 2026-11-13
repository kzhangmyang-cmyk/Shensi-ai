# Task 9 — Control automatic Douyin acquisition in the Shensi dashboard

Status: implemented and verified with a deterministic real-HTTP fixture. No
real Douyin action, account credential or backend change was used.

## RED

The two API, two controller and two view self-tests were added before their
implementations. The required first four commands initially reached pnpm's
offline dependency check, so the same TypeScript entry points were rerun with
the already-installed local Node loader. Each failed at the expected boundary:
the new API/controller/view modules did not exist. Implementation started only
after that exact `ERR_MODULE_NOT_FOUND` RED was recorded.

## GREEN

- `douyin-automation-api.ts` and `outreach-batch-api.ts` consume only generated
  acquisition DTOs. Their authenticated requests use exact public paths,
  credentials, browser CSRF, semantic idempotency, `If-Match` and caller
  `AbortSignal`; request bodies are closed and response/status failures remain
  distinguishable, including malformed projections and 401/403/409/412.
- The automation controller owns one QR poller and one run poller, expires and
  reconnects QR sessions, saves editable keywords/local time/timezone and the
  1–200 daily limit (default 50), fences async generations, makes run-now
  single-flight, and aborts on mode change, logout and close.
- The batch controller preserves opaque batch identity outside rendered text,
  maps selected candidate positions back to server identity only at the API
  boundary, saves exact comment/direct-message edits as revision 2, reloads
  current authority after 409/412, requires a second approval confirmation,
  and polls pause/resume plus sanitized action receipts.
- The existing dark Shensi dashboard still has one `.replica-shell`, its
  current brand/navigation/session behavior and focus semantics. Automatic
  Douyin acquisition is the primary workspace; authorized public-link import
  is a collapsed secondary fallback. The real-task inspector uses a local
  display label and local timestamp instead of exposing an internal task ID.
- Desktop renders candidate rows beside a public-evidence inspector. At 390px
  the candidates and inspector become one-column cards. Main/body scrolling is
  restored at desktop, 1024px and 390px with no nested frozen-pane trap.
- The deterministic fixture is a real local HTTP server. The Playwright test
  has zero `page.route`, `route` fulfillment or Shensi response interception.
  It covers auth/session restore, QR states, save/enable/run-now, running and
  partial progress, creator/commenter candidates, keyboard selection, exact
  editors, revision 2, stale approval reload, explicit confirmation, daily
  remaining allowance, comment/message receipts, pause/resume, reload identity
  and 1440/1024/390 overflow/scroll checks. Intentional 412 is classified;
  unexpected console and HTTP errors remain zero.

## Browser plugin QA

The required Browser plugin was available and used after the repository
Playwright run; no fallback was needed. Against the same real HTTP fixture it
rendered and interacted with the authenticated dashboard at 1440, 1024 and
390 pixels. It verified one shell/workspace, QR connection to active, save and
run-now, partial progress, the two candidate kinds, mobile candidate selection
and evidence, a body-scroll jump to the lower performance dashboard, and no
visible `task-fixture` identifier. Rendered screenshots showed the desktop
lower-page flow, the 390px one-column candidate/evidence stack and the 1024px
dashboard. Browser console capture was empty and no framework overlay appeared.
The temporary viewport override was reset and the fixture/Vite processes were
stopped after QA.

## Verification

- Six focused API/controller/view self-tests: passed (2 API, 2 controller,
  2 view).
- `pnpm --dir frontend test`: passed, aggregate `checked: 56`.
- `pnpm --dir frontend test:types`: passed source, browser-test and visual-
  reader TypeScript projects.
- `pnpm --dir frontend exec playwright test tests/douyin-mediacrawler-acquisition.spec.ts --project=chromium`:
  1 passed in 17.4 seconds.
- `pnpm --dir frontend build`: passed; only the existing Vite chunk-size
  advisory remains.
- `pnpm check:context`: returned `SHENSI_CONTEXT_OK`.
- `pnpm test`: passed 92 contract tests, backend self-test/provider gate,
  frontend 56 checks and Baota package 2/2.
- `pnpm build`: passed generated contract freshness, backend TypeScript and
  frontend production build; only the existing Vite chunk-size advisory
  remains.
- `git diff --check`: passed.

## Documentation and scope

README, Architecture, Acquisition module and the sole current Project Status
ledger now describe the automatic-first UI, controller/abort authority,
responsive scrolling, privacy boundary and Task 10 as the next authorized
stage. API Index was checked and remains current because Task 9 consumes the
already-published generated contract without changing a route or DTO.

The change touches only frontend runtime/view/test code and current
documentation. It does not modify backend, contracts, generated contract
bytes, deployment or the private MediaCrawler service. It sends no real Douyin
comment, message or crawl and makes no cutover or dedicated-account acceptance
claim.

## Commit

`feat(frontend): control automatic Douyin acquisition` (this report is included
in the commit; the exact immutable hash is supplied in the handoff).

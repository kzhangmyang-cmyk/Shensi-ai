# Task 4 Report — Provider connection to Douyin plan E2E

## Result

Added a dedicated deterministic Playwright flow for the first-use customer
journey from zero usable search connections to an explicit Douyin public-search
plan. The test configures an official `baidu_ai_search` BYOK connection in the
current workspace, saves it disabled, tests it, enables it, and continues the
preserved task without calling a real provider.

A second scenario covers an HTTP 200 health response with `ok:false`: the
connection remains disabled, the failure is visible, enable/continue remain
blocked, and no Copilot planning call occurs. No production integration change
was required.

## Contract and security coverage

- Provider connection list projections are driven by formal writes:
  `empty -> disabled/untested -> disabled/passed -> active/passed`.
- Create is an exact collection POST with the selected Provider, fixture-only
  sentinel, `status:"disabled"`, and an `Idempotency-Key`.
- Health test is an exact bodyless POST with neither idempotency nor `If-Match`.
- Enable is an exact PATCH body `{status:"active"}` with no invented write
  headers.
- Raw `apiKey` values are redacted before fixture request records can reach
  assertion diagnostics. Secret checks report only booleans or affected surface
  names, never the sentinel itself.
- The live input is cleared and the sentinel is absent from drawer HTML, URL,
  localStorage, sessionStorage, and console output.
- The preserved task, Douyin platform, and selected template survive the
  connection lifecycle. The Copilot message contains `targetPlatform:"douyin"`
  and the rendered plan contains only the fixture's allowed compiled public-site
  queries.
- The strict fixture rejects undeclared Acquisition traffic and denylisted
  comment, reply, message, friend/group, or outreach writes outside that API.
  The exact write ledger contains no automatic outreach or todo creation.

## RED to GREEN

The initial dedicated run executed two scenarios and produced one passing test
plus one failing assertion. The failure exposed an incorrect test assumption:
after save, the new-key field is replaced by a legitimate empty rotation field,
so the correct security contract is an empty value rather than an absent node.
The assertion was corrected and the suite went green without a production-code
change.

A later verification run found an incidental exact GET-count assertion could
vary when the overview request was cancelled during navigation. It was replaced
with exact de-duplicated state-transition assertions, preserving strict
lifecycle coverage without depending on browser scheduling.

## Fresh verification

| Check | Result | Duration |
|---|---:|---:|
| `npx playwright test tests/ai-acquisition-provider-connection.spec.ts --project=chromium` | 2 passed | 8.2 s |
| `npx playwright test tests/ai-douyin-platform-discovery.spec.ts --project=chromium` | 1 passed | 8.2 s |
| `npm run test --workspace frontend` | 126 unit tests passed; self-test checked 75 | 1.35 s |
| `npm run build --workspace frontend` | passed; existing large-chunk warning only | 7.68 s wall / 4.83 s Vite |
| `npm run test:acquisition --workspace backend` | 404 passed | 198.3 s |
| `npm test` | all root phases passed: contracts, backend, frontend and Baota | 19.5 s |
| `npm run test:contracts` | 25 passed | 3.01 s |
| `npm run test:contract-drift --workspace backend` | 16 passed | 3.51 s |
| `npm run test:acquisition-openapi --workspace backend` | 22 passed | 1.83 s |
| `npm run check:generated-acquisition-types` | passed | 1.80 s |
| `npm run test:baota-package` | 1 passed | 10.17 s |
| `git diff --check` | passed | <0.1 s |

## Documentation

Added `搜索来源连接中心` to the product documentation. It lists the six
supported official search Provider IDs, explains disabled-first BYOK setup and
`active + passed` gating, states encryption/write-only and official Base URL
restrictions, separates search Provider from target content platform, and makes
the public-index/no-automatic-outreach limitations explicit.

## Independent review

The first review found five actionable issues: PATCH matching was not exact,
external outreach paths were too narrowly observed, raw secret-bearing request
records could reach failure diagnostics, list state depended on GET count, and
the unhealthy HTTP 200 scenario needed more explicit proof. All were addressed.

Scoped re-review confirmed the exact PATCH, redacted diagnostics, write-driven
state, and unhealthy-200 coverage. A final denylist gap for generic message
endpoints was then closed. Final independent verdict: **spec compliant** and
**quality good**, with no remaining finding.

## Remaining risks

- The browser flow is deterministic and intentionally does not prove live
  credentials or third-party Provider availability.
- Playwright coverage uses the repository's configured Chromium project; other
  browser engines are outside this task's matrix.
- The production build retains the repository's existing large-chunk warning;
  this task adds no production bundle code.

## Scope

Changed only the dedicated E2E, product documentation, Task 4 plan/progress, and
this report. The protected untracked July 23 plan was not read, modified,
staged, or committed.

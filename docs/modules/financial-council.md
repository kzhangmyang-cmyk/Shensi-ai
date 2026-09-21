# Financial Council

## Responsibility

The page first offers general enterprise-document analysis using the shared
read-only finance document service. Partial CSV/XLSX, text PDF and DOCX do not
require a complete statement package. Its source-backed HTML/PDF report is
page-local until exported, separate from persisted formal council runs.
The formal report/export section remains visible without a run, with disabled
buttons and the reason. Opening an existing run from history loads its report;
only a matching loaded collaboration report enables export. PDF uses the existing
desktop export bridge; no second rendering engine is introduced.

Builds a financial snapshot from authoritative facts or a statement package,
runs specialist analysis and audit/rebuttal, derives CFO consensus and
portfolio scenarios, requires human approval, and dispatches only controlled
draft/todo operations with durable receipts.

## Entry Points

- Composition: `backend/src/growth-financial-council-module.ts`.
- Domain/API: `backend/src/financial-council-service.ts` and
  `backend/src/financial-council-router.ts`.
- Supporting routers: policy, model-routing, statement-package, and
  agent-center `financial-council-*-router.ts` files.
- Workers: analysis, optimization, dispatch, and their recovery sweepers.
- Public projection: `backend/src/financial-council-collaboration.ts` derives
  role state, review history and the eight-section report from persisted facts.
- Desktop report export: `desktop/src/main/council-report-ipc.ts` and the
  narrow `window.shensiCouncilReport` preload bridge.
- Frontend: `frontend/src/growth/council/` and
  `frontend/src/growth/agents/`, routed by `frontend/src/growth/router.ts`.

## Dependencies

Growth workspace/capability context, finance facts and statement packages,
advisor and acquisition projections, model connection snapshots/gateway,
Growth HTTP idempotency, MySQL repositories, and the immutable Growth contract
release `1.0.21`.

## Database Tables

Repository DDL owns `financial_council_runs`, run events and snapshots,
`financial_council_collaboration_events` (append sequence plus unique
workspace/run/event identity),
specialist/audit/rebuttal/consensus facts, portfolio revisions, policy
versions, model-routing versions, dispatch operations/events/receipts,
`financial_council_drafts`, and financial statement package tables. Inspect
`financial-council-mysql-repository.ts` and the focused policy, routing, draft,
dispatch, and statement-package repositories for exact columns.

## Public Interfaces

Contracted routes are under `/api/v1/finance/council-runs`,
`/api/v1/finance/council-policy`,
`/api/v1/finance/council-model-routing-policy`,
`/api/v1/finance/statement-packages`, and the finance agent-center reads. The
editable contract is `growth-advisor-quote-roi.v1.yaml`; release `1.0.21`
contains the current immutable public snapshot.

`GET /api/v1/finance/council-runs?limit=20&after=...` returns workspace-scoped
recent frozen runs, newest first. `after` identifies an existing run in that
workspace; limits are 1–100. `GET .../{runId}/events` supports the same limit
range with an event-ID cursor. The frontend reads all event pages with ID
deduplication and rejects repeated cursors.

`GET .../{runId}/collaboration` returns six independent role states, public
events, review outcomes, full CFO narrative provenance and a detailed report.
It verifies the frozen snapshot and fences run revision and appended event
identities around its reads. If the worker keeps changing them across three
attempts, the read returns `409 financial_council_read_retry` for a fresh read.
No raw prompt, provider binding, lease token or private model reasoning is
returned.

## Collaboration and reports

Five specialist analyses run sequentially. Successful stored findings, actual
starts, failures and missing input are recorded under the worker lease;
recovery skips completed specialists. Rules audit selects only actual conflicts
for one bounded targeted review. The public record retains the original
analysis, correction text/evidence, upheld/withdrawn decisions and unresolved
disagreements. A replacement draft is not silently promoted into a recalculated
financial fact.

The CFO's `overallDiagnosis`, `priorityFindingIds`, `minorityFindingIds`,
`riskNotes` and `narrativeStatus` are persisted before the consensus write and
reused on recovery. Invalid/unavailable model output is explicitly degraded;
historical consensus without provenance is not shown as verified model success.
Ordinary Chinese words such as 成本、形成、统一 do not count as numerical claims;
unsupported numeric/monetary assertions and missing citations remain rejected.

The shared model gateway persists each provider attempt before returning it.
`ModelLedgerPersistenceError` retains storage and provider causes separately
from provider availability errors. The council adapter maps it to
`financial_council_model_ledger_persistence_failed` without another flush or
provider call. This applies to the original attempt, a bounded repair and
preflight failures; an undurable attempt cannot become a successful finding.

The sidebar entry reads workspace history and restores the latest run without
requiring a run ID in the address. New analysis requires a verified confirmed
statement package, model readiness, formula policy and the run capability.
Empty or unready workspaces show the real missing prerequisite and a link to
prepare it. All three statement-preparation links and the supporting preparation
action open `#agents`, whose “准备财务分析” dialog owns the three-statement
package flow; they do not open the `#growth/finance` ledger import.
The shared shell router tracks whether a standalone module still owns the
surface. Returning from Council through an ordinary hash link or browser history
restores the same title, active navigation, route classes and preparation
inspector as sidebar navigation, even if the last standalone module was agents.
Preparation role cards label `ready` as “等待运行”: this role state means no
run exists, not that financial data or a model connection is ready. Separate
data/model projections retain those checks, and saved execution states remain
unchanged. One failed auxiliary request does not discard a successful run;
retry is available, and terminal non-dispatch runs stop polling. Reading,
exporting or opening history does not approve actions or replace a draft.
Successful run reads insert or update the current history item immediately,
including a run created on the same page, while retaining the history cursor.
When a newer run revision arrives before its collaboration projection, the
previous same-run report remains readable with an explicit revision/update
notice. Focus, expanded sections, input drafts and reading position survive
that transition; a report from another run is never retained. Failed,
expired, rejected or uncomputable runs without consensus show their actual
terminal reason rather than a continuing-generation message.

The detailed report contains executive priorities, source/period/method,
deterministic metrics, specialist evidence, cross-review, scenario comparison,
suggested actions and a version/formula/gap appendix. Missing cash-flow inputs
are not displayed as zero; absent comparable periods do not produce trends.
The screen, HTML download and PDF use the exact same loaded `reportId` and
`financial-council-report.v1` content; exports never fetch a newer report.
Completion, cancellation and failure feedback is also scoped to that run and
report. Switching reports or leaving the page suppresses feedback from an old
export without changing the export's original content or destination.
Partial reports and degraded CFO summaries remain visibly labelled.

Report presentation translates known status, conclusion, action and constraint
codes into Chinese. `risk_hypothesis` means a risk judgment requiring
verification, not a confirmed finding. Specialist headings use role and formula
topic; impact estimates come only from linked saved candidate actions, without
adding repeated actions together. Gap-ID assumptions resolve to recorded gap
descriptions; an unresolved reference remains explicitly missing. Model free
prose and business subject names retain their original text.

Body citations use deterministic short numbers. One appendix index retains full
source IDs, aliases, formula versions and input/result hashes. Report-derived
metrics cite the report/package, not unrelated CRM or quotation records in the
snapshot. Unknown technical codes receive a readable fallback with the original
in the appendix. The full report ID/version appears at the end, and section
numbers are not duplicated. The isolated acceptance provider emits Chinese
review prose; production model text is not translated to match the sample.

PDF export validates static HTML and fragment-only report links, checks the
current local top-frame renderer, then uses an isolated sandboxed window with
scripts/network/navigation disabled. Only the native save dialog selects a
path. Cancellation saves nothing; the temporary print window closes on success,
failure or disposal. The existing application window is not restarted.

The read-only question path `/api/v1/finance/cfo-conversation` supports one
selected role among all six specialists, using an explicitly selected read-only
CSV/XLSX source or the latest confirmed three-statement package and current scoped
model routing. Both paths retain selected-role methods; only verified packages
use the complete-statement deterministic fact gate. CFO is the default. Finance
ledger commits and unconfirmed statement previews do not implicitly select
question material. Partial source reading creates no verified package and does
not change the formal council run prerequisites. See `agent-specialist-skills.md` for the source
and role support matrix.
It creates no council runs or actions and does not replace council specialists.
See `cfo-conversation.md` for conversation and voice boundaries.

## Tests

- Full council domain suite: `pnpm test:financial-council`
- Vertical slice: `pnpm --filter ./backend test:financial-council:vertical`
- Collaboration/report HTTP and regression suite:
  `pnpm --filter ./backend test:financial-council:collaboration`
- Frontend council API/controller/entry/view/report regressions are part of
  `pnpm --filter ./frontend test`.
- Desktop PDF bridge: `pnpm --dir desktop exec tsx --test tests/council-report-ipc.test.ts`
- Reproducible report sample:
  `pnpm --dir backend exec tsx scripts/financial-council-collaboration-sample.ts`.
  Uses only the in-memory integration fixture and deterministic model, writes
  clearly labelled artifacts under `outputs/financial-council-collaboration-sample/`,
  and does not read/write the application database or invoke providers.
- Visible native PDF acceptance, after generating that sample:
  `node desktop/scripts/council-pdf-native-harness.mjs`.
  Opens a separate, explicitly labelled sample window with a clickable PDF
  button, using the production report renderer, preload and IPC. A random
  loopback origin serves only its static page/script; a fresh temporary
  `userData`/session and filtered environment isolate it from the real app.
  Click export and cancel first, then export and save to a chosen test path.
  Verify the displayed cancelled/saved result, the same report ID in the PDF,
  and that the sample window remains usable. Closing it or pressing Ctrl-C in
  its terminal stops only this harness. The printed temporary directory and
  chosen PDF are retained; no application data is deleted.
  `--prepare-only` bundles without opening a window. `--smoke` starts a separate
  hidden Electron window, verifies the rendered button, production bridge and
  report ID, then exits without opening a save dialog. Startup has a 15-second
  stage deadline and prints `ready` or a bounded failure diagnostic; the ESM
  entry completes before waiting for Electron's ready event.
  Its focused tests are
  `node --test desktop/scripts/council-pdf-native-harness.test.mjs`.
- MySQL suite: `pnpm --filter ./backend test:financial-council:mysql`
- Real-runtime integration: `pnpm --filter ./backend test:financial-council:real-runtime`
- Real browser: `pnpm test:e2e:financial-council:real`

## Operational Checks

Follow `docs/operations/financial-council-real-runtime.md`. Real-runtime and
browser evidence require `MYSQL_TEST_ADMIN_URL`; live-provider smoke additionally
requires valid model connection IDs and decryption keys. Verify restart
recovery, approval authority, revision identity, dispatch idempotency, and that
no provider payload or business data leaks through agent-center projections.
When the agent-center projection reports no routing-policy version, the browser
renders that empty state without issuing policy or preview requests that are
guaranteed to return `404`.

The current isolated local acceptance (2026-09-07) has two complementary
levels of evidence. A real HTTP/MySQL request path completed statement preview,
package commit, computed cash forecast and council creation through
`snapshot_frozen`. It intentionally had no eligible live model connection.
The controlled real-runtime MySQL suite passed 5/5 and covers the complete
package -> analysis -> `awaiting_approval` -> approval -> dispatch-receipt path,
including recovery after creating a second runtime. Do not treat run creation
alone as proof that specialist analysis or dispatch completed.

## Known Limitations

Consent-only statement packages intentionally remain `not_computable` without
an attested cash forecast. Live-provider behavior is unverified when local
credentials are absent, and memory suites do not prove MySQL concurrency or
cross-process recovery. Approval creates controlled downstream work; it does
not grant unrestricted autonomous execution.

# Task 4 report — final documentation and verification

## Documentation delivered

- Updated `README.md`, `docs/PROJECT_STATUS.md`, `docs/ARCHITECTURE.md`,
  `docs/modules/acquisition.md`, and `docs/DEPLOYMENT.md` to state the current
  local visible-window and production headless behavior directly.
- Documented that local `MEDIACRAWLER_BROWSER_HEADLESS=false` uses a dedicated
  standard-Playwright Douyin window, production may set `true`, and Shensi
  explicitly disables CDP.
- Defined the visible tab as an operator observation mirror for the approved
  keyword and public video. The deterministic MediaCrawler request client is
  the data authority, and observation navigation cannot fabricate results.
- Reconciled the Task 3 crawler-status contract without duplicating
  `docs/API_INDEX.md`: the persisted public activity is limited to phase,
  approved keyword or null, visible/headless mode, and monotonic sequence.
- Documented that the dashboard polls the persisted Node projection, shows the
  localized phase, browser mode, keyword, attempt/update time, and candidate
  allowance, and blocks duplicate runs while the current intent is unobserved
  or nonterminal. Comment and direct-message approval rules are unchanged.
- Recorded the prohibited public/documented details: raw URL, profile path,
  cookie, header, selector, CDP/WebSocket endpoint, browser identifier, and
  raw log.

## Initial Task 4 deterministic verification (historical)

This section records the earlier documentation-only Task 4 pass before the
later crawler-lifecycle remediation and local QR acceptance work.

| Command | Result | Evidence |
| --- | --- | --- |
| `./scripts/context-check` | PASS | `SHENSI_CONTEXT_OK` |
| `pnpm check:acquisition-contracts` | PASS | Contracts: 94 passing tests; contract drift: 19; acquisition OpenAPI/conformance: 41; frontend acquisition checks: 57. The initial sandbox run was denied a local Express listener (`EPERM`); the identical local-only rerun with listener permission passed. |
| `pnpm test` | PASS | Contracts: 94 passing tests; frontend acquisition checks: 57. The initial sandbox run was denied tsx local IPC (`EPERM`); the identical local-only rerun with IPC/listener permission passed. |
| `pnpm build` | PASS | Contract type check, backend TypeScript build, and frontend Vite build passed; 119 modules transformed. |
| `git diff --check` | PASS | No whitespace errors. |

## Initial Task 4 warnings and skipped gates (historical)

- Vite emitted its existing warning that one minified chunk exceeds 500 kB;
  the build still passed.
- Docker/Compose rendering, image build, and running-container gates were not
  run in that pass because Docker was unavailable and the pass changed only
  documentation.
- That initial pass did not run a real browser, crawl, Douyin request, comment,
  direct message, CAPTCHA, QR-login flow, or live-provider acceptance. The
  later QR acceptance evidence is recorded in `docs/PROJECT_STATUS.md`; the
  final remediation below still triggered no crawl or external action.

## Initial Task 4 self-review (historical)

- The documentation uses current-state language and does not elevate archived
  plans or reports to execution authority.
- `docs/modules/acquisition.md` reconciles the existing Task 3 contract/UI
  wording rather than adding a parallel API description.
- That initial documentation-only pass changed no DTO, route, data model, or
  runtime behavior, so it required no contract generation or API-index edit.

## Final remediation verification

This evidence applies to code HEAD `72bb512` after the closed candidate-page
decoder, terminal-ingestion lifecycle remediation, legacy-generation
reconciliation, and MySQL task-presentation query repair. The documentation
edits that record those rules do not change runtime code.

| Command | Result | Evidence |
| --- | --- | --- |
| `./scripts/context-check` | PASS | `SHENSI_CONTEXT_OK` |
| Sidecar adapter pytest | PASS | 71 passed. |
| `pnpm test` | PASS | Contracts: 94 passed; backend, frontend, and Baota suites passed. |
| `pnpm check:acquisition-contracts` | PASS | Contract drift: 19 passed; security, OpenAPI/conformance (41), frontend, and Baota checks passed. |
| `pnpm build` | PASS | Contract/generated-type checks, backend TypeScript build, and frontend Vite build passed. |
| Focused crawler lifecycle | PASS | 103 passed; two live-MySQL tests skipped because `MYSQL_TEST_ADMIN_URL` is not configured. |
| Focused task presentation | PASS | 105 passed; one isolated live-MySQL fixture skipped. The configured local MySQL account and task-detail endpoints both returned 200. |
| Local acquisition page | PASS | Refreshed `http://127.0.0.1:5588/#acquisition`; the account was connected, no-API copy and save/run readiness were present, persisted task metrics loaded, obsolete required-search/account/overview/automation errors were absent, and no console error was observed. |
| Independent code inspection | PASS | The lifecycle/legacy code snapshot received GO, and the later `72bb512` SQL repair received no Critical, Important, or Minor finding. |
| Fresh `git diff --check` | PASS | The documentation-integrated diff is whitespace-clean. |

The focused crawler command was:

```sh
cd backend
NODE_ENV=test TZ=UTC node --import tsx --test --test-concurrency=1 \
  src/acquisition-crawler-job-mysql-repository-test.ts \
  src/acquisition-crawler-job-router-test.ts \
  src/acquisition-crawler-job-test.ts \
  src/acquisition-crawler-worker-test.ts \
  src/acquisition-douyin-crawler-ingestion-repository-test.ts \
  src/acquisition-douyin-crawler-ingestion-test.ts \
  src/acquisition-run-candidates-router-test.ts
```

The focused task-presentation command was:

```sh
cd backend
NODE_ENV=test TZ=UTC node --import tsx --test \
  src/acquisition-visual-reader-mysql-repository-test.ts \
  src/acquisition-run-presentation-test.ts \
  src/acquisition-task-overview-test.ts \
  src/acquisition-task-overview-router-test.ts
```

The build emitted only the existing Vite advisory for a minified chunk above
500 kB. Browser verification stayed on the local application; no Douyin/
iesdouyin navigation, crawl, comment, direct message, CAPTCHA, or other external
action was run. The existing configured local MySQL application was checked
through read-only API calls; the isolated `MYSQL_TEST_ADMIN_URL` fixture and
Docker gates were not run or inferred.

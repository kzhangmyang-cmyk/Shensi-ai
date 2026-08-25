# Douyin Visible Crawl Observation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a dedicated visible Douyin browser during local collection and publish a sanitized, persisted activity snapshot to the acquisition dashboard.

**Architecture:** The sidecar explicitly launches standard Playwright in the configured headless/visible mode, mirrors approved search/video navigation in that dedicated tab, and atomically persists a closed activity snapshot. The existing Node worker copies that snapshot through its fenced job repository into the public persisted crawler status; the frontend continues its existing polling and renders the activity without receiving live browser state.

**Tech Stack:** Python 3.11, FastAPI/Pydantic, Playwright, TypeScript/Node 22, Express, MySQL JSON persistence, OpenAPI-generated frontend types, React/Vite DOM self-tests.

**Spec:** `docs/superpowers/specs/2026-08-25-douyin-visible-crawl-observation-design.md`

## Global Constraints

- Do not start a real crawl or make a Douyin comment/direct-message action.
- Do not expose URLs, cookies, profiles, headers, selectors, CDP ports, WebSocket endpoints, or raw logs.
- Disable MediaCrawler CDP mode for Shensi collection and use only the dedicated Playwright context.
- `currentKeyword` is null or an exact member of the frozen approved keyword list.
- Every production behavior follows a witnessed failing test.
- Preserve the unrelated dirty-worktree changes already present.

---

### Task 1: Sidecar visible browser and sanitized activity

**Files:**
- Modify: `services/media-crawler/shensi_adapter/schemas.py`
- Modify: `services/media-crawler/shensi_adapter/crawl_jobs.py`
- Modify: `services/media-crawler/shensi_adapter/app.py`
- Test: `services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py`
- Test: `services/media-crawler/tests/shensi_adapter/test_contracts.py`

**Interfaces:**
- Produces: `CrawlActivity` with `phase`, `current_keyword`, `browser_mode`, and `sequence` in every `CrawlJobView`.
- Produces: `MediaCrawlerRunner(headless: bool)` and activity events consumed by `CrawlJobManager`.
- Consumes: `MEDIACRAWLER_BROWSER_HEADLESS`; the crawl subprocess explicitly sets `ENABLE_CDP_MODE=False`, `CDP_CONNECT_EXISTING=False`, `HEADLESS=headless`, and `CDP_HEADLESS=headless`.

- [ ] **Step 1: Write failing browser-configuration and observation-navigation tests**

```python
def test_execute_upstream_disables_cdp_and_applies_configured_visible_mode(...):
    # Execute against injected fake config/crawler boundaries.
    assert fake_config.ENABLE_CDP_MODE is False
    assert fake_config.CDP_CONNECT_EXISTING is False
    assert fake_config.HEADLESS is False

def test_visible_observer_navigates_only_to_approved_douyin_search_and_video(...):
    # A fake page records goto calls; no network is used.
    assert calls == [
        "https://www.douyin.com/search/%E8%A2%9C%E5%AD%90?type=general",
        "https://www.douyin.com/video/73001",
    ]
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
uv run --frozen --project services/media-crawler pytest -q \
  services/media-crawler/tests/shensi_adapter/test_crawl_jobs.py \
  services/media-crawler/tests/shensi_adapter/test_contracts.py
```

Expected: failures because crawl activity and explicit standard-browser configuration do not exist.

- [ ] **Step 3: Add the minimal sidecar implementation**

```python
class CrawlActivity(BaseModel):
    phase: Literal["queued", "starting_browser", "opening_douyin",
                   "searching", "collecting_comments", "finalizing", "completed"]
    current_keyword: str | None
    browser_mode: Literal["visible", "headless"]
    sequence: int

class CrawlJobView(BaseModel):
    # existing fields...
    activity: CrawlActivity
```

The runner writes only this snapshot, the manager validates the keyword
against `request.keywords`, increments the persisted sequence, and the visible
observer wraps search/comment calls without changing their returned data.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS with no external requests.

### Task 2: Fenced Node activity persistence and private gateway

**Files:**
- Modify: `backend/src/acquisition-crawler-job.ts`
- Modify: `backend/src/acquisition-crawler-job-repository.ts`
- Modify: `backend/src/acquisition-crawler-job-mysql-repository.ts`
- Modify: `backend/src/acquisition-mediacrawler-gateway.ts`
- Modify: `backend/src/acquisition-crawler-worker.ts`
- Test: `backend/src/acquisition-crawler-job-test.ts`
- Test: `backend/src/acquisition-crawler-job-mysql-repository-test.ts`
- Test: `backend/src/acquisition-mediacrawler-gateway-test.ts`
- Test: `backend/src/acquisition-crawler-worker-test.ts`

**Interfaces:**
- Consumes: private sidecar `activity` in snake_case.
- Produces: `AcquisitionCrawlerActivity` in camelCase.
- Produces: `updateActivity(fence, { activity, now })`, with monotonic sequence and frozen-keyword validation.

- [ ] **Step 1: Write failing gateway, Memory/MySQL repository, and worker tests**

```ts
await repository.updateActivity(fence, {
  activity: {
    phase: "searching", currentKeyword: "袜子",
    browserMode: "visible", sequence: 2
  },
  now
});
assert.equal((await repository.findByRun("workspace-1", "run-1"))
  ?.activity.currentKeyword, "袜子");
```

Tests also prove that a lower sequence, a same-sequence conflict, a non-frozen
keyword, and private extra gateway fields are rejected, and that the worker
persists activity while `pageCount` is zero.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-mediacrawler-gateway-test.ts \
  src/acquisition-crawler-worker-test.ts \
  src/acquisition-crawler-job-test.ts \
  src/acquisition-crawler-job-mysql-repository-test.ts
```

Expected: compile/test failures for the missing activity contract and repository method.

- [ ] **Step 3: Implement the domain, repository, gateway, and worker path**

```ts
export interface AcquisitionCrawlerActivity {
  phase: "queued" | "starting_browser" | "opening_douyin" | "searching"
    | "collecting_comments" | "finalizing" | "completed";
  currentKeyword: string | null;
  browserMode: "visible" | "headless";
  sequence: number;
}

updateActivity(
  fence: AcquisitionCrawlerJobFence,
  input: { activity: AcquisitionCrawlerActivity; now: string }
): Promise<AcquisitionCrawlerJob>;
```

Memory and MySQL store the snapshot in the existing job JSON. MySQL hydration
adds the safe default for old rows; no table column or destructive migration is
required. The worker persists the snapshot immediately after every validated
sidecar status read.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

### Task 3: Public contract and real-time dashboard

**Files:**
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-crawler-job-router-test.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`
- Modify: `backend/src/acquisition-openapi-response-conformance-test.ts`
- Regenerate: `frontend/src/generated/ai-acquisition.ts`
- Modify: `frontend/src/acquisition/douyin-automation-view.ts`
- Modify: `frontend/src/acquisition/douyin-automation-view.self-test.ts`
- Modify: `frontend/src/acquisition/douyin-automation-controller.ts`
- Modify: `frontend/src/acquisition/douyin-automation-controller.self-test.ts`
- Modify: `frontend/src/replica-dashboard.css`

**Interfaces:**
- Produces: required `activity` on `AcquisitionCrawlerStatus`.
- Consumes: generated `components["schemas"]["AcquisitionCrawlerStatus"]`; no handwritten transport DTO.

- [ ] **Step 1: Write failing closed-contract and UI behavior tests**

```ts
assert.deepEqual(status.activity, {
  phase: "collecting_comments",
  currentKeyword: "袜子",
  browserMode: "visible",
  sequence: 4
});
assert.match(host.textContent ?? "", /可视窗口已打开/u);
assert.match(host.textContent ?? "", /正在采集评论/u);
assert.match(host.textContent ?? "", /当前关键词：袜子/u);
```

The controller test proves that a non-terminal crawler status keeps the
save-and-run action disabled after the first poll.

- [ ] **Step 2: Run contract/frontend tests and verify RED**

```bash
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 \
  src/acquisition-crawler-job-router-test.ts \
  src/acquisition-openapi-test.ts \
  src/acquisition-openapi-response-conformance-test.ts
pnpm --filter ./frontend test
```

Expected: failures because `activity` is absent and the UI has no observation status.

- [ ] **Step 3: Implement and generate the public DTO**

```yaml
activity:
  type: object
  additionalProperties: false
  required: [phase, currentKeyword, browserMode, sequence]
```

Run `pnpm generate:frontend-contract-types`, then render translated phases,
browser mode, current keyword, attempt/update time, and `candidateBudgetUsed /
candidateBudgetLimit`. Remove the misleading completion percentage and do not
render a raw URL or private browser identifier.

- [ ] **Step 4: Run the tests and verify GREEN**

Run the commands from Step 2 plus:

```bash
pnpm check:generated-acquisition-types
pnpm --filter ./frontend build
```

Expected: PASS.

### Task 4: Current documentation and verification gates

**Files:**
- Modify: `README.md`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/modules/acquisition.md`
- Modify: `docs/DEPLOYMENT.md`

**Interfaces:**
- Documents: local visible-window behavior, observation-mirror semantics,
  headless production behavior, and the closed safe progress contract.

- [ ] **Step 1: Update current execution documents**

Describe the current behavior directly. Do not add a top-of-file revision
note or make archived plans the execution authority.

- [ ] **Step 2: Run focused and aggregate verification**

```bash
./scripts/context-check
pnpm check:acquisition-contracts
pnpm test
pnpm build
git diff --check
```

Expected: all available deterministic gates pass. Docker/live Douyin gates
remain outside this change and must be reported as not run, not treated as
successful.


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

## Handoff from Task 2 and UI audit

- Starting HEAD is `ffe0405`; `crawlerStatus()` now produces the required
  sanitized camel-case `activity`. Do not expose the internal
  `activityObserved` sentinel.
- Extend the canonical YAML, the backend runtime OpenAPI mirror, and the
  response fixtures together. Regenerate the frontend type with
  `pnpm generate:frontend-contract-types`; never hand-edit the generated DTO.
- `frontend/src/acquisition/douyin-automation-api.ts` is an allowed direct
  consumer addition to the file list: its runtime status validator must
  validate the required closed activity shape instead of casting a malformed
  response to the generated type.
- Phase labels: `queued` 排队中, `starting_browser` 正在启动浏览器,
  `opening_douyin` 正在打开抖音, `searching` 正在搜索,
  `collecting_comments` 正在采集评论, `finalizing` 正在整理候选人,
  `completed` 采集完成. Visible mode says `可视窗口已打开`; headless says
  `后台浏览器运行中`.
- The status card must show attempt, localized update time, current keyword
  (or a safe waiting label), and `candidateBudgetUsed / candidateBudgetLimit`
  as a candidate allowance. It must not show a completion percentage, URL, or
  private browser identifier.
- Disablement must exist in both the rendered control and the controller
  command path: if `crawlerStatus.state` is non-terminal, Enter/direct method
  invocation must not create another run. A locally submitted run that has no
  first poll result yet should render a queued/waiting observation placeholder.
- Do not add reload recovery or a new latest-run endpoint in this task; that
  requires a separate public API decision. Do not run a real browser or
  contact Douyin.

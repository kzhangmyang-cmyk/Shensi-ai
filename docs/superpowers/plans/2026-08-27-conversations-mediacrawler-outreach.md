# 社媒对话 MediaCrawler 受控外联实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让真实社媒对话页面能够从公开候选证据创建、恢复和审批单候选外联批次，并由 MediaCrawler 在用户二次确认后真实执行一次可验证的抖音评论，再按既有顺序执行私信。

**Architecture:** Node 后端继续作为批次、审批、额度、幂等和动作 outbox 的唯一权威；新增候选范围的批次发现 GET，使页面刷新后能恢复当前批次和回执。前端组合现有 `OutreachBatchController` 和审批视图，不提供绕过审批的直接发送。MediaCrawler 扩展把测试专用选择器替换为有序、唯一、可见的真实页面控件定位，并在可见浏览器中等待用户手动完成平台验证，绝不自动破解滑块或 CAPTCHA。

**Tech Stack:** TypeScript 5、Node.js、Express、MySQL 8、OpenAPI 3.0、Vite、原生 DOM 控制器、Playwright、Python 3.11、FastAPI、pytest。

**Spec:** `docs/superpowers/specs/2026-08-27-conversations-mediacrawler-outreach-design.md`

## Global Constraints

- 只支持抖音；其他平台不在本计划范围内。
- 真实评论和私信只能由当前批次的精确冻结文案产生，最终审批必须携带当前 revision、batchHash、ETag、CSRF 和 `confirm: true`。
- 评论目标必须是无 query/hash 的 `https://www.douyin.com/video/{id}`；私信目标必须是无 query/hash 的 `https://www.douyin.com/user/{id}`。
- 评论先执行；只有评论成功且最短 180 秒间隔满足后，私信才可领取。
- 自动测试和发布验收不得向真实抖音账号提交评论或私信。
- 滑块、CAPTCHA、登录验证和风控只能由用户在可见浏览器中手动完成；代码不得自动识别、破解、注入令牌或调用打码服务。
- 页面保持现有黑色、灰色和绿色设计变量，不新增另一套主题。
- MediaCrawler 上游出处、授权引用和 Shensi 扩展边界必须保留；不得把评论执行描述为上游原生能力。
- 当前工作树已有其他获客改动；每次提交只暂存本任务明确列出的文件，不得覆盖或回滚无关修改。

---

### Task 1: 候选范围的批次发现仓储与服务

**Files:**
- Modify: `backend/src/acquisition-outreach-batch-repository.ts`
- Modify: `backend/src/acquisition-outreach-batch-mysql-repository.ts`
- Modify: `backend/src/acquisition-outreach-batch-service.ts`
- Modify: `backend/src/acquisition-outreach-batch-test.ts`
- Modify: `backend/src/acquisition-outreach-batch-mysql-repository-test.ts`
- Modify: `backend/schema.mysql.sql`
- Modify: `backend/goodjob_crm.full.sql`

**Interfaces:**
- Consumes: `AcquisitionOutreachBatch`,当前 head revision、既有 `remaining()` 额度计算。
- Produces:

```ts
export interface OutreachBatchListAnchor {
  createdAt: string;
  batchId: string;
}

export interface OutreachBatchRepositoryPage {
  items: AcquisitionOutreachBatch[];
  next: OutreachBatchListAnchor | null;
}

listByRunCandidate(input: {
  workspaceId: string;
  runId: string;
  candidateId: string;
  limit: number;
  after: OutreachBatchListAnchor | null;
}): Promise<OutreachBatchRepositoryPage>;
```

- [ ] **Step 1: 写内存仓储和服务 RED 测试**

在 `acquisition-outreach-batch-test.ts` 新增两个 `node:test` 用例。第一个在两个 workspace、两个 run、两个 candidate 中创建多批次及一个新修订，然后断言只返回当前 workspace/run/candidate 的 head，按 `createdAt DESC, id DESC` 排列且 keyset 第二页无重复。第二个断言服务重新计算 `dailyRemainingLimit`，并通过 `publicOutreachBatch` 删除 `evidenceText`、`publicActorKey`、`publicProfileUrl`、`commentTargetPublicUrl`。

```ts
const firstPage = await repository.listByRunCandidate({
  workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-1",
  limit: 1, after: null
});
assert.equal(firstPage.items.length, 1);
assert.ok(firstPage.next);
const secondPage = await repository.listByRunCandidate({
  workspaceId: "workspace-1", runId: "run-1", candidateId: "candidate-1",
  limit: 1, after: firstPage.next
});
assert.notEqual(secondPage.items[0]?.id, firstPage.items[0]?.id);
assert.equal((publicPage.items[0]?.candidates[0] as Record<string, unknown>).evidenceText, undefined);
```

- [ ] **Step 2: 运行聚焦测试并确认 RED**

Run:

```bash
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 src/acquisition-outreach-batch-test.ts
```

Expected: FAIL，因为 `listByRunCandidate` 尚不存在。

- [ ] **Step 3: 实现内存仓储和服务的最小 GREEN**

内存仓储只读取每个批次数组的 `.at(-1)`，筛选当前候选仍存在于 head 的批次，稳定反序并读取 `limit + 1`。服务验证 `runId`、`candidateId`、limit 和 anchor，逐批次调用 `remaining()` 后再调用 `publicOutreachBatch()`。

```ts
async listByRunCandidate(scope: OutreachScope, input: {
  runId: string; candidateId: string; limit: number;
  after: OutreachBatchListAnchor | null;
}) {
  const page = await this.repository.listByRunCandidate({
    workspaceId: scope.workspaceId, ...input
  });
  return {
    items: await Promise.all(page.items.map(async (batch) => publicOutreachBatch({
      ...batch,
      dailyRemainingLimit: await this.repository.remaining(
        batch.workspaceId, batch.accountId, batch.localDate, batch.dailyCandidateLimit
      )
    }))),
    next: page.next
  };
}
```

- [ ] **Step 4: 写 MySQL RED 测试**

在 `acquisition-outreach-batch-mysql-repository-test.ts` 断言两个 DDL 镜像和运行时 DDL 都包含：

```sql
KEY ix_acquisition_outreach_batch_run_page
  (workspace_id,run_id,created_at,id,revision)
KEY ix_acquisition_outreach_candidate_page
  (workspace_id,candidate_id,batch_id,batch_revision)
```

再用记录 SQL 的 fake pool 断言查询包含 workspace/run/candidate、当前 head `NOT EXISTS`、keyset 条件、反序和 `LIMIT limit+1`。隔离 MySQL 用例断言跨页每个 current head 只出现一次。

- [ ] **Step 5: 运行 MySQL 聚焦测试并确认 RED**

Run:

```bash
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 src/acquisition-outreach-batch-mysql-repository-test.ts
```

Expected: FAIL，因为索引、迁移检查和查询尚不存在。

- [ ] **Step 6: 实现 MySQL 查询、索引和现有库迁移**

查询固定为 `created_at DESC, id DESC`，cursor 条件为 `created_at < ? OR (created_at = ? AND id < ?)`。`ensureAcquisitionOutreachBatchMysqlSchema` 读取 `information_schema.statistics` 并只对缺失的精确索引执行白名单 `ALTER TABLE ... ADD KEY`；同步两个 SQL 镜像。

- [ ] **Step 7: 运行 Task 1 测试并确认 GREEN**

Run:

```bash
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 src/acquisition-outreach-batch-test.ts src/acquisition-outreach-batch-mysql-repository-test.ts
```

Expected: PASS；没有真实 MySQL 环境时现有 live MySQL 用例只能显示其声明的 skip。

- [ ] **Step 8: 提交 Task 1**

```bash
git add backend/src/acquisition-outreach-batch-repository.ts backend/src/acquisition-outreach-batch-mysql-repository.ts backend/src/acquisition-outreach-batch-service.ts backend/src/acquisition-outreach-batch-test.ts backend/src/acquisition-outreach-batch-mysql-repository-test.ts backend/schema.mysql.sql backend/goodjob_crm.full.sql
git commit -m "feat(acquisition): discover candidate outreach batches"
```

---

### Task 2: 批次发现 HTTP/OpenAPI 合同与前端客户端

**Files:**
- Modify: `backend/src/acquisition-outreach-batch-router.ts`
- Modify: `backend/src/acquisition-outreach-batch-router-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `backend/src/acquisition-openapi.ts`
- Modify: `backend/src/acquisition-openapi-test.ts`
- Modify: `backend/src/acquisition-openapi-response-conformance-test.ts`
- Modify: `backend/src/acquisition-openapi-contract-drift-test.ts`
- Modify: `contracts/openapi/ai-acquisition.v1.yaml`
- Modify: `contracts/test/openapi.test.mjs`
- Generate: `frontend/src/generated/ai-acquisition.ts`
- Modify: `frontend/src/acquisition/outreach-batch-api.ts`
- Modify: `frontend/src/acquisition/outreach-batch-api.self-test.ts`

**Interfaces:**
- Consumes: Task 1 `listByRunCandidate()`。
- Produces: `GET /api/v1/acquisition/outreach-batches?runId&candidateId&limit&cursor` 和 `OutreachBatchApi.listBatches()`。

- [ ] **Step 1: 写 router RED 测试**

给 router test harness 注入 `cursorSecret: "outreach-batch-router-test-secret-at-least-32-bytes"` 和 service mock `listByRunCandidate()`。新增断言：runId/candidateId 必填，limit 默认 20 且范围 1–100；需要 `acquisition.outreach.approve`；正常响应不含私有 authority；篡改或跨筛选器复用 cursor 返回 `400 invalid_cursor`。

```ts
const page = await appRequest({
  method: "GET",
  path: "/api/v1/acquisition/outreach-batches?runId=run-1&candidateId=candidate-1&limit=1"
});
assert.equal(page.response.status, 200);
assert.equal(Array.isArray(page.json.items), true);
assert.equal(typeof page.json.nextCursor, "string");
```

- [ ] **Step 2: 运行 router 测试并确认 RED**

```bash
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 src/acquisition-outreach-batch-router-test.ts
```

Expected: FAIL，collection GET 尚未注册。

- [ ] **Step 3: 实现严格查询、HMAC cursor 和路由**

cursor 载荷固定为：

```ts
type CursorPayload = {
  v: 1; workspaceId: string; runId: string; candidateId: string;
  createdAt: string; batchId: string;
};
```

编码使用 `base64url(JSON).base64url(HMAC-SHA256)` 和 `timingSafeEqual`；绑定 workspace/run/candidate。`acquisition-application.ts` 注入 `derivedSecret(masterSecret, "outreach-batch-list-cursor")`。GET 不要求 CSRF 或幂等键。

- [ ] **Step 4: 写 OpenAPI 与漂移 RED 测试**

把 operationId 集合增加 `listAcquisitionOutreachBatches`，断言四个 query 参数、`AcquisitionOutreachBatchList` 的 `{items,nextCursor}`、cookie/bearer security 和私有字段不可见。合同路径增加：

```yaml
/api/v1/acquisition/outreach-batches:
  get:
    operationId: listAcquisitionOutreachBatches
```

- [ ] **Step 5: 运行合同测试并确认 RED**

```bash
pnpm --filter ./backend test:acquisition-openapi
pnpm --filter ./backend test:contract-drift
pnpm test:contracts
```

Expected: 至少一个命令 FAIL，因为 YAML、运行时 OpenAPI 与 operation map 尚未同步。

- [ ] **Step 6: 实现并生成合同类型**

同步 `acquisition-openapi.ts` 和 YAML，然后运行生成器，禁止手改生成文件：

```bash
pnpm generate:frontend-contract-types
pnpm check:generated-acquisition-types
```

- [ ] **Step 7: 写前端 API RED 测试**

```ts
await api.listBatches("run/1", "candidate/1", 1, "cursor/value", signal);
assert.equal(calls[0]?.url,
  "/api/v1/acquisition/outreach-batches?runId=run%2F1&candidateId=candidate%2F1&limit=1&cursor=cursor%2Fvalue");
assert.equal(calls[0]?.init?.method, "GET");
assert.equal(calls[0]?.init?.body, undefined);
assert.equal(new Headers(calls[0]?.init?.headers).has("x-csrf-token"), false);
```

另断言 malformed `items`、`nextCursor` 或批次 shape 返回 `malformed_response`。

- [ ] **Step 8: 实现 `OutreachBatchApi.listBatches` 并跑 GREEN**

```ts
listBatches(runId, candidateId, limit = 1, cursor = null, signal) {
  const query = new URLSearchParams({ runId, candidateId, limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  return request(`/api/v1/acquisition/outreach-batches?${query}`, {
    method: "GET", signal
  }, listShape);
}
```

Run:

```bash
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 src/acquisition-outreach-batch-router-test.ts
pnpm --filter ./backend test:acquisition-openapi
pnpm --filter ./backend test:contract-drift
pnpm test:contracts
pnpm --filter ./frontend exec tsx src/acquisition/outreach-batch-api.self-test.ts
```

Expected: PASS。

- [ ] **Step 9: 提交 Task 2**

```bash
git add backend/src/acquisition-outreach-batch-router.ts backend/src/acquisition-outreach-batch-router-test.ts backend/src/acquisition-application.ts backend/src/acquisition-openapi.ts backend/src/acquisition-openapi-test.ts backend/src/acquisition-openapi-response-conformance-test.ts backend/src/acquisition-openapi-contract-drift-test.ts contracts/openapi/ai-acquisition.v1.yaml contracts/test/openapi.test.mjs frontend/src/generated/ai-acquisition.ts frontend/src/acquisition/outreach-batch-api.ts frontend/src/acquisition/outreach-batch-api.self-test.ts
git commit -m "feat(api): list candidate outreach batches"
```

---

### Task 3: 社媒对话完整审批工作台

**Files:**
- Create: `frontend/src/acquisition/outreach-batch-selection.ts`
- Create: `frontend/src/acquisition/outreach-batch-selection.self-test.ts`
- Modify: `frontend/src/self-test.ts`
- Modify: `frontend/src/acquisition/outreach-batch-view.ts`
- Modify: `frontend/src/acquisition/outreach-batch-view.self-test.ts`
- Modify: `frontend/src/acquisition/douyin-automation-api.ts`
- Modify: `frontend/src/acquisition/douyin-automation-api.self-test.ts`
- Modify: `frontend/src/acquisition/douyin-automation-controller.ts`
- Modify: `frontend/src/acquisition/douyin-automation-view.ts`
- Modify: `frontend/src/acquisition/runtime.ts`
- Modify: `frontend/src/conversations/real-api.ts`
- Modify: `frontend/src/conversations/real-api.self-test.ts`
- Modify: `frontend/src/conversations/real-controller.ts`
- Modify: `frontend/src/conversations/real-controller.self-test.ts`
- Modify: `frontend/src/conversations/real-view.ts`
- Modify: `frontend/src/conversations/real-view.self-test.ts`
- Modify: `frontend/src/conversations/real-entry.self-test.ts`
- Modify: `frontend/src/replica-dashboard.css`

**Interfaces:**
- Consumes: Task 2 `listBatches()`，既有 `createOutreachBatchController()`、`renderOutreachBatchView()`。
- Produces: 选择一条真实互动→创建单候选批次→编辑→保存→二次确认→审批→轮询回执，刷新后从服务器恢复。

- [ ] **Step 1: 写共享 selection store 和稳定事件委托 RED 测试**

selection store 精确接口：

```ts
export const LAST_OUTREACH_BATCH_KEY = "shensi:acquisition:last-outreach-batch";
export interface OutreachBatchSelectionStore {
  read(): string | null;
  remember(batchId: string): void;
  clear(): void;
  subscribe(listener: (batchId: string | null) => void): () => void;
}
```

测试 storage 抛错时 fail closed、空 ID 不写、remember/clear 广播。`outreach-batch-view.self-test.ts` 新增重建 child `innerHTML` 后，稳定根节点仍能代理 textarea input、复核 checkbox 和 save/approve click 的测试。

- [ ] **Step 2: 运行两个聚焦测试并确认 RED**

```bash
pnpm --filter ./frontend exec tsx src/acquisition/outreach-batch-selection.self-test.ts
pnpm --filter ./frontend exec tsx src/acquisition/outreach-batch-view.self-test.ts
```

Expected: FAIL，selection 模块和 `bindOutreachBatchActions()` 尚不存在。

- [ ] **Step 3: 实现共享 selection store 和事件 binder**

`bindOutreachBatchActions(eventRoot, controller)` 只绑定 input/change/click，不 subscribe、不 render；`mountOutreachBatchView()` 继续负责 subscribe/render 并复用 binder。`runtime.ts` 删除本地 storage key，改用 store 的 read/remember/clear/subscribe。

- [ ] **Step 4: 写 eligibility 和真实互动投影 RED 测试**

把 eligibility helper 移到 `douyin-automation-api.ts`：

```ts
export function isDouyinCommentOutreachCandidate(
  candidate: Pick<DouyinRunCandidate, "evidence">
): boolean;
```

测试 exact video 为 true，profile/query/hash/http/其他 host 为 false。`RealPublicInteraction` 增加 `outreachEligible`，profile-only 仍显示但不可创建。

- [ ] **Step 5: 运行 API/投影测试并确认 RED，再实现 GREEN**

```bash
pnpm --filter ./frontend exec tsx src/acquisition/douyin-automation-api.self-test.ts
pnpm --filter ./frontend exec tsx src/conversations/real-api.self-test.ts
```

Expected RED 后，实现共享 helper 和投影；再运行同命令取得 PASS。

- [ ] **Step 6: 写 controller/view RED 测试**

状态增加：

```ts
export interface RealConversationsViewState {
  status: "loading" | "ready" | "error";
  snapshot: RealConversationsSnapshot | null;
  selectedInteractionKey: string | null;
  outreach: OutreachBatchState;
  error: string | null;
}
```

controller options 增加 `outreachApi`、`outreachPollDelayMs` 和 `batchSelection`。测试断言：

```ts
await controller.open();
await controller.createOutreachForSelected();
assert.deepEqual(createCalls, [{ runId: "run-1", candidateIds: ["candidate-1"] }]);
assert.equal(selection.read(), "batch-1");
assert.match(main.innerHTML, /精确公开评论/);
assert.doesNotMatch(main.innerHTML, /发送不可用|平台回复（未接入）/);
```

另测 profile-only 不调用 create、`listBatches(..., limit=1)` 恢复最新批次、selection 不匹配不伪造候选归属、deactivate 中止轮询、destroy 清理委托。

view 测试覆盖 eligible CTA、profile disabled、loading、完整编辑器、复核 checkbox、approved receipts、XSS escaping 和 inspector 的“非官方 inbox”说明。

- [ ] **Step 7: 运行 controller/view 测试并确认 RED**

```bash
pnpm --filter ./frontend exec tsx src/conversations/real-controller.self-test.ts
pnpm --filter ./frontend exec tsx src/conversations/real-view.self-test.ts
```

Expected: FAIL，当前仍渲染只读 composer。

- [ ] **Step 8: 实现真实会话组合控制器和视图**

稳定 `main` 只绑定一次 `bindOutreachBatchActions`。每次 render 先重建主 HTML，再把纯批次视图渲染到 fresh nested host：

```ts
main.innerHTML = renderMain(state);
const host = main.querySelector<HTMLElement>("[data-real-conversations-outreach-host]");
if (host) renderOutreachBatchView(host, state.outreach);
inspector.innerHTML = renderInspector(state);
```

选择候选时先 `listBatches(runId,candidateId,1,null)`，有结果就 `outreachController.load(id)`；没有才显示创建按钮。创建永远只传当前一个 `candidateId`。恢复动作回执继续使用现有 `listActions` 轮询。

- [ ] **Step 9: 补响应式样式并运行前端 GREEN**

只新增 conversation CTA/disabled/loading/focus-visible 和 `.real-conversations .outreach-workspace { margin-top: 0; }`；复用所有现有颜色变量。

```bash
pnpm --filter ./frontend test
pnpm --filter ./frontend test:types
pnpm --filter ./frontend build
```

Expected: PASS。

- [ ] **Step 10: 提交 Task 3**

```bash
git add frontend/src/acquisition/outreach-batch-selection.ts frontend/src/acquisition/outreach-batch-selection.self-test.ts frontend/src/self-test.ts frontend/src/acquisition/outreach-batch-view.ts frontend/src/acquisition/outreach-batch-view.self-test.ts frontend/src/acquisition/douyin-automation-api.ts frontend/src/acquisition/douyin-automation-api.self-test.ts frontend/src/acquisition/douyin-automation-controller.ts frontend/src/acquisition/douyin-automation-view.ts frontend/src/acquisition/runtime.ts frontend/src/conversations/real-api.ts frontend/src/conversations/real-api.self-test.ts frontend/src/conversations/real-controller.ts frontend/src/conversations/real-controller.self-test.ts frontend/src/conversations/real-view.ts frontend/src/conversations/real-view.self-test.ts frontend/src/conversations/real-entry.self-test.ts frontend/src/replica-dashboard.css
git commit -m "feat(conversations): add controlled Douyin outreach"
```

---

### Task 4: MediaCrawler 真实评论控件与可验证回执

**Files:**
- Create: `services/media-crawler/shensi_adapter/douyin_action_controls.py`
- Create: `services/media-crawler/tests/shensi_adapter/test_douyin_action_controls.py`
- Modify: `services/media-crawler/shensi_adapter/douyin_actions.py`
- Modify: `services/media-crawler/tests/shensi_adapter/test_actions.py`

**Interfaces:**
- Consumes: caller-owned authenticated Playwright page 和 `ActionRequest`。
- Produces:

```py
class ActionControls(NamedTuple):
    composer: object
    submit: object

def detect_page_failure(page: object) -> str | None: ...
def locate_action_controls(page: object, kind: str) -> ActionControls: ...
def find_visible_receipt(page: object, request: ActionRequest) -> str | None: ...
```

- [ ] **Step 1: 写真实结构定位 RED 测试**

FakePage 必须支持 CSS candidates、`get_by_role`/exact text、unique visible count、fill 后 value 回读和 click 计数。测试不提供任何 `data-e2e` 控件，只提供如下真实结构模拟：

```html
<div class="comment-editor" contenteditable="true" aria-label="留下你的评论"></div>
<button type="button">发送</button>
<div class="comment-item" data-comment-id="comment-123">冻结的批准文本</div>
```

断言精确文案填入、回读相等、提交只点击一次、回执为 `douyin-comment:comment-123`。另测多个 composer、多个 submit、不可见控件和非精确回执文本全部 fail closed 且 clicks 为空。

- [ ] **Step 2: 运行控件测试并确认 RED**

```bash
cd services/media-crawler && uv run pytest -q tests/shensi_adapter/test_douyin_action_controls.py tests/shensi_adapter/test_actions.py
```

Expected: FAIL，新模块和真实定位尚不存在。

- [ ] **Step 3: 实现有序唯一定位与真实回执**

真实候选优先顺序固定且有界：

```py
COMMENT_COMPOSERS = (
    '[contenteditable="true"][aria-label*="评论"]',
    '[contenteditable="true"][data-placeholder*="评论"]',
    'textarea[placeholder*="评论"]',
)
COMMENT_SUBMITS = (
    'button:has-text("发送")',
    '[role="button"]:has-text("发送")',
)
```

每一优先级只有“恰好一个可见匹配”才能采用；同一级多匹配立即返回 `douyin_action_control_ambiguous`。评论提交前使用 `input_value()` 或 `text_content()` 回读精确冻结文案。提交后只在评论项候选内查找 exact content；优先读取 allowlist 属性 `data-comment-id`/`data-cid`，缺少平台 ID 时返回 `douyin-visible-comment:<sha256(actionId,target,content)>`，但前提是页面中恰好一个非编辑器评论项精确出现该文案。

测试专用 `data-e2e` 可保留为最后 fixture fallback，但真实路径测试必须证明不依赖它。

- [ ] **Step 4: 把 executor 切到新控件模块并扩充闭合错误码**

新增 `douyin_action_control_ambiguous`、`douyin_action_content_mismatch`、`douyin_action_receipt_ambiguous` 到 Python schema、Node gateway schema 和 worker closed failure set；不把页面文字或完整文案写入错误。

- [ ] **Step 5: 运行 sidecar GREEN**

```bash
cd services/media-crawler && uv run pytest -q tests/shensi_adapter/test_douyin_action_controls.py tests/shensi_adapter/test_actions.py tests/shensi_adapter/test_app.py
```

Expected: PASS，测试只操作 FakePage/FastAPI fixture，不访问抖音。

- [ ] **Step 6: 提交 Task 4**

```bash
git add services/media-crawler/shensi_adapter/douyin_action_controls.py services/media-crawler/shensi_adapter/douyin_actions.py services/media-crawler/shensi_adapter/schemas.py services/media-crawler/tests/shensi_adapter/test_douyin_action_controls.py services/media-crawler/tests/shensi_adapter/test_actions.py backend/src/acquisition-mediacrawler-gateway.ts backend/src/acquisition-outreach-action-worker.ts backend/src/acquisition-mediacrawler-gateway-test.ts backend/src/acquisition-outreach-action-worker-test.ts
git commit -m "feat(mediacrawler): execute verifiable Douyin comments"
```

---

### Task 5: 可见浏览器人工验证等待与同动作恢复

**Files:**
- Modify: `services/media-crawler/shensi_adapter/douyin_actions.py`
- Modify: `services/media-crawler/shensi_adapter/browser_state.py`
- Modify: `services/media-crawler/shensi_adapter/app.py`
- Modify: `services/media-crawler/tests/shensi_adapter/test_actions.py`
- Modify: `services/media-crawler/tests/shensi_adapter/test_browser_state.py`
- Modify: `backend/src/acquisition-mediacrawler-gateway.ts`
- Modify: `backend/src/acquisition-mediacrawler-gateway-test.ts`
- Modify: `backend/src/acquisition-outreach-action-worker.ts`
- Modify: `backend/src/acquisition-outreach-action-worker-test.ts`
- Modify: `backend/src/acquisition-application.ts`
- Modify: `scripts/real-trial-config.mjs`
- Modify: `scripts/real-trial-config.test.mjs`

**Interfaces:**
- Consumes: Task 4 page failure detection。
- Produces: 同一次、同一 action ID 的可见人工验证窗口；验证消失后重新校验目标和控件并继续，绝不重复点击。

- [ ] **Step 1: 写人工验证 RED 测试**

FakePage 初始显示 verification，第一次 wait 后移除 verification 并出现评论控件。断言：

```py
receipt = DouyinActionExecutor(
    now=clock.now, verification_poll_ms=1
).execute(page, request(deadline_at=clock.now() + timedelta(seconds=5)))
assert page.brought_to_front == 1
assert page.verification_bypass_calls == []
assert page.clicks == [comment_submit]
assert receipt.state == "succeeded"
```

另一用例让 verification 保持到 deadline，断言 `douyin_verification_required`、fills/clicks 均为空。第三个用例让验证消失后目标 URL 变化，断言 `action_rejected` 且不点击。

- [ ] **Step 2: 运行 RED**

```bash
cd services/media-crawler && uv run pytest -q tests/shensi_adapter/test_actions.py tests/shensi_adapter/test_browser_state.py
```

Expected: FAIL，executor 当前看到 verification 立即结束并关闭窗口。

- [ ] **Step 3: 实现有界人工等待**

verification 只执行：`page.bring_to_front()`、有界 poll、重新调用 `detect_page_failure()`。它不调用 OCR、drag、mouse、evaluate 注入、网络签名或第三方服务。只有 verification 消失且 URL/登录/控件重新验证成功后才允许 fill/click。

部署常量固定：

- `DOUYIN_ACTION_MANUAL_VERIFICATION_SECONDS` 默认 120，范围 30–300；
- Node action deadline = verification seconds + 30 秒；
- gateway action HTTP timeout = action deadline + 10 秒；
- browser IPC command timeout = action deadline + 20 秒；
- headless runtime 检测到 verification 立即返回失败，不进行等待。

- [ ] **Step 4: 写 Node timeout/worker RED 测试并实现配置**

gateway test 断言普通 health/crawl 仍使用 5 秒，而 `executeAction` 使用独立 `actionTimeoutMs`。worker test 断言 deadline 传入 sidecar 且 verification failure 会风险暂停、不会自动重新 claim 同一动作。trial config 必须在 visible runtime 设置 120 秒，默认生产配置仍可显式覆盖。

- [ ] **Step 5: 运行 Task 5 GREEN**

```bash
cd services/media-crawler && uv run pytest -q tests/shensi_adapter/test_actions.py tests/shensi_adapter/test_browser_state.py
cd ../../
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 src/acquisition-mediacrawler-gateway-test.ts src/acquisition-outreach-action-worker-test.ts
node --test scripts/real-trial-config.test.mjs
```

Expected: PASS；任何测试都不访问真实平台。

- [ ] **Step 6: 提交 Task 5**

```bash
git add services/media-crawler/shensi_adapter/douyin_actions.py services/media-crawler/shensi_adapter/browser_state.py services/media-crawler/shensi_adapter/app.py services/media-crawler/tests/shensi_adapter/test_actions.py services/media-crawler/tests/shensi_adapter/test_browser_state.py backend/src/acquisition-mediacrawler-gateway.ts backend/src/acquisition-mediacrawler-gateway-test.ts backend/src/acquisition-outreach-action-worker.ts backend/src/acquisition-outreach-action-worker-test.ts backend/src/acquisition-application.ts scripts/real-trial-config.mjs scripts/real-trial-config.test.mjs
git commit -m "feat(mediacrawler): allow manual verification handoff"
```

---

### Task 6: 无外部写 E2E、当前文档和部署验收

**Files:**
- Modify: `frontend/tests/fixtures/douyin-mediacrawler-http-fixture.ts`
- Modify: `frontend/tests/douyin-mediacrawler-acquisition.spec.ts`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/modules/acquisition.md`
- Modify: `docs/operations/real-customer-trial.md`
- Modify: `docs/API_INDEX.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `frontend/README.md`

**Interfaces:**
- Consumes: Tasks 1–5 的完整页面、API 和 sidecar 行为。
- Produces: 可重放的无外部写浏览器验收、最新开发/部署文档。

- [ ] **Step 1: 写 E2E RED**

fixture overview 在 run 启动后返回真实 `latestRun`；batch create 记录精确单候选 IDs；GET collection 返回最近 batch；approve fixture 产生 comment→DM receipts。Playwright 用例执行：登录→采集→导航社媒对话→选择 exact video→创建→编辑→保存→勾选→审批 fixture→看到评论/私信回执→reload→恢复同一批次。另测 profile-only CTA disabled。

该 fixture 的 approve 只操作内存 HTTP fixture，不调用 sidecar 或抖音。

- [ ] **Step 2: 运行 E2E 并确认 RED**

```bash
pnpm --filter ./frontend exec playwright test --config=playwright.config.ts tests/douyin-mediacrawler-acquisition.spec.ts --project=chromium
```

Expected: FAIL，因为 conversations 尚未在 fixture 中形成完整审批恢复闭环。

- [ ] **Step 3: 实现 fixture 与 E2E GREEN**

不得降低现有 acquisition 测试断言；新增用例独立 reset 状态，不能依赖测试顺序。

- [ ] **Step 4: 同步当前文档**

正文直接描述当前真实规则：`#conversations` 是公开证据外联工作台而非官方 inbox；两个页面共用批次权威；刷新按 run+candidate 恢复；最终审批才发送；MediaCrawler 评论执行是 Shensi 扩展；验证只允许手动完成。删除“回复框永久禁用”“只能凭已知 batchId”“本页不会创建批次”等过期正文。

- [ ] **Step 5: 运行完整验证**

```bash
pnpm check:acquisition-contracts
pnpm --filter ./backend test:acquisition
pnpm --filter ./backend test:acquisition-outreach-actions
pnpm --filter ./frontend test
pnpm --filter ./frontend test:types
pnpm --filter ./frontend build
cd services/media-crawler && uv run pytest -q tests/shensi_adapter
```

Expected: 全部 exit 0；MySQL live tests 只有在显式隔离测试数据库配置存在时运行，否则按现有声明 skip。

- [ ] **Step 6: 提交 Task 6**

```bash
git add frontend/tests/fixtures/douyin-mediacrawler-http-fixture.ts frontend/tests/douyin-mediacrawler-acquisition.spec.ts docs/PROJECT_STATUS.md docs/modules/acquisition.md docs/operations/real-customer-trial.md docs/API_INDEX.md docs/ARCHITECTURE.md frontend/README.md
git commit -m "test(acquisition): verify conversation outreach flow"
```

---

### Task 7: 发布与一次真实评论验收

**Files:**
- No production code changes unless verification exposes a reproducible defect; any fix restarts the relevant RED/GREEN task.
- Runtime artifacts: trial state under the existing private trial runtime directories only。

**Interfaces:**
- Consumes: 全部自动验证通过的同一 Git revision。
- Produces: 新临时访问地址，以及一次由用户最终确认的真实评论平台回执。

- [ ] **Step 1: 发布前只读审计**

确认没有 pending/executing actions，记录已批准批次数量和当前 action gate；不得批准旧批次，不得修改历史动作。确认 backend、frontend 和 sidecar 将使用同一 revision，且 visible browser 开启。

- [ ] **Step 2: 发布并执行无外部写验证**

```bash
pnpm trial:publish
pnpm trial:status
pnpm trial:verify
```

验证登录、候选读取、单候选批次创建、编辑、保存、刷新恢复和二次确认门禁；停在最终审批之前。

- [ ] **Step 3: 向用户展示真实验收内容**

页面明确展示：目标视频 URL、候选公开证据、精确评论文案、精确私信文案、当日剩余额度和动作顺序。用户可修改并保存新修订。

- [ ] **Step 4: 用户亲自完成最终二次确认**

只有用户在页面勾选“我已逐条核对”并点击“确认审批并排队”才产生外部动作。Codex 不代替用户点击。若抖音显示滑块/CAPTCHA，用户在可见窗口手动完成；代码只等待并复检。

- [ ] **Step 5: 验证真实评论且阻止重复提交**

同时核对：抖音视频页出现精确评论；Shensi action 状态为 `succeeded`；`platformReceiptReference` 非空；attemptCount 符合一次受控执行；同 action ID 重放只读取已保存回执，不再次点击。私信仍遵守评论成功后至少 180 秒的前置条件。

- [ ] **Step 6: 最终状态与文档核对**

运行：

```bash
git diff --check
pnpm trial:status
```

报告真实评论的安全回执引用和时间，不回显完整 Cookie、账号句柄、私信正文或内部 service secret。

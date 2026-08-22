# AI 增长参谋集成、视觉回归与发布验收计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 验证 AI 增长参谋从任务输入到计划审批、真实运行、候选投影、作战卡和 CRM 跟进的完整链路，并保证演示模式安全、视觉稳定、契约无回归。

**Architecture:** Playwright 使用独立 spec 和可控 backend fixtures；真实模式测试 production API contract，演示模式通过网络审计证明零外部/零写入。视觉回归使用固定数据、相同视口和明确参考图对照，不把截图本身当作 QA。

**Tech Stack:** Playwright、Node test runner、Vite preview/dev server、现有 backend test harness。

## Global Constraints

- 使用现有 `frontend/playwright.config.ts` 的 Chrome project 和本地 backend/frontend webServer。
- demo 网络断言必须证明零外部搜索、零审核/转换/待办写入。
- real E2E 必须消费生产契约，不用宽松 Mock 或自由文本替代。
- 所有视觉状态使用固定数据和相同视口；截图后必须做同输入对照检查。
- 目标视口固定为 1440×900、1366×768、1024×768。
- 不以 `overflow-x:hidden` 掩盖布局问题。
- 不自动部署、推送或发布；只提交本地分支变更。
- 完成声明前必须跑 contracts、backend、frontend、E2E、build 和 `git diff --check`。

---

## Task 1: 建立 E2E Fixture 和网络审计

**Files:**

- Create: `frontend/tests/ai-growth-advisor.spec.ts`
- Create: `frontend/tests/fixtures/ai-growth.ts`

**Interfaces:**

- Consumes: 已发布的 OpenAPI DTO 和前端 `ai-growth` feature 网络路径。
- Produces: 可控真实模式 response fixture 与 request log，供 Task 2/Task 3 使用。

### 1.1 实现可控真实模式 Fixture

- [ ] Fixture 提供严格 DTO：
  - Copilot session/task with `planDraft`
  - plan create/approval/run
  - paged presentation responses
  - candidate/evidence/qualification/financial/battle-card
  - candidate review、convert，以及带 Idempotency-Key replay/conflict 的 todo
- [ ] Fixture 的 presentation 第一页 `hasMore=true`，第二页追平，第三次轮询出现 candidate 更新，以验证 cursor 增量。
- [ ] 使用 request log 记录 method/path/body/headers。

### 1.2 实现演示网络审计

- [ ] 在 demo test 中监听所有 request，断言从开始演示到完成期间不存在：
  - 搜索/获客计划运行 API
  - `/convert`
  - candidate 人工 review decision 写接口
  - `POST /api/todos`
  - 外部 http(s) 搜索 Provider
- [ ] 允许页面初始化已有认证/静态资源请求，但必须把 allowlist 写死在测试中。

### 1.3 提交

```bash
git add frontend/tests/fixtures/ai-growth.ts \
  frontend/tests/ai-growth-advisor.spec.ts
git commit -m "test: add AI growth advisor fixtures"
```

---

## Task 2: 覆盖三分钟核心旅程和失败恢复

**Files:**

- Modify: `frontend/tests/ai-growth-advisor.spec.ts`

**Interfaces:**

- Consumes: Task 1 fixture、前端状态机、后端三个可信契约。
- Produces: 三分钟旅程、真实写入顺序和错误恢复的端到端证据。

### 2.1 演示模式旅程

- [ ] 验证：
  - 登录后首屏标题。
  - 企业服务模板填充。
  - 生成计划、等待批准。
  - 未批准不进入执行。
  - 批准后候选逐步进入。
  - pause/resume。
  - jump to result。
  - 老板摘要多币种/待评估。
  - 作战卡 fact/inference/unknown。
  - 后续动作仅预览。
  - demo→real 清空 demo 数据。

### 2.2 真实模式旅程

- [ ] 验证请求：
  - message body 明确 `responseMode:"plan_draft"`。
  - plan create body 与 task.planDraft 一致。
  - approve 带正确 `If-Match`。
  - presentation 使用 `nextAfter`，candidateId upsert 不重复。
  - 成功搜索返回的候选已经由后端 `qualify_candidate` 生成资格与财务决定；单候选评估失败显示 partial success/待评估，不伪造金额。
  - terminal 且 `hasMore=false` 后停止轮询。
- [ ] 点击无作战卡客户：
  - 不出现 direct battle-card POST。
  - Copilot task 调用后重新 GET card。
- [ ] 点击无资格决定客户：
  - qualification 404 只显示“待资格评估”，不阻断 candidate/evidence 抽屉。
  - 点击评估后 Copilot task 的 `toolNames` 包含 `qualify_candidate`。
  - 成功后重新读取 qualification 与 financial-value。
- [ ] 候选人工复核与外联动作审核：
  - pending_review 时先在“候选资格人工复核”面板分别覆盖 approved、rejected、do_not_contact、needs_research；请求必须带 qualification 的 current decisionVersion 与人工 reason。
  - approved 响应后 candidate 主列表立即更新，且 `approvedDecisionVersion === latestDecisionVersion`。
  - 只有 approved 后才显示“创建外联动作审核任务”，通过 Copilot assistant task 调用 `create_review_task` 并验证 `toolNames`。
  - 不把人工 decision `/review` 请求伪装成创建任务。
- [ ] “转为线索并创建跟进任务”：
  - pending-review candidate 只显示人工审核入口，不能直接转换。
  - approved candidate 才允许开始转换。
  - 先 convert。
  - 成功后 POST `/api/todos`，负责人为当前用户，`Idempotency-Key` 由 conversion.id 稳定派生。
  - 模拟服务端已创建但客户端丢失响应；第二步显示“已转换、待办创建状态待确认”，只重试待办、不重复转换，并复用完全相同的 key。
  - 重放返回同一 todo id、`Idempotency-Replayed:true`，列表中没有重复待办。
- [ ] 作战卡抽屉验证 Escape 关闭、Tab 焦点锁定、关闭后焦点恢复和 body scroll lock；这些行为不放在无 DOM 的 unit tests。

### 2.3 错误恢复

- [ ] 覆盖：
  - `SEARCH_PROVIDER_CONNECTION_REQUIRED`
  - partial provider failure
  - ETag conflict 后重新加载
  - empty
  - model failure
  - cursor tamper/error
  - network retry/backoff
  - pause/resume/cancel

### 2.4 运行并提交

- [ ] 运行：

```bash
npm run test:e2e --workspace frontend -- ai-growth-advisor.spec.ts
```

- [ ] 提交：

```bash
git add frontend/tests/ai-growth-advisor.spec.ts
git commit -m "test: cover AI growth advisor journeys"
```

---

## Task 3: 做可复查的视觉回归

**Files:**

- Create: `frontend/tests/ai-growth-advisor.visual.spec.ts`
- Create: `docs/audits/ai-growth-demo/after/README.md`
- Create: generated screenshots under `docs/audits/ai-growth-demo/after/`

**Interfaces:**

- Consumes: Task 1 固定 Fixture、Task 2 已验证交互、既有 before screenshots。
- Produces: 六种页面状态 × 三个视口的回归测试与审计截图索引。

### 3.1 固定视觉状态

- [ ] 用同一演示 Fixture 固定以下状态：
  - 初始首屏
  - 计划待确认
  - 运行中
  - 作战卡打开
  - 任务完成
  - AI 配置页

### 3.2 视口矩阵

- [ ] 每个状态覆盖：
  - 1440×900
  - 1366×768
  - 1024×768
- [ ] 自动断言：
  - `document.documentElement.scrollWidth <= clientWidth`
  - 主 CTA 可见
  - 计划表单没有被压成窄条
  - drawer 不超出视口
  - AI 配置表单输入/按钮可操作

### 3.3 人工组合对照

- [ ] 使用已存在的改造前截图：
  - `docs/audits/ai-growth-demo/01-login.png`
  - `02-dashboard.png`
  - `03-auto-acquisition.png`
  - `04-ai-config.png`
- [ ] 对每个目标视口，把参考图和新截图放入同一视觉比较输入，记录：
  - 间距
  - 字体层级
  - 边框/圆角
  - 内容裁切
  - 横向溢出
  - 抽屉与焦点状态
- [ ] 修复可见偏差后重新截图，不把第一次截图当完成。
- [ ] `after/README.md` 记录每张截图的状态、视口、数据模式和通过结论。

### 3.4 运行并提交

- [ ] 运行：

```bash
npm run test:e2e --workspace frontend -- ai-growth-advisor.visual.spec.ts
```

- [ ] 提交：

```bash
git add frontend/tests/ai-growth-advisor.visual.spec.ts \
  docs/audits/ai-growth-demo/after
git commit -m "test: verify AI growth advisor visuals"
```

---

## Task 4: 全量回归、安全断言与文档

**Files:**

- Modify: `README.md`
- Create: `docs/ai-growth-advisor.md`
- Modify: `docs/superpowers/specs/2026-07-26-ai-growth-advisor-demo-design.md` only to mark implementation status, without rewriting approved requirements

**Interfaces:**

- Consumes: 三个子计划的代码、测试和截图结果。
- Produces: 运维/测试手册、spec 实现状态和最终发布门禁记录。

### 4.1 文档真实/演示模式

- [ ] `docs/ai-growth-advisor.md` 写清：
  - 三个可信后端契约。
  - real mode 所需模型与搜索连接。
  - demo mode 数据来源和零写入边界。
  - 状态机和恢复方式。
  - 作战卡受控生成路径。
  - 运行 presentation 指标口径。
  - 本地测试命令。

### 4.2 全量验证

- [ ] 依次运行：

```bash
npm run test:contracts
npm run test:acquisition --workspace backend
npm run test --workspace backend
npm run test --workspace frontend
npm run test:e2e --workspace frontend
npm run build
git diff --check
```

- [ ] 搜索禁止路径，确认 feature 没有 direct domain write：

```bash
rg -n 'POST.*battle-card|candidates/.*/battle-card.*POST' \
  frontend/src/features/ai-growth frontend/tests
```

- [ ] 搜索前端运行归属猜测，确认没有全局候选回退：

```bash
rg -n 'createdAt.*run|run.*createdAt|/api/v1/acquisition/candidates\\?' \
  frontend/src/features/ai-growth
```

- [ ] 搜索演示网络依赖：

```bash
rg -n 'fetch\\(|XMLHttpRequest|request\\(' \
  frontend/src/features/ai-growth/demo
```

### 4.3 最终实现状态

- [ ] 将批准 spec 状态追加为“已实现，验收命令与截图见 docs/ai-growth-advisor.md”，不改设计决策。
- [ ] 提交：

```bash
git add README.md \
  docs/ai-growth-advisor.md \
  docs/superpowers/specs/2026-07-26-ai-growth-advisor-demo-design.md
git commit -m "docs: hand off AI growth advisor"
```

## 最终验收清单

- [ ] 老板无需讲解即可看懂 AI 正在找客户。
- [ ] 90 秒内演示完整流程。
- [ ] demo 明确标注且零外部搜索/零正式写入。
- [ ] real 只显示真实 Provider 和后端状态。
- [ ] planDraft 不解析自由文本。
- [ ] candidate 与 run 有权威关联。
- [ ] financial 与 current qualification 版本一致。
- [ ] 多币种不相加。
- [ ] 作战卡事实、推测、未知清楚区分。
- [ ] 1024px 无阻断布局。
- [ ] 键盘、焦点、live status、reduced motion 通过。
- [ ] contracts、backend、frontend、E2E、build、diff check 全绿。

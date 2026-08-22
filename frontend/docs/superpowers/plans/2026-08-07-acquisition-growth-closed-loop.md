# AI 获客闭环（阶段 1–3）实施计划

> 执行范围：只实现用户确认的 1、2、3。第 4 阶段仅保留扩展位，不新增未确认功能。

**目标：** 在当前 `5189` 新版前端上打通“AI 一句话生成抖音获客方案 → 人工批准候选并交接 CRM/私域 → 跟进结果回流渠道 ROI 和 AI 老板简报”的真实闭环。

**总体原则：** AI 负责计划、判断和解释；可信连接、预算、审批、客户交接和经营指标由后端校验并持久化。前端不得重构或伪造服务端生成的计划快照、AI 等级或财务价值。所有高风险动作保留人工确认，暂不实现平台自动私信、自动加好友或自动群发。

**代码库：**

- 新前端：`/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend`
- 后端：`/Users/mac/Documents/外贸/GoodJob-1.09`
- 不触碰用户已有修改：新前端 `pnpm-workspace.yaml`；后端旧版 `frontend/src/features/ai-growth/**` 及现有未跟踪方案文档。

---

## Task 1：AI 增长参谋生成完整抖音获客方案

**前端文件：**

- 新增：`src/acquisition/plan-draft-workflow.ts`
- 新增：`src/acquisition/plan-draft-workflow.self-test.ts`
- 新增：`src/acquisition/plan-draft-view.ts`
- 新增：`src/acquisition/plan-draft-view.self-test.ts`
- 修改：`src/acquisition/task-creation-api.ts`
- 修改：`src/acquisition/task-creation-api.self-test.ts`
- 修改：`src/acquisition/task-creation-controller.ts`
- 修改：`src/acquisition/task-creation-controller.self-test.ts`
- 修改：`index.html`
- 修改：`src/replica-dashboard.css`
- 修改：`src/self-test.ts`
- 修改或新增相应 Playwright 测试

### 步骤

1. 先写失败测试，固定 Copilot 会话、`plan_draft` 任务创建、轮询、取消、超时和错误恢复协议。
2. 给 `task-creation-api.ts` 增加类型安全的 Copilot session/task API；严格校验任务结果，不接受客户端提供 `modelSnapshotRef`。
3. 实现轮询工作流：复用会话、稳定幂等键、指数退避、120 秒超时、`AbortSignal`；仅把 session/task/model/prompt 元数据写入 `sessionStorage`，不保存 API Key 和计划正文。
4. 写失败测试，固定计划预览必须完整展示 ICP 五组信息、所有搜索连接、组织/个人双通道、全部查询、逐项预算、总预算和停止条件，并对文本做 HTML 转义。
5. 实现完整计划预览组件，内部始终保存服务端原始完整草稿；不得把多连接、多查询压扁成当前手工表单。
6. 将创建任务弹窗拆为“AI 生成 / 手动创建”两种模式，默认 AI：一句自然语言 → 生成/重新生成 → 完整预览 → 勾选批准 → 创建并运行。
7. AI 模式修改模型、搜索连接或语义目标时使旧草稿失效；关闭、切换或重新生成时取消旧轮询。手动模式保持现有行为和校验。
8. 复用现有 `createPlan → approvePlan → createRun` 工作流，提交服务端完整草稿。
9. 跑单测、端到端测试和构建；验证一条自然语言能产生包含至少两个 provider、四个 query 的完整请求体。

---

## Task 2：候选交接 CRM / 私域并创建首次跟进待办

**后端文件：**

- 新增：`backend/src/acquisition-private-domain-handoff.ts`
- 新增：`backend/src/acquisition-private-domain-handoff-test.ts`
- 修改：`backend/src/acquisition-lead-conversion-port.ts`
- 修改：`backend/src/acquisition-v1-router.ts`
- 修改：`backend/src/acquisition-openapi.ts`
- 修改：`backend/src/acquisition-application.ts`
- 修改：`backend/src/types.ts`
- 修改：`backend/src/store.ts`
- 修改：`backend/src/mysql-store.ts`
- 修改：`backend/src/server.ts`

**前端文件：**

- 修改：`src/acquisition/detail-center-api.ts`
- 修改：`src/acquisition/detail-center-api.self-test.ts`
- 修改：`src/acquisition/detail-center-controller.ts`
- 修改：`src/acquisition/detail-center-controller.self-test.ts`
- 修改：`src/acquisition/detail-center-view.ts`
- 修改：`src/acquisition/detail-center-view.self-test.ts`
- 新增：`src/private-domain/runtime-api.ts`
- 新增：`src/private-domain/runtime-api.self-test.ts`
- 新增：`src/private-domain/controller.ts`
- 新增：`src/private-domain/controller.self-test.ts`
- 新增：`src/private-domain/view.ts`
- 新增：`src/private-domain/view.self-test.ts`
- 修改：`src/replica-dashboard.ts`
- 修改：`src/demo/demo-app.ts`
- 修改：`src/self-test.ts`

### 步骤

1. 先写后端失败测试，覆盖：未批准/过期决策/硬门禁拒绝、租户隔离、创建新客户、关联已有客户、S 级映射、CNY/外币金额、不可伪造 AI 快照、幂等重放/冲突、失败恢复和首次 Todo 关联。
2. 增加 `AcquisitionCustomerHandoff` 持久化模型，并把候选转换时的资格评分和财务价值以服务端不可变快照写入 Lead 来源载荷。
3. 实现 `POST /api/v1/acquisition/candidates/:id/private-domain-handoffs`：支持 `create_new` 与 `link_existing`；创建或恢复 Lead、Customer、CustomerActivity、首次 Todo 和 handoff 记录。
4. 实现 `GET /api/v1/acquisition/candidates/:id/private-domain-handoff`，用于刷新后恢复完整交接状态。
5. 幂等键必填；同键同体重放、同键异体 409、不同键重复提交也不得生成第二套 Customer/Todo。MySQL 下使用事务或等价可恢复阶段记录。
6. 更新 OpenAPI 和存储适配，运行后端目标测试。
7. 先写前端失败测试，覆盖批准状态 CTA、交接模式/跟进时间、CSRF 与幂等头、失败保留、刷新恢复、成功资源链接、输入转义和旧请求竞态。
8. 在新版候选详情中加入“交接至 CRM/私域”；`approved` 可交接，已有 Lead 但未完成时可继续，完成后显示 Lead/Customer/Todo 和首次跟进时间。
9. 新建真实私域运行时模块，用真实客户/活动/待办接口替换当前演示数据；仅在显式 demo 模式保留演示页。
10. 跑前后端单测、端到端测试和构建，验证批准候选只产生一个 Lead、一个 Customer 和一个关联 Todo。

---

## Task 3：CRM 结果回流、渠道 ROI 与 AI 老板简报

**后端文件（以现有 Outcome 能力为准增量修改）：**

- 新增：`backend/src/acquisition-crm-outcome-reconciliation.ts`
- 新增：`backend/src/acquisition-crm-outcome-reconciliation-test.ts`
- 新增：`backend/src/acquisition-performance-query.ts`
- 新增：`backend/src/acquisition-performance-query-test.ts`
- 新增：`backend/src/acquisition-performance-router.ts`
- 新增：`backend/src/acquisition-performance-router-test.ts`
- 修改：`backend/src/acquisition-v1-router.ts`
- 修改：`backend/src/acquisition-openapi.ts`
- 修改：`backend/src/acquisition-application.ts`
- 修改：`backend/src/acquisition-pi-tools.ts`
- 修改：`backend/src/acquisition-tool-executor.ts`
- 修改：`backend/src/types.ts`
- 修改：`backend/src/store.ts`
- 修改：`backend/src/mysql-store.ts`

**前端文件：**

- 新增或修改：真实经营/ROI API、controller、view 及 self-tests
- 修改：AI 增长参谋首页与快捷入口
- 修改：`src/replica-dashboard.ts`
- 修改：`src/self-test.ts`
- 修改或新增相应 Playwright 测试

### 步骤

1. 固化转换归因：交接时校验候选确实来自当前 `runId` 的 `candidate.discovered`，并把 run/plan/provider/operation/decision/evidence 快照写入 Lead 来源；不得把 Copilot sessionId 当获客 runId。
2. 先写失败测试，固定 CRM 结果只能由后端根据持久化 `LeadActivity`、`DealEvent` 对账生成 Outcome；浏览器继续禁止直接 POST Outcome。
3. 实现可恢复、至少一次的对账器，幂等映射 `contacted`、`quoted`、`won`、`lost`。现有 payment 仅是销售记录且未经财务核销，禁止映射为 `payment_received`。
4. 实现只读 `GET /api/v1/acquisition/performance`，按租户、时间窗（最长 90 天）、平台和候选去重聚合发现、高意向、批准、转 CRM、联系、报价、成交与丢单；所有金额按币种分别呈现，分母为零的 rate 返回 `null`。
5. 第一版不得伪造完整渠道 ROI：当前执行预算只能标为“已记录 API/执行成本”，成交金额只能标为“成交合同额”。缺少完整渠道成本、财务核销或服务成本时，返回 `roi.status = not_computable` 和明确原因，不展示虚假毛利/实际回款。
6. 增加确定性的老板简报事实层：漏斗变化、分币种合同额、数据质量、主要风险和建议动作，每条引用 metricId。Pi 只通过只读工具解释事实，不得改写数值或补造缺失财务数据；模型失败时事实层仍可用。
7. 新版前端将经营结果区与 AI 增长参谋接入真实 API；支持时间范围/平台筛选、刷新、空/加载/错误状态。真实请求失败绝不回退为演示数字。
8. 增加“生成今日经营简报”和“查看证据”动作；所有外部文本转义，简报明确区分事实、AI 解读和数据缺口。
9. 跑后端口径测试、OpenAPI 安全回归、前端单测、端到端测试和构建；验证获客来源可一路追溯到联系、报价和成交合同额，且全过程浏览器没有 POST Outcome。

---

## 收尾：总体验收与交付（不是新增产品第 4 项）

1. 运行新前端 `pnpm test`、`pnpm build`、相关 Playwright 测试。
2. 运行后端本次新增测试、获客核心回归测试及构建/类型检查。
3. 人工走通：一句话计划 → 计划批准运行 → 候选审批 → CRM/私域交接 → 首次待办 → 成交/回款回流 → ROI → AI 老板简报。
4. 确认 `http://127.0.0.1:5189/#acquisition` 仍使用新版 UI；不切回旧版前端。
5. 检查 Git diff，只提交本次范围文件，不包含用户原有修改。
6. 第 4 产品阶段仅保留技术扩展点，不实现任何尚未由用户确定的功能。

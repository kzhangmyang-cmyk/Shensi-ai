# 财务多智能体委员会与最佳行动组合总实施索引

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已批准的财务多智能体委员会设计实现成一套可追溯、可重放、受人工审批约束的财务分析与行动组合系统。

**Architecture:** 复用现有 `business-advisor` 确定性公式、Growth sealed-read、官方模型网关、Advisor 建议/动作分发与 MySQL 事务模式。五个专业角色在同一冻结快照上独立生成结构化提案，确定性校验与一次定向反驳形成审计结果，CFO 只合成已验证事实，确定性 branch-and-bound 优化器输出三套组合，最后由人工修订、重优化、批准并派发草案或待办。

**Tech Stack:** TypeScript、Express、MySQL 8、Zod、JSON Schema 2020-12、OpenAPI 3.1、现有 Model Gateway、Node test runner、Vite、vanilla controller/view、Playwright。

**当前状态：** P1–P5 实现和本地发布验证已完成。Growth contract 固定为 `1.0.10`（`sha256:dcbbc8e43c0ba43cd8e628cb49bd43f8f1a77810d3f864c83e11f4ac2fa0aee3`）；Memory vertical 覆盖完整报表、五专家、同角色 `risk_preference`、恰好一次 rebuttal、三组合、revision 2、approve、draft receipt 与无权威投影变更，前端 fixture E2E 10/10。真实 InnoDB 矩阵 83/83 与无 route-intercept Chromium 纵向 E2E 1/1 已通过；浏览器链路使用隔离 MySQL 库、真实 session/CSRF、Growth 路由、异步工作器与派发回执，模型输出使用确定性 test-only adapter。

## Global Constraints

- Backend repository: `/Users/mac/Documents/新项目/GoodJob-growth`，branch `codex/growth-advisor-quote-roi`。
- Standalone frontend: `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend`，必须保留用户已有 `pnpm-workspace.yaml` 与 `debug-agents.mts` 变更；不要改 package lock。
- Approved design: `docs/superpowers/specs/2026-08-16-financial-multi-agent-council-design.md`。
- 第一版数据只来自请求中冻结的财务报表，以及当前工作区已有 CRM、报价、回款/财务事实、成本和 ROI 权威读模型；不接银行、税务局、外部 ERP 或新数据商。
- 所有专家读取同一个 `FinancialSnapshot`；不得在分析、反驳或 CFO 合成阶段重新读取“最新数据”。
- 金额只用安全整数 minor，比例只用整数 BPS，时间使用 UTC ISO 字符串；不得以浮点数作为优化器权威输入。
- 模型只解释、提出假设和闭合动作种类；公式值、影响情景、硬约束结果、排名和审批状态均由服务端确定性代码产生。
- 每个模型调用使用现有官方连接快照、内容哈希、调用账本和超时；不新增第二套模型 SDK 或多智能体框架。
- 五个专家没有写工具；审计、CFO 和优化器也没有业务写权限。
- 冲突只允许一轮定向反驳。关键冲突未解决时，相关动作不得进入组合。
- 单次候选动作上限 24。相同快照、策略版本和候选集合必须得到字节级一致的三套组合及淘汰原因。
- 保守情景现金储备、到期债务、必要支出、合规、权限、数据完整性、预算、容量、前置和互斥始终是不可关闭的硬约束。
- 人工编辑创建新 portfolio revision 并完整重优化；旧 revision 立即失效且不可批准。
- 批准后只能创建预算草案、受控待办、数据补全方案或后续审批任务；不得自动记账、核销、付款、收款、报价、签约、开票、报税或外联。
- 所有仓储必须通过同一 memory/MySQL 行为套件；MySQL 线上矩阵在 `MYSQL_TEST_ADMIN_URL` 可用时为发布必跑项。
- 每个任务遵循 RED → GREEN → focused verification → independent review → scoped commit；不得用扩大 schema、宽松解析或跳过断言让测试变绿。
- 任何接口、数据结构、交互或模块职责变化，都同步当前 README、OpenAPI、生成类型和进度文档。

## Plan Set

1. [合同、领域骨架与冻结快照](./2026-08-16-financial-council-contracts-snapshot.md)
2. [五专家、确定性校验与一次反驳](./2026-08-16-financial-council-specialists-audit.md)
3. [CFO 合成、策略版本与确定性组合优化](./2026-08-16-financial-council-optimizer.md)
4. [人工修订、批准与受控草案派发](./2026-08-16-financial-council-approval-dispatch.md)
5. [前端、纵向验收与双仓发布](./2026-08-16-financial-council-frontend-release.md)

## Dependency DAG

```text
P1 Contract + domain + immutable snapshot + run repository
 |
 +--> P2 Formula catalog + five specialists + validation + one rebuttal
       |
       +--> P3 Consensus + policy versions + exact optimizer
             |
             +--> P4 Revision/edit/approve + stale check + draft outbox
                   |
                   +--> P5 Frontend + E2E + real MySQL + release
```

`P1` 的公开合同冻结后，`P2` 的模型输出结构和 `P5` 的生成类型可以并行实现；其余按 DAG 顺序执行。P5 实现、真实 MySQL 和无 route-intercept 浏览器门禁均已完成。

## Public HTTP Surface

所有写路由复用 `GrowthCommandContextFactory`、一个物理 `Idempotency-Key`、`executeGrowthIdempotentCommand` 和需要时的 `If-Match`：

```text
POST /api/v1/finance/council-runs
GET  /api/v1/finance/council-runs/{runId}
GET  /api/v1/finance/council-runs/{runId}/events
GET  /api/v1/finance/council-policy
PUT  /api/v1/finance/council-policy
POST /api/v1/finance/council-runs/{runId}/portfolio-revisions
POST /api/v1/finance/council-runs/{runId}/portfolio-revisions/{revision}/approve
POST /api/v1/finance/council-runs/{runId}/reject
GET  /api/v1/finance/council-runs/{runId}/dispatches
```

创建运行返回 `202` 和可轮询的运行投影。运行内部异步推进，不能把五次模型调用绑在一个 HTTP 请求生命周期内。

策略读取只在 workspace 无任何版本时物化一次服务端默认 `financial-council-policy.v1`。策略写入使用 workspace-scoped `If-Match` 和幂等键追加不可变新版本；旧运行引用的策略 ID 不会被改写。平衡权重严格合计 10,000 BPS，`cash_first` / `growth_first` 转换和全部硬约束种类都在代码中固定，不暴露可关闭开关。

## Ordered Exit Gates

### P1 Exit

- [x] 公开 schema、OpenAPI、运行领域和 snapshot hash 已冻结。
- [x] 同一请求的所有权威读取只 seal 一次并复用一个 cutoff。
- [x] snapshot 与 run memory/MySQL parity 全绿，跨租户与 open-shape fail closed。真实 InnoDB 用例在 `MYSQL_TEST_ADMIN_URL` 未配置时保持唯一条件跳过，不虚构 live 结果。

### P2 Exit

- [x] 五专家各自持久一个闭合结果并引用同一 snapshot ID/hash；符合闭合部分角色策略时以脱敏 gap 取代缺席结果。
- [x] 模型金额与未声明证据不能进入 finding/action。
- [x] 冲突图可重放，每名专家最多一次反驳，未解决冲突保留在 disposition 的 blocking set 中供 P3 组合过滤。

### P3 Exit

- [x] CFO 报告保留少数意见、拒绝项、未解决冲突与数据缺口；模型不可用时使用确定性服务端模板。
- [x] exact branch-and-bound 在至少 200 个 seeded 小规模案例中与 exhaustive oracle 完全一致。
- [x] 平衡、现金优先、增长优先三套 revision 1 绑定全部不可变输入并可恢复发布；无非空可行集仍返回三个空组合与完整 blocker，关键输入失效则 `not_computable`。

### P4 Exit

- [x] 任何编辑都会创建新 revision 并重新计算依赖、约束和得分。
- [x] 旧 revision、stale snapshot、权限不足与重复批准均无法派发。
- [x] 每个已批动作至多产生一个受控草案/待办/审批任务，恢复不重复副作用。

### P5 Exit

- [x] 前端 fixture 展示专家结论、冲突、统一判断、三组合、淘汰原因、敏感性、revision 和派发回执。
- [x] fixture Playwright 10/10 覆盖三视口、键盘、错误态和轮询恢复；后端 Memory vertical 2/2 通过。
- [x] `1.0.10` 合同/生成类型、backend/frontend build 和 diff check 已重新执行并通过。
- [x] 真实 InnoDB 行为矩阵 83/83 通过，包含真实双连接并发、恢复、审批、派发与策略版本持久化。
- [x] 无 route-intercept Chromium E2E 1/1 通过，使用真实后端、session/CSRF、隔离 MySQL 库和公开 API 轮询。
- [x] 双仓本地发布验收已有 fresh 通过证据；模型供应商调用不在该确定性纵向门禁中。

## Final Verification

```bash
cd /Users/mac/Documents/新项目/GoodJob-growth
npm run test:business-advisor --workspace backend
npm run test:financial-council --workspace backend
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" npm run test:financial-council:mysql --workspace backend
npm run test:growth-advisor --workspace backend
npm run test:growth-finance:mysql --workspace backend
npm run test:growth-quotes --workspace backend
npm run check:growth-contracts
npm run test:contracts
npm run build
git diff --check

cd /Users/mac/Documents/外贸/GoodJob-marketing-system-frontend
pnpm run contract:check
pnpm run test:growth:fixture
pnpm run test:types
pnpm test
pnpm run test:e2e -- growth-financial-council.spec.ts
pnpm build
git diff --check
```

## Execution Protocol

1. 每个实现 worker 只领取一个任务，不跨计划顺手改下一层。
2. RED 必须是目标行为失败，不接受纯语法错误、错误 fixture 或故意缺环境变量。
3. 每个任务只提交 `Files` 清单和必要的当前 README/状态文档。
4. 独立 reviewer 重点检查：同快照、金额/BPS、租户隔离、提示注入、模型输出越权、冲突轮次、优化器正确性、stale revision、审批边界、幂等/租约/恢复。
5. Important/Critical finding 回到原任务新增反例并修复，直到 reviewer 批准。
6. 条件性 live-MySQL skip 必须明确记录；发布环境不得把缺少 MySQL 证据写成通过。
7. 最终完成提交必须更新设计状态、主 README、模块 README 和当前进度入口。

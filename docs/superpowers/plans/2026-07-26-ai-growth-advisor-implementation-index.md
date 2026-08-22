# AI 增长参谋实施计划总索引

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement these plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已批准的“AI 全网获客指挥中心”设计落地为一个可信、可演示、可真实运行的 AI 增长参谋首页，同时保持现有 V1 契约向后兼容。

**Architecture:** 后端先提供三个可信展示契约：结构化计划草稿、运行展示投影、当前财务价值。前端在独立 `ai-growth` feature 中把真实模式与确定性演示模式适配为同一 ViewModel。最后用端到端、视觉回归和全量构建验证三分钟演示链路。

**Tech Stack:** Node.js 22、TypeScript、Express、Zod、Pi Agent、MySQL/In-memory repositories、Vite、原生 DOM 组件、Playwright。

## Global Constraints

- 只增加已批准的三个向后兼容展示契约，不破坏既有 V1 字段语义。
- 不新增搜索 Provider 或模型 Provider。
- 不实现自动加好友、自动私信、自动评论或自动群发。
- 演示模式必须标注“演示数据”，总时长为 45–90 秒，不调用外部搜索或正式写入接口。
- 真实模式状态只能由后端任务、运行、分片和投影驱动，不能用计时器伪造。
- 真实模式只使用当前用户已启用的官方连接和客户自填 API Key。
- 未持久化的财务价值显示“待评估”，不同币种不得相加。
- 1440×900、1366×768、1024×768 均不得出现横向溢出。
- 不采集或展示私密、敏感个人信息。

---

## 实施顺序

1. [后端可信展示契约](./2026-07-26-ai-growth-advisor-backend-contracts.md)
2. [前端 AI 增长参谋体验](./2026-07-26-ai-growth-advisor-frontend-experience.md)
3. [集成、视觉回归与发布验收](./2026-07-26-ai-growth-advisor-integration-qa.md)

后端计划中的契约与 OpenAPI 是前端真实模式的阻塞依赖。前端的演示模式、组件与 ViewModel 可以在后端开发期间并行，但真实模式联调必须等待后端契约通过。

## 并行边界

| 工作流 | 可并行内容 | 不可越界内容 |
|---|---|---|
| 后端 | 计划草稿、运行投影、财务读取、OpenAPI | 不修改前端视觉与页面状态 |
| 前端 | 演示 runner、ViewModel、页面组件、响应式 | 不从自由文本猜计划，不从时间猜运行候选 |
| QA | Fixture、E2E 脚本、视口矩阵 | 不用测试 Mock 掩盖真实契约缺失 |

## 共同完成标准

- 登录后默认进入“AI 增长参谋”。
- 演示模式 45–90 秒完成计划、执行、候选、作战卡和老板摘要，并明确标注“演示数据”。
- 演示模式不调用搜索、候选转换、审核写入或 CRM 待办接口。
- 真实模式只使用当前用户已启用的官方搜索连接。
- 计划草稿中的连接、凭据版本、操作 ID、模型连接和分片预算全部由服务端补全。
- 每个搜索主题在全部已启用官方搜索来源执行，超过操作上限或预算不足时明确阻断，不静默降级。
- 运行候选只通过服务端持久化的 run→candidate 关联进入投影。
- 搜索候选自动进入受控资格与财务评估；单候选失败显示“待评估”，不伪造金额。
- 财务价值必须绑定候选当前资格决定；缺失时显示“待评估”。
- pending_review 候选必须由用户明确批准/驳回后才能转换或创建外联动作审核任务。
- 作战卡缺失时只通过 Copilot 的 `build_battle_card` 受控工具生成。
- 转换后的 CRM 待办使用 conversion 派生 Idempotency-Key，重试不重复创建。
- 1440×900、1366×768、1024×768 均无横向溢出。
- `npm run test`、`npm run test:e2e`、`npm run build`、`git diff --check` 全部通过。

## 最终提交策略

每个子计划按任务单独提交。完成三个子计划后只做一次集成提交，提交内容仅包含联调修复、验收文档和最终截图索引，避免把大范围功能再次压成一个不可审查的提交。

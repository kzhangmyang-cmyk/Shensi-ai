# 六角色按需联网 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 六角色正常聊天按需搜索，回答附可恢复的真实来源，不把内部资料交给搜索供应商。

**Architecture:** 在现有 agent-center.ask 汇合点加入公开检索规划；复用既有搜索连接及问答模型。只读文档和财务引用继续走原验证器，来源与回答同次保存。

**Tech Stack:** TypeScript、Zod、Express、现有模型网关、加密 MySQL 会话、现有原生 DOM 前端。

**Spec:** `docs/design/agent-conversation-web-research.md`（2026-09-25 用户批准）。

## Global Constraints

- 不增加供应商、依赖、数据库表或新的自动执行任务。
- 每次问题最多一次检索、最多五个去重来源，无后台重试。
- 判断模型只收当前问题及同作用域上次公开主题，不收附件、内部报表、偏好或完整历史。
- 搜索供应商只收校验通过的公开查询，不收原问题；隐私验证失败阻断交付。
- 不修改抖音核心、旧队列或执行真实外发；开发应用重启单独按已授权边界执行。
- 黑绿/蓝白宽窄均验收；不打安装包。

## Review Focus

1. 问题本身夹带内部金额、邮箱或凭据，不能因模型换写而泄露到搜索请求（任务2）。
2. 附件失效但问题涉及公开政策，仍应先拒绝失效附件，不能搜索绕过（任务3）。
3. 两个并发问题及切换角色，不得覆盖来源主题或保存迟到回答（任务3、4）。
4. 模型引用不存在的编号或来源含脚本链接，不能生成可点击伪来源（任务1、3、4）。
5. 旧会话、长来源及 CAS 冲突，不得破坏恢复或只存正文丢来源（任务3）。

## Task 1: 分离真实搜索与独立答案

**Files:** 修改 `backend/src/agent-web-research.ts`；测试 `backend/src/agent-web-research-test.ts`。

**Interfaces:** 新增 `AgentWebResearchService.retrieve(context, raw, signal?)`。raw 复用现有 query/connectionId/role 严格 schema；返回 `{ query, searchProvider, sources, retrievedAt, evidenceKind: 'search_index_snippets' }`。run 复用 retrieve 后调用现有 answer，保持显式接口兼容。

- [ ] 新增失败测试，调用 retrieve 后断言 search 一次、answer 零次；复用现有 context 和 fixture：
```ts
const evidence = await service.retrieve(context, {query:'公共政策', connectionId:'search-1', role:'tax'});
assert.equal(evidence.sources.length, 1);
assert.equal(calls.length, 1);
assert.equal(evidence.evidenceKind, 'search_index_snippets');
```
- [ ] 运行 `pnpm --dir backend exec node --import tsx --test src/agent-web-research-test.ts`，确认缺少 retrieve 失败。
- [ ] 把 run 中输入鉴权、连接选择、搜索、去重和空结果拒绝整体移入 retrieve；run 用 `const evidence = await this.retrieve(context, raw, signal)`，仅在此后生成并验证答案，返回 `{...valid.data, ...evidence}`。
- [ ] 增加取消、六条截断五条、重复 URL、脚本 URL 和非法引用回归，运行相同测试通过。
- [ ] 审阅本任务 diff，只提交本任务已验证文件，不包含其他工作区改动。

## Task 2: 公开查询规划及隔离

**Files:** 新增 `backend/src/agent-conversation-research.ts`、`backend/src/agent-conversation-research-test.ts`；修改 `backend/src/agent-web-research-runtime.ts`、对应 runtime 测试。

**Interfaces:** 规划结果严格定义如下，不允许模型返回任意工具参数：
```ts
type ResearchPlan =
  | { kind:'not_needed' }
  | { kind:'clarify'; question:string }
  | { kind:'search'; topic:string; region:string; freshness:string };
type PlanInput = {question:string; previousPublicTopic?:string};
```
运行时依赖注入规划模型与 Task1 retrieve；角色和身份使用服务端 context，不从模型输出获取。

- [ ] 先写受控规划网关测试：遍历现有 FINANCIAL_COUNCIL_MODEL_ROLES，普通资料摘录 not_needed 不调用 search；时效问题 search 只调用一次；无主题指代返回 clarify。
- [ ] 运行 `pnpm --dir backend exec node --import tsx --test src/agent-conversation-research-test.ts` 确认模块缺失失败。
- [ ] 从现有角色模型网关构造结构化规划请求，仅序列化 `{question, previousPublicTopic}`。搜索查询只拼接通过校验的 topic/region/freshness；连接从当前 context 的 connections 按既有顺序选择。
- [ ] 对当前问题含凭据、邮箱、电话、内部金额/标识的情况，先返回 clarify 请求单独公开主题，不将包含敏感上下文的问题交给规划器压缩；字段不能包含 URL 凭据、联系信息或内部值。无法证明公开的混合主题不搜索。拒绝原因用稳定业务码，不记录原敏感内容。
- [ ] 使用带附件、历史、偏好和内部数值的生产调用夹具，检查提供商 fetch 请求内容，而非仅检查规划 prompt：
```ts
for (const value of ['附件秘密', '内部流水标识', '998877.66', 'private@example.org']) {
  assert.equal(JSON.stringify(searchRequests).includes(value), false);
}
assert.equal(searchRequests.length, 0); // 混合敏感问题须先澄清
```
- [ ] 断言无连接、超时、空结果均有稳定错误，无第二次请求。专项通过后审阅并仅提交本任务文件。

## Task 3: 汇合问答、契约和持久化

**Files:** 修改 `backend/src/financial-council-agent-center.ts`、`growth-financial-council-module.ts`、`cfo-conversation.ts`、`finance-document-model.ts`、`finance-document-service.ts`、`cfo-conversation-session-repository.ts` 及各自测试；契约 `contracts/json-schema/cfo-conversation.v1.schema.json`、`cfo-session.v1.schema.json` 和联网 schema、发布清单及生成目标。

**Interfaces:** 回答及 assistant turn 可选 research 包含 Task1 evidence、合法 citationIds 和 completed 状态；普通未搜索回答不含字段。澄清/搜索失败走现有错误或澄清回答路径，不伪造 completed。财务/文档模型输入新增可选 publicEvidence，不修改原 material 和引用事实类型。

- [ ] 先在 agent-center 和生产 HTTP 组合测试加入普通、附件、持久会话、经营偏好四条入口的时效问答，断言实际检索一次及原文引用保留，当前实现应失败。
- [ ] 在 ask 的 selected 验证和角色路由后调用规划；先校验资料再规划。把 module 中已有 webResearch 实例提前创建并注入中心与原手动路由，不创建第二套执行器。
- [ ] 向两条问答模型输入添加独立不可信 publicEvidence 区；结构化输出允许公共编号列表，原财务数字/文档引用验证照常执行。每个公共编号必须在 evidence.sources 中，URL 只能从服务端 evidence 取。
- [ ] 按批准设计扩展可选 research schema，发布下一契约版本，不覆盖既有 release；执行 `pnpm build:growth-contract-release`、`pnpm generate:frontend-contract-types`、`pnpm check:growth-contracts`。
- [ ] askInSession 保存 assistant turn 时一起附 research，CAS 仍只执行一次。CFO 上次公开主题从已存 research 恢复；非持久角色只保留同身份/角色当前会话的服务端短期主题，取消和新会话清除。
- [ ] 旧会话不含 research 仍可读；CAS 冲突不部分保存；跨身份不可取主题；取消后不写入。运行 `pnpm --dir backend test:cfo-conversation`，包含财务数值/文档原引用回归。
- [ ] 更新 `docs/modules/cfo-conversation.md`、`docs/modules/shared-agent-capabilities.md`、契约说明；审阅并仅提交本任务文件。

## Task 4: 普通聊天来源和视觉验收

**Files:** 修改 `frontend/src/growth/agents/cfo-conversation.ts`、`cfo-chat-messages.ts`、相应 self-test、`frontend/src/replica-dashboard.css`、`frontend/scripts/test-agent-chat-layout.mts`；新增来源展示专项测试。

**Interfaces:** 消息通过生成的 research DTO 展示来源；safe HTTP(S)链接、纯文本标题/摘要、检索时间和“搜索摘要”。普通回答不产生空来源面板。

- [ ] 先写恢复会话含 S1 来源的组件测试，断言标题/时间可见、URL 来源于快照；旧回答没有来源区；现有组件应失败。
- [ ] 删除 cfo-conversation 的独立查询面板挂载，保留设置中心搜索连接；消息组件用 DOM textContent 与通过协议校验的 anchor.href 展示，不拼接模型 HTML。
- [ ] role change/退出中止请求并清空页内主题与消息；新聊天保留未发送草稿但不沿用旧主题。历史重开用保存来源，不重新检索。
- [ ] 浏览器测试黑绿/蓝白各1440/1024/390，覆盖长标题、来源展开/收起、键盘激活、错误/禁用、草稿和输入框可达；检查横向溢出和对比度。
- [ ] 运行前端测试、类型检查、契约漂移及根 `pnpm test && pnpm build && ./scripts/context-check && git diff --check`。
- [ ] 在 `docs/PROJECT_STATUS.md` 记录实际证据；精选备份检查无密钥/客户数据/冻结抖音变更，再验证推送。开发应用单独受控同步，保持旧队列暂停和发送关闭。

## 执行与验收

本计划不实现小红书适配，小红书作为独立可验证子项目推进。计划需用户审阅并选择执行方式后实施；推荐本会话原生逐项执行，避免把共用问答与契约拆成并发修改。

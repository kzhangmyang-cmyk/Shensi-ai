# 抖音获客智能体 Skill 与工作流契约

日期：2026-08-05

状态：设计草案

依赖：`AI 全自动获客与销售转化系统——抖音首发版 PRD`

## 1. 设计原则

系统对客户只展示一个“AI 增长参谋”，内部不采用多个自由 Agent 相互委托的不可控结构。

| 层级 | 职责 | 能否产生外部副作用 |
|---|---|---:|
| Agent / Pi | 理解目标、选择工具、解释结果、接受追问 | 否 |
| Skill | 完成单一语义判断或生成任务 | 否 |
| Workflow | 编排阶段、预算、队列、重试、幂等和状态 | 只可调用受控端口 |
| Rule Engine | 执行确定性硬门禁，产生动作决定 | 否 |
| Connector Worker | 使用客户凭据调用官方平台能力 | 是，且必须有动作决定 |

Skill 必须满足：

1. 输入输出均通过版本化 JSON Schema；
2. 不直接访问数据库、文件系统、浏览器或平台凭据；
3. 不直接发送消息、回复评论、加好友、转换 CRM 或记录虚假结果；
4. 所有事实结论引用证据，推测标注置信度，证据不足输出未知；
5. 相同版本、相同输入快照应产生可评估、可追踪的结果；
6. 模型不可用时允许规则降级，但不得放宽硬门禁。

## 2. 标准调用信封

所有 Skill 使用统一调用信封：

```json
{
  "invocationId": "inv_...",
  "skillId": "qualification.evaluate",
  "skillVersion": "1.0.0",
  "tenantId": "tenant_...",
  "actor": {
    "type": "workflow",
    "id": "candidate-processing"
  },
  "subject": {
    "type": "candidate",
    "id": "cand_...",
    "version": 7
  },
  "planSnapshotRef": "plan-snapshot:...",
  "modelSnapshotRef": "model-snapshot:...",
  "capabilitySnapshotRef": "capability-snapshot:...",
  "ruleBundle": {
    "id": "qualification-rules",
    "version": "3.1.0"
  },
  "evidenceRefs": ["evidence:..."],
  "budget": {
    "maxInputTokens": 12000,
    "maxOutputTokens": 2500,
    "maxAmountMinor": 500,
    "deadlineAt": "2026-08-05T12:00:00Z"
  },
  "idempotencyKey": "skill:qualification.evaluate:cand_...:v7",
  "input": {}
}
```

## 3. 标准结果信封

```json
{
  "invocationId": "inv_...",
  "skillId": "qualification.evaluate",
  "skillVersion": "1.0.0",
  "status": "succeeded",
  "output": {},
  "claims": [
    {
      "claim": "候选近期表达明确采购需求",
      "classification": "fact",
      "confidenceBps": 9100,
      "evidenceRefs": ["evidence:..."]
    }
  ],
  "warnings": [],
  "provenance": {
    "modelCallRef": "model-call:...",
    "promptVersion": "qualification.zh-CN.v4",
    "schemaVersion": "qualification-decision.v2",
    "inputHash": "sha256:...",
    "outputHash": "sha256:..."
  },
  "usage": {
    "inputTokens": 0,
    "outputTokens": 0,
    "amountMinor": 0,
    "durationMs": 0
  }
}
```

`status` 允许：`succeeded`、`degraded`、`needs_evidence`、`blocked`、`failed`。

`classification` 允许：`fact`、`inference`、`unknown`。

失败结果必须包含稳定错误码、可否重试和不完整字段，不能只返回自然语言错误。

## 4. Skill 注册表

| Skill ID | 主要输出 | 现状 | 参考现有 Pi 工具 |
|---|---|---|---|
| `icp.plan_draft` | ICP、信号、排除项、预算建议 | 已有能力，需扩展抖音字段 | Copilot plan draft |
| `douyin.discovery_plan` | 抖音查询、数据入口与能力要求 | 新增 | `search_public_sources` |
| `platform.signal_normalize` | 标准平台事件和原子信号 | 新增 | 无 |
| `identity.resolve_merge` | 主体标识、合并建议和冲突 | 已有内核，需平台化 | identity resolver |
| `candidate.research` | 企业/个人公开商务研究 | 已有，需扩展平台证据 | `research_candidate` |
| `qualification.evaluate` | S/A/B/C/D、理由、反证 | 已有，需多事件输入 | `qualify_candidate` |
| `financial_value.estimate` | 金额、毛利、周期、风险 | 已有 | `estimate_financial_value` |
| `battle_card.compose` | 客户作战卡 V2 | 已有，需细化字段 | `build_battle_card` |
| `connection.strategy` | 分角色、分渠道策略 | 已有，需动作意图 | `draft_connection_strategy` |
| `quote.guard` | 澄清问题、内部报价边界 | 新增 | 无 |
| `conversation.next_action` | 阶段、异议、下一步 | 新增 | 无 |
| `action.policy_evaluate` | 自动/审核/禁止 | 新增，规则优先 | `create_review_task` 的前置 |
| `outcome.learn` | 归因、评估样本和策略反馈 | 扩展 | `record_outcome` |

## 5. 具体 Skill 契约

### 5.1 `icp.plan_draft`

**目的**：将客户自然语言目标变成跨行业、可审批的获客计划草稿。

**输入**：产品资料、目标地区、目标组织/个人、历史成交画像、经营目标、行业知识库、预算约束。

**输出**：ICP、正/负信号、排除条件、数据入口建议、搜索主题、评分权重、预算和待用户确认问题。

**硬规则**：模型不得自行开启连接器、批准计划或扩大预算。

**降级**：模型失败时返回基于用户输入的最小草稿，并标记缺失字段。

**黄金样本**：企业服务、装修、美业、财税、制造、教培六类行业。

### 5.2 `douyin.discovery_plan`

**目的**：把已批准 ICP 转为抖音首发的发现任务。

**输入**：ICP 快照、可用搜索连接、抖音连接器能力快照、用户 URL 和计划预算。

**输出**：

- 公开搜索查询；
- 用户链接解析任务；
- 授权数据同步范围；
- 每个任务需要的能力、优先级和停止条件；
- 预计请求量，不承诺线索数量。

**硬规则**：只生成当前连接和能力快照可完成的任务；不得生成绕过登录或验证码的步骤。

**降级**：无抖音连接器时只生成公开搜索和用户提交入口。

**测试**：同一目标的确定性去重、预算切片、无连接器、授权过期、能力受限。

### 5.3 `platform.signal_normalize`

**目的**：把抖音及后续平台事件转成通用原子信号。

**输入**：已验证签名并脱敏的平台事件、授权快照、内容与主体引用。

**输出**：

- `eventType`、`sourcePlatform`、`platformAccountRef`；
- 视频、评论、消息或表单引用；
- 需求、询价、痛点、重复互动、业务身份、拒绝、投诉、广告等原子信号；
- 发生时间、有效期、置信度和证据引用。

**硬规则**：不改变原始事件；拒绝和勿扰信号优先保留。

**降级**：无法分类时输出 `unknown_signal`，不得丢弃原始证据。

**测试**：重复、乱序、删除、编辑、空文本、表情、中文口语和平台 ID 冲突。

### 5.4 `identity.resolve_merge`

**目的**：将多来源事件归入稳定候选并避免重复客户。

**输入**：账号主页、公开身份、企业域名、统一社会信用代码、平台稳定 ID 和已有别名。

**输出**：`resolved`、`needs_review` 或 `conflict`；主体引用、合并建议、支持证据和冲突候选。

**硬规则**：弱名称、昵称或模型相似度不能独立完成强身份合并。

**降级**：证据不足时创建待研究候选，不创建虚假联系人。

**测试**：同账号多视频、同企业多账号、同名不同人、账号改名和跨租户隔离。

### 5.5 `candidate.research`

**目的**：补齐高价值候选的公开商务背景。

**输入**：候选、现有证据、研究缺口和独立预算。

**输出**：企业/个人商务概况、近期动态、需求证据、疑似供应商、购买角色和未知项。

**硬规则**：不得把供应商、性格、预算或联系方式的推测写成事实。

**降级**：来源受限、登录墙或超预算时保存部分结果。

**测试**：无官网、同名企业、过期内容、冲突来源和访问受限。

### 5.6 `qualification.evaluate`

**目的**：基于时间窗内的多信号和证据判断是否值得跟进。

**输入**：候选画像、聚合信号、事实证据、反证、ICP、规则分和历史互动。

**输出**：总分、S/A/B/C/D、需求明确度、ICP 匹配、购买阶段、互动强度、角色可达性、负向信号、触达风险、推荐动作和解释。

**硬规则**：来源、身份、公开数据、勿扰、明确拒绝、新鲜度和 Schema 门禁由确定性规则决定，模型不能覆盖。

**降级**：模型失败时输出规则分和 `degraded`，不得自动升级为 S/A。

**测试**：一句“多少钱”、连续三次询价、行业不匹配、广告号、明确拒绝和旧证据。

### 5.7 `financial_value.estimate`

**目的**：区分“想不想买”和“值不值得做”。

**输入**：资格判断、产品价格/成本规则、行业历史、服务复杂度、回款和复购数据。

**输出**：成交金额区间、成交概率、毛利区间、销售周期、回款周期、服务复杂度、账期风险、复购/转介绍概率和财务等级。

**硬规则**：金额使用最小货币单位，概率使用基点；无可靠业务参数时显示待评估。

**降级**：不以默认客单价伪造预计收入。

**测试**：高意向低毛利、长账期、高交付成本、无价格规则和多币种预留。

### 5.8 `battle_card.compose`

**目的**：为 S/A 或达到综合阈值的候选生成销售可执行作战卡。

**输入**：候选、研究、资格、财务价值、知识库和角色信息。

**输出**：客户概况、需求证据、供应商假设、决策链、采购偏好、沟通风格、连接路径、分角色话术、不建议动作和财务摘要。

**硬规则**：每个重要结论必须标注事实/推测/未知、证据和置信度。

**降级**：局部字段失败不阻塞已有有效部分，失败字段显示未知。

**测试**：证据引用完整性、无依据人格结论、V1 只读兼容和新证据失效。

### 5.9 `connection.strategy`

**目的**：把作战卡转为各渠道的连接策略和候选动作意图。

**输入**：作战卡、可用渠道、当前互动阶段、内容规则和授权能力。

**输出**：公开回复、已授权私信、企微、电话、邮件、表单、转介绍等策略，以及目标、目的、草稿、最佳时机和停止条件。

**硬规则**：输出只是 `PlatformActionIntent` 草稿，不等于执行许可。

**降级**：能力不足时输出人工渠道建议。

**测试**：不同决策角色、价格型/效果型/谨慎型偏好、重复文案和禁止承诺。

### 5.10 `quote.guard`

**目的**：对外先澄清需求，对内保护报价和毛利。

**输入**：客户问题、需求完整度、产品套餐、底价、折扣、服务成本和审批规则。

**输出**：是否可报价、澄清问题、对外回复草稿、内部价格区间、最低底线、折扣上限、毛利影响和审批要求。

**硬规则**：内部底价和毛利信息不得出现在对外文本；超折扣必须审核。

**降级**：财务数据不全时只生成澄清问题，不给价格。

**测试**：直接问价、预算已明确、多人采购、低毛利和敏感价格泄露。

### 5.11 `conversation.next_action`

**目的**：根据客户回复更新销售阶段和下一步动作。

**输入**：已授权会话摘要、最新消息、作战卡、历史动作和时间。

**输出**：阶段、意图变化、异议、需补信息、下一步建议、回复草稿、跟进时间和停止条件。

**硬规则**：明确拒绝立即输出停止，模型不得自行恢复勿扰客户。

**降级**：上下文不足时转人工，不猜测客户承诺。

**测试**：询价、异议、已读不回、拒绝、要求电话、成交和错发消息。

### 5.12 `action.policy_evaluate`

**目的**：确定一个动作意图能否自动执行。

该 Skill 实际由确定性规则引擎实现，模型只能提供风险标签，不能产生最终许可。

**输入**：动作意图、能力快照、授权、计划策略、候选状态、勿扰、频率、预算、内容检查、幂等账本和人工审批。

**输出**：

```json
{
  "decision": "auto_allowed",
  "reasonCodes": ["CAPABILITY_AVAILABLE", "PLAN_PREAUTHORIZED"],
  "requiredReviewRole": null,
  "expiresAt": "2026-08-05T12:15:00Z",
  "policyVersion": "douyin-action-policy.v1"
}
```

`decision` 只允许 `auto_allowed`、`review_required`、`blocked`。

**硬规则**：缺能力、缺授权、勿扰、明确拒绝、超频、超预算、内容阻断、过期决定或已有成功回执时不得自动执行。

**降级**：任何内部错误默认为 `review_required` 或 `blocked`，绝不 fail-open。

**测试**：每个门禁单独失败、组合失败、策略过期、授权撤销、并发重试和重复回调。

### 5.13 `outcome.learn`

**目的**：将真实业务结果变为归因和评估数据，而不是让模型在线自行修改规则。

**输入**：动作回执、客户回复、私域转换、报价、成交、回款、拒绝/投诉、计划和全部版本引用。

**输出**：归因事件、质量标签、评估样本、策略建议和需人工复核的异常。

**硬规则**：只有可信执行回执或业务系统事实才能形成正式 Outcome；模型不能伪造触达或成交。

**降级**：归因不唯一时输出多触点贡献和不确定性。

**测试**：重复回执、跨渠道成交、延迟回款、人工录入纠错和无归因成交。

## 6. 确定性工作流

### 6.1 `douyin-acquisition-run`

```text
approved plan
→ capability preflight
→ public search / user import / authorized sync
→ event verification and normalization
→ signal aggregation
→ identity resolution
→ candidate research
→ qualification
→ financial value
→ battle card
→ connection strategy
→ action policy
→ action queue or review queue
```

每个阶段有稳定幂等键；单候选失败不终止整个 Run；暂停、取消、预算耗尽和授权撤销向下传播。

### 6.2 `platform-action-execution`

```text
action intent
→ current capability and authorization recheck
→ current policy decision recheck
→ content render and final validation
→ connector call
→ receipt
→ outcome event
→ candidate/conversation update
```

连接器调用前必须再次检查当前能力和授权，不能只依赖计划创建时快照。

### 6.3 `conversation-follow-up`

```text
authorized inbound event
→ normalize and attach conversation
→ next-action Skill
→ action policy
→ automatic reply / review / stop
→ receipt and stage update
```

## 7. Connector 契约

所有平台连接器实现统一端口：

- `authorize()`：发起官方授权；
- `refreshAuthorization()`：刷新或验证授权；
- `probeCapabilities()`：返回当前账号、应用和环境的能力快照；
- `pullEvents(cursor)`：拉取允许的数据；
- `verifyWebhook(request)`：验证签名、时间和重放；
- `executeAction(job)`：执行已获许可的动作；
- `queryActionReceipt(externalId)`：查询不确定结果；
- `revoke()`：停止使用并清理活动授权。

连接器结果必须区分：能力不可用、授权不足、额度不足、频率限制、临时错误、永久错误和结果未知。

## 8. 注册、版本和回滚

每个 Skill、工作流、规则包和连接器均登记：

- 稳定 ID、语义版本和状态；
- 输入/输出 Schema 版本；
- Prompt、模型能力和知识库要求；
- 所需证据类型和数据敏感级别；
- 黄金样本集与最低质量阈值；
- 可用行业、租户和灰度范围；
- 上一稳定版本和回滚条件。

新版本先对历史样本回放，再影子运行，最后小流量启用。线上不得由模型自行修改 Prompt、规则或动作权限。

## 9. 安全不变量

1. Skill 永远不能直接触达客户。
2. 动作没有当前有效的 `ActionDecision` 就不能进入 Connector Worker。
3. `auto_allowed` 必须由确定性规则生成，模型输出不能替代。
4. 客户拒绝、勿扰、授权撤销和平台能力撤销均优先于计划配置。
5. 成功回执是业务事实；模型文本不是执行证据。
6. 所有个人画像只使用公开商务信息和授权交互，禁止私密或敏感信息画像。
7. 跨租户、跨账号、跨连接器的数据、凭据和记忆不得混用。

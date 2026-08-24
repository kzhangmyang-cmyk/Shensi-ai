# AI 全网获客智能体完整设计

日期：2026-07-23

状态：产品范围已确认，等待书面设计复核

基线：GoodJob Gitee 1.09（`5732e2092b48837929e7bf1f3588f3940dccd7be`）

## 1. 目标

在 GoodJob 1.09 已有的 Campaign、Strategy、Run、Worker、Provider Runtime、原始证据、去重、资格判断、CRM 转化和结果反馈能力上，完成一个行业无关、可配置的 AI 全网获客智能体。这里的“行业无关”表示核心证据、主体、评分和工作流不绑定某一个垂直行业；不表示系统在没有行业规则、数据授权和专项验证的情况下对所有行业天然有效。

完整系统必须做到：

1. 客户使用各模型厂商的官方 API Key 直连。
2. 客户可配置多个模型连接，但同一时间只启用一个模型。
3. 从真实搜索 API 和授权数据源获取企业线索与个人公开需求信号。
4. 企业与个人使用不同的数据模型、身份归一、去重和评分规则。
5. 每个 AI 判断都带来源、证据、置信度、模型和规则版本。
6. 生成客户情报、供应商分析、决策链、采购偏好、连接策略和客户作战卡。
7. 通过人工审核后才能转为正式 CRM 线索。
8. 将跟进、回复、成交和流失结果反向用于评估和规则优化建议。
9. 通过 AI 增长参谋提供自然语言规划、解释和作战入口。

本轮不是削减功能的 MVP。开发过程可以拆成多个小型分支和 Pull Request，但只有本文定义的完整 AI 获客链路全部通过验收，才算功能完成。

## 2. 非目标和边界

本设计不把以下能力作为 AI 获客智能体的一部分：

- 绕过登录、验证码、平台权限或访问限制；
- 依赖个人微信外挂、自动加好友、自动群发或模拟真人规避检测；
- 采集非公开聊天、非公开朋友圈、通讯录或购买的灰产数据；
- 用模型猜测填充不存在的联系方式、身份、采购需求或供应商关系；
- 让 Pi 或大模型直接操作队列、租约、重试、费用结算或数据库权威状态；
- 未经人工审核自动转为正式客户或自动触达。

对小红书、抖音、知乎、微博、B 站、公众号、视频号等平台，第一优先级是正式授权接口；没有可用授权接口时，只处理搜索引擎已公开索引的页面、用户主动提交的链接或用户合法导入的数据。

## 3. 已有基线与关键缺口

GoodJob 1.09 已具备：

- Prospect Campaign 与不可变版本；
- Prospect Strategy、预览、审批与激活；
- Search Run、Shard、幂等和状态机；
- Worker、租约、心跳、重试、请求 Ledger 和原始来源记录；
- Serper、Brave、SerpApi 等 Provider；
- 网站候选清洗、组织身份归一、覆盖记忆和资格门禁；
- Lead/Customer 转化；
- Customer Intelligence 与 Outcome Feedback。

现有关键缺口：

1. AI 模型运行时以通用 Chat Completion 为主，没有完整的多厂商能力契约、工具调用、结构化结果修复、计费审计和厂商测试矩阵。
2. 缺少百度 AI 搜索和腾讯联网搜索等中文网络数据源。
3. 缺少从自然语言目标到双通道搜索策略的正式规划智能体。
4. 普通 Web 搜索结果主要落为 `WebsiteOpportunity`，尚未完整桥接到可信企业身份、`TenantProspect` 和资格门禁。
5. 缺少个人公开需求信号的独立领域对象和处理链路。
6. 缺少把企业与个人证据统一呈现为客户作战卡的上层智能体。
7. 缺少可供前后端双方并行开发的稳定 OpenAPI 与 JSON Schema 契约。

## 4. 总体架构

```text
用户自然语言目标
        │
        ▼
AI 增长参谋 / 获客规划智能体（Pi Agent Core）
        │  输出结构化 Campaign / Strategy 草稿
        ▼
GoodJob 规则校验 + 人工审批
        │
        ▼
Campaign → Strategy → Run → Shard → Worker
        │
        ▼
真实搜索 Provider
├── 百度 AI 搜索
├── 腾讯联网搜索
├── Serper
├── Brave Search
├── SerpApi
├── Tavily
├── 企业官网解析
└── URL / Excel / CSV 授权导入
        │
        ▼
不可变原始证据与调用 Ledger
        │
        ├── 企业通道
        │   └── 企业身份 → 去重 → 需求/采购信号 → 资格评分
        │
        └── 个人通道
            └── 公开账号 → 内容去重 → 需求聚合 → 意向评分
        │
        ▼
客户情报与客户作战卡
        │
        ▼
人工审核 → CRM 线索 → 跟进 → Outcome Feedback
```

### 4.1 职责分离

Pi 与大模型负责：

- 理解自然语言目标；
- 生成 ICP 和搜索策略草稿；
- 发现信息缺口；
- 解释证据和评分；
- 生成客户研究与作战卡；
- 提供 AI 增长参谋对话体验。

GoodJob 确定性内核负责：

- 权限、租户和数据范围；
- Campaign、Strategy 和审批；
- Provider 请求、队列、租约、重试和限流；
- 幂等、游标、原始证据和成本；
- 身份归一、去重和资格硬门禁；
- 人工审核、CRM 写入和审计。

Pi 固定使用 `@earendil-works/pi-agent-core@0.81.1`，并通过 lockfile 将它的传递依赖 `@earendil-works/pi-ai` 固定为同一版本。允许 `pi-ai` 作为 `pi-agent-core` 的必要传递依赖，但不调用其 Provider 选择、密钥读取或跨模型路由；所有真实模型调用仍统一经过本系统的 `ActiveModelGateway`。不引入完整 `pi-coding-agent`，不向 SaaS 用户开放 Bash、文件写入或代码编辑工具。

适配边界固定为：

```ts
interface PiGatewayAdapter {
  createModel(snapshot: AiJobModelSnapshot): PiCompatibleModel;
  streamFn(
    snapshot: AiJobModelSnapshot,
    context: PiAgentContext,
    options: PiStreamOptions
  ): AsyncIterable<PiStreamEvent>;
}
```

`createModel` 只向 Pi 暴露快照中的模型元数据与能力；`streamFn` 将 Pi 的消息和 Tool Schema 转换为 `ActiveModelGateway.callTools/streamText` 请求，并把结果转换回 Pi 事件。适配器不能从环境变量、Pi Provider 目录或另一个连接重新选模型。

`0.81.1` 要求 Node.js `>=22.19.0`，因此引入 Pi 前必须把根 `engines`、本地开发说明、CI、Ubuntu 部署和宝塔部署统一到 Node.js `>=22.19.0` 并通过部署回归。依赖升级必须单独评审许可证、Node 版本、Tool Calling 行为和会话兼容性。

## 5. 官方模型直连层

### 5.1 首批厂商

系统完整支持以下官方连接：

| Provider ID | 厂商 | 主要协议 |
|---|---|---|
| `openai` | OpenAI | Responses / Chat Completions |
| `moonshot` | Kimi / 月之暗面 | OpenAI-compatible Chat Completions |
| `minimax` | MiniMax | MiniMax Chat Completion / OpenAI-compatible adapter |
| `zhipu` | 智谱 GLM | OpenAI-compatible Chat Completions |
| `deepseek` | DeepSeek | OpenAI-compatible Chat Completions |
| `qwen` | 阿里云百炼 / 通义千问 | OpenAI-compatible Chat / Responses |
| `doubao` | 火山方舟 / 豆包 | Ark official API adapter |
| `hunyuan` | 腾讯混元 | OpenAI-compatible Chat Completions |
| `qianfan` | 百度千帆 / 文心 | 千帆 official API adapter |

模型名称不写死在业务逻辑中。连接测试通过后保存客户选择的模型 ID。厂商提供模型列表接口时从官方接口刷新；厂商未提供时使用系统维护、带版本和更新时间的模型目录，不能伪造为实时官方列表。

每个模型连接保存能力探测结果：

- `structuredOutput`
- `toolCalling`
- `parallelToolCalling`
- `streaming`
- `modelListing`

某项智能体任务需要模型不支持的能力时，系统必须在执行前拒绝并提示客户选择兼容模型，不能在运行中静默降级。

### 5.2 BYOK 规则

- 每个连接使用客户自己的官方 API Key。
- API Key 使用服务端密钥加密后保存，接口永不回显明文。
- 模型连接作用域固定为当前 GoodJob 用户（`ownerId`）；团队成员不能共享或读取彼此的 Key。
- 每个用户可以保存多个连接，但数据库必须通过事务和唯一约束保证同一时间最多一个 `active` 连接。
- 所有由该用户新建的智能体任务统一使用创建时的当前启用连接。
- 不做任务级模型路由。
- 不做跨厂商自动回退。
- 模型不可用时返回标准错误并暂停相关 AI 步骤。
- 切换当前模型必须留存操作者、时间、旧连接、新连接和原因。

每个 AI Job 在创建时固化：

- `connectionId`
- `credentialVersion`
- `provider`
- `model`
- `capabilitySnapshot`
- `promptVersion`
- `schemaVersion`

切换当前连接只影响切换后创建的新任务；运行中任务、重试和恢复继续使用原快照。Key 更新创建新的 `credentialVersion`，旧版本加密保留至关联任务终态并满足审计保留期。被活动任务引用的连接不能物理删除，只能停用；满足保留条件后才能清除。

### 5.3 统一接口

```ts
interface ActiveModelGateway {
  healthCheck(): Promise<ModelHealthResult>;
  listModels(): Promise<{
    source: "official_api" | "versioned_catalog";
    models: ModelDescriptor[];
  }>;
  generateStructured<T>(
    request: StructuredGenerationRequest<T>
  ): Promise<StructuredGenerationResult<T>>;
  callTools(
    request: ToolCallingRequest
  ): Promise<ToolCallingResult>;
  streamText(
    request: TextGenerationRequest
  ): AsyncIterable<ModelStreamEvent>;
}
```

所有调用记录：

- `ownerId`、`teamId`、`jobId` 和 `attemptId`；
- `connectionId`、`credentialVersion` 和 `capabilitySnapshotHash`；
- provider、base URL 指纹和 model；
- prompt/template 版本；
- schema 版本；
- request ID；
-输入、输出和推理 Token；
- 厂商返回的 request ID；
- 时延、状态和标准错误；
- 估算或实际费用；
- 脱敏后的调用参数哈希与结果哈希。

`model-call-record.v1` 是追加式调用 Ledger；上述关联字段全部必填。重试创建新的 `attemptId`，但必须复用原 `jobId/connectionId/credentialVersion/capabilitySnapshotHash`。任何 attempt 与当前活动连接不同并不构成错误，判断依据始终是 Job 创建时的快照。

### 5.4 结构化输出

AI 业务结果必须通过版本化 JSON Schema。

处理顺序：

1. 请求模型输出结构化 JSON。
2. 本地 JSON 解析与 Schema 校验。
3. 校验失败时，使用同一模型和原始错误执行一次结构修复。
4. 第二次仍失败则终止该 AI 步骤。
5. 不得通过默认值把缺失证据伪装成成功结果。

## 6. 搜索与数据 Provider 层

### 6.1 真实搜索源

系统接入：

- 百度 AI 搜索；
- 腾讯云联网搜索；
- Serper；
- Brave Search；
- SerpApi；
- Tavily；
- 企业官网解析；
- 用户提交 URL；
- Excel / CSV 授权导入。

数据源不能都伪装成同一种 API Provider，固定拆成三类操作契约：

1. `SearchProvider`：百度、腾讯、Serper、Brave、SerpApi、Tavily。实现查询规范化、页码或游标、请求量、结果量、配额、费用、429/5xx 退避、网络白名单和独立限流。
2. `ContentFetcher`：对用户提交或搜索结果中的公开 URL 做受控解析。实现访问状态、重定向安全、内容类型、大小上限、来源 URL 和抓取时间。
3. `ImportSource`：Excel/CSV 和系统导入。实现文件指纹、行号、批次、字段映射、错误行、幂等和导入审计；不要求虚构分页、HTTP 429 或来源 URL。

三类契约都必须实现：

- 能力声明；
- 权限和来源配置；
- 原始输入或响应保存；
- 可验证的 provenance locator；
- 请求或批次用量；
- 稳定错误类型；
- 幂等和审计。

GoodJob 1.09 当前自动执行路径以 `accessMode = "api"` 为主；工程轨必须先扩展 Runtime 的操作类型和门禁，才能把 `ContentFetcher` 与 `ImportSource` 纳入同一个 Run，而不能用条件分支伪装成 API 搜索。

### 6.2 平台公开内容发现

规划智能体可生成平台限定查询，例如：

```text
site:xiaohongshu.com 装修 获客难 厦门
site:zhihu.com 采购 CRM 系统
site:weibo.com 门店 招生 没客户
site:bilibili.com 企业 获客 成本
```

这些结果只说明“搜索引擎公开索引到相关页面”。系统必须保存真正的来源平台与搜索 Provider，不能把搜索摘要描述成已经完整读取了平台页面。

当客户提供合法链接时，可由受控网页解析器读取公开内容；若目标页面要求登录、验证码或拒绝访问，则标记为 `access_restricted`，不得绕过。

### 6.3 搜索预算

每个 Run 保存：

- Provider 调用次数上限；
- 最大结果数；
- 最大预计费用；
- 最大运行时间；
- 单域名最大结果数；
- 企业/个人通道分配比例；
- 停止条件。

达到任一硬上限时停止发起新请求，并按 6.4 进入 `budget_exhausted` 终态。

### 6.4 Operation Shard 与预算终态

Run 内三类操作使用统一、可审计的 Shard：

```ts
interface AcquisitionOperationShard {
  id: string;
  runId: string;
  parentShardId: string | null;
  kind: "search" | "content_fetch" | "import_rows";
  sourceRef: string;
  budgetSnapshotId: string;
  allocatedBudget: OperationBudget;
  consumedBudget: OperationUsage;
  status:
    | "queued"
    | "running"
    | "retry_scheduled"
    | "pause_requested"
    | "paused"
    | "cancel_requested"
    | "cancelled"
    | "succeeded"
    | "succeeded_empty"
    | "partial_success"
    | "failed"
    | "budget_exhausted";
}
```

该枚举以现有 `ProspectRunShardStatus` 为基线，只新增终态 `budget_exhausted`；Run 状态同样在现有 `ProspectSearchRunStatus` 上新增 `budget_exhausted`。

关系与执行规则：

- Search 是顶层 Shard，可在审批预算内动态创建 `content_fetch` 子 Shard；
- 用户提交 URL 形成顶层 `content_fetch` Shard；
- Excel/CSV 上传先成为已校验的 Import Artifact，Run 再为该制品创建顶层 `import_rows` Shard；文件上传本身不是 Search；
- 动态 fan-out 只能使用父 Shard 尚未消耗的结果数、请求数、费用和时间额度，不能借用其他 Shard 预算；
- 暂停 Run 时，`queued/retry_scheduled` Shard 直接进入 `paused`，`running` Shard 先进入 `pause_requested` 并在持久化当前游标、用量和证据后的安全点进入 `paused`；恢复只把 `paused` Shard 放回 `queued`，不得清空游标和已消费预算；
- 取消 Run 会阻止新任务；`queued/retry_scheduled/paused` Shard 直接进入 `cancelled`，`running/pause_requested` Shard 进入 `cancel_requested` 并在安全点进入 `cancelled`；已完成证据和用量永久保留；
- 可重试错误使 Shard 进入 `retry_scheduled`，重试继续使用原预算与幂等快照；超过重试上限后进入 `failed`；
- 所有 Shard 为 `succeeded/succeeded_empty` 时，有有效证据的 Run 为 `succeeded`，否则为 `succeeded_empty`；任一 Shard 为 `partial_success` 时 Run 为 `partial_success`；至少一个产生有效证据且至少一个为 `failed/cancelled` 时也为 `partial_success`；没有 Shard 产生有效证据且发生错误时为 `failed`；
- Run 只有在所有非终态 Shard 完成安全点转换后才进入 `paused` 或 `cancelled`；`pause_requested/cancel_requested` 不得被聚合为完成；
- 任一 Run 级硬预算耗尽使触发 Shard 为 `budget_exhausted`，其余非终态 Shard 按取消安全点收敛；全部停止后 Run 才进入同名终态。Shard 自身分配额度耗尽时该 Shard 为 `budget_exhausted`：该 Run 已产生任何有效证据则聚合为 `partial_success`，没有产生任何有效证据则聚合为 `failed`；Run 级 `budget_exhausted` 不能通过 `resume` 恢复；
- `pause/resume` 只用于人工暂停或可恢复的运行条件。预算耗尽后若要继续，必须基于原 Run 创建带 `parentRunId`、新审批预算快照和原因的新 Run；
- Run 使用单一 `billingCurrency` 与不可变费率目录快照统一比较费用；费用无法估算的 Provider 在启用金额硬上限的 Run 中不得执行。

Run 汇总从 Shard Ledger 计算，不允许由模型修改。每次创建子 Shard、消费预算、取消和聚合状态均写审计事件。

## 7. 获客规划智能体

### 7.1 输入

- 产品、服务和价值主张；
- 行业与子行业；
- 地区和语言；
- 客单价与成交周期；
- 企业客户、个人消费者或两者；
- 理想客户与排除对象；
- 已有成交案例；
- 禁止话术和勿扰规则；
- 搜索预算；
- 用户自然语言目标。

### 7.2 输出

规划智能体输出版本化 `AcquisitionPlanDraft`：

- ICP；
- 企业客户画像；
- 个人消费场景；
- 正向、弱向和负向信号；
- 产品关键词、行业词、同义词和痛点词；
- 采购、询价、招聘、招投标、扩店等信号；
- 企业搜索任务；
- 个人需求搜索任务；
- 平台限定查询；
- Provider 选择建议；
- 搜索预算分配；
- 停止条件；
- 信息缺口；
- 风险与人工确认项。

规划智能体只能保存草稿。草稿必须经过 GoodJob 规则校验和人工审批，才能生成正式 Strategy。

### 7.3 受控工具

Pi 只能调用：

- `read_campaign_context`
- `save_campaign_draft`
- `list_provider_catalog`
- `preview_prospect_strategy`
- `save_strategy_draft`
- `read_run_summary`
- `read_prospect_evidence`
- `explain_qualification`
- `build_battle_card_draft`
- `request_human_review`

每次工具调用经过：

- 租户和角色校验；
- 工具白名单；
- 参数 Schema；
- 预算检查；
- 幂等检查；
- 调用前后哈希和审计。

## 8. 统一证据模型

所有搜索结果先成为不可变证据，不直接成为客户。

```ts
interface DiscoveryEvidence {
  id: string;
  targetType: "organization" | "individual_signal";
  sourcePlatform: string;
  sourceTitle: string;
  sourceSnippet: string;
  publishedAt: string | null;
  fetchedAt: string;
  locale: string;
  rawArtifactHash: string;
  contentHash: string;
  provenance:
    | {
        kind: "search_result";
        provider: string;
        queryText: string;
        sourceUrl: string;
        resultRank: number | null;
      }
    | {
        kind: "user_submitted_url";
        sourceUrl: string;
        submittedBy: string;
      }
    | {
        kind: "import_artifact_row";
        importBatchId: string;
        artifactHash: string;
        sheetName: string;
        rowNumber: number;
      };
  accessStatus:
    | "indexed_summary"
    | "public_content"
    | "user_supplied"
    | "access_restricted";
}
```

证据规则：

- 每条证据必须具有不可空且可验证的 provenance locator：Web 内容使用 `sourceUrl`，导入内容使用 `importBatchId + artifactHash + sheetName + rowNumber`；
- 搜索摘要与页面全文分开存储；
- AI 生成的结论不得保存为原始证据；
- 同一内容通过多个 Provider 命中时保留多条来源绑定，但只建立一个候选主体；
- 证据修改只能追加新版本，不覆盖历史。

## 9. 企业获客通道

```text
DiscoveryEvidence
→ OrganizationIdentityCandidate
→ 强身份/域名/名称归一
→ Organization
→ TenantProspect
→ 企业需求与采购信号
→ Qualification
```

处理能力：

- 企业名、域名、地区和统一社会信用代码等强标识解析；
- 企业别名和多语言名称；
- 官网、招聘、招投标、地图、新闻和公开内容证据聚合；
- 同主体跨 Provider 去重；
- 疑似身份冲突进入人工审核；
- 现有供应商和竞品痕迹；
- 采购信号、扩张信号、经营压力和时间新鲜度；
- 关键部门与决策角色建议；
- 企业意向与触达风险评分。

普通 Web 候选必须经过“网站候选 → 企业身份 → `TenantProspect`”桥接，不能长期停留在与资格判断割裂的 `WebsiteOpportunity`。

## 10. 个人公开需求通道

个人需求信号使用独立对象，不伪装成企业：

```ts
interface IndividualDemandSignal {
  id: string;
  publicActorKey: string;
  publicDisplayName: string;
  publicProfileUrl: string;
  sourcePlatform: string;
  evidenceIds: string[];
  demandCategory: string;
  demandSummary: string;
  locationHint: string;
  buyingStage:
    | "awareness"
    | "problem_defined"
    | "solution_research"
    | "comparison"
    | "purchase_ready";
  negativeSignals: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}
```

处理能力：

- 只使用公开账号标识和公开链接；
- 同平台公开账号归一；
- URL、内容哈希和近似文本去重；
- 多条公开内容聚合为持续需求信号；
- 区分随便询问、内容互动、明确场景、比价和准备购买；
- 识别拒绝、投诉、广告、同行和勿扰信号；
- 不采集家庭住址、行踪、健康、宗教、金融账户、身份证、非公开通讯录或未成年人敏感信息；
- 模型推测必须标记为 `inference`，不能当作事实。

### 10.1 个人主体与 CRM 兼容

个人信号通过独立 `IndividualParty` 成为可审核主体：

```ts
interface IndividualParty {
  id: string;
  ownerId: string;
  teamId: string;
  publicActorKey: string;
  publicDisplayName: string;
  publicProfileUrl: string;
  sourcePlatform: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

type PartyRef =
  | {
      partyType: "organization";
      organizationId: string;
      tenantProspectId: string;
    }
  | {
      partyType: "individual";
      individualPartyId: string;
      demandSignalId: string;
    };
```

CRM 的 Lead 与 Customer 增加：

- `partyType: "organization" | "individual"`；
- `partyRef`；
- `displayName`；
- 企业主体可选 `company`；
- 个人主体可选 `publicProfileUrl` 和 `sourcePlatform`。

兼容规则：

- 现有 Lead/Customer 迁移为 `partyType = "organization"`，保留原 `company`；
- 企业 Lead 必须绑定 Organization/TenantProspect；
- 个人 Lead 必须绑定 IndividualParty/IndividualDemandSignal；
- 个人 `displayName` 不能写进 `company` 冒充企业；
- 企业与个人分别执行唯一索引、去重、审核、来源绑定和展示；
- 同一公开个人跨平台不自动合并，除非有用户授权或人工确认的可靠标识；
- Lead 转 Customer 时保持原 `partyType`，不得改变主体类型；
- API、数据库迁移、权限、导出和前端详情均使用 `partyType` 判别联合。

## 11. 双通道资格评分

企业与个人有独立评分卡，但共享证据规范。

### 11.1 企业评分

- 需求明确度；
- ICP 匹配；
- 企业身份可信度；
- 采购或扩张信号；
- 预算与规模可能性；
- 决策链可达性；
- 信号新鲜度；
- 多来源证据；
- 负向信号；
- 触达风险。

### 11.2 个人评分

- 需求表达强度；
- 真实使用场景；
- 购买阶段；
- 地区与产品匹配；
- 多次公开信号；
- 时间新鲜度；
- 比价、预算和时效信号；
- 拒绝、广告和同行信号；
- 证据完整度；
- 触达风险。

### 11.3 输出

```ts
interface QualificationDecision {
  decisionEngine: "model" | "rules";
  grade: "S" | "A" | "B" | "C" | "D";
  score: number;
  recommendedAction:
    | "priority_review"
    | "public_response"
    | "nurture"
    | "observe"
    | "do_not_contact";
  evidence: EvidenceReference[];
  positiveSignals: ScoredSignal[];
  negativeSignals: ScoredSignal[];
  reasons: string[];
  confidence: number;
  ruleVersion: string;
  promptVersion: string | null;
  modelProvider: string | null;
  model: string | null;
}
```

硬门禁先于 AI 分数：

- 无原始来源；
- 身份冲突未解决；
- 已在勿扰名单；
- 明确拒绝；
- 敏感或非公开数据；
- 证据过期；
- Schema 不合格。

任何一项硬门禁失败，都不能被模型高分覆盖。

“不做跨模型自动回退”不等于取消确定性规则兜底：

- 规划、情报研究和作战卡依赖模型；当前模型不可用时暂停。
- 资格硬门禁和最低可用评分由版本化规则引擎继续执行，结果标记 `decisionEngine = "rules"`。
- 规则结果的 `promptVersion/modelProvider/model` 为 `null`，但必须保留 `ruleVersion`、证据和原因。
- 规则兜底不得生成模型推断、人格描述或供应商猜测。
- 模型恢复后不会静默覆盖既有规则结果；重新评分必须作为新版本并进入审核。

## 12. 客户情报与客户作战卡

对通过门禁的候选生成：

- 主体摘要；
- 需求证据与时间线；
- 企业或个人场景；
- 可能痛点；
- 企业现有供应商、竞品和替换/补位机会；
- 企业关键部门、决策角色和推荐顺序；
- 采购偏好；
- 商务沟通风格；
- 推荐连接路径；
- 老板、运营、采购、技术或个人消费者版本的开场策略；
- 报价拦截与需求澄清问题；
- 不建议动作；
- 待人工核实的推断。

每个字段分为：

- `fact`：有直接证据；
- `inference`：模型推断；
- `unknown`：没有足够信息。

推断必须带证据引用和置信度，不得输出没有来源的确定性人格标签。

## 13. 人工审核与 CRM 转化

状态：

```text
discovered
├── unresolvable
└── normalized
    → qualified
    → pending_review
      ├── approved
      ├── rejected
      ├── do_not_contact
      └── needs_research
needs_research → normalized | pending_review
approved → converted_to_lead
approved → pending_review
rejected → normalized
```

状态转换规则：

| From | To | Actor | Guard |
|---|---|---|---|
| `discovered` | `normalized` | 系统 Worker | provenance 合格且主体类型可判别 |
| `discovered` | `unresolvable` | 系统 Worker | 主体类型或可靠身份在规范化预算内仍不可判别，必须记录原因 |
| `normalized` | `qualified` | 规则/模型服务 | 硬门禁已执行，评分版本完整 |
| `qualified` | `pending_review` | 系统 | 有资格决定与证据快照 |
| `pending_review` | `approved` | 授权审核人 | 未命中拒绝/勿扰硬门禁 |
| `pending_review` | `rejected` | 授权审核人 | 必须填写原因 |
| `pending_review` | `do_not_contact` | 授权审核人 | 写入勿扰记录和范围 |
| `pending_review` | `needs_research` | 授权审核人 | 必须列明缺失证据 |
| `needs_research` | `normalized` | 研究 Worker | 追加了新证据版本 |
| `needs_research` | `pending_review` | 研究 Worker | `no_new_evidence/access_restricted/failed`，附研究尝试和终止原因 |
| `approved` | `converted_to_lead` | 授权审核人 | 主体绑定完整且幂等键有效 |
| `approved` | `pending_review` | 系统 | 新证据、主体合并或评分依赖版本变化 |
| `rejected` | `normalized` | 授权审核人 | 显式重开且已有新证据 |

补充约束：

- 每个转换使用 `candidateId + decisionVersion + action` 幂等键；
- 新证据、主体合并、规则版本变化或模型重新评分都会使旧 `approved` 失效并回到 `pending_review`；
- `rejected` 可在追加新证据后由审核人显式重开，不能自动重开；
- `unresolvable` 是终态，只能由授权审核人在补充可验证来源后创建新版本候选，不能原地改写；
- 每次 `needs_research` 都有独立次数/费用预算；没有新增证据、页面受限或研究失败时必须回到 `pending_review`，由审核人决定驳回或发起新的受预算研究，不得无限自动循环；
- `do_not_contact` 不能由模型或 Worker 自动解除；
- 重复审核生成新 Review Event，不覆盖历史；
- 硬门禁失败的候选不得进入 `approved`；
- 企业转换创建 organization party Lead，个人转换创建 individual party Lead。

审核人可以：

- 查看原始来源；
- 查看 AI 评分和理由；
- 查看事实与推断的区别；
- 修改等级和推荐动作；
- 补充或驳回证据；
- 加入勿扰；
- 要求重新研究；
- 批准转为 CRM 线索。

转换必须使用幂等键，并保存：

- 候选主体；
- 证据快照；
- 资格决定；
- 审核决定；
- 负责人和团队；
- 转换后的 Lead ID；
- 后续结果回传绑定。

## 14. Outcome Feedback 与持续改进

反馈使用追加式事件，不覆盖候选或 CRM 当前状态：

```ts
interface OutcomeFeedbackBase {
  id: string;
  ownerId: string;
  teamId: string;
  leadId: string | null;
  customerId: string | null;
  eventType:
    | "validated"
    | "contacted"
    | "replied"
    | "rejected"
    | "do_not_contact"
    | "private_domain_entered"
    | "need_confirmed"
    | "quoted"
    | "won"
    | "lost"
    | "payment_received";
  occurredAt: string;
  amount: { amountMinor: number; currency: string } | null;
  reasonCode: string | null;
  reasonText: string | null;
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
}

interface LiveOutcomeFeedbackEvent extends OutcomeFeedbackBase {
  recordKind: "live";
  partyRef: PartyRef;
  candidateId: string;
  attribution: {
    runId: string;
    evidenceIds: string[];
    providerIds: string[];
    queryIds: string[];
    strategyVersion: string;
    qualificationDecisionId: string;
    decisionVersion: string;
    decisionSnapshotHash: string;
    decisionEngine: "model" | "rules";
    ruleVersion: string;
    modelProvider: string | null;
    model: string | null;
    promptVersion: string | null;
  };
}

interface LegacyMigratedOutcomeFeedbackEvent extends OutcomeFeedbackBase {
  recordKind: "legacy_migrated";
  legacySourceId: string;
  partyRef: Extract<PartyRef, { partyType: "organization" }> | null;
  candidateId: string | null;
  attribution: {
    runId: string | null;
    evidenceIds: string[];
    providerIds: string[];
    queryIds: string[];
    strategyVersion: string | null;
    qualificationDecisionId: string | null;
    decisionVersion: string | null;
    decisionSnapshotHash: string | null;
    decisionEngine: "model" | "rules" | null;
    ruleVersion: string | null;
    modelProvider: string | null;
    model: string | null;
    promptVersion: string | null;
  };
  migrationWarnings: string[];
}

type OutcomeFeedbackEvent =
  | LiveOutcomeFeedbackEvent
  | LegacyMigratedOutcomeFeedbackEvent;
```

所有新写入只能使用 `recordKind = "live"` 并通过强校验。企业事件的 `partyRef` 绑定 Organization/TenantProspect；个人事件只绑定 IndividualParty/IndividualDemandSignal，不要求 `organizationId` 或 `tenantProspectId`。`legacy_migrated` 仅用于只读保留无法补齐关联的 1.09 历史记录，不能伪装成完整训练样本；缺失字段逐项写入 `migrationWarnings`。

回复、拒绝、勿扰、进入私域、确认需求、报价、成交、流失、回款分别形成事件；人工改分另以 Review Event 关联同一候选和决定版本。新 Live 事件固化资格决定快照，确保结果可追溯到证据、规则、模型和 Prompt。

反馈用于：

- 评估 Provider 质量；
- 评估关键词与搜索策略；
- 评估规则精度；
- 发现误判和漏判；
- 生成规则、Prompt 和预算调整建议。

系统不允许模型自行修改生产规则。建议必须经过人工批准、版本化和回滚保护。

## 15. AI 增长参谋

自然语言能力：

- 创建获客目标；
- 生成或修改 Campaign / Strategy 草稿；
- 查询 Run 状态；
- 解释为什么推荐或排除某个候选；
- 生成今日作战清单；
- 分析来源质量；
- 生成客户作战卡；
- 提出补充研究任务；
- 请求人工审核。

每个回答必须区分：

- 系统事实；
- AI 推断；
- 操作建议；
- 需要人工确认的动作。

AI 增长参谋不直接执行审批、CRM 转化或触达。

## 16. API 与契约

先冻结版本化契约，再由双方并行开发。

首个实现 Pull Request 必须只完成契约冻结和可执行 Contract Test；双方批准 `ai-acquisition.v1` 后，才能开始依赖该契约的网关、Provider、持久化和 UI 功能。下列目录与文件是强制交付，不是参考结构：

```text
contracts/
├── openapi/
│   └── ai-acquisition.v1.yaml
├── json-schema/
│   ├── api-error.v1.schema.json
│   ├── paged-result.v1.schema.json
│   ├── async-operation.v1.schema.json
│   ├── model-provider.v1.schema.json
│   ├── model-connection.v1.schema.json
│   ├── model-capability.v1.schema.json
│   ├── model-call-record.v1.schema.json
│   ├── discovery-provider.v1.schema.json
│   ├── provider-connection.v1.schema.json
│   ├── content-fetch-operation.v1.schema.json
│   ├── import-operation.v1.schema.json
│   ├── acquisition-plan.v1.schema.json
│   ├── acquisition-run.v1.schema.json
│   ├── acquisition-operation-shard.v1.schema.json
│   ├── discovery-evidence.v1.schema.json
│   ├── party-ref.v1.schema.json
│   ├── organization-candidate.v1.schema.json
│   ├── individual-demand-signal.v1.schema.json
│   ├── qualification-decision.v1.schema.json
│   ├── battle-card.v1.schema.json
│   ├── review-event.v1.schema.json
│   ├── outcome-feedback.v1.schema.json
│   ├── copilot-session.v1.schema.json
│   └── copilot-task.v1.schema.json
└── examples/
    ├── organization-flow.v1.json
    ├── individual-flow.v1.json
    └── search-smoke-query.v1.json
```

强制 HTTP 契约：

```text
GET    /api/v1/ai/providers
GET    /api/v1/ai/connections
POST   /api/v1/ai/connections
GET    /api/v1/ai/connections/:id
PATCH  /api/v1/ai/connections/:id
GET    /api/v1/ai/connections/:id/models
POST   /api/v1/ai/connections/:id/test
POST   /api/v1/ai/connections/:id/activate
DELETE /api/v1/ai/connections/:id
GET    /api/v1/ai/calls
GET    /api/v1/ai/calls/:id

GET    /api/v1/acquisition/providers
GET    /api/v1/acquisition/provider-connections
POST   /api/v1/acquisition/provider-connections
GET    /api/v1/acquisition/provider-connections/:id
PATCH  /api/v1/acquisition/provider-connections/:id
POST   /api/v1/acquisition/provider-connections/:id/test
DELETE /api/v1/acquisition/provider-connections/:id

POST   /api/v1/acquisition/fetch-operations
GET    /api/v1/acquisition/fetch-operations/:id
POST   /api/v1/acquisition/import-operations
GET    /api/v1/acquisition/import-operations/:id

GET    /api/v1/acquisition/plans
POST   /api/v1/acquisition/plans
GET    /api/v1/acquisition/plans/:id
PATCH  /api/v1/acquisition/plans/:id
POST   /api/v1/acquisition/plans/:id/approve

GET    /api/v1/acquisition/runs
POST   /api/v1/acquisition/runs
GET    /api/v1/acquisition/runs/:id
GET    /api/v1/acquisition/runs/:id/operation-shards
POST   /api/v1/acquisition/runs/:id/pause
POST   /api/v1/acquisition/runs/:id/resume
POST   /api/v1/acquisition/runs/:id/cancel

GET    /api/v1/acquisition/candidates
GET    /api/v1/acquisition/candidates/:id
GET    /api/v1/acquisition/candidates/:id/evidence
POST   /api/v1/acquisition/candidates/:id/research
GET    /api/v1/acquisition/candidates/:id/qualification
POST   /api/v1/acquisition/candidates/:id/qualification
GET    /api/v1/acquisition/candidates/:id/battle-card
POST   /api/v1/acquisition/candidates/:id/battle-card
GET    /api/v1/acquisition/candidates/:id/reviews
POST   /api/v1/acquisition/candidates/:id/review
POST   /api/v1/acquisition/candidates/:id/convert

POST   /api/v1/acquisition/outcomes
GET    /api/v1/acquisition/outcomes

POST   /api/v1/acquisition/copilot/sessions
GET    /api/v1/acquisition/copilot/sessions/:id
POST   /api/v1/acquisition/copilot/sessions/:id/messages
GET    /api/v1/acquisition/copilot/tasks/:id

GET    /api/v1/acquisition/audit-events
```

`v1` 规则：

- 所有接口要求认证；资源查询同时执行 `ownerId/teamId` 范围与 RBAC 校验；
- 创建、审批、转化、重试和反馈写入使用 `Idempotency-Key`；服务端返回并保存最终幂等结果；
- 列表接口统一使用 `cursor`、`limit` 和稳定排序，返回版本化 `PagedResult`；
- 研究、运行、评分、作战卡和 Copilot 等长任务返回 `202 + AsyncOperation`，通过任务或资源状态查询终态；
- `resume` 只接受 `paused`；`budget_exhausted` 返回 `409 budget_revision_requires_new_run`，继续执行必须 `POST /runs` 并提交 `parentRunId` 和已批准的新预算快照；
- 连接被活动任务或审计保留期引用时，`DELETE` 返回 `409 connection_in_use`，只允许先停用；
- 只允许新增可选字段；
- 不能删除或重命名已有字段；
- 时间使用带时区 ISO 8601；
- 金额使用 `amountMinor + currency`；
- 枚举未知值必须安全失败；
- 错误使用统一 `code/message/details/requestId/retryable`；
- AI 输出必须包含证据、置信度、模型和版本。

## 17. 可靠性与错误处理

### 17.1 模型错误

- 401/403：连接失效，暂停 AI 步骤；
- 404：模型或 Base URL 错误；
- 429：遵循 `Retry-After`，不切换厂商；
- 5xx/超时：有限重试，仍失败则记录为可恢复失败；
- Schema 失败：同模型修复一次；
- 空响应或内容过滤：明确记录，不生成业务结果。

### 17.2 搜索错误

- 单个 Provider 失败不抹掉其他 Provider 的成功结果；
- 每个失败写入请求 Ledger；
- 重试必须复用幂等键；
- 部分成功明确标记 `partial_success`；
- 无法读取页面时保留搜索摘要，并标记访问状态；
- Provider 费用未知时标记 `unknown`，不能当作零费用。

### 17.3 数据一致性

- MySQL 是唯一业务事实来源；
- Redis 只用于唤醒、延迟任务和死信镜像；
- 原始证据追加，不覆盖；
- 转换和反馈均使用幂等键；
- 企业和个人命名空间隔离；
- 所有人工修改写审计事件。

### 17.4 基线迁移与发布前置条件

在新增网关与双通道数据前，先完成以下可回滚迁移：

1. 将根 `engines`、CI、Ubuntu 与宝塔部署统一升级到 Node.js `>=22.19.0`，并在目标部署环境完成安装、构建、启动和回滚测试。
2. 将 AI 模型配置的新 ID 从 `Date.now()` 改为 UUID，并增加并发创建与唯一性回归测试。
3. 将现有 `ai_model_configs.enabled` 迁移为“每个 `owner_id` 最多一个活动连接”的数据库约束。若旧数据存在多个启用连接，按 `updated_at DESC, id ASC` 选择唯一活动项，其余停用并写迁移审计。
4. 新增凭据版本表和连接引用关系；旧加密 Key 迁移为 `credentialVersion = 1`，不得在迁移日志中输出明文。
5. 将已有企业 Lead/Customer 显式迁移为 `partyType = organization`；不得把个人 `displayName` 回填到 `company` 字段。
6. 将现有仅支持 `won/lost` 的 Acquisition Outcome 逐条迁移为 `recordKind = legacy_migrated` 的 `OutcomeFeedbackEvent`：保留原 ID、时间、原因和金额；仅在原 `tenantProspectId/organizationId` 可验证时生成 organization `PartyRef`，空字符串或无效关联转为 `null` 并逐项写入 `migrationWarnings`；其他缺失归因字段保持 `null`，不得伪造中间互动事件。迁移值固定为 `idempotencyKey = "legacy:" + legacySourceId`、`createdBy = "system_migration"`，重复迁移必须命中同一事件且不得产生副本。迁移后所有新事件必须使用强校验的 `live` 分支，个人事件不创建组织外键。
7. 为 `SearchProvider`、`ContentFetcher`、`ImportSource` 增加判别字段、约束和回填规则，旧 API Provider 迁移为 `SearchProvider`。
8. 每个数据库迁移都必须通过空库安装、1.09 升级、重复执行、失败回滚和数据校验测试。
9. 发布前必须处理基线依赖审计中的高严重性风险；若上游没有安全版本，必须有记录负责人、影响范围、隔离措施和到期日的书面发布豁免。基线审计若继续报告 `xlsx` 高严重性问题，不得静默忽略。

## 18. 安全与隐私

- API Key 使用独立加密密钥和 AES-GCM 保存；
- 前端只看到 `hasKey` 和末尾掩码；
- 运行日志只保存请求/结果哈希、Token 数、耗时、状态码和标准错误，禁止记录完整 Key、Authorization、Cookie、原始 Prompt、原始模型输出和个人敏感信息；
- 若原始模型输入/输出是证据复核所必需，只能保存在独立的加密业务制品库中，执行细粒度访问控制、访问审计、默认 90 天可配置保留期和级联删除；它们不属于运行日志；
- 向模型厂商发送前执行数据最小化和字段过滤，只发送当前任务必需内容；界面明确显示当前官方模型厂商并取得客户配置授权；
- 不向模型发送 API Key、Cookie、非公开聊天、私人联系人、敏感身份信息或与任务无关的个人数据；
- 模型 Base URL 使用 HTTPS、主机和端口白名单；
- Provider 网络请求防 SSRF、重定向逃逸和私网访问；
- 每个工具调用执行租户、角色和资源范围检查；
- 个人公开信号执行最小化收集、来源留痕和删除/勿扰处理；
- 删除请求必须级联到搜索制品、模型业务制品、个人主体索引和导出缓存，同时保留不含原文的必要审计墓碑；
- 数据导出遵循角色、字段脱敏和审计。

## 19. 测试设计

### 19.1 模型连接测试

冻结 `provider × certified model × capability` 矩阵，每个能力值只能是：

- `supported`：适配器与该认证模型必须通过正向契约测试；
- `unsupported`：必须通过“执行前明确拒绝”的负向契约测试；
- `not_exposed`：厂商未提供该接口，UI 和 API 不得伪装为可用。

每个厂商至少认证一个能完成核心规划任务的模型；Pi 使用的认证模型必须是 `toolCalling = supported`。测试覆盖：

- 鉴权成功与失败；
- 模型列表；
- 结构化 JSON；
- Tool Calling；
- 流式响应；
- 429、超时和 5xx；
- Token 与费用解析；
- Key 不泄漏。

默认测试使用确定性 HTTP fixture，不消耗真实额度。真实官方 API Smoke Test 由显式环境变量开启。

Fixture Contract Test 是合并硬门禁。Smoke Test 状态统一为 `passed | failed | not_run`；九类官方模型全部达到 `passed` 是“完整功能发布”的门槛。缺少客户测试 Key 时可以完成代码和 fixture 测试，但不能声称九类真实官方连接已经验收完成。

### 19.2 发现操作测试

- `SearchProvider`：查询规范化、分页/游标、费用/配额、429 退避、部分成功和重复结果；
- `ContentFetcher`：URL 白名单、重定向逃逸、私网阻断、内容类型、大小上限、访问受限和内容哈希；
- `ImportSource`：文件指纹、Sheet/行 provenance、字段映射、错误行、重复导入和批次审计；
- 三类操作：原始制品、幂等、稳定错误、租户隔离和证据追溯。

六个真实 SearchProvider 另设 Live Smoke Matrix，状态统一为 `passed | failed | not_run`，凭据变量固定为：

| Provider | Smoke 凭据 |
|---|---|
| 百度 AI 搜索 | `ACQ_SMOKE_BAIDU_API_KEY` |
| 腾讯联网搜索 | `ACQ_SMOKE_TENCENT_SECRET_ID`、`ACQ_SMOKE_TENCENT_SECRET_KEY` |
| Serper | `ACQ_SMOKE_SERPER_API_KEY` |
| Brave Search | `ACQ_SMOKE_BRAVE_API_KEY` |
| SerpApi | `ACQ_SMOKE_SERPAPI_API_KEY` |
| Tavily | `ACQ_SMOKE_TAVILY_API_KEY` |

每个 Live Smoke 执行版本库中的 `contracts/examples/search-smoke-query.v1.json`（初始查询为 `site:gov.cn 工业和信息化部`），断言鉴权成功、至少一条规范化结果、合法 provenance URL、Provider request ID 或等价追踪字段、用量/配额字段为数值或明确 `unknown`，并把时间、区域、适配器版本和脱敏响应哈希写入测试报告。Fixture 是合并硬门；六个 Live Smoke 全部 `passed` 是完整功能发布硬门。缺少凭据时可以继续开发，但不得把对应 Provider 标记为“真实可用”。

### 19.3 双通道测试

企业：

- 企业名、域名和强标识归一；
- 别名与跨来源去重；
- 身份冲突；
- Web 候选到 `TenantProspect`；
- 企业资格硬门禁。

个人：

- 公开账号归一；
- 内容与近似文本去重；
- 多次需求信号聚合；
- 随便询问与购买准备区分；
- 拒绝和勿扰门禁。

### 19.4 端到端测试

覆盖：

```text
模型连接
→ 自然语言计划
→ 人工审批
→ 真实 Provider fixture
→ Search/Fetch/Import Operation Shard 与动态 fan-out
→ 原始证据
→ 双通道候选
→ 资格评分
→ 客户作战卡
→ 人工审核
→ CRM 转化
→ 企业/个人 Outcome Feedback Event
```

另覆盖人工暂停恢复、取消级联、部分成功、预算耗尽终态、基于原 Run 新建增补预算 Run、研究无新证据/访问受限/失败回审，以及不可判别主体进入 `unresolvable`。

### 19.5 质量评测

建立固定版本、脱敏且可复现的 Golden Dataset。首个发布门槛至少包含 640 个样本，覆盖：

- `zh-CN` 与 `en`；
- 企业和个人两种主体；
- 发现、比较、询价、采购准备、拒绝/勿扰等购买阶段；
- 本地生活、企业服务、制造/外贸、装修、美业、财税、教培、招商加盟八类代表性业务原型。

每个“行业原型 × 主体类型 × 语言”单元至少 20 个样本；购买阶段在完整数据集中分层均衡，拒绝/勿扰样本不得少于总量的 15%。

“行业无关”按上述跨行业验证矩阵和可配置规则引擎验收，不宣传所有受监管或高度专业行业已获得专项认证。分别评测：

- 搜索计划覆盖率；
- 企业身份准确率；
- 个人需求意向准确率；
- S/A 级精确率；
- 拒绝/勿扰召回率；
- 证据引用完整率；
- 作战卡事实与推断混淆率；
- 人工改分率。

完整发布的固定阈值：

| 指标 | 门槛 |
|---|---:|
| provenance 完整率 | `100%` |
| 硬门禁绕过数 | `0` |
| 勿扰/明确拒绝召回率 | `100%` |
| 企业主体归一精确率 | `>= 95%` |
| 需求阶段 Macro-F1 | `>= 0.80` |
| S/A 级候选精确率 | `>= 0.80` |
| 作战卡事实/推断混淆率 | `<= 2%` |
| 敏感或非公开信息违规数 | `0` |

人工改分率作为诊断指标按行业、通道和版本观察，不单独作为发布门槛；每次规则、Prompt、模型或数据处理版本变化都必须重跑完整 Golden Dataset。

## 20. 协作与合并边界

按交付物而不是按同一份运行时代码分工。

智能体与财务决策负责人维护：

```text
docs/product/ai-acquisition/**
contracts/drafts/**
prompts/ai-acquisition/**
tests/golden/ai-acquisition/**
```

其职责是业务规则、Prompt、财务评分、JSON Schema 草案、契约示例、Golden Dataset 和验收结论，不直接维护网关、路由、数据库或 UI 运行时代码。

前端与后端工程负责人维护：

```text
contracts/openapi/**
contracts/json-schema/**
contracts/examples/**
backend/src/model-providers/**
backend/src/ai-growth/**
frontend/src/features/ai-growth/**
backend/src/http/ai-growth-routes.ts
backend/src/persistence/ai-growth-repository.ts
```

其职责是把双方已批准的草案固化为正式契约，并实现模型网关、搜索适配器、业务服务、数据库迁移、API、UI、部署和技术测试。`contracts/**` 是共同批准的边界，工程负责人是唯一集成人；任何正式契约变更必须同时获得业务规则负责人和工程负责人批准。

以下高冲突文件由前端与后端工程负责人或指定集成人单独维护：

- `frontend/index.html`
- `frontend/src/prototype-api.ts`
- `backend/src/server.ts`
- `backend/src/mysql-store.ts`
- `backend/src/types.ts`
- `backend/src/store.ts`
- `backend/schema.mysql.sql`
- `package-lock.json`

首个工程重构 PR 先从这些巨型文件中抽取 AI Growth 的模块入口；后续功能 PR 只实现纯服务或特性目录，不直接并行修改高冲突文件。指定集成人在单独接线 PR 中完成注册、迁移汇总和依赖锁文件更新。

固定分支与依赖顺序：

```text
develop/ai-growth
├── feature/contracts-ai-acquisition-v1
├── feature/ai-growth-module-extraction       # 依赖契约
├── feature/model-provider-gateway            # 依赖契约
├── feature/search-providers-cn               # 依赖契约
├── feature/acquisition-planning-agent        # 依赖网关与 Provider
├── feature/organization-candidate-bridge     # 依赖模块抽取与证据契约
├── feature/individual-demand-pipeline        # 依赖模块抽取与主体契约
├── feature/qualification-and-battle-card     # 依赖双通道
├── feature/acquisition-copilot               # 依赖规划、评分与作战卡
└── feature/acquisition-feedback              # 依赖 CRM 转化
```

每个 Pull Request 只包含一个明确模块，并合入共同的 `develop/ai-growth`，不直接合入 `main`。

## 21. 完整验收标准

只有全部满足才算 AI 获客智能体完成：

1. 九类官方模型连接均有实现、冻结能力矩阵、Fixture Contract Test，且使用指定测试 Key 的真实 Smoke Test 状态均为 `passed`。
2. 客户可保存多连接但只能启用一个，且 Key 全程不泄漏。
3. 百度、腾讯、Serper、Brave、SerpApi、Tavily 的 `SearchProvider` Live Smoke 均为 `passed`，受控 `ContentFetcher` 和 Excel/CSV `ImportSource` 契约与集成测试通过。
4. 获客规划智能体能生成企业与个人两类可审批搜索计划。
5. Campaign、Strategy、Run、Operation Shard、Worker 和发现操作全链路可执行、暂停、恢复、取消、部分成功、预算耗尽和审计。
6. 所有候选都有不可变来源证据。
7. 普通 Web 企业候选可桥接到组织身份、`TenantProspect` 和资格判断。
8. 个人公开需求信号拥有独立归一、去重、聚合和评分链路。
9. 企业与个人评分均执行硬门禁，并输出可解释证据。
10. 高价值候选可生成事实/推断分离的客户作战卡。
11. 人工审核可改分、驳回、补充研究、勿扰和批准转换。
12. CRM 转化幂等，Outcome Feedback 可追溯到来源、规则和模型。
13. AI 增长参谋只能通过受控工具读取、规划、解释和请求审核。
14. 构建、单元测试、契约测试、双通道集成测试和端到端测试通过。
15. 模型/搜索错误、部分成功、幂等重试、连接快照和审批失效状态机均通过故障注入测试；切换活动连接后，旧 Job 的所有 attempt 仍绑定原 `connectionId/credentialVersion/capabilitySnapshotHash`。
16. 安全测试确认无 Key 泄漏、无 SSRF、无跨租户访问和无未审核自动转化。
17. 前后端依据同一版本化契约完成联调。
18. Node 运行时、基线模型配置、凭据版本、Provider 操作类型、CRM 主体和 Outcome Feedback 迁移通过新装、升级、重复执行和回滚测试。
19. 个人主体可以独立完成证据、归一、评分、审核、CRM 转化、勿扰、删除和反馈闭环，不借用企业 `company` 字段伪装。
20. 固定 Golden Dataset 的全部发布门槛通过，并能按模型、规则、Prompt、行业原型和通道追溯结果。
21. 高严重性依赖风险已修复或存在仍在有效期内、责任明确的书面发布豁免。

## 22. 官方参考

- Kimi OpenAI 兼容与 Tool Calls：
  - https://platform.moonshot.cn/docs/guide/migrating-from-openai-to-kimi
  - https://platform.moonshot.cn/docs/guide/use-kimi-api-to-complete-tool-calls
- MiniMax API：
  - https://platform.minimaxi.com/docs/api-reference/api-overview
- 智谱 GLM Function Calling：
  - https://docs.bigmodel.cn/cn/guide/capabilities/function-calling
- DeepSeek Function Calling：
  - https://api-docs.deepseek.com/guides/function_calling
- 通义千问 Function Calling：
  - https://help.aliyun.com/zh/model-studio/qwen-function-calling
- 腾讯混元 OpenAI 兼容接口：
  - https://cloud.tencent.com/document/product/1729/111007
- 百度 AI 搜索：
  - https://cloud.baidu.com/doc/BAIDU_AI_SEARCH/index.html
- 百度千帆 Function Calling：
  - https://cloud.baidu.com/doc/qianfan-docs/s/xm95lyys5
- Pi：
  - https://github.com/earendil-works/pi

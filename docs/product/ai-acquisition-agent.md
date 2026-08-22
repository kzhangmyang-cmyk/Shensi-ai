# AI 全网获客智能体：开发与运维交接

> 适用基线：GoodJob 1.09
>
> API 状态：后端已接入真实应用生命周期
>
> 目标读者：产品负责人、智能体开发者、前后端协作者、部署运维人员

## 1. 产品边界

这套能力是“公开商机发现 + AI 判断 + 人工决策”的获客智能体，不是自动营销外挂。

完整链路为：

```text
自然语言目标
  → ICP 与双通道搜索计划
  → 人工审批
  → 官方搜索 API
  → 原始证据与主体归一
  → 意向/财务价值判断
  → 客户作战卡与连接策略草稿
  → 人工审核
  → CRM 线索
  → 结果反馈
```

系统同时处理两类公开商机：

- **企业通道（organization）**：企业官网、域名、统一社会信用代码、地区、公开采购/招聘/扩张等信号。
- **个人通道（individual）**：公开账号、公开主页、公开需求内容及其购买阶段。只处理公开商务需求，不采集私人聊天、通讯录、非公开朋友圈、家庭住址、轨迹、健康、宗教、金融账户等敏感或私密信息。

没有解析出可靠主体身份的搜索结果会保留为待研究候选，并以
`identityResolved = false` 命中硬门禁；模型不能把模糊搜索结果直接说成已核实客户。

## 2. 运行架构

```text
Express 身份认证
  └─ AcquisitionRuntimeBridge
      └─ createAcquisitionApplication
          ├─ Pi Agent Core（对话与工具编排）
          ├─ Active Model Gateway（9 个官方 BYOK 模型适配）
          ├─ Plan / Run / Shard / Worker（确定性执行内核）
          ├─ Public Search Port（6 个官方搜索连接）
          ├─ Domain Service（证据、候选、评分、审核、转换）
          ├─ Controlled Tool Executor（受控工具与幂等 Ledger）
          └─ Memory 或 MySQL repositories
```

职责严格分离：

- **Pi / 大模型**：理解目标、调用已授权工具、解释证据、输出结构化判断和草稿。
- **GoodJob 确定性内核**：租户隔离、权限、快照、审批、预算、队列、幂等、审计、硬门禁、CRM 写入。
- **人**：审批搜索计划、复核候选、确认连接策略、批准 CRM 转换和实际触达。

Pi 使用 `@earendil-works/pi-agent-core@0.81.1`，不使用其环境变量密钥发现或模型自动路由。模型只能来自当前用户在 GoodJob 中启用并由服务端固化的连接快照。

### 2.1 Pi、确定性流水线与两道人工作业门

| 环节 | Pi / 模型负责 | 确定性流水线负责 |
|---|---|---|
| 目标理解 | 将自然语言目标整理为 ICP、查询意图和可解释草稿 | 校验 Schema、租户、连接、快照和预算，生成可审批计划版本 |
| 公开搜索 | 解释搜索目的和结果，不自行选择未授权连接 | 按已审批 operation/shard 调用官方连接，执行配额、重试、去重和审计 |
| 候选处理 | 基于证据生成研究摘要、评分解释、财务判断和作战卡草稿 | 执行身份解析、硬门禁、阶段状态机、幂等、失败隔离和优先级排序 |
| 结果呈现 | 回答“为什么推荐”和“下一步做什么” | 从权威 Repository 生成 presentation 增量投影，模型不能伪造进度 |
| CRM/触达 | 生成供人修改的连接策略 | 校验审核版本并只执行一次转换；不提供自动外联能力 |

闭环固定保留两道人工作业门：

1. **执行前计划审批门**：用户确认目标、范围、数据源、预算和模型快照后，系统
   才能创建 Run。
2. **业务动作前审核门**：自动搜索、研究、评分和作战卡完成后，用户仍需审核
   当前 decision version，才可转换 CRM 或创建后续人工触达任务。

两道门之间的搜索、归一、补充研究、资格判断、财务评估和作战卡生成由
GoodJob Worker 自动串联；不要求用户逐条点击“评分”或“生成作战卡”。

### 2.2 抖音平台化发现工作流与 Skill 边界

新建获客任务必须显式携带 `targetPlatform`。当前只有两个可执行值：

- `douyin`：抖音公开商机；使用搜索服务商已索引的公开页面，也可在计划明确
  启用后对发现或用户提交的公开视频读取有界一级评论样本；
- `web`：全网公开网页，按通用公开搜索规则执行。

抖音链路不是一个可以自由操作网页的巨型 Agent，而是“大模型语义规划、
确定性 Skill 与可恢复工作流”：

```text
用户选择抖音公开商机
  → Pi / 模型生成行业、地区、需求信号与语义查询意图
  → Douyin Query Compiler Skill 移除模型/用户提供的 site: 条件
  → 编译为 site:douyin.com 与 site:iesdouyin.com 的确定性查询
  → 人工审批平台、查询、搜索 Provider 和预算
  → 已授权搜索 Provider 执行公开搜索
  → Douyin Public Source Classifier Skill 分类抖音公开页面
  → 可选 experimental_public_sample 读取有界一级公开评论样本
  → 不可变评论事件、采集观测、需求信号和公开主体聚合
  → 证据归一、候选研究、意向/财务评分和作战卡
  → 人工复核后才能转 CRM 或创建人工跟进任务
```

#### Douyin Query Compiler Skill

- 对语义查询先执行 NFKC 规范化、空白折叠和去重；
- 先移除所有外部提供的 `site:` 表达式，包括全角冒号和不可见
  Unicode 变体；
- 只能生成以 `site:douyin.com ` 或 `site:iesdouyin.com ` 精确开头的
  搜索操作，单条不超过 1000 字符；
- 由智能体生成的方案会在操作数、分片和预算分配之前完成编译，
  且生成器只返回通过 readiness 检查的可审批草稿；
- Plan 创建和更新允许保存尚未就绪的草稿，便于人工继续编辑，
  不会把“可保存”误表达为“可执行”；
- 审批时先对待审草稿执行 readiness 检查，在信任快照校验之后还会
  在事务内重新读取当前修订并再检查一次，防止并发更新越过审批门；
- 创建 Run 时会验证已批准版本号与快照哈希，并对已批准快照再次
  执行 readiness 检查。因此直接调用 Plan API 可以保存待修改草稿，
  但无法将不安全的抖音查询审批或执行。

#### Douyin Public Source Classifier Skill

分类器只接受精确根域或其合法子域，拒绝伪装成抖音的相似域名，并将公开结果分为：

| `sourceType` | 含义 | 身份处理 |
|---|---|---|
| `profile` | 稳定的 `/user/<id>` 公开主页 | 精确 URL 通过验证时可参与公开身份归一 |
| `video` | 抖音公开视频页 | 作为内容证据，不把视频 URL 当成评论用户身份 |
| `comment_signal` | 搜索索引中呈现的评论式摘要 | 只是 `needs_research` 信号，不得声称已扫描全部评论或已验证留言人 |
| `short_link` | `v.douyin.com` 短链接 | 在解析到稳定公开页前保持待研究 |
| `other` | 其他合法抖音公开页 | 只作为普通公开证据 |

抖音限定查询会丢弃搜索 Provider 返回的站外泄漏结果。这只是证据
边界，不代表可以通过搜索摘要获得抖音账号权限、私信能力或全量评论。

### 2.3 公开一级评论样本 Beta

公开评论自动化有两个入口：搜索分片中经过当前租户、连接、查询和 Evidence
完整性校验的抖音公开视频 URL，以及客户通过 content-fetch 提交的公开抖音视频
URL。它不是一个可配置的通用抓取器。启用评论的抖音计划必须同时固化：

```text
douyinPublicCommentSample.enabled = true
provider connection = douyin-public-comments
providerId = experimental_public_sample
kind = content_fetch
status = active
credentialVersion = 1
```

前端默认计划上限为每 Run `10` 个视频、每视频 `30` 条、每视频 `3` 页；
版本化合同允许的硬上限为 `20 / 100 / 5`。实际执行取计划值、服务端上限和 Run
剩余请求/结果预算中的更严者。Provider 的 HTTP 请求计入 `maxRequests`，接收评论
计入 `maxResults`；达到视频、评论、页数、请求或结果上限后不再开始新请求。费用与
时长在分片结果入账时执行 Run 级门禁；当前公开样本 Provider 的费用记为 `0`，单次
请求越过时长分配时会在分片结算后标记预算耗尽，而不是请求前硬停止。

Provider 固定覆盖语义为 `public_top_level_sample`，只访问代码白名单内的 HTTPS
抖音公开主机，不接受用户 endpoint，也不使用 Cookie、登录态、私有签名、代理池、
验证码或浏览器模拟。当前只读取一级评论正文；二级回复仅保存公开返回的
`replyCount`，不读取回复正文。评论者头像字段被丢弃，不下载或展示人脸资产。

每条含平台评论 ID 的有效记录以
`ownerId + teamId + platform + platformEventId` 幂等写入不可变事件；重新采集只追加
observation。公开原文哈希变化时追加内容版本和可追溯 Evidence，原事件与旧 Run
快照不被覆盖。`sec_uid`、规范化 handle 和 comment-scoped actor key 分别用于稳定
主体、待研究主体和不可合并主体；缺少平台评论 ID 的记录以
`source_payload_invalid` 拒绝，不能生成事件。

意愿分类先执行确定性正向、负向和噪音规则。单条“多少钱”最多为
`potential_signal`；身份未核验的强信号在页面显示“高潜需求信号”，只有通过当前
身份与证据核验、资格为 S/A 且没有硬门禁失败的候选才可显示“高意向”。人工审核
仍是 CRM 转换与触达门禁，不参与该页面标签判断。自动身份研究只能使用
受控公开搜索与精确公开主页证据；无法形成一致结论时继续停在人工核验工作台。

Run Presentation 的七步时间线与五项评论计数全部由持久化分片、fetch attempt、
事件、Evidence 和候选事实派生，前端不会用定时器增加数量。单视频失败不回滚同
Run 已获得的结果；混合结果使用 `partial_success`。稳定语义如下：

| 错误码 | 运维/页面语义 |
|---|---|
| `public_sample_unavailable` | 公开 Beta 样本暂不可用，可稍后创建新 Run |
| `access_restricted` | 当前公开访问受限，保留同 Run 已获得的样本 |
| `rate_limited` | 访问或频率受限，按有界退避处理并保留已有结果 |
| `video_id_unresolved` | 来源 URL 未解析到受支持的公开数字视频 ID |
| `source_payload_invalid` | 公开响应缺少平台 ID 或字段不符合严格合同 |
| `no_public_comments` | 本次一级公开样本为空；不表示没有客户，也不计为视频失败 |

已批准计划的 Run 进入成功、空成功、部分成功或失败终态后，任务详情可以点击
“再次运行”创建新的独立 Run。精确 execution 重放复用已落库的终态投影，不重新
请求 Provider；显式的新 Run 可在相同计划和当前预算内重新采集，并保留全部历史。

客户授权的抖音官方 OAuth 连接器、授权事件/Webhook、官方动作能力和持久化周期
调度仍是后续任务。当前应用的启动首扫和周期 recovery sweeper 只恢复已经创建的
Run / execution intent，不会按日、按周或 Cron 自动创建新的获客 Run。

#### 搜索 Provider 与内容来源必须分开

- `provider` 表示谁完成了检索，例如 `baidu_ai_search` 或
  `tencent_web_search`；
- `sourcePlatform` 表示最终内容属于哪个平台，抖音公开页面必须为
  `douyin`；
- `sourceType` 表示公开页面类型，`provenance` 继续保存 Provider、连接
  ID、原始 URL、查询和访问状态。

因此“百度 AI 搜索找到一个抖音视频”应记为搜索 Provider
`baidu_ai_search` + 内容来源 `douyin` + 页面类型 `video`，不得把
百度记为内容平台。

#### 后续平台适配

快手、微信公众号、微博和小红书当前在界面中只显示“待接入”，不能选择或执行。
后续每个平台应实现同一套适配接口：

1. 平台 ID 与可见选择器状态；
2. 允许域名、确定性查询编译与 readiness 校验；
3. 页面类型、内容来源与站外结果过滤；
4. 平台特有的公开身份解析规则；
5. 独立 fixture、安全边界测试和端到端验收。

不应复制一整套 Agent，更不应接入模拟点击、自动私信、自动加好友或规避检测的
平台脚本。

### 2.4 抖音主体核验工作台

搜索引擎命中的抖音视频页、评论式摘要或短链接只能证明“这里出现了需求信号”，
不能证明摘要中的账号就是已经核实的客户。此类个人候选会以
`identityResolved = false` 进入候选列表，并显示“核验主体”，资格评估、财务价值
和客户作战卡保持锁定。

销售在原客户作战抽屉内完成以下受控流程：

```text
查看原始需求信号与搜索 Provider
  → 填写精确 HTTPS 抖音 /user/<id> 公开主页
  → 受控 content-fetch 抓取公开页面
  → 系统只展示本次抓取返回的 evidenceIds
  → 人工选择与声明主页完全一致的公开证据并填写核验说明
  → 使用候选当前 version 和 If-Match 确认主体
  → research_candidate
  → qualify_candidate（同时刷新财务价值）
  → 符合门禁时 build_battle_card
  → 停在候选人工审核
```

核验门禁由确定性规则执行，而不是让模型自行决定：

- 只接受 `https://douyin.com/user/<id>` 或
  `https://www.douyin.com/user/<id>`，拒绝端口、查询参数、片段、相似域、视频页和
  分享短链；
- 证据必须来自当前 content-fetch operation 返回的 ID，内容平台为抖音、
  `sourceType = profile`、访问未受限且保留抓取时间；
- 证据规范化 URL 必须与销售声明的主页完全一致；原始搜索结果只用于解释需求，
  不能被直接勾选为身份依据；
- 确认写入必须有唯一 `Idempotency-Key`、精确候选版本和人工说明；409、412、
  428 不会被静默覆盖；若刷新后发现其他成员已经确认同一主体，则按幂等成功继续；
- 关闭抽屉或切换候选会废弃迟到的抓取、确认和智能体任务结果；重复点击会合并为
  同一个进行中操作。

主体确认后的自动化仅限公开客户研究、意向/财务判断和客户作战卡。系统不会在该
流程中创建外联审核、转换 CRM、发评论、发私信、加好友或群发；这些业务动作仍需
独立人工审核。

## 3. 已支持的官方 BYOK 模型

每个用户填写自己的官方 API Key。Key 在服务端加密保存，读取接口只返回掩码；团队成员不能读取彼此的 Key。同一用户可以保存多个连接，但同一时间只启用一个连接。

| Provider ID | 厂商 | 协议 |
|---|---|---|
| `openai` | OpenAI | Responses / Chat Completions |
| `moonshot` | Kimi / 月之暗面 | OpenAI-compatible Chat Completions |
| `minimax` | MiniMax | MiniMax / OpenAI-compatible Chat Completions |
| `zhipu` | 智谱 GLM | OpenAI-compatible Chat Completions |
| `deepseek` | DeepSeek | OpenAI-compatible Chat Completions |
| `qwen` | 阿里云百炼 / 通义千问 | OpenAI-compatible Chat / Responses |
| `doubao` | 火山方舟 / 豆包 | Ark official API |
| `hunyuan` | 腾讯混元 | OpenAI-compatible Chat Completions |
| `qianfan` | 百度千帆 / 文心 | Qianfan official API |

连接管理 API：

```text
GET    /api/v1/ai/endpoint-profiles
GET    /api/v1/ai/connections
POST   /api/v1/ai/connections
GET    /api/v1/ai/connections/:id
PATCH  /api/v1/ai/connections/:id
POST   /api/v1/ai/connections/:id/activate
DELETE /api/v1/ai/connections/:id
GET    /api/v1/ai/calls
GET    /api/v1/ai/calls/:id
```

创建、修改、启用和删除连接时，客户端必须发送唯一的
`Idempotency-Key`。创建连接只能选择服务端登记的官方端点；不能用任意 Base URL 冒充官方厂商。

### 3.1 模型快照语义

智能体任务创建时固化以下信息：

- `connectionId`
- `credentialVersion`
- `provider`、`model`
- `baseUrlFingerprint`
- `capabilitySnapshot` 及其哈希
- `promptVersion`、`schemaVersion`
- 受信 Prompt 和 Tool Schema 的内容哈希

启用其他模型只影响之后新建的任务。API Key 轮换产生新的
`credentialVersion`；运行中任务、恢复和重试仍引用原快照，不能静默切换厂商、模型、Key、Prompt 或 Schema。

## 4. 已支持的真实搜索连接

| Provider ID | 数据源 |
|---|---|
| `baidu_ai_search` | 百度 AI 搜索 |
| `tencent_web_search` | 腾讯联网搜索 |
| `tavily` | Tavily Search |
| `serper` | Serper |
| `brave` | Brave Search |
| `serpapi` | SerpApi |

搜索连接由当前用户通过获客 V1 接口配置和测试：

```text
GET    /api/v1/acquisition/providers
GET    /api/v1/acquisition/provider-connections
POST   /api/v1/acquisition/provider-connections
GET    /api/v1/acquisition/provider-connections/:id
PATCH  /api/v1/acquisition/provider-connections/:id
DELETE /api/v1/acquisition/provider-connections/:id
POST   /api/v1/acquisition/provider-connections/:id/test
```

### 4.1 搜索来源连接中心

连接中心支持当前 Provider Catalog 中的官方搜索 Provider ID：
`baidu_ai_search`、`tencent_web_search`、`tavily`、`serper`、`brave` 和
`serpapi`。首次使用真实获客时，客户在当前工作区选择 Provider、填写自己的
官方 API Key 并保存；新连接默认保存为 `disabled`，必须先完成真实连接测试，
再由客户明确启用。只有 `status=active` 且 `lastHealthStatus=passed` 的搜索连接
可以继续生成和运行获客方案，测试返回 `ok:false` 时仍保持禁用。

API Key 在服务端加密保存，在前端与 API 安全投影中均为只写：保存后不会回显，
也不得进入页面 HTML、URL、浏览器存储、日志或错误消息。连接只能使用服务端登记
的官方 Base URL；不接受任意地址冒充官方 Provider，修改受支持的连接地址时也
必须重新提交 Key 并重新测试。

搜索 Provider 与目标内容平台是两个概念：例如 `baidu_ai_search` 负责检索，
`douyin` 表示方案限定的内容平台。配置搜索 Provider 只会启用对公开、已索引页面
的检索，不代表获得抖音全站、私域内容或完整评论访问权，也不会自动评论、私信、
加好友或执行其他自动触达。

以上接口只返回连接 ID、厂商、状态和凭据版本等安全投影，不回传 API Key、
密文或内部凭据引用。客户在连接中心配置一次官方 Key 后，`search_public_sources`
未指定 `providerConnectionIds` 时会自动使用该客户已启用的全部官方搜索连接；
若客户明确选择了连接，则只使用所选连接。没有可用连接时返回稳定的
`SEARCH_PROVIDER_CONNECTION_REQUIRED`，前端应引导客户进入连接设置页。

搜索 API Key 同样加密保存。`ProviderConnection.credentialVersion` 是服务端维护的单调版本号：

- 新建连接从版本 `1` 开始；
- API Key 或 Base URL 发生变化时版本递增；
- 启用/停用、配额/预算、健康检查结果等运行状态变化不轮换版本；
- 计划固化 `connectionId + providerId + credentialVersion + status`；
- 计划审批时和每个搜索分片真正调用外部 API 前都会重新校验所有权、团队、个人作用域、启用状态和版本；
- 配置已变化的旧计划必须创建新修订并重新审批，不能继续执行。

这种快照阻止“审批时使用 A 数据源配置，执行时悄悄换成 B 配置”。

## 5. 受控 Pi 工具

智能体只有以下业务工具，没有 Bash、文件写入、代码执行、浏览器自动点击、个人微信或自动发送工具：

| 工具 | 用途 |
|---|---|
| `search_public_sources` | 通过已授权官方搜索连接发现公开商机 |
| `get_candidate_evidence` | 读取候选的可信证据 |
| `research_candidate` | 用公开来源补充候选研究 |
| `qualify_candidate` | 生成可解释的意向资格判断 |
| `build_battle_card` | 生成客户作战卡草稿 |
| `estimate_financial_value` | 估算线索财务价值 |
| `draft_connection_strategy` | 生成分角色、分渠道的连接话术草稿 |
| `list_priority_candidates` | 读取当前用户的优先候选清单 |
| `create_review_task` | 创建人工审核任务 |
| `record_outcome` | 在已有审核动作和可信执行凭证后记录结果 |

所有工具参数先经过严格 Schema 校验；调用写入脱敏审计，保存参数/结果哈希、租户、操作者、会话、工具名、状态和时间。模型不能自行写入正式证据，不能伪造触达结果，也不能绕过人工审核转换 CRM。

系统**不实现**：

- 自动加好友、自动私信、自动评论、自动群发；
- 模拟真人频率或规避平台检测；
- 绕过登录、验证码或平台权限；
- 未经人工审核自动转换客户或自动触达；
- 通过模型猜测补全不存在的身份、联系方式、供应商关系或采购需求。

## 6. 计划、证据与人工审核门禁

### 6.1 计划门禁

1. 自然语言目标先形成结构化计划草稿。
2. 创建计划必须发送 `Idempotency-Key`；相同租户、相同键和相同请求只返回
   同一个计划，不会重复创建。
3. 客户端只能选择可选的 `modelConnectionId`，不能提交
   `modelSnapshotRef`。服务端在创建时绑定模型、凭证版本、能力、Prompt 和
   Schema 的可信快照。
4. 前端读取 `ETag`，修改和审批使用 `If-Match`，防止覆盖他人修订。
5. 审批时服务端重新校验模型快照和所有搜索连接快照。
6. 只有已审批且快照仍可信的版本才能创建 Run。
7. 创建 Run 必须发送 `Idempotency-Key`。
8. Run 被拆成企业/个人搜索分片，可暂停、恢复和取消。

### 6.2 候选硬门禁

资格判断至少校验：

- `hasOriginalSource`：有原始公开来源；
- `identityResolved`：主体身份已解析；
- `notDoNotContact`：不在勿扰状态；
- `noExplicitRejection`：没有明确拒绝；
- `publicDataOnly`：只使用公开、允许的数据；
- `evidenceFresh`：证据未过期；
- `schemaValid`：结构化结果通过 Schema。

搜索结果无法直接解析出强身份时，候选会继续保留，但不得进入资格判断。
人工核验员可以调用：

```text
POST /api/v1/acquisition/candidates/:id/identity-confirmation
Idempotency-Key: <唯一业务键>
If-Match: "candidate-v<当前候选版本>"
```

企业候选只能提交经公开证据支持的官网域名和/或统一社会信用代码；个人候选
只能提交受支持平台的精确公开主页 URL。客户端不能提交 `partyRef`、
`organizationId`、`individualPartyId` 或去重键，规范化标识和稳定主体 ID
全部由服务端生成。

身份确认会在同一事务内完成：

1. 复核证据租户、主体类型、公开 URL 和访问状态；
2. 绑定团队作用域内的强身份别名；
3. 更新候选主体档案并递增候选版本；
4. 使旧资格判断、旧批准和旧作战卡失效；
5. 写入脱敏审计和幂等结果。

以后搜索到相同官网、统一社会信用代码或相同公开主页时，系统会复用原候选，
不会再创建重复客户。若该身份已绑定其他候选，则返回
`identity_conflict`，由人工执行候选合并。

作战卡的每个重要结论必须引用候选已有证据。新证据会使原审批失效。CRM 转换只接受：

- 当前状态为 `approved`；
- 审核批准的 `decisionVersion` 与当前判断版本完全一致；
- 所有硬门禁仍通过。

面向普通客户端的直接证据、候选、评分、作战卡和 Outcome 写接口默认返回
`403 direct_domain_write_disabled`。这些权威结果只能由受控任务或明确启用的可信业务集成写入。人工审核和批准后的 CRM 转换仍通过公开 API 完成。

### 6.3 作战卡 V1/V2 兼容

- 新生成结果使用 `battle-card.v2`，包含客户概况、需求证据、供应商假设、
  决策链、采购偏好、连接策略、不建议动作和财务摘要。
- 已有 `battle-card.v1` 保持只读可展示；前端按 `schemaVersion` 选择适配器，
  不在读取时伪造 V2 缺失字段。
- V1 中不存在的供应商、决策链、采购偏好或财务字段统一显示“未知/暂无证据”，
  不能由 UI 或模型补写成事实。
- V2 每项结论必须携带事实/推测/未知语义、证据引用和置信度。新证据或身份确认
  会使旧判断和旧卡片失效。
- 作战卡阶段失败只标记该候选可重试，不回滚同一 Run 已完成的其他候选；重试
  只能从 AI 增长参谋任务入口发起，前端不直接 POST 作战卡领域接口。

### 6.4 搜索、研究和模型预算

预算均为硬上限，不是提示词建议：

- **搜索预算**：计划快照固定 `maxRequests`、`maxResults`、
  `maxAmountMinor`、`billingCurrency` 和 `maxDurationSeconds`，再分配到每个
  operation/shard。Worker 在请求前和记账后校验；耗尽后进入
  `budget_exhausted`，暂停/取消信号向分片和候选处理传播。
- **补充研究预算**：每个候选最多生成 3 条补充查询，每条最多接收 5 个结果，
  单次研究默认 30 秒；只能复用 Run 已审批的连接快照，不能创建新候选或静默
  切换 Provider。
- **Pi 模型预算**：单次任务默认最多 32 次工具调用、16 个模型轮次、180 秒和
  200,000 个总 Token。任一上限触发稳定的预算错误码并终止后续调用。
- **失败隔离**：单 Provider、单候选研究、单模型或单作战卡失败呈现为
  `partial_success` 或对应候选的可重试阶段；已经完成的结果仍可读取。

## 7. API 前缀与主要资源

所有获客 API 都要求 GoodJob 登录态，统一位于：

```text
/api/v1/acquisition
```

主要接口：

```text
# 只读获客任务总览
GET    /api/v1/acquisition/overview?platform=douyin|web
GET    /api/v1/acquisition/tasks?platform=douyin|web&limit=<1..100>
GET    /api/v1/acquisition/tasks/:planId

# 计划与运行
POST   /api/v1/acquisition/plans
GET    /api/v1/acquisition/plans/:id
PATCH  /api/v1/acquisition/plans/:id
POST   /api/v1/acquisition/plans/:id/revisions
POST   /api/v1/acquisition/plans/:id/approval
POST   /api/v1/acquisition/plans/:id/runs
GET    /api/v1/acquisition/runs/:id
GET    /api/v1/acquisition/runs/:id/shards
POST   /api/v1/acquisition/runs/:id/pause
POST   /api/v1/acquisition/runs/:id/resume
POST   /api/v1/acquisition/runs/:id/cancel
GET    /api/v1/acquisition/runs/:id/presentation

# 候选、证据和审核
GET    /api/v1/acquisition/candidates
GET    /api/v1/acquisition/candidates/:id
GET    /api/v1/acquisition/candidates/:id/evidence
POST   /api/v1/acquisition/candidates/:id/identity-confirmation
GET    /api/v1/acquisition/candidates/:id/qualification
GET    /api/v1/acquisition/candidates/:id/battle-card
GET    /api/v1/acquisition/candidates/:id/reviews
POST   /api/v1/acquisition/candidates/:id/review
POST   /api/v1/acquisition/candidates/:id/convert
GET    /api/v1/acquisition/outcomes
GET    /api/v1/acquisition/audit-events

# AI 增长参谋
POST   /api/v1/acquisition/copilot/sessions
GET    /api/v1/acquisition/copilot/sessions/:id
GET    /api/v1/acquisition/copilot/sessions/:id/messages
POST   /api/v1/acquisition/copilot/sessions/:id/messages
GET    /api/v1/acquisition/copilot/tasks/:id

# AI 增长参谋：今日经营视图与受控建议闭环

增长参谋新增以下权威入口：

GET    /api/v1/acquisition/advisor/today?currency=CNY&asOf=<date-time>
POST   /api/v1/acquisition/advisor/recommendations/:id/accept
POST   /api/v1/acquisition/advisor/recommendations/:id/ignore
POST   /api/v1/acquisition/advisor/recommendations/:id/complete

`today` 只接受 `currency` 与 `asOf` 两个查询参数；工作区、角色与时区全部由
服务端推导。响应包含 `priorityCustomers`、`pendingQuoteApprovals`、
`expectedRoi`、`actualRoi`、`financialDataGaps`、`recommendations` 与
`sourceSnapshotHash`，敏感毛利/成本字段只在调用方具备
`pricing.sensitive.read` 能力时投影。`asOf` 超过服务端时钟 1 秒返回
`422 invalid_as_of`，且不会发起任何读取。

建议命令使用闭合的 `{ reason: string | null }` 请求体，要求单次
`Idempotency-Key` 与 `If-Match: advisor-recommendation-v:<revision>`；
`complete` 不接受任何调用方提供的结果引用，只附加服务端解析到的那一条
`action_receipt`。接受建议只会改变建议状态，不会执行任何动作。

受控动作只允许六种：`open_candidate`、`create_quote_draft`、
`create_quote_approval_task`、`create_sales_todo`、`complete_cost_data`、
`complete_financial_fact`。AI 只能通过这些白名单动作把建议转成报价草稿、
审批任务、销售待办或数据补全导航；不能批准/发布报价、核销财务事实、发送
触达或补造 ROI。建议必须携带同工作区的强类型 `metricRefs`/`evidenceRefs`/
`entityRefs`，引用缺失、过期或跨工作区时创建被拒绝，且不会写入任何建议或
动作记录。

# 官方数据源与客户 BYOK 连接
GET    /api/v1/acquisition/providers
GET    /api/v1/acquisition/provider-connections
POST   /api/v1/acquisition/provider-connections
GET    /api/v1/acquisition/provider-connections/:id
PATCH  /api/v1/acquisition/provider-connections/:id
DELETE /api/v1/acquisition/provider-connections/:id
POST   /api/v1/acquisition/provider-connections/:id/test

# 受控公开网页抓取
GET    /api/v1/acquisition/content-fetch-operations
POST   /api/v1/acquisition/content-fetch-operations
GET    /api/v1/acquisition/content-fetch-operations/:id

# 客户授权 CSV/XLSX 导入
GET    /api/v1/acquisition/import-operations
POST   /api/v1/acquisition/import-operations
GET    /api/v1/acquisition/import-operations/:id
```

列表接口使用有签名的游标；写接口需要按对应契约提供
`Idempotency-Key` 或 `If-Match`。前端不要自行拼装或修改服务端快照、证据、评分和审计字段。
导入接口接收最大 5 MB 的原始 CSV/XLSX 请求体；文件名、主体通道和列映射通过
查询参数或文档指定的请求头传入，不使用 `multipart/form-data`。公开网页 URL
和文件内容会在持久化前执行安全校验。

### 7.1 任务总览、身份与页面恢复

上述三个任务总览接口全部只读，不会启动搜索、模型、审核或
CRM 写入。正式获客任务的唯一身份是 `planId`；任务状态来自该
Plan 的 latest Run。latest Run 先按 `createdAt` 降序，同一时刻再按
`id` 降序选择，不依赖前端缓存或演示状态。

`platform` 与 `provider` 必须分开：平台只有 `douyin|web`；
`baidu_ai_search`、`tencent_web_search`、`tavily` 等是执行搜索的
Provider，不是抖音平台状态。发现方式只允许
`public_search|user_import|official_authorized`。当前未配置官方抖音
授权时，页面必须标记为“抖音 · 公开搜索”，不得声称
`official_authorized` 已连接。

前端使用可恢复的 URL hash：`#ai-growth` 打开真实任务总览，
`#ai-growth/new` 打开新建流程，
`#ai-growth/task/<encodeURIComponent(planId)>` 恢复指定任务详情。
刷新任务详情后必须重新读取权威 Plan、latest Run 和 Presentation。
演示模式必须显示“演示数据”，只做本地回放，向正式获客和
`/api/todos` 写接口发出的请求数必须为零。

### 7.2 Presentation 指标口径

`GET /api/v1/acquisition/runs/:id/presentation?after=<cursor>&limit=<1..100>`
是前端真实运行模式的唯一进度来源。它是只读增量投影，不触发搜索、模型或写入。

| 字段 | 口径 |
|---|---|
| `sourcesSearched` | 当前 Run 中已进入执行投影的 Provider 分片/数据源数量 |
| `pagesAnalyzed` | 分片已记账的结果处理量；用于展示工作量，不等同于网页 URL 去重数 |
| `organizationsFound` | 与该 Run 关联、当前主体类型为企业的去重候选数 |
| `dedupedCandidates` | 与该 Run 关联的稳定候选总数；同一强身份跨来源只计一次 |
| `validOpportunities` | 当前已有有效资格判断且未被硬门禁阻断的候选数 |
| `highIntent` | 当前资格等级为 S/A 的候选数 |
| `financialEvaluatedHighIntentCount` | S/A 候选中已有当前有效财务价值判断的数量 |
| `financialPendingHighIntentCount` | S/A 候选中仍无当前有效财务价值判断的数量 |
| `expectedRevenueByCurrency` | 已完成财务评估候选的预计收入，按币种以最小货币单位分别求和，不跨币种换算 |
| Provider `raw/accepted/duplicate/failedResultCount` | 各分片原始、接收、去重和失败结果计数；部分失败不覆盖已完成结果 |
| `candidateEvents` | 本页发生发现或权威状态变化的候选快照，可能多次出现同一候选 |
| `hasMore` / `nextAfter` | 是否仍有后续事件及下页签名游标；游标绑定租户、操作者和 Run，禁止修改 |

页面展示候选当前状态时应按 `candidateId` 合并增量事件，以最新权威快照为准；
Run 控制按钮必须保留最新 `run.etag`。演示模式使用本地只读回放并明确标记
“演示数据”，不得调用获客写接口、审核、转换或待办接口。

## 8. 启动、恢复与关闭

要求 Node.js `>=22.19.0`。

### 8.1 开发环境（内存）

```bash
JWT_SECRET='至少32字符且稳定的开发密钥' \
ACQUISITION_MASTER_SECRET='至少32字符且稳定的获客主密钥' \
CRM_STORE=memory \
npm run dev --workspace backend
```

内存模式只适合本地开发和自动测试；进程退出后获客计划、候选、会话和审计不会保留。

### 8.2 生产环境（MySQL）

至少配置：

```bash
NODE_ENV=production
CRM_STORE=mysql
DATABASE_URL=mysql://user:password@host:3306/goodjob
JWT_SECRET=...
ACQUISITION_MASTER_SECRET=...
PROVIDER_CREDENTIAL_KEY=...
AGENT_JOB_ENCRYPTION_KEY=...
MODEL_CONNECTION_IDEMPOTENCY_SECRET=...
```

所有密钥至少 32 个字符。`MYSQL_URL` 可替代 `DATABASE_URL`。

说明：

- `PROVIDER_CREDENTIAL_KEY`：加密模型/搜索 API Key 和 Provider 缓存；
- `AGENT_JOB_ENCRYPTION_KEY`：加密任务载荷；未单独配置时可复用 Provider 密钥；
- `ACQUISITION_MASTER_SECRET`：派生获客游标、工具审计、动作凭证和 Copilot 幂等密钥；
- `MODEL_CONNECTION_IDEMPOTENCY_SECRET`：模型连接写入幂等哈希；
- `JWT_SECRET`：登录认证；当前获客主密钥缺失时服务端会回退到它，但生产环境应显式设置独立且稳定的 `ACQUISITION_MASTER_SECRET`。

密钥不能随普通部署轮换。轮换前必须制定密文重加密和在途任务处理方案，否则旧凭据、动作凭证或审计校验可能无法读取。

### 8.3 生命周期

服务启动顺序：

1. 校验认证与密钥安全；
2. 初始化 GoodJob Store；
3. 在 MySQL 模式创建/迁移获客表；
4. 创建模型、搜索、领域、工具和 Pi Runtime；
5. 立即恢复未完成的 Plan execution intents，并启动默认每 60 秒一次、
   进程内不重入的周期恢复扫描；
6. 恢复被进程中断的 Copilot 任务；
7. 抢占并恢复排队中或租约已过期的网页抓取与文件导入任务；
8. 将 Runtime 安装到已认证的 Express 路由；
9. 启动原有 Prospect worker/scheduler 和 HTTP 服务。

任一步骤失败都会终止启动，不会降级成“页面可用但获客 Runtime 不可用”。
Plan execution intent 的启动首扫失败同样会终止启动；运行期单轮扫描失败会保留
可恢复状态并等待下一轮，不阻塞其他恢复意图。收到 `SIGTERM` / `SIGINT` 时先停止
周期恢复扫描，再等待计划 Worker 和活动 Copilot 任务收尾，最后关闭 MySQL Pool
和 GoodJob Store，避免恢复器向已关闭的 Worker 派发任务。默认获客 Worker 并发为
`2`，应用级优雅关闭超时为 30 秒。

### 8.4 本地完整启动与恢复演练

分别启动内存后端和前端：

```bash
JWT_SECRET='goodjob-local-jwt-secret-at-least-32-characters' \
ACQUISITION_MASTER_SECRET='goodjob-local-acquisition-secret-at-least-32-bytes' \
CRM_STORE=memory \
PORT=4188 \
npm run dev --workspace backend
```

```bash
VITE_API_TARGET='http://127.0.0.1:4188' \
npm run dev --workspace frontend
```

需要验证进程重启恢复时，必须改用可丢弃的 MySQL 环境，并在停止、重启前后使用
相同的数据库和密钥：

```bash
JWT_SECRET='保持不变的32字符以上密钥' \
ACQUISITION_MASTER_SECRET='保持不变的32字符以上主密钥' \
CRM_STORE=mysql \
DATABASE_URL='mysql://user:password@127.0.0.1:3306/goodjob_test' \
PORT=4188 \
npm run dev:mysql --workspace backend
```

创建并启动一个 Run 后，在 `queued`/`running` 阶段使用 `Ctrl-C` 正常停止，再执行
同一命令。启动首扫会恢复未完成 execution intent，周期扫描会继续接管可恢复任务。
用登录 Token 查询真实状态：

```bash
curl -H "Authorization: Bearer ${TOKEN}" \
  "http://127.0.0.1:4188/api/v1/acquisition/runs/${RUN_ID}"
curl -H "Authorization: Bearer ${TOKEN}" \
  "http://127.0.0.1:4188/api/v1/acquisition/copilot/tasks/${TASK_ID}"
```

不要用 memory 模式执行恢复验收；它在重启后必然丢失数据。

## 9. Memory 与 MySQL

| 模式 | 用途 | 特性 |
|---|---|---|
| `memory` | 本地开发、单元测试、演示 | 启动快；不持久化；不能多进程共享 |
| `mysql` | 集成、试运行、生产 | 持久化计划、运行、候选、会话、工具 Ledger、审核和审计；支持进程重启恢复 |

生产环境强制使用 MySQL。不要把内存模式的成功演示当成持久化或故障恢复验收。

## 10. 与朋友并行开发的合并边界

建议按 API 合同协作，不共享临时内部对象：

### 智能体/决策负责人维护

- `backend/src/acquisition-*`
- `backend/src/model-providers/*`
- 模型/搜索连接快照与凭据版本语义
- Prompt、Tool Schema、评分与财务价值规则
- 本文档和获客专项测试

### 前端/通用后端负责人维护

- 获客页面、任务进度、候选列表、作战卡、审核台、经营看板；
- 现有 GoodJob CRM 页面和非获客业务路由；
- 通过本文公开 API 接入，不从前端导入后端内部类型或自行重算权威状态。

### 共同遵守

1. 每个功能单独分支和 Pull Request，不直接提交 `main`。
2. 不修改对方正在处理的文件；若必须改共享的 `server.ts`、`types.ts`、
   `mysql-store.ts` 或 API Schema，先在 Issue 中确认字段和迁移。
3. 前端必须保留服务端返回的 `ETag`、游标、任务 ID、decision version 和
   request ID；不得伪造模型/搜索快照。
4. 所有新增写接口都要明确幂等、租户、审批和错误码语义。
5. 合并前运行获客专项测试、TypeScript 编译和双方已有测试。
6. 数据库字段只通过向前兼容迁移增加；不要删除或重命名另一个分支已使用的字段。

## 11. 测试

不依赖 MySQL、不绑定本地 Socket 的确定性专项测试：

```bash
npm run test:acquisition --workspace backend
```

该脚本固定 UTC、单并发执行，并运行模型连接、官方端点、模型 Gateway 以及
`src/acquisition-*-test.ts` 全部获客专项测试。新增获客测试会自动纳入该脚本，
不能靠遗漏测试文件规避回归。

受当前沙箱禁止监听本地 Socket 的限制，以下 HTTP 传输测试没有放入该脚本，必须在允许绑定 loopback 的本机或 CI 单独运行：

```bash
NODE_ENV=test \
JWT_SECRET='goodjob-acquisition-http-test-secret-at-least-32-characters' \
ACQUISITION_MASTER_SECRET='goodjob-acquisition-http-master-at-least-32-bytes' \
node --import tsx --test --test-concurrency=1 \
  src/model-connection-routes-test.ts \
  src/acquisition-plan-router-test.ts \
  src/acquisition-v1-router-test.ts \
  src/acquisition-runtime-bridge-test.ts
```

MySQL 专项测试也不在默认脚本中，需要可丢弃的独立测试数据库后运行，例如：

```text
acquisition-mysql-repositories-test.ts
```

任何测试都不能指向开发者或客户的真实业务数据库。

Task 8 闭环 E2E 使用 Playwright 自动启动 `4288` 内存后端和 `5288` 前端：

```bash
JWT_SECRET='goodjob-e2e-jwt-secret-at-least-32-characters' \
ACQUISITION_MASTER_SECRET='goodjob-e2e-master-secret-at-least-32-bytes' \
npm run test:e2e --workspace frontend -- ai-acquisition-loop.spec.ts
```

抖音平台化公开商机 E2E 使用严格 method + pathname fixture，任何未声明的
获客请求都返回 `501`。它验证默认/键盘平台选择、显式
`targetPlatform=douyin`、只允许站点查询、审批与 Run、Provider/
`sourcePlatform` 分离、S/A 作战卡、任务 hash 恢复、响应式无溢出和无自动外联写入：

```bash
JWT_SECRET='goodjob-e2e-jwt-secret-at-least-32-characters' \
ACQUISITION_MASTER_SECRET='goodjob-e2e-master-secret-at-least-32-bytes' \
npm run test:e2e --workspace frontend -- ai-douyin-platform-discovery.spec.ts
```

公开评论自动化 E2E 使用显式提交的 queued、running 和 `partial_success` 服务端
快照，验证 1440、1024、768 三个视口、评论证据回溯、刷新恢复、无横向溢出及
只读请求边界。它使用本地 fixture，不访问真实抖音：

```bash
cd /path/to/GoodJob-marketing-system-frontend
npm run test:e2e -- acquisition-comment-automation.spec.ts
```

授权可见评论读取 E2E 使用同一个真实获客详情 UI/controller/API 边界和本地页面消息
harness，严格模拟 `goodjob.visual-reader.bridge.v1`，不安装真实扩展、不打开抖音、
不访问外网。它覆盖 1440、1024、768、键盘授权、扩展缺失、DOM、受控 OCR、
低置信人工复核、停止、安全拒绝、刷新恢复、授权制品、过期制品和无横向溢出；
同时审计请求、日志、local/session storage 和 fixture 状态，确保没有原始截图、Cookie、
浏览器配置、私域动作或自动 CRM 转换：

```bash
cd /path/to/GoodJob-marketing-system-frontend
npm run test:e2e -- acquisition-visual-reader.spec.ts
```

该能力固定为 `authorized_visible_top_level_sample`。DOM/ARIA 完整正文不调用 OCR；
仅在用户允许制品、正文缺失或截断时，扩展才在内存中完成评论卡裁剪、遮挡和 OCR。
低置信、冲突、截断、安全失败和用户接管只进入人工复核，不产生自动资格或 CRM 事实。
候选 Evidence 只有在 provenance 为 `authorized_visual_observation` 且 `artifactId` 非空时
可查看遮挡 WebP。制品 404/到期后 Evidence ID 与 hash 仍保留。

真实 Chrome 兼容性检查只能作为手工 Beta smoke：操作者必须先设置
`GOODJOB_VISUAL_READER_SMOKE=1`，再亲自选择自己的公开视频并点击开始；没有开关就
停止，不能加入普通测试或 CI。终端或记录只允许会话状态、有界数量、提取方法和稳定
错误码，不得包含评论正文、昵称、主页标识、截图、Cookie、nonce 或其他个人字段。
在 Chrome 扩展程序页移除扩展即可卸载；卸载不会删除服务端 Evidence，遮挡制品按
服务端保留期到期。

真实抖音网络只允许通过显式 opt-in 的手工 Beta smoke 验证。缺少开关或数字视频
ID 时脚本会报明原因、不发请求；成功输出只包含有界计数、游标/覆盖摘要、制品哈希
和 Provider 版本，失败只输出稳定错误码，不输出完整评论者个人字段：

```bash
DOUYIN_VIDEO_ID='<公开视频数字 ID>' \
DOUYIN_PUBLIC_COMMENT_SMOKE=1 \
npm run smoke:douyin-public-comments --workspace backend
```

不要把该命令加入普通单元测试或 CI 快照。公开 endpoint 不可用时保持 Beta
熔断/受限状态，不补 Cookie、签名、代理或浏览器规避逻辑。

完整交接验收命令：

```bash
npm run test:contracts
npm run test:acquisition --workspace backend
npm run test --workspace backend
npm run test --workspace frontend
JWT_SECRET='goodjob-e2e-jwt-secret-at-least-32-characters' \
ACQUISITION_MASTER_SECRET='goodjob-e2e-master-secret-at-least-32-bytes' \
npm run test:e2e --workspace frontend -- ai-acquisition-loop.spec.ts
npm run test:e2e --workspace frontend -- ai-douyin-platform-discovery.spec.ts
npm run build
git diff --check
```

## 12. 已知运营限制

1. **“全网”不等于无限抓取。** 能发现的范围受搜索厂商索引、API 配额、地区、许可和公开可见性约束；系统不能保证覆盖中国每个平台或取得全部联系方式。
2. **搜索结果不是客户事实。** 未解析身份、缺少原始来源或证据过期的候选会被硬门禁阻断，仍需要研究或人工核验。
3. **外部 API 是至少一次语义。** 工具结果 Ledger 使用租约和 fencing token 防止旧 Worker 覆盖新结果，但进程在外部请求成功、结果落库前崩溃时，搜索厂商仍可能收到重复请求。运营侧应设置预算/配额并依赖请求指纹和审计排查。
4. **MySQL 计划仓库目前偏保守。** 为保证正确性，计划/运行事务使用全局 guard，并会在事务视图中锁定和装载较大的计划运行表；高租户、高并发部署前需要改为租户/聚合级锁和分页读取。
5. **跨仓库事务仍需强化。** 候选领域状态、工具审计、工具幂等和 CRM 转换跨越多个 Repository，目前不应宣传为跨进程、跨服务的全链路 exactly-once。高并发生产部署前应补统一 Unit of Work / Outbox 与故障注入测试。
6. **部署形态当前以单 API Runtime 为安全基线。** 在完成上面的细粒度事务与多节点抢占验证前，不建议横向扩展多个同时写入同一获客计划/候选的 API 实例。
7. **Socket 与真实 MySQL 验收要在 CI 补齐。** 沙箱中的专项脚本只证明进程内逻辑，不替代 HTTP、真实数据库、真实厂商测试环境和灰度配额验证。
8. **连接健康不代表业务质量。** API Key 测试通过只说明端点可访问；搜索质量、证据准确率、模型结构化输出率和转化效果需要按行业持续评估。
9. **公开评论只是一级有界样本。** 页面和销售材料不得写成全站、完整或实时连续
   监听；公开可见性、地域、频率、页面结构和 Provider Beta 状态都会改变本次覆盖。
10. **恢复扫描不是周期获客调度。** 当前 recovery sweeper 只接管已经存在的持久化
    execution；客户可在终态计划上手工“再次运行”，但尚无持久化日/周/Cron 调度器。

## 13. 上线前检查

- [ ] Node.js 版本满足 `>=22.19.0`
- [ ] 生产环境使用 MySQL，备份和恢复演练通过
- [ ] 所有生产密钥独立、稳定且至少 32 字符
- [ ] 9 个模型连接的官方端点校验与能力探测通过
- [ ] 实际使用的搜索连接已测试，预算和配额已设置
- [ ] 计划审批、版本漂移拒绝、暂停/恢复/取消已演练
- [ ] 企业与个人各完成一条“搜索到人工审核”的样例链路
- [ ] 抖音任务只产生 `site:douyin.com` / `site:iesdouyin.com` 限定查询
- [ ] 证据同时保留搜索 Provider、`sourcePlatform=douyin`、页面类型和原始 URL
- [ ] 视频、短链和评论式摘要不会被当成已验证个人身份
- [ ] 评论策略固定为 `experimental_public_sample` 和 `public_top_level_sample`，
      上限、Run 预算与一级评论边界均已展示
- [ ] `partial_success`、`no_public_comments`、访问受限与频率受限没有被解释成
      “没有客户”
- [ ] 手工 smoke 只在明确 opt-in 时运行，终端和快照不包含完整评论者个人字段
- [ ] 官方抖音授权连接器和持久化周期调度仍明确标记为后续能力
- [ ] 未解析身份、勿扰、明确拒绝、敏感数据和过期证据能被阻断
- [ ] CRM 转换必须依赖人工批准和准确 decision version
- [ ] `npm run test:acquisition --workspace backend` 与 TypeScript 编译通过
- [ ] HTTP Socket 测试和真实 MySQL 专项测试在 CI 通过
- [ ] 已确认系统没有自动外联、自动加好友或模拟真人动作入口

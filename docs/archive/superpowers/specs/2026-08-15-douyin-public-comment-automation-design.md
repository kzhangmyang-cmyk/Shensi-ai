# 抖音公开评论获客自动化设计

日期：2026-08-15

状态：已确认；公开评论链路已实现；授权视觉合同、存储与 API 已实现，
客户授权 UI、扩展/OCR 与下游投影待后续 Tasks

适用基线：GoodJob Growth 后端与 GoodJob Marketing System Frontend

## 1. 目标

让客户在获客中心明确感受到一条真实、可验证、无需逐步点击的自动化链路：

```text
创建抖音获客任务
→ 公开搜索或用户链接发现抖音视频
→ 自动读取可公开访问的一级评论样本
→ 标准化、去重并聚合同一公开主体的需求信号
→ 确定性规则与 AI 结合判断意愿
→ 实时展示执行步骤、数量、证据和失败原因
→ 人工核验高潜主体
→ 转入 CRM
```

本设计补齐公开评论数据入口和用户可见运行证据，不重写现有 Plan、Run、
Shard、Evidence、Candidate、Qualification、Battle Card、Review、CRM 和 ROI
领域能力。

第一阶段的“自动化”指：计划批准后，系统自动完成公开视频发现、评论样本读取、
事件标准化、候选聚合、意愿研判和结果展示；用户不需要逐条导入评论或逐条点击
评分。它不表示扫描整个抖音，也不表示绕过平台登录、验证码、访问控制或频率限制。

## 2. 方案比较与选择

### 方案一：整体部署现成 Python 抖音爬虫

优点是短期字段多、演示快。缺点是多数项目依赖登录 Cookie、浏览器自动化或已失效
的签名算法；部分许可证禁止商业使用或要求 GPL 派生代码开源；独立 Python 服务还会
复制 GoodJob 已有的任务、证据和恢复机制。不采用。

### 方案二：只等待抖音官方授权连接器

优点是长期能力和合规边界最清晰。缺点是应用审批、账号授权和接口能力存在外部依赖，
无法解决当前客户看不到自动获客过程的问题。官方连接器仍是后续增强路径，但不阻塞
公开评论样本能力。

### 方案三：复用允许商业使用的公开评论能力，接入 GoodJob 现有内核

从 Apache-2.0 项目中迁移公开、免登录、有限评论样本的读取和字段标准化；从 MIT 项目
中迁移采集器的去重、限流、重试和游标保护方法；所有持久化、评分、审核和 CRM 继续
由 GoodJob 权威领域模型负责。

该方案适配成本最低，许可证和数据覆盖范围可以明确说明，且能最快形成真实可解释的
自动化体验，是本次选定方案。

## 3. 开源复用边界

### 3.1 可迁移实现

1. `JNHFlow21/social-media-toolkit`，commit
   `ed2f3cbdc47e6761736e915cfeb1ce1fbb364d96`，Apache-2.0：
   - 抖音公开视频 ID 的公开一级评论样本请求；
   - 评论字段标准化；
   - 请求上限、只读来源和样本覆盖语义。
2. `jiji262/douyin-downloader`，commit
   `ad7338fdc474c14e2063370540a362cd8a953b43`，MIT：
   - 基于评论 ID 的页内去重；
   - 游标不推进时停止，防止无限循环；
   - 限速、重试、部分失败和测试用例组织方式。

生产代码若移植或改写上述实现，必须新增仓库级第三方声明，记录仓库、commit、
许可证、原文件、修改内容和用途；保留许可证要求的版权与声明。不得复制其登录
Cookie、私有签名、浏览器规避或代理池实现。

调研中使用新版本 Python 对两个候选分别执行了聚焦测试：`social-media-toolkit`
57/57 通过，`douyin-downloader` 评论与风险控制相关测试 56/56 通过。前者的评论端点
在真实公开视频 ID 上返回了结构化样本，但普通作品 URL 的元数据解析失败。因此实现
只能迁移经过验证的“视频 ID → 评论样本”窄能力，URL 解析继续复用 GoodJob 现有逻辑。

### 3.2 仅借鉴方法

- `VladUZH/harken`：来源适配器、统一事件、内容哈希去重、持久游标和运行指标；
- `obsei/obsei`：Source/Analyzer/Sink 职责分离；
- `activepieces/activepieces`：步骤级运行时间线、重试和连接状态体验；
- `suhasbhairav/ai-agents-for-marketing`：证据优先、可见执行轨迹和人工审批体验；
- `NanmiCoder/MediaCrawler`、`JoeanAmier/TikTokDownloader`：只研究字段和故障场景，
  不复制受非商业许可证或 GPL 约束的代码。

不引入新的工作流引擎或 CRM。Activepieces、n8n、Twenty、Frappe CRM 等会与现有
GoodJob 能力重复，并增加许可证、部署和数据一致性成本。

### 3.3 BrowserAct 授权浏览器视觉读取边界

`browser-act/skills`，commit
`8f287271faa0c1df79a44578cb059102ff004da2`，MIT，可作为授权浏览器读取流程的参考。
该版本只有依赖已登录抖音会话的 `douyin-video-search`，没有抖音评论采集 Skill；其
脚本通过浏览器内 `fetch(..., { credentials: "include" })` 调用搜索接口。BrowserAct
入口 Skill 只是发现桩，真实运行指令由另行安装的 `browser-act-cli` 动态提供；仓库说明
的完整能力还包含隐身指纹、代理轮换和验证码处理。因此仅审查该 GitHub 仓库不足以把
CLI 作为 GoodJob 生产依赖，现阶段不复制其脚本、不安装进后端，也不复用反检测能力。

默认关闭的 `authorized_browser_visual_reader` 服务端合同、存储与授权 API 已实现；
客户侧授权 UI、扩展/OCR 和下游投影由后续 Tasks 实现。完整边界只允许在客户明确
授权的本地浏览器会话中发现公开视频 URL，并读取当前页面实际可见的一级评论卡：

- 浏览器配置、Cookie、登录凭据、完整页面截图和网络响应留在客户设备，不上传到
  GoodJob；
- 读取顺序固定为 DOM/无障碍树文本优先，评论卡截图 OCR/视觉模型兜底；两条路径都只
  读取当前视口或有界滚动后真实出现的内容，不调用逆向签名接口；
- 连接器可提交规范化视频 URL、可选公开标题、搜索词、采集时间和来源版本；对评论卡
  额外提交可见正文、公开昵称、可见时间、公开点赞/回复数、提取方法和识别置信度；
- 完整截图只在客户侧短暂处理；需要视觉证据时，只上传裁剪后的评论卡，并在客户侧先
  遮挡头像、无关账号、导航和通知区域；
- OCR 优先在客户侧执行；只有客户已批准的视觉模型连接允许接收遮挡后的评论卡裁剪，
  且请求不得包含完整页面、Cookie、浏览器配置或同视口的其他账号内容；
- 服务端再次执行主机、协议、视频 ID、数量、租户、幂等与预算校验；
- 发现的 URL 进入现有公开链接导入和评论富化链路；视觉评论先写入独立、可审计的观察
  证据，浏览器连接器不直接写候选或资格结论；
- DOM 中存在真实平台评论 ID 时，服务端才可按普通评论事件验证并升级；只有视觉文字
  而没有真实评论 ID 时不得伪造 `platformEventId`，保持视觉观察证据和 `needs_research`；
- 不允许输入、表单提交、评论、私信、点赞、关注、发布、文件上传、代理切换、验证码
  处理、Cookie 导入导出或指纹配置；允许的交互仅限打开评论区、滚动评论容器和展开
  当前评论卡的只读内容；
- 连接器不可用、用户未授权或页面要求新增验证时安全停止，不影响免登录公开搜索和
  用户链接入口。

实现优先采用 GoodJob 自有的窄输出协议和客户侧进程边界。只有 BrowserAct CLI 的精确
版本、制品哈希、实际传输行为和供应链完成独立审查后，才可把它列为客户侧可选执行器；
无论执行器如何替换，服务端只信任上述有界 URL 与视觉观察投影。

## 4. 数据入口与覆盖语义

公开评论链路支持两种默认真实入口；第三种默认关闭的可选授权入口已具备服务端合同、
存储与 API，但在客户侧授权 UI 和扩展/OCR 完成前不开放使用：

1. 公开搜索 Provider 发现的抖音视频 URL；
2. 用户在获客中心提交的公开抖音视频 URL 或短链。
3. 默认关闭的客户侧授权浏览器视觉读取器提交的抖音视频 URL 和可见评论观察；该入口
   扩展视频发现与公开端点失效时的可见样本覆盖，但不改变资格研判的权威链路。

前两种 URL discovery 入口进入公开评论 Provider 流水线：系统先使用现有抖音 URL 分类
和短链研究能力解析 `videoId`，再调用公开评论样本 Provider。不能因为作品元数据解析
失败就放弃一个已经可以从 URL 确定的数字视频 ID。

授权浏览器入口不经过公开评论 Provider。服务端验证已授权视觉读取会话、Run/Plan 归属、
受控来源 URL 与 `videoId` 动态一致性后，把 `authorized_visible_top_level_sample` 下的
`douyin.visual-comment-observation.v1` 直接写入视觉观察持久链路。它不会把视觉观察冒充
公开端点评论结果，也不会在缺少可验证平台评论 ID 时写入 `douyin.comment.v1`。

当前候选实现使用的是可匿名访问、但未作为抖音开放平台正式能力发布的分享端点。
因此该 Provider 必须标记为 `experimental_public_sample`，保持可替换、可熔断，并先以
受控 Beta 能力开放。它没有稳定性承诺，不能取代客户授权的抖音官方连接器；商业发布
前还需完成针对当时平台条款和数据合规要求的复核。

每次结果必须记录以下覆盖信息：

- `coverage = public_top_level_sample`；
- 请求数量和实际返回数量；
- 是否包含二级回复正文；
- 来源端点版本和采集时间；
- 作品报告的评论总量（可以获得时）；
- `accessStatus = public_content | access_restricted | unavailable`。

授权浏览器视觉观察使用不同覆盖语义
`coverage = authorized_visible_top_level_sample`，并额外记录 `extractionMethod = dom |
accessibility | ocr | vision`、识别置信度、视口、裁剪制品哈希、读取器版本和客户侧
采集时间。该覆盖不能冒充免登录公开端点结果，也不能在没有真实评论 ID 时写入
`douyin.comment.v1`。

视觉评论观察使用独立的 `douyin.visual-comment-observation.v1`，至少包含：

```text
observationId               GoodJob 视觉观察 ID
sourceUrl                   当前抖音视频 URL
videoId                     从受控 URL 解析出的 aweme_id
visibleText                 DOM/OCR 实际读取的文字，不由模型补写
textHash                    visibleText 标准化哈希
displayName                 评论卡可见公开昵称，可为空
visibleTimeText             页面可见时间原文，可为空
likeCount/replyCount        页面可见且可可靠解析时填写，否则为空
platformCommentId           DOM 中可验证的真实评论 ID，可为空
publicProfileUrl/secUid     评论卡公开链接中可验证时填写，否则为空
extractionMethod            dom | accessibility | ocr | vision
fieldConfidences            每个提取字段的 0..1 置信度
viewportHash                当前视口去重哈希
redactedCropHash            遮挡后评论卡制品哈希，可为空
readerVersion               客户侧读取器版本
capturedAt                  客户侧采集时间
```

同一 Run 内以 `sourceUrl + viewportHash + 评论卡边界 + textHash` 去重。由于虚拟列表会复用
DOM 节点，这个指纹不能作为跨 Run 平台身份；没有真实评论 ID 时仅形成视觉观察证据。
DOM/无障碍树与 OCR 结果一致时提高置信度；两者显著冲突、文字被截断或任一关键字段低于
阈值时标记 `visual_extraction_low_confidence`，保留原始可见片段但不进入自动资格判断。
视觉模型只能转录和定位，不允许根据上下文补全不可见文字。

免登录 Provider 结果只能称为“公开评论样本”，授权浏览器结果只能称为“授权浏览器
可见样本”。两者都不得展示“全量评论”“扫描整个抖音”或暗示已经读取当前会话不可见
的内容。二级回复第一阶段只保留公开返回的回复数量，不读取回复正文。

## 5. 平台事件契约

公开评论先保存为不可变平台事件，再聚合为候选信号。不得把原始评论直接写成已核实
客户。

`douyin.comment.v1` 至少包含：

```text
eventId                     GoodJob 事件 ID
platform                    douyin
eventType                   comment
platformEventId             cid / comment_id
videoId                     aweme_id
parentCommentId             第一阶段固定为空
text                        评论公开原文
textHash                    原文标准化哈希
occurredAt                  评论发布时间
capturedAt                  系统采集时间
likeCount                   公开点赞数
replyCount                  公开回复数
ipLabel                     公开显示的粗粒度 IP 地区标签，可为空
actor.displayName           公开昵称
actor.handle                公开抖音号或短号，可为空
actor.secUid                公开稳定主体标识，可为空
sourceUrl                   原视频公开 URL
coverage                    public_top_level_sample
accessStatus                public_content
providerVersion             Provider 与实现版本
rawArtifactHash             原始响应制品哈希
```

幂等键固定为 `ownerId + teamId + platform + platformEventId`。缺少评论 ID 的记录不创建平台
事件。相同评论重新读取时只新增采集观测，并把 Run 事件关联固定到当次观测；同 Run 的公开计数投影取该 Run 关联的最新观测，后续 Run 不改变历史 Run 快照，且不修改历史原文；原文变化时
以新证据版本关联旧事件，不能静默覆盖。

采集观测的 `rawArtifactHash` 指向当次 Provider 原始页面制品。事件仓储同时
持久化以 `ownerId + teamId + eventId + textHash` 为唯一边界的内容版本，保留该
文本哈希第一次观测的精确公开原文、观测 ID、页面 `rawArtifactHash`、
发布时间、公开主体和 Provider/来源上下文。Discovery Evidence 从该持久
内容版本构造：`sourceSnippet` 保留有界精确原文，`rawArtifactHash` 引用
真实首次页面制品。因此同一 `eventId + textHash` 在后续不同页面制品中
仍产生字节等价证据；当次观测仍可独立追溯至它自己的页面制品。候选
主体只取已持久化的不可变事件，不使用未持久化的后续观测主体。

事件、观测、内容版本和 `pending` ingestion saga 先在事件仓储的同一本地
事务中持久，作为进程重启后的恢复依据。随后证据、Domain 幂等记录、
候选及其目录索引、事件链接和 saga `committed` 由 ingestion unit of work 在同一
原子边界内提交。内存组合对 Domain、事件仓储和候选目录使用共享的串行化
快照事务；MySQL 组合使用同一连接和同一数据库事务。Domain 侧或事件 commit
侧任一失败都回滚整个完成边界：已批准候选、证据、审计、幂等记录和目录
恢复为失败前快照，且不产生 Run 成功事实。

内存完成边界和独立个人信号入库统一按
`CandidateDirectory → Domain → Events` 取锁，嵌套事务复用已激活上下文。
Domain、事件仓储和候选目录的独立写方法也进入各自事务的同一串行队列，
避免共享快照回滚覆盖并发成功写。MySQL 完成边界使用的命名锁必须验证
`RELEASE_LOCK` 返回值严格为 `1`；查询失败、`0` 或 `NULL` 都将该连接标记为
不可复用并销毁，不能放回连接池。旧 saga 表通过
专用连接上的固定 migration advisory lock 串行表创建、
`information_schema.columns + DATABASE()` 缺列检查/回填，以及
`information_schema.statistics` 中按 `seq_in_index` 校验的 pending 索引。
无索引或旧 `(status, created_at, saga_id)` 索引仅通过代码内固定
白名单 SQL 重建为
`(status, next_attempt_at, lease_expires_at, created_at, saga_id)`；并发启动的
后续者取锁后重读状态。schema 完成后才能启动首次 recovery sweep。

重启恢复通过持久的 `attemptCount`/`nextAttemptAt` 和有时租约领取 `pending` saga。
单个工作项失败只保存非 PII 错误码并指数退避，不阻塞后续租户；MySQL
使用 `FOR UPDATE SKIP LOCKED`，内存实现保持相同的单次领取语义。应用启动时
立即执行一次 sweep，之后定时扫描，关闭时停止计时器并等待活动 sweep。
Recovery 诊断回调只接收稳定 code、stage、attempt 和不可逆 saga hash，
不接收原始 `Error`/message/stack、评论正文、公开主体标识或来源 URL；
诊断回调自身失败不影响工作项隔离和持久退避。

`ipLabel` 只用于证据展示和用户配置的地区匹配，不得推断民族、健康、政治、宗教、
收入等敏感属性。第一阶段不保存或展示评论者头像，不下载人脸资产，也不做人脸识别。

## 6. 主体聚合与意愿研判

### 6.1 主体聚合

- 有 `secUid` 时，以 `douyin:sec_uid:<value>` 作为公开主体稳定键；
- 只有 handle 时使用低置信度临时键，并保持 `needs_research`；
- 两者都没有时按评论事件生成不可合并信号，不能猜测身份；
- 同一主体在多个视频、评论和时间点的事件进入同一时间窗聚合；
- 后续需求信号以显式阶段顺序只升不降，摘要有界去重保留，负向代码稳定并集，
  且不覆盖已有主体身份字段；
- 任何自动合并都保存依据和置信度，并支持人工拆分或确认。

### 6.2 确定性信号

先用可审计规则提取：

- 明确询价、报价、预算、采购、供应商、加盟、合作、试用、交付时间；
- 业务痛点、寻找方案、比较选择、重复互动；
- 明确拒绝、勿扰、不需要、反营销和风险词；
- 纯表情、无业务语义、抽奖互动和重复灌水等噪音。

规则只产生信号，不直接把单条“多少钱”评为高意向客户。

### 6.3 AI 资格判断

现有 Qualification 读取聚合事件和其他公开证据，输出：

- S/A/B/C/D 等级、分数和置信度；
- 需求类别与购买阶段；
- 支持证据、反证和未知项；
- 推荐动作和不建议动作；
- 是否需要身份研究或人工审核。

高意向展示至少要求可靠的需求证据；转入 CRM 仍要求主体核验和人工确认。身份未核验
但信号较强的记录显示为“高潜需求信号”，不能显示为“已确认客户”。

高置信度视觉观察可以进入相同的确定性意愿规则和 Qualification，但只能由服务端从已
持久化视觉证据生成候选信号。缺少真实评论 ID 时候选保持 `needs_research`；缺少可验证
`secUid`/公开主页链接时还必须使用不可合并主体，不能依据相同昵称跨观察合并。低置信度
视觉观察只进入人工复核，不参与自动资格评分。

## 7. 自动运行与调度

计划批准后由现有 Run/Shard/Worker 执行：

```text
discover_video_urls
→ resolve_video_ids
→ fetch_public_comment_samples
→ read_authorized_visible_comments（仅在客户明确启用，且公开样本不可用或用户显式运行时）
→ persist_visual_observations（仅在产生视觉读取结果时）
→ normalize_platform_events
→ aggregate_actor_signals
→ qualify_candidates
→ refresh_run_presentation
```

每一步使用稳定幂等键。单个视频失败不终止整个 Run；已经取得的评论仍可继续进入研判。
第一阶段提供一次完整自动 Run 和显式“再次运行”。周期性计划只有在现有计划调度契约
能够持久化频率、暂停和预算时才启用，不用前端计时器伪造持续运行。

预算至少限制：发现 URL 数、视频数、每视频评论样本上限、HTTP 请求数、模型调用数、
总时长和费用。系统不得通过切换账号、代理或模拟真人来绕过来源限制。

搜索分片只在搜索响应完成严格验证后，从 Evidence provenance 中选取
可确定作品 ID 的抖音直链。Evidence 必须完整包含当前连接、当前查询、Provider、
结果序号、来源 URL、owner/team 作用域和公开访问语义；只有 `sourceUrl` 的伪造对象
不会触发评论读取。Run worker 使用仅内部可见的 tenant-scoped Evidence projection，
普通工具返回仍移除 owner/team。HTTP 重试按真实 transport 次数计入 requests，
包括成功 HTTP 后 JSON、payload、normalize 或 source 验证失败；剩余预算同时传给 Provider。跨页评论
去重和游标循环检测只存在于当次 enrichment。评论候选与搜索候选去重后，再进入现有
candidate pipeline。单个作品限流或受限时，已有评论结果保留且分片为
`partial_success`；`no_public_comments` 是可解释空覆盖，不计失败结果，全部为空时为
`succeeded_empty`。计划未启用评论策略或来源不是抖音作品时安全跳过。

用户显式创建的单独抖音 content-fetch 不需要 Run，但仍通过同一 Provider、
事件仓储和 ingestion service 保存事件、证据与待核验候选；该显式入口固定限制为
1 个视频、每视频 30 条、最多 3 页。显式创建在 content-fetch operation 首次写入时
同时持久 standalone intent。原页抓取与评论富化是两个独立事实；每个 direct 或
`runId + shardId` 上下文分别持久策略、剩余预算、租约、尝试次数、退避时间和终态
summary，不能复用另一调用方的 summary。恢复 worker 在启动和定时 sweep 中按租户
隔离领取 pending execution，失败项退避且不饿死后续租户；无需调用者重放。公开响应
只投影对应调用方结果，不暴露内部 execution、policy、budget 或 lease。无 Run 的其他
后台工作不会自动扩展评论读取。standalone intent 纳入版本化不可变 request hash；
同一幂等键切换 intent 会冲突。原页抓取失败或无 final URL 时，已领取的评论 execution
以 `BASE_CONTENT_FETCH_FAILED` 终止，不再进入恢复。单 operation 最多保留 1000 个调用方
execution；MySQL 读取对确定性 ID、direct/Run context 及全部状态/租约组合严格 fail-closed。

每个视频的首次终态 fetch attempt 持久真实 transport 用量、耗时、event/evidence/candidate
标识和聚合计数。相同 Run context 精确重放直接聚合该终态投影，MySQL 进程重启或公开评论
发生变化都不会再次请求 Provider 或 ingestion。旧 attempt 没有可选投影时，仅保守使用
已持久的终态计数，不静默重抓。

计划连接只接受规范 ID `douyin-public-comments`，并同时要求
`experimental_public_sample + content_fetch + active + credentialVersion=1`；执行仍只使用
application 固定注入 Provider。Content-fetch MySQL schema 在 recovery 启动前通过专用
连接和固定 advisory lock 串行升级，锁获取或释放失败销毁会话而不放回连接池。
公开 `candidateCount` 必须与去重后的 `candidateIds` 长度精确一致。

授权浏览器视觉读取必须是显式连接、显式运行或客户侧计划触发，不能由 GoodJob 后端
静默接管本地 Chrome。首次连接、会话变化和每次批量运行都留下租户隔离审计；撤销
授权后立即停止新读取，不影响已持久化的公开 URL、评论事件和证据历史。

视觉读取预算独立限制每 Run 视频数、每视频可见评论数、评论容器滚动次数、OCR/视觉
调用次数和总时长。相同视口或相同评论卡指纹只处理一次；连续两次滚动没有新增卡片、
达到预算、页面离开目标视频、出现登录/验证码/安全验证或用户接管时立即停止。

## 8. 前端自动化体验

保留当前深绿/暖白商务视觉语言，获客中心的第一工作区调整为：

1. **任务输入区**：行业、地区、产品、目标客户、需求关键词和公开数据来源；
2. **自动运行时间线**：展示服务端真实步骤、当前状态、开始时间、耗时和部分失败；
3. **实时计数带**：发现视频、读取评论样本、有效需求信号、待核验主体、高潜信号；
4. **高潜评论列表**：评论原文、公开主体、视频来源、时间、意愿等级、理由和置信度；
5. **证据抽屉**：原视频链接、原始评论、字段、覆盖范围、证据版本和 AI 判断引用；
6. **人工接管区**：核验身份、忽略、加入勿扰、转入 CRM。

所有动画和进度只反映后端事件。没有任务时展示可执行的任务创建入口；连接缺失时展示
配置搜索来源；只导入公开链接时，也要自动完成后续评论读取和研判。真实模式禁止使用
定时器递增数字、预置客户、伪造执行步骤或把演示数据混入真实统计。

视觉读取结果必须标记“授权浏览器可见样本”，与“免登录公开评论样本”分开计数和筛选。
低置信度卡片显示识别方法与待复核状态；用户可以查看遮挡后的评论卡证据，但不能从
前端取回完整页面截图或浏览器会话数据。

## 9. API 与投影

优先扩展现有版本化 Acquisition API，不创建平行 REST 体系：

- Run presentation 固定返回七个自动化步骤。只有不可变计划版本为抖音且明确启用公开
  评论样本时步骤才适用；其他 Run 七步均返回 skipped，普通网页搜索分片不冒充视频发现。
  发现步骤时间只取 `shard.started` 与终态 shard 事件，评论读取时间只取 fetch attempt；
  标准化、主体聚合、资格研判和刷新没有独立生命周期事实时起止时间与耗时均为 null；
- Run summary 聚合整个 Run 的 fetch attempt（含第 101 条及以后），candidate ID 与信号事实
  使用 10000 条硬保护，不用 50 条展示窗口反推。有效需求重新读取不可变事件分类并排除
  negative 与 `do_not_contact`；未核验主体按已聚合的稳定公开主体跨视频、跨页去重。event
  已持久化但 saga/link 未提交时，主体聚合保持 pending/partial_success；
- 高潜评论仅在租户范围内 individual candidate、Evidence 均真实存在、candidate 拥有该
  evidenceId，且 Evidence 的 platform、access status、content hash、provider version、coverage、
  platform event ID 和 source URL 逐项精确对应当前事件时公开。Candidate 的严格 secUid、
  规范化 handle 或 comment-scoped key 还必须与事件主体一致；悬空 candidate、悬空
  Evidence、交叉链接和主体错配全部 fail closed。最新评论独立限制 50 条，不挤占候选签名游标，也不返回头像；
- Candidate/Evidence 读取投影增加平台事件和意愿证据；
- 公开链接导入响应固定返回持久化 `commentSampleSummary`，包含实际事件、证据、
  候选、usage 和部分失败错误；排队中或旧数据为 `null`；
- 候选列表支持按 `sourcePlatform=douyin`、意愿等级、身份状态和 Run 筛选；
- 所有写请求继续遵守现有鉴权、CSRF、幂等和并发契约。

OpenAPI、JSON Schema、生成类型、错误码和前端 ViewModel 必须同步更新。前端不能根据
评论文案自行计算权威分数或制造平台事件。

## 10. 错误与恢复

至少区分：

- `public_sample_unavailable`：公开视频存在，但公开评论样本暂不可用；
- `access_restricted`：来源要求登录、验证码或其他受限访问；
- `rate_limited`：来源限流，按服务端退避时间重试；
- `video_id_unresolved`：URL 无法确定作品 ID；
- `source_payload_invalid`：公开端点返回结构变化或非法数据；
- `partial_success`：部分视频失败，已有评论和判断仍有效；
- `no_public_comments`：成功访问但当前没有公开评论，不按系统错误处理；
- `model_output_invalid`：AI 输出不满足结构化契约，保留规则信号并进入可重试状态；
- `authorized_browser_unavailable`：已启用授权浏览器视觉读取，但客户侧连接器当前不可用；
- `authorized_browser_input_invalid`：连接器提交了非抖音 URL、无效视频 ID、超限或不满足
  窄输出协议的数据；
- `visual_comment_unresolved`：页面中可见评论文字已提取，但缺少真实评论 ID，保留为待
  核验视觉观察证据，不按平台事件处理；
- `visual_extraction_low_confidence`：OCR/视觉结果低于阈值，不进入自动资格判断，仅供
  人工复核。

HTTP 请求使用短超时、有限指数退避、来源级限流和熔断。错误日志不得包含凭据、完整
Cookie 或不必要的个人数据。Provider 失效时任务明确降级，不能回退到浏览器自动登录、
逆向签名或另一个未经用户授权的数据源。

## 11. 测试与验收

### 11.1 自动测试

1. URL 和视频 ID 解析：普通链接、分享链接、短链、恶意主机和无效 ID；
2. Provider 合同：字段标准化、请求上限、空样本、限流、超时和响应结构变化；
3. 平台事件：幂等、原文版本、同主体聚合和缺失身份；
4. 意愿判断：询价、方案研究、采购准备、否定信号、噪音和反证；
5. Worker：部分失败、重试、暂停、恢复、取消、预算耗尽和游标卡死；
6. API/OpenAPI：真实响应与生成类型一致；
7. 前端：真实时间线、计数、高潜列表、证据抽屉和人工接管；
8. E2E：创建任务后自动完成“视频 → 评论 → 信号 → 资格判断 → 证据展示”，全程无
   伪造请求或演示数据。
9. 视觉读取：DOM、无障碍树、OCR、视觉转录、虚拟列表节点复用、截图遮挡、低置信度、
   用户中止和缺少真实评论 ID。

自动测试只使用本地 fixture，不访问真实抖音。另保留一个不进入 CI 的人工公开链接
烟雾测试，用于确认公开端点仍可用并记录检查时间。

### 11.2 验收标准

1. 客户创建并批准任务后，不再需要逐条粘贴评论或逐条点击 AI 评分；
2. 真实页面能看到服务端执行中的步骤、耗时、数量和错误；
3. 每条高潜信号都能打开原视频和原始评论证据；
4. 页面分别显示“公开评论样本”或“授权浏览器可见样本”及实际覆盖数量；
5. 身份待核验记录不会冒充已确认客户；
6. 有真实评论 ID 的同一评论重复运行不会创建重复事件或重复候选；视觉观察缺少真实
   评论 ID 时不做跨 Run 平台去重承诺，并在前端明确其观察级身份；
7. 单视频失败不会丢失其他视频结果；
8. 没有公开评论时显示真实零结果，不填充演示评论；
9. 受限访问不会触发登录绕过、验证码规避或 Cookie 抓取；
10. 许可证声明、OpenAPI、产品文档和测试基线全部同步。
11. 授权浏览器视觉读取启用时只增加公开视频 URL 和真实可见的评论观察；上传请求和
    制品中不存在 Cookie、登录凭据、完整页面截图、浏览器指纹、验证码响应或平台写
    操作。
12. DOM/无障碍树与 OCR/视觉路径分别有确定性 fixture；低置信度、重复视口、虚拟列表
    复用节点、缺少评论 ID、头像遮挡和用户中止均有自动测试。

## 12. 非目标与后续阶段

第一阶段不包括：

- 全量或无限翻页抓取抖音评论；
- 二级回复正文抓取；
- 登录 Cookie 托管；
- 完整浏览器页面截图上传或长期保存；
- 自动评论、自动私信、自动关注或群发；
- 绕过验证码、签名、平台频率或访问限制；
- 将公开昵称自动推断为真实姓名、企业或联系方式。

后续通过客户自己的抖音开放平台应用和正式授权连接器增加官方数据、游标同步、Webhook
和允许动作。官方连接器与公开评论样本 Provider 共用同一平台事件、候选、评分、审核、
CRM 和 ROI 模型，不建立第二套获客系统。

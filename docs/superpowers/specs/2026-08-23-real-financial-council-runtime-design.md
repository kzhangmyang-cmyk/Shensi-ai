# 真实财务多智能体闭环设计

**状态：** 实施完成，真实供应商验收待凭据

**日期：** 2026-08-23

## 1. 背景与当前事实

黑色 `#agents` 智能体中心已经成为唯一产品前端，当前展示六位经营顾问：

- AI 经营总管；
- 财务分析；
- 利润分析；
- 成本分析；
- 现金流分析；
- 税务健康。

当前开发服务器没有配置 `VITE_API_TARGET`，因此认证和智能体首页仍运行在演示模式。代码库内已经存在真实的 Financial Council 领域、MySQL repository、模型网关、五位专业智能体、交叉审计与反驳、CFO 共识、三组合优化、人工审批、草稿派发和恢复 worker。本阶段不重写这些能力，而是完成生产运行配置、模型路由、真实财务数据入口以及黑色前端的完整接线。

本机已经安装并启动 MySQL Community Server 8.4.11，实际监听端口为 `3307`。仓库 `.env.example` 仍以 `3306` 为示例，且当前终端没有配置 `DATABASE_URL`、`MYSQL_URL` 或 `MYSQL_TEST_ADMIN_URL`。实施必须显式完成账号、端口和运行环境接线，不能用 Memory 或 fake MySQL 冒充真实验收。

## 2. 目标

1. 让黑色智能体中心使用真实登录、真实企业工作区和真实 MySQL 数据。
2. 支持 OpenAI、DeepSeek、Kimi、通义、智谱、豆包、MiniMax、混元和千帆等现有 OpenAI-compatible 供应商。
3. 由系统按角色自动选择模型，管理员可以固定主模型和备用模型。
4. 通过上传资产负债表、利润表和现金流量表启动真实六智能体分析。
5. 保存每个任务的模型、凭据版本、输入、提示词、Schema 和结果身份，保证可审计与可恢复。
6. 让五位专家交叉检查，由 AI 经营总管汇总共识、少数意见和三套最佳组合。
7. 人工审批后只生成行动草稿和待办，不自动执行外部财务操作。
8. 用真实 MySQL、真实模型供应商和无网络拦截浏览器完成纵向验收。

## 3. 已确认的产品裁决

- 所有已支持模型供应商都可配置，不把产品绑定到单一供应商。
- 每次任务只调用该角色选中的主模型；仅在可重试失败时切换备用模型，不让所有供应商重复生成同一结果。
- 自动路由综合结构化输出能力、近期成功率、P95 延迟、调用成本和角色适配度。
- 管理员覆盖优先于系统推荐，普通使用者不能修改工作区模型路由策略。
- 第一条真实数据链路采用上传财务报表，不在首期接 ERP 或财务软件。
- 审批后的动作只形成草稿和待办，禁止直接付款、报税、记账、发送外部消息或修改外部系统。
- 原始 Excel 第一阶段不长期保存；只保存文件哈希、来源元数据、解析结果和不可变数据版本。

## 4. 开源方案评估

### 4.1 TradingAgents

[TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) 使用 Apache-2.0，维护活跃，提供专业角色分工、研究员辩论、结构化输出、决策日志和 checkpoint resume。可借鉴：

- 专家结论进入对立检查后再由管理角色决策；
- 每个节点持久化状态，崩溃后从最后成功节点恢复；
- 模型供应商与角色解耦。

不直接复用其代码：该项目以股票交易为领域，运行时是 Python/LangGraph，直接接入会引入第二套编排和部署体系。

### 4.2 FinRobot

[AI4Finance-Foundation/FinRobot](https://github.com/AI4Finance-Foundation/FinRobot) 使用 Apache-2.0，提供 Director Agent、专业角色注册、多模型调度和专业报告生成。可借鉴：

- 调度器基于角色能力选择模型；
- 分离数据感知、分析推理和行动输出；
- 多供应商作为基础设施能力，而不是写死在智能体内。

不直接复用其代码：其重点是证券研究、估值和交易，且包含 Python notebook、外部市场数据和独立 Web 服务，与当前企业内部经营财务领域和 TypeScript 运行时不匹配。

### 4.3 OpenAI Agents JS、CrewAI 与 AutoGen

[OpenAI Agents JS](https://github.com/openai/openai-agents-js) 的 handoff、guardrail、session 和生命周期可作为 TypeScript 设计参考。CrewAI 提供 Crews/Flows 和股票分析示例；AutoGen 提供通用多智能体编排，但 AutoGen Studio 官方定位仍偏原型而非生产应用。

本阶段不引入新的智能体框架。现有代码已经具备更严格的工作区隔离、不可变快照、租约 fencing、原子持久化和恢复语义。替换框架会重复实现并扩大安全面。只吸收以下模式：

- 每个角色使用独立结构化合同；
- 每个模型调用前后都有确定性校验；
- handoff 只传递最小、已验证的数据切片；
- 中断、重试、恢复和最终输出必须保持同一状态机语义。

## 5. 总体架构

```text
真实登录与企业工作区
          ↓
财务报表上传、预览、确认
          ↓
Finance Import + Verified Ledger
          ↓
不可变 Financial Snapshot
          ↓
工作区模型路由策略
          ↓
财务 / 利润 / 成本 / 现金流 / 税务专家
          ↓
交叉审计与一次反驳
          ↓
AI 经营总管共识与少数意见
          ↓
确定性约束 + 三组合优化
          ↓
人工编辑、审批
          ↓
行动草稿与待办回执
```

领域公式、硬约束、方案评分、审批和执行边界继续由服务器确定性代码控制。模型只负责结构化专业分析、反驳和叙事，不得自行计算或覆盖服务端权威金额、比例、哈希、状态或动作权限。

## 6. 运行环境与真实模式

### 6.1 MySQL

- 使用本机 `127.0.0.1:3307` 的 MySQL 8.4.11。
- 创建仅供 Shensi Sales 使用的数据库和最小权限账号，不使用 root 运行应用。
- 本地真实环境通过 Git 忽略的环境文件或启动器注入 `DATABASE_URL`；不得提交真实密码。
- `CRM_STORE=mysql` 时，后端启动失败必须 fail closed，禁止回退到内存。
- Financial Council、Finance Import、verified ledger、模型连接、调用账本、审批、派发和草稿全部使用同一真实 MySQL 生命周期。

### 6.2 前后端

- 后端继续绑定 `127.0.0.1:4188`。
- 前端通过 `VITE_API_TARGET=http://127.0.0.1:4188` 启动真实模式。
- 登录使用真实 session cookie、CSRF 和 `/api/auth/*`，不写入 demo session。
- Growth bootstrap 必须返回与前端固定版本一致的合同、工作区和 capability。
- `#agents` 仍是唯一首页；进入智能体详情或委员会工作台时复用同一黑色壳。

## 7. 财务资料入口

### 7.1 支持范围

必需输入：

- 资产负债表；
- 利润表；
- 现金流量表。

可选输入：

- 产品利润明细；
- 客户利润与应收明细；
- 成本明细；
- 税务风险资料。

### 7.2 上传流程

1. 浏览器只负责读取工作簿和生成结构化 sheet rows，不在本地决定财务事实。
2. 后端执行 closed-schema 解析、单位/币种/期间校验和完整性检查。
3. 前端展示标准化预览、警告和无法计算项。
4. 用户确认后才创建 Finance Import，并写入 verified ledger。
5. 每次确认生成不可变数据版本、文件哈希、解析器版本和导入时间。
6. Financial Snapshot 只从已验证的工作区事实构建，不能直接信任浏览器 DTO。

原始 Excel 不写入长期业务表。若后续需要审计文件留存，应作为独立的加密 artifact 能力设计，不在本阶段隐式增加。

## 8. 模型连接中心

复用现有 Model Connection、凭据版本、能力快照、激活事件和调用账本：

- 供应商：`openai`、`moonshot`、`minimax`、`zhipu`、`deepseek`、`qwen`、`doubao`、`hunyuan`、`qianfan`；
- API Key 只在创建或轮换时提交，后端加密保存，前端之后只显示掩码；
- 连接测试包括认证、模型列表、结构化 JSON 输出、超时和端点身份；
- 同一 owner/team 可以有多个 `active` 连接，但只有一个内部 `default`；旧版非财务任务只绑定该默认连接，财务路由在全部合格 `active` 连接中选择主连接和最多两个有序备用；
- 只有 `active` 且 `structuredOutput=true` 的连接可以参与财务路由；
- 自定义 URL 必须经过已有 SSRF、DNS、TLS 和 endpoint profile 规则；
- 测试失败不能自动激活连接。

## 9. 工作区模型路由策略

新增 `FinancialCouncilModelRoutingPolicy`，按工作区版本化，至少包含：

- `policyVersionId`、`workspaceId`、`revision`、`status`；
- 六个角色：`cfo`、`finance`、`profit`、`cost`、`cashflow`、`tax`；
- 每个角色的 `mode: auto | pinned`；
- 可选 `primaryConnectionId`；
- 最多两个有序 `fallbackConnectionIds`；
- 工作区默认最大单次预算、角色预算和超时；
- 创建人、更新时间和 ETag/If-Match 版本。

管理员可以固定连接，但不能绕过以下硬规则：

- 连接属于当前 owner/team；
- 连接已激活；
- 结构化输出能力通过认证；
- 模型端点身份与凭据版本有效；
- 连接没有被禁用或撤销。

### 9.1 自动评分

第一版使用透明、确定性的评分，不使用另一个模型选择模型：

- 结构化输出能力：硬门槛；
- 近 30 次同角色调用成功率；
- 近 30 次 P95 延迟；
- 最近可用的输入/输出 Token 单价；
- 同角色连续失败惩罚；
- 管理员角色偏好加权。

缺少成本数据时不伪造价格，评分只使用可用维度并标记 `cost_unknown`。相同分数使用 connection ID 的 UTF-8 二进制顺序稳定排序。

### 9.2 路由冻结与备用模型

- 创建 run 时冻结路由策略版本。
- 每个 `(runId, role, phase, attempt)` 冻结 connection、credential version、model、endpoint、prompt hash、schema hash 和 input hash。
- 主模型仅在超时、限流、暂时不可用或明确可重试的 provider 错误时进入下一 attempt。
- 认证失败、Schema 不支持、输入不完整、输出业务校验失败和策略冲突不进行跨供应商盲目重试。
- 新 attempt 使用新的 job identity 和模型快照；旧 attempt 的迟到结果不能覆盖当前任务。
- 一个角色最多主模型一次、备用模型两次。

## 10. 多智能体工作流

### 10.1 专家阶段

五位专家并行读取同一不可变 Snapshot 的最小角色切片：

- 财务：偿债、盈利、营运与安全指标；
- 利润：产品、客户和真实贡献利润；
- 成本：固定/变动成本、异常和降本空间；
- 现金流：30/90 天预测、回款和资金断裂风险；
- 税务：发票、收入确认、成本真实性、个税和股权风险。

每个输出必须通过角色 Schema、引用成员关系、公式结果、动作类型和服务端投影校验后才可持久化。

### 10.2 审计与反驳

- 服务器根据公式、Evidence、风险偏好和资源冲突建立 canonical audit graph。
- 每个角色最多一次 round-1 rebuttal。
- 反驳只能针对服务器选定的 finding，不能自行修改公式结果或引入未验证证据。
- 第二轮模型反驳不持久化；未解决冲突进入 CFO 少数意见或方案 blocker。

### 10.3 CFO 与组合优化

- CFO 模型只生成闭合的共识叙事和少数意见。
- 硬约束、金额、比例、情景值和组合选择继续由确定性公式与 optimizer 生成。
- 输出固定包含 `balanced`、`cash_first`、`growth_first` 三种组合。
- 现金储备、债务、必要支出、预算、能力、周期、置信度、合规、依赖和未解决冲突均为硬约束。

## 11. 人工审批与派发

- 只有最新、未过期、来源与策略仍一致的 portfolio revision 可以审批。
- 审批 UI 展示选中方案、被拒动作原因、关键风险、所需 capability 和数据缺口。
- 审批记录冻结 approver、workspace、run、revision、portfolio kind、action IDs、Snapshot、policy 和结果哈希。
- 每个获批动作只生成一个稳定 outbox 记录。
- 派发目标仅限内部 draft repository 与待办，不调用付款、报税、记账、邮件或第三方系统。
- 重启后可以从 outbox 恢复并精确重放，changed payload 必须冲突。

## 12. 黑色智能体中心交互

### 12.1 首页卡牌状态

六张卡牌从静态演示状态改为服务器投影：

- `未连接数据`；
- `数据已就绪`；
- `分析中`；
- `等待其他专家`；
- `已完成`；
- `需要人工复核`；
- `模型连接异常`。

卡牌展示当前角色的模型显示名、最近运行时间和状态，但不展示 API Key、提示词或内部推理。

### 12.2 真实运行路径

1. 管理员在设置中心配置并启用至少一个合格模型连接。
2. 用户在智能体中心上传三张报表并确认解析预览。
3. 页面创建 Financial Council run 并显示五位专家进度。
4. 用户可以查看结论、数据引用、反驳和失败/备用模型切换记录。
5. CFO 完成后展示三套组合和不可计算项。
6. 有权限用户编辑允许字段并生成新 revision。
7. 审批后展示草稿与待办回执。

## 13. 数据表与持久化边界

优先扩展现有 repository 和 schema，不新建平行运行体系。预计新增：

- 工作区模型路由策略表；
- 角色/连接性能聚合表；
- 财务上传来源与解析版本表（若现有 finance import 不能完整表达）；
- 必要的 run-to-routing-policy binding 字段。

现有以下事实继续作为权威来源：

- model connections、credential versions、activation events；
- AI job model snapshots、model call records；
- finance imports、verified financial ledger；
- Financial Council runs、events、snapshots、specialist results、audit/rebuttal、consensus、portfolio revisions、approvals、outbox 和 drafts。

所有表必须有 workspace 绑定、closed lifecycle、长度边界、不可变 hash 和 Memory/MySQL 行为一致性。Schema 升级必须兼容已有表并在命名锁或等价互斥下执行。

## 14. API 边界

继续使用现有公开接口：

- `/api/auth/*`；
- `/api/v1/growth/bootstrap`；
- Business Advisor agents、statement parsing/diagnosis；
- `/api/v1/finance/council-policy`；
- `/api/v1/finance/council-runs` 及 run/events/revisions/approve/reject/dispatches；
- 现有模型连接中心接口。

仅在现有合同无法表达时新增：

- `GET /api/v1/finance/council-model-routing-policy`；
- `PUT /api/v1/finance/council-model-routing-policy`，要求 Idempotency-Key 与 If-Match；
- 角色路由预览接口，返回推荐连接、理由代码和缺失能力，不触发模型调用。

所有新 DTO 必须 closed schema、版本化，并同步静态 OpenAPI、运行时验证、生成前端类型、合同漂移测试和不可变 release。

## 15. 安全与隐私

- 首次启用财务模型分析时，明确提示标准化财务数据会传输给选中的第三方模型供应商，并要求人工确认。
- 每个角色只接收所需字段，禁止发送原始工作簿、账号密码、API Key、无关客户信息或浏览器状态。
- 系统 prompt、Schema 和策略与用户上传内容使用不同消息角色和固定边界。
- 模型输出始终视为不可信数据，必须 closed-schema 解析并经过服务端业务校验。
- 日志只记录连接 ID、供应商、模型、耗时、Token、错误码、请求 ID 和内容哈希，不记录财务正文或密钥。
- API Key 使用现有 encryption AAD 和 credential version；生产环境不得使用默认 secret。
- workspace、owner、team、capability、CSRF、idempotency 和 ETag 由服务器解析，前端不能自报权威身份。

## 16. 错误、恢复与成本

- 报表解析失败：返回定位到 sheet/row/field 的安全错误，零业务写入。
- MySQL 不可用：真实模式启动失败，不回退 Memory。
- 模型连接不可用：在创建 run 前显示缺失能力；运行中只按明确可重试规则进入备用模型。
- 所有模型不可用：角色标记 `not_computable`，最终结果保留缺口并阻止不安全审批。
- worker 崩溃：租约过期后由 sweeper 恢复；lease token、attempt 和严格过期边界阻止旧执行者提交。
- 预算耗尽：停止后续 provider 调用并生成明确缺口，不用低可信内容填充。
- 供应商迟到响应：在每个 await 后重新校验当前 attempt、租约、run 和 Snapshot。

## 17. 实施阶段

### 阶段一：真实运行基础

- 配置 MySQL 3307 的数据库、应用账号和 Git 忽略环境文件；
- 启动真实后端、真实 session/CSRF 和前端代理；
- 在黑色壳中证明不再使用 demo session。

### 阶段二：多供应商与路由策略

- 完成所有现有供应商的连接测试；
- 新增工作区角色路由策略、评分、管理员覆盖和备用模型；
- 冻结每次选择并接入调用账本。

### 阶段三：三表导入与真实运行

- 将三张报表上传、预览、确认接到 finance import 和 verified ledger；
- 从已验证事实构建 Snapshot；
- 跑通五专家、审计、反驳、CFO 和优化。

### 阶段四：黑色前端接线

- 卡牌使用真实 readiness/run projection；
- 展示模型路由、进度、失败切换、结论、反驳和三组合；
- 完成编辑、审批、草稿/待办回执。

### 阶段五：真实验收与文档

- 真实 MySQL 重启恢复；
- 至少两个真实模型供应商；
- 主模型失败到备用模型的可控演练；
- 无 route interception 的 Chromium 纵向测试；
- 更新根 README、前端 README、环境示例、运维与当前状态文档。

## 18. 验收标准

1. MySQL 8.4.11 在 `3307` 以非 root 应用账号运行，后端使用真实持久化。
2. 前端通过 `VITE_API_TARGET` 进入真实认证和工作区，不创建 demo admin。
3. 至少两个不同供应商连接通过结构化输出认证并进入路由池。
4. 三张报表经预览确认后形成不可变 verified data version。
5. 五位专家全部获得角色绑定的模型快照并产生持久结果。
6. audit graph 至少包含一条真实冲突并完成一次 round-1 rebuttal。
7. CFO 保留共识与少数意见，optimizer 产出固定三组合。
8. 主模型的可重试失败触发指定备用模型，旧 attempt 无法提交或覆盖。
9. 后端重启后可以读取并继续 run、专家结果、审批、outbox 和草稿。
10. 人工审批只创建草稿和待办，不产生外部副作用。
11. 浏览器使用真实 session、CSRF、API 和 MySQL 完成上传到审批，无 route/fulfill 拦截。
12. 根测试、合同、MySQL 集成、类型、构建和 `git diff --check` 全部通过。

真实供应商验收需要管理员在连接中心自行录入 API Key。密钥不得出现在聊天、命令输出、测试快照、Git diff 或日志中。

## 19. 回滚

- 真实模式环境配置与代码提交分离；移除本地环境文件即可停止真实连接，不删除数据库。
- 模型路由策略、上传接线和黑色前端接线分成可独立回滚的提交。
- 新表只做向前兼容添加；回滚代码不能自动删除表或历史运行。
- 若新路由器异常，可将策略切为管理员固定连接，继续使用现有模型网关。
- 若真实前端出现问题，可暂时关闭真实入口并保留数据库与后端运行记录，不能回退为伪造业务结果。

## 20. 非目标

- 不在本阶段接 ERP、会计软件或银行系统；
- 不新增自动付款、报税、记账或外部消息发送；
- 不保存原始 Excel 长期 artifact；
- 不引入 Python 智能体服务、CrewAI、AutoGen 或 LangGraph 运行时；
- 不让模型替代服务端公式、硬约束、权限或审批；
- 不建设通用后台管理系统；
- 不把所有供应商同时用于同一角色的重复分析和投票。

# AI 经营顾问（business-advisor）

面向 1000 万～5000 万营收民企老板的虚拟经营顾问团队。定位是「让没有请 CFO 的老板也拥有一个 AI 经营管理团队」，输出经营诊断而非单纯财务问答。

## 智能体团队

| id | 角色 | 职责 |
| --- | --- | --- |
| cfo | AI 经营总管 | 综合诊断、健康评分、90 天行动计划 |
| finance | 财务分析 | 三大报表、盈利能力、运营效率、安全能力 |
| profit | 利润分析 | 产品真实利润、客户 ABC、假利润识别、费用对标 |
| cost | 成本分析 | 成本结构、价差/量差、异常科目识别 |
| cashflow | 现金流分析 | 现金预测、应收分析、资金全链条复盘 |
| tax | 税务健康 | 发票、收入确认、成本真实性、个税、股权（只体检不做避税） |

每个智能体带专属知识库（`knowledge.ts`），口径与方法论来自领雁财税/冠琦咨询的真实项目（丰博自动化、金辉酒业、天瑞产业），已按脱敏口径沉淀。

## 金额与比例约定

- 金额一律用整数 minor（元 × 100），避免浮点误差。
- 比例一律用 BPS（万分之一）：`800 bps = 8%`。
- 报表勾稽不平、毛利为负、期末现金为负时抛错拒绝编数，绝不粉饰。

## 指标口径（analysis.ts）

| 指标 | 口径 | 警戒线 |
| --- | --- | --- |
| 毛利率/净利率 | 毛利/收入、净利润/收入 | 净利率 < 5% 高风险，< 8% 关注 |
| ROE / ROA | 净利润/净资产、净利润/总资产 | — |
| 资产负债率 | 总负债/总资产 | > 70% 高风险 |
| 流动比率 / 速动比率 | 流动资产/流动负债；(流动资产-存货)/流动负债 | < 1.5 / < 1.0 高风险 |
| 应收账款周转率 / 天数 | 收入/应收；(应收/收入)×365 | 周转天数 > 90 高风险 |
| 存货周转率 | 营业成本/存货 | < 2 次 关注 |
| 利息保障倍数 | (净利润+所得税+利息)/利息 | < 3 高风险 |
| 收现比 / 净现比 | 经营现金流入/收入；经营净现金流/净利润 | 收现比 < 85% 关注；净现比 < 1 且净利为正 高风险 |
| 现金保障月数 | 期末现金/月均毛利 | — |

## 诊断报告结构（service.ts）

报告 = 健康评分 + 问题清单（全量，按优先级排序）+ 90 天行动计划 + 证据链。

每个问题遵循咨询四段式：**现象（证据）→ 风险（法律/财务/管理）→ 建议（制度+流程）**，并带 `category`（财务/利润/成本/现金流/税务/经营）与 `level`（red/yellow）分级。健康评分从 5000 起步，按上述红线逐项扣分，封顶 10000。

## API

### 同步经营诊断

旧路由挂在 `backend/src/business-advisor-router.ts`，在单个 HTTP 请求中同步计算公式与诊断，不创建可恢复运行：

- `GET /api/v1/business-advisor/agents`：智能体团队与知识库标题
- `POST /api/v1/business-advisor/analyze`：指标 + 产品/客户/现金流/成本/税务分析
- `POST /api/v1/business-advisor/diagnose`：完整经营诊断报告
- `POST /api/v1/business-advisor/statements/parse`：旧同步诊断入口，解析资产负债表 + 利润表；它不创建可供财务委员会使用的权威数据版本
- `POST /api/v1/business-advisor/statements/diagnose`：解析报表并直接生成诊断报告
- `POST /api/v1/business-advisor/statements/import`：多 sheet / 集团报表导入，按公司分组返回全部诊断结果

### 冻结财务委员会运行

`POST /api/v1/finance/council-runs` 是独立的异步工作流入口。认证上下文必须具有 `finance.council.run`；workspace、actor 和 capabilities 只取自认证上下文，请求体只能提交币种、数据时点、报表证据与策略版本。

创建运行时，服务先在同一 cutoff 读取 CRM、报价、已验证财务事实与 ROI 权威投影，再把报表、公式输入、数据缺口和敏感字段投影冻结成 run-bound snapshot。Repository 在一个原子 mutation 中提交 `snapshot_frozen` 运行、snapshot 以及连续的 `created` / `snapshot_frozen` 事件；不会在 HTTP 请求中执行模型。`snapshot_frozen` 是可恢复的持久工作事实，内部 relay 会把它投递给幂等 wake sink，失败后按后续 sweep 重试。

同一 `Idempotency-Key` 与同一 canonical 请求精确重放同一个运行；修改请求体返回冲突，不会重复提交 snapshot 或 advisory wake。运行与事件读取始终按认证 workspace 隔离。

HTTP 幂等仓库只保存 domain-separated digest，不保存原始 `Idempotency-Key`。同一创建请求在运行推进到 revision 2 之后仍精确重放当前聚合，不回退或重建 snapshot。持久化 snapshot 与完整事件链在每个读取边界重新校验：业务报表复用唯一 canonical validator，snapshot 会从所属 run 的报表与权威投影重新计算标准报表、公式、缺口、来源引用及 run-bound 身份，并且 record `createdAt` 必须精确等于唯一 `snapshot_frozen` 事件的 `occurredAt`，不能只靠攻击者重新签名通过。报价权威读取先按请求币种过滤，再应用 100 项完整性探针上限；未指定币种的旧 reader 调用保持原行为。

### 不可变财务委员会策略

`GET /api/v1/finance/council-policy` 按认证 workspace 读取当前策略；当且仅当该 workspace 没有任何策略版本时，服务端物化命名默认版本 `financial-council-policy.v1`。`PUT /api/v1/finance/council-policy` 需要 `finance.council.run` 与 `finance.council.policy.manage` 能力、`Idempotency-Key` 和 workspace-scoped `If-Match`；它只追加新版本，不覆盖旧版本。完全相同的幂等重放返回原版本，同键改体或过期 revision 均闭合失败。

策略请求为严格闭合对象：所有金额和限制必须为非负 safe integer，平衡权重总和固定为 10,000 BPS，系数版本由服务端 allowlist 控制。现金优先和增长优先权重转换固定在代码中；现金储备、到期债务/必要支出、合规、权限、关键数据、预算、容量、时限、前置、互斥和置信度门槛不是可关闭布尔开关。新运行只能引用本 workspace 中已存在的不可变策略 ID，该 ID 可唯一解析到确切 version、revision 和 hash。

### 工作区模型路由与智能体状态

Financial Council 组合根按同一 `memory | mysql` mode 和同一 MySQL pool 创建工作区模型路由仓库，不使用全局 singleton。路由策略固定覆盖 `cfo|finance|profit|cost|cashflow|tax` 六个角色，支持自动选择或一个固定主连接加最多两个有序备用连接；版本通过 `active|superseded` 状态、revision CAS、actor-scoped 幂等键和 immutable policy hash 持久化，Memory 与 MySQL 共用行为合同。MySQL 仅新增 `financial_council_model_routing_policies` 与 `financial_council_model_routing_idempotency` 两张表，schema 在命名锁内前向创建，不提供破坏性 down migration。

自动评分只接纳当前 workspace 中 active、官方 provider、`structuredOutput=true` 且 certification hash 格式闭合有效的连接。它从 canonical `financial-council:<runId>:<role>:<phase>:<attempt>` job ID 的右侧解析角色，仅统计同 workspace/role 最近 30 条 durable call record，并确定性组合成功率、P95、显式已知成本、连续失败惩罚和角色级 `preferenceWeightBps`；成本未知时不推测 token 单价，相同分数按 connection ID 的 UTF-8 binary 顺序稳定排序。该认证门槛只表示持久字段闭合有效，不证明证书来源或时效。

公开 `GET|PUT /api/v1/finance/council-model-routing-policy` 与 `POST .../preview` 复用该受信任 workspace resolver；GET 返回 revision `ETag`，PUT 需要 `finance.council.policy.manage`、`Idempotency-Key` 与 `If-Match`，尚无策略时只允许标准 create-if-absent 值 `If-Match: *`。preview 只接受精确 `{}`，不调用模型或写模型账本。`GET /api/v1/finance/council-agent-center` 和 `GET /api/v1/finance/council-runs/{runId}/agents` 只返回六角色固定顺序、公开连接展示信息和 durable call record 推导的脱敏 attempt 状态，绝不返回凭据、prompt、provider body 或标准化业务数据。

runnable 扫描使用 workspace/run 的 UTF-8 binary-byte 复合游标，Memory 与 MySQL 共用同一全序。relay 对 runnable enumeration、wake sink 与错误 observer 都设置有界 deadline，因此永久不返回的查询或投递不会阻塞 sweep 或应用关闭。公开创建合同只接受 CNY/USD，策略版本 ID 与业务报表文本分别最多包含 255 和 4000 个 Unicode code point，报表数组上限 100 项。公开 run 从 `snapshot_frozen` 开始，内部 revision-1 `created` 状态只存在于事件历史，service 与 router 都不会把它作为 run 响应。

### 五专家可恢复执行

生产模块把官方 active model gateway、五专家 coordinator、确定性冲突图、一轮反驳、lease-fenced worker 与 recovery sweeper 组合成真实异步流程：

`snapshot_frozen -> analyzing -> auditing -> synthesizing -> optimizing -> awaiting_approval`

创建/冻结时会在内部原子持久分析 owner/team，恢复不使用当前切换的 workspace 或模型身份。每次 claim 使用随机 64 位十六进制 token 和递增 attempt；精确到期时刻已算 stale，同 worker reclaim 后的旧 token 也不能写入。专家 result、gap、audit graph、rebuttal reservation/result/disposition 与运行转移都在同一 token + attempt + strict-expiry fence 下提交。

五个 analyze job 与最多五个 rebuttal job 的逻辑 attempt 始终为 `1`；可重试传输失败一次，不增加专家提交轮次。恢复先读已持久的 analyze result、graph 和 rebuttal reservation/completion，不创建第二轮，变更的 replay 会冲突关闭。

`finance` 和 `cashflow` 是硬约束角色，失败或缺失现金硬约束会进入 `not_computable`。`profit|cost|tax` 只有在确定性检查证明不依赖未可用硬约束或动作公式时才可部分继续，并持久仅含闭集 code 的脱敏 gap。缺少税务输入记为 `tax_input_missing`，不伪造税务结论。

CFO 只为已验证的 consensus 生成叙述；模型不可用或输出越界时使用服务端模板，不阻塞优化。优化器只消费运行绑定的 snapshot、audit graph、不可变 policy version 和 accepted/minority 候选集，固定返回 balanced、cash-first、growth-first 三套 revision 1。无非空可行集仍发布三个空组合及完整 blocker；候选超界等关键输入失效才进入 `not_computable`。

revision 1 是独立不可变记录，同时绑定 run/snapshot/audit/policy/consensus/candidate-set/output hash。崩溃发生在 revision insert 之后时，恢复 worker 用同一冻结输入重算并与已存字节比较，一致才发布；篡改或 replay 漂移会 fail closed。Memory 与 MySQL 共用行为合同，MySQL insert 和运行转移位于受 lease fence 的事务边界内。关闭顺序是 relay、recovery sweeper、optimization worker drain、analysis worker drain，然后底层资源。

### 审批、编辑与派发查询

委员会公开 API 使用认证的 active workspace；浏览器和客户端不得发送 `X-Workspace-Id`。`POST /api/v1/finance/council-runs/{runId}/portfolio-revisions` 只接受严格闭合的 edit operations，并返回新的 revision 中三套重新计算组合。该命令以及 approve/reject 都需要 `Idempotency-Key` 和对应 run 的 `If-Match`：缺失 `If-Match` 返回 428，缺失或格式错误的幂等键返回 400，过期 revision 返回 412，重复但不同请求返回 409；相同请求重放会标记 `Idempotency-Replayed: true`。

`POST /api/v1/finance/council-runs/{runId}/portfolio-revisions/{revision}/approve` 需要 `finance.council.approve`，显式绑定 `portfolioKind`，以 202 只创建受控草案、待办或后续审批任务，绝不直接写权威财务、报价或 CRM 数据。`POST /api/v1/finance/council-runs/{runId}/reject` 同样绑定 revision、portfolio kind 与原因。`GET /api/v1/finance/council-runs/{runId}/dispatches` 返回 no-store 的公共操作投影；`queued`、`running`、`retry` 均表示非终态，且永不暴露 proof、hash、lease 或 fence。发布消费者应导入不可变 Growth contract `1.0.12`。

生产 composition 为 Memory/MySQL 各自装配 draft repository、approved-action loader、进程内 approval proof issuer、dispatch worker 与 recovery sweeper。消费者必须从已批准的确切 portfolio revision 重读 action 并核对 action/portfolio hash，才能创建非权威 draft；进程重启后通过 dispatch hash probe 继续，不重复产生副作用。同角色、portfolio-level 的不同行动风险偏好以 `role:<role>` 形成真实 `risk_preference` 冲突，每个角色仍最多一次 rebuttal。

## 报表导入（statement-import.ts）

财务委员会的当前真实输入必须同时包含同一企业、同一期间、同一显式币种的资产负债表、利润表和现金流量表。三份 XLSX 先通过统一的 secure spreadsheet artifact 边界，公式、宏、外部链接、重复 sheet、压缩炸弹和超限内容均闭合失败；币种只接受工作簿 metadata/statement field 中明确写出的 `CNY` 或 `USD`，不从文件名推测。

公开 `POST /api/v1/finance/statement-packages/preview` 精确接收按资产负债表、利润表、现金流量表排序的三个 XLSX upload；`POST .../{previewId}/commit` 接受 consent-only，或同时携带闭合的 `cashForecast`。当前真实前端要求四个预测总额（未来 30 天流入/流出、31–90 天流入/流出）、显式应收账款列表（可明确为空）和管理层预测声明完整后才可 commit；金额经严格十进制解析为安全整数 minor。预览只保存一小时有效的非权威标准化记录，不写 financial fact ledger、不创建 verified package 或 council run，也不保存 workbook bytes、base64 或 raw cells。commit 在单事务中锁定 preview，由服务端写入 actor、acceptedAt、currency 和声明权威，形成不可变 `financial-statements.v2` package 与幂等响应，再标记 preview committed。公开响应只含脱敏文件元数据、期间、币种和 warning code，不返回应收客户或金额行。`POST /api/v1/finance/council-runs/from-statement-package` 只接受 `statementPackageId` 与 `policyVersionId`，package 内部保存的 canonical `BusinessReportInput`、输入哈希、同意审计和 package hash 不进入 public DTO。

现金流量表提供期初现金、经营流入/流出、投资净额和筹资净额，并与期末现金及资产负债表货币资金双重勾稽。consent-only package 仍将 forecast 明确记录为 `not_computable/source_statements_do_not_provide_forecast`，绝不填零或拿历史现金流冒充预测；携带完整管理层 forecast 的 package 删除该 marker，并由四个总额和显式应收账款账龄计算确定性现金公式。Council run 与 snapshot 内部必须绑定 package ID/hash，真实 package 的来源引用固定为 `{kind: financial_statement_package, sourceId, sourceVersion: financial-statements.v2, snapshotHash}`。

支持两类标准格式：

- 小企业会计准则（会小企01表）：`资产/行次/期末余额/年初余额` 左右双栏布局，利润表含 `本年累计金额/本季金额`。
- 一般企业会计准则：`资产/行次/期末余额/上年年末余额`，利润表含 `本期金额/本年累计金额`。

解析规则：

- 关键科目从表内行标签匹配（货币资金、应收账款、存货、应付账款、负债合计等），金额统一转整数 minor。
- 多 sheet 导入（`statements/import`）自动识别每个 sheet 是资产负债表还是利润表，按「编制单位」或 sheet 名分组配对；单家公司解析失败不影响其他公司，失败项带错误码返回。
- `其他流动资产`、`非流动资产`、`非流动负债` 优先取报表自带合计行，并做三重勾稽校验：资产合计=流动资产+非流动资产、负债合计=流动+非流动负债、资产=负债+权益（容差 1 元），不平即报 `statement_unbalanced`。
- 期间费用由报表自身勾稽倒推（营业收入-营业成本-净利润-财务费用-所得税费用），保证引擎净利润与报表一致。
- 旧同步双表诊断在未提供现金流量表时仍可返回受限诊断，但它不是完整数据，也不能作为财务委员会真实运行输入；三表 package 缺少现金流量表会以 `financial_statement_cashflow_required` 失败。
- 真实亏损企业（负权益、零收入有成本）允许诊断，毛利为负作为红色预警输出，不再拒绝。

## 测试

```bash
npm run test:business-advisor --workspace backend
npm run test:financial-council --workspace backend
npm run test:financial-council:vertical --workspace backend
MYSQL_TEST_ADMIN_URL="mysql://..." npm run test:financial-council:mysql --workspace backend
```

`test:financial-council:mysql` 是真实 InnoDB 发布门禁；未配置 `MYSQL_TEST_ADMIN_URL` 时必须显式失败，不得将缺少证据记为通过。

当前实现状态：财务委员会 P1–P5、工作区模型路由、三表与管理层现金预测 onboarding、脱敏 agent-center public surface 均已实现，Growth contract 固定为 `1.0.12`。隔离 InnoDB 的迁移/竞态（4/4）与跨两 runtime 恢复（1/1）已真实通过；无 route-intercept Chromium 已在两个独立随机 MySQL 数据库中连续完成 forecast-backed 五专家、恰好一次反驳、三组合、revision 2、balanced 审批、成功回执和 reload identity。consent-only package 仍按安全设计进入 `not_computable`。真实双供应商因凭据环境缺失必须 BLOCKED，因此整体状态仍是“实施完成，真实供应商验收待凭据”。

覆盖：金额换算、勾稽校验、指标计算、假利润/客户 ABC/现金流预警、知识库条目、诊断阈值（负债率/应收天数/利息保障/净现比）、两种报表格式解析与勾稽错误。

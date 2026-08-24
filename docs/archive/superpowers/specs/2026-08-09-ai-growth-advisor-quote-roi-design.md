# AI 增长参谋、报价决策与可计算 ROI 闭环设计

日期：2026-08-09

状态：产品方案已确认，待实施计划

目标版本：GoodJob 1.09 二次开发版本

## 1. 背景

GoodJob 当前已经完成抖音公开获客阶段 A 的主要技术闭环：

- 客户自带搜索和模型 API Key；
- 真实公开搜索计划、审批、运行和恢复；
- 抖音视频或评论信号的主体核验；
- 客户研究、S/A/B/C/D 意向评分和财务价值评估；
- 客户作战卡、人工审核和 CRM 交接；
- 报价、成交等 CRM Outcome 回流；
- 真实获客漏斗、分币种报价额和成交合同额；
- 局部 AI 增长参谋能力，包括获客计划草拟和老板经营简报。

但是，当前经营决策仍有三个关键断点：

1. 候选财务价值属于 AI 预测，不是以产品价格和成本为依据的正式报价；
2. 当前系统只有合同额和部分 API 执行成本，没有完整渠道成本、实际回款和实际毛利，因此 ROI 被明确标记为不可计算；
3. AI 增长参谋只有局部入口，没有形成“发现问题、解释依据、创建受控任务、追踪结果”的全局经营闭环。

本设计不通过新增演示数字解决这些问题，而是先建立可验证的报价与财务事实，再让 AI 解释和使用这些事实。

## 2. 产品目标

将现有的“AI 获客判断系统”升级为一条可审计的增长经营闭环：

```text
获客候选与作战卡
→ 选择产品或服务
→ 确定性报价试算
→ AI 解释报价并生成谈判建议
→ 人工审批
→ 报价、成交、回款和成本核销
→ 预计 ROI 与实际 ROI
→ AI 增长参谋生成下一步行动
```

### 2.1 成功标准

1. 每个租户能够维护自己的产品、服务和套餐目录；
2. 正式报价由确定性规则计算，AI 不决定底价、折扣或毛利；
3. 所有对外报价必须经过人工确认，异常报价必须主管审批；
4. 预计 ROI 和实际 ROI 在模型、接口和界面中严格分离；
5. 实际 ROI 只有在成本、毛利、归因和批次结账条件完整时才计算；
6. 财务事实首版支持后台录入和 Excel 导入，并保留来源、凭证和核销状态；
7. AI 增长参谋的每条建议都有可追溯的数据依据和受控行动入口；
8. 真实模式不允许回退到演示金额或用 AI 补造缺失财务数据；
9. 一条抖音候选能够完整走到报价、成交、回款、实际 ROI 和经营复盘。

## 3. 已确认的产品决策

本设计已经确认以下决策：

1. 同时展示预计 ROI 和实际 ROI，但使用不同公式、状态和视觉区域；
2. 产品目录属于租户，每个客户维护自己的商品、服务或套餐；
3. 首版财务数据使用后台录入和 Excel 导入，不依赖外部财务或广告平台 API；
4. AI 只能分析、解释、生成草稿和创建审批任务，不能直接批准或对外发送报价；
5. 选择纵向闭环方案，不先做独立聊天页面或孤立的财务底座；
6. 首版支持一个顶层商品、服务或套餐的报价；套餐内部可以包含多个版本化组件，但不提前实现任意多行混合报价、库存、复杂物流、税务和完整 ERP。

## 4. 方案比较与选择

### 方案一：先做 AI 增长参谋页面

优点是演示效果最快。缺点是报价和 ROI 仍缺少权威事实，容易再次变成“AI 会说、金额不可信”。不采用。

### 方案二：先完成全部财务底座

优点是财务模型最完整。缺点是较长时间看不到可使用的客户闭环，且容易过早扩展成 ERP。暂不采用。

### 方案三：按真实交易纵向闭环开发

每个切片都从候选或 CRM 商机出发，最终形成可审计结果。产品目录、报价、财务事实、ROI 和 AI 参谋按依赖关系逐步接通。

本设计选择方案三。

## 5. 范围与非目标

### 5.1 本次范围

- 租户级产品、服务和套餐目录；
- 版本化价格和成本策略；
- 报价试算、版本、提交、批准和驳回；
- 底价、折扣、毛利和账期门禁；
- AI 报价解释、谈判策略和话术草稿；
- 渠道成本、成交、回款、退款和实际成本的录入与导入；
- 财务事实核销、更正和凭证；
- 获客批次结账；
- 预计 ROI、实际 ROI、合同 ROAS 和回款进度；
- 全局 AI 增长参谋工作台；
- 建议采纳、任务执行和结果反馈；
- 与候选、作战卡、CRM 商机和现有 PI 单据衔接。

### 5.2 非目标

- 让 AI 自主批准或发送报价；
- 将 AI 预测值记为财务事实；
- 将普通 CRM “付款”状态直接视为真实到账；
- 自动跨币种汇总而没有正式汇率快照；
- 完整库存、采购、税务、物流和会计总账；
- 抖音自动评论、自动私信、自动加好友或绕过平台风控；
- 同时建设快手、小红书、微博和微信平台连接器；
- 第一版直接对接所有广告、财务或 ERP API；
- 重新实现一套独立 Agent 框架。

## 6. 角色与权限边界

### 6.1 销售

- 查看候选、作战卡和可用产品；
- 创建报价草稿并运行试算；
- 请求 AI 解释和生成谈判话术；
- 提交报价审批；
- 查看自己的报价和审批结果；
- 记录客户反馈和 CRM Outcome。

销售不能修改权威成本、底价或审批规则，不能批准自己触发的异常报价。

### 6.2 销售主管或负责人

- 审批超折扣、低毛利、长账期或其他异常报价；
- 驳回并要求新版本；
- 查看团队报价、毛利和建议采纳情况；
- 创建销售待办和调整负责人。

### 6.3 财务或经营管理员

- 维护成本和财务事实；
- 导入回款、退款和实际成本；
- 核销、更正和关闭获客批次；
- 查看实际 ROI 的计算证据；
- 管理允许的币种和后续汇率快照。

首版不新增数据库角色枚举。上述职责映射到现有 `admin` 和 `super_admin`，后续若增加自定义角色，只复用同一 capability，不改变领域权限判断。

### 6.4 租户管理员

- 维护产品目录、价格策略和审批阈值；
- 分配角色权限；
- 查看全租户经营分析和审计记录。

### 6.5 AI 增长参谋

- 读取已授权的候选、作战卡、报价和经营事实；
- 解释确定性计算结果；
- 生成报价草稿、话术和建议；
- 创建人工审批任务和销售待办；
- 记录建议是否被采纳及其结果。

AI 不拥有修改底价、写入已核销财务事实、批准报价或对外发送报价的权限。

### 6.6 工作区隔离和能力矩阵

新领域对象不再把 `ownerId` 同时解释为“租户”和“创建者”。统一定义：

```text
workspaceId = ActiveWorkspaceContext 中经过服务端授权的具体工作区 ID
createdBy = 执行动作的用户 ID
assignedTo = 业务负责人 ID
```

`workspaceId` 是所有新目录、报价、成本、财务、批次、建议和嵌套引用的唯一隔离键。创建、查询、关联和聚合时，服务端必须验证所有关联 ID 属于同一工作区。现有获客对象通过请求 Scope 映射到具体工作区，不根据前端提交的 owner/team 字段授权。

`super_admin` 的 `teamId="all"` 只代表跨工作区查询权限，绝不能作为可持久化 workspaceId。所有写命令都必须携带或由路由选择一个具体、已授权的 ActiveWorkspaceContext；个人工作区使用稳定的 `personal:<userId>` 标识。跨工作区查询逐工作区执行并保持结果隔离，不允许把多个工作区合并成伪工作区 `all`。

首版能力矩阵：

| 能力 | sales | manager | admin | super_admin |
|---|---:|---:|---:|---:|
| 查看可销售目录和允许报价区间 | 是 | 是 | 是 | 是 |
| 查看底价、标准成本和详细毛利 | 否，除非单独授权 | 是 | 是 | 是 |
| 创建报价草稿 | 是 | 是 | 是 | 是 |
| 确认规则内报价 | 不能确认自己提交的版本 | 是 | 是 | 是 |
| 批准异常报价 | 否 | 是，且不能自批 | 是，且不能自批 | 是，且不能自批 |
| 管理目录和价格策略 | 否 | 否 | 是 | 是 |
| 录入成本和财务事实 | 否 | 可录入待核销 | 是 | 是 |
| 核销、冲销和关闭批次 | 否 | 否 | 是 | 是 |
| 查看 Growth Performance 与已结账 ROI | 否；销售只看自己报价的预计指标 | 团队范围 | 工作区范围 | 指定工作区范围 |

权限由 capability 判断，不在各路由重复硬编码角色名。字段投影也按 capability 脱敏：无 `pricing.sensitive.read` 时不返回标准成本、底价和详细实际毛利。

新版前端登录后先读取 `GET /api/v1/growth/bootstrap`，响应只包含服务端已授权的具体 `workspaceId`、`capabilityRegistryVersion`、当前用户 `capabilities[]`、`contractVersion`、`contractHash`和已启用功能标识。不返回任何密钥、全租户工作区列表或未授权能力。`super_admin` 未选择具体 ActiveWorkspaceContext 时返回可操作的“需选择工作区”状态，不返回伪 workspaceId=`all`。

Capability 使用版本化、封闭的注册表，首版至少包含：

```text
catalog.read
catalog.manage
pricing.sensitive.read
quote.draft.create
quote.confirm
quote.exception.discount.approve
quote.exception.margin.approve
quote.exception.payment_terms.approve
quote.exception.gift.approve
quote.exception.credit.approve
quote.exception.manual.approve
ledger.pending.create
ledger.verify
roi.close
growth.performance.team.read
growth.performance.workspace.read
acquisition.outcome.reconcile.internal
```

默认 grant：`sales` 可读目录并创建草稿；`manager` 获得确认、各异常报价审批能力和团队读取；`admin/super_admin` 在具体 ActiveWorkspaceContext 内获得目录、账本、关账和工作区读取能力。`acquisition.outcome.reconcile.internal` 只授予服务内部 Reconciler identity，永不授予人类角色或 AI。规则到 capability 的封闭映射为：规则内确认 → `quote.confirm`；超普通折扣/毛利/账期/赠送/信用/人工升级 → 对应 `quote.exception.*.approve`。策略和审批快照必须保存 capability registry version，未知 capability 直接拒绝，不降级为角色字符串。

## 7. 核心业务流程

### 7.1 报价流程

```text
候选或 CRM 商机
→ 选择产品、服务或套餐
→ 输入数量、目标价、赠送项和付款条款
→ 读取有效价格策略版本
→ 确定性试算
→ 展示标准价、建议区间、底价、折扣、毛利和贡献利润
→ AI 解释客户偏好与谈判策略
→ 保存不可变报价版本
→ 提交审批
→ 规则内由非提交人负责人确认
→ 异常报价由主管批准或驳回
→ 事务内设为唯一正式报价并写入发布 Outbox
→ 发布 Worker 幂等生成 PI 投影和 CRM 已报价事件
```

`QuoteVersion` 是本闭环唯一商业报价权威。PI 只是在报价批准后的交付单据投影，不能修改商品、数量、金额或条款；PI 原有审批只保留文档发送和导出控制，不再构成第二套商业价格审批。

对于带有获客候选或获客归因的 Deal：

- 禁止旧接口直接创建 `quote` DealEvent；
- 禁止旧接口使用任意客户端明细创建 PI；
- 禁止旧 Deal 更新接口修改 product、quantity、unitPrice、amount、currency 和 amountType 等商业字段；这些字段只能由正式 QuoteVersion 投影；
- 禁止旧阶段接口直接跳转 `quoted`、`won` 或创建 `won/lost` 商业事件；
- 只有引用已批准 `QuoteVersion` 的发布 Worker 可以写入；
- 成交或丢单通过 `POST /api/v1/quotes/deals/:dealId/decision`，必须引用当前 DealAuthoritativeQuote、校验金额哈希，并由服务端原子更新 Deal 与 DealEvent；
- 报价前无预算、无需求或不匹配的 Deal 通过同一 decision 命令的 `pre_quote_disqualified` 类型关闭；该事件不带商业金额，只进入漏斗，不生成报价、成交或 ROI 事实；
- 新权威报价模式下，公开 `POST /api/v1/acquisition/outcomes` 不再接受 `quoted/won/lost`；这三类 Outcome 只能由持有内部 Reconciler capability 的服务根据已验证 DealEvent 稳定键写入；
- 旧历史 PI 和 quote 事件标记为 `legacy_unverified`，在人工关联到报价版本前不进入预计 ROI。

非获客来源的既有外贸流程保持兼容，但不能反向关联为获客正式报价。新租户默认启用权威报价门禁。

### 7.2 财务事实流程

```text
后台录入或 Excel 导入
→ 逐行格式与业务校验
→ 外部编号和证据哈希去重
→ 保存待核销事实
→ 财务核对凭证与归因
→ 核销或驳回
→ 错误通过冲销或更正事实修复，不覆盖原记录
```

### 7.3 ROI 流程

```text
选择平台、计划、获客批次、币种和 asOf
→ 汇总已归因成本
→ 汇总报价与预计成交价值
→ 汇总已核销收入、成本和退款
→ 检查成本、毛利、归因和结账门禁
→ 分别计算预计 ROI 和实际 ROI
→ 输出数据覆盖率、公式和证据
→ AI 解释结果并创建受控任务
```

## 8. 领域模型

现有 `Candidate`、`FinancialValueDecision`、`BattleCard`、`Deal`、`DealEvent`、`TradeDocument` 和 `OutcomeAttributionInput` 继续复用。新增模型不得把 AI 预测与财务事实混为一个字段。

### 8.1 CatalogItem

代表租户可销售的商品、服务或套餐。

主要字段：

```text
id、workspaceId
type：product | service | package
code、name、description
unit、status
createdAt、updatedAt
```

套餐通过版本化组件引用其他目录项；历史报价始终保留当时的组件快照。

套餐使用独立版本：

```text
PackageVersion
id、packageCatalogItemId、version、currency
status：draft | active | retired
validFrom、validTo
revision、createdAt、updatedAt

PackageComponent
packageVersionId
componentCatalogItemId
componentPricingPolicyVersionId
quantityMicros
```

激活套餐前必须验证：组件属于同一工作区、币种一致、策略有效、数量为正，并且组件图无直接或间接循环。套餐策略的标准成本由冻结组件成本、数量和套餐自身服务成本确定性汇总。

PackageVersion 只有 `draft` 允许使用 `If-Match: revision` 修改组件和有效期；`active/retired` 内容永久不可变，变更必须新建版本。激活和退役都提升 revision，并发 PATCH 只能一个成功。

### 8.2 PricingPolicyVersion

代表某个目录项在一段时间内的权威价格和成本规则。

```text
id、catalogItemId、version
packageVersionId?（仅 package）
currency
listUnitPriceMinor
unitStandardCostMinor
defaultOrderDeliveryCostMinor
defaultOrderSalesCostMinor
defaultOrderServiceCostMinor
absoluteFloorUnitPriceMinor
standardDiscountLimitBps、absoluteDiscountLimitBps
targetGrossMarginBps、absoluteMinimumGrossMarginBps
standardPaymentTermDays、absolutePaymentTermDays
approvalThresholds
surchargePolicies[]（封闭规则、适用条件、固定或单位附加费）
giftPolicies[]（包含赠送项成本和普通/绝对上限）
validFrom、validTo
status：draft | active | retired
source、createdBy、createdAt
```

价格和标准成本字段均为“每计量单位”的最小货币单位整数；默认交付、销售和服务成本为每张报价的订单级金额。同一个目录项、币种和时间范围内最多一个活动版本。旧版本不能被覆盖，只能退休并创建新版本。

套餐目录项的活动 PricingPolicyVersion 必须引用同币种、有效期覆盖报价时点的精确 PackageVersion。每个套餐、币种和重叠时间范围最多一个 active PackageVersion；切换组件必须先创建新 PackageVersion，再创建引用它的新 PricingPolicyVersion。

`approvalThresholds` 是封闭 Schema，不是任意 JSON：它分别定义 standard/absolute 折扣 BPS、毛利 BPS、账期天数、赠送金额/数量、信用风险阈值和人工升级开关，每一类规则都显式映射到注册表中的 capability。`additionalProperties:false`，未知规则或 capability 不允许激活。

`CatalogItem + PricingPolicyVersion` 成为产品、销售价格和标准成本的唯一主数据。现有 `CommissionProduct` 迁移为引用 `catalogItemId` 的提成配置投影：

- 既有 CommissionProduct 为每个工作区迁移一个 CatalogItem 和初始策略版本，来源标记为 `legacy_commission_product`；
- 迁移完成后，CommissionProduct 的价格和成本字段只读，并由 Catalog 投影；
- 新提成计算读取正式报价的价格/成本快照，不重新读取当前策略；
- 历史提成继续使用已有快照，目录更新不能静默改变历史结果；
- 迁移校验未通过的产品不能进入正式报价。

### 8.3 QuoteCase

代表一个客户或商机的一次持续报价过程。

```text
id、candidateId?、customerId?、dealId?
workspaceId
assignedTo
status：open | closed | cancelled
currentDraftVersionId?
revision
createdAt、updatedAt
```

至少关联候选、客户或商机中的一个。同一个 Deal 最多一个打开的 QuoteCase。QuoteCase 不保存正式报价权威缓存；正式报价只能通过 DealAuthoritativeQuote 查询。

候选可以先创建草稿，但 QuoteVersion 提交前必须绑定 Deal。绑定时复用现有私域交接和 Outcome Reconciler 的强关系校验，冻结：

```text
CommercialBindingSnapshot
candidateId、handoffId、leadId?、customerId、dealId
candidateVersion
handoffContentHash、dealContentHash
bindingHashSchemaVersion
attributionSnapshot
bindingHash、verifiedAt
```

如果候选尚未进入 CRM，页面先创建受控 CRM 转换任务，成功后再提交报价。候选、客户和 Deal 只在同一工作区但不属于同一交接链时必须拒绝。

`bind-deal` 是一次性命令：未绑定 Case 可绑定一次，同 Deal 重放幂等，改绑其他 Deal 拒绝。`cancel` 只允许在没有 submitted/approved 版本时执行，并将草稿设为 expired；`close` 仅在没有活动 submitted/approved 版本时人工执行。有当前权威报价的 Case 只能由 won/lost decision 或报价 expiry 流程关闭；这些命令同时校验 Deal guard 并清理当前指针，不留悬空权威。

现有 Handoff 没有版本号，因此 `handoffContentHash` 按版本化 canonical schema 计算候选、客户、负责人和幂等来源字段；`dealContentHash` 只包含绑定身份字段，不包含之后由 QuoteVersion 投影的可变商业金额。哈希 Schema 变更必须提升 `bindingHashSchemaVersion`。

### 8.3.1 DealAuthoritativeQuote

Deal 级权威指针确保跨 QuoteCase 也只有一个正式报价：

```text
workspaceId、dealId（唯一）
quoteCaseId?、quoteVersionId?
revision
updatedAt

DealAuthoritativeQuoteEvent
id、workspaceId、dealId
eventType：approved | superseded | expired | won | lost
previousQuoteVersionId?、quoteVersionId?
commercialAmountHash
authorityRevision
recordedAt
```

候选草稿首次绑定 Deal 时就在同一事务中创建可空的 DealAuthoritativeQuote guard，并以 Deal 行或 guard 行串行化“每个 Deal 最多一个 open QuoteCase”。并发 bind 同一 Deal 只能一个成功。批准事务先锁定该 guard，再锁定 QuoteCase。若已有其他 Case 的正式版本，则在同一事务中将其 supersede、追加指针事件并更新当前指针。预计经营聚合读取指针事件在查询 `asOf` 时有效的 quoteVersionId，不遍历 QuoteCase，也不使用当前状态倒推历史。

### 8.4 QuoteVersion

每次试算并保存后生成不可变版本。

```text
id、quoteCaseId、version
currency
lineItems[]
customerTargetPriceMinor?
discountMinor、surchargeMinor、requiredSurchargeMinor
paymentTerms、giftItems[]
listAmountMinor、quotedAmountMinor
estimatedFulfillmentCostMinor
estimatedSalesCostMinor
estimatedServiceCostMinor
estimatedGrossProfitMinor
estimatedContributionMinor
discountBps、grossMarginBps
approvalReasons[]
pricingPolicySnapshot
probabilityAssessmentSnapshot
inputSnapshotHash
status：draft | submitted | approved | rejected | superseded | expired
createdBy、createdAt
```

报价版本只接受确定性计算服务产生的金额结果。前端和 LLM 不能直接提交计算后字段。

首版 `lineItems` 只允许一个顶层目录项；当该目录项为套餐时，服务端将套餐组件展开为只读成本快照。保留数组结构是为了兼容套餐快照和后续多行报价，但首版 API 必须拒绝多个顶层销售项，避免范围静默扩张。

`probabilityAssessmentSnapshot` 必须保存原始 `closeProbabilityBps`、资格决定 ID/版本、规则/模型快照和评估时间。不能读取已经概率加权的 `expectedGrossProfitMinor` 再次乘概率。

现有 FinancialValueDecision 只持久化经过取整的百分比，不能无损恢复原始 BPS。实施时新增 `ProbabilityAssessment.v2`：

```text
id、workspaceId、candidateId、dealId?
closeProbabilityBps
qualificationDecisionId、qualificationDecisionVersion
evidenceRefs[]
ruleVersion、modelSnapshotRef?
inputSnapshotHash、assessedAt
```

旧百分比决定标记为 `legacy_percent_precision`，不能通过乘 100 伪装成原始 BPS，也不进入正式预计 ROI；需要重新执行 v2 评估。报价草稿可以先保存，但提交审批前必须冻结有效 ProbabilityAssessment.v2。

报价状态机：

```text
draft → submitted → approved
                  ↘ rejected

approved → superseded | expired
draft/submitted → expired
```

批准时必须先锁定 DealAuthoritativeQuote，再锁定 QuoteCase，保证同一 Deal 跨 Case 最多一个 `approved` 正式版本。批准新版本时，在同一事务中将旧正式版本改为 `superseded`、更新 Deal 指针并写 Outbox。成交后正式版本被冻结，不再允许被替代，只能创建更正交易流程。

QuoteVersion 的 `status` 是追加式 QuoteLifecycleEvent 的当前投影：

```text
QuoteLifecycleEvent
id、workspaceId、quoteVersionId
lifecycleRevision
fromStatus?、toStatus
actorId、recordedAt
```

submitted、approved、rejected、superseded、expired 都保存前后状态、执行人和单调 revision。`(workspaceId, quoteVersionId, lifecycleRevision)` 和 `(workspaceId, dealId, authorityRevision)` 分别唯一；同一事务中的多个事件按 revision 而不是毫秒时间戳重建。预计 ROI 的历史 `asOf` 通过 QuoteLifecycleEvent 与 DealAuthoritativeQuoteEvent 重建，后续替代或成交不能改变旧时点结果。

### 8.5 QuoteApproval

```text
id、quoteVersionId
status：pending | approved | rejected | cancelled
approvalKind：confirmation | exception
requiredCapabilities[]
triggeredRules[]
pricingPolicyVersionId、policySnapshotHash
submittedBy、submittedAt
decidedBy?、decidedAt?
reason?
```

同一报价版本只允许一个活动审批。新报价版本必须创建新的审批记录。每条命中规则显式映射到 capability 集合；不同 capability 不假设成单一线性“最高角色”，决策人必须同时满足合并后的全部 requiredCapabilities。

提交人与决策人不得相同。多个异常规则合并为一个审批任务，并要求决策人同时满足全部 requiredCapabilities。规则内报价仍需要非提交人的负责人确认，满足“所有对外报价人工确认”的产品边界。

### 8.6 QuotePublicationOperation

报价批准后的跨模块发布使用事务 Outbox，而不是“同一事务或可恢复流程”二选一：

```text
id、quoteCaseId、quoteVersionId
dealId、dealAuthorityRevision、commercialAmountHash
status：queued | running | succeeded | partial_failure | failed | superseded | cancelled
piDocumentId?
dealEventId?
attempts、lastErrorCode?
leaseOwner?、leaseExpiresAt?、fencingToken?
idempotencyKey、createdAt、updatedAt
```

批准事务原子提交 QuoteVersion、QuoteCase、QuoteApproval、DealAuthoritativeQuote 和 Outbox。Worker 使用租约、fencing token、心跳和恢复 sweeper，按稳定键分别创建 PI 投影，并通过一个 CRM 命令原子更新 Deal 的 stage/amount/currency/amountType 与写入 quote DealEvent。

批准新版本时，同一 Deal 的旧未完成 PublicationOperation 在事务内标记为 `superseded`。每个副作用命令都必须以 `dealId + quoteVersionId + dealAuthorityRevision` 条件写入；旧 Worker 即使延迟恢复，也会因指针 revision 不匹配而停止，不能覆盖新报价。已发布的旧 PI 保留历史并标记 superseded，不删除审计记录。

`won/lost` decision 与批准使用同一 Deal guard 锁，原子提升 authority revision，并将该 Deal 所有未完成 PublicationOperation 标记为 `cancelled`。Worker 每次副作用前都要重新校验 Deal 仍处于可发布状态且 revision 一致；不能在成交或丢单后把 Deal 回写为 quoted。

Worker 不直接写 Acquisition Outcome；现有 CRM Outcome Reconciler 是 `DealEvent.quote → quoted Outcome` 的唯一写入者，避免双写。步骤失败可恢复，不撤销已经批准的报价。前端分别展示“商业报价已批准”和“PI/CRM 发布中或失败”，并提供受控重试。双 Worker、ACK 丢失或进程崩溃不能产生重复 PI、DealEvent 或 Outcome。

### 8.7 AcquisitionCostEntry

一条实际获客成本一行。

```text
id、workspaceId
platform、planId?、runId?、providerId?
category：api | media | content | agency | operation
amountMinor、currency、occurredAt
provenance：provider_reported | portal_export | invoice_confirmed | manual_verified
sourceRef?、evidenceHash、externalId?
sourceIdentityRoot、sourceVersion
businessOccurredAt、recordedAt
correctsCostEntryId?、correctionGroupId?
createdBy
```

核销状态由追加式 VerificationEvent 投影，不允许直接修改成本行。只有已核销净额进入实际 ROI。`estimated` 不能写入或核销到实际成本账本。

预计获客成本使用独立 `AcquisitionCostEstimate`：

```text
id、workspaceId、cohortId?、planId?、runId?
amountMinor、currency
source：approved_budget | plan_budget | provider_estimate | manual_estimate
sourceStableKey、version、status：draft | active | superseded
sourceVersion、inputSnapshotHash、revision
validFrom、validTo、createdBy、createdAt、activatedAt?
```

Estimate 只进入预计 ROI，永远不能通过“核销”变成实际成本；实际成本必须新建带真实 provenance 的 CostEntry 并通过来源身份与 Estimate 对账。

`sourceStableKey` 表示一笔经济成本身份，例如计划预算、供应商请求成本或手工共享投放。同一工作区、币种和 sourceStableKey 只能有一个 active 版本；更正通过新版本激活并 supersede 旧版本。不同 sourceStableKey 代表不同经济成本时才可累加；对同一经济成本的 plan budget、provider estimate 和 manual estimate 必须归并为同一 stable key 并显式选择激活版本，不使用隐式优先级。共享预计成本只有通过完整 AllocationSet 分配后才进入批次预计 ROI。

现有 Run `consumedBudget` 是可变累计值，不能直接按不存在的 budgetVersion 投影。API 成本优先从已有逐请求 `ProspectProviderRequestAccountingEvidence` 按 `provider-request:<accountingEvidenceId>` 生成追加式成本行；没有逐请求证据的旧 Run 只能在不可恢复终态按最终 Run 内容哈希生成一次 `legacy-run-final:<runId>:<finalHash>` 待核销行。

现有逐请求 Evidence 若 provenance 为 `unknown | estimated`，只能投影为 AcquisitionCostEstimate，不能生成可核销 CostEntry；只有 `provider_reported` 等可验证来源才进入实际成本待核销链。

供应商报表或发票用于核验或更正同一投影行，不能追加第二笔同源 API 成本。`consumedBudget` 只作为对账控制总额，Performance 以后只从成本账本聚合，避免双计。

### 8.8 AcquisitionCohort 与成员

获客批次是一等公民，不以临时日期查询替代：

```text
AcquisitionCohort
id、workspaceId
platform、cohortFrom、cohortTo
definitionVersion、firstTouchRuleVersion
status：active | superseded
createdAt

AcquisitionCohortMember
id、cohortId
workspaceId、platform、canonicalSubjectId、subjectStableKey
primaryCandidateId
firstDiscoveredAt
firstPlanId、firstRunId、firstShardId
attributionSnapshot
createdAt

AcquisitionCanonicalSubject
id、workspaceId、platform、subjectStableKey
canonicalProfileUrl?、createdAt

AcquisitionCanonicalSubjectAlias
canonicalSubjectId
candidateId、evidenceId?、ownerId?
discoveredAt

AcquisitionCohortMemberSource
cohortMemberId
candidateId、evidenceId?、ownerId?
discoveredAt
```

同一个规范主体在同一工作区和平台只能属于其首次权威发现批次。成员必须引用现有强类型 `OutcomeAttributionInput` 的完整来源链，并保存 first-touch 规则版本。每个 ClosureVersion 通过 RoiSnapshotEntry 冻结当时成员集合和哈希；后续晚到成员只能进入重开后的新 ClosureVersion。Plan 不是第二种成员关系；经营查询通过成员的 `firstPlanId` 在同一闭包快照中切片，避免一个主体同时进入平台批次和计划批次。

规范主体唯一键为 `(workspaceId, platform, subjectStableKey)`，CohortMember 也使用该键保证首次归属唯一；`id` 用作 RoiSnapshotEntry 的稳定 FK。两个销售发现同一抖音主体时只生成一个批次成员，但通过 Alias 和 MemberSource 保留所有 candidate/evidence/owner 来源。平台时间窗不得重叠；创建 Cohort 时锁定 workspace+platform 并拒绝重叠半开区间。

### 8.9 AttributionAllocationSet

成本和财务事实与批次之间使用版本化、可查询的分配集合，不能只依赖 JSON 快照：

```text
AttributionAllocationSet
id、workspaceId
sourceType：cost_entry | cost_estimate | financial_fact | source_report
sourceId
version
status：draft | active | superseded
revision
createdBy、createdAt、activatedBy?、activatedAt?

AttributionAllocationItem
allocationSetId
cohortId
candidateId?
planId?、runId?
allocationBps
allocationRule：first_touch | direct | manual | equal_split | evidence_weighted
ruleVersion
evidenceRefs[]
targetStableKey
```

激活时锁定 source，原子校验全部 Item 合计等于 10000 基点并 supersede 前一版本。错误分配不能原地修改，只能创建新 Set。未激活或部分分配的金额进入覆盖率缺口，不能静默排除。候选财务事实默认使用其 first-touch Cohort；共享成本首版只自动接受 `direct` 分配，其他分配必须由有权限的用户确认。

将整数最小货币单位按 BPS 分摊时，先对每项向下取整，再按小数余数从大到小分配剩余最小单位；余数相同按 `targetStableKey` 字典序决定。所有子项金额必须严格等于原金额。

所有 source、cohort、candidate、plan 和 run 引用必须属于同一工作区。Item 唯一键为 `(allocationSetId, targetStableKey)`；同一个 source 的激活事务锁定 source 归因行，保证最多一个 active Set。新版本可以使用相同规则和目标调整比例，不会被跨版本唯一键阻断。

`source_report` 引用独立 `FinancialSourceReport`：

```text
FinancialSourceReport
id、workspaceId、currency
sourceSystem、sourceCursor?、reportHash（唯一来源身份）
declaredTotalMinor、periodFrom、periodTo
createdBy、createdAt
```

同一报告覆盖多个 Cohort 时，必须先以 source_report 创建并激活 AllocationSet，每个 Attestation 引用该 report 和 Set，并且声明额只能等于分配到该 Cohort 的有效金额。未分配报告或各批次声明合计超过报告总额时不能关账。

此外必须验证业务绑定：候选、客户和 Deal 必须来自同一条权威 `candidate → private-domain handoff → lead/customer → deal` 链。分配到 candidate 或 deal 时保存并验证该 BindingSnapshot，不能因为两个对象属于同一工作区就允许组合。

### 8.10 FinancialFact 与核销事件

```text
id、workspaceId
candidateId?、customerId?、dealId?
quoteVersionId?
factType：contract_won | payment_received | revenue_recognized |
          cogs_recognized | refund | bad_debt_written_off
amountMinor、currency
businessOccurredAt、recordedAt
provenance
sourceRef?、evidenceHash、externalId?
sourceIdentityRoot、sourceVersion
attributionSnapshot
commercialBindingSnapshot
commercialAmountHash?
correctsFactId?、correctionGroupId?
createdBy

LedgerVerificationEvent
id、workspaceId
ledgerType：cost | financial
ledgerEntryId
eventType：verified | rejected | reversed
reversesEventId?
correctionGroupId?
reason、decidedBy、recordedAt

LedgerSourceHead
workspaceId、ledgerType、sourceIdentityRoot（唯一）
currentLedgerEntryId、currentSourceVersion、revision
```

普通 CRM `DealEvent.payment` 不能自动映射为 `payment_received`，除非经过财务来源和核销规则验证。

任何关联 candidate/customer/deal 的财务事实都必须通过 CommercialBindingSnapshot 校验。Deal 级事实至少绑定 Deal；若要进入获客 ROI，还必须绑定其权威候选、handoff 链和成交时冻结的权威 QuoteVersion。商业金额哈希与 QuoteVersion 不一致、无权威报价或通过旧接口篡改的 Deal 一律不能进入实际 ROI。

首版实际毛利只有一个规范来源：已核销 `revenue_recognized - cogs_recognized - refund - bad_debt_written_off`。如果导入文件只提供“收入 + 实际毛利”，导入适配器可在预览中明确派生 `cogs = revenue - grossProfit`，用户确认后写入带 `derived_from_import` provenance 的 COGS 事实；仅提供毛利而没有收入时不能计算实际 ROI。

首版只支持整条核销，不支持部分核销：`pending → verified | rejected`，`verified → reversed`，`rejected/reversed` 为终态。每个状态转换锁定账本行，并且每条记录最多一个有效决定事件。

原始金额必须为正数。冲销通过 `reversed` 事件引用该记录的 `verified` 事件，且只能全额冲销一次；更正由“全额冲销原事实 + 新建 pending 事实”在同一事务中组成一个 `correctionGroupId`，不修改旧记录。每条记录同时保存业务发生时间和系统记录时间。

原始来源形成稳定 `sourceIdentityRoot`，首条记录为 sourceVersion=1。更正事务按固定顺序锁定 LedgerSourceHead 和当前记录，冲销当前版本、插入同 root 且 sourceVersion+1 的 pending 记录，再原子更新 Head。唯一键为 `(workspaceId, ledgerType, sourceIdentityRoot, sourceVersion)`；Head 保证同一来源只有一个当前版本。沿用原 externalId 不会冲突，也不会断开来源审计链；并发更正及幂等重试只能产生一个新版本。

### 8.10.1 CashSettlementAllocationSet

批次总额相等不能证明每个 Deal 已回款。现金、退款和坏账必须逐收入事实结算：

```text
CashSettlementAllocationSet
id、workspaceId、sourceFactId
version、status：draft | active | superseded
revision、createdBy、createdAt、activatedBy?、activatedAt?

CashSettlementAllocationItem
allocationSetId
targetRevenueFactId
dealId、quoteVersionId
amountMinor、currency
originalPaymentFactId?（refund 必填）
originalPaymentAllocationSetId?、originalPaymentAllocationItemId?（refund 必填）
commercialBindingSnapshot
```

约束：

- source 和 target 必须属于同一 Deal、QuoteVersion、币种和 CommercialBinding；
- 同一 source 的 active 分配合计不能超过其已核销金额；
- payment + bad debt 对收入义务的分配不能超过已确认收入；
- refund Item 必须同时通过 `originalPaymentFactId + originalPaymentAllocationSetId + originalPaymentAllocationItemId` 引用原 payment 的具体活动结算版本和收入事实，并降低净现金及净收入；
- 超额付款保留为未分配客户余额，不进入该 Deal ROI；
- 部分回款保留未结余额，不能被同批次其他 Deal 的多付金额抵消；
- 激活时先锁定 source Fact，再按 `(dealId, targetRevenueFactId)` 固定顺序锁定目标收入，原子校验所有 Item 并 supersede 前一 active Set；并发 payment 与 bad-debt 分配不能超额占用同一 RevenueFact；
- 激活 refund Set 时还要锁定被引用的 payment Set/Item，并校验它仍为 active 且指向同一 RevenueFact。存在 active refund 引用时，原 payment Set 不得改分配；必须先冲销或 supersede 相关 refund Set，防止退款悬挂到旧收入；
- 修改结算关系使用新版本，不能原地覆盖。ClosureVersion 通过 RoiSnapshotEntry 冻结实际使用的 active Settlement Set 及内容哈希。

### 8.11 RoiClosureVersion 与 RoiSnapshot

证明一个获客批次在某个截止时间的数据已经完整，并固定当时发布的结果。

```text
ClosureAttestation
id、workspaceId、cohortId、currency
aspect：acquisition_cost | revenue | cogs | cash | refund_bad_debt | attribution
periodFrom、periodTo、asOf
declaredTotalMinor?
sourceSystem、sourceCursor?
sourceReportId?、reportAllocationSetId?
reportHash、evidenceRefs[]
status：signed | superseded
signedBy、signedAt

RoiClosureSeries
id、workspaceId、cohortId、currency（唯一）
status：open | closed
currentClosureVersionId?、revision
updatedAt

RoiClosureSeriesEvent
id、closureSeriesId、revision
eventType：closed | reopened
previousClosureVersionId?、actorId、recordedAt

RoiClosureVersion
id、workspaceId、cohortId、currency、version
asOf
status：closed | superseded
previousClosureVersionId?
formulaVersion
membershipSnapshotHash
attestationSetHash
factSetHash、costSetHash、allocationSetHash、settlementSetHash
closedBy、closedAt

RoiSnapshot
closureVersionId
computedMetrics
coverage
calculationHash

RoiSnapshotEntry
closureVersionId
sourceType：cohort_member | attestation | cost | financial | verification | allocation_set | settlement_set
sourceId
effectiveAmountMinor?
sourceHash
```

纳入集合使用 `RoiSnapshotEntry` 子表保存，不把无限增长的 ID 数组塞进单行 JSON。查询可按 sourceId 追溯，也可用集合哈希验证未被篡改。

数据库无法从“没有更多记录”推断数据完整，因此关闭批次前必须由有权限的管理员为成本、收入、COGS、现金、退款/坏账和归因分别签署 ClosureAttestation。即使数据全部来自手工录入，也必须提供“人工台账已完整对账”的报告哈希或凭证。Attestation 的声明总额必须与截至 `asOf` 的账本聚合一致。同一来源报告可以支持多个批次，但必须引用活动 AllocationSet，且各批次不能重复声明同一份未分配全额。

相同 ClosureVersion 的结果永远不变。迟到回款、成员、冲销或更正必须针对该币种重开并生成后继版本，旧版本改为 `superseded` 但继续可查询。Cohort 本身不设全局 closed 状态，因此 CNY 和 USD 可分别关闭或只重开其中一种币种，互不修改对方版本。

`RoiClosureSeries` 是按 cohort+currency 的可变 guard：首次创建时为 open，成功 close 后为 closed；reopen 必须锁定 Series、提升 revision、追加 reopened Event 并转为 open，但不改写旧 Snapshot。只有 open Series 可创建新 ClosureVersion，成功后原子指向新版本并转为 closed。同一币种并发 reopen/close 通过 `If-Match` revision 只能一个成功，同键重放幂等。

关闭命令只提交 cohort、currency、`asOf` 和要使用的 Attestation ID 集合。后端根据截至该系统时间已经核销的追加式事件、活动 AllocationSet、回款对账、签署证明和查询完整性计算门禁；未满足时返回缺口，不能创建 ClosureVersion。`asOf` 同时约束业务发生时间和系统记录时间，确保时间旅行查询可复现。

### 8.12 AdvisorRecommendation

```text
id、workspaceId
audienceRole
type
summary、rationale
metricRefs[]、evidenceRefs[]、entityRefs[]（强类型且同工作区）
confidence
riskLevel
recommendedAction
status：proposed | accepted | ignored | completed | expired
assignedTo?
acceptedBy?、acceptedAt?
outcomeRefs[]
dataAsOf、inputSnapshotHash
modelSnapshotRef、promptVersion、schemaVersion
generationIdempotencyKey、expiresAt
createdAt、updatedAt
```

AI 建议保存的是可解释决策和受控动作，不保存模型内部推理链。

## 9. 确定性计算规则

所有金额使用“ISO 4217 币种 + 最小货币单位整数”，概率和比例使用基点，禁止浮点金额。

数值约束：

- 数量使用 `quantityMicros`，即六位小数定点整数；
- 币种小数位来自固定版本的 ISO 4217 指数注册表，例如 JPY=0、CNY=2、KWD=3；
- 中间乘除使用 BigInt，最终最小货币单位采用 `ROUND_HALF_UP`；
- 每个顶层行项目先取整，再汇总总额；首版只有一个顶层行项目；
- API 金额必须位于 JavaScript 安全整数和数据库 BIGINT 共同安全范围内，超限返回 `amount_out_of_range`；
- 概率、折扣、毛利阈值和 allocation 等“比例 BPS”位于 0..10000；`absoluteMinimumGrossMarginBps` 仅允许 0..9999；ROI BPS 是有符号结果，不受 10000 上限约束，但必须位于显式安全整数范围；
- 折扣、退款和冲销不使用负原始金额，而由明确字段或引用事件表达。

### 9.1 报价计算

```text
offeredLineAmountMinor
= roundHalfUp(offeredUnitPriceMinor × quantityMicros ÷ 1_000_000)

lineStandardCostMinor
= roundHalfUp(unitStandardCostMinor × quantityMicros ÷ 1_000_000)

listAmountMinor
= roundHalfUp(listUnitPriceMinor × quantityMicros ÷ 1_000_000)

absoluteFloorAmountMinor
= ceil(absoluteFloorUnitPriceMinor × quantityMicros ÷ 1_000_000)

netProductAmountMinor
= offeredLineAmountMinor - orderDiscountMinor

quotedAmountMinor
= netProductAmountMinor + surchargeMinor

estimatedFulfillmentCost
= Σ lineStandardCost + giftCost
  + configuredDeliveryCost

estimatedGrossProfit
= quotedAmount - estimatedFulfillmentCost

grossMarginBps
= round(estimatedGrossProfit × 10000 ÷ quotedAmount)

estimatedContribution
= estimatedGrossProfit - estimatedSalesCost - estimatedServiceCost

discountBps
= roundHalfUp(
  max(0, listAmountMinor - netProductAmountMinor)
  × 10000 ÷ listAmountMinor
)
```

策略激活和报价试算都要求 `listUnitPriceMinor > 0`，因此 `listAmountMinor` 必须为正，折扣公式不允许零分母。当报价金额小于或等于零时，毛利率不可计算并阻止提交。

套餐的 `unitStandardCostMinor` 已由冻结组件成本和套餐自身服务成本汇总，报价时不得再次叠加组件成本。赠送项按其冻结策略和数量单独计入成本。

绝对底价比较使用不含 surcharge 的 `netProductAmountMinor >= absoluteFloorAmountMinor`；附加费不能掩盖产品售价低于底线。数量大于 1 或为分数时，底价总额始终按数量向上取整。

首版确定性报价区间为：

```text
minimumMarginPrice
= ceil(estimatedFulfillmentCost × 10000 ÷ (10000 - absoluteMinimumGrossMarginBps))

minimumAllowedQuotedAmount
= max(absoluteFloorAmountMinor + requiredSurchargeMinor, minimumMarginPrice)

recommendedOpeningQuotedAmount
= max(listAmountMinor + requiredSurchargeMinor, minimumAllowedQuotedAmount)
```

`requiredSurchargeMinor` 只能由已激活 PricingPolicyVersion 中的封闭 `surchargePolicies[]` 根据地区、履约方式和账期等结构化输入确定性计算；没有命中时为 0，不接受 LLM 或前端直接填写。底价门禁同时校验 `netProductAmountMinor >= absoluteFloorAmountMinor` 与 `quotedAmountMinor >= minimumMarginPrice`。AI 可以解释为什么从标准价、底线价或客户目标价切入，但不能生成区间之外的权威金额。

### 9.2 报价审批门禁

门禁分为三类。

#### 硬阻断 `hard_blocked`

- 产品、策略或权威成本缺失；
- 策略未激活、已过期或版本冲突；
- 报价低于绝对底价或最低毛利价格；
- 折扣超过绝对折扣上限；
- 付款账期超过绝对账期上限；
- 赠送项数量或成本超过绝对上限；
- 金额、数量、币种或 BPS 越界；
- 客户、产品、候选或商机不属于同一工作区。

硬阻断不能通过主管审批绕过，必须修复数据或生成新版本。

#### 普通确认 `confirmation_required`

- 报价位于允许区间内；
- 折扣、毛利和账期全部符合策略。

仍需非提交人负责人确认，不能直接对外发送。

#### 异常审批 `exception_approval_required`

- 折扣超过普通销售阈值但没有突破绝对底线；
- 毛利率低于普通目标但不低于绝对最低毛利；
- 付款账期超过普通阈值但没有突破绝对上限；
- 赠送项超过普通允许范围但没有突破绝对上限；
- 客户信用或回款风险超过阈值；
- 人工要求升级审批。

异常规则合并为一个任务，决策人必须同时具备合并后的全部 `requiredCapabilities`；提交人不得自批。租户策略必须分别配置“普通阈值”和“绝对底线”，不能用一个 `floorPrice` 同时表达可越权和不可越权边界，也不得将 capability 简化为单一线性角色等级。

### 9.3 预计 ROI

预计 ROI 是计划指标，不能显示为实际经营收益。

```text
probabilityWeightedGrossProfit
= approvedQuoteGrossProfit × closeProbabilityBps ÷ 10000

expectedRoiBps
= round(
  (probabilityWeightedGrossProfit - attributedEstimatedAcquisitionCost)
  × 10000
  ÷ attributedEstimatedAcquisitionCost
)
```

预计 ROI 必须同时显示成交概率来源、报价版本和成本覆盖率。

预计聚合对每个 Deal 只读取查询 `asOf` 时有效的单一 `DealAuthoritativeQuoteEvent.quoteVersionId`；只有 `asOf=now` 时才可用当前 DealAuthoritativeQuote 指针作为等价快捷路径：

- `approved` 且对应 Deal 尚未 won/lost 的版本按冻结概率加权；
- `superseded`、`expired`、`rejected` 和 `lost` 不进入预计聚合；
- 已 won 的交易进入实际经营区，不再重复出现在预计管道；
- 预计获客成本为零时返回 `not_computable: zero_estimated_cost`；
- 成本覆盖率不足时可以展示预计毛利，但不能展示貌似精确的预计 ROI；
- 禁止读取已经加权的 `FinancialValueDecision.expectedGrossProfitMinor` 再乘成交概率。

### 9.4 实际 ROI

首版实际 ROI 定义为“获客批次毛利 ROI”：

```text
verifiedGrossProfit
= verifiedRevenue - verifiedCogs - verifiedRefunds - verifiedBadDebt

actualRoiBps
= round(
  (verifiedGrossProfit - verifiedAcquisitionCost)
  × 10000
  ÷ verifiedAcquisitionCost
)
```

`verifiedRevenue` 采用收入确认事实；`payment_received` 单独形成现金视图。由于本产品已经确认实际 ROI 必须建立在真实回款基础上，首版结账同时要求该批次回款已对账完成，但不把“回款倍数”冒充毛利 ROI。

现金完整性逐 Deal、QuoteVersion 和 RevenueFact 判断：每条已核销收入都必须满足 `allocatedPayment + allocatedBadDebt = recognizedRevenue`，且每条 refund 都已完整关联原 payment 和收入；净现金为 `allocatedPayment - allocatedRefund`。任何部分回款、未分配多付、跨 Deal 抵消或未关联退款都只展示进度，实际 ROI 保持 `not_computable: cash_reconciliation_incomplete`。

以下指标独立展示，不得命名为 ROI：

- 合同 ROAS = 成交合同额 ÷ 获客成本；
- 回款倍数 = 已到账金额 ÷ 获客成本；
- 回款率 = 已到账金额 ÷ 成交合同额。

### 9.5 实际 ROI 可计算门禁

只有以下条件全部满足才返回 `computed`：

- 已核销获客成本大于零；
- 成本期间已关闭；
- 每笔获客交易都绑定成交时冻结的权威 QuoteVersion，商业金额哈希一致；
- 实际收入、成本和退款已核销；
- 回款已对账且现金完整性门禁通过；
- 获客归因完整；
- 所有聚合金额币种一致；
- 查询没有触发安全截断；
- 批次在指定 `asOf` 已结账。

否则返回 `not_computable` 和精确原因：

```text
cost_missing
cost_not_closed
gross_profit_unverified
cash_reconciliation_incomplete
attribution_incomplete
multi_currency_without_fx
zero_cost
query_truncated
cohort_not_closed
```

### 9.6 获客批次和时间窗口语义

首版采用获客批次口径，避免把“发现时间”和“成交时间”限制在同一个查询窗口：

- 批次成员是 `firstDiscoveredAt` 位于 `[cohortFrom, cohortTo)` 的去重候选；
- 报价、成交、收入、回款、退款和成本事实读取到 `asOf`，不要求发生在发现窗口内；
- 直接属于 Plan、Run 或候选的成本按权威归因进入批次；共享成本只有激活完整 `AttributionAllocationSet` 后才进入；
- 晚到的成交或回款通过更大的 `asOf` 或重开批次纳入，不回写已经发布的结账版本；
- 一个候选在同一平台只属于其首次权威发现批次，避免重复计算；
- 无法证明候选、Outcome 或成本归属时，降低归因覆盖率并阻止实际 ROI。

覆盖率统一使用“满足条件的金额 ÷ 应覆盖总金额”计算；当应覆盖总金额无法确定时状态为 `unknown`，不能用记录条数替代金额覆盖率。

## 10. 前端信息架构

继续使用 `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend` 的新版前端，不重做视觉系统。

### 10.1 AI 增长参谋首页

该页面不是单一聊天框，而是“结论、数据、依据、行动”工作台。

首屏包括：

- 今日经营结论；
- 三至十个优先客户；
- 待审批报价；
- 预计 ROI 和实际 ROI；
- 数据缺口与风险；
- 自然语言输入框；
- AI 任务状态；
- 建议采纳和完成情况。

每条建议必须显示：

- 建议内容；
- 判断依据；
- 数据时间和可信状态；
- 关联客户、报价、指标或证据；
- 风险；
- 允许的受控动作。

允许动作仅包括：

- 打开客户作战卡；
- 创建报价草稿；
- 创建待办；
- 提交人工审批；
- 跳转补录成本或回款；
- 标记采纳、忽略或完成。

### 10.2 产品与报价规则

- 商品、服务和套餐列表；
- 标准价、成本、底价、折扣和最低毛利；
- 套餐组成；
- 生效时间和版本历史；
- 审批规则；
- 缺失或过期提醒。

### 10.3 报价决策工作台

从候选详情或 CRM 商机进入，保持客户上下文。

页面并列展示：

- 客户背景和作战卡；
- 客户目标价与采购偏好；
- 产品或套餐选择；
- 标准价、建议报价和底线价格；
- 折扣率、毛利和贡献利润；
- 触发的审批规则；
- AI 谈判策略、分角色话术和不建议动作；
- 报价版本对比；
- 审批时间线。

### 10.4 财务事实与导入

- 渠道成本；
- 成交与回款；
- 退款；
- 履约成本；
- 实际毛利；
- 凭证、核销和更正；
- Excel 模板下载、导入预览、逐行结果和错误导出。

### 10.5 ROI 经营看板

页面严格分为：

1. 预计经营结果；
2. 已核销经营结果。

展示内容：

- 平台、计划、批次和币种筛选；
- 预计成交、预计毛利和预计 ROI；
- 实际回款、实际毛利和实际 ROI；
- 合同 ROAS 和回款进度；
- 成本、毛利和归因覆盖率；
- 计算公式与证据；
- 不可计算原因；
- 数据缺口修复入口。

### 10.6 前后端仓库和发布边界

产品前端以独立仓库 `/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend` 为唯一新版实现；GoodJob-1.09 内的 legacy `frontend` 不重复开发这些页面，只保留既有兼容功能。

跨仓协作规则：

- GoodJob-1.09 的 OpenAPI/JSON Schema 是唯一权威契约；
- 每个契约发布生成不可变 `contractVersion` 和 SHA-256；
- 新版前端提交由该契约生成的类型和对应 contract hash；
- 前端 API fixture、mock 和 E2E 必须使用同一生成契约；
- 兼容字段使用 additive minor 版本，破坏性变化提升 major；
- 发布门禁同时运行后端契约/构建和新版前端 self-test/build/E2E；
- 实施使用两个独立 worktree，先提交权威契约和后端，再提交锁定该契约版本的前端；
- 不把外部前端文件直接复制回 legacy frontend，避免两套页面漂移。

## 11. 后端架构

不引入新智能体框架。复用现有 GoodJob 后端、Acquisition Copilot、Pi 工具、审核、CRM 和 TradeDocument 能力。

建议新增边界模块：

```text
catalog-domain
pricing-policy-service
quote-calculation-service
quote-approval-service
acquisition-cost-ledger
financial-fact-ledger
finance-import-service
acquisition-roi-query
growth-advisor-query
advisor-recommendation-service
```

确定性计算、持久化、审计和 AI 解释必须是分离的模块。AI 网关故障不能改变报价或 ROI 结果。

### 11.1 核心 API

```text
GET               /api/v1/growth/bootstrap

GET/POST          /api/v1/catalog/items
GET/PATCH         /api/v1/catalog/items/:id
POST              /api/v1/catalog/items/:id/retire
GET/POST          /api/v1/catalog/pricing-policies
GET               /api/v1/catalog/pricing-policies/:id
POST              /api/v1/catalog/pricing-policies/:id/activate
POST              /api/v1/catalog/pricing-policies/:id/retire
GET/POST          /api/v1/catalog/packages/:itemId/versions
GET/PATCH         /api/v1/catalog/package-versions/:id
POST              /api/v1/catalog/package-versions/:id/activate
POST              /api/v1/catalog/package-versions/:id/retire

GET/POST          /api/v1/quotes/cases
GET               /api/v1/quotes/cases/:id
POST              /api/v1/quotes/cases/:id/bind-deal
POST              /api/v1/quotes/cases/:id/close
POST              /api/v1/quotes/cases/:id/cancel
POST              /api/v1/quotes/cases/:id/preview
POST              /api/v1/quotes/cases/:id/versions
GET               /api/v1/quotes/cases/:id/versions
GET               /api/v1/quotes/versions/:id
POST              /api/v1/quotes/versions/:id/submit
POST              /api/v1/quotes/versions/:id/approve
POST              /api/v1/quotes/versions/:id/reject
POST              /api/v1/quotes/versions/:id/expire
GET               /api/v1/quotes/versions/:id/approvals
GET               /api/v1/quotes/publication-operations/:id
POST              /api/v1/quotes/publication-operations/:id/retry
POST              /api/v1/quotes/deals/:dealId/decision

GET/POST          /api/v1/acquisition/cost-entries
GET/POST          /api/v1/acquisition/cost-estimates
POST              /api/v1/acquisition/cost-estimates/:id/activate
POST              /api/v1/acquisition/cost-estimates/:id/supersede
POST              /api/v1/acquisition/cost-entries/:id/verify
POST              /api/v1/acquisition/cost-entries/:id/reject
POST              /api/v1/acquisition/cost-entries/:id/reverse
POST              /api/v1/acquisition/cost-entries/:id/correct
GET/POST          /api/v1/acquisition/attribution-allocation-sets
GET               /api/v1/acquisition/attribution-allocation-sets/:id
POST              /api/v1/acquisition/attribution-allocation-sets/:id/activate

GET/POST          /api/v1/finance/facts
POST              /api/v1/finance/facts/:id/verify
POST              /api/v1/finance/facts/:id/reject
POST              /api/v1/finance/facts/:id/reverse
POST              /api/v1/finance/facts/:id/correct
GET/POST          /api/v1/finance/source-reports
GET               /api/v1/finance/source-reports/:id
GET/POST          /api/v1/finance/settlement-allocation-sets
GET               /api/v1/finance/settlement-allocation-sets/:id
POST              /api/v1/finance/settlement-allocation-sets/:id/activate
GET               /api/v1/finance/import-templates/:kind
POST              /api/v1/finance/imports/preview
POST              /api/v1/finance/imports/:previewId/commit
GET               /api/v1/finance/imports/:id
GET               /api/v1/finance/imports/:id/errors

GET/POST          /api/v1/acquisition/cohorts
GET               /api/v1/acquisition/cohorts/:id
GET/POST          /api/v1/acquisition/cohorts/:id/attestations
POST              /api/v1/acquisition/cohorts/:id/close
GET               /api/v1/acquisition/cohorts/:id/closures
POST              /api/v1/acquisition/roi-closures/:closureVersionId/reopen

GET               /api/v1/acquisition/performance
GET               /api/v1/acquisition/growth-performance
GET               /api/v1/acquisition/advisor/today
POST              /api/v1/acquisition/advisor/recommendations/:id/accept
POST              /api/v1/acquisition/advisor/recommendations/:id/ignore
POST              /api/v1/acquisition/advisor/recommendations/:id/complete
```

所有列表接口必须定义分页、排序和工作区过滤；敏感金额按 capability 脱敏。所有命令接口定义精确状态转换、错误码、`Idempotency-Key` 和 `If-Match`，不能只依赖路由层的通用校验。

### 11.2 Growth Performance 契约

现有 `/api/v1/acquisition/performance` 保持原 V1 Schema、旧 `roi:not_computable` 和现有 Pi 工具不变。新建 `/api/v1/acquisition/growth-performance` 承载批次报价、现金和 ROI，避免破坏 `additionalProperties:false` 的旧客户端。

```text
GET /api/v1/acquisition/growth-performance
  ?cohortId=<id>
  &currency=CNY
  &asOf=<date-time>
  &planId=<optional-first-touch-plan-slice>
  &closureVersionId=<optional-exact-published-snapshot>

expectedRoiByCurrency[]
actualRoiByCurrency[]
cashByCurrency[]
coverage
dataGaps[]
```

实际 ROI 的选择规则：

1. 提供 `closureVersionId` 时，精确读取该不可变快照，并校验 cohort/currency/plan slice；
2. 只提供 `cohortId/currency/asOf` 时，在所有已发布状态 `closed | superseded` 中选择 `closure.asOf <= request.asOf` 的最大 `asOf`，相同 asOf 取最高版本；
3. 没有可用 ClosureVersion 时，预计区可以实时计算，实际区返回 `not_computable: cohort_not_closed`；
4. `planId` 只切片同一 ClosureVersion 中 firstPlanId 对应的成员和成本，不创建第二套批次成员；
5. 响应必须返回 `closureVersionId`、`formulaVersion`、`calculationHash`、`dataAsOf` 和 `membershipSnapshotHash`；
6. 已发布快照永远不按当前账本实时重算。

该查询必须由数据库聚合实现，不复用旧 Performance 的 100 Run/500 Candidate 内存扫描安全上限。查询触发任何安全截断时，实际 ROI 必须返回 `not_computable: query_truncated`。

新契约拥有独立 Schema 版本、OpenAPI 路径和生成类型；页面迁移完成前旧接口继续服务现有老板简报。新的 AI 工具名称为 `get_growth_performance`，不静默改变旧工具语义。

示例实际 ROI 投影：

```json
{
  "currency": "CNY",
  "status": "computed",
  "basis": "verified_gross_profit",
  "verifiedGrossProfitMinor": 800000,
  "verifiedAcquisitionCostMinor": 200000,
  "roiBps": 30000,
  "costCoverageBps": 10000,
  "marginCoverageBps": 10000,
  "cashCoverageBps": 10000,
  "attributionCoverageBps": 10000
}
```

## 12. AI 增长参谋工具边界

复用现有 Copilot 会话、任务、模型快照和受控工具执行器，增加以下工具：

```text
list_catalog_items
get_pricing_policy
preview_quote
create_quote_draft
list_pending_quote_approvals
get_quote_decision
get_growth_performance
list_financial_data_gaps
create_advisor_recommendation
create_quote_approval_task
create_sales_todo
record_recommendation_outcome
```

工具规则：

1. `preview_quote` 调用确定性服务，模型不能提交计算结果；
2. `create_quote_draft` 只能保存草稿，不能提交或批准；
3. AI 不能调用财务核销、成本修改和审批通过接口；
4. ROI 工具只读取权威查询结果，不能推算缺失数据；
5. 每条建议保存指标、实体和证据引用；
6. 不向用户展示模型内部推理链，只展示可验证依据；
7. 模型失败时，确定性页面和审批流程继续可用。

`create_review_task` 已经属于现有候选外联/转换审核工具，不扩展成报价审批。新增 `create_quote_approval_task` 使用独立目标联合和 capability，防止同名工具出现两种不兼容语义。

所有新增工具必须：

- 使用独立版本化 TypeBox/JSON Schema；
- 注册到现有 Pi 精确 allowlist 和执行模式；
- 校验所有引用属于同一工作区；
- 冻结 model、prompt、tool schema 和数据 `asOf`；
- 使用稳定调用哈希和幂等键；
- 复用现有工具审计与任务状态，不建立第二套 Agent 运行时。

## 13. Excel 导入设计

首版提供成本事实和财务事实两类模板。

导入过程：

```text
上传文件
→ 解析工作簿
→ 字段映射与预览
→ 格式校验
→ 权限与租户校验
→ 外部编号和 evidenceHash 去重
→ 逐行业务校验
→ 正确行以 pending 状态入库
→ 错误行保留原因
→ 生成导入报告和错误文件
```

要求：

- 正确行与错误行隔离，支持部分成功；
- 金额必须指定币种；
- 日期必须显式时区或采用租户时区；
- 事实必须指定来源；Excel 不能指定 `verified`，所有导入行统一进入 pending；
- 外部编号重复时返回既有记录，不重复入账；
- 导入写入具备幂等键；
- 不在浏览器中保存原始凭证的敏感内容；
- 导入结果可审计、可重放但不能重复产生事实。

## 14. 一致性、权限与错误处理

### 14.1 一致性

- 所有写接口要求租户隔离、权限和幂等键；
- HTTP `Idempotency-Key` 在 workspace + actorId + method + canonical path 下唯一，并保存规范 request hash 与 operation/resource ID；同键同请求重放时必须重新鉴权并按当前 capability 投影响应，同键异请求返回 `409 idempotency_conflict`；不缓存可跨权限泄露的完整敏感响应；
- 业务去重键与 HTTP 幂等键分离；财务来源身份和发布 operation 键永久保留，即使请求者变化也不能重复产生业务事实；
- 报价、策略和批次命令使用 `If-Match` 进行乐观并发校验；
- 报价提交使用策略版本、QuoteCase revision 和候选/商机快照进行校验；现有 Deal 没有版本号时，首版先使用稳定内容哈希，不伪造 revision；
- 价格策略过期或变化后必须重新试算；
- 同一报价版本最多一个活动审批；
- 批准时按固定顺序先锁定 DealAuthoritativeQuote，再锁定 QuoteCase；正式版本、审批、Deal 权威指针与 Outbox 在同一 MySQL 事务提交；
- PI 和 quote DealEvent 由可恢复 Worker 根据 QuotePublicationOperation 幂等发布；Acquisition Outcome 只由现有 CRM Outcome Reconciler 根据 DealEvent 稳定键写入；
- 财务事实不能覆盖，错误通过冲销或更正处理；
- 结账后新增事实必须重开批次或进入下一版本；
- Excel 行身份优先使用 workspace + source + factType + externalId；没有 externalId 时使用 fileHash + sheetName + rowNumber；evidenceHash 只用于内容冲突检查，不能单独把两笔合法同金额事实去重；
- CRM 报价事件必须引用 quoteId 和 quoteVersion；
- PI 必须引用已经批准的报价版本。

MySQL 落地要求：

- 策略激活事务锁定 CatalogItem，再检查活动时间区间重叠；
- DealAuthoritativeQuote 行锁保证每个 Deal 跨 Case 只有一个正式版本；QuoteCase 行锁只保证单 Case 版本分配和状态转移串行化；
- LedgerSourceHead 保证每个来源只有一个当前版本，`(workspaceId, ledgerType, sourceIdentityRoot, sourceVersion)` 唯一索引保证更正链不重复；
- 同一幂等键的 reservation 在业务行锁之前获取，避免并发缺口锁死锁；
- 内存仓储与 MySQL 仓储通过同一并发行为测试；
- 报价、账本、批次和 Outbox 使用新增的追加式专用仓储，不接入现有全量 `persistAll/replaceRows` 写法。

### 14.2 错误状态

前端至少区分：

```text
pricing_policy_missing
pricing_policy_stale
quote_hard_blocked
cost_missing
quote_requires_approval
quote_version_conflict
approval_already_decided
approval_self_decision_forbidden
quote_publication_failed
financial_fact_duplicate
financial_fact_unverified
financial_fact_conflict
ledger_reversal_exceeds_balance
import_partial_success
roi_not_computable
multi_currency_without_fx
ai_explanation_unavailable
```

AI 解释失败只影响解释区，不影响确定性报价、审批和 ROI 查询。

### 14.3 安全

- 后端重新计算并验证所有金额；
- API 不返回成本权限以外的敏感字段；
- 凭证使用受控文件引用而非公开 URL；
- 权威成本、底价和实际毛利受字段级权限保护；
- 审批、核销和结账均写入审计记录；
- 所有模型输入执行最小披露，避免发送无关财务数据；
- 真实模式禁止从前端 demo store 回填金额。

## 15. 迁移与兼容策略

### 15.1 产品主数据

1. 扫描每个工作区的 CommissionProduct；
2. 创建对应 CatalogItem 和初始 PricingPolicyVersion；
3. 保存双向映射和迁移报告；
4. 验证币种、价格、成本和历史提成快照；
5. 验证通过后将旧价格/成本写入口切换为只读兼容投影；
6. 无法迁移的记录进入人工修复队列，不能用于正式报价。

### 15.2 历史报价和 PI

- 历史 Deal quote 事件和 PI 保持可读，标记 `legacy_unverified`；
- 不凭空生成 QuoteVersion 或定价策略快照；
- 用户可通过人工映射流程将历史单据关联到新目录，但历史数据不参与预计 ROI；
- 新获客来源 Deal 必须使用 QuoteVersion 权威链；
- 非获客旧外贸流程继续可用，但不能写入新获客 ROI 归因。

### 15.3 历史 Outcome、回款与提成数据

- `FinancialFact` 是实际 ROI 的唯一实际财务账本；
- 现有 Acquisition Outcome 继续用于漏斗和归因事件，不直接充当收入、回款或成本事实；
- 现有 `MonthlySalesRecord(basisType=receipt)` 继续用于提成和运营报表，不自动计入实际 ROI；
- 管理员可通过一次性迁移预览，将有可信凭证的历史 receipt 投影为 pending FinancialFact；
- 投影使用稳定 source identity，核销后才进入 ROI；Outcome、MonthlySales 和 FinancialFact 之间保存映射，任何查询只能从 FinancialFact 聚合一次；
- 无法证明真实到账或权威报价的历史记录保持运营事实，不伪造财务事实。

### 15.4 Performance 与前端

- 旧 `/performance`、旧 Pi 工具和旧老板简报保持兼容；
- 新 `/growth-performance` 和 AI 工具独立上线；
- 新版前端先通过 capability 和 contractVersion 探测功能，再切换真实页面；
- legacy frontend 不复制新版页面；
- 回滚只关闭新功能入口，不删除已写入的追加式账本或报价历史。

## 16. 开发顺序

### 阶段 0：契约、工作区和兼容门禁

- workspaceId/capability 基础；
- OpenAPI、Schema 和跨仓 contractVersion；
- 旧 PI/Deal quote 绕过门禁；
- CommissionProduct 迁移投影；
- 专用追加式仓储和 Outbox 基础。

验收：新领域不能越权、不能被旧接口绕过，并有可回滚迁移报告。

### 阶段 1：产品目录与报价规则

- 目录对象、价格策略和版本；
- 单行和套餐数据模型；
- 后端 CRUD、权限、持久化和契约；
- 新版前端维护页面。

验收：任意租户可配置一套可追溯报价规则。

### 阶段 2：报价决策闭环

- 确定性试算；
- 折扣、底价、毛利和账期门禁；
- 报价版本；
- AI 解释和谈判策略；
- 提交、批准、驳回；
- 生成 PI；
- CRM 报价事件。

验收：一条抖音候选能形成经过人工批准的正式报价。

### 阶段 3：财务事实和 Excel 导入

- 渠道成本；
- 成交、回款、退款和实际成本；
- 核销、更正和凭证；
- Excel 模板、预览、逐行结果和错误导出。

验收：不连接外部 API 也能形成可审计的真实经营数据。

### 阶段 4：预计与实际 ROI

- 批次、平台、计划和币种聚合；
- 预计和实际 ROI；
- 合同 ROAS、回款进度和覆盖率；
- 结账和不可计算原因；
- 新版前端看板。

验收：数据完整时输出可验证 ROI；数据不完整时只输出缺口。

### 阶段 5：全局 AI 增长参谋

- 今日结论；
- 优先客户；
- 待审批报价；
- ROI 和数据缺口；
- 自然语言问答；
- 创建草稿、审批任务和销售待办；
- 建议采纳及 Outcome 回流。

验收：每条 AI 建议都能追溯到真实数据并转成受控任务。

### 阶段 6：闭环验收

最终真实演示：

```text
抖音公开获客
→ 主体核验
→ 意向评分与作战卡
→ 产品报价
→ 人工审批
→ CRM
→ 成交与回款
→ 成本核销
→ 实际 ROI
→ AI 增长参谋复盘并创建下一步任务
```

## 17. 测试策略

### 17.1 单元测试

- 金额整数计算和舍入；
- 折扣、底价、毛利和贡献利润；
- 预计 ROI 与实际 ROI；
- 零成本、负数、退款和冲销；
- 币种隔离；
- 最低毛利价格向上取整；
- 审批门禁；
- 结账和成本、毛利、现金、归因覆盖率；
- 获客批次与 `asOf` 跨期结果；
- 黄金样例：毛利 100、成交概率 40%、获客成本 10 时预计 ROI 为 300%，证明没有二次概率加权；
- JPY、CNY、KWD、分数数量、负毛利、9999 BPS 最低毛利和金额上限；
- 数量大于 1 时，单位底价必须先按数量换算为整单底价；分数数量使用向上取整的 floor，surcharge 不得掩盖产品净价低于底线；
- 属性测试验证报价不低于绝对底线、取整一致和公式哈希稳定；
- AllocationSet 余数分配后子项总额严格等于原金额。

### 17.2 仓储与领域测试

- 多租户隔离；
- 幂等和重复事实；
- 报价版本不可变；
- 并发提交和并发审批；
- 价格策略有效期；
- 核销、更正和重开批次；
- 共享成本分配合计和未分配门禁；
- 收入加毛利导入只能派生一条带 provenance 的 COGS；
- MySQL 与内存实现行为一致；
- 两个真实 MySQL 连接下的策略激活、版本分配、并发审批、核销、冲销和结账竞争；
- 相同幂等键同 payload 重放、异 payload 冲突、跨工作区嵌套引用拒绝；
- 非法状态转换、自审批和重复冲销；
- `asOf` 时间旅行、迟到核销、重开后旧 RoiSnapshot 保持不变；
- 同一 Deal 经历报价 A 批准、报价 B 替代、成交与丢单前后的四个 `asOf` 时点均能从 QuoteLifecycleEvent 和 DealAuthoritativeQuoteEvent 精确重建；
- 同工作区但错误 candidate/customer/deal 绑定必须拒绝；
- 跨 QuoteCase 批准时 Deal 级权威报价仍然唯一；
- 同一 Deal 存在多个历史 QuoteCase 时，预计聚合只读取指定 `asOf` 的单一 DealAuthoritativeQuoteEvent，不按 Case 遍历、不重复计入；
- 两个 candidate-only QuoteCase 并发绑定同一 Deal 只能一个成功，首次批准时也能锁定预先创建的 Deal guard；
- candidate-only Case 可完成 bind→submit，同 Deal 重放 bind 幂等，改绑其他 Deal 拒绝；存在 submitted/approved 版本时 close/cancel 拒绝，won/lost/expiry 使用权威状态机关闭；
- DealAuthoritativeQuoteEvent 和 QuoteLifecycleEvent 在同一毫秒发生多次转移时仍按单调 revision 稳定重建，重复 revision 被唯一键拒绝；
- PublicationOperation queued/running 期间先执行 won/lost 后，旧 Worker 恢复必须因 authority revision 失效而停止，不能把 Deal 回写为 quoted；
- 同一套餐、币种和重叠时间范围并发激活只能有一个 PackageVersion 成功，价格策略必须冻结它的精确版本；
- PackageVersion 只有 draft 可 PATCH，两个相同 revision 的并发 PATCH 只能一个成功，active/retired 的任何内容修改都拒绝；
- 同一成本 sourceStableKey 并发激活只能一个 Estimate 版本成功，plan/provider/manual 不能把同一经济成本重复计入；
- provenance 为 unknown/estimated 的逐请求证据只能生成 Estimate，不能进入 CostEntry 核销链；
- 并发激活 AllocationSet 只能一个成功，纠错后旧 Set 不再进入新 Closure；
- ClosureAttestation 总额、报告哈希和成员快照必须与 ClosureVersion 一致；
- 用户降权后重放旧 HTTP 幂等键不能看到敏感成本；
- Outbox 双 Worker claim、租约过期、fencing、崩溃恢复和 ACK 丢失；
- Run API 成本逐次增长、供应商核验后不重复计费。
- `super_admin(teamId="all")` 未选择具体 ActiveWorkspaceContext 时任何业务写入均拒绝，选择后仍必须通过该工作区 capability 校验；
- 不同 Deal 的 payment/refund/bad-debt 不能交叉结算，部分回款、溢付和未关联退款都必须阻止实际 ROI 关账；
- 并发激活 payment 和 bad-debt Settlement Set 不能超额占用同一 RevenueFact；旧 ClosureVersion 冻结的 Settlement Set 在后续 supersede 后仍可完整复现；
- 存在 active refund 时并发重分配原 payment 必须失败；退款必须冻结具体 payment Set/Item，不能只按 payment Fact 悬挂引用；
- 同一外部来源更正使用 LedgerSourceHead 顺序增加 sourceVersion，并发更正和同键重放只产生一个新 pending 版本；
- 同一 FinancialSourceReport 分配到多个 Cohort 时，各 Attestation 声明额之和不得超过报告总额，未引用 active report AllocationSet 时不能关账；
- 同一 cohort 的 CNY/USD ClosureSeries 独立转移；reopen 只打开指定币种，并发 reopen/close 受 revision 栅栏保护；
- capability registry 拒绝未知能力，每种 discount/margin/payment/gift/credit/manual 审批规则都生成精确的 requiredCapabilities 快照；

### 17.3 契约测试

- OpenAPI Schema；
- 生成 TypeScript 类型；
- 请求和响应封闭字段；
- 权限错误和标准错误信封；
- 预计与实际指标不能混用；
- `not_computable` 原因必须可枚举；
- 旧 Performance/OpenAPI/Pi 工具保持兼容；
- 新 Growth Performance、Quote、Ledger 和 Cohort 生成类型与前端 contract hash 一致；
- 历史 CommissionProduct、PI 和 DealEvent 迁移契约。

### 17.4 导入测试

- 正确文件；
- 错误格式；
- 重复行；
- 部分成功；
- 超大文件限制；
- 恶意公式、路径和内容；
- 重试不重复入账。

### 17.5 纵向集成测试

```text
候选
→ 报价试算
→ 人工审批
→ CRM 已报价
→ 成交与回款
→ 成本核销
→ 实际 ROI
→ AI 参谋读取并创建下一步任务
```

必须断言：

- 只有一次有效报价和审批；
- CRM 事件引用正确报价版本；
- AI 没有修改权威金额；
- 未核销时实际 ROI 不可计算；
- 完整核销后实际 ROI 与公式一致；
- 真实模式没有本地演示数据；
- 不产生自动外联动作；
- 旧 CRM quote 和 PI 接口不能绕过获客正式报价；
- 公开 Outcome 写入接口不能直写 quoted/won/lost；只有 Reconciler 内部 capability 和已验证 DealEvent 稳定键可以生成这三类 Outcome；
- 报价前丢单使用 `pre_quote_disqualified`，不需 QuoteVersion 但不得带金额或进入 ROI；报价后丢单必须引用当前权威 QuoteVersion；
- 客户端尝试篡改获客 Deal 的 product/quantity/unitPrice/amount/currency/amountType 必须拒绝，即使 manager/admin 也不能无权威报价直接跳转 quoted/won/lost；
- 篡改后的 Deal 金额哈希、无 DealAuthoritativeQuote 的 won Event，或非当前 QuoteVersion 的成交命令，都必须阻止 Outcome 归因和 ROI 关账；
- 报价批准后，在 PI 投影、CRM DealEvent 发布和 Reconciler 写 Outcome 每个步骤注入故障，分别验证 Outbox 与 Reconciler 重放不产生重复；
- 同源 API 运行成本在补录供应商发票后仍只计一次；
- 共享成本未完整分配时实际 ROI 不可计算；
- 超大批次使用数据库聚合，任何安全截断都不能返回 `computed`；
- DealEvent 是 quoted Outcome 的唯一触发源，Worker 不直接重复写 Outcome；
- 任意 `asOf` 和精确 `closureVersionId` 选择正确不可变快照；
- 部分回款只显示现金进度，实际 ROI 保持不可计算；
- Deal A 少回款与 Deal B 多回款即使批次总额相等也不能相互抵消，逐 Deal Settlement 不守恒时不可计算；
- 成本、收入或归因来源未签署完整性 Attestation 时不能关闭批次。

### 17.6 前端验收

- self-test；
- 单元测试；
- 生产构建；
- 浏览器 E2E；
- 真实/演示模式隔离；
- 1280、1366 和 1440 宽度布局；
- 金额、比例、币种和数据状态可访问性。

## 18. 质量门槛

每个阶段合并前必须满足：

- 新增核心逻辑先有失败测试；
- 前后端契约同步；
- 关键写入幂等；
- 租户和权限测试通过；
- 没有把 AI 预测冒充实际事实；
- 没有新增第二套重复业务模型；
- 没有无意义兼容代码或演示回退；
- 定向测试、相关全量测试、构建和 `git diff --check` 通过；
- 重大阶段完成后进行独立代码审查。

## 19. 最终验收标准

1. 租户可创建产品、服务和套餐，并维护版本化价格与成本；
2. 报价引擎能计算标准价、底价、折扣、毛利和贡献利润；
3. 异常报价不能绕过主管审批；
4. 批准报价能生成或绑定 PI，并在 CRM 中记录权威版本；
5. 后台录入和 Excel 导入能形成可核销成本与财务事实；
6. 预计 ROI 和实际 ROI 使用独立公式和状态；
7. 实际 ROI 只有在严格门禁满足后才显示；
8. AI 增长参谋能够引用真实报价和经营事实解释建议；
9. AI 只能创建草稿、待办和审批任务，不能直接批准或发送；
10. 抖音获客到实际 ROI 和经营复盘的纵向闭环通过自动测试；
11. 新版前端继续使用当前设计体系，真实模式无演示数字；
12. 所有金额、版本、审批、财务事实和建议结果可追溯；
13. QuoteVersion 是获客正式报价唯一权威，旧 CRM/PI 路径不能绕过；
14. 团队共享数据使用统一 workspaceId，敏感成本字段按 capability 脱敏；
15. 同一 RoiClosureVersion 在迟到回款、冲销或重开后仍返回原始快照；
16. 产品、历史 PI 和 DealEvent 的迁移可审计、可回滚且不伪造事实。

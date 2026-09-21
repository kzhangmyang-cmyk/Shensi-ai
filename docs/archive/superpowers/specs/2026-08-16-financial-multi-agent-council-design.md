# 财务多智能体委员会与最佳行动组合设计

日期：2026-08-16

状态：P1–P5 实现和本地发布验证已完成。Growth contract 固定为 `1.0.10`（`sha256:dcbbc8e43c0ba43cd8e628cb49bd43f8f1a77810d3f864c83e11f4ac2fa0aee3`）；Memory vertical 2/2、前端 fixture E2E 10/10、真实 InnoDB 83/83 和无 route-intercept Chromium E2E 1/1 已通过。浏览器链路使用隔离 MySQL 库、真实 session/CSRF、Growth 路由、异步工作器与派发回执；模型输出使用确定性 test-only adapter。

## 1. 背景

GoodJob 已有 `business-advisor` 第一版确定性分析引擎，登记了六个产品角色：AI 经营总管、财务分析、利润分析、成本分析、现金流分析和税务健康。现有实现能够解析标准财务报表，计算财务指标、产品与客户真实利润、现金预测、成本结构和税务风险，并生成健康评分、问题清单、90 天行动计划和证据链。

当前六个角色共用一个同步分析服务。它们代表六种专家视角，但尚未形成独立提交、交叉质疑、冲突仲裁和行动组合优化的协作闭环。本设计将现有确定性公式保留为权威计算层，把五个专业角色升级为独立专家，把 AI 经营总管升级为委员会主持人，并新增内部审计与确定性优化组件。

现有 `npm run test:business-advisor --workspace backend` 基线为 26/26 通过。

## 2. 已确认的产品决策

1. 输出分为两层：先形成统一经营判断，再生成约束内的最佳行动组合。
2. 系统只创建预算草案、待办、调整方案和审批任务；任何正式财务或业务动作必须人工批准。
3. 第一版只读取财务报表及现有 CRM、报价、回款、成本和 ROI 数据，不接银行、税务局或外部 ERP。
4. 优化目标由工作区配置，但现金安全、偿债能力、合规、数据完整性和业务权限始终是不可关闭的硬约束。
5. 采用“专家委员会 + 内部审计 + CFO 汇总 + 确定性优化器”架构。
6. 专家之间只允许一轮定向反驳，禁止自由聊天和无限协商。
7. 审批人可以删除、修改或选择部分动作；任何修改都会创建新 revision，并重新优化和校验全部约束。
8. 优化器同时输出推荐组合、现金优先备选和增长优先备选，供审批人比较。

## 3. 目标与非目标

### 3.1 目标

- 让每个专家基于同一份冻结经营快照独立分析。
- 让所有结论携带公式、证据、置信度、假设和数据缺口。
- 对公式错误、证据冲突、口径冲突和跨专家矛盾进行确定性检查。
- 保留合理少数意见，不让多数票覆盖硬证据。
- 在硬约束内计算可解释、可重放的行动组合。
- 让审批人看到入选动作、淘汰原因、三情景影响和敏感性分析。
- 保证所有批准后的副作用仍受现有权限、幂等和人工审批边界约束。

### 3.2 非目标

- 不自动记账、核销、付款、收款、报价、签约、开票或报税。
- 不把模型生成的金额、比例或概率直接作为财务事实。
- 不接入银行、税务、外部 ERP 或新的第三方数据商。
- 不建立第二套财务账本、CRM、报价或 ROI 权威域。
- 不实现无限轮多智能体辩论。
- 不提供规避监管、避税或投资交易建议。

## 4. 开源参考与采用边界

| 项目 | 许可证 | 采用内容 | 不采用内容 |
| --- | --- | --- | --- |
| [Anthropic Finance Plugin](https://github.com/anthropics/knowledge-work-plugins/tree/main/finance) | Apache-2.0 | 月结、对账、三表、差异分析、审计工作流和人工复核结构 | 不直接复制美国 GAAP、SOX 或具体会计判断 |
| [CFO Stack](https://github.com/MikeChongCan/cfo-stack) | MIT | 复式账本思维、来源凭证、可追溯分类、对账和版本化政策 | 不直接采用美国/加拿大税务包，不安装其全局技能或浏览器自动化 |
| [FinRobot](https://github.com/AI4Finance-Foundation/FinRobot) | Apache-2.0 | 主管—专家编排、角色工具注册、报告合成和证据驱动输出 | 不采用股票研究公式、交易逻辑或无隔离代码执行 |
| [OpenBB](https://github.com/OpenBB-finance/OpenBB) | AGPL-3.0 | “一次接入、多处消费”的数据适配思想 | 第一版不直接引入其代码或依赖，避免不必要的 AGPL 传播义务 |
| [AI Hedge Fund](https://github.com/virattt/ai-hedge-fund) | MIT | 经理—分析师分工、运行记录和风险角色的概念参考 | 不采用投资决策、交易、回测或自动执行逻辑 |

实现前若需要复制任何源代码，必须再次核对准确版本、许可证、NOTICE、维护状态和依赖安全。本设计目前只采用公开架构思想和工作流模式。

## 5. 总体架构

```text
FinancialCouncilRequest
        |
        v
FinancialSnapshotBuilder -- 冻结同一 workspace/dataAsOf/version 集合
        |
        +--> Finance Specialist
        +--> Profit Specialist
        +--> Cost Specialist
        +--> Cashflow Specialist
        +--> Tax Health Specialist
                    |
                    v
        Deterministic Finding Validator
                    |
                    v
        Audit & Rebuttal Coordinator
                    |
                    v
              CFO Synthesizer
                    |
                    v
       Deterministic Portfolio Optimizer
                    |
                    v
              Human Approval
                    |
                    v
        Draft / Todo / Approval Dispatchers
```

产品仍展示六个角色。内部审计器和优化器是系统组件，不伪装为能够独立承担职业责任的人类专家。

## 6. 组件职责

### 6.1 FinancialSnapshotBuilder

- 从现有财务报表、CRM、报价、回款、成本和 ROI 权威读模型构建快照。
- 在入口解析一个具体工作区和授权能力。
- 记录 `dataAsOf`、各数据源版本、来源 ID、内容哈希和字段脱敏结果。
- 所有专家读取同一个不可变快照对象，不自行查询漂移中的最新数据。
- 关键数据缺失或跨源矛盾时产生闭合 `DataGap`，不补零、不猜测。

### 6.2 五个专业智能体

- **财务分析师**：三表、盈利能力、运营效率、偿债与安全能力。
- **利润分析师**：产品真实利润、客户 ABC、假利润和利润改善候选。
- **成本分析师**：成本结构、价格/数量/组合差异、异常科目和降本候选。
- **现金流分析师**：回款、应收账龄、资金缺口、30/90 天情景和偿债压力。
- **税务健康分析师**：发票、收入确认、成本真实性、薪酬和股权风险体检；不下税务结论、不生成避税方案。

每个智能体只能调用其声明的只读工具。确定性公式由服务端运行，模型负责解释、归因候选、提出假设和候选动作。

### 6.3 Deterministic Finding Validator

- 验证闭合 Schema、引用权限、快照归属和字段长度。
- 重算公式并核对 `formulaVersion`、输入哈希和结果。
- 拒绝无来源金额、越权证据、未来时间、跨租户引用和隐藏假设。
- 将不可信 CRM 文本、备注和导入文件视为数据，不允许其中的指令改变系统权限。

### 6.4 Audit & Rebuttal Coordinator

- 基于共同指标、互斥结论、共享证据和候选动作建立冲突图。
- 对受影响专家发起一次定向反驳。
- 专家只能选择：坚持并补证据、修订结论、撤回结论。
- 第二次仍无法解决的冲突进入 `unresolvedConflicts`，交人工处理。

### 6.5 CFO Synthesizer

- 汇总已验证结论，形成统一经营判断。
- 保留少数意见、被拒结论、未解决冲突和数据缺口。
- 不修改专家原始记录，不越过硬约束，不用模型置信度覆盖权威证据。

### 6.6 Deterministic Portfolio Optimizer

- 只接受通过验证的候选动作和财务影响输入。
- 使用整数 minor、BPS、离散时间桶和版本化公式。
- 第一版限制单次候选动作为最多 24 个，使用确定性 branch-and-bound 枚举与剪枝，并以小规模完全穷举作为测试基准。
- 产生 Pareto 候选后，根据工作区版本化权重选出平衡、现金优先和增长优先三个组合。
- 相同快照、配置和候选动作必须产生相同排序结果。

### 6.7 Approval Controller

- 展示统一判断、三套组合、三情景影响、敏感性分析、淘汰原因和所需权限。
- 审批人每次编辑都创建新的组合 revision。
- 修改后必须重新运行优化器和全部约束；旧 revision 不能被批准。
- 批准前再次核对关键数据版本、权限和幂等键。

### 6.8 Draft Dispatchers

批准后仅允许创建：

- 预算调整草案；
- 财务、销售或经营待办；
- 催收、成本改善或数据补全方案；
- 后续人工审批任务。

Dispatchers 复用现有业务命令、权限和幂等边界，不旁路写入权威域。

## 7. 核心数据合同

### 7.1 FinancialFinding

```ts
interface FinancialFinding {
  findingId: string;
  runId: string;
  snapshotId: string;
  agentRole: "finance" | "profit" | "cost" | "cashflow" | "tax";
  conclusion: string;
  evidenceRefs: readonly EvidenceRef[];
  formulaRef: FormulaResultRef | null;
  confidenceBps: number;
  severity: "info" | "warning" | "critical";
  assumptions: readonly string[];
  missingData: readonly DataGap[];
  candidateActionIds: readonly string[];
}
```

### 7.2 CandidateAction

```ts
interface CandidateAction {
  actionId: string;
  sourceFindingIds: readonly string[];
  ownerRole: string;
  durationDays: number;
  prerequisites: readonly string[];
  mutuallyExclusiveWith: readonly string[];
  cashImpact: ScenarioMoney;
  profitImpact: ScenarioMoney;
  riskReductionBps: ScenarioBps;
  budgetCostMinor: bigint;
  capacityUnits: number;
  confidenceBps: number;
  requiredCapabilities: readonly string[];
  requiresHumanApproval: true;
}
```

`ScenarioMoney` 和 `ScenarioBps` 固定包含 `conservative/base/optimistic`。其值必须来自服务端公式、已核验事实或明确的人工输入，不能由模型自由生成。

### 7.3 ConsensusReport

包含 `acceptedFindings`、`minorityFindings`、`rejectedFindings`、`unresolvedConflicts`、`dataGaps`、`overallDiagnosis` 和所有输入版本引用。

### 7.4 ActionPortfolio

包含组合 revision、动作集合、硬约束结果、目标得分明细、三情景预测、敏感性分析、淘汰动作及原因、所需审批能力和有效期。

### 7.5 FinancialCouncilRun

状态机为：

```text
created
  -> snapshot_frozen
  -> analyzing
  -> auditing
  -> synthesizing
  -> optimizing
  -> awaiting_approval
  -> approved | rejected | expired
```

任一关键环节失败可进入 `failed` 或带闭合原因的 `not_computable`。所有状态转换追加事件并携带单调 revision。

## 8. 协作和冲突规则

1. 五个专家先独立提交，提交前看不到其他专家的自由文本结论。
2. 确定性校验通过后，审计器才生成冲突图。
3. 冲突类型固定为：公式冲突、证据冲突、口径冲突、动作互斥、资源竞争和风险偏好差异。
4. 公式、证据和权限冲突不能通过模型投票解决。
5. 风险偏好差异可以保留为少数意见，并进入不同组合情景。
6. 一轮反驳后仍未解决的关键冲突使相关动作不可优化，直到人工裁决或补充数据。
7. CFO 可以解释和排序结论，但不能删除审计记录或改变公式结果。

## 9. 硬约束与目标函数

### 9.1 硬约束

- 保守情景下期末现金不得低于工作区最低储备。
- 已知到期债务和必要经营支出必须覆盖。
- 税务、合同、权限和审批规则不得绕过。
- 缺失关键事实、证据冲突或低于配置置信门槛的动作不得进入推荐组合。
- 总预算、人员容量和执行期限不得超限。
- 动作的前置、互斥、顺序和重复规则必须满足。

任何硬约束不满足时，推荐组合数量为零，并返回准确原因。

### 9.2 可配置目标

目标函数最大化：现金改善、利润改善、风险降低和战略价值；最小化实施成本、不确定性、见效时间和组织负荷。

工作区只能修改目标权重和已授权的业务阈值，不能关闭硬约束。所有权重、阈值和公式均版本化并进入运行哈希。

## 10. 人工审批与重优化

- 审批人可以选择一个组合，也可以删除或修改动作。
- 编辑动作不会在原组合上直接打补丁，而是创建新 revision。
- 新 revision 重新执行影响计算、依赖闭包、硬约束和目标排序。
- 旧收益数字不得显示为新组合结果。
- 批准操作要求匹配最新 revision、有效权限和稳定幂等键。
- 数据源在审批前发生关键变化时，运行标记为 stale，禁止批准并提示重新分析。

## 11. 失败、恢复与观测

- 每个专家、反驳阶段和总运行都有时限、模型调用预算和有界重试。
- 非关键专家失败时，只有在缺失结果不影响硬约束和目标解释的情况下才允许生成标记清晰的部分建议。
- 关键事实、审计、CFO 合成或优化器失败时，不输出最佳组合。
- 运行、专家结果、反驳、组合 revision、审批和 dispatcher 操作都有独立幂等键。
- 新事实不改写旧快照；旧运行标记 stale，新运行使用新快照。
- 观测日志只记录 ID、阶段、耗时、错误码、版本和计数，不记录完整报表、客户备注、税务文本或模型密钥。
- 运行历史保留原始专家结论、修订、审计决定、组合结果和审批记录。

## 12. 安全与权限

- 所有证据读取必须基于具体工作区和当前用户能力。
- 敏感成本、利润、税务和个人数据在构建快照时完成字段级投影。
- 模型输入使用最小必要字段，CRM/文档文本标记为不可信内容。
- 智能体工具采用闭合 allowlist，专业智能体无写工具。
- CFO、审计器和优化器同样不能持有财务执行权限。
- Draft Dispatchers 必须复用现有服务边界，不直接写数据库表。
- 税务输出必须持续标注“风险体检，需专业人员复核”，不得声称合规或给出规避监管方案。

## 13. 测试与验收

### 13.1 领域与合同

- 金额、比例、时间、快照和公式版本测试。
- 所有公开与持久化对象的闭合 Schema 测试。
- 跨租户、越权证据、缺失数据、未来时间和内容哈希冲突测试。
- 状态机、revision、幂等和持久恢复测试。

### 13.2 智能体协作

- 五个专家确实读取同一对象身份的快照。
- 独立提交阶段不能看到其他专家自由文本。
- 冲突图只包含有证据关系的冲突。
- 每个专家最多一轮反驳，超时后不继续对话。
- CFO 保留少数意见、拒绝原因和未解决冲突。
- CRM 文本中的提示注入不能改变工具、权限或系统规则。

### 13.3 优化器

- 小规模随机案例与完全穷举最优结果一致。
- 现金、偿债、合规、预算、容量、前置和互斥约束逐项测试。
- 输入顺序变化不改变输出。
- 审批人删改动作后必须重新优化，旧 revision 立即失效。
- 任何硬约束失败时组合为空。
- 三种组合的标签、权重和敏感性解释与实际结果一致。

### 13.4 联合反例

- 账面盈利但保守情景现金断裂：利润智能体建议扩张，现金流智能体反对，最终组合守住现金底线。
- 高毛利但真实利润为负：产品售后、运费和服务成本必须改变结论。
- ROI 很高但回款或成本证据不完整：不得进入推荐组合。
- 审批人删除关键动作：剩余动作重新优化，不能复用原收益。
- 分析期间数据更新：旧运行保持可审计，批准前版本检查拒绝旧草案。

### 13.5 纵向验收

真实验收路径为：

```text
报表 + CRM + 报价 + 回款 + 成本 + ROI
-> 冻结快照
-> 五专家结果
-> 冲突审计与一次反驳
-> CFO 统一判断
-> 三套行动组合
-> 人工编辑与重新优化
-> 人工批准
-> 草案/待办创建
```

真实 MySQL 与内存实现必须通过同一行为矩阵。最终无业务响应 mock 的浏览器 E2E 验证数据显示、异议、组合编辑、重新优化、审批权限和草案创建。

## 14. 实施分解

本设计拆成五个顺序子项目，每个子项目独立设计细化、RED→GREEN、审查和提交：

1. **合同与冻结快照**：新增运行、结论、动作和组合合同，组合现有权威读模型。
2. **专家委员会与审计**：把现有五类分析函数封装为专业工具，增加独立提交、验证、冲突图和一次反驳。
3. **CFO 合成与优化器**：统一判断、硬约束、精确组合搜索、三套组合和敏感性分析。
4. **审批与草案派发**：revision、编辑后重优化、权限、幂等和现有业务命令适配。
5. **前端与纵向验收**：委员会运行详情、异议和证据、组合比较、审批台及真实 E2E。

第一子项目开始前先核对现有 Growth sealed-read、AdvisorRecommendation、Financial Ledger、Quote、CRM 和 ROI Closure 合同，避免建立重复权威域。

## 15. 完成定义

设计完成不等于功能完成。只有以下条件全部满足，财务多智能体委员会才可标记完成：

- 五个专业智能体有独立、结构化、持久且可审计的输出。
- 审计器能发现公式、证据、口径和动作冲突，并执行一次受控反驳。
- CFO 统一判断保留所有重要异议和数据缺口。
- 优化器在硬约束内产生可验证的三套行动组合。
- 人工修改会触发新 revision 和完整重优化。
- 未经审批不能创建任何业务草案或待办，批准后也不能直接执行财务动作。
- 内存/MySQL、合同、权限、安全、恢复、真实纵向 E2E 和前端可访问性门禁全部通过。

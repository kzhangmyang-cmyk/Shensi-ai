# 财务现金预测补充输入设计

**状态：** 已批准，等待实施计划

**日期：** 2026-08-23

**基线：** `0f70378`

## 1. 背景

真实财务委员会已经支持三张历史财务报表、不可变 Statement Package、五位专业智能体、CFO 共识、三组合优化和人工审批。隔离真实 MySQL 的迁移、并发竞态与重启恢复已经通过。

三张历史报表不能证明未来 30/90 天的现金流入、流出和应收账款回收时间。现有解析器因此把现金预测标记为 `source_statements_do_not_provide_forecast`，现金流角色作为硬约束会让 run 正确进入 `not_computable`。不得通过填零、复用历史现金流或让模型猜测来绕过该状态。

本阶段新增一个由工作区用户明确填写并确认的“管理层现金预测”补充输入，使 Statement Package 在保留三表来源的同时具备可审计的未来现金依据。

## 2. 目标与非目标

### 2.1 目标

1. 在三表预览后收集固定 30/90 天现金预测和应收账款账龄。
2. 将预测、提交人、提交时间和声明版本绑定进不可变 Statement Package。
3. 只有预测完整、闭合且经过用户确认时，现金流公式才可以计算。
4. 保持旧三表-only 调用安全兼容：仍可提交，但结果必须是 `not_computable`。
5. 让当前无网络拦截 Chromium 验收通过三表、预测、委员会、组合、修订、审批和草稿派发闭环。

### 2.2 非目标

- 不从历史报表自动推断未来现金流。
- 不引入机器学习预测、Monte Carlo 或概率区间。
- 不接 ERP、银行、Xero、Plaid 或外部付款计划。
- 不保存原始工作簿或未经校验的浏览器 DTO。
- 不自动执行付款、记账、报税、邮件或第三方写操作。
- 不把真实模型供应商凭据写入仓库或测试夹具。

## 3. 开源方案评估

### 3.1 ERPNext

[ERPNext Payment Schedule](https://github.com/frappe/erpnext/blob/develop/erpnext/accounts/services/payment_schedule.py) 使用明确的付款条件、到期日和应付金额，而不是仅凭历史财务报表推断未来现金。项目维护成熟，但代码为 GPLv3，且其 Python/Frappe 领域模型与当前 TypeScript 运行时不匹配。本阶段只借鉴“预测必须来自明确的未来付款依据”这一边界，不复制代码。

### 3.2 CashPilot

[CashPilot](https://github.com/kevinmeix1/CashPilot) 展示 30/60/90 天预测、来源追踪和人工审批队列。其仓库页面没有明确展示可复用许可证，且实现围绕 Xero 与演示场景，因此只参考产品交互，不复制代码或数据模型。

### 3.3 CashFlow360

[CashFlow360](https://github.com/NevilPatel01/CashFlow360) 将定期和一次性未来交易投影到 30/90/365 天日历，但当前提交历史较短、技术栈不同。本阶段不引入其基础设施或预测引擎，只确认“未来输入与历史账目分离”的方向。

## 4. 选定方案

采用“Statement Package 提交时附带管理层现金预测”的方案。

三表 preview 继续只解析历史报表。commit 可以携带可选的 `cashForecast`：

- 新版真实前端必须填写并提交；
- 旧客户端不提交时保持现有三表-only 行为；
- 服务端不从 preview 或历史数据补全缺失预测；
- commit 生成一个全新的不可变 verified package，预测属于该 package 的权威输入。

不建立独立预测资源或第四张工作簿，避免增加额外版本状态机、表和路由。未来接入 ERP/银行后，可以新增服务器签发的预测来源类型，而不改变本次管理层输入的来源身份。

## 5. 数据合同

### 5.1 写入合同

新增 `FinancialCashForecastSupplementInput`：

```ts
interface FinancialCashForecastSupplementInput {
  forecastAsOf: string; // ISO date-time，不得晚于服务器当前时间
  expectedInflowsNext30DaysMinor: number;
  expectedOutflowsNext30DaysMinor: number;
  expectedInflowsNext31To90DaysMinor: number;
  expectedOutflowsNext31To90DaysMinor: number;
  receivables: readonly {
    customer: string;
    amountMinor: number;
    daysOutstanding: number;
  }[];
  attestation: {
    accepted: true;
    noticeVersion: "financial-cash-forecast.v1";
  };
}
```

规则：

- 四个金额必须是非负 safe integer；禁止浮点、负数、`NaN`、无穷和字符串金额。
- `receivables` 必须显式提交；空数组表示用户确认当前没有应收明细，不能用缺字段表达“未知”。
- 单行金额必须大于零；`daysOutstanding` 为 `0..3650` 的 safe integer。
- 客户名称去除首尾空格后长度为 `1..255` 个 Unicode code point；相同规范化名称合并前必须先拒绝重复，避免静默改变用户输入。
- 最多 100 行应收账款；顺序按客户名 UTF-8 二进制顺序、金额和天数稳定规范化。
- `forecastAsOf` 不得未来超过 1 秒，也不得早于 Statement Package 期间结束前 366 天。
- 币种不由浏览器重复提交，始终继承 preview 的 `CNY | USD`。
- closed-schema：未知字段、accessor、稀疏数组和非普通对象全部拒绝。

`FinancialStatementConsentInput` 在新版合同中增加可选 `cashForecast`。旧 consent-only 输入继续有效，但产生的 verified package 保持 `forecastStatus: not_computable`。

### 5.2 服务端权威记录

服务端从认证上下文和服务器时间生成 `FinancialCashForecastSupplement`：

```ts
interface FinancialCashForecastSupplement {
  source: "management_attested";
  forecastAsOf: string;
  currency: "CNY" | "USD";
  expectedInflowsNext30DaysMinor: number;
  expectedOutflowsNext30DaysMinor: number;
  expectedInflowsNext31To90DaysMinor: number;
  expectedOutflowsNext31To90DaysMinor: number;
  receivables: readonly FinancialCashForecastReceivable[];
  acceptedBy: string;
  acceptedAt: string;
  noticeVersion: "financial-cash-forecast.v1";
  forecastHash: `sha256:${string}`;
}
```

`acceptedBy`、`acceptedAt`、`currency`、`source` 和 `forecastHash` 均由服务端生成，客户端不能覆盖。

### 5.3 公共投影

verified package 公共响应增加：

- `forecastStatus: computed | not_computable`；
- `cashForecast: null | { source, forecastAsOf, currency, 四个汇总金额, receivablesCount, noticeVersion, acceptedAt, forecastHash }`。

公共响应不返回客户级应收账款名称和金额；完整明细只存在工作区隔离的内部 package/business report 中。

## 6. 标准化与不可变性

commit 流程在同一个 repository 原子操作中：

1. 按 workspace 锁定并读取未过期 preview；
2. 校验 consent 和可选 cash forecast；
3. 将 forecast 投影到 `businessReport.cashFlow` 的四个未来金额与显式 `receivables`；
4. 删除 `forecast: not_computable` marker；
5. 重新运行 `canonicalBusinessReportInput`；
6. 重新计算 `reportInputHash`、`forecastHash` 和 `packageHash`；
7. 保存 verified package，并将 preview 标记为已提交。

原始 preview 不被修改。相同 workspace、preview、幂等键、request hash 和 forecast 输入精确重放同一 package；changed forecast 必须返回冲突，不得覆盖已提交 package。

Memory 与 MySQL 必须使用同一验证器、同一 canonical preimage 和同一错误码。MySQL 继续只持久化闭合 JSON 与哈希，不新增 raw workbook/body/base64 列。

## 7. 委员会计算边界

- forecast 缺失：三条现金公式均产生数据缺口，run 进入 `not_computable`。
- forecast 存在：`cashflow_forecast` 与 `cash_shortfall` 必须由确定性服务器公式计算。
- `receivables=[]`：`eligible_overdue_receivable` 计算为零且不是缺失。
- 存在应收账款：仅 `daysOutstanding > 90` 的行进入逾期回款公式，按规范化客户名聚合。
- 模型只能引用服务器签发的 formula/evidence ID，不能使用用户原始文本或自报金额。
- forecast 及其 hash 通过 Statement Package hash、run、snapshot 和 formula result identity 贯穿保存与恢复。

## 8. API 与发布兼容

- 保留现有 preview 和 commit 路径。
- commit body 在 runtime 接受旧 consent-only 与新 consent+cashForecast 两种 closed shape。
- 发布新的不可变 Growth contract `1.0.12`，明确新输入和公共 forecast 投影。
- `1.0.11` 文件、manifest 和 OpenAPI 字节保持不变。
- 前端只消费生成的 `1.0.12` 类型，不手写重复 DTO。
- 400/401/403/409/412 继续保留现有语义；新增稳定错误码：
  - `financial_cash_forecast_required`；
  - `financial_cash_forecast_invalid`；
  - `financial_cash_forecast_future`；
  - `financial_cash_forecast_conflict`。

真实前端在未填写完整预测时禁用 commit，但服务器仍必须独立 fail closed。

## 9. 前端交互

三表预览下方增加“未来现金预测”区：

- 四个金额输入，标签清楚区分 `未来 30 天` 与 `第 31–90 天`；
- 应收账款可添加/删除行，字段为客户、金额、逾期天数；
- 显式“当前没有应收账款”操作生成空数组；
- 金额使用当前 package 币种展示，输入为十进制主币单位，controller 通过无浮点的字符串解析转换为 minor integer；
- 编辑期间客户名称和金额只允许存在于当前表单控件与 controller 私有内存；不得复制到 `data-*` 属性、console、storage、URL、idempotency key 或公共状态投影；
- 预测提交前展示管理层声明，只有勾选后才允许 commit；
- commit 成功后清除所有私有输入引用，只保留服务器公共汇总投影；
- close、destroy、logout、模式切换和新 preview 必须中止请求并清除预测状态；
- 409/412 保留用户输入并提示重新加载，其他终态错误不得泄露服务端 cause。

## 10. 安全与隐私

- workspace、actor、acceptedBy、acceptedAt 和 currency 全部来自服务端权威上下文。
- request hash 和 idempotency identity 使用 forecastHash，不包含 raw customer name 或 raw amount。
- 日志只记录稳定错误码、workspace-safe IDs 和 hash，不记录预测金额、客户名称或请求 body。
- 真实浏览器测试禁止 `page.route`、`context.route`、`route.fulfill`、`route.fallback` 和 `route.abort`。
- 测试 readiness 不包含密码、数据库 URL、连接密钥或 provider body。
- 真实供应商仍使用外部配置的连接 ID 和官方解密环境；缺失时必须非零 BLOCKED。

## 11. 测试与验收

### 11.1 领域与持久化

- valid/invalid forecast、空应收、重复客户、100/101 行、未来时间、安全整数和 closed-shape。
- Memory/MySQL commit、exact replay、changed conflict、rollback、跨 workspace、重启读取和 tamper detection parity。
- consent-only 继续得到 `not_computable`；forecast commit 得到 computed cash formulas。
- package、run、snapshot、formula 和 forecast hashes 在重启后保持一致。

### 11.2 合同与前端

- `1.0.12` JSON Schema、OpenAPI、runtime router、generated types 和 response conformance 全部一致。
- `1.0.11` immutable release 无字节变化。
- API/controller/view 覆盖金额解析、私有状态释放、幂等、abort、generation fence、409/412 和错误清理。
- 1440、1366、1024、390 四个视口无横向溢出，键盘可完成全部输入与声明。

### 11.3 真实纵向验收

在随机隔离 MySQL 数据库中，无网络拦截 Chromium 必须完成：

1. 真实登录、session、CSRF 与 workspace；
2. 三份 XLSX preview；
3. 填写现金预测和应收账款；
4. consent + attestation 后 commit；
5. 创建 run，观察五位专家、一次反驳、CFO 共识和三组合；
6. 修订 revision 2；
7. 审批 balanced 组合；
8. outbox、receipt 和内部 draft 全部成功；
9. 重启后 package/forecast/run/snapshot/portfolio/approval/receipt identity 不变。

真实双供应商 smoke 与上述确定性浏览器链分开记账。没有真实供应商凭据时，功能实施可以完成，但整体状态必须保持“真实供应商验收待凭据”。

## 12. 文档同步

实施时同步更新：

- 根 README 的当前真实运行状态；
- `backend/src/business-advisor/README.md` 的数据权威与公式规则；
- `frontend/README.md` 的真实 onboarding 流程与合同版本；
- `contracts/README.md` 的 `1.0.12` 发布说明；
- `docs/operations/financial-council-real-runtime.md` 的运维和验收命令；
- 真实财务委员会设计状态。

当前执行文档必须直接描述新规则，不能在默认阅读路径保留“三表-only 可完成审批闭环”的误导表述。

# Task 4 实施报告：三张财务报表不可变权威数据版本

## 范围与裁决

- 只实现 Task 4；未修改公开 router、OpenAPI 或 UI，也未进入 Task 5。
- `financial_statement_package` 是三张汇总报表的权威版本；未把汇总表写入交易级 `financial_facts`，未新增第二套 ledger。
- package 组合进现有 Growth Finance / Financial Council 生命周期，并保留 Task 3 的 `modelRoutingPolicyVersionId`、多 active/default 语义、validators 与 MySQL schema migration。

## TDD 证据

### RED

1. `financial-statement-package-test.ts` 首次运行因 `financial-statement-package.js` 不存在而失败，证明三表 domain 尚不存在。
2. repository/service tests 首次运行因 package repository/service 模块不存在而失败。
3. MySQL repository test 首次运行因 MySQL package repository 模块不存在而失败。
4. Financial Council service test 首次运行以 `createRunFromStatementPackage is not a function` 失败。
5. snapshot binding test 首次运行显示 `statementPackageId` 为 `undefined`。
6. 历史现金流无预测的门禁测试首次运行因缺少 `cash_forecast_not_computable` data gap 失败。
7. closed consent test 首次运行因带额外字段的 consent 被接受而失败。

brief 给出的 `npm exec --workspace backend` 在本仓返回 `No workspaces found`，因此所有有效 RED/GREEN 使用等价的 `pnpm --dir backend exec tsx` 执行。

### GREEN

- package domain：5/5。
- package Memory repository/service：3/3（repository 1，service 2）。
- package MySQL unit：2/2。
- Financial Council snapshot：15/15。
- Financial Council service：17/17。
- Task 4 focused 聚合：88/88，0 skip。
- Financial Council MySQL fake/contract：71 pass，0 fail，2 skip（两项真实 InnoDB）。

## 三表解析、安全与勾稽

- 必须恰好提供资产负债表、利润表、现金流量表；三表企业、期间、币种必须一致。
- 每份工作簿从 closed metadata/statement field 读取显式币种，只接受 `CNY|USD`；缺失、未知或不一致均 fail closed，未从文件名推测，未沿用硬编码 CNY。
- 现金流解析期初现金、经营流入/流出、投资净额、筹资净额和期末现金；先做现金流内部勾稽，再与资产负债表货币资金勾稽。
- 资产负债表继续复用现有资产/负债/权益及 footings 校验；所有进入 canonical report 的金额必须是 safe integer。
- 复用 `secure-spreadsheet-artifact.ts`，没有第二解析器。XLSX only；统一继承 zip entry、解压大小/压缩比、macro、external link、sheet/row/column/cell size 边界，并在 package 层额外拒绝公式与重复/含混 sheet。
- parser version 固定为 `financial-statements.v2`；company Unicode 上限 255 code points；package/domain/consent/upload 均为 closed JSON shape。

## 预测不可计算门禁

- `CashFlowInput` 最小扩展为两种 closed 形态：旧的四项预测数值，或 `forecast: {status:"not_computable",reason:"source_statements_do_not_provide_forecast"}`，两者不可混用。
- 三表 package 永远使用后一形态，不填 0、不把历史现金流冒充 30/90 天预测。
- snapshot formula projection 将其保持为 `not_computable`，并写入 `cash_forecast_not_computable` data gap，使不安全审批继续受 data completeness 约束。

## Preview、commit 与持久化

- preview 只保存一小时有效、非权威的 normalized record；零 package、零 run、零 ledger fact。
- source allowlist 只保存 `{kind,fileName,fileHash,mediaType,sheetNames}`；package/preview 表不含 workbook bytes、base64 或 raw cells。
- commit 单事务锁 preview，检查未过期/未提交，写 package、幂等响应，再标记 preview committed；exact replay 返回相同 package，changed request 冲突。
- cleanup 只删除未提交的过期 preview，从不删除 committed package。
- Memory contract 覆盖 preview 非权威、exact replay、changed-content conflict、跨 workspace 不可见及 raw 字段缺席。
- MySQL 使用精确三表：`financial_statement_package_previews`、`financial_statement_packages`、`financial_statement_package_idempotency`，均为 InnoDB；unit test 证明 preview `FOR UPDATE` 及失败 rollback。`getVerified` 只从持久 package JSON/hash 重载，支持进程重建后的读取语义。

## Run / snapshot package binding

- 新 run 内部必填 `statementPackageId` / `statementPackageHash`；旧测试只能使用明确的 trusted legacy sentinel。
- MySQL run 表新增两个非空列及命名锁内的前向 migration，同时保留 routing policy 列；row/JSON 双写校验防止去规范化篡改。
- `createRunFromStatementPackage` 只接受 package ID + policy ID，服务端 `getVerified` 后构造 canonical business report，再复用唯一内部 create path；浏览器不能覆盖 report 或 package hash。
- 新 package snapshot 的精确 source ref 是 `{kind:"financial_statement_package",sourceId,sourceVersion:"financial-statements.v2",snapshotHash}`。

## 组合、验证与文档

- `pnpm --dir backend exec tsx --test ...Task4 focused files...`：88 pass，0 fail。
- `pnpm --filter ./backend test:growth-finance:imports`：exit 0。
- `pnpm test:financial-council`：363 pass，0 fail，2 skip。
- `pnpm --filter ./backend build`：exit 0。
- `git diff --check`：exit 0。
- `backend/src/business-advisor/README.md` 已更新三表权威输入、preview/commit、币种、不可计算预测、package/run binding；公开 API/OpenAPI 未改变。

## 自审与关注项

- 未发现 workbook bytes/base64/raw cells 持久化、硬编码 package 币种、第二 ledger、公开 route/OpenAPI/UI 变更。
- `MYSQL_TEST_ADMIN_URL` 未配置，因此两项真实 InnoDB 测试为 skip；本报告不把 package 新表的真实 InnoDB restart/rollback 记为通过。Memory、fake MySQL、transaction rollback 和 server-side reload 已通过。
- 真实路由禁止浏览器 report、上传 API 与 UI 属于 Task 5，本提交仅提供内部 package service 和真实 run 创建入口。

## 提交

- 目标提交：`feat(finance): verify three-statement data packages`

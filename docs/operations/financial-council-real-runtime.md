# 真实财务委员会运行手册

当前状态：实施完成，真实供应商验收待凭据。本地隔离 MySQL 的迁移、并发竞态与跨实例恢复已验证；当前无真实双供应商连接凭据。仅三表输入无法证明 30/90 天现金预测，必须稳定进入 `not_computable`；新增可信预测输入合同前，无拦截 Chromium 不可记为审批闭环通过。

## MySQL 8.4（3307）

本机实例只绑定 `127.0.0.1:3307`。启停使用本机已安装的 MySQL 服务管理方式；先用无凭据的只读健康检查确认监听与 `SELECT 1`。测试管理 URL 只能通过进程环境提供，不得写入 Git、报告或日志。验收为每次运行创建 `shensi_financial_council_<pid>_<uuid>` 随机库，在外层 `finally` 删除；不得对持久 `shensi_sales` 做破坏性断言。

备份由数据库管理员对持久库执行标准一致性备份，包含 financial council package、snapshot、policy、routing、lease、outbox 和 draft 表。恢复后先做只读身份校验，再启动 worker；核对 package hash、snapshot ID/hash、两类 policy ID 和 outbox receipt 不变。

## 双供应商准备

管理员必须通过连接中心录入密钥，不能将 raw API key 传给 CLI。在同一 workspace 中准备两个 `active` 连接，要求 provider 不同、structured output 已认证、实时配额与网络可用。运行时只设置 `DATABASE_URL`、`FINANCIAL_COUNCIL_LIVE_PRIMARY_CONNECTION_ID` 和 `FINANCIAL_COUNCIL_LIVE_FALLBACK_CONNECTION_ID`，并配置官方 store 解密/JWT 环境。

`pnpm --filter ./backend test:financial-council:live-providers` 会校验 workspace、连接状态、双 provider 和认证哈希，再对每个 provider 做最小结构化调用。fallback drill 在 primary 网络前注入可重试失败，必须证明 attempt 1 零网络字节、attempt 2 只对不同 provider 调用一次。输出仅允许闭合元数据。

## 操作路径

1. 在 `#agents` 检查六角色模型就绪状态。
2. 上传同企业、同期间、显式 CNY/USD 的资产负债表、利润表和现金流量表。
3. 检查 preview 告警，接受 `financial-model-data.v1` 数据传输告知后 commit verified package。
4. 启动 run，核对 package、公式 policy 和模型 routing policy 的不可变绑定。
5. 审核五专家、异议/复议、CFO 共识与三个组合；修订后只审批最新 revision。
6. 审批只创建内部 draft/todo 与确定性 receipt，不付款、不申报税务、不记账、不发邮件或 webhook。

## 错误与恢复

- `MYSQL_TEST_ADMIN_URL_REQUIRED:financial-council-real-runtime`：未提供隔离测试管理连接；非零退出，不能 skip。
- `LIVE_PROVIDER_*_REQUIRED`、`LIVE_PROVIDER_PAIR_MUST_USE_DISTINCT_PROVIDERS`、`LIVE_PROVIDER_*_NOT_READY`：补齐环境或连接中心状态后重跑，不得在日志打印 cause/body/URL/secret。
- `financial_council_lease_stale`：旧 lease 或精确过期时刻写入被正常拒绝；由新 runtime 重新 claim，不要手工改 token。
- `not_computable`：三表-only package 的预期安全状态。package 保留 `source_statements_do_not_provide_forecast` 缺口，snapshot/formula catalog 不得用历史现金流伪造预测；在可信 forecast 输入合同上线前不可审批。

## 门禁与回滚

MySQL 门禁：`MYSQL_TEST_ADMIN_URL=... pnpm --filter ./backend test:financial-council:real-runtime`。无拦截 Chromium：`MYSQL_TEST_ADMIN_URL=... pnpm test:e2e:financial-council:real-runtime`。发布前还必须运行 contracts、growth contracts、backend financial council/MySQL、frontend tests/types/E2E、root build 和 `git diff --check`。

回滚只停止真实 runtime/workers 并移除当前进程环境接线。不自动 drop 持久表，不回收或改写既有 package/snapshot/policy/routing/outbox；数据变更由单独、经审批的运维流程执行。

# Task 8 实施报告

## 结论

DONE_WITH_CONCERNS。隔离真实 MySQL 的 schema upgrade、双连接竞态、精确过期/ABA lease 拒绝、跨两 runtime 恢复与 outbox receipt replay 已通过。双供应商 smoke 因当前环境缺 `DATABASE_URL`、两个 workspace connection ID 和官方解密/JWT 环境而安全非零 BLOCKED。三表-only 运行已从公式重算不一致修复为稳定 `not_computable`；因为三表无法证明 30/90 天预测且 `cashflow` 是 critical hard constraint，新增可信预测输入合同前无拦截 Chromium 不可到达审批闭环。

## RED / GREEN

- RED：live-provider 测试模块不存在，`ERR_MODULE_NOT_FOUND`（0 pass / 1 fail）。GREEN：`financial-council-live-provider-smoke-test.ts` 2/2 pass；只接受 store/connection IDs，闭合元数据输出。
- RED：新随机库初始化报 `ER_DUP_FIELDNAME statement_package_id`。根因是 `information_schema.columns` 的驱动字段名大小写与读取不一致。GREEN：两处查询显式 alias，迁移/竞态 4/4 pass。
- RED：restart harness 首次因上述 schema 问题无法创建 runtime。GREEN：1/1 pass；同一 owned DB 跨两 pool/runtime，仅外层 finally drop。
- Browser RED 1：非 ISO 期间导致 `financial_statement_period_required`；已改 ISO 期间。
- Browser RED 2：package-run 错发到 legacy create endpoint；已改为 `/api/v1/finance/council-runs/from-statement-package`。
- Browser RED 3：前端把模型 routing policy ID 作为公式 policy ID；已通过现有 `/api/v1/finance/council-policy` 分别加载与绑定，real API/controller self-tests 与 types pass。
- Follow-up RED：用现有真实 XLSX parser、in-memory package 与真实 council pipeline 的最小后端测试稳定复现 `financial_formula_input_invalid`。首个不一致字段为 `formulaInputs.cashflow`：snapshot 识别 package forecast 为 not-computable，formula catalog 却重算为 computed。
- Follow-up GREEN：formula catalog 使用与 snapshot 相同的 forecast-presence 条件；focused formula/snapshot/statement-package suite 27/27 pass，三表-only pipeline 稳定终止于 `not_computable`。
- Browser 最终状态仍为 FAIL。旧 trace 到达 package commit、run create、revision 3 `analyzing`；修复后的最小后端证据证明三表-only 不能合法到达 `awaiting_approval`。没有放宽 validator/critical cashflow，也没有伪造 forecast。

## 真实 MySQL / races / restart

本机 socket root 无密码只读 `SELECT 1` PASS。每次验收在 shell 内生成临时账号，仅授予 `shensi_financial_council\_%` 数据库范围，trap 删除账号，未输出或写入凭据。

- routing/package schema upgrade + two-connection If-Match/commit race：4 pass / 0 fail / 0 skip。
- restart：1 pass / 0 fail / 0 skip。证明 package/hash、snapshot ID/hash、formula policy、routing policy、outbox receipt 身份稳定，exact-expiry 与旧 ABA lease 被拒绝。
- 随机库使用至少两个不同 `CONNECTION_ID()`；没有对 `shensi_sales` 做破坏性断言。

## Provider smoke

单元测试 2/2 PASS。实际命令 `pnpm --filter ./backend test:financial-council:live-providers` 安全输出仅 `{"event":"financial_council_live_provider_blocked","code":"DATABASE_URL_REQUIRED"}` 并 exit 1，记为 BLOCKED。未传 raw API key，未输出 URL、secret、provider body 或 exception cause。fallback drill 的单元合同要求 attempt 1 在网络前失败且 networkBytes=0，attempt 2 只调用不同 provider 一次。

## Browser no-intercept

静态 grep 对 `page.route|context.route|route.fulfill|route.fallback|route.abort` 为 0 matches。spec 不 import fixture router；server 使用真实 `server.app`、session cookie、CSRF、workspace/capabilities、真实 MySQL repositories/workers/routes，只保留 acceptance-only deterministic model adapter。readiness contract 不再包含密码。

实际 Chromium：1 fail / 0 pass / 0 skip，已知失败如上。该失败不被 skip/PASS 或 fixture route 代替。

## 门禁

PASS：

- `pnpm test:contracts`：90/90。
- `pnpm check:growth-contracts`：44/44。
- frontend `test:types`：exit 0。
- real API/controller self-tests：exit 0。
- real E2E server contract/fail-fast：2/2。
- live-provider smoke unit：2/2。
- MySQL migrations/races：4/4。
- MySQL restart：1/1。
- `git diff --check`：exit 0。
- `pnpm build`：exit 0（contracts types + backend TypeScript + frontend production build）。
- follow-up focused formula/snapshot/statement-package：27 pass / 0 fail / 0 skip。
- `pnpm --filter ./backend test:financial-council`：366 pass / 0 fail / 2 MySQL-env skip。
- root/backend/frontend lockfiles 相对 BASE `2eac052`：0 changes。

BLOCKED/FAIL/not run：

- live providers：BLOCKED, `DATABASE_URL_REQUIRED`。
- no-intercept Chromium：FAIL；三表-only 按安全合同为 `not_computable`，而当前 spec 要求 `awaiting_approval`。
- 由于已知 Chromium 失败且无真实 provider 凭据，不声称完整 release gate 通过。
- 既有 `test:financial-council:mysql` 定向运行曾显示 71 pass / 1 fail / 2 skip，故不列入 PASS。

## 安全 / locks / 文档

- 非 Markdown diff 未发现 `sk-*`、内联 MySQL 凭据或 private key marker。
- dispatch 关键词命中仅为 `unmatched_payment` 领域状态与显式拒绝测试；没有外部 executor。
- raw persistence 关键词命中仅为 DDL 禁止列断言，没有 raw workbook/body/secret 列。
- 已更新 root/frontend/backend current README、运维手册和权威设计状态；状态精确为“实施完成，真实供应商验收待凭据”。

## Self-review / concerns

已自查 fail-closed env gates、隔离 DB lifecycle、双连接身份、lease 精确边界、fallback 零 primary 网络、readiness 脱敏、无拦截静态合同。主要 concern 是已批准合同之间的验收目标冲突：三表 package 必须声明 forecast 不可计算，critical cashflow 又必须阻止不安全审批。下一步是单独设计并审批可信 30/90 天预测输入/证据合同，不是放宽 validator 或伪造数据。

## Commit

主提交：`16a3a91 test(finance): verify the real financial council runtime`。Follow-up 提交单独交付。

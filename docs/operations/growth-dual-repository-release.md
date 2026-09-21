# Growth 双仓发布门禁

## 固定路径

- 后端（producer）：本仓库，release 位于
  `contracts/releases/growth-advisor-quote-roi/<contractVersion>/`。
- 前端（consumer）：`/Users/mac/Documents/外贸/GoodJob-marketing-system-frontend`，
  pinned 位于 `contracts/pinned/`。

## 本地门禁

```bash
npm run test:growth-release-gate
```

`tools/growth-dual-repo-release-gate.test.mjs` 验证：

- producer/consumer 的合同 `name`、`contractVersion`、`contractHash` 三者必须
  完全一致，任何 mismatch 立即失败；
- Foundation / Advisor 等真实 MySQL 套件必须输出
  `GROWTH_REAL_MYSQL <suite> connections=2 tests=<positive>` marker，缺失、
  `tests=0` 或任何 skip 都失败；
- 固定命令矩阵覆盖后端 contracts/drift/openapi/security/foundation/catalog/
  quotes/finance/roi/advisor/acquisition/closed-loop 与前端
  contract:check/types/test/fixture/e2e/build；
- MySQL 命名的套件与 `test:e2e:real` 记录为 `real_mysql`，其余为 `standard`；
- 发布记录包含两个 40 位发布 SHA、两个回滚 SHA、`contractVersion`、
  `contractHash`、UTC 验证时间与逐项命令结果。

## 正式发布

发布前两个仓库都必须干净（`git status --porcelain=v1 -z --untracked-files=all`
为零字节；未提交的 `pnpm-workspace.yaml` 必须先提交或移出工作树），且都非浅克隆。

```bash
cd <backend-root>
GOODJOB_BACKEND_ROOT=<backend-root> \
GOODJOB_FRONTEND_ROOT=<frontend-root> \
GROWTH_BACKEND_COMMIT=<40-hex> \
GROWTH_FRONTEND_COMMIT=<40-hex> \
GROWTH_BACKEND_ROLLBACK=<40-hex 祖先> \
GROWTH_FRONTEND_ROLLBACK=<40-hex 祖先> \
MYSQL_TEST_ADMIN_URL="mysql://..." \
npm run release:growth
```

门禁会先读取 consumer pinned manifest 的 `contractVersion`，校验严格 SemVer 后
才读取 producer 同名目录的 `manifest.json`，并验证目录名、manifest 内版本与
哈希三者一致。`resolveImmutableRollbackCommit` 要求回滚 SHA 为发布 SHA 的
祖先（`git merge-base --is-ancestor`），符号引用/分支名/标签名一律拒绝。
全部命令通过且两个仓库 HEAD/工作树快照前后逐字节一致后，写出
`growth-release-record.json`。

## 未配置 MySQL 时的行为

`MYSQL_TEST_ADMIN_URL` 缺失时，真实 MySQL 套件显式失败
（`MYSQL_TEST_ADMIN_URL_REQUIRED:*`），门禁不允许跳过；内存套件可先跑，
但不能替代 MySQL 验收。CI 发布必须在两次 `fetch-depth: 0` checkout 上执行。

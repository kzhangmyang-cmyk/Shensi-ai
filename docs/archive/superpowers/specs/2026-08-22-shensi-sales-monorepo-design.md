# Shensi Sales 统一 Monorepo 设计

**状态：** 已实现

**日期：** 2026-08-22

**目标仓库：** `kzhangmyang-cmyk/shensi-sales`（private）

## 1. 目标

把已完成并提交的销售系统前端、后端、共享合同和部署资料统一到 `shensi-sales`，形成一个可独立安装、开发、测试和发布的标准 Monorepo。迁移只调整仓库结构和工程入口，不改变产品功能、接口语义或业务数据。

## 2. 权威来源

迁移只读取 Git 已提交对象，不从开发者工作目录复制文件。

- 后端及共享基础设施：`kzhangmyang-cmyk/GoodJob` 的 `main`，提交 `d21bbac7a751d853216bfe0a63461121396f5ab1`；其中包含金融多智能体最终提交 `7b3442fec1c6490157f36973100fe6c3babf6d98`。
- 前端：`kzhangmyang-cmyk/shensi-sales` 当前 `main`，提交 `daaf468f8efd8dde5d85ea9715794bf96a3bce26`。
- 两条历史共享祖先 `9f7d1542713f4ffa104a855a8cb15b09f5768c31`，最终集成提交保留两边历史，不做 squash，也不把其中一边覆盖为无历史快照。

以下本地状态不进入新仓库：

- 原前端工作区中未提交的 `pnpm-workspace.yaml` 修改；
- 原前端工作区中未跟踪的 `debug-agents.mts`；
- 环境变量、数据库凭据、测试数据库、构建产物和其他未提交文件。

## 3. 目标目录

```text
shensi-sales/
├── backend/                 # API、领域服务、worker、MySQL 持久化
├── frontend/                # React/Vite 前端、浏览器扩展、Playwright
├── contracts/               # OpenAPI、JSON Schema、生成类型入口
├── deploy/                  # 部署与打包资源
├── docs/                    # 当前文档、设计和操作说明
├── tools/                   # 跨包工程脚本
├── package.json             # 根级统一命令
├── pnpm-workspace.yaml      # 正式工作区声明
├── pnpm-lock.yaml           # 唯一依赖锁文件
└── README.md                # 项目入口和本地运行说明
```

前端当前根目录内容整体移入 `frontend/`。后端仓库中现有的 `backend/`、`contracts/`、`deploy/`、`docs/` 和 `tools/` 作为这些目录的基础；后端仓库内旧的 `frontend/` 不作为最终前端来源。

## 4. 历史合并策略

1. 从 `shensi-sales/main` 创建集成分支 `codex/shensi-sales-monorepo`，保留当前前端历史。
2. fetch `GoodJob/main` 的 `d21bbac...`，生成一个同时拥有前端和后端父历史的普通 merge commit。
3. merge 过程中不采用整树的 `ours` 或 `theirs`。按目标目录重建最终 tree：
   - 根工程、`backend/`、`contracts/`、`deploy/`、`docs/`、`tools/` 取自 `GoodJob/main`；
   - `frontend/` 精确取自前端提交 `daaf468...`；
   - 根 README、workspace 和锁文件按本设计重写。
4. 合并前后分别记录 source tree hash，并核对目标 `frontend/` 与 `daaf468...` 的内容差异只包含路径前缀和为 Monorepo 必须做的路径修正。
5. 只向 `shensi-sales` 推送集成分支并通过 PR 合入 `main`；原 `GoodJob` 和原前端本地工作区保持不变。

## 5. 包管理和锁文件

目标仓库统一使用 pnpm workspace：

```yaml
packages:
  - backend
  - frontend
  - contracts
```

- 根 `package.json` 保留跨包编排能力，命令改为 `pnpm --filter` 或 `pnpm -r`。
- `backend/package.json` 和 `frontend/package.json` 保留各自包级命令；只有路径或包管理器依赖导致命令失效时才做最小修正。
- 从三份已提交的 package manifest 在目标仓库生成新的根 `pnpm-lock.yaml`。
- 目标仓库不保留 npm `package-lock.json`，避免两种锁文件并存；这只发生在新仓库，原仓库锁文件不修改。
- 不复制原前端本地修改过的 `pnpm-workspace.yaml`，而是根据上述正式配置重新创建。

## 6. 合同、路径和运行方式

- `contracts/` 是唯一合同来源；前端的导入、生成和漂移检查从 `frontend/` 指向根 `contracts/`。
- 本地开发由根命令同时启动后端和前端，后端仍可分别以 memory 或 MySQL 模式运行。
- 前端 Vite 代理继续指向本地后端；浏览器不直接携带 workspace/capability 等服务端权威字段。
- 前后端仍分别构建，部署产物互不混合；统一仓库不意味着把 API 和静态资源强制打成单一进程。
- 金融委员会真实 E2E 继续使用真实后端路由、会话、CSRF、MySQL 和无 route interception 的 Chromium 流程。

## 7. 根级命令

根 `package.json` 至少提供：

- `pnpm dev`：并行启动后端和前端；
- `pnpm build`：按合同、后端、前端顺序构建；
- `pnpm test`：运行合同、后端、前端的默认门禁；
- `pnpm test:financial-council`：运行金融多智能体聚合测试；
- `pnpm test:e2e`：运行前端常规 E2E；
- `pnpm test:e2e:financial-council:real`：运行真实 MySQL + 后端 + Chromium 的金融委员会验收。

命令名称以稳定、易懂为优先；迁移中可为旧 npm 命令保留短期兼容 alias，但当前 README 只介绍 pnpm 入口。

## 8. 验证标准

集成分支完成前必须在目标目录验证：

1. 删除安装产物后执行 `pnpm install --frozen-lockfile` 成功；
2. 合同生成、合同 freshness、OpenAPI/Schema 漂移检查通过；
3. 后端 TypeScript build 与金融委员会聚合测试通过；
4. 前端 types、自测试、单元测试和 Vite build 通过；
5. Playwright 常规关键路径通过；
6. 在 `MYSQL_TEST_ADMIN_URL` 可用时，真实 MySQL 集成和无拦截 Chromium 金融委员会 E2E 通过；环境不可用时必须明确报告阻塞，不能写成通过或用 fake 替代；
7. `git diff --check` 通过，仓库不含凭据、调试脚本、原始客户数据或构建产物；
8. README、开发入口、测试入口和部署文档与最终目录一致。

迁移前已经验证过的源功能包括金融委员会后端聚合测试、真实 MySQL 集成以及真实 Chromium E2E；这些结果只作为回归基线，不能替代迁移后在新路径上的验证。

## 9. 安全与数据边界

- 不迁移 `.env`、cookie、token、数据库 URL 或本地测试数据库。
- Git 历史和最终 tree 都要执行 secrets/大文件的基础检查。
- `debug-agents.mts` 属于未跟踪本地调试文件，明确排除。
- 迁移不触发生产部署、不连接真实模型供应商、不执行客户数据迁移。

## 10. 回滚

- 合并前所有工作都在 `codex/shensi-sales-monorepo`；删除该分支即可回到现有 `shensi-sales/main`。
- 原 `GoodJob` 仓库和原前端工作区不被改写，始终可作为源版本回退。
- 合入后若发现路径级问题，通过 revert 集成 merge commit 回退，不重写 `main` 历史。

## 11. 非目标

- 不在本次迁移中增加销售或财务功能；
- 不重构已验证的领域逻辑；
- 不替换数据库、模型网关或部署平台；
- 不把本地临时调试工具纳入产品；
- 不在验证完成前删除或归档原仓库。

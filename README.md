# Shensi Sales

[![Quality gates](https://github.com/kzhangmyang-cmyk/shensi-sales/actions/workflows/quality.yml/badge.svg)](https://github.com/kzhangmyang-cmyk/shensi-sales/actions/workflows/quality.yml)

Shensi Sales 是面向外贸销售团队的客户增长与经营分析系统。本仓库统一维护前端、后端、共享 API 合同、部署资源和财务多智能体工作流。唯一前端是黑色智能体业务壳：产品首页为 `#agents` 的六张智能体卡牌，旧白色 CRM 已删除且不再提供入口。

## 仓库结构

```text
backend/    Express API、领域服务、worker、MySQL 持久化
frontend/   React/Vite 前端、授权视觉读取扩展、Playwright 测试
contracts/  OpenAPI、JSON Schema、不可变合同发布和类型生成
deploy/     部署与打包资源
docs/       当前设计、开发与运维文档
tools/      跨 workspace 工程门禁
```

`contracts/` 是可编辑合同的唯一来源。`frontend/contracts/pinned/` 是前端消费的不可变快照，`contract:check` 会验证它与根合同发布 `1.0.11` 的身份和哈希一致。

## 环境要求

- Node.js `22.22.3`（仓库同时限制为 `>=22.22.3 <23`）
- pnpm `11`
- MySQL 8（MySQL 模式和真实端到端验收需要）
- Chrome（Playwright 真实浏览器验收需要）

环境变量从根目录 `.env.example` 复制到本地 `.env` 后填写。不要提交 `.env`、数据库连接、Cookie、token 或客户数据。

真实本地模式固定使用 `127.0.0.1:3307`、数据库 `shensi_sales` 和应用账号 `shensi_sales_app@127.0.0.1`。将 `.env.example` 中的变量名复制到 Git 忽略的 `.env.real.local`，在本机填写 `MYSQL_LOCAL_ADMIN_URL`、`SHENSI_MYSQL_APP_PASSWORD`、`DATABASE_URL` 以及各项应用密钥；`DATABASE_URL` 中的应用密码必须与 `SHENSI_MYSQL_APP_PASSWORD` 一致。凭据只能在本机输入，禁止粘贴到聊天、日志、提交或测试快照中。

## 安装与开发

```bash
pnpm install --frozen-lockfile
pnpm --filter goodjob-crm-frontend dev
```

前端默认地址为 `http://127.0.0.1:5188/#agents`。`/`、空 Hash、`#dashboard` 和未知 Hash 都会自动规范化到 `#agents`；获客、私域、成交、工作流以及 Growth/财务深链仍由同一黑色壳承载。

需要可重复地启动真实本地模式时，先用本机 MySQL 管理账号做一次最小权限初始化，再启动唯一的黑色前端壳与后端：

```bash
pnpm setup:mysql:local
pnpm dev:real
```

初始化命令只创建数据库 `shensi_sales` 和账号 `shensi_sales_app@127.0.0.1`，且仅授予该数据库范围内的 `SELECT`、`INSERT`、`UPDATE`、`DELETE`、`CREATE`、`ALTER`、`INDEX`、`REFERENCES` 权限。`pnpm dev:real` 以 `CRM_STORE=mysql` 启动 `http://127.0.0.1:4188`，并让 `http://127.0.0.1:5188/#agents` 通过真实 session、CSRF 与 `/api/auth/*` 登录；任一进程可用 `Ctrl-C` 一并停止。真实模式的 MySQL 不可用时后端会失败关闭，不回退到 memory。

普通开发需要同时启动 MySQL 模式后端和前端时运行 `pnpm dev`。也可以分别运行：

```bash
pnpm --filter ./backend dev
pnpm --filter ./backend dev:mysql
pnpm --filter goodjob-crm-frontend dev
```

后端的 memory 模式适合本地功能验证；需要持久化、worker 恢复或真实纵向验收时使用 MySQL 模式。本次前端壳迁移没有删除或修改后端、数据库、合同、权限边界或既有业务数据。

## 常用门禁

```bash
pnpm test:layout
pnpm build
pnpm test
pnpm test:financial-council
pnpm test:e2e
```

GitHub `Quality gates` 会在 pull request 和 `main` push 上自动启动隔离的 MySQL 8.4 service，并运行上述根门禁、财务委员会与 Chromium 验收。测试数据库不使用任何生产 Secrets。

合同门禁：

```bash
pnpm test:contracts
pnpm check:growth-contracts
pnpm check:acquisition-contracts
```

金融委员会的真实 MySQL + 后端 + Chromium 验收不拦截或伪造网络请求：

```bash
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" \
pnpm test:e2e:financial-council:real
```

没有 `MYSQL_TEST_ADMIN_URL` 时，该真实验收属于阻塞，不能以 Memory 或 fake MySQL 结果替代。

当前 Task 8 状态为“实施完成，真实供应商验收待凭据”：隔离 MySQL 的并发竞态与跨 runtime 恢复已通过；真实双供应商因未配置连接 ID/解密环境而 BLOCKED。仅三表输入按安全合同必须稳定进入 `not_computable`：三表不能证明 30/90 天现金预测，而 `cashflow` 是 critical hard constraint。在新增可信预测输入合同前，无拦截 Chromium 不可到达 `awaiting_approval`。详见 [真实财务委员会运行手册](docs/operations/financial-council-real-runtime.md)。

## 主要能力

- 黑色智能体中心首页、获客、私域、成交、工作流与销售任务
- 公开来源获客、证据链、身份核验和受控 CRM 转化
- Growth Advisor、产品目录、报价、成本台账、ROI 与财务导入
- 五角色财务分析、审计反驳、CFO 共识、组合优化、人工审批和受控派发
- 工作区三表 package、六角色模型路由预览与脱敏智能体状态；审批只创建草稿、待办或后续审批任务
- 授权可见评论读取、本地 OCR、遮挡制品和隐私安全门禁

## 进一步文档

- [前端运行与验收](frontend/README.md)
- [共享合同](contracts/README.md)
- [当前开发状态](DEVELOPMENT_STATUS.md)
- [开发决策](DEVELOPMENT_DECISIONS.md)
- [统一仓库设计](docs/superpowers/specs/2026-08-22-shensi-sales-monorepo-design.md)

旧的 `GoodJob` 仓库保留为迁移来源和回退点；新的功能开发、合同更新和发布以本仓库为准。

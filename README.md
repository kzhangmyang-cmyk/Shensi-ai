# Shensi Sales

Shensi Sales 是面向外贸销售团队的客户增长与经营分析系统。本仓库统一维护前端、后端、共享 API 合同、部署资源和财务多智能体工作流。

## 仓库结构

```text
backend/    Express API、领域服务、worker、MySQL 持久化
frontend/   React/Vite 前端、授权视觉读取扩展、Playwright 测试
contracts/  OpenAPI、JSON Schema、不可变合同发布和类型生成
deploy/     部署与打包资源
docs/       当前设计、开发与运维文档
tools/      跨 workspace 工程门禁
```

`contracts/` 是可编辑合同的唯一来源。`frontend/contracts/pinned/` 是前端消费的不可变快照，`contract:check` 会验证它与根合同发布 `1.0.10` 的身份和哈希一致。

## 环境要求

- Node.js `22.22.3`（仓库同时限制为 `>=22.22.3 <23`）
- pnpm `11`
- MySQL 8（MySQL 模式和真实端到端验收需要）
- Chrome（Playwright 真实浏览器验收需要）

环境变量从根目录 `.env.example` 复制到本地 `.env` 后填写。不要提交 `.env`、数据库连接、Cookie、token 或客户数据。

## 安装与开发

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 默认同时启动 MySQL 模式后端和前端。也可以分别运行：

```bash
pnpm --filter ./backend dev
pnpm --filter ./backend dev:mysql
pnpm --filter ./frontend dev
```

前端默认地址为 `http://127.0.0.1:5188`。后端的 memory 模式适合本地功能验证；需要持久化、worker 恢复或真实纵向验收时使用 MySQL 模式。

## 常用门禁

```bash
pnpm test:layout
pnpm build
pnpm test
pnpm test:financial-council
pnpm test:e2e
```

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

## 主要能力

- 客户、联系人、商机、跟进、报价与销售任务管理
- 公开来源获客、证据链、身份核验和受控 CRM 转化
- Growth Advisor、产品目录、报价、成本台账、ROI 与财务导入
- 五角色财务分析、审计反驳、CFO 共识、组合优化、人工审批和受控派发
- 授权可见评论读取、本地 OCR、遮挡制品和隐私安全门禁

## 进一步文档

- [前端运行与验收](frontend/README.md)
- [共享合同](contracts/README.md)
- [当前开发状态](DEVELOPMENT_STATUS.md)
- [开发决策](DEVELOPMENT_DECISIONS.md)
- [统一仓库设计](docs/superpowers/specs/2026-08-22-shensi-sales-monorepo-design.md)

旧的 `GoodJob` 仓库保留为迁移来源和回退点；新的功能开发、合同更新和发布以本仓库为准。

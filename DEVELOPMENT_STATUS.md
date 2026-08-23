# Shensi Sales 开发状态

**当前日期：** 2026-08-23

**当前仓库：** `kzhangmyang-cmyk/shensi-sales`

**默认分支：** `main`

## 当前结论

Shensi Sales 已经是统一的 pnpm Monorepo，前端、后端、共享合同、部署资源和财务多智能体位于同一个 Git 历史中。唯一产品前端是黑色智能体业务壳：`#agents` 的六张智能体卡牌是首页，旧白色 CRM 已删除且不再提供入口。财务委员会的核心开发已完成，当前主要工作是正式模型和生产环境验收，不是重写财务智能体。

`/`、空 Hash、`#dashboard` 和未知 Hash 均自动规范化到 `#agents`。获客、私域、成交、自动工作流以及全部受支持的 Growth/财务深链继续由同一黑色壳承载；后端、数据库、合同、权限边界和现有业务数据均未删除或改变。

## 仓库与运行方式

- `backend/`：Express API、领域服务、worker、恢复 sweeper 和 MySQL 持久化。
- `frontend/`：React/Vite 前端、授权视觉读取扩展和 Playwright 验收。
- `contracts/`：OpenAPI、JSON Schema、不可变合同发布和前端类型生成。
- `deploy/`：宝塔 Linux 安装、打包、数据库初始化和服务管理。
- 根目录使用 Node.js `22.22.3` 和 pnpm `11.18.0`，唯一锁文件是 `pnpm-lock.yaml`。
- 本地可以使用 Memory 模式进行快速功能验证；恢复、并发、审批和真实纵向验收使用 MySQL 模式。

## 已完成能力

### 智能体业务壳与销售工作台

- JWT 登录、工作区与业务员/主管/管理员数据边界。
- 黑色智能体中心首页及客户、联系人、商机、待办、跟进提醒、导入导出、资料、考试、OCR 和账号管理。
- Memory/MySQL 双模式存储，生产环境只根据显式配置创建初始管理员。

### 智能获客与 Growth

- 获客计划、版本、运行控制、队列协调、证据链、身份解析、候选人评估和受控 CRM 转化。
- Growth Advisor、产品目录、报价、成本台账、ROI、财务导入和工作区策略。
- 授权可见评论读取、本地 OCR、遮挡裁剪证据和脱敏/外网防护。

### 财务多智能体委员会

- 五个专业角色：财务、利润、成本、现金流和税务健康。
- 确定性公式、证据绑定 finding、冲突图、一轮反驳、CFO 共识与少数意见保留。
- 十二类硬约束与穷尽 oracle 校验的组合优化，固定输出 `balanced`、`cash_first`、`growth_first`。
- 方案修订、当前数据/策略再验证、人工审批/拒绝、不可伪造授权证明和逐动作派发。
- 持久化租约、ABA fencing、崩溃恢复、幂等重放、MySQL 事务回滚和受控草稿生成。

## 当前验证基线

- `pnpm install --frozen-lockfile`：PASS。
- `pnpm test`：PASS，包括 contracts 88/88、前端 self-test 125/125 和宝塔发布包 2/2。
- `pnpm test:layout`：7/7 PASS，覆盖 Monorepo 目录、跨仓合同和 GitHub Quality workflow。
- `pnpm build`：后端 TypeScript 和前端 Vite 生产构建 PASS；仅保留既有 chunk-size warning。
- 真实 MySQL 8.4 财务委员会聚合测试：327/327 PASS，0 skip。
- 真实 InnoDB 仓储/并发/恢复专项：83/83 PASS。
- 前端 Chromium 完整回归：58/58 PASS（从 Monorepo 根目录执行 `pnpm --filter goodjob-crm-frontend run test:e2e`）。
- 真实 MySQL + 真实后端 + 无 route interception Chromium 验收：1/1 PASS。

`.github/workflows/quality.yml` 在 pull request 和 `main` push 上使用 MySQL 8.4 service 自动运行根测试、构建、财务委员会和两类 Chromium 验收。该工作流不依赖生产 Secrets。

## 尚待生产验收

1. 在宝塔 Linux 生产机准备独立 MySQL、域名和 HTTPS，执行首次发布、备份和恢复演练。
2. 配置实际模型供应商的 API Key、官方端点和能力探测，用脱敏真实财务样本校验输出质量、费用和延迟。
3. 配置生产搜索/数据连接、配额与预算，完成企业和个人各一条从公开证据到人工审核的样例链。
4. 官方抖音授权连接器与持久化周期调度仍是后续能力；当前只允许受控的公开样本和用户明确授权的本地可见读取。
5. 完成一轮真实用户试运行，根据审批结果调整策略阈值和模型提示词。

## 当前开发命令

```bash
pnpm install --frozen-lockfile
pnpm --filter goodjob-crm-frontend dev
pnpm dev
pnpm test:layout
pnpm test
pnpm build
pnpm test:financial-council
```

前端默认 URL 是 `http://127.0.0.1:5188/#agents`。所有命令从 Monorepo 根目录执行；前端定向命令使用 `--filter goodjob-crm-frontend`。

真实财务委员会浏览器验收：

```bash
MYSQL_TEST_ADMIN_URL="mysql://<admin>@127.0.0.1:3306/mysql" \
pnpm test:e2e:financial-council:real
```

`docs/superpowers/plans/` 中的旧计划用于保留实施历史，其旧 checkbox 不再代表当前缺口；后续开发以本文档、根 `README.md` 和对应模块 README 为准。

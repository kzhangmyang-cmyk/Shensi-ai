# 智能体中心单一前端壳实施计划

> **实施状态：** 已完成。下列任务记录实施后的当前状态。

**Goal:** 将当前黑色 `#agents` 智能体中心升级为唯一前端壳，安全删除旧白色 CRM 页面和只服务于旧入口的代码。

**Architecture:** 先以纯函数闭合 Hash 路由，再把登录/会话从巨型旧 CRM 控制器中抽成独立控制器；随后缩减 `index.html` 为登录页、黑色壳和 Growth 工作区三部分，最后删除不可达旧模块。保留现有获客、私域、工作流、Growth 和财务委员会控制器，后端、合同、数据库及数据不变。

**Tech Stack:** TypeScript 5.7、Vite 6、原生 DOM、Playwright、现有 Node/tsx self-test、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-08-23-agent-center-single-frontend-shell-design.md`

## 任务状态

- [x] Task 1：闭合唯一应用路由
- [x] Task 2：抽出黑色壳认证控制器
- [x] Task 3：删除旧白色 CRM 并建立唯一 DOM
- [x] Task 4：清理无消费者依赖、同步文档并完成验收

## Global Constraints

- 唯一权威首页是黑色 `#agents` 智能体中心和六张业务智能体卡牌。
- `/`、空 Hash、`#dashboard` 和未知 Hash 必须规范化到 `#agents`。
- 登录、会话、CSRF、RBAC、workspace 权威、后端 API、数据库和业务数据不得削弱或迁移。
- `#acquisition`、私域、成交、自动工作流及受支持的 Growth/财务深链路必须继续可用。
- 删除代码前必须证明其不再被黑色壳、Growth 页面、测试或构建入口引用。
- 不新增后台管理系统，不重做卡牌视觉，不新增智能体业务能力。
- 当前用户要求快速开发；实施过程不启动独立代码审查或 CodeRabbit，按 TDD 和本计划门禁自验。

---

## 文件结构

### 新建

- `frontend/src/app-route.ts`：唯一应用 Hash 规范化规则。
- `frontend/src/app-route.self-test.ts`：根路径、旧 dashboard、未知路径和保留深链路测试。
- `frontend/src/app-session.ts`：登录、会话恢复、退出和认证事件控制器。
- `frontend/src/app-session.self-test.ts`：demo/real 登录、恢复、401 和退出的确定性测试。
- `frontend/src/app-shell.css`：仅包含全局基础、登录页和认证前后可见性规则。
- `frontend/tests/agent-center-shell.spec.ts`：唯一壳、六卡、Hash 回退和旧壳缺失的浏览器验收。

### 修改

- `frontend/index.html`：只保留登录页、黑色 replica 壳、Growth host、必要对话框和模块入口。
- `frontend/src/demo/demo-types.ts`：删除 `dashboard` 这个旧默认模块。
- `frontend/src/demo/demo-router.ts`：默认模块改为 `agents`，统一使用 `normalizeAppHash`。
- `frontend/src/demo/demo-app.ts`：删除 dashboard 渲染分支，继续装配黑色壳业务模块。
- `frontend/src/demo/demo-store.self-test.ts`：移除对已删除 dashboard view 的耦合，保留 store 领域回归。
- `frontend/src/growth/entry.ts`：只在黑色壳和 Growth host 之间切换。
- `frontend/src/replica-dashboard.css`：移除针对旧 `.shell` 的兼容规则，保留黑色壳布局。
- `frontend/src/self-test.ts`：把“旧 CRM 必须存在”的静态断言改为“唯一黑色壳且旧入口不存在”。
- `frontend/playwright.config.ts`：纳入新的唯一壳验收 spec。
- `frontend/package.json`、`pnpm-lock.yaml`：删除旧 CRM 独占依赖。
- `README.md`、`frontend/README.md`、`DEVELOPMENT_STATUS.md`：把默认入口和前端职责改为当前真实规则。

### 删除

- `frontend/src/prototype-api.ts`：旧白色 CRM 巨型控制器。
- `frontend/src/m1-layout.css`：旧白色 CRM/M1 兼容样式。
- `frontend/src/lead-finder-layout.ts`：仅由旧控制器和旧静态测试消费的布局 helper。
- `frontend/src/main.tsx`：未被当前 Vite 入口加载的旧 React CRM。
- `frontend/src/api.ts`：仅服务旧 React CRM 的 API 类型与客户端。
- `frontend/src/styles.css`：仅服务旧 React CRM 的样式。
- `frontend/src/demo/demo-dashboard-view.ts`：错误 `#dashboard` 黑色壳视图；该 Hash 改为智能体中心兼容跳转。

---

### Task 1: 闭合唯一应用路由（已完成）

**Files:**
- Create: `frontend/src/app-route.ts`
- Create: `frontend/src/app-route.self-test.ts`
- Modify: `frontend/src/demo/demo-types.ts`
- Modify: `frontend/src/demo/demo-router.ts`
- Modify: `frontend/src/demo/demo-app.ts`
- Modify: `frontend/src/demo/demo-store.self-test.ts`
- Modify: `frontend/src/self-test.ts`

**Interfaces:**
- Consumes: `parseGrowthHash(hash: string): GrowthRoute | null`、现有 `DemoModule`。
- Produces: `normalizeAppHash(hash: string): string`、`isStandaloneModuleHash(hash: string): boolean`；`createDemoRouter()` 默认进入 `agents`。

- [x] **Step 1: 写路由失败测试**

```ts
import { strict as assert } from "node:assert";
import { normalizeAppHash } from "./app-route";

assert.equal(normalizeAppHash(""), "#agents");
assert.equal(normalizeAppHash("#"), "#agents");
assert.equal(normalizeAppHash("#dashboard"), "#agents");
assert.equal(normalizeAppHash("#unknown-old-crm"), "#agents");
assert.equal(normalizeAppHash("#agents"), "#agents");
assert.equal(normalizeAppHash("#acquisition"), "#acquisition");
assert.equal(normalizeAppHash("#growth/agents/profit"), "#growth/agents/profit");
assert.equal(normalizeAppHash("#financial-council"), "#financial-council");
```

- [x] **Step 2: 运行测试并确认 RED**

Run: `cd frontend && pnpm exec tsx src/app-route.self-test.ts`

Expected: FAIL，报 `ERR_MODULE_NOT_FOUND` 或缺少 `normalizeAppHash`。

- [x] **Step 3: 实现最小闭合路由**

```ts
import { parseGrowthHash } from "./growth/router";

const standalone = new Set([
  "agents",
  "acquisition",
  "conversations",
  "private-domain",
  "conversion",
  "scripts",
  "trade-marketing",
  "settings"
]);

export function isStandaloneModuleHash(hash: string): boolean {
  return standalone.has(hash.replace(/^#/, ""));
}

export function normalizeAppHash(hash: string): string {
  if (parseGrowthHash(hash)) return hash.startsWith("#") ? hash : `#${hash}`;
  return isStandaloneModuleHash(hash)
    ? `#${hash.replace(/^#/, "")}`
    : "#agents";
}
```

在 `DemoModule` 删除 `dashboard`；`createDemoRouter(initial = "agents")` 启动前调用 `normalizeAppHash`，使用 `history.replaceState` 规范化而不增加浏览器历史。`demo-app.ts` 删除 `renderDashboardView`、`resetDashboardViewState` 和 dashboard 分支。

- [x] **Step 4: 更新聚合 self-test**

在 `frontend/src/self-test.ts` 导入 `./app-route.self-test`，删除 `renderDashboardView` 及旧 dashboard 静态要求；在 `demo-store.self-test.ts` 用 conversation/private-domain view 的既有恶意枚举测试替代 dashboard renderer 调用，继续验证文本转义和 store 不变式。

- [x] **Step 5: 运行路由和现有 self-test**

Run: `cd frontend && pnpm exec tsx src/app-route.self-test.ts && pnpm test`

Expected: 两个命令均 PASS，输出最终 `ok: true`；`#dashboard` 不再是 `DemoModule`。

- [x] **Step 6: 提交路由切换**

```bash
git add frontend/src/app-route.ts frontend/src/app-route.self-test.ts frontend/src/demo/demo-types.ts frontend/src/demo/demo-router.ts frontend/src/demo/demo-app.ts frontend/src/demo/demo-store.self-test.ts frontend/src/self-test.ts
git commit -m "feat(frontend): make agent center the default route"
```

---

### Task 2: 从旧 CRM 抽出最小认证控制器（已完成）

**Files:**
- Create: `frontend/src/app-session.ts`
- Create: `frontend/src/app-session.self-test.ts`
- Modify: `frontend/src/self-test.ts`
- Modify: `frontend/index.html`

**Interfaces:**
- Consumes: `/api/auth/login`、`/api/auth/me`、`/api/auth/logout`、`gj_csrf` cookie、`gj_user` localStorage、`goodjob:auth-state-changed`。
- Produces: `createAppSessionController(options): AppSessionController`，含 `start(): Promise<void>`、`login(email, password): Promise<void>`、`logout(): Promise<void>`、`destroy(): void`。

- [x] **Step 1: 写认证控制器失败测试**

用 linkedom 创建只包含 `#loginButton`、`#loginEmail`、`#loginPassword`、`.replica-user`、`[data-session-user-name]` 和 `[data-session-user-role]` 的 DOM，注入 fake `fetchImpl`、memory storage 和 cookie source，断言：

```ts
assert.equal(document.body.classList.contains("is-authenticated"), false);
await controller.login("admin@goodjob.com", "goodjob123");
assert.equal(document.body.classList.contains("is-authenticated"), true);
assert.equal(location.hash, "#agents");
assert.equal(storage.getItem("gj_user")?.includes("admin@goodjob.com"), true);
assert.deepEqual(events, [true]);
await controller.logout();
assert.equal(storage.getItem("gj_user"), null);
assert.deepEqual(events, [true, false]);
```

另加真实模式用例：写请求携带 `x-csrf-token`；`/api/auth/me` 401 时清除本地 session 且不展示黑色壳。

- [x] **Step 2: 运行测试并确认 RED**

Run: `cd frontend && pnpm exec tsx src/app-session.self-test.ts`

Expected: FAIL，报缺少 `app-session.js`。

- [x] **Step 3: 实现认证控制器**

实现闭合的 `AppUser`：

```ts
export interface AppUser {
  id: string;
  name: string;
  email: string;
  role: "sales" | "manager" | "admin" | "super_admin";
  teamId: string;
  avatar: string;
}
```

控制器要求：

- demo 模式只使用本地确定性 admin，不访问 `/api/**`；
- real 模式 `credentials: "same-origin"`；
- POST 自动读取 `gj_csrf` 并发送 `x-csrf-token`；
- 登录/恢复成功后写入 `gj_user`、更新黑色侧栏用户名称/角色、增加 `body.is-authenticated`、发布认证事件；
- 根路径、`#dashboard` 或未知 Hash 在认证成功时规范化为 `#agents`；
- logout 即使服务器请求失败也清理本地 session；
- `destroy()` 移除 DOM 监听器，避免重复启动。

- [x] **Step 4: 把黑色侧栏用户按钮绑定到新控制器**

在 `index.html` 的 `.replica-user` 增加 `id="logoutButton"` 和 `aria-label="退出登录"`；名称、角色节点分别增加 `data-session-user-name`、`data-session-user-role`。在页面底部加载 `/src/app-session.ts`，模块入口只执行一次 `createAppSessionController().start()`。

- [x] **Step 5: 运行认证、类型和聚合测试**

Run: `cd frontend && pnpm exec tsx src/app-session.self-test.ts && pnpm test && pnpm run test:types`

Expected: 全部 PASS；真实写请求的 CSRF 断言通过。

- [x] **Step 6: 提交认证抽取**

```bash
git add frontend/index.html frontend/src/app-session.ts frontend/src/app-session.self-test.ts frontend/src/self-test.ts
git commit -m "refactor(frontend): isolate shell authentication"
```

---

### Task 3: 删除旧白色 CRM 并让黑色壳成为唯一 DOM（已完成）

**Files:**
- Create: `frontend/src/app-shell.css`
- Create: `frontend/tests/agent-center-shell.spec.ts`
- Modify: `frontend/index.html`
- Modify: `frontend/src/replica-dashboard.css`
- Modify: `frontend/src/growth/entry.ts`
- Modify: `frontend/src/self-test.ts`
- Modify: `frontend/playwright.config.ts`
- Delete: `frontend/src/prototype-api.ts`
- Delete: `frontend/src/m1-layout.css`
- Delete: `frontend/src/lead-finder-layout.ts`
- Delete: `frontend/src/main.tsx`
- Delete: `frontend/src/api.ts`
- Delete: `frontend/src/styles.css`
- Delete: `frontend/src/demo/demo-dashboard-view.ts`

**Interfaces:**
- Consumes: Task 1 的 Hash 规范化、Task 2 的认证事件、现有 `replica-dashboard.ts`、`demo-app.ts`、`growth/entry.ts`。
- Produces: 页面中唯一业务壳 `.replica-shell`；旧 `.shell`、`prototype-api.ts` 和 dashboard DOM 不再存在。

- [x] **Step 1: 写唯一壳浏览器失败测试**

新增 Playwright spec：

```ts
test("root and legacy dashboard open the agent center only", async ({ page }) => {
  await page.goto("/");
  await page.locator("#loginButton").click();
  await expect(page).toHaveURL(/#agents$/u);
  await expect(page.getByRole("heading", { name: "AI 经营顾问团队" })).toBeVisible();
  await expect(page.locator(".agent-card")).toHaveCount(6);
  await expect(page.locator(".shell")).toHaveCount(0);
  await expect(page.locator("#dashboard")).toHaveCount(0);
  await page.goto("/#dashboard");
  await expect(page).toHaveURL(/#agents$/u);
});
```

再断言 `#acquisition`、`#private-domain`、`#growth/agents` 和 `#financial-council` 仍能激活对应现有 host，不出现旧 CRM。

- [x] **Step 2: 运行浏览器测试并确认 RED**

Run: `cd frontend && pnpm exec playwright test agent-center-shell.spec.ts --project=chromium`

Expected: FAIL；当前 `/` 或 `#dashboard` 仍含旧 `.shell`/dashboard DOM。

- [x] **Step 3: 缩减 `index.html`**

正文只保留现有完整登录表单、现有完整 `.replica-shell`（含获客面板、动态 module host、inspector 和对话框）以及现有完整 `#growthWorkspace`。资源入口必须精确收敛为：

```html
<link rel="stylesheet" href="/src/app-shell.css" />
<link rel="stylesheet" href="/src/vendor/phosphor/regular/style.css" />
<link rel="stylesheet" href="/src/replica-dashboard.css" />
<link rel="stylesheet" href="/src/demo/demo.css" />
<link rel="stylesheet" href="/src/growth/styles.css" />
<script type="module" src="/src/app-session.ts"></script>
<script type="module" src="/src/replica-dashboard.ts"></script>
<script type="module" src="/src/demo/demo-app.ts"></script>
```

删除旧 `<div class="shell">` 全部 DOM、旧内联 tab/router script、`prototype-api.ts` 和 `m1-layout.css` 入口。黑色壳内部现有获客面板、`#demoModuleMain`、`#demoModuleInspector`、任务/连接对话框必须原样保留。

- [x] **Step 4: 建立最小全局与登录样式**

`app-shell.css` 只定义 `html/body` 基础、`.login-screen`、登录表单、错误提示、认证前后可见性和移动端登录布局。`replica-dashboard.css` 删除：

```css
body.is-authenticated > .shell { display: none !important; }
```

不改六张卡牌和现有黑色壳设计 token。

- [x] **Step 5: 删除确认不可达的旧文件并闭合静态测试**

删除本任务列出的七个文件。更新 `self-test.ts`，以源码断言锁定：

```ts
assert.doesNotMatch(prototype, /class="shell"/u);
assert.doesNotMatch(prototype, /id="dashboard"/u);
assert.doesNotMatch(prototype, /prototype-api\.ts/u);
assert.match(prototype, /data-replica-view="agents"/u);
assert.match(prototype, /id="demoModuleMain"/u);
```

`growth/entry.ts` 的 shell selector 从 `.replica-shell, .shell` 改为 `.replica-shell`。

- [x] **Step 6: 执行依赖和导入审计**

Run:

```bash
rg -n "prototype-api|m1-layout|lead-finder-layout|demo-dashboard-view|src/main\.tsx|class=\"shell\"|id=\"dashboard\"" frontend --glob '!node_modules/**' --glob '!dist/**'
```

Expected: 除设计/历史文档外，前端运行代码和当前测试零匹配；任何剩余源码匹配都必须在本任务内删除或改写。

- [x] **Step 7: 运行唯一壳和保留路径门禁**

Run:

```bash
cd frontend
pnpm test
pnpm run test:types
pnpm exec playwright test agent-center-shell.spec.ts demo-auth.spec.ts growth-bootstrap.spec.ts growth-financial-council.spec.ts --project=chromium
pnpm build
```

Expected: 全部 PASS；构建中不再打包 `prototype-api.ts`、旧 React CRM 或 `echarts`。保留的财务报表导入继续打包 `xlsx`。

- [x] **Step 8: 提交唯一壳和旧代码删除**

```bash
git add -A frontend/index.html frontend/src frontend/tests/agent-center-shell.spec.ts frontend/playwright.config.ts
git commit -m "refactor(frontend): remove the legacy crm shell"
```

---

### Task 4: 清理依赖、同步当前文档并完成全量验收（已完成）

**Files:**
- Modify: `frontend/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `README.md`
- Modify: `frontend/README.md`
- Modify: `DEVELOPMENT_STATUS.md`

**Interfaces:**
- Consumes: Task 3 的唯一黑色应用壳。
- Produces: 与实际入口一致的安装、启动、测试和产品说明。

- [x] **Step 1: 审计保留与无消费者依赖**

Run:

```bash
rg -n 'from "(xlsx|echarts)|from "react|from "react-dom' frontend/src --glob '!ui-kit/**'
```

Expected: 保留的财务报表导入在 `frontend/src/growth/agents/controller.ts` 直接使用 `xlsx`；`echarts` 零匹配；React 只出现在保留的 `frontend/src/ui-kit/`。

- [x] **Step 2: 删除无消费者依赖**

Run:

```bash
pnpm --filter goodjob-crm-frontend remove echarts
```

Expected: `frontend/package.json` 与根 `pnpm-lock.yaml` 不再包含 `echarts`，但保留 `xlsx` 以支持财务报表导入；`pnpm install --frozen-lockfile` 可用。React 依赖因 UI kit 仍使用而保留。

- [x] **Step 3: 更新当前文档**

把三个当前入口文档正文改成以下真实规则：

- 项目唯一前端为黑色智能体业务壳；
- 默认 URL 为 `http://127.0.0.1:<vite-port>/#agents`；
- `/`、`#dashboard` 和未知 Hash 自动回到 `#agents`；
- 六张智能体卡牌是产品首页；
- 旧白色 CRM 已删除，不再提供旧入口；
- 后端、数据库、合同和现有业务数据未删除；
- 开发、测试和 build 命令仍从 pnpm workspace 执行。

- [x] **Step 4: 运行完整前端门禁**

Run:

```bash
pnpm install --frozen-lockfile
pnpm --filter goodjob-crm-frontend run test:types
pnpm --filter goodjob-crm-frontend test
pnpm --filter goodjob-crm-frontend run test:e2e
pnpm --filter goodjob-crm-frontend build
pnpm build
git diff --check
```

Expected: 所有命令 PASS；若既有构建仅有已记录的 Vite chunk-size warning，可记录但不得把失败写成通过。

- [x] **Step 5: 在真实浏览器完成四视口验收**

依次使用 1440、1366、1024、390 像素 viewport 打开 `/`，完成 demo 登录并验证：

- URL 为 `#agents`；
- 标题和六张卡牌可见；
- 侧边栏/移动导航可操作；
- 页面无横向溢出；
- `#acquisition`、`#private-domain`、`#growth/agents`、`#financial-council` 可达；
- DOM 中不存在 `.shell` 和 `#dashboard`。

- [x] **Step 6: 提交依赖和文档收尾**

```bash
git add frontend/package.json pnpm-lock.yaml README.md frontend/README.md DEVELOPMENT_STATUS.md
git commit -m "docs: make agent center the canonical frontend"
```

- [x] **Step 7: 最终状态核对**

Run:

```bash
git status --short
git log -4 --oneline
git diff HEAD~4..HEAD --check
```

Expected: 工作树干净；四个提交依次为路由、认证、唯一壳删除、依赖与文档；diff check PASS。

---

## 自检结果

- 规格覆盖：路由、认证、保留业务、旧代码删除、错误行为、响应式验收、数据安全、文档和回滚均有对应任务。
- 占位符扫描：计划不包含未完成标记、含糊实现指令或未定义接口。
- 类型一致性：路由统一由 `normalizeAppHash` 提供；认证统一发布现有 `goodjob:auth-state-changed`；Growth 和财务深链路继续由 `parseGrowthHash` 处理。
- 删除安全：先完成路由和认证替代，再删除旧文件；旧壳删除是独立提交，可单独 revert。

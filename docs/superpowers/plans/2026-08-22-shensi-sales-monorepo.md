# Shensi Sales Monorepo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将已提交的 GoodJob 后端与 shensi-sales 前端合并为一个可安装、测试和发布的 pnpm Monorepo，同时保留双方 Git 历史。

**Architecture:** 以当前 `shensi-sales/main` 的前端历史为主线，普通 merge `GoodJob/main`，再按已批准设计重建目标 tree。根 workspace 负责编排，`backend/`、`frontend/` 和 `contracts/` 保持独立包；前端钉住的合同副本作为可验证的消费制品，根 `contracts/` 是唯一可编辑合同源。

**Tech Stack:** Git, pnpm workspace, Node.js 22.22.3, TypeScript, Express, React 19, Vite 6, Playwright, MySQL 8

**Spec:** `docs/superpowers/specs/2026-08-22-shensi-sales-monorepo-design.md`

## Global Constraints

- 后端来源固定为 `d21bbac7a751d853216bfe0a63461121396f5ab1`，前端来源固定为 `daaf468f8efd8dde5d85ea9715794bf96a3bce26`。
- 必须保留两条 Git 历史；不得 squash、force-push 或改写 `main`。
- 原前端未提交的 `pnpm-workspace.yaml` 和 `debug-agents.mts` 不得读取、复制、修改、暂存或删除。
- 目标仓库只保留根 `pnpm-lock.yaml`，不保留 npm `package-lock.json`；原仓库锁文件保持不变。
- 根 `contracts/` 是唯一可编辑合同源；`frontend/contracts/pinned/` 只是哈希校验后的消费快照。
- 不迁移 `.env`、凭据、cookie、数据库、构建产物或原始客户数据。
- 不改变业务逻辑、API 语义或数据库模型。
- `MYSQL_TEST_ADMIN_URL` 不可用时必须如实报告真实 MySQL/E2E 阻塞，禁止用 fake 结果冒充。
- 每个提交前检查 README 和当前执行文档，保证命令与目录是当前真实状态。

---

### Task 1: 合并双方历史并重建目标目录

**Files:**
- Move: 当前前端提交的全部产品文件 → `frontend/`
- Restore: `backend/`, `contracts/`, `deploy/`, `docs/`, `tools/` from `GoodJob/main`
- Preserve: `docs/superpowers/specs/2026-08-22-shensi-sales-monorepo-design.md`
- Preserve: `docs/superpowers/plans/2026-08-22-shensi-sales-monorepo.md`

**Interfaces:**
- Consumes: Git trees `d21bbac...` and `daaf468...`
- Produces: 一个同时包含两边祖先、且目录符合设计的 merge tree

- [x] **Step 1: 固定并验证来源对象**

```bash
git fetch https://github.com/kzhangmyang-cmyk/GoodJob.git \
  main:refs/remotes/goodjob/main
test "$(git rev-parse refs/remotes/goodjob/main)" = \
  d21bbac7a751d853216bfe0a63461121396f5ab1
test "$(git rev-parse main)" = \
  daaf468f8efd8dde5d85ea9715794bf96a3bce26
```

Expected: 两个 `test` 均 exit 0。

- [x] **Step 2: 运行普通 merge 并确认预期结构冲突**

```bash
git merge --no-ff --no-commit refs/remotes/goodjob/main
```

Expected: merge 进入未提交状态并报告前端根目录与 GoodJob Monorepo 的结构冲突；不得提交自动合并结果。

- [x] **Step 3: 按批准设计机械重建 tree**

```bash
FRONTEND_TREE_DIR="$(mktemp -d)"
git archive daaf468f8efd8dde5d85ea9715794bf96a3bce26 | \
  tar -x -C "$FRONTEND_TREE_DIR"
git checkout refs/remotes/goodjob/main -- .
git rm -r --ignore-unmatch frontend
mkdir frontend
cp -R "$FRONTEND_TREE_DIR"/. frontend/
git checkout 0fd63fa -- \
  docs/superpowers/specs/2026-08-22-shensi-sales-monorepo-design.md
git checkout codex/shensi-sales-monorepo -- \
  docs/superpowers/plans/2026-08-22-shensi-sales-monorepo.md
git add -A
```

Expected: `backend/src/server.ts`、`frontend/src/main.tsx` 和 `contracts/package.json` 同时存在；`frontend/debug-agents.mts` 不存在。

- [x] **Step 4: 验证 merge 索引和双历史**

```bash
test -f backend/src/server.ts
test -f frontend/src/main.tsx
test -f contracts/package.json
test ! -e frontend/debug-agents.mts
git diff --cached --check
```

Expected: 全部 exit 0。保持 merge 状态进入 Task 2，根工程配置完成后统一提交。

---

### Task 2: 建立统一 pnpm workspace 与结构门禁

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `tools/shensi-monorepo-layout.test.mjs`
- Modify: `package.json`
- Delete: `package-lock.json`
- Replace: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `backend/package.json`, `frontend/package.json`, `contracts/package.json`
- Produces: 根命令 `dev`, `build`, `test`, `test:financial-council`, `test:e2e`, `test:e2e:financial-council:real`, `test:layout`

- [x] **Step 1: 写结构门禁测试**

Create `tools/shensi-monorepo-layout.test.mjs`:

```js
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const exists = async (path) => access(path).then(() => true, () => false);

test("repository exposes the approved monorepo layout", async () => {
  const workspace = await readFile("pnpm-workspace.yaml", "utf8");
  assert.match(workspace, /- backend/u);
  assert.match(workspace, /- frontend/u);
  assert.match(workspace, /- contracts/u);
  assert.equal(await exists("backend/src/server.ts"), true);
  assert.equal(await exists("frontend/src/main.tsx"), true);
  assert.equal(await exists("contracts/package.json"), true);
  assert.equal(await exists("package-lock.json"), false);
  assert.equal(await exists("debug-agents.mts"), false);
  assert.equal(await exists("frontend/debug-agents.mts"), false);
});
```

- [x] **Step 2: 运行结构门禁并确认 RED**

Run: `node --test tools/shensi-monorepo-layout.test.mjs`

Expected: FAIL，因为正式 workspace 尚未建立或 `package-lock.json` 仍存在。

- [x] **Step 3: 写根 workspace 配置与命令**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - backend
  - frontend
  - contracts

allowBuilds:
  "@google/genai": false
  "@scarf/scarf": false
  esbuild: true
  msgpackr-extract: true
  protobufjs: true
  puppeteer: true
  tesseract.js: true
```

Set root `package.json` to private package `shensi-sales`, preserve Node engine `>=22.22.3 <23`, keep `concurrently` `^9.2.1`, and define:

```json
{
  "scripts": {
    "dev": "concurrently \"pnpm --filter ./backend dev:mysql\" \"pnpm --filter ./frontend dev\"",
    "build": "pnpm --filter ./contracts check:types && pnpm --filter ./backend build && pnpm --filter ./frontend build",
    "test": "pnpm --filter ./contracts test && pnpm --filter ./backend test && pnpm --filter ./frontend test",
    "test:layout": "node --test tools/shensi-monorepo-layout.test.mjs",
    "test:financial-council": "pnpm --filter ./backend test:financial-council",
    "test:e2e": "pnpm --filter ./frontend test:e2e",
    "test:e2e:financial-council:real": "pnpm --filter ./frontend test:e2e:financial-council:real"
  }
}
```

- [x] **Step 4: 删除旧锁并生成唯一 pnpm 锁**

```bash
git rm package-lock.json
rm -f pnpm-lock.yaml
pnpm install --lockfile-only
pnpm install --frozen-lockfile
```

Expected: 根 `pnpm-lock.yaml` 同时列出三个 workspace importer，安装 exit 0。

- [x] **Step 5: 运行结构门禁并确认 GREEN**

Run: `pnpm test:layout`

Expected: 1 test PASS。

---

### Task 3: 修正 Monorepo 路径与合同消费边界

**Files:**
- Modify: `frontend/playwright.financial-council-real.config.ts`
- Modify: `frontend/scripts/check-growth-contract.mjs`
- Modify: `frontend/scripts/check-growth-contract.test.mjs`
- Test: `tools/shensi-monorepo-layout.test.mjs`

**Interfaces:**
- Consumes: root release `contracts/releases/growth-advisor-quote-roi/1.0.10`
- Produces: 默认定位当前 Monorepo 根的真实 E2E；校验 pinned 消费快照与根 release 同源

- [x] **Step 1: 为默认后端根路径写失败断言**

Append to `tools/shensi-monorepo-layout.test.mjs`:

```js
test("real council E2E resolves the backend from this monorepo", async () => {
  const config = await readFile(
    "frontend/playwright.financial-council-real.config.ts",
    "utf8"
  );
  assert.doesNotMatch(config, /GoodJob-growth/u);
  assert.match(config, /import\.meta\.url/u);
});
```

- [x] **Step 2: 运行路径测试并确认 RED**

Run: `pnpm test:layout`

Expected: FAIL，因为配置仍含旧绝对路径 `/GoodJob-growth`。

- [x] **Step 3: 改为相对当前仓库的默认路径**

In `frontend/playwright.financial-council-real.config.ts`:

```ts
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(frontendRoot, "..");
const backendRoot = process.env.GOODJOB_BACKEND_ROOT ?? repositoryRoot;
```

Keep the environment override and existing no-route-interception behavior.

- [x] **Step 4: 校验 pinned 合同与根 release 一致**

Extend `frontend/scripts/check-growth-contract.mjs` so `verifyPinnedGrowthContract()` also reads `../../contracts/releases/growth-advisor-quote-roi/1.0.10`, verifies both releases, then rejects unless `contractVersion` and `contractHash` match. Add a temporary-directory test whose valid pinned release identifies a different canonical root release and expects `Pinned growth contract identity mismatch`.

Run:

```bash
pnpm --filter ./frontend contract:check
node --test frontend/scripts/check-growth-contract.test.mjs
```

Expected: all checks PASS and generated TypeScript remains unchanged.

- [x] **Step 5: 运行路径门禁并确认 GREEN**

```bash
pnpm test:layout
pnpm --filter ./frontend test:types
```

Expected: all PASS。

---

### Task 4: 同步统一仓库文档

**Files:**
- Modify: `README.md`
- Modify: `frontend/README.md`
- Modify: `docs/superpowers/specs/2026-08-22-shensi-sales-monorepo-design.md`
- Modify: `docs/superpowers/plans/2026-08-22-shensi-sales-monorepo.md`

**Interfaces:**
- Consumes: Task 2 根命令和 Task 3 路径规则
- Produces: 当前开发者唯一入口和可复制命令

- [x] **Step 1: 写根 README**

Document exact commands:

```text
Node.js 22.22.3
pnpm install --frozen-lockfile
pnpm dev
pnpm build
pnpm test
pnpm test:financial-council
MYSQL_TEST_ADMIN_URL=... pnpm test:e2e:financial-council:real
```

Include directory responsibilities, memory/MySQL modes, contract ownership, environment-file policy, and links to backend/current documentation plus `frontend/README.md`.

- [x] **Step 2: 修正前端 README 的路径和命令**

Replace the absolute `GOODJOB_BACKEND_ROOT=/Users/.../GoodJob-growth` example with:

```bash
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" \
pnpm test:e2e:financial-council:real
```

Explain that `frontend/contracts/pinned/` is a verified consumption snapshot, while authored contracts live at root `contracts/`.

- [x] **Step 3: 检查文档无旧工作区入口**

```bash
rg -n '/Users/mac/Documents/新项目/GoodJob-growth' \
  README.md frontend/README.md package.json frontend/playwright*.ts
```

Expected: no matches。

---

### Task 5: 完成 merge、执行门禁并推送 PR

**Files:**
- Verify: entire repository
- Modify only if a gate proves a path/package-manager regression

**Interfaces:**
- Consumes: Tasks 1–4 complete target tree
- Produces: reviewable GitHub integration branch and PR

- [x] **Step 1: 提交原子历史 merge**

```bash
git add -A
git diff --cached --check
git commit -m "feat: unify shensi sales frontend and backend"
```

Expected: commit has two parents; `git rev-list --parents -n 1 HEAD` contains pre-merge shensi branch and `d21bbac...` ancestry。

- [x] **Step 2: 运行安装与快速工程门禁**

```bash
pnpm install --frozen-lockfile
pnpm test:layout
pnpm --filter ./contracts test
pnpm --filter ./contracts check:types
pnpm --filter ./frontend contract:check
pnpm --filter ./frontend test:types
pnpm --filter ./frontend test
pnpm build
git diff --check
```

Expected: all exit 0；Vite 既有 chunk warning 可记录但不是失败。

- [x] **Step 3: 运行金融委员会与浏览器回归**

```bash
pnpm test:financial-council
pnpm --filter ./frontend exec playwright test \
  acquisition-visual-reader.spec.ts growth-financial-council.spec.ts
```

Expected: backend aggregate 0 fail；指定 Playwright suites 0 fail。

- [x] **Step 4: 有真实 MySQL 时运行最终验收**

```bash
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" \
pnpm test:e2e:financial-council:real
```

Expected: Chromium 1/1 PASS；变量或 MySQL 不可用时明确标记 BLOCKED，不用 fake 替代。

- [x] **Step 5: 做安全和来源核对**

```bash
test ! -e debug-agents.mts
test ! -e frontend/debug-agents.mts
git ls-files | rg '(^|/)(\.env($|\.)|debug-agents\.mts|node_modules|dist/)' && exit 1 || true
git status --short
```

Expected: no secret/debug/build files tracked；工作树 clean。前端产品差异只来自目录前缀、Monorepo 路径、合同校验和 README。

- [ ] **Step 6: 推送分支并创建 PR**

```bash
git push -u origin codex/shensi-sales-monorepo
gh pr create \
  --repo kzhangmyang-cmyk/shensi-sales \
  --base main \
  --head codex/shensi-sales-monorepo \
  --title "Unify Shensi Sales frontend and backend" \
  --body-file /tmp/shensi-sales-pr.md
```

PR body lists source commits, directory layout, pnpm decision, exact test counts, any MySQL/E2E blocker, and confirms the two local user files were excluded.

## Implementation Record

- 历史合并提交：`4d2185018f93333a2606d77f306ff3e14f25eea3`，父历史为 `14aab16d91f9393d96fdc9509077203454799e68` 与 `d21bbac7a751d853216bfe0a63461121396f5ab1`。
- 重建时目标 `frontend/` subtree 与来源 `daaf468f8efd8dde5d85ea9715794bf96a3bce26` 的 tree hash 均为 `321756959c857b120fb0633db9c65815c9e050de`；随后只加入 Monorepo 路径、合同校验、生成类型和 README 变更。
- `pnpm install --frozen-lockfile`：PASS，4 个 workspace importer。
- 结构门禁：2/2 PASS。
- 合同门禁：88/88 PASS；生成类型 freshness PASS。
- 前端：types PASS，自测试 125/125 PASS，build PASS。
- 根门禁：`pnpm test` PASS；宝塔 pnpm 发布包 2/2 PASS；`pnpm test:layout` 2/2 PASS；整仓 `pnpm build` PASS。
- 后端：TypeScript build PASS；金融委员会在真实 MySQL 环境下 327 pass / 0 fail / 0 skip。
- Chromium 关键回归：20/20 PASS（visual reader + financial council fixture suites）。
- 真实 InnoDB：MySQL 8.4.11 LTS，仓储/并发/恢复门禁 83/83 PASS。
- 真实 MySQL + 真实后端 + no-intercept Chromium：1/1 PASS。
- `debug-agents.mts` 和原前端未提交的 `pnpm-workspace.yaml` 均未复制；原工作区保持原状。

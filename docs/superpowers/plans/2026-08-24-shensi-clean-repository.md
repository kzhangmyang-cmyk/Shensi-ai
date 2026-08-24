# Shensi Clean Repository Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create `/Users/mac/Documents/新项目/shensi` as the only current, deployable, AI-readable repository, migrate the live MySQL data and encrypted DeepSeek configuration, and replace the obsolete login surface.

**Architecture:** Clone the verified current branch into a standalone repository while preserving history, keep the existing `frontend/`, `backend/`, and `contracts/` boundaries, and add current-state documentation, migration tooling, and a four-service Compose deployment. Restore data into a new database before cutover, verify identities and encrypted model credentials, then switch the user-facing origin only after parallel acceptance.

**Tech Stack:** Node.js 22.22.3, TypeScript, pnpm 11.18.0, Vite, Express, MySQL 8.4, Docker Compose, Nginx, Playwright, OpenSSL.

**Spec:** `docs/superpowers/specs/2026-08-24-shensi-clean-repository-design.md`

## Global Constraints

- The source is the clean `codex/real-financial-council` branch containing design commit `5471e2fa3195b471f585bc097501501f1388b6b4` and this committed plan.
- The destination is exactly `/Users/mac/Documents/新项目/shensi`; reject any existing non-empty destination instead of merging into it.
- Keep `frontend/`, `backend/`, and `contracts/` at the repository root.
- Do not copy `.git/worktrees`, `node_modules`, `dist`, `.env.real.local`, database files, Playwright output, or plaintext credentials as ordinary project artifacts.
- Do not delete or overwrite `/Users/mac/Documents/新项目/shensi-sales` or its `shensi_sales` database.
- Database restore must target a distinct database named `shensi` and fail if the source and target names match.
- Database dumps, `.env.local`, `.env.production.local`, passphrases, API keys, customer raw rows, and provider encryption keys must remain Git-ignored.
- Provider credentials remain encrypted; migration must preserve `PROVIDER_CREDENTIAL_KEY` and `AGENT_JOB_ENCRYPTION_KEY` outside Git.
- The new login must never contain default credentials or render the old white CRM panel.
- Production cannot fall back to memory or demo data.
- Docker images run as non-root users and use multi-stage builds.
- Current Growth contract release remains `1.0.12`; migration does not create a new public contract release.
- Historical plans are non-authoritative; `docs/PROJECT_STATUS.md` is the sole current progress ledger.
- Do not push to a new GitHub remote until the user explicitly authorizes it.

---

### Task 1: Create the standalone canonical repository

**Files:**
- Create in destination: `docs/SOURCE_PROVENANCE.md`
- Create in destination: `tools/shensi-repository-layout.test.mjs`
- Modify in destination: `.gitignore`

**Interfaces:**
- Consumes: clean source branch and its exact `git rev-parse HEAD`.
- Produces: standalone `/Users/mac/Documents/新项目/shensi` repository whose `main` is the current branch and whose legacy remote cannot be pushed accidentally.

- [ ] **Step 1: Capture and validate the source commit**

Run from `/Users/mac/Documents/新项目/shensi-sales/.worktrees/agent-center-shell`:

```bash
test -z "$(git status --porcelain)"
test "$(git branch --show-current)" = "codex/real-financial-council"
SOURCE_COMMIT="$(git rev-parse HEAD)"
git merge-base --is-ancestor 5471e2fa3195b471f585bc097501501f1388b6b4 "$SOURCE_COMMIT"
test ! -e /Users/mac/Documents/新项目/shensi
```

Expected: every command exits `0`; the destination does not exist.

- [ ] **Step 2: Clone the current branch into the destination**

```bash
SOURCE_COMMIT="$(git -C /Users/mac/Documents/新项目/shensi-sales/.worktrees/agent-center-shell rev-parse HEAD)"
git clone --no-local --single-branch \
  --branch codex/real-financial-council \
  /Users/mac/Documents/新项目/shensi-sales \
  /Users/mac/Documents/新项目/shensi
cd /Users/mac/Documents/新项目/shensi
git branch -M main
git remote rename origin legacy-origin
git remote set-url --push legacy-origin disabled://legacy-origin
test "$(git rev-parse HEAD)" = "$SOURCE_COMMIT"
```

Expected: `main` points at the captured source commit; fetch remains available through `legacy-origin`, while pushes fail closed.

- [ ] **Step 3: Write the failing repository-layout test**

Create `tools/shensi-repository-layout.test.mjs`:

```js
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("shensi is the canonical standalone repository", () => {
  assert.equal(basename(root), "shensi");
  for (const path of [
    "frontend/package.json",
    "backend/package.json",
    "contracts/package.json",
    "docs/SOURCE_PROVENANCE.md"
  ]) assert.equal(existsSync(resolve(root, path)), true, path);
  assert.doesNotMatch(readFileSync(resolve(root, ".gitignore"), "utf8"), /!\.env\.production\.local/u);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run:

```bash
node --test tools/shensi-repository-layout.test.mjs
```

Expected: FAIL because `docs/SOURCE_PROVENANCE.md` does not exist.

- [ ] **Step 5: Add provenance and secret exclusions**

Use `apply_patch` to create `docs/SOURCE_PROVENANCE.md`. Set the source commit
line to the exact value from the source repository. Verify it with:

```bash
SOURCE_COMMIT="$(git -C /Users/mac/Documents/新项目/shensi-sales/.worktrees/agent-center-shell rev-parse HEAD)"
rg -F "$SOURCE_COMMIT" docs/SOURCE_PROVENANCE.md
```

The remaining content is fixed:

```markdown
# Source Provenance

- Imported from: `/Users/mac/Documents/新项目/shensi-sales`
- Source branch: `codex/real-financial-council`
- Imported at: `2026-08-24 Asia/Shanghai`
- Legacy GitHub repository: `https://github.com/kzhangmyang-cmyk/shensi-sales`

The legacy repository is a rollback and history source. New development,
deployment, status reporting, and AI instructions begin in this repository.
```

Append these exact exclusions to `.gitignore` if they are not already present:

```gitignore
.env.local
.env.production.local
backups/
*.sql
*.sql.enc
*.migration-manifest.json
deploy/secrets/
```

- [ ] **Step 6: Run the test and commit**

Run:

```bash
node --test tools/shensi-repository-layout.test.mjs
git diff --check
git add .gitignore docs/SOURCE_PROVENANCE.md tools/shensi-repository-layout.test.mjs
git commit -m "chore: establish canonical shensi repository"
```

Expected: PASS, then one commit in the destination repository.

---

### Task 2: Establish the AI-readable current-state documentation

**Files:**
- Create: `AGENTS.md`
- Rewrite: `README.md`
- Create: `docs/PROJECT_STATUS.md`
- Create: `docs/ARCHITECTURE.md`
- Create: `docs/API_INDEX.md`
- Create: `docs/DATA_MIGRATION.md`
- Create: `docs/DEPLOYMENT.md`
- Create: `docs/modules/acquisition.md`
- Create: `docs/modules/crm.md`
- Create: `docs/modules/financial-council.md`
- Create: `docs/modules/model-connections.md`
- Create: `docs/modules/identity-and-permissions.md`
- Create: `docs/archive/README.md`
- Create: `scripts/context-check`
- Create: `scripts/context-check.mjs`
- Create: `tools/context-check.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: current package scripts, release `1.0.12`, source provenance, and module entry points.
- Produces: deterministic reading order and a machine-checkable current-state contract for humans and coding agents.

- [ ] **Step 1: Write the failing context-check test**

Create `tools/context-check.test.mjs`:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("current agent context is complete and points at shensi", () => {
  const result = spawnSync(process.execPath, ["scripts/context-check.mjs"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /SHENSI_CONTEXT_OK/u);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test tools/context-check.test.mjs
```

Expected: FAIL with `MODULE_NOT_FOUND` for `scripts/context-check.mjs`.

- [ ] **Step 3: Implement the context checker**

Create executable `scripts/context-check`:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$ROOT/scripts/context-check.mjs"
```

Create `scripts/context-check.mjs`:

```js
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "AGENTS.md",
  "README.md",
  "docs/PROJECT_STATUS.md",
  "docs/ARCHITECTURE.md",
  "docs/API_INDEX.md",
  "docs/DATA_MIGRATION.md",
  "docs/DEPLOYMENT.md",
  "docs/SOURCE_PROVENANCE.md",
  "docs/modules/acquisition.md",
  "docs/modules/crm.md",
  "docs/modules/financial-council.md",
  "docs/modules/model-connections.md",
  "docs/modules/identity-and-permissions.md"
];
for (const relative of required) {
  if (!existsSync(resolve(root, relative))) throw new Error(`CONTEXT_FILE_MISSING:${relative}`);
}
const status = readFileSync(resolve(root, "docs/PROJECT_STATUS.md"), "utf8");
for (const heading of ["## Completed", "## Active", "## Blocked", "## Next"]) {
  if (!status.includes(heading)) throw new Error(`PROJECT_STATUS_SECTION_MISSING:${heading}`);
}
if (status.includes(".worktrees/agent-center-shell")) {
  throw new Error("PROJECT_STATUS_POINTS_TO_LEGACY_WORKTREE");
}
const contractManifest = JSON.parse(readFileSync(
  resolve(root, "contracts/releases/growth-advisor-quote-roi/1.0.12/manifest.json"),
  "utf8"
));
if (contractManifest.contractVersion !== "1.0.12") throw new Error("CONTRACT_RELEASE_DRIFT");
console.log("SHENSI_CONTEXT_OK");
```

- [ ] **Step 4: Write current documentation using a fixed template**

Write `AGENTS.md` with this reading order and rules:

```markdown
# Shensi Agent Instructions

## Required reading order
1. `README.md`
2. `docs/PROJECT_STATUS.md`
3. `docs/ARCHITECTURE.md`
4. The relevant file under `docs/modules/`
5. `docs/API_INDEX.md` for public-contract work
6. `docs/DATA_MIGRATION.md` or `docs/DEPLOYMENT.md` for operations

## Current authority
- Work only from this repository.
- `docs/PROJECT_STATUS.md` is the sole current progress ledger.
- `docs/archive/` and `docs/superpowers/` are historical context, not execution authority.
- Do not invent frontend DTOs; use generated types from `contracts/`.

## Safety
- Never print, commit, or copy secrets into tracked files.
- Never overwrite the source database during migration.
- Preserve unrelated user changes.
- Use `apply_patch` for source edits and run the documented focused and aggregate gates.

## Required finish gates
- `./scripts/context-check`
- `pnpm test`
- `pnpm build`
- `git diff --check`
- Relevant deployment or migration verification when those surfaces change.

## Documentation synchronization
Behavior, contracts, data structures, interactions, deployment, and module
responsibilities must update their current documentation in the same change.
```

Each `docs/modules/*.md` file must contain these exact headings:

```markdown
# Module Name
## Responsibility
## Entry Points
## Dependencies
## Database Tables
## Public Interfaces
## Tests
## Operational Checks
## Known Limitations
```

Populate each section from actual `rg` and package-script evidence; do not copy historical completion claims without a current test command.

- [ ] **Step 5: Move completed historical plans out of the current reading path**

Preserve the current Shensi design and implementation plan under
`docs/superpowers/` while they are executing. Move every other tracked file
under `docs/superpowers/specs/` and `docs/superpowers/plans/` to matching paths
under `docs/archive/superpowers/` using `git mv`. Add
`docs/archive/README.md` stating that archived documents are not execution
authority and pointing to `docs/PROJECT_STATUS.md`. Update tracked links found
by:

```bash
rg -n 'docs/superpowers/(specs|plans)/' --glob '*.md' --glob '!docs/archive/**'
```

Every remaining result must be either one of the two executing Shensi documents
or changed to its archived path.

- [ ] **Step 6: Add the package entry and verify**

Add to the root `package.json` scripts:

```json
"check:context": "node scripts/context-check.mjs"
```

Run:

```bash
chmod +x scripts/context-check
node --test tools/context-check.test.mjs
./scripts/context-check
pnpm check:context
git diff --check
```

Expected: all commands pass and print `SHENSI_CONTEXT_OK`.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md README.md docs package.json scripts/context-check scripts/context-check.mjs tools/context-check.test.mjs
git commit -m "docs: make shensi legible to coding agents"
```

---

### Task 3: Replace the obsolete login with the Shensi enterprise login

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/src/app-shell.css`
- Modify: `frontend/src/app-session.ts`
- Modify: `frontend/src/app-session.self-test.ts`
- Create: `frontend/tests/shensi-login.spec.ts`
- Modify: `frontend/README.md`

**Interfaces:**
- Consumes: existing `/api/auth/login`, `/api/auth/me`, `/api/auth/logout`, `gj_session`, and `gj_csrf` behavior.
- Produces: accessible dark Shensi login, safe loading/error/session states, and zero default credentials.

- [ ] **Step 1: Add failing session-state tests**

Extend `frontend/src/app-session.self-test.ts` with a deferred login request and these assertions:

```ts
const pending = Promise.withResolvers<Response>();
const controller = createAppSessionController({
  document,
  location,
  storage,
  fetchImpl: async () => pending.promise
});
const login = controller.login("owner@example.com", "correct-password");
assert.equal(document.querySelector<HTMLButtonElement>("#loginButton")?.disabled, true);
assert.equal(document.querySelector("#loginForm")?.getAttribute("aria-busy"), "true");
pending.resolve(new Response(JSON.stringify({ user: admin }), {
  status: 200,
  headers: { "content-type": "application/json" }
}));
await login;
assert.equal(document.querySelector<HTMLButtonElement>("#loginButton")?.disabled, false);
assert.equal(document.querySelector("#loginForm")?.getAttribute("aria-busy"), "false");
```

Add static assertions that `frontend/index.html` contains `Shensi` and contains neither `value="admin@goodjob.com"` nor `value="goodjob123"`.

- [ ] **Step 2: Run focused tests to verify failure**

Run:

```bash
frontend/node_modules/.bin/tsx frontend/src/app-session.self-test.ts
```

Expected: FAIL because the current form has no busy state and still contains default credentials.

- [ ] **Step 3: Implement the login markup and state contract**

Replace only the login section in `frontend/index.html` with semantic markup shaped as follows:

```html
<section class="login-screen shensi-login" aria-label="Shensi 登录">
  <div class="shensi-login-story">
    <a class="shensi-login-brand" href="#" aria-label="Shensi 首页">
      <span class="shensi-login-mark" aria-hidden="true">S</span>
      <span><strong>Shensi</strong><small>多智能体增长与经营系统</small></span>
    </a>
    <p class="shensi-login-kicker">AI OPERATING SYSTEM FOR GROWTH</p>
    <h1>让获客、成交与财务决策，在同一个智能体系统里协作。</h1>
    <p>真实数据、明确权限、完整审计。每一步自动化都保留人工批准边界。</p>
    <ul class="shensi-login-capabilities" aria-label="系统能力">
      <li>自动获客</li><li>客户经营</li><li>财务委员会</li><li>模型路由</li>
    </ul>
  </div>
  <div class="shensi-login-panel">
    <form id="loginForm" aria-busy="false">
      <p class="shensi-login-eyebrow">SECURE WORKSPACE</p>
      <h2>登录 Shensi</h2>
      <p>使用管理员分配的企业账号进入工作区。</p>
      <label class="login-field" for="loginEmail"><span>账号</span>
        <input id="loginEmail" name="email" type="email" autocomplete="username" required>
      </label>
      <label class="login-field" for="loginPassword"><span>密码</span>
        <input id="loginPassword" name="password" type="password" autocomplete="current-password" required>
      </label>
      <button type="submit" id="loginButton">登录工作台</button>
      <p class="login-error" id="loginError" role="status" aria-live="polite"></p>
    </form>
  </div>
</section>
```

In `app-session.ts`, bind the form `submit` event, set `aria-busy`, disable the button while the current generation is pending, and restore controls only when the same generation completes. Keep the existing safe Chinese error messages and generation fence.

- [ ] **Step 4: Implement responsive dark styling**

Replace the old login-only rules in `app-shell.css` with Shensi tokens and ensure:

```css
.shensi-login { background: #050806; color: #f4f7f4; }
.shensi-login-panel { background: rgba(13, 18, 15, .92); border: 1px solid rgba(120, 255, 154, .16); }
.shensi-login input { color: #f4f7f4; background: rgba(255,255,255,.04); }
.shensi-login button { min-height: 46px; background: linear-gradient(135deg,#79ff98,#39d967); }
@media (max-width: 760px) {
  .shensi-login { grid-template-columns: 1fr; }
  .shensi-login-story { padding: 32px 22px 12px; }
  .shensi-login-panel { margin: 12px 16px 28px; }
}
```

Do not hide focus outlines. Do not style any authenticated shell selector in this file.

- [ ] **Step 5: Add the browser test**

Create `frontend/tests/shensi-login.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("Shensi login is the only unauthenticated shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Shensi 登录" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "登录 Shensi" })).toBeVisible();
  await expect(page.locator(".replica-shell")).toBeHidden();
  await expect(page.locator("#loginEmail")).toHaveValue("");
  await expect(page.locator("#loginPassword")).toHaveValue("");
  await expect(page.getByText("GoodJob 自动营销系统")).toHaveCount(0);
  for (const width of [390, 1024, 1366, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
```

- [ ] **Step 6: Run focused and aggregate frontend gates**

Run:

```bash
frontend/node_modules/.bin/tsx frontend/src/app-session.self-test.ts
frontend/node_modules/.bin/playwright test frontend/tests/shensi-login.spec.ts --project=chromium
frontend/node_modules/.bin/tsx frontend/src/self-test.ts
frontend/node_modules/.bin/tsc -p frontend/tsconfig.json --noEmit
(cd frontend && ./node_modules/.bin/vite build)
git diff --check
```

Expected: all pass; only the existing large-chunk advisory may remain.

- [ ] **Step 7: Update documentation and commit**

Update `frontend/README.md` to state that real mode starts at the Shensi login, has no baked-in credentials, and restores only server-validated sessions.

```bash
git add frontend/index.html frontend/src/app-shell.css frontend/src/app-session.ts frontend/src/app-session.self-test.ts frontend/tests/shensi-login.spec.ts frontend/README.md
git commit -m "feat(frontend): replace legacy login with shensi workspace"
```

---

### Task 4: Add production Docker Compose deployment

**Files:**
- Create: `.dockerignore`
- Create: `deploy/compose.yaml`
- Create: `deploy/docker/backend.Dockerfile`
- Create: `deploy/docker/frontend.Dockerfile`
- Create: `deploy/nginx/default.conf`
- Create: `tools/deployment-contract.test.mjs`
- Modify: `.env.example`
- Modify: `docs/DEPLOYMENT.md`

**Interfaces:**
- Consumes: root pnpm workspace, backend `dist/server.js`, frontend `dist/`, `/api/health`, and production environment variables.
- Produces: `mysql`, `backend`, `frontend`, and `gateway` services on an internal network with one public HTTP port.

- [ ] **Step 1: Write the failing deployment contract test**

Create `tools/deployment-contract.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("compose has four isolated production services", () => {
  const compose = read("deploy/compose.yaml");
  for (const service of ["mysql:", "backend:", "frontend:", "gateway:"]) {
    assert.match(compose, new RegExp(`\\n  ${service}`));
  }
  assert.match(compose, /CRM_STORE: mysql/u);
  assert.match(compose, /NODE_ENV: production/u);
  assert.doesNotMatch(compose, /goodjob123|sk-[a-zA-Z0-9]/u);
});

test("runtime images are non-root and pinned", () => {
  const backend = read("deploy/docker/backend.Dockerfile");
  const frontend = read("deploy/docker/frontend.Dockerfile");
  assert.match(backend, /FROM node:22\.22\.3-bookworm-slim/u);
  assert.match(backend, /USER node/u);
  assert.match(frontend, /nginxinc\/nginx-unprivileged:1\.27-alpine/u);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --test tools/deployment-contract.test.mjs
```

Expected: FAIL because `deploy/compose.yaml` is absent.

- [ ] **Step 3: Add multi-stage images**

Create `deploy/docker/backend.Dockerfile`:

```dockerfile
FROM node:22.22.3-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY contracts/package.json contracts/package.json
RUN pnpm install --frozen-lockfile
COPY backend backend
COPY contracts contracts
RUN pnpm --filter ./contracts check:types && pnpm --filter ./backend build

FROM node:22.22.3-bookworm-slim AS runtime
ENV NODE_ENV=production CRM_STORE=mysql
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend/node_modules ./backend/node_modules
COPY --from=build --chown=node:node /app/backend/package.json ./backend/package.json
COPY --from=build --chown=node:node /app/backend/dist ./backend/dist
COPY --from=build --chown=node:node /app/contracts ./contracts
USER node
EXPOSE 4188
CMD ["node", "backend/dist/server.js"]
```

Create `deploy/docker/frontend.Dockerfile`:

```dockerfile
FROM node:22.22.3-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY contracts/package.json contracts/package.json
RUN pnpm install --frozen-lockfile
COPY frontend frontend
COPY contracts contracts
RUN pnpm --filter ./frontend build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 8080
```

Create `.dockerignore` excluding `.git`, `.env*`, `backups`, `node_modules`, `dist`, test output, and `.worktrees` while allowing `.env.example`.

- [ ] **Step 4: Add Compose and gateway configuration**

Create `deploy/compose.yaml` with these stable service boundaries:

```yaml
name: shensi
services:
  mysql:
    image: mysql:8.4.11
    environment:
      MYSQL_DATABASE: shensi
      MYSQL_USER: shensi_app
      MYSQL_PASSWORD_FILE: /run/secrets/mysql_app_password
      MYSQL_ROOT_PASSWORD_FILE: /run/secrets/mysql_root_password
    secrets: [mysql_app_password, mysql_root_password]
    volumes: [shensi_mysql:/var/lib/mysql]
    networks: [shensi_internal]
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -p$$(cat /run/secrets/mysql_root_password) --silent"]
      interval: 5s
      timeout: 5s
      retries: 30
  backend:
    build:
      context: ..
      dockerfile: deploy/docker/backend.Dockerfile
    env_file: ../.env.production.local
    environment:
      NODE_ENV: production
      CRM_STORE: mysql
      BACKEND_HOST: 0.0.0.0
      PORT: 4188
    depends_on:
      mysql: { condition: service_healthy }
    networks: [shensi_internal]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:4188/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 20
  frontend:
    build:
      context: ..
      dockerfile: deploy/docker/frontend.Dockerfile
    networks: [shensi_internal]
  gateway:
    image: nginxinc/nginx-unprivileged:1.27-alpine
    ports: ["${SHENSI_HTTP_PORT:-8080}:8080"]
    volumes:
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      backend: { condition: service_healthy }
      frontend: { condition: service_started }
    networks: [shensi_internal]
secrets:
  mysql_app_password: { file: ./secrets/mysql_app_password }
  mysql_root_password: { file: ./secrets/mysql_root_password }
volumes:
  shensi_mysql:
networks:
  shensi_internal:
    internal: true
```

`.env.production.local` must contain a URL-encoded `DATABASE_URL` whose host is
`mysql`, port is `3306`, database is `shensi`, and password matches the
`mysql_app_password` secret. Do not weaken password characters to work around
URL encoding.

Create `deploy/nginx/default.conf` with `listen 8080`, `/api/` proxying to `http://backend:4188`, `/` proxying to `http://frontend:8080`, `client_max_body_size 12m`, `X-Content-Type-Options nosniff`, `Referrer-Policy same-origin`, forwarded host/proto headers, and a local `/healthz` response.

- [ ] **Step 5: Validate deployment artifacts**

Run:

```bash
node --test tools/deployment-contract.test.mjs
docker compose -f deploy/compose.yaml --env-file .env.example config --quiet
docker build -f deploy/docker/backend.Dockerfile -t shensi-backend:local .
docker build -f deploy/docker/frontend.Dockerfile -t shensi-frontend:local .
git diff --check
```

Expected: all pass. If Docker is not installed, record that exact environment blocker in `docs/PROJECT_STATUS.md`; static tests and application builds still must pass, but do not claim the container gate passed.

- [ ] **Step 6: Document and commit**

Document prerequisites, secret-file creation, ports, health checks, backup-before-upgrade, deployment, logs, stop, and rollback in `docs/DEPLOYMENT.md`.

```bash
git add .dockerignore .env.example deploy docs/DEPLOYMENT.md tools/deployment-contract.test.mjs
git commit -m "feat(deploy): add shensi compose deployment"
```

---

### Task 5: Add canonical local and production command wrappers

**Files:**
- Create: `scripts/dev`
- Create: `scripts/dev.mjs`
- Create: `scripts/deploy`
- Create: `scripts/deploy.mjs`
- Create: `scripts/verify`
- Create: `scripts/verify.mjs`
- Create: `tools/runtime-scripts.test.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: `.env.local`, `.env.production.local`, root pnpm scripts, Compose, and `/api/health`.
- Produces: one local command, one production command, and one verification command with fail-closed port and environment validation.

- [ ] **Step 1: Write failing script tests**

Create `tools/runtime-scripts.test.mjs` that imports pure exports from the `.mjs` files:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { requiredLocalVariables, validatePorts } from "../scripts/dev.mjs";
import { requiredProductionVariables } from "../scripts/deploy.mjs";

test("local runtime requires real MySQL and security keys", () => {
  assert.deepEqual(requiredLocalVariables, [
    "DATABASE_URL", "JWT_SECRET", "PROVIDER_CREDENTIAL_KEY",
    "AGENT_JOB_ENCRYPTION_KEY", "ACQUISITION_MASTER_SECRET"
  ]);
});

test("ports must be distinct and valid", () => {
  assert.throws(() => validatePorts({ backend: 5191, frontend: 5191 }), /PORT_CONFLICT/u);
  assert.doesNotThrow(() => validatePorts({ backend: 4191, frontend: 5191 }));
});

test("production adds secure-cookie and database requirements", () => {
  assert.equal(requiredProductionVariables.includes("SESSION_COOKIE_SECURE"), true);
  assert.equal(requiredProductionVariables.includes("SHENSI_MYSQL_APP_PASSWORD"), true);
});
```

- [ ] **Step 2: Run the test to verify failure**

Run `node --test tools/runtime-scripts.test.mjs`.

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement wrappers and pure validation**

Each extensionless wrapper uses strict shell mode and executes its `.mjs` peer from the resolved repository root. `dev.mjs` must:

- read `.env.local` without logging values;
- require the five variables asserted above;
- default to backend `4191` and frontend `5191`;
- check both ports before spawning anything;
- spawn backend with `CRM_STORE=mysql` and frontend with `VITE_API_TARGET=http://127.0.0.1:4191`;
- forward `SIGINT`/`SIGTERM` and wait for both children.

`deploy.mjs` must:

- require `.env.production.local` mode `0600` on POSIX;
- require production security variables and secret files;
- run `docker compose config --quiet`, `build`, `up -d`, then bounded health polling;
- print only service names, states, and public origin.

`verify.mjs` must run context check, contract tests, backend build, frontend tests/types/build, and health requests without printing environment values.

- [ ] **Step 4: Add package aliases and verify**

Add to `package.json`:

```json
"dev:shensi": "node --env-file-if-exists=.env.local scripts/dev.mjs",
"deploy:shensi": "node --env-file-if-exists=.env.production.local scripts/deploy.mjs",
"verify:shensi": "node scripts/verify.mjs"
```

Run:

```bash
chmod +x scripts/dev scripts/deploy scripts/verify
node --test tools/runtime-scripts.test.mjs
./scripts/context-check
git diff --check
```

- [ ] **Step 5: Update README and commit**

Make `README.md` lead with exactly these commands:

```bash
cp .env.example .env.local
./scripts/dev
./scripts/verify
```

and production:

```bash
cp .env.example .env.production.local
./scripts/deploy
```

Then commit:

```bash
git add README.md package.json scripts/dev scripts/dev.mjs scripts/deploy scripts/deploy.mjs scripts/verify scripts/verify.mjs tools/runtime-scripts.test.mjs
git commit -m "feat: add canonical shensi runtime commands"
```

---

### Task 6: Build encrypted backup, restore, and verification tooling

**Files:**
- Create: `scripts/lib/database-url.mjs`
- Create: `scripts/lib/process-pipeline.mjs`
- Create: `scripts/lib/migration-manifest.mjs`
- Create: `scripts/backup`
- Create: `scripts/backup.mjs`
- Create: `scripts/restore`
- Create: `scripts/restore.mjs`
- Create: `scripts/migrate-data`
- Create: `scripts/migrate-data.mjs`
- Create: `scripts/verify-data.mjs`
- Create: `tools/data-migration-scripts.test.mjs`
- Modify: `docs/DATA_MIGRATION.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `SOURCE_DATABASE_URL`, `TARGET_DATABASE_URL`, `SHENSI_BACKUP_PASSPHRASE`, MySQL 8.4 CLI tools, OpenSSL, and `mysql2/promise`.
- Produces: encrypted `*.sql.enc`, non-secret manifest, restored `shensi` database, and a closed verification report.

- [ ] **Step 1: Write failing pure-function tests**

Create `tools/data-migration-scripts.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { parseMysqlUrl, requireDistinctDatabases } from "../scripts/lib/database-url.mjs";
import { safeManifest } from "../scripts/lib/migration-manifest.mjs";

test("database URLs parse without leaking passwords", () => {
  const parsed = parseMysqlUrl("mysql://app:p%40ss@127.0.0.1:3307/shensi_sales");
  assert.deepEqual(parsed, {
    host: "127.0.0.1", port: 3307, user: "app",
    password: "p@ss", database: "shensi_sales"
  });
  assert.doesNotMatch(JSON.stringify(safeManifest(parsed)), /p@ss/u);
});

test("restore rejects the source database", () => {
  assert.throws(
    () => requireDistinctDatabases("shensi_sales", "shensi_sales"),
    /SOURCE_TARGET_DATABASE_MATCH/u
  );
  assert.doesNotThrow(() => requireDistinctDatabases("shensi_sales", "shensi"));
});
```

- [ ] **Step 2: Run the tests to verify failure**

Run `node --test tools/data-migration-scripts.test.mjs`.

Expected: FAIL because migration modules do not exist.

- [ ] **Step 3: Implement URL parsing and safe process pipelines**

`database-url.mjs` must accept only `mysql:` URLs, decode credentials, require a concrete database, and use this implementation:

```js
export function parseMysqlUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "mysql:") throw new Error("MYSQL_URL_PROTOCOL_INVALID");
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!url.hostname || !url.username || !database) throw new Error("MYSQL_URL_INCOMPLETE");
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database
  };
}
export function requireDistinctDatabases(source, target) {
  if (source === target) throw new Error("SOURCE_TARGET_DATABASE_MATCH");
}
export function mysqlCliEnvironment(parsed, baseEnv = process.env) {
  return { ...baseEnv, MYSQL_PWD: parsed.password };
}
```

`process-pipeline.mjs` must spawn explicit binary paths with argument arrays, connect stdout to stdin, reject on any non-zero exit, redact child environments from errors, and terminate both children on signals.

- [ ] **Step 4: Implement encrypted backup**

`backup.mjs` must resolve binaries from `MYSQLDUMP_BIN` and `OPENSSL_BIN`, defaulting to:

```text
/Users/mac/.local/mysql-8.4.11-macos15-arm64/bin/mysqldump
/usr/bin/openssl
```

The data pipeline is:

```text
mysqldump --single-transaction --routines --triggers --events
          --hex-blob --default-character-set=utf8mb4 --set-gtid-purged=OFF
          --host "$MYSQL_HOST" --port "$MYSQL_PORT" --user "$MYSQL_USER" "$SOURCE_DATABASE"
| openssl enc -aes-256-cbc -pbkdf2 -salt
          -pass env:SHENSI_BACKUP_PASSPHRASE
> "backups/${UTC_TIMESTAMP}-shensi_sales.sql.enc"
```

Use `fs.open` mode `0600`, never a shell string, and delete an incomplete output on failure. Write a manifest with encrypted-file SHA-256, source commit, MySQL version, source database, creation time, and per-table counts; omit passwords and full URLs.

- [ ] **Step 5: Implement restore and verification**

`restore.mjs` must require a target URL, reject a matching source database, require the target database to be empty or explicitly created by this migration, and stream:

```text
openssl enc -d -aes-256-cbc -pbkdf2
        -pass env:SHENSI_BACKUP_PASSPHRASE -in "$ENCRYPTED_BACKUP"
| mysql --host "$MYSQL_HOST" --port "$MYSQL_PORT" --user "$MYSQL_USER" "$TARGET_DATABASE"
```

`verify-data.mjs` must use `mysql2/promise` and compare:

- table set and per-table row counts;
- migration/schema metadata;
- user/workspace stable IDs;
- acquisition and financial council run IDs/statuses;
- model connection ID/provider/model/credential version/default state;
- a bounded sample of stored integrity hashes.

It writes a non-secret JSON report containing only counts, IDs explicitly classified as non-sensitive, hashes, and pass/fail codes.

- [ ] **Step 6: Implement the orchestrator and wrappers**

`migrate-data.mjs` runs preflight, backup, target creation through `MYSQL_LOCAL_ADMIN_URL`, restore, and verification. It never drops a database. The wrappers execute their `.mjs` peers with strict shell mode.

Run:

```bash
chmod +x scripts/backup scripts/restore scripts/migrate-data
node --test tools/data-migration-scripts.test.mjs
git diff --check
```

- [ ] **Step 7: Document and commit**

`docs/DATA_MIGRATION.md` must contain exact prerequisites, environment names, backup, restore, verify, rollback, retention, and incident steps. It must say that encrypted provider rows are unusable without the original encryption keys.

```bash
git add .gitignore docs/DATA_MIGRATION.md scripts/backup scripts/backup.mjs scripts/restore scripts/restore.mjs scripts/migrate-data scripts/migrate-data.mjs scripts/verify-data.mjs scripts/lib tools/data-migration-scripts.test.mjs
git commit -m "feat(data): add encrypted shensi migration tooling"
```

---

### Task 7: Execute the live data migration into a new database

**Files:**
- Create untracked: `.env.production.local`
- Create untracked: `backups/*-shensi_sales.sql.enc`
- Create untracked: `backups/*-shensi_sales.migration-manifest.json`
- Create: `docs/migration/2026-08-24-live-migration-verification.md`
- Modify: `docs/PROJECT_STATUS.md`

**Interfaces:**
- Consumes: current live `shensi_sales` database and the source runtime's Git-ignored encryption keys.
- Produces: distinct `shensi` database, verified data identities, working encrypted DeepSeek credential, and a non-secret evidence report.

- [ ] **Step 1: Preflight the live source without printing secrets**

Run from the new repository:

```bash
test -f /Users/mac/Documents/新项目/shensi-sales/.worktrees/agent-center-shell/.env.real.local
install -m 600 /Users/mac/Documents/新项目/shensi-sales/.worktrees/agent-center-shell/.env.real.local .env.production.local
test "$(stat -f '%Lp' .env.production.local)" = "600"
git check-ignore .env.production.local backups/probe.sql.enc
```

Use a secret-safe editor to add `SOURCE_DATABASE_URL` with the old
`shensi_sales` URL, `TARGET_DATABASE_URL` with the new `shensi` URL, and set the
runtime `DATABASE_URL` to the same target URL. Set `PORT=4192` and
`BACKEND_HOST=127.0.0.1`. Do not display the file with `cat`, `sed`, shell
tracing, or tool output.

- [ ] **Step 2: Capture a source database inventory**

Run the verifier in inventory mode:

```bash
node --env-file=.env.production.local scripts/verify-data.mjs \
  --source-env SOURCE_DATABASE_URL \
  --inventory-only \
  --output backups/source-inventory.json
```

Expected: a non-secret count/hash report and zero credential material.

- [ ] **Step 3: Create the encrypted backup**

```bash
node --env-file=.env.production.local scripts/backup.mjs \
  --source-env SOURCE_DATABASE_URL \
  --output-dir backups
```

Expected: one `0600` encrypted dump and one manifest; `openssl enc -d` with an incorrect passphrase fails.

- [ ] **Step 4: Restore into the distinct target**

Set `TARGET_DATABASE_URL` to database `shensi` and run:

```bash
node --env-file=.env.production.local scripts/migrate-data.mjs \
  --source-env SOURCE_DATABASE_URL \
  --target-env TARGET_DATABASE_URL \
  --target-database shensi
```

Expected: source database remains unchanged, target is populated, and the data verifier passes.

- [ ] **Step 5: Start the new backend on an isolated port**

```bash
node --env-file=.env.production.local backend/dist/server.js
```

Run it in a managed terminal session and verify:

```bash
curl --fail --silent http://127.0.0.1:4192/api/health
```

Expected JSON includes `"ok":true` and `"store":"mysql"`.

- [ ] **Step 6: Verify login and restored DeepSeek credential**

Use a bounded Node HTTP verifier that:

1. logs in with credentials supplied through environment variables;
2. captures CSRF/session cookies in memory;
3. lists `/api/v1/ai/connections`;
4. finds the restored `deepseek-v4-pro` connection;
5. calls `POST /api/tools/ai-config/test` with its ID;
6. asserts a successful health result;
7. prints only connection ID, provider, model, credential version, duration, and pass/fail.

The verifier must never print request headers, cookie values, API keys, raw provider bodies, or `.env.production.local`.

- [ ] **Step 7: Write non-secret migration evidence and commit**

Create `docs/migration/2026-08-24-live-migration-verification.md` with source/target database names, backup SHA-256, source/target counts, stable-ID results, health results, model identity, and explicit secret/residue audit. Do not include credentials or customer rows.

Update `docs/PROJECT_STATUS.md`: data migration moves to Completed only if every gate passed; otherwise place the precise blocker under Blocked.

```bash
git status --short
git check-ignore .env.production.local backups/*.sql.enc
git grep -nE 'sk-[A-Za-z0-9]{20,}|mysql://[^:]+:[^@]+@' -- . ':!*.example'
git add docs/migration/2026-08-24-live-migration-verification.md docs/PROJECT_STATUS.md
git commit -m "docs(data): record verified shensi migration"
```

Expected: secret grep returns no tracked secret; only documentation is committed.

---

### Task 8: Run full acceptance and cut over to Shensi

**Files:**
- Create: `frontend/tests/shensi-cutover.spec.ts`
- Modify: `docs/PROJECT_STATUS.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify after user acceptance only: `/Users/mac/Documents/新项目/shensi-sales/LEGACY_READ_ONLY.md`

**Interfaces:**
- Consumes: restored `shensi` database, new login, deployment stack, and verified source/target reports.
- Produces: accepted Shensi origin, stopped legacy user-facing frontend, and explicit legacy rollback marker.

- [ ] **Step 1: Add the real cutover browser test**

Create `frontend/tests/shensi-cutover.spec.ts` without request interception:

```ts
import { expect, test } from "@playwright/test";

test("restored Shensi runtime reaches the current acquisition application", async ({ page }) => {
  await page.goto(process.env.SHENSI_TEST_ORIGIN ?? "http://127.0.0.1:5192/");
  await expect(page.getByRole("heading", { name: "登录 Shensi" })).toBeVisible();
  await page.locator("#loginEmail").fill(process.env.SHENSI_TEST_EMAIL ?? "");
  await page.locator("#loginPassword").fill(process.env.SHENSI_TEST_PASSWORD ?? "");
  await page.locator("#loginButton").click();
  await expect(page.locator(".replica-shell")).toBeVisible();
  await page.goto(`${process.env.SHENSI_TEST_ORIGIN ?? "http://127.0.0.1:5192/"}#acquisition`);
  await expect(page.getByRole("heading", { name: "启动抖音自动获客" })).toBeVisible();
  await expect(page.locator(".shell")).toHaveCount(0);
});
```

- [ ] **Step 2: Start the new frontend against the isolated backend**

Run frontend at `5192` with `VITE_API_TARGET=http://127.0.0.1:4192`. Run the browser test with credentials supplied only in the process environment.

Expected: new login, authenticated card shell, automatic-acquisition entry, and no legacy shell.

- [ ] **Step 3: Run all source and deployment gates**

Run from `/Users/mac/Documents/新项目/shensi`:

```bash
./scripts/context-check
node --test tools/shensi-repository-layout.test.mjs tools/context-check.test.mjs tools/deployment-contract.test.mjs tools/runtime-scripts.test.mjs tools/data-migration-scripts.test.mjs
pnpm test:contracts
pnpm --filter ./backend test:financial-statements
pnpm --filter ./backend test:financial-council
pnpm --filter ./backend build
pnpm --filter ./frontend test
pnpm --filter ./frontend test:types
pnpm --filter ./frontend build
docker compose -f deploy/compose.yaml --env-file .env.production.local config --quiet
git diff --check
git status --short
```

Expected: no failures, no unexpected skips, clean tracked worktree. Environment-dependent live provider gates must be reported separately and never converted to fake passes.

- [ ] **Step 4: Present the isolated origin for user acceptance**

Open `http://127.0.0.1:5192/` for the user. Do not stop `5191` or modify the legacy repository yet. Obtain explicit user confirmation that the new login and current application are correct.

- [ ] **Step 5: Switch the user-facing local origin after approval**

After approval, stop only the exact processes listening on the old `5191` frontend and its paired legacy backend. Start the Shensi frontend/backend on the documented canonical ports or update the reverse proxy. Validate process working directories with `lsof` before termination.

Run the same no-intercept browser smoke at the final origin.

- [ ] **Step 6: Mark the legacy repository read-only**

Only after successful cutover, create `/Users/mac/Documents/新项目/shensi-sales/LEGACY_READ_ONLY.md`:

```markdown
# Legacy Read-only Repository

Current development and deployment moved to:
`/Users/mac/Documents/新项目/shensi`

This repository is retained only for rollback and historical Git provenance.
Do not start services or make new product changes here.
```

Do not delete the old repository or source database.

- [ ] **Step 7: Finalize current status and commit**

Update `docs/PROJECT_STATUS.md` with exact final origins, target database,
verification commands, completed migration evidence, known external-provider
blockers, and the next product task. Update `docs/DEPLOYMENT.md` to reflect the
actual canonical ports and cutover procedure.

```bash
git add frontend/tests/shensi-cutover.spec.ts docs/PROJECT_STATUS.md docs/DEPLOYMENT.md
git commit -m "test: verify shensi production cutover"
git status --short
```

Expected: clean new repository, current docs, final origin serving Shensi, and legacy assets retained only for rollback.

- [ ] **Step 8: Archive the completed Shensi design and plan**

After the final status commit and only when `docs/PROJECT_STATUS.md` records the
implementation as completed, move the two executing documents into the archive:

```bash
mkdir -p docs/archive/superpowers/specs docs/archive/superpowers/plans
git mv docs/superpowers/specs/2026-08-24-shensi-clean-repository-design.md docs/archive/superpowers/specs/
git mv docs/superpowers/plans/2026-08-24-shensi-clean-repository.md docs/archive/superpowers/plans/
git add docs/PROJECT_STATUS.md docs/archive
git commit -m "docs: archive completed shensi migration plan"
```

Update current links to the archived paths before committing and run
`./scripts/context-check` again.

---

## Plan Self-Review Checklist

- [x] Every spec goal maps to at least one task.
- [x] The new repository is created before any destination edits.
- [x] Login, deployment, data migration, AI context, and cutover each have a real RED/GREEN or preflight/verification gate.
- [x] Source and target databases cannot match.
- [x] No step commits or prints secrets, dumps, customer rows, or encryption keys.
- [x] DeepSeek is verified from the restored encrypted record.
- [x] The old repository and database remain available for rollback.
- [x] User acceptance occurs before the old local origin is stopped.
- [x] Current documentation is updated at each behavior/operations boundary.

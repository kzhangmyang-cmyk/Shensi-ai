import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { execFile as nativeExecFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createSourceContentManifest } from "./source-content-manifest.mjs";

const execFile = promisify(nativeExecFile);
const DESKTOP_REQUIRED = [
  'desktop/enterprise-bridge/extension/capture.js',
  "desktop/scripts/dev.mjs", "desktop/scripts/prepare-dev-build-identity.mjs", "scripts/source-content-manifest.mjs",
  "frontend/package.json", "frontend/index.html", "frontend/admin.html", "frontend/ui-kit.html", "frontend/vite.config.ts", "frontend/tsconfig.json",
  "frontend/contracts/pinned/growth-advisor-quote-roi.manifest.json", "desktop/package.json", "desktop/shensi-sidecar.spec",
  "desktop/electron-builder.yml", "desktop/electron-builder.release.yml", "desktop/tsconfig.json", "desktop/tsconfig.build.json",
  "desktop/build/entitlements.mac.empty.plist", "desktop/build/entitlements.mac.plist", "desktop/build/icon-approval.json", "desktop/build/icon-source.png",
  ...["package-macos.sh", "build-preload.mjs", "build-sidecar.mjs", "build-sidecar.sh", "frozen-sidecar-entrypoint.py", "generate-macos-icon.mjs", "check-package-environment.mjs", "write-runtime-config.mjs", "release-policy.mjs", "package-content-policy.mjs", "macos-entitlements-policy.mjs", "macos-signature-policy.mjs", "macos-release-sign.mjs", "macos-release-hooks.mjs", "verify-desktop-renderer.mjs", "verify-package.mjs", "verify-macos-artifacts.sh"].map((name) => `desktop/scripts/${name}`),
  "services/media-crawler/pyproject.toml", "services/media-crawler/uv.lock", "services/media-crawler/var.py", "services/media-crawler/LICENSE",
  "services/media-crawler/libs/stealth.min.js", "services/media-crawler/libs/douyin.js", "services/media-crawler/config/__init__.py",
  "services/media-crawler/config/base_config.py", "services/media-crawler/config/db_config.py",
  ...["bilibili_config.py", "xhs_config.py", "dy_config.py", "ks_config.py", "weibo_config.py", "tieba_config.py", "zhihu_config.py"].map((name) => `services/media-crawler/config/${name}`),
  "services/media-crawler/database/__init__.py", "services/media-crawler/database/db_session.py",
  "services/media-crawler/database/models.py", "services/media-crawler/database/mongodb_store_base.py",
  "services/media-crawler/model/__init__.py",
  "services/media-crawler/model/m_douyin.py", "services/media-crawler/store/__init__.py", "services/media-crawler/media_platform/__init__.py",
  "services/media-crawler/shensi_adapter/vendor/douyin_spider/utils/mstoken_profile.json",
  "services/media-crawler/shensi_adapter/vendor/douyin_spider/utils/mstoken_common_profile.json"
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "shensi-manifest-"));
  for (const name of ["backend/src", "contracts", "frontend/src/generated", "desktop/src/generated", "deploy/nginx", "deploy/docker", "scripts"]) await mkdir(join(root, name), { recursive: true });
  for (const [name, body] of Object.entries({
    "package.json": "{}", "pnpm-lock.yaml": "lock", "pnpm-workspace.yaml": "packages: []",
    "backend/package.json": "{}", "backend/src/server.ts": "export {}", "contracts/package.json": "{}",
    "contracts/schema.ts": "export {}", "frontend/package.json": "{}", "frontend/src/app.ts": "export {}", "frontend/src/generated/ai-acquisition.ts": "export {}", "frontend/src/generated/decision-simulation.ts": "export {}",
    "desktop/package.json": "{}", "desktop/src/main.ts": "export {}", "desktop/src/generated/ai-acquisition.d.ts": "export {}", "deploy/compose.api-only.yaml": "services: {}",
    ".dockerignore": "node_modules", "deploy/docker/backend.Dockerfile": "COPY frontend/package.json frontend/package.json", "deploy/nginx/api-only.conf": "server {}", "scripts/container-runtime.mjs": "export {}", "scripts/source-content-manifest.mjs": "export {}"
  })) await writeFile(join(root, name), body);
  for (const path of DESKTOP_REQUIRED) {
    await mkdir(join(root, path, ".."), { recursive: true });
    try { await writeFile(join(root, path), "required", { flag: "wx" }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
  }
  return root;
}

async function writeFixtureFiles(root, files) {
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), body);
  }
}

test("backend-runtime hashes sorted regular Docker inputs including an untracked source file", async () => {
  const root = await fixture();
  await writeFile(join(root, "backend/src/untracked.ts"), "new input");
  const manifest = await createSourceContentManifest(root, "backend-runtime");
  assert.deepEqual(manifest.records.map((record) => record.path), [...manifest.records.map((record) => record.path)].sort());
  assert.equal(manifest.records.some((record) => record.path === "backend/src/untracked.ts"), true);
  assert.match(manifest.rootHash, /^[a-f0-9]{64}$/u);
});

test("backend-runtime exactly binds Docker COPY controls including frontend contract output and Docker ignore", async () => {
  const root = await fixture();
  await mkdir(join(root, "deploy/docker"), { recursive: true });
  await writeFile(join(root, "frontend/package.json"), '{"name":"renderer"}');
  await writeFile(join(root, "deploy/docker/backend.Dockerfile"), "COPY frontend/package.json frontend/package.json");
  await writeFile(join(root, ".dockerignore"), "node_modules");
  const before = await createSourceContentManifest(root, "backend-runtime");
  assert.deepEqual(before.records.map(({ path }) => path).filter((path) => ["frontend/package.json", "frontend/src/generated/ai-acquisition.ts", "desktop/src/generated/ai-acquisition.d.ts", "deploy/docker/backend.Dockerfile", ".dockerignore"].includes(path)).sort(), [".dockerignore", "deploy/docker/backend.Dockerfile", "desktop/src/generated/ai-acquisition.d.ts", "frontend/package.json", "frontend/src/generated/ai-acquisition.ts"]);
  await writeFile(join(root, "frontend/package.json"), '{"name":"renderer-v2"}');
  assert.notEqual((await createSourceContentManifest(root, "backend-runtime")).rootHash, before.rootHash);
});

test("backend-runtime record set exactly follows the current Docker COPY context plus API-only controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-backend-manifest-exact-"));
  await writeFixtureFiles(root, {
    "package.json": "{}",
    "pnpm-lock.yaml": "lock",
    "pnpm-workspace.yaml": "packages: []",
    ".dockerignore": "node_modules\ndist\n.runtime",
    "deploy/docker/backend.Dockerfile": "COPY backend backend",
    "deploy/compose.api-only.yaml": "services: {}",
    "deploy/nginx/api-only.conf": "server {}",
    "scripts/container-runtime.mjs": "export {}",
    "scripts/source-content-manifest.mjs": "export {}",
    "backend/package.json": "{}",
    "backend/tsconfig.json": "{}",
    "backend/src/server.ts": "export {}",
    "backend/src/new.ts": "export const untracked = true",
    "backend/src/server-test.ts": "test copied by Docker today",
    "contracts/package.json": "{}",
    "contracts/openapi/a.yaml": "openapi: 3.1.0",
    "frontend/package.json": "{}",
    "frontend/src/generated/ai-acquisition.ts": "export {}",
    "frontend/src/generated/decision-simulation.ts": "export {}",
    "desktop/src/generated/ai-acquisition.d.ts": "export {}",
    "backend/dist/server.js": "generated",
    "backend/node_modules/x.js": "generated",
    ".runtime/x": "state",
    ".env.local": "not-walked-secret"
  });
  const manifest = await createSourceContentManifest(root, "backend-runtime");
  assert.deepEqual(manifest.records.map(({ path }) => path), [
    ".dockerignore",
    "backend/package.json",
    "backend/src/new.ts",
    "backend/src/server-test.ts",
    "backend/src/server.ts",
    "backend/tsconfig.json",
    "contracts/openapi/a.yaml",
    "contracts/package.json",
    "deploy/compose.api-only.yaml",
    "deploy/docker/backend.Dockerfile",
    "deploy/nginx/api-only.conf",
    "desktop/src/generated/ai-acquisition.d.ts",
    "frontend/package.json",
    "frontend/src/generated/ai-acquisition.ts",
    "frontend/src/generated/decision-simulation.ts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/container-runtime.mjs",
    "scripts/source-content-manifest.mjs"
  ]);
  await writeFixtureFiles(root, { "backend/src/database-password.json": "forbidden" });
  await assert.rejects(() => createSourceContentManifest(root, "backend-runtime"), /MANIFEST_FORBIDDEN_INPUT/u);
});

test("manifest changes when a build input mode changes and rejects symlinks", async () => {
  const root = await fixture();
  const before = await createSourceContentManifest(root, "backend-runtime");
  await chmod(join(root, "backend/src/server.ts"), 0o755);
  const after = await createSourceContentManifest(root, "backend-runtime");
  assert.notEqual(before.rootHash, after.rootHash);
  await symlink("server.ts", join(root, "backend/src/link.ts"));
  await assert.rejects(() => createSourceContentManifest(root, "backend-runtime"), /MANIFEST_SYMLINK_FORBIDDEN/u);
});

test("desktop-app binds the admin entry and rejects its omission", async () => {
  const root = await fixture();
  const before = await createSourceContentManifest(root, "desktop-app");
  assert.ok(before.records.some(record => record.path === "frontend/admin.html"));
  await writeFile(join(root, "frontend/admin.html"), "<main>changed admin entry</main>");
  assert.notEqual((await createSourceContentManifest(root, "desktop-app")).rootHash, before.rootHash);
  await rm(join(root, "frontend/admin.html"));
  await assert.rejects(() => createSourceContentManifest(root, "desktop-app"), /MANIFEST_REQUIRED_INPUT_MISSING:frontend\/admin.html/u);
});

test("desktop-app excludes generated output and fails for an unclassified frontend-root input", async () => {
  const root = await fixture();
  await mkdir(join(root, "frontend/dist"), { recursive: true });
  await writeFile(join(root, "frontend/dist/generated.js"), "generated");
  const manifest = await createSourceContentManifest(root, "desktop-app");
  assert.equal(manifest.records.some((record) => record.path.includes("frontend/dist/")), false);
  await writeFile(join(root, "frontend/enterprise-preview.html"), "development-only preview");
  const previewManifest = await createSourceContentManifest(root, "desktop-app");
  assert.equal(previewManifest.records.some((record) => record.path === "frontend/enterprise-preview.html"), false);
  await mkdir(join(root, "desktop/enterprise-bridge"), { recursive: true });
  await writeFile(join(root, "desktop/enterprise-bridge/install.mjs"), "separate Chrome installer");
  const separate = await createSourceContentManifest(root, "desktop-app");
  assert.equal(separate.records.some(record => record.path === 'desktop/enterprise-bridge/install.mjs'), false);
  assert.equal(separate.records.some(record => record.path === 'desktop/enterprise-bridge/extension/capture.js'), true);
  await writeFile(join(root, "frontend/unclassified-input.ts"), "must classify");
  await assert.rejects(() => createSourceContentManifest(root, "desktop-app"), /MANIFEST_UNCLASSIFIED_FILE/u);
});

test("manifest CLI reports only scope, record count, and root hash", async () => {
  const root = await fixture();
  const script = fileURLToPath(new URL("./source-content-manifest.mjs", import.meta.url));
  const { stdout } = await execFile(process.execPath, [script, "backend-runtime"], { cwd: root });
  assert.match(stdout, /^SOURCE_CONTENT_MANIFEST scope=backend-runtime records=\d+ root=[a-f0-9]{64}\n$/u);
});

test("desktop-app binds renderer public assets and exact Sidecar source/lock/build inputs while excluding generated and rejecting Profiles/secrets", async () => {
  const root = await fixture();
  for (const directory of ["frontend/public", "frontend/browser-extension", "desktop/scripts", "desktop/resources/generated", "services/media-crawler/shensi_adapter", "services/media-crawler/tests"]) await mkdir(join(root, directory), { recursive: true });
  for (const [path, body] of Object.entries({
    "frontend/public/logo.svg": "public-v1", "frontend/browser-extension/manifest.json": "{}",
    "desktop/scripts/build-sidecar.mjs": "build", "desktop/shensi-sidecar.spec": "spec",
    "services/media-crawler/pyproject.toml": "[project]", "services/media-crawler/uv.lock": "lock",
    "services/media-crawler/shensi_adapter/app.py": "source", "services/media-crawler/tests/test_app.py": "test",
    "desktop/resources/generated/desktop-config.json": "generated"
  })) await writeFile(join(root, path), body);
  const before = await createSourceContentManifest(root, "desktop-app");
  assert.equal(before.records.some((record) => record.path === "frontend/public/logo.svg"), true);
  assert.equal(before.records.some((record) => record.path === "services/media-crawler/uv.lock"), true);
  assert.equal(before.records.some((record) => record.path.includes("resources/generated")), false);
  await writeFile(join(root, "services/media-crawler/shensi_adapter/untracked.py"), "untracked input");
  const after = await createSourceContentManifest(root, "desktop-app");
  assert.notEqual(after.rootHash, before.rootHash);
  await mkdir(join(root, "desktop/Profiles"));
  await assert.rejects(() => createSourceContentManifest(root, "desktop-app"), /MANIFEST_FORBIDDEN_INPUT/u);
});

test("desktop-app binds every reached cache, proxy, and database Sidecar module", async () => {
  const root = await fixture();
  const reached = [
    "services/media-crawler/cache/__init__.py", "services/media-crawler/cache/abs_cache.py",
    "services/media-crawler/cache/cache_factory.py", "services/media-crawler/cache/local_cache.py",
    "services/media-crawler/cache/redis_cache.py", "services/media-crawler/proxy/__init__.py",
    "services/media-crawler/proxy/base_proxy.py", "services/media-crawler/proxy/proxy_ip_pool.py",
    "services/media-crawler/proxy/proxy_mixin.py", "services/media-crawler/proxy/types.py",
    "services/media-crawler/proxy/providers/__init__.py", "services/media-crawler/proxy/providers/jishu_http_proxy.py",
    "services/media-crawler/proxy/providers/kuaidl_proxy.py", "services/media-crawler/proxy/providers/wandou_http_proxy.py",
    "services/media-crawler/database/__init__.py",
    "services/media-crawler/database/db_session.py", "services/media-crawler/database/models.py",
    "services/media-crawler/database/mongodb_store_base.py"
  ];
  await writeFixtureFiles(root, Object.fromEntries(reached.map((path) => [path, "input-v1"])));
  let previous = await createSourceContentManifest(root, "desktop-app");
  for (const path of reached) {
    assert.equal(previous.records.some((record) => record.path === path), true);
    await writeFile(join(root, path), "input-v2");
    const current = await createSourceContentManifest(root, "desktop-app");
    assert.notEqual(current.rootHash, previous.rootHash);
    previous = current;
  }
});

test("desktop-app exactly mirrors static config imports and excludes unreached database modules", async () => {
  const root = await fixture();
  const configModules = ["bilibili_config.py", "xhs_config.py", "dy_config.py", "ks_config.py", "weibo_config.py", "tieba_config.py", "zhihu_config.py"];
  await writeFixtureFiles(root, {
    "services/media-crawler/config/__init__.py": "from .base_config import *\nfrom .db_config import *\n",
    "services/media-crawler/config/base_config.py": configModules.map((name) => `from .${name.slice(0, -3)} import *`).join("\n"),
    ...Object.fromEntries(configModules.map((name) => [`services/media-crawler/config/${name}`, `${name}=1`])),
    "services/media-crawler/database/__init__.py": "",
    "services/media-crawler/database/db_session.py": "SESSION = 1",
    "services/media-crawler/database/models.py": "MODELS = 1",
    "services/media-crawler/database/mongodb_store_base.py": "MONGO = 1",
    "services/media-crawler/database/db.py": "UNREACHED = 1"
  });
  let manifest = await createSourceContentManifest(root, "desktop-app");
  assert.deepEqual(manifest.records.map(({ path }) => path).filter((path) => path.startsWith("services/media-crawler/config/") || path.startsWith("services/media-crawler/database/")), [
    "services/media-crawler/config/__init__.py",
    "services/media-crawler/config/base_config.py",
    "services/media-crawler/config/bilibili_config.py",
    "services/media-crawler/config/db_config.py",
    "services/media-crawler/config/dy_config.py",
    "services/media-crawler/config/ks_config.py",
    "services/media-crawler/config/tieba_config.py",
    "services/media-crawler/config/weibo_config.py",
    "services/media-crawler/config/xhs_config.py",
    "services/media-crawler/config/zhihu_config.py",
    "services/media-crawler/database/__init__.py",
    "services/media-crawler/database/db_session.py",
    "services/media-crawler/database/models.py",
    "services/media-crawler/database/mongodb_store_base.py"
  ]);
  for (const name of configModules) {
    const path = `services/media-crawler/config/${name}`; const before = manifest.rootHash;
    await writeFile(join(root, path), `${name}=2`);
    manifest = await createSourceContentManifest(root, "desktop-app");
    assert.notEqual(manifest.rootHash, before, name);
  }
  const beforeUnreached = manifest.rootHash;
  await writeFile(join(root, "services/media-crawler/database/db.py"), "UNREACHED = 2");
  assert.equal((await createSourceContentManifest(root, "desktop-app")).rootHash, beforeUnreached);
  await writeFixtureFiles(root, { "services/media-crawler/database/new_unreached.py": "UNREACHED = 3" });
  assert.equal((await createSourceContentManifest(root, "desktop-app")).rootHash, beforeUnreached);
});

test("desktop-app enumerates build source assets while excluding regenerated and rejecting unrelated artifacts", async () => {
  const root = await fixture();
  const sources = ["entitlements.mac.empty.plist", "entitlements.mac.plist", "icon-approval.json", "icon-source.png"];
  const before = await createSourceContentManifest(root, "desktop-app");
  for (const name of sources) assert.equal(before.records.some((record) => record.path === `desktop/build/${name}`), true);
  await writeFixtureFiles(root, { "desktop/build/icon.icns": "generated-v1" });
  const generated = await createSourceContentManifest(root, "desktop-app");
  assert.equal(generated.records.some((record) => record.path === "desktop/build/icon.icns"), false);
  await writeFile(join(root, "desktop/build/icon.icns"), "generated-v2");
  assert.equal((await createSourceContentManifest(root, "desktop-app")).rootHash, generated.rootHash);
  await writeFixtureFiles(root, { "desktop/build/unrelated.bin": "not an input" });
  await assert.rejects(() => createSourceContentManifest(root, "desktop-app"), /MANIFEST_UNCLASSIFIED_FILE/u);
});

test("manifest rejects a symlink substituted for every included tree root", async () => {
  const cases = {
    "backend-runtime": ["backend", "contracts"],
    "desktop-app": [
      "frontend", "frontend/src", "frontend/public", "desktop", "desktop/build", "desktop/src/main", "desktop/src/preload", "desktop/src/shared",
      "services/media-crawler",
      "services/media-crawler/shensi_adapter", "services/media-crawler/media_platform/douyin",
      "services/media-crawler/store/douyin", "services/media-crawler/tools", "services/media-crawler/base", "services/media-crawler/config",
      "services/media-crawler/cache", "services/media-crawler/proxy", "services/media-crawler/database"
    ]
  };
  for (const [scope, roots] of Object.entries(cases)) for (const includedRoot of roots) {
    const root = await fixture();
    await mkdir(join(root, includedRoot), { recursive: true });
    const targetParent = await mkdtemp(join(tmpdir(), "shensi-tree-target-"));
    const target = join(targetParent, "actual");
    await rename(join(root, includedRoot), target);
    await symlink(target, join(root, includedRoot));
    await assert.rejects(() => createSourceContentManifest(root, scope), /MANIFEST_SYMLINK_FORBIDDEN/u, includedRoot);
    await rm(targetParent, { recursive: true, force: true });
  }
});

test("desktop-app record set exactly follows renderer Electron packaging and Sidecar build inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "shensi-desktop-manifest-exact-"));
  const reachedScripts = [
    "dev.mjs", "prepare-dev-build-identity.mjs",
    "build-preload.mjs", "build-sidecar.mjs", "build-sidecar.sh",
    "frozen-sidecar-entrypoint.py", "generate-macos-icon.mjs",
    "check-package-environment.mjs", "write-runtime-config.mjs",
    "release-policy.mjs", "package-content-policy.mjs", "package-macos.sh",
    "macos-entitlements-policy.mjs", "macos-signature-policy.mjs",
    "macos-release-sign.mjs", "macos-release-hooks.mjs",
    "verify-desktop-renderer.mjs", "verify-package.mjs",
    "verify-macos-artifacts.sh"
  ];
  const files = {
    "scripts/source-content-manifest.mjs": "export {}",
    "desktop/enterprise-bridge/extension/capture.js": "(() => ({}))()",
    "package.json": "{}", "pnpm-lock.yaml": "lock", "pnpm-workspace.yaml": "packages: []",
    "frontend/package.json": "{}", "frontend/vite.config.ts": "export {}",
    "frontend/tsconfig.json": "{}", "frontend/index.html": "<main />",
    "frontend/admin.html": "<main />", "frontend/ui-kit.html": "<main />", "frontend/src/app.ts": "export {}",
    "frontend/public/logo.svg": "<svg />",
    "frontend/contracts/pinned/growth-advisor-quote-roi.manifest.json": "{}",
    "desktop/package.json": "{}", "desktop/tsconfig.json": "{}",
    "desktop/tsconfig.build.json": "{}", "desktop/electron-builder.yml": "appId: test",
    "desktop/electron-builder.release.yml": "appId: test",
    "desktop/shensi-sidecar.spec": "Analysis([])",
    "desktop/src/main/main.ts": "export {}", "desktop/src/preload/preload.ts": "export {}",
    "desktop/src/shared/contracts.ts": "export {}", "desktop/build/icon.icns": "generated-icon",
    "desktop/src/generated/ai-acquisition.d.ts": "export {}",
    "desktop/build/entitlements.mac.empty.plist": "empty-plist", "desktop/build/entitlements.mac.plist": "plist",
    "desktop/build/icon-approval.json": "{}", "desktop/build/icon-source.png": "<svg />",
    "services/media-crawler/pyproject.toml": "[project]", "services/media-crawler/uv.lock": "lock",
    "services/media-crawler/LICENSE": "license", "services/media-crawler/var.py": "VALUE = 1",
    "services/media-crawler/shensi_adapter/app.py": "pass",
    "services/media-crawler/shensi_adapter/vendor/douyin_spider/utils/mstoken_profile.json": "{}",
    "services/media-crawler/shensi_adapter/vendor/douyin_spider/utils/mstoken_common_profile.json": "{}",
    "services/media-crawler/media_platform/douyin/core.py": "pass",
    "services/media-crawler/store/douyin/store.py": "pass",
    "services/media-crawler/cache/__init__.py": "", "services/media-crawler/cache/abs_cache.py": "pass",
    "services/media-crawler/cache/cache_factory.py": "pass", "services/media-crawler/cache/local_cache.py": "pass",
    "services/media-crawler/cache/redis_cache.py": "pass", "services/media-crawler/proxy/__init__.py": "",
    "services/media-crawler/proxy/base_proxy.py": "pass", "services/media-crawler/proxy/proxy_ip_pool.py": "pass",
    "services/media-crawler/proxy/proxy_mixin.py": "pass", "services/media-crawler/proxy/types.py": "pass",
    "services/media-crawler/proxy/providers/__init__.py": "", "services/media-crawler/proxy/providers/jishu_http_proxy.py": "pass",
    "services/media-crawler/proxy/providers/kuaidl_proxy.py": "pass", "services/media-crawler/proxy/providers/wandou_http_proxy.py": "pass",
    "services/media-crawler/database/__init__.py": "", "services/media-crawler/database/db.py": "pass",
    "services/media-crawler/database/db_session.py": "pass", "services/media-crawler/database/models.py": "pass",
    "services/media-crawler/database/mongodb_store_base.py": "pass",
    "services/media-crawler/tools/tool.py": "pass", "services/media-crawler/base/base.py": "pass",
    "services/media-crawler/config/__init__.py": "", "services/media-crawler/config/base_config.py": "",
    "services/media-crawler/config/db_config.py": "", "services/media-crawler/config/bilibili_config.py": "",
    "services/media-crawler/config/xhs_config.py": "", "services/media-crawler/config/dy_config.py": "",
    "services/media-crawler/config/ks_config.py": "", "services/media-crawler/config/weibo_config.py": "",
    "services/media-crawler/config/tieba_config.py": "", "services/media-crawler/config/zhihu_config.py": "",
    "services/media-crawler/model/__init__.py": "",
    "services/media-crawler/model/m_douyin.py": "", "services/media-crawler/store/__init__.py": "",
    "services/media-crawler/media_platform/__init__.py": "",
    "services/media-crawler/libs/stealth.min.js": "js", "services/media-crawler/libs/douyin.js": "js",
    "frontend/browser-extension/ignored.ts": "ignored", "frontend/tests/ignored.ts": "ignored",
    "frontend/scripts/ignored.mjs": "ignored", "frontend/dist-desktop/ignored.js": "ignored",
    "desktop/tests/ignored.ts": "ignored", "desktop/resources/staging/ignored": "ignored",
    "desktop/resources/generated/desktop-config.json": "ignored",
    "services/media-crawler/docs/ignored.md": "ignored", "services/media-crawler/webui/ignored.ts": "ignored",
    "services/media-crawler/tests/test_app.py": "ignored", "services/media-crawler/.venv/ignored": "ignored",
    "services/media-crawler/api/ignored.py": "ignored", "services/media-crawler/media_platform/xhs/ignored.py": "ignored",
    "services/media-crawler/store/xhs/ignored.py": "ignored"
  };
  for (const script of reachedScripts) files[`desktop/scripts/${script}`] = script;
  await writeFixtureFiles(root, files);
  const manifest = await createSourceContentManifest(root, "desktop-app");
  const expected = Object.keys(files).filter((path) =>
    !["desktop/build/icon.icns", "services/media-crawler/database/db.py"].includes(path) && !/(?:^frontend\/(?:browser-extension|tests|scripts|dist-desktop)\/|^desktop\/(?:tests|resources)\/|^services\/media-crawler\/(?:docs|webui|tests|\.venv|api)\/|^services\/media-crawler\/(?:media_platform|store)\/xhs\/)/u.test(path)
  ).sort();
  assert.deepEqual(manifest.records.map(({ path }) => path), expected);
  await rm(join(root, "desktop/scripts/package-macos.sh"));
  await assert.rejects(() => createSourceContentManifest(root, "desktop-app"), /MANIFEST_REQUIRED_INPUT_MISSING/u);
  await writeFixtureFiles(root, { "desktop/scripts/package-macos.sh": "package-macos.sh" });
  await writeFixtureFiles(root, { "services/media-crawler/tools/new_runtime_module.py": "pass" });
  assert.equal((await createSourceContentManifest(root, "desktop-app")).records.some(({ path }) => path.endsWith("tools/new_runtime_module.py")), true);
  await mkdir(join(root, "services/media-crawler/Profiles"));
  await assert.rejects(() => createSourceContentManifest(root, "desktop-app"), /MANIFEST_FORBIDDEN_INPUT/u);
});

test("desktop-app identity binds development startup, its producer, canonical source algorithm and generated Main contract", async () => {
  const root = await fixture();
  await writeFixtureFiles(root, { "desktop/src/generated/ai-acquisition.d.ts": "export {}" });
  let before = await createSourceContentManifest(root, "desktop-app");
  for (const input of ["desktop/scripts/dev.mjs", "desktop/scripts/prepare-dev-build-identity.mjs", "scripts/source-content-manifest.mjs", "desktop/src/generated/ai-acquisition.d.ts"]) {
    await writeFile(join(root, input), "changed input");
    const after = await createSourceContentManifest(root, "desktop-app");
    assert.notEqual(after.rootHash, before.rootHash, input);
    before = after;
  }
});

test("desktop-app fails closed for unknown direct build-root siblings and secret or symlinked inputs", async () => {
  for (const [rootName, unknown] of [["frontend", "unknown.bin"], ["desktop", "unknown.bin"], ["services/media-crawler", "unknown.bin"]]) {
    const root = await fixture();
    await writeFixtureFiles(root, { [`${rootName}/${unknown}`]: "unknown" });
    await assert.rejects(() => createSourceContentManifest(root, "desktop-app"), /MANIFEST_UNCLASSIFIED_FILE/u);
  }
  const secretRoot = await fixture();
  await writeFixtureFiles(secretRoot, { "services/media-crawler/shensi_adapter/client-secret.pem": "secret" });
  await assert.rejects(() => createSourceContentManifest(secretRoot, "desktop-app"), /MANIFEST_FORBIDDEN_INPUT/u);
  const linkRoot = await fixture();
  await symlink("app.ts", join(linkRoot, "frontend/src/linked.ts"));
  await assert.rejects(() => createSourceContentManifest(linkRoot, "desktop-app"), /MANIFEST_SYMLINK_FORBIDDEN/u);
});

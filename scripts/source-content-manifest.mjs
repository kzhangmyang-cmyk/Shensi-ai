import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FILES = new Set(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
const BACKEND_RUNTIME_FILES = new Set([".dockerignore", "frontend/package.json", "frontend/src/generated/ai-acquisition.ts", "frontend/src/generated/decision-simulation.ts", "desktop/src/generated/ai-acquisition.d.ts", "deploy/docker/backend.Dockerfile", "deploy/compose.api-only.yaml", "deploy/nginx/api-only.conf", "scripts/container-runtime.mjs", "scripts/source-content-manifest.mjs"]);
const GENERATED_SEGMENTS = new Set(["node_modules", ".git", ".runtime", "dist", "dist-desktop", "release", "test-results", "coverage", "playwright-report", ".build", "__pycache__", ".pytest_cache", ".venv", ".local-data"]);
const FORBIDDEN_SEGMENTS = new Set(["profiles", "secrets"]);

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function normalized(path) { return path.split("\\").join("/"); }
function excluded(path, scope) {
  const normalizedPath = normalized(path);
  const segments = normalizedPath.split("/");
  if (segments.some((segment) => GENERATED_SEGMENTS.has(segment))) return true;
  if (scope === "desktop-app" && /(^|\/)(?:[^/]+-test|[^/]+\.test|[^/]+\.spec)\.[^/]+$/u.test(normalizedPath)) return true;
  if (scope === "desktop-app" && /(^|\/)README[^/]*$/iu.test(normalizedPath)) return true;
  return /^desktop\/resources\/(?:generated|staging)(?:\/|$)/u.test(normalizedPath);
}
function forbidden(path) { return normalized(path).split("/").some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()) || (segment !== ".env.example" && /^\.env(?:\.|$)/u.test(segment)) || /(?:secret|credential|password)\.(?:json|ya?ml|env|pem|key)$/iu.test(segment)); }

async function addFile(root, absolute, records, scope) {
  const stat = await lstat(absolute);
  const path = normalized(relative(root, absolute));
  if (forbidden(path)) throw new Error(`MANIFEST_FORBIDDEN_INPUT:${path}`);
  if (stat.isSymbolicLink()) throw new Error(`MANIFEST_SYMLINK_FORBIDDEN:${path}`);
  if (!stat.isFile()) return;
  if (excluded(path, scope)) return;
  records.set(path, Object.freeze({ path, mode: stat.mode & 0o777, size: stat.size, sha256: digest(await readFile(absolute)) }));
}

async function addRequiredFile(root, absolute, records, scope) {
  try { await addFile(root, absolute, records, scope); } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`MANIFEST_REQUIRED_INPUT_MISSING:${normalized(relative(root, absolute))}`);
    throw error;
  }
}

async function addTree(root, directory, records, scope) {
  const rootPath = normalized(relative(root, directory));
  let rootStat;
  try { rootStat = await lstat(directory); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  if (rootStat.isSymbolicLink()) throw new Error(`MANIFEST_SYMLINK_FORBIDDEN:${rootPath}`);
  if (!rootStat.isDirectory()) throw new Error(`MANIFEST_TREE_ROOT_INVALID:${rootPath}`);
  let entries;
  entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = resolve(directory, entry.name);
    const path = normalized(relative(root, absolute));
    if (forbidden(path)) throw new Error(`MANIFEST_FORBIDDEN_INPUT:${path}`);
    if (excluded(path, scope)) continue;
    if (entry.isSymbolicLink()) throw new Error(`MANIFEST_SYMLINK_FORBIDDEN:${path}`);
    if (entry.isDirectory()) await addTree(root, absolute, records, scope);
    else await addFile(root, absolute, records, scope);
  }
}

async function assertRootClassified(root, directory, allowed, explicitlyExcluded = new Set()) {
  let rootStat;
  try { rootStat = await lstat(resolve(root, directory)); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  if (rootStat.isSymbolicLink()) throw new Error(`MANIFEST_SYMLINK_FORBIDDEN:${directory}`);
  if (!rootStat.isDirectory()) throw new Error(`MANIFEST_TREE_ROOT_INVALID:${directory}`);
  for (const entry of await readdir(resolve(root, directory), { withFileTypes: true }).catch(() => [])) {
    const path = `${directory}/${entry.name}`;
    if (forbidden(path)) throw new Error(`MANIFEST_FORBIDDEN_INPUT:${path}`);
    if (excluded(path, "desktop-app") || allowed.has(entry.name) || explicitlyExcluded.has(entry.name) || entry.name.startsWith("playwright.")) continue;
    throw new Error(`MANIFEST_UNCLASSIFIED_FILE:${path}`);
  }
}

async function assertIncludedRoot(root, directory) {
  let stat;
  try { stat = await lstat(resolve(root, directory)); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
  if (stat.isSymbolicLink()) throw new Error(`MANIFEST_SYMLINK_FORBIDDEN:${directory}`);
  if (!stat.isDirectory()) throw new Error(`MANIFEST_TREE_ROOT_INVALID:${directory}`);
}

export async function createSourceContentManifest(repositoryRoot, scope) {
  const root = resolve(repositoryRoot);
  const records = new Map();
  if (scope === "backend-runtime") {
    for (const file of ROOT_FILES) await addFile(root, resolve(root, file), records, scope);
    for (const directory of ["backend", "contracts"]) await addTree(root, resolve(root, directory), records, scope);
    for (const file of BACKEND_RUNTIME_FILES) await addFile(root, resolve(root, file), records, scope);
  } else if (scope === "desktop-app") {
    for (const file of ["desktop/scripts/dev.mjs", "desktop/scripts/prepare-dev-build-identity.mjs", "scripts/source-content-manifest.mjs"]) await addRequiredFile(root, resolve(root, file), records, scope);
    await addTree(root, resolve(root, "desktop/src/generated"), records, scope);
    await assertRootClassified(root, "frontend", new Set(["src", "public", "package.json", "index.html", "admin.html", "ui-kit.html", "vite.config.ts", "tsconfig.json"]), new Set(["enterprise-preview.html", "browser-extension", "contracts", "scripts", "tests", "pnpm-lock.yaml", "pnpm-workspace.yaml", "docs", ".superpowers", ".gitignore", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "tsconfig.node.json", "tsconfig.tests.json", "tsconfig.tsbuildinfo", "playwright.config.ts", "playwright.douyin-mediacrawler-real.config.ts", "playwright.financial-council-real-runtime.config.ts", "playwright.financial-council-real.config.ts", "playwright.shensi-cutover.config.ts"]));
    // Native host/installer remain separate; the shared DOM reader ships in Electron too.
    await addRequiredFile(root, resolve(root, 'desktop/enterprise-bridge/extension/capture.js'), records, scope);
    await assertRootClassified(root, "desktop", new Set(["src", "scripts", "build", "resources", "package.json", "shensi-sidecar.spec", "electron-builder.yml", "electron-builder.release.yml", "tsconfig.json", "tsconfig.build.json"]), new Set(["tests", "enterprise-bridge"]));
    await assertRootClassified(root, "desktop/build", new Set(["entitlements.mac.empty.plist", "entitlements.mac.plist", "icon-approval.json", "icon-source.png"]), new Set(["icon.icns"]));
    await assertRootClassified(root, "services/media-crawler", new Set(["shensi_adapter", "pyproject.toml", "uv.lock", "var.py", "libs", "media_platform", "model", "store", "tools", "base", "config", "cache", "database", "proxy", "LICENSE"]), new Set(["tests", "test", "docs", ".github", "webui", "api", "cmd_arg", "constant", "data", "scripts", "package.json", "package-lock.json", "mypy.ini", "README.md", "README_en.md", "README_es.md", "SHENSI_UPSTREAM.md", "requirements.txt", "Dockerfile.shensi", "Dockerfile.shensi.dockerignore", ".dockerignore.shensi", ".gitignore", ".gitattributes", ".python-version", ".pre-commit-config.yaml", ".env.example", "main.py", "recv_sms.py"]));
    for (const directory of ["services/media-crawler/config", "services/media-crawler/database"]) await assertIncludedRoot(root, directory);
    for (const file of ROOT_FILES) await addFile(root, resolve(root, file), records, scope);
    for (const directory of ["frontend/src", "frontend/public", "desktop/src/main", "desktop/src/preload", "desktop/src/shared", "desktop/resources/audio", "services/media-crawler/shensi_adapter", "services/media-crawler/media_platform/douyin", "services/media-crawler/store/douyin", "services/media-crawler/tools", "services/media-crawler/base", "services/media-crawler/cache", "services/media-crawler/proxy"]) await addTree(root, resolve(root, directory), records, scope);
    for (const file of ["frontend/package.json", "frontend/index.html", "frontend/admin.html", "frontend/ui-kit.html", "frontend/vite.config.ts", "frontend/tsconfig.json", "frontend/contracts/pinned/growth-advisor-quote-roi.manifest.json", "desktop/package.json", "desktop/shensi-sidecar.spec", "desktop/electron-builder.yml", "desktop/electron-builder.release.yml", "desktop/tsconfig.json", "desktop/tsconfig.build.json", "desktop/build/entitlements.mac.empty.plist", "desktop/build/entitlements.mac.plist", "desktop/build/icon-approval.json", "desktop/build/icon-source.png", "desktop/scripts/package-macos.sh", "desktop/scripts/build-preload.mjs", "desktop/scripts/build-sidecar.mjs", "desktop/scripts/build-sidecar.sh", "desktop/scripts/frozen-sidecar-entrypoint.py", "desktop/scripts/generate-macos-icon.mjs", "desktop/scripts/check-package-environment.mjs", "desktop/scripts/write-runtime-config.mjs", "desktop/scripts/release-policy.mjs", "desktop/scripts/package-content-policy.mjs", "desktop/scripts/macos-entitlements-policy.mjs", "desktop/scripts/macos-signature-policy.mjs", "desktop/scripts/macos-release-sign.mjs", "desktop/scripts/macos-release-hooks.mjs", "desktop/scripts/verify-desktop-renderer.mjs", "desktop/scripts/verify-package.mjs", "desktop/scripts/verify-macos-artifacts.sh", "services/media-crawler/pyproject.toml", "services/media-crawler/uv.lock", "services/media-crawler/var.py", "services/media-crawler/LICENSE", "services/media-crawler/libs/stealth.min.js", "services/media-crawler/libs/douyin.js", "services/media-crawler/config/__init__.py", "services/media-crawler/config/base_config.py", "services/media-crawler/config/db_config.py", "services/media-crawler/config/bilibili_config.py", "services/media-crawler/config/xhs_config.py", "services/media-crawler/config/dy_config.py", "services/media-crawler/config/ks_config.py", "services/media-crawler/config/weibo_config.py", "services/media-crawler/config/tieba_config.py", "services/media-crawler/config/zhihu_config.py", "services/media-crawler/database/__init__.py", "services/media-crawler/database/db_session.py", "services/media-crawler/database/models.py", "services/media-crawler/database/mongodb_store_base.py", "services/media-crawler/model/__init__.py", "services/media-crawler/model/m_douyin.py", "services/media-crawler/store/__init__.py", "services/media-crawler/media_platform/__init__.py", "services/media-crawler/shensi_adapter/vendor/douyin_spider/utils/mstoken_profile.json", "services/media-crawler/shensi_adapter/vendor/douyin_spider/utils/mstoken_common_profile.json"]) await addRequiredFile(root, resolve(root, file), records, scope);
  } else throw new Error("MANIFEST_SCOPE_INVALID");
  const sortedRecords = [...records.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const serialized = sortedRecords.map((record) => `${record.path}\0${record.mode}\0${record.size}\0${record.sha256}\n`).join("");
  return Object.freeze({ scope, records: Object.freeze(sortedRecords), rootHash: digest(serialized) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const scope = process.argv[2] ?? "backend-runtime";
  const manifest = await createSourceContentManifest(process.cwd(), scope);
  console.log(`SOURCE_CONTENT_MANIFEST scope=${manifest.scope} records=${manifest.records.length} root=${manifest.rootHash}`);
}

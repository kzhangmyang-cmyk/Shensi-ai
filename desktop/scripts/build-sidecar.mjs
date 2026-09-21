import { spawn } from "node:child_process";
import { chmod, cp, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PYINSTALLER = "pyinstaller==6.16.0";
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(desktopRoot, "..");
const serviceRoot = path.join(repositoryRoot, "services", "media-crawler");
const stageRoot = path.join(desktopRoot, "resources", "staging");
const sidecarStage = path.join(stageRoot, "sidecar");
const browsersStage = path.join(stageRoot, "playwright");
const buildRoot = path.join(desktopRoot, ".build", "sidecar");
const distRoot = path.join(buildRoot, "dist");
const workRoot = path.join(buildRoot, "work");
const specPath = path.join(desktopRoot, "shensi-sidecar.spec");

function run(executable, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(executable)} failed (${code ?? signal ?? "unknown"})`));
    });
  });
}

async function assertDirectoryWithin(candidate, parent) {
  const [resolvedCandidate, resolvedParent] = await Promise.all([
    realpath(candidate),
    realpath(parent),
  ]);
  if (resolvedCandidate !== resolvedParent
    && !resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`)) {
    throw new Error(`unsafe staging path: ${resolvedCandidate}`);
  }
}

async function rejectForbiddenResources(root) {
  const forbidden = /(?:^|[-_.])(novnc|xvfb|x11vnc|websockify|redis-server|mysqld|mysqld-safe)(?:[-_.]|$)/iu;
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (forbidden.test(entry.name)) throw new Error(`forbidden desktop resource: ${entry.name}`);
      if (entry.isDirectory()) queue.push(path.join(directory, entry.name));
    }
  }
}

async function collectFiles(root) {
  const files = [];
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  return files;
}

async function validateStagedRuntime() {
  const internal = path.join(sidecarStage, "_internal");
  const requiredFiles = [
    path.join(internal, "shensi_adapter", "vendor", "douyin_spider", "utils", "mstoken_profile.json"),
    path.join(internal, "shensi_adapter", "vendor", "douyin_spider", "utils", "mstoken_common_profile.json"),
    path.join(internal, "libs", "stealth.min.js"),
    path.join(internal, "libs", "douyin.js"),
    path.join(internal, "playwright", "driver", "node"),
    path.join(internal, "playwright", "driver", "package", "package.json"),
    path.join(internal, "certifi", "cacert.pem"),
  ];
  for (const candidate of requiredFiles) {
    if (!(await stat(candidate)).isFile()) throw new Error(`required Sidecar resource missing: ${candidate}`);
  }
  const node = path.join(internal, "playwright", "driver", "node");
  const resolvedNode = await realpath(node);
  const resolvedInternal = await realpath(internal);
  if (!resolvedNode.startsWith(`${resolvedInternal}${path.sep}`) || ((await stat(node)).mode & 0o111) === 0) {
    throw new Error("bundled Playwright Node is unsafe or non-executable");
  }
  const sidecarFiles = await collectFiles(internal);
  for (const pattern of [/playwright-[^/]+\.dist-info\/METADATA$/u, /certifi-[^/]+\.dist-info\/METADATA$/u]) {
    if (sidecarFiles.filter((candidate) => pattern.test(candidate)).length !== 1) {
      throw new Error(`required Sidecar package metadata missing: ${pattern}`);
    }
  }
  const browserFiles = await collectFiles(browsersStage);
  const browserExecutables = browserFiles.filter((candidate) =>
    /chromium-\d+\/chrome-mac-(?:arm64|x64)\/Google Chrome for Testing\.app\/Contents\/MacOS\/Google Chrome for Testing$/u.test(candidate));
  if (browserExecutables.length !== 1 || ((await stat(browserExecutables[0])).mode & 0o111) === 0) {
    throw new Error("exactly one executable bundled Chromium is required");
  }
}

await mkdir(stageRoot, { recursive: true, mode: 0o700 });
await assertDirectoryWithin(stageRoot, path.join(desktopRoot, "resources"));
await Promise.all([
  rm(sidecarStage, { recursive: true, force: true }),
  rm(browsersStage, { recursive: true, force: true }),
  rm(buildRoot, { recursive: true, force: true }),
]);
await Promise.all([
  mkdir(sidecarStage, { recursive: true, mode: 0o700 }),
  mkdir(browsersStage, { recursive: true, mode: 0o700 }),
  mkdir(distRoot, { recursive: true, mode: 0o700 }),
  mkdir(workRoot, { recursive: true, mode: 0o700 }),
]);

const sharedEnvironment = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: browsersStage,
  PLAYWRIGHT_SKIP_BROWSER_GC: "1",
};

await run("uv", [
  "run", "--frozen", "--project", serviceRoot,
  "python", "-m", "playwright", "install", "--no-shell", "chromium",
], { env: sharedEnvironment });

// Playwright writes SDK garbage-collection ownership links containing the
// installing virtualenv's absolute path. Browsers do not read this metadata.
await rm(path.join(browsersStage, ".links"), { recursive: true, force: true });

await run("uv", [
  "run", "--frozen", "--project", serviceRoot, "--with", PYINSTALLER,
  "pyinstaller", "--noconfirm", "--clean",
  "--distpath", distRoot,
  "--workpath", workRoot,
  specPath,
], { env: sharedEnvironment });

const builtDirectory = path.join(distRoot, "shensi-sidecar");
const builtExecutable = path.join(builtDirectory, "shensi-sidecar");
if (!(await stat(builtExecutable)).isFile()) throw new Error("Sidecar executable was not produced");
await cp(builtDirectory, sidecarStage, { recursive: true, force: false });
await chmod(path.join(sidecarStage, "shensi-sidecar"), 0o755);
await validateStagedRuntime();
await rejectForbiddenResources(stageRoot);

console.log(JSON.stringify({
  ok: true,
  sidecar: path.relative(repositoryRoot, path.join(sidecarStage, "shensi-sidecar")),
  browsers: path.relative(repositoryRoot, browsersStage),
  pyinstaller: PYINSTALLER,
}));

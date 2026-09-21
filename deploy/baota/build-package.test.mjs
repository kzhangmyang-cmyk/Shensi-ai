import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const { parseHTML } = createRequire(path.join(workspaceRoot, "frontend/package.json"))("linkedom");

test("backend build emits the package start entry at dist/server.js", () => {
  const outputDirectory = mkdtempSync(
    path.join(workspaceRoot, "backend/.build-entry-")
  );

  try {
    execFileSync(
      path.join(workspaceRoot, "backend/node_modules/.bin/tsc"),
      [
        "-p",
        path.join(workspaceRoot, "backend/tsconfig.json"),
        "--outDir",
        outputDirectory
      ],
      { cwd: workspaceRoot, encoding: "utf8" }
    );
    const startEntry = path.join(outputDirectory, "server.js");
    execFileSync(process.execPath, [path.join(workspaceRoot, "backend/scripts/copy-cfo-skill.mjs"), outputDirectory],
      { cwd: workspaceRoot, encoding: "utf8" });
    assert.equal(readFileSync(path.join(outputDirectory, "skills/cfo-operating-advisor/SKILL.md"), "utf8"),
      readFileSync(path.join(workspaceRoot, "backend/src/skills/cfo-operating-advisor/SKILL.md"), "utf8"));

    assert.equal(
      existsSync(startEntry),
      true,
      "backend build did not emit the package start entry dist/server.js"
    );

    const evaluation = spawnSync(process.execPath, [startEntry], {
      cwd: workspaceRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        JWT_SECRET: "goodjob-build-entry-test-secret-at-least-32-characters",
        ACQUISITION_MASTER_SECRET:
          "goodjob-build-entry-master-secret-at-least-32-characters"
      }
    });
    assert.equal(
      evaluation.status,
      0,
      evaluation.stderr || evaluation.stdout
    );
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
});

test("Baota package can evaluate the acquisition OpenAPI module", () => {
  const temporaryRoot = mkdtempSync(
    path.join(tmpdir(), "goodjob-baota-package-")
  );
  const outputDirectory = path.join(temporaryRoot, "output");
  const extractedDirectory = path.join(temporaryRoot, "extracted");
  const sourceDirectory = path.join(temporaryRoot, "source");

  try {
    for (const relativePath of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "backend/package.json",
      "backend/tsconfig.json",
      "backend/src",
      "backend/scripts/copy-cfo-skill.mjs",
      "frontend/package.json",
      "frontend/index.html",
      "frontend/admin.html",
      "frontend/tsconfig.json",
      "frontend/tsconfig.node.json",
      "frontend/vite.config.ts",
      "frontend/src",
      "contracts/package.json",
      "contracts/json-schema",
      "contracts/openapi",
      "contracts/scripts",
      "deploy/baota"
    ]) {
      const destination = path.join(sourceDirectory, relativePath);
      mkdirSync(path.dirname(destination), { recursive: true });
      cpSync(
        path.join(workspaceRoot, relativePath),
        destination,
        { recursive: true }
      );
    }
    const databaseDirectory = path.join(
      sourceDirectory,
      "deploy/baota/database"
    );
    mkdirSync(databaseDirectory, { recursive: true });
    writeFileSync(path.join(databaseDirectory, "bootstrap.sql.gz"), "fixture");
    writeFileSync(
      path.join(databaseDirectory, "bootstrap.sql.gz.sha256"),
      "fixture  bootstrap.sql.gz\n"
    );

    const sourceLoginPath = path.join(sourceDirectory, "frontend/index.html");
    const sourceLoginHtml = readFileSync(sourceLoginPath, "utf8");
    const plainLoginHtml = sourceLoginHtml.replace(/ placeholder="[^"]*"/gu, "");
    for (const [id, description] of [
      ["loginEmail", "账号"],
      ["loginPassword", "密码"]
    ]) {
      for (const mutation of ["prefilled", "not-required"]) {
        const input = new RegExp(`<input id="${id}"[^>]*>`, "u");
        assert.match(sourceLoginHtml, input);
        writeFileSync(sourceLoginPath, plainLoginHtml.replace(input, (tag) =>
          mutation === "prefilled"
            ? tag.replace("<input ", '<input value="synthetic-prefilled" ')
            : tag.replace(" required", "")));
        const rejected = spawnSync("bash", [
          path.join(sourceDirectory, "deploy/baota/build-package.sh"), outputDirectory
        ], { cwd: sourceDirectory, encoding: "utf8", env: {
          ...process.env, PACKAGE_TIMESTAMP: "invalid-login-smoke"
        } });
        assert.equal(rejected.status, 1, `${id} ${mutation} must not be packaged`);
        assert.match(rejected.stderr, new RegExp(`登录界面缺少空白${description}输入`, "u"));
        assert.deepEqual(readdirSync(outputDirectory), [], "invalid login must not emit an archive");
      }
    }
    writeFileSync(sourceLoginPath, sourceLoginHtml);

    const archivePath = execFileSync(
      "bash",
      [
        path.join(sourceDirectory, "deploy/baota/build-package.sh"),
        outputDirectory
      ],
      {
        cwd: sourceDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          PACKAGE_TIMESTAMP: "contract-assets-smoke"
        }
      }
    ).trim();
    execFileSync("mkdir", ["-p", extractedDirectory]);
    execFileSync("tar", ["-xzf", archivePath, "-C", extractedDirectory]);
    const packageRoot = path.join(
      extractedDirectory,
      readdirSync(extractedDirectory)[0]
    );
    assert.equal(existsSync(path.join(packageRoot, "pnpm-lock.yaml")), true);
    assert.equal(existsSync(path.join(packageRoot, "pnpm-workspace.yaml")), true);
    assert.equal(existsSync(path.join(packageRoot, "package-lock.json")), false);
    assert.equal(
      existsSync(path.join(packageRoot, "contracts/openapi/ai-acquisition.v1.yaml")),
      true
    );
    assert.equal(
      existsSync(path.join(packageRoot, "contracts/scripts/generate-frontend-contract-types.mjs")),
      true
    );
    const loginHtml = readFileSync(path.join(packageRoot, "frontend/index.html"), "utf8");
    assert.equal(readFileSync(path.join(packageRoot, "frontend/admin.html"), "utf8"),
      readFileSync(path.join(workspaceRoot, "frontend/admin.html"), "utf8"));
    assert.match(loginHtml, /aria-label="Shensi 登录"/u);
    const { document: loginDocument } = parseHTML(loginHtml);
    for (const [id, name, type, autocomplete] of [
      ["loginEmail", "email", "text", "username"],
      ["loginPassword", "password", "password", "current-password"]
    ]) {
      const input = loginDocument.getElementById(id);
      assert.ok(input, `${id} is required in the package`);
      assert.equal(input.getAttribute("name"), name);
      assert.equal(input.getAttribute("type"), type);
      assert.equal(input.getAttribute("autocomplete"), autocomplete);
      assert.equal(input.hasAttribute("required"), true);
      assert.equal(input.getAttribute("value") ?? "", "");
    }
    assert.equal(loginDocument.getElementById("loginEmail").getAttribute("maxlength"), "320");
    assert.doesNotMatch(loginHtml, /value="admin@goodjob\.com"|value="goodjob123"/u);
    for (const workspace of ["backend", "frontend", "contracts"]) {
      symlinkSync(
        path.join(workspaceRoot, workspace, "node_modules"),
        path.join(packageRoot, workspace, "node_modules"),
        "dir"
      );
    }
    execFileSync(
      path.join(workspaceRoot, "backend/node_modules/.bin/tsc"),
      ["-p", path.join(packageRoot, "backend/tsconfig.json")],
      { cwd: packageRoot, encoding: "utf8" }
    );
    execFileSync(process.execPath, [path.join(packageRoot, "backend/scripts/copy-cfo-skill.mjs")],
      { cwd: packageRoot, encoding: "utf8" });
    const moduleUrl = pathToFileURL(path.join(
      packageRoot,
      "backend/dist/acquisition-openapi.js"
    )).href;
    const evaluation = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(moduleUrl)}); await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, "backend/dist/skills/cfo-operating-advisor/index.js")).href)})`
      ],
      {
        cwd: packageRoot,
        encoding: "utf8"
      }
    );

    assert.equal(
      evaluation.status,
      0,
      evaluation.stderr || evaluation.stdout
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

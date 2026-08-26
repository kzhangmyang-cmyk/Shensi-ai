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
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);

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
      "frontend/package.json",
      "frontend/index.html",
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
    assert.match(loginHtml, /aria-label="Shensi 登录"/u);
    assert.match(
      loginHtml,
      /<input id="loginEmail" name="email" type="text" autocomplete="username" required maxlength="320">/u
    );
    assert.match(
      loginHtml,
      /<input id="loginPassword" name="password" type="password" autocomplete="current-password" required>/u
    );
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
    const moduleUrl = pathToFileURL(path.join(
      packageRoot,
      "backend/dist/acquisition-openapi.js"
    )).href;
    const evaluation = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(moduleUrl)})`
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

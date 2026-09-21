import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  auditVisualReaderBundle,
  renderVisualReaderManifest
} from "../../../scripts/build-visual-reader-manifest.mts";

const templateUrl = new URL("../manifest.template.json", import.meta.url);

const ocrFixtureAssets = [
  ["ocr/worker.min.js", "worker", "tesseract.js", "7.0.0", "Apache-2.0", "https://github.com/naptha/tesseract.js"],
  ["ocr/core/tesseract-core-lstm.wasm.js", "core-base-js", "tesseract.js-core", "7.0.0", "Apache-2.0", "https://github.com/naptha/tesseract.js-core"],
  ["ocr/core/tesseract-core-lstm.wasm", "core-base-wasm", "tesseract.js-core", "7.0.0", "Apache-2.0", "https://github.com/naptha/tesseract.js-core"],
  ["ocr/core/tesseract-core-simd-lstm.wasm.js", "core-simd-js", "tesseract.js-core", "7.0.0", "Apache-2.0", "https://github.com/naptha/tesseract.js-core"],
  ["ocr/core/tesseract-core-simd-lstm.wasm", "core-simd-wasm", "tesseract.js-core", "7.0.0", "Apache-2.0", "https://github.com/naptha/tesseract.js-core"],
  ["ocr/core/tesseract-core-relaxedsimd-lstm.wasm.js", "core-relaxed-js", "tesseract.js-core", "7.0.0", "Apache-2.0", "https://github.com/naptha/tesseract.js-core"],
  ["ocr/core/tesseract-core-relaxedsimd-lstm.wasm", "core-relaxed-wasm", "tesseract.js-core", "7.0.0", "Apache-2.0", "https://github.com/naptha/tesseract.js-core"],
  ["ocr/lang/chi_sim.traineddata", "chi-sim", "@tesseract.js-data/chi_sim", "1.0.0", "MIT", "https://github.com/naptha/tessdata"],
  ["ocr/lang/eng.traineddata", "eng", "@tesseract.js-data/eng", "1.0.0", "MIT", "https://github.com/naptha/tessdata"],
  ["ocr/licenses/tesseract.js-APACHE-2.0.txt", "apache-js", "tesseract.js", "7.0.0", "Apache-2.0", "https://github.com/naptha/tesseract.js"],
  ["ocr/licenses/tesseract.js-core-APACHE-2.0.txt", "apache-core", "tesseract.js-core", "7.0.0", "Apache-2.0", "https://github.com/naptha/tesseract.js-core"],
  ["ocr/licenses/tessdata-MIT.txt", "mit-data", "@tesseract.js-data/chi_sim + @tesseract.js-data/eng", "1.0.0", "MIT", "https://github.com/naptha/tessdata"]
] as const;

async function writeOcrFixture(root: string): Promise<void> {
  const assets = [];
  for (const [path, content, packageName, version, license, source] of ocrFixtureAssets) {
    const bytes = Buffer.from(content);
    const destination = join(root, path);
    await mkdir(join(destination, ".."), { recursive: true });
    await writeFile(destination, bytes);
    assets.push({
      path,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      package: packageName,
      version,
      license,
      source
    });
  }
  await writeFile(join(root, "ocr-assets.json"), `${JSON.stringify({ schemaVersion: 1, assets }, null, 2)}\n`);
}

{
  const manifest = await renderVisualReaderManifest({
    templateUrl,
    originsLiteral: undefined,
    release: false
  });
  assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "storage", "offscreen"]);
  assert.deepEqual(manifest.host_permissions, ["https://www.douyin.com/*"]);
  assert.deepEqual(manifest.content_scripts?.[0]?.matches, ["http://127.0.0.1:5191/*"]);
  assert.equal(manifest.background?.type, "module");
  assert.equal(manifest.action?.default_popup, "popup.html");
  assert.deepEqual(manifest.content_security_policy, {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  });
}

for (const originsLiteral of ["https://evil.example", "http://localhost:5191", "https://crm.goodjob.example,https://growth.goodjob.example", "https://crm.goodjob.example/path"]) {
  await assert.rejects(
    () => renderVisualReaderManifest({ templateUrl, originsLiteral, release: false }),
    /开发构建/u,
    `development rendering rejects ${originsLiteral}`
  );
}
for (const originsLiteral of [undefined, "", "  ", "http://127.0.0.1:5191"]) {
  const manifest = await renderVisualReaderManifest({ templateUrl, originsLiteral, release: false });
  assert.deepEqual(manifest.content_scripts?.[0]?.matches, ["http://127.0.0.1:5191/*"],
    `development rendering remains the one fixed local origin for ${String(originsLiteral)}`);
}

{
  const manifest = await renderVisualReaderManifest({
    templateUrl,
    originsLiteral: "https://crm.goodjob.example,https://growth.goodjob.example",
    release: true
  });
  assert.deepEqual(manifest.content_scripts?.[0]?.matches, [
    "https://crm.goodjob.example/*",
    "https://growth.goodjob.example/*"
  ]);
}

await assert.rejects(
  () => renderVisualReaderManifest({ templateUrl, originsLiteral: undefined, release: true }),
  /发布构建必须显式配置 HTTPS GoodJob origin/u
);
for (const originsLiteral of [
  "https://*/*",
  "https://goodjob.example/path",
  "http://goodjob.example",
  "https://user:pass@goodjob.example",
  "<all_urls>"
]) {
  await assert.rejects(
    () => renderVisualReaderManifest({ templateUrl, originsLiteral, release: true }),
    /GoodJob origin/u
  );
}

{
  const root = await mkdtemp(join(tmpdir(), "goodjob-visual-reader-"));
  try {
    const releaseOptions = {
      templateUrl,
      originsLiteral: "https://crm.goodjob.example",
      release: true
    } as const;
    const validManifest = await renderVisualReaderManifest(releaseOptions);
    await writeFile(join(root, "manifest.json"), JSON.stringify(validManifest));
    await writeFile(join(root, "service-worker.js"), "globalThis.chrome.runtime.onMessage.addListener(() => undefined);\n");
    await writeFile(join(root, "goodjob-bridge-content.js"), "globalThis.addEventListener('message', () => undefined);\n");
    await writeFile(join(root, "douyin-content.js"), "globalThis.addEventListener('scroll', () => undefined);\n");
    await writeFile(join(root, "popup.js"), "globalThis.document.addEventListener('DOMContentLoaded', () => undefined);\n");
    await writeFile(join(root, "popup.html"), "<!doctype html><script type=\"module\" src=\"./popup.js\"></script>");
    await writeFile(join(root, "popup.css"), "body{color:#173d33}");
    await writeFile(join(root, "offscreen.js"), "globalThis.chrome.runtime.onMessage.addListener(() => undefined);\n");
    await writeFile(join(root, "offscreen.html"), "<!doctype html><script type=\"module\" src=\"./offscreen.js\"></script>");
    await writeOcrFixture(root);
    await assert.rejects(() => auditVisualReaderBundle(root, releaseOptions), /license|notice/iu,
      "redistributed OCR assets require shipped license texts and modification notices");
    await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), "pinned OCR packages and modified worker\n");
    const report = await auditVisualReaderBundle(root, releaseOptions);
    assert.deepEqual(report, { files: 23, forbiddenFindings: [] });
    await rm(join(root, "offscreen.html"));
    await assert.rejects(() => auditVisualReaderBundle(root, releaseOptions), /必需构建入口/u);
    await writeFile(join(root, "offscreen.html"), "<!doctype html><script type=\"module\" src=\"./offscreen.js\"></script>");
    const validCheck = spawnSync("npm", ["run", "check:visual-reader-bundle"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VISUAL_READER_DIST_DIR: root,
        VISUAL_READER_RELEASE: "1",
        GOODJOB_APP_ORIGINS: "https://crm.goodjob.example"
      },
      encoding: "utf8"
    });
    assert.equal(validCheck.status, 0,
      "the read-only command accepts a release manifest rendered from this exact template and origin");
    await writeFile(join(root, "service-worker.js"), "fetch('https://remote.example/api')\n//# sourceMappingURL=x.map");
    await assert.rejects(() => auditVisualReaderBundle(root, releaseOptions), /远程网络|source map/u);
    await writeFile(join(root, "service-worker.js"), "globalThis.chrome.runtime.onMessage.addListener(() => undefined);\n");
    const assetManifestPath = join(root, "ocr-assets.json");
    const assetManifest = JSON.parse(await readFile(assetManifestPath, "utf8"));
    assetManifest.assets[0].sha256 = "0".repeat(64);
    await writeFile(assetManifestPath, JSON.stringify(assetManifest));
    await assert.rejects(() => auditVisualReaderBundle(root, releaseOptions), /OCR 资产.*SHA-256/u);
    await writeOcrFixture(root);
    await writeFile(join(root, "ocr", "worker.min.js"), "new Function('return 1')");
    await assert.rejects(() => auditVisualReaderBundle(root, releaseOptions), /动态代码|SHA-256/u);
    await writeOcrFixture(root);
    await writeFile(join(root, "raw-comment-fixture.webp"), "raw");
    await assert.rejects(() => auditVisualReaderBundle(root, releaseOptions), /原始 fixture/u);
    await rm(join(root, "raw-comment-fixture.webp"));
    await writeFile(join(root, "oversized.bin"), "");
    await truncate(join(root, "oversized.bin"), 80 * 1024 * 1024);
    await assert.rejects(() => auditVisualReaderBundle(root, releaseOptions), /80 MiB/u);
    await rm(join(root, "oversized.bin"));
    const parsed = structuredClone(validManifest);
    parsed.permissions.push("cookies");
    await writeFile(join(root, "manifest.json"), JSON.stringify(parsed));
    await assert.rejects(() => auditVisualReaderBundle(root, releaseOptions), /禁止权限/u);
    await writeFile(join(root, "service-worker.js"), "globalThis.chrome.runtime.onMessage.addListener(() => undefined);\n");

    const tamperedManifests: Array<[string, Record<string, unknown>]> = [
      ["evil but syntactically specific origin", {
        ...structuredClone(validManifest),
        content_scripts: [{
          ...structuredClone(validManifest.content_scripts?.[0]),
          matches: ["https://evil.example/*"]
        }]
      }],
      ["remote CSP", {
        ...structuredClone(validManifest),
        content_security_policy: {
          extension_pages: "script-src 'self' https://evil.example; object-src 'self'"
        }
      }],
      ["optional permission", {
        ...structuredClone(validManifest),
        optional_permissions: ["cookies"]
      }],
      ["changed content script", {
        ...structuredClone(validManifest),
        content_scripts: [{
          ...structuredClone(validManifest.content_scripts?.[0]),
          js: ["goodjob-bridge-content.js", "evil.js"]
        }]
      }]
    ];
    for (const [name, tampered] of tamperedManifests) {
      await writeFile(join(root, "manifest.json"), JSON.stringify(tampered));
      await assert.rejects(
        () => auditVisualReaderBundle(root, releaseOptions),
        /manifest|权限|origin|CSP|content-script/iu,
        name
      );
    }

    const commandTamper = tamperedManifests[0][1];
    await writeFile(join(root, "manifest.json"), JSON.stringify(commandTamper));
    const checked = spawnSync("npm", ["run", "check:visual-reader-bundle"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        VISUAL_READER_DIST_DIR: root,
        VISUAL_READER_RELEASE: "1",
        GOODJOB_APP_ORIGINS: "https://crm.goodjob.example"
      },
      encoding: "utf8"
    });
    assert.notEqual(checked.status, 0, "the check command rejects an already-tampered manifest");
    const afterCheck = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    assert.deepEqual(afterCheck, commandTamper, "check is read-only and cannot repair evidence");

    const developmentManifest = await renderVisualReaderManifest({
      templateUrl,
      originsLiteral: undefined,
      release: false
    });
    const evilDevelopmentManifest = structuredClone(developmentManifest);
    const developmentScripts = evilDevelopmentManifest.content_scripts;
    assert.ok(developmentScripts?.[0]?.matches);
    developmentScripts[0].matches = ["https://evil.example/*"];
    await writeFile(join(root, "manifest.json"), JSON.stringify(evilDevelopmentManifest));
    const developmentCheckEnv: NodeJS.ProcessEnv = {
      ...process.env,
      VISUAL_READER_DIST_DIR: root,
      GOODJOB_APP_ORIGINS: "https://evil.example"
    };
    delete developmentCheckEnv.VISUAL_READER_RELEASE;
    const evilDevelopmentCheck = spawnSync("npm", ["run", "check:visual-reader-bundle"], {
      cwd: process.cwd(),
      env: developmentCheckEnv,
      encoding: "utf8"
    });
    assert.notEqual(evilDevelopmentCheck.status, 0,
      "the read-only development audit never treats an evil environment origin as its baseline");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

console.log("douyin visual reader manifest self-test passed");

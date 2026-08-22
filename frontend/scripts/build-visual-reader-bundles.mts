import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { build } from "vite";
import {
  createVisualReaderViteConfig,
  type VisualReaderEntry
} from "../browser-extension/douyin-visual-reader/vite.config";
import { OCR_ASSET_SOURCES } from "./build-visual-reader-manifest.mts";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const extensionRoot = resolve(projectRoot, "browser-extension/douyin-visual-reader");
const distDir = resolve(
  projectRoot,
  process.env.VISUAL_READER_DIST_DIR ?? "dist-visual-reader/douyin-visual-reader"
);
const entries: VisualReaderEntry[] = [
  "service-worker", "goodjob-bridge-content", "douyin-content", "popup", "offscreen",
  "tesseract-worker"
];

async function assertInstalledVersion(packageName: string, expectedVersion: string): Promise<void> {
  const parsed = JSON.parse(await readFile(resolve(projectRoot, "node_modules", packageName, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (parsed.version !== expectedVersion) {
    throw new Error(`${packageName} must resolve exactly to ${expectedVersion}`);
  }
}

function sourcePathForOcrAsset(path: string): string | undefined {
  if (path === "ocr/worker.min.js") return undefined;
  if (path.startsWith("ocr/core/")) {
    return resolve(projectRoot, "node_modules/tesseract.js-core", path.slice("ocr/core/".length));
  }
  if (path === "ocr/lang/chi_sim.traineddata") {
    return resolve(projectRoot,
      "node_modules/@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz");
  }
  if (path === "ocr/lang/eng.traineddata") {
    return resolve(projectRoot,
      "node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz");
  }
  if (path === "ocr/licenses/tesseract.js-APACHE-2.0.txt") {
    return resolve(projectRoot, "node_modules/tesseract.js/LICENSE.md");
  }
  if (path === "ocr/licenses/tesseract.js-core-APACHE-2.0.txt") {
    return resolve(projectRoot, "node_modules/tesseract.js-core/LICENSE");
  }
  if (path === "ocr/licenses/tessdata-MIT.txt") {
    return resolve(extensionRoot, "src/tessdata-MIT.txt");
  }
  throw new Error(`Unknown OCR asset: ${path}`);
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
for (const entry of entries) {
  await build({ ...createVisualReaderViteConfig(entry), configFile: false, logLevel: "warn" });
}
await copyFile(resolve(extensionRoot, "src/popup.html"), resolve(distDir, "popup.html"));
await copyFile(resolve(extensionRoot, "src/popup.css"), resolve(distDir, "popup.css"));
await copyFile(resolve(extensionRoot, "src/offscreen.html"), resolve(distDir, "offscreen.html"));
await copyFile(resolve(projectRoot, "THIRD_PARTY_NOTICES.md"), resolve(distDir, "THIRD_PARTY_NOTICES.md"));

await assertInstalledVersion("tesseract.js", "7.0.0");
await assertInstalledVersion("tesseract.js-core", "7.0.0");
await assertInstalledVersion("@tesseract.js-data/chi_sim", "1.0.0");
await assertInstalledVersion("@tesseract.js-data/eng", "1.0.0");
for (const asset of OCR_ASSET_SOURCES) {
  const source = sourcePathForOcrAsset(asset.path);
  if (!source) continue;
  const destination = resolve(distDir, asset.path);
  await mkdir(resolve(destination, ".."), { recursive: true });
  if (asset.path.startsWith("ocr/lang/")) {
    await writeFile(destination, gunzipSync(await readFile(source)));
  } else {
    await copyFile(source, destination);
  }
}
const assets = [];
for (const asset of OCR_ASSET_SOURCES) {
  const bytes = await readFile(resolve(distDir, asset.path));
  assets.push({
    path: asset.path,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    package: asset.package,
    version: asset.version,
    license: asset.license,
    source: asset.source
  });
}
await writeFile(resolve(distDir, "ocr-assets.json"), `${JSON.stringify({
  schemaVersion: 1,
  assets
}, null, 2)}\n`);

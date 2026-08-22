import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type UserConfig } from "vite";

export type VisualReaderEntry = "service-worker" | "goodjob-bridge-content" | "douyin-content"
  | "popup" | "offscreen" | "tesseract-worker";

const extensionRoot = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const visualReaderDistDir = resolve(
  projectRoot,
  process.env.VISUAL_READER_DIST_DIR ?? "dist-visual-reader/douyin-visual-reader"
);

function localOnlyTesseractPlugin(): Plugin {
  return {
    name: "goodjob-local-only-tesseract",
    enforce: "pre",
    transform(source, id) {
      const normalizedId = id.replaceAll("\\", "/");
      if (normalizedId.endsWith("/tesseract.js/src/worker/browser/defaultOptions.js")) {
        return `${source.replace(/const version = require\([^\n]+\);\n/u, "")
          .replace(/workerPath: `https:\/\/cdn\.jsdelivr\.net[^\n]+/u, "workerPath: '',")}\n`;
      }
      if (normalizedId.endsWith("/tesseract.js/src/worker/browser/loadImage.js")) {
        return `'use strict';\nmodule.exports = async (image) => {\n`
          + `  if (!(image instanceof Uint8Array)) throw new Error('OCR image must be local bytes');\n`
          + `  return image;\n};\n`;
      }
      if (normalizedId.endsWith("/tesseract.js/src/worker-script/utils/setImage.js")) {
        return `'use strict';\nmodule.exports = (TessModule, api, image, angle = 0) => {\n`
          + `  if (!(image instanceof Uint8Array) || image.length < 12\n`
          + `    || image[0] !== 82 || image[1] !== 73 || image[2] !== 70 || image[3] !== 70\n`
          + `    || image[8] !== 87 || image[9] !== 69 || image[10] !== 66 || image[11] !== 80) {\n`
          + `    throw new Error('OCR worker accepts redacted WebP bytes only');\n`
          + `  }\n`
          + `  TessModule.FS.writeFile('/input', image);\n`
          + `  if (api.SetImageFile(1, angle) === 1) throw new Error('Error attempting to read image.');\n`
          + `};\n`;
      }
      if (normalizedId.endsWith("/tesseract.js/src/worker-script/index.js")) {
        const withoutRegenerator = source.replace("require('regenerator-runtime/runtime');\n", "");
        const localLanguageOnly = withoutRegenerator.replace(
          /const langPathDownload = langPath \|\| \(lstmOnly \? `https:\/\/cdn\.jsdelivr\.net\/npm\/@tesseract\.js-data\/\$\{lang\}\/4\.0\.0_best_int` : `https:\/\/cdn\.jsdelivr\.net\/npm\/@tesseract\.js-data\/\$\{lang\}\/4\.0\.0`\);/u,
          "if (typeof langPath !== 'string' || !/^(?:chrome|moz)-extension:\\/\\//.test(langPath)) throw Error('Local extension language path required');\n        const langPathDownload = langPath;"
        );
        if (localLanguageOnly === source || /cdn\.jsdelivr\.net|regenerator-runtime/u.test(localLanguageOnly)) {
          throw new Error("Tesseract worker local-only source patch did not apply cleanly");
        }
        return localLanguageOnly;
      }
      return undefined;
    }
  };
}

export function createVisualReaderViteConfig(entry: VisualReaderEntry): UserConfig {
  const moduleEntry = entry === "service-worker";
  const outputName = entry === "tesseract-worker" ? "ocr/worker.min.js" : `${entry}.js`;
  return {
    root: extensionRoot,
    publicDir: false,
    plugins: [localOnlyTesseractPlugin()],
    build: {
      outDir: visualReaderDistDir,
      emptyOutDir: false,
      sourcemap: false,
      minify: false,
      target: "es2022",
      lib: {
        entry: resolve(extensionRoot, `src/${entry}.ts`),
        name: moduleEntry ? undefined : `GoodJob${entry.replaceAll("-", "")}`,
        formats: [moduleEntry ? "es" : "iife"],
        fileName: () => outputName
      },
      rollupOptions: {
        output: { inlineDynamicImports: true }
      }
    }
  };
}

export default defineConfig(createVisualReaderViteConfig(
  (process.env.VISUAL_READER_ENTRY as VisualReaderEntry | undefined) ?? "service-worker"
));

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditVisualReaderBundle } from "./build-visual-reader-manifest.mts";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDir = resolve(
  projectRoot,
  process.env.VISUAL_READER_DIST_DIR ?? "dist-visual-reader/douyin-visual-reader"
);
const templateUrl = new URL("../browser-extension/douyin-visual-reader/manifest.template.json", import.meta.url);

await auditVisualReaderBundle(distDir, {
  templateUrl,
  originsLiteral: process.env.GOODJOB_APP_ORIGINS,
  release: process.env.VISUAL_READER_RELEASE === "1"
});

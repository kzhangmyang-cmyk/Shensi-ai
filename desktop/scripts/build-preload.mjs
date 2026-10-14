import { rm, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const outputDirectory = path.join(desktopRoot, "dist", "preload");

await rm(outputDirectory, { recursive: true, force: true });
await copyFile(path.join(desktopRoot, 'enterprise-bridge/extension/capture.js'), path.join(desktopRoot, 'dist/main/enterprise-capture.js'));
await build({
  entryPoints: [path.join(desktopRoot, "src", "preload", "preload.ts")],
  outfile: path.join(outputDirectory, "preload.cjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
});
await build({
  entryPoints: [path.join(desktopRoot, 'src/preload/local-setup.ts')],
  outfile: path.join(outputDirectory, 'local-setup.cjs'), bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], logLevel: 'info',
});

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const root = await realpath(path.resolve(process.argv[2] ?? "frontend/dist-desktop"));
if (!(await stat(path.join(root, "index.html"))).isFile()) {
  throw new Error("desktop renderer index is missing");
}

const queue = [root];
let files = 0;
while (queue.length > 0) {
  const directory = queue.pop();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      queue.push(candidate);
      continue;
    }
    files += 1;
    if (files > 20_000) throw new Error("desktop renderer file cap exceeded");
    if (/novnc|douyin-rfb-runtime/iu.test(entry.name)) {
      throw new Error(`remote-canvas artifact packaged in desktop renderer: ${entry.name}`);
    }
    if (/\.(?:js|html|json)$/u.test(entry.name)) {
      const source = await readFile(candidate, "utf8");
      if (/@novnc\/novnc|new\s+RFB\b/u.test(source)) {
        throw new Error(`remote-canvas implementation packaged in desktop renderer: ${entry.name}`);
      }
    }
  }
}

console.log(JSON.stringify({ ok: true, root, files, remoteCanvasIncluded: false }));

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconset = path.join(desktopRoot, ".build", "icon", "Shensi.iconset");
const output = path.join(desktopRoot, "build", "icon.icns");
const approval = JSON.parse(await readFile(path.join(desktopRoot, "build", "icon-approval.json"), "utf8"));
if (approval.source !== "icon-source.png") throw new Error("unexpected icon source");
const sourcePath = path.join(desktopRoot, "build", approval.source);
const source = await readFile(sourcePath);
if (createHash("sha256").update(source).digest("hex") !== approval.sha256) {
  throw new Error("icon artwork changed; review the source and its approval together");
}
if (!source.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    || source.readUInt32BE(16) !== source.readUInt32BE(20)
    || source.readUInt32BE(16) < 1024) {
  throw new Error("icon source must be a square PNG of at least 1024 pixels");
}
function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} failed: ${code}`)));
  });
}
await mkdir(iconset, { recursive: true });
for (const [name, size] of [
  ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
]) {
  await run("/usr/bin/sips", ["-z", String(size), String(size), sourcePath, "--out", path.join(iconset, name)]);
}
await run("/usr/bin/iconutil", ["-c", "icns", "-o", output, iconset]);
console.log(JSON.stringify({ ok: true, icon: "desktop/build/icon.icns", source: approval.source,
  sourceSha256: approval.sha256, temporary: approval.status !== "product-owner-approved" }));

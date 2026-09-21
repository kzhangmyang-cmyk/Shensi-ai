import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDirectory, "..");
const iconset = path.join(desktopRoot, ".build", "icon", "Shensi.iconset");
const output = path.join(desktopRoot, "build", "icon.icns");
const expectedSourceHash = "e290c529373b16d529bb9824dbbd60f58b9e47e1a247043d64f047be2ccbcb77";

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function png(size) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  const radius = size * 0.21875;
  const inside = (x, y) => {
    const cx = Math.max(radius, Math.min(size - radius, x));
    const cy = Math.max(radius, Math.min(size - radius, y));
    return ((x - cx) ** 2) + ((y - cy) ** 2) <= radius ** 2;
  };
  const green = (x, y) => (x >= size * 0.28125 && x < size * 0.71875 && (
    (y >= size * 0.25 && y < size * 0.375)
    || (y >= size * 0.4375 && y < size * 0.5625)
    || (y >= size * 0.625 && y < size * 0.75)
    || (x < size * 0.40625 && y >= size * 0.375 && y < size * 0.4375)
    || (x >= size * 0.59375 && y >= size * 0.5625 && y < size * 0.625)
  ));
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const offset = y * (stride + 1) + 1 + x * 4;
      if (!inside(x + 0.5, y + 0.5)) continue;
      const color = green(x, y) ? [0x33, 0xff, 0x88] : [0x05, 0x08, 0x06];
      raw[offset] = color[0]; raw[offset + 1] = color[1]; raw[offset + 2] = color[2]; raw[offset + 3] = 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function run(executable, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { shell: false, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("iconutil failed")));
  });
}

const source = await readFile(path.join(desktopRoot, "build", "icon-source.svg"));
if (createHash("sha256").update(source).digest("hex") !== expectedSourceHash) {
  throw new Error("temporary icon source changed; review and update the deterministic renderer together");
}
await rm(path.dirname(iconset), { recursive: true, force: true });
await mkdir(iconset, { recursive: true });
for (const [name, size] of [
  ["icon_16x16.png", 16], ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32], ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128], ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256], ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512], ["icon_512x512@2x.png", 1024],
]) await writeFile(path.join(iconset, name), png(size));
await run("/usr/bin/iconutil", ["-c", "icns", "-o", output, iconset]);
console.log(JSON.stringify({ ok: true, icon: "desktop/build/icon.icns", temporary: true }));

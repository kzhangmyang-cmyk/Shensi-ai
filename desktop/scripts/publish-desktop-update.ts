import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { publishDesktopUpdate } from "../src/shared/publish-desktop-update.ts";
import type { UpdateRelease } from "../src/shared/app-update.ts";

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || !value || value.startsWith("--")) {
    console.error("usage: publish-desktop-update.ts --dmg --feed --version --sequence --arch --build-manifest-sha256 --url --notes-file --published-at [--git-sha]");
    process.exit(2);
  }
  args.set(key.slice(2), value);
}

const required = ["dmg", "feed", "version", "sequence", "arch", "build-manifest-sha256", "url", "notes-file", "published-at"];
for (const name of required) if (!args.get(name)) {
  console.error(`missing --${name}`);
  process.exit(2);
}

const dmg = await readFile(resolve(args.get("dmg")!));
const notes = await readFile(resolve(args.get("notes-file")!), "utf8");
const sequence = Number(args.get("sequence"));
const release: UpdateRelease = {
  releaseSequence: sequence,
  version: args.get("version")!,
  platform: "darwin",
  arch: args.get("arch") === "x64" ? "x64" : "arm64",
  buildManifestSha256: args.get("build-manifest-sha256")!,
  ...(args.get("git-sha") ? { gitSha: args.get("git-sha") } : {}),
  url: args.get("url")!,
  sha256: createHash("sha256").update(dmg).digest("hex"),
  size: dmg.byteLength,
  publishedAt: args.get("published-at")!,
  title: `Shensi ${args.get("version")}`,
  notes: notes.trim()
};
if (args.get("arch") !== "arm64" && args.get("arch") !== "x64") {
  console.error("arch must be arm64 or x64");
  process.exit(2);
}
let existing: string | null = null;
try { existing = await readFile(resolve(args.get("feed")!), "utf8"); } catch { existing = null; }
const next = publishDesktopUpdate(existing, release);
await writeFile(resolve(args.get("feed")!), next, { mode: 0o644 });
console.log(JSON.stringify({ wrote: resolve(args.get("feed")!), sha256: release.sha256, size: release.size, uploaded: false }));

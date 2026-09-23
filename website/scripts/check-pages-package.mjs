import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist-pages/", import.meta.url));
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    assert(!entry.isSymbolicLink(), "Deployment must not contain symlinks");
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else files.push(path);
  }
}
await walk(root);
assert(files.length <= 20000, "Cloudflare Free Pages file limit exceeded");
let bytes = 0, largest = 0;
for (const file of files) {
  const relative = file.slice(root.length);
  assert(relative === "_headers" || [".html", ".css", ".js", ".png", ".svg", ".webp", ".txt", ".xml"].includes(extname(file)), `Unexpected deployment file: ${relative}`);
  const size = (await stat(file)).size;
  assert(size <= 25 * 1024 * 1024, `Asset exceeds 25 MiB: ${relative}`);
  bytes += size; largest = Math.max(largest, size);
  if (extname(file) === ".html") {
    const html = await readFile(file, "utf8");
    assert(!/<form\b|id="inquiry-form"/.test(html), `Static deployment must not collect inquiries: ${relative}`);
    assert(!/127\.0\.0\.1|localhost|\.runtime\//.test(html), `Local-only reference in ${relative}`);
  }
}
for (const locale of ["", "en/"]) {
  const contact = await readFile(resolve(root, locale, "contact/index.html"), "utf8");
  assert(contact.includes(locale ? "Online inquiries not yet available" : "在线咨询暂未开放"));
  assert((await readFile(resolve(root, locale, "404.html"), "utf8")).includes("noindex"));
}
const headers = await readFile(resolve(root, "_headers"), "utf8");
assert(headers.includes("frame-ancestors 'none'") && headers.includes("form-action 'none'"));
const home = await readFile(resolve(root, "index.html"), "utf8");
if (!home.includes('rel="canonical"')) {
  assert(home.includes("noindex") && headers.includes("X-Robots-Tag: noindex"));
  assert((await readFile(resolve(root, "robots.txt"), "utf8")).includes("Disallow: /"));
}
console.log(`SHENSI_PAGES_PACKAGE_OK ${JSON.stringify({ files: files.length, bytes, largestAssetBytes: largest, staticContact: true })}`);

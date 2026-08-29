import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("MediaCrawler is pinned with its license and Shensi boundary", () => {
  assert.equal(existsSync("services/media-crawler/LICENSE"), true);
  const upstream = readFileSync("services/media-crawler/SHENSI_UPSTREAM.md", "utf8");
  assert.match(upstream, /d6f7c5bb906b6dac40ddf343ef9e26438a3de092/u);
  assert.match(upstream, /commercial authorization is held outside Git/u);
});

test("optional local action OCR pins one dependency set and both notices retain its licenses", () => {
  const pyproject = readFileSync("services/media-crawler/pyproject.toml", "utf8");
  const lock = readFileSync("services/media-crawler/uv.lock", "utf8");
  const notices = [
    readFileSync("THIRD_PARTY_NOTICES.md", "utf8"),
    readFileSync("docs/THIRD_PARTY_NOTICES.md", "utf8")
  ];

  assert.match(pyproject, /visual-locator\s*=\s*\[[^\]]*"onnxruntime==1\.29\.0"[^\]]*"rapidocr==3\.9\.2"[^\]]*\]/su);
  assert.match(lock, /name = "onnxruntime"[\s\S]*?version = "1\.29\.0"/u);
  assert.match(lock, /name = "rapidocr"[\s\S]*?version = "3\.9\.2"/u);
  for (const notice of notices) {
    assert.match(notice, /rapidocr(?:@|`\]\([^)]*\) `|`\s*)3\.9\.2[^\n]*(?:Apache-2\.0)/iu);
    assert.match(notice, /onnxruntime(?:@|`\]\([^)]*\) `|`\s*)1\.29\.0[^\n]*(?:MIT)/iu);
  }
});

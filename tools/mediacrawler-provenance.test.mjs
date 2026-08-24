import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("MediaCrawler is pinned with its license and Shensi boundary", () => {
  assert.equal(existsSync("services/media-crawler/LICENSE"), true);
  const upstream = readFileSync("services/media-crawler/SHENSI_UPSTREAM.md", "utf8");
  assert.match(upstream, /d6f7c5bb906b6dac40ddf343ef9e26438a3de092/u);
  assert.match(upstream, /commercial authorization is held outside Git/u);
});

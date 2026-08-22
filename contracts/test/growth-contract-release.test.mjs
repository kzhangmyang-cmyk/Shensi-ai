import assert from "node:assert/strict";
import SwaggerParser from "@apidevtools/swagger-parser";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildGrowthContractRelease } from "../scripts/build-growth-contract-release.mjs";

test("growth release derives the version directory and never overwrites different bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "growth-contract-release-"));
  try {
    const input = new URL("../openapi/growth-advisor-quote-roi.v1.yaml", import.meta.url);
    const firstRoot = path.join(root, "first");
    const secondRoot = path.join(root, "second");
    const firstManifest = await buildGrowthContractRelease({ input, releasesRoot: firstRoot });
    const secondManifest = await buildGrowthContractRelease({ input, releasesRoot: secondRoot });
    const first = path.join(firstRoot, firstManifest.contractVersion);
    const second = path.join(secondRoot, secondManifest.contractVersion);
    const bytes = await readFile(path.join(first, "openapi.json"));
    const expectedHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    assert.equal(firstManifest.contractVersion, "1.0.10");
    assert.equal(firstManifest.contractHash, expectedHash);
    assert.deepEqual(firstManifest, secondManifest);
    assert.deepEqual(bytes, await readFile(path.join(second, "openapi.json")));

    await buildGrowthContractRelease({ input, releasesRoot: firstRoot, check: true });
    const committedManifestBytes = await readFile(path.join(first, "manifest.json"));
    await writeFile(
      path.join(first, "manifest.json"),
      `${JSON.stringify({ ...firstManifest, contractHash: `sha256:${"9".repeat(64)}` }, null, 2)}\n`,
      "utf8"
    );
    await assert.rejects(
      buildGrowthContractRelease({ input, releasesRoot: firstRoot }),
      /immutable growth contract release collision for 1\.0\.10/u
    );
    await writeFile(path.join(first, "manifest.json"), committedManifestBytes);
    await writeFile(path.join(first, "openapi.json"), "{}\n", "utf8");
    await assert.rejects(
      buildGrowthContractRelease({ input, releasesRoot: firstRoot }),
      /immutable growth contract release collision for 1\.0\.10/u
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the committed council releases discard invalid intermediates and retain the valid 1.0.6 baseline", async () => {
  const releasesRoot = new URL("../releases/growth-advisor-quote-roi/", import.meta.url);
  const versions = await readdir(releasesRoot);
  assert.equal(versions.includes("1.0.4"), false);
  assert.equal(versions.includes("1.0.5"), false);
  assert.equal(versions.includes("1.0.6"), true);
});

test("publishing a successor preserves the immutable 1.0.0 release bytes", async () => {
  const release = new URL("../releases/growth-advisor-quote-roi/1.0.0/", import.meta.url);
  const openApi = await readFile(new URL("openapi.json", release));
  const manifest = await readFile(new URL("manifest.json", release));

  assert.equal(
    createHash("sha256").update(openApi).digest("hex"),
    "fb38e95326241fbc3fb5a4e3b75bc572b3fb3944baedd0ecbcf2117a7fcbe707"
  );
  assert.equal(
    createHash("sha256").update(manifest).digest("hex"),
    "85ac612f8ac8b933786b642579141d5545b5b713262cd2681c4dc6eaef62efe0"
  );
});

test("publishing 1.0.3 preserves the immutable 1.0.1 release bytes", async () => {
  const release = new URL("../releases/growth-advisor-quote-roi/1.0.1/",
    import.meta.url);
  assert.equal(createHash("sha256").update(
    await readFile(new URL("openapi.json", release))).digest("hex"),
  "a535375d2d7c83d9454fa17ce5178bb2d5fb1ac875747e6466979bd1991692fe");
  assert.equal(createHash("sha256").update(
    await readFile(new URL("manifest.json", release))).digest("hex"),
  "d3008bf5d84d4583c38740605808cfa70e6d717db64534cb13dd68110def13ed");
});

test("growth release resolves YAML merges into a valid OpenAPI document", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "growth-contract-release-"));
  try {
    const input = new URL("../openapi/growth-advisor-quote-roi.v1.yaml", import.meta.url);
    const releasesRoot = path.join(root, "releases");
    const manifest = await buildGrowthContractRelease({ input, releasesRoot });
    const bytes = await readFile(
      path.join(releasesRoot, manifest.contractVersion, "openapi.json")
    );
    const document = JSON.parse(bytes);
    const operation = document.paths["/api/v1/catalog/items"].post;

    assert.doesNotMatch(bytes.toString("utf8"), /"<<"/u);
    assert.deepEqual(operation.security, [
      { bearerAuth: [] },
      { cookieAuth: [], csrfToken: [] }
    ]);
    assert.deepEqual(operation.parameters, [
      { $ref: "#/components/parameters/workspaceHeader" },
      { $ref: "#/components/parameters/idempotencyKey" }
    ]);
    assert.deepEqual(Object.keys(operation.responses).sort(), ["201", "400", "401", "403", "409", "422"]);
    await assert.doesNotReject(SwaggerParser.validate(document, {}));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

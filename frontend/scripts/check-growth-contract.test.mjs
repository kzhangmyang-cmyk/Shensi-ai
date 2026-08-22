import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  verifyPinnedGrowthContractAt,
  verifyPinnedMatchesCanonicalReleaseAt
} from "./check-growth-contract.mjs";
import { importGrowthContract } from "./import-growth-contract.mjs";

async function writeCanonicalRelease(root, version = "1.0.10") {
  const openapi = Buffer.from('{"openapi":"3.1.0"}\n');
  const manifest = {
    name: "growth-advisor-quote-roi",
    contractVersion: version,
    contractHash: `sha256:${createHash("sha256").update(openapi).digest("hex")}`,
    openapiVersion: "3.1.0"
  };
  await writeFile(path.join(root, "openapi.json"), openapi);
  await writeFile(
    path.join(root, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  return { manifest, openapi };
}

test("pinned contract rejects a manifest whose hash is not the OpenAPI bytes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "growth-pin-"));
  try {
    const openapi = Buffer.from('{"openapi":"3.1.0"}\n');
    await writeFile(
      path.join(root, "growth-advisor-quote-roi.openapi.json"),
      openapi
    );
    await writeFile(
      path.join(root, "growth-advisor-quote-roi.manifest.json"),
      JSON.stringify({
        name: "growth-advisor-quote-roi",
        contractVersion: "1.0.0",
        contractHash: `sha256:${createHash("sha256")
          .update("different").digest("hex")}`,
        openapiVersion: "3.1.0"
      })
    );
    await assert.rejects(
      verifyPinnedGrowthContractAt(root),
      /Pinned growth contract hash mismatch/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("contract generator dependencies are declared exactly", async () => {
  const packageJson = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url), "utf8"
  ));
  assert.equal(packageJson.devDependencies["openapi-typescript"], "7.13.0");
  assert.equal(packageJson.devDependencies.yaml, "2.8.1");
});

test("import renames the backend canonical release into the pinned layout", async () => {
  const releaseRoot = await mkdtemp(path.join(tmpdir(), "growth-release-"));
  const pinnedRoot = await mkdtemp(path.join(tmpdir(), "growth-pinned-"));
  try {
    const { manifest, openapi } = await writeCanonicalRelease(releaseRoot);
    assert.deepEqual(
      await importGrowthContract(releaseRoot, pinnedRoot),
      manifest
    );
    assert.deepEqual(
      await readFile(path.join(
        pinnedRoot, "growth-advisor-quote-roi.openapi.json"
      )),
      openapi
    );
    assert.equal(
      JSON.parse(await readFile(path.join(
        pinnedRoot, "growth-advisor-quote-roi.manifest.json"
      ), "utf8")).contractVersion,
      "1.0.10"
    );
  } finally {
    await Promise.all([
      rm(releaseRoot, { recursive: true, force: true }),
      rm(pinnedRoot, { recursive: true, force: true })
    ]);
  }
});

test("pinned release verifies against its own manifest hash", async () => {
  const manifest = await verifyPinnedGrowthContractAt(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "contracts",
      "pinned"
    )
  );
  assert.equal(manifest.contractVersion, "1.0.10");
});

test("pinned release must identify the canonical monorepo release", async () => {
  const pinnedRoot = await mkdtemp(path.join(tmpdir(), "growth-pinned-"));
  const sourceRelease = await mkdtemp(path.join(tmpdir(), "growth-source-"));
  const canonicalRelease = await mkdtemp(path.join(tmpdir(), "growth-canonical-"));
  try {
    await writeCanonicalRelease(sourceRelease, "1.0.10");
    await writeCanonicalRelease(canonicalRelease, "1.0.9");
    await importGrowthContract(sourceRelease, pinnedRoot);
    await assert.rejects(
      verifyPinnedMatchesCanonicalReleaseAt(pinnedRoot, canonicalRelease),
      /Pinned growth contract identity mismatch/u
    );
  } finally {
    await Promise.all([
      rm(pinnedRoot, { recursive: true, force: true }),
      rm(sourceRelease, { recursive: true, force: true }),
      rm(canonicalRelease, { recursive: true, force: true })
    ]);
  }
});

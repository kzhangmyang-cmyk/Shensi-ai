import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CONTRACT_NAME = "growth-advisor-quote-roi";

function pinnedDirectory() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "contracts",
    "pinned"
  );
}

function canonicalReleaseDirectory() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "contracts",
    "releases",
    CONTRACT_NAME,
    "1.0.29"
  );
}

async function verifyGrowthContractAt(directory, openApiName, manifestName) {
  const openApiPath = path.join(directory, openApiName);
  const manifestPath = path.join(directory, manifestName);
  const [bytes, manifestText] = await Promise.all([
    readFile(openApiPath),
    readFile(manifestPath, "utf8")
  ]);
  const manifest = JSON.parse(manifestText);
  const actual = `sha256:${createHash("sha256")
    .update(bytes).digest("hex")}`;
  if (actual !== manifest.contractHash) {
    throw new Error("Pinned growth contract hash mismatch");
  }
  return manifest;
}

export async function verifyPinnedGrowthContractAt(directory) {
  return verifyGrowthContractAt(
    directory,
    `${CONTRACT_NAME}.openapi.json`,
    `${CONTRACT_NAME}.manifest.json`
  );
}

export async function verifyGrowthContractReleaseAt(directory) {
  return verifyGrowthContractAt(directory, "openapi.json", "manifest.json");
}

export async function verifyPinnedMatchesCanonicalReleaseAt(
  pinned,
  canonicalRelease
) {
  const [pinnedManifest, canonicalManifest] = await Promise.all([
    verifyPinnedGrowthContractAt(pinned),
    verifyGrowthContractReleaseAt(canonicalRelease)
  ]);
  for (const key of [
    "name",
    "contractVersion",
    "contractHash",
    "openapiVersion"
  ]) {
    if (pinnedManifest[key] !== canonicalManifest[key]) {
      throw new Error("Pinned growth contract identity mismatch");
    }
  }
  return pinnedManifest;
}

export async function verifyPinnedGrowthContract() {
  return verifyPinnedMatchesCanonicalReleaseAt(
    pinnedDirectory(),
    canonicalReleaseDirectory()
  );
}

function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined
    && pathToFileURL(path.resolve(entry)).href === metaUrl;
}

async function main(argv) {
  if (argv.length !== 0) throw new Error("Usage: check-growth-contract.mjs");
  await verifyPinnedGrowthContract();
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));

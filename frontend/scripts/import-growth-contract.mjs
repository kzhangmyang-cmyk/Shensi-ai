import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  verifyGrowthContractReleaseAt
} from "./check-growth-contract.mjs";

const CONTRACT_NAME = "growth-advisor-quote-roi";

function pinnedDirectory() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "contracts",
    "pinned"
  );
}

export async function importGrowthContract(
  releaseDirectory,
  destinationDirectory = pinnedDirectory()
) {
  const manifest = await verifyGrowthContractReleaseAt(releaseDirectory);
  if (manifest.name !== CONTRACT_NAME) {
    throw new Error("Pinned growth contract name mismatch");
  }
  await mkdir(destinationDirectory, { recursive: true });
  await Promise.all([
    copyFile(
      path.join(releaseDirectory, "openapi.json"),
      path.join(destinationDirectory, `${CONTRACT_NAME}.openapi.json`)
    ),
    copyFile(
      path.join(releaseDirectory, "manifest.json"),
      path.join(destinationDirectory, `${CONTRACT_NAME}.manifest.json`)
    )
  ]);
  return manifest;
}

function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined
    && pathToFileURL(path.resolve(entry)).href === metaUrl;
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== "--release") {
    throw new Error("Usage: import-growth-contract.mjs --release <directory>");
  }
  await importGrowthContract(path.resolve(argv[1]));
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));

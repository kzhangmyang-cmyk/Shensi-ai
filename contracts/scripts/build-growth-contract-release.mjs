import SwaggerParser from "@apidevtools/swagger-parser";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])])
  );
}

const strictSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

async function readReleaseBytes(outputDirectory) {
  return Promise.all([
    readFile(path.join(outputDirectory, "openapi.json")),
    readFile(path.join(outputDirectory, "manifest.json"))
  ]);
}

async function releaseDirectoryExists(outputDirectory) {
  try {
    const metadata = await stat(outputDirectory);
    if (!metadata.isDirectory()) throw new Error("growth release path is not a directory");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function buildGrowthContractRelease({ input, releasesRoot, check = false }) {
  const inputPath = input instanceof URL ? fileURLToPath(input) : input;
  const source = parseDocument(await readFile(inputPath, "utf8"), {
    merge: true,
    maxAliasCount: -1
  });
  if (source.errors.length > 0) throw source.errors[0];
  const bundled = await SwaggerParser.bundle(
    inputPath,
    source.toJS({ maxAliasCount: -1 }),
    {}
  );
  await SwaggerParser.validate(inputPath, structuredClone(bundled), {});
  const contractVersion = bundled.info?.version;
  if (typeof contractVersion !== "string" || !strictSemver.test(contractVersion)) {
    throw new Error("OpenAPI info.version must be a strict SemVer release directory name");
  }
  const outputDirectory = path.join(releasesRoot, contractVersion);
  const bytes = Buffer.from(`${JSON.stringify(canonical(bundled), null, 2)}\n`, "utf8");
  const manifest = {
    name: "growth-advisor-quote-roi",
    contractVersion,
    contractHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    openapiVersion: "3.1.0"
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  if (await releaseDirectoryExists(outputDirectory)) {
    let committedOpenApi;
    let committedManifest;
    try {
      [committedOpenApi, committedManifest] = await readReleaseBytes(outputDirectory);
    } catch (error) {
      throw new Error(`immutable growth contract release collision for ${contractVersion}`, { cause: error });
    }
    if (!committedOpenApi.equals(bytes) || !committedManifest.equals(manifestBytes)) {
      throw new Error(`immutable growth contract release collision for ${contractVersion}`);
    }
    return manifest;
  }
  if (check) throw new Error(`Committed growth contract release ${contractVersion} is missing`);
  await mkdir(releasesRoot, { recursive: true });
  await mkdir(outputDirectory);
  await writeFile(path.join(outputDirectory, "openapi.json"), bytes, { flag: "wx" });
  await writeFile(path.join(outputDirectory, "manifest.json"), manifestBytes, { flag: "wx" });
  return manifest;
}

function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === metaUrl;
}

async function main(argv) {
  const allowed = new Set(["--check", "--print-version"]);
  if (argv.some((argument) => !allowed.has(argument)) || new Set(argv).size !== argv.length) {
    throw new Error("Usage: build-growth-contract-release.mjs [--check] [--print-version]");
  }
  const manifest = await buildGrowthContractRelease({
    input: new URL("../openapi/growth-advisor-quote-roi.v1.yaml", import.meta.url),
    releasesRoot: fileURLToPath(
      new URL("../releases/growth-advisor-quote-roi/", import.meta.url)
    ),
    check: argv.includes("--check")
  });
  if (argv.includes("--print-version")) process.stdout.write(`${manifest.contractVersion}\n`);
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));

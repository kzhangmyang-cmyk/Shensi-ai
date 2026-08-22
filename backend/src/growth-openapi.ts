import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import {
  convertJsonSchema202012ToOpenApi30
} from "./acquisition-openapi.js";

export type GrowthOpenApiHttpMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete";

export type OpenApiPathItem = Partial<Record<
  GrowthOpenApiHttpMethod,
  Record<string, any>
>>;

export interface GrowthContractManifest {
  name: "growth-advisor-quote-roi";
  contractVersion: string;
  contractHash: `sha256:${string}`;
  openapiVersion: "3.1.0";
}

export interface GrowthContractRelease {
  manifest: Readonly<GrowthContractManifest>;
  document: Readonly<Record<string, any>>;
}

const releasesRoot = new URL(
  "../../contracts/releases/growth-advisor-quote-roi/",
  import.meta.url
);
const strictSemver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

interface ParsedSemver {
  core: readonly [bigint, bigint, bigint];
  prerelease: readonly string[] | null;
  precedenceKey: string;
}

function parseStrictSemver(value: string): ParsedSemver | null {
  if (!strictSemver.test(value)) return null;
  const withoutBuild = value.split("+", 1)[0];
  const prereleaseSeparator = withoutBuild.indexOf("-");
  const coreValue = prereleaseSeparator === -1
    ? withoutBuild
    : withoutBuild.slice(0, prereleaseSeparator);
  const prereleaseValue = prereleaseSeparator === -1
    ? undefined
    : withoutBuild.slice(prereleaseSeparator + 1);
  const [major, minor, patch] = coreValue.split(".").map(BigInt);
  return {
    core: [major, minor, patch],
    prerelease: prereleaseValue?.split(".") ?? null,
    precedenceKey: withoutBuild
  };
}

function compareSemver(
  left: ParsedSemver,
  right: ParsedSemver
) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] < right.core[index]) return -1;
    if (left.core[index] > right.core[index]) return 1;
  }
  if (left.prerelease === null) return right.prerelease === null ? 0 : 1;
  if (right.prerelease === null) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/u.test(leftIdentifier);
    const rightNumeric = /^\d+$/u.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

export function selectGrowthContractReleaseVersion(
  candidates: readonly string[]
): string {
  let selected: { value: string; parsed: ParsedSemver } | null = null;
  const versions = new Set(candidates);
  const directoriesByPrecedence = new Map<string, string>();
  for (const value of versions) {
    const parsed = parseStrictSemver(value);
    if (!parsed) continue;
    const existing = directoriesByPrecedence.get(parsed.precedenceKey);
    if (existing && existing !== value) {
      throw new Error("AMBIGUOUS_GROWTH_CONTRACT_RELEASE");
    }
    directoriesByPrecedence.set(parsed.precedenceKey, value);
    if (!selected) {
      selected = { value, parsed };
      continue;
    }
    const order = compareSemver(parsed, selected.parsed);
    if (order > 0) selected = { value, parsed };
  }
  if (!selected) throw new Error("GROWTH_CONTRACT_RELEASE_NOT_FOUND");
  return selected.value;
}

function currentReleaseRoot(): { root: URL; version: string } {
  const version = selectGrowthContractReleaseVersion(
    readdirSync(releasesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  );
  return {
    root: new URL(`${encodeURIComponent(version)}/`, releasesRoot),
    version
  };
}

function assertManifest(value: unknown): GrowthContractManifest {
  const manifest = value as Partial<GrowthContractManifest> | null;
  if (
    !manifest
    || manifest.name !== "growth-advisor-quote-roi"
    || typeof manifest.contractVersion !== "string"
    || parseStrictSemver(manifest.contractVersion) === null
    || !/^sha256:[0-9a-f]{64}$/u.test(manifest.contractHash ?? "")
    || manifest.openapiVersion !== "3.1.0"
  ) {
    throw new Error("INVALID_GROWTH_CONTRACT_MANIFEST");
  }
  return manifest as GrowthContractManifest;
}

let cachedRelease: GrowthContractRelease | undefined;

export function loadGrowthContractRelease(): GrowthContractRelease {
  if (cachedRelease) return cachedRelease;
  const currentRelease = currentReleaseRoot();
  const releaseRoot = currentRelease.root;
  const manifest = assertManifest(JSON.parse(readFileSync(
    new URL("manifest.json", releaseRoot),
    "utf8"
  )));
  if (manifest.contractVersion !== currentRelease.version) {
    throw new Error("GROWTH_CONTRACT_RELEASE_DIRECTORY_MISMATCH");
  }
  const openApiBytes = readFileSync(new URL("openapi.json", releaseRoot));
  const actualHash = `sha256:${createHash("sha256")
    .update(openApiBytes)
    .digest("hex")}`;
  if (actualHash !== manifest.contractHash) {
    throw new Error("GROWTH_CONTRACT_RELEASE_HASH_MISMATCH");
  }
  const document = JSON.parse(openApiBytes.toString("utf8"));
  if (
    document.openapi !== manifest.openapiVersion
    || document.info?.version !== manifest.contractVersion
    || !document.paths
  ) {
    throw new Error("GROWTH_CONTRACT_RELEASE_IDENTITY_MISMATCH");
  }
  cachedRelease = Object.freeze({
    manifest: Object.freeze({ ...manifest }),
    document: Object.freeze(document)
  });
  return cachedRelease;
}

function prepareReleasedSchema(
  value: unknown,
  source: Record<string, any>
): any {
  if (Array.isArray(value)) {
    return value.map((item) => prepareReleasedSchema(item, source));
  }
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === "string") {
    const match = /^#\/components\/schemas\/([^/]+)(\/.+)$/u.exec(
      record.$ref
    );
    if (!match) return { $ref: record.$ref };
    const target = resolveComponentAlias(source, record.$ref);
    if (target === undefined) {
      throw new Error(`MISSING_GROWTH_OPENAPI_REFERENCE:${record.$ref}`);
    }
    return prepareReleasedSchema(target, source);
  }
  const rewritten = Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "contains" && key !== "$defs")
    .map(([key, item]) => [
    key,
    prepareReleasedSchema(item, source)
  ]));
  if ("contains" in value) {
    const contains = prepareReleasedSchema(
      (value as Record<string, unknown>).contains
      , source
    );
    rewritten.allOf = [
      ...(Array.isArray(rewritten.allOf) ? rewritten.allOf : []),
      { not: { items: { not: contains } } }
    ];
  }
  return rewritten;
}

function convertReleasedSchema(
  value: unknown,
  source: Record<string, any>
): any {
  return convertJsonSchema202012ToOpenApi30(
    prepareReleasedSchema(value, source)
  );
}

function convertEmbeddedSchemas(
  value: unknown,
  source: Record<string, any>
): any {
  if (Array.isArray(value)) {
    return value.map((item) => convertEmbeddedSchemas(item, source));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    key === "schema"
      ? convertReleasedSchema(item, source)
      : convertEmbeddedSchemas(item, source)
  ]));
}

function decodePointerSegment(value: string) {
  return decodeURIComponent(value.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function resolveComponentAlias(
  root: Record<string, any>,
  reference: string
): unknown {
  if (!reference.startsWith("#/")) return { $ref: reference };
  let current: any = root;
  for (const segment of reference.slice(2).split("/")) {
    while (current && typeof current.$ref === "string") {
      current = resolveComponentAlias(root, current.$ref);
    }
    current = current?.[decodePointerSegment(segment)];
  }
  return current;
}

export function createGrowthOpenApiPaths(): Record<string, OpenApiPathItem> {
  const source = loadGrowthContractRelease().document as Record<string, any>;
  return convertEmbeddedSchemas(structuredClone(source.paths), source);
}

export function createGrowthOpenApiComponents(): Record<string, any> {
  const source = loadGrowthContractRelease().document as Record<string, any>;
  const components = structuredClone(source.components ?? {});
  components.schemas = Object.fromEntries(Object.entries(
    components.schemas ?? {}
  ).map(([name, schema]) => [
    name,
    convertReleasedSchema(
      schema && typeof schema === "object" && "$ref" in schema
        ? resolveComponentAlias(source, String((schema as any).$ref))
        : schema,
      source
    )
  ]));
  for (const key of Object.keys(components)) {
    if (key !== "schemas") {
      components[key] = convertEmbeddedSchemas(components[key], source);
    }
  }
  return components;
}

import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { readFile as readFileFs } from "node:fs/promises";

const execFileAsync = promisify(execFile);

function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

const OUTPUT_PATH = path.join(
  projectRoot(),
  "src",
  "generated",
  "growth-advisor-quote-roi.ts"
);

export async function generateGrowthContractTypes({ check }) {
  const openApiPath = path.join(
    projectRoot(),
    "contracts",
    "pinned",
    "growth-advisor-quote-roi.openapi.json"
  );
  const workdir = await mkdtemp(path.join(tmpdir(), "growth-types-"));
  try {
    const source = JSON.parse(await readFileFs(openApiPath, "utf8"));
    const normalized = normalizeOpenApiDefs(source);
    const normalizedPath = path.join(workdir, "growth-advisor-quote-roi.json");
    await writeFile(
      normalizedPath,
      `${JSON.stringify(normalized)}\n`,
      "utf8"
    );
    const { stdout } = await execFileAsync(
      path.join(projectRoot(), "node_modules", ".bin", "openapi-typescript"),
      [normalizedPath],
      { encoding: "utf8" }
    );
    const generated = `${stdout.trim()}\n`;
    if (check) {
      const existing = await readFile(OUTPUT_PATH, "utf8");
      if (existing !== generated) {
        throw new Error("Growth generated types are out of date");
      }
      return;
    }
    await writeFile(OUTPUT_PATH, generated, "utf8");
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

/** Promotes every nested JSON Schema `$defs` key into a top-level component
 *  (`<Schema>_<Def>`) and rewrites `#/components/schemas/<S>/$defs/<K>` refs
 *  to the new component, so openapi-typescript emits clean non-union types. */
export function normalizeOpenApiDefs(document) {
  const schemas = document.components?.schemas;
  if (!schemas || typeof schemas !== "object") return document;
  const fileToComponent = new Map();
  for (const [name, schema] of Object.entries(schemas)) {
    if (!schema || typeof schema !== "object") continue;
    const idMatch = typeof schema.$id === "string"
      ? /json-schema\/([A-Za-z0-9_-]+)\.v1\.schema\.json$/u.exec(schema.$id)
      : null;
    if (idMatch && !fileToComponent.has(idMatch[1])) {
      fileToComponent.set(idMatch[1], name);
    }
    const collectRefs = (value) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) collectRefs(item);
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        if (key === "$ref" && typeof item === "string") {
          const match = /json-schema\/([A-Za-z0-9_-]+)\.v1\.schema\.json/u
            .exec(item);
          if (match && !fileToComponent.has(match[1])) {
            fileToComponent.set(match[1], name);
          }
        } else {
          collectRefs(item);
        }
      }
    };
    collectRefs(schema);
  }
  const promoted = [];
  for (const [name, schema] of Object.entries(schemas)) {
    if (!schema || typeof schema !== "object") continue;
    const defs = schema.$defs;
    if (!defs || typeof defs !== "object") continue;
    for (const [key, value] of Object.entries(defs)) {
      const promotedName = `${name}_${key}`;
      schemas[promotedName] = structuredClone(value);
      promoted.push([`${name}/${key}`, promotedName]);
    }
  }
  const rewriteRefs = (value, currentSchema = null) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) rewriteRefs(item, currentSchema);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && typeof item === "string") {
        const internal = /^#\/\$defs\/([A-Za-z0-9_]+)$/u.exec(item);
        if (internal && currentSchema && schemas[`${currentSchema}_${internal[1]}`]) {
          value.$ref = `#/components/schemas/${currentSchema}_${internal[1]}`;
          continue;
        }
        const internalized = /^#\/components\/schemas\/([A-Za-z0-9_]+)\/(?:\$defs|%24defs)\/([A-Za-z0-9_]+)$/u
          .exec(item);
        if (internalized) {
          const promotedName = `${internalized[1]}_${internalized[2]}`;
          if (schemas[promotedName]) {
            value.$ref = `#/components/schemas/${promotedName}`;
            continue;
          }
        }
        const external = /([A-Za-z0-9_-]+)\.v1\.schema\.json#\/(?:\$defs|%24defs)\/([A-Za-z0-9_]+)$/u
          .exec(item);
        if (external) {
          const component = fileToComponent.get(external[1]);
          if (component) {
            const promotedName = `${component}_${external[2]}`;
            if (schemas[promotedName]) {
              value.$ref = `#/components/schemas/${promotedName}`;
              continue;
            }
          }
        }
      } else {
        const next = key === "schemas" && typeof item === "object"
          ? null : currentSchema;
        rewriteRefs(item, next);
      }
    }
  };
  for (const [name, schema] of Object.entries(schemas)) {
    rewriteRefs(schema, name);
  }
  rewriteRefs(document);
  return document;
}

function isMain(metaUrl) {
  const entry = process.argv[1];
  return entry !== undefined
    && pathToFileURL(path.resolve(entry)).href === metaUrl;
}

async function main(argv) {
  if (argv.some((argument) => argument !== "--check")) {
    throw new Error("Usage: generate-growth-contract-types.mjs [--check]");
  }
  await generateGrowthContractTypes({ check: argv.includes("--check") });
}

if (isMain(import.meta.url)) await main(process.argv.slice(2));

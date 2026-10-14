import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const contractsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repositoryRoot = path.resolve(contractsRoot, "..");

function parseArguments(arguments_) {
  const options = {
    check: false,
    input: path.join(contractsRoot, "openapi", "ai-acquisition.v1.yaml"),
    output: path.join(
      repositoryRoot,
      "frontend",
      "src",
      "generated",
      "ai-acquisition.ts"
    )
  };

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--check") {
      options.check = true;
      continue;
    }
    if (argument === "--input" || argument === "--output") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a path`);
      }
      options[argument.slice(2)] = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return options;
}

async function render(input) {
  const nodes = await openapiTS(pathToFileURL(input), {
    transform(schema) {
      // Normalize the loaded generation copy only. A server-side off default
      // must not make reference retrieval mandatory for legacy/voice callers.
      if (schema.type === "object" && schema.properties?.knowledgeMode?.default === "off"
          && !schema.required?.includes("knowledgeMode")) {
        delete schema.properties.knowledgeMode.default;
      }
    }
  });
  return astToString(nodes);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const generated = await render(options.input);

  if (options.check) {
    let committed;
    try {
      committed = await readFile(options.output, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw new Error(`Generated types are absent: ${options.output}`);
      }
      throw error;
    }
    if (committed !== generated) {
      throw new Error(`Generated types are stale: ${options.output}`);
    }
    return;
  }

  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, generated, "utf8");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

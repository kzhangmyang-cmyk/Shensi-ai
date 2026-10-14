import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const kinds = Object.freeze({
  "database-url": {
    filename: "database_url",
    validate(value) {
      let url;
      try {
        url = new URL(value);
      } catch {
        throw new Error("CLOUD_TEST_DATABASE_URL_INVALID");
      }
      if (
        url.protocol !== "mysql:"
        || !url.username
        || !url.password
        || !url.hostname.endsWith(".aivencloud.com")
        || url.searchParams.get("ssl-mode") !== "REQUIRED"
      ) {
        throw new Error("CLOUD_TEST_DATABASE_URL_INVALID");
      }
    }
  },
  ca: {
    filename: "mysql_ca.pem",
    validate(value) {
      if (!/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/u.test(value)) {
        throw new Error("CLOUD_TEST_CA_INVALID");
      }
    }
  }
});

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("CLOUD_TEST_SECRET_DIRECTORY_INVALID");
  }
  await chmod(path, 0o700);
}

async function writePrivateFile(path, value) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("CLOUD_TEST_SECRET_FILE_INVALID");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${value}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function ingest(kind, value) {
  const definition = kinds[kind];
  if (!definition) throw new Error("CLOUD_TEST_SECRET_KIND_INVALID");
  definition.validate(value);
  const root = resolve(process.env.SHENSI_CLOUD_TEST_RUNTIME_ROOT || ".runtime/cloud-test");
  const secretsDirectory = resolve(root, "secrets");
  await ensurePrivateDirectory(root);
  await ensurePrivateDirectory(secretsDirectory);
  await writePrivateFile(resolve(secretsDirectory, definition.filename), value);
}

const kind = process.argv[2];
await ingest(kind, await readStdin());
console.log(JSON.stringify({ ok: true, kind }));

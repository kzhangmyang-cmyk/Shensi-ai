import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function loadLocalEnv() {
  if (process.env.SHENSI_SKIP_LOCAL_ENV === "true") return;
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(currentDir, "../../.env"),
    resolve(process.cwd(), ".env")
  ];
  const envPath = candidates.find((path) => existsSync(path));
  if (!envPath) return;
  const content = readFileSync(envPath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const rawValue = trimmed.slice(index + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

/** Trusted backend configuration, never request/Renderer settings. */
export function readReferenceRuntime(environment = process.env) {
  const mode = environment.SHENSI_REFERENCE_MODE ?? 'disabled';
  const origin = environment.SHENSI_REFERENCE_ORIGIN;
  const issuer = environment.SHENSI_REFERENCE_ISSUER;
  const backendInstanceId = environment.SHENSI_REFERENCE_BACKEND_INSTANCE_ID;
  const corpusId = environment.SHENSI_REFERENCE_CORPUS_ID;
  const packPath = environment.SHENSI_REFERENCE_PACK;
  const packHash = environment.SHENSI_REFERENCE_PACK_SHA256;
  const allowed = ['SHENSI_REFERENCE_MODE','SHENSI_REFERENCE_ORIGIN','SHENSI_REFERENCE_ISSUER','SHENSI_REFERENCE_BACKEND_INSTANCE_ID','SHENSI_REFERENCE_CORPUS_ID','SHENSI_REFERENCE_PACK','SHENSI_REFERENCE_PACK_SHA256'];
  try {
    if (Object.keys(environment).some(key => key.startsWith('SHENSI_REFERENCE_') && !allowed.includes(key))) throw Error();
    if (mode === 'embedded') {
      if (!packPath || !isAbsolute(packPath) || !packHash || !/^[a-f0-9]{64}$/.test(packHash)
        || origin !== undefined || issuer !== undefined || backendInstanceId !== undefined || corpusId !== undefined) throw Error();
      return { mode, packPath, packHash };
    }
    if (packPath !== undefined || packHash !== undefined) throw Error();
    if (mode === 'disabled') {
      if (origin !== undefined || issuer !== undefined || backendInstanceId !== undefined || corpusId !== undefined) throw Error();
      return { mode: 'disabled' };
    }
    if (!['client','central'].includes(mode) || !origin || issuer !== origin || !backendInstanceId
      || backendInstanceId.length > 191 || !/^[A-Za-z0-9_-]+$/.test(backendInstanceId)) throw Error();
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || url.search || url.hash) throw Error();
    if (mode === 'central') {
      if (!corpusId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(corpusId)) throw Error();
      return { mode, origin, issuer, backendInstanceId, corpusId };
    }
    if (corpusId !== undefined) throw Error();
    return { mode, origin, issuer, backendInstanceId };
  } catch { throw new Error('reference_configuration_invalid'); }
}

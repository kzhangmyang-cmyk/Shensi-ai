import { readFile } from "node:fs/promises";
import path from "node:path";

export interface RemoteOriginOptions {
  production: boolean;
  resourcesPath: string;
  environment: Record<string, string | undefined>;
}

export interface RemoteDesktopRuntime {
  mode?: 'remote';
  remoteOrigin: string;
  dataEnvironment: "production" | "development" | "test";
  testId?: string;
}
export type DesktopRuntime = RemoteDesktopRuntime | { mode: 'standalone'; dataEnvironment: 'production' | 'development' };

/** Local installation acceptance must never reuse a customer's profile or device identity. */
export async function resolveDesktopRuntime(options: RemoteOriginOptions): Promise<DesktopRuntime> {
  if (!options.production && options.environment.SHENSI_DESKTOP_MODE === 'standalone')
    return { mode: 'standalone', dataEnvironment: 'development' };
  if (options.production) {
    const config = JSON.parse(await readFile(path.join(options.resourcesPath, 'desktop-config.json'), 'utf8'));
    if (config?.mode === 'standalone') {
      if (Object.keys(config).length !== 1) throw new Error('desktop config has unexpected fields');
      return { mode: 'standalone', dataEnvironment: 'production' };
    }
  }
  const remoteOrigin = await resolveRemoteOrigin(options);
  if (options.production && remoteOrigin.startsWith("http://127.0.0.1:")) {
    return { remoteOrigin, dataEnvironment: "test", testId: "packaged-local" };
  }
  return { remoteOrigin, dataEnvironment: options.production ? "production" : "development" };
}

const PLACEHOLDER_HOSTS = new Set(["example.com", "api.example.com", "localhost"]);

function validatedOrigin(value: unknown): string {
  if (typeof value !== "string") throw new Error("desktop remote origin is missing");
  let origin: URL;
  try { origin = new URL(value); }
  catch { throw new Error("desktop remote origin is invalid"); }
  if (origin.username || origin.password || origin.pathname !== "/"
    || origin.search || origin.hash || origin.origin !== value.replace(/\/$/u, "")) {
    throw new Error("desktop remote origin must be an exact origin");
  }
  const isHttps = origin.protocol === "https:";
  const isDevelopmentLoopback = origin.protocol === "http:"
    && origin.hostname === "127.0.0.1" && origin.port !== "";
  if (!isHttps && !isDevelopmentLoopback) {
    throw new Error("desktop remote origin must use HTTPS or loopback development HTTP at exact 127.0.0.1 with a port");
  }
  if (PLACEHOLDER_HOSTS.has(origin.hostname)
    || origin.hostname.endsWith(".example") || origin.hostname.endsWith(".invalid")
    || origin.hostname.endsWith(".test") || origin.hostname.endsWith(".localhost")) {
    throw new Error("desktop remote origin must not use a placeholder hostname");
  }
  return origin.origin;
}

export async function resolveRemoteOrigin(options: RemoteOriginOptions): Promise<string> {
  if (!options.production) {
    return validatedOrigin(options.environment.SHENSI_REMOTE_ORIGIN);
  }
  const raw = await readFile(path.join(options.resourcesPath, "desktop-config.json"), "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new Error("desktop config must be a plain object");
  }
  const fields = Object.keys(parsed);
  if (fields.length !== 1 || fields[0] !== "remoteOrigin")
    throw new Error("desktop config has unexpected fields");
  return validatedOrigin((parsed as { remoteOrigin?: unknown }).remoteOrigin);
}

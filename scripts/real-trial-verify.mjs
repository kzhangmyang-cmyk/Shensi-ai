import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function verifyTrialRuntime({ origin, fetchImpl = fetch }) {
  const gateway = await fetchImpl(`${origin}/healthz`);
  const backend = await fetchImpl(`${origin}/api/health`);
  const protectedResponse = await fetchImpl(`${origin}/api/auth/me`);
  const isolated = await fetchImpl(`${origin}/internal/v1/health`);
  if (!gateway.ok || !backend.ok) throw new Error("TRIAL_GATEWAY_OR_BACKEND_UNHEALTHY");
  if (protectedResponse.status !== 401) throw new Error("TRIAL_PROTECTED_ROUTE_NOT_AUTHENTICATED");
  if (isolated.status !== 404) throw new Error("TRIAL_INTERNAL_ROUTE_EXPOSED");
  return { ok: true };
}
if (process.argv[1]?.endsWith("real-trial-verify.mjs")) {
  const runtimeRoot = resolve(process.env.SHENSI_TRIAL_RUNTIME_ROOT ?? resolve(import.meta.dirname, "..", ".runtime/real-trial"));
  const origin = process.env.SHENSI_TRIAL_ORIGIN
    ?? (await readFile(resolve(runtimeRoot, "status.json"), "utf8").then((value) => JSON.parse(value).origin));
  if (typeof origin !== "string" || !origin) throw new Error("TRIAL_ORIGIN_UNAVAILABLE");
  verifyTrialRuntime({ origin }).then(() => console.log("TRIAL_VERIFY_OK")).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

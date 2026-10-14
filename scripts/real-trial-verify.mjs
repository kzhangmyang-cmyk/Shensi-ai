import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const publicVerificationRequestTimeoutMs = 5_000;
const publicVerificationRetryDelaysMs = Object.freeze([
  250, 500, 1_000, 2_000, 4_000
]);

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function boundedFetch(fetchImpl, url, requestTimeoutMs) {
  try {
    return await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(requestTimeoutMs)
    });
  } catch {
    return null;
  }
}

async function verifyPublicContractOnce({
  origin,
  fetchImpl,
  requestTimeoutMs
}) {
  const gateway = await boundedFetch(
    fetchImpl, `${origin}/healthz`, requestTimeoutMs
  );
  if (!gateway) return "TRIAL_PUBLIC_VERIFICATION_UNAVAILABLE";
  if (!gateway.ok) return "TRIAL_GATEWAY_OR_BACKEND_UNHEALTHY";

  const backend = await boundedFetch(
    fetchImpl, `${origin}/api/health`, requestTimeoutMs
  );
  if (!backend) return "TRIAL_PUBLIC_VERIFICATION_UNAVAILABLE";
  if (!backend.ok) return "TRIAL_GATEWAY_OR_BACKEND_UNHEALTHY";

  const protectedResponse = await boundedFetch(
    fetchImpl, `${origin}/api/auth/me`, requestTimeoutMs
  );
  if (!protectedResponse) return "TRIAL_PUBLIC_VERIFICATION_UNAVAILABLE";
  if (protectedResponse.status !== 401) {
    throw new Error("TRIAL_PROTECTED_ROUTE_NOT_AUTHENTICATED");
  }

  const isolated = await boundedFetch(
    fetchImpl, `${origin}/internal/v1/health`, requestTimeoutMs
  );
  if (!isolated) return "TRIAL_PUBLIC_VERIFICATION_UNAVAILABLE";
  if (isolated.status !== 404) {
    throw new Error("TRIAL_INTERNAL_ROUTE_EXPOSED");
  }
  return null;
}

export async function verifyTrialRuntime({
  origin,
  fetchImpl = fetch,
  requestTimeoutMs = publicVerificationRequestTimeoutMs,
  retryDelaysMs = publicVerificationRetryDelaysMs
}) {
  let transientFailure = "TRIAL_PUBLIC_VERIFICATION_UNAVAILABLE";
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    transientFailure = await verifyPublicContractOnce({
      origin,
      fetchImpl,
      requestTimeoutMs
    });
    if (!transientFailure) return { ok: true };
    if (attempt < retryDelaysMs.length) {
      await wait(retryDelaysMs[attempt]);
    }
  }
  throw new Error(transientFailure);
}
if (process.argv[1]?.endsWith("real-trial-verify.mjs")) {
  const runtimeRoot = resolve(process.env.SHENSI_TRIAL_RUNTIME_ROOT ?? resolve(import.meta.dirname, "..", ".runtime/real-trial"));
  const origin = process.env.SHENSI_TRIAL_ORIGIN
    ?? (await readFile(resolve(runtimeRoot, "status.json"), "utf8").then((value) => JSON.parse(value).origin));
  if (typeof origin !== "string" || !origin) throw new Error("TRIAL_ORIGIN_UNAVAILABLE");
  verifyTrialRuntime({ origin }).then(() => console.log("TRIAL_VERIFY_OK")).catch((error) => { console.error(error.message); process.exitCode = 1; });
}

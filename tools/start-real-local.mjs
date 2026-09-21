import { spawn } from "node:child_process";
import { readLocalRealRuntimeConfig } from "../backend/scripts/local-real-runtime.ts";

const config = readLocalRealRuntimeConfig(process.env);
const baseEnv = { ...process.env };
const children = [
  spawn("pnpm", ["--filter", "./backend", "dev"], {
    env: {
      ...baseEnv,
      CRM_STORE: "mysql",
      PORT: "4188",
      BACKEND_HOST: "127.0.0.1"
    },
    stdio: "inherit"
  }),
  spawn(
    "pnpm",
    ["--filter", "./frontend", "dev", "--", "--host", "127.0.0.1", "--port", "5188"],
    {
      env: {
        ...baseEnv,
        VITE_API_TARGET: config.backendOrigin
      },
      stdio: "inherit"
    }
  )
];

let stopping = false;
function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}
for (const child of children) {
  child.once("error", () => {
    stop("SIGTERM");
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (!stopping) stop("SIGTERM");
    if (code && code !== 0) process.exitCode = code;
    if (signal && !["SIGINT", "SIGTERM"].includes(signal)) process.exitCode = 1;
  });
}

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

const marker = process.argv.indexOf("--");
const nonce = process.argv[process.argv.indexOf("--runtime-nonce") + 1];
const logPath = process.argv[process.argv.indexOf("--log") + 1];
if (!/^[a-f0-9]{32}$/u.test(nonce ?? "") || marker < 0 || !logPath) throw new Error("TRIAL_CHILD_ARGUMENTS_INVALID");
const target = JSON.parse(Buffer.from(process.argv[marker + 1] ?? "", "base64url").toString("utf8"));
if (!target || typeof target.command !== "string" || !Array.isArray(target.args) || !target.args.every((value) => typeof value === "string")) throw new Error("TRIAL_CHILD_TARGET_INVALID");
const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
const child = spawn(target.command, target.args, { cwd: process.cwd(), env: process.env, detached: false, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
const stop = (signal) => { try { child.kill(signal); } catch {} };
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
child.once("exit", (code, signal) => { log.end(); process.exitCode = code ?? (signal ? 1 : 0); });

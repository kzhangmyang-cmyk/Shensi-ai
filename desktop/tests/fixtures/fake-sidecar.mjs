import { readFileSync } from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";

const mode = process.env.FAKE_SIDECAR_MODE ?? "normal";
if (mode === "early-exit") process.exit(12);
const token = readFileSync(process.env.MEDIACRAWLER_SERVICE_SECRET_FILE, "utf8").trim();
if (["descendant", "cooperative-descendant", "crash-descendant"].includes(mode)) {
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
  if (process.env.FAKE_DESCENDANT_PID_FILE) (await import("node:fs")).writeFileSync(process.env.FAKE_DESCENDANT_PID_FILE, String(child.pid));
}
const server = http.createServer((request, response) => {
  const authenticated = request.headers.authorization === `Bearer ${mode === "bad-health" ? "wrong" : token}`;
  if (!authenticated) { response.writeHead(401); response.end('{"detail":"unauthorized"}'); return; }
  response.setHeader("content-type", "application/json");
  response.end('{"ok":true,"service":"shensi-mediacrawler","upstream_commit":"d6f7c5bb906b6dac40ddf343ef9e26438a3de092"}');
});
server.listen(0, "127.0.0.1", () => {
  if (mode === "verbose") { process.stdout.write("out".repeat(40_000)); process.stderr.write("err".repeat(40_000)); }
  if (mode === "invalid-ready") awaitImportWriteStream(3).end("not-json\n");
  else if (mode !== "no-ready") {
    const record = { type: "shensi-sidecar-ready", protocolVersion: 1, pid: mode === "bad-pid" ? 999999 : process.pid, port: server.address().port };
    if (mode === "extra-ready") record.extra = true;
    const message = JSON.stringify(record);
    const stream = awaitImportWriteStream(3);
    if (mode === "delayed-duplicate-ready") { stream.write(`${message}\n`); setTimeout(() => stream.end(`${message}\n`), 100); }
    else stream.end(mode === "duplicate-ready" ? `${message}\n${message}\n` : `${message}\n`);
  }
  if (mode === "crash") setTimeout(() => process.exit(19), 80);
  if (mode === "crash-descendant") setTimeout(() => process.exit(19), 350);
});
function awaitImportWriteStream(fd) {
  const { createWriteStream } = requireShim;
  return createWriteStream(null, { fd });
}
import { createWriteStream } from "node:fs";
const requireShim = { createWriteStream };
process.on("SIGTERM", () => {
  if (mode === "ignore-term" || mode === "descendant" || mode === "crash-descendant") return;
  server.close(() => process.exit(0));
});

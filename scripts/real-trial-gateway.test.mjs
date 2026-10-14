import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { connect } from "node:net";
import test from "node:test";
import { createTrialGateway } from "./real-trial-gateway.mjs";

async function listen(server) { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return server.address().port; }
async function close(server) { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }

async function websocketProbe({ port, path, payload }) {
  const key = Buffer.from("shensi-live-login-probe").toString("base64");
  const socket = connect({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write([
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${key}`,
    "",
    ""
  ].join("\r\n"));
  let received = Buffer.alloc(0);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("websocket probe timed out")), 2_000);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      const boundary = received.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const body = received.subarray(boundary + 4);
      if (!body.includes(payload)) {
        socket.write(payload);
        return;
      }
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  socket.destroy();
  return received;
}

async function upgradeStatus(port, path) {
  const socket = connect({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
  const status = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("upgrade status timed out")), 2_000);
    socket.once("data", (chunk) => {
      clearTimeout(timeout);
      resolve(chunk.toString("latin1").split("\r\n", 1)[0]);
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  socket.destroy();
  return status;
}

test("gateway transparently routes frontend and API traffic while owning healthz", async (t) => {
  let publicHost = "";
  let observedBackendHost = "";
  const backend = createServer((request, response) => {
    assert.equal(request.headers["x-csrf-token"], "csrf-fixture");
    assert.equal(request.headers.cookie, "session=fixture");
    assert.equal(request.headers["x-forwarded-proto"], "https");
    observedBackendHost = request.headers.host ?? "";
    response.writeHead(201, { "set-cookie": "backend=ok; HttpOnly", "content-type": "text/plain" });
    response.end(`backend:${request.url}`);
  });
  const frontend = createServer((request, response) => response.end(`frontend:${request.url}`));
  const backendPort = await listen(backend);
  const frontendPort = await listen(frontend);
  const gateway = createTrialGateway({ host: "127.0.0.1", port: 0, backend: `http://127.0.0.1:${backendPort}`, frontend: `http://127.0.0.1:${frontendPort}` });
  await gateway.start();
  publicHost = new URL(gateway.origin()).host;
  t.after(async () => { await gateway.stop(); await close(backend); await close(frontend); });
  const origin = gateway.origin();
  const api = await fetch(`${origin}/api/health`, { headers: { cookie: "session=fixture", "x-csrf-token": "csrf-fixture" } });
  assert.equal(api.status, 201);
  assert.equal(observedBackendHost, publicHost);
  assert.equal(await api.text(), "backend:/api/health");
  assert.equal(api.headers.get("set-cookie"), "backend=ok; HttpOnly");
  assert.equal(await (await fetch(`${origin}/dashboard`)).text(), "frontend:/dashboard");
  for (const path of ["/internal/v1/health", "/docs", "/openapi.json", "/.runtime/trial.env", "/src/app.ts"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404, path);
    assert.equal(await response.text(), "not found");
  }
  assert.equal(await (await fetch(`${origin}/healthz`)).text(), "ok");
});

test("gateway upgrades one opaque live-login path to the sidecar WebSocket", async (t) => {
  const token = "a".repeat(43);
  const payload = Buffer.from("live-login-duplex-probe");
  let observedPath = "";
  let observedForwardedProto = "";
  const mediaSockets = new Set();
  const mediaCrawler = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  mediaCrawler.on("upgrade", (request, socket) => {
    mediaSockets.add(socket);
    socket.once("close", () => mediaSockets.delete(socket));
    observedPath = request.url ?? "";
    observedForwardedProto = String(request.headers["x-forwarded-proto"] ?? "");
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n"));
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const frontend = createServer((_request, response) => response.end("frontend"));
  const backend = createServer((_request, response) => response.end("backend"));
  const mediaCrawlerPort = await listen(mediaCrawler);
  const frontendPort = await listen(frontend);
  const backendPort = await listen(backend);
  const gateway = createTrialGateway({
    host: "127.0.0.1",
    port: 0,
    backend: `http://127.0.0.1:${backendPort}`,
    frontend: `http://127.0.0.1:${frontendPort}`,
    mediaCrawler: `http://127.0.0.1:${mediaCrawlerPort}`
  });
  await gateway.start();
  t.after(async () => {
    for (const socket of mediaSockets) socket.destroy();
    await gateway.stop();
    await Promise.all([close(mediaCrawler), close(frontend), close(backend)]);
  });

  const port = Number(new URL(gateway.origin()).port);
  const received = await websocketProbe({
    port,
    path: `/douyin-live/${token}`,
    payload
  });

  assert.match(received.toString("latin1"), /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(received.toString("latin1"), /\r\nSec-WebSocket-Accept: [A-Za-z0-9+/=]+\r\n/u);
  assert.equal(observedPath, `/internal/v1/douyin/live/${token}`);
  assert.equal(observedForwardedProto, "https");
});

test("gateway rejects live-login upgrades that do not carry one opaque token", async (t) => {
  let upstreamUpgrades = 0;
  const mediaCrawler = createServer();
  mediaCrawler.on("upgrade", (_request, socket) => {
    upstreamUpgrades += 1;
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: close\r\n\r\n");
  });
  const mediaCrawlerPort = await listen(mediaCrawler);
  const gateway = createTrialGateway({
    host: "127.0.0.1",
    port: 0,
    backend: "http://127.0.0.1:9",
    frontend: "http://127.0.0.1:9",
    mediaCrawler: `http://127.0.0.1:${mediaCrawlerPort}`
  });
  await gateway.start();
  t.after(async () => { await gateway.stop(); await close(mediaCrawler); });

  const port = Number(new URL(gateway.origin()).port);
  assert.equal(await upgradeStatus(port, "/douyin-live/short"), "HTTP/1.1 404 Not Found");
  assert.equal(await upgradeStatus(port, `/douyin-live/${"a".repeat(42)}`), "HTTP/1.1 404 Not Found");
  assert.equal(await upgradeStatus(port, `/douyin-live/${"a".repeat(43)}/extra`), "HTTP/1.1 404 Not Found");
  assert.equal(upstreamUpgrades, 0);
});

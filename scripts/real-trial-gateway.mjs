import { createServer, request as httpRequest } from "node:http";
const hopByHop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
const liveLoginPath = /^\/douyin-live\/([A-Za-z0-9_-]{43,128})$/u;

function forwardedHeaders(incoming, host) {
  const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !hopByHop.has(name.toLowerCase())));
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-host"] = incoming.headers.host ?? host;
  headers["x-forwarded-for"] = incoming.socket.remoteAddress ?? "127.0.0.1";
  return headers;
}

function rejectUpgrade(socket, status = "404 Not Found") {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function serializedHeaders(rawHeaders) {
  const lines = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    lines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`);
  }
  return lines.join("\r\n");
}

export function createTrialGateway({ host = "127.0.0.1", port = 5608, backend, frontend, mediaCrawler }) {
  let server;
  const upgradedSockets = new Set();
  const handler = (incoming, outgoing) => {
    if (incoming.url === "/healthz") { outgoing.writeHead(200, { "content-type": "text/plain" }); outgoing.end("ok"); return; }
    if (incoming.url?.startsWith("/douyin-live/")) { outgoing.writeHead(426, { "content-type": "text/plain" }); outgoing.end("websocket upgrade required"); return; }
    if (/^\/(?:internal(?:\/|$)|docs(?:\/|$)|openapi(?:[./]|$)|\.runtime(?:\/|$)|\.|(?:src|scripts|backend)(?:\/|$))/u.test(incoming.url ?? "")) {
      outgoing.writeHead(404, { "content-type": "text/plain" }); outgoing.end("not found"); return;
    }
    const upstream = new URL(incoming.url === "/api" || incoming.url?.startsWith("/api/") ? backend : frontend);
    const headers = forwardedHeaders(incoming, host);
    const proxied = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: incoming.url, method: incoming.method, headers }, (response) => { const safe = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !hopByHop.has(name.toLowerCase()))); outgoing.writeHead(response.statusCode ?? 502, safe); response.pipe(outgoing); });
    proxied.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "application/json" }); outgoing.end('{"message":"upstream_unavailable"}'); }); incoming.pipe(proxied);
  };
  const upgrade = (incoming, socket, head) => {
    const match = liveLoginPath.exec(incoming.url ?? "");
    if (!match || !mediaCrawler) { rejectUpgrade(socket); return; }
    const upstream = new URL(mediaCrawler);
    const headers = forwardedHeaders(incoming, host);
    headers.host = upstream.host;
    headers.connection = "Upgrade";
    headers.upgrade = "websocket";
    const proxied = httpRequest({
      hostname: upstream.hostname,
      port: upstream.port,
      path: `/internal/v1/douyin/live/${match[1]}`,
      method: "GET",
      headers
    });
    proxied.once("upgrade", (response, upstreamSocket, upstreamHead) => {
      upgradedSockets.add(socket);
      upgradedSockets.add(upstreamSocket);
      const forget = (value) => upgradedSockets.delete(value);
      socket.once("close", () => { forget(socket); upstreamSocket.destroy(); });
      upstreamSocket.once("close", () => { forget(upstreamSocket); socket.destroy(); });
      socket.write(`HTTP/1.1 ${response.statusCode ?? 101} ${response.statusMessage ?? "Switching Protocols"}\r\n${serializedHeaders(response.rawHeaders)}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      socket.pipe(upstreamSocket).pipe(socket);
    });
    proxied.once("response", (response) => {
      response.resume();
      rejectUpgrade(socket, `${response.statusCode ?? 502} ${response.statusMessage ?? "Bad Gateway"}`);
    });
    proxied.once("error", () => rejectUpgrade(socket, "502 Bad Gateway"));
    proxied.end();
  };
  return {
    async start() {
      server = createServer(handler);
      server.on("upgrade", upgrade);
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
    },
    async stop() {
      for (const socket of upgradedSockets) socket.destroy();
      upgradedSockets.clear();
      if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    origin() { const address = server?.address(); return `http://${host}:${typeof address === "object" && address ? address.port : port}`; }
  };
}
if (process.argv[1]?.endsWith("real-trial-gateway.mjs")) {
  const gateway = createTrialGateway({ host: "127.0.0.1", port: Number(process.env.PORT ?? 5608), backend: process.env.TRIAL_BACKEND_ORIGIN ?? "http://127.0.0.1:5611", frontend: process.env.TRIAL_FRONTEND_ORIGIN ?? "http://127.0.0.1:5610", mediaCrawler: process.env.MEDIACRAWLER_BASE_URL ?? "http://127.0.0.1:5612" });
  gateway.start().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

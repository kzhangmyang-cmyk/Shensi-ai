import { createServer, request as httpRequest } from "node:http";
const hopByHop = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
export function createTrialGateway({ host = "127.0.0.1", port = 5608, backend, frontend }) {
  let server;
  const handler = (incoming, outgoing) => {
    if (incoming.url === "/healthz") { outgoing.writeHead(200, { "content-type": "text/plain" }); outgoing.end("ok"); return; }
    if (/^\/(?:internal(?:\/|$)|docs(?:\/|$)|openapi(?:[./]|$)|\.runtime(?:\/|$)|\.|(?:src|scripts|backend)(?:\/|$))/u.test(incoming.url ?? "")) {
      outgoing.writeHead(404, { "content-type": "text/plain" }); outgoing.end("not found"); return;
    }
    const upstream = new URL(incoming.url === "/api" || incoming.url?.startsWith("/api/") ? backend : frontend);
    const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !hopByHop.has(name.toLowerCase())));
    headers["x-forwarded-proto"] = "https"; headers["x-forwarded-host"] = incoming.headers.host ?? host; headers["x-forwarded-for"] = incoming.socket.remoteAddress ?? "127.0.0.1";
    const proxied = httpRequest({ hostname: upstream.hostname, port: upstream.port, path: incoming.url, method: incoming.method, headers }, (response) => { const safe = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !hopByHop.has(name.toLowerCase()))); outgoing.writeHead(response.statusCode ?? 502, safe); response.pipe(outgoing); });
    proxied.on("error", () => { if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "application/json" }); outgoing.end('{"message":"upstream_unavailable"}'); }); incoming.pipe(proxied);
  };
  return { async start() { server = createServer(handler); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); }); }, async stop() { if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }, origin() { const address = server?.address(); return `http://${host}:${typeof address === "object" && address ? address.port : port}`; } };
}
if (process.argv[1]?.endsWith("real-trial-gateway.mjs")) {
  const gateway = createTrialGateway({ host: "127.0.0.1", port: Number(process.env.PORT ?? 5608), backend: process.env.TRIAL_BACKEND_ORIGIN ?? "http://127.0.0.1:5611", frontend: process.env.TRIAL_FRONTEND_ORIGIN ?? "http://127.0.0.1:5610" });
  gateway.start().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTrialGateway } from "./real-trial-gateway.mjs";

async function listen(server) { await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); return server.address().port; }
async function close(server) { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }

test("gateway transparently routes frontend and API traffic while owning healthz", async (t) => {
  const backend = createServer((request, response) => {
    assert.equal(request.headers["x-csrf-token"], "csrf-fixture");
    assert.equal(request.headers.cookie, "session=fixture");
    assert.equal(request.headers["x-forwarded-proto"], "https");
    response.writeHead(201, { "set-cookie": "backend=ok; HttpOnly", "content-type": "text/plain" });
    response.end(`backend:${request.url}`);
  });
  const frontend = createServer((request, response) => response.end(`frontend:${request.url}`));
  const backendPort = await listen(backend);
  const frontendPort = await listen(frontend);
  const gateway = createTrialGateway({ host: "127.0.0.1", port: 0, backend: `http://127.0.0.1:${backendPort}`, frontend: `http://127.0.0.1:${frontendPort}` });
  await gateway.start();
  t.after(async () => { await gateway.stop(); await close(backend); await close(frontend); });
  const origin = gateway.origin();
  const api = await fetch(`${origin}/api/health`, { headers: { cookie: "session=fixture", "x-csrf-token": "csrf-fixture" } });
  assert.equal(api.status, 201);
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

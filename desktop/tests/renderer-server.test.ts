import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from 'node:stream';
import { startRendererServer as startServer, rendererUpstreamBudget, type RendererServerOptions } from "../src/main/renderer-server.ts";

const BUILD_DIGEST = "a".repeat(64);
const startRendererServer = (options: Omit<RendererServerOptions, "buildManifestSha256">) =>
  startServer({ ...options, buildManifestSha256: BUILD_DIGEST });

const knowledgePath = '/api/v1/knowledge/documents/12345678-1234-1234-1234-123456789abc/versions/abcdef01-1234-1234-1234-123456789abc/content';
test('only exact knowledge binary GET/PUT use 120s and bounded original transfer budgets', () => {
  assert.equal(rendererUpstreamBudget('GET', knowledgePath).timeoutMs, 120_000);
  assert.equal(rendererUpstreamBudget('GET', knowledgePath).responseBytes, 50 * 1024 * 1024);
  assert.equal(rendererUpstreamBudget('PUT', knowledgePath).timeoutMs, 120_000);
  assert.equal(rendererUpstreamBudget('PUT', knowledgePath).responseBytes, 1024 * 1024);
  for (const [method, pathname] of [['POST', knowledgePath], ['GET', `${knowledgePath}/`], ['PUT', `${knowledgePath}-other`], ['PUT', '/api/v1/knowledge/documents/not-a-uuid/versions/not-a-uuid/content']]) {
    assert.equal(rendererUpstreamBudget(method, pathname).timeoutMs, 10_000);
    assert.equal(rendererUpstreamBudget(method, pathname).responseBytes, 1024 * 1024);
  }
});

test('knowledge upload forwards before local EOF and download forwards before upstream EOF', async t => {
  const distDir = await mkdtemp(path.join(tmpdir(), 'shensi-renderer-knowledge-'));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  let uploadObserved!: () => void, finishDownload!: () => void;
  const receivedUpload = new Promise<void>(resolve => { uploadObserved = resolve; });
  const upstream = createServer((incoming, outgoing) => {
    if (incoming.method === 'PUT') {
      assert.equal(incoming.headers.cookie, 'gj_session=synthetic');
      assert.equal(incoming.headers['x-csrf-token'], 'synthetic-csrf');
      assert.equal(incoming.headers['x-workspace-id'], 'synthetic-workspace');
      assert.equal(incoming.headers['x-shensi-desktop-build-manifest-sha256'], BUILD_DIGEST);
      incoming.once('data', uploadObserved); incoming.on('data', () => {}); incoming.on('end', () => outgoing.end('uploaded'));
    } else {
      outgoing.setHeader('Content-Type', 'application/octet-stream'); outgoing.write('first'); finishDownload = () => outgoing.end('last');
    }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address(); assert.ok(address && typeof address === 'object');
  const renderer = await startRendererServer({ distDir, remoteOrigin: `http://127.0.0.1:${address.port}` });
  t.after(async () => { await renderer.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const upload = httpRequest(`${renderer.origin}${knowledgePath}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream',
    Cookie: 'gj_session=synthetic', 'X-CSRF-Token': 'synthetic-csrf', 'X-Workspace-Id': 'synthetic-workspace',
    'X-Shensi-Desktop-Build-Manifest-SHA256': 'renderer-cannot-select-this' } });
  upload.on('error', () => {});
  upload.write(Buffer.alloc(2 * 1024 * 1024, 65));
  assert.equal(await Promise.race([receivedUpload.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 1000))]), true);
  const uploadDone = new Promise<number>(resolve => upload.once('response', res => { res.resume(); res.once('end', () => resolve(res.statusCode!)); }));
  upload.end(); assert.equal(await uploadDone, 200);
  const response = await fetch(`${renderer.origin}${knowledgePath}`); const reader = response.body!.getReader();
  const first = await reader.read(); assert.equal(Buffer.from(first.value!).toString(), 'first');
  finishDownload(); let rest = '';
  for (;;) { const next = await reader.read(); if (next.done) break; rest += Buffer.from(next.value).toString(); }
  assert.equal(rest, 'last'); reader.releaseLock();
});

test('disconnected knowledge uploads and downloads cancel the exact streaming upstream', { timeout: 5000 }, async t => {
  const distDir = await mkdtemp(path.join(tmpdir(), 'shensi-renderer-knowledge-abort-'));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  for (const method of ['PUT', 'GET']) {
    let observed!: () => void, aborted!: () => void;
    const received = new Promise<void>(resolve => { observed = resolve; });
    const closed = new Promise<void>(resolve => { aborted = resolve; });
    const upstream = createServer((incoming, outgoing) => {
      outgoing.once('close', aborted);
      if (method === 'PUT') { incoming.on('data', () => {}); incoming.once('data', observed); }
      else { outgoing.setHeader('Content-Type', 'application/octet-stream'); outgoing.write('partial'); observed(); }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address(); assert.ok(address && typeof address === 'object');
    const renderer = await startRendererServer({ distDir, remoteOrigin: `http://127.0.0.1:${address.port}` });
    try {
      const outgoing = httpRequest(`${renderer.origin}${knowledgePath}`, { method, headers: { 'Content-Type': 'application/octet-stream' } });
      outgoing.on('error', () => {}); outgoing.on('response', response => response.on('error', () => {}));
      if (method === 'PUT') outgoing.write('partial'); else outgoing.end();
      await received; outgoing.destroy();
      assert.equal(await Promise.race([closed.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 750))]), true);
    } finally {
      await renderer.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  }
});

test('knowledge unknown-length overrun is bounded, redirects denied and neighboring routes unchanged', { timeout: 15000 }, async t => {
  const distDir = await mkdtemp(path.join(tmpdir(), 'shensi-renderer-knowledge-limit-'));
  t.after(() => rm(distDir, { recursive: true, force: true }));
  let calls = 0;
  const upstream = createServer((incoming, outgoing) => {
    calls++;
    if (incoming.method === 'GET') { outgoing.writeHead(302, { Location: 'https://external.invalid/collect' }); outgoing.end(); }
    else { incoming.on('data', () => {}); incoming.on('end', () => outgoing.end('ok')); }
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address(); assert.ok(address && typeof address === 'object');
  const renderer = await startRendererServer({ distDir, remoteOrigin: `http://127.0.0.1:${address.port}` });
  t.after(async () => { await renderer.close(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const body = Readable.from((async function* () { const chunk = Buffer.alloc(64 * 1024, 65); for (let i = 0; i < 801; i++) yield chunk; })());
  const response = await fetch(`${renderer.origin}${knowledgePath}`, { method: 'PUT', body: body as unknown as BodyInit,
    headers: { 'Content-Type': 'application/octet-stream' }, duplex: 'half', signal: AbortSignal.timeout(10000) } as RequestInit);
  assert.equal(response.status, 413); assert.equal(await response.text(), 'Request too large');
  const redirected = await request(renderer.origin, knowledgePath);
  assert.equal(redirected.status, 502); assert.equal(await redirected.text(), 'Gateway redirect denied');
  const before = calls;
  for (const pathname of [`${knowledgePath}/`, `${knowledgePath}-other`]) {
    const neighbor = await request(renderer.origin, pathname, { method: 'PUT', body: 'x'.repeat(1024 * 1024 + 1) });
    assert.equal(neighbor.status, 413);
  }
  assert.equal(calls, before);
});

test("only exact read-only model routes use the bounded model deadline and source response budget", () => {
  for (const pathname of ["/api/v1/finance/documents/inspect", "/api/v1/finance/cfo-conversation"]) {
    assert.equal(rendererUpstreamBudget("POST", pathname).timeoutMs, 130_000);
    assert.equal(rendererUpstreamBudget("GET", pathname).timeoutMs, 10_000);
    assert.equal(rendererUpstreamBudget("POST", `${pathname}/`).timeoutMs, 10_000);
    assert.equal(rendererUpstreamBudget("POST", `${pathname}-other`).timeoutMs, 10_000);
  }
  assert.equal(rendererUpstreamBudget("POST", "/api/v1/finance/documents/inspect").responseBytes, 8 * 1024 * 1024);
  assert.equal(rendererUpstreamBudget("POST", "/api/v1/finance/cfo-conversation").responseBytes, 1024 * 1024);
  assert.deepEqual(rendererUpstreamBudget("POST", "/api/v1/finance/documents/inspect",
    { upstreamTimeoutMs: 50, maxResponseBytes: 256 }), { timeoutMs: 50, responseBytes: 256 });
});

test('system reference text entry routes receive 130s without widening methods, UUIDs or response bytes', () => {
  const session = '/api/v1/finance/cfo-sessions/12345678-1234-1234-1234-123456789abc/turns';
  const routes = ['/api/v1/finance/cfo-conversation', session, '/api/v1/finance/operating-memory-question'];
  for (const pathname of routes) {
    assert.deepEqual(rendererUpstreamBudget('POST', pathname), { timeoutMs: 130_000, responseBytes: 1_048_576 });
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE', undefined]) {
      assert.equal(rendererUpstreamBudget(method, pathname).timeoutMs, 10_000);
    }
    for (const neighbor of [`${pathname}/`, `${pathname}-other`, `${pathname}/extra`]) {
      assert.equal(rendererUpstreamBudget('POST', neighbor).timeoutMs, 10_000);
    }
  }
  for (const id of ['not-a-uuid', '12345678-1234-1234-1234-123456789abg', '------------------------------------', '12345678123412341234123456789abc']) {
    assert.equal(rendererUpstreamBudget('POST', `/api/v1/finance/cfo-sessions/${id}/turns`).timeoutMs, 10_000);
  }
  assert.deepEqual(rendererUpstreamBudget('POST', session, { upstreamTimeoutMs: 25, maxResponseBytes: 128 }), { timeoutMs: 25, responseBytes: 128 });
});

test("AI route deadlines cover their model operations without broadening neighboring APIs", () => {
  for (const [pathname, timeoutMs] of [
    ["/api/v1/acquisition/plans/plan-1/automation/keyword-suggestions", 40_000],
    ["/api/tools/ai-config/test", 250_000],
  ] as const) {
    assert.equal(rendererUpstreamBudget("POST", pathname).timeoutMs, timeoutMs);
    assert.equal(rendererUpstreamBudget("POST", pathname).responseBytes, 1_048_576);
    for (const method of ["GET", "PUT", "PATCH", "DELETE", undefined]) {
      assert.equal(rendererUpstreamBudget(method, pathname).timeoutMs, 10_000);
    }
    for (const neighbor of [`${pathname}/`, `${pathname}-other`, `${pathname}/run`]) {
      assert.equal(rendererUpstreamBudget("POST", neighbor).timeoutMs, 10_000);
    }
    assert.equal(rendererUpstreamBudget("POST", pathname, { upstreamTimeoutMs: 25 }).timeoutMs, 25);
  }
  for (const pathname of ["/api/v1/acquisition/plans//automation/keyword-suggestions",
    "/api/v1/acquisition/plans/a/b/automation/keyword-suggestions", "/api/other-model-call"]) {
    assert.equal(rendererUpstreamBudget("POST", pathname).timeoutMs, 10_000);
  }
});

test("model operations returning after ten seconds reach Renderer while ordinary APIs time out", async (t) => {
  const distDir = await mkdtemp(path.join(tmpdir(), "shensi-renderer-"));
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const upstream = createServer((_incoming, outgoing) => {
    const timer = setTimeout(() => outgoing.end('{"ok":true}'), 10_500);
    timers.add(timer);
    outgoing.once("close", () => { clearTimeout(timer); timers.delete(timer); });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const renderer = await startRendererServer({ distDir, remoteOrigin: `http://127.0.0.1:${address.port}` });
  t.after(async () => {
    await renderer.close(); timers.forEach(clearTimeout); upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const [keywords, modelTest, ordinary] = await Promise.all([
    "/api/v1/acquisition/plans/plan-1/automation/keyword-suggestions?fixture=1",
    "/api/tools/ai-config/test", "/api/ordinary"
  ].map((pathname) => request(renderer.origin, pathname, { method: "POST", body: "{}" })));
  assert.equal(keywords.status, 200);
  assert.equal(await keywords.text(), '{"ok":true}');
  assert.equal(modelTest.status, 200);
  assert.equal(await modelTest.text(), '{"ok":true}');
  assert.equal(ordinary.status, 504);
});

test("disconnected Renderer cancels its pending upstream model request", async (t) => {
  const distDir = await mkdtemp(path.join(tmpdir(), "shensi-renderer-"));
  let sawRequest!: () => void;
  const received = new Promise<void>((resolve) => { sawRequest = resolve; });
  let sawClose!: () => void;
  const closed = new Promise<void>((resolve) => { sawClose = resolve; });
  const upstream = createServer((_incoming, outgoing) => {
    outgoing.once("close", sawClose); sawRequest();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const renderer = await startRendererServer({ distDir, remoteOrigin: `http://127.0.0.1:${address.port}` });
  t.after(async () => {
    await renderer.close(); upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const outgoing = httpRequest(`${renderer.origin}/api/tools/ai-config/test`, { method: "POST" });
  outgoing.on("error", () => undefined); outgoing.end("{}");
  await received;
  outgoing.destroy();
  const result = await Promise.race([closed.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 750))]);
  assert.equal(result, true, "closing the Renderer request must not leave its upstream alive until the long model deadline");
});

test("renderer replaces every case and duplicate build header exactly once with the frozen Main digest", async (t) => {
  const distDir = await mkdtemp(path.join(tmpdir(), "shensi-renderer-"));
  await writeFile(path.join(distDir, "index.html"), "ok");
  const observed: string[][] = [];
  const upstream = createServer((incoming, outgoing) => { observed.push(incoming.rawHeaders); outgoing.end("ok"); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const options = { distDir, remoteOrigin: `http://127.0.0.1:${address.port}`, buildManifestSha256: BUILD_DIGEST };
  const renderer = await startServer(options);
  t.after(() => renderer.close());
  options.buildManifestSha256 = "b".repeat(64);
  const target = new URL(renderer.origin);
  for (const names of [[], ["x-shensi-desktop-build-manifest-sha256"], ["X-SHENSI-DESKTOP-BUILD-MANIFEST-SHA256"], ["X-Shensi-Desktop-Build-Manifest-SHA256", "x-shensi-desktop-build-manifest-sha256"]]) {
    await new Promise<void>((resolve, reject) => {
      const request = httpRequest(`${renderer.origin}/api/write`, {
        headers: { Host: target.host, ...Object.fromEntries(names.map((name) => [name, ["attacker-selected", "duplicate-selected"]])) },
      }, (response) => { response.resume(); response.once("end", resolve); });
      request.once("error", reject); request.end();
    });
  }
  assert.equal(observed.length, 4);
  for (const raw of observed) {
    const values = raw.flatMap((name, index) => index % 2 === 0 && name.toLowerCase() === "x-shensi-desktop-build-manifest-sha256" ? [raw[index + 1]] : []);
    assert.deepEqual(values, [BUILD_DIGEST]);
  }
});

test("renderer rejects missing or malformed Main build identity before opening the server", async () => {
  for (const buildManifestSha256 of [undefined, "", "A".repeat(64), "a".repeat(63), " a".repeat(32)]) {
    await assert.rejects(startServer({ distDir: "/not-read", remoteOrigin: "https://api.shensi.example", buildManifestSha256 } as RendererServerOptions), /buildManifestSha256/u);
  }
});

async function request(origin: string, pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${origin}${pathname}`, init);
}
async function rawStatus(
  origin: string,
  pathname: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: target.hostname, port: Number(target.port) }); let received = "";
    const normalized = new Map<string, string>([
      ["host", target.host],
      ["connection", "close"],
    ]);
    for (const [name, value] of Object.entries(headers)) normalized.set(name.toLowerCase(), value);
    const serialized = [...normalized].map(([name, value]) => `${name}: ${value}`).join("\r\n");
    socket.once("error", reject); socket.on("data", (part) => { received += part.toString(); }); socket.once("end", () => resolve(Number(/^HTTP\/1\.1 (\d+)/u.exec(received)?.[1] ?? 0))); socket.once("connect", () => socket.end(`GET ${pathname} HTTP/1.1\r\n${serialized}\r\n\r\n`));
  });
}

test("renderer server serves dist files, SPA fallback, and rejects traversal", async () => {
  const distDir = await mkdtemp(path.join(tmpdir(), "shensi-renderer-"));
  await writeFile(path.join(distDir, "index.html"), "<main>Shensi</main>");
  await writeFile(path.join(distDir, "app.js"), "export const app = true;");
  const renderer = await startRendererServer({ distDir, remoteOrigin: "https://api.shensi.example" });
  try {
    assert.equal(await (await request(renderer.origin, "/app.js")).text(), "export const app = true;");
    await writeFile(path.join(distDir, "app.css"), "body { color: white; }");
    assert.match((await request(renderer.origin, "/app.css")).headers.get("content-type") ?? "", /^text\/css/u);
    assert.equal(await (await request(renderer.origin, "/acquisition/plan-1")).text(), "<main>Shensi</main>");
    assert.equal(await rawStatus(renderer.origin, "/%2e%2e%2fpackage.json"), 404);
    assert.equal(await (await request(renderer.origin, "/api-not-allowed")).text(), "<main>Shensi</main>");
  } finally {
    await renderer.close();
  }
});

test("renderer CSP permits the existing renderer's inline styles without permitting inline scripts", async () => {
  const distDir = await mkdtemp(path.join(tmpdir(), "shensi-renderer-"));
  await writeFile(path.join(distDir, "index.html"), '<main style="color: white">Shensi</main>');
  const renderer = await startRendererServer({ distDir, remoteOrigin: "https://api.shensi.example" });
  try {
    const response = await request(renderer.origin, "/");
    const policy = response.headers.get("content-security-policy") ?? "";
    assert.match(policy, /style-src 'self' 'unsafe-inline'/u);
    assert.match(policy, /script-src 'self'(?:;|$)/u);
    assert.doesNotMatch(policy, /script-src[^;]*'unsafe-inline'/u);
  } finally {
    await renderer.close();
  }
});

test("renderer server proxies only /api to the configured HTTP(S) origin and rewrites cookies", async () => {
  const distDir = await mkdtemp(path.join(tmpdir(), "shensi-renderer-"));
  await writeFile(path.join(distDir, "index.html"), "ok");
  const upstream = await new Promise<import("node:http").Server>((resolve) => {
    const server = createServer((incoming, outgoing) => {
      assert.equal(incoming.url, "/api/session?next=1");
      outgoing.setHeader("set-cookie", "session=abc; Domain=api.shensi.example; Path=/internal; HttpOnly; Secure; SameSite=None");
      outgoing.end("proxied");
    }).listen(0, "127.0.0.1", () => resolve(server));
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const renderer = await startRendererServer({ distDir, remoteOrigin: `http://127.0.0.1:${address.port}` });
  try {
    const response = await request(renderer.origin, "/api/session?next=1");
    assert.equal(await response.text(), "proxied");
    const cookie = response.headers.get("set-cookie") ?? "";
    assert.match(cookie, /session=abc/u);
    assert.doesNotMatch(cookie, /Domain=/iu);
    assert.match(cookie, /Path=\//u);
    assert.doesNotMatch(cookie, /Secure/iu);
  } finally {
    await renderer.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("renderer proxy fixes trusted origin headers and preserves cookie plus CSRF without forging it", async () => {
  const distDir = await mkdtemp(path.join(tmpdir(), "shensi-renderer-")); await writeFile(path.join(distDir, "index.html"), "ok");
  const observed: Array<import("node:http").IncomingHttpHeaders> = [];
  const upstream = createServer((request, response) => { observed.push(request.headers); response.end("ok"); }); await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string"); const remoteOrigin = `http://127.0.0.1:${address.port}`;
  const renderer = await startRendererServer({ distDir, remoteOrigin });
  try {
    await request(renderer.origin, "/api/write", { method: "POST", headers: { Origin: renderer.origin, Referer: `${renderer.origin}/acquisition`, Cookie: "session=abc", "x-csrf-token": "csrf-1" }, body: "{}" });
    await request(renderer.origin, "/api/no-csrf", { method: "POST", headers: { Origin: renderer.origin, Cookie: "session=abc" }, body: "{}" });
    await request(renderer.origin, "/api/read");
    assert.equal(observed[0]?.origin, remoteOrigin); assert.equal(observed[0]?.referer, `${remoteOrigin}/`); assert.equal(observed[0]?.host, `127.0.0.1:${address.port}`); assert.equal(observed[0]?.cookie, "session=abc"); assert.equal(observed[0]?.['x-csrf-token'], "csrf-1"); assert.equal(observed[1]?.['x-csrf-token'], undefined);
    assert.equal(observed.length, 3);
  } finally { await renderer.close(); await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())); }
});

test("renderer gateway rejects untrusted Host, Origin, Referer, and cross-site fetches", async () => {
  const distDir = await mkdtemp(path.join(tmpdir(), "shensi-renderer-"));
  await writeFile(path.join(distDir, "index.html"), "ok");
  let upstreamCalls = 0;
  const upstream = createServer((_request, response) => { upstreamCalls += 1; response.end("ok"); });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const renderer = await startRendererServer({
    distDir,
    remoteOrigin: `http://127.0.0.1:${address.port}`,
  });
  try {
    assert.equal((await request(renderer.origin, "/api/read", { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await request(renderer.origin, "/api/read", { headers: { Referer: "https://evil.example/path" } })).status, 403);
    assert.equal((await request(renderer.origin, "/api/read", { headers: { Origin: renderer.origin, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal(await rawStatus(renderer.origin, "/api/read", { Host: "evil.example" }), 403);
    assert.equal(upstreamCalls, 0);
  } finally {
    await renderer.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("renderer server rejects a non-origin API target", async () => {
  const distDir = await mkdtemp(path.join(tmpdir(), "shensi-renderer-"));
  await writeFile(path.join(distDir, "index.html"), "ok");
  await assert.rejects(
    startRendererServer({ distDir, remoteOrigin: "file:///tmp/not-an-api" }),
    /remoteOrigin/u
  );
});

test("renderer server enforces the decoded upstream response limit while streaming", async () => {
  const distDir = await mkdtemp(path.join(tmpdir(), "shensi-renderer-"));
  await writeFile(path.join(distDir, "index.html"), "ok");
  const upstream = createServer((_request, response) => {
    response.write(Buffer.alloc(700));
    response.end(Buffer.alloc(700));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const renderer = await startRendererServer({
    distDir,
    remoteOrigin: `http://127.0.0.1:${address.port}`,
    maxResponseBytes: 1_024,
  });
  try {
    const response = await request(renderer.origin, "/api/oversized");
    assert.equal(response.status, 413);
    assert.equal(await response.text(), "Response too large");
  } finally {
    await renderer.close();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("renderer forwards maximum-size finance preview uploads without widening other routes", async (t) => {
  const distDir = await mkdtemp(path.join(tmpdir(), "shensi-renderer-"));
  const upstream = createServer(async (incoming, outgoing) => {
    let bytes = 0;
    for await (const chunk of incoming) bytes += chunk.length;
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify({ bytes, cookie: incoming.headers.cookie,
      csrf: incoming.headers["x-csrf-token"],
      workspace: incoming.headers["x-workspace-id"] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const renderer = await startRendererServer({ distDir,
    remoteOrigin: `http://127.0.0.1:${address.port}` });
  t.after(async () => {
    await renderer.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  const upload = { fileName: "maximum.xlsx",
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    contentBase64: Buffer.alloc(5 * 1024 * 1024).toString("base64") };
  for (const [pathname, payload] of [
    ["/api/v1/finance/documents/inspect", { ...upload, readWithModel: false }],
    ["/api/v1/decision-simulations/preparations", { dataKind:'synthetic', files:[upload] }],
    ["/api/v1/finance/imports/preview", { ...upload, kind: "financial_fact", mapping: {} }],
    ["/api/v1/finance/statement-packages/preview", { statements:
      ["balance_sheet", "income_statement", "cash_flow_statement"].map((kind) => ({ ...upload, kind })) }],
  ] as const) {
    await t.test(pathname, async () => {
      const body = JSON.stringify(payload);
      const response = await request(renderer.origin, `${pathname}?request=preview`, {
        method: "POST", headers: { "content-type": "application/json",
          Origin: renderer.origin, Cookie: "session=upload-test",
          "x-csrf-token": "csrf-upload-test", "x-workspace-id": "workspace-upload-test" }, body,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { bytes: Buffer.byteLength(body),
        cookie: "session=upload-test", csrf: "csrf-upload-test", workspace: "workspace-upload-test" });
    });
  }
  const ordinaryBody = JSON.stringify({ contentBase64: "A".repeat(1024 * 1024) });
  for (const [method, pathname] of [
    ["POST", "/api/write"],
    ["POST", "/api/v1/finance/documents/inspect/"],
    ["PUT", "/api/v1/finance/documents/inspect"],
    ["POST", "/api/v1/finance/imports/preview/"],
    ["POST", "/api/v1/finance/imports/preview-other"],
    ["POST", "/api/v1/finance/imports/preview/commit"],
    ["PUT", "/api/v1/finance/imports/preview"],
    ["POST", "/api/v1/finance/statement-packages/preview/"],
    ["POST", "/api/v1/finance/statement-packages/preview/commit"],
    ["PATCH", "/api/v1/finance/statement-packages/preview"],
  ] as const) {
    await t.test(`${method} ${pathname} retains the ordinary body limit`, async () => {
      const response = await request(renderer.origin, pathname, {
        method, headers: { "content-type": "application/json" }, body: ordinaryBody,
      });
      assert.equal(response.status, 413);
      assert.equal(await response.text(), "Request too large");
    });
  }
  for (const [pathname, size] of [
    ["/api/v1/finance/documents/inspect", 7_056_045],
    ["/api/v1/finance/imports/preview", 7_056_045],
    ["/api/v1/finance/statement-packages/preview", 21_037_061],
  ] as const) {
    await t.test(`${pathname} still rejects excessive JSON envelopes`, async () => {
      const body = JSON.stringify({ contentBase64: "A".repeat(size - 20) });
      assert.equal(Buffer.byteLength(body), size);
      const response = await request(renderer.origin, pathname, {
        method: "POST", headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(response.status, 413);
      assert.equal(await response.text(), "Request too large");
    });
  }
});

test("renderer server keeps the upstream deadline active while reading its body", async () => {
  const distDir = await mkdtemp(path.join(tmpdir(), "shensi-renderer-"));
  await writeFile(path.join(distDir, "index.html"), "ok");
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("partial");
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const renderer = await startRendererServer({
    distDir,
    remoteOrigin: `http://127.0.0.1:${address.port}`,
    upstreamTimeoutMs: 50,
  });
  try {
    for (const pathname of ["/api/hanging",
      "/api/v1/acquisition/plans/plan-1/automation/keyword-suggestions", "/api/tools/ai-config/test"]) {
      const response = await request(renderer.origin, pathname, { method: "POST", body: "{}" });
      assert.equal(response.status, 504, `${pathname} must still abort an unfinished response body`);
    }
  } finally {
    await renderer.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

test("renderer close aborts a partial local request instead of blocking application exit", async () => {
  const distDir = await mkdtemp(path.join(tmpdir(), "shensi-renderer-"));
  await writeFile(path.join(distDir, "index.html"), "ok");
  const upstream = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const renderer = await startRendererServer({
    distDir,
    remoteOrigin: `http://127.0.0.1:${address.port}`,
    requestTimeoutMs: 10_000,
  });
  const target = new URL(renderer.origin);
  const socket = createConnection({ host: target.hostname, port: Number(target.port) });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => {
      socket.write(`POST /api/partial HTTP/1.1\r\nHost: ${target.host}\r\nContent-Length: 100\r\n\r\na`);
      resolve();
    });
    socket.once("error", reject);
  });
  try {
    await Promise.race([
      renderer.close(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("renderer close timed out")), 500)),
    ]);
  } finally {
    socket.destroy();
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
});

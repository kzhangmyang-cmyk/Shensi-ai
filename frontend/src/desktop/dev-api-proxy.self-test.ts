import assert from "node:assert/strict";
import { createDesktopDevApiProxy } from "./dev-api-proxy";

const listeners = new Map<string, (...args: unknown[]) => void>();
const rendererOrigin = "http://127.0.0.1:5188";
const options = createDesktopDevApiProxy("http://127.0.0.1:5611", rendererOrigin);

assert.equal(options.target, "http://127.0.0.1:5611");
assert.equal(options.changeOrigin, true);
options.configure({
  on(event, listener) {
    listeners.set(event, listener as (...args: unknown[]) => void);
  }
});

const headers = new Map<string, string>();
listeners.get("proxyReq")?.({
  setHeader(name: string, value: string) {
    headers.set(name.toLowerCase(), value);
  }
});
assert.equal(headers.get("origin"), "http://127.0.0.1:5611");
assert.equal(headers.get("referer"), "http://127.0.0.1:5611/");

function bypass(headers: Record<string, string | undefined>) {
  let body = "";
  const response = {
    statusCode: 200,
    writableEnded: false,
    end(value = "") { body = value; this.writableEnded = true; }
  };
  const result = options.bypass({ url: "/api/health", headers }, response);
  return { body, response, result };
}

assert.equal(bypass({ host: "127.0.0.1:5188" }).result, undefined);
for (const headers of [
  { host: "evil.example" },
  { host: "127.0.0.1:5188", origin: "https://evil.example" },
  { host: "127.0.0.1:5188", referer: "https://evil.example/path" },
  { host: "127.0.0.1:5188", origin: rendererOrigin, "sec-fetch-site": "cross-site" },
]) {
  const rejected = bypass(headers);
  assert.equal(rejected.response.statusCode, 403);
  assert.equal(rejected.response.writableEnded, true);
  assert.equal(rejected.body, "Forbidden");
  assert.equal(rejected.result, "/api/health");
}

assert.throws(() => createDesktopDevApiProxy("http://127.0.0.1:5611/path", rendererOrigin));
assert.throws(() => createDesktopDevApiProxy("file:///tmp/api", rendererOrigin));
assert.throws(() => createDesktopDevApiProxy("http://api.shensi.example", rendererOrigin));
assert.throws(() => createDesktopDevApiProxy("http://127.0.0.1:5611", "https://evil.example"));

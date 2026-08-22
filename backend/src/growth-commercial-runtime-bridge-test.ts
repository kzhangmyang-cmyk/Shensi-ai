import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import {
  GrowthCommercialRuntimeBridge
} from "./growth-commercial-runtime-bridge.js";

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()))
  };
}

test("install bridge delegates once and closes one installed runtime", async () => {
  const events: string[] = [];
  const bridge = new GrowthCommercialRuntimeBridge();
  const app = express();
  app.use(bridge.middleware());
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  const server = await listen(app);
  try {
    const health = await fetch(`${server.origin}/api/health`);
    assert.equal(health.status, 200);
    const unavailable = await fetch(
      `${server.origin}/api/v1/growth/bootstrap`
    );
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get("cache-control"), "no-store");
    assert.deepEqual(await unavailable.json(), {
      code: "GROWTH_RUNTIME_NOT_READY"
    });

    bridge.install({
      handler(req, res, next) {
        if (req.path === "/api/v1/growth/bootstrap") {
          events.push("handle");
          res.json({ ready: true });
          return;
        }
        next();
      },
      toolPorts: {} as never,
      integrations: {},
      async close() {
        events.push("close");
      }
    });
    const active = await fetch(`${server.origin}/api/v1/growth/bootstrap`);
    assert.equal(active.status, 200);
    assert.throws(() => bridge.install({} as never), /already installed/u);
    await Promise.all([bridge.close(), bridge.close()]);
    assert.deepEqual(events, ["handle", "close"]);
    assert.equal((await fetch(
      `${server.origin}/api/v1/growth/bootstrap`
    )).status, 503);
  } finally {
    await server.close();
  }
});

test("bridge leaves legacy acquisition routes to the Acquisition runtime", async () => {
  const bridge = new GrowthCommercialRuntimeBridge();
  const app = express();
  app.use(bridge.middleware());
  app.get("/api/v1/acquisition/candidates", (_req, res) => {
    res.json({ legacy: true });
  });
  const server = await listen(app);
  try {
    const response = await fetch(
      `${server.origin}/api/v1/acquisition/candidates`
    );
    assert.equal(response.status, 200);
  } finally {
    await server.close();
  }
});

test("closing an uninstalled bridge permanently prevents a late install", async () => {
  const bridge = new GrowthCommercialRuntimeBridge();
  await bridge.close();
  await bridge.close();
  assert.throws(() => bridge.install({
    handler: (_req, _res, next) => next(),
    toolPorts: {} as never,
    integrations: {},
    close: async () => undefined
  }), /closed/u);
});

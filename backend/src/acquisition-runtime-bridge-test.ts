import assert from "node:assert/strict";
import express from "express";
import {
  AcquisitionRuntimeBridge
} from "./acquisition-runtime-bridge.js";

async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server address unavailable");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

const bridge = new AcquisitionRuntimeBridge();
const app = express();
app.use(bridge.middleware());
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});
const server = await listen(app);

try {
  const health = await fetch(`${server.origin}/api/health`);
  assert.equal(health.status, 200);

  const unavailable = await fetch(
    `${server.origin}/api/v1/acquisition/candidates`
  );
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), {
    error: {
      code: "acquisition_runtime_unavailable",
      message: "AI 获客服务尚未就绪"
    }
  });
  assert.equal(unavailable.headers.get("cache-control"), "no-store");

  let firstClosed = 0;
  bridge.install({
    handler(req, res, next) {
      if (req.path === "/api/v1/acquisition/candidates") {
        res.json({ runtime: "first" });
        return;
      }
      next();
    },
    async close() {
      firstClosed += 1;
    }
  });
  const active = await fetch(
    `${server.origin}/api/v1/acquisition/candidates`
  );
  assert.equal(active.status, 200);
  assert.deepEqual(await active.json(), { runtime: "first" });

  assert.throws(
    () => bridge.install({
      handler: (_req, _res, next) => next(),
      async close() {}
    }),
    /already installed/
  );

  await bridge.close();
  await bridge.close();
  assert.equal(firstClosed, 1);
  const afterClose = await fetch(
    `${server.origin}/api/v1/acquisition/candidates`
  );
  assert.equal(afterClose.status, 503);
} finally {
  await server.close();
}

console.log("acquisition runtime bridge tests passed");

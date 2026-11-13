import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRemoteOrigin, resolveDesktopRuntime } from "../src/main/runtime-config.ts";

test('standalone mode is explicit and does not inherit a remote API', async () => {
  const resourcesPath = await mkdtemp(path.join(tmpdir(), 'shensi-runtime-config-'));
  await writeFile(path.join(resourcesPath, 'desktop-config.json'), JSON.stringify({ mode: 'standalone' }));
  assert.deepEqual(await resolveDesktopRuntime({ production: true, resourcesPath,
    environment: { SHENSI_REMOTE_ORIGIN: 'http://127.0.0.1:5638' } }),
    { mode: 'standalone', dataEnvironment: 'production' });
  assert.deepEqual(await resolveDesktopRuntime({ production: false, resourcesPath,
    environment: { SHENSI_DESKTOP_MODE: 'standalone', SHENSI_REMOTE_ORIGIN: 'http://127.0.0.1:5638' } }),
    { mode: 'standalone', dataEnvironment: 'development' });
  await writeFile(path.join(resourcesPath, 'desktop-config.json'), JSON.stringify({ mode: 'standalone', remoteOrigin: 'https://api.shensi.cn' }));
  await assert.rejects(resolveDesktopRuntime({ production: true, resourcesPath, environment: {} }), /fields/);
});

test("loopback installation tests isolate application and browser state from production", async () => {
  const resourcesPath = await mkdtemp(path.join(tmpdir(), "shensi-runtime-config-"));
  await writeFile(path.join(resourcesPath, "desktop-config.json"), JSON.stringify({ remoteOrigin: "http://127.0.0.1:5680" }));
  const runtime = await resolveDesktopRuntime({ production: true, resourcesPath, environment: {} });
  assert.deepEqual(runtime, { remoteOrigin: "http://127.0.0.1:5680", dataEnvironment: "test", testId: "packaged-local" });
  await writeFile(path.join(resourcesPath, "desktop-config.json"), JSON.stringify({ remoteOrigin: "https://api.shensi.cn" }));
  assert.deepEqual(await resolveDesktopRuntime({ production: true, resourcesPath, environment: {} }),
    { remoteOrigin: "https://api.shensi.cn", dataEnvironment: "production" });
  assert.deepEqual(await resolveDesktopRuntime({ production: false, resourcesPath, environment: { SHENSI_REMOTE_ORIGIN: "http://127.0.0.1:5638" } }),
    { remoteOrigin: "http://127.0.0.1:5638", dataEnvironment: "development" });
});

test("packaged runtime reads the signed public API origin from app resources", async () => {
  const resourcesPath = await mkdtemp(path.join(tmpdir(), "shensi-runtime-config-"));
  await writeFile(
    path.join(resourcesPath, "desktop-config.json"),
    `${JSON.stringify({ remoteOrigin: "https://api.shensi.cn" })}\n`,
  );
  assert.equal(await resolveRemoteOrigin({
    production: true,
    resourcesPath,
    environment: {},
  }), "https://api.shensi.cn");
});

test("packaged development runtime accepts an exact IPv4 loopback API origin", async () => {
  const resourcesPath = await mkdtemp(path.join(tmpdir(), "shensi-runtime-config-"));
  await writeFile(
    path.join(resourcesPath, "desktop-config.json"),
    `${JSON.stringify({ remoteOrigin: "http://127.0.0.1:5608" })}\n`,
  );
  assert.equal(await resolveRemoteOrigin({
    production: true,
    resourcesPath,
    environment: {},
  }), "http://127.0.0.1:5608");
});

test("packaged runtime fails closed on missing, non-HTTPS or ambiguous config", async () => {
  const resourcesPath = await mkdtemp(path.join(tmpdir(), "shensi-runtime-config-"));
  await assert.rejects(resolveRemoteOrigin({ production: true, resourcesPath, environment: {} }));

  await writeFile(path.join(resourcesPath, "desktop-config.json"), JSON.stringify({
    remoteOrigin: "http://api.shensi.example",
  }));
  await assert.rejects(resolveRemoteOrigin({ production: true, resourcesPath, environment: {} }), /HTTPS/u);

  await writeFile(path.join(resourcesPath, "desktop-config.json"), JSON.stringify({
    remoteOrigin: "https://desktop.internal.example",
  }));
  await assert.rejects(resolveRemoteOrigin({ production: true, resourcesPath, environment: {} }), /placeholder/u);

  await writeFile(path.join(resourcesPath, "desktop-config.json"), JSON.stringify({
    remoteOrigin: "https://api.shensi.example",
    injected: true,
  }));
  await assert.rejects(resolveRemoteOrigin({ production: true, resourcesPath, environment: {} }), /fields/u);
});

test("development permits only an HTTPS origin or an exact loopback HTTP origin", async () => {
  assert.equal(await resolveRemoteOrigin({
    production: false,
    resourcesPath: "/unused",
    environment: { SHENSI_REMOTE_ORIGIN: "http://127.0.0.1:5611" },
  }), "http://127.0.0.1:5611");
  assert.equal(await resolveRemoteOrigin({
    production: false,
    resourcesPath: "/unused",
    environment: { SHENSI_REMOTE_ORIGIN: "https://api.shensi.cn" },
  }), "https://api.shensi.cn");
  await assert.rejects(resolveRemoteOrigin({
    production: false,
    resourcesPath: "/unused",
    environment: { SHENSI_REMOTE_ORIGIN: "https://desktop.internal.example" },
  }), /placeholder/u);
  await assert.rejects(resolveRemoteOrigin({
    production: false,
    resourcesPath: "/unused",
    environment: { SHENSI_REMOTE_ORIGIN: "http://api.shensi.example" },
  }), /HTTPS or loopback/u);
});

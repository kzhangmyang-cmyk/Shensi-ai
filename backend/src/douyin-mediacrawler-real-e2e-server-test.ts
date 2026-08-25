import assert from "node:assert/strict";
import test from "node:test";

import {
  createDouyinMediaCrawlerRealE2eRuntime,
  readDouyinMediaCrawlerRealE2eConfiguration
} from "./douyin-mediacrawler-real-e2e-server.js";

test("real Douyin E2E configuration fails closed without MySQL and sidecar secret file", () => {
  assert.throws(
    () => readDouyinMediaCrawlerRealE2eConfiguration({}),
    /MYSQL_TEST_ADMIN_URL_REQUIRED:douyin-mediacrawler-real-runtime/u
  );
  assert.throws(
    () => readDouyinMediaCrawlerRealE2eConfiguration({ MYSQL_TEST_ADMIN_URL: "mysql://user:pass@127.0.0.1:3306/test" }),
    /MEDIACRAWLER_SERVICE_SECRET_FILE_REQUIRED:douyin-mediacrawler-real-runtime/u
  );
});
test("real Douyin E2E runtime uses actual Shensi auth/CSRF routes and never exposes its secret", async () => {
  const runtime = await createDouyinMediaCrawlerRealE2eRuntime({
    configuration: {
      databaseUrl: "mysql://fixture.invalid/shensi_fixture",
      backendPort: 5488,
      sidecarUrl: "http://127.0.0.1:5491",
      serviceSecret: "fixture-secret-that-is-never-returned-123456",
      databaseName: "shensi_fixture",
      databaseAdminUrl: "mysql://fixture.invalid/mysql"
    },
    startDatabase: async () => ({ close: async () => undefined }),
    startHttpServer: async () => ({ close: async () => undefined })
  });
  try {
    assert.equal(runtime.readiness.backendUrl, "http://127.0.0.1:5488");
    assert.equal(runtime.readiness.loginPath, "/api/auth/login");
    assert.equal(runtime.readiness.csrfPath, "/api/auth/csrf");
    assert.equal(JSON.stringify(runtime.readiness).includes("fixture-secret"), false);
  } finally {
    await runtime.close();
  }
});

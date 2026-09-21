import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";
const { readDouyinOutreachFeatureFlags,
  readMediaCrawlerGatewayConfiguration } = await import("./server.js");

const serviceSecret = "mediacrawler-test-secret-that-is-at-least-32-bytes";

function withSecretFile(run: (secretFile: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "shensi-gateway-runtime-"));
  const secretFile = join(directory, "service-secret");
  try {
    writeFileSync(secretFile, serviceSecret, { mode: 0o600 });
    chmodSync(secretFile, 0o600);
    run(secretFile);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("backend gateway composition propagates the canonical desktop runtime mode", () => {
  withSecretFile((secretFile) => {
    assert.deepEqual(readMediaCrawlerGatewayConfiguration({
      MEDIACRAWLER_BASE_URL: "http://127.0.0.1:5612",
      MEDIACRAWLER_SERVICE_SECRET_FILE: secretFile,
      SHENSI_RUNTIME_MODE: "desktop",
      MEDIACRAWLER_BROWSER_DISPLAY: "operator",
    }), {
      baseUrl: "http://127.0.0.1:5612",
      serviceSecret,
      runtimeMode: "desktop",
    });
  });
});

test("backend gateway composition infers retained web mode from virtual display", () => {
  withSecretFile((secretFile) => {
    assert.equal(readMediaCrawlerGatewayConfiguration({
      MEDIACRAWLER_BASE_URL: "http://127.0.0.1:5612",
      MEDIACRAWLER_SERVICE_SECRET_FILE: secretFile,
      MEDIACRAWLER_BROWSER_DISPLAY: "virtual",
    })?.runtimeMode, "web");
  });
});

test("backend gateway composition rejects runtime/display disagreement", () => {
  withSecretFile((secretFile) => {
    assert.throws(() => readMediaCrawlerGatewayConfiguration({
      MEDIACRAWLER_BASE_URL: "http://127.0.0.1:5612",
      MEDIACRAWLER_SERVICE_SECRET_FILE: secretFile,
      SHENSI_RUNTIME_MODE: "desktop",
      MEDIACRAWLER_BROWSER_DISPLAY: "virtual",
    }), /SHENSI_RUNTIME_MODE conflicts with MEDIACRAWLER_BROWSER_DISPLAY/u);
  });
});

test("approval and server and desktop execution gates are independent", () => {
  assert.deepEqual(readDouyinOutreachFeatureFlags({
    DOUYIN_OUTREACH_APPROVALS_ENABLED: "true",
    DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED: "false",
    DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: "true",
    DOUYIN_OUTREACH_ACTIONS_ENABLED: "true"
  }, null), {
    approvalsEnabled: true,
    serverExecutionEnabled: false,
    desktopExecutionEnabled: true
  });
  assert.deepEqual(readDouyinOutreachFeatureFlags({
    DOUYIN_OUTREACH_APPROVALS_ENABLED: "false",
    DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED: "true",
    DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: "false",
    DOUYIN_OUTREACH_ACTIONS_ENABLED: "false"
  }, { executeAction() {} }), {
    approvalsEnabled: false,
    serverExecutionEnabled: true,
    desktopExecutionEnabled: false
  });
});

test("one canonical outreach gate requires all three exact lowercase values", () => {
  assert.throws(() => readDouyinOutreachFeatureFlags({
    DOUYIN_OUTREACH_APPROVALS_ENABLED: "true",
    DOUYIN_OUTREACH_ACTIONS_ENABLED: "true"
  }, { executeAction() {} }), /DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED/u);
  assert.throws(() => readDouyinOutreachFeatureFlags({
    DOUYIN_OUTREACH_APPROVALS_ENABLED: "TRUE",
    DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED: "false",
    DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: "false"
  }, null), /DOUYIN_OUTREACH_APPROVALS_ENABLED/u);
});

test("canonical server execution fails closed without a constructed gateway", () => {
  assert.throws(() => readDouyinOutreachFeatureFlags({
    DOUYIN_OUTREACH_APPROVALS_ENABLED: "true",
    DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED: "true",
    DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED: "false"
  }, null), /DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED requires.*gateway/u);
});

test("legacy outreach gate remains a bounded all-server compatibility adapter", () => {
  assert.deepEqual(readDouyinOutreachFeatureFlags({
    DOUYIN_OUTREACH_ACTIONS_ENABLED: "TRUE"
  }, { executeAction() {} }), {
    approvalsEnabled: true,
    serverExecutionEnabled: true,
    desktopExecutionEnabled: false
  });
  assert.deepEqual(readDouyinOutreachFeatureFlags({}, null), {
    approvalsEnabled: false,
    serverExecutionEnabled: false,
    desktopExecutionEnabled: false
  });
});

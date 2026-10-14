import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDesktopLogger } from "../src/main/logger.ts";

test("desktop logger writes JSON lines and redacts sensitive fields", () => {
  const path = join(mkdtempSync(join(tmpdir(), "shensi-logger-")), "desktop.log");
  const logger = createDesktopLogger(path);
  logger.info("connector.ready", { authorization: "Bearer abc", token: "abc",
    serviceSecret: "secret", accountId: "workspace-customer-1", account_key: "f".repeat(64),
    accountHandle: "douyin-user", nested: { sessionId: "session-1", message: "ready" } });
  const line = JSON.parse(readFileSync(path, "utf8").trim()) as Record<string, unknown>;
  assert.equal(line.level, "info");
  assert.equal(line.event, "connector.ready");
  const rendered = JSON.stringify(line);
  for (const secret of ["Bearer abc", "workspace-customer-1", "f".repeat(64), "session-1", "secret", "douyin-user"])
    assert.doesNotMatch(rendered, new RegExp(secret));
  assert.match(rendered, /\[REDACTED\]/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("desktop logger rejects unsafe events and non-plain values", () => {
  const logger = createDesktopLogger(join(mkdtempSync(join(tmpdir(), "shensi-logger-")), "desktop.log"));
  assert.throws(() => logger.info("", {}));
  assert.throws(() => logger.info("event", { value: new URL("https://example.com") }));
  assert.throws(() => logger.info("event", { value: Number.NaN }));
  assert.throws(() => logger.info("event", { value: Number.POSITIVE_INFINITY }));
});

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppPaths } from "../src/main/app-paths.ts";

test("app paths separate production, development and test data", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shensi-paths-")));
  const production = createAppPaths({ baseUserData: root, environment: "production" });
  const development = createAppPaths({ baseUserData: root, environment: "development" });
  const testPaths = createAppPaths({ baseUserData: root, environment: "test", testId: "case-01" });
  assert.equal(production.userData, join(root, "Shensi"));
  assert.equal(development.userData, join(root, "Shensi Development"));
  assert.equal(testPaths.userData, join(root, "Shensi Test", "case-01"));
  assert.equal(new Set([production.userData, development.userData, testPaths.userData]).size, 3);
});

test("profiles, logs, cache and temp stay beneath userData", () => {
  const paths = createAppPaths({ baseUserData: "/Users/example/Library/Application Support", environment: "production" });
  assert.deepEqual(paths, {
    userData: "/Users/example/Library/Application Support/Shensi",
    logs: "/Users/example/Library/Application Support/Shensi/logs",
    profiles: "/Users/example/Library/Application Support/Shensi/profiles",
    cache: "/Users/example/Library/Application Support/Shensi/cache",
    temp: "/Users/example/Library/Application Support/Shensi/temp",
    installation: "/Users/example/Library/Application Support/Shensi/device-installation",
    deviceCredentials: "/Users/example/Library/Application Support/Shensi/device-credentials",
    outreachJournal: "/Users/example/Library/Application Support/Shensi/outreach-journal"
  });
  for (const value of Object.values(paths).slice(1)) assert.ok(value.startsWith(`${paths.userData}/`));
});

test("app paths reject relative roots and unsafe test identifiers", () => {
  assert.throws(() => createAppPaths({ baseUserData: "relative", environment: "production" }));
  assert.throws(() => createAppPaths({ baseUserData: "/tmp", environment: "test", testId: "../escape" }));
});

test("outreach stores cannot share production and development authority", () => {
  const base = "/Users/example/Library/Application Support";
  const production = createAppPaths({ baseUserData: base, environment: "production" });
  const development = createAppPaths({ baseUserData: base, environment: "development" });
  for (const key of ["installation", "deviceCredentials", "outreachJournal"] as const) {
    assert.equal(typeof production[key], "string");
    assert.ok(production[key].startsWith(`${production.userData}/`));
    assert.ok(development[key].startsWith(`${development.userData}/`));
    assert.notEqual(production[key], development[key]);
  }
  assert.equal(new Set([production.installation, production.deviceCredentials, production.outreachJournal]).size, 3);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePackageMode,
  validateRemoteOrigin,
  validateReleaseEnvironment,
} from "../scripts/release-policy.mjs";

test("development accepts a real HTTPS or exact IPv4 loopback origin", () => {
  assert.equal(validateRemoteOrigin("https://api.shensi.cn", false), "https://api.shensi.cn");
  assert.equal(validateRemoteOrigin("http://127.0.0.1:4188", false), "http://127.0.0.1:4188");
  for (const value of [
    "https://desktop.internal.example",
    "https://service.invalid",
    "http://127.0.0.1",
    "http://localhost:4188",
    "http://[::1]:4188",
    "http://127.0.0.2:4188",
    "http://user:secret@127.0.0.1:4188",
    "http://127.0.0.1:4188/path",
  ]) assert.throws(() => validateRemoteOrigin(value, false));
  assert.equal(normalizePackageMode("development"), "development");
});

test("release rejects placeholder and non-exact origins", () => {
  for (const value of [
    "https://example.com",
    "https://api.example.com",
    "https://localhost",
    "https://service.invalid",
    "http://127.0.0.1:4188",
    "https://real.example/path",
    "http://real.example",
    "https://user:secret@real.example",
  ]) assert.throws(() => validateRemoteOrigin(value, true));
});

test("release requires signing identity material and a notary keychain profile", () => {
  assert.throws(() => validateReleaseEnvironment({ SHENSI_REMOTE_ORIGIN: "https://api.shensi.cn" }), /signing identity/u);
  assert.throws(() => validateReleaseEnvironment({
    SHENSI_REMOTE_ORIGIN: "https://api.shensi.cn",
    CSC_NAME: "Developer ID Application: Shensi (TEAMID1234)",
  }), /keychain profile/u);
  assert.deepEqual(validateReleaseEnvironment({
    SHENSI_REMOTE_ORIGIN: "https://api.shensi.cn",
    CSC_LINK: "/secure/certificate.p12",
    SHENSI_NOTARYTOOL_KEYCHAIN_PROFILE: "shensi-notary",
  }), { remoteOrigin: "https://api.shensi.cn", notaryProfile: "shensi-notary" });
});

test("non-release mode never requires Apple credentials", () => {
  assert.equal(normalizePackageMode(undefined), "development");
  assert.throws(() => normalizePackageMode("public"));
});

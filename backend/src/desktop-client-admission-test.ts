import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import test from "node:test";
import express from "express";
import {
  createDesktopClientAdmissionMiddleware,
  resolveDesktopClientAdmissionConfiguration
} from "./desktop-client-admission.js";

const ADMITTED_DIGEST = "a".repeat(64);
const SECOND_ADMITTED_DIGEST = "b".repeat(64);
const BUILD_HEADER = "X-Shensi-Desktop-Build-Manifest-SHA256";

function configuration(env: Record<string, string | undefined>) {
  return resolveDesktopClientAdmissionConfiguration(env);
}

function createApp(mode: "migration_locked" | "exact") {
  let mutationCalls = 0;
  let parserErrors = 0;
  const app = express();
  app.use(createDesktopClientAdmissionMiddleware(configuration(
    mode === "exact"
      ? { SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: mode,
        SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: ADMITTED_DIGEST }
      : { SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: mode }
  )));
  app.use(express.json());
  app.use((error: unknown, _req: express.Request, res: express.Response,
    _next: express.NextFunction) => {
    parserErrors += 1;
    res.status(400).json({ error: "json_parser_reached" });
  });
  app.all("/business-operation", (_req, res) => {
    mutationCalls += 1;
    res.status(204).end();
  });
  return {
    app,
    mutationCalls: () => mutationCalls,
    parserErrors: () => parserErrors
  };
}

async function send(
  app: express.Express,
  method: string,
  headers: Record<string, string | string[]> = {},
  body?: string
) {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port: address.port,
        path: "/business-operation", method, headers }, (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { responseBody += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0,
          body: responseBody }));
      });
      request.on("error", reject);
      if (body !== undefined) request.write(body);
      request.end();
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
}

test("startup validation catches a missing desktop admission mode before the server can compose", () => {
  assert.throws(() => configuration({}), /SHENSI_DESKTOP_CLIENT_ADMISSION_MODE/u);
  assert.throws(() => configuration({ SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "locked" }),
    /migration_locked\|exact/u);
});

test("startup validation catches an exact mode without one lowercase manifest digest", () => {
  assert.throws(() => configuration({
    SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "exact"
  }), /SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256/u);
  assert.throws(() => configuration({
    SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "exact",
    SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: "A".repeat(64)
  }), /64 lowercase hexadecimal/u);
});

test("startup validation catches a configured digest that would make migration_locked ambiguous", () => {
  assert.throws(() => configuration({
    SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "migration_locked",
    SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: ADMITTED_DIGEST
  }), /must be empty/u);
  assert.throws(() => configuration({
    SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "migration_locked",
    SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: " "
  }), /must be empty/u);
  assert.throws(() => configuration({
    SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "migration_locked",
    SHENSI_DESKTOP_ADDITIONAL_ADMITTED_BUILD_MANIFEST_SHA256S: SECOND_ADMITTED_DIGEST
  }), /must be empty/u);
});

test("exact mode accepts a bounded canonical build allowlist for arm64 x64 and controlled overlap", () => {
  assert.deepEqual(configuration({
    SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "exact",
    SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: ADMITTED_DIGEST,
    SHENSI_DESKTOP_ADDITIONAL_ADMITTED_BUILD_MANIFEST_SHA256S:
      `${SECOND_ADMITTED_DIGEST},${"c".repeat(64)}`
  }), {
    mode: "exact",
    admittedBuildManifestSha256: ADMITTED_DIGEST,
    additionalAdmittedBuildManifestSha256s: [SECOND_ADMITTED_DIGEST, "c".repeat(64)]
  });
  for (const value of [
    `${SECOND_ADMITTED_DIGEST},`,
    ` ${SECOND_ADMITTED_DIGEST}`,
    SECOND_ADMITTED_DIGEST.toUpperCase(),
    `${ADMITTED_DIGEST},${SECOND_ADMITTED_DIGEST}`,
    Array.from({ length: 8 }, (_, index) => String(index + 1).repeat(64)).join(",")
  ]) assert.throws(() => configuration({
    SHENSI_DESKTOP_CLIENT_ADMISSION_MODE: "exact",
    SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256: ADMITTED_DIGEST,
    SHENSI_DESKTOP_ADDITIONAL_ADMITTED_BUILD_MANIFEST_SHA256S: value
  }), /ADDITIONAL_ADMITTED_BUILD_MANIFEST_SHA256S/u);
});

test("migration lock prevents every mutation method from reaching downstream business handlers", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const fixture = createApp("migration_locked");
    const response = await send(fixture.app, method, {
      "Content-Type": "application/json",
      [BUILD_HEADER]: "supplied-digest-must-not-appear"
    }, "{");
    assert.equal(response.status, 503, method);
    assert.deepEqual(JSON.parse(response.body), {
      error: "desktop_client_migration_locked"
    }, method);
    assert.equal(fixture.mutationCalls(), 0, method);
    assert.equal(fixture.parserErrors(), 0, method);
    assert.equal(response.body.includes("supplied-digest-must-not-appear"), false,
      method);
  }
});

test("read-method classification does not turn GET HEAD or OPTIONS into admitted mutations", async () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const fixture = createApp("migration_locked");
    const response = await send(fixture.app, method);
    assert.equal(response.status, 204, method);
    assert.equal(fixture.mutationCalls(), 1, method);
    assert.equal(fixture.parserErrors(), 0, method);
  }
});

test("exact admission rejects missing, duplicate, comma-joined, malformed, uppercase, stale, and wrong headers", async () => {
  const rejectedHeaders: Array<Record<string, string | string[]>> = [
    {},
    { [BUILD_HEADER]: [ADMITTED_DIGEST, ADMITTED_DIGEST] },
    { [BUILD_HEADER]: `${ADMITTED_DIGEST},${ADMITTED_DIGEST}` },
    { [BUILD_HEADER]: "a".repeat(63) },
    { [BUILD_HEADER]: "A".repeat(64) },
    { [BUILD_HEADER]: "b".repeat(64) },
    { [BUILD_HEADER]: "c".repeat(64) }
  ];
  for (const headers of rejectedHeaders) {
    const fixture = createApp("exact");
    const supplied = String(headers[BUILD_HEADER] ?? "missing");
    const response = await send(fixture.app, "POST", {
      "Content-Type": "application/json", ...headers
    }, "{");
    assert.equal(response.status, 409, supplied);
    assert.deepEqual(JSON.parse(response.body), {
      error: "desktop_client_build_not_admitted"
    }, supplied);
    assert.equal(fixture.mutationCalls(), 0, supplied);
    assert.equal(fixture.parserErrors(), 0, supplied);
    assert.equal(response.body.includes(supplied), false, supplied);
    assert.equal(response.body.includes(ADMITTED_DIGEST), false, supplied);
  }
});

test("admission precedes JSON parsing when a wrong build sends malformed content", async () => {
  const fixture = createApp("exact");
  const response = await send(fixture.app, "POST", {
    "Content-Type": "application/json", [BUILD_HEADER]: "b".repeat(64)
  }, "{");
  assert.equal(response.status, 409);
  assert.deepEqual(JSON.parse(response.body), {
    error: "desktop_client_build_not_admitted"
  });
  assert.equal(fixture.parserErrors(), 0);
  assert.equal(fixture.mutationCalls(), 0);
});

test("an admitted exact request continues to downstream validation instead of replacing it", async () => {
  const fixture = createApp("exact");
  const response = await send(fixture.app, "POST", {
    "Content-Type": "application/json", [BUILD_HEADER]: ADMITTED_DIGEST
  }, "{}");
  assert.equal(response.status, 204);
  assert.equal(fixture.mutationCalls(), 1);
  assert.equal(fixture.parserErrors(), 0);
});

test("an additional admitted architecture digest reaches the same downstream checks", async () => {
  let mutationCalls = 0;
  const app = express();
  app.use(createDesktopClientAdmissionMiddleware({ mode: "exact",
    admittedBuildManifestSha256: ADMITTED_DIGEST,
    additionalAdmittedBuildManifestSha256s: [SECOND_ADMITTED_DIGEST] }));
  app.post("/business-operation", (_request, response) => {
    mutationCalls += 1; response.status(204).end();
  });
  const response = await send(app, "POST", {
    [BUILD_HEADER]: SECOND_ADMITTED_DIGEST
  });
  assert.equal(response.status, 204);
  assert.equal(mutationCalls, 1);
});

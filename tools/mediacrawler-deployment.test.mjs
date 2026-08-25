import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertMediaCrawlerHostPrerequisites,
  validateMediaCrawlerComposeConfig
} from "../scripts/mediacrawler-runtime.mjs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("MediaCrawler image is a pinned, reproducible Python 3.11 Playwright runtime", () => {
  const dockerfile = read("services/media-crawler/Dockerfile.shensi");
  for (const dockerignore of [read("services/media-crawler/.dockerignore.shensi"),
    read("services/media-crawler/Dockerfile.shensi.dockerignore")]) {
    assert.match(dockerignore, /^deploy\/secrets\/$/mu);
    assert.match(dockerignore, /^\.env\.\*$/mu);
    assert.match(dockerignore, /^\*\*\/browser_data\/$/mu);
    assert.match(dockerignore, /^\.git\/$/mu);
  }
  assert.match(dockerfile, /^FROM ghcr\.io\/astral-sh\/uv:0\.12\.5 AS uv$/mu);
  assert.match(dockerfile, /^FROM python:3\.11\.[0-9]+-slim-bookworm AS (?:builder|runtime)$/mu);
  assert.match(dockerfile, /uv sync --frozen --no-dev --no-editable/u);
  assert.match(dockerfile, /python -m playwright install --with-deps chromium/u);
  assert.match(dockerfile, /^USER [1-9][0-9]*:[1-9][0-9]*$/mu);
  assert.match(dockerfile, /"--timeout-graceful-shutdown", "20"/u);
  assert.doesNotMatch(dockerfile, /MEDIACRAWLER_SERVICE_SECRET\s*=/u);
});

test("production compose keeps MediaCrawler private, read-only, bounded, and secret-file based", () => {
  const compose = read("deploy/compose.yaml");
  const media = compose.split("\n  media-crawler:\n")[1]?.split(/\n  (?:mysql|backend|frontend|gateway):\n|\n(?:secrets|volumes|networks):\n/u)[0] ?? "";
  assert.notEqual(media, "");
  assert.doesNotMatch(media, /^\s+ports:/mu);
  assert.match(media, /read_only: true/u);
  assert.match(media, /MEDIACRAWLER_SERVICE_SECRET_FILE: \/run\/secrets\/mediacrawler_service_secret/u);
  assert.match(media, /target: \/var\/lib\/shensi-mediacrawler/u);
  assert.match(media, /bind:\s*\n\s+create_host_path: false/u);
  assert.match(media, /healthcheck:/u);
  assert.match(media, /stop_grace_period: 25s/u);
  assert.match(media, /cpus: ["']?1\.0["']?/u);
  assert.match(media, /memory: 1536M/u);
  assert.match(media, /pids_limit: 256/u);
  assert.match(media, /no-new-privileges:true/u);
  assert.match(media, /cap_drop:\s*\n\s+- ALL/u);
  assert.match(media, /networks: \[shensi_mediacrawler, shensi_egress\]/u);

  const backend = compose.split("\n  backend:\n")[1]?.split(/\n  (?:media-crawler|mysql|frontend|gateway):\n/u)[0] ?? "";
  assert.match(backend, /MEDIACRAWLER_BASE_URL: http:\/\/media-crawler:8899/u);
  assert.match(backend, /MEDIACRAWLER_SERVICE_SECRET_FILE: \/run\/secrets\/mediacrawler_service_secret/u);
  assert.match(backend, /target: \/run\/secrets\/mediacrawler_service_secret\s+uid: "1000"\s+gid: "1000"\s+mode: 0400/u);
  assert.doesNotMatch(backend, /MEDIACRAWLER_SERVICE_SECRET:/u);
  assert.match(backend, /networks: \[shensi_internal, shensi_mediacrawler, shensi_egress\]/u);

  const gateway = compose.split("\n  gateway:\n")[1]?.split(/\n(?:secrets|volumes|networks):\n/u)[0] ?? "";
  assert.doesNotMatch(gateway, /shensi_mediacrawler|media-crawler/u);
});

test("host prerequisite validation fails closed on missing, weak, linked, or exposed state", () => {
  const root = mkdtempSync(join(tmpdir(), "shensi-mediacrawler-runtime-"));
  const secret = join(root, "service-secret");
  const state = join(root, "encrypted-state");
  try {
    assert.throws(
      () => assertMediaCrawlerHostPrerequisites({ secretFile: secret, stateDirectory: state }),
      /MEDIACRAWLER_SECRET_FILE_MISSING/u
    );
    writeFileSync(secret, "short", { mode: 0o600 });
    mkdirSync(state, { mode: 0o700 });
    assert.throws(
      () => assertMediaCrawlerHostPrerequisites({ secretFile: secret, stateDirectory: state }),
      /MEDIACRAWLER_SECRET_TOO_SHORT/u
    );
    writeFileSync(secret, "s".repeat(64), { mode: 0o600 });
    chmodSync(state, 0o755);
    assert.throws(
      () => assertMediaCrawlerHostPrerequisites({ secretFile: secret, stateDirectory: state }),
      /MEDIACRAWLER_STATE_PERMISSIONS_MUST_BE_0700/u
    );
    chmodSync(state, 0o700);
    assert.doesNotThrow(() => assertMediaCrawlerHostPrerequisites({ secretFile: secret, stateDirectory: state }));

    const linked = join(root, "linked-secret");
    symlinkSync(secret, linked);
    assert.throws(
      () => assertMediaCrawlerHostPrerequisites({ secretFile: linked, stateDirectory: state }),
      /MEDIACRAWLER_SECRET_FILE_MUST_NOT_BE_SYMLINK/u
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rendered compose validation rejects a published or routed sidecar", () => {
  const safe = {
    services: {
      backend: { networks: { shensi_internal: null, shensi_mediacrawler: null } },
      "media-crawler": {
        networks: { shensi_mediacrawler: null, shensi_egress: null },
        read_only: true,
        secrets: [{ source: "mediacrawler_service_secret", target: "/run/secrets/mediacrawler_service_secret" }]
      },
      gateway: { networks: { shensi_internal: null } }
    },
    networks: { shensi_mediacrawler: { internal: true } }
  };
  assert.doesNotThrow(() => validateMediaCrawlerComposeConfig(safe));
  assert.throws(
    () => validateMediaCrawlerComposeConfig({
      ...safe,
      services: { ...safe.services, "media-crawler": { ...safe.services["media-crawler"], ports: [{ published: "8899" }] } }
    }),
    /MEDIACRAWLER_MUST_NOT_PUBLISH_PORTS/u
  );
  assert.throws(
    () => validateMediaCrawlerComposeConfig({
      ...safe,
      services: { ...safe.services, gateway: { networks: { shensi_internal: null, shensi_mediacrawler: null } } }
    }),
    /GATEWAY_MUST_NOT_ROUTE_MEDIACRAWLER/u
  );
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("compose has four isolated production services", () => {
  const compose = read("deploy/compose.yaml");
  for (const service of ["mysql:", "backend:", "frontend:", "gateway:"]) {
    assert.match(compose, new RegExp(`\\n  ${service}`));
  }
  assert.match(compose, /CRM_STORE: mysql/u);
  assert.match(compose, /NODE_ENV: production/u);
  assert.doesNotMatch(compose, /goodjob123|sk-[a-zA-Z0-9]/u);
});

test("runtime images are non-root and pinned", () => {
  const backend = read("deploy/docker/backend.Dockerfile");
  const frontend = read("deploy/docker/frontend.Dockerfile");
  assert.match(backend, /FROM node:22\.22\.3-bookworm-slim/u);
  assert.match(backend, /USER node/u);
  assert.match(frontend, /nginxinc\/nginx-unprivileged:1\.27-alpine/u);
});

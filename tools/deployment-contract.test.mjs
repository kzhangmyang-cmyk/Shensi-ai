import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const service = (compose, name) => compose
  .split(`\n  ${name}:\n`)[1]
  .split(/\n  (?:mysql|media-crawler|backend|frontend|gateway):\n|\n(?:secrets|volumes|networks):\n/u)[0];

test("compose has five isolated production services", () => {
  const compose = read("deploy/compose.yaml");
  for (const service of ["mysql:", "media-crawler:", "backend:", "frontend:", "gateway:"]) {
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

test("deployment secrets stay out of build context", () => {
  const dockerignore = read(".dockerignore");
  assert.match(dockerignore, /^deploy\/secrets\/$/mu);
});

test("only the backend and private MediaCrawler sidecar have egress", () => {
  const compose = read("deploy/compose.yaml");
  assert.match(service(compose, "backend"), /networks: \[shensi_internal, shensi_mediacrawler, shensi_egress\]/u);
  assert.match(service(compose, "backend"), /TRUSTED_PROXY_CIDRS: 172\.30\.0\.4\/32/u);
  assert.match(service(compose, "gateway"), /ipv4_address: 172\.30\.0\.4/u);
  assert.match(compose, /shensi_egress:\s*$/mu);
  assert.match(service(compose, "media-crawler"), /networks: \[shensi_mediacrawler, shensi_egress\]/u);
  for (const name of ["mysql", "frontend", "gateway"]) {
    assert.doesNotMatch(service(compose, name), /shensi_egress/u);
  }
});

test("deployment secret commands handle real line endings", () => {
  const deployment = read("docs/DEPLOYMENT.md");
  assert.match(deployment, /tr -d '\\n'/u);
  assert.doesNotMatch(deployment, /tr -d '\\\\n'/u);
  assert.match(deployment, /\/\[\\r\\n\]\//u);
  assert.doesNotMatch(deployment, /\/\[\\\\r\\\\n\]\//u);

  const newlineFree = execFileSync(
    "sh",
    ["-c", "printf 'alpha\\nbeta\\n' | tr -d '\\n'"],
    { encoding: "utf8" }
  );
  assert.equal(newlineFree, "alphabeta");
  assert.equal(/[\r\n]/u.test("alpha\r\nbeta"), true);
});

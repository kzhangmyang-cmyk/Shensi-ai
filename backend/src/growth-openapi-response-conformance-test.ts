import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import express from "express";
import { createGrowthBootstrapRouter } from "./growth-bootstrap-router.js";
import { loadGrowthContractRelease } from "./growth-openapi.js";
import {
  assertCatalogRuntimeResponsesConform
} from "./catalog-runtime-response-conformance-test.js";
import {
  assertQuoteRuntimeResponsesConform
} from "./quote-runtime-response-conformance-test.js";
import {
  assertFinanceRuntimeResponsesConform
} from "./growth-finance-openapi-response-conformance-test.js";

test("runtime bootstrap responses conform to GrowthBootstrapResponse", async () => {
  const release = loadGrowthContractRelease();
  const schema = JSON.parse(await readFile(new URL(
    "../../contracts/json-schema/growth-bootstrap.v1.schema.json",
    import.meta.url
  ), "utf8"));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const app = express();
  let selected = true;
  app.use(createGrowthBootstrapRouter({
    manifest: release.manifest,
    capabilityRegistryVersion: "growth-capabilities.v1",
    resolveContext: async () => selected
      ? ({
          workspaceId: "workspace-1",
          kind: "team",
          actorId: "user-1",
          role: "sales",
          teamId: "workspace-1",
          capabilities: ["catalog.read"],
          capabilityRegistryVersion: "growth-capabilities.v1"
        })
      : null,
    enabledFeatures: () => ["catalog"]
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/v1/growth/bootstrap`
    );
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(validate(body), true, JSON.stringify(validate.errors));
    assert.equal(body.contractVersion, release.manifest.contractVersion);
    assert.equal(body.contractHash, release.manifest.contractHash);

    selected = false;
    const selectionResponse = await fetch(
      `http://127.0.0.1:${port}/api/v1/growth/bootstrap`
    );
    const selectionBody = await selectionResponse.json();
    assert.equal(selectionResponse.status, 200);
    assert.equal(
      validate(selectionBody),
      true,
      JSON.stringify(validate.errors)
    );
    assert.equal(selectionBody.status, "workspace_selection_required");
    assert.equal(selectionBody.contractVersion, release.manifest.contractVersion);
    assert.equal(selectionBody.contractHash, release.manifest.contractHash);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) =>
      error ? reject(error) : resolve()));
  }
});

test(
  "central Growth response suite validates released Catalog operations",
  assertCatalogRuntimeResponsesConform
);

test(
  "central Growth response suite validates released Quote operations",
  assertQuoteRuntimeResponsesConform
);

test(
  "central Growth response suite validates released Finance operations",
  assertFinanceRuntimeResponsesConform
);

test("advisor today runtime response conforms to the released schema", async () => {
  const release = loadGrowthContractRelease();
  assert.equal(release.manifest.contractVersion, "1.0.10");
  const schema = JSON.parse(await readFile(new URL(
    "../../contracts/json-schema/advisor-today.v1.schema.json",
    import.meta.url
  ), "utf8"));
  const ajv = new Ajv2020({ strict: false });
  const schemaRoot = new URL("../../contracts/json-schema/", import.meta.url);
  for (const filename of await readdir(schemaRoot)) {
    if (!filename.endsWith(".schema.json")) continue;
    if (filename === "advisor-today.v1.schema.json") continue;
    const schema = JSON.parse(await readFile(
      new URL(filename, schemaRoot), "utf8"
    ));
    ajv.addSchema(schema);
  }
  const validate = ajv.compile(schema);
  const body = {
    workspaceId: "workspace-1",
    audienceRole: "manager",
    dataAsOf: "2026-08-09T08:00:00.000Z",
    priorityCustomers: [],
    pendingQuoteApprovals: [],
    expectedRoi: [],
    actualRoi: [],
    financialDataGaps: [],
    recommendations: [],
    sourceSnapshotHash: `sha256:${"a".repeat(64)}`
  };
  assert.equal(validate(body), true, JSON.stringify(validate.errors));
  const negative = { ...body, audienceRole: "engineer" };
  assert.equal(validate(negative), false);
});

import assert from "node:assert/strict";
import {
  replaceAcquisitionRuntimeConfiguration
} from "./mysql-store.js";

const current = {
  aiModelConfigs: [{ id: "model-old" }],
  modelCredentialVersions: [{ connectionId: "model-old", version: 1 }],
  aiJobModelSnapshots: [{ jobId: "job-old" }],
  providerCatalog: [{ id: "provider-old" }],
  providerConnections: [{ id: "connection-old", credentialVersion: 1 }]
};
const arrayIdentities = {
  aiModelConfigs: current.aiModelConfigs,
  modelCredentialVersions: current.modelCredentialVersions,
  aiJobModelSnapshots: current.aiJobModelSnapshots,
  providerCatalog: current.providerCatalog,
  providerConnections: current.providerConnections
};
const authoritative = {
  aiModelConfigs: [{ id: "model-current" }],
  modelCredentialVersions: [{
    connectionId: "model-current",
    version: 3
  }],
  aiJobModelSnapshots: [{ jobId: "job-current" }],
  providerCatalog: [{ id: "provider-current" }],
  providerConnections: [{
    id: "connection-current",
    credentialVersion: 4
  }]
};

replaceAcquisitionRuntimeConfiguration(
  current as never,
  authoritative as never
);

for (const key of Object.keys(arrayIdentities) as Array<
  keyof typeof arrayIdentities
>) {
  assert.equal(
    current[key],
    arrayIdentities[key],
    `${key} must preserve the shared array identity`
  );
  assert.deepEqual(current[key], authoritative[key]);
}

console.log("Acquisition runtime configuration refresh tests passed");

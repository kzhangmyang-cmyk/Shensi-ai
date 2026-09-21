import { strict as assert } from "node:assert";
import {
  createGrowthBootstrapLoader
} from "./bootstrap-api";

const client = {
  async request(path: string) {
    assert.equal(path, "/api/v1/growth/bootstrap");
    return {
      status: 200,
      etag: null,
      body: {
        status: "ready",
        workspaceId: "workspace-1",
        capabilityRegistryVersion: "growth-capabilities.v1",
        capabilities: ["catalog.read"],
        contractVersion: "1.0.3",
        contractHash: `sha256:${"a".repeat(64)}`,
        features: ["catalog"]
      }
    };
  }
} as never;

const loader = createGrowthBootstrapLoader(client);
const bootstrap = await loader.load();
assert.equal(bootstrap.status, "ready");
assert.equal(bootstrap.contractVersion, "1.0.3");

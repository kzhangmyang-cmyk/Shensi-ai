import assert from "node:assert/strict";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET =
  "goodjob-provider-version-test-secret-at-least-32-characters";

const server = await import("./server.js");
const resolveVersion = (
  server as typeof server & {
    resolveProviderConnectionCredentialVersion?: (input: {
      currentVersion?: number;
      currentConfiguration: { apiKey: string; baseUrl: string };
      nextConfiguration: { apiKey: string; baseUrl: string };
    }) => number;
  }
).resolveProviderConnectionCredentialVersion;

assert.equal(
  typeof resolveVersion,
  "function",
  "server must expose deterministic Provider connection versioning"
);

assert.equal(resolveVersion!({
  currentConfiguration: { apiKey: "", baseUrl: "" },
  nextConfiguration: { apiKey: "first-key", baseUrl: "https://search.example/v1" }
}), 1, "a new connection starts at credential/config version 1");

assert.equal(resolveVersion!({
  currentVersion: 4,
  currentConfiguration: {
    apiKey: "same-key",
    baseUrl: "https://search.example/v1"
  },
  nextConfiguration: {
    apiKey: "same-key",
    baseUrl: "https://search.example/v1"
  }
}), 4, "saving the same effective configuration keeps the version stable");

assert.equal(resolveVersion!({
  currentVersion: 4,
  currentConfiguration: {
    apiKey: "old-key",
    baseUrl: "https://search.example/v1"
  },
  nextConfiguration: {
    apiKey: "rotated-key",
    baseUrl: "https://search.example/v1"
  }
}), 5, "rotating the API key increments the version");

assert.equal(resolveVersion!({
  currentVersion: 4,
  currentConfiguration: {
    apiKey: "same-key",
    baseUrl: "https://search.example/v1"
  },
  nextConfiguration: {
    apiKey: "same-key",
    baseUrl: "https://search.example/v2"
  }
}), 5, "changing the execution base URL increments the version");

assert.equal(resolveVersion!({
  currentVersion: 0,
  currentConfiguration: {
    apiKey: "legacy-key",
    baseUrl: ""
  },
  nextConfiguration: {
    apiKey: "legacy-key",
    baseUrl: ""
  }
}), 1, "legacy or invalid versions normalize to the first positive version");

assert.equal(resolveVersion!({
  currentVersion: -2,
  currentConfiguration: {
    apiKey: "legacy-key",
    baseUrl: ""
  },
  nextConfiguration: {
    apiKey: "replacement-key",
    baseUrl: "https://search.example/v2"
  }
}), 1, "an invalid legacy version is materialized at 1 before future rotations");

console.log("Provider connection credential/config version tests passed");

import assert from "node:assert/strict";
import {
  IncomingMessage,
  ServerResponse
} from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import test from "node:test";
import express from "express";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import {
  ACQUISITION_SEARCH_PROVIDER_IDS,
  ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS
} from "./acquisition-discovery-providers.js";
import {
  acquisitionProviderConnectionVersion
} from "./acquisition-provider-connection-version.js";
import {
  decryptProviderConfigurationWithSecret
} from "./credential-security.js";
import { ProviderContractError } from "./provider-contract.js";
import {
  createAcquisitionProviderConnectionsRouter,
  type AcquisitionProviderConnectionStore,
  type AcquisitionProviderConnectionsRouterOptions
} from "./acquisition-provider-connections-router.js";
import type { ProviderConnection } from "./types.js";

const OWNER_A = "owner-provider-a";
const TEAM_A = "team-provider-a";
const CREDENTIAL_SECRET =
  "acquisition-provider-route-test-secret-at-least-32-characters";

function deterministicIds() {
  let sequence = 0;
  return (prefix: string) => `${prefix}-${++sequence}`;
}

function createStore(): AcquisitionProviderConnectionStore {
  return {
    providerCatalog: createDefaultProviderCatalog(),
    providerConnections: [],
    async persist() {},
    async readBarrier() {}
  };
}

function storedConnection(
  overrides: Partial<ProviderConnection> = {}
): ProviderConnection {
  return {
    id: "provider-connection-visible",
    providerId: "serper",
    scope: "personal",
    credentialRef: "credential-ref-visible",
    configurationEncrypted: "ciphertext-secret-must-not-be-returned",
    status: "active",
    quotaPolicy: {},
    budgetPolicy: {},
    lastHealthAt: "",
    lastHealthStatus: "untested",
    lastErrorCode: "",
    lastHealthMessage: "",
    usage: "",
    ownerId: OWNER_A,
    teamId: TEAM_A,
    createdBy: OWNER_A,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
    ...overrides
  };
}

async function createFixture(
  overrides: Partial<AcquisitionProviderConnectionsRouterOptions> = {}
) {
  const store = overrides.store ?? createStore();
  const app = express();
  app.use((req, _res, next) => {
    const ownerId = req.header("x-test-owner");
    const teamId = req.header("x-test-team");
    if (ownerId && teamId) {
      (req as unknown as {
        user?: { id: string; teamId: string };
      }).user = {
        id: ownerId,
        teamId
      };
    }
    next();
  });
  app.use(createAcquisitionProviderConnectionsRouter({
    store,
    credentialSecret: CREDENTIAL_SECRET,
    requestIdFactory: deterministicIds(),
    idFactory: deterministicIds(),
    now: () => "2026-07-24T00:00:00.000Z",
    ...overrides
  }));

  async function request(
    path: string,
    init: RequestInit = {},
    identity: { ownerId: string; teamId: string } | null = {
      ownerId: OWNER_A,
      teamId: TEAM_A
    }
  ) {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (typeof init.body === "string") {
      headers.set(
        "content-length",
        String(Buffer.byteLength(init.body, "utf8"))
      );
    }
    if (identity) {
      headers.set("x-test-owner", identity.ownerId);
      headers.set("x-test-team", identity.teamId);
    }
    class MockSocket extends Duplex {
      readonly chunks: Buffer[] = [];

      override _read() {}

      override _write(
        chunk: Uint8Array,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void
      ) {
        this.chunks.push(Buffer.from(chunk));
        callback();
      }
    }
    const socket = new MockSocket();
    const incoming = new IncomingMessage(
      socket as unknown as Socket
    );
    incoming.method = init.method || "GET";
    incoming.url = path;
    incoming.headers = Object.fromEntries(
      [...headers.entries()].map(([key, value]) => [
        key.toLocaleLowerCase(),
        value
      ])
    );
    if (typeof init.body === "string") {
      (incoming as IncomingMessage & { body?: unknown }).body =
        JSON.parse(init.body);
    }
    const outgoing = new ServerResponse(incoming);
    outgoing.assignSocket(socket as unknown as Socket);
    const finished = new Promise<void>((resolve, reject) => {
      outgoing.on("finish", resolve);
      outgoing.on("error", reject);
    });
    const dispatch = app as unknown as (
      req: IncomingMessage,
      res: ServerResponse
    ) => void;
    dispatch(incoming, outgoing);
    incoming.push(null);
    await finished;
    const raw = Buffer.concat(socket.chunks).toString("utf8");
    const separator = raw.indexOf("\r\n\r\n");
    const head = raw.slice(0, separator);
    const body = raw.slice(separator + 4);
    const [statusLine = "", ...headerLines] = head.split("\r\n");
    const status = Number(statusLine.match(/^HTTP\/\d\.\d (\d{3})/u)?.[1]);
    const responseHeaders = new Headers();
    for (const line of headerLines) {
      const colon = line.indexOf(":");
      if (colon > 0) {
        responseHeaders.append(
          line.slice(0, colon).trim(),
          line.slice(colon + 1).trim()
        );
      }
    }
    const response = {
      status,
      headers: responseHeaders
    };
    const json = body ? JSON.parse(body) : null;
    return { response, json };
  }

  return {
    store,
    request,
    async close() {}
  };
}

test("v1 acquisition provider catalog exposes six executable searches and two fixed system providers", async () => {
  assert.deepEqual(ACQUISITION_SEARCH_PROVIDER_IDS, [
    "baidu_ai_search",
    "tencent_web_search",
    "serper",
    "brave",
    "serpapi",
    "tavily"
  ]);

  const fixture = await createFixture();
  try {
    const result = await fixture.request("/api/v1/acquisition/providers");
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(result.response.headers.get("x-request-id"), "request-1");
    assert.deepEqual(
      result.json.items.map((item: { id: string }) => item.id).sort(),
      [
        "authorized_file_import",
        "baidu_ai_search",
        "brave",
        "controlled_public_content",
        "serpapi",
        "serper",
        "tavily",
        "tencent_web_search"
      ].sort()
    );
    assert.equal(
      result.json.items.filter(
        (item: { kind: string }) => item.kind === "search"
      ).length,
      6
    );
    const baidu = result.json.items.find(
      (item: { id: string }) => item.id === "baidu_ai_search"
    );
    assert.equal(baidu.requiresKey, true);
    assert.equal(
      baidu.defaultBaseUrl,
      "https://qianfan.baidubce.com/v2/ai_search"
    );
    assert.match(baidu.officialDocsUrl, /^https:\/\/cloud\.baidu\.com\//u);
    assert.match(baidu.keyHint, /API Key/u);
    assert.equal(JSON.stringify(result.json).includes("apiKey"), false);
    assert.equal(JSON.stringify(result.json).includes("credential"), false);
  } finally {
    await fixture.close();
  }
});

test("v1 creates an owner-scoped BYOK search connection with write-only encrypted credentials", async () => {
  const fixture = await createFixture();
  const apiKey = "serper-private-route-key";
  try {
    const result = await fixture.request(
      "/api/v1/acquisition/provider-connections",
      {
        method: "POST",
        headers: { "Idempotency-Key": "create-serper-connection" },
        body: JSON.stringify({
          providerId: "serper",
          apiKey,
          baseUrl: "https://google.serper.dev",
          status: "active"
        })
      }
    );

    assert.equal(result.response.status, 201);
    assert.deepEqual(Object.keys(result.json).sort(), [
      "createdAt",
      "credentialVersion",
      "id",
      "kind",
      "lastErrorCode",
      "lastHealthAt",
      "lastHealthMessage",
      "lastHealthStatus",
      "ownerId",
      "providerId",
      "status",
      "teamId",
      "usage"
    ]);
    assert.equal(result.json.ownerId, OWNER_A);
    assert.equal(result.json.teamId, TEAM_A);
    assert.equal(result.json.providerId, "serper");
    assert.equal(result.json.kind, "search");
    assert.equal(result.json.status, "active");
    assert.equal(result.json.credentialVersion, 1);
    assert.equal(result.json.lastHealthAt, null);
    assert.equal(result.json.lastHealthStatus, "untested");
    assert.equal(result.json.lastErrorCode, null);
    assert.equal(result.json.lastHealthMessage, "");
    assert.equal(result.json.usage, "");
    assert.equal(JSON.stringify(result.json).includes(apiKey), false);

    assert.equal(fixture.store.providerConnections.length, 1);
    const stored = fixture.store.providerConnections[0]!;
    assert.equal(stored.ownerId, OWNER_A);
    assert.equal(stored.teamId, TEAM_A);
    assert.equal(stored.scope, "personal");
    assert.equal(stored.configurationEncrypted.includes(apiKey), false);
    assert.deepEqual(
      decryptProviderConfigurationWithSecret(
        stored,
        stored.configurationEncrypted,
        CREDENTIAL_SECRET
      ),
      {
        apiKey,
        baseUrl: "https://google.serper.dev"
      }
    );
  } finally {
    await fixture.close();
  }
});

test("v1 provider connection writes use the serialized store mutation boundary", async () => {
  let mutationCalls = 0;
  let directPersistCalls = 0;
  const store = createStore();
  store.persist = async () => {
    directPersistCalls += 1;
  };
  store.persistMutation = async (mutation) => {
    mutationCalls += 1;
    return mutation().value;
  };
  const fixture = await createFixture({ store });
  try {
    const result = await fixture.request(
      "/api/v1/acquisition/provider-connections",
      {
        method: "POST",
        headers: { "Idempotency-Key": "serialized-create" },
        body: JSON.stringify({
          providerId: "tavily",
          apiKey: "tavily-private-key",
          status: "disabled"
        })
      }
    );

    assert.equal(result.response.status, 201);
    assert.equal(mutationCalls, 1);
    assert.equal(directPersistCalls, 0);
    assert.equal(store.providerConnections.length, 1);
  } finally {
    await fixture.close();
  }
});

test("v1 provider uniqueness is scoped by owner and team inside serialized writes", async () => {
  const store = createStore();
  let tail = Promise.resolve();
  let activeMutations = 0;
  let maximumActiveMutations = 0;
  store.persistMutation = async (mutation) => {
    const current = tail.then(async () => {
      activeMutations += 1;
      maximumActiveMutations = Math.max(
        maximumActiveMutations,
        activeMutations
      );
      try {
        await Promise.resolve();
        return mutation().value;
      } finally {
        activeMutations -= 1;
      }
    });
    tail = current.then(() => undefined, () => undefined);
    return current;
  };
  const fixture = await createFixture({ store });
  const create = (
    idempotencyKey: string,
    teamId: string
  ) => fixture.request(
    "/api/v1/acquisition/provider-connections",
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        providerId: "serper",
        apiKey: `private-${idempotencyKey}`
      })
    },
    { ownerId: OWNER_A, teamId }
  );
  try {
    const crossTeam = await Promise.all([
      create("same-owner-team-a", TEAM_A),
      create("same-owner-team-b", "team-provider-b")
    ]);
    assert.deepEqual(
      crossTeam.map((result) => result.response.status),
      [201, 201]
    );
    assert.deepEqual(
      store.providerConnections
        .map((connection) => connection.teamId)
        .sort(),
      [TEAM_A, "team-provider-b"].sort()
    );

    const sameTeam = await Promise.all([
      create("same-team-duplicate-a", "team-provider-c"),
      create("same-team-duplicate-b", "team-provider-c")
    ]);
    assert.deepEqual(
      sameTeam.map((result) => result.response.status).sort(),
      [201, 409]
    );
    assert.equal(
      sameTeam.find((result) => result.response.status === 409)?.json.code,
      "provider_connection_exists"
    );
    assert.equal(
      store.providerConnections.filter(
        (connection) => connection.teamId === "team-provider-c"
      ).length,
      1
    );
    assert.equal(maximumActiveMutations, 1);
  } finally {
    await fixture.close();
  }
});

test("v1 create replays exactly and rejects conflicting Idempotency-Key reuse", async () => {
  const fixture = await createFixture();
  const path = "/api/v1/acquisition/provider-connections";
  const idempotencyKey = "idempotent-provider-create";
  const apiKey = "brave-private-idempotent-key";
  const body = {
    providerId: "brave",
    apiKey,
    baseUrl: "https://api.search.brave.com/res/v1",
    status: "disabled"
  };
  try {
    const first = await fixture.request(path, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body)
    });
    assert.equal(first.response.status, 201);
    const storedCiphertext =
      fixture.store.providerConnections[0]?.configurationEncrypted;

    const replay = await fixture.request(path, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(body)
    });
    assert.equal(replay.response.status, 200);
    assert.equal(
      replay.response.headers.get("idempotency-replayed"),
      "true"
    );
    assert.deepEqual(replay.json, first.json);
    assert.equal(fixture.store.providerConnections.length, 1);
    assert.equal(
      fixture.store.providerConnections[0]?.configurationEncrypted,
      storedCiphertext
    );

    const conflict = await fixture.request(path, {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        ...body,
        apiKey: "different-private-key"
      })
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.json.code, "idempotency_key_conflict");
    assert.equal(fixture.store.providerConnections.length, 1);
    assert.equal(
      JSON.stringify(fixture.store.providerConnections).includes(
        idempotencyKey
      ),
      false
    );
    assert.equal(
      JSON.stringify(fixture.store.providerConnections).includes(apiKey),
      false
    );
  } finally {
    await fixture.close();
  }
});

test("v1 connection reads include fixed systems and enforce exact owner-and-team scope without decrypting", async () => {
  const visible = storedConnection();
  const otherOwner = storedConnection({
    id: "provider-connection-other-owner",
    providerId: "tavily",
    ownerId: "owner-provider-b"
  });
  const otherTeam = storedConnection({
    id: "provider-connection-other-team",
    providerId: "brave",
    teamId: "team-provider-b"
  });
  const nonPersonal = storedConnection({
    id: "provider-connection-platform",
    providerId: "serpapi",
    scope: "platform"
  });
  const store = createStore();
  store.providerConnections.push(
    visible,
    otherOwner,
    otherTeam,
    nonPersonal
  );
  const fixture = await createFixture({ store });
  try {
    const list = await fixture.request(
      "/api/v1/acquisition/provider-connections"
    );
    assert.equal(list.response.status, 200);
    assert.deepEqual(
      list.json.items.map((item: { id: string }) => item.id).sort(),
      [
        visible.id,
        ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS.contentFetch.connectionId,
        ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS.import.connectionId
      ].sort()
    );
    const publicVisible = list.json.items.find(
      (item: { id: string }) => item.id === visible.id
    );
    assert.equal(
      publicVisible.credentialVersion,
      acquisitionProviderConnectionVersion(visible)
    );
    assert.deepEqual(publicVisible, {
      id: visible.id,
      ownerId: OWNER_A,
      teamId: TEAM_A,
      providerId: visible.providerId,
      kind: "search",
      status: "active",
      credentialVersion: acquisitionProviderConnectionVersion(visible),
      lastHealthAt: null,
      lastHealthStatus: "untested",
      lastErrorCode: null,
      lastHealthMessage: "",
      usage: "",
      createdAt: visible.createdAt
    });
    assert.equal(
      JSON.stringify(list.json).includes(
        visible.configurationEncrypted
      ),
      false
    );

    const detail = await fixture.request(
      `/api/v1/acquisition/provider-connections/${visible.id}`
    );
    assert.equal(detail.response.status, 200);
    assert.equal(detail.json.id, visible.id);
    assert.equal("configurationEncrypted" in detail.json, false);
    assert.equal("credentialRef" in detail.json, false);
    assert.equal("apiKey" in detail.json, false);
    assert.equal("baseUrl" in detail.json, false);

    const system = await fixture.request(
      `/api/v1/acquisition/provider-connections/${
        ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS.contentFetch.connectionId
      }`
    );
    assert.equal(system.response.status, 200);
    assert.equal(system.json.kind, "content_fetch");
    assert.equal(system.json.ownerId, "system");
    assert.equal(system.json.teamId, null);
    assert.equal(system.json.lastHealthAt, null);
    assert.equal(system.json.lastHealthStatus, "untested");
    assert.equal(system.json.lastErrorCode, null);
    assert.equal(system.json.lastHealthMessage, "系统托管来源");
    assert.equal(system.json.usage, "");
    assert.equal("credentialRef" in system.json, false);
    assert.equal("configurationEncrypted" in system.json, false);
    assert.equal("baseUrl" in system.json, false);

    const hidden = await fixture.request(
      `/api/v1/acquisition/provider-connections/${otherOwner.id}`
    );
    assert.equal(hidden.response.status, 404);
    assert.equal(hidden.json.code, "provider_connection_not_found");
  } finally {
    await fixture.close();
  }
});

test("v1 patch rotates credentials once while status-only changes preserve the credential version", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.request(
      "/api/v1/acquisition/provider-connections",
      {
        method: "POST",
        headers: { "Idempotency-Key": "patch-target-create" },
        body: JSON.stringify({
          providerId: "tencent_web_search",
          apiKey: "tencent-original-private-key",
          status: "disabled"
        })
      }
    );
    assert.equal(created.response.status, 201);
    const connection = fixture.store.providerConnections[0]!;
    const originalCiphertext = connection.configurationEncrypted;

    const activated = await fixture.request(
      `/api/v1/acquisition/provider-connections/${connection.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status: "active" })
      }
    );
    assert.equal(activated.response.status, 200);
    assert.equal(activated.json.status, "active");
    assert.equal(activated.json.credentialVersion, 1);
    assert.equal(connection.configurationEncrypted, originalCiphertext);

    const nextApiKey = "tencent-rotated-private-key";
    const rotated = await fixture.request(
      `/api/v1/acquisition/provider-connections/${connection.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          apiKey: nextApiKey,
          baseUrl: "https://api.wsa.cloud.tencent.com"
        })
      }
    );
    assert.equal(rotated.response.status, 200);
    assert.equal(rotated.json.credentialVersion, 2);
    assert.equal(JSON.stringify(rotated.json).includes(nextApiKey), false);
    assert.notEqual(connection.configurationEncrypted, originalCiphertext);
    assert.deepEqual(
      decryptProviderConfigurationWithSecret(
        connection,
        connection.configurationEncrypted,
        CREDENTIAL_SECRET
      ),
      {
        apiKey: nextApiKey,
        baseUrl: "https://api.wsa.cloud.tencent.com"
      }
    );
    assert.equal(connection.lastHealthStatus, "untested");
    assert.equal(connection.lastHealthAt, "");
  } finally {
    await fixture.close();
  }
});

test("v1 deletes only owner-scoped BYOK connections and keeps system connections read-only", async () => {
  const fixture = await createFixture();
  try {
    const created = await fixture.request(
      "/api/v1/acquisition/provider-connections",
      {
        method: "POST",
        headers: { "Idempotency-Key": "delete-target-create" },
        body: JSON.stringify({
          providerId: "baidu_ai_search",
          apiKey: "baidu-delete-private-key"
        })
      }
    );
    assert.equal(created.response.status, 201);

    const deleted = await fixture.request(
      `/api/v1/acquisition/provider-connections/${created.json.id}`,
      { method: "DELETE" }
    );
    assert.equal(deleted.response.status, 204);
    assert.equal(deleted.json, null);
    assert.equal(fixture.store.providerConnections.length, 0);

    const systemId =
      ACQUISITION_SYSTEM_PROVIDER_CONNECTIONS.import.connectionId;
    const blocked = await fixture.request(
      `/api/v1/acquisition/provider-connections/${systemId}`,
      { method: "DELETE" }
    );
    assert.equal(blocked.response.status, 403);
    assert.equal(blocked.json.code, "system_connection_read_only");
    assert.equal(
      JSON.stringify(blocked.json).includes(CREDENTIAL_SECRET),
      false
    );
  } finally {
    await fixture.close();
  }
});

test("v1 connection test delegates without exposing the credential secret and persists sanitized health", async () => {
  const testerInputs: Array<Record<string, unknown>> = [];
  const fixture = await createFixture({
    async connectionTester(input) {
      testerInputs.push(input as unknown as Record<string, unknown>);
      return {
        ok: true,
        message: "腾讯云联网搜索连接通过",
        errorCode: null,
        retryable: false,
        retryAfterAt: null,
        usage: "fixture usage"
      };
    }
  });
  try {
    const created = await fixture.request(
      "/api/v1/acquisition/provider-connections",
      {
        method: "POST",
        headers: { "Idempotency-Key": "test-target-create" },
        body: JSON.stringify({
          providerId: "tencent_web_search",
          apiKey: "tencent-test-private-key",
          status: "disabled"
        })
      }
    );
    assert.equal(created.response.status, 201);
    const beforeVersion = created.json.credentialVersion;

    const tested = await fixture.request(
      `/api/v1/acquisition/provider-connections/${created.json.id}/test`,
      { method: "POST" }
    );
    assert.equal(tested.response.status, 200);
    assert.deepEqual(tested.json, {
      ok: true,
      message: "数据源连接测试通过",
      errorCode: null,
      retryable: false,
      retryAfterAt: null,
      usage: "fixture usage"
    });
    assert.equal(testerInputs.length, 1);
    assert.equal("credentialSecret" in testerInputs[0]!, false);
    assert.equal(
      JSON.stringify(testerInputs[0]).includes(CREDENTIAL_SECRET),
      false
    );
    assert.deepEqual(testerInputs[0]?.scope, {
      ownerId: OWNER_A,
      teamId: TEAM_A
    });

    const connection = fixture.store.providerConnections[0]!;
    assert.equal(connection.lastHealthStatus, "passed");
    assert.equal(connection.lastHealthAt, "2026-07-24T00:00:00.000Z");
    assert.equal(connection.lastHealthMessage, tested.json.message);
    assert.equal(connection.usage, "fixture usage");
    assert.equal(
      acquisitionProviderConnectionVersion(connection),
      beforeVersion
    );
    const refreshed = await fixture.request(
      `/api/v1/acquisition/provider-connections/${created.json.id}`
    );
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.json.lastHealthStatus, "passed");
    assert.equal(
      refreshed.json.lastHealthAt,
      "2026-07-24T00:00:00.000Z"
    );
    assert.equal(
      refreshed.json.lastHealthMessage,
      "数据源连接测试通过"
    );
    assert.equal(refreshed.json.lastErrorCode, null);
    assert.equal(refreshed.json.usage, "fixture usage");
  } finally {
    await fixture.close();
  }
});

test("v1 failed connection tests remain visible through the public health projection", async () => {
  const fixture = await createFixture({
    async connectionTester() {
      return {
        ok: false,
        message: "数据源授权已失效，请检查连接配置",
        errorCode: "PROVIDER_AUTH_FAILED",
        retryable: false,
        retryAfterAt: null,
        usage: ""
      };
    }
  });
  try {
    const created = await fixture.request(
      "/api/v1/acquisition/provider-connections",
      {
        method: "POST",
        headers: { "Idempotency-Key": "failed-health-create" },
        body: JSON.stringify({
          providerId: "serpapi",
          apiKey: "failed-health-private-key"
        })
      }
    );
    const tested = await fixture.request(
      `/api/v1/acquisition/provider-connections/${created.json.id}/test`,
      { method: "POST" }
    );
    assert.equal(tested.response.status, 200);
    assert.equal(tested.json.ok, false);

    const refreshed = await fixture.request(
      `/api/v1/acquisition/provider-connections/${created.json.id}`
    );
    assert.equal(refreshed.response.status, 200);
    assert.equal(refreshed.json.lastHealthStatus, "failed");
    assert.equal(
      refreshed.json.lastHealthMessage,
      "数据源授权已失效，请检查连接配置"
    );
    assert.equal(refreshed.json.lastErrorCode, "provider_auth_failed");
    assert.equal(
      JSON.stringify(refreshed.json).includes("failed-health-private-key"),
      false
    );
  } finally {
    await fixture.close();
  }
});

test("v1 health projections redact tester messages containing connection configuration", async () => {
  const configuredBaseUrl = "https://google.serper.dev";
  const apiKey = "health-message-private-api-key";
  let credentialRef = "";
  const fixture = await createFixture({
    async connectionTester(input) {
      credentialRef = input.connection.credentialRef;
      return {
        ok: false,
        message: [
          `network request to ${configuredBaseUrl} failed`,
          `credential ${credentialRef}`,
          `api key ${apiKey}`
        ].join("; "),
        errorCode: "PROVIDER_NETWORK_ERROR",
        retryable: true,
        retryAfterAt: null,
        usage: ""
      };
    }
  });
  try {
    const created = await fixture.request(
      "/api/v1/acquisition/provider-connections",
      {
        method: "POST",
        headers: { "Idempotency-Key": "redacted-health-create" },
        body: JSON.stringify({
          providerId: "serper",
          apiKey,
          baseUrl: configuredBaseUrl
        })
      }
    );
    const tested = await fixture.request(
      `/api/v1/acquisition/provider-connections/${created.json.id}/test`,
      { method: "POST" }
    );
    assert.equal(tested.response.status, 200);
    assert.equal(tested.json.message, "数据源连接异常，可稍后重试");

    const detail = await fixture.request(
      `/api/v1/acquisition/provider-connections/${created.json.id}`
    );
    const list = await fixture.request(
      "/api/v1/acquisition/provider-connections"
    );
    for (const projection of [detail.json, list.json]) {
      const serialized = JSON.stringify(projection);
      assert.equal(serialized.includes(configuredBaseUrl), false);
      assert.equal(serialized.includes(credentialRef), false);
      assert.equal(serialized.includes(apiKey), false);
      assert.match(serialized, /数据源连接异常，可稍后重试/u);
    }
  } finally {
    await fixture.close();
  }
});

test("v1 provider routes return structured auth, idempotency, policy, and read-only errors", async () => {
  const fixture = await createFixture();
  const errorKeys = [
    "code",
    "details",
    "message",
    "requestId",
    "retryable"
  ];
  try {
    const unauthenticated = await fixture.request(
      "/api/v1/acquisition/providers",
      {},
      null
    );
    assert.equal(unauthenticated.response.status, 401);
    assert.deepEqual(
      Object.keys(unauthenticated.json).sort(),
      errorKeys
    );
    assert.equal(unauthenticated.json.code, "unauthorized");
    assert.equal(
      unauthenticated.response.headers.get("cache-control"),
      "no-store"
    );
    assert.ok(unauthenticated.json.requestId);

    const missingKey = await fixture.request(
      "/api/v1/acquisition/provider-connections",
      {
        method: "POST",
        body: JSON.stringify({
          providerId: "serper",
          apiKey: "never-persisted-without-idempotency"
        })
      }
    );
    assert.equal(missingKey.response.status, 400);
    assert.equal(missingKey.json.code, "idempotency_key_required");
    assert.equal(fixture.store.providerConnections.length, 0);

    const systemCreate = await fixture.request(
      "/api/v1/acquisition/provider-connections",
      {
        method: "POST",
        headers: { "Idempotency-Key": "reject-system-create" },
        body: JSON.stringify({
          providerId: "controlled_public_content",
          apiKey: "must-not-be-stored"
        })
      }
    );
    assert.equal(systemCreate.response.status, 403);
    assert.equal(
      systemCreate.json.code,
      "system_connection_read_only"
    );

    const invalidNetwork = await fixture.request(
      "/api/v1/acquisition/provider-connections",
      {
        method: "POST",
        headers: { "Idempotency-Key": "reject-network-create" },
        body: JSON.stringify({
          providerId: "serper",
          apiKey: "must-not-reach-evil-host",
          baseUrl: "https://evil.example.test/search"
        })
      }
    );
    assert.equal(invalidNetwork.response.status, 400);
    assert.equal(
      invalidNetwork.json.code,
      "invalid_provider_base_url"
    );
    assert.equal(fixture.store.providerConnections.length, 0);
  } finally {
    await fixture.close();
  }
});

test("v1 maps sanitized upstream tester failures without confusing provider auth with user auth", async () => {
  let failure: ProviderContractError = new ProviderContractError({
    code: "PROVIDER_AUTH_FAILED",
    retryable: false,
    retryAfterAt: null,
    publicMessage: "数据源授权已失效，请检查连接配置",
    httpStatus: 401,
    phase: "health"
  }, {
    cause: new Error("upstream rejected super-private-provider-key")
  });
  const fixture = await createFixture({
    async connectionTester() {
      throw failure;
    }
  });
  try {
    const created = await fixture.request(
      "/api/v1/acquisition/provider-connections",
      {
        method: "POST",
        headers: { "Idempotency-Key": "tester-error-target" },
        body: JSON.stringify({
          providerId: "serpapi",
          apiKey: "super-private-provider-key"
        })
      }
    );
    assert.equal(created.response.status, 201);
    const path =
      `/api/v1/acquisition/provider-connections/${created.json.id}/test`;

    const auth = await fixture.request(path, { method: "POST" });
    assert.equal(auth.response.status, 422);
    assert.equal(auth.json.code, "provider_auth_failed");
    assert.equal(auth.json.retryable, false);
    assert.equal(
      JSON.stringify(auth.json).includes("super-private-provider-key"),
      false
    );

    failure = new ProviderContractError({
      code: "PROVIDER_TIMEOUT",
      retryable: true,
      retryAfterAt: null,
      publicMessage: "数据源连接超时，请稍后重试",
      httpStatus: null,
      phase: "health"
    });
    const timeout = await fixture.request(path, { method: "POST" });
    assert.equal(timeout.response.status, 503);
    assert.equal(timeout.json.code, "provider_timeout");
    assert.equal(timeout.json.retryable, true);
  } finally {
    await fixture.close();
  }
});

test("v1 rolls back and maps provider connection persistence failures as retryable", async () => {
  const store = createStore();
  store.persistMutation = async (mutation) => {
    const applied = mutation();
    applied.rollback();
    throw new Error("fixture database credentials must stay private");
  };
  const fixture = await createFixture({ store });
  try {
    const result = await fixture.request(
      "/api/v1/acquisition/provider-connections",
      {
        method: "POST",
        headers: { "Idempotency-Key": "persistence-failure-create" },
        body: JSON.stringify({
          providerId: "tavily",
          apiKey: "persistence-failure-private-key"
        })
      }
    );
    assert.equal(result.response.status, 503);
    assert.equal(
      result.json.code,
      "provider_connection_persistence_failed"
    );
    assert.equal(result.json.retryable, true);
    assert.equal(store.providerConnections.length, 0);
    assert.equal(
      JSON.stringify(result.json).includes(
        "persistence-failure-private-key"
      ),
      false
    );
    assert.equal(
      JSON.stringify(result.json).includes("database credentials"),
      false
    );
  } finally {
    await fixture.close();
  }
});

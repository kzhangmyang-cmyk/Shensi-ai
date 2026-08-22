import assert from "node:assert/strict";
import {
  IncomingMessage,
  ServerResponse
} from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { test } from "node:test";
import express from "express";
import type { DiscoveryEvidenceInput } from "./acquisition-domain.js";
import {
  AcquisitionDiscoveryOperationError,
  AcquisitionDiscoveryOperationService,
  InMemoryAcquisitionDiscoveryOperationRepository,
  type AcquisitionDiscoveryScope
} from "./acquisition-discovery-operations.js";
import {
  createAcquisitionDiscoveryOperationsRouter
} from "./acquisition-discovery-operations-router.js";

const OWNER = "owner-a";
const TEAM = "team-a";
const NOW = "2026-07-24T08:00:00.000Z";

async function fixture(options: {
  fetchDispatchError?: Error;
  importDispatchError?: Error;
} = {}) {
  const repository =
    new InMemoryAcquisitionDiscoveryOperationRepository();
  const service = new AcquisitionDiscoveryOperationService({
    repository,
    evidence: {
      async appendEvidence(
        scope: AcquisitionDiscoveryScope,
        input: DiscoveryEvidenceInput
      ) {
        return {
          ...input,
          id: "evidence-1",
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          supersedesEvidenceId: input.supersedesEvidenceId ?? null,
          fetchedAt: NOW
        };
      }
    },
    masterSecret:
      "goodjob-discovery-router-test-secret-at-least-32-bytes",
    idFactory: (prefix) => `${prefix}-${repository.size(prefix) + 1}`,
    now: () => NOW
  });
  const fetchDispatches: Array<{
    scope: AcquisitionDiscoveryScope;
    id: string;
  }> = [];
  const importDispatches: Array<{
    scope: AcquisitionDiscoveryScope;
    id: string;
  }> = [];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const ownerId = req.header("x-test-owner");
    const teamId = req.header("x-test-team");
    if (ownerId && teamId) {
      req.user = {
        id: ownerId,
        teamId,
        name: ownerId,
        email: `${ownerId}@example.test`,
        role: "sales",
        avatar: "",
        authVersion: 1
      };
    }
    next();
  });
  app.use(createAcquisitionDiscoveryOperationsRouter({
    service,
    dispatchContentFetchOperation: async (scope, id) => {
      fetchDispatches.push({ scope: structuredClone(scope), id });
      if (options.fetchDispatchError) throw options.fetchDispatchError;
    },
    dispatchImportOperation: async (scope, id) => {
      importDispatches.push({ scope: structuredClone(scope), id });
      if (options.importDispatchError) throw options.importDispatchError;
    },
    requestIdFactory: () => "discovery-request-1"
  }));

  async function request(
    path: string,
    init: RequestInit = {},
    identity: { ownerId: string; teamId: string } | null = {
      ownerId: OWNER,
      teamId: TEAM
    }
  ) {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    if (identity) {
      headers.set("x-test-owner", identity.ownerId);
      headers.set("x-test-team", identity.teamId);
    }
    const requestBody = typeof init.body === "string"
      ? Buffer.from(init.body)
      : init.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : null;
    if (requestBody && !headers.has("content-length")) {
      headers.set("content-length", String(requestBody.length));
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
    const nodeSocket = socket as unknown as Socket;
    const incoming = new IncomingMessage(nodeSocket);
    incoming.method = init.method ?? "GET";
    incoming.url = path;
    (incoming as unknown as { complete: boolean }).complete = true;
    incoming.headers = Object.fromEntries(
      [...headers.entries()].map(([key, value]) => [
        key.toLocaleLowerCase(),
        value
      ])
    );
    const outgoing = new ServerResponse(incoming);
    outgoing.assignSocket(nodeSocket);
    const finished = new Promise<void>((resolve, reject) => {
      outgoing.on("finish", resolve);
      outgoing.on("error", reject);
    });
    if (requestBody) incoming.push(requestBody);
    incoming.push(null);
    (app as unknown as {
      handle(req: IncomingMessage, res: ServerResponse): void;
    }).handle(incoming, outgoing);
    await finished;
    const raw = Buffer.concat(socket.chunks).toString("utf8");
    const separator = raw.indexOf("\r\n\r\n");
    const head = raw.slice(0, separator);
    const body = raw.slice(separator + 4);
    const [statusLine = "", ...headerLines] = head.split("\r\n");
    const status = Number(
      statusLine.match(/^HTTP\/\d\.\d (\d{3})/u)?.[1]
    );
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
    const json = (
      body
      && responseHeaders.get("content-type")?.includes("application/json")
        ? JSON.parse(body)
        : null
    ) as
      | Record<string, unknown>
      | null;
    return { response, json };
  }

  return {
    request,
    fetchDispatches,
    importDispatches,
    async close() {}
  };
}

test("content fetch HTTP create dispatches and returns a sanitized tenant operation", async () => {
  const app = await fixture();
  try {
    const created = await app.request(
      "/api/v1/acquisition/content-fetch-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "fetch-http-key-1" },
        body: JSON.stringify({
          sourceUrl: "https://example.com/public-opportunity",
          subjectChannel: "organization"
        })
      }
    );

    assert.equal(
      created.response.status,
      202,
      JSON.stringify(created.json)
    );
    assert.equal(created.response.headers.get("cache-control"), "no-store");
    assert.equal(
      created.response.headers.get("x-request-id"),
      "discovery-request-1"
    );
    assert.equal(created.json?.status, "queued");
    assert.equal(created.json?.commentSampleSummary, null);
    assert.equal(created.json?.ownerId, OWNER);
    assert.equal("idempotencyKeyHash" in (created.json ?? {}), false);
    assert.equal("requestHash" in (created.json ?? {}), false);
    assert.deepEqual(app.fetchDispatches, [{
      scope: { ownerId: OWNER, teamId: TEAM, actorId: OWNER },
      id: created.json?.id
    }]);

    const loaded = await app.request(
      `/api/v1/acquisition/content-fetch-operations/${created.json?.id}`
    );
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.json?.id, created.json?.id);
  } finally {
    await app.close();
  }
});

test("content fetch HTTP list is bounded and tenant isolated", async () => {
  const app = await fixture();
  try {
    await app.request(
      "/api/v1/acquisition/content-fetch-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "fetch-list-http-key-1" },
        body: JSON.stringify({
          sourceUrl: "https://example.com/first",
          subjectChannel: "organization"
        })
      }
    );
    const foreign = await app.request(
      "/api/v1/acquisition/content-fetch-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "fetch-list-http-key-foreign" },
        body: JSON.stringify({
          sourceUrl: "https://example.com/foreign",
          subjectChannel: "individual"
        })
      },
      { ownerId: "owner-b", teamId: TEAM }
    );
    const latest = await app.request(
      "/api/v1/acquisition/content-fetch-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "fetch-list-http-key-2" },
        body: JSON.stringify({
          sourceUrl: "https://example.com/latest",
          subjectChannel: "individual"
        })
      }
    );

    const listed = await app.request(
      "/api/v1/acquisition/content-fetch-operations?limit=1"
    );
    assert.equal(listed.response.status, 200);
    const items = listed.json?.items as Array<Record<string, unknown>>;
    assert.deepEqual(items.map((item) => item.id), [latest.json?.id]);
    assert.equal(items[0]?.ownerId, OWNER);

    const hidden = await app.request(
      `/api/v1/acquisition/content-fetch-operations/${foreign.json?.id}`
    );
    assert.equal(hidden.response.status, 404);
    assert.equal(hidden.json?.code, "resource_not_found");
  } finally {
    await app.close();
  }
});

test("CSV import HTTP create consumes raw bytes and returns no artifact material", async () => {
  const app = await fixture();
  try {
    const mapping = JSON.stringify({
      sourceTitle: "title",
      sourceSnippet: "snippet"
    });
    const csv = Buffer.from(
      "title,snippet\r\nPublic opportunity,Customer needs CRM",
      "utf8"
    );
    const created = await app.request(
      "/api/v1/acquisition/import-operations"
        + `?subjectChannel=organization&fileName=${encodeURIComponent("leads.csv")}`
        + `&mapping=${encodeURIComponent(mapping)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Idempotency-Key": "import-http-key-1"
        },
        body: csv
      }
    );

    assert.equal(created.response.status, 202);
    assert.equal(created.json?.fileName, "leads.csv");
    assert.equal(created.json?.mediaType, "text/csv");
    assert.match(
      String(created.json?.artifactHash),
      /^sha256:[a-f0-9]{64}$/u
    );
    assert.equal("artifactCiphertext" in (created.json ?? {}), false);
    assert.equal("columnMapping" in (created.json ?? {}), false);
    assert.equal("contentBase64" in (created.json ?? {}), false);
    assert.deepEqual(app.importDispatches, [{
      scope: { ownerId: OWNER, teamId: TEAM, actorId: OWNER },
      id: created.json?.id
    }]);

    const loaded = await app.request(
      `/api/v1/acquisition/import-operations/${created.json?.id}`
    );
    assert.equal(loaded.response.status, 200);
    assert.equal(loaded.json?.id, created.json?.id);
  } finally {
    await app.close();
  }
});

test("octet-stream import accepts metadata headers and appears only in its tenant list", async () => {
  const app = await fixture();
  try {
    const mapping = JSON.stringify({
      sourceTitle: "title",
      sourceSnippet: "snippet"
    });
    const csv = Buffer.from(
      "title,snippet\r\nDemand signal,Buyer comparing vendors",
      "utf8"
    );
    const headers = {
      "Content-Type": "application/octet-stream",
      "Idempotency-Key": "import-header-key",
      "X-Subject-Channel": "individual",
      "X-File-Name": "signals.csv",
      "X-Column-Mapping": mapping
    };
    const foreign = await app.request(
      "/api/v1/acquisition/import-operations",
      { method: "POST", headers, body: csv },
      { ownerId: "owner-b", teamId: TEAM }
    );
    assert.equal(foreign.response.status, 202);

    const created = await app.request(
      "/api/v1/acquisition/import-operations",
      {
        method: "POST",
        headers: {
          ...headers,
          "Idempotency-Key": "import-header-key-owner-a"
        },
        body: csv
      }
    );
    assert.equal(created.response.status, 202);
    assert.equal(created.json?.mediaType, "text/csv");
    assert.equal(created.json?.subjectChannel, "individual");

    const listed = await app.request(
      "/api/v1/acquisition/import-operations?limit=100"
    );
    assert.equal(listed.response.status, 200);
    const items = listed.json?.items as Array<Record<string, unknown>>;
    assert.deepEqual(items.map((item) => item.id), [created.json?.id]);
    assert.equal(
      items.some((item) => item.id === foreign.json?.id),
      false
    );
  } finally {
    await app.close();
  }
});

test("XLSX import preserves the spreadsheet media type", async () => {
  const app = await fixture();
  try {
    const created = await app.request(
      "/api/v1/acquisition/import-operations"
        + "?subjectChannel=organization"
        + "&fileName=signals.xlsx"
        + `&mapping=${encodeURIComponent(JSON.stringify({
          sourceTitle: "title",
          sourceSnippet: "snippet"
        }))}`,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Idempotency-Key": "import-xlsx-http-key"
        },
        body: Buffer.from([0x50, 0x4b, 0x03, 0x04])
      }
    );

    assert.equal(created.response.status, 202);
    assert.equal(
      created.json?.mediaType,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
  } finally {
    await app.close();
  }
});

test("import rejects conflicting query and header metadata", async () => {
  const app = await fixture();
  try {
    const mapping = JSON.stringify({
      sourceTitle: "title",
      sourceSnippet: "snippet"
    });
    const result = await app.request(
      "/api/v1/acquisition/import-operations"
        + "?subjectChannel=organization"
        + "&fileName=signals.csv"
        + `&mapping=${encodeURIComponent(mapping)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/csv",
          "Idempotency-Key": "import-conflict-http-key",
          "X-Subject-Channel": "individual"
        },
        body: Buffer.from("title,snippet\r\nSignal,Needs CRM")
      }
    );

    assert.equal(result.response.status, 400);
    assert.equal(result.json?.code, "invalid_request");
    assert.equal(app.importDispatches.length, 0);
  } finally {
    await app.close();
  }
});

test("import rejects raw payloads over five MiB with a non-retryable 413", async () => {
  const app = await fixture();
  try {
    const result = await app.request(
      "/api/v1/acquisition/import-operations"
        + "?subjectChannel=organization"
        + "&fileName=oversized.csv"
        + `&mapping=${encodeURIComponent(JSON.stringify({
          sourceTitle: "title",
          sourceSnippet: "snippet"
        }))}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/csv",
          "Idempotency-Key": "import-oversized-http-key"
        },
        body: Buffer.alloc(5 * 1024 * 1024 + 1, 0x61)
      }
    );

    assert.equal(result.response.status, 413);
    assert.equal(result.json?.code, "import_limit_exceeded");
    assert.equal(result.json?.retryable, false);
    assert.equal(
      result.response.headers.get("x-request-id"),
      "discovery-request-1"
    );
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(app.importDispatches.length, 0);
  } finally {
    await app.close();
  }
});

test("retryable content fetch dispatch failures map to a sanitized 502", async () => {
  const app = await fixture({
    fetchDispatchError: new AcquisitionDiscoveryOperationError(
      "CONTENT_FETCH_FAILED",
      "upstream request failed"
    )
  });
  try {
    const result = await app.request(
      "/api/v1/acquisition/content-fetch-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "fetch-dispatch-failure-key" },
        body: JSON.stringify({
          sourceUrl: "https://example.com/unavailable",
          subjectChannel: "organization"
        })
      }
    );

    assert.equal(result.response.status, 502);
    assert.equal(result.json?.code, "content_fetch_failed");
    assert.equal(result.json?.retryable, true);
    assert.equal(result.json?.requestId, "discovery-request-1");
    assert.doesNotMatch(JSON.stringify(result.json), /upstream/u);
  } finally {
    await app.close();
  }
});

test("operation HTTP writes require identity, idempotency, and strict JSON", async () => {
  const app = await fixture();
  try {
    const unauthenticated = await app.request(
      "/api/v1/acquisition/content-fetch-operations",
      {},
      null
    );
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(unauthenticated.json?.code, "unauthorized");
    assert.equal(
      unauthenticated.response.headers.get("cache-control"),
      "no-store"
    );

    const missingKey = await app.request(
      "/api/v1/acquisition/content-fetch-operations",
      {
        method: "POST",
        body: JSON.stringify({
          sourceUrl: "https://example.com/opportunity",
          subjectChannel: "organization"
        })
      }
    );
    assert.equal(missingKey.response.status, 400);
    assert.equal(missingKey.json?.code, "idempotency_key_required");

    const unknownField = await app.request(
      "/api/v1/acquisition/content-fetch-operations",
      {
        method: "POST",
        headers: { "Idempotency-Key": "strict-json-key" },
        body: JSON.stringify({
          sourceUrl: "https://example.com/opportunity",
          subjectChannel: "organization",
          contentBase64: "must-not-be-accepted"
        })
      }
    );
    assert.equal(unknownField.response.status, 400);
    assert.equal(unknownField.json?.code, "invalid_request");

    const invalidLimit = await app.request(
      "/api/v1/acquisition/content-fetch-operations?limit=101"
    );
    assert.equal(invalidLimit.response.status, 400);
    assert.equal(invalidLimit.json?.code, "invalid_request");
    assert.equal(app.fetchDispatches.length, 0);
  } finally {
    await app.close();
  }
});

test("import HTTP rejects JSON base64 and invalid artifact input", async () => {
  const app = await fixture();
  try {
    const mapping = JSON.stringify({
      sourceTitle: "title",
      sourceSnippet: "snippet"
    });
    const jsonImport = await app.request(
      "/api/v1/acquisition/import-operations"
        + "?subjectChannel=organization"
        + "&fileName=leads.csv"
        + `&mapping=${encodeURIComponent(mapping)}`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "json-import-key" },
        body: JSON.stringify({ contentBase64: "dGl0bGUsc25pcHBldA==" })
      }
    );
    assert.equal(jsonImport.response.status, 415);
    assert.equal(jsonImport.json?.code, "unsupported_media_type");

    const invalidMapping = await app.request(
      "/api/v1/acquisition/import-operations"
        + "?subjectChannel=organization"
        + "&fileName=leads.csv"
        + "&mapping=not-json",
      {
        method: "POST",
        headers: {
          "Content-Type": "text/csv",
          "Idempotency-Key": "invalid-mapping-key"
        },
        body: Buffer.from("title,snippet")
      }
    );
    assert.equal(invalidMapping.response.status, 400);
    assert.equal(invalidMapping.json?.code, "invalid_request");

    const emptyArtifact = await app.request(
      "/api/v1/acquisition/import-operations"
        + "?subjectChannel=organization"
        + "&fileName=leads.csv"
        + `&mapping=${encodeURIComponent(mapping)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/csv",
          "Idempotency-Key": "empty-import-key"
        },
        body: Buffer.alloc(0)
      }
    );
    assert.equal(emptyArtifact.response.status, 422);
    assert.equal(emptyArtifact.json?.code, "import_artifact_invalid");
    assert.equal(app.importDispatches.length, 0);
  } finally {
    await app.close();
  }
});

test("import metadata also accepts the documented field names as headers", async () => {
  const app = await fixture();
  try {
    const result = await app.request(
      "/api/v1/acquisition/import-operations",
      {
        method: "POST",
        headers: {
          "Content-Type": "text/csv",
          "Idempotency-Key": "direct-metadata-header-key",
          subjectChannel: "organization",
          fileName: "direct.csv",
          mapping: JSON.stringify({
            sourceTitle: "title",
            sourceSnippet: "snippet"
          })
        },
        body: Buffer.from("title,snippet\r\nOpportunity,Needs CRM")
      }
    );

    assert.equal(result.response.status, 202);
    assert.equal(result.json?.fileName, "direct.csv");
  } finally {
    await app.close();
  }
});

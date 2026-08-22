import assert from "node:assert/strict";
import { test } from "node:test";
import { createAcquisitionPublicSearchPort } from "./acquisition-public-search-port.js";
import { encryptProviderConfiguration } from "./credential-security.js";
import { createDefaultProviderCatalog } from "./provider-catalog.js";
import { setProviderHttpTestTransport } from "./provider-http-client.js";
import type { AcquisitionPublicSearchStore } from "./acquisition-public-search-port.js";
import type { ProviderConnection } from "./types.js";

process.env.JWT_SECRET =
  "goodjob-douyin-baidu-tracer-test-secret-at-least-32-characters";

const OWNER_ID = "owner-douyin-tracer";
const TEAM_ID = "team-douyin-tracer";
const CONNECTION_ID = "connection-baidu-douyin-tracer";
const API_KEY = "mock-baidu-key-never-sent-to-network";

function baiduConnection(): ProviderConnection {
  const identity = {
    id: CONNECTION_ID,
    providerId: "baidu_ai_search",
    ownerId: OWNER_ID,
    teamId: TEAM_ID
  };
  return {
    ...identity,
    scope: "personal",
    credentialRef: "credential-baidu-douyin-tracer",
    configurationEncrypted: encryptProviderConfiguration(identity, {
      apiKey: API_KEY,
      baseUrl: "https://qianfan.baidubce.com/v2/ai_search"
    }),
    status: "active",
    quotaPolicy: {},
    budgetPolicy: {},
    lastHealthAt: "",
    lastHealthStatus: "untested",
    lastErrorCode: "",
    lastHealthMessage: "",
    usage: "",
    createdBy: OWNER_ID,
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z"
  };
}

test("Baidu official search separates unresolved Douyin content from verified profiles", async (t) => {
  const connection = baiduConnection();
  let persistCalls = 0;
  const store: AcquisitionPublicSearchStore = {
    providerCatalog: createDefaultProviderCatalog(),
    providerConnections: [connection],
    providerRequestLogs: [],
    async persist() {
      persistCalls += 1;
    }
  };
  let httpCalls = 0;

  setProviderHttpTestTransport(async (url, init) => {
    httpCalls += 1;
    assert.equal(
      url,
      "https://qianfan.baidubce.com/v2/ai_search/web_search"
    );
    assert.equal(init.method, "POST");
    assert.equal(
      new Headers(init.headers).get("x-appbuilder-authorization"),
      `Bearer ${API_KEY}`
    );
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
      search_source: string;
      resource_type_filter: Array<{ type: string; top_k: number }>;
      safe_search: boolean;
    };
    assert.equal(body.messages[0]?.role, "user");
    assert.match(body.messages[0]?.content || "", /site:douyin\.com/u);
    assert.equal(body.search_source, "baidu_search_v2");
    assert.deepEqual(body.resource_type_filter, [{ type: "web", top_k: 10 }]);
    assert.equal(body.safe_search, true);

    return new Response(JSON.stringify({
      request_id: "baidu-douyin-tracer-request",
      references: [
        {
          id: 1,
          type: "web",
          title: "门店获客复盘公开视频",
          url: "https://www.douyin.com/video/7521000000000000100",
          snippet: "公开索引摘要：咨询量不少，但有效客户较少。"
        },
        {
          id: 2,
          type: "web",
          title: "门店经营经验分享",
          url: "https://v.douyin.com/TracerLink/",
          snippet: "公开短链索引摘要，发布账号身份仍需人工核实。"
        },
        {
          id: 3,
          type: "web",
          title: "站外转载页面",
          url: "https://news.example.cn/douyin/repost",
          snippet: "百度搜索混入的非抖音来源。"
        },
        {
          id: 4,
          type: "web",
          title: "门店主理人的抖音主页",
          url: "https://www.douyin.com/user/MS4wLjABAAAATracer",
          snippet: "独立搜索明确返回的公开主页。"
        }
      ]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  });
  t.after(() => setProviderHttpTestTransport(null));

  const response = await createAcquisitionPublicSearchPort(store).search({
    ownerId: OWNER_ID,
    teamId: TEAM_ID,
    actorId: "actor-douyin-tracer",
    sessionId: "run-douyin-tracer",
    providerConnectionId: CONNECTION_ID,
    query: "site:douyin.com 厦门 门店 获客",
    subjectKinds: ["individual"],
    maxResults: 10
  });

  assert.equal(httpCalls, 1);
  assert.equal(response.provider, "baidu_ai_search");
  assert.deepEqual(
    response.results.map((result) => result.sourceType),
    ["video", "short_link", "profile"]
  );
  assert.equal(
    response.results.some((result) => result.sourceUrl.includes("news.example.cn")),
    false
  );
  for (const result of response.results) {
    assert.equal(result.sourcePlatform, "douyin");
    assert.equal(result.subject.kind, "individual");
    if (result.subject.kind === "individual") {
      assert.equal(result.subject.sourcePlatform, "douyin");
      if (result.sourceType === "profile") {
        assert.match(
          result.subject.individualPartyId ?? "",
          /^public-individual-[a-f0-9]{24}$/u
        );
        assert.match(
          result.subject.publicActorKey,
          /^public:douyin:sha256:[a-f0-9]{64}$/u
        );
      } else {
        assert.equal(result.subject.individualPartyId, null);
        assert.match(
          result.subject.publicActorKey,
          /^unresolved-public-signal:douyin:sha256:[a-f0-9]{64}$/u
        );
      }
    }
  }

  assert.equal(persistCalls, 1);
  assert.equal(store.providerRequestLogs.length, 1);
  const audit = store.providerRequestLogs[0]!;
  assert.equal(audit.providerId, "baidu_ai_search");
  assert.equal(audit.connectionId, CONNECTION_ID);
  assert.equal(audit.runId, "run-douyin-tracer");
  assert.equal(audit.endpointCode, "search");
  assert.equal(audit.httpStatus, 200);
  assert.equal(JSON.stringify(audit).includes(API_KEY), false);
});

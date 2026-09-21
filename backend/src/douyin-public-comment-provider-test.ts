import assert from "node:assert/strict";
import test from "node:test";
import {
  DouyinPublicCommentProviderError,
  createDouyinPublicCommentProvider,
  resolveDouyinVideoId,
  type DouyinPublicCommentTransport
} from "./douyin-public-comment-provider.js";

const videoId = "7521000000000000000";
const sourceUrl = `https://www.douyin.com/video/${videoId}`;

function payload(comments: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    status_code: 0,
    comments,
    cursor: 10,
    has_more: false,
    total: comments.length,
    ...overrides
  };
}

function response(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

function comment(cid: string, overrides: Record<string, unknown> = {}) {
  return {
    cid,
    text: `公开评论 ${cid}`,
    create_time: 1_725_000_000,
    digg_count: 7,
    reply_comment_total: 2,
    ip_label: "上海",
    user: {
      nickname: "公开用户",
      short_id: "public_handle",
      sec_uid: "public-sec-uid",
      avatar_thumb: { url_list: ["https://avatar.example.invalid/private.jpg"] },
      ...overrides.user as Record<string, unknown>
    },
    ...overrides
  };
}

function scriptedTransport(responses: Array<Response | Error>) {
  let calls = 0;
  const transport: DouyinPublicCommentTransport = async (url, init) => {
    calls += 1;
    const requested = new URL(url);
    assert.equal(requested.origin, "https://www.iesdouyin.com");
    assert.equal(requested.pathname, "/web/api/v2/comment/list/");
    assert.equal(requested.searchParams.has("aweme_id"), true);
    assert.equal(init.method, "GET");
    const headers = new Headers(init.headers);
    assert.equal(headers.has("cookie"), false);
    assert.equal(headers.has("authorization"), false);
    const next = responses.shift();
    if (!next) throw new Error("unexpected transport call");
    if (next instanceof Error) throw next;
    return next;
  };
  return { transport, calls: () => calls };
}

test("resolves only supported direct video URLs or a controlled short-link final URL", () => {
  assert.equal(resolveDouyinVideoId(sourceUrl), videoId);
  assert.equal(
    resolveDouyinVideoId(`https://www.iesdouyin.com/share/video/${videoId}/`),
    videoId
  );
  assert.equal(resolveDouyinVideoId("https://example.com/video/7521000000000000000"), null);
  assert.equal(
    resolveDouyinVideoId("https://v.douyin.com/abc123/", sourceUrl),
    videoId
  );
  assert.equal(
    resolveDouyinVideoId("https://example.com/short", sourceUrl),
    null
  );
});

test("normalizes an allowed top-level comment shape without avatar or login fields", async () => {
  const script = scriptedTransport([response(payload([comment("cid-1")]))]);
  const provider = createDouyinPublicCommentProvider({ transport: script.transport });

  const page = await provider.fetchTopLevelSample({
    videoId,
    sourceUrl,
    cursor: 0,
    count: 20
  });

  assert.equal(script.calls(), 1);
  assert.deepEqual(page.comments, [{
    commentId: "cid-1",
    text: "公开评论 cid-1",
    occurredAt: "2024-08-30T06:40:00.000Z",
    likeCount: 7,
    replyCount: 2,
    ipLabel: "上海",
    actor: {
      displayName: "公开用户",
      handle: "public_handle",
      secUid: "public-sec-uid"
    }
  }]);
  assert.equal(page.replyBodiesIncluded, false);
  assert.equal(page.providerId, "experimental_public_sample");
  assert.equal(page.providerVersion, "douyin-public-comment-provider-v1");
  assert.equal(page.coverage, "public_top_level_sample");
  assert.deepEqual(page.metadata, {
    requestedCommentCount: 20,
    returnedCommentCount: 1,
    duplicateCommentCount: 0,
    partial: false,
    cursorProgressed: true,
    transportRequestCount: 1
  });
  assert.match(page.rawArtifactHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(page).includes("avatar"), false);
  assert.equal(JSON.stringify(page).toLocaleLowerCase().includes("cookie"), false);
  assert.equal(JSON.stringify(page).toLocaleLowerCase().includes("login"), false);
});

test("deduplicates repeated cid values within one page", async () => {
  const provider = createDouyinPublicCommentProvider({
    transport: scriptedTransport([response(payload([comment("cid-1"), comment("cid-1")]))]).transport
  });
  const page = await provider.fetchTopLevelSample({ videoId, sourceUrl, cursor: 0, count: 20 });
  assert.deepEqual(page.comments.map((item) => item.commentId), ["cid-1"]);
  assert.equal(page.metadata.duplicateCommentCount, 1);
});

test("leaves cross-page cid deduplication to the caller-local enrichment", async () => {
  const provider = createDouyinPublicCommentProvider({
    transport: scriptedTransport([
      response(payload([comment("cid-1")], { cursor: 10, has_more: true })),
      response(payload([comment("cid-1"), comment("cid-2")], { cursor: 20, has_more: false }))
    ]).transport
  });
  await provider.fetchTopLevelSample({ videoId, sourceUrl, cursor: 0, count: 20 });
  const page = await provider.fetchTopLevelSample({ videoId, sourceUrl, cursor: 10, count: 20 });
  assert.deepEqual(page.comments.map((item) => item.commentId), [
    "cid-1",
    "cid-2"
  ]);
  assert.equal(page.metadata.duplicateCommentCount, 0);
});

test("provider instances retain no cross-call comment or cursor state", async () => {
  const provider = createDouyinPublicCommentProvider({
    transport: scriptedTransport([
      response(payload([comment("cid-stateless")], {
        cursor: 10,
        has_more: true
      })),
      response(payload([comment("cid-stateless")], {
        cursor: 10,
        has_more: true
      }))
    ]).transport
  });
  const first = await provider.fetchTopLevelSample({
    videoId,
    sourceUrl,
    cursor: 0,
    count: 20
  });
  const independentReplay = await provider.fetchTopLevelSample({
    videoId,
    sourceUrl,
    cursor: 0,
    count: 20
  });

  assert.deepEqual(first.comments.map((item) => item.commentId), [
    "cid-stateless"
  ]);
  assert.deepEqual(
    independentReplay.comments.map((item) => item.commentId),
    ["cid-stateless"]
  );
  assert.equal(independentReplay.nextCursor, 10);
});

test("stops pagination as a partial sample when the next cursor does not progress", async () => {
  const provider = createDouyinPublicCommentProvider({
    transport: scriptedTransport([
      response(payload([comment("cid-1")], { cursor: 0, has_more: true }))
    ]).transport
  });
  const page = await provider.fetchTopLevelSample({ videoId, sourceUrl, cursor: 0, count: 20 });
  assert.equal(page.nextCursor, null);
  assert.equal(page.hasMore, false);
  assert.equal(page.metadata.partial, true);
  assert.equal(page.metadata.cursorProgressed, false);
});

test("retries a 429 twice while honoring Retry-After before returning the page", async () => {
  const script = scriptedTransport([
    response({ status_code: 0 }, 429, { "retry-after": "1" }),
    response({ status_code: 0 }, 429, { "retry-after": "1" }),
    response(payload([comment("cid-1")]))
  ]);
  const delays: number[] = [];
  const provider = createDouyinPublicCommentProvider({
    transport: script.transport,
    sleep: async (delayMs) => { delays.push(delayMs); }
  });
  const page = await provider.fetchTopLevelSample({ videoId, sourceUrl, cursor: 0, count: 20 });
  assert.equal(page.comments.length, 1);
  assert.equal(script.calls(), 3);
  assert.deepEqual(delays, [1_000, 1_000]);
});

test("reports every HTTP retry and never exceeds the supplied transport budget", async () => {
  const successful = scriptedTransport([
    response({ status_code: 0 }, 500),
    response({ status_code: 0 }, 500),
    response(payload([comment("cid-budget-success")]))
  ]);
  const provider = createDouyinPublicCommentProvider({
    transport: successful.transport,
    sleep: async () => undefined
  });
  const fetchWithBudget = provider.fetchTopLevelSample.bind(provider) as (
    input: Parameters<typeof provider.fetchTopLevelSample>[0] & {
      transportRequestBudget: number;
    }
  ) => ReturnType<typeof provider.fetchTopLevelSample>;
  const page = await fetchWithBudget({
    videoId,
    sourceUrl,
    cursor: 0,
    count: 20,
    transportRequestBudget: 3
  });
  assert.equal(successful.calls(), 3);
  assert.equal((page.metadata as typeof page.metadata & {
    transportRequestCount: number;
  }).transportRequestCount, 3);

  const bounded = scriptedTransport([
    response({ status_code: 0 }, 500),
    response({ status_code: 0 }, 500),
    response(payload([comment("cid-must-not-fetch")]))
  ]);
  const oneRequestProvider = createDouyinPublicCommentProvider({
    transport: bounded.transport,
    sleep: async () => undefined
  });
  const fetchOne = oneRequestProvider.fetchTopLevelSample.bind(
    oneRequestProvider
  ) as typeof fetchWithBudget;
  await assert.rejects(fetchOne({
    videoId,
    sourceUrl,
    cursor: 0,
    count: 20,
    transportRequestBudget: 1
  }), (error: unknown) => error instanceof DouyinPublicCommentProviderError
    && error.code === "public_sample_unavailable"
    && (error as DouyinPublicCommentProviderError & {
      transportRequestCount: number;
    }).transportRequestCount === 1);
  assert.equal(bounded.calls(), 1);
});

test("attaches every consumed retry to malformed successful HTTP responses", async () => {
  for (const budget of [3, 1]) {
    const responses = budget === 3
      ? [
          response({ status_code: 0 }, 500),
          response({ status_code: 0 }, 500),
          response({ status_code: 0, comments: "invalid" })
        ]
      : [response({ status_code: 0, comments: "invalid" })];
    const script = scriptedTransport(responses);
    const provider = createDouyinPublicCommentProvider({
      transport: script.transport,
      sleep: async () => undefined
    });
    await assert.rejects(
      provider.fetchTopLevelSample({
        videoId,
        sourceUrl,
        cursor: 0,
        count: 20,
        transportRequestBudget: budget
      }),
      (error: unknown) =>
        error instanceof DouyinPublicCommentProviderError
        && error.code === "source_payload_invalid"
        && error.transportRequestCount === budget
    );
    assert.equal(script.calls(), budget);
  }
});

test("maps restricted, malformed, empty, and cid-less payloads to stable errors", async () => {
  const cases: Array<{ body: Response; code: DouyinPublicCommentProviderError["code"] }> = [
    { body: response({ status_code: 0 }, 403), code: "access_restricted" },
    { body: response({ status_code: 0, comments: "not-an-array" }), code: "source_payload_invalid" },
    { body: response(payload([])), code: "no_public_comments" },
    { body: response(payload([comment("", { cid: undefined })])), code: "source_payload_invalid" }
  ];
  for (const item of cases) {
    const provider = createDouyinPublicCommentProvider({
      transport: scriptedTransport([item.body]).transport
    });
    await assert.rejects(
      () => provider.fetchTopLevelSample({ videoId, sourceUrl, cursor: 0, count: 20 }),
      (error: unknown) => error instanceof DouyinPublicCommentProviderError && error.code === item.code
    );
  }
});

test("does not retain a valid cid when another comment makes the page invalid", async () => {
  const provider = createDouyinPublicCommentProvider({
    transport: scriptedTransport([
      response(payload([comment("cid-1"), comment("", { cid: undefined })])),
      response(payload([comment("cid-1")]))
    ]).transport
  });
  await assert.rejects(
    () => provider.fetchTopLevelSample({ videoId, sourceUrl, cursor: 0, count: 20 }),
    (error: unknown) => error instanceof DouyinPublicCommentProviderError
      && error.code === "source_payload_invalid"
  );
  const correctedPage = await provider.fetchTopLevelSample({
    videoId, sourceUrl, cursor: 0, count: 20
  });
  assert.deepEqual(correctedPage.comments.map((item) => item.commentId), ["cid-1"]);
});

test("does not retry a non-retryable transport or programming exception", async () => {
  const programmingError = new Error("programming transport failure");
  let calls = 0;
  const provider = createDouyinPublicCommentProvider({
    transport: async () => {
      calls += 1;
      throw programmingError;
    },
    sleep: async () => { throw new Error("sleep must not be called"); }
  });
  await assert.rejects(
    () => provider.fetchTopLevelSample({ videoId, sourceUrl, cursor: 0, count: 20 }),
    (error: unknown) => error === programmingError
  );
  assert.equal(calls, 1);
});

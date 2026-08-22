import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  classifyDouyinPublicSource,
  isDouyinBoundPublicSearchQuery,
  type DouyinPublicSourceType
} from "./acquisition-douyin-public-source.js";
import {
  resolveAcquisitionPublicIdentity
} from "./acquisition-public-identity-resolver.js";

test("classifies exact Douyin profile, video, share-video, and short-link URLs", () => {
  assert.deepEqual(
    classifyDouyinPublicSource("https://www.douyin.com/user/MS4wLjABAAAA"),
    { sourcePlatform: "douyin", sourceType: "profile" }
  );
  assert.deepEqual(
    classifyDouyinPublicSource("https://douyin.com/video/7521000000000000000"),
    { sourcePlatform: "douyin", sourceType: "video" }
  );
  assert.deepEqual(
    classifyDouyinPublicSource(
      "https://www.iesdouyin.com/share/video/7521000000000000001/"
    ),
    { sourcePlatform: "douyin", sourceType: "video" }
  );
  assert.deepEqual(
    classifyDouyinPublicSource("https://v.douyin.com/AbCdEfGh/"),
    { sourcePlatform: "douyin", sourceType: "short_link" }
  );
});

test("marks explicit indexed comment wording as an unverified comment signal", () => {
  assert.deepEqual(
    classifyDouyinPublicSource(
      "https://www.douyin.com/video/7521000000000000002",
      "装修公司老板公开留言",
      "评论区回复：想了解获客方案和报价"
    ),
    { sourcePlatform: "douyin", sourceType: "comment_signal" }
  );
});

test("accepts only the exact Douyin roots or their dot-subdomains", () => {
  assert.deepEqual(
    classifyDouyinPublicSource("https://creator.douyin.com/creator-micro/home"),
    { sourcePlatform: "douyin", sourceType: "other" }
  );
  for (const url of [
    "https://douyin.com.evil.example/user/actor",
    "https://evil-douyin.com/user/actor",
    "https://evil.example/douyin.com/video/1",
    "https://iesdouyin.com.evil.example/share/video/1",
    "https://user:secret@douyin.com/user/actor",
    "javascript:https://douyin.com/user/actor"
  ]) {
    assert.equal(classifyDouyinPublicSource(url), null, url);
  }
});

test("detects only exact compiler-produced Douyin-bound public searches", () => {
  for (const query of [
    "site:douyin.com 厦门 装修 获客",
    "site:iesdouyin.com 美业 供应商"
  ]) {
    assert.equal(isDouyinBoundPublicSearchQuery(query), true, query);
  }
  for (const query of [
    "厦门 装修 获客",
    "site:douyin.com.evil.example 获客",
    "site:evil.example/douyin.com 获客",
    "SITE:douyin.com 获客",
    "site：douyin.com 获客",
    "site:douyin.com"
  ]) {
    assert.equal(isDouyinBoundPublicSearchQuery(query), false, query);
  }
});

test("resolves only stable Douyin profiles while video, short-link, and comment signals need research", () => {
  const resolve = (
    publicProfileUrl: string,
    sourceType: DouyinPublicSourceType
  ) =>
    resolveAcquisitionPublicIdentity({
      ownerId: "owner-douyin",
      teamId: "team-douyin",
      provider: "baidu_ai_search",
      sourceUrl: publicProfileUrl,
      sourceType,
      subject: {
        kind: "individual",
        publicActorKey: `public:douyin:sha256:${createHash("sha256")
          .update(publicProfileUrl)
          .digest("hex")}`,
        publicProfileUrl,
        sourcePlatform: "douyin"
      }
    });

  assert.equal(
    resolve("https://www.douyin.com/user/MS4wLjABAAAA", "profile").status,
    "resolved"
  );
  assert.equal(
    resolve("https://www.douyin.com/video/7521000000000000000", "video").status,
    "needs_research"
  );
  assert.equal(
    resolve("https://v.douyin.com/AbCdEfGh/", "short_link").status,
    "needs_research"
  );
  assert.equal(
    resolve(
      "https://www.douyin.com/user/MS4wLjABAAAA",
      "comment_signal"
    ).status,
    "needs_research"
  );
});

test("adapter-generated content-platform identities preserve legacy provider-scoped v1 deduplication", () => {
  const provider = "baidu_ai_search";
  const profileUrl =
    "https://www.xiaohongshu.com/user/profile/public-business-owner";
  const digest = createHash("sha256").update(profileUrl).digest("hex");
  const resolve = (
    actorNamespace: "public" | "unresolved-public-signal",
    actorPlatform: string,
    sourcePlatform: string,
    url = profileUrl
  ) => resolveAcquisitionPublicIdentity({
    ownerId: "owner-compat",
    teamId: "team-compat",
    provider,
    sourceUrl: url,
    subject: {
      kind: "individual",
      publicActorKey:
        `${actorNamespace}:${actorPlatform}:sha256:${digest}`,
      publicProfileUrl: url,
      sourcePlatform
    }
  });

  const legacyResolved = resolve("public", provider, provider);
  const contentResolved = resolve(
    "public",
    "xiaohongshu.com",
    "xiaohongshu.com"
  );
  assert.equal(legacyResolved.status, "resolved");
  assert.equal(contentResolved.status, "resolved");
  assert.equal(contentResolved.partyId, legacyResolved.partyId);
  assert.equal(contentResolved.dedupeKey, legacyResolved.dedupeKey);

  const unresolvedUrl = "https://news.example.cn/public-demand-signal";
  const unresolvedDigest = createHash("sha256")
    .update(unresolvedUrl)
    .digest("hex");
  const legacyUnresolved = resolveAcquisitionPublicIdentity({
    ownerId: "owner-compat",
    teamId: "team-compat",
    provider,
    sourceUrl: unresolvedUrl,
    subject: {
      kind: "individual",
      publicActorKey:
        `unresolved-public-signal:${provider}:sha256:${unresolvedDigest}`,
      publicProfileUrl: unresolvedUrl,
      sourcePlatform: provider
    }
  });
  const contentUnresolved = resolveAcquisitionPublicIdentity({
    ownerId: "owner-compat",
    teamId: "team-compat",
    provider,
    sourceUrl: unresolvedUrl,
    subject: {
      kind: "individual",
      publicActorKey:
        `unresolved-public-signal:news.example.cn:sha256:${unresolvedDigest}`,
      publicProfileUrl: unresolvedUrl,
      sourcePlatform: "news.example.cn"
    }
  });
  assert.equal(legacyUnresolved.status, "needs_research");
  assert.equal(contentUnresolved.status, "needs_research");
  assert.equal(contentUnresolved.partyId, legacyUnresolved.partyId);
  assert.equal(contentUnresolved.dedupeKey, legacyUnresolved.dedupeKey);
});

test("custom public actor keys are not rewritten by the compatibility bridge", () => {
  const base = {
    ownerId: "owner-custom",
    teamId: "team-custom",
    provider: "baidu_ai_search",
    sourceUrl: "https://news.example.cn/custom-actor",
    subject: {
      kind: "individual" as const,
      publicActorKey: "public:customer-owned-actor",
      publicProfileUrl:
        "https://www.xiaohongshu.com/user/profile/customer-owned-actor"
    }
  };
  const providerScoped = resolveAcquisitionPublicIdentity({
    ...base,
    subject: { ...base.subject, sourcePlatform: "baidu_ai_search" }
  });
  const contentScoped = resolveAcquisitionPublicIdentity({
    ...base,
    subject: { ...base.subject, sourcePlatform: "xiaohongshu.com" }
  });

  assert.equal(providerScoped.status, "resolved");
  assert.equal(contentScoped.status, "resolved");
  assert.notEqual(contentScoped.dedupeKey, providerScoped.dedupeKey);
});

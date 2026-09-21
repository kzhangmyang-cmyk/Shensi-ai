import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  isSafeAcquisitionPublicActorKey,
  resolveAcquisitionPublicIdentity
} from "./acquisition-public-identity-resolver.js";

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

test("accepts only the strict unresolved opaque actor key emitted by public adapters", () => {
  const sourceUrl =
    "https://www.douyin.com/video/7536012345678909876";
  const actualAdapterKey =
    `unresolved-public-signal:douyin:sha256:${digest(sourceUrl)}`;

  assert.equal(isSafeAcquisitionPublicActorKey(actualAdapterKey), true);

  for (const malformed of [
    `unresolved-public-signals:douyin:sha256:${digest(sourceUrl)}`,
    `unresolved-public-signal::sha256:${digest(sourceUrl)}`,
    `unresolved-public-signal:douyin:mobile:sha256:${digest(sourceUrl)}`,
    `unresolved-public-signal:Douyin:sha256:${digest(sourceUrl)}`,
    `unresolved-public-signal:douyin:sha256:${digest(sourceUrl).toUpperCase()}`,
    `unresolved-public-signal:douyin:sha256:${"a".repeat(63)}`,
    `unresolved-public-signal:douyin:sha256:${"a".repeat(65)}`,
    `unresolved-public-signal:douyin:sha256:${"g".repeat(64)}`,
    `unresolved-public-signal:${"a".repeat(240)}:sha256:${"b".repeat(64)}`
  ]) {
    assert.equal(
      isSafeAcquisitionPublicActorKey(malformed),
      false,
      malformed
    );
  }
});

test("keeps an adapter unresolved key unresolved even when its URL hash matches", () => {
  const sourceUrl =
    "https://www.douyin.com/video/7536012345678909876";
  const resolution = resolveAcquisitionPublicIdentity({
    ownerId: "owner-resolver",
    teamId: "team-resolver",
    provider: "baidu_ai_search",
    sourceUrl,
    sourceType: "video",
    subject: {
      kind: "individual",
      publicActorKey:
        `unresolved-public-signal:douyin:sha256:${digest(sourceUrl)}`,
      publicProfileUrl: sourceUrl,
      sourcePlatform: "douyin"
    }
  });

  assert.equal(resolution.status, "needs_research");
  assert.equal(
    resolution.reasonCode,
    "insufficient_provider_public_actor_identity"
  );
});

test("fails closed when an opaque public actor key does not hash the normalized source URL", () => {
  const profileUrl =
    "https://www.douyin.com/user/MS4wLjABAAAAresolver";
  const resolution = resolveAcquisitionPublicIdentity({
    ownerId: "owner-resolver",
    teamId: "team-resolver",
    provider: "douyin",
    sourceUrl: profileUrl,
    sourceType: "profile",
    subject: {
      kind: "individual",
      publicActorKey:
        `public:douyin:sha256:${digest(`${profileUrl}-different`)}`,
      publicProfileUrl: profileUrl,
      sourcePlatform: "douyin"
    }
  });

  assert.equal(resolution.status, "needs_research");
  assert.equal(resolution.basis, null);
});

test("matches opaque actor hashes against the normalized public source URL", () => {
  const sourceUrl =
    "https://WWW.DOUYIN.COM/user/MS4wLjABAAAAnormalized/?b=2&a=1#public";
  const normalizedSourceUrl =
    "https://www.douyin.com/user/MS4wLjABAAAAnormalized?a=1&b=2";
  const resolution = resolveAcquisitionPublicIdentity({
    ownerId: "owner-resolver",
    teamId: "team-resolver",
    provider: "douyin",
    sourceUrl,
    sourceType: "profile",
    subject: {
      kind: "individual",
      publicActorKey:
        `public:douyin:sha256:${digest(normalizedSourceUrl)}`,
      publicProfileUrl: normalizedSourceUrl,
      sourcePlatform: "douyin"
    }
  });

  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.basis, "provider_public_actor");
});

function resolveDouyinCommentActor(input: {
  ownerId?: string;
  sourceUrl?: string;
  publicActorKey: string;
  publicProfileUrl?: string;
  provider?: string;
  sourcePlatform?: string;
}) {
  return resolveAcquisitionPublicIdentity({
    ownerId: input.ownerId ?? "owner-resolver",
    teamId: "team-resolver",
    provider: input.provider ?? "experimental_public_sample",
    sourceUrl: input.sourceUrl
      ?? "https://www.douyin.com/video/7536012345678909876",
    sourceType: "video",
    subject: {
      kind: "individual",
      publicActorKey: input.publicActorKey,
      publicProfileUrl: input.publicProfileUrl
        ?? input.sourceUrl
        ?? "https://www.douyin.com/video/7536012345678909876",
      sourcePlatform: input.sourcePlatform ?? "douyin"
    }
  });
}

test("uses a strict Douyin secUid as stable unresolved dedupe material across videos", () => {
  const first = resolveDouyinCommentActor({
    publicActorKey: "douyin:sec_uid:MS4wLjABAAAA_actor-1"
  });
  const second = resolveDouyinCommentActor({
    publicActorKey: "douyin:sec_uid:MS4wLjABAAAA_actor-1",
    sourceUrl: "https://www.douyin.com/video/7536012345678909999"
  });
  const different = resolveDouyinCommentActor({
    publicActorKey: "douyin:sec_uid:MS4wLjABAAAA_actor-2"
  });

  assert.equal(first.status, "needs_research");
  assert.equal(second.status, "needs_research");
  assert.equal(first.dedupeKey, second.dedupeKey);
  assert.equal(first.partyId, second.partyId);
  assert.notEqual(first.dedupeKey, different.dedupeKey);
  assert.equal(
    first.normalizedProfileUrl,
    "https://www.douyin.com/video/7536012345678909876"
  );
  assert.equal(
    isSafeAcquisitionPublicActorKey(
      "douyin:sec_uid:MS4wLjABAAAA_123456789012345_actor"
    ),
    true,
    "opaque secUid material may contain a digit run without being a phone"
  );
});

test("keeps handle and comment-scoped keys unresolved and in separate namespaces", () => {
  const handle = resolveDouyinCommentActor({
    publicActorKey: "douyin:handle:Public_User.01"
  });
  const replayedHandle = resolveDouyinCommentActor({
    publicActorKey: "douyin:handle:public_user.01",
    sourceUrl: "https://www.douyin.com/video/7536012345678909999"
  });
  const secUid = resolveDouyinCommentActor({
    publicActorKey: "douyin:sec_uid:public_user.01"
  });
  const firstComment = resolveDouyinCommentActor({
    publicActorKey: "unmergeable:douyin:comment:cid-1"
  });
  const secondComment = resolveDouyinCommentActor({
    publicActorKey: "unmergeable:douyin:comment:cid-2"
  });

  assert.equal(handle.status, "needs_research");
  assert.equal(handle.dedupeKey, replayedHandle.dedupeKey);
  assert.notEqual(handle.dedupeKey, secUid.dedupeKey);
  assert.notEqual(firstComment.dedupeKey, secondComment.dedupeKey);
  assert.equal(firstComment.status, "needs_research");
  assert.equal(secondComment.status, "needs_research");
});

test("rejects malformed or non-Douyin stable comment actor keys", () => {
  for (const malformed of [
    "douyin:Sec_UID:MS4wLjABAAAA_actor",
    "douyin:sec_uid:contains space",
    "douyin:sec_uid:alice@example.com",
    "douyin:sec_uid:https://example.com/user",
    `douyin:sec_uid:${"a".repeat(129)}`,
    "douyin:handle:contains space",
    "douyin:handle:+8613812345678",
    "unmergeable:douyin:comment:",
    "unmergeable:douyin:comment:contains space"
  ]) {
    assert.equal(isSafeAcquisitionPublicActorKey(malformed), false, malformed);
  }

  const wrongPlatform = resolveDouyinCommentActor({
    publicActorKey: "douyin:sec_uid:MS4wLjABAAAA_actor",
    sourceUrl: "https://www.linkedin.com/in/alice",
    publicProfileUrl: "https://www.linkedin.com/in/alice",
    provider: "linkedin-search",
    sourcePlatform: "linkedin"
  });
  const wrongProvider = resolveDouyinCommentActor({
    publicActorKey: "douyin:sec_uid:MS4wLjABAAAA_actor",
    provider: "brave"
  });
  assert.equal(wrongPlatform.status, "needs_research");
  assert.equal(wrongProvider.status, "needs_research");
  assert.notEqual(
    wrongPlatform.dedupeKey,
    resolveDouyinCommentActor({
      publicActorKey: "douyin:sec_uid:MS4wLjABAAAA_actor"
    }).dedupeKey
  );
  assert.notEqual(
    wrongProvider.dedupeKey,
    resolveDouyinCommentActor({
      publicActorKey: "douyin:sec_uid:MS4wLjABAAAA_actor"
    }).dedupeKey
  );
});

test("isolates stable Douyin comment actor keys by owner and team", () => {
  const ownerA = resolveDouyinCommentActor({
    ownerId: "owner-a",
    publicActorKey: "douyin:sec_uid:MS4wLjABAAAA_actor"
  });
  const ownerB = resolveDouyinCommentActor({
    ownerId: "owner-b",
    publicActorKey: "douyin:sec_uid:MS4wLjABAAAA_actor"
  });
  assert.notEqual(ownerA.dedupeKey, ownerB.dedupeKey);
  assert.notEqual(ownerA.partyId, ownerB.partyId);
});

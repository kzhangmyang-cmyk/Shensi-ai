import assert from "node:assert/strict";
import test from "node:test";
import {
  compileAcquisitionDiscoveryQueries,
  isSafeDouyinSearchQuery
} from "./acquisition-douyin-discovery-plan.js";

test("Douyin compilation strips Unicode and injected site clauses before adding exact roots", () => {
  const compiled = compileAcquisitionDiscoveryQueries({
    targetPlatform: "douyin",
    queryIntents: [{
      subjectChannel: "organization",
      query: [
        "\u200b\uff33\uff29\uff34\uff25\uff1aevil.example",
        "\u7f8e\u5bb9\u0000\u83b7\u5ba2",
        "-site:other.example",
        "site:douyin.com"
      ].join(" ")
    }]
  });

  assert.deepEqual(compiled, [{
    subjectChannel: "organization",
    query: "site:douyin.com \u7f8e\u5bb9 \u83b7\u5ba2"
  }, {
    subjectChannel: "organization",
    query: "site:iesdouyin.com \u7f8e\u5bb9 \u83b7\u5ba2"
  }]);
  assert.equal(compiled.every((item) => isSafeDouyinSearchQuery(item.query)), true);
});

test("Douyin compilation is stable and deduplicates only within the same subject channel", () => {
  const compiled = compileAcquisitionDiscoveryQueries({
    targetPlatform: "douyin",
    queryIntents: [{
      subjectChannel: "organization",
      query: "  \u53a6\u95e8   \u88c5\u4fee  "
    }, {
      subjectChannel: "organization",
      query: "\u53a6\u95e8 \u88c5\u4fee"
    }, {
      subjectChannel: "individual",
      query: "\u53a6\u95e8 \u88c5\u4fee"
    }]
  });

  assert.deepEqual(compiled, [{
    subjectChannel: "organization",
    query: "site:douyin.com \u53a6\u95e8 \u88c5\u4fee"
  }, {
    subjectChannel: "organization",
    query: "site:iesdouyin.com \u53a6\u95e8 \u88c5\u4fee"
  }, {
    subjectChannel: "individual",
    query: "site:douyin.com \u53a6\u95e8 \u88c5\u4fee"
  }, {
    subjectChannel: "individual",
    query: "site:iesdouyin.com \u53a6\u95e8 \u88c5\u4fee"
  }]);
});

test("compiler rejects empty semantic intent after removing site clauses", () => {
  for (const query of [
    "site:evil.example -site:douyin.com \u200b",
    "(site:evil.example)"
  ]) {
    assert.throws(() => compileAcquisitionDiscoveryQueries({
      targetPlatform: "douyin",
      queryIntents: [{
        subjectChannel: "individual",
        query
      }]
    }), /ACQUISITION_DISCOVERY_QUERY_EMPTY/);
  }
});

test("compiler limits every final query to the search tool maximum", () => {
  const compiled = compileAcquisitionDiscoveryQueries({
    targetPlatform: "douyin",
    queryIntents: [{
      subjectChannel: "organization",
      query: "\u5546".repeat(1_200)
    }]
  });

  assert.equal(compiled.length, 2);
  assert.equal(compiled[0]?.query.length, 1_000);
  assert.equal(compiled[1]?.query.length, 1_000);
  assert.equal(compiled.every((item) => isSafeDouyinSearchQuery(item.query)), true);
});

test("web compilation normalizes without rewriting a lawful site constraint", () => {
  assert.deepEqual(compileAcquisitionDiscoveryQueries({
    targetPlatform: "web",
    queryIntents: [{
      subjectChannel: "individual",
      query: "\uff53\uff49\uff54\uff45\uff1agov.cn  \u8001\u677f\u0007  \u83b7\u5ba2\u96be"
    }]
  }), [{
    subjectChannel: "individual",
    query: "site:gov.cn \u8001\u677f \u83b7\u5ba2\u96be"
  }]);
});

test("site stripping does not corrupt ordinary words ending in site", () => {
  assert.deepEqual(compileAcquisitionDiscoveryQueries({
    targetPlatform: "web",
    queryIntents: [{
      subjectChannel: "organization",
      query: "website:\u5b98\u7f51 \u4f01\u4e1a\u670d\u52a1"
    }]
  }), [{
    subjectChannel: "organization",
    query: "website:\u5b98\u7f51 \u4f01\u4e1a\u670d\u52a1"
  }]);
});

test("Douyin safety requires one exact root, a non-empty intent, and no nested site clause", () => {
  for (const query of [
    "site:douyin.com \u88c5\u4fee\u83b7\u5ba2",
    "site:iesdouyin.com \u88c5\u4fee\u83b7\u5ba2"
  ]) {
    assert.equal(isSafeDouyinSearchQuery(query), true, query);
  }
  for (const query of [
    "site:douyin.com.evil.example \u88c5\u4fee\u83b7\u5ba2",
    "site:evil.example \u88c5\u4fee\u83b7\u5ba2",
    "SITE:douyin.com \u88c5\u4fee\u83b7\u5ba2",
    "site\uff1adouyin.com \u88c5\u4fee\u83b7\u5ba2",
    "site:douyin.com",
    "site:douyin.com site:evil.example \u88c5\u4fee\u83b7\u5ba2",
    `site:douyin.com ${"\u5546".repeat(1_001)}`
  ]) {
    assert.equal(isSafeDouyinSearchQuery(query), false, query.slice(0, 80));
  }
});

test("Douyin safety rejects repeated zero-width and control-character probes deterministically", () => {
  assert.equal(
    isSafeDouyinSearchQuery("site:douyin.com \u83b7\u5ba2\u200b"),
    false
  );
  assert.equal(
    isSafeDouyinSearchQuery("site:douyin.com \u200b\u83b7\u5ba2"),
    false
  );
  assert.equal(
    isSafeDouyinSearchQuery("site:iesdouyin.com \u83b7\u5ba2\u0001"),
    false
  );
  assert.equal(
    isSafeDouyinSearchQuery("site:iesdouyin.com \u0001\u83b7\u5ba2"),
    false
  );
});

test("Douyin compilation strips site operators adjacent to punctuation but preserves website words", () => {
  for (const query of [
    "\u53a6\u95e8,site:evil.example \u88c5\u4fee",
    "\u53a6\u95e8[site:evil.example] \u88c5\u4fee",
    "\u53a6\u95e8{site:evil.example} \u88c5\u4fee",
    "\u53a6\u95e8\"site:evil.example\" \u88c5\u4fee",
    "\u53a6\u95e8'site:evil.example' \u88c5\u4fee"
  ]) {
    const compiled = compileAcquisitionDiscoveryQueries({
      targetPlatform: "douyin",
      queryIntents: [{ subjectChannel: "organization", query }]
    });
    assert.equal(compiled.length, 2, query);
    assert.equal(compiled.every((item) => !item.query.includes("evil.example")), true, query);
    assert.equal(compiled.every((item) => isSafeDouyinSearchQuery(item.query)), true, query);
  }

  assert.equal(
    isSafeDouyinSearchQuery("site:douyin.com website:\u5b98\u7f51 \u88c5\u4fee"),
    true
  );
});

test("Douyin safety rejects residual site operators after punctuation", () => {
  for (const query of [
    "site:douyin.com \u53a6\u95e8,site:evil.example \u88c5\u4fee",
    "site:douyin.com \u53a6\u95e8[site:evil.example] \u88c5\u4fee",
    "site:douyin.com \u53a6\u95e8{site:evil.example} \u88c5\u4fee",
    "site:douyin.com \u53a6\u95e8\"site:evil.example\" \u88c5\u4fee",
    "site:douyin.com \u53a6\u95e8'site:evil.example' \u88c5\u4fee"
  ]) {
    assert.equal(isSafeDouyinSearchQuery(query), false, query);
  }
});

test("Unicode format characters cannot hide a site operator or survive a safe query", () => {
  const compiled = compileAcquisitionDiscoveryQueries({
    targetPlatform: "douyin",
    queryIntents: [{
      subjectChannel: "individual",
      query: "s\u00adite:evil.example \u8001\u677f\u061c \u83b7\u5ba2\u96be"
    }]
  });
  assert.deepEqual(compiled, [{
    subjectChannel: "individual",
    query: "site:douyin.com \u8001\u677f \u83b7\u5ba2\u96be"
  }, {
    subjectChannel: "individual",
    query: "site:iesdouyin.com \u8001\u677f \u83b7\u5ba2\u96be"
  }]);
  assert.equal(
    isSafeDouyinSearchQuery("site:douyin.com \u8001\u677f\u061c \u83b7\u5ba2\u96be"),
    false
  );
});

test("default-ignorable Unicode marks cannot hide a site operator", () => {
  for (const invisible of ["\u034f", "\ufe0f", "\u180b"]) {
    const compiled = compileAcquisitionDiscoveryQueries({
      targetPlatform: "douyin",
      queryIntents: [{
        subjectChannel: "individual",
        query: `s${invisible}ite:evil.example \u8001\u677f \u83b7\u5ba2\u96be`
      }]
    });
    assert.deepEqual(compiled, [{
      subjectChannel: "individual",
      query: "site:douyin.com \u8001\u677f \u83b7\u5ba2\u96be"
    }, {
      subjectChannel: "individual",
      query: "site:iesdouyin.com \u8001\u677f \u83b7\u5ba2\u96be"
    }], `U+${invisible.codePointAt(0)?.toString(16).toUpperCase()}`);
    assert.equal(
      isSafeDouyinSearchQuery(
        `site:douyin.com \u8001\u677f s${invisible}ite:evil.example`
      ),
      false,
      `U+${invisible.codePointAt(0)?.toString(16).toUpperCase()}`
    );
  }
});

test("web truncation rejects a bounded result with no semantic content", () => {
  assert.throws(() => compileAcquisitionDiscoveryQueries({
    targetPlatform: "web",
    queryIntents: [{
      subjectChannel: "organization",
      query: `${".".repeat(1_000)}\u6709\u6548\u5185\u5bb9`
    }]
  }), /ACQUISITION_DISCOVERY_QUERY_EMPTY/);
});

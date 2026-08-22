import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAcquisitionDouyinPublicProfileDiscovery
} from "./acquisition-douyin-public-profile-discovery.js";
import type { ProviderHttpRedirectTrace } from "./provider-http-client.js";

function traced(body: string, url = "https://www.douyin.com/video/7521000000000000000"): ProviderHttpRedirectTrace {
  return {
    response: new Response(body, { status: 200, headers: { "content-type": "text/html" } }),
    redirectChain: [url]
  };
}

test("discovery returns one normalized explicit public profile and content fingerprints", async () => {
  const discovery = createAcquisitionDouyinPublicProfileDiscovery({
    fetchWithRedirectTrace: async () => traced([
      '<link rel="canonical" href="https://www.douyin.com/user/MS4wLjABAAAA-author/">',
      '<a href="https://www.douyin.com/user/MS4wLjABAAAA-author">author</a>',
      '<a href="https://www.douyin.com/video/7521000000000000000">video</a>'
    ].join("")),
    hash: (value) => value.startsWith("[")
      ? "sha256:fixture-content"
      : "sha256:fixture"
  });

  assert.deepEqual(
    await discovery.discover({
      sourceUrl: "https://www.douyin.com/video/7521000000000000000",
      sourceEvidenceId: "evidence-video",
      signal: new AbortController().signal
    }),
    {
      status: "succeeded",
      redirectChain: ["https://www.douyin.com/video/7521000000000000000"],
      publicProfileUrls: ["https://www.douyin.com/user/MS4wLjABAAAA-author"],
      rawArtifactHash: "sha256:fixture",
      contentHash: "sha256:fixture-content"
    }
  );
});

test("discovery never treats videos, short links, or nickname text as profiles", async () => {
  const discovery = createAcquisitionDouyinPublicProfileDiscovery({
    fetchWithRedirectTrace: async () => traced([
      '<a href="https://www.douyin.com/video/7521000000000000000">video</a>',
      '<a href="https://v.douyin.com/ShortOnly/">short</a>',
      "昵称：值得信赖的作者"
    ].join(""))
  });

  const result = await discovery.discover({
    sourceUrl: "https://www.douyin.com/video/7521000000000000000",
    sourceEvidenceId: "evidence-video"
  });

  assert.deepEqual(result, {
    status: "not_found",
    redirectChain: ["https://www.douyin.com/video/7521000000000000000"],
    publicProfileUrls: []
  });
});

test("discovery rejects non-HTTPS or non-exact Douyin hosts before fetching", async () => {
  let calls = 0;
  const discovery = createAcquisitionDouyinPublicProfileDiscovery({
    fetchWithRedirectTrace: async () => {
      calls += 1;
      return traced("");
    }
  });

  for (const sourceUrl of [
    "https://douyin.com.evil.example/user/actor",
    "http://www.douyin.com/user/actor"
  ]) {
    assert.deepEqual(await discovery.discover({ sourceUrl, sourceEvidenceId: "evidence" }), {
      status: "redirect_not_allowed",
      redirectChain: [],
      publicProfileUrls: []
    });
  }
  assert.equal(calls, 0);
});

test("discovery keeps a public profile page that merely contains login links or bundle text", async () => {
  const discovery = createAcquisitionDouyinPublicProfileDiscovery({
    fetchWithRedirectTrace: async () => traced([
      '<a href="/login">登录</a>',
      "<script>const loginBundleVersion = 'verify';</script>",
      '<a href="https://www.douyin.com/user/public-actor">author</a>'
    ].join(""))
  });

  assert.equal((await discovery.discover({
    sourceUrl: "https://www.douyin.com/video/7521000000000000000",
    sourceEvidenceId: "evidence"
  })).status, "succeeded");
});

test("discovery accepts a public final page after an approved intermediate login path", async () => {
  const discovery = createAcquisitionDouyinPublicProfileDiscovery({
    fetchWithRedirectTrace: async () => ({
      response: new Response('<a href="https://www.douyin.com/user/final-actor">author</a>'),
      redirectChain: [
        "https://v.douyin.com/ShortLink/",
        "https://www.douyin.com/login",
        "https://www.douyin.com/user/final-actor"
      ]
    })
  });

  assert.equal((await discovery.discover({
    sourceUrl: "https://v.douyin.com/ShortLink/",
    sourceEvidenceId: "evidence"
  })).status, "succeeded");
});

test("discovery treats explicit verification pages and restricted responses as access restrictions", async () => {
  for (const response of [
    new Response('<body data-page="verification"><div id="captcha_container"></div></body>', { status: 200 }),
    new Response("", { status: 403 }),
    new Response("", { status: 429 })
  ]) {
    const discovery = createAcquisitionDouyinPublicProfileDiscovery({
      fetchWithRedirectTrace: async () => ({
        response,
        redirectChain: ["https://www.douyin.com/video/7521000000000000000"]
      })
    });
    assert.deepEqual(await discovery.discover({
      sourceUrl: "https://www.douyin.com/video/7521000000000000000",
      sourceEvidenceId: "evidence"
    }), {
      status: "access_restricted",
      redirectChain: ["https://www.douyin.com/video/7521000000000000000"],
      publicProfileUrls: []
    });
  }
});

test("discovery extracts JSON structured profile URLs with escaped slashes", async () => {
  const discovery = createAcquisitionDouyinPublicProfileDiscovery({
    fetchWithRedirectTrace: async () => traced(
      '{"url":"https:\\/\\/www.douyin.com\\/user\\/escaped-slash"}'
    )
  });

  const result = await discovery.discover({
    sourceUrl: "https://www.douyin.com/video/7521000000000000000",
    sourceEvidenceId: "evidence"
  });
  assert.deepEqual(result.status === "succeeded" ? result.publicProfileUrls : [], [
    "https://www.douyin.com/user/escaped-slash"
  ]);
});

test("discovery extracts JSON-LD structured profile URLs with Unicode escaped slashes", async () => {
  const discovery = createAcquisitionDouyinPublicProfileDiscovery({
    fetchWithRedirectTrace: async () => traced(
      '<script type="application/ld+json">{"url":"https:\\u002F\\u002Fwww.douyin.com\\u002Fuser\\u002Funicode-slash"}</script>'
    )
  });

  const result = await discovery.discover({
    sourceUrl: "https://www.douyin.com/video/7521000000000000000",
    sourceEvidenceId: "evidence"
  });
  assert.deepEqual(result.status === "succeeded" ? result.publicProfileUrls : [], [
    "https://www.douyin.com/user/unicode-slash"
  ]);
});

test("discovery rejects a trace that leaves the fixed exact-host allowlist", async () => {
  const discovery = createAcquisitionDouyinPublicProfileDiscovery({
    fetchWithRedirectTrace: async () => traced(
      '<a href="https://www.douyin.com/user/actor">author</a>',
      "https://www.douyin.com/video/7521000000000000000"
    )
  });
  const unsafeDiscovery = createAcquisitionDouyinPublicProfileDiscovery({
    fetchWithRedirectTrace: async () => ({
      response: new Response("", { status: 200 }),
      redirectChain: [
        "https://www.douyin.com/video/7521000000000000000",
        "https://evil.example/user/actor"
      ]
    })
  });

  assert.equal((await discovery.discover({
    sourceUrl: "https://www.douyin.com/video/7521000000000000000",
    sourceEvidenceId: "evidence"
  })).status, "succeeded");
  assert.deepEqual(await unsafeDiscovery.discover({
    sourceUrl: "https://www.douyin.com/video/7521000000000000000",
    sourceEvidenceId: "evidence"
  }), {
    status: "redirect_not_allowed",
    redirectChain: [
      "https://www.douyin.com/video/7521000000000000000",
      "https://evil.example/user/actor"
    ],
    publicProfileUrls: []
  });
});

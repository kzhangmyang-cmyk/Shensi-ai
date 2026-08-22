import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchProviderHttpWithRedirectTrace,
  setProviderHttpTestTransport
} from "./provider-http-client.js";

const policy = {
  allowedHosts: ["v.douyin.com"],
  redirectHosts: ["www.douyin.com"],
  allowedPathPrefixes: ["/"],
  allowedMethods: ["GET"] as const
};

test("redirect trace preserves every approved destination in order", async (t) => {
  setProviderHttpTestTransport(async (url) => {
    if (url === "https://v.douyin.com/TraceMe/") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://www.douyin.com/video/7521000000000000000" }
      });
    }
    return new Response("ok", { status: 200 });
  });
  t.after(() => setProviderHttpTestTransport(null));

  const traced = await fetchProviderHttpWithRedirectTrace(
    policy,
    "https://v.douyin.com/TraceMe/",
    { method: "GET" }
  );

  assert.deepEqual(traced.redirectChain, [
    "https://v.douyin.com/TraceMe/",
    "https://www.douyin.com/video/7521000000000000000"
  ]);
  assert.equal(await traced.response.text(), "ok");
});

test("redirect trace rejects an unapproved redirect host", async (t) => {
  setProviderHttpTestTransport(async () => new Response(null, {
    status: 302,
    headers: { location: "https://douyin.com.evil.example/user/actor" }
  }));
  t.after(() => setProviderHttpTestTransport(null));

  await assert.rejects(
    () => fetchProviderHttpWithRedirectTrace(
      policy,
      "https://v.douyin.com/Unsafe/",
      { method: "GET" }
    ),
    /不在已批准|跨主机重定向/u
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createWebsiteServer } from "./server.mjs";
import { validateInquiry } from "../src/contact-validation.mjs";
const input = { name: "Example", company: "Synthetic company", email: "test@example.com", industry: "Technology", need: "global", message: "Synthetic inquiry for validation only.", consent: true, locale: "en", website: "" };
test("validates required fields, consent, injection, enums and honeypot", () => {
  assert.equal(validateInquiry(input).ok, true);
  for (const patch of [{ name: "" }, { email: "a\r\nBcc:x@y.com" }, { email: "bad" }, { consent: false }, { website: "bot" }, { need: "arbitrary" }, { message: "x" }, { company: "x".repeat(161) }]) assert.equal(validateInquiry({ ...input, ...patch }).ok, false);
});
test("request boundary and delivery reflect real receipt, never mock success", async () => {
  let calls = 0;
  const server = createWebsiteServer({ origins: ["http://localhost"], deliver: async () => { calls++; } });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/website-contact`;
  const post = (body, origin = "http://localhost") => fetch(url, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post(input, "https://evil.example")).status, 403);
    assert.equal((await post({ ...input, consent: false })).status, 422);
    assert.equal((await post(input)).status, 200);
    assert.equal(calls, 1);
    await post(input); await post(input); await post(input);
    assert.equal((await post(input)).status, 429);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test("missing mail config and transport failure are visible failures", async () => {
  for (const [deliver, status] of [[null, 503], [async () => { throw new Error("no SMTP"); }, 502]]) {
    const server = createWebsiteServer({ origins: ["http://localhost"], deliver });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/website-contact`, { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json" }, body: JSON.stringify(input) });
      assert.equal(response.status, status);
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});

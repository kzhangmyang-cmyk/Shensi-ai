import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { GrowthHttpError } from "./growth-command-context.js";
import {
  canonicalGrowthRequestHash,
  assertRevisionPrecondition,
  commandContextFromRequest,
  parseGrowthIdempotencyKey,
  parseIfMatchRevision,
  requireExpectedRevision,
  setRevisionEtag
} from "./growth-http-preconditions.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

const workspace = Object.freeze({ workspaceId: "team-a", kind: "team", actorId: "user-1", role: "admin", teamId: "team-a", capabilities: [], capabilityRegistryVersion: "growth-capabilities.v1" }) as ActiveWorkspaceContext;
const request = (headers: Record<string, string> = {}) => ({ method: "POST", header: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? undefined, activeWorkspace: workspace }) as unknown as Request;

test("revision parser rejects a missing If-Match precondition", () => {
  assert.throws(() => parseIfMatchRevision(request(), "catalog-item"), (error: unknown) => error instanceof GrowthHttpError && error.status === 428 && error.code === "revision_required");
});

test("revision parser rejects a malformed ETag", () => {
  assert.throws(() => parseIfMatchRevision(request({ "If-Match": "catalog-item:1" }), "catalog-item"), (error: unknown) => error instanceof GrowthHttpError && error.status === 400 && error.code === "invalid_if_match");
});

test("revision precondition distinguishes stale from exact revisions", () => {
  assert.throws(() => assertRevisionPrecondition(2, 3), (error: unknown) => error instanceof GrowthHttpError && error.status === 412 && error.code === "revision_conflict");
  assert.equal(assertRevisionPrecondition(3, 3), 3);
  assert.equal(parseIfMatchRevision(request({ "If-Match": '"catalog-item:item-1:3"' }), "catalog-item:item-1"), 3);
});

test("request context trusts workspace identity and hashes resource and revision", () => {
  const context = commandContextFromRequest(request({ "Idempotency-Key": "key-0001" }), {
    canonicalPath: "/api/v1/catalog/items/:id/retire", pathParams: Object.freeze({ id: "item-a" }), payload: { ignoredActorId: "forged" }, expectedRevision: 3
  });
  assert.equal(context.workspace, workspace);
  assert.equal(context.actorId, "user-1");
  assert.equal(context.idempotencyKey, "key-0001");
  assert.notEqual(context.requestHash, canonicalGrowthRequestHash({ method: "POST", canonicalPath: "/api/v1/catalog/items/:id/retire", pathParams: { id: "item-b" }, payload: { ignoredActorId: "forged" }, expectedRevision: 3 }));
  assert.notEqual(context.requestHash, canonicalGrowthRequestHash({ method: "POST", canonicalPath: "/api/v1/catalog/items/:id/retire", pathParams: { id: "item-a" }, payload: { ignoredActorId: "forged" }, expectedRevision: 4 }));
});

test("request helpers reject malformed idempotency and path inputs and emit parseable revision ETags", () => {
  assert.throws(() => parseGrowthIdempotencyKey(request({ "Idempotency-Key": " " })), /invalid_idempotency_key/u);
  assert.throws(() => commandContextFromRequest(request({ "Idempotency-Key": "key-0001" }), { canonicalPath: "/x", pathParams: { id: " " }, payload: {}, expectedRevision: null }), /invalid_growth_path_params/u);
  assert.throws(() => commandContextFromRequest(request({ "Idempotency-Key": "key-0001" }), { canonicalPath: "/x/:id", pathParams: Object.freeze({ id: "item-1", extra: "forged" }), payload: {}, expectedRevision: null }), /invalid_growth_path_params/u);
  const headers = new Map<string, string>();
  setRevisionEtag({ setHeader: (name: string, value: string) => { headers.set(name, value); } } as unknown as Response, "catalog-item", "item-1", 7);
  assert.equal(headers.get("ETag"), '"catalog-item:item-1:7"');
  assert.equal(parseIfMatchRevision(request({ "If-Match": headers.get("ETag")! }), "catalog-item:item-1"), 7);
  assert.throws(() => parseIfMatchRevision(request({ "If-Match": headers.get("ETag")! }), "catalog-item:item-2"), /invalid_if_match/u);
  assert.throws(() => parseIfMatchRevision(request({ "If-Match": headers.get("ETag")! }), "quote-version:quote-1"), /invalid_if_match/u);
});

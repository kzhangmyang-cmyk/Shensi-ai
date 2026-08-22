import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { canonicalJsonStringify } from "./canonical-json.js";
import { GrowthHttpError, requireExpectedRevision, type CommandContext } from "./growth-command-context.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export type GrowthWorkspaceContextResolver = (req: Request) => ActiveWorkspaceContext;
export type GrowthCommandContextFactory = (req: Request, input: { canonicalPath: string; pathParams: Readonly<Record<string, string>>; payload: unknown; expectedRevision: number | null }) => CommandContext;

export function canonicalGrowthRequestHash(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJsonStringify(value)).digest("hex")}`;
}

export function parseGrowthIdempotencyKey(req: Request): string {
  const value = req.header("Idempotency-Key");
  if (typeof value !== "string" || !value.trim() || value.length > 200) {
    throw new GrowthHttpError(400, "invalid_idempotency_key");
  }
  return value;
}

export function parseIfMatchRevision(req: Request, resourceScope: string): number {
  const normalizedScope = resourceScope.trim();
  if (!normalizedScope) throw new GrowthHttpError(400, "invalid_if_match");
  const raw = req.header("If-Match");
  if (!raw?.trim()) throw new GrowthHttpError(428, "revision_required");
  const match = new RegExp(`^"${normalizedScope.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}:([1-9]\\d*)"$`, "u").exec(raw.trim());
  if (!match) throw new GrowthHttpError(400, "invalid_if_match");
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) throw new GrowthHttpError(400, "invalid_if_match");
  return revision;
}

export function assertRevisionPrecondition(expectedRevision: number, currentRevision: number): number {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new GrowthHttpError(428, "revision_required");
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 1 || expectedRevision !== currentRevision) throw new GrowthHttpError(412, "revision_conflict");
  return expectedRevision;
}

export { requireExpectedRevision };

function pathParams(
  canonicalPath: string,
  value: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.isFrozen(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw new GrowthHttpError(400, "invalid_growth_path_params");
  const expected = [...canonicalPath.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/gu)]
    .map((match) => match[1]!);
  const actual = Object.keys(value).sort();
  if (new Set(expected).size !== expected.length
    || actual.length !== expected.length
    || actual.some((key, index) => key !== [...expected].sort()[index])) {
    throw new GrowthHttpError(400, "invalid_growth_path_params");
  }
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim() || typeof item !== "string" || !item.trim()) throw new GrowthHttpError(400, "invalid_growth_path_params");
  }
  return value;
}

export function commandContextFromRequest(req: Request, input: { canonicalPath: string; pathParams: Readonly<Record<string, string>>; payload: unknown; expectedRevision: number | null }): CommandContext {
  if (!req.activeWorkspace) throw new GrowthHttpError(400, "workspace_required");
  const validatedPathParams = pathParams(input.canonicalPath, input.pathParams);
  return Object.freeze({
    workspace: req.activeWorkspace,
    actorId: req.activeWorkspace.actorId,
    idempotencyKey: parseGrowthIdempotencyKey(req),
    requestHash: canonicalGrowthRequestHash({ method: req.method.toUpperCase(), canonicalPath: input.canonicalPath, pathParams: validatedPathParams, payload: input.payload, expectedRevision: input.expectedRevision }),
    expectedRevision: input.expectedRevision
  });
}

export function setRevisionEtag(res: Response, resource: string, id: string, revision: number): void {
  if (!resource.trim() || !id.trim() || !Number.isSafeInteger(revision) || revision < 1) throw new Error("invalid_growth_revision_etag");
  res.setHeader("ETag", `"${resource}:${id}:${revision}"`);
}

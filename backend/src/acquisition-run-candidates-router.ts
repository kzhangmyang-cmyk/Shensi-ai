import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";

export interface PublicRunCandidate {
  id: string;
  status: string;
  displayName: string;
  evidence: { sourceUrl: string; excerpt: string };
}

export interface AcquisitionRunCandidatesRepository {
  list(workspaceId: string, runId: string): Promise<readonly PublicRunCandidate[] | null>;
}

interface CursorPayload {
  v: 1;
  workspaceId: string;
  runId: string;
  filterHash: string;
  snapshot: string;
  offset: number;
}

function digest(value: string) {
  return createHmac("sha256", "run-candidate-filter-v1").update(value).digest("hex");
}
function filterHash(status: string | null) { return digest(JSON.stringify({ status })); }
function snapshot(items: readonly PublicRunCandidate[]) {
  return digest(JSON.stringify(items.map((item) => [item.id, item.status])));
}
function encode(payload: CursorPayload, secret: string) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}
function decode(value: string, secret: string): CursorPayload | null {
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const actualBuffer = Buffer.from(signature); const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
    return parsed.v === 1 && typeof parsed.workspaceId === "string" && typeof parsed.runId === "string"
      && typeof parsed.filterHash === "string" && typeof parsed.snapshot === "string"
      && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0 ? parsed : null;
  } catch { return null; }
}
function publicItem(item: PublicRunCandidate) {
  return {
    id: item.id, status: item.status, displayName: item.displayName.slice(0, 200),
    evidence: { sourceUrl: item.evidence.sourceUrl, excerpt: [...item.evidence.excerpt].slice(0, 500).join("") }
  };
}

/** Public read model: never returns raw crawler payloads, handles, or cookies. */
export function createAcquisitionRunCandidatesRouter(options: {
  repository: AcquisitionRunCandidatesRepository;
  cursorSecret: string;
  requestIdFactory?: () => string;
}) {
  const router = Router();
  const fail = (res: Response, status: number, code: string, requestId: string) =>
    res.status(status).json({ error: { code, message: code, details: null, requestId } });
  router.get("/api/v1/acquisition/runs/:runId/candidates", async (req: Request, res: Response) => {
    const requestId = options.requestIdFactory?.() ?? "request_run_candidates";
    res.setHeader("X-Request-Id", requestId); res.setHeader("Cache-Control", "no-store");
    const user = req.user; const workspace = req.activeWorkspace;
    if (!user?.id || !user.teamId || !workspace || workspace.actorId !== user.id || workspace.teamId !== user.teamId) {
      fail(res, 401, "workspace_context_invalid", requestId); return;
    }
    const runId = String(req.params.runId ?? "").trim();
    const status = typeof req.query.status === "string" && req.query.status.trim() ? req.query.status.trim() : null;
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
    if (!runId || !Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) { fail(res, 400, "invalid_request", requestId); return; }
    const listed = await options.repository.list(workspace.workspaceId, runId);
    if (listed === null) {
      fail(res, 404, "acquisition_run_not_found", requestId);
      return;
    }
    const all = listed.map(publicItem);
    // A DNC record is durable suppression state, never part of a default
    // downstream candidate feed. It is visible only through an explicit
    // status filter, which the application can additionally authorize.
    const filtered = status
      ? all.filter((item) => item.status === status)
      : all.filter((item) => item.status !== "do_not_contact");
    const hash = filterHash(status); const currentSnapshot = snapshot(filtered);
    let offset = 0;
    if (typeof req.query.cursor === "string") {
      const cursor = decode(req.query.cursor, options.cursorSecret);
      if (!cursor || cursor.workspaceId !== workspace.workspaceId || cursor.runId !== runId
        || cursor.filterHash !== hash || cursor.snapshot !== currentSnapshot) {
        fail(res, 400, "invalid_cursor", requestId); return;
      }
      offset = cursor.offset;
    }
    const items = filtered.slice(offset, offset + rawLimit);
    const nextOffset = offset + items.length;
    res.json({ items, nextCursor: nextOffset < filtered.length ? encode({ v: 1, workspaceId: workspace.workspaceId, runId, filterHash: hash, snapshot: currentSnapshot, offset: nextOffset }, options.cursorSecret) : null });
  });
  return router;
}

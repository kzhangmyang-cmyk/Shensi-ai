import { createHash } from "node:crypto";

import { Router, type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";

import { canonicalJsonStringify } from "./canonical-json.js";
import type { AcquisitionDesktopInstallationService } from "./acquisition-desktop-installation-service.js";
import type { AcquisitionDesktopOutreachSync } from "./acquisition-desktop-outreach-sync.js";

export interface AcquisitionDesktopOutreachSyncRouterOptions {
  installationService: Pick<AcquisitionDesktopInstallationService,
    "createEnrollment" | "register" | "authenticateDevice" | "bindDesktopExecutor" | "getDesktopBindingStatus">;
  outreachSync: Pick<AcquisitionDesktopOutreachSync, "claim" | "complete" | "reconcile">;
  /** Composition owns the gate; false deliberately leaves installation management available. */
  desktopExecutionEnabled?: boolean;
}

class PublicHttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const safeId = z.string().min(1).max(255)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));
const integer = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const bareHash = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value);
const accountHandle = z.string().regex(/^dyacct_[a-f0-9]{64}$/u);
const idempotencyPattern = /^[^\u0000-\u001f\u007f]{8,200}$/u;

const enrollmentBody = z.object({ protocolVersion: z.literal(1), installationId: token }).strict();
const registerBody = enrollmentBody.extend({ enrollmentToken: token }).strict();
const bindingBody = z.object({ installationId: token, accountHandle,
  loginStateVersion: integer, expectedBindingGeneration: z.number().int().min(0)
    .max(Number.MAX_SAFE_INTEGER), handoff: z.boolean() }).strict();
const availableAccount = z.object({ accountId: safeId, accountHandle,
  loginStateVersion: integer, bindingGeneration: integer }).strict();
const claimBody = z.object({ protocolVersion: z.literal(1), processInstanceId: token,
  waitSeconds: z.literal(0), availableAccounts: z.array(availableAccount).min(1).max(100) }).strict()
  .superRefine((value, context) => {
    if (new Set(value.availableAccounts.map((account) => account.accountId)).size
      !== value.availableAccounts.length) context.addIssue({ code: "custom", path: ["availableAccounts"],
      message: "available account IDs must be unique" });
  });
const startedCommand = z.object({ event: z.literal("started"), leaseVersion: integer,
  loginStateVersion: integer, taskRequestHash: bareHash, occurredAt: timestamp }).strict();
const receipt = z.object({ actionId: safeId, state: z.enum(["succeeded", "failed"]),
  platformReceiptReference: z.string().min(1).max(255).nullable(), occurredAt: timestamp,
  failureCode: z.string().min(1).max(80).nullable() }).strict();
const receiptCommand = z.object({ event: z.literal("receipt"), leaseVersion: integer,
  loginStateVersion: integer, taskRequestHash: bareHash, reconciliation: z.boolean(), receipt }).strict();
const completeBody = z.object({ protocolVersion: z.literal(1), processInstanceId: token,
  bindingGeneration: integer, command: z.discriminatedUnion("event", [startedCommand, receiptCommand]) }).strict();
const reconcileBody = z.object({ protocolVersion: z.literal(1), processInstanceId: token,
  accountId: safeId, accountHandle, loginStateVersion: integer, bindingGeneration: integer,
  originalLeaseVersion: integer, taskRequestHash: bareHash,
  journalPhase: z.enum(["claimed", "central_started", "sidecar_completed"]),
  receiptHash: bareHash.optional() }).strict().superRefine((value, context) => {
  if ((value.journalPhase === "sidecar_completed") !== (value.receiptHash !== undefined)) {
    context.addIssue({ code: "custom", path: ["receiptHash"],
      message: "receiptHash is required only after sidecar completion" });
  }
});

function canonicalBodyHash(value: unknown) {
  return createHash("sha256").update(canonicalJsonStringify(value), "utf8").digest("hex");
}

function physicalHeader(request: Request, name: string): string | null {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name.toLowerCase()) {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  if (values.length !== 1 || values[0].includes(",")) return null;
  return values[0];
}

function hasPhysicalHeader(request: Request, name: string) {
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === name.toLowerCase()) return true;
  }
  return false;
}

function requireJson(request: Request) {
  if (!request.is("application/json")) throw new PublicHttpError(415, "unsupported_media_type");
}

function idempotencyKey(request: Request) {
  const value = physicalHeader(request, "Idempotency-Key");
  if (!value || !idempotencyPattern.test(value)) {
    throw new PublicHttpError(400, "invalid_idempotency_key");
  }
  return value;
}

function userScope(request: Request) {
  if (!request.user?.id || !request.user.teamId) throw new PublicHttpError(401, "unauthorized");
  const workspace = request.activeWorkspace;
  if (!workspace || workspace.actorId !== request.user.id || workspace.teamId !== request.user.teamId) {
    throw new PublicHttpError(403, "workspace_context_invalid");
  }
  if (!workspace.capabilities?.includes("acquisition.outreach.approve" as never)) {
    throw new PublicHttpError(403, "capability_forbidden");
  }
  return { workspaceId: workspace.workspaceId, userId: request.user.id, teamId: request.user.teamId };
}

async function devicePrincipal(request: Request,
  installationService: AcquisitionDesktopOutreachSyncRouterOptions["installationService"]) {
  const installationId = physicalHeader(request, "X-Shensi-Desktop-Installation-Id");
  const deviceToken = physicalHeader(request, "X-Shensi-Desktop-Device-Token");
  if (!installationId || !deviceToken || !token.safeParse(installationId).success
    || !token.safeParse(deviceToken).success) {
    throw new PublicHttpError(401, "desktop_device_authentication_required");
  }
  try {
    const principal = await installationService.authenticateDevice({ installationId, deviceToken,
      protocolVersion: 1 });
    if (!principal) throw new PublicHttpError(401, "desktop_device_authentication_required");
    return principal;
  } catch (error) {
    if (error instanceof PublicHttpError) throw error;
    throw mappedError(error);
  }
}

function taskCapability(request: Request) {
  const value = physicalHeader(request, "X-Shensi-Desktop-Task-Token");
  if (!value || !token.safeParse(value).success) {
    throw new PublicHttpError(400, "invalid_desktop_task_token");
  }
  return value;
}

function rejectUnexpectedTaskCapability(request: Request) {
  if (hasPhysicalHeader(request, "X-Shensi-Desktop-Task-Token")) {
    throw new PublicHttpError(400, "unexpected_desktop_task_token");
  }
}

function mappedError(error: unknown): PublicHttpError {
  if (error instanceof PublicHttpError) return error;
  if (error instanceof ZodError || error instanceof SyntaxError) return new PublicHttpError(400, "invalid_request");
  const code = error instanceof Error ? error.message : "";
  const statusByCode: Record<string, number> = {
    desktop_enrollment_invalid: 400, desktop_enrollment_idempotency_conflict: 409,
    desktop_registration_idempotency_conflict: 409, desktop_enrollment_expired: 410,
    desktop_enrollment_unavailable: 503, desktop_membership_inactive: 403,
    desktop_executor_binding_invalid: 400, desktop_executor_binding_unavailable: 503,
    desktop_executor_handoff_required: 409, desktop_executor_handoff_blocked: 409,
    desktop_executor_generation_stale: 409, idempotency_key_conflict: 409,
    social_account_not_found: 404, desktop_installation_unavailable: 503,
    invalid_desktop_outreach_claim: 400, desktop_outreach_claim_not_authorized: 404,
    desktop_outreach_claim_idempotency_conflict: 409,
    invalid_desktop_outreach_completion: 400, desktop_outreach_completion_not_authorized: 404,
    desktop_outreach_completion_stale: 409, desktop_outreach_start_expired: 410,
    desktop_action_replay_conflict: 409, invalid_desktop_outreach_reconcile: 400
  };
  if (statusByCode[code]) return new PublicHttpError(statusByCode[code], code);
  return new PublicHttpError(503, "desktop_outreach_unavailable");
}

function operation(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, _next: NextFunction) => {
    void handler(request, response).catch((error) => {
      const mapped = mappedError(error);
      response.status(mapped.status).json({ error: mapped.code });
    });
  };
}

function executionEnabled(options: AcquisitionDesktopOutreachSyncRouterOptions) {
  if (options.desktopExecutionEnabled !== true) {
    throw new PublicHttpError(503, "desktop_execution_disabled");
  }
}

function projectBinding(result: { accountId: string; executorMode: "desktop";
  bindingGeneration: number; leaseExpiresAt: string; ownedByInstallation: true }) {
  return { accountId: result.accountId, executorMode: result.executorMode,
    bindingGeneration: result.bindingGeneration, leaseExpiresAt: result.leaseExpiresAt,
    ownedByInstallation: result.ownedByInstallation };
}

function projectActionTask(task: { actionId: string; workspaceId: string;
  accountId: string; accountHandle: string; loginStateVersion: number;
  executorBindingGeneration: number; kind: "comment" | "direct_message";
  canonicalTargetPublicUrl: string; content: string; approvedContentHash: string;
  taskRequestHash: string; deadlineAt: string; leaseVersion: number;
  leaseExpiresAt: string; predecessorReceipt: string | null }) {
  return { actionId: task.actionId, workspaceId: task.workspaceId,
    accountId: task.accountId, accountHandle: task.accountHandle,
    loginStateVersion: task.loginStateVersion,
    executorBindingGeneration: task.executorBindingGeneration, kind: task.kind,
    canonicalTargetPublicUrl: task.canonicalTargetPublicUrl, content: task.content,
    approvedContentHash: task.approvedContentHash, taskRequestHash: task.taskRequestHash,
    deadlineAt: task.deadlineAt, leaseVersion: task.leaseVersion,
    leaseExpiresAt: task.leaseExpiresAt, predecessorReceipt: task.predecessorReceipt };
}

function projectClaim(result: Awaited<ReturnType<AcquisitionDesktopOutreachSync["claim"]>>) {
  if (result.kind === "reconcile") return { kind: result.kind,
    task: projectReconciliationTask(result.task), taskToken: result.taskToken,
    serverTime: result.serverTime, replayed: result.replayed };
  return result.kind === "claimed"
    ? { kind: result.kind, task: projectActionTask(result.task),
        taskToken: result.taskToken, serverTime: result.serverTime,
        replayed: result.replayed }
    : { kind: result.kind, serverTime: result.serverTime,
        retryAfterMs: result.retryAfterMs, replayed: result.replayed };
}

function projectCompletion(result: Awaited<ReturnType<AcquisitionDesktopOutreachSync["complete"]>>) {
  return { actionId: result.actionId, state: result.state, replayed: result.replayed,
    accountPaused: result.accountPaused, occurredAt: result.occurredAt };
}

function projectReconciliationTask(task: {
  actionId: string; workspaceId: string; accountId: string; accountHandle: string;
  loginStateVersion: number; executorBindingGeneration: number;
  observationLoginStateVersion?: number;
  kind: "comment" | "direct_message"; canonicalTargetPublicUrl: string;
  content: string; approvedContentHash: string; deadlineAt: string;
  taskRequestHash: string; leaseVersion: number; originalLeaseVersion: number;
  reconciliationGeneration: number; capability: "reconcile_only";
}) {
  return { actionId: task.actionId, workspaceId: task.workspaceId,
    accountId: task.accountId, accountHandle: task.accountHandle,
    loginStateVersion: task.loginStateVersion,
    ...(task.observationLoginStateVersion === undefined ? {} : {
      observationLoginStateVersion: task.observationLoginStateVersion }),
    executorBindingGeneration: task.executorBindingGeneration, kind: task.kind,
    canonicalTargetPublicUrl: task.canonicalTargetPublicUrl, content: task.content,
    approvedContentHash: task.approvedContentHash, deadlineAt: task.deadlineAt,
    taskRequestHash: task.taskRequestHash, leaseVersion: task.leaseVersion,
    originalLeaseVersion: task.originalLeaseVersion,
    reconciliationGeneration: task.reconciliationGeneration,
    capability: task.capability };
}

function projectReconcile(result: Awaited<ReturnType<AcquisitionDesktopOutreachSync["reconcile"]>>) {
  if (result.kind === "released") return { kind: result.kind,
    actionId: result.actionId, taskRequestHash: result.taskRequestHash,
    originalLeaseVersion: result.originalLeaseVersion, replayed: result.replayed };
  if (result.kind === "reconcile") return { kind: result.kind,
    replayed: result.replayed, taskToken: result.taskToken,
    task: projectReconciliationTask(result.task) };
  if (result.kind === "terminal") return { kind: result.kind, status: result.status,
    receiptHash: result.receiptHash, replayed: result.replayed };
  if (result.kind === "waiting") return { kind: result.kind,
    retryAfterMs: result.retryAfterMs, replayed: result.replayed };
  return { kind: result.kind, replayed: result.replayed };
}

export function createAcquisitionDesktopOutreachSyncRouter(options: AcquisitionDesktopOutreachSyncRouterOptions) {
  const router = Router();
  router.post("/desktop-installations/enrollments", operation(async (request, response) => {
    requireJson(request); const scope = userScope(request); const body = enrollmentBody.parse(request.body);
    const result = await options.installationService.createEnrollment(scope, body, idempotencyKey(request), canonicalBodyHash(body));
    response.status(201).json({ enrollmentToken: result.token, expiresAt: result.expiresAt });
  }));
  router.post("/desktop-installations/register", operation(async (request, response) => {
    requireJson(request); const body = registerBody.parse(request.body);
    const result = await options.installationService.register(body, idempotencyKey(request), canonicalBodyHash(body));
    response.status(result.replayed ? 200 : 201).json({ deviceToken: result.deviceToken,
      workspaceId: result.workspaceId, protocolVersion: result.protocolVersion });
  }));
  router.get("/social-accounts/:accountId/desktop-binding", operation(async (request, response) => {
    const scope = userScope(request);
    const query = z.object({ installationId: token }).strict().parse(request.query);
    const result = await options.installationService.getDesktopBindingStatus(scope,
      safeId.parse(request.params.accountId), query.installationId);
    response.setHeader("Cache-Control", "no-store");
    response.json({ accountId: result.accountId, executorMode: result.executorMode,
      bindingGeneration: result.bindingGeneration, leaseExpiresAt: result.leaseExpiresAt,
      ownedByInstallation: result.ownedByInstallation, hasUnresolvedActions: result.hasUnresolvedActions });
  }));
  router.post("/social-accounts/:accountId/desktop-binding", operation(async (request, response) => {
    requireJson(request); const scope = userScope(request); const body = bindingBody.parse(request.body);
    const accountId = safeId.parse(request.params.accountId);
    const result = await options.installationService.bindDesktopExecutor(scope, accountId, {
      installationId: body.installationId, accountHandle: body.accountHandle,
      loginStateVersion: body.loginStateVersion, expectedGeneration: body.expectedBindingGeneration,
      handoff: body.handoff }, idempotencyKey(request), canonicalBodyHash(body));
    response.json(projectBinding(result));
  }));
  router.post("/desktop-outreach-actions/claim", operation(async (request, response) => {
    executionEnabled(options); rejectUnexpectedTaskCapability(request);
    const principal = await devicePrincipal(request, options.installationService);
    requireJson(request); const body = claimBody.parse(request.body);
    const result = await options.outreachSync.claim(principal, { processInstanceId: body.processInstanceId,
      availableAccounts: body.availableAccounts, idempotencyKey: idempotencyKey(request) });
    response.json(projectClaim(result));
  }));
  router.post("/desktop-outreach-actions/:actionId/complete", operation(async (request, response) => {
    executionEnabled(options); const principal = await devicePrincipal(request, options.installationService);
    requireJson(request); const body = completeBody.parse(request.body); const actionId = safeId.parse(request.params.actionId);
    const command = body.command;
    const result = await options.outreachSync.complete(principal, actionId, { ...command,
      processInstanceId: body.processInstanceId, taskToken: taskCapability(request),
      executorBindingGeneration: body.bindingGeneration, idempotencyKey: idempotencyKey(request) } as never);
    response.json(projectCompletion(result));
  }));
  router.post("/desktop-outreach-actions/:actionId/reconcile", operation(async (request, response) => {
    executionEnabled(options); rejectUnexpectedTaskCapability(request);
    const principal = await devicePrincipal(request, options.installationService);
    requireJson(request); const body = reconcileBody.parse(request.body); const actionId = safeId.parse(request.params.actionId);
    const result = await options.outreachSync.reconcile(principal, actionId, { version: 1,
      processInstanceId: body.processInstanceId, accountId: body.accountId, accountHandle: body.accountHandle,
      loginStateVersion: body.loginStateVersion, bindingGeneration: body.bindingGeneration,
      originalLeaseVersion: body.originalLeaseVersion, taskRequestHash: body.taskRequestHash,
      journalPhase: body.journalPhase, ...(body.receiptHash ? { receiptHash: body.receiptHash } : {}),
      idempotencyKey: idempotencyKey(request) });
    response.json(projectReconcile(result));
  }));
  const exactPaths = ["/desktop-installations/enrollments", "/desktop-installations/register",
    "/social-accounts/:accountId/desktop-binding", "/desktop-outreach-actions/claim",
    "/desktop-outreach-actions/:actionId/complete", "/desktop-outreach-actions/:actionId/reconcile"];
  for (const path of exactPaths) router.all(path, (_request, response) => {
    response.status(405).json({ error: "method_not_allowed" });
  });
  return router;
}

import type { RequestHandler } from "express";
import type { Role, SessionUser } from "./types.js";
import {
  capabilitiesForHumanRole,
  GROWTH_CAPABILITY_REGISTRY_VERSION,
  type GrowthCapability
} from "./growth-capabilities.js";

export interface ActiveWorkspaceContext {
  workspaceId: string;
  kind: "team" | "personal";
  actorId: string;
  role: Role;
  teamId: string;
  capabilities: readonly GrowthCapability[];
  capabilityRegistryVersion: string;
}

export interface GrowthWorkspaceDirectory {
  canAccess(user: SessionUser, workspaceId: string): Promise<boolean>;
}

export interface GrowthAcquisitionWorkspaceDirectory {
  resolve(scope: Readonly<{ ownerId: string; teamId: string }>): Promise<{
    workspaceId: string;
    kind: "team" | "personal";
    bindingRevision: string;
  } | null>;
}

declare const resolvedAcquisitionWorkspaceBrand: unique symbol;

export interface ResolvedAcquisitionWorkspace {
  readonly workspaceId: string;
  readonly kind: "team" | "personal";
  readonly bindingRevision: string;
  readonly ownerId: string;
  readonly teamId: string;
  readonly [resolvedAcquisitionWorkspaceBrand]: true;
}

export interface GrowthAcquisitionWorkspaceResolver {
  resolve(scope: Readonly<{ ownerId: string; teamId: string }>):
    Promise<ResolvedAcquisitionWorkspace | null>;
}

const resolvedAcquisitionWorkspaces = new WeakSet<object>();
const issuedAcquisitionWorkspaceResolvers = new WeakSet<object>();

export function assertGrowthAcquisitionWorkspaceResolver(
  value: GrowthAcquisitionWorkspaceResolver
): GrowthAcquisitionWorkspaceResolver {
  if (!value || !issuedAcquisitionWorkspaceResolvers.has(value)) {
    throw new Error("invalid_growth_acquisition_workspace_resolver");
  }
  return value;
}

function concrete(value: string) {
  const normalized = value.trim();
  return normalized && normalized !== "all" ? normalized : null;
}

export function assertResolvedAcquisitionWorkspace(
  value: ResolvedAcquisitionWorkspace | null
): ResolvedAcquisitionWorkspace {
  if (!value || !resolvedAcquisitionWorkspaces.has(value)) {
    throw new Error("invalid_resolved_acquisition_workspace");
  }
  return value;
}

export function createGrowthAcquisitionWorkspaceResolver(
  directory: GrowthAcquisitionWorkspaceDirectory
): GrowthAcquisitionWorkspaceResolver {
  const resolver = Object.freeze({
    async resolve(scope: Readonly<{ ownerId: string; teamId: string }>) {
      const ownerId = concrete(scope.ownerId);
      const teamId = concrete(scope.teamId);
      if (!ownerId || !teamId) return null;
      const exactScope = Object.freeze({ ownerId, teamId });
      const binding = await directory.resolve(exactScope);
      if (!binding) return null;
      const workspaceId = concrete(binding.workspaceId);
      const bindingRevision = concrete(binding.bindingRevision);
      if (!workspaceId || !bindingRevision) return null;
      if (binding.kind !== "team" && binding.kind !== "personal") return null;
      const resolved = Object.freeze({
        workspaceId,
        kind: binding.kind,
        bindingRevision,
        ownerId,
        teamId
      }) as ResolvedAcquisitionWorkspace;
      resolvedAcquisitionWorkspaces.add(resolved);
      return resolved;
    }
  });
  issuedAcquisitionWorkspaceResolvers.add(resolver);
  return resolver;
}

export async function resolveActiveWorkspace(
  user: SessionUser,
  requestedWorkspaceId: string | null,
  directory: GrowthWorkspaceDirectory
): Promise<ActiveWorkspaceContext | null> {
  const personal = `personal:${user.id}`;
  const requested = requestedWorkspaceId?.trim() || null;
  let workspaceId: string | null = null;
  if (requested === "all") return null;
  if (requested?.startsWith("personal:") && requested !== personal) return null;
  if (requested === personal) {
    workspaceId = personal;
  } else if (
    user.teamId !== "all"
    && (!requested || requested === user.teamId)
  ) {
    workspaceId = user.teamId;
  } else if (requested && await directory.canAccess(user, requested)) {
    workspaceId = requested;
  }
  if (!workspaceId || workspaceId === "all") return null;
  return Object.freeze({
    workspaceId,
    kind: workspaceId === personal ? "personal" : "team",
    actorId: user.id,
    role: user.role,
    teamId: user.teamId,
    capabilities: capabilitiesForHumanRole(user.role),
    capabilityRegistryVersion: GROWTH_CAPABILITY_REGISTRY_VERSION
  });
}

export function createGrowthWorkspaceMiddleware(
  directory: GrowthWorkspaceDirectory
): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      if (!req.user) {
        req.activeWorkspace = undefined;
        next();
        return;
      }
      const requested = req.header("X-Workspace-Id") ?? null;
      req.activeWorkspace = await resolveActiveWorkspace(
        req.user,
        requested,
        directory
      ) ?? undefined;
      next();
    })().catch(next);
  };
}

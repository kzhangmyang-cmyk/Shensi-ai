import { z } from 'zod';

export const platformFeatures = ['acquisition', 'agents', 'decision', 'crm', 'growth', 'outreach'] as const;
export const planCodes = ['trial', 'basic', 'pro'] as const;
export const planDraftSchema = z.object({
  code: z.enum(planCodes),
  features: z.array(z.enum(platformFeatures)).max(6).refine(values => new Set(values).size === values.length),
  seatLimit: z.number().int().min(1).max(10000).nullable(),
  durationDays: z.number().int().min(1).max(3650).nullable(),
  published: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.published && (!value.features.length || value.seatLimit === null || value.durationDays === null)) {
    context.addIssue({ code: 'custom', message: '发布套餐必须明确功能、席位和有效天数' });
  }
});
export type PlatformPlan = z.infer<typeof planDraftSchema> & { id: string; version: number };
export interface PlatformWorkspace {
  id: string;
  name: string;
  contact: string;
  status: 'pending' | 'active' | 'suspended';
  planVersionId: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  revision: number;
}
export interface PlatformMembership {
  userId: string;
  role: 'owner' | 'operator';
  status: 'active' | 'disabled';
  secretEncrypted: string;
  lastOtpCounter: number;
  sessionVersion: number;
}
export interface PlatformAudit {
  id: string; actorId: string; action: string; targetId: string;
  reason: string; occurredAt: string; revision: number;
}
export interface PlatformAdminState {
  revision: number;
  memberships: PlatformMembership[];
  plans: PlatformPlan[];
  workspaces: PlatformWorkspace[];
  audits: PlatformAudit[];
  passwordResets?: { tokenHash: string; userId: string; expiresAt: string; authVersion: number }[];
}
export function emptyPlatformState(): PlatformAdminState {
  return { revision: 0, memberships: [], workspaces: [], audits: [], plans: planCodes.map(code => ({ id: `${code}:1`, version: 1, code, features: [], seatLimit: null, durationDays: null, published: false })) };
}

export type PlatformFeature = typeof platformFeatures[number];
export interface CustomerAccess {
  status: 'unmanaged' | 'pending' | 'suspended' | 'unconfigured' | 'scheduled' | 'active' | 'expired';
  workspaceId: string;
  workspaceName: string | null;
  planCode: typeof planCodes[number] | null;
  startsAt: string | null;
  expiresAt: string | null;
  features: PlatformFeature[];
  canRead: boolean;
  canExecute: boolean;
  checkedAt: string;
}

// Customer-facing commercial summary only. Business role and ownership checks remain separate.
export function summarizeCustomerAccess(state: PlatformAdminState, workspaceId: string, now = Date.now(), updating = false): CustomerAccess {
  const base: CustomerAccess = { status: 'unconfigured', workspaceId, workspaceName: null, planCode: null, startsAt: null, expiresAt: null, features: [], canRead: false, canExecute: false, checkedAt: new Date(now).toISOString() };
  if (updating) return base;
  const workspace = state.workspaces.find(row => row.id === workspaceId);
  if (!workspace) return { ...base, status: 'unmanaged', features: [...platformFeatures], canRead: true, canExecute: true };
  base.workspaceName = workspace.name;
  base.startsAt = workspace.startsAt; base.expiresAt = workspace.expiresAt;
  const plan = state.plans.find(row => row.id === workspace.planVersionId && row.published);
  if (plan) { base.planCode = plan.code; base.features = [...plan.features]; }
  if (workspace.status !== 'active') return { ...base, status: workspace.status };
  const starts = Date.parse(workspace.startsAt ?? ''), ends = Date.parse(workspace.expiresAt ?? '');
  if (!plan || !Number.isFinite(starts) || !Number.isFinite(ends) || starts >= ends) return base;
  if (now < starts) return { ...base, status: 'scheduled' };
  if (now >= ends) return { ...base, status: 'expired', canRead: true };
  return { ...base, status: 'active', canRead: true, canExecute: true };
}

export function evaluatePlatformAccess(state: PlatformAdminState, workspaceId: string, feature: PlatformFeature | null, operation: 'read' | 'execute', now: number) {
  const workspace = state.workspaces.find(row => row.id === workspaceId);
  // Explicitly unmanaged existing customers preserve their current permissions.
  if (!workspace) return { allowed: true, managed: false, code: 'unmanaged' };
  if (workspace.status !== 'active') return { allowed: false, managed: true, code: `workspace_${workspace.status}` };
  const plan = state.plans.find(row => row.id === workspace.planVersionId);
  if (!plan?.published || !workspace.startsAt || !workspace.expiresAt) return { allowed: false, managed: true, code: 'subscription_unconfigured' };
  const starts = Date.parse(workspace.startsAt), ends = Date.parse(workspace.expiresAt);
  if (!Number.isFinite(starts) || !Number.isFinite(ends) || starts >= ends || now < starts) return { allowed: false, managed: true, code: 'subscription_inactive' };
  // Retained data remains readable on expiry, but new execution never does.
  if (now >= ends && operation === 'execute') return { allowed: false, managed: true, code: 'subscription_expired' };
  if (feature && !plan.features.includes(feature)) return { allowed: false, managed: true, code: 'feature_forbidden' };
  return { allowed: true, managed: true, code: now >= ends ? 'expired_read_only' : 'active' };
}

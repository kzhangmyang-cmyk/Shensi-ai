import { publicUser } from '../auth.js';
import { isAccountMutationPending, isPlatformMutationPending } from '../account-mutation-state.js';
import { evaluatePlatformAccess } from '../platform-admin-domain.js';
import { resolveActiveWorkspace, type GrowthWorkspaceDirectory } from '../growth-workspace-context.js';
import type { CrmStore } from '../store.js';
import { assertKnowledgeScope, type KnowledgeJobClaim, type KnowledgeScope } from './domain.js';

/** Reuses the current application account/membership authority, not upload claims. */
export function createKnowledgeScopeAuthorizer(store: Pick<CrmStore, 'users'> & Partial<Pick<CrmStore, 'platformAdminStates'>>) {
  const directory: GrowthWorkspaceDirectory = { async canAccess(user, workspaceId) {
    return user.role === 'super_admin' && store.users.some(row => row.status === 'active' && row.teamId === workspaceId);
  } };
  return async (claim: Pick<KnowledgeScope, 'actorId' | 'workspaceId'>) => {
    const user = store.users.find(row => row.id === claim.actorId && row.status === 'active');
    if (!user || isAccountMutationPending(user.id)) throw new Error('knowledge_authorization_revoked');
    const platform = store.platformAdminStates?.[0];
    if (platform && (isPlatformMutationPending(store) || !evaluatePlatformAccess(platform, user.teamId, 'crm', 'execute', Date.now()).allowed)) {
      throw new Error('knowledge_authorization_revoked');
    }
    const ctx = await resolveActiveWorkspace(publicUser(user), claim.workspaceId, directory);
    if (!ctx || ctx.workspaceId !== claim.workspaceId || ctx.actorId !== claim.actorId) throw new Error('knowledge_authorization_revoked');
    assertKnowledgeScope(ctx, 'knowledge.read'); return ctx;
  };
}
export function createKnowledgeJobAuthorizer(store: Pick<CrmStore, 'users'> & Partial<Pick<CrmStore, 'platformAdminStates'>>) {
  const authorize = createKnowledgeScopeAuthorizer(store);
  return async (claim: KnowledgeJobClaim) => { const ctx = await authorize(claim); assertKnowledgeScope(ctx, 'knowledge.upload'); return ctx; };
}

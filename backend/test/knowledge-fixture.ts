import { capabilitiesForHumanRole } from '../src/growth-capabilities.js';
import type { ActiveWorkspaceContext } from '../src/growth-workspace-context.js';

export const validInput = {
  title: '全面预算参考', filename: 'budget.txt', format: 'txt' as const,
  bytes: 120, sourceKind: 'book' as const, roles: ['cfo', 'finance'] as ('cfo' | 'finance')[]
};
export function knowledgeContext(actorId = 'actor-a', workspaceId = 'team-a',
  role: ActiveWorkspaceContext['role'] = 'admin'): ActiveWorkspaceContext {
  return { actorId, workspaceId, kind: 'team', teamId: 'team-a', role,
    capabilities: capabilitiesForHumanRole(role), capabilityRegistryVersion: 'growth-capabilities.v1' };
}
export const parsedFixture = {
  parserVersion: 'synthetic.v1',
  coverage: { totalPages: 1, extractedPages: 1, missingPages: [] }, warnings: [],
  chunks: [{ order: 0, text: '全面预算需要结合企业的现金回款和实际经营目标。',
    locator: { page: 1, chapter: '预算方法' }, warnings: [] }]
};

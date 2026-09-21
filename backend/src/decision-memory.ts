// Compatibility entry: existing operating-domain rows, encryption and immutable
// report snapshots remain unchanged. There is only one implementation.
export {AgentOperatingMemoryService as DecisionMemoryService, savedPreferencesSchema,
  emptyDecisionMemory} from './agent-operating-memory.js';
export type {DecisionMemory,DecisionReview} from './agent-operating-memory.js';

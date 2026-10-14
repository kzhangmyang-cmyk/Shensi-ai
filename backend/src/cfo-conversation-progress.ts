// Internal execution observations, not model reasoning or a public wire DTO.
export type CfoConversationStage = 'material_ready' | 'skill_ready' | 'model_started' | 'answer_validated';
export type CfoConversationProgress = (stage: CfoConversationStage) => void;

export function observeCfoStage(observer: CfoConversationProgress | undefined,
  stage: CfoConversationStage, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  // A disconnected status consumer must not invalidate an otherwise valid answer.
  try { observer?.(stage); } catch { /* Observation never owns execution. */ }
  signal?.throwIfAborted();
}

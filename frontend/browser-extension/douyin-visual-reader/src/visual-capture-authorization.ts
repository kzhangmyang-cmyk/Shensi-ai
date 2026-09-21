import type { VisualReaderRuntimeSnapshot } from "./session-coordinator";
import { authorizeVisualCapture } from "./visual-capture-guard";
import type {
  VisualCaptureAuthorization,
  VisualCaptureOwner
} from "./visual-capture-runtime";

interface CaptureCoordinatorSnapshotSource {
  snapshot(): VisualReaderRuntimeSnapshot;
}

export function createVisualCaptureAuthorizationResolver(dependencies: {
  getCoordinator(): CaptureCoordinatorSnapshotSource | null;
  getGeneration(): number;
  getTab(tabId: number): Promise<{
    id?: number;
    windowId?: number;
    active?: boolean;
    url?: string;
  } | null>;
  getFocusedWindowId(): Promise<number | null>;
}): (request: unknown, senderTabId: number | null,
expectedOwner: VisualCaptureOwner | null) => Promise<VisualCaptureAuthorization | null> {
  return async (request, senderTabId, expectedOwner) => {
    const coordinator = dependencies.getCoordinator();
    const generation = dependencies.getGeneration();
    const before = coordinator?.snapshot() ?? null;
    if (!coordinator || !before || before.status !== "reading" || before.douyinTabId === null) {
      return null;
    }
    const [tab, focusedWindowId] = await Promise.all([
      dependencies.getTab(before.douyinTabId),
      dependencies.getFocusedWindowId()
    ]);
    if (dependencies.getCoordinator() !== coordinator
      || dependencies.getGeneration() !== generation) return null;
    const snapshot = coordinator.snapshot();
    const authorized = authorizeVisualCapture({
      request,
      senderTabId,
      snapshot,
      tab,
      focusedWindowId
    });
    if (!authorized || snapshot.douyinTabId === null || snapshot.douyinWindowId === null) return null;
    const owner: VisualCaptureOwner = {
      generation,
      sessionId: snapshot.sessionId,
      tabId: snapshot.douyinTabId,
      windowId: snapshot.douyinWindowId
    };
    if (expectedOwner && (expectedOwner.generation !== owner.generation
      || expectedOwner.sessionId !== owner.sessionId || expectedOwner.tabId !== owner.tabId
      || expectedOwner.windowId !== owner.windowId)) return null;
    return { request: authorized, owner };
  };
}

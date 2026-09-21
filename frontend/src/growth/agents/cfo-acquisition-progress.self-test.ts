import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import {
  loadCfoAcquisitionProgress,
  recordCfoAcquisitionDraft,
  startCfoAcquisitionProgressTracking
} from "./cfo-acquisition-progress";

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const { document, window } = parseHTML("<html><body></body></html>");
const storage = new MemoryStorage();
Object.defineProperty(window, "localStorage", {
  value: storage,
  configurable: true
});
document.body.dataset.sessionWorkspaceId = "workspace-1";
document.body.dataset.sessionUserId = "user-1";
const now = () => "2026-09-06T12:00:00.000Z";
const tracker = startCfoAcquisitionProgressTracking(document, now);

recordCfoAcquisitionDraft(document, "开始拖音获客", now);
document.dispatchEvent(new window.CustomEvent(
  "goodjob:cfo-acquisition-workflow-started",
  { detail: { planId: "plan-1", runId: "run-1", runStatus: "queued" } }
));
document.dispatchEvent(new window.CustomEvent(
  "goodjob:acquisition-candidate-changed",
  { detail: { planId: "plan-1", candidateId: "candidate-1", action: "reviewed" } }
));
document.dispatchEvent(new window.CustomEvent(
  "goodjob:acquisition-candidate-changed",
  { detail: { planId: "plan-1", candidateId: "candidate-1", action: "private_domain_handoff_completed", customerId: "customer-1", todoId: "todo-1" } }
));
document.dispatchEvent(new window.CustomEvent(
  "goodjob:acquisition-deal-created",
  { detail: { customerId: "customer-1", dealId: "deal-1" } }
));

assert.deepEqual(loadCfoAcquisitionProgress(storage, "workspace-1:user-1"), {
  version: 1,
  scope: "workspace-1:user-1",
  prompt: "开始拖音获客",
  stage: "deal_created",
  planId: "plan-1",
  runId: "run-1",
  runStatus: "queued",
  candidateId: "candidate-1",
  customerId: "customer-1",
  todoId: "todo-1",
  dealId: "deal-1",
  updatedAt: "2026-09-06T12:00:00.000Z"
});

document.body.dataset.sessionUserId = "user-2";
assert.equal(loadCfoAcquisitionProgress(storage, "workspace-1:user-2"), null);
tracker.dispose();

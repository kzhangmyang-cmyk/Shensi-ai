import { strict as assert } from "node:assert";
import * as detailEntry from "./detail-center-entry";

const { acquisitionDetailRequestForAction } = detailEntry;

assert.deepEqual(
  acquisitionDetailRequestForAction("real", "replicaEditTask", "plan-real-1"),
  { mode: "plan", planId: "plan-real-1" },
  "the real plan action must open the selected task's plan details"
);

assert.deepEqual(
  acquisitionDetailRequestForAction("real", "replicaCompleteTask", "plan-real-1"),
  { mode: "candidates", planId: "plan-real-1" },
  "the real candidate action must open the selected task's AI review"
);

assert.equal(
  acquisitionDetailRequestForAction("demo", "replicaCompleteTask", "plan-demo"),
  null,
  "demo actions must keep their existing simulated behavior"
);

assert.equal(
  acquisitionDetailRequestForAction("real", "replicaEditTask", "  "),
  null,
  "a real detail action without a selected plan must not open an empty dialog"
);

const candidateDetailOpenRequest = (
  detailEntry as typeof detailEntry & {
    acquisitionCandidateDetailRequest?: (
      candidateId: string,
      planId?: string
    ) => unknown;
  }
).acquisitionCandidateDetailRequest;

assert.equal(
  typeof candidateDetailOpenRequest,
  "function",
  "a user-imported candidate needs a task-independent detail request builder"
);
assert.deepEqual(
  candidateDetailOpenRequest?.("candidate-imported-1"),
  { mode: "candidates", candidateId: "candidate-imported-1" },
  "an imported candidate must remain openable before any acquisition task exists"
);
assert.deepEqual(
  candidateDetailOpenRequest?.("candidate-imported-1", "plan-existing-1"),
  {
    mode: "candidates",
    planId: "plan-existing-1",
    candidateId: "candidate-imported-1"
  },
  "an imported candidate should keep task attribution when a plan is selected"
);

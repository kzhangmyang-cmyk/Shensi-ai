import { strict as assert } from "node:assert";
import {
  isPlanDraftSubmissionReady,
  isTaskCreationSubmitReady
} from "./task-creation-controller";
import * as taskCreationController from "./task-creation-controller";
import { buildDouyinPlanInput } from "./task-creation-api";

assert.equal(isTaskCreationSubmitReady({
  searchConnectionId: "search-1",
  modelConnectionId: "model-1",
  approvalConfirmed: false,
  loading: false,
  submitting: false,
  completed: false
}), false);

{
  const prepareAiPlan = (taskCreationController as Record<string, unknown>)
    .prepareAiPlanForApproval;
  assert.equal(typeof prepareAiPlan, "function");
  const planInput = buildDouyinPlanInput({
    name: "AI 评论计划",
    objective: "发现公开需求",
    industries: ["企业服务"],
    regions: ["厦门"],
    organizationCriteria: ["需求明确"],
    individualCriteria: ["公开询价"],
    organizationQuery: "企业 获客",
    individualQuery: "老板 询价",
    providerConnection: {
      id: "search-1", providerId: "brave", kind: "search", status: "active", lastHealthStatus: "passed", credentialVersion: 1
    },
    modelConnectionId: "model-1",
    budget: { billingCurrency: "CNY", maxRequests: 4, maxResults: 4, maxAmountMinor: 0, maxDurationSeconds: 4 }
  });
  const sampleInput = { enabled: true, maxVideosPerRun: 10, maxCommentsPerVideo: 30, maxPagesPerVideo: 3 };
  const effective = (prepareAiPlan as unknown as (input: typeof planInput, sample: typeof sampleInput) => typeof planInput)(planInput, sampleInput);
  assert.deepEqual((effective as typeof effective & { douyinPublicCommentSample?: unknown }).douyinPublicCommentSample, sampleInput);
  assert.deepEqual(effective.providerConnections.at(-1), {
    connectionId: "douyin-public-comments", providerId: "experimental_public_sample", kind: "content_fetch", status: "active", credentialVersion: 1
  });
  for (const changed of [
    { ...sampleInput, maxVideosPerRun: 20 },
    { ...sampleInput, maxCommentsPerVideo: 31 },
    { ...sampleInput, maxPagesPerVideo: 4 }
  ]) {
    assert.equal(
      ((taskCreationController as unknown as Record<string, (previous: typeof sampleInput, next: typeof sampleInput) => boolean>)
        .commentSamplePlanChanged)(sampleInput, changed),
      true
    );
  }
}

const completedManualSubmission = {
  searchConnectionId: "search-1",
  modelConnectionId: "model-1",
  approvalConfirmed: true,
  loading: false,
  submitting: false,
  completed: true
};
assert.equal(isTaskCreationSubmitReady(completedManualSubmission), false);

const completedAiSubmission = {
  mode: "ai" as const,
  hasDraft: true,
  approvalConfirmed: true,
  loading: false,
  submitting: false,
  completed: true
};
assert.equal(isPlanDraftSubmissionReady(completedAiSubmission), false);

assert.equal(isPlanDraftSubmissionReady({
  mode: "ai",
  hasDraft: false,
  approvalConfirmed: true,
  loading: false,
  submitting: false,
  completed: false
}), false);
assert.equal(isPlanDraftSubmissionReady({
  mode: "ai",
  hasDraft: true,
  approvalConfirmed: true,
  loading: false,
  submitting: false,
  completed: false
}), true);
assert.equal(isPlanDraftSubmissionReady({
  mode: "manual",
  hasDraft: false,
  approvalConfirmed: true,
  loading: false,
  submitting: false,
  completed: false
}), true);

assert.equal(isTaskCreationSubmitReady({
  searchConnectionId: "search-1",
  modelConnectionId: "model-1",
  approvalConfirmed: true,
  loading: false,
  submitting: false,
  completed: false
}), true);

assert.equal(isTaskCreationSubmitReady({
  searchConnectionId: "search-1",
  modelConnectionId: "model-1",
  approvalConfirmed: true,
  loading: true,
  submitting: false,
  completed: false
}), false);

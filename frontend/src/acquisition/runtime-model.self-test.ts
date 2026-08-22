import { strict as assert } from "node:assert";
import {
  buildAcquisitionOverviewModel,
  runStatusLabel
} from "./runtime-model";

const overview = buildAcquisitionOverviewModel({
  generatedAt: "2026-08-07T05:00:00.000Z",
  platform: "douyin",
  totals: { tasks: 3 },
  statusCounts: {
    running: 1,
    succeeded: 1,
    failed: 1
  },
  discoveryMethodCounts: {
    public_search: 2,
    user_import: 1
  },
  tasks: [
    {
      id: "task-running",
      planId: "plan-running",
      name: "厦门装修需求发现",
      objective: "发现公开表达装修需求的抖音主体",
      platform: "douyin",
      discoveryMethods: ["public_search"],
      planStatus: "approved",
      latestRun: {
        id: "run-running",
        status: "running",
        updatedAt: "2026-08-07T04:59:00.000Z",
        completedAt: null,
        evidenceCount: 12,
        consumedBudget: {
          requests: 4,
          results: 18,
          durationSeconds: 31
        }
      },
      updatedAt: "2026-08-07T04:59:00.000Z"
    },
    {
      id: "task-failed",
      planId: "plan-failed",
      name: "厦门美业需求发现",
      objective: "发现公开表达美业获客需求的主体",
      platform: "douyin",
      discoveryMethods: ["public_search", "user_import"],
      planStatus: "approved",
      latestRun: {
        id: "run-failed",
        status: "failed",
        updatedAt: "2026-08-07T04:30:00.000Z",
        completedAt: "2026-08-07T04:31:00.000Z",
        evidenceCount: 3,
        consumedBudget: {
          requests: 2,
          results: 3,
          durationSeconds: 22
        }
      },
      updatedAt: "2026-08-07T04:31:00.000Z"
    },
    {
      id: "task-draft",
      planId: "plan-draft",
      name: "厦门教培需求发现",
      objective: "发现公开表达招生需求的主体",
      platform: "douyin",
      discoveryMethods: ["user_import"],
      planStatus: "draft",
      latestRun: null,
      updatedAt: "2026-08-07T04:00:00.000Z"
    }
  ]
});

assert.deepEqual(overview.metrics, [
  { label: "真实任务", value: 3, unit: "项", tone: "normal" },
  { label: "运行中", value: 1, unit: "项", tone: "active" },
  { label: "已完成", value: 1, unit: "项", tone: "success" },
  { label: "需关注", value: 1, unit: "项", tone: "danger" }
]);
assert.equal(overview.tasks[0]?.planId, "plan-running");
assert.equal(overview.tasks[0]?.statusLabel, "正在运行");
assert.equal(overview.tasks[0]?.evidenceCount, 12);
assert.equal(overview.tasks[0]?.tags.join(" / "), "公开搜索");
assert.equal(overview.tasks[1]?.statusTone, "danger");
assert.equal(overview.tasks[2]?.statusLabel, "尚未开始");
assert.equal(runStatusLabel("budget_exhausted"), "预算已用完");
assert.equal(runStatusLabel(null), "尚未开始");

const transitioningOverview = buildAcquisitionOverviewModel({
  generatedAt: "2026-08-07T05:05:00.000Z",
  platform: "douyin",
  totals: { tasks: 2 },
  statusCounts: {
    pause_requested: 1,
    cancel_requested: 1
  },
  discoveryMethodCounts: {
    public_search: 2
  },
  tasks: [
    {
      id: "task-pausing",
      planId: "plan-pausing",
      name: "正在安全暂停的任务",
      objective: "在当前分片安全点停止执行",
      platform: "douyin",
      discoveryMethods: ["public_search"],
      planStatus: "approved",
      latestRun: {
        id: "run-pausing",
        status: "pause_requested",
        updatedAt: "2026-08-07T05:04:00.000Z",
        completedAt: null,
        evidenceCount: 8,
        consumedBudget: {
          requests: 3,
          results: 8,
          durationSeconds: 24
        }
      },
      updatedAt: "2026-08-07T05:04:00.000Z"
    },
    {
      id: "task-cancelling",
      planId: "plan-cancelling",
      name: "正在取消的任务",
      objective: "收敛当前真实运行",
      platform: "douyin",
      discoveryMethods: ["public_search"],
      planStatus: "approved",
      latestRun: {
        id: "run-cancelling",
        status: "cancel_requested",
        updatedAt: "2026-08-07T05:03:00.000Z",
        completedAt: null,
        evidenceCount: 5,
        consumedBudget: {
          requests: 2,
          results: 5,
          durationSeconds: 19
        }
      },
      updatedAt: "2026-08-07T05:03:00.000Z"
    }
  ]
});

assert.deepEqual(transitioningOverview.metrics, [
  { label: "真实任务", value: 2, unit: "项", tone: "normal" },
  { label: "运行中", value: 2, unit: "项", tone: "active" },
  { label: "已完成", value: 0, unit: "项", tone: "success" },
  { label: "需关注", value: 0, unit: "项", tone: "danger" }
]);
assert.equal(transitioningOverview.tasks[0]?.statusLabel, "正在暂停");
assert.equal(transitioningOverview.tasks[0]?.statusTone, "active");
assert.equal(transitioningOverview.tasks[1]?.statusLabel, "正在取消");
assert.equal(transitioningOverview.tasks[1]?.statusTone, "active");

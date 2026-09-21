import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import mysql from "mysql2/promise";
import type { AcquisitionCandidate } from "./acquisition-domain.js";
import type { AcquisitionPlanPayload } from "./acquisition-plan-run-repository.js";
import {
  CfoAcquisitionWorkflowService,
  type CfoAcquisitionWorkflowDependencies
} from "./cfo-acquisition-workflow.js";
import { createMysqlStore } from "./mysql-store.js";
import type { Customer, Todo, User } from "./types.js";

const planPayload: AcquisitionPlanPayload = {
  targetPlatform: "douyin",
  name: "隔离获客验收",
  objective: "在隔离数据中验证获客到 CRM 跟进闭环",
  icp: {
    industries: ["工业除尘"],
    regions: ["中国"],
    organizationCriteria: ["有公开采购需求"],
    individualCriteria: ["公开讨论除尘设备"],
    exclusionRules: ["去除重复主体"]
  },
  subjectChannels: { organization: true, individual: true },
  providerConnections: [{
    connectionId: "search-1",
    providerId: "tavily",
    kind: "search",
    status: "active",
    credentialVersion: 1
  }],
  operations: [{
    operationId: "operation-1",
    subjectChannel: "individual",
    kind: "search",
    connectionId: "search-1",
    query: "工业除尘",
    allocatedBudget: {
      requests: 1,
      results: 10,
      amountMinor: 100,
      durationSeconds: 60
    }
  }],
  budgetSnapshot: {
    billingCurrency: "CNY",
    maxRequests: 1,
    maxResults: 10,
    maxAmountMinor: 100,
    maxDurationSeconds: 60
  },
  modelSnapshotRef: {
    jobSnapshotId: "snapshot-1",
    connectionId: "model-1",
    credentialVersion: 1,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    capabilitySnapshotHash: "capability-1",
    promptVersion: "prompt-1",
    schemaVersion: "schema-1",
    promptHash: "prompt-hash-1",
    schemaHash: "schema-hash-1"
  },
  stopConditions: {
    stopWhenBudgetExhausted: true,
    stopWhenNoMoreResults: true
  }
};

function harness() {
  const calls: string[] = [];
  const jobs: any[] = [];
  const aliases: any[] = [];
  const runs = new Map<string, any>();
  const candidates = new Map<string, AcquisitionCandidate>();
  const links: Array<{ candidateId: string; eventId: string; createdAt: string }> = [];
  const dependencies: CfoAcquisitionWorkflowDependencies = {
    store: {
      users: [{ id: "actor-1", teamId: "team-1", status: "active" }],
      agentJobs: jobs,
      agentJobIdempotencyAliases: aliases,
      async persist() { calls.push("persist"); }
    } as any,
    planDraftGenerator: {
      async generate(input) {
        calls.push(`generate:${input.prompt}`);
        return {
          summary: "已生成草稿",
          planDraft: {
            ...structuredClone(planPayload),
            modelSnapshotRef: undefined,
            modelConnectionId: "model-1"
          } as any,
          assistantMessage: { role: "assistant", content: [] } as any
        };
      }
    },
    async resolveModelSnapshot() {
      calls.push("resolve-model");
      return structuredClone(planPayload.modelSnapshotRef!);
    },
    planService: {
      async createPlan(_scope, payload) {
        calls.push("create-plan");
        return { id: "plan-1", etag: '"plan-1:1"', status: "draft", payload } as any;
      },
      async getPlan() { return { id: "plan-1", etag: '"plan-1:1"', status: "draft" } as any; },
      async approvePlan() {
        calls.push("approve-plan");
        return { id: "plan-1", etag: '"plan-1:2"', status: "approved" } as any;
      },
      async createRun() {
        calls.push("create-run");
        const run = { id: "run-1", etag: '"run-1:1"', status: "queued" };
        runs.set(run.id, run);
        return run as any;
      },
      async getRun(_scope, id) { return runs.get(id); },
      async cancelRun(_scope, id) {
        const run = runs.get(id); run.status = "cancelled";
        calls.push("cancel-run");
        return run;
      }
    },
    planRepository: {
      async listRunCandidateLinks() { return structuredClone(links); }
    },
    domainService: {
      async getCandidate(_scope, id) { return candidates.get(id)!; },
      async reviewCandidate(_scope, id, input) {
        calls.push(`review:${id}:${input.action}`);
        return { id: `review-${id}`, ...input } as any;
      }
    },
    handoffService: {
      async create(_scope, id) {
        calls.push(`handoff:${id}`);
        return {
          replayed: false,
          handoff: { id: `handoff-${id}` },
          lead: { id: `lead-${id}` },
          customer: { id: `customer-${id}` },
          todo: { id: `todo-${id}` },
          intelligence: {}
        } as any;
      }
    },
    now: (() => {
      let tick = 0;
      return () => new Date(Date.UTC(2026, 8, 7, 0, 0, tick++)).toISOString();
    })()
  };
  return {
    service: new CfoAcquisitionWorkflowService(dependencies),
    dependencies,
    calls,
    jobs,
    runs,
    candidates,
    links
  };
}

test("CFO instruction creates one durable reviewable plan and replays by idempotency", async () => {
  const { service, calls, jobs } = harness();
  const scope = { ownerId: "actor-1", teamId: "team-1", actorId: "actor-1" };
  const created = await service.createDraft(scope, {
    instruction: "帮我执行抖音获客",
    idempotencyKey: "cfo-workflow-create-1"
  });
  const replayed = await service.createDraft(scope, {
    instruction: "帮我执行抖音获客",
    idempotencyKey: "cfo-workflow-create-1"
  });

  assert.equal(created.stage, "awaiting_plan_approval");
  assert.equal(created.planId, "plan-1");
  assert.equal(created.planReview?.budget.results, 10);
  assert.equal(created.planReview?.operations[0]?.query, "工业除尘");
  assert.equal(replayed.workflowId, created.workflowId);
  assert.equal(jobs.length, 1);
  assert.equal(calls.filter((item) => item.startsWith("generate:")).length, 1);
  assert.equal(calls.filter((item) => item === "create-plan").length, 1);
});

test("approved workflow resumes through acquisition and writes CRM once per human decision", async () => {
  const fixture = harness();
  const { service, calls, runs, candidates, links } = fixture;
  const scope = { ownerId: "actor-1", teamId: "team-1", actorId: "actor-1" };
  const created = await service.createDraft(scope, {
    instruction: "帮我执行抖音获客并把合格客户放进 CRM",
    idempotencyKey: "cfo-workflow-create-2"
  });
  const running = await service.approveAndRun(scope, created.workflowId, {
    reason: "已人工核对计划、预算和数据来源",
    idempotencyKey: "cfo-workflow-approve-2"
  });
  await service.approveAndRun(scope, created.workflowId, {
    reason: "已人工核对计划、预算和数据来源",
    idempotencyKey: "cfo-workflow-approve-2"
  });

  assert.equal(running.stage, "running_acquisition");
  assert.equal(calls.filter((item) => item === "approve-plan").length, 1);
  assert.equal(calls.filter((item) => item === "create-run").length, 1);

  candidates.set("candidate-1", {
    id: "candidate-1",
    ownerId: "actor-1",
    teamId: "team-1",
    profile: {
      kind: "individual",
      publicDisplayName: "隔离测试客户"
    },
    latestDecisionVersion: "decision-v1"
  } as AcquisitionCandidate);
  links.push({
    candidateId: "candidate-1",
    eventId: "run-event-1",
    createdAt: "2026-09-07T00:00:00.000Z"
  });
  runs.get("run-1").status = "succeeded";
  const reviewable = await service.reconcile(scope, created.workflowId);
  assert.equal(reviewable.stage, "awaiting_candidate_review");
  assert.equal(reviewable.candidates.length, 1);

  const completed = await service.decideCandidate(scope, created.workflowId, {
    candidateId: "candidate-1",
    action: "approved",
    reason: "证据与资格判断已人工核对",
    dueAt: "2026-09-08T00:00:00.000Z",
    idempotencyKey: "cfo-candidate-decision-1"
  });
  const replayed = await service.decideCandidate(scope, created.workflowId, {
    candidateId: "candidate-1",
    action: "approved",
    reason: "证据与资格判断已人工核对",
    dueAt: "2026-09-08T00:00:00.000Z",
    idempotencyKey: "cfo-candidate-decision-1"
  });

  assert.equal(completed.stage, "completed");
  assert.equal(completed.candidates[0]?.customerId, "customer-candidate-1");
  assert.equal(completed.candidates[0]?.todoId, "todo-candidate-1");
  assert.equal(calls.filter((item) => item === "review:candidate-1:approved").length, 1);
  assert.equal(calls.filter((item) => item === "handoff:candidate-1").length, 1);
  assert.deepEqual(replayed, completed);

  const restarted = new CfoAcquisitionWorkflowService(fixture.dependencies);
  assert.deepEqual(await restarted.get(scope, created.workflowId), completed);
});

test("one batch approval sequentially writes every selected candidate to CRM without duplicate replay", async () => {
  const fixture = harness();
  const { service, calls, runs, candidates, links } = fixture;
  const scope = { ownerId: "actor-1", teamId: "team-1", actorId: "actor-1" };
  const created = await service.createDraft(scope, {
    instruction: "批量批准两个抖音获客候选人进入 CRM",
    idempotencyKey: "cfo-workflow-create-batch-1"
  });
  await service.approveAndRun(scope, created.workflowId, {
    reason: "已人工核对计划",
    idempotencyKey: "cfo-workflow-approve-batch-1"
  });
  for (const [candidateId, displayName, eventId] of [
    ["candidate-1", "隔离客户甲", "run-event-1"],
    ["candidate-2", "隔离客户乙", "run-event-2"]
  ] as const) {
    candidates.set(candidateId, {
      id: candidateId,
      ownerId: "actor-1",
      teamId: "team-1",
      profile: { kind: "individual", publicDisplayName: displayName },
      latestDecisionVersion: `decision-${candidateId}`
    } as AcquisitionCandidate);
    links.push({ candidateId, eventId, createdAt: "2026-09-07T00:00:00.000Z" });
  }
  runs.get("run-1").status = "succeeded";
  await service.reconcile(scope, created.workflowId);

  const completed = await service.decideCandidates(scope, created.workflowId, {
    decisions: [
      { candidateId: "candidate-1", action: "approved", reason: "批量人工核对通过", dueAt: "2026-09-08T00:00:00.000Z", priority: "normal" },
      { candidateId: "candidate-2", action: "approved", reason: "批量人工核对通过", dueAt: "2026-09-08T00:00:00.000Z", priority: "normal" }
    ],
    idempotencyKey: "cfo-candidate-batch-decision-1"
  });
  const replayed = await service.decideCandidates(scope, created.workflowId, {
    decisions: [
      { candidateId: "candidate-1", action: "approved", reason: "批量人工核对通过", dueAt: "2026-09-08T00:00:00.000Z", priority: "normal" },
      { candidateId: "candidate-2", action: "approved", reason: "批量人工核对通过", dueAt: "2026-09-08T00:00:00.000Z", priority: "normal" }
    ],
    idempotencyKey: "cfo-candidate-batch-decision-1"
  });

  assert.equal(completed.stage, "completed");
  assert.deepEqual(completed.candidates.map((candidate) => candidate.customerId), [
    "customer-candidate-1",
    "customer-candidate-2"
  ]);
  assert.deepEqual(calls.filter((item) => item.startsWith("review:")), [
    "review:candidate-1:approved",
    "review:candidate-2:approved"
  ]);
  assert.deepEqual(calls.filter((item) => item.startsWith("handoff:")), [
    "handoff:candidate-1",
    "handoff:candidate-2"
  ]);
  assert.deepEqual(replayed, completed);
});

test("workflow ownership is exact and cancellation blocks later CRM writes", async () => {
  const { service, calls, runs } = harness();
  const scope = { ownerId: "actor-1", teamId: "team-1", actorId: "actor-1" };
  const created = await service.createDraft(scope, {
    instruction: "创建一条可取消的隔离获客任务",
    idempotencyKey: "cfo-workflow-create-3"
  });
  await service.approveAndRun(scope, created.workflowId, {
    reason: "人工批准隔离测试",
    idempotencyKey: "cfo-workflow-approve-3"
  });
  runs.get("run-1").etag = '"run-1:1"';
  const cancelled = await service.cancel(scope, created.workflowId, {
    reason: "人工取消"
  });
  assert.equal(cancelled.stage, "cancelled");
  assert.equal(calls.filter((item) => item === "cancel-run").length, 1);
  await assert.rejects(
    service.get({ ownerId: "actor-2", teamId: "team-1", actorId: "actor-2" }, created.workflowId),
    (error: any) => error.code === "cfo_workflow_not_found"
  );
  await assert.rejects(
    service.decideCandidate(scope, created.workflowId, {
      candidateId: "candidate-1",
      action: "approved",
      reason: "不应执行",
      idempotencyKey: "cfo-cancelled-decision-1"
    }),
    (error: any) => error.code === "cfo_workflow_cancelled"
  );
  assert.equal(calls.filter((item) => item.startsWith("review:")).length, 0);
  assert.equal(calls.filter((item) => item.startsWith("handoff:")).length, 0);
});

test("CFO batch approvals and CRM follow-ups survive a real MySQL restart without duplicate writes", {
  skip: !process.env.MYSQL_TEST_ADMIN_URL
    ? "MYSQL_TEST_ADMIN_URL is required; no database is provisioned implicitly"
    : false
}, async () => {
  const adminUrl = new URL(process.env.MYSQL_TEST_ADMIN_URL!);
  const databaseName = `gj_cfo_${randomUUID().replaceAll("-", "")}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousMysqlUrl = process.env.MYSQL_URL;
  const admin = await mysql.createConnection(adminUrl.toString());
  let primaryStore: Awaited<ReturnType<typeof createMysqlStore>> | null = null;
  let restartedStore: Awaited<ReturnType<typeof createMysqlStore>> | null = null;
  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    process.env.DATABASE_URL = databaseUrl.toString();
    delete process.env.MYSQL_URL;
    primaryStore = await createMysqlStore();
    primaryStore.users.push({
      id: "actor-1",
      name: "CFO MySQL Tester",
      email: "cfo-mysql@example.test",
      password: "not-used-in-this-test",
      role: "admin",
      teamId: "team-1",
      avatar: "",
      status: "active"
    } satisfies User);
    await primaryStore.persist();

    const fixture = harness();
    fixture.dependencies.store = primaryStore;
    fixture.dependencies.handoffService = {
      async create(_scope, candidateId) {
        const customer: Customer = {
          id: `customer-${candidateId}`,
          company: "隔离测试客户",
          country: "中国",
          contact: "隔离联系人",
          ownerId: "actor-1",
          teamId: "team-1",
          stage: "待首次跟进",
          amount: 0,
          health: 80,
          nextReminder: "2026-09-08T00:00:00.000Z",
          wecomBound: false,
          billingName: "",
          billingAddress: "",
          documentContact: "隔离联系人",
          defaultPortDischarge: "",
          defaultIncoterm: "",
          defaultPaymentTerm: ""
        };
        const todo: Todo = {
          id: `todo-${candidateId}`,
          title: "跟进隔离测试客户",
          type: "customer",
          priority: "normal",
          status: "pending",
          dueAt: "2026-09-08T00:00:00.000Z",
          ownerId: "actor-1",
          teamId: "team-1",
          related: customer.company,
          done: false,
          customerId: customer.id,
          createdAt: "2026-09-07T00:00:00.000Z"
        };
        primaryStore!.customers.push(customer);
        primaryStore!.todos.push(todo);
        await primaryStore!.persist();
        return {
          replayed: false,
          handoff: { id: `handoff-${candidateId}` },
          lead: { id: `lead-${candidateId}` },
          customer,
          todo,
          intelligence: {}
        } as any;
      }
    };
    const service = new CfoAcquisitionWorkflowService(fixture.dependencies);
    const scope = { ownerId: "actor-1", teamId: "team-1", actorId: "actor-1" };
    const created = await service.createDraft(scope, {
      instruction: "隔离验证经营总管获客到 CRM 跟进",
      idempotencyKey: "cfo-mysql-create-1"
    });
    await service.approveAndRun(scope, created.workflowId, {
      reason: "人工批准隔离数据库测试",
      idempotencyKey: "cfo-mysql-approve-1"
    });
    for (const [candidateId, displayName, eventId] of [
      ["candidate-1", "隔离测试客户甲", "run-event-1"],
      ["candidate-2", "隔离测试客户乙", "run-event-2"]
    ] as const) {
      fixture.candidates.set(candidateId, {
        id: candidateId,
        ownerId: "actor-1",
        teamId: "team-1",
        profile: { kind: "individual", publicDisplayName: displayName },
        latestDecisionVersion: `decision-${candidateId}`
      } as AcquisitionCandidate);
      fixture.links.push({
        candidateId,
        eventId,
        createdAt: "2026-09-07T00:00:00.000Z"
      });
    }
    fixture.runs.get("run-1").status = "succeeded";
    await service.reconcile(scope, created.workflowId);
    const completed = await service.decideCandidates(scope, created.workflowId, {
      decisions: ["candidate-1", "candidate-2"].map((candidateId) => ({
        candidateId,
        action: "approved" as const,
        reason: "人工批量核对通过",
        dueAt: "2026-09-08T00:00:00.000Z",
        priority: "normal" as const
      })),
      idempotencyKey: "cfo-mysql-batch-decision-1"
    });
    assert.equal(completed.stage, "completed");
    assert.deepEqual(completed.candidates.map((candidate) => candidate.customerId), [
      "customer-candidate-1",
      "customer-candidate-2"
    ]);
    await primaryStore.close?.();
    primaryStore = null;

    restartedStore = await createMysqlStore();
    const restartedFixture = harness();
    restartedFixture.dependencies.store = restartedStore;
    restartedFixture.dependencies.handoffService = {
      async create() { throw new Error("completed workflow must not repeat CRM handoff"); }
    };
    const restartedService = new CfoAcquisitionWorkflowService(
      restartedFixture.dependencies
    );
    const restored = await restartedService.get(scope, created.workflowId);
    assert.equal(restored.stage, "completed");
    assert.deepEqual(restored.candidates.map((candidate) => candidate.customerId), [
      "customer-candidate-1",
      "customer-candidate-2"
    ]);
    assert.deepEqual(restored.candidates.map((candidate) => candidate.todoId), [
      "todo-candidate-1",
      "todo-candidate-2"
    ]);
    for (const candidateId of ["candidate-1", "candidate-2"]) {
      assert.equal(restartedStore.customers.filter((item) =>
        item.id === `customer-${candidateId}`).length, 1);
      assert.equal(restartedStore.todos.filter((item) =>
        item.id === `todo-${candidateId}`).length, 1);
    }
    assert.deepEqual(
      await restartedService.decideCandidates(scope, created.workflowId, {
        decisions: ["candidate-1", "candidate-2"].map((candidateId) => ({
          candidateId,
          action: "approved" as const,
          reason: "重复批量回调"
        })),
        idempotencyKey: "cfo-mysql-batch-decision-replay"
      }),
      restored
    );
  } finally {
    await primaryStore?.close?.();
    await restartedStore?.close?.();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousMysqlUrl === undefined) delete process.env.MYSQL_URL;
    else process.env.MYSQL_URL = previousMysqlUrl;
    await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    await admin.end();
  }
});

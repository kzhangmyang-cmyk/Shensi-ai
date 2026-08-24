import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultDouyinAutomationPolicyInput,
  normalizeDouyinAutomationPolicyInput,
  type DouyinAutomationPolicyInput
} from "./acquisition-douyin-automation.js";
import {
  InMemoryAcquisitionDouyinAutomationRepository
} from "./acquisition-douyin-automation-repository.js";
import {
  AcquisitionDouyinAutomationError,
  AcquisitionDouyinAutomationService
} from "./acquisition-douyin-automation-service.js";
import {
  InMemoryAcquisitionPlanRunRepository,
  type AcquisitionPlan,
  type AcquisitionPlanPayload,
  type AcquisitionPlanVersion
} from "./acquisition-plan-run-repository.js";
import {
  InMemoryAcquisitionSocialAccountRepository,
  type AcquisitionSocialAccountRepository
} from "./acquisition-social-account-repository.js";

const NOW = "2026-08-25T01:00:00.000Z";
const SCOPE = Object.freeze({
  workspaceId: "workspace-a",
  ownerId: "owner-a",
  teamId: "team-a",
  actorId: "owner-a"
});

const POLICY: DouyinAutomationPolicyInput = {
  keywords: ["工业除尘设备", "工厂环保改造"],
  schedule: {
    enabled: true,
    localTime: "09:30",
    timeZone: "Asia/Shanghai"
  },
  dailyCandidateLimit: 50,
  collectCreators: true,
  collectDemandComments: true,
  limits: {
    maxVideos: 30,
    maxCommentsPerVideo: 50,
    maxPagesPerVideo: 3,
    maxDurationSeconds: 3_600
  }
};

function planPayload(): AcquisitionPlanPayload {
  return {
    targetPlatform: "douyin",
    name: "抖音工业获客",
    objective: "寻找工业环保设备采购需求",
    icp: {
      industries: ["工业环保"],
      regions: ["中国"],
      organizationCriteria: ["有明确改造项目"],
      individualCriteria: ["公开表达采购需求"],
      exclusionRules: []
    },
    subjectChannels: { organization: true, individual: true },
    providerConnections: [],
    operations: [],
    budgetSnapshot: {
      billingCurrency: "CNY",
      maxRequests: 100,
      maxResults: 1_000,
      maxAmountMinor: 100_000,
      maxDurationSeconds: 3_600
    },
    modelSnapshotRef: {
      jobSnapshotId: "job-1",
      connectionId: "connection-1",
      credentialVersion: 1,
      provider: "qwen",
      model: "qwen-plus",
      capabilitySnapshotHash: "sha256:capability",
      promptVersion: "prompt-v1",
      schemaVersion: "schema-v1",
      promptHash: "sha256:prompt",
      schemaHash: "sha256:schema"
    },
    stopConditions: {
      stopWhenBudgetExhausted: true,
      stopWhenNoMoreResults: true
    }
  };
}

async function seedPlan(
  repository: InMemoryAcquisitionPlanRunRepository,
  payload = planPayload()
) {
  const version: AcquisitionPlanVersion = {
    id: "plan-version-1",
    planId: "plan-1",
    ownerId: SCOPE.ownerId,
    teamId: SCOPE.teamId,
    version: 1,
    payload,
    payloadHash: "plan-snapshot-hash-1",
    createdBy: SCOPE.actorId,
    createdAt: NOW
  };
  const plan: AcquisitionPlan = {
    id: version.planId,
    ownerId: SCOPE.ownerId,
    teamId: SCOPE.teamId,
    status: "approved",
    version: 1,
    revision: 2,
    etag: '"plan-1:2"',
    currentVersionId: version.id,
    approvedVersionId: version.id,
    approvedSnapshotHash: version.payloadHash,
    approvedBy: SCOPE.actorId,
    approvedAt: NOW,
    budgetSnapshot: payload.budgetSnapshot,
    payload,
    createdBy: SCOPE.actorId,
    createdAt: NOW,
    updatedBy: SCOPE.actorId,
    updatedAt: NOW
  };
  await repository.transaction((transaction) => {
    transaction.putPlan(plan);
    transaction.appendPlanVersion(version);
  });
}

async function seedAccount(repository: InMemoryAcquisitionSocialAccountRepository) {
  await repository.upsert({
    id: "account-1",
    workspaceId: SCOPE.workspaceId,
    platform: "douyin",
    accountHandle: "private-account-handle",
    upstreamSessionId: "upstream-session-1",
    displayName: "企业抖音号",
    state: "active",
    loginStateVersion: 7,
    revision: 1,
    etag: '"account-v1"',
    lastValidatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  });
}

async function fixture(options: {
  seedActiveAccount?: boolean;
  accounts?: Pick<AcquisitionSocialAccountRepository, "findByWorkspaceAndPlatform">;
  resolvedWorkspaceId?: string;
  payload?: AcquisitionPlanPayload;
} = {}) {
  const plans = new InMemoryAcquisitionPlanRunRepository();
  await seedPlan(plans, options.payload);
  const accountRepository = new InMemoryAcquisitionSocialAccountRepository();
  if (options.seedActiveAccount !== false) await seedAccount(accountRepository);
  let sequence = 0;
  const repository = new InMemoryAcquisitionDouyinAutomationRepository();
  const service = new AcquisitionDouyinAutomationService({
    repository,
    plans,
    accounts: options.accounts ?? accountRepository,
    resolvePlanWorkspace: async () => ({
      workspaceId: options.resolvedWorkspaceId ?? SCOPE.workspaceId
    }),
    idFactory: (prefix) => `${prefix}-${++sequence}`,
    now: () => NOW
  });
  return { service, repository, plans, accountRepository };
}

function rejectsCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof AcquisitionDouyinAutomationError);
    assert.equal(error.code, code);
    return true;
  };
}

test("automation input applies the server-owned daily candidate default", () => {
  const normalized = normalizeDouyinAutomationPolicyInput({
    ...POLICY,
    dailyCandidateLimit: undefined
  });
  assert.equal(normalized.dailyCandidateLimit, 50);
  assert.equal(defaultDouyinAutomationPolicyInput().dailyCandidateLimit, 50);
});

test("automation input rejects daily limits outside 1 through 200", () => {
  for (const dailyCandidateLimit of [0, 201]) {
    assert.throws(
      () => normalizeDouyinAutomationPolicyInput({
        ...POLICY,
        dailyCandidateLimit
      }),
      /invalid_daily_candidate_limit/u
    );
  }
});

test("automation input rejects duplicate, empty, and overlong keywords", () => {
  for (const keywords of [
    ["工业除尘", " 工业除尘 "],
    ["工业除尘", ""],
    ["工".repeat(101)]
  ]) {
    assert.throws(
      () => normalizeDouyinAutomationPolicyInput({ ...POLICY, keywords }),
      /invalid_automation_keywords/u
    );
  }
});

test("automation input rejects invalid local time and IANA timezone", () => {
  assert.throws(
    () => normalizeDouyinAutomationPolicyInput({
      ...POLICY,
      schedule: { ...POLICY.schedule, localTime: "24:00" }
    }),
    /invalid_automation_local_time/u
  );
  assert.throws(
    () => normalizeDouyinAutomationPolicyInput({
      ...POLICY,
      schedule: { ...POLICY.schedule, timeZone: "Mars/Olympus" }
    }),
    /invalid_automation_time_zone/u
  );
});

test("automation input cannot disable every collection source", () => {
  assert.throws(
    () => normalizeDouyinAutomationPolicyInput({
      ...POLICY,
      collectCreators: false,
      collectDemandComments: false
    }),
    /automation_collection_required/u
  );
});

test("GET returns a non-persisted server default only before the first version", async () => {
  const { service, repository } = await fixture();
  const first = await service.get(SCOPE, "plan-1");

  assert.equal(first.source, "default");
  assert.equal(first.id, null);
  assert.equal(first.dailyCandidateLimit, 50);
  assert.equal((await repository.listVersions(SCOPE.workspaceId, "plan-1")).length, 0);

  const saved = await service.put(
    SCOPE,
    "plan-1",
    first.etag,
    "policy-create-1",
    POLICY
  );
  const current = await service.get(SCOPE, "plan-1");
  assert.deepEqual(current, saved.value);
});

test("GET default de-duplicates plan-derived keywords case-insensitively", async () => {
  const payload = planPayload();
  payload.icp.industries = ["Industrial", " industrial "];
  payload.objective = "INDUSTRIAL";
  const { service } = await fixture({ payload });
  const value = await service.get(SCOPE, "plan-1");
  assert.deepEqual(value.keywords, ["Industrial"]);
});

test("policy creation rejects missing, inactive, or cross-workspace active accounts", async () => {
  const missing = await fixture({ seedActiveAccount: false });
  const missingDefault = await missing.service.get(SCOPE, "plan-1");
  await assert.rejects(
    missing.service.put(
      SCOPE,
      "plan-1",
      missingDefault.etag,
      "missing-account-1",
      POLICY
    ),
    rejectsCode("active_douyin_account_required")
  );

  const inactive = await fixture({
    accounts: {
      async findByWorkspaceAndPlatform() {
        return {
          id: "account-inactive",
          workspaceId: SCOPE.workspaceId,
          platform: "douyin",
          accountHandle: null,
          displayName: "Expired",
          state: "login_expired",
          loginStateVersion: 7,
          revision: 2,
          etag: '"account-v2"',
          lastValidatedAt: NOW,
          createdAt: NOW,
          updatedAt: NOW
        };
      }
    }
  });
  const inactiveDefault = await inactive.service.get(SCOPE, "plan-1");
  await assert.rejects(
    inactive.service.put(
      SCOPE,
      "plan-1",
      inactiveDefault.etag,
      "inactive-account-1",
      POLICY
    ),
    rejectsCode("active_douyin_account_required")
  );

  const crossWorkspaceRecord = {
    id: "account-other",
    workspaceId: "workspace-other",
    platform: "douyin" as const,
    accountHandle: "private-other-handle",
    displayName: "Other",
    state: "active" as const,
    loginStateVersion: 1,
    revision: 1,
    etag: '"account-v1"',
    lastValidatedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW
  };
  const cross = await fixture({
    accounts: {
      async findByWorkspaceAndPlatform() {
        return crossWorkspaceRecord;
      }
    }
  });
  const crossDefault = await cross.service.get(SCOPE, "plan-1");
  await assert.rejects(
    cross.service.put(
      SCOPE,
      "plan-1",
      crossDefault.etag,
      "cross-account-1",
      POLICY
    ),
    rejectsCode("active_douyin_account_workspace_mismatch")
  );
});

test("plan and active workspace binding hides cross-workspace plans", async () => {
  const { service } = await fixture({ resolvedWorkspaceId: "workspace-other" });
  await assert.rejects(
    service.get(SCOPE, "plan-1"),
    rejectsCode("automation_plan_not_found")
  );
});

test("policy idempotency replays exactly and rejects a changed request", async () => {
  const { service } = await fixture();
  const initial = await service.get(SCOPE, "plan-1");
  const first = await service.put(
    SCOPE,
    "plan-1",
    initial.etag,
    "policy-replay-1",
    POLICY
  );
  const replay = await service.put(
    SCOPE,
    "plan-1",
    initial.etag,
    "policy-replay-1",
    POLICY
  );
  assert.deepEqual(replay.value, first.value);
  assert.equal(replay.replayed, true);

  await assert.rejects(
    service.put(
      SCOPE,
      "plan-1",
      initial.etag,
      "policy-replay-1",
      { ...POLICY, dailyCandidateLimit: 51 }
    ),
    rejectsCode("automation_idempotency_conflict")
  );
});

test("two writers using one If-Match produce one immutable winner", async () => {
  const { service, repository } = await fixture();
  const initial = await service.get(SCOPE, "plan-1");
  const attempts = await Promise.allSettled([
    service.put(SCOPE, "plan-1", initial.etag, "writer-one-1", POLICY),
    service.put(SCOPE, "plan-1", initial.etag, "writer-two-1", {
      ...POLICY,
      dailyCandidateLimit: 75
    })
  ]);

  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = attempts.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.ok(rejected.reason instanceof AcquisitionDouyinAutomationError);
  assert.equal(rejected.reason.code, "automation_precondition_failed");
  const versions = await repository.listVersions(SCOPE.workspaceId, "plan-1");
  assert.equal(versions.length, 1);
  assert.equal(versions[0]?.version, 1);
});

test("every PUT appends a version and never mutates its predecessor", async () => {
  const { service, repository } = await fixture();
  const initial = await service.get(SCOPE, "plan-1");
  const first = await service.put(
    SCOPE,
    "plan-1",
    initial.etag,
    "policy-version-1",
    POLICY
  );
  await service.put(
    SCOPE,
    "plan-1",
    first.value.etag,
    "policy-version-2",
    { ...POLICY, dailyCandidateLimit: 75 }
  );

  const versions = await repository.listVersions(SCOPE.workspaceId, "plan-1");
  assert.equal(versions.length, 2);
  assert.equal(versions[0]?.dailyCandidateLimit, 50);
  assert.equal(versions[1]?.dailyCandidateLimit, 75);
  assert.equal(versions[0]?.id, first.value.id);
});

test("run-now freezes plan, policy, account, login and shared daily budget identities", async () => {
  const { service } = await fixture();
  const initial = await service.get(SCOPE, "plan-1");
  const saved = await service.put(
    SCOPE,
    "plan-1",
    initial.etag,
    "policy-for-run-1",
    POLICY
  );

  const first = await service.runNow(
    SCOPE,
    "plan-1",
    "run-now-replay-1",
    { reason: "人工立即采集" }
  );
  assert.equal(first.value.status, "queued");
  assert.equal(first.value.planVersionId, "plan-version-1");
  assert.equal(first.value.planSnapshotHash, "plan-snapshot-hash-1");
  assert.equal(first.value.policyVersionId, saved.value.id);
  assert.equal(first.value.policyHash, saved.value.policyHash);
  assert.equal(first.value.accountId, "account-1");
  assert.equal(first.value.accountLoginStateVersion, 7);
  assert.equal(first.value.localDate, "2026-08-25");
  assert.match(first.value.dailyBudgetId, /^sha256:[a-f0-9]{64}$/u);

  const replay = await service.runNow(
    SCOPE,
    "plan-1",
    "run-now-replay-1",
    { reason: "人工立即采集" }
  );
  assert.deepEqual(replay.value, first.value);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    service.runNow(
      SCOPE,
      "plan-1",
      "run-now-replay-1",
      { reason: "变更后的请求" }
    ),
    rejectsCode("automation_idempotency_conflict")
  );
});

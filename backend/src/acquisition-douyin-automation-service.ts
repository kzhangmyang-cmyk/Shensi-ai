import type {
  DouyinAutomationPolicyInput,
  DouyinAutomationPolicyResource,
  DouyinAutomationPolicyVersion,
  DouyinAutomationRunIntent,
  DouyinAutomationRunNowInput,
  NormalizedDouyinAutomationPolicyInput
} from "./acquisition-douyin-automation.js";
import {
  defaultDouyinAutomationPolicyInput,
  douyinAutomationDefaultEtag,
  douyinAutomationHash,
  douyinAutomationVersionEtag,
  localDateInTimeZone,
  normalizeDouyinAutomationPolicyInput
} from "./acquisition-douyin-automation.js";
import type {
  AcquisitionDouyinAutomationRepository,
  DouyinAutomationReplayLookup
} from "./acquisition-douyin-automation-repository.js";
import type {
  AcquisitionPlan,
  AcquisitionPlanRunRepository,
  AcquisitionPlanVersion
} from "./acquisition-plan-run-repository.js";
import { acquisitionFrozenPlanVersionIdentity } from "./acquisition-plan-run-repository.js";
import type {
  AcquisitionSocialAccountPrivateRecord,
  AcquisitionSocialAccountRepository
} from "./acquisition-social-account-repository.js";

export interface AcquisitionDouyinAutomationScope {
  workspaceId: string;
  ownerId: string;
  teamId: string;
  actorId: string;
}

interface PlanWorkspaceBinding {
  workspaceId: string;
}

export interface AcquisitionDouyinAutomationServiceOptions {
  repository: AcquisitionDouyinAutomationRepository;
  plans: Pick<
    AcquisitionPlanRunRepository,
    "getPlan" | "getPlanVersion"
  >;
  accounts: Pick<
    AcquisitionSocialAccountRepository,
    "findByWorkspaceAndPlatform"
  >;
  resolvePlanWorkspace: (
    scope: Readonly<{ ownerId: string; teamId: string }>
  ) => Promise<PlanWorkspaceBinding | null>;
  idFactory?: (prefix: string) => string;
  now?: () => string;
  onRunIntent?: (
    run: DouyinAutomationRunIntent,
    policy: DouyinAutomationPolicyVersion
  ) => Promise<void>;
}

export class AcquisitionDouyinAutomationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: Record<string, unknown> | null = null
  ) {
    super(code);
    this.name = "AcquisitionDouyinAutomationError";
  }
}

function fail(status: number, code: string): never {
  throw new AcquisitionDouyinAutomationError(status, code);
}

function assertScope(scope: AcquisitionDouyinAutomationScope) {
  if (!scope.workspaceId?.trim()
    || !scope.ownerId?.trim()
    || !scope.teamId?.trim()
    || !scope.actorId?.trim()) {
    fail(400, "invalid_automation_scope");
  }
}

function normalizedIdempotencyKey(value: string) {
  const key = value?.trim();
  if (!key || key.length < 8 || key.length > 200) {
    fail(400, "invalid_idempotency_key");
  }
  return key;
}

function normalizedIfMatch(value: string) {
  const etag = value?.trim();
  if (!etag) fail(428, "if_match_required");
  if (etag.length > 255) fail(400, "invalid_if_match");
  return etag;
}

function normalizedReason(input: DouyinAutomationRunNowInput) {
  if (!input || typeof input !== "object") {
    fail(400, "invalid_run_now_input");
  }
  if (input.reason === undefined) return null;
  if (typeof input.reason !== "string") {
    fail(400, "invalid_run_now_input");
  }
  const reason = input.reason.trim();
  if (reason.length > 2_000) fail(400, "invalid_run_now_input");
  return reason || null;
}

function defaultKeywords(plan: AcquisitionPlan) {
  const candidates = [
    ...plan.payload.icp.industries,
    plan.payload.objective
  ].map((value) => value.trim())
    .filter(Boolean)
    .map((value) => [...value].slice(0, 100).join(""));
  const identities = new Set<string>();
  const keywords = candidates.filter((value) => {
    const identity = value.toLocaleLowerCase("en-US");
    if (identities.has(identity)) return false;
    identities.add(identity);
    return true;
  }).slice(0, 20);
  return keywords.length > 0 ? keywords : ["公开采购需求"];
}

function assertAccount(
  scope: AcquisitionDouyinAutomationScope,
  account: AcquisitionSocialAccountPrivateRecord | null
) {
  if (!account) fail(409, "active_douyin_account_required");
  if (account.workspaceId !== scope.workspaceId) {
    fail(404, "active_douyin_account_workspace_mismatch");
  }
  if (account.platform !== "douyin"
    || account.state !== "active"
    || !account.accountHandle
    || !Number.isSafeInteger(account.loginStateVersion)
    || Number(account.loginStateVersion) < 1) {
    fail(409, "active_douyin_account_required");
  }
  return account as AcquisitionSocialAccountPrivateRecord & {
    accountHandle: string;
    loginStateVersion: number;
  };
}

function policyAuthorityHash(input: {
  policy: NormalizedDouyinAutomationPolicyInput;
  workspaceId: string;
  planVersionId: string;
  planSnapshotHash: string;
  accountId: string | null;
  accountLoginStateVersion: number | null;
}) {
  return douyinAutomationHash(input);
}

export class AcquisitionDouyinAutomationService {
  private readonly repository: AcquisitionDouyinAutomationRepository;
  private readonly plans: AcquisitionDouyinAutomationServiceOptions["plans"];
  private readonly accounts: AcquisitionDouyinAutomationServiceOptions["accounts"];
  private readonly resolvePlanWorkspace: AcquisitionDouyinAutomationServiceOptions["resolvePlanWorkspace"];
  private readonly idFactory: (prefix: string) => string;
  private readonly now: () => string;
  private readonly onRunIntent: AcquisitionDouyinAutomationServiceOptions["onRunIntent"];

  constructor(options: AcquisitionDouyinAutomationServiceOptions) {
    this.repository = options.repository;
    this.plans = options.plans;
    this.accounts = options.accounts;
    this.resolvePlanWorkspace = options.resolvePlanWorkspace;
    this.idFactory = options.idFactory
      ?? ((prefix) => `${prefix}_${crypto.randomUUID()}`);
    this.now = options.now ?? (() => new Date().toISOString());
    this.onRunIntent = options.onRunIntent;
  }

  private async visiblePlan(
    scope: AcquisitionDouyinAutomationScope,
    planId: string
  ) {
    assertScope(scope);
    const plan = await this.plans.getPlan(planId);
    if (!plan
      || plan.ownerId !== scope.ownerId
      || plan.teamId !== scope.teamId) {
      fail(404, "automation_plan_not_found");
    }
    const binding = await this.resolvePlanWorkspace({
      ownerId: scope.ownerId,
      teamId: scope.teamId
    });
    if (!binding || binding.workspaceId !== scope.workspaceId) {
      fail(404, "automation_plan_not_found");
    }
    const version = await this.plans.getPlanVersion(plan.currentVersionId);
    if (!version
      || version.planId !== plan.id
      || version.ownerId !== scope.ownerId
      || version.teamId !== scope.teamId
      || version.version !== plan.version) {
      fail(409, "automation_plan_snapshot_corrupt");
    }
    try {
      acquisitionFrozenPlanVersionIdentity(plan, version);
    } catch {
      fail(409, "automation_plan_snapshot_corrupt");
    }
    return { plan, version };
  }

  private defaultResource(
    scope: AcquisitionDouyinAutomationScope,
    plan: AcquisitionPlan,
    version: AcquisitionPlanVersion
  ): DouyinAutomationPolicyResource {
    const policy = defaultDouyinAutomationPolicyInput(defaultKeywords(plan));
    return Object.freeze({
      id: null,
      source: "default",
      workspaceId: scope.workspaceId,
      planId: plan.id,
      planVersionId: version.id,
      planVersion: version.version,
      planSnapshotHash: version.payloadHash,
      accountId: null,
      accountLoginStateVersion: null,
      version: 0,
      revision: 0,
      etag: douyinAutomationDefaultEtag(plan.id, version.id),
      policyHash: policyAuthorityHash({
        policy,
        workspaceId: scope.workspaceId,
        planVersionId: version.id,
        planSnapshotHash: version.payloadHash,
        accountId: null,
        accountLoginStateVersion: null
      }),
      ...policy,
      createdBy: null,
      createdAt: null
    });
  }

  async get(scope: AcquisitionDouyinAutomationScope, planId: string) {
    const { plan, version } = await this.visiblePlan(scope, planId);
    const current = await this.repository.getCurrent(scope.workspaceId, plan.id);
    if (!current) return this.defaultResource(scope, plan, version);
    if (current.workspaceId !== scope.workspaceId || current.planId !== plan.id) {
      fail(409, "automation_policy_binding_corrupt");
    }
    return current;
  }

  private replayResult(
    replay: DouyinAutomationReplayLookup,
    expected: "policy"
  ): DouyinAutomationPolicyVersion | null;
  private replayResult(
    replay: DouyinAutomationReplayLookup,
    expected: "run"
  ): DouyinAutomationRunIntent | null;
  private replayResult(
    replay: DouyinAutomationReplayLookup,
    expected: "policy" | "run"
  ): DouyinAutomationPolicyVersion | DouyinAutomationRunIntent | null {
    if (replay.kind === "conflict") {
      fail(409, "automation_idempotency_conflict");
    }
    if (replay.kind === "none") return null;
    if (replay.kind !== expected) {
      fail(409, "automation_idempotency_record_corrupt");
    }
    return replay.value;
  }

  async put(
    scope: AcquisitionDouyinAutomationScope,
    planId: string,
    ifMatch: string,
    idempotencyKey: string,
    input: DouyinAutomationPolicyInput
  ) {
    const expectedEtag = normalizedIfMatch(ifMatch);
    const key = normalizedIdempotencyKey(idempotencyKey);
    let policy: NormalizedDouyinAutomationPolicyInput;
    try {
      policy = normalizeDouyinAutomationPolicyInput(input);
    } catch (error) {
      const code = error instanceof Error
        ? error.message
        : "invalid_automation_policy";
      throw new AcquisitionDouyinAutomationError(400, code);
    }
    const { plan, version: planVersion } = await this.visiblePlan(scope, planId);
    const requestHash = douyinAutomationHash({
      planId: plan.id,
      expectedEtag,
      policy
    });
    const replay = this.replayResult(
      await this.repository.findCommandReplay(
        scope.workspaceId,
        plan.id,
        "put_policy",
        key,
        requestHash
      ),
      "policy"
    );
    if (replay) return { value: replay, replayed: true };

    const account = assertAccount(
      scope,
      await this.accounts.findByWorkspaceAndPlatform(
        scope.workspaceId,
        "douyin"
      )
    );
    const current = await this.repository.getCurrent(
      scope.workspaceId,
      plan.id
    );
    const revision = (current?.revision ?? 0) + 1;
    const createdAt = this.now();
    const value: DouyinAutomationPolicyVersion = Object.freeze({
      id: this.idFactory("douyin-policy"),
      source: "version",
      workspaceId: scope.workspaceId,
      planId: plan.id,
      planVersionId: planVersion.id,
      planVersion: planVersion.version,
      planSnapshotHash: planVersion.payloadHash,
      accountId: account.id,
      accountLoginStateVersion: account.loginStateVersion,
      version: revision,
      revision,
      etag: douyinAutomationVersionEtag(plan.id, revision),
      policyHash: policyAuthorityHash({
        policy,
        workspaceId: scope.workspaceId,
        planVersionId: planVersion.id,
        planSnapshotHash: planVersion.payloadHash,
        accountId: account.id,
        accountLoginStateVersion: account.loginStateVersion
      }),
      ...policy,
      createdBy: scope.actorId,
      createdAt
    });
    const result = await this.repository.savePolicy({
      workspaceId: scope.workspaceId,
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      planId: plan.id,
      planVersionId: planVersion.id,
      accountId: account.id,
      accountLoginStateVersion: account.loginStateVersion,
      expectedEtag,
      defaultEtag: douyinAutomationDefaultEtag(plan.id, planVersion.id),
      idempotencyKey: key,
      requestHash,
      value
    });
    if (result.kind === "conflict") {
      fail(409, "automation_idempotency_conflict");
    }
    if (result.kind === "precondition_failed") {
      fail(412, "automation_precondition_failed");
    }
    if (result.kind === "binding_mismatch") {
      fail(409, "automation_policy_binding_conflict");
    }
    return { value: result.value, replayed: result.kind === "replay" };
  }

  async runNow(
    scope: AcquisitionDouyinAutomationScope,
    planId: string,
    idempotencyKey: string,
    input: DouyinAutomationRunNowInput
  ) {
    const key = normalizedIdempotencyKey(idempotencyKey);
    const reason = normalizedReason(input);
    const { plan, version: planVersion } = await this.visiblePlan(scope, planId);
    const requestHash = douyinAutomationHash({
      planId: plan.id,
      reason
    });
    const replay = this.replayResult(
      await this.repository.findCommandReplay(
        scope.workspaceId,
        plan.id,
        "run_now",
        key,
        requestHash
      ),
      "run"
    );
    if (replay) {
      const replayPolicy = await this.repository.getCurrent(
        scope.workspaceId,
        plan.id
      );
      if (replayPolicy) await this.onRunIntent?.(replay, replayPolicy);
      return { value: replay, replayed: true };
    }
    if (plan.status !== "approved"
      || plan.approvedVersionId !== planVersion.id
      || plan.approvedSnapshotHash !== planVersion.payloadHash) {
      fail(409, "approved_automation_plan_required");
    }
    const policy = await this.repository.getCurrent(scope.workspaceId, plan.id);
    if (!policy) fail(409, "automation_policy_required");
    if (policy.planVersionId !== planVersion.id
      || policy.planSnapshotHash !== planVersion.payloadHash) {
      fail(409, "automation_policy_plan_version_mismatch");
    }
    const account = assertAccount(
      scope,
      await this.accounts.findByWorkspaceAndPlatform(
        scope.workspaceId,
        "douyin"
      )
    );
    if (policy.accountId !== account.id
      || policy.accountLoginStateVersion !== account.loginStateVersion) {
      fail(409, "automation_account_login_state_changed");
    }
    const createdAt = this.now();
    const localDate = localDateInTimeZone(
      createdAt,
      policy.schedule.timeZone
    );
    const value: DouyinAutomationRunIntent = Object.freeze({
      id: this.idFactory("douyin-run"),
      workspaceId: scope.workspaceId,
      planId: plan.id,
      planVersionId: planVersion.id,
      planVersion: planVersion.version,
      planSnapshotHash: planVersion.payloadHash,
      policyVersionId: policy.id,
      policyHash: policy.policyHash,
      accountId: account.id,
      accountLoginStateVersion: account.loginStateVersion,
      dailyBudgetId: douyinAutomationHash({
        workspaceId: scope.workspaceId,
        planId: plan.id,
        policyVersionId: policy.id,
        localDate
      }),
      localDate,
      trigger: "run_now",
      collectCreators: policy.collectCreators,
      collectDemandComments: policy.collectDemandComments,
      status: "queued",
      reason,
      createdBy: scope.actorId,
      createdAt
    });
    const result = await this.repository.createRunIntent({
      workspaceId: scope.workspaceId,
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      planId: plan.id,
      planVersionId: planVersion.id,
      policyVersionId: policy.id,
      accountId: account.id,
      accountLoginStateVersion: account.loginStateVersion,
      idempotencyKey: key,
      requestHash,
      value
    });
    if (result.kind === "conflict") {
      fail(409, "automation_idempotency_conflict");
    }
    if (result.kind === "binding_mismatch") {
      fail(409, "automation_run_binding_conflict");
    }
    await this.onRunIntent?.(result.value, policy);
    return { value: result.value, replayed: result.kind === "replay" };
  }
}

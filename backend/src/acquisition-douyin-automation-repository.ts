import { createHash } from "node:crypto";
import type {
  DouyinAutomationPolicyVersion,
  DouyinAutomationRunIntent
} from "./acquisition-douyin-automation.js";
import type {
  AcquisitionDouyinCollectionRunBinding,
  AcquisitionPlan,
  AcquisitionPlanVersion,
  InMemoryAcquisitionPlanRunRepository
} from "./acquisition-plan-run-repository.js";
import type {
  AcquisitionSocialAccountPrivateRecord,
  InMemoryAcquisitionSocialAccountRepository
} from "./acquisition-social-account-repository.js";
import {
  AcquisitionMemoryTransactionCoordinator,
  type AcquisitionMemoryTransactionToken
} from "./acquisition-memory-transaction-coordinator.js";

export type DouyinAutomationCommandOperation = "put_policy" | "run_now";

export type DouyinAutomationReplayLookup =
  | { kind: "none" }
  | { kind: "conflict" }
  | {
      kind: "policy";
      value: DouyinAutomationPolicyVersion;
    }
  | {
      kind: "run";
      value: DouyinAutomationRunIntent;
    };

export interface SaveDouyinAutomationPolicyCommand {
  workspaceId: string;
  ownerId: string;
  teamId: string;
  planId: string;
  planVersionId: string;
  accountId: string;
  accountLoginStateVersion: number;
  expectedEtag: string;
  defaultEtag: string;
  idempotencyKey: string;
  requestHash: string;
  value: DouyinAutomationPolicyVersion;
}

export type SaveDouyinAutomationPolicyResult =
  | { kind: "created"; value: DouyinAutomationPolicyVersion }
  | { kind: "replay"; value: DouyinAutomationPolicyVersion }
  | { kind: "conflict" }
  | { kind: "precondition_failed" }
  | { kind: "binding_mismatch" };

export interface CreateDouyinAutomationRunIntentCommand {
  workspaceId: string;
  ownerId: string;
  teamId: string;
  planId: string;
  planVersionId: string;
  policyVersionId: string;
  accountId: string;
  accountLoginStateVersion: number;
  idempotencyKey: string;
  requestHash: string;
  value: DouyinAutomationRunIntent;
  runBinding: AcquisitionDouyinCollectionRunBinding;
}

export type CreateDouyinAutomationRunIntentResult =
  | { kind: "created"; value: DouyinAutomationRunIntent }
  | { kind: "replay"; value: DouyinAutomationRunIntent }
  | { kind: "conflict" }
  | { kind: "binding_mismatch" };

type AuthorityCommand = SaveDouyinAutomationPolicyCommand
  | CreateDouyinAutomationRunIntentCommand;

export interface DouyinAutomationAuthorityState {
  plan: AcquisitionPlan | null;
  version: AcquisitionPlanVersion | null;
  account: Pick<
    AcquisitionSocialAccountPrivateRecord,
    "workspaceId" | "id" | "platform" | "state" | "loginStateVersion"
  > | null;
}

export interface AcquisitionDouyinAutomationAuthorityValidator {
  isCurrent(
    command: AuthorityCommand,
    requireApproved: boolean,
    token: AcquisitionMemoryTransactionToken
  ): boolean | Promise<boolean>;
  bindRun(
    command: CreateDouyinAutomationRunIntentCommand,
    token: AcquisitionMemoryTransactionToken
  ): void | Promise<void>;
}

export function douyinAutomationAuthorityIsCurrent(
  command: AuthorityCommand,
  authority: DouyinAutomationAuthorityState,
  requireApproved: boolean
) {
  const { plan, version, account } = authority;
  return Boolean(plan
    && version
    && account
    && plan.id === command.planId
    && plan.ownerId === command.ownerId
    && plan.teamId === command.teamId
    && plan.currentVersionId === command.planVersionId
    && command.value.workspaceId === command.workspaceId
    && command.value.planId === command.planId
    && command.value.planVersionId === command.planVersionId
    && command.value.accountId === command.accountId
    && command.value.accountLoginStateVersion
      === command.accountLoginStateVersion
    && version.id === command.planVersionId
    && version.planId === command.planId
    && version.ownerId === command.ownerId
    && version.teamId === command.teamId
    && version.version === command.value.planVersion
    && version.payloadHash === command.value.planSnapshotHash
    && account.workspaceId === command.workspaceId
    && account.id === command.accountId
    && account.platform === "douyin"
    && account.state === "active"
    && account.loginStateVersion === command.accountLoginStateVersion
    && (!requireApproved || (
      plan.status === "approved"
      && plan.approvedVersionId === command.planVersionId
      && plan.approvedSnapshotHash === version.payloadHash
    )));
}

export function createAcquisitionDouyinAutomationAuthorityValidator(options: {
  memoryTransactions: AcquisitionMemoryTransactionCoordinator;
  plans: InMemoryAcquisitionPlanRunRepository;
  accounts: InMemoryAcquisitionSocialAccountRepository;
}): AcquisitionDouyinAutomationAuthorityValidator {
  if (options.plans.memoryTransactions !== options.memoryTransactions
    || options.accounts.memoryTransactions !== options.memoryTransactions) {
    throw new Error("acquisition_memory_transaction_coordinator_mismatch");
  }
  return {
    isCurrent(command, requireApproved, token) {
      const { plan, version } = options.plans.getDouyinAutomationAuthority(
        token,
        command.planId,
        command.planVersionId
      );
      const account = options.accounts.getDouyinAutomationAuthorityAccount(
        token,
        command.workspaceId,
        "douyin"
      );
      return douyinAutomationAuthorityIsCurrent(
        command,
        { plan, version, account },
        requireApproved
      );
    },
    bindRun(command, token) {
      if (command.runBinding.automationIntentId !== command.value.id
        || command.runBinding.run.id !== command.value.acquisitionRunId) {
        throw new Error("douyin_collection_run_binding_mismatch");
      }
      options.plans.bindDouyinAutomationRun(token, command.runBinding);
    }
  };
}

export interface AcquisitionDouyinAutomationRepository {
  listCurrentPolicies(): Promise<DouyinAutomationPolicyVersion[]>;
  getCurrent(
    workspaceId: string,
    planId: string
  ): Promise<DouyinAutomationPolicyVersion | null>;
  listVersions(
    workspaceId: string,
    planId: string
  ): Promise<DouyinAutomationPolicyVersion[]>;
  findCommandReplay(
    workspaceId: string,
    planId: string,
    operation: DouyinAutomationCommandOperation,
    idempotencyKey: string,
    requestHash: string
  ): Promise<DouyinAutomationReplayLookup>;
  savePolicy(
    command: SaveDouyinAutomationPolicyCommand
  ): Promise<SaveDouyinAutomationPolicyResult>;
  createRunIntent(
    command: CreateDouyinAutomationRunIntentCommand
  ): Promise<CreateDouyinAutomationRunIntentResult>;
  getRunIntent(
    workspaceId: string,
    runId: string
  ): Promise<DouyinAutomationRunIntent | null>;
}

interface ReplayRecord {
  workspaceId: string;
  planId: string;
  operation: DouyinAutomationCommandOperation;
  idempotencyKeyHash: string;
  requestHash: string;
  resultKind: "policy" | "run";
  result: DouyinAutomationPolicyVersion | DouyinAutomationRunIntent;
}

interface AutomationState {
  heads: Map<string, string>;
  versions: Map<string, DouyinAutomationPolicyVersion>;
  replays: Map<string, ReplayRecord>;
  runs: Map<string, DouyinAutomationRunIntent>;
}

function emptyState(): AutomationState {
  return {
    heads: new Map(),
    versions: new Map(),
    replays: new Map(),
    runs: new Map()
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hashKey(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function headKey(workspaceId: string, planId: string) {
  return `${workspaceId}\u0000${planId}`;
}

function replayKey(
  workspaceId: string,
  planId: string,
  operation: DouyinAutomationCommandOperation,
  idempotencyKey: string
) {
  return `${workspaceId}\u0000${planId}\u0000${operation}\u0000${hashKey(
    idempotencyKey
  )}`;
}

function replayLookup(
  record: ReplayRecord | undefined,
  requestHash: string
): DouyinAutomationReplayLookup {
  if (!record) return { kind: "none" };
  if (record.requestHash !== requestHash) return { kind: "conflict" };
  return record.resultKind === "policy"
    ? { kind: "policy", value: clone(record.result as DouyinAutomationPolicyVersion) }
    : { kind: "run", value: clone(record.result as DouyinAutomationRunIntent) };
}

export class InMemoryAcquisitionDouyinAutomationRepository
implements AcquisitionDouyinAutomationRepository {
  private state = emptyState();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly memoryTransactions: AcquisitionMemoryTransactionCoordinator,
    private readonly authority: AcquisitionDouyinAutomationAuthorityValidator
  ) {}

  private transaction<T>(work: (
    state: AutomationState,
    token: AcquisitionMemoryTransactionToken
  ) => T | Promise<T>) {
    const current = this.memoryTransactions.transaction(async (token) => {
      const state = clone(this.state);
      const result = await work(state, token);
      this.state = state;
      return clone(result);
    });
    this.tail = current.then(() => undefined, () => undefined);
    return current;
  }

  private async snapshot() {
    await this.tail;
    return clone(this.state);
  }

  async getCurrent(workspaceId: string, planId: string) {
    const state = await this.snapshot();
    const id = state.heads.get(headKey(workspaceId, planId));
    return id ? clone(state.versions.get(id) ?? null) : null;
  }

  async listCurrentPolicies() {
    const state = await this.snapshot();
    return [...state.heads.values()].map((id) => state.versions.get(id))
      .filter((value): value is DouyinAutomationPolicyVersion => Boolean(value))
      .map(clone);
  }

  async listVersions(workspaceId: string, planId: string) {
    const state = await this.snapshot();
    return [...state.versions.values()]
      .filter((value) => value.workspaceId === workspaceId
        && value.planId === planId)
      .sort((left, right) => left.version - right.version)
      .map(clone);
  }

  async findCommandReplay(
    workspaceId: string,
    planId: string,
    operation: DouyinAutomationCommandOperation,
    idempotencyKey: string,
    requestHash: string
  ) {
    const state = await this.snapshot();
    return replayLookup(
      state.replays.get(replayKey(
        workspaceId,
        planId,
        operation,
        idempotencyKey
      )),
      requestHash
    );
  }

  savePolicy(command: SaveDouyinAutomationPolicyCommand) {
    return this.transaction<SaveDouyinAutomationPolicyResult>(async (state, token) => {
      const replayIdentity = replayKey(
        command.workspaceId,
        command.planId,
        "put_policy",
        command.idempotencyKey
      );
      const replay = replayLookup(
        state.replays.get(replayIdentity),
        command.requestHash
      );
      if (replay.kind === "conflict") return { kind: "conflict" };
      if (replay.kind !== "none") {
        return replay.kind === "policy"
          ? { kind: "replay", value: replay.value }
          : { kind: "binding_mismatch" };
      }
      const identity = headKey(command.workspaceId, command.planId);
      const currentId = state.heads.get(identity);
      const current = currentId ? state.versions.get(currentId) : null;
      const actualEtag = current?.etag ?? command.defaultEtag;
      if (actualEtag !== command.expectedEtag) {
        return { kind: "precondition_failed" };
      }
      const expectedVersion = (current?.version ?? 0) + 1;
      if (command.value.workspaceId !== command.workspaceId
        || command.value.planId !== command.planId
        || command.value.planVersionId !== command.planVersionId
        || command.value.accountId !== command.accountId
        || command.value.accountLoginStateVersion
          !== command.accountLoginStateVersion
        || command.value.version !== expectedVersion
        || command.value.revision !== expectedVersion
        || state.versions.has(command.value.id)) {
        return { kind: "binding_mismatch" };
      }
      if (!await this.authority.isCurrent(command, false, token)) {
        return { kind: "binding_mismatch" };
      }
      state.versions.set(command.value.id, clone(command.value));
      state.heads.set(identity, command.value.id);
      state.replays.set(replayIdentity, {
        workspaceId: command.workspaceId,
        planId: command.planId,
        operation: "put_policy",
        idempotencyKeyHash: hashKey(command.idempotencyKey),
        requestHash: command.requestHash,
        resultKind: "policy",
        result: clone(command.value)
      });
      return { kind: "created", value: command.value };
    });
  }

  createRunIntent(command: CreateDouyinAutomationRunIntentCommand) {
    return this.transaction<CreateDouyinAutomationRunIntentResult>(async (state, token) => {
      const replayIdentity = replayKey(
        command.workspaceId,
        command.planId,
        "run_now",
        command.idempotencyKey
      );
      const replay = replayLookup(
        state.replays.get(replayIdentity),
        command.requestHash
      );
      if (replay.kind === "conflict") return { kind: "conflict" };
      if (replay.kind !== "none") {
        return replay.kind === "run"
          ? { kind: "replay", value: replay.value }
          : { kind: "binding_mismatch" };
      }
      const currentId = state.heads.get(headKey(
        command.workspaceId,
        command.planId
      ));
      if (currentId !== command.policyVersionId
        || command.value.workspaceId !== command.workspaceId
        || command.value.planId !== command.planId
        || command.value.planVersionId !== command.planVersionId
        || command.value.policyVersionId !== command.policyVersionId
        || command.value.accountId !== command.accountId
        || command.value.accountLoginStateVersion
          !== command.accountLoginStateVersion
        || command.value.acquisitionRunId !== command.runBinding.run.id
        || command.runBinding.automationIntentId !== command.value.id
        || state.runs.has(command.value.id)) {
        return { kind: "binding_mismatch" };
      }
      if (!await this.authority.isCurrent(command, true, token)) {
        return { kind: "binding_mismatch" };
      }
      await this.authority.bindRun(command, token);
      state.runs.set(command.value.id, clone(command.value));
      state.replays.set(replayIdentity, {
        workspaceId: command.workspaceId,
        planId: command.planId,
        operation: "run_now",
        idempotencyKeyHash: hashKey(command.idempotencyKey),
        requestHash: command.requestHash,
        resultKind: "run",
        result: clone(command.value)
      });
      return { kind: "created", value: command.value };
    });
  }

  async getRunIntent(workspaceId: string, runId: string) {
    const state = await this.snapshot();
    const run = state.runs.get(runId);
    return run?.workspaceId === workspaceId ? clone(run) : null;
  }
}

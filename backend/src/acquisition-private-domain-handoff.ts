import { createHash } from "node:crypto";
import type {
  OutcomeAttributionInput
} from "./acquisition-domain.js";
import type {
  AcquisitionDomainRepository
} from "./acquisition-domain-repository.js";
import type {
  AcquisitionActorScope,
  AcquisitionDomainService
} from "./acquisition-domain-service.js";
import { canonicalJsonStringify } from "./canonical-json.js";
import type {
  AcquisitionCustomerHandoff,
  AcquisitionCustomerHandoffOperation,
  AcquisitionCustomerHandoffRequestSnapshot,
  AcquisitionHandoffIntelligence,
  Customer,
  CustomerActivity,
  Lead,
  LeadActivity,
  LeadSourceEvent,
  Todo
} from "./types.js";

export interface AcquisitionPrivateDomainHandoffRequest
  extends AcquisitionCustomerHandoffRequestSnapshot {}

export interface AcquisitionPrivateDomainHandoffStore {
  leads: Lead[];
  leadSourceEvents: LeadSourceEvent[];
  leadActivities: LeadActivity[];
  customers: Customer[];
  customerActivities: CustomerActivity[];
  todos: Todo[];
  acquisitionCustomerHandoffs: AcquisitionCustomerHandoff[];
  acquisitionCustomerHandoffOperations: AcquisitionCustomerHandoffOperation[];
  persist(): Promise<void>;
  persistMutation?<T>(mutation: () => {
    value: T;
    rollback(): void;
  }): Promise<T>;
  readBarrier(): Promise<void>;
}

export interface AcquisitionPrivateDomainHandoffResult {
  replayed: boolean;
  handoff: AcquisitionCustomerHandoff;
  lead: Lead;
  customer: Customer;
  todo: Todo;
  intelligence: AcquisitionHandoffIntelligence;
  recovery?: {
    request: AcquisitionPrivateDomainHandoffRecoveryRequest;
  };
}

export interface AcquisitionPrivateDomainHandoffAttributionResolver {
  resolve(
    scope: { ownerId: string; teamId: string },
    input: {
      runId: string;
      discoveredEventId: string;
      candidateId: string;
      evidenceIds: string[];
      qualificationDecisionId: string;
      decisionVersion: string;
      decisionSnapshotHash: string;
    }
  ): Promise<OutcomeAttributionInput | null>;
}

export interface AcquisitionPrivateDomainHandoffPendingResult {
  replayed: false;
  inProgress: {
    id: string;
    candidateId: string;
    decisionVersion: string;
    mode: "create_new" | "link_existing";
    existingCustomerId: string;
    stage: AcquisitionCustomerHandoffOperation["stage"];
    request: AcquisitionPrivateDomainHandoffRecoveryRequest;
    createdAt: string;
  };
}

export type AcquisitionPrivateDomainHandoffStatus =
  | AcquisitionPrivateDomainHandoffResult
  | AcquisitionPrivateDomainHandoffPendingResult;

export class AcquisitionPrivateDomainHandoffError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "AcquisitionPrivateDomainHandoffError";
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(prefix: string, values: string[]) {
  return `${prefix}_${digest(values.join("\u001f")).slice(0, 40)}`;
}

function privateDomainHandoffSnapshotEvent(input: {
  scope: Pick<AcquisitionActorScope, "ownerId" | "teamId">;
  candidateId: string;
  leadId: string;
  decisionVersion: string;
  sourceUrl: string;
  occurredAt: string;
  acquisitionAttribution: OutcomeAttributionInput;
  intelligence: AcquisitionHandoffIntelligence;
  qualificationSnapshotHash: string;
  financialSnapshotHash: string;
}): LeadSourceEvent {
  return {
    id: stableId("lse", [
      input.scope.ownerId,
      input.scope.teamId,
      input.candidateId,
      "private-domain-handoff-snapshot"
    ]),
    leadId: input.leadId,
    sourceType: "outbound",
    channel: "acquisition_private_domain_handoff_snapshot",
    campaign: input.decisionVersion,
    externalId: input.candidateId,
    sourceUrl: input.sourceUrl,
    occurredAt: input.occurredAt,
    receivedAt: input.occurredAt,
    rawPayload: canonicalJsonStringify({
      candidateId: input.candidateId,
      decisionVersion: input.decisionVersion,
      acquisitionAttribution: input.acquisitionAttribution,
      intelligence: input.intelligence,
      qualificationSnapshotHash: input.qualificationSnapshotHash,
      financialSnapshotHash: input.financialSnapshotHash
    }),
    ownerId: input.scope.ownerId,
    teamId: input.scope.teamId
  };
}

function gradeForCustomer(
  grade: AcquisitionHandoffIntelligence["qualificationGrade"]
): Customer["grade"] {
  return grade === "S" ? "A" : grade;
}

function normalizeHandoffRequest(
  request: AcquisitionPrivateDomainHandoffRequest
): AcquisitionCustomerHandoffRequestSnapshot {
  return {
    operationCode: "handoff_acquisition_candidate_v1",
    runId: request.runId.trim(),
    discoveredEventId: request.discoveredEventId.trim(),
    decisionVersion: request.decisionVersion.trim(),
    mode: request.mode,
    existingCustomerId: request.mode === "link_existing"
      ? request.existingCustomerId.trim()
      : "",
    followUp: {
      title: request.followUp.title.trim(),
      dueAt: new Date(request.followUp.dueAt).toISOString(),
      priority: request.followUp.priority
    }
  };
}

export type AcquisitionPrivateDomainHandoffRecoveryRequest = Omit<
  AcquisitionCustomerHandoffRequestSnapshot,
  "runId" | "discoveredEventId"
> & (
  | Pick<
      AcquisitionCustomerHandoffRequestSnapshot,
      "runId" | "discoveredEventId"
    >
  | { runId?: never; discoveredEventId?: never }
);

function legacyHandoffRequestSnapshot(
  value: unknown
): Omit<AcquisitionPrivateDomainHandoffRecoveryRequest,
  "runId" | "discoveredEventId"> | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Partial<AcquisitionCustomerHandoffRequestSnapshot>;
  const hasRunId = Object.prototype.hasOwnProperty.call(request, "runId");
  const hasDiscoveredEventId = Object.prototype.hasOwnProperty.call(
    request,
    "discoveredEventId"
  );
  const followUp = request.followUp;
  if (hasRunId !== hasDiscoveredEventId
    || (hasRunId && (typeof request.runId !== "string"
      || request.runId.trim().length === 0
      || typeof request.discoveredEventId !== "string"
      || request.discoveredEventId.trim().length === 0))
    || request.operationCode !== "handoff_acquisition_candidate_v1"
    || typeof request.decisionVersion !== "string"
    || (request.mode !== "create_new" && request.mode !== "link_existing")
    || typeof request.existingCustomerId !== "string"
    || !followUp
    || typeof followUp.title !== "string"
    || typeof followUp.dueAt !== "string"
    || !["high", "medium", "normal"].includes(followUp.priority)) {
    return null;
  }
  return {
    operationCode: request.operationCode,
    decisionVersion: request.decisionVersion,
    mode: request.mode,
    existingCustomerId: request.existingCustomerId,
    followUp: {
      title: followUp.title,
      dueAt: followUp.dueAt,
      priority: followUp.priority
    }
  };
}

function hasPinnedAttributionRequest(
  value: unknown
): value is AcquisitionCustomerHandoffRequestSnapshot {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<AcquisitionCustomerHandoffRequestSnapshot>;
  return typeof request.runId === "string"
    && request.runId.trim().length > 0
    && typeof request.discoveredEventId === "string"
    && request.discoveredEventId.trim().length > 0;
}

function removeById<T extends { id: string }>(values: T[], id: string) {
  const index = values.findIndex((value) => value.id === id);
  if (index >= 0) values.splice(index, 1);
}

const handoffStageOrder: AcquisitionCustomerHandoffOperation["stage"][] = [
  "reserved",
  "lead_ready",
  "customer_ready",
  "activity_ready",
  "todo_ready",
  "completed"
];

function laterHandoffStage(
  current: AcquisitionCustomerHandoffOperation["stage"],
  next: AcquisitionCustomerHandoffOperation["stage"]
) {
  return handoffStageOrder.indexOf(current) >= handoffStageOrder.indexOf(next)
    ? current
    : next;
}

function acceptedProcessingKeyHashes(record: {
  processingKeyHash: string;
  acceptedProcessingKeyHashes?: string[];
}) {
  return Array.from(new Set([
    record.processingKeyHash,
    ...(Array.isArray(record.acceptedProcessingKeyHashes)
      ? record.acceptedProcessingKeyHashes
      : [])
  ]));
}

export class AcquisitionPrivateDomainHandoffService {
  readonly #repository: AcquisitionDomainRepository;
  readonly #domainService: AcquisitionDomainService;
  readonly #store: AcquisitionPrivateDomainHandoffStore;
  readonly #attributionResolver:
    AcquisitionPrivateDomainHandoffAttributionResolver | undefined;
  readonly #now: () => string;
  readonly #inFlight = new Map<
    string,
    Promise<AcquisitionPrivateDomainHandoffResult>
  >();

  constructor(options: {
    repository: AcquisitionDomainRepository;
    domainService: AcquisitionDomainService;
    store: AcquisitionPrivateDomainHandoffStore;
    attributionResolver?: AcquisitionPrivateDomainHandoffAttributionResolver;
    now?: () => string;
  }) {
    this.#repository = options.repository;
    this.#domainService = options.domainService;
    this.#store = options.store;
    this.#attributionResolver = options.attributionResolver;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async create(
    scope: AcquisitionActorScope,
    candidateId: string,
    request: AcquisitionPrivateDomainHandoffRequest,
    idempotencyKey: string
  ): Promise<AcquisitionPrivateDomainHandoffResult> {
    const flightKey = [scope.ownerId, scope.teamId, candidateId].join("\u001f");
    const running = this.#inFlight.get(flightKey);
    if (running) {
      await running;
      return await this.#create(scope, candidateId, request, idempotencyKey);
    }
    const operation = this.#create(
      scope,
      candidateId,
      request,
      idempotencyKey
    );
    this.#inFlight.set(flightKey, operation);
    try {
      return await operation;
    } finally {
      if (this.#inFlight.get(flightKey) === operation) {
        this.#inFlight.delete(flightKey);
      }
    }
  }

  async #create(
    scope: AcquisitionActorScope,
    candidateId: string,
    request: AcquisitionPrivateDomainHandoffRequest,
    idempotencyKey: string
  ): Promise<AcquisitionPrivateDomainHandoffResult> {
    await this.#store.readBarrier();
    const normalizedRequest = normalizeHandoffRequest(request);
    const processingKeyHash = digest([
      scope.ownerId,
      scope.teamId,
      candidateId,
      idempotencyKey
    ].join("\u001f"));
    const requestHash = digest(canonicalJsonStringify(normalizedRequest));
    const completed = this.#store.acquisitionCustomerHandoffs.find((item) =>
      item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
      && item.candidateId === candidateId
    );
    if (completed) {
      const acceptedKey = acceptedProcessingKeyHashes(completed)
        .includes(processingKeyHash);
      if (!completed.acquisitionAttribution) {
        return await this.#upgradeCompletedLegacy(
          scope,
          candidateId,
          normalizedRequest,
          requestHash,
          processingKeyHash,
          completed,
          acceptedKey
        );
      }
      if (acceptedKey && completed.requestHash !== requestHash) {
        throw new AcquisitionPrivateDomainHandoffError(
          "ACQUISITION_HANDOFF_IDEMPOTENCY_CONFLICT",
          "同一 Idempotency-Key 已用于不同交接请求",
          409
        );
      }
      return this.#completedResult(
        scope,
        completed,
        acceptedKey
      );
    }
    let operation = this.#store.acquisitionCustomerHandoffOperations.find(
      (item) => item.ownerId === scope.ownerId
        && item.teamId === scope.teamId
        && item.candidateId === candidateId
    );
    if (operation && !operation.request) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_RECOVERY_DATA_MISSING",
        "未完成交接缺少原请求快照，无法安全恢复",
        409
      );
    }
    const legacyOperationRequest = operation
      && !hasPinnedAttributionRequest(operation.request)
      ? legacyHandoffRequestSnapshot(operation.request)
      : null;
    if (operation && legacyOperationRequest) {
      const normalizedLegacyRequest = legacyHandoffRequestSnapshot(
        normalizedRequest
      );
      const storedLegacyHash = digest(
        canonicalJsonStringify(legacyOperationRequest)
      );
      const incomingLegacyHash = normalizedLegacyRequest
        ? digest(canonicalJsonStringify(normalizedLegacyRequest))
        : "";
      if (operation.requestHash !== storedLegacyHash
        || operation.requestHash !== incomingLegacyHash) {
        throw new AcquisitionPrivateDomainHandoffError(
          "ACQUISITION_HANDOFF_IDEMPOTENCY_CONFLICT",
          "候选已有使用不同规范化请求的未完成交接",
          409
        );
      }
    } else if (operation && operation.requestHash !== requestHash) {
        throw new AcquisitionPrivateDomainHandoffError(
          "ACQUISITION_HANDOFF_IDEMPOTENCY_CONFLICT",
          "候选已有使用不同规范化请求的未完成交接",
          409
        );
    }
    request = operation && !legacyOperationRequest
      ? structuredClone(operation.request)
      : normalizedRequest;
    const candidate = await this.#repository.findCandidate(scope, candidateId);
    if (!candidate) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_CANDIDATE_NOT_FOUND",
        "候选不存在",
        404
      );
    }
    if (candidate.status !== "approved"
      && candidate.status !== "converted_to_lead") {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_NOT_APPROVED",
        "只有已批准或已转线索的候选可以交接",
        409
      );
    }
    if (candidate.approvedDecisionVersion !== request.decisionVersion
      || candidate.latestDecisionVersion !== request.decisionVersion) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_STALE_DECISION",
        "审核批准的资格决定版本已失效",
        409
      );
    }
    if (candidate.hardGateFailures.length > 0) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_HARD_GATE_BLOCKED",
        "硬门禁未通过，禁止交接",
        409
      );
    }
    const qualifications = await this.#repository.listQualificationDecisions(
      scope,
      candidateId
    );
    const qualification = qualifications.find((item) =>
      item.id === candidate.latestDecisionId
      && item.decisionVersion === request.decisionVersion
    );
    const financials = await this.#repository.listFinancialValues(
      scope,
      candidateId
    );
    const financial = financials
      .filter((item) =>
        item.qualificationDecisionId === qualification?.id
      )
      .at(-1);
    if (!qualification || !financial) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_INTELLIGENCE_MISSING",
        "候选的服务端评分快照不完整",
        409
      );
    }
    let acquisitionAttribution = operation?.acquisitionAttribution ?? null;
    if ((!operation || !acquisitionAttribution || legacyOperationRequest)
      && this.#attributionResolver) {
      try {
        acquisitionAttribution = await this.#attributionResolver.resolve(
          { ownerId: scope.ownerId, teamId: scope.teamId },
          {
            runId: request.runId,
            discoveredEventId: request.discoveredEventId,
            candidateId,
            evidenceIds: candidate.evidenceIds,
            qualificationDecisionId: qualification.id,
            decisionVersion: qualification.decisionVersion,
            decisionSnapshotHash: qualification.snapshotHash
          }
        );
      } catch {
        acquisitionAttribution = null;
      }
    }
    if (!acquisitionAttribution) {
      throw new AcquisitionPrivateDomainHandoffError(
        operation
          ? "ACQUISITION_HANDOFF_RECOVERY_DATA_MISSING"
          : "ACQUISITION_HANDOFF_ATTRIBUTION_INVALID",
        operation
          ? "未完成交接缺少固定获客归因，无法安全恢复"
          : "指定的获客 Run 或发现事件无效",
        409
      );
    }
    const operationNeedsAttributionUpgrade = Boolean(operation
      && (legacyOperationRequest || !operation.acquisitionAttribution));
    if (qualification.hardGateFailures.length > 0) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_HARD_GATE_BLOCKED",
        "服务端资格快照的硬门禁未通过",
        409
      );
    }
    const existingCustomer = request.mode === "link_existing"
      ? this.#store.customers.find((item) =>
          item.id === request.existingCustomerId
          && item.ownerId === scope.ownerId
          && item.teamId === scope.teamId
        )
      : undefined;
    if (request.mode === "link_existing" && !existingCustomer) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_CUSTOMER_NOT_FOUND",
        "指定的客户不存在或不在当前负责人/团队范围",
        404
      );
    }
    const currentIntelligence: AcquisitionHandoffIntelligence = {
      qualificationGrade: qualification.grade,
      qualificationScore: qualification.score,
      financialGrade: financial.grade,
      currency: financial.currency,
      expectedRevenueMinor: financial.expectedRevenueMinor,
      expectedGrossProfitMinor: financial.expectedGrossProfitMinor,
      expectedContributionMinor: financial.expectedContributionMinor
    };
    const identity = [scope.ownerId, scope.teamId, candidateId];
    const createdAt = operation?.createdAt
      ?? new Date(this.#now()).toISOString();
    if (operation && !operationNeedsAttributionUpgrade) {
      const acceptedKeys = acceptedProcessingKeyHashes(operation);
      if (!acceptedKeys.includes(processingKeyHash)) {
        const acceptedOperation = operation;
        await this.#persistMutation(() => {
          const previousOperation = structuredClone(acceptedOperation);
          acceptedOperation.acceptedProcessingKeyHashes = [
            ...acceptedKeys,
            processingKeyHash
          ];
          acceptedOperation.updatedAt = new Date(this.#now()).toISOString();
          return {
            value: undefined,
            rollback: () => Object.assign(
              acceptedOperation,
              previousOperation
            )
          };
        });
      }
    }
    if (!operation) {
      operation = {
        id: stableId("acho", identity),
        ownerId: scope.ownerId,
        teamId: scope.teamId,
        candidateId,
        processingKeyHash,
        acceptedProcessingKeyHashes: [processingKeyHash],
        requestHash,
        decisionVersion: request.decisionVersion,
        mode: request.mode,
        existingCustomerId: request.existingCustomerId,
        stage: "reserved",
        leadId: candidate.leadId ?? "",
        customerId: existingCustomer?.id ?? stableId("customer", identity),
        activityId: stableId("ca", identity),
        todoId: stableId("todo", identity),
        handoffId: stableId("ach", identity),
        intelligence: currentIntelligence,
        qualificationSnapshotHash: qualification.snapshotHash,
        financialSnapshotHash: financial.inputSnapshotHash,
        acquisitionAttribution: structuredClone(acquisitionAttribution),
        request: structuredClone(request),
        createdAt,
        updatedAt: createdAt
      };
      const reserved = operation;
      await this.#persistMutation(() => {
        this.#store.acquisitionCustomerHandoffOperations.unshift(reserved);
        return {
          value: undefined,
          rollback: () => removeById(
            this.#store.acquisitionCustomerHandoffOperations,
            reserved.id
          )
        };
      });
    }
    const conversion = candidate.status === "converted_to_lead"
      && candidate.leadId
      ? { leadId: candidate.leadId }
      : await this.#domainService.convertCandidate(scope, candidateId, {
          decisionVersion: request.decisionVersion,
          idempotencyKey: `private-domain-handoff:${idempotencyKey}`
        });
    const lead = this.#store.leads.find((item) =>
      item.id === conversion.leadId
      && item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
    );
    if (!lead) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_LEAD_MISSING",
        "CRM 线索未完整持久化",
        502
      );
    }
    const intelligence = structuredClone(operation.intelligence);
    const linkedCustomerId = lead.convertedCustomerId?.trim() ?? "";
    const linkedCustomer = linkedCustomerId
      ? this.#store.customers.find((item) =>
          item.id === linkedCustomerId
          && item.ownerId === scope.ownerId
          && item.teamId === scope.teamId
        )
      : undefined;
    if (linkedCustomerId && !linkedCustomer) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_LEAD_CUSTOMER_MISSING",
        "CRM 线索已关联的客户不存在或不在当前租户范围",
        409
      );
    }
    if (linkedCustomer && existingCustomer
      && linkedCustomer.id !== existingCustomer.id) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_LEAD_CUSTOMER_CONFLICT",
        "CRM 线索已关联其他客户，不能覆盖原客户链接",
        409
      );
    }
    const customerId = linkedCustomer?.id
      ?? existingCustomer?.id
      ?? operation.customerId;
    const snapshotEvent = privateDomainHandoffSnapshotEvent({
      scope,
      candidateId,
      leadId: lead.id,
      decisionVersion: request.decisionVersion,
      sourceUrl: lead.sourceUrl,
      occurredAt: createdAt,
      acquisitionAttribution,
      intelligence,
      qualificationSnapshotHash: operation.qualificationSnapshotHash,
      financialSnapshotHash: operation.financialSnapshotHash
    });
    const snapshotEventCollision = this.#store.leadSourceEvents.find((item) =>
      item.id === snapshotEvent.id
    );
    const recoveredSnapshotEvent = this.#store.leadSourceEvents.find((item) =>
      item.id === snapshotEvent.id
      && item.leadId === lead.id
      && item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
    );
    if (snapshotEventCollision && !recoveredSnapshotEvent) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_RECOVERY_DATA_MISSING",
        "交接来源快照与当前租户或 Lead 不一致，无法安全恢复",
        409
      );
    }
    await this.#persistMutation(() => {
      const previousOperation = structuredClone(operation);
      const previousSnapshotEvent = recoveredSnapshotEvent
        ? structuredClone(recoveredSnapshotEvent)
        : null;
      if (!recoveredSnapshotEvent) {
        this.#store.leadSourceEvents.unshift(snapshotEvent);
      } else {
        Object.assign(recoveredSnapshotEvent, snapshotEvent);
      }
      if (operationNeedsAttributionUpgrade) {
        operation.request = structuredClone(request);
        operation.requestHash = requestHash;
        operation.acquisitionAttribution = structuredClone(
          acquisitionAttribution
        );
        operation.acceptedProcessingKeyHashes = Array.from(new Set([
          ...acceptedProcessingKeyHashes(operation),
          processingKeyHash
        ]));
      }
      Object.assign(operation, {
        stage: laterHandoffStage(operation.stage, "lead_ready"),
        leadId: lead.id,
        customerId,
        updatedAt: new Date(this.#now()).toISOString()
      });
      return {
        value: undefined,
        rollback: () => {
          if (!recoveredSnapshotEvent) {
            removeById(this.#store.leadSourceEvents, snapshotEvent.id);
          } else if (previousSnapshotEvent) {
            Object.assign(recoveredSnapshotEvent, previousSnapshotEvent);
          }
          Object.assign(operation, previousOperation);
        }
      };
    });
    const activityId = operation.activityId;
    const todoId = operation.todoId;
    const handoffId = operation.handoffId;
    const recoveredCustomer = this.#store.customers.find((item) =>
      item.id === customerId
      && item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
    );
    const targetCustomer = linkedCustomer ?? existingCustomer
      ?? recoveredCustomer;
    const customer: Customer = targetCustomer
      ? {
          ...targetCustomer,
          nextReminder: request.followUp.dueAt
        }
      : {
          id: customerId,
          company: lead.company,
          country: lead.country,
          contact: lead.contact,
          ownerId: scope.ownerId,
          teamId: scope.teamId,
          stage: "待首次跟进",
          amount: intelligence.currency === "CNY"
            ? intelligence.expectedRevenueMinor / 100
            : 0,
          health: 80,
          grade: gradeForCustomer(intelligence.qualificationGrade),
          nextReminder: request.followUp.dueAt,
          wecomBound: false,
          billingName: "",
          billingAddress: "",
          documentContact: lead.contact,
          defaultPortDischarge: "",
          defaultIncoterm: "",
          defaultPaymentTerm: "",
          poolStatus: "owned",
          ownershipVersion: 0
        };
    await this.#persistMutation(() => {
      const previousCustomer = targetCustomer
        ? structuredClone(targetCustomer)
        : null;
      const previousConvertedCustomerId = lead.convertedCustomerId;
      const previousOperation = structuredClone(operation);
      if (targetCustomer) {
        targetCustomer.nextReminder = customer.nextReminder;
      } else {
        this.#store.customers.unshift(customer);
      }
      lead.convertedCustomerId = customer.id;
      Object.assign(operation, {
        stage: laterHandoffStage(operation.stage, "customer_ready"),
        customerId: customer.id,
        updatedAt: new Date(this.#now()).toISOString()
      });
      return {
        value: undefined,
        rollback: () => {
          if (targetCustomer && previousCustomer) {
            Object.assign(targetCustomer, previousCustomer);
          } else {
            removeById(this.#store.customers, customer.id);
          }
          lead.convertedCustomerId = previousConvertedCustomerId;
          Object.assign(operation, previousOperation);
        }
      };
    });
    const activity: CustomerActivity = {
      id: activityId,
      customerId,
      type: "note",
      content: `由获客候选 ${candidateId} 交接至 CRM/私域，已创建首次跟进。`,
      operatorId: scope.actorId,
      nextReminder: request.followUp.dueAt,
      createdAt
    };
    const recoveredActivity = this.#store.customerActivities.find((item) =>
      item.id === activityId
    );
    await this.#persistMutation(() => {
      const previousOperation = structuredClone(operation);
      if (!recoveredActivity) this.#store.customerActivities.unshift(activity);
      Object.assign(operation, {
        stage: laterHandoffStage(operation.stage, "activity_ready"),
        updatedAt: new Date(this.#now()).toISOString()
      });
      return {
        value: undefined,
        rollback: () => {
          if (!recoveredActivity) {
            removeById(this.#store.customerActivities, activity.id);
          }
          Object.assign(operation, previousOperation);
        }
      };
    });
    const todo: Todo = {
      id: todoId,
      title: request.followUp.title,
      type: "customer",
      priority: request.followUp.priority,
      status: "pending",
      dueAt: request.followUp.dueAt,
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      related: customer.company,
      done: false,
      customerId,
      leadId: lead.id,
      triggerKey: `acquisition-first-follow-up:${candidateId}`,
      createdAt
    };
    const recoveredTodo = this.#store.todos.find((item) =>
      item.id === todoId
      && item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
    );
    await this.#persistMutation(() => {
      const previousOperation = structuredClone(operation);
      if (!recoveredTodo) this.#store.todos.unshift(todo);
      Object.assign(operation, {
        stage: laterHandoffStage(operation.stage, "todo_ready"),
        updatedAt: new Date(this.#now()).toISOString()
      });
      return {
        value: undefined,
        rollback: () => {
          if (!recoveredTodo) removeById(this.#store.todos, todo.id);
          Object.assign(operation, previousOperation);
        }
      };
    });
    const durableTodo = recoveredTodo ?? todo;
    const handoff: AcquisitionCustomerHandoff = {
      id: handoffId,
      ownerId: scope.ownerId,
      teamId: scope.teamId,
      candidateId,
      leadId: lead.id,
      customerId,
      todoId,
      decisionVersion: request.decisionVersion,
      mode: request.mode,
      processingKeyHash: operation.processingKeyHash,
      acceptedProcessingKeyHashes:
        acceptedProcessingKeyHashes(operation),
      requestHash: operation.requestHash,
      intelligence,
      qualificationSnapshotHash: operation.qualificationSnapshotHash,
      financialSnapshotHash: operation.financialSnapshotHash,
      acquisitionAttribution: structuredClone(acquisitionAttribution),
      createdAt
    };
    const result: AcquisitionPrivateDomainHandoffResult = {
      replayed: false,
      handoff,
      lead,
      customer,
      todo: durableTodo,
      intelligence
    };
    const apply = () => {
      const previousOperation = structuredClone(operation);
      this.#store.acquisitionCustomerHandoffs.unshift(handoff);
      Object.assign(operation, {
        stage: "completed",
        leadId: lead.id,
        customerId: customer.id,
        updatedAt: createdAt
      });
      return {
        value: result,
        rollback: () => {
          removeById(this.#store.acquisitionCustomerHandoffs, handoff.id);
          Object.assign(operation, previousOperation);
        }
      };
    };
    return await this.#persistMutation(apply);
  }

  async #upgradeCompletedLegacy(
    scope: AcquisitionActorScope,
    candidateId: string,
    request: AcquisitionCustomerHandoffRequestSnapshot,
    requestHash: string,
    processingKeyHash: string,
    handoff: AcquisitionCustomerHandoff,
    replayed: boolean
  ): Promise<AcquisitionPrivateDomainHandoffResult> {
    const durable = this.#completedResult(scope, handoff, replayed);
    const durableRequest = durable.recovery?.request;
    const operation = this.#store.acquisitionCustomerHandoffOperations.find(
      (item) => item.ownerId === scope.ownerId
        && item.teamId === scope.teamId
        && item.candidateId === candidateId
        && item.handoffId === handoff.id
    );
    if (!durableRequest || !operation) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_RECOVERY_DATA_MISSING",
        "已完成交接缺少可信原请求，无法补全获客归因",
        409
      );
    }
    const durableComparable = hasPinnedAttributionRequest(durableRequest)
      ? durableRequest
      : legacyHandoffRequestSnapshot(durableRequest);
    const incomingComparable = hasPinnedAttributionRequest(durableRequest)
      ? request
      : legacyHandoffRequestSnapshot(request);
    if (!durableComparable || !incomingComparable
      || canonicalJsonStringify(durableComparable)
        !== canonicalJsonStringify(incomingComparable)) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_IDEMPOTENCY_CONFLICT",
        "历史交接恢复请求与原始规范化请求不一致",
        409
      );
    }
    const candidate = await this.#repository.findCandidate(scope, candidateId);
    if (!candidate
      || (candidate.status !== "approved"
        && candidate.status !== "converted_to_lead")
      || candidate.leadId !== handoff.leadId
      || candidate.approvedDecisionVersion !== request.decisionVersion
      || candidate.latestDecisionVersion !== request.decisionVersion
      || candidate.hardGateFailures.length > 0) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_RECOVERY_DATA_MISSING",
        "已完成交接与当前候选资格快照不一致",
        409
      );
    }
    const qualification = (await this.#repository.listQualificationDecisions(
      scope,
      candidateId
    )).find((item) => item.id === candidate.latestDecisionId
      && item.decisionVersion === request.decisionVersion
      && item.snapshotHash === operation.qualificationSnapshotHash
      && item.snapshotHash === handoff.qualificationSnapshotHash);
    if (!qualification || qualification.hardGateFailures.length > 0
      || !this.#attributionResolver) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_RECOVERY_DATA_MISSING",
        "已完成交接缺少可验证资格快照或归因解析器",
        409
      );
    }
    let acquisitionAttribution: OutcomeAttributionInput | null = null;
    try {
      acquisitionAttribution = await this.#attributionResolver.resolve(
        { ownerId: scope.ownerId, teamId: scope.teamId },
        {
          runId: request.runId,
          discoveredEventId: request.discoveredEventId,
          candidateId,
          evidenceIds: candidate.evidenceIds,
          qualificationDecisionId: qualification.id,
          decisionVersion: qualification.decisionVersion,
          decisionSnapshotHash: qualification.snapshotHash
        }
      );
    } catch {
      acquisitionAttribution = null;
    }
    if (!acquisitionAttribution) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_ATTRIBUTION_INVALID",
        "历史交接的 Run 或发现事件无法验证",
        409
      );
    }
    const sourceSnapshot = privateDomainHandoffSnapshotEvent({
      scope,
      candidateId,
      leadId: handoff.leadId,
      decisionVersion: request.decisionVersion,
      sourceUrl: durable.lead.sourceUrl,
      occurredAt: handoff.createdAt,
      acquisitionAttribution,
      intelligence: operation.intelligence,
      qualificationSnapshotHash: operation.qualificationSnapshotHash,
      financialSnapshotHash: operation.financialSnapshotHash
    });
    const collision = this.#store.leadSourceEvents.find((item) =>
      item.id === sourceSnapshot.id
    );
    const snapshotEvent = collision
      && collision.leadId === handoff.leadId
      && collision.ownerId === scope.ownerId
      && collision.teamId === scope.teamId
      ? collision
      : null;
    if (collision && !snapshotEvent) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_RECOVERY_DATA_MISSING",
        "历史交接来源快照与当前租户或 Lead 不一致",
        409
      );
    }
    const acceptedKeys = Array.from(new Set([
      ...acceptedProcessingKeyHashes(operation),
      ...acceptedProcessingKeyHashes(handoff),
      processingKeyHash
    ]));
    await this.#persistMutation(() => {
      const previousOperation = structuredClone(operation);
      const previousHandoff = structuredClone(handoff);
      const previousSnapshot = snapshotEvent
        ? structuredClone(snapshotEvent)
        : null;
      Object.assign(operation, {
        request: structuredClone(request),
        requestHash,
        acquisitionAttribution: structuredClone(acquisitionAttribution),
        acceptedProcessingKeyHashes: [...acceptedKeys],
        updatedAt: new Date(this.#now()).toISOString()
      });
      Object.assign(handoff, {
        requestHash,
        acquisitionAttribution: structuredClone(acquisitionAttribution),
        acceptedProcessingKeyHashes: [...acceptedKeys]
      });
      if (snapshotEvent) {
        Object.assign(snapshotEvent, sourceSnapshot);
      } else {
        this.#store.leadSourceEvents.unshift(sourceSnapshot);
      }
      return {
        value: undefined,
        rollback: () => {
          Object.assign(operation, previousOperation);
          Object.assign(handoff, previousHandoff);
          if (snapshotEvent && previousSnapshot) {
            Object.assign(snapshotEvent, previousSnapshot);
          } else {
            removeById(this.#store.leadSourceEvents, sourceSnapshot.id);
          }
        }
      };
    });
    return this.#completedResult(scope, handoff, replayed);
  }

  async #persistMutation<T>(mutationFactory: () => {
    value: T;
    rollback(): void;
  }): Promise<T> {
    if (this.#store.persistMutation) {
      return await this.#store.persistMutation(mutationFactory);
    }
    const mutation = mutationFactory();
    try {
      await this.#store.persist();
      return mutation.value;
    } catch (error) {
      mutation.rollback();
      throw error;
    }
  }

  #completedResult(
    scope: Pick<AcquisitionActorScope, "ownerId" | "teamId">,
    handoff: AcquisitionCustomerHandoff,
    replayed: boolean
  ): AcquisitionPrivateDomainHandoffResult {
    const lead = this.#store.leads.find((item) =>
      item.id === handoff.leadId
      && item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
    );
    const customer = this.#store.customers.find((item) =>
      item.id === handoff.customerId
      && item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
    );
    const todo = this.#store.todos.find((item) =>
      item.id === handoff.todoId
      && item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
    );
    if (!lead || !customer || !todo) {
      throw new AcquisitionPrivateDomainHandoffError(
        "ACQUISITION_HANDOFF_INCOMPLETE",
        "交接记录关联的 CRM 资源不完整",
        502
      );
    }
    const recoveryRequest = this.#completedRecoveryRequest(
      scope,
      handoff,
      lead,
      customer,
      todo
    );
    return {
      replayed,
      handoff,
      lead,
      customer,
      todo,
      intelligence: handoff.intelligence,
      ...(recoveryRequest
        ? { recovery: { request: recoveryRequest } }
        : {})
    };
  }

  #completedRecoveryRequest(
    scope: Pick<AcquisitionActorScope, "ownerId" | "teamId">,
    handoff: AcquisitionCustomerHandoff,
    lead: Lead,
    customer: Customer,
    todo: Todo
  ): AcquisitionPrivateDomainHandoffRecoveryRequest | null {
    if (handoff.acquisitionAttribution) return null;
    const operations = this.#store.acquisitionCustomerHandoffOperations.filter(
      (item) => item.ownerId === scope.ownerId
        && item.teamId === scope.teamId
        && item.candidateId === handoff.candidateId
        && item.handoffId === handoff.id
    );
    if (operations.length !== 1) return null;
    const operation = operations[0];
    const request = operation.request as unknown;
    const legacyRequest = legacyHandoffRequestSnapshot(request);
    if (!legacyRequest
      || operation.stage !== "completed"
      || operation.leadId !== handoff.leadId
      || operation.customerId !== handoff.customerId
      || operation.todoId !== handoff.todoId
      || operation.decisionVersion !== legacyRequest.decisionVersion
      || operation.decisionVersion !== handoff.decisionVersion
      || operation.mode !== legacyRequest.mode
      || operation.mode !== handoff.mode
      || operation.processingKeyHash !== handoff.processingKeyHash
      || canonicalJsonStringify(
        acceptedProcessingKeyHashes(operation).sort()
      ) !== canonicalJsonStringify(
        acceptedProcessingKeyHashes(handoff).sort()
      )
      || operation.existingCustomerId !== legacyRequest.existingCustomerId
      || (legacyRequest.mode === "link_existing"
        && legacyRequest.existingCustomerId !== handoff.customerId)
      || operation.requestHash !== handoff.requestHash
      || operation.requestHash !== digest(canonicalJsonStringify(request))
      || operation.qualificationSnapshotHash
        !== handoff.qualificationSnapshotHash
      || operation.financialSnapshotHash !== handoff.financialSnapshotHash
      || canonicalJsonStringify(operation.intelligence)
        !== canonicalJsonStringify(handoff.intelligence)
      || lead.convertedCustomerId !== customer.id
      || todo.leadId !== lead.id
      || todo.customerId !== customer.id
      || todo.title !== legacyRequest.followUp.title
      || todo.dueAt !== legacyRequest.followUp.dueAt
      || todo.priority !== legacyRequest.followUp.priority) {
      return null;
    }
    return structuredClone(
      request as AcquisitionPrivateDomainHandoffRecoveryRequest
    );
  }

  async get(
    scope: Pick<AcquisitionActorScope, "ownerId" | "teamId">,
    candidateId: string
  ): Promise<AcquisitionPrivateDomainHandoffStatus> {
    await this.#store.readBarrier();
    const handoff = this.#store.acquisitionCustomerHandoffs.find((item) =>
      item.ownerId === scope.ownerId
      && item.teamId === scope.teamId
      && item.candidateId === candidateId
    );
    if (handoff) {
      return this.#completedResult(scope, handoff, false);
    }
    const operation = this.#store.acquisitionCustomerHandoffOperations.find(
      (item) => item.ownerId === scope.ownerId
        && item.teamId === scope.teamId
        && item.candidateId === candidateId
    );
    if (operation) {
      if (!operation.request) {
        throw new AcquisitionPrivateDomainHandoffError(
          "ACQUISITION_HANDOFF_RECOVERY_DATA_MISSING",
          "未完成交接缺少原请求快照，无法安全恢复",
          409
        );
      }
      if (!legacyHandoffRequestSnapshot(operation.request)) {
        throw new AcquisitionPrivateDomainHandoffError(
          "ACQUISITION_HANDOFF_RECOVERY_DATA_MISSING",
          "未完成交接的获客归因固定信息不完整",
          409
        );
      }
      return {
        replayed: false,
        inProgress: {
          id: operation.id,
          candidateId: operation.candidateId,
          decisionVersion: operation.decisionVersion,
          mode: operation.mode,
          existingCustomerId: operation.existingCustomerId,
          stage: operation.stage,
          request: structuredClone(operation.request),
          createdAt: operation.createdAt
        }
      };
    }
    throw new AcquisitionPrivateDomainHandoffError(
      "ACQUISITION_HANDOFF_NOT_FOUND",
      "交接记录不存在",
      404
    );
  }
}

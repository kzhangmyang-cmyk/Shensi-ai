import type {
  AcquisitionBudgetLimit,
  AcquisitionBudgetUsage,
  AcquisitionPlanPayload
} from "./acquisition-plan-run-repository.js";
import {
  isSafeDouyinSearchQuery
} from "./acquisition-douyin-discovery-plan.js";

function nonNegativeInteger(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}

function budgetFields(
  budget: AcquisitionBudgetLimit | AcquisitionBudgetUsage
) {
  return [
    ["requests", "maxRequests"],
    ["results", "maxResults"],
    ["amountMinor", "maxAmountMinor"],
    ["durationSeconds", "maxDurationSeconds"]
  ] as const;
}

export function planReadinessIssues(payload: AcquisitionPlanPayload): string[] {
  const issues: string[] = [];
  const mediaCrawler = payload.executionMode === "douyin_mediacrawler";
  if (!payload.name?.trim()) issues.push("name_required");
  if (!payload.objective?.trim()) issues.push("objective_required");
  if (!payload.subjectChannels?.organization
    || !payload.subjectChannels?.individual) {
    issues.push("dual_subject_channels_required");
  }
  if (!payload.icp?.industries?.length) issues.push("icp_industries_required");
  if (!payload.icp?.regions?.length) issues.push("icp_regions_required");
  if (!payload.icp?.organizationCriteria?.length) {
    issues.push("organization_icp_required");
  }
  if (!payload.icp?.individualCriteria?.length) {
    issues.push("individual_icp_required");
  }
  if (mediaCrawler) {
    if (payload.targetPlatform !== "douyin") {
      issues.push("mediacrawler_douyin_platform_required");
    }
    if (payload.providerConnections?.length) {
      issues.push("mediacrawler_provider_connections_forbidden");
    }
    if (payload.operations?.length) {
      issues.push("mediacrawler_generic_operations_forbidden");
    }
    if (payload.modelSnapshotRef !== null) {
      issues.push("mediacrawler_model_snapshot_forbidden");
    }
  } else {
    if (!payload.providerConnections?.length) {
      issues.push("provider_connection_required");
    }

    const connectionById = new Map(
      (payload.providerConnections ?? []).map((connection) => [
        connection.connectionId,
        connection
      ])
    );
    const connectionIds = new Set<string>();
    for (const connection of payload.providerConnections ?? []) {
      if (!connection.connectionId?.trim()
        || !connection.providerId?.trim()
        || connectionIds.has(connection.connectionId)) {
        issues.push("provider_connection_invalid_or_duplicate");
      }
      connectionIds.add(connection.connectionId);
      if (connection.status !== "active") {
        issues.push(`provider_connection_not_active:${connection.connectionId}`);
      }
      if (!positiveInteger(connection.credentialVersion)) {
        issues.push(
          `provider_credential_version_invalid:${connection.connectionId}`
        );
      }
    }

    if (!payload.operations?.length) issues.push("operation_required");
    const operationIds = new Set<string>();
    const searchChannels = new Set<string>();
    for (const operation of payload.operations ?? []) {
      if (!operation.operationId?.trim()
        || operationIds.has(operation.operationId)) {
        issues.push("operation_id_invalid_or_duplicate");
      }
      operationIds.add(operation.operationId);
      if (operation.kind === "search") {
        searchChannels.add(operation.subjectChannel);
        if (!operation.query?.trim()) {
          issues.push(`search_query_required:${operation.operationId}`);
        } else if (payload.targetPlatform === "douyin"
          && !isSafeDouyinSearchQuery(operation.query)) {
          issues.push(`douyin_search_query_unsafe:${operation.operationId}`);
        }
      } else if (!operation.sourceRef?.trim()) {
        issues.push(`source_ref_required:${operation.operationId}`);
      }
      const connection = connectionById.get(operation.connectionId);
      if (!connection) {
        issues.push(`operation_connection_missing:${operation.operationId}`);
      } else {
        const expectedKind = operation.kind === "import_rows"
          ? "import"
          : operation.kind;
        if (connection.kind !== expectedKind) {
          issues.push(`operation_connection_kind_mismatch:${operation.operationId}`);
        }
        if (connection.status !== "active") {
          issues.push(`operation_connection_inactive:${operation.operationId}`);
        }
      }
      if (!operation.allocatedBudget
        || !budgetFields(operation.allocatedBudget).every(([usageField]) =>
          nonNegativeInteger(operation.allocatedBudget[usageField]))) {
        issues.push(`operation_budget_invalid:${operation.operationId}`);
      }
    }
    if (!searchChannels.has("organization")) {
      issues.push("organization_search_query_required");
    }
    if (!searchChannels.has("individual")) {
      issues.push("individual_search_query_required");
    }
  }

  const allocated = (payload.operations ?? []).reduce(
    (total, operation) => ({
      requests: total.requests + (operation.allocatedBudget?.requests ?? 0),
      results: total.results + (operation.allocatedBudget?.results ?? 0),
      amountMinor:
        total.amountMinor + (operation.allocatedBudget?.amountMinor ?? 0),
      durationSeconds:
        total.durationSeconds
        + (operation.allocatedBudget?.durationSeconds ?? 0)
    }),
    { requests: 0, results: 0, amountMinor: 0, durationSeconds: 0 }
  );

  const budget = payload.budgetSnapshot;
  if (!budget?.billingCurrency?.trim()
    || budget.billingCurrency.trim().length !== 3) {
    issues.push("budget_currency_required");
  }
  if (!budget
    || !positiveInteger(budget.maxRequests)
    || !positiveInteger(budget.maxResults)
    || !nonNegativeInteger(budget.maxAmountMinor)
    || !positiveInteger(budget.maxDurationSeconds)) {
    issues.push("plan_budget_invalid");
  } else if (allocated.requests > budget.maxRequests
    || allocated.results > budget.maxResults
    || allocated.amountMinor > budget.maxAmountMinor
    || allocated.durationSeconds > budget.maxDurationSeconds) {
    issues.push("operation_allocations_exceed_plan_budget");
  }

  const model = payload.modelSnapshotRef;
  if (!mediaCrawler && (!model
    || !model.jobSnapshotId?.trim()
    || !model.connectionId?.trim()
    || !positiveInteger(model.credentialVersion)
    || !model.provider?.trim()
    || !model.model?.trim()
    || !model.capabilitySnapshotHash?.trim()
    || !model.promptVersion?.trim()
    || !model.schemaVersion?.trim()
    || !model.promptHash?.trim()
    || !model.schemaHash?.trim())) {
    issues.push("model_snapshot_invalid");
  }
  return [...new Set(issues)];
}

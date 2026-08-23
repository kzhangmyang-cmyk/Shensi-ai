import { createHash } from "node:crypto";
import type { ModelCallRecord } from "./model-providers/call-ledger.js";
import { parseFinancialCouncilModelCallJobId as parseJobId } from
  "./model-providers/call-ledger.js";
import { MODEL_PROVIDER_IDS, type ModelConnection } from
  "./model-providers/types.js";
import type { ActiveWorkspaceContext } from "./growth-workspace-context.js";

export const FINANCIAL_COUNCIL_MODEL_ROLES = [
  "cfo", "finance", "profit", "cost", "cashflow", "tax"
] as const;

export type FinancialCouncilModelRole =
  (typeof FINANCIAL_COUNCIL_MODEL_ROLES)[number];

export interface FinancialCouncilRoleRoute {
  readonly mode: "auto" | "pinned";
  readonly primaryConnectionId: string | null;
  readonly fallbackConnectionIds: readonly string[];
  readonly preferenceWeightBps: number;
}

export interface FinancialCouncilModelRoutingPolicyInput {
  readonly roles: Readonly<Record<
    FinancialCouncilModelRole,
    FinancialCouncilRoleRoute
  >>;
  readonly maxRunBudgetMinor: number;
  readonly maxRoleBudgetMinor: number;
  readonly requestTimeoutMs: number;
}

export interface FinancialCouncilModelRoutingPolicyVersion
extends FinancialCouncilModelRoutingPolicyInput {
  readonly policyVersionId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly status: "active" | "superseded";
  readonly policyHash: `sha256:${string}`;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface FinancialCouncilModelRoutePreview {
  readonly role: FinancialCouncilModelRole;
  readonly orderedConnectionIds: readonly string[];
  readonly selectedConnectionId: string | null;
  readonly reasonCodes: readonly string[];
  readonly missingCapabilities: readonly string[];
}

export interface FinancialCouncilModelPrice {
  readonly connectionId: string;
  readonly inputTokenPriceMinorPerMillion: number;
  readonly outputTokenPriceMinorPerMillion: number;
  readonly createdAt: string;
}

export interface SelectFinancialCouncilModelRouteInput {
  readonly role: FinancialCouncilModelRole;
  readonly policy: FinancialCouncilModelRoutingPolicyVersion;
  readonly connections: readonly ModelConnection[];
  readonly recentCalls: readonly ModelCallRecord[];
  readonly prices: readonly FinancialCouncilModelPrice[];
  readonly activeWorkspace: ActiveWorkspaceContext;
}

export class FinancialCouncilModelRoutingError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "FinancialCouncilModelRoutingError";
  }
}

function fail(code = "financial_council_model_routing_invalid"): never {
  throw new FinancialCouncilModelRoutingError(code);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Reflect.ownKeys(value);
  return actual.every((key) => typeof key === "string")
    && actual.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function concreteId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && !!value
    && Buffer.byteLength(value, "utf8") <= 160 && value !== "all";
}

function persistedId(value: unknown): value is string {
  return concreteId(value) && /^[!-~]+$/u.test(value) && value.length <= 160;
}

function safeNonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safePositive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function instant(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 32) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (plainObject(value)) {
    return `{${Object.keys(value).sort(utf8Compare).map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail();
  return encoded;
}

function immutable<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => immutable(item))) as T;
  }
  if (plainObject(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(
      ([key, item]) => [key, immutable(item)]
    ))) as T;
  }
  return value;
}

function normalizeRoute(value: unknown): FinancialCouncilRoleRoute {
  if (!plainObject(value) || !exactKeys(value, ["mode",
    "primaryConnectionId", "fallbackConnectionIds", "preferenceWeightBps"])) {
    fail();
  }
  if (value.mode !== "auto" && value.mode !== "pinned") fail();
  const primary = value.primaryConnectionId;
  if (primary !== null && !concreteId(primary)) fail();
  if (!Array.isArray(value.fallbackConnectionIds)
    || value.fallbackConnectionIds.length > 2
    || !value.fallbackConnectionIds.every(concreteId)
    || new Set(value.fallbackConnectionIds).size
      !== value.fallbackConnectionIds.length
    || (primary !== null && value.fallbackConnectionIds.includes(primary))) {
    fail();
  }
  if (!Number.isSafeInteger(value.preferenceWeightBps)
    || (value.preferenceWeightBps as number) < 0
    || (value.preferenceWeightBps as number) > 10_000) fail();
  if (value.mode === "auto"
    && (primary !== null || value.fallbackConnectionIds.length !== 0)) fail();
  if (value.mode === "pinned" && primary === null) fail();
  return Object.freeze({
    mode: value.mode,
    primaryConnectionId: primary as string | null,
    fallbackConnectionIds: Object.freeze([...value.fallbackConnectionIds]),
    preferenceWeightBps: value.preferenceWeightBps as number
  });
}

export function normalizeFinancialCouncilModelRoutingPolicyInput(
  value: unknown
): FinancialCouncilModelRoutingPolicyInput {
  if (!plainObject(value) || !exactKeys(value, ["roles",
    "maxRunBudgetMinor", "maxRoleBudgetMinor", "requestTimeoutMs"])
    || !plainObject(value.roles)
    || !exactKeys(value.roles, FINANCIAL_COUNCIL_MODEL_ROLES)
    || !safeNonNegative(value.maxRunBudgetMinor)
    || !safeNonNegative(value.maxRoleBudgetMinor)
    || value.maxRoleBudgetMinor > value.maxRunBudgetMinor
    || !safePositive(value.requestTimeoutMs)) fail();
  const roleInputs = value.roles;
  const roles = Object.fromEntries(FINANCIAL_COUNCIL_MODEL_ROLES.map(
    (role) => [role, normalizeRoute(roleInputs[role])]
  )) as Record<FinancialCouncilModelRole, FinancialCouncilRoleRoute>;
  return Object.freeze({
    roles: Object.freeze(roles),
    maxRunBudgetMinor: value.maxRunBudgetMinor,
    maxRoleBudgetMinor: value.maxRoleBudgetMinor,
    requestTimeoutMs: value.requestTimeoutMs
  });
}

const VERSION_KEYS = ["policyVersionId", "workspaceId", "revision", "status",
  "roles", "maxRunBudgetMinor", "maxRoleBudgetMinor", "requestTimeoutMs",
  "policyHash", "createdBy", "createdAt"] as const;

function hashFields(value: Omit<FinancialCouncilModelRoutingPolicyVersion,
"policyHash" | "status">): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export function createFinancialCouncilModelRoutingPolicyVersion(input: {
  readonly policyVersionId: string;
  readonly workspaceId: string;
  readonly revision: number;
  readonly status: "active" | "superseded";
  readonly input: FinancialCouncilModelRoutingPolicyInput;
  readonly createdBy: string;
  readonly createdAt: string;
}): FinancialCouncilModelRoutingPolicyVersion {
  if (!plainObject(input) || !exactKeys(input as unknown as Record<string, unknown>,
    ["policyVersionId", "workspaceId", "revision", "status", "input",
      "createdBy", "createdAt"])
    || !persistedId(input.policyVersionId) || !persistedId(input.workspaceId)
    || !safePositive(input.revision)
    || (input.status !== "active" && input.status !== "superseded")
    || !persistedId(input.createdBy) || !instant(input.createdAt)) fail();
  const normalized = normalizeFinancialCouncilModelRoutingPolicyInput(
    input.input
  );
  const fields = {
    policyVersionId: input.policyVersionId,
    workspaceId: input.workspaceId,
    revision: input.revision,
    roles: normalized.roles,
    maxRunBudgetMinor: normalized.maxRunBudgetMinor,
    maxRoleBudgetMinor: normalized.maxRoleBudgetMinor,
    requestTimeoutMs: normalized.requestTimeoutMs,
    createdBy: input.createdBy,
    createdAt: input.createdAt
  };
  return immutable({
    ...fields,
    status: input.status,
    policyHash: hashFields(fields)
  });
}

export function assertFinancialCouncilModelRoutingPolicyVersion(
  value: unknown
): asserts value is FinancialCouncilModelRoutingPolicyVersion {
  if (!plainObject(value) || !exactKeys(value, VERSION_KEYS)
    || !persistedId(value.policyVersionId) || !persistedId(value.workspaceId)
    || !safePositive(value.revision)
    || (value.status !== "active" && value.status !== "superseded")
    || !persistedId(value.createdBy) || !instant(value.createdAt)
    || typeof value.policyHash !== "string"
    || !/^sha256:[0-9a-f]{64}$/u.test(value.policyHash)) {
    fail("financial_council_model_routing_integrity");
  }
  let normalized: FinancialCouncilModelRoutingPolicyInput;
  try {
    normalized = normalizeFinancialCouncilModelRoutingPolicyInput({
      roles: value.roles,
      maxRunBudgetMinor: value.maxRunBudgetMinor,
      maxRoleBudgetMinor: value.maxRoleBudgetMinor,
      requestTimeoutMs: value.requestTimeoutMs
    });
  } catch {
    fail("financial_council_model_routing_integrity");
  }
  const expected = hashFields({
    policyVersionId: value.policyVersionId,
    workspaceId: value.workspaceId,
    revision: value.revision,
    roles: normalized.roles,
    maxRunBudgetMinor: normalized.maxRunBudgetMinor,
    maxRoleBudgetMinor: normalized.maxRoleBudgetMinor,
    requestTimeoutMs: normalized.requestTimeoutMs,
    createdBy: value.createdBy,
    createdAt: value.createdAt
  });
  if (value.policyHash !== expected) {
    fail("financial_council_model_routing_integrity");
  }
}

export function immutableFinancialCouncilModelRoutingPolicyVersion(
  value: FinancialCouncilModelRoutingPolicyVersion
): FinancialCouncilModelRoutingPolicyVersion {
  assertFinancialCouncilModelRoutingPolicyVersion(value);
  return immutable(structuredClone(value));
}

export function financialCouncilModelRoutingCanonicalJson(
  value: FinancialCouncilModelRoutingPolicyVersion
): string {
  assertFinancialCouncilModelRoutingPolicyVersion(value);
  return canonical(value);
}

export function withFinancialCouncilModelRoutingPolicyStatus(
  value: FinancialCouncilModelRoutingPolicyVersion,
  status: "active" | "superseded"
): FinancialCouncilModelRoutingPolicyVersion {
  assertFinancialCouncilModelRoutingPolicyVersion(value);
  return immutable({ ...structuredClone(value), status });
}

export function parseFinancialCouncilModelCallJobId(jobId: string) {
  return parseJobId(jobId);
}

function workspaceMatches(
  scope: Pick<ModelConnection | ModelCallRecord, "ownerId" | "teamId">,
  workspace: ActiveWorkspaceContext
) {
  return workspace.kind === "team"
    ? scope.teamId === workspace.workspaceId
    : scope.ownerId === workspace.actorId && scope.teamId === workspace.teamId;
}

function validConnection(connection: ModelConnection) {
  return concreteId(connection.id)
    && concreteId(connection.ownerId)
    && (connection.teamId === null || concreteId(connection.teamId))
    && MODEL_PROVIDER_IDS.includes(connection.provider)
    && concreteId(connection.model)
    && safePositive(connection.credentialVersion)
    && connection.status === "active"
    && connection.capabilitySnapshot?.structuredOutput === true
    && typeof connection.capabilityCertificationHash === "string"
    && /^sha256:[0-9a-f]{64}$/u.test(connection.capabilityCertificationHash);
}

function validateArrays(input: SelectFinancialCouncilModelRouteInput) {
  if (!FINANCIAL_COUNCIL_MODEL_ROLES.includes(input.role)
    || !Array.isArray(input.connections) || !Array.isArray(input.recentCalls)
    || !Array.isArray(input.prices)) fail();
  for (const [items, key] of [
    [input.connections, "id"], [input.recentCalls, "id"],
    [input.prices, "connectionId"]
  ] as const) {
    const ids = items.map((item) => Reflect.get(item, key));
    if (!ids.every(concreteId) || new Set(ids).size !== ids.length) fail();
  }
  for (const call of input.recentCalls) {
    if (!safeNonNegative(call.latencyMs) || !safeNonNegative(call.inputTokens)
      || !safeNonNegative(call.outputTokens)
      || !safeNonNegative(call.reasoningTokens)
      || !safeNonNegative(call.cost?.amountMinor)
      || !instant(call.createdAt)) fail();
  }
  for (const price of input.prices) {
    if (!plainObject(price) || !exactKeys(price, ["connectionId",
      "inputTokenPriceMinorPerMillion", "outputTokenPriceMinorPerMillion",
      "createdAt"])
      || !safeNonNegative(price.inputTokenPriceMinorPerMillion)
      || !safeNonNegative(price.outputTokenPriceMinorPerMillion)
      || !instant(price.createdAt)) fail();
  }
}

interface CandidateScore {
  readonly connection: ModelConnection;
  readonly score: bigint;
  readonly cost: bigint | null;
}

export function selectFinancialCouncilModelRoute(
  input: SelectFinancialCouncilModelRouteInput
): FinancialCouncilModelRoutePreview {
  assertFinancialCouncilModelRoutingPolicyVersion(input.policy);
  validateArrays(input);
  if (!input.activeWorkspace || input.policy.workspaceId
    !== input.activeWorkspace.workspaceId) fail();
  const eligible = input.connections.filter((connection) =>
    workspaceMatches(connection, input.activeWorkspace)
    && validConnection(connection));
  const route = input.policy.roles[input.role];
  const reasons = ["structured_output_certified"];
  if (eligible.length === 0) {
    return immutable({ role: input.role, orderedConnectionIds: [],
      selectedConnectionId: null, reasonCodes: [],
      missingCapabilities: ["structured_output_certified"] });
  }
  if (route.mode === "pinned") {
    const eligibleIds = new Set(eligible.map((item) => item.id));
    const ordered = [route.primaryConnectionId!, ...route.fallbackConnectionIds]
      .filter((id) => eligibleIds.has(id));
    return immutable({ role: input.role, orderedConnectionIds: ordered,
      selectedConnectionId: ordered[0] ?? null, reasonCodes: reasons,
      missingCapabilities: ordered.length ? [] : ["pinned_connection_eligible"] });
  }
  const calls = [...input.recentCalls].filter((item) => {
    const parsed = parseJobId(item.jobId);
    return parsed?.role === input.role
      && workspaceMatches(item, input.activeWorkspace);
  }).sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt > right.createdAt ? -1 : 1;
    }
    return utf8Compare(left.id, right.id);
  }).slice(0, 30);
  const byConnection = new Map<string, ModelCallRecord[]>();
  for (const item of calls) {
    const values = byConnection.get(item.connectionId) ?? [];
    values.push(item);
    byConnection.set(item.connectionId, values);
  }
  const prices = new Map(input.prices.map((item) => [item.connectionId, item]));
  let anyCalls = false;
  let anyFailures = false;
  const candidates: CandidateScore[] = eligible.map((connection) => {
    const history = byConnection.get(connection.id) ?? [];
    let score = BigInt(route.preferenceWeightBps);
    if (history.length > 0) {
      anyCalls = true;
      const successes = history.filter((item) => item.status === "succeeded")
        .length;
      score += BigInt(Math.floor(successes * 10_000 / history.length));
      const latencies = history.map((item) => item.latencyMs)
        .sort((left, right) => left - right);
      const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]!;
      score -= BigInt(Math.floor(p95 / 10));
    }
    let consecutiveFailures = 0;
    for (const item of history) {
      if (item.status !== "failed") break;
      consecutiveFailures += 1;
    }
    if (consecutiveFailures > 0) {
      anyFailures = true;
      score -= BigInt(consecutiveFailures * 1_000);
    }
    const known = history.filter((item) => item.cost.kind !== "unknown");
    let cost: bigint | null = null;
    if (known.length) {
      cost = known.reduce((sum, item) => sum + BigInt(item.cost.amountMinor),
        0n) / BigInt(known.length);
    } else {
      const price = prices.get(connection.id);
      if (price) cost = BigInt(price.inputTokenPriceMinorPerMillion)
        + BigInt(price.outputTokenPriceMinorPerMillion);
    }
    return { connection, score, cost };
  });
  if (anyCalls) reasons.push("recent_success_rate", "recent_p95_latency");
  const allCostsKnown = candidates.every((item) => item.cost !== null);
  if (allCostsKnown) {
    reasons.push("known_cost");
    for (const candidate of candidates) {
      (candidate as { score: bigint }).score -= candidate.cost!;
    }
  } else reasons.push("cost_unknown");
  if (anyFailures) reasons.push("consecutive_failure_penalty");
  if (route.preferenceWeightBps !== 0) reasons.push("role_preference_weight");
  candidates.sort((left, right) => {
    if (left.score !== right.score) return left.score > right.score ? -1 : 1;
    return utf8Compare(left.connection.id, right.connection.id);
  });
  if (candidates.some((item, index) => index > 0
    && item.score === candidates[index - 1]!.score)) {
    reasons.push("stable_tiebreak");
  }
  const ordered = candidates.map((item) => item.connection.id);
  return immutable({ role: input.role, orderedConnectionIds: ordered,
    selectedConnectionId: ordered[0] ?? null, reasonCodes: reasons,
    missingCapabilities: [] });
}

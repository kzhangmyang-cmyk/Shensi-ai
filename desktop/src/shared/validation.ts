import { DESKTOP_CHANNELS, type DesktopChannel, type DouyinCollectionTask, type DesktopOutreachCoordinatorView } from "./contracts.ts";

const CHANNELS = new Set<string>(Object.values(DESKTOP_CHANNELS));
const NO_ARGUMENT_CHANNELS = new Set<string>([
  DESKTOP_CHANNELS.getRuntimeInfo,
  DESKTOP_CHANNELS.getDesktopInstallationInfo,
  DESKTOP_CHANNELS.getDesktopOutreachStatus,
  DESKTOP_CHANNELS.getConnectorStatus,
  DESKTOP_CHANNELS.restartConnector,
  DESKTOP_CHANNELS.openLogsDirectory,
  DESKTOP_CHANNELS.getAppVersion
]);
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,199}$/u;

function fail(message: string): never { throw new TypeError(message); }
function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plain(value)) fail("IPC value must be a plain object");
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)))
    fail("IPC value has missing or extra fields");
  return value;
}
function safeId(value: unknown, name: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(`${name} is invalid`);
  return value;
}
function accountId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 200)
    fail("accountId is invalid");
  return value;
}
function centralIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || /[\u0000-\u001f\u007f]/u.test(value))
    fail("workspace/account identifier is invalid");
  return value;
}
function account(value: unknown): { accountId: string } {
  const record = exact(value, ["accountId"]);
  return { accountId: accountId(record.accountId) };
}
function identifier(value: unknown, key: "sessionId" | "taskId") {
  const record = exact(value, [key]);
  return { [key]: safeId(record[key], key) };
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)
    || value < min || value > max)
    fail(`${name} is outside its allowed range`);
  return value as number;
}
function collectionTask(value: unknown): DouyinCollectionTask {
  const keys = ["taskId", "loginStateVersion", "keywords", "maxVideos",
    "maxCommentsPerVideo", "maxPagesPerVideo", "collectCreators",
    "collectDemandComments", "deadlineAt"] as const;
  const record = exact(value, plain(value) && "maxComments" in value ? [...keys, "maxComments"] : keys);
  if (!Array.isArray(record.keywords) || record.keywords.length < 1 || record.keywords.length > 20)
    fail("keywords are invalid");
  const keywords = record.keywords.map((item) => typeof item === "string" ? item.trim() : "");
  if (keywords.some((item) => item.length < 1 || [...item].length > 100)) fail("keywords are invalid");
  if (typeof record.collectCreators !== "boolean" || typeof record.collectDemandComments !== "boolean")
    fail("collection flags are invalid");
  if (typeof record.deadlineAt !== "string" || !Number.isFinite(Date.parse(record.deadlineAt))
    || Date.parse(record.deadlineAt) <= Date.now()) fail("deadlineAt must be a future ISO timestamp");
  if (new Date(record.deadlineAt).toISOString() !== record.deadlineAt) fail("deadlineAt must be canonical ISO");
  return {
    taskId: safeId(record.taskId, "taskId"),
    loginStateVersion: integer(record.loginStateVersion, "loginStateVersion", 1, 2_147_483_647),
    keywords,
    maxVideos: integer(record.maxVideos, "maxVideos", 1, 200),
    maxCommentsPerVideo: integer(record.maxCommentsPerVideo, "maxCommentsPerVideo", 1, 200),
    ...(record.maxComments === undefined ? {} : { maxComments: integer(record.maxComments, "maxComments", 1, 10000) }),
    maxPagesPerVideo: integer(record.maxPagesPerVideo, "maxPagesPerVideo", 1, 20),
    collectCreators: record.collectCreators,
    collectDemandComments: record.collectDemandComments,
    deadlineAt: record.deadlineAt
  };
}

export function validateInvoke(channel: string, value: unknown): unknown {
  if (!CHANNELS.has(channel) || channel === DESKTOP_CHANNELS.connectorStatusChanged
    || channel === DESKTOP_CHANNELS.desktopOutreachStatusChanged)
    fail("IPC channel is not invokable");
  if (NO_ARGUMENT_CHANNELS.has(channel)) {
    if (value !== undefined) fail("IPC channel accepts no arguments");
    return undefined;
  }
  if (channel === DESKTOP_CHANNELS.registerDesktopInstallation) {
    const record = exact(value, ["workspaceId", "enrollmentToken"]);
    if (typeof record.enrollmentToken !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(record.enrollmentToken))
      fail("enrollmentToken is invalid");
    return { workspaceId: centralIdentifier(record.workspaceId), enrollmentToken: record.enrollmentToken };
  }
  if (channel === DESKTOP_CHANNELS.recordDesktopBinding) {
    const record = exact(value, ["workspaceId", "accountId", "bindingGeneration"]);
    return { workspaceId: centralIdentifier(record.workspaceId), accountId: centralIdentifier(record.accountId),
      bindingGeneration: integer(record.bindingGeneration, "bindingGeneration", 1, Number.MAX_SAFE_INTEGER) };
  }
  if (channel === DESKTOP_CHANNELS.setDesktopWorkspace) {
    const record = exact(value, ["workspaceId"]);
    return { workspaceId: record.workspaceId === null ? null : centralIdentifier(record.workspaceId) };
  }
  if (channel === DESKTOP_CHANNELS.startDouyinLogin || channel === DESKTOP_CHANNELS.checkDouyinLogin) return account(value);
  if ([DESKTOP_CHANNELS.getDouyinLoginStatus, DESKTOP_CHANNELS.confirmDouyinLogin,
    DESKTOP_CHANNELS.cancelDouyinLogin].includes(channel as never)) return identifier(value, "sessionId");
  if ([DESKTOP_CHANNELS.getDouyinCollectionStatus,
    DESKTOP_CHANNELS.acknowledgeDouyinCollection,
    DESKTOP_CHANNELS.cancelDouyinCollection]
    .includes(channel as never)) return identifier(value, "taskId");
  if (channel === DESKTOP_CHANNELS.controlDouyinCollection) {
    const record = exact(value, ["taskId", "action"]);
    if (!["pause", "resume", "stop"].includes(String(record.action))) fail("invalid collection control");
    return { taskId: safeId(record.taskId, "taskId"), action: record.action };
  }
  if (channel === DESKTOP_CHANNELS.getDouyinCollectionResults) {
    if (!plain(value)) fail("IPC value must be a plain object");
    const keys = value.cursor === undefined ? ["taskId"] : ["taskId", "cursor"];
    const record = exact(value, keys);
    const result: { taskId: string; cursor?: string } = { taskId: safeId(record.taskId, "taskId") };
    if (record.cursor !== undefined) result.cursor = safeId(record.cursor, "cursor");
    return result;
  }
  if (channel === DESKTOP_CHANNELS.startDouyinCollection) {
    const record = exact(value, ["accountId", "task"]);
    return { accountId: accountId(record.accountId), task: collectionTask(record.task) };
  }
  return fail(`Unsupported IPC channel: ${channel}`);
}

export type { DesktopChannel };

export function validateDesktopOutreachView(value: unknown): DesktopOutreachCoordinatorView {
  const record = exact(value, ["state", "diagnostic", "currentActionKind", "updatedAt", "pendingReconciliationCount", "ownership"]);
  if (!["disabled", "unenrolled", "unbound", "offline", "idle", "claiming", "claimed", "executing",
    "reconciling", "risk_paused", "error", "stopping"].includes(record.state as string)
    || ![null, "central_unreachable", "connector_unavailable", "binding_unavailable", "coordinator_error", "risk_paused"].includes(record.diagnostic as null)
    || ![null, "comment", "direct_message"].includes(record.currentActionKind as null)
    || !["unregistered", "unbound", "this_device", "other_device", "unknown"].includes(record.ownership as string))
    fail("desktop outreach status is invalid");
  integer(record.pendingReconciliationCount, "pendingReconciliationCount", 0, Number.MAX_SAFE_INTEGER);
  if (record.updatedAt !== null && (typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))
    || new Date(record.updatedAt).toISOString() !== record.updatedAt)) fail("desktop outreach timestamp is invalid");
  return { ...record } as unknown as DesktopOutreachCoordinatorView;
}

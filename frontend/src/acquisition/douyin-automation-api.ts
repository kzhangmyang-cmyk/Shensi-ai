import type { components, operations } from "../generated/ai-acquisition";
import { csrfFromCookie } from "./csrf";
import type {
  DouyinCollectionActivity,
  DouyinCollectionRecord,
  DouyinCollectionTask
} from "../desktop/desktop-bridge";

export type DouyinPolicyInput = components["schemas"]["DouyinAutomationPolicyInput"];
export type DouyinPolicy = components["schemas"]["DouyinAutomationPolicyResource"];
export type DouyinPolicyVersion = components["schemas"]["DouyinAutomationPolicyVersion"];
export type DouyinRunIntent = components["schemas"]["DouyinAutomationRunIntent"];
export type DouyinCrawlerStatus = components["schemas"]["AcquisitionCrawlerStatus"];
export type DouyinRunCandidate = components["schemas"]["AcquisitionRunCandidate"];
export type DouyinKeywordSuggestions = components["schemas"]["DouyinKeywordSuggestions"];
type GeneratedDouyinLoginSession = operations["getAcquisitionDouyinLoginSession"]["responses"][200]["content"]["application/json"];
export interface DouyinLoginPage {
  imageDataUrl: string;
  width: number;
  height: number;
}
export type DouyinLoginFailureCode =
  | "douyin_login_ui_unsupported"
  | "douyin_verification_required"
  | "douyin_login_page_unavailable"
  | "douyin_login_page_not_allowed"
  | "douyin_browser_unavailable"
  | "douyin_browser_command_timeout"
  | "douyin_login_open_failed";
export type DouyinQrStatus = "opening" | "ready" | "expired" | "network_error"
  | "verification_required";
export type DouyinLoginInteractionSurface = "external_window" | "remote_canvas";
export type DouyinLoginRuntimeState = "stopped" | "starting" | "running" | "crashed";
export type DouyinLoginAuthState = "unknown" | "logged_out" | "waiting_for_user"
  | "verification_required" | "authenticated" | "expired";
export type DouyinLoginTaskState = "idle" | "preparing" | "running" | "cancelling"
  | "completed" | "failed";
export interface DouyinLoginDiagnostic {
  code: string;
  message: string;
  recoverable: boolean;
  occurredAt: string;
}
export type DouyinLoginSession = Omit<GeneratedDouyinLoginSession,
  "loginPage" | "failureCode" | "qrStatus" | "interactionSurface" | "runtimeState"
  | "authState" | "taskState" | "diagnostic" | "screenshotAvailable" | "qrAvailable"> & {
  loginPage: DouyinLoginPage | null;
  failureCode: DouyinLoginFailureCode | null;
  qrStatus: DouyinQrStatus | null;
  /** Missing only while interoperating with a pre-desktop-migration server. */
  interactionSurface?: DouyinLoginInteractionSurface;
  runtimeState?: DouyinLoginRuntimeState;
  authState?: DouyinLoginAuthState;
  taskState?: DouyinLoginTaskState;
  diagnostic?: DouyinLoginDiagnostic | null;
  screenshotAvailable?: boolean;
  qrAvailable?: boolean;
};
export interface DouyinLiveLoginSession {
  socketPath: string;
  expiresAt: string;
}
export type DouyinLoginKey = "Enter" | "Tab" | "Backspace" | "Escape"
  | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight";
export type DouyinLoginInteraction =
  | { type: "click"; normalizedX: number; normalizedY: number }
  | { type: "text"; text: string }
  | { type: "key"; key: DouyinLoginKey }
  | { type: "scroll"; deltaX: number; deltaY: number }
  | { type: "refresh_qr" };
export type DouyinAccountList = operations["listAcquisitionDouyinSocialAccounts"]["responses"][200]["content"]["application/json"];
export type DouyinAccount = DouyinAccountList["items"][number];
export type DouyinCandidatePage = operations["listAcquisitionRunCandidates"]["responses"][200]["content"]["application/json"];
export type DouyinCandidatePageQuery = Pick<NonNullable<
  operations["listAcquisitionRunCandidates"]["parameters"]["query"]
>, "cursor" | "limit">;

export interface DesktopDouyinLoginCompletionInput {
  accountHandle: string;
  displayName: string;
  loginStateVersion: number;
}

export interface DesktopCrawlerTerminalInput {
  state: "succeeded" | "partial";
  failureCode: "crawl_interrupted_after_partial_results" | null;
  activity: DouyinCollectionActivity;
}

export interface DesktopCrawlerPageInput {
  leaseVersion: number;
  cursor: string | null;
  nextCursor: string | null;
  done: boolean;
  records: DouyinCollectionRecord[];
  terminal?: DesktopCrawlerTerminalInput;
}

export interface DesktopCrawlerJobResource {
  jobId: string;
  runId: string;
  state: "scheduled" | "queued" | "running" | "succeeded" | "partial"
    | "paused" | "cancelled" | "failed";
  leaseVersion: number;
  leaseExpiresAt: string | null;
  cursor: string | null;
  recordCount: number;
  ingestionState: "pending" | "running" | "succeeded" | "failed" | null;
  cloudDurable: boolean;
  acknowledgedAt: string | null;
  activity: DouyinCollectionActivity;
}

export interface DesktopCrawlerPageResource extends DesktopCrawlerJobResource {
  replayed: boolean;
}

export interface DesktopRunPreparation {
  run: DouyinRunIntent;
  taskToken: string;
  task: DouyinCollectionTask;
}

export function isDouyinCommentOutreachCandidate(
  candidate: Pick<DouyinRunCandidate, "evidence">
): boolean {
  return /^https:\/\/www\.douyin\.com\/video\/[A-Za-z0-9_-]{1,300}$/u
    .test(candidate.evidence.sourceUrl);
}

export interface DouyinAutomationPlanCreateInput {
  name: string;
  keywords: string[];
  dailyCandidateLimit: number;
}

export interface DouyinAutomationPlanResource {
  id: string;
  name: string;
  status: "draft" | "approved";
  version: number;
  etag: string;
}

export interface AcquisitionHttpErrorDetail {
  path: string;
  code: string;
  message: string;
}

export class AcquisitionHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: readonly AcquisitionHttpErrorDetail[] = []
  ) {
    super(message);
    this.name = "AcquisitionHttpError";
  }
}

export interface DouyinAutomationApi {
  createPlan(input: DouyinAutomationPlanCreateInput, idempotencyKey: string, signal?: AbortSignal): Promise<DouyinAutomationPlanResource>;
  approvePlan(planId: string, etag: string, signal?: AbortSignal): Promise<DouyinAutomationPlanResource>;
  savePlanName(planId: string, name: string, signal?: AbortSignal, keywords?: readonly string[]): Promise<DouyinAutomationPlanResource>;
  listAccounts(signal?: AbortSignal): Promise<DouyinAccountList>;
  createLoginSession(idempotencyKey: string, signal?: AbortSignal): Promise<DouyinLoginSession>;
  getLoginSession(sessionId: string, signal?: AbortSignal): Promise<DouyinLoginSession>;
  interactLoginSession(sessionId: string, input: DouyinLoginInteraction, signal?: AbortSignal): Promise<DouyinLoginSession>;
  cancelLoginSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  disconnectAccount(accountId: string, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<void>;
  getAutomation(planId: string, signal?: AbortSignal): Promise<DouyinPolicy>;
  suggestKeywords(planId: string, idempotencyKey: string, signal?: AbortSignal): Promise<DouyinKeywordSuggestions>;
  putAutomation(planId: string, input: DouyinPolicyInput, etag: string, idempotencyKey: string, signal?: AbortSignal): Promise<DouyinPolicyVersion>;
  runNow(planId: string, idempotencyKey: string, signal?: AbortSignal): Promise<DouyinRunIntent>;
  getCrawlerStatus(runId: string, signal?: AbortSignal): Promise<DouyinCrawlerStatus>;
  listRunCandidates(runId: string, signal?: AbortSignal, query?: DouyinCandidatePageQuery): Promise<DouyinCandidatePage>;
}

export interface DouyinDesktopSyncApi {
  completeDesktopLogin(input: DesktopDouyinLoginCompletionInput,
    idempotencyKey: string, signal?: AbortSignal): Promise<DouyinAccount>;
  prepareDesktopRun(planId: string, idempotencyKey: string,
    signal?: AbortSignal): Promise<DesktopRunPreparation>;
  claimDesktopJob(jobId: string, taskToken: string,
    signal?: AbortSignal): Promise<DesktopCrawlerJobResource>;
  renewDesktopJob(jobId: string, taskToken: string, leaseVersion: number,
    signal?: AbortSignal): Promise<DesktopCrawlerJobResource>;
  uploadDesktopPage(jobId: string, taskToken: string, idempotencyKey: string,
    input: DesktopCrawlerPageInput, signal?: AbortSignal): Promise<DesktopCrawlerPageResource>;
  completeDesktopJob(jobId: string, taskToken: string,
    signal?: AbortSignal): Promise<DesktopCrawlerJobResource>;
  cancelDesktopJob(jobId: string, taskToken: string, leaseVersion: number,
    signal?: AbortSignal): Promise<DesktopCrawlerJobResource>;
}

export interface DouyinLiveLoginApi {
  createLiveLoginSession(sessionId: string, signal?: AbortSignal): Promise<DouyinLiveLoginSession>;
}

export interface DouyinAutomationApiOptions {
  cookie?: string;
  cookieSource?: () => string;
  loginRequestTimeoutMs?: number;
  loginInteractionTimeoutMs?: number;
  cancellationStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

const LOGIN_CANCELLATION_STORAGE_KEY = "shensi.douyin.login-cancellations.v1";

function defaultCancellationStorage(): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function derivedDouyinPlanFields(keywords: readonly string[]) {
  return {
    objective: `通过 MediaCrawler 采集抖音公开内容，发现与 ${keywords.join("、")} 相关的潜在客户`,
    icp: { industries: [...keywords], regions: ["不限地区"],
      organizationCriteria: ["公开内容与手工关键词匹配"],
      individualCriteria: ["公开内容与手工关键词匹配"], exclusionRules: [] as string[] }
  };
}

function derivedDouyinPlanUpdate(payload: Record<string, unknown>, keywords?: readonly string[]) {
  if (!keywords?.length || payload.executionMode !== "douyin_mediacrawler"
    || payload.targetPlatform !== "douyin" || !isRecord(payload.icp)) return null;
  const icp = payload.icp;
  if (!Array.isArray(icp.industries) || !icp.industries.length
    || !icp.industries.every((keyword): keyword is string => typeof keyword === "string")) return null;
  const original = derivedDouyinPlanFields(icp.industries);
  // Only replace the untouched block produced by createPlan. Independent
  // objectives or customized ICP fields must retain their separate meaning.
  if (payload.objective !== original.objective || Object.keys(icp).length !== 5
    || Object.entries(original.icp).some(([field, value]) => JSON.stringify(icp[field]) !== JSON.stringify(value))) return null;
  const next = derivedDouyinPlanFields(keywords.map((keyword) => keyword.trim()).filter(Boolean).slice(0, 20));
  return next.objective !== original.objective
    || JSON.stringify(next.icp.industries) !== JSON.stringify(original.icp.industries) ? next : null;
}

function safeErrorDetails(value: unknown): AcquisitionHttpErrorDetail[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)
      || typeof item.path !== "string"
      || typeof item.code !== "string"
      || typeof item.message !== "string") return [];
    return [{
      path: item.path.slice(0, 160),
      code: item.code.slice(0, 80),
      message: item.message.slice(0, 300)
    }];
  }).slice(0, 10);
}

function safeError(body: unknown, status: number): AcquisitionHttpError {
  const root = isRecord(body) ? body : {};
  const nested = isRecord(root.error) ? root.error : {};
  const code = typeof nested.code === "string" ? nested.code
    : typeof root.code === "string" ? root.code : `http_${status}`;
  const message = typeof nested.message === "string" ? nested.message
    : typeof root.message === "string" ? root.message : `请求失败（HTTP ${status}）`;
  const details = safeErrorDetails(nested.details ?? root.details);
  const firstDetail = details[0];
  const displayMessage = firstDetail
    ? `${message}：${firstDetail.path || "请求内容"}：${firstDetail.message}`
    : message;
  return new AcquisitionHttpError(status, code, displayMessage.slice(0, 300), details);
}

function validString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const forbiddenResponseFieldNames = new Set([
  "cookie",
  "accounthandle",
  "accountkey",
  "browserprofile",
  "profilepath",
  "userdatadir",
  "leasetoken",
  "servicesecret",
  "desktoptasktokenhash",
  "sidecarorigin",
  "sidecartoken",
  "sidecarport"
]);

function normalizedResponseFieldName(name: string): string {
  return name.replace(/[_-]/gu, "").toLocaleLowerCase();
}

function hasForbiddenResponseFieldName(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenResponseFieldName);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([name, nested]) => forbiddenResponseFieldNames.has(normalizedResponseFieldName(name))
    || hasForbiddenResponseFieldName(nested));
}

function assertShape<T>(body: unknown, predicate: (value: Record<string, unknown>) => boolean): T {
  if (hasForbiddenResponseFieldName(body)) {
    throw new AcquisitionHttpError(502, "unsafe_response", "服务器返回了不应向浏览器暴露的字段");
  }
  if (!isRecord(body) || !predicate(body)) {
    throw new AcquisitionHttpError(502, "malformed_response", "服务器返回了无法识别的数据");
  }
  return body as T;
}

function policyShape(value: Record<string, unknown>): boolean {
  return validString(value.planId) && validString(value.etag)
    && Array.isArray(value.keywords) && isRecord(value.schedule)
    && typeof value.dailyCandidateLimit === "number";
}

function loginShape(value: Record<string, unknown>): boolean {
  const failureCodes: readonly DouyinLoginFailureCode[] = [
    "douyin_login_ui_unsupported",
    "douyin_verification_required",
    "douyin_login_page_unavailable",
    "douyin_login_page_not_allowed",
    "douyin_browser_unavailable",
    "douyin_browser_command_timeout",
    "douyin_login_open_failed"
  ];
  const qrStatuses: readonly DouyinQrStatus[] = [
    "opening", "ready", "expired", "network_error", "verification_required"
  ];
  const interactionSurfaces: readonly DouyinLoginInteractionSurface[] = [
    "external_window", "remote_canvas"
  ];
  const runtimeStates: readonly DouyinLoginRuntimeState[] = [
    "stopped", "starting", "running", "crashed"
  ];
  const authStates: readonly DouyinLoginAuthState[] = [
    "unknown", "logged_out", "waiting_for_user", "verification_required",
    "authenticated", "expired"
  ];
  const taskStates: readonly DouyinLoginTaskState[] = [
    "idle", "preparing", "running", "cancelling", "completed", "failed"
  ];
  const hasRuntimeContract = [
    "interactionSurface", "runtimeState", "authState", "taskState", "diagnostic",
    "screenshotAvailable", "qrAvailable"
  ].some((field) => Object.prototype.hasOwnProperty.call(value, field));
  const diagnostic = value.diagnostic;
  const validDiagnostic = diagnostic === null || (isRecord(diagnostic)
    && Object.keys(diagnostic).length === 4
    && validString(diagnostic.code) && diagnostic.code.length <= 100
    && validString(diagnostic.message) && diagnostic.message.length <= 500
    && typeof diagnostic.recoverable === "boolean"
    && validDateTime(diagnostic.occurredAt));
  const validRuntimeContract = !hasRuntimeContract || (
    interactionSurfaces.includes(value.interactionSurface as DouyinLoginInteractionSurface)
    && runtimeStates.includes(value.runtimeState as DouyinLoginRuntimeState)
    && authStates.includes(value.authState as DouyinLoginAuthState)
    && taskStates.includes(value.taskState as DouyinLoginTaskState)
    && Object.prototype.hasOwnProperty.call(value, "diagnostic")
    && validDiagnostic
    && typeof value.screenshotAvailable === "boolean"
    && typeof value.qrAvailable === "boolean"
  );
  return validString(value.id) && value.platform === "douyin"
    && ["awaiting_scan", "active", "login_expired"].includes(String(value.state))
    && Object.prototype.hasOwnProperty.call(value, "qrImageDataUrl")
    && (value.qrImageDataUrl === null
      || (validString(value.qrImageDataUrl) && value.qrImageDataUrl.startsWith("data:image/")))
    && Object.prototype.hasOwnProperty.call(value, "loginPage")
    && (value.loginPage === null || (isRecord(value.loginPage)
      && Object.keys(value.loginPage).length === 3
      && validString(value.loginPage.imageDataUrl)
      && value.loginPage.imageDataUrl.startsWith("data:image/")
      && Number.isSafeInteger(value.loginPage.width) && Number(value.loginPage.width) > 0
      && Number.isSafeInteger(value.loginPage.height) && Number(value.loginPage.height) > 0))
    && Object.prototype.hasOwnProperty.call(value, "failureCode")
    && (value.failureCode === null
      || failureCodes.includes(value.failureCode as DouyinLoginFailureCode))
    && Object.prototype.hasOwnProperty.call(value, "qrStatus")
    && (value.qrStatus === null
      || qrStatuses.includes(value.qrStatus as DouyinQrStatus))
    && validString(value.expiresAt)
    && validRuntimeContract;
}

function planShape(value: Record<string, unknown>): boolean {
  const payload = isRecord(value.payload) ? value.payload : {};
  return validString(value.id) && (validString(value.name) || validString(payload.name))
    && ["draft", "approved"].includes(String(value.status))
    && typeof value.version === "number";
}

function unicodeLength(value: string): number {
  return [...value].length;
}

function validDateTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!parts) return false;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const offsetHour = parts[7] ? Number(parts[8]) : 0;
  const offsetMinute = parts[7] ? Number(parts[9]) : 0;
  if (hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

function crawlerActivityShape(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 4
    || typeof value.phase !== "string"
    || !["queued", "starting_browser", "opening_douyin", "searching",
      "collecting_comments", "finalizing", "completed"].includes(value.phase)
    || (value.currentKeyword !== null
      && (!validString(value.currentKeyword) || unicodeLength(value.currentKeyword) > 100))
    || typeof value.browserMode !== "string"
    || !["visible", "headless"].includes(value.browserMode)
    || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 0) return false;
  return Object.keys(value).every((key) => [
    "phase", "currentKeyword", "browserMode", "sequence"
  ].includes(key));
}

function crawlerStatusShape(value: Record<string, unknown>, runId: string): boolean {
  const keys = [
    "runId", "state", "attempt", "cursorPersisted", "recordCount",
    "candidateBudgetUsed", "candidateBudgetLimit", "candidateProjectionState", "lastErrorCode",
    "createdAt", "updatedAt", "completedAt", "activity"
  ];
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && value.runId === runId
    && typeof value.state === "string"
    && ["scheduled", "queued", "running", "succeeded", "partial", "paused", "cancelled", "failed"].includes(value.state)
    && Number.isSafeInteger(value.attempt) && Number(value.attempt) >= 0
    && typeof value.cursorPersisted === "boolean"
    && Number.isSafeInteger(value.recordCount) && Number(value.recordCount) >= 0
    && Number.isSafeInteger(value.candidateBudgetUsed) && Number(value.candidateBudgetUsed) >= 0
    && (value.candidateBudgetLimit === null || (Number.isSafeInteger(value.candidateBudgetLimit)
      && Number(value.candidateBudgetLimit) >= 1 && Number(value.candidateBudgetLimit) <= 200))
    && typeof value.candidateProjectionState === "string"
    && ["pending", "ready", "failed"].includes(value.candidateProjectionState)
    && (value.lastErrorCode === null
      || (typeof value.lastErrorCode === "string" && unicodeLength(value.lastErrorCode) <= 100))
    && validDateTime(value.createdAt) && validDateTime(value.updatedAt)
    && (value.completedAt === null || validDateTime(value.completedAt))
    && crawlerActivityShape(value.activity);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function exactKeysWithOptional(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): boolean {
  const allowed = new Set([...required, ...optional]);
  return Object.keys(value).every((key) => allowed.has(key))
    && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && unicodeLength(value) <= maxLength;
}

function nonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && unicodeLength(value) > 0 && unicodeLength(value) <= maxLength;
}

function publicHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0
    || !/^https?:\/\/[^/\\?#]/i.test(value)
    || value.includes("\\")
    || /[\p{White_Space}\p{Cc}\p{Cf}]/u.test(value)
    || /%(?![0-9A-Fa-f]{2})/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.hostname.length > 0
      && parsed.username.length === 0
      && parsed.password.length === 0;
  } catch { return false; }
}

function publicHttpsImageUrl(value: unknown): value is string {
  return boundedString(value, 2_000)
    && value.length > 0
    && /^https:\/\/[^/\\?#]/iu.test(value)
    && !value.includes("\\")
    && !/[\p{White_Space}\p{Cc}\p{Cf}]/u.test(value)
    && !/%(?![0-9A-Fa-f]{2})/u.test(value)
    && (() => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:"
          && parsed.hostname.length > 0
          && parsed.username.length === 0
          && parsed.password.length === 0;
      } catch { return false; }
    })();
}

function candidateEvidenceShape(value: unknown): boolean {
  return isRecord(value)
    && exactKeys(value, ["sourceUrl", "excerpt"])
    && publicHttpUrl(value.sourceUrl)
    && boundedString(value.excerpt, 500);
}

function runCandidateShape(value: unknown): boolean {
  return isRecord(value)
    && exactKeysWithOptional(value, ["id", "status", "displayName", "evidence"], [
      "avatarUrl", "coverUrl"
    ])
    && validString(value.id)
    && validString(value.status)
    && boundedString(value.displayName, 200)
    && candidateEvidenceShape(value.evidence)
    && (value.avatarUrl === undefined || publicHttpsImageUrl(value.avatarUrl))
    && (value.coverUrl === undefined || publicHttpsImageUrl(value.coverUrl));
}

function runCandidatePageShape(value: Record<string, unknown>): boolean {
  return exactKeys(value, ["items", "nextCursor"])
    && Array.isArray(value.items) && value.items.length <= 100
    && value.items.every(runCandidateShape)
    && (value.nextCursor === null || nonEmptyBoundedString(value.nextCursor, 8_192));
}

function liveLoginShape(value: Record<string, unknown>): boolean {
  return exactKeys(value, ["socketPath", "expiresAt"])
    && nonEmptyBoundedString(value.socketPath, 2_048)
    && value.socketPath.startsWith("/")
    && !value.socketPath.startsWith("//")
    && !value.socketPath.includes("\\")
    && validDateTime(value.expiresAt);
}

function publicAccountShape(value: Record<string, unknown>): boolean {
  return exactKeys(value, ["id", "workspaceId", "platform", "displayName", "state",
    "loginStateVersion", "revision", "etag", "lastValidatedAt", "createdAt", "updatedAt"])
    && nonEmptyBoundedString(value.id, 255)
    && nonEmptyBoundedString(value.workspaceId, 255)
    && value.platform === "douyin"
    && (value.displayName === null || boundedString(value.displayName, 100))
    && ["awaiting_scan", "active", "login_expired", "risk_paused", "disconnected"]
      .includes(String(value.state))
    && (value.loginStateVersion === null
      || Number.isSafeInteger(value.loginStateVersion) && Number(value.loginStateVersion) >= 1)
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 1
    && nonEmptyBoundedString(value.etag, 255)
    && (value.lastValidatedAt === null || validDateTime(value.lastValidatedAt))
    && validDateTime(value.createdAt) && validDateTime(value.updatedAt);
}

function runIntentShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return exactKeys(value, ["id", "acquisitionRunId", "workspaceId", "planId",
    "planVersionId", "planVersion", "planSnapshotHash", "policyVersionId",
    "policyHash", "accountId", "accountLoginStateVersion", "dailyBudgetId",
    "localDate", "trigger", "collectCreators", "collectDemandComments", "status",
    "reason", "createdBy", "createdAt"])
    && [value.id, value.acquisitionRunId, value.workspaceId, value.planId,
      value.planVersionId, value.planSnapshotHash, value.policyVersionId,
      value.policyHash, value.accountId, value.dailyBudgetId, value.createdBy]
      .every((item) => nonEmptyBoundedString(item, 255))
    && Number.isSafeInteger(value.planVersion) && Number(value.planVersion) >= 1
    && Number.isSafeInteger(value.accountLoginStateVersion)
    && Number(value.accountLoginStateVersion) >= 1
    && /^\d{4}-\d{2}-\d{2}$/u.test(String(value.localDate))
    && ["scheduled", "run_now"].includes(String(value.trigger))
    && typeof value.collectCreators === "boolean"
    && typeof value.collectDemandComments === "boolean"
    && value.status === "queued"
    && (value.reason === null || boundedString(value.reason, 2_000))
    && validDateTime(value.createdAt);
}

function collectionTaskShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return exactKeysWithOptional(value, ["taskId", "loginStateVersion", "keywords", "maxVideos",
    "maxCommentsPerVideo", "maxPagesPerVideo", "collectCreators",
    "collectDemandComments", "deadlineAt"], ["maxComments"])
    && (value.maxComments === undefined || (Number.isSafeInteger(value.maxComments)
      && Number(value.maxComments) >= 1 && Number(value.maxComments) <= 10000))
    && nonEmptyBoundedString(value.taskId, 255)
    && Number.isSafeInteger(value.loginStateVersion) && Number(value.loginStateVersion) >= 1
    && Array.isArray(value.keywords) && value.keywords.length >= 1 && value.keywords.length <= 20
    && value.keywords.every((item) => nonEmptyBoundedString(item, 100))
    && Number.isSafeInteger(value.maxVideos) && Number(value.maxVideos) >= 1
    && Number(value.maxVideos) <= 200
    && Number.isSafeInteger(value.maxCommentsPerVideo)
    && Number(value.maxCommentsPerVideo) >= 1 && Number(value.maxCommentsPerVideo) <= 200
    && Number.isSafeInteger(value.maxPagesPerVideo)
    && Number(value.maxPagesPerVideo) >= 1 && Number(value.maxPagesPerVideo) <= 20
    && typeof value.collectCreators === "boolean"
    && typeof value.collectDemandComments === "boolean"
    && validDateTime(value.deadlineAt);
}

function desktopPreparationShape(value: Record<string, unknown>): boolean {
  return exactKeys(value, ["run", "taskToken", "task"])
    && runIntentShape(value.run)
    && nonEmptyBoundedString(value.taskToken, 512)
    && String(value.taskToken).length >= 32
    && /^[A-Za-z0-9_-]+$/u.test(String(value.taskToken))
    && collectionTaskShape(value.task)
    && (value.run as Record<string, unknown>).accountLoginStateVersion
      === (value.task as Record<string, unknown>).loginStateVersion;
}

function desktopJobShape(value: Record<string, unknown>, replayField: boolean): boolean {
  const keys = ["jobId", "runId", "state", "leaseVersion", "leaseExpiresAt",
    "cursor", "recordCount", "ingestionState", "cloudDurable", "acknowledgedAt",
    "activity", ...(replayField ? ["replayed"] : [])];
  return exactKeys(value, keys)
    && nonEmptyBoundedString(value.jobId, 255)
    && nonEmptyBoundedString(value.runId, 255)
    && ["scheduled", "queued", "running", "succeeded", "partial", "paused",
      "cancelled", "failed"].includes(String(value.state))
    && Number.isSafeInteger(value.leaseVersion) && Number(value.leaseVersion) >= 0
    && (value.leaseExpiresAt === null || validDateTime(value.leaseExpiresAt))
    && (value.cursor === null || boundedString(value.cursor, 512))
    && Number.isSafeInteger(value.recordCount) && Number(value.recordCount) >= 0
    && (value.ingestionState === null
      || ["pending", "running", "succeeded", "failed"].includes(String(value.ingestionState)))
    && typeof value.cloudDurable === "boolean"
    && value.cloudDurable === (value.ingestionState === "succeeded")
    && (value.acknowledgedAt === null || validDateTime(value.acknowledgedAt))
    && crawlerActivityShape(value.activity)
    && (!replayField || typeof value.replayed === "boolean");
}

export function createDouyinAutomationApi(
  fetchImpl: typeof fetch = fetch,
  options: DouyinAutomationApiOptions = {}
): DouyinAutomationApi & DouyinLiveLoginApi & DouyinDesktopSyncApi {
  const cookieSource = options.cookieSource ?? (() => options.cookie
    ?? (typeof document === "undefined" ? "" : document.cookie));
  const loginRequestTimeoutMs = Number.isFinite(options.loginRequestTimeoutMs)
    ? Math.max(1, Math.trunc(options.loginRequestTimeoutMs!))
    : 15_000;
  const loginInteractionTimeoutMs = Number.isFinite(options.loginInteractionTimeoutMs)
    ? Math.max(1, Math.trunc(options.loginInteractionTimeoutMs!))
    : 75_000;
  const cancellationStorage = options.cancellationStorage === undefined
    ? defaultCancellationStorage()
    : options.cancellationStorage;
  const readPendingCancellations = (): string[] => {
    if (!cancellationStorage) return [];
    try {
      const value: unknown = JSON.parse(
        cancellationStorage.getItem(LOGIN_CANCELLATION_STORAGE_KEY) ?? "[]"
      );
      return Array.isArray(value)
        ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))]
        : [];
    } catch {
      return [];
    }
  };
  const writePendingCancellations = (sessionIds: readonly string[]) => {
    if (!cancellationStorage) return;
    try {
      if (sessionIds.length === 0) cancellationStorage.removeItem(LOGIN_CANCELLATION_STORAGE_KEY);
      else cancellationStorage.setItem(LOGIN_CANCELLATION_STORAGE_KEY, JSON.stringify(sessionIds));
    } catch {
      // Storage can be unavailable in hardened/private browser contexts. The
      // keepalive request below remains the best available cleanup attempt.
    }
  };
  const rememberCancellation = (sessionId: string) => {
    writePendingCancellations([...new Set([...readPendingCancellations(), sessionId])]);
  };
  const forgetCancellation = (sessionId: string) => {
    writePendingCancellations(readPendingCancellations().filter((id) => id !== sessionId));
  };

  async function boundedFetch(
    path: string,
    init: RequestInit,
    timeoutMs?: number
  ): Promise<Response> {
    if (timeoutMs === undefined) return fetchImpl(path, init);
    const controller = new AbortController();
    const upstreamSignal = init.signal;
    let timedOut = false;
    const forwardAbort = () => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) forwardAbort();
    else upstreamSignal?.addEventListener("abort", forwardAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException("Request timed out", "TimeoutError"));
    }, timeoutMs);
    try {
      return await fetchImpl(path, { ...init, signal: controller.signal });
    } catch (error) {
      if (timedOut) {
        throw new AcquisitionHttpError(408, "request_timeout", "请求超时，请重试。");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  async function request<T>(
    path: string,
    init: RequestInit,
    validate: (value: Record<string, unknown>) => boolean,
    timeoutMs?: number
  ): Promise<T> {
    const response = await boundedFetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init.headers ?? {}) }
    }, timeoutMs);
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) throw safeError(body, response.status);
    return assertShape<T>(body, validate);
  }

  async function requestVoid(path: string, init: RequestInit, timeoutMs?: number): Promise<void> {
    const response = await boundedFetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init.headers ?? {}) }
    }, timeoutMs);
    if (response.ok) return;
    const body = await response.json().catch(() => null) as unknown;
    throw safeError(body, response.status);
  }

  async function requestPlan(path: string, init: RequestInit,
    inspectPayload?: (payload: Record<string, unknown>) => void): Promise<DouyinAutomationPlanResource> {
    const response = await boundedFetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { accept: "application/json", ...(init.headers ?? {}) }
    });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) throw safeError(body, response.status);
    const plan = assertShape<Record<string, unknown>>(body, planShape);
    const etag = response.headers.get("etag");
    if (!etag) throw new AcquisitionHttpError(502, "malformed_response", "服务器返回的计划缺少 ETag");
    const payload = isRecord(plan.payload) ? plan.payload : {};
    inspectPayload?.(payload);
    return {
      id: String(plan.id),
      name: String(validString(plan.name) ? plan.name : payload.name),
      status: plan.status as DouyinAutomationPlanResource["status"],
      version: Number(plan.version),
      etag
    };
  }

  const writeHeaders = (idempotencyKey: string, etag?: string) => ({
    "content-type": "application/json",
    "Idempotency-Key": idempotencyKey,
    "X-CSRF-Token": csrfFromCookie(cookieSource()),
    ...(etag ? { "If-Match": etag } : {})
  });
  const desktopTaskHeaders = (taskToken: string, idempotencyKey?: string) => ({
    "content-type": "application/json",
    "X-CSRF-Token": csrfFromCookie(cookieSource()),
    "X-Shensi-Desktop-Task-Token": taskToken,
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {})
  });

  return {
    createPlan(input, idempotencyKey, signal) {
      const keywords = input.keywords.map((keyword) => keyword.trim()).filter(Boolean).slice(0, 20);
      const name = input.name.trim().slice(0, 200);
      const dailyCandidateLimit = Math.max(1, Math.min(200, Math.trunc(input.dailyCandidateLimit)));
      return requestPlan("/api/v1/acquisition/plans", {
        method: "POST", signal, headers: writeHeaders(idempotencyKey),
        body: JSON.stringify({
          executionMode: "douyin_mediacrawler",
          targetPlatform: "douyin",
          name,
          ...derivedDouyinPlanFields(keywords),
          subjectChannels: { organization: true, individual: true },
          providerConnections: [],
          operations: [],
          budgetSnapshot: {
            billingCurrency: "CNY",
            maxRequests: 1,
            maxResults: dailyCandidateLimit,
            maxAmountMinor: 0,
            maxDurationSeconds: 3_600
          },
          stopConditions: { stopWhenBudgetExhausted: true, stopWhenNoMoreResults: true }
        })
      });
    },
    async savePlanName(planId, inputName, signal, keywords) {
      const name = inputName.trim().slice(0, 200);
      if (!name) throw new AcquisitionHttpError(400, "plan_name_required", "请输入计划名称");
      const path = `/api/v1/acquisition/plans/${segment(planId)}`;
      let payload: Record<string, unknown> = {};
      const inspectPayload = (value: Record<string, unknown>) => { payload = value; };
      let plan = await requestPlan(path, { method: "GET", signal }, inspectPayload);
      signal?.throwIfAborted();
      if (plan.id !== planId) throw new AcquisitionHttpError(502, "malformed_response", "服务器返回的计划不匹配");
      const derivedUpdate = derivedDouyinPlanUpdate(payload, keywords);
      if (plan.name !== name || derivedUpdate) {
        const patch: operations["updateAcquisitionPlan"]["requestBody"]["content"]["application/json"] = { name, ...derivedUpdate };
        plan = await requestPlan(plan.status === "approved" ? `${path}/revisions` : path, {
          method: plan.status === "approved" ? "POST" : "PATCH", signal,
          headers: { "content-type": "application/json", "X-CSRF-Token": csrfFromCookie(cookieSource()),
            "If-Match": plan.etag },
          body: JSON.stringify(patch)
        }, inspectPayload);
        signal?.throwIfAborted();
        if (plan.id !== planId || plan.name !== name || plan.status !== "draft") {
          throw new AcquisitionHttpError(502, "malformed_response", "服务器返回的计划修订不匹配");
        }
        if (derivedUpdate && (payload.objective !== derivedUpdate.objective || !isRecord(payload.icp)
          || Object.entries(derivedUpdate.icp).some(([field, value]) => JSON.stringify((payload.icp as Record<string, unknown>)[field]) !== JSON.stringify(value)))) {
          throw new AcquisitionHttpError(502, "malformed_response", "服务器返回的计划目标修订不匹配");
        }
      }
      const approved = plan.status === "approved" ? plan : await this.approvePlan(planId, plan.etag, signal);
      signal?.throwIfAborted();
      if (approved.id !== planId || approved.name !== name || approved.status !== "approved") {
        throw new AcquisitionHttpError(502, "malformed_response", "服务器返回的计划审批不匹配");
      }
      return approved;
    },
    approvePlan(planId, etag, signal) {
      return requestPlan(`/api/v1/acquisition/plans/${segment(planId)}/approval`, {
        method: "POST", signal,
        headers: {
          "content-type": "application/json",
          "X-CSRF-Token": csrfFromCookie(cookieSource()),
          "If-Match": etag
        },
        body: JSON.stringify({ decision: "approve", reason: "启用 MediaCrawler 抖音自动采集" })
      });
    },
    async listAccounts(signal) {
      for (const sessionId of readPendingCancellations()) {
        try {
          await requestVoid(
            `/api/v1/acquisition/social-accounts/douyin/login-sessions/${segment(sessionId)}`,
            { method: "DELETE", signal, keepalive: true,
              headers: { "X-CSRF-Token": csrfFromCookie(cookieSource()) } },
            loginRequestTimeoutMs
          );
          forgetCancellation(sessionId);
        } catch (error) {
          if (error instanceof AcquisitionHttpError && error.status === 404) {
            forgetCancellation(sessionId);
          }
        }
      }
      return request("/api/v1/acquisition/social-accounts/douyin", { method: "GET", signal },
        (value) => Array.isArray(value.items));
    },
    createLoginSession(idempotencyKey, signal) {
      return request("/api/v1/acquisition/social-accounts/douyin/login-sessions", {
        method: "POST", signal, headers: writeHeaders(idempotencyKey),
        body: JSON.stringify({ platform: "douyin" })
      }, loginShape, loginRequestTimeoutMs);
    },
    getLoginSession(sessionId, signal) {
      return request(`/api/v1/acquisition/social-accounts/douyin/login-sessions/${segment(sessionId)}`,
        { method: "GET", signal }, loginShape, loginRequestTimeoutMs);
    },
    createLiveLoginSession(sessionId, signal) {
      return request(
        `/api/v1/acquisition/social-accounts/douyin/login-sessions/${segment(sessionId)}/live`,
        {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            "X-CSRF-Token": csrfFromCookie(cookieSource())
          },
          body: "{}"
        },
        liveLoginShape,
        loginRequestTimeoutMs
      );
    },
    interactLoginSession(sessionId, input, signal) {
      return request(`/api/v1/acquisition/social-accounts/douyin/login-sessions/${segment(sessionId)}/interactions`, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "X-CSRF-Token": csrfFromCookie(cookieSource())
        },
        body: JSON.stringify(input)
      }, loginShape, loginInteractionTimeoutMs);
    },
    async cancelLoginSession(sessionId, signal) {
      rememberCancellation(sessionId);
      try {
        await requestVoid(
        `/api/v1/acquisition/social-accounts/douyin/login-sessions/${segment(sessionId)}`,
        {
          method: "DELETE",
          signal,
          keepalive: true,
          headers: { "X-CSRF-Token": csrfFromCookie(cookieSource()) }
        },
        loginRequestTimeoutMs
      );
        forgetCancellation(sessionId);
      } catch (error) {
        if (error instanceof AcquisitionHttpError && error.status === 404) {
          forgetCancellation(sessionId);
          return;
        }
        throw error;
      }
    },
    async disconnectAccount(accountId, etag, idempotencyKey, signal) {
      await request(`/api/v1/acquisition/social-accounts/${segment(accountId)}`, {
        method: "DELETE", signal, headers: writeHeaders(idempotencyKey, etag)
      }, (value) => validString(value.id) && value.state === "disconnected");
    },
    getAutomation(planId, signal) {
      return request(`/api/v1/acquisition/plans/${segment(planId)}/automation`,
        { method: "GET", signal }, policyShape);
    },
    suggestKeywords(planId, idempotencyKey, signal) {
      return request(`/api/v1/acquisition/plans/${segment(planId)}/automation/keyword-suggestions`, {
        method: "POST", signal, headers: writeHeaders(idempotencyKey), body: "{}"
      }, (value) => Array.isArray(value.keywords) && validString(value.modelSnapshotId));
    },
    putAutomation(planId, input, etag, idempotencyKey, signal) {
      const closed: DouyinPolicyInput = {
        keywords: [...input.keywords],
        schedule: { enabled: input.schedule.enabled, localTime: input.schedule.localTime, timeZone: input.schedule.timeZone },
        dailyCandidateLimit: input.dailyCandidateLimit,
        collectCreators: input.collectCreators,
        collectDemandComments: input.collectDemandComments,
        limits: { ...input.limits }
      };
      return request(`/api/v1/acquisition/plans/${segment(planId)}/automation`, {
        method: "PUT", signal, headers: writeHeaders(idempotencyKey, etag), body: JSON.stringify(closed)
      }, policyShape);
    },
    runNow(planId, idempotencyKey, signal) {
      return request(`/api/v1/acquisition/plans/${segment(planId)}/run-now`, {
        method: "POST", signal, headers: writeHeaders(idempotencyKey), body: "{}"
      }, (value) => validString(value.id) && validString(value.acquisitionRunId) && value.status === "queued");
    },
    completeDesktopLogin(input, idempotencyKey, signal) {
      const closed: DesktopDouyinLoginCompletionInput = {
        accountHandle: input.accountHandle,
        displayName: input.displayName,
        loginStateVersion: input.loginStateVersion
      };
      return request(
        "/api/v1/acquisition/social-accounts/douyin/desktop-login-completions",
        { method: "POST", signal, headers: writeHeaders(idempotencyKey),
          body: JSON.stringify(closed) },
        publicAccountShape
      );
    },
    prepareDesktopRun(planId, idempotencyKey, signal) {
      return request(`/api/v1/acquisition/plans/${segment(planId)}/desktop-run-now`, {
        method: "POST", signal, headers: writeHeaders(idempotencyKey), body: "{}"
      }, desktopPreparationShape);
    },
    claimDesktopJob(jobId, taskToken, signal) {
      return request(`/api/v1/acquisition/desktop-crawler-jobs/${segment(jobId)}/claim`, {
        method: "POST", signal, headers: desktopTaskHeaders(taskToken), body: "{}"
      }, (value) => desktopJobShape(value, false));
    },
    renewDesktopJob(jobId, taskToken, leaseVersion, signal) {
      return request(`/api/v1/acquisition/desktop-crawler-jobs/${segment(jobId)}/lease`, {
        method: "PUT", signal, headers: desktopTaskHeaders(taskToken),
        body: JSON.stringify({ leaseVersion })
      }, (value) => desktopJobShape(value, false));
    },
    uploadDesktopPage(jobId, taskToken, idempotencyKey, input, signal) {
      return request(`/api/v1/acquisition/desktop-crawler-jobs/${segment(jobId)}/pages`, {
        method: "PUT", signal,
        headers: desktopTaskHeaders(taskToken, idempotencyKey),
        body: JSON.stringify(input)
      }, (value) => desktopJobShape(value, true));
    },
    completeDesktopJob(jobId, taskToken, signal) {
      return request(`/api/v1/acquisition/desktop-crawler-jobs/${segment(jobId)}/complete`, {
        method: "POST", signal, headers: desktopTaskHeaders(taskToken), body: "{}"
      }, (value) => desktopJobShape(value, false));
    },
    cancelDesktopJob(jobId, taskToken, leaseVersion, signal) {
      return request(`/api/v1/acquisition/desktop-crawler-jobs/${segment(jobId)}/cancel`, {
        method: "POST", signal, headers: desktopTaskHeaders(taskToken),
        body: JSON.stringify({ leaseVersion })
      }, (value) => desktopJobShape(value, false));
    },
    getCrawlerStatus(runId, signal) {
      return request(`/api/v1/acquisition/runs/${segment(runId)}/crawler-status`, { method: "GET", signal },
        (value) => crawlerStatusShape(value, runId));
    },
    listRunCandidates(runId, signal, query) {
      const params = new URLSearchParams();
      if (query?.cursor !== undefined) params.set("cursor", query.cursor);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      const suffix = params.size > 0 ? `?${params}` : "";
      return request(`/api/v1/acquisition/runs/${segment(runId)}/candidates${suffix}`, { method: "GET", signal },
        runCandidatePageShape);
    }
  };
}

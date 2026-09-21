import type { DesktopOutreachBridge } from "../../../desktop/src/shared/contracts";
export type { DesktopOutreachCoordinatorView } from "../../../desktop/src/shared/contracts";
export type ConnectorState = "starting" | "ready" | "crashed" | "stopped";

export interface DesktopDiagnostic {
  code: string;
  message: string;
  recoverable: boolean;
  occurredAt: string;
}

export interface DesktopRuntimeInfo {
  platform: "darwin";
  architecture: "arm64" | "x64";
  appVersion: string;
  environment: "development" | "production" | "test";
  connectorStatus: ConnectorStatus;
}

export interface ConnectorStatus {
  state: ConnectorState;
  protocolVersion: number | null;
  diagnostic: DesktopDiagnostic | null;
}

export interface DouyinLoginStatus {
  sessionId: string;
  state: "awaiting_scan" | "active" | "expired" | "failed";
  interactionSurface: "external_window";
  runtimeState: "stopped" | "starting" | "running" | "crashed";
  authState: "unknown" | "logged_out" | "waiting_for_user" | "verification_required" | "authenticated" | "expired";
  taskState: "idle" | "preparing" | "running" | "cancelling" | "completed" | "failed";
  diagnostic: DesktopDiagnostic | null;
  expiresAt: string;
  accountHandle: string | null;
  accountDisplayName: string | null;
  loginStateVersion: number | null;
  failureCode: string | null;
}

export interface DouyinCollectionTask {
  taskId: string;
  loginStateVersion: number;
  keywords: string[];
  maxVideos: number;
  maxCommentsPerVideo: number;
  maxComments?: number;
  maxPagesPerVideo: number;
  collectCreators: boolean;
  collectDemandComments: boolean;
  deadlineAt: string;
}

export interface DouyinCollectionStatus {
  taskId: string;
  state: "queued" | "running" | "succeeded" | "partial" | "paused" | "cancelled" | "failed";
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  acknowledgedAt: string | null;
  recordCount: number;
  commentCount?: number | null;
  commentTarget?: number | null;
  controlState?: "running" | "pausing" | "paused" | "stopping";
  pageCount: number;
  failureCode: string | null;
  activity: DouyinCollectionActivity;
}
export interface DouyinCollectionActivity {
  phase: "queued" | "starting_browser" | "opening_douyin" | "searching" | "collecting_comments" | "finalizing" | "completed";
  currentKeyword: string | null;
  browserMode: "visible" | "headless";
  sequence: number;
}
export interface DouyinCollectionRecord {
  recordId: string;
  kind: "video" | "creator" | "comment";
  actorKind: "creator" | "commenter" | null;
  canonicalUrl: string;
  publicDisplayName: string;
  publicProfileUrl: string | null;
  textExcerpt: string;
  sourceKeyword: string;
  observedAt: string;
  contentHash: string;
}
export interface DouyinCollectionPage {
  taskId: string;
  cursor: string | null;
  nextCursor: string | null;
  done: boolean;
  records: DouyinCollectionRecord[];
}

export interface ShensiDesktopApi extends DesktopOutreachBridge {
  getRuntimeInfo(): Promise<DesktopRuntimeInfo>;
  getConnectorStatus(): Promise<ConnectorStatus>;
  restartConnector(): Promise<ConnectorStatus>;
  startDouyinLogin(accountId: string): Promise<DouyinLoginStatus>;
  checkDouyinLogin(accountId: string): Promise<import("../../../desktop/src/shared/contracts").DouyinAccountIdentity>;
  getDouyinLoginStatus(sessionId: string): Promise<DouyinLoginStatus>;
  confirmDouyinLogin(sessionId: string): Promise<DouyinLoginStatus>;
  cancelDouyinLogin(sessionId: string): Promise<void>;
  startDouyinCollection(accountId: string, task: DouyinCollectionTask): Promise<DouyinCollectionStatus>;
  getDouyinCollectionStatus(taskId: string): Promise<DouyinCollectionStatus>;
  getDouyinCollectionResults(taskId: string, cursor?: string): Promise<DouyinCollectionPage>;
  acknowledgeDouyinCollection(taskId: string): Promise<void>;
  cancelDouyinCollection(taskId: string): Promise<void>;
  controlDouyinCollection?(taskId: string, action: "pause" | "resume" | "stop"): Promise<DouyinCollectionStatus>;
  openLogsDirectory(): Promise<void>;
  getAppVersion(): Promise<string>;
  onConnectorStatus(listener: (status: ConnectorStatus) => void): () => void;
}

const REQUIRED_METHODS = [
  "getRuntimeInfo", "getConnectorStatus", "restartConnector", "startDouyinLogin", "checkDouyinLogin",
  "getDouyinLoginStatus", "confirmDouyinLogin", "cancelDouyinLogin",
  "startDouyinCollection", "getDouyinCollectionStatus", "getDouyinCollectionResults",
  "acknowledgeDouyinCollection", "cancelDouyinCollection", "openLogsDirectory",
  "getAppVersion", "onConnectorStatus", "getDesktopInstallationInfo",
  "registerDesktopInstallation", "recordDesktopBinding", "setDesktopWorkspace",
  "getDesktopOutreachStatus", "onDesktopOutreachStatusChanged"
] as const satisfies readonly (keyof ShensiDesktopApi)[];

export function getDesktopBridge(value: unknown): ShensiDesktopApi | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { shensiDesktop?: unknown }).shensiDesktop;
  if (!candidate || typeof candidate !== "object") return null;
  return REQUIRED_METHODS.every((method) => typeof (candidate as Record<string, unknown>)[method] === "function")
    ? candidate as ShensiDesktopApi : null;
}

declare global {
  interface Window { readonly shensiDesktop?: ShensiDesktopApi; }
}

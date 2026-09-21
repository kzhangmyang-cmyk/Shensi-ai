export const DESKTOP_CHANNELS = Object.freeze({
  getDesktopInstallationInfo: "shensi:desktop:get-installation-info",
  registerDesktopInstallation: "shensi:desktop:register-installation",
  recordDesktopBinding: "shensi:desktop:record-binding",
  setDesktopWorkspace: "shensi:desktop:set-workspace",
  getDesktopOutreachStatus: "shensi:desktop:get-outreach-status",
  desktopOutreachStatusChanged: "shensi:desktop:outreach-status-changed",
  getRuntimeInfo: "shensi:desktop:get-runtime-info",
  getConnectorStatus: "shensi:desktop:get-connector-status",
  restartConnector: "shensi:desktop:restart-connector",
  startDouyinLogin: "shensi:desktop:start-douyin-login",
  checkDouyinLogin: "shensi:desktop:check-douyin-login",
  getDouyinLoginStatus: "shensi:desktop:get-douyin-login-status",
  confirmDouyinLogin: "shensi:desktop:confirm-douyin-login",
  cancelDouyinLogin: "shensi:desktop:cancel-douyin-login",
  startDouyinCollection: "shensi:desktop:start-douyin-collection",
  getDouyinCollectionStatus: "shensi:desktop:get-douyin-collection-status",
  getDouyinCollectionResults: "shensi:desktop:get-douyin-collection-results",
  acknowledgeDouyinCollection: "shensi:desktop:acknowledge-douyin-collection",
  cancelDouyinCollection: "shensi:desktop:cancel-douyin-collection",
  controlDouyinCollection: "shensi:desktop:control-douyin-collection",
  openLogsDirectory: "shensi:desktop:open-logs-directory",
  getAppVersion: "shensi:desktop:get-app-version",
  connectorStatusChanged: "shensi:desktop:connector-status-changed"
} as const);

export type DesktopChannel = typeof DESKTOP_CHANNELS[keyof typeof DESKTOP_CHANNELS];

export type DesktopOutreachCoordinatorState = "disabled" | "unenrolled" | "unbound" | "offline" | "idle"
  | "claiming" | "claimed" | "executing" | "reconciling" | "risk_paused" | "error" | "stopping";
export interface DesktopOutreachCoordinatorView {
  state: DesktopOutreachCoordinatorState;
  diagnostic: "central_unreachable" | "connector_unavailable" | "binding_unavailable" | "coordinator_error" | "risk_paused" | null;
  currentActionKind: "comment" | "direct_message" | null;
  updatedAt: string | null;
  pendingReconciliationCount: number;
  ownership: "unregistered" | "unbound" | "this_device" | "other_device" | "unknown";
}
export interface DesktopInstallationInfo {
  installationId: string; protocolVersion: 1; registeredWorkspaceIds: string[];
}
export interface RegisterDesktopInstallationInput { workspaceId: string; enrollmentToken: string; }
export interface RecordDesktopBindingInput { workspaceId: string; accountId: string; bindingGeneration: number; }
export interface DesktopOutreachBridge {
  getDesktopInstallationInfo(): Promise<DesktopInstallationInfo>;
  registerDesktopInstallation(input: RegisterDesktopInstallationInput): Promise<{ workspaceId: string; registered: true }>;
  recordDesktopBinding(input: RecordDesktopBindingInput): Promise<{ recorded: true }>;
  setDesktopWorkspace(input: { workspaceId: string | null }): Promise<void>;
  getDesktopOutreachStatus(): Promise<DesktopOutreachCoordinatorView>;
  onDesktopOutreachStatusChanged(listener: (value: DesktopOutreachCoordinatorView) => void): () => void;
}

export interface DesktopRuntimeInfo {
  platform: "darwin";
  architecture: "arm64" | "x64";
  appVersion: string;
  environment: "development" | "production" | "test";
  connectorStatus: ConnectorStatus;
}

export interface ConnectorStatus {
  state: "starting" | "ready" | "crashed" | "stopped";
  protocolVersion: number | null;
  diagnostic: DesktopDiagnostic | null;
}

export interface DesktopDiagnostic {
  code: string;
  message: string;
  recoverable: boolean;
  occurredAt: string;
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

export type DouyinAccountIdentity = { accountHandle: string; accountDisplayName: string; loginStateVersion: number };

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

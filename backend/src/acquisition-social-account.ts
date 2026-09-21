export type AcquisitionSocialAccountState =
  | "awaiting_scan" | "active" | "login_expired"
  | "risk_paused" | "disconnected";

export type AcquisitionSocialAccountExecutorMode = "desktop" | "server" | null;

export interface AcquisitionSocialAccountDesktopBindingStatus {
  accountId: string;
  executorMode: AcquisitionSocialAccountExecutorMode;
  bindingGeneration: number;
  leaseExpiresAt: string | null;
  ownedByInstallation: boolean;
  hasUnresolvedActions: boolean;
}

export interface AcquisitionSocialAccountDesktopBindingView {
  accountId: string;
  executorMode: "desktop";
  bindingGeneration: number;
  leaseExpiresAt: string;
  ownedByInstallation: true;
}

export type AcquisitionSocialAccountInteractionSurface =
  | "external_window" | "remote_canvas";
export type AcquisitionSocialAccountRuntimeState =
  | "stopped" | "starting" | "running" | "crashed";
export type AcquisitionSocialAccountAuthState =
  | "unknown" | "logged_out" | "waiting_for_user"
  | "verification_required" | "authenticated" | "expired";
export type AcquisitionSocialAccountTaskState =
  | "idle" | "preparing" | "running" | "cancelling"
  | "completed" | "failed";

export interface AcquisitionSocialAccountLoginDiagnostic {
  code: string;
  message: string;
  recoverable: boolean;
  occurredAt: string;
}

export interface AcquisitionSocialAccount {
  id: string;
  workspaceId: string;
  platform: "douyin";
  displayName: string | null;
  state: AcquisitionSocialAccountState;
  loginStateVersion: number | null;
  revision: number;
  etag: string;
  lastValidatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AcquisitionSocialAccountLoginSession {
  id: string;
  platform: "douyin";
  state: "awaiting_scan" | "active" | "login_expired";
  interactionSurface: AcquisitionSocialAccountInteractionSurface;
  runtimeState: AcquisitionSocialAccountRuntimeState;
  authState: AcquisitionSocialAccountAuthState;
  taskState: AcquisitionSocialAccountTaskState;
  diagnostic: AcquisitionSocialAccountLoginDiagnostic | null;
  screenshotAvailable: boolean;
  qrAvailable: boolean;
  qrImageDataUrl: string | null;
  qrStatus: AcquisitionSocialAccountQrStatus;
  loginPage: Readonly<{
    imageDataUrl: string;
    width: number;
    height: number;
  }> | null;
  failureCode: AcquisitionSocialAccountLoginFailureCode | null;
  expiresAt: string;
  account: AcquisitionSocialAccount | null;
}

export type AcquisitionSocialAccountQrStatus =
  | "opening"
  | "ready"
  | "expired"
  | "network_error"
  | "verification_required"
  | null;

export type AcquisitionSocialAccountLoginFailureCode =
  | "douyin_login_ui_unsupported"
  | "douyin_verification_required"
  | "douyin_login_page_unavailable"
  | "douyin_login_page_not_allowed"
  | "douyin_browser_unavailable"
  | "douyin_browser_command_timeout"
  | "douyin_login_open_failed";

export type AcquisitionSocialAccountLoginInteraction =
  | Readonly<{ type: "refresh_qr" }>
  | Readonly<{ type: "click"; normalizedX: number; normalizedY: number }>
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "key"; key: "Enter" | "Tab" | "Backspace" | "Escape"
    | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" }>
  | Readonly<{ type: "scroll"; deltaX: number; deltaY: number }>;

export function publicSocialAccount(record: AcquisitionSocialAccount & { accountHandle: string | null }): AcquisitionSocialAccount {
  return Object.freeze({
    id: record.id,
    workspaceId: record.workspaceId,
    platform: record.platform,
    displayName: record.displayName,
    state: record.state,
    loginStateVersion: record.loginStateVersion,
    revision: record.revision,
    etag: record.etag,
    lastValidatedAt: record.lastValidatedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  });
}

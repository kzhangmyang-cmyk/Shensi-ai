export type AcquisitionSocialAccountState =
  | "awaiting_scan" | "active" | "login_expired"
  | "risk_paused" | "disconnected";

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
  qrImageDataUrl: string | null;
  expiresAt: string;
  account: AcquisitionSocialAccount | null;
}

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

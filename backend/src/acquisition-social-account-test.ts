import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryAcquisitionSocialAccountRepository } from "./acquisition-social-account-repository.js";
import { AcquisitionSocialAccountService } from "./acquisition-social-account-service.js";

const context = { workspaceId: "workspace-a" };
const otherWorkspace = { workspaceId: "workspace-b" };

class Gateway {
  createLoginSessionCalls = 0;
  async createLoginSession() {
    this.createLoginSessionCalls += 1;
    return { sessionId: "session-a", state: "awaiting_scan" as const,
      qrImageDataUrl: "data:image/png;base64,cXI=", expiresAt: "2026-08-24T00:01:00.000Z",
      accountHandle: null, accountDisplayName: null, loginStateVersion: null };
  }
  async getLoginSession() { return { sessionId: "session-a", state: "active" as const,
    qrImageDataUrl: null, expiresAt: "2026-08-24T00:01:00.000Z", accountHandle: "private-handle",
    accountDisplayName: "Douyin", loginStateVersion: 1 }; }
}

test("creates a sanitized QR login session and prevents cross-workspace binding", async () => {
  const gateway = new Gateway();
  const service = new AcquisitionSocialAccountService({ repository: new InMemoryAcquisitionSocialAccountRepository(), gateway,
    idFactory: () => "account-a", now: () => "2026-08-24T00:00:00.000Z" });
  const view = await service.createLoginSession(context, { platform: "douyin" });
  assert.equal(gateway.createLoginSessionCalls, 1);
  assert.equal(view.state, "awaiting_scan");
  assert.equal("accountHandle" in view, false);
  await assert.rejects(service.bindActiveSession(otherWorkspace, view.id), { code: "douyin_login_session_not_found" });
});

test("binds exactly once, replaces the active account, and disconnects safely", async () => {
  const service = new AcquisitionSocialAccountService({ repository: new InMemoryAcquisitionSocialAccountRepository(), gateway: new Gateway(),
    idFactory: (() => { let n = 0; return () => `account-${++n}`; })(), now: () => "2026-08-24T00:00:00.000Z" });
  const session = await service.createLoginSession(context, { platform: "douyin" });
  const active = await service.bindActiveSession(context, session.id);
  assert.equal(active.state, "active");
  assert.equal("accountHandle" in active, false);
  const replay = await service.bindActiveSession(context, session.id);
  assert.deepEqual(replay, active);
  const disconnected = await service.disconnect(context, active.id, active.etag);
  assert.equal(disconnected.state, "disconnected");
  assert.equal((await service.list(context)).items[0]?.state, "disconnected");
});

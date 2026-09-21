import { randomUUID } from "node:crypto";
import { DESKTOP_CHANNELS, type DesktopInstallationInfo, type DesktopOutreachBridge,
  type DesktopOutreachCoordinatorView, type RegisterDesktopInstallationInput, type RecordDesktopBindingInput } from "../shared/contracts.ts";
import { validateInvoke } from "../shared/validation.ts";
import type { DesktopCentralApiClient } from "./desktop-central-api-client.ts";
import { registrationResponse } from "./desktop-central-protocol.ts";
import type { DeviceCredentialStore } from "./device-credential-store.ts";
import type { DeviceInstallationStore } from "./device-installation.ts";
import type { DesktopOutreachActionCoordinator } from "./outreach-action-coordinator.ts";

export interface DesktopEnrollmentServiceOptions {
  onBindingDiagnostic?: (value: { reason: "generation_conflict"; priorGeneration: number; requestedGeneration: number }) => void;
  central: Pick<DesktopCentralApiClient, "register">;
  installationStore: DeviceInstallationStore;
  credentialStore: DeviceCredentialStore;
  coordinator: Pick<DesktopOutreachActionCoordinator, "getState" | "onState" | "setContext"> & {
    getStatusMetadata(): Omit<DesktopOutreachCoordinatorView, "state" | "ownership">;
  };
}

/** Enrollment and a closed status projection. Executable authority stays in Main. */
export class DesktopEnrollmentService implements DesktopOutreachBridge {
  readonly #options: DesktopEnrollmentServiceOptions;
  readonly #listeners = new Set<(value: DesktopOutreachCoordinatorView) => void>();
  readonly #unsubscribe: () => void;
  #workspaceId: string | null = null;
  #ownership: DesktopOutreachCoordinatorView["ownership"] = "unknown";
  #disposed = false;
  constructor(options: DesktopEnrollmentServiceOptions) {
    this.#options = options;
    this.#unsubscribe = options.coordinator.onState(() => this.#publish());
  }
  async getDesktopInstallationInfo(): Promise<DesktopInstallationInfo> {
    this.#assertActive();
    return { installationId: await this.#options.installationStore.getOrCreateInstallationId(), protocolVersion: 1,
      registeredWorkspaceIds: await this.#options.credentialStore.registeredWorkspaceIds() };
  }
  async registerDesktopInstallation(input: RegisterDesktopInstallationInput): Promise<{ workspaceId: string; registered: true }> {
    this.#assertActive();
    input = validateInvoke(DESKTOP_CHANNELS.registerDesktopInstallation, input) as RegisterDesktopInstallationInput;
    try {
      const installationId = await this.#options.installationStore.getOrCreateInstallationId();
      const registered = await this.#options.central.register({ installationId, protocolVersion: 1, enrollmentToken: input.enrollmentToken },
        { expectedWorkspaceId: input.workspaceId, idempotencyKey: randomUUID() });
      registrationResponse(registered);
      if (registered.workspaceId !== input.workspaceId) throw new Error();
      this.#assertActive();
      const existing = await this.#options.credentialStore.load(input.workspaceId);
      await this.#options.credentialStore.save({ ...registered, bindings: existing?.bindings ?? [] });
      await this.#refresh(input.workspaceId);
      return { workspaceId: input.workspaceId, registered: true };
    } catch { throw new Error("desktop_registration_failed"); }
  }
  async recordDesktopBinding(input: RecordDesktopBindingInput): Promise<{ recorded: true }> {
    this.#assertActive();
    input = validateInvoke(DESKTOP_CHANNELS.recordDesktopBinding, input) as RecordDesktopBindingInput;
    const current = await this.#options.credentialStore.load(input.workspaceId);
    const prior = current?.bindings.find((binding) => binding.accountId === input.accountId);
    if (!current) throw new Error("desktop_credential_missing");
    if (prior && prior.bindingGeneration > input.bindingGeneration) {
      this.#options.onBindingDiagnostic?.({ reason: "generation_conflict", priorGeneration: prior.bindingGeneration, requestedGeneration: input.bindingGeneration });
      throw new Error("desktop_binding_generation_conflict");
    }
    if (prior?.bindingGeneration !== input.bindingGeneration) {
      await this.#options.credentialStore.recordBinding(input.workspaceId, { accountId: input.accountId, bindingGeneration: input.bindingGeneration });
      await this.#refresh(input.workspaceId);
    } else {
      // A successful central rebind may renew an expired same-device lease.
      // Recover stopped lanes, but a Renderer reload must not interrupt a write.
      const snapshot = this.#options.coordinator.getState();
      if (["error", "offline", "unenrolled", "unbound"].includes(snapshot.state)
        && !snapshot.accounts.some((account) => ["executing", "claimed", "claiming"].includes(account.state)))
        await this.#refresh(input.workspaceId);
    }
    return { recorded: true };
  }
  async setDesktopWorkspace(input: { workspaceId: string | null }): Promise<void> {
    this.#assertActive();
    input = validateInvoke(DESKTOP_CHANNELS.setDesktopWorkspace, input) as typeof input;
    if (input.workspaceId === this.#workspaceId) return;
    this.#workspaceId = input.workspaceId;
    this.#ownership = "unknown";
    await this.#options.coordinator.setContext(input.workspaceId);
    await this.#readOwnership(input.workspaceId);
  }
  async #readOwnership(workspaceId: string | null) {
    const credential = workspaceId === null ? null : await this.#options.credentialStore.load(workspaceId);
    if (this.#disposed || workspaceId !== this.#workspaceId) return;
    this.#ownership = workspaceId === null ? "unknown" : !credential ? "unregistered" : credential.bindings.length ? "this_device" : "unbound";
    this.#publish();
  }
  async #refresh(workspaceId: string) {
    if (this.#disposed || this.#workspaceId !== workspaceId) return;
    await this.#options.coordinator.setContext(workspaceId);
    await this.#readOwnership(workspaceId);
  }
  async getDesktopOutreachStatus(): Promise<DesktopOutreachCoordinatorView> { return this.#view(); }
  #view(): DesktopOutreachCoordinatorView {
    const metadata = this.#options.coordinator.getStatusMetadata();
    return { state: this.#options.coordinator.getState().state, diagnostic: metadata.diagnostic,
      currentActionKind: metadata.currentActionKind, updatedAt: metadata.updatedAt,
      pendingReconciliationCount: metadata.pendingReconciliationCount, ownership: this.#ownership };
  }
  onDesktopOutreachStatusChanged(listener: (value: DesktopOutreachCoordinatorView) => void): () => void {
    this.#assertActive(); this.#listeners.add(listener); return () => { this.#listeners.delete(listener); };
  }
  #publish() {
    if (this.#disposed) return;
    for (const listener of this.#listeners) { try { listener(this.#view()); } catch { /* Renderer cannot interrupt Main. */ } }
  }
  #assertActive() { if (this.#disposed) throw new Error("desktop_enrollment_disposed"); }
  dispose() { this.#disposed = true; this.#unsubscribe(); this.#listeners.clear(); }
}

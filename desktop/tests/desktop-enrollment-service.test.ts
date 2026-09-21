import assert from "node:assert/strict";
import test from "node:test";
import { DesktopEnrollmentService } from "../src/main/desktop-enrollment-service.ts";
import type { DesktopWorkspaceCredential } from "../src/main/device-credential-store.ts";
import type { DesktopOutreachCoordinatorState } from "../src/shared/contracts.ts";

function fixture() {
  const credentials = new Map<string, DesktopWorkspaceCredential>();
  const contexts: Array<string | null> = [];
  const listeners = new Set<() => void>();
  let state: DesktopOutreachCoordinatorState = "unenrolled";
  let responseWorkspace = "workspace-one";
  const registrations: unknown[] = [];
  const bindingDiagnostics: unknown[] = [];
  const service = new DesktopEnrollmentService({
    onBindingDiagnostic: value => bindingDiagnostics.push(value),
    installationStore: { getOrCreateInstallationId: async () => "I".repeat(43) },
    credentialStore: {
      registeredWorkspaceIds: async () => [...credentials.keys()].sort(),
      load: async (id) => structuredClone(credentials.get(id) ?? null),
      save: async (value) => { credentials.set(value.workspaceId, structuredClone(value)); },
      recordBinding: async (id, binding) => {
        const value = credentials.get(id); if (!value) throw Error("missing");
        value.bindings = [structuredClone(binding)];
      }, remove: async (id) => { credentials.delete(id); }
    },
    central: { register: async (input, options) => {
      registrations.push({ input, options });
      return { workspaceId: responseWorkspace, protocolVersion: 1, deviceToken: "SECRET_TOKEN_".padEnd(43, "X") };
    } },
    coordinator: {
      getState: () => ({ state, accounts: [{ accountId: "private-account", actionId: "private-action", state }] }),
      getStatusMetadata: () => ({ diagnostic: null, currentActionKind: null, updatedAt: null, pendingReconciliationCount: 0 }),
      onState: (listener) => { const notify = () => listener({ state, accounts: [] }); listeners.add(notify); return () => { listeners.delete(notify); }; },
      setContext: async (id) => { contexts.push(id); state = id === null ? "unenrolled" : "idle"; for (const listener of listeners) listener(); }
    }
  });
  return { service, credentials, contexts, listeners, registrations, bindingDiagnostics,
    setState: (value: DesktopOutreachCoordinatorState) => { state = value; },
    wrongWorkspace: () => { responseWorkspace = "other-workspace"; } };
}

test("registration stores the credential only in Main and rejects a different workspace before saving", async () => {
  const f = fixture();
  assert.deepEqual(await f.service.getDesktopInstallationInfo(), { installationId: "I".repeat(43), protocolVersion: 1, registeredWorkspaceIds: [] });
  assert.deepEqual(await f.service.registerDesktopInstallation({ workspaceId: "workspace-one", enrollmentToken: "E".repeat(43) }), { workspaceId: "workspace-one", registered: true });
  assert.equal(f.credentials.get("workspace-one")?.deviceToken, "SECRET_TOKEN_".padEnd(43, "X"));
  assert.deepEqual(f.contexts, []);
  f.wrongWorkspace();
  await assert.rejects(f.service.registerDesktopInstallation({ workspaceId: "workspace-one", enrollmentToken: "E".repeat(43) }), /registration_failed/);
  assert.equal(f.credentials.size, 1);
  assert.equal(JSON.stringify(await f.service.getDesktopInstallationInfo()).includes("SECRET"), false);
  f.service.dispose();
});

test("successful same-generation rebind refreshes recovery errors without interrupting an active action", async () => {
  const f = fixture();
  await f.service.setDesktopWorkspace({ workspaceId: "workspace-one" });
  await f.service.registerDesktopInstallation({ workspaceId: "workspace-one", enrollmentToken: "E".repeat(43) });
  const binding = { workspaceId: "workspace-one", accountId: "account-one", bindingGeneration: 2 };
  await f.service.recordDesktopBinding(binding);
  let before = f.contexts.length;
  f.setState("executing");
  await f.service.recordDesktopBinding(binding);
  assert.equal(f.contexts.length, before);
  f.setState("error");
  await f.service.recordDesktopBinding(binding);
  assert.equal(f.contexts.length, before + 1);
  f.service.dispose();
});

test("workspace selection, binding refresh and Renderer unsubscribe never restart an unchanged context", async () => {
  const f = fixture();
  const views: unknown[] = [];
  const unsubscribe = f.service.onDesktopOutreachStatusChanged((value) => views.push(value));
  await f.service.setDesktopWorkspace({ workspaceId: "workspace-one" });
  await f.service.registerDesktopInstallation({ workspaceId: "workspace-one", enrollmentToken: "E".repeat(43) });
  await f.service.recordDesktopBinding({ workspaceId: "workspace-one", accountId: "account-one", bindingGeneration: 2 });
  assert.equal((await f.service.getDesktopOutreachStatus()).ownership, "this_device");
  const before = f.contexts.length;
  await f.service.setDesktopWorkspace({ workspaceId: "workspace-one" });
  await f.service.recordDesktopBinding({ workspaceId: "workspace-one", accountId: "account-one", bindingGeneration: 2 });
  assert.equal(f.contexts.length, before);
  await assert.rejects(f.service.recordDesktopBinding({ workspaceId: "workspace-one", accountId: "account-one", bindingGeneration: 1 }), /generation_conflict/);
  assert.deepEqual(f.bindingDiagnostics, [{ reason: "generation_conflict", priorGeneration: 2, requestedGeneration: 1 }]);
  unsubscribe(); unsubscribe();
  const observed = views.length;
  await f.service.setDesktopWorkspace({ workspaceId: null });
  assert.equal(views.length, observed);
  assert.equal(f.contexts.at(-1), null);
  assert.equal((await f.service.getDesktopOutreachStatus()).ownership, "unknown");
  assert.equal(JSON.stringify(views).includes("private-"), false);
  const last = f.contexts.length;
  f.service.dispose(); f.service.dispose();
  assert.equal(f.listeners.size, 0);
  assert.equal(f.contexts.length, last);
});

test("recording another workspace's successful binding does not change the current workspace", async () => {
  const f = fixture();
  await f.service.registerDesktopInstallation({ workspaceId: "workspace-one", enrollmentToken: "E".repeat(43) });
  await f.service.setDesktopWorkspace({ workspaceId: "workspace-two" });
  await f.service.recordDesktopBinding({ workspaceId: "workspace-one", accountId: "account-one", bindingGeneration: 1 });
  assert.deepEqual(f.contexts, ["workspace-two"]);
  assert.equal((await f.service.getDesktopOutreachStatus()).ownership, "unregistered");
  f.service.dispose();
});

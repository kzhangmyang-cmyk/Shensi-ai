import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { mountSettingsPage } from "./settings-page";

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export async function runSettingsPageTests(): Promise<void> {
  const { document } = parseHTML(`<html><body data-session-workspace-id="workspace-1"><main>
    <nav>
      <button class="active" data-settings-target="settings-model" aria-current="true"></button>
      <button data-settings-target="settings-voice"></button>
      <button data-settings-target="settings-greeting"></button>
      <button data-settings-target="settings-account"></button>
    </nav>
    <section id="settings-model"></section>
    <section id="settings-voice"></section>
    <section id="settings-greeting"></section>
    <section id="settings-account"></section>
    <button data-settings-voice-check></button>
    <em data-settings-status="model"></em>
    <em data-settings-status="search"></em>
    <em data-settings-status="voice"></em>
  </main></body></html>`);
  const calls: string[] = [];
  const mounted = mountSettingsPage(document.querySelector("main")!, {
    workspaceId: "workspace-1",
    realtimeBridge: {
      settings: async (workspaceId: string) => {
        calls.push(`voice:${workspaceId}`);
        return {
          state: "ready",
          configured: true,
          workspaceId: "voice-space",
          model: "qwen3.5-omni-flash-realtime",
          region: "cn-beijing",
          checkedAt: "2026-09-08T08:30:00.000Z"
        };
      },
      check: async (workspaceId: string) => {
        calls.push(`check:${workspaceId}`);
        return {
          state: "saved",
          configured: true,
          workspaceId: "voice-space",
          model: "qwen3.5-omni-flash-realtime",
          region: "cn-beijing",
          checkedAt: null
        };
      }
    },
    connectionApi: {
      listModelConnections: async () => {
        calls.push("model");
        return [{ provider: "deepseek", status: "active" }] as never;
      },
      listSearchConnections: async () => {
        calls.push("search");
        return [{ status: "active", lastHealthStatus: "passed" }] as never;
      }
    }
  });
  await tick();
  assert.deepEqual(calls.sort(), ["model", "search", "voice:workspace-1"]);
  assert.equal(document.querySelector('[data-settings-status="model"]')?.textContent, "已启用");
  assert.equal(document.querySelector('[data-settings-status="search"]')?.textContent, "连接正常");
  assert.match(
    document.querySelector('[data-settings-status="voice"]')?.textContent ?? "",
    /^连接正常 · /
  );
  assert.equal(calls.some((call) => call.startsWith("check:")), false,
    "opening settings must not begin a realtime connection check");

  document.querySelector<HTMLButtonElement>("[data-settings-voice-check]")!.click();
  await tick();
  assert.equal(calls.includes("check:workspace-1"), true,
    "the explicit connection-check control must call the desktop bridge");
  assert.equal(document.querySelector('[data-settings-status="voice"]')?.textContent, "已保存 · 待检测");

  document.querySelector<HTMLButtonElement>('[data-settings-target="settings-voice"]')!.click();
  assert.equal(document.querySelector('[data-settings-target="settings-model"]')?.getAttribute("aria-current"), null);
  assert.equal(document.querySelector('[data-settings-target="settings-voice"]')?.getAttribute("aria-current"), "true");
  assert.equal(document.querySelector('[data-settings-target="settings-voice"]')?.classList.contains("active"), true);

  document.querySelector<HTMLButtonElement>('[data-settings-target="settings-greeting"]')!.click();
  assert.equal(document.querySelector('[data-settings-target="settings-voice"]')?.getAttribute("aria-current"), null);
  assert.equal(document.querySelector('[data-settings-target="settings-greeting"]')?.getAttribute("aria-current"), "true");
  assert.equal(document.querySelector('[data-settings-target="settings-greeting"]')?.classList.contains("active"), true);
  mounted.dispose();

  const failed = parseHTML(`<html><body><main>
    <em data-settings-status="model"></em><em data-settings-status="search"></em>
    <em data-settings-status="voice"></em>
  </main></body></html>`).document;
  const failedMount = mountSettingsPage(failed.querySelector("main")!, {
    connectionApi: {
      listModelConnections: async () => { throw new Error("offline"); },
      listSearchConnections: async () => []
    }
  });
  await tick();
  assert.equal(failed.querySelector('[data-settings-status="model"]')?.textContent, "读取失败");
  assert.equal(failed.querySelector('[data-settings-status="search"]')?.textContent, "未配置");
  failedMount.dispose();

  const saved = parseHTML(`<html><body><main>
    <em data-settings-status="model"></em><em data-settings-status="search"></em>
    <em data-settings-status="voice"></em>
  </main></body></html>`).document;
  const savedMount = mountSettingsPage(saved.querySelector("main")!, {
    workspaceId: "workspace-2",
    realtimeBridge: {
      settings: async () => ({
        state: "saved",
        configured: true,
        workspaceId: "",
        model: "qwen3.5-omni-flash-realtime",
        region: "cn-beijing",
        checkedAt: null
      }),
      check: async () => ({
        state: "saved",
        configured: true,
        workspaceId: "",
        model: "qwen3.5-omni-flash-realtime",
        region: "cn-beijing",
        checkedAt: null
      })
    },
    connectionApi: {
      listModelConnections: async () => [],
      listSearchConnections: async () => []
    }
  });
  await tick();
  assert.equal(saved.querySelector('[data-settings-status="voice"]')?.textContent, "已保存 · 待检测");
  savedMount.dispose();

  const staleRead = parseHTML(`<html><body><main>
    <button data-settings-voice-check></button>
    <em data-settings-status="model"></em><em data-settings-status="search"></em>
    <em data-settings-status="voice"></em>
  </main></body></html>`).document;
  let resolveInitialVoice!: (value: {
    state: "ready";
    configured: true;
    workspaceId: string;
    model: string;
    region: "cn-beijing";
    checkedAt: string;
  }) => void;
  const staleReadMount = mountSettingsPage(staleRead.querySelector("main")!, {
    workspaceId: "workspace-3",
    realtimeBridge: {
      settings: async () => new Promise((resolve) => { resolveInitialVoice = resolve; }),
      check: async () => ({
        state: "saved",
        configured: true,
        workspaceId: "voice-space",
        model: "qwen3.5-omni-flash-realtime",
        region: "cn-beijing",
        checkedAt: null
      })
    },
    connectionApi: {
      listModelConnections: async () => [],
      listSearchConnections: async () => []
    }
  });
  await tick();
  staleRead.querySelector<HTMLButtonElement>("[data-settings-voice-check]")!.click();
  await tick();
  assert.equal(staleRead.querySelector('[data-settings-status="voice"]')?.textContent, "已保存 · 待检测");
  resolveInitialVoice({
    state: "ready",
    configured: true,
    workspaceId: "voice-space",
    model: "qwen3.5-omni-flash-realtime",
    region: "cn-beijing",
    checkedAt: "2026-09-08T08:30:00.000Z"
  });
  await tick();
  assert.equal(staleRead.querySelector('[data-settings-status="voice"]')?.textContent, "已保存 · 待检测",
    "a slower read must not overwrite a user-requested connection check");
  staleReadMount.dispose();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSettingsPageTests().then(() => console.log("settings-page self-test passed"));
}

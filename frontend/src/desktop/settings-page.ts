import type {
  ModelConnection,
  SearchConnection
} from "../connections/connection-api";
import { createConnectionSettingsApi } from "../connections/connection-api";
import type { CfoVoiceBridge } from "../../../desktop/src/shared/cfo-voice";
import type {
  CfoRealtimeBridge,
  VoiceSettingsView
} from "../../../desktop/src/shared/cfo-realtime";
import { mountGreetingSettings } from "./greeting-settings";

interface SettingsConnectionApi {
  listModelConnections(): Promise<ModelConnection[]>;
  listSearchConnections(): Promise<SearchConnection[]>;
}

interface SettingsPageOptions {
  connectionApi?: SettingsConnectionApi;
  voiceBridge?: CfoVoiceBridge;
  realtimeBridge?: Pick<CfoRealtimeBridge, "settings" | "check">;
  workspaceId?: string | null;
}

function setStatus(host: HTMLElement, kind: "model" | "search" | "voice", value: string): void {
  const node = host.querySelector<HTMLElement>(`[data-settings-status="${kind}"]`);
  if (node) node.textContent = value;
}

function modelStatus(connections: ModelConnection[]): string {
  if (connections.some((item) => item.status === "active")) return "已启用";
  if (connections.length > 0) return "已配置 · 未启用";
  return "未配置";
}

function searchStatus(connections: SearchConnection[]): string {
  if (connections.some((item) => item.status === "active" && item.lastHealthStatus === "passed")) {
    return "连接正常";
  }
  if (connections.some((item) => item.status === "active")) return "已启用 · 待检测";
  if (connections.length > 0) return "已配置 · 未启用";
  return "未配置";
}

function checkedAtLabel(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function voiceStatus(view: VoiceSettingsView): string {
  const checkedAt = checkedAtLabel(view.checkedAt);
  switch (view.state) {
    case "not_configured": return "未配置";
    case "saved": return "已保存 · 待检测";
    case "ready": return checkedAt ? `连接正常 · ${checkedAt}` : "连接正常";
    case "credentials_failed": return checkedAt ? `Key 校验失败 · ${checkedAt}` : "Key 校验失败";
    case "permission_failed": return checkedAt ? `权限未通过 · ${checkedAt}` : "权限未通过";
    case "network_failed": return checkedAt ? `网络检测失败 · ${checkedAt}` : "网络检测失败";
    case "protocol_failed": return checkedAt ? `协议检测失败 · ${checkedAt}` : "协议检测失败";
  }
}

export function mountSettingsPage(
  host: HTMLElement,
  options: SettingsPageOptions = {}
): { dispose(): void } {
  const api = options.connectionApi ?? createConnectionSettingsApi();
  const greeting = mountGreetingSettings(host, options.voiceBridge);
  const navigation = [...host.querySelectorAll<HTMLButtonElement>("[data-settings-target]")];
  const voiceCheck = host.querySelector<HTMLButtonElement>("[data-settings-voice-check]");
  let disposed = false;
  let voiceStatusVersion = 0;

  const activate = (button: HTMLButtonElement): void => {
    const id = button.dataset.settingsTarget;
    const target = id ? host.querySelector<HTMLElement>(`#${id}`) : null;
    if (!target) return;
    navigation.forEach((item) => {
      const active = item === button;
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "true");
      else item.removeAttribute("aria-current");
    });
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };
  const handlers = navigation.map((button) => {
    const handler = () => activate(button);
    button.addEventListener("click", handler);
    return { button, handler };
  });

  setStatus(host, "model", "正在读取…");
  setStatus(host, "search", "正在读取…");
  const workspaceId = options.workspaceId?.trim() ?? "";
  const canCheckVoice = Boolean(options.realtimeBridge && workspaceId);
  if (voiceCheck) voiceCheck.disabled = !canCheckVoice;
  setStatus(host, "voice", options.realtimeBridge && workspaceId ? "正在读取…" : "当前不可用");
  const reads: Promise<unknown>[] = [
    api.listModelConnections().then((items) => {
      if (!disposed) setStatus(host, "model", modelStatus(items));
    }),
    api.listSearchConnections().then((items) => {
      if (!disposed) setStatus(host, "search", searchStatus(items));
    })
  ];
  if (options.realtimeBridge && workspaceId) {
    const requestVersion = ++voiceStatusVersion;
    reads.push(options.realtimeBridge.settings(workspaceId)
      .then((view) => {
        if (!disposed && requestVersion === voiceStatusVersion) setStatus(host, "voice", voiceStatus(view));
      })
      .catch(() => {
        if (!disposed && requestVersion === voiceStatusVersion) setStatus(host, "voice", "读取失败");
      }));
  }
  void Promise.allSettled(reads).then((results) => {
    if (disposed) return;
    if (results[0]?.status === "rejected") setStatus(host, "model", "读取失败");
    if (results[1]?.status === "rejected") setStatus(host, "search", "读取失败");
  });

  const checkVoice = (): void => {
    if (!options.realtimeBridge || !workspaceId || disposed) {
      setStatus(host, "voice", "当前不可用");
      return;
    }
    if (voiceCheck) {
      voiceCheck.disabled = true;
      voiceCheck.setAttribute("aria-busy", "true");
    }
    const requestVersion = ++voiceStatusVersion;
    setStatus(host, "voice", "正在检测…");
    void options.realtimeBridge.check(workspaceId)
      .then((view) => {
        if (!disposed && requestVersion === voiceStatusVersion) setStatus(host, "voice", voiceStatus(view));
      })
      .catch(() => {
        if (!disposed && requestVersion === voiceStatusVersion) setStatus(host, "voice", "检测未完成");
      })
      .finally(() => {
        if (disposed || !voiceCheck) return;
        voiceCheck.disabled = false;
        voiceCheck.removeAttribute("aria-busy");
      });
  };
  voiceCheck?.addEventListener("click", checkVoice);

  return {
    dispose(): void {
      disposed = true;
      greeting.dispose();
      handlers.forEach(({ button, handler }) => button.removeEventListener("click", handler));
      voiceCheck?.removeEventListener("click", checkVoice);
    }
  };
}

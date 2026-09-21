import { desktopOutreachCopy, type DesktopRuntimeState } from "./desktop-runtime";
import { patchStableView } from "./stable-view";
import type { DouyinAccount } from "../acquisition/douyin-automation-api";

export type DesktopAccountUiRuntime = Pick<DesktopRuntimeState, "bridge" | "outreachStatus" | "enrollmentError" | "bindingStatus" | "bindingError" | "bindingPending" | "subscribeOutreach" | "bindDesktopAccount" | "synchronizeWorkspace" | "accountId" | "prepareLocalAccountBinding">;
const escape = (text: string) => text.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function mountDesktopAccountStatus(host: HTMLElement, runtime: DesktopAccountUiRuntime | null,
  accountSource?: () => Pick<DouyinAccount, "id" | "workspaceId" | "state" | "loginStateVersion"> | null) {
  let confirmed = false;
  let generation: number | null = null;
  let checking = false;
  let checkMessage = "";
  let checkGeneration = 0;
  let checkWorkspace = runtime?.accountId();
  const accountIdentity = () => {
    const account = accountSource?.();
    return account ? `${account.workspaceId}:${account.id}:${account.state}:${account.loginStateVersion}` : null;
  };
  let checkedAccount = accountIdentity();
  const render = () => {
    if (!runtime) return;
    if (checkWorkspace !== runtime.accountId() || checkedAccount !== accountIdentity()) {
      checkWorkspace = runtime.accountId(); checkGeneration++;
      checkedAccount = accountIdentity();
      checking = false; checkMessage = "";
    }
    const card = host.querySelector<HTMLElement>(".douyin-account-card");
    if (!card) return;
    let slot = card.querySelector<HTMLElement>("[data-desktop-outreach-status]");
    if (!slot) { slot = host.ownerDocument.createElement("div"); slot.dataset.desktopOutreachStatus = ""; card.append(slot); }
    const binding = runtime.bindingStatus();
    if (binding?.bindingGeneration !== generation) { confirmed = false; generation = binding?.bindingGeneration ?? null; }
    const conflict = binding?.executorMode === "desktop" && !binding.ownedByInstallation;
    const blocked = Boolean(binding?.hasUnresolvedActions || runtime.bindingPending());
    const rebindBlocked = Boolean(runtime.bindingPending() || (binding?.executorMode != null && binding.hasUnresolvedActions && !binding.ownedByInstallation));
    patchStableView(slot, `<div class="douyin-inline-status" role="status"><strong>${escape(runtime.enrollmentError() ?? desktopOutreachCopy(runtime.outreachStatus()))}</strong>${runtime.bindingError() ? `<span>${escape(runtime.bindingError()!)}</span>` : ""}</div><div class="douyin-actions">${runtime.enrollmentError() ? `<button type="button" class="secondary" data-desktop-binding-action="register">重试注册此设备</button>` : ""}${binding && !conflict ? `<button type="button" class="secondary" data-desktop-binding-action="bind" ${rebindBlocked ? "disabled" : ""}>重新绑定本机账号</button>` : ""}<button type="button" class="secondary" data-desktop-binding-action="check-login" ${checking ? "disabled" : ""}>${checking ? "正在检测…" : "重新检测本机登录"}</button></div>${checkMessage ? `<p role="status">${escape(checkMessage)}</p>` : ""}${conflict ? `<div class="douyin-inline-status is-warning"><p>${binding.hasUnresolvedActions ? "仍有未解决动作，暂不可切换设备" : "该账号已绑定其他设备。交接后旧设备将失去执行权限。"}</p><label><input type="checkbox" data-desktop-handoff-confirm ${confirmed ? "checked" : ""} ${blocked ? "disabled" : ""}> 我确认将该账号交接给本机</label><button type="button" class="secondary" data-desktop-binding-action="handoff" ${blocked || !confirmed ? "disabled" : ""}>确认交接到本机</button></div>` : ""}`);
  };
  const click = (event: Event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-desktop-binding-action]");
    if (!button || button.disabled || !runtime) return;
    if (button.dataset.desktopBindingAction === "check-login") {
      const workspaceId = runtime.accountId();
      if (!workspaceId || !runtime.bridge || checking) return;
      const own = ++checkGeneration;
      const ownAccount = accountIdentity();
      const currentCheck = () => own === checkGeneration && runtime.accountId() === workspaceId
        && accountIdentity() === ownAccount;
      checking = true; checkMessage = ""; render();
      void runtime.bridge.checkDouyinLogin(workspaceId).then(async (identity) => {
        if (!currentCheck()) return;
        checkMessage = `本机登录记录可用：${identity.accountDisplayName}（版本 ${identity.loginStateVersion}）。发送前仍会核对抖音实际账号。`;
        const account = accountSource?.();
        if (account) {
          try { await runtime.prepareLocalAccountBinding(account, identity); }
          catch {
            if (currentCheck())
              checkMessage += " 无法恢复设备绑定信息，请核对账号状态后重试检测。";
          }
        }
      }, () => {
        if (currentCheck())
          checkMessage = "未找到可用的本机登录记录，请使用连接抖音重新登录。";
      }).finally(() => { if (own === checkGeneration) { checking = false; render(); } });
    } else if (button.dataset.desktopBindingAction === "register") {
      void runtime.synchronizeWorkspace(runtime.accountId()).catch(() => undefined);
    } else {
      const handoff = button.dataset.desktopBindingAction === "handoff";
      if (handoff && (!confirmed || runtime.bindingStatus()?.hasUnresolvedActions)) return;
      void runtime.bindDesktopAccount(handoff).catch(() => undefined);
    }
  };
  const change = (event: Event) => {
    const input = event.target as HTMLInputElement | null;
    if (!input?.matches("[data-desktop-handoff-confirm]")) return;
    confirmed = input.checked;
    render();
  };
  host.addEventListener("click", click);
  host.addEventListener("change", change);
  const unsubscribe = runtime?.subscribeOutreach(render) ?? (() => undefined);
  return { render, dispose() { checkGeneration++; unsubscribe(); host.removeEventListener("click", click); host.removeEventListener("change", change); } };
}

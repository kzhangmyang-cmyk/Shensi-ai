import type { PublicUpdateState } from "../../../desktop/src/shared/app-update.ts";

export interface AppUpdateBridge {
  getState(): Promise<PublicUpdateState>;
  check(): Promise<PublicUpdateState>;
  download(): Promise<PublicUpdateState>;
  cancel(): Promise<PublicUpdateState>;
  retry(): Promise<PublicUpdateState>;
  reveal(): Promise<PublicUpdateState>;
  onChange(listener: (state: PublicUpdateState) => void): () => void;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/gu, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]!));

export function renderAppUpdateDialog(state: PublicUpdateState): string {
  const title = state.phase === "current" ? "已是当前版本"
    : state.phase === "available" ? "可以更新"
    : state.phase === "downloading" ? "正在下载"
    : state.phase === "verified" ? "安装包已校验"
    : state.phase === "failed" ? "更新没有完成"
    : "检查更新";
  const body = state.phase === "checking" ? "正在读取发布清单。"
    : state.phase === "current" ? `当前版本 ${state.installedVersion}。没有更新的安装包。`
    : state.phase === "available" ? `${state.title ?? "新版本"} ${state.availableVersion ?? ""}。${state.notes ?? ""}`
    : state.phase === "verified" ? state.instructions ?? ""
    : state.phase === "failed" ? state.error ?? "请重试。"
    : state.error ?? "下载完成后会先校验，再由你手动安装。";
  const percent = state.progress?.total ? Math.min(100, Math.round(state.progress.received / state.progress.total * 100)) : 0;
  const progress = state.phase === "downloading"
    ? `<div class="replica-app-update-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div><p>${percent}%</p>`
    : "";
  const actions = state.phase === "available"
    ? `<button type="button" data-app-update-action="download">下载并校验</button>`
    : state.phase === "downloading"
      ? `<button type="button" data-app-update-action="cancel">取消</button>`
      : state.phase === "failed"
        ? `<button type="button" data-app-update-action="retry">重试</button>`
        : state.phase === "verified"
          ? `<button type="button" data-app-update-action="reveal">在访达中显示</button>`
          : `<button type="button" data-app-update-action="check">检查更新</button>`;
  return `<dialog class="replica-app-update-dialog" open aria-labelledby="appUpdateTitle"><div><h2 id="appUpdateTitle">${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p>${progress}<p class="replica-app-update-limit">自动替换并重启需要 Developer ID 签名和公证。当前构建没有这两项，所以不会改动正在运行的应用。</p><div class="replica-app-update-actions">${actions}<button type="button" data-app-update-action="close">关闭</button></div></div></dialog>`;
}

export function installAppUpdate(doc: Document, bridge: AppUpdateBridge): { dispose(): void } {
  const sidebar = doc.querySelector(".replica-sidebar-bottom");
  const entry = doc.createElement("button");
  entry.type = "button";
  entry.className = "replica-app-update-entry";
  entry.dataset.appUpdateOpen = "";
  entry.setAttribute("aria-label", "检查更新");
  entry.innerHTML = `<i class="ph ph-download-simple" aria-hidden="true"></i><span>检查更新</span>`;
  const user = sidebar?.querySelector(".replica-user");
  if (sidebar) sidebar.insertBefore(entry, user ?? null);
  else doc.body.append(entry);
  let state: PublicUpdateState | null = null;
  let dialog: HTMLDialogElement | null = null;
  const paint = (next: PublicUpdateState) => {
    state = next;
    entry.dataset.updateAvailable = next.phase === "available" || next.phase === "verified" ? "true" : "false";
    entry.querySelector("span")!.textContent = next.phase === "available" ? "有可用更新" : "检查更新";
    if (!dialog) return;
    const host = doc.createElement("template");
    host.innerHTML = renderAppUpdateDialog(next);
    const replacement = host.content.querySelector("dialog");
    if (replacement) dialog.replaceWith(replacement);
    dialog = replacement;
  };
  const open = () => {
    if (!dialog) {
      const host = doc.createElement("template");
      host.innerHTML = renderAppUpdateDialog(state ?? idleState());
      dialog = host.content.querySelector("dialog");
      if (dialog) doc.body.append(dialog);
    }
    void bridge.check().then(paint, () => paint({ ...idleState(), phase: "failed", error: "更新清单无法读取。" }));
  };
  const onClick = (event: Event) => {
    const target = event.target as { closest?: (selector: string) => HTMLElement | null } | null;
    if (!target || typeof target.closest !== "function") return;
    if (target.closest("[data-app-update-open]")) { open(); return; }
    const action = target.closest("[data-app-update-action]")?.dataset.appUpdateAction;
    if (!action) return;
    if (action === "close") { dialog?.remove(); dialog = null; return; }
    const run = action === "download" ? bridge.download()
      : action === "cancel" ? bridge.cancel()
      : action === "retry" ? bridge.retry()
      : action === "reveal" ? bridge.reveal()
      : bridge.check();
    void run.then(paint, () => paint({ ...(state ?? idleState()), phase: "failed", error: "更新没有完成，请重试。" }));
  };
  doc.addEventListener("click", onClick);
  const unsubscribe = bridge.onChange(paint);
  void bridge.getState().then(paint, () => undefined);
  return { dispose() { unsubscribe(); doc.removeEventListener("click", onClick); entry.remove(); dialog?.remove(); } };
}

function idleState(): PublicUpdateState {
  return {
    phase: "idle", installedVersion: "", releaseSequence: 0, availableVersion: null, title: null,
    notes: null, size: null, progress: null, error: null, fileName: null,
    automaticInstallSupported: false, installMode: "manual-dmg", instructions: null
  };
}

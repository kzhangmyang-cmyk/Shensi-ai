import { createPopupSelectionModel, type SelectableDouyinTab } from "./popup-model";
import { popupPrivacyCopy } from "./popup-privacy-copy";

declare const chrome: any;

interface PopupSession {
  sessionId: string;
  limits: { maxCommentsPerVideo: number; maxScrolls: number };
  usage: { observationCount: number; scrollCount: number };
  artifactUploadEnabled: boolean;
  status: string;
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`popup element missing: ${id}`);
  return found as T;
}

function validSnapshot(value: unknown): value is {
  session: PopupSession | null;
  tabs: SelectableDouyinTab[];
  confirmationToken: string | null;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || !("session" in record) || !Array.isArray(record.tabs)
    || !(record.confirmationToken === null || (typeof record.confirmationToken === "string"
      && /^[0-9a-f]{48}$/u.test(record.confirmationToken)))) return false;
  if (record.session === null) return record.confirmationToken === null && record.tabs.every(validTab);
  if (typeof record.session !== "object" || Array.isArray(record.session)) return false;
  const session = record.session as Record<string, unknown>;
  return Object.keys(session).length === 5
    && typeof session.sessionId === "string"
    && typeof session.artifactUploadEnabled === "boolean"
    && typeof session.status === "string"
    && session.limits !== null && typeof session.limits === "object"
    && session.usage !== null && typeof session.usage === "object"
    && record.tabs.every(validTab);
}

function validTab(value: unknown): value is SelectableDouyinTab {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const tab = value as Record<string, unknown>;
  return Object.keys(tab).length === 4 && Number.isSafeInteger(tab.id)
    && Number.isSafeInteger(tab.windowId)
    && typeof tab.title === "string" && typeof tab.url === "string"
    && /^https:\/\/www\.douyin\.com\/video\/[1-9][0-9]{0,31}$/u.test(tab.url);
}

const status = element<HTMLParagraphElement>("status");
const startButton = element<HTMLButtonElement>("start");
const stopButton = element<HTMLButtonElement>("stop");
const tabList = element<HTMLDivElement>("tab-list");
let model = createPopupSelectionModel([]);
let confirmationToken: string | null = null;

function setStatus(message: string, error = false): void {
  status.textContent = message;
  status.dataset.error = String(error);
}

function renderTabs(tabs: SelectableDouyinTab[]): void {
  model = createPopupSelectionModel(tabs);
  tabList.replaceChildren();
  for (const tab of model.tabs()) {
    const label = document.createElement("label");
    label.className = "reader-popup__tab";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "douyin-tab";
    radio.value = String(tab.id);
    radio.addEventListener("change", () => {
      model.select(tab.id);
      startButton.disabled = !model.canStart() || confirmationToken === null;
      setStatus("已选择视频。点击开始后仅执行只读操作");
    });
    const copy = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = tab.title;
    const url = document.createElement("small");
    url.textContent = tab.url;
    copy.append(title, url);
    label.append(radio, copy);
    tabList.append(label);
  }
  if (tabs.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = "当前窗口没有可确认的抖音视频标签页。";
    tabList.append(empty);
  }
}

async function refresh(): Promise<void> {
  const snapshot = await chrome.runtime.sendMessage({ kind: "popup_snapshot" });
  if (!validSnapshot(snapshot) || !snapshot.session) {
    confirmationToken = null;
    startButton.disabled = true;
    stopButton.disabled = true;
    setStatus("请先在 GoodJob 运行详情中创建授权视觉读取会话", true);
    renderTabs([]);
    return;
  }
  const session = snapshot.session;
  confirmationToken = snapshot.confirmationToken;
  element("session-id").textContent = session.sessionId;
  element("remaining-comments").textContent = String(Math.max(0,
    session.limits.maxCommentsPerVideo - session.usage.observationCount));
  element("remaining-scrolls").textContent = String(Math.max(0,
    session.limits.maxScrolls - session.usage.scrollCount));
  const privacy = popupPrivacyCopy(session.artifactUploadEnabled);
  element("artifact-mode").textContent = privacy.artifactMode;
  element("scope-copy").textContent = privacy.scope;
  element("privacy-copy").textContent = privacy.lifecycle;
  renderTabs(snapshot.tabs);
  const active = session.status === "reading";
  startButton.disabled = true;
  stopButton.disabled = !["authorized", "reading"].includes(session.status);
  if (active) setStatus("只读读取进行中。关闭弹窗后仍会继续，可随时点击停止");
  else setStatus("请选择一个视频标签页，再点击开始只读读取");
}

startButton.addEventListener("click", async () => {
  const tab = model.confirm();
  const token = confirmationToken;
  if (!tab || !token) return;
  confirmationToken = null;
  startButton.disabled = true;
  setStatus("正在启动只读读取");
  const response = await chrome.runtime.sendMessage({
    kind: "popup_confirm",
    confirmationToken: token,
    tab: { id: tab.id, windowId: tab.windowId, url: tab.url }
  });
  const accepted = response !== null && typeof response === "object"
    && !Array.isArray(response) && (response as { accepted?: unknown }).accepted === true;
  stopButton.disabled = !accepted;
  setStatus(accepted ? "只读读取进行中。关闭弹窗后仍会继续" : "无法启动，请重新授权", !accepted);
});

stopButton.addEventListener("click", async () => {
  startButton.disabled = true;
  stopButton.disabled = true;
  await chrome.runtime.sendMessage({ kind: "popup_abort" });
  setStatus("读取已停止");
});

void refresh().catch(() => setStatus("扩展连接失败，请重新打开", true));

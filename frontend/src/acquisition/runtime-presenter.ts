import type { AcquisitionTaskRowModel } from "./runtime-model";
import type { PublicLeadImportOutcome } from "./runtime-import";

export type PublicDouyinImportStatus =
  | "idle"
  | "uploading"
  | "completed"
  | "partial"
  | "failed";

export type PublicDouyinImportItemStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export interface PublicDouyinImportResult {
  sourceUrl: string;
  status: PublicDouyinImportItemStatus;
  operationId: string | null;
  errorMessage: string | null;
}

export interface PublicDouyinImportPanelState {
  visible: boolean;
  urlText: string;
  status: PublicDouyinImportStatus;
  message: string | null;
  results: PublicDouyinImportResult[];
  outcome: PublicLeadImportOutcome | null;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[character] ?? character);
}

function statusClass(tone: AcquisitionTaskRowModel["statusTone"]): string {
  if (tone === "danger") return " danger";
  if (tone === "normal") return " medium";
  return "";
}

export function renderRealTaskRows(tasks: AcquisitionTaskRowModel[]): string {
  if (tasks.length === 0) {
    return `
      <div class="replica-real-empty" role="status">
        <i class="ph ph-radar" aria-hidden="true"></i>
        <strong>暂无真实抖音获客任务</strong>
        <span>创建并批准任务后，真实运行状态会显示在这里。</span>
      </div>
    `;
  }

  const localDateTime = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short"
  });

  return tasks.map((task, index) => {
    const tags = task.tags.length > 0 ? task.tags.join(",") : "待配置来源";
    const publicLabel = `采集任务 ${String(index + 1).padStart(2, "0")}`;
    const updatedAt = Number.isNaN(Date.parse(task.updatedAt))
      ? "更新时间待同步"
      : localDateTime.format(new Date(task.updatedAt));
    return `
      <button
        type="button"
        class="replica-task-row"
        data-acquisition-real-task="true"
        data-acquisition-plan-id="${escapeHtml(task.planId)}"
        data-task-id="${escapeHtml(publicLabel)}"
        data-task-name="${escapeHtml(task.name)}"
        data-task-summary="${escapeHtml(task.objective)}"
        data-task-owner="智能体"
        data-task-project="${escapeHtml(task.platformLabel)}"
        data-task-due="${escapeHtml(updatedAt)}"
        data-task-status="${escapeHtml(task.statusLabel)}"
        data-task-priority="待判断"
        data-task-tags="${escapeHtml(tags)}"
        data-evidence-count="${task.evidenceCount}"
        data-request-count="${task.requests}"
        data-result-count="${task.results}"
        data-duration-seconds="${task.durationSeconds}"
      >
        <span>${escapeHtml(publicLabel)}</span>
        <b>${escapeHtml(task.name)}</b>
        <span><span class="priority${statusClass(task.statusTone)}">${escapeHtml(task.statusLabel)}</span> ${task.evidenceCount} 条公开证据</span>
      </button>
    `;
  }).join("");
}

const IMPORT_STATUS_LABELS: Readonly<Record<
  PublicDouyinImportItemStatus,
  string
>> = {
  queued: "等待导入",
  running: "正在形成证据",
  succeeded: "用户提交证据已形成",
  failed: "导入失败"
};

function outcomeHtml(outcome: PublicLeadImportOutcome | null): string {
  if (!outcome) return "";
  const metrics = [
    outcome.acceptedRowCount === null ? null : `接收 ${outcome.acceptedRowCount} 行`,
    outcome.evidenceCount === null ? null : `形成 ${outcome.evidenceCount} 条证据`,
    outcome.candidateCount === null ? null : `生成 ${outcome.candidateCount} 个待核验候选`
  ].filter((item): item is string => item !== null);
  const candidates = outcome.candidateIds.map((candidateId, index) => `
    <button
      type="button"
      class="replica-public-import-text-action"
      data-acquisition-import-action="verify-identity"
      data-candidate-id="${escapeHtml(candidateId)}"
    >打开待核验候选 ${index + 1}</button>
  `).join("");
  const rowErrors = outcome.rowErrors.map((error) => `
    <li>
      <strong>第 ${error.rowNumber} 行${error.sheetName ? ` · ${escapeHtml(error.sheetName)}` : ""}</strong>
      <span>${escapeHtml(error.message)}</span>
      <small>${escapeHtml(error.code)}</small>
    </li>
  `).join("");
  return `
    <section class="replica-public-import-outcome" aria-label="导入结果">
      ${metrics.length > 0 ? `<p>${metrics.map(escapeHtml).join(" · ")}</p>` : ""}
      ${candidates ? `<div class="replica-public-import-candidates">${candidates}</div>` : ""}
      ${rowErrors
        ? `<ul class="replica-public-import-errors" aria-label="逐行导入错误">${rowErrors}</ul>`
        : ""}
    </section>
  `;
}

function importResultsHtml(results: PublicDouyinImportResult[]): string {
  if (results.length === 0) return "";
  return `
    <ol class="replica-public-import-results" aria-label="公开链接导入结果">
      ${results.map((result) => `
        <li data-import-result-status="${result.status}">
          <span>
            <strong>${escapeHtml(IMPORT_STATUS_LABELS[result.status])}</strong>
            <small>${escapeHtml(result.sourceUrl)}</small>
          </span>
          <span>
            ${result.operationId ? `<small>任务 ${escapeHtml(result.operationId)}</small>` : ""}
            ${result.errorMessage
              ? `<small class="replica-public-import-error">${escapeHtml(result.errorMessage)}</small>`
              : ""}
          </span>
        </li>
      `).join("")}
    </ol>
  `;
}

export function renderPublicDouyinImportPanel(
  state: PublicDouyinImportPanelState
): string {
  const busy = state.status === "uploading";
  const manualImportOpen = busy
    || state.urlText.trim().length > 0
    || state.message !== null
    || state.results.length > 0
    || state.outcome !== null;
  return `
    <section
      class="replica-public-import"
      aria-labelledby="replicaPublicImportTitle"
      ${state.visible ? "" : "hidden"}
    >
      <header class="replica-public-import-header">
        <div>
          <p>自动发现客户</p>
          <h2 id="replicaPublicImportTitle">启动抖音自动获客</h2>
          <span>描述目标客户后，系统自动搜索公开页面，AI 筛选需求信号，交由你批准后运行。</span>
        </div>
        <strong>真实自动运行</strong>
      </header>
      <div class="replica-auto-acquisition-entry">
        <button
          type="button"
          class="replica-auto-acquisition-action"
          data-acquisition-import-action="start-auto-acquisition"
        >创建自动获客任务</button>
        <span>无需先粘贴链接 · 需要已启用的搜索 API 和支持工具调用的 AI 模型</span>
      </div>
      <div class="replica-public-import-notice" role="note">
        系统只处理公开信息，不会自动认定客户身份，也不会自动私信、关注或触达客户。
      </div>
      <details class="replica-public-import-manual" ${manualImportOpen ? "open" : ""}>
        <summary>已有链接？补充导入</summary>
        <div class="replica-public-import-manual-body">
          <p>可补充抖音视频、公开主页或短链，每行一个。导入后仍需主体核验。</p>
          ${state.message
            ? `<p class="replica-public-import-message" role="status" aria-live="polite">${escapeHtml(state.message)}</p>`
            : ""}
          <label class="replica-public-import-field">
            <span>粘贴公开链接</span>
            <textarea
              rows="4"
              data-acquisition-import-url-input
              placeholder="https://www.douyin.com/video/...&#10;https://v.douyin.com/..."
              ${busy ? "disabled" : ""}
            >${escapeHtml(state.urlText)}</textarea>
          </label>
          <div class="replica-public-import-actions">
            <button
              type="button"
              data-acquisition-import-action="submit-urls"
              ${busy || state.urlText.trim().length === 0 ? "disabled" : ""}
            >${busy ? "正在导入" : "导入公开链接"}</button>
            <span>导入完成后，可从候选入口进入主体核验和 AI 研判。</span>
          </div>
          ${importResultsHtml(state.results)}
          ${outcomeHtml(state.outcome)}
        </div>
      </details>
    </section>
  `;
}

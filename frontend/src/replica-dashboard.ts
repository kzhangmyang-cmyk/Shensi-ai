import { startAcquisitionRuntime } from "./acquisition/runtime";
import { startAcquisitionTaskCreation } from "./acquisition/task-creation-controller";
import { startAcquisitionDetailCenter } from "./acquisition/detail-center-controller";
import { acquisitionDetailRequestForAction } from "./acquisition/detail-center-entry";
import { startAcquisitionPerformance } from "./acquisition/performance-controller";
import { startConnectionCenter } from "./connections/connection-controller";

type ReplicaTaskRow = HTMLButtonElement & {
  dataset: DOMStringMap & {
    taskId?: string;
    taskName?: string;
    taskSummary?: string;
    taskOwner?: string;
    taskProject?: string;
    taskDue?: string;
    taskStatus?: string;
    taskPriority?: string;
    taskTags?: string;
    acquisitionRealTask?: string;
    acquisitionPlanId?: string;
    evidenceCount?: string;
    requestCount?: string;
    resultCount?: string;
    durationSeconds?: string;
  };
};

type ReplicaFlowCard = HTMLButtonElement & {
  dataset: DOMStringMap & {
    flowTaskId?: string;
    flowState?: string;
  };
};

const replica = document.querySelector<HTMLElement>(".replica-shell");

if (replica) {
  const searchInput = document.querySelector<HTMLInputElement>("#replicaSearchInput");
  const toast = document.querySelector<HTMLElement>("#replicaToast");
  const flow = document.querySelector<HTMLElement>("#replicaFlowStage");
  const modal = document.querySelector<HTMLDialogElement>("#replicaTaskModal");
  const taskForm = document.querySelector<HTMLFormElement>("#replicaTaskForm");
  const flowPosition = document.querySelector<HTMLElement>("#replicaFlowPosition");
  let activeScope = "all";
  let activeFilter = "all";
  let searchQuery = "";
  let selectedTask = document.querySelector<ReplicaTaskRow>(".replica-task-row.active");
  let selectedFlowIndex = 0;
  let flowDragStartX: number | null = null;
  let flowDragPointerId: number | null = null;
  let flowPointerCardIndex: number | null = null;
  let suppressFlowClickUntil = 0;
  let lastFlowWheelAt = 0;
  let toastTimer = 0;

  const detail = {
    id: document.querySelector<HTMLElement>("#replicaDetailId"),
    name: document.querySelector<HTMLElement>("#replicaDetailNameText"),
    summary: document.querySelector<HTMLElement>("#replicaDetailSummary"),
    owner: document.querySelector<HTMLElement>("#replicaDetailOwner"),
    project: document.querySelector<HTMLElement>("#replicaDetailProject"),
    due: document.querySelector<HTMLElement>("#replicaDetailDue"),
    status: document.querySelector<HTMLElement>("#replicaDetailStatus"),
    priority: document.querySelector<HTMLElement>("#replicaDetailPriority"),
    priorityText: document.querySelector<HTMLElement>("#replicaDetailPriorityText"),
    tags: document.querySelector<HTMLElement>("#replicaDetailTags"),
    advice: document.querySelector<HTMLElement>("#replicaAdvicePrimary")
  };

  function escapeText(value: string) {
    return value.replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[character] || character);
  }

  function showToast(message: string) {
    if (!toast) return;
    const label = toast.querySelector("span");
    if (label) label.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2200);
  }

  function isAcquisitionActive(): boolean {
    const panel = document.querySelector<HTMLElement>("[data-replica-module-panel=\"acquisition\"]");
    return !panel || !panel.hidden;
  }

  function taskRows() {
    return Array.from(document.querySelectorAll<ReplicaTaskRow>(".replica-task-row"));
  }

  const initialTaskPlacements = taskRows().map((row) => ({ row, parent: row.parentElement }));

  function flowCards() {
    return Array.from(flow?.querySelectorAll<ReplicaFlowCard>(".replica-flow-card") || []);
  }

  function setFlowDragOffset(offset: number) {
    flow?.style.setProperty("--flow-drag-x", `${offset}px`);
  }

  function updateFlowLayout(nextIndex: number) {
    const cards = flowCards();
    if (!flow || cards.length === 0) return;
    selectedFlowIndex = ((nextIndex % cards.length) + cards.length) % cards.length;
    const half = Math.floor(cards.length / 2);
    const compact = flow.clientWidth < 620;
    const firstStep = compact ? 68 : 96;
    const nextStep = compact ? 48 : 72;

    cards.forEach((card, index) => {
      let offset = index - selectedFlowIndex;
      if (offset > half) offset -= cards.length;
      if (offset < -half) offset += cards.length;
      const distance = Math.abs(offset);
      const direction = Math.sign(offset);
      const x = offset === 0 ? 0 : direction * (firstStep + Math.max(0, distance - 1) * nextStep);
      const z = offset === 0 ? 88 : -44 * distance;
      const rotation = offset === 0 ? 0 : direction * -13;
      const scale = offset === 0 ? 1.07 : Math.max(0.82, 1 - distance * 0.055);
      const opacity = offset === 0 ? 1 : Math.max(0.34, 1 - distance * 0.16);
      const selected = index === selectedFlowIndex;
      card.style.setProperty("--flow-x", `${x}px`);
      card.style.setProperty("--flow-z", `${z}px`);
      card.style.setProperty("--flow-rotate", `${rotation}deg`);
      card.style.setProperty("--flow-scale", String(scale));
      card.style.setProperty("--flow-opacity", String(opacity));
      card.style.setProperty("--flow-layer", String(20 - distance));
      card.classList.toggle("is-selected", selected);
      card.setAttribute("aria-selected", String(selected));
      card.tabIndex = selected ? 0 : -1;
      const state = card.querySelector<HTMLElement>(".replica-flow-card-state");
      if (state) state.textContent = selected ? "当前选择" : card.dataset.flowState || "";
    });

    const selectedCard = cards[selectedFlowIndex];
    flow.setAttribute("aria-activedescendant", selectedCard.id);
    if (flowPosition) flowPosition.textContent = `${selectedFlowIndex + 1} / ${cards.length}`;
  }

  function syncFlowToTask(row: ReplicaTaskRow) {
    const cards = flowCards();
    const exactIndex = cards.findIndex((card) => card.dataset.flowTaskId === row.dataset.taskId);
    const platformIndex = exactIndex >= 0
      ? exactIndex
      : cards.findIndex((card) => {
        const linkedRow = taskRows().find((task) => task.dataset.taskId === card.dataset.flowTaskId);
        return linkedRow?.dataset.taskProject === row.dataset.taskProject;
      });
    if (platformIndex >= 0) updateFlowLayout(platformIndex);
  }

  function selectFlowProject(index: number, focusCard = false) {
    const cards = flowCards();
    if (cards.length === 0) return;
    updateFlowLayout(index);
    const selectedCard = cards[selectedFlowIndex];
    const row = taskRows().find((task) => task.dataset.taskId === selectedCard.dataset.flowTaskId);
    if (row) renderTaskDetail(row, false);
    if (focusCard) selectedCard.focus({ preventScroll: true });
  }

  function updateGroupCounts() {
    document.querySelectorAll<HTMLElement>(".replica-task-group").forEach((group) => {
      const count = Array.from(group.querySelectorAll<HTMLElement>(".replica-task-row")).filter((row) => !row.hidden).length;
      const countLabel = group.querySelector<HTMLElement>(".replica-group-head small");
      if (countLabel) countLabel.textContent = String(count);
      group.hidden = Boolean(group.querySelector(".replica-task-list")) && count === 0;
    });
  }

  function applyFilters() {
    const query = searchQuery.trim().toLowerCase();
    taskRows().forEach((row) => {
      const text = `${row.dataset.taskId || ""} ${row.dataset.taskName || ""} ${row.dataset.taskSummary || ""} ${row.dataset.taskProject || ""}`.toLowerCase();
      const scopeMatches = activeScope === "all"
        || (activeScope === "agent" && row.dataset.taskOwner === "智能体")
        || (activeScope === "script" && row.dataset.taskOwner === "自动工作流");
      const filterMatches = activeFilter === "all"
        || (activeFilter === "high" && row.dataset.taskPriority === "高")
        || (activeFilter === "active" && row.dataset.taskStatus === "进行中");
      row.hidden = !scopeMatches || !filterMatches || (query.length > 0 && !text.includes(query));
    });
    updateGroupCounts();
  }

  function renderTaskDetail(row: ReplicaTaskRow, syncFlow = true) {
    const isRealTask = row.dataset.acquisitionRealTask === "true";
    const planButton = document.querySelector<HTMLButtonElement>("#replicaEditTask");
    const candidateButton = document.querySelector<HTMLButtonElement>("#replicaCompleteTask");
    selectedTask?.classList.remove("active");
    selectedTask = row;
    selectedTask.classList.add("active");
    if (detail.id) detail.id.textContent = row.dataset.taskId || "--";
    if (detail.name) detail.name.textContent = row.dataset.taskName || "未命名任务";
    if (detail.summary) detail.summary.textContent = row.dataset.taskSummary || "暂无任务说明。";
    if (detail.owner) detail.owner.textContent = row.dataset.taskOwner || "--";
    if (detail.project) detail.project.textContent = row.dataset.taskProject || "--";
    if (detail.due) detail.due.textContent = row.dataset.taskDue || "--";
    if (detail.status) detail.status.textContent = row.dataset.taskStatus || "--";
    if (detail.priority) {
      detail.priority.textContent = isRealTask
        ? "真实任务"
        : `${row.dataset.taskPriority || "普通"}意向`;
    }
    if (detail.priorityText) detail.priorityText.textContent = row.dataset.taskPriority || "普通";
    if (detail.tags) {
      detail.tags.innerHTML = (row.dataset.taskTags || "待整理")
        .split(",")
        .map((tag) => `<span>${escapeText(tag.trim())}</span>`)
        .join("");
    }
    if (detail.advice) {
      detail.advice.textContent = isRealTask
        ? `真实任务数据已载入；公开证据不等于意向客户，需完成 AI 研判后再决定是否触达。`
        : `演示建议：优先处理“${row.dataset.taskProject || "当前平台"}”中包含明确购买、咨询或合作意图的内容`;
    }
    if (planButton) planButton.disabled = false;
    if (candidateButton) candidateButton.disabled = false;
    if (isRealTask) {
      document.dispatchEvent(new CustomEvent("goodjob:acquisition-task-selected", {
        detail: { planId: row.dataset.acquisitionPlanId || "" }
      }));
    }
    if (syncFlow) syncFlowToTask(row);
    flow?.classList.add("is-focused");
    window.setTimeout(() => flow?.classList.remove("is-focused"), 460);
  }

  replica.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const flowControl = target.closest<HTMLButtonElement>("[data-flow-direction]");
    if (flowControl) {
      const direction = Number(flowControl.dataset.flowDirection || "0");
      selectFlowProject(selectedFlowIndex + direction);
      return;
    }

    const flowCard = target.closest<ReplicaFlowCard>(".replica-flow-card");
    if (flowCard) {
      if (Date.now() < suppressFlowClickUntil) return;
      const index = flowCards().indexOf(flowCard);
      if (index >= 0) selectFlowProject(index);
      return;
    }

    const task = target.closest<ReplicaTaskRow>(".replica-task-row");
    if (task) {
      renderTaskDetail(task);
      return;
    }

    const scopeButton = target.closest<HTMLButtonElement>("[data-replica-scope]");
    if (scopeButton) {
      activeScope = scopeButton.dataset.replicaScope || "all";
      document.querySelectorAll<HTMLButtonElement>("[data-replica-scope]").forEach((button) => {
        const active = button === scopeButton;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      });
      applyFilters();
      return;
    }

    const groupButton = target.closest<HTMLButtonElement>("[data-group-toggle]");
    if (groupButton) {
      const group = groupButton.closest<HTMLElement>(".replica-task-group");
      const list = group?.querySelector<HTMLElement>(".replica-task-list");
      if (list) {
        list.hidden = !list.hidden;
        groupButton.querySelector("i")?.classList.toggle("ph-caret-right", list.hidden);
        groupButton.querySelector("i")?.classList.toggle("ph-caret-down", !list.hidden);
      }
      return;
    }

    const toolButton = target.closest<HTMLButtonElement>("[data-replica-tool]");
    if (toolButton) {
      const tool = toolButton.dataset.replicaTool;
      if (tool === "filter") {
        if (replica.dataset.acquisitionMode === "real") {
          showToast("真实任务需完成 AI 意向研判后才能按意向筛选");
          return;
        }
        const willEnable = activeFilter !== "high";
        activeFilter = willEnable ? "high" : "all";
        toolButton.classList.toggle("active", willEnable);
        applyFilters();
        showToast(willEnable ? "已只显示高意向获客任务" : "已显示全部获客任务");
      }
      if (tool === "sort") {
        document.querySelectorAll<HTMLElement>(".replica-task-list").forEach((list) => {
          const rows = Array.from(list.querySelectorAll<ReplicaTaskRow>(".replica-task-row"));
          rows.reverse().forEach((row) => list.append(row));
        });
        toolButton.classList.toggle("active");
        showToast("任务顺序已调整");
      }
      return;
    }

    const timelineButton = target.closest<HTMLButtonElement>("[data-timeline-scale]");
    if (timelineButton) {
      document.querySelectorAll<HTMLButtonElement>("[data-timeline-scale]").forEach((button) => button.classList.toggle("active", button === timelineButton));
      showToast(timelineButton.dataset.timelineScale === "today" ? "已定位到今天" : "已切换为周视图");
    }
  });

  searchInput?.addEventListener("input", () => {
    searchQuery = searchInput.value;
    applyFilters();
  });

  searchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      searchInput.value = "";
      searchQuery = "";
      applyFilters();
    }
  });

  flow?.addEventListener("pointerdown", (event) => {
    if ((event.target as HTMLElement).closest(".replica-flow-control")) return;
    flowDragStartX = event.clientX;
    flowDragPointerId = event.pointerId;
    const pressedCard = (event.target as HTMLElement).closest<ReplicaFlowCard>(".replica-flow-card");
    flowPointerCardIndex = pressedCard ? flowCards().indexOf(pressedCard) : null;
    flow.classList.add("is-dragging");
    flow.setPointerCapture(event.pointerId);
  });

  flow?.addEventListener("pointermove", (event) => {
    if (flowDragStartX === null || event.pointerId !== flowDragPointerId) return;
    const offset = Math.max(-72, Math.min(72, event.clientX - flowDragStartX));
    setFlowDragOffset(offset);
  });

  function finishFlowDrag(event: PointerEvent) {
    if (flowDragStartX === null || event.pointerId !== flowDragPointerId) return;
    const offset = event.clientX - flowDragStartX;
    if (Math.abs(offset) >= 34) {
      suppressFlowClickUntil = Date.now() + 260;
      selectFlowProject(selectedFlowIndex + (offset < 0 ? 1 : -1));
    } else if (flowPointerCardIndex !== null && flowPointerCardIndex !== selectedFlowIndex) {
      suppressFlowClickUntil = Date.now() + 260;
      selectFlowProject(flowPointerCardIndex);
    } else if (flow) {
      const bounds = flow.getBoundingClientRect();
      const sideOffset = event.clientX - (bounds.left + bounds.width / 2);
      if (Math.abs(sideOffset) >= 74) {
        suppressFlowClickUntil = Date.now() + 260;
        selectFlowProject(selectedFlowIndex + (sideOffset > 0 ? 1 : -1));
      }
    }
    flowDragStartX = null;
    flowDragPointerId = null;
    flowPointerCardIndex = null;
    setFlowDragOffset(0);
    flow?.classList.remove("is-dragging");
  }

  flow?.addEventListener("pointerup", finishFlowDrag);
  flow?.addEventListener("pointercancel", finishFlowDrag);

  flow?.addEventListener("wheel", (event) => {
    const horizontalDelta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
      ? event.deltaX
      : event.shiftKey
        ? event.deltaY
        : 0;
    if (Math.abs(horizontalDelta) < 10 || Date.now() - lastFlowWheelAt < 420) return;
    event.preventDefault();
    lastFlowWheelAt = Date.now();
    selectFlowProject(selectedFlowIndex + (horizontalDelta > 0 ? 1 : -1));
  }, { passive: false });

  flow?.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      selectFlowProject(selectedFlowIndex + (event.key === "ArrowRight" ? 1 : -1), true);
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      selectFlowProject(event.key === "Home" ? 0 : flowCards().length - 1, true);
    }
  });

  window.addEventListener("resize", () => updateFlowLayout(selectedFlowIndex));

  document.querySelector("#replicaNewTaskButton")?.addEventListener("click", () => {
    if (!isAcquisitionActive()) return;
    if (replica.dataset.acquisitionMode === "real") {
      document.dispatchEvent(new CustomEvent("goodjob:acquisition-create-requested"));
      return;
    }
    modal?.showModal();
  });
  document.querySelector("#replicaModalClose")?.addEventListener("click", () => modal?.close());
  document.querySelector("#replicaModalCancel")?.addEventListener("click", () => modal?.close());
  document.querySelector("#replicaEditTask")?.addEventListener("click", () => {
    if (!selectedTask) return;
    if (replica.dataset.acquisitionMode === "real") {
      const request = acquisitionDetailRequestForAction(
        replica.dataset.acquisitionMode,
        "replicaEditTask",
        selectedTask.dataset.acquisitionPlanId
      );
      if (!request) {
        showToast("请先选择一个真实抖音获客任务");
        return;
      }
      document.dispatchEvent(new CustomEvent(
        "goodjob:acquisition-detail-open-requested",
        { detail: request }
      ));
      return;
    }
    const nameInput = document.querySelector<HTMLInputElement>("#replicaTaskName");
    const dueInput = document.querySelector<HTMLInputElement>("#replicaTaskDue");
    const summaryInput = document.querySelector<HTMLTextAreaElement>("#replicaTaskSummary");
    const platformInput = document.querySelector<HTMLSelectElement>("#replicaTaskStage");
    const modeInput = document.querySelector<HTMLSelectElement>("#replicaTaskMode");
    if (nameInput) nameInput.value = selectedTask.dataset.taskName || "";
    if (summaryInput) summaryInput.value = selectedTask.dataset.taskSummary || "";
    if (dueInput) dueInput.value = "";
    if (platformInput) platformInput.value = selectedTask.dataset.taskProject || "抖音";
    if (modeInput) modeInput.value = selectedTask.dataset.taskOwner || "智能体";
    modal?.showModal();
  });

  document.querySelector("#replicaCompleteTask")?.addEventListener("click", (event) => {
    if (!isAcquisitionActive() || replica.dataset.acquisitionMode !== "real") return;
    event.preventDefault();
    event.stopPropagation();
    const request = acquisitionDetailRequestForAction(
      replica.dataset.acquisitionMode,
      "replicaCompleteTask",
      selectedTask?.dataset.acquisitionPlanId
    );
    if (!request) {
      showToast("请先选择一个真实抖音获客任务");
      return;
    }
    document.dispatchEvent(new CustomEvent(
      "goodjob:acquisition-detail-open-requested",
      { detail: request }
    ));
  });

  document.querySelector("#replicaAdviceButton")?.addEventListener("click", () => {
    showToast(replica.dataset.acquisitionMode === "real"
      ? "真实证据必须经过 AI 研判和人工审核，不能直接视为意向客户"
      : "演示：已展开 AI 建议；不会读取或操作真实平台数据");
  });

  taskForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!isAcquisitionActive()) {
      modal?.close();
      return;
    }
    if (replica.dataset.acquisitionMode === "real") {
      modal?.close();
      showToast("真实模式不会创建本地模拟任务");
      return;
    }
    const name = document.querySelector<HTMLInputElement>("#replicaTaskName")?.value.trim() || "新演示获客任务";
    const summary = document.querySelector<HTMLTextAreaElement>("#replicaTaskSummary")?.value.trim() || "演示扫描相关话题和评论，模拟识别需求客户并生成沟通记录。";
    const stage = document.querySelector<HTMLSelectElement>("#replicaTaskStage")?.value || "抖音";
    const mode = document.querySelector<HTMLSelectElement>("#replicaTaskMode")?.value || "智能体";
    const due = document.querySelector<HTMLInputElement>("#replicaTaskDue")?.value.replace("T", " ") || "立即启动";
    const list = document.querySelector<HTMLElement>(".replica-task-group .replica-task-list");
    if (list) {
      const nextId = `ACQ-${stage.toUpperCase()}-${String(taskRows().length + 1).padStart(2, "0")}`;
      const row = document.createElement("button") as ReplicaTaskRow;
      row.type = "button";
      row.className = "replica-task-row";
      row.dataset.taskId = nextId;
      row.dataset.taskName = name;
      row.dataset.taskSummary = summary;
      row.dataset.taskOwner = mode;
      row.dataset.taskProject = stage;
      row.dataset.taskDue = due;
      row.dataset.taskStatus = "演示：模拟待启动";
      row.dataset.taskPriority = "中";
      row.dataset.taskTags = `${stage},${mode},新建`;
      row.dataset.demoCreated = "true";
      row.innerHTML = `<span>${escapeText(nextId)}</span><b>${escapeText(name)}</b><span><span class="priority medium">${escapeText(mode === "智能体" ? "智能体" : "工作流")}</span> 模拟待启动</span>`;
      list.prepend(row);
      renderTaskDetail(row);
      applyFilters();
    }
    taskForm.reset();
    modal?.close();
    showToast(`演示：“${name}”已创建`);
  });

  function resetAcquisitionTransientState() {
    taskRows().filter((row) => row.dataset.demoCreated === "true").forEach((row) => row.remove());
    initialTaskPlacements.forEach(({ row, parent }) => parent?.append(row));
    activeScope = "all";
    activeFilter = "all";
    searchQuery = "";
    if (searchInput) searchInput.value = "";
    document.querySelectorAll<HTMLButtonElement>("[data-replica-scope]").forEach((button) => {
      const active = button.dataset.replicaScope === "all";
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll<HTMLButtonElement>("[data-replica-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.replicaTool === "view");
    });
    document.querySelectorAll<HTMLElement>(".replica-task-list").forEach((list) => {
      list.hidden = false;
    });
    document.querySelectorAll<HTMLButtonElement>("[data-group-toggle]").forEach((button) => {
      button.querySelector("i")?.classList.remove("ph-caret-right");
      button.querySelector("i")?.classList.add("ph-caret-down");
    });
    document.querySelectorAll<HTMLButtonElement>("[data-timeline-scale]").forEach((button) => {
      button.classList.toggle("active", button.dataset.timelineScale === "week");
    });
    taskForm?.reset();
    if (modal?.open) modal.close();
    selectedTask = initialTaskPlacements[0]?.row ?? null;
    if (selectedTask) renderTaskDetail(selectedTask);
    applyFilters();
    updateFlowLayout(0);
  }

  document.addEventListener("goodjob:demo-reset", resetAcquisitionTransientState);

  document.addEventListener("goodjob:acquisition-mode-changed", (event) => {
    const mode = (event as CustomEvent<{ mode?: string }>).detail?.mode;
    activeScope = "all";
    activeFilter = "all";
    searchQuery = "";
    if (searchInput) searchInput.value = "";
    document.querySelectorAll<HTMLButtonElement>("[data-replica-scope]").forEach((button) => {
      const active = button.dataset.replicaScope === "all";
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll<HTMLButtonElement>("[data-replica-tool]").forEach((button) => {
      button.classList.toggle("active", button.dataset.replicaTool === "view");
    });
    const nextTask = mode === "real"
      ? document.querySelector<ReplicaTaskRow>("[data-acquisition-real-task=\"true\"]")
      : initialTaskPlacements[0]?.row ?? null;
    if (nextTask) renderTaskDetail(nextTask);
    applyFilters();
  });

  document.addEventListener("goodjob:acquisition-notify", (event) => {
    const message = (event as CustomEvent<{ message?: unknown }>).detail?.message;
    if (typeof message === "string" && message.trim()) showToast(message.trim());
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      searchInput?.focus();
    }
  });

  updateFlowLayout(selectedFlowIndex);
}

startAcquisitionRuntime();
startAcquisitionTaskCreation();
startAcquisitionDetailCenter();
startAcquisitionPerformance();
startConnectionCenter();

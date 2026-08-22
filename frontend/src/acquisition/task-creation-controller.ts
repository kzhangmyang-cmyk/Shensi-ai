import {
  applyDouyinPublicCommentSamplePolicy,
  buildDouyinPlanInput,
  type DouyinPlanInput,
  type DouyinPublicCommentSample,
  createAcquisitionTaskCreationApi,
  type AcquisitionSearchConnection,
  type ToolCallingModelConnection
} from "./task-creation-api";
import { createPlanDraftWorkflow } from "./plan-draft-workflow";
import { renderPlanDraftPreview } from "./plan-draft-view";
import { createTaskCreationWorkflow } from "./task-creation-workflow";

let started = false;

export interface TaskCreationSubmitState {
  searchConnectionId: string;
  modelConnectionId: string;
  approvalConfirmed: boolean;
  loading: boolean;
  submitting: boolean;
  completed: boolean;
}

export function isTaskCreationSubmitReady(
  state: TaskCreationSubmitState
): boolean {
  return Boolean(
    state.searchConnectionId
    && state.modelConnectionId
    && state.approvalConfirmed
    && !state.loading
    && !state.submitting
    && !state.completed
  );
}

export function isPlanDraftSubmissionReady(state: {
  mode: "ai" | "manual";
  hasDraft: boolean;
  approvalConfirmed: boolean;
  loading: boolean;
  submitting: boolean;
  completed: boolean;
}): boolean {
  return state.mode === "manual"
    ? state.approvalConfirmed && !state.loading && !state.submitting && !state.completed
    : state.hasDraft && state.approvalConfirmed && !state.loading && !state.submitting && !state.completed;
}

export function prepareAiPlanForApproval(
  plan: DouyinPlanInput,
  sample: DouyinPublicCommentSample | undefined
): DouyinPlanInput {
  return applyDouyinPublicCommentSamplePolicy(plan, sample);
}

export function commentSamplePlanChanged(
  previous: DouyinPublicCommentSample | undefined,
  next: DouyinPublicCommentSample | undefined
): boolean {
  return previous?.enabled !== next?.enabled
    || previous?.maxVideosPerRun !== next?.maxVideosPerRun
    || previous?.maxCommentsPerVideo !== next?.maxCommentsPerVideo
    || previous?.maxPagesPerVideo !== next?.maxPagesPerVideo;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function inputValue(id: string): string {
  return byId<HTMLInputElement | HTMLTextAreaElement>(id)?.value.trim() ?? "";
}

function numberValue(id: string): number {
  return Number(byId<HTMLInputElement>(id)?.value ?? "");
}

function splitValues(value: string): string[] {
  return value
    .split(/[，,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function optionLabel(connection: AcquisitionSearchConnection): string {
  const provider = connection.providerId.replace(/_/g, " ");
  return `${provider} · 凭据 v${connection.credentialVersion}`;
}

function modelOptionLabel(connection: ToolCallingModelConnection): string {
  return `${connection.provider} · ${connection.model} · 凭据 v${connection.credentialVersion}`;
}

function initialise(): void {
  const dialog = byId<HTMLDialogElement>("replicaRealTaskModal");
  const form = byId<HTMLFormElement>("replicaRealTaskForm");
  const close = byId<HTMLButtonElement>("replicaRealTaskClose");
  const cancel = byId<HTMLButtonElement>("replicaRealTaskCancel");
  const refresh = byId<HTMLButtonElement>("replicaRealConnectionsRefresh");
  const configure = byId<HTMLButtonElement>("replicaRealConnectionsConfigure");
  const searchSelect = byId<HTMLSelectElement>("replicaRealSearchConnection");
  const modelSelect = byId<HTMLSelectElement>("replicaRealModelConnection");
  const approvalConfirmed = byId<HTMLInputElement>("replicaRealApprovalConfirmed");
  const submit = byId<HTMLButtonElement>("replicaRealTaskSubmit");
  const aiMode = byId<HTMLButtonElement>("replicaRealTaskModeAi");
  const manualMode = byId<HTMLButtonElement>("replicaRealTaskModeManual");
  const aiPrompt = byId<HTMLTextAreaElement>("replicaRealAiPrompt");
  const aiGenerate = byId<HTMLButtonElement>("replicaRealAiGenerate");
  const aiDraft = byId("replicaRealAiDraft");
  const aiSection = byId("replicaRealAiSection");
  const manualFields = byId("replicaRealManualFields");
  const preflight = byId("replicaRealPreflightStatus");
  const submitStatus = byId("replicaRealTaskSubmitStatus");
  const commentSample = byId<HTMLInputElement>("replicaRealCommentSampleEnabled");
  const commentSampleFields = byId<HTMLFieldSetElement>("replicaRealCommentSampleFields");
  if (!dialog || !form || !searchSelect || !modelSelect || !submit) return;

  const taskDialog = dialog;
  const taskForm = form;
  const searchConnectionSelect = searchSelect;
  const modelConnectionSelect = modelSelect;
  const submitButton = submit;

  const api = createAcquisitionTaskCreationApi();
  const workflow = createTaskCreationWorkflow(api);
  const planDraftWorkflow = createPlanDraftWorkflow(api);
  let searchConnections: AcquisitionSearchConnection[] = [];
  let modelConnections: ToolCallingModelConnection[] = [];
  let loadingConnections = false;
  let submitting = false;
  let completed = false;
  let mode: "ai" | "manual" = "ai";
  let generatedPlan: ReturnType<typeof buildDouyinPlanInput> | null = null;
  let generatedCommentSample: DouyinPublicCommentSample | undefined;
  let generation = 0;

  function selectedCommentSample() {
    if (!commentSample?.checked) return undefined;
    return {
      enabled: true,
      maxVideosPerRun: numberValue("replicaRealCommentMaxVideos"),
      maxCommentsPerVideo: numberValue("replicaRealCommentMaxComments"),
      maxPagesPerVideo: numberValue("replicaRealCommentMaxPages")
    };
  }

  function updateCommentSampleFields(): void {
    if (commentSampleFields) commentSampleFields.disabled = commentSample?.checked !== true;
  }

  function setPreflight(message: string, state: "loading" | "ready" | "blocked"): void {
    if (!preflight) return;
    preflight.textContent = message;
    preflight.dataset.state = state;
  }

  function setSubmitStatus(message: string, state: "loading" | "success" | "error"): void {
    if (!submitStatus) return;
    submitStatus.hidden = false;
    submitStatus.dataset.state = state;
    submitStatus.textContent = message;
  }

  function updateSubmitAvailability(): void {
    submitButton.disabled = mode === "manual"
      ? !isTaskCreationSubmitReady({
        searchConnectionId: searchConnectionSelect.value,
        modelConnectionId: modelConnectionSelect.value,
        approvalConfirmed: approvalConfirmed?.checked === true,
        loading: loadingConnections,
        submitting,
        completed
      })
      : !isPlanDraftSubmissionReady({
        mode,
        hasDraft: generatedPlan !== null,
        approvalConfirmed: approvalConfirmed?.checked === true,
        loading: loadingConnections,
        submitting,
        completed
      });
  }

  function setMode(nextMode: "ai" | "manual"): void {
    if (completed) return;
    mode = nextMode;
    invalidateGeneratedPlan();
    aiMode?.setAttribute("aria-pressed", String(mode === "ai"));
    manualMode?.setAttribute("aria-pressed", String(mode === "manual"));
    if (manualFields) manualFields.hidden = mode !== "manual";
    if (aiSection) aiSection.hidden = mode !== "ai";
    manualFields?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select").forEach((field) => {
      field.disabled = mode === "ai";
    });
    if (aiPrompt) aiPrompt.disabled = mode !== "ai";
    updateCommentSampleFields();
    submitButton.innerHTML = mode === "ai"
      ? '<i class="ph ph-play" aria-hidden="true"></i>批准并启动 AI 方案'
      : '<i class="ph ph-play" aria-hidden="true"></i>创建、批准并启动';
    updateSubmitAvailability();
  }

  function invalidateGeneratedPlan(): void {
    generation += 1;
    planDraftWorkflow.clear();
    generatedPlan = null;
    generatedCommentSample = undefined;
    if (approvalConfirmed) approvalConfirmed.checked = false;
    if (aiGenerate) aiGenerate.disabled = false;
    if (aiDraft) {
      aiDraft.hidden = true;
      aiDraft.replaceChildren();
    }
    updateSubmitAvailability();
  }

  async function generatePlanDraft(): Promise<void> {
    if (mode !== "ai" || loadingConnections || submitting || completed) return;
    if (!modelConnectionSelect.value) {
      setSubmitStatus("请先选择一个支持工具调用的 AI 模型。", "error");
      return;
    }
    const prompt = aiPrompt?.value.trim() ?? "";
    if (!prompt) {
      setSubmitStatus("请用一句话描述您的抖音获客目标。", "error");
      return;
    }
    invalidateGeneratedPlan();
    const requestGeneration = generation;
    aiGenerate!.disabled = true;
    setSubmitStatus("AI 增长参谋正在生成完整服务端计划草稿…", "loading");
    try {
      const result = await planDraftWorkflow.generate({
        modelConnectionId: modelConnectionSelect.value,
        prompt
      });
      if (requestGeneration !== generation || mode !== "ai") return;
      const sample = selectedCommentSample();
      generatedPlan = prepareAiPlanForApproval(result.planDraft, sample);
      generatedCommentSample = sample;
      if (aiDraft) {
        aiDraft.innerHTML = renderPlanDraftPreview(generatedPlan);
        aiDraft.hidden = false;
      }
      setSubmitStatus("计划草稿已生成。请完整核对后勾选人工批准。", "success");
    } catch (error) {
      if (requestGeneration !== generation) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      setSubmitStatus(error instanceof Error ? error.message : "AI 计划生成失败", "error");
    } finally {
      if (requestGeneration === generation) {
        if (aiGenerate) aiGenerate.disabled = false;
        updateSubmitAvailability();
      }
    }
  }

  function renderConnections(): void {
    searchConnectionSelect.replaceChildren();
    modelConnectionSelect.replaceChildren();

    if (searchConnections.length === 0) {
      searchConnectionSelect.add(new Option("未配置已启用的真实搜索 API", ""));
    } else {
      searchConnections.forEach((connection) => {
        searchConnectionSelect.add(new Option(optionLabel(connection), connection.id));
      });
    }

    if (modelConnections.length === 0) {
      modelConnectionSelect.add(new Option("未配置支持工具调用的 AI 模型", ""));
    } else {
      modelConnections.forEach((connection) => {
        modelConnectionSelect.add(new Option(modelOptionLabel(connection), connection.id));
      });
    }

    if (searchConnections.length > 0 && modelConnections.length > 0) {
      setPreflight(
        `运行条件已满足：${optionLabel(searchConnections[0]!)}；${modelOptionLabel(modelConnections[0]!)}。`,
        "ready"
      );
    } else if (searchConnections.length === 0 && modelConnections.length === 0) {
      setPreflight("还缺 2 项：请先配置并测试真实搜索 API，以及支持工具调用的 AI 模型连接。", "blocked");
    } else if (searchConnections.length === 0) {
      setPreflight("还缺 1 项：请先配置并测试一个真实搜索 API 连接。", "blocked");
    } else {
      setPreflight("还缺 1 项：请先配置一个支持工具调用的 AI 模型连接。", "blocked");
    }
    updateSubmitAvailability();
  }

  async function loadConnections(): Promise<void> {
    if (loadingConnections) return;
    loadingConnections = true;
    updateSubmitAvailability();
    setPreflight("正在核验真实搜索 API 与 AI 模型连接…", "loading");
    searchConnectionSelect.replaceChildren(new Option("正在读取可用连接…", ""));
    modelConnectionSelect.replaceChildren(new Option("正在读取可用模型…", ""));
    try {
      [searchConnections, modelConnections] = await Promise.all([
        api.listActiveSearchConnections(),
        api.listToolCallingModelConnections()
      ]);
      renderConnections();
    } catch (error) {
      searchConnections = [];
      modelConnections = [];
      const message = error instanceof Error ? error.message : "连接检查失败";
      renderConnections();
      setPreflight(`真实连接检查失败：${message}`, "blocked");
    } finally {
      loadingConnections = false;
      updateSubmitAvailability();
    }
  }

  function resetDialog(): void {
    completed = false;
    taskForm.dataset.state = "editing";
    taskForm.reset();
    taskForm.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>(
      "input, textarea, select, button"
    ).forEach((control) => {
      control.disabled = false;
    });
    if (cancel) cancel.textContent = "取消";
    if (submitStatus) submitStatus.hidden = true;
    setMode("ai");
  }

  function markCompleted(): void {
    completed = true;
    taskForm.dataset.state = "completed";
    taskForm.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>(
      "input, textarea, select, button"
    ).forEach((control) => {
      if (control === close || control === cancel) return;
      control.disabled = true;
    });
    submitButton.innerHTML = '<i class="ph ph-check-circle" aria-hidden="true"></i>任务已启动';
    if (cancel) cancel.textContent = "关闭";
  }

  function openDialog(): void {
    resetDialog();
    if (!taskDialog.open) taskDialog.showModal();
    void loadConnections();
  }

  function closeDialog(): void {
    if (submitting) return;
    resetDialog();
    taskDialog.close();
  }

  document.addEventListener("goodjob:acquisition-create-requested", openDialog);
  close?.addEventListener("click", closeDialog);
  cancel?.addEventListener("click", closeDialog);
  refresh?.addEventListener("click", () => void loadConnections());
  configure?.addEventListener("click", () => {
    const mode = searchConnections.length === 0 ? "search" : "model";
    document.dispatchEvent(new CustomEvent("goodjob:connections-open-requested", {
      detail: { mode, returnTo: "task-creation" }
    }));
  });
  document.addEventListener("goodjob:connections-changed", () => {
    if (taskDialog.open) {
      if (mode === "ai") invalidateGeneratedPlan();
      void loadConnections();
    }
  });
  searchConnectionSelect.addEventListener("change", () => {
    if (mode === "ai") invalidateGeneratedPlan();
    updateSubmitAvailability();
  });
  modelConnectionSelect.addEventListener("change", () => {
    if (mode === "ai") invalidateGeneratedPlan();
    updateSubmitAvailability();
  });
  approvalConfirmed?.addEventListener("change", updateSubmitAvailability);
  commentSample?.addEventListener("change", () => {
    updateCommentSampleFields();
    invalidateGeneratedPlan();
  });
  ["replicaRealCommentMaxVideos", "replicaRealCommentMaxComments", "replicaRealCommentMaxPages"]
    .forEach((id) => byId<HTMLInputElement>(id)?.addEventListener("input", () => {
      if (mode === "ai" && generatedPlan && commentSamplePlanChanged(
        generatedCommentSample,
        selectedCommentSample()
      )) invalidateGeneratedPlan();
    }));
  aiMode?.addEventListener("click", () => setMode("ai"));
  manualMode?.addEventListener("click", () => setMode("manual"));
  aiPrompt?.addEventListener("input", () => {
    if (mode === "ai") invalidateGeneratedPlan();
  });
  aiGenerate?.addEventListener("click", () => void generatePlanDraft());

  taskForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submitting || completed || !taskForm.reportValidity()) return;
    const providerConnection = searchConnections.find(
      (connection) => connection.id === searchConnectionSelect.value
    );
    if (mode === "manual" && (!providerConnection || !modelConnectionSelect.value)) {
      setSubmitStatus("真实运行条件尚未满足，请先完成连接检查。", "error");
      return;
    }

    let planInput: ReturnType<typeof buildDouyinPlanInput>;
    try {
      planInput = mode === "ai"
        ? generatedPlan ?? (() => { throw new Error("请先生成完整 AI 计划草稿"); })()
        : buildDouyinPlanInput({
        name: inputValue("replicaRealTaskName"),
        objective: inputValue("replicaRealObjective"),
        industries: splitValues(inputValue("replicaRealIndustries")),
        regions: splitValues(inputValue("replicaRealRegions")),
        organizationCriteria: splitValues(inputValue("replicaRealOrganizationCriteria")),
        individualCriteria: splitValues(inputValue("replicaRealIndividualCriteria")),
        exclusionRules: splitValues(inputValue("replicaRealExclusions")),
        organizationQuery: inputValue("replicaRealOrganizationQuery"),
        individualQuery: inputValue("replicaRealIndividualQuery"),
        providerConnection: providerConnection!,
        modelConnectionId: modelConnectionSelect.value,
        budget: {
          billingCurrency: "CNY",
          maxRequests: numberValue("replicaRealMaxRequests"),
          maxResults: numberValue("replicaRealMaxResults"),
          maxAmountMinor: numberValue("replicaRealMaxAmount"),
          maxDurationSeconds: numberValue("replicaRealMaxDuration")
        },
        douyinPublicCommentSample: selectedCommentSample()
      });
    } catch (error) {
      setSubmitStatus(error instanceof Error ? error.message : "任务参数不完整", "error");
      return;
    }

    submitting = true;
    updateSubmitAvailability();
    void (async () => {
      try {
        const result = await workflow.execute({
          planInput,
          approval: {
            decision: "approve",
            reason: inputValue("replicaRealApprovalReason")
          },
          run: {
            reason: inputValue("replicaRealRunReason")
          },
          onStage(stage) {
            if (stage === "creating-plan") {
              setSubmitStatus("第 1/3 步：正在创建可审计的获客计划…", "loading");
            } else if (stage === "approving-plan") {
              setSubmitStatus("第 2/3 步：计划已创建，正在记录人工批准…", "loading");
            } else {
              setSubmitStatus("第 3/3 步：方案已批准，正在创建真实运行…", "loading");
            }
          }
        });
        const run = result.run;
        const runId = typeof run.id === "string" ? run.id : "--";
        const runStatus = typeof run.status === "string" ? run.status : "queued";
        setSubmitStatus(`任务已开始 · Run ${runId} · ${runStatus}`, "success");
        document.dispatchEvent(new CustomEvent("goodjob:acquisition-notify", {
          detail: { message: "真实抖音获客任务已批准并开始运行" }
        }));
        document.dispatchEvent(new Event("goodjob:acquisition-refresh-requested"));
        markCompleted();
      } catch (error) {
        const message = error instanceof Error ? error.message : "真实任务创建失败";
        const pendingPlanId = workflow.pendingPlanId();
        setSubmitStatus(
          pendingPlanId
            ? `创建失败：${message}。计划 ${pendingPlanId} 已保留，重试不会重复创建计划。`
            : `创建失败：${message}`,
          "error"
        );
      } finally {
        submitting = false;
        updateSubmitAvailability();
      }
    })();
  });
}

export function startAcquisitionTaskCreation(): void {
  if (started || typeof document === "undefined") return;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startAcquisitionTaskCreation, { once: true });
    return;
  }
  started = true;
  initialise();
}

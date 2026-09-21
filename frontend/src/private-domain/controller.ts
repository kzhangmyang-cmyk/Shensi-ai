import {
  createPrivateDomainRuntimeApi,
  pendingAcquisitionBindings,
  type PrivateDomainRuntimeApi
} from "./runtime-api";
import {
  renderPrivateDomainView,
  type PrivateDomainSurface,
  type PrivateDomainViewState
} from "./view";

export interface PrivateDomainControllerOptions {
  api?: PrivateDomainRuntimeApi;
  main?: HTMLElement | null;
  inspector?: HTMLElement | null;
  eventTarget?: EventTarget;
  surface?: PrivateDomainSurface;
}

export interface PrivateDomainController {
  getState(): Readonly<PrivateDomainViewState>;
  whenIdle(): Promise<void>;
  open(preferredCustomerId?: string): Promise<void>;
  deactivate(): void;
  selectCustomer(customerId: string): void;
  setCustomerFilter(filter: PrivateDomainViewState["customerFilter"]): void;
  setCustomerQuery(query: string): void;
  setGradeFilter(grade: string): void;
  setStageFilter(stage: string): void;
  setOwnerFilter(ownerId: string): void;
  setCustomerPage(page: number): void;
  setPageSize(pageSize: number): void;
  destroy(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "真实私域数据读取失败";
}

export function createPrivateDomainController(
  options: PrivateDomainControllerOptions = {}
): PrivateDomainController {
  const api = options.api ?? createPrivateDomainRuntimeApi();
  const main = options.main ?? (typeof document === "undefined"
    ? null
    : document.getElementById("demoModuleMain"));
  const inspector = options.inspector ?? (typeof document === "undefined"
    ? null
    : document.getElementById("demoModuleInspector"));
  const eventTarget = options.eventTarget ?? (typeof document === "undefined"
    ? new EventTarget()
    : document);
  const state: PrivateDomainViewState = {
    status: "ready",
    customers: [],
    todos: [],
    selectedCustomerId: null,
    customerFilter: "all",
    customerQuery: "",
    gradeFilter: "",
    stageFilter: "",
    ownerFilter: "",
    currentPage: 1,
    pageSize: 20,
    error: null
  };
  let disposed = false;
  let active = false;
  let requestSerial = 0;
  let mutationSerial = 0;
  let selectionSerial = 0;
  let idlePromise = Promise.resolve();

  function render() {
    if (active && main && inspector) {
      renderPrivateDomainView(state, main, inspector, { surface: options.surface });
    }
  }

  function openEditor(kind: NonNullable<PrivateDomainViewState["editor"]>["kind"], todoId?: string) {
    if (!active || disposed || state.editor?.submitting) return;
    const customer = state.customers.find((item) => item.id === state.selectedCustomerId);
    if (kind !== "customer" && !customer) return;
    if (kind === "complete" && !state.todos.some((todo) => todo.id === todoId
      && todo.customerId === customer?.id && !todo.done && !todo.cancelledAt && !todo.historyAt)) return;
    mutationSerial += 1;
    state.notice = null;
    state.editor = {
      kind, customerId: kind === "customer" ? undefined : customer?.id, todoId,
      values: kind === "customer" ? { company: "", country: "未知", contact: "待维护", stage: "询盘", grade: "C" }
        : kind === "activity" ? { type: "note", content: "", nextReminder: "" }
          : kind === "todo" ? { title: "", dueAt: "", priority: "normal" } : { completionResult: "" },
      submitting: false, error: null
    };
    render();
  }

  function submitEditor() {
    const editor = state.editor;
    if (!active || disposed || !editor || editor.submitting) return;
    const value = (name: string) => editor.values[name]?.trim() ?? "";
    const required = editor.kind === "customer" ? ["company"] : editor.kind === "activity" ? ["content"]
      : editor.kind === "todo" ? ["title", "dueAt"] : ["completionResult"];
    if (required.some((name) => !value(name))) {
      editor.error = "请填写必填内容"; render(); return;
    }
    const serial = ++mutationSerial;
    const isCurrent = () => active && !disposed && serial === mutationSerial && state.editor === editor
      && (editor.kind === "customer" || state.selectedCustomerId === editor.customerId);
    editor.submitting = true;
    editor.error = null;
    render();
    const operation = (async () => {
      try {
        let customerId = editor.customerId;
        if (editor.kind === "customer") {
          if (!api.createCustomer) throw new Error("客户录入暂不可用");
          const customer = await api.createCustomer({ company: value("company"), country: value("country") || "未知",
            contact: value("contact") || "待维护", stage: value("stage") || "询盘", grade: value("grade") as "A" | "B" | "C" | "D" });
          customerId = customer.id;
        } else if (editor.kind === "activity") {
          if (!api.recordActivity) throw new Error("跟进录入暂不可用");
          await api.recordActivity(editor.customerId!, { type: value("type"), content: value("content"), nextReminder: value("nextReminder") });
        } else if (editor.kind === "todo") {
          if (!api.createTodo) throw new Error("待办安排暂不可用");
          const customer = state.customers.find((item) => item.id === editor.customerId)!;
          await api.createTodo({ title: value("title"), type: "customer", priority: value("priority") as "high" | "medium" | "normal",
            dueAt: value("dueAt"), related: customer.company, customerId: editor.customerId });
        } else {
          if (!api.completeTodo) throw new Error("待办完成暂不可用");
          await api.completeTodo(editor.todoId!, value("completionResult"));
        }
        if (!isCurrent()) return;
        state.editor = null;
        state.notice = { customer: "客户已保存", activity: "跟进已记录", todo: "待办已安排", complete: "待办已完成" }[editor.kind];
        if (editor.kind === "customer") {
          state.customerFilter = "all"; state.customerQuery = ""; state.gradeFilter = "";
          state.stageFilter = ""; state.ownerFilter = ""; state.currentPage = 1;
        }
        // A successful write is never retried when the subsequent read fails.
        await controller.open(customerId).catch(() => undefined);
      } catch (error) {
        if (!isCurrent()) return;
        editor.submitting = false;
        editor.error = errorText(error);
        render();
      }
    })();
    idlePromise = operation;
  }

  const controller: PrivateDomainController = {
    getState() {
      return state;
    },
    whenIdle() {
      return idlePromise;
    },
    open(preferredCustomerId) {
      if (disposed) return Promise.resolve();
      active = true;
      mutationSerial += 1;
      state.editor = null;
      const serial = ++requestSerial;
      const selectionAtStart = selectionSerial;
      state.status = "loading";
      state.error = null;
      render();
      const operation = (async () => {
        try {
          const [customers, todos] = await Promise.all([
            api.getCustomers(),
            api.getTodos()
          ]);
          if (disposed || serial !== requestSerial) return;
          state.customers = customers;
          state.todos = todos;
          const preferred = selectionAtStart === selectionSerial ? preferredCustomerId?.trim() : undefined;
          const retainedSelection = state.selectedCustomerId;
          const hasRetainedSelection = customers.some((customer) =>
            customer.id === retainedSelection);
          state.selectedCustomerId = preferred
            ? customers.some((customer) => customer.id === preferred)
              ? preferred
              : null
            : hasRetainedSelection
              ? retainedSelection
              : null;
          state.status = "ready";
          state.error = null;
          render();
        } catch (error) {
          if (disposed || serial !== requestSerial) return;
          state.status = "error";
          state.error = errorText(error);
          render();
          throw error;
        }
      })();
      idlePromise = operation.then(() => undefined, () => undefined);
      return operation;
    },
    deactivate() {
      active = false;
      requestSerial += 1;
      mutationSerial += 1;
      state.editor = null;
      state.notice = null;
    },
    selectCustomer(customerId) {
      const normalized = customerId.trim();
      if (!state.customers.some((customer) => customer.id === normalized)) {
        return;
      }
      if (normalized !== state.selectedCustomerId) {
        selectionSerial += 1;
        mutationSerial += 1;
        state.editor = null;
        state.notice = null;
      }
      state.selectedCustomerId = normalized;
      render();
    },
    setCustomerFilter(filter) {
      state.customerFilter = filter;
      state.currentPage = 1;
      render();
    },
    setCustomerQuery(query) {
      state.customerQuery = query.trim();
      state.currentPage = 1;
      render();
    },
    setGradeFilter(grade) {
      state.gradeFilter = grade.trim();
      state.currentPage = 1;
      render();
    },
    setStageFilter(stage) {
      state.stageFilter = stage.trim();
      state.currentPage = 1;
      render();
    },
    setOwnerFilter(ownerId) {
      state.ownerFilter = ownerId.trim();
      state.currentPage = 1;
      render();
    },
    setCustomerPage(page) {
      state.currentPage = Math.max(1, Math.trunc(page));
      render();
    },
    setPageSize(pageSize) {
      if (![20, 50, 100].includes(pageSize)) return;
      state.pageSize = pageSize;
      state.currentPage = 1;
      render();
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      controller.deactivate();
      main?.removeEventListener("click", onClick);
      main?.removeEventListener("input", onInput);
      main?.removeEventListener("change", onChange);
      main?.removeEventListener("submit", onSubmit);
      inspector?.removeEventListener("click", onClick);
      inspector?.removeEventListener("input", onInput);
      inspector?.removeEventListener("change", onChange);
      inspector?.removeEventListener("submit", onSubmit);
      eventTarget.removeEventListener("goodjob:customer-create-requested", onCustomerCreateRequested);
      eventTarget.removeEventListener(
        "goodjob:acquisition-deal-created",
        onAcquisitionDealCreated
      );
    }
  };

  function onClick(event: Event) {
    if (!active || disposed) return;
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      "[data-private-domain-action]"
    );
    if (!target || (!main?.contains(target) && !inspector?.contains(target))) return;
    if (target.dataset.privateDomainAction === "record-activity") {
      openEditor("activity");
    } else if (target.dataset.privateDomainAction === "create-todo") {
      openEditor("todo");
    } else if (target.dataset.privateDomainAction === "complete-todo") {
      openEditor("complete", target.dataset.todoId);
    } else if (target.dataset.privateDomainAction === "cancel-editor") {
      mutationSerial += 1;
      state.editor = null;
      render();
    } else if (target.dataset.privateDomainAction === "select-customer") {
      controller.selectCustomer(target.dataset.customerId ?? "");
    } else if (target.dataset.privateDomainAction === "filter") {
      const filter = target.dataset.filter;
      if (filter === "all" || filter === "pending" || filter === "today") {
        controller.setCustomerFilter(filter);
      }
    } else if (target.dataset.privateDomainAction === "page") {
      controller.setCustomerPage(state.currentPage + (target.dataset.page === "next" ? 1 : -1));
    } else if (target.dataset.privateDomainAction === "create-deal") {
      const customerId = target.dataset.customerId?.trim() ?? "";
      const customer = state.customers.find((item) => item.id === customerId);
      if (pendingAcquisitionBindings(customer).length === 0) return;
      eventTarget.dispatchEvent(new CustomEvent(
        "goodjob:deal-create-requested",
        { detail: { customerId } }
      ));
    } else if (target.dataset.privateDomainAction === "open-quote-workbench") {
      const customerId = target.dataset.customerId?.trim() ?? "";
      const customer = state.customers.find((item) => item.id === customerId);
      if (!customer) return;
      eventTarget.dispatchEvent(new CustomEvent(
        "goodjob:quote-workbench-requested",
        {
          detail: {
            customerId,
            candidateId:
              customer.quoteEligibleCandidateId?.trim() || undefined,
            dealId: customer.quoteEligibleDealId?.trim()
              || customer.activeDealId?.trim()
              || undefined,
            assignedTo: customer.ownerId
          }
        }
      ));
    } else if (target.dataset.privateDomainAction === "retry") {
      void controller.open(state.selectedCustomerId ?? undefined).catch(
        () => undefined
      );
    }
  }

  function onChange(event: Event) {
    if (updateEditorField(event)) return;
    const target = (event.target as HTMLSelectElement | null)?.closest<HTMLSelectElement>(
      "select[data-private-domain-filter]"
    );
    if (!target || !main?.contains(target)) return;
    if (target.dataset.privateDomainFilter === "grade") {
      controller.setGradeFilter(target.value);
    } else if (target.dataset.privateDomainFilter === "stage") {
      controller.setStageFilter(target.value);
    } else if (target.dataset.privateDomainFilter === "owner") {
      controller.setOwnerFilter(target.value);
    } else if (target.dataset.privateDomainFilter === "page-size") {
      controller.setPageSize(Number(target.value));
    }
  }

  function onInput(event: Event) {
    if (updateEditorField(event)) return;
    const target = (event.target as HTMLInputElement | null)?.closest<HTMLInputElement>(
      "input[data-private-domain-query]"
    );
    if (!target || !main?.contains(target)) return;
    controller.setCustomerQuery(target.value);
    const replacement = main?.querySelector<HTMLInputElement>("input[data-private-domain-query]");
    if (replacement) {
      replacement.focus();
      replacement.setSelectionRange(replacement.value.length, replacement.value.length);
    }
  }

  function updateEditorField(event: Event): boolean {
    const target = event.target as HTMLInputElement | null;
    if (!active || !target?.closest?.("[data-private-domain-form]") || !state.editor
      || (!main?.contains(target) && !inspector?.contains(target))) return false;
    if (!state.editor.submitting && target.name in state.editor.values) state.editor.values[target.name] = target.value;
    return true;
  }

  function onSubmit(event: Event) {
    const form = (event.target as HTMLElement | null)?.closest<HTMLFormElement>("[data-private-domain-form]");
    if (!form || (!main?.contains(form) && !inspector?.contains(form))) return;
    event.preventDefault();
    event.stopPropagation();
    if (!state.editor?.submitting) {
      for (const input of form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("[name]")) {
        if (state.editor && input.name in state.editor.values) state.editor.values[input.name] = input.value;
      }
    }
    submitEditor();
  }

  function onCustomerCreateRequested() {
    if (options.surface !== "catalog") openEditor("customer");
  }

  function onAcquisitionDealCreated(event: Event) {
    if (!active || disposed) return;
    const detail = (event as CustomEvent<{ customerId?: unknown }>).detail;
    const customerId = typeof detail?.customerId === "string"
      ? detail.customerId.trim()
      : "";
    if (!customerId) return;
    void controller.open(customerId).catch(() => undefined);
  }

  main?.addEventListener("click", onClick);
  main?.addEventListener("input", onInput);
  main?.addEventListener("change", onChange);
  main?.addEventListener("submit", onSubmit);
  inspector?.addEventListener("click", onClick);
  inspector?.addEventListener("input", onInput);
  inspector?.addEventListener("change", onChange);
  inspector?.addEventListener("submit", onSubmit);
  eventTarget.addEventListener("goodjob:customer-create-requested", onCustomerCreateRequested);
  eventTarget.addEventListener(
    "goodjob:acquisition-deal-created",
    onAcquisitionDealCreated
  );
  render();
  return controller;
}

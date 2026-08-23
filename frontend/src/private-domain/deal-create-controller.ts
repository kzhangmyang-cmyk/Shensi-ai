import { csrfFromCookie } from "../acquisition/csrf";
import {
  pendingAcquisitionBindings,
  type PrivateDomainAcquisitionBinding,
  type PrivateDomainCustomer
} from "./runtime-api";

export interface AuthoritativeDealCreateInput {
  title: string;
  customerId: string;
  product: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  currency: string;
  nextAction: string;
  nextActionAt: string;
  expectedCloseAt: string;
  acquisitionBinding: { handoffId: string; leadId: string };
}

export interface AuthoritativeDealCreateApi {
  getCustomer(customerId: string, signal?: AbortSignal): Promise<PrivateDomainCustomer | null>;
  createDeal(
    input: AuthoritativeDealCreateInput,
    signal?: AbortSignal
  ): Promise<{ deal: { id: string } }>;
}

export interface DealCreateController {
  destroy(): void;
}

interface DealCreateApiOptions {
  fetchImpl?: typeof fetch;
  cookieSource?: () => string;
  onUnauthorized?: () => void;
}

interface DealCreateControllerOptions {
  api?: AuthoritativeDealCreateApi;
  document?: Document;
  location?: Pick<Location, "hash">;
}

function errorBodyMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "请求失败";
  const envelope = body as { message?: unknown; error?: { message?: unknown } };
  if (typeof envelope.error?.message === "string" && envelope.error.message.trim()) {
    return envelope.error.message;
  }
  return typeof envelope.message === "string" && envelope.message.trim()
    ? envelope.message
    : "请求失败";
}

function defaultUnauthorizedBoundary(): void {
  try {
    localStorage.removeItem("gj_user");
  } catch {
    // Storage may be unavailable without weakening the visible auth boundary.
  }
  document.body.classList.remove("is-authenticated");
  document.dispatchEvent(new CustomEvent("goodjob:auth-state-changed", {
    detail: { authenticated: false }
  }));
}

export function createAuthoritativeDealCreateApi(
  options: DealCreateApiOptions = {}
): AuthoritativeDealCreateApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cookieSource = options.cookieSource ?? (() => document.cookie);
  const onUnauthorized = options.onUnauthorized ?? defaultUnauthorizedBoundary;

  async function request<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const csrf = method === "GET" ? "" : csrfFromCookie(cookieSource());
    const response = await fetchImpl(path, {
      ...init,
      credentials: "same-origin",
      signal,
      headers: {
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" || !csrf ? {} : { "x-csrf-token": csrf }),
        ...(init.headers ?? {})
      }
    });
    const body = await response.json().catch(() => ({})) as T;
    if (!response.ok) {
      if (response.status === 401) onUnauthorized();
      throw new Error(errorBodyMessage(body));
    }
    return body;
  }

  return {
    async getCustomer(customerId, signal) {
      const result = await request<{ customers: PrivateDomainCustomer[] }>(
        "/api/customers?scope=mine",
        { method: "GET" },
        signal
      );
      return result.customers.find((customer) => customer.id === customerId) ?? null;
    },
    createDeal(input, signal) {
      return request<{ deal: { id: string } }>(
        "/api/deals",
        { method: "POST", body: JSON.stringify(input) },
        signal
      );
    }
  };
}

function inputValue<T extends HTMLInputElement | HTMLSelectElement>(
  dialog: HTMLDialogElement,
  selector: string
): string {
  return dialog.querySelector<T>(selector)?.value.trim() ?? "";
}

function dispatchDealCreated(
  documentRef: Document,
  dealId: string,
  input: AuthoritativeDealCreateInput
): void {
  documentRef.dispatchEvent(new CustomEvent("goodjob:acquisition-deal-created", {
    detail: {
      dealId,
      customerId: input.customerId,
      handoffId: input.acquisitionBinding.handoffId,
      leadId: input.acquisitionBinding.leadId
    }
  }));
}

export function createDealCreateController(
  options: DealCreateControllerOptions = {}
): DealCreateController {
  const documentRef = options.document ?? document;
  const locationRef = options.location ?? window.location;
  const api = options.api ?? createAuthoritativeDealCreateApi();
  const dialog = documentRef.querySelector<HTMLDialogElement>("#replicaDealCreateDialog");
  const form = dialog?.querySelector<HTMLFormElement>("#replicaDealCreateForm");
  const status = dialog?.querySelector<HTMLElement>("#replicaDealCreateStatus");
  const saveButton = dialog?.querySelector<HTMLButtonElement>("#saveDealButton");
  const quantityInput = dialog?.querySelector<HTMLInputElement>("#dealQuantityInput");
  const unitPriceInput = dialog?.querySelector<HTMLInputElement>("#dealUnitPriceInput");
  const amountInput = dialog?.querySelector<HTMLInputElement>("#dealAmountInput");
  let activeCustomer: PrivateDomainCustomer | null = null;
  let activeBindings: PrivateDomainAcquisitionBinding[] = [];
  let requestSerial = 0;
  let abortController: AbortController | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  function setStatus(message: string, kind: "loading" | "error" = "loading") {
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle("is-error", kind === "error");
  }

  function showToast(message: string, error = false) {
    const toast = documentRef.querySelector<HTMLElement>("#replicaToast");
    const label = toast?.querySelector<HTMLElement>("span");
    if (!toast || !label) return;
    label.textContent = message;
    toast.classList.toggle("error", error);
    toast.classList.add("show");
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2_600);
  }

  function clearSensitiveState(): void {
    requestSerial += 1;
    abortController?.abort();
    abortController = null;
    activeCustomer = null;
    activeBindings = [];
    if (dialog?.hasAttribute("open")) dialog.close();
    form?.reset();
    form?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "input, textarea"
    ).forEach((field) => {
      field.value = "";
    });
    form?.querySelectorAll<HTMLSelectElement>("select").forEach((field) => {
      if (field.id === "dealAcquisitionBindingInput") field.replaceChildren();
      field.selectedIndex = -1;
    });
    setStatus("");
    saveButton?.removeAttribute("disabled");
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = null;
    const toast = documentRef.querySelector<HTMLElement>("#replicaToast");
    toast?.classList.remove("show", "error");
    const toastLabel = toast?.querySelector<HTMLElement>("span");
    if (toastLabel) toastLabel.textContent = "";
  }

  function updateAmount() {
    if (!amountInput) return;
    const quantity = Number(quantityInput?.value ?? 0);
    const unitPrice = Number(unitPriceInput?.value ?? 0);
    amountInput.value = String(Math.round(quantity * unitPrice * 100) / 100);
  }

  function openDialog(customer: PrivateDomainCustomer) {
    if (destroyed
      || !documentRef.body.classList.contains("is-authenticated")
      || !dialog
      || !form) return;
    activeCustomer = customer;
    activeBindings = pendingAcquisitionBindings(customer);
    form.reset();
    const customerId = dialog.querySelector<HTMLInputElement>("#dealCustomerIdInput");
    const customerName = dialog.querySelector<HTMLInputElement>("#dealCustomerInput");
    const bindingSelect = dialog.querySelector<HTMLSelectElement>("#dealAcquisitionBindingInput");
    if (customerId) customerId.value = customer.id;
    if (customerName) customerName.value = customer.company;
    if (bindingSelect) {
      bindingSelect.replaceChildren(...activeBindings.map((binding) => {
        const option = documentRef.createElement("option");
        option.value = binding.handoffId;
        option.textContent = `AI 获客候选 ${binding.candidateId} · ${binding.createdAt}`;
        return option;
      }));
    }
    setStatus("");
    updateAmount();
    if (!dialog.open) dialog.showModal();
  }

  async function onDealCreateRequested(event: Event) {
    const detail = (event as CustomEvent<{ customerId?: unknown }>).detail;
    const customerId = typeof detail?.customerId === "string" ? detail.customerId.trim() : "";
    if (destroyed
      || !customerId
      || !documentRef.body.classList.contains("is-authenticated")) {
      if (customerId) showToast("登录已失效，请重新登录", true);
      return;
    }
    const serial = ++requestSerial;
    abortController?.abort();
    const requestAbort = new AbortController();
    abortController = requestAbort;
    showToast("正在读取客户权威数据");
    try {
      const customer = await api.getCustomer(customerId, requestAbort.signal);
      if (serial !== requestSerial
        || !documentRef.body.classList.contains("is-authenticated")) return;
      if (!customer || pendingAcquisitionBindings(customer).length === 0) {
        showToast("该客户当前没有可绑定的获客来源，请刷新后重试", true);
        return;
      }
      documentRef.querySelector("#replicaToast")?.classList.remove("show");
      openDialog(customer);
    } catch {
      if (serial === requestSerial && !requestAbort.signal.aborted) {
        showToast("加载客户权威数据失败，请稍后重试", true);
      }
    }
  }

  async function onSubmit(event: Event) {
    event.preventDefault();
    if (destroyed
      || !documentRef.body.classList.contains("is-authenticated")
      || !dialog
      || !activeCustomer) return;
    const selectedHandoffId = inputValue<HTMLSelectElement>(dialog, "#dealAcquisitionBindingInput");
    const selectedBinding = activeBindings.find((binding) => binding.handoffId === selectedHandoffId);
    const title = inputValue<HTMLInputElement>(dialog, "#dealTitleInput");
    const product = inputValue<HTMLInputElement>(dialog, "#dealProductInput");
    const nextAction = inputValue<HTMLInputElement>(dialog, "#dealNextActionInput");
    const nextActionAt = inputValue<HTMLInputElement>(dialog, "#dealNextActionAtInput");
    if (!title || !product || !nextAction || !nextActionAt || !selectedBinding) {
      setStatus("请填写商机名称、产品、下一动作、日期并选择获客来源", "error");
      return;
    }
    const quantityValue = inputValue<HTMLInputElement>(dialog, "#dealQuantityInput");
    const unitPriceValue = inputValue<HTMLInputElement>(dialog, "#dealUnitPriceInput");
    const quantity = Number(quantityValue);
    const unitPrice = Number(unitPriceValue);
    if (!quantityValue
      || !unitPriceValue
      || !Number.isFinite(quantity)
      || !Number.isFinite(unitPrice)
      || quantity <= 0
      || unitPrice <= 0
      || !Number.isFinite(quantity * unitPrice)) {
      setStatus("数量和单价必须为大于 0 的有效数字", "error");
      return;
    }
    const input: AuthoritativeDealCreateInput = {
      title,
      customerId: activeCustomer.id,
      product,
      quantity,
      unitPrice,
      amount: Math.round(quantity * unitPrice * 100) / 100,
      currency: inputValue<HTMLSelectElement>(dialog, "#dealCurrencyInput") || "USD",
      nextAction,
      nextActionAt,
      expectedCloseAt: inputValue<HTMLInputElement>(dialog, "#dealExpectedCloseAtInput"),
      acquisitionBinding: {
        handoffId: selectedBinding.handoffId,
        leadId: selectedBinding.leadId
      }
    };
    const serial = ++requestSerial;
    abortController?.abort();
    const requestAbort = new AbortController();
    abortController = requestAbort;
    saveButton?.setAttribute("disabled", "");
    setStatus("正在创建真实商机…");
    try {
      const result = await api.createDeal(input, requestAbort.signal);
      if (serial !== requestSerial
        || requestAbort.signal.aborted
        || !documentRef.body.classList.contains("is-authenticated")) return;
      dispatchDealCreated(documentRef, result.deal.id, input);
      dialog.close();
      locationRef.hash = "#conversion";
      showToast("商机已新增");
    } catch {
      if (serial === requestSerial && !requestAbort.signal.aborted) {
        setStatus("商机创建失败，请稍后重试", "error");
      }
    } finally {
      if (serial === requestSerial) {
        abortController = null;
        saveButton?.removeAttribute("disabled");
      }
    }
  }

  function onAuthenticationStateChanged(event: Event) {
    const detail = (event as CustomEvent<{ authenticated?: boolean }>).detail;
    if (detail?.authenticated === false) clearSensitiveState();
  }

  function closeDialog() {
    clearSensitiveState();
  }

  form?.addEventListener("submit", onSubmit);
  quantityInput?.addEventListener("input", updateAmount);
  unitPriceInput?.addEventListener("input", updateAmount);
  dialog?.querySelector("#replicaDealCreateCancel")?.addEventListener("click", closeDialog);
  dialog?.querySelector("#replicaDealCreateClose")?.addEventListener("click", closeDialog);
  documentRef.addEventListener("goodjob:deal-create-requested", onDealCreateRequested);
  documentRef.addEventListener("goodjob:auth-state-changed", onAuthenticationStateChanged);

  return {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      clearSensitiveState();
      form?.removeEventListener("submit", onSubmit);
      quantityInput?.removeEventListener("input", updateAmount);
      unitPriceInput?.removeEventListener("input", updateAmount);
      dialog?.querySelector("#replicaDealCreateCancel")?.removeEventListener("click", closeDialog);
      dialog?.querySelector("#replicaDealCreateClose")?.removeEventListener("click", closeDialog);
      documentRef.removeEventListener("goodjob:deal-create-requested", onDealCreateRequested);
      documentRef.removeEventListener("goodjob:auth-state-changed", onAuthenticationStateChanged);
    }
  };
}

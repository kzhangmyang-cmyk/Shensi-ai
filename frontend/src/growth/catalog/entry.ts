import { GrowthApiError } from "../http";
import type { CatalogApi, CatalogItemInput, PricingPolicyDraftInput } from "./api";
import { createCatalogController, type CatalogPageState } from "./controller";
import { renderCatalogPage } from "./view";

function escape(value: string): string {
  return value.replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function numberField(name: string, label: string, value = "0", step = "0.01", max?: string): string {
  return `<label><span>${label}</span><input name="${name}" type="number" min="0" ${max ? `max="${max}"` : ""} step="${step}" value="${value}" required></label>`;
}

function renderForm(kind: "item" | "policy", state: CatalogPageState): string {
  const fields = kind === "item"
    ? `<label><span>产品编码</span><input name="code" maxlength="100" required></label>
       <label><span>产品名称</span><input name="name" maxlength="200" required></label>
       <label><span>类型</span><select name="type"><option value="product">产品</option><option value="service">服务</option></select></label>
       <label><span>计价单位</span><input name="unit" maxlength="50" value="件" required></label>
       <label class="catalog-form-wide"><span>说明</span><textarea name="description" maxlength="4000"></textarea></label>`
    : `<label><span>产品 / 服务</span><select name="catalogItemId" required>${state.kind === "ready" ? state.items.filter(item => item.status === "active" && item.type !== "package").map(item => `<option value="${escape(item.id)}">${escape(item.name)}</option>`).join("") : ""}</select></label>
       <label><span>币种</span><select name="currency"><option value="CNY">人民币 CNY</option><option value="USD">美元 USD</option><option value="EUR">欧元 EUR</option></select></label>
       ${numberField("price", "单位标价（元）", "")}${numberField("cost", "单位标准成本（元）")}
       ${numberField("floor", "最低单位售价（元）")}${numberField("targetMargin", "目标毛利率（%）", "20", "0.01", "100")}
       ${numberField("minimumMargin", "最低毛利率（%）", "0", "0.01", "99.99")}
       ${numberField("standardDiscount", "常规折扣上限（%）", "0", "0.01", "100")}
       ${numberField("absoluteDiscount", "绝对折扣上限（%）", "0", "0.01", "100")}
       ${numberField("paymentDays", "标准账期（天）", "0", "1")}${numberField("maximumPaymentDays", "最长账期（天）", "0", "1")}
       <p class="catalog-form-wide">金额按所选币种填写。此基础策略不含订单附加成本、附加费或赠品；即刻生效、无截止日期。保存为草稿后，需手动激活才能用于报价。</p>`;
  return `<form class="catalog-editor" data-catalog-form="${kind}"><h3>${kind === "item" ? "新增产品 / 服务" : "新增基础定价策略"}</h3><fieldset>${fields}</fieldset>
    <div class="catalog-actions"><button type="submit">${kind === "item" ? "保存产品" : "保存定价草稿"}</button><button type="button" data-action="cancel-editor">取消</button></div></form>`;
}

function decimal(data: FormData, key: string, label: string, max = Number.MAX_SAFE_INTEGER): number {
  const value = String(data.get(key) ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/u.test(value)) throw new Error(`${label}需填写非负数，最多两位小数。`);
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(result) || result > max) throw new Error(`${label}超出有效范围。`);
  return result;
}

export function catalogPolicyFromForm(data: FormData, now: string): PricingPolicyDraftInput {
  const days = (key: string) => {
    const value = String(data.get(key) ?? "");
    const number = Number(value);
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number)) throw new Error("账期需填写非负整数天数。");
    return number;
  };
  const policy: PricingPolicyDraftInput = {
    catalogItemId: String(data.get("catalogItemId") ?? ""), packageVersionId: null,
    currency: String(data.get("currency") ?? ""), listUnitPriceMinor: decimal(data, "price", "标价"),
    unitStandardCostMinor: decimal(data, "cost", "成本"), absoluteFloorUnitPriceMinor: decimal(data, "floor", "最低售价"),
    defaultOrderDeliveryCostMinor: 0, defaultOrderSalesCostMinor: 0, defaultOrderServiceCostMinor: 0,
    targetGrossMarginBps: decimal(data, "targetMargin", "目标毛利率", 10000),
    absoluteMinimumGrossMarginBps: decimal(data, "minimumMargin", "最低毛利率", 9999),
    standardDiscountLimitBps: decimal(data, "standardDiscount", "常规折扣", 10000),
    absoluteDiscountLimitBps: decimal(data, "absoluteDiscount", "绝对折扣", 10000),
    standardPaymentTermDays: days("paymentDays"), absolutePaymentTermDays: days("maximumPaymentDays"),
    approvalThresholds: {
      discountCapability: "quote.exception.discount.approve", marginCapability: "quote.exception.margin.approve",
      paymentTermsCapability: "quote.exception.payment_terms.approve", giftCapability: "quote.exception.gift.approve",
      creditCapability: "quote.exception.credit.approve", manualCapability: "quote.exception.manual.approve",
      creditRiskThresholdBps: 0, manualEscalationEnabled: true
    }, surchargePolicies: [], giftPolicies: [], validFrom: now, validTo: null
  };
  if (!policy.catalogItemId || !["CNY", "USD", "EUR"].includes(policy.currency)) throw new Error("请选择产品和币种。");
  if (policy.listUnitPriceMinor <= 0 || policy.absoluteFloorUnitPriceMinor > policy.listUnitPriceMinor) throw new Error("标价须大于零，最低售价不可高于标价。");
  if (policy.standardDiscountLimitBps > policy.absoluteDiscountLimitBps || policy.absoluteMinimumGrossMarginBps > policy.targetGrossMarginBps || policy.standardPaymentTermDays > policy.absolutePaymentTermDays) throw new Error("请核对折扣、毛利率和账期的上下限。");
  return policy;
}

export function createCatalogPageEntry(options: {
  api: CatalogApi; hasFeature: (feature: string) => boolean; hasCapability: (capability: string) => boolean;
}) {
  const controller = createCatalogController(options);
  let host: HTMLElement | null = null;
  let state: CatalogPageState = { kind: "loading" };
  let abort: AbortController | null = null;
  let busy = false;
  let draft: { kind: "item"; signature: string; key: string; input: CatalogItemInput }
    | { kind: "policy"; signature: string; key: string; input: PricingPolicyDraftInput } | null = null;
  const feedback = (message: string) => {
    const target = host?.querySelector("[data-catalog-feedback]");
    if (target) target.textContent = message;
  };
  const load = async (signal: AbortSignal) => {
    const result = await controller.load(signal);
    if (signal.aborted || signal !== abort?.signal || !host) return;
    state = result;
    host.innerHTML = renderCatalogPage(state);
  };
  const run = async (command: (signal: AbortSignal, key: string) => Promise<unknown>, action: string, savedKey?: string) => {
    if (busy || !host || !abort || abort.signal.aborted || !options.hasCapability("catalog.manage")) return;
    const current = abort;
    busy = true;
    const disabled = [...host.querySelectorAll<HTMLButtonElement | HTMLFieldSetElement>("button:not([disabled]), fieldset:not([disabled])")];
    disabled.forEach(control => { control.disabled = true; });
    feedback("正在保存，请稍候…");
    try {
      await command(current.signal, savedKey ?? controller.nextIdempotencyKey(action));
      if (current.signal.aborted || current !== abort) return;
      draft = null;
      await load(current.signal);
      if (!current.signal.aborted && current === abort) feedback("已保存，目录已刷新。");
    } catch (error) {
      if (current.signal.aborted || current !== abort) return;
      feedback(error instanceof GrowthApiError && [409, 412].includes(error.status)
        ? `保存冲突：编码可能已存在或资料已更新，请核对后重试。（${error.code}）`
        : error instanceof GrowthApiError ? `未保存：${error.message}`
        : "保存结果未确认。请保持输入重试，或刷新目录核对结果。");
    } finally {
      if (current === abort) { busy = false; disabled.forEach(control => { if (control.isConnected) control.disabled = false; }); }
    }
  };
  const onClick = (event: Event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>("[data-action]");
    if (!button || !host?.contains(button) || button.disabled || busy || !options.hasCapability("catalog.manage")) return;
    const action = button.dataset.action;
    const editor = host.querySelector("[data-catalog-editor]");
    if (action === "cancel-editor") { draft = null; if (editor) editor.innerHTML = ""; return; }
    if (action === "create-item" || action === "create-policy") {
      draft = null;
      if (editor) editor.innerHTML = renderForm(action === "create-item" ? "item" : "policy", state);
      feedback(""); editor?.querySelector<HTMLElement>("input, select")?.focus(); return;
    }
    const id = button.dataset.id ?? "", etag = button.dataset.etag ?? "";
    if (!id || !etag) return;
    const method = action === "activate-package" ? options.api.activatePackageVersion
      : action === "retire-package" ? options.api.retirePackageVersion
      : action === "activate-policy" ? options.api.activatePricingPolicy : null;
    if (method) void run((signal, key) => method(id, etag, key, signal), action!);
  };
  const onSubmit = (event: Event) => {
    const form = (event.target as HTMLElement | null)?.closest<HTMLFormElement>("[data-catalog-form]");
    if (!form || !host?.contains(form)) return;
    event.preventDefault();
    if (busy) return;
    const data = new FormData(form);
    try {
      if (form.dataset.catalogForm === "item") {
        const input: CatalogItemInput = { code: String(data.get("code") ?? "").trim(), name: String(data.get("name") ?? "").trim(), type: data.get("type") === "service" ? "service" : "product", unit: String(data.get("unit") ?? "").trim(), description: String(data.get("description") ?? "").trim() || null };
        if (!input.code || !input.name || !input.unit) throw new Error("请填写编码、产品名称和计价单位。");
        const signature = JSON.stringify(input);
        const request = draft?.kind === "item" && draft.signature === signature ? draft
          : { kind: "item" as const, signature, key: controller.nextIdempotencyKey("create-item"), input };
        draft = request;
        void run((signal, key) => options.api.createItem(request.input, key, signal), "create-item", request.key);
      } else {
        const input = catalogPolicyFromForm(data, new Date().toISOString());
        const signature = JSON.stringify({ ...input, validFrom: undefined });
        const request = draft?.kind === "policy" && draft.signature === signature ? draft
          : { kind: "policy" as const, signature, key: controller.nextIdempotencyKey("create-policy"), input };
        draft = request;
        void run((signal, key) => options.api.createPricingPolicy(request.input, key, signal), "create-policy", request.key);
      }
    } catch (error) { feedback(error instanceof Error ? error.message : "请检查填写内容。"); }
  };
  const unmount = () => { abort?.abort(); abort = null; busy = false; draft = null; host?.removeEventListener("click", onClick); host?.removeEventListener("submit", onSubmit); host = null; };
  return {
    async mount(target: HTMLElement, signal: AbortSignal) {
      unmount(); host = target; abort = new AbortController();
      const ownedAbort = abort;
      if (signal.aborted) { unmount(); return; }
      signal.addEventListener("abort", () => { ownedAbort.abort(); if (abort === ownedAbort) unmount(); }, { once: true });
      host.addEventListener("click", onClick); host.addEventListener("submit", onSubmit);
      await load(ownedAbort.signal);
    }, unmount
  };
}

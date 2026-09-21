import type { DouyinPlanInput } from "./task-creation-api";

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function list(values: string[]): string {
  return values.map((value) => `<li>${escapeHtml(value)}</li>`).join("");
}

export function renderPlanDraftPreview(plan: DouyinPlanInput): string {
  const connections = new Map(plan.providerConnections.map((connection) => [connection.connectionId, connection]));
  const operations = plan.operations.map((operation) => {
    const connection = connections.get(operation.connectionId);
    const provider = connection?.providerId ?? operation.connectionId;
    return `<li><strong>${escapeHtml(operation.subjectChannel === "organization" ? "组织" : "个人")}</strong> · ${escapeHtml(provider)} · 连接 ${escapeHtml(operation.connectionId)} · <code>${escapeHtml(operation.query)}</code><small>请求 ${operation.allocatedBudget.requests} · 结果 ${operation.allocatedBudget.results} · 费用 ${operation.allocatedBudget.amountMinor} ${escapeHtml(plan.budgetSnapshot.billingCurrency)} · 时长 ${operation.allocatedBudget.durationSeconds} 秒</small></li>`;
  }).join("");
  return `<section class="replica-plan-draft-preview" aria-label="AI 计划草稿完整预览">
    <header><span>AI 生成的完整服务端计划</span><h3>${escapeHtml(plan.name)}</h3><p>${escapeHtml(plan.objective)}</p></header>
    <div class="replica-plan-draft-grid">
      <section><h4>理想客户画像</h4><dl><dt>行业</dt><dd><ul>${list(plan.icp.industries)}</ul></dd><dt>地区</dt><dd><ul>${list(plan.icp.regions)}</ul></dd><dt>企业条件</dt><dd><ul>${list(plan.icp.organizationCriteria)}</ul></dd><dt>个人条件</dt><dd><ul>${list(plan.icp.individualCriteria)}</ul></dd><dt>排除规则</dt><dd><ul>${list(plan.icp.exclusionRules)}</ul></dd></dl></section>
      <section><h4>搜索连接</h4><ul>${plan.providerConnections.map((connection) => `<li>${escapeHtml(connection.providerId)} · 连接 ${escapeHtml(connection.connectionId)} · 凭据 v${connection.credentialVersion}</li>`).join("")}</ul><h4>组织 / 个人通道</h4><p>${plan.subjectChannels.organization ? "组织" : ""}${plan.subjectChannels.organization && plan.subjectChannels.individual ? "、" : ""}${plan.subjectChannels.individual ? "个人" : ""}</p></section>
    </div>
    <section><h4>全部搜索查询与逐项预算</h4><ol class="replica-plan-draft-operations">${operations}</ol></section>
    <footer><span>最大请求：${plan.budgetSnapshot.maxRequests} ${escapeHtml(plan.budgetSnapshot.billingCurrency)}</span><span>最大结果：${plan.budgetSnapshot.maxResults} ${escapeHtml(plan.budgetSnapshot.billingCurrency)}</span><span>费用上限：${plan.budgetSnapshot.maxAmountMinor} ${escapeHtml(plan.budgetSnapshot.billingCurrency)}</span><span>最长运行：${plan.budgetSnapshot.maxDurationSeconds} 秒</span><span>${plan.stopConditions.stopWhenBudgetExhausted ? "预算耗尽时停止" : "预算不自动停止"}</span><span>${plan.stopConditions.stopWhenNoMoreResults ? "无更多结果时停止" : "结果耗尽后继续"}</span></footer>
  </section>`;
}

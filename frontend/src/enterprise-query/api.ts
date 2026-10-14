import type { Enterprise } from "./model";
import type { components } from "../generated/ai-acquisition";
import { csrfFromCookie } from "../acquisition/csrf";
export function createEnterpriseApi(fetcher: typeof fetch = fetch) {
  async function request(path: string, body?: unknown, key?: string) {
    const response = await fetcher(path, { method: body ? "POST" : "GET", credentials: "same-origin",
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json", "x-csrf-token": csrfFromCookie(document.cookie), "Idempotency-Key": key! } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error?.message || `请求失败（${response.status}）`);
    return data;
  }
  return {
    async searchPublic(keyword: string, page: number): Promise<components["schemas"]["EnterpriseQueryPage"]> {
      return request(`/api/enterprise-query/gleif?${new URLSearchParams({ keyword, page: String(page) })}`);
    },
    async list(): Promise<Enterprise[]> {
      const data = await request("/api/tools/website-opportunities");
      if (!Array.isArray(data.opportunities)) throw new Error("企业数据响应格式不正确");
      return data.opportunities;
    },
    async join(item: Enterprise, key: string): Promise<string> {
      if (!item.tenantProspectId || !item.leadId) throw new Error("该企业尚未完成线索核验，暂不能加入客户池");
      const result = await request(`/api/prospects/${encodeURIComponent(item.tenantProspectId)}/convert-to-customer`, {
        operationCode: "convert_prospect_to_customer_v1", leadId: item.leadId, mode: "create_new"
      }, key);
      return result.customer.id;
    }
  };
}

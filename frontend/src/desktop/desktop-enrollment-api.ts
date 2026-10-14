import type { components } from "../generated/ai-acquisition";
import { csrfFromCookie } from "../acquisition/csrf";

export type DesktopEnrollmentRequest = components["schemas"]["DesktopEnrollmentRequest"];
export type DesktopEnrollmentResponse = components["schemas"]["DesktopEnrollmentResponse"];
export type DesktopBindingRequest = components["schemas"]["DesktopExecutorBindingRequest"];
export type DesktopBindingResponse = components["schemas"]["DesktopExecutorBindingResponse"];
export type DesktopBindingStatus = components["schemas"]["DesktopBindingStatus"];

export interface DesktopEnrollmentApi {
  enroll(input: DesktopEnrollmentRequest): Promise<DesktopEnrollmentResponse>;
  bind(accountId: string, input: DesktopBindingRequest, idempotencyKey: string): Promise<DesktopBindingResponse>;
  getBinding(accountId: string, installationId: string): Promise<DesktopBindingStatus>;
}

export function createDesktopEnrollmentApi(options: {
  fetchImpl?: typeof fetch; cookieSource?: () => string;
} = {}): DesktopEnrollmentApi {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const cookieSource = options.cookieSource ?? (() => typeof document === "undefined" ? "" : document.cookie);
  async function request<T>(path: string, input: unknown, key: string): Promise<T> {
    const response = await fetchImpl(`/api/v1/acquisition/${path}`, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key,
        "X-CSRF-Token": csrfFromCookie(cookieSource()) },
      body: JSON.stringify(input)
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const error = value && typeof value === "object" && "error" in value ? value.error : null;
      throw new Error(typeof error === "string" && /^desktop_[a-z_]+$/u.test(error)
        ? error : "desktop_enrollment_unavailable");
    }
    return value as T;
  }
  return {
    async getBinding(accountId, installationId) {
      const response = await fetchImpl(`/api/v1/acquisition/social-accounts/${encodeURIComponent(accountId)}/desktop-binding?installationId=${encodeURIComponent(installationId)}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error("desktop_executor_binding_unavailable");
      return response.json() as Promise<DesktopBindingStatus>;
    },
    enroll: (input) => request("desktop-installations/enrollments", input, `enroll-${crypto.randomUUID()}`),
    bind: (accountId, input, key) => request(`social-accounts/${encodeURIComponent(accountId)}/desktop-binding`, input, key)
  };
}

export interface PrivateDomainCustomerActivity {
  id: string;
  customerId: string;
  type: string;
  content: string;
  operatorId: string;
  operatorName?: string;
  nextReminder: string;
  createdAt: string;
}

export interface PrivateDomainAcquisitionBinding {
  handoffId: string;
  leadId: string;
  candidateId: string;
  createdAt: string;
}

export interface PrivateDomainCustomer {
  id: string;
  company: string;
  country: string;
  contact: string;
  ownerId: string;
  teamId: string;
  ownerName?: string;
  stage: string;
  amount: number;
  health: number;
  grade?: "A" | "B" | "C" | "D";
  nextReminder: string;
  wecomBound: boolean;
  activities: PrivateDomainCustomerActivity[];
  pipelineStage?: string;
  pipelineAmount?: number;
  activeDealCount?: number;
  activeDealId?: string;
  quoteEligibleDealId?: string;
  quoteEligibleCandidateId?: string;
  acquisitionBindings?: PrivateDomainAcquisitionBinding[];
}

export function pendingAcquisitionBindings(
  customer?: Pick<PrivateDomainCustomer, "acquisitionBindings"> | null
): PrivateDomainAcquisitionBinding[] {
  return (customer?.acquisitionBindings ?? []).filter((binding) =>
    typeof binding?.handoffId === "string"
    && Boolean(binding.handoffId.trim())
    && typeof binding?.leadId === "string"
    && Boolean(binding.leadId.trim())
    && typeof binding?.candidateId === "string"
    && Boolean(binding.candidateId.trim())
    && typeof binding?.createdAt === "string"
    && Boolean(binding.createdAt.trim())
  );
}

export interface PrivateDomainTodo {
  id: string;
  title: string;
  type: string;
  priority: "high" | "medium" | "normal";
  status?: "pending" | "in_progress";
  dueAt: string;
  ownerId: string;
  teamId: string;
  related: string;
  done: boolean;
  customerId?: string;
  leadId?: string;
  cancelledAt?: string;
  historyAt?: string;
}

export interface PrivateDomainWriteApi {
  createCustomer(input: Pick<PrivateDomainCustomer, "company" | "country" | "contact" | "stage" | "grade">): Promise<PrivateDomainCustomer>;
  recordActivity(customerId: string, input: Pick<PrivateDomainCustomerActivity, "type" | "content" | "nextReminder">): Promise<PrivateDomainCustomer>;
  createTodo(input: Pick<PrivateDomainTodo, "title" | "type" | "priority" | "dueAt" | "related" | "customerId">): Promise<PrivateDomainTodo>;
  completeTodo(todoId: string, completionResult: string): Promise<PrivateDomainTodo>;
}

export interface PrivateDomainRuntimeApi extends Partial<PrivateDomainWriteApi> {
  getCustomers(): Promise<PrivateDomainCustomer[]>;
  getTodos(): Promise<PrivateDomainTodo[]>;
}

interface ErrorEnvelope {
  message?: unknown;
  error?: { message?: unknown };
}

function errorMessage(value: ErrorEnvelope, status: number) {
  if (typeof value.error?.message === "string" && value.error.message.trim()) {
    return value.error.message;
  }
  if (typeof value.message === "string" && value.message.trim()) {
    return value.message;
  }
  return `请求失败（HTTP ${status}）`;
}

export function createPrivateDomainRuntimeApi(
  fetchImpl: typeof fetch = fetch,
  cookieSource: () => string = () => typeof document === "undefined" ? "" : document.cookie
): PrivateDomainRuntimeApi & PrivateDomainWriteApi {
  async function request<T>(path: string, payload?: unknown): Promise<T> {
    const csrf = payload === undefined ? "" : csrfFromCookie(cookieSource());
    const response = await fetchImpl(path, {
      method: payload === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", ...(payload === undefined ? {} : {
        "content-type": "application/json", "x-csrf-token": csrf
      }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    });
    const body = await response.json().catch(() => ({})) as T & ErrorEnvelope;
    if (!response.ok) throw new Error(errorMessage(body, response.status));
    return body;
  }
  return {
    async getCustomers() {
      const body = await request<{ customers: PrivateDomainCustomer[] }>(
        "/api/customers?scope=mine"
      );
      return body.customers;
    },
    async getTodos() {
      const body = await request<{ todos: PrivateDomainTodo[] }>("/api/todos");
      return body.todos;
    },
    async createCustomer(input) {
      return (await request<{ customer: PrivateDomainCustomer }>("/api/customers", input)).customer;
    },
    async recordActivity(customerId, input) {
      return (await request<{ customer: PrivateDomainCustomer }>(`/api/customers/${encodeURIComponent(customerId)}/activities`, input)).customer;
    },
    async createTodo(input) {
      return (await request<{ todo: PrivateDomainTodo }>("/api/todos", input)).todo;
    },
    async completeTodo(todoId, completionResult) {
      return (await request<{ todo: PrivateDomainTodo }>(`/api/todos/${encodeURIComponent(todoId)}/complete`, { completionResult })).todo;
    }
  };
}
import { csrfFromCookie } from "../acquisition/csrf";

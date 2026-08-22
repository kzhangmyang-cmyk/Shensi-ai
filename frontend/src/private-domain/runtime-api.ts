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
}

export interface PrivateDomainRuntimeApi {
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
  fetchImpl: typeof fetch = fetch
): PrivateDomainRuntimeApi {
  async function get<T>(path: string): Promise<T> {
    const response = await fetchImpl(path, {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" }
    });
    const body = await response.json().catch(() => ({})) as T & ErrorEnvelope;
    if (!response.ok) throw new Error(errorMessage(body, response.status));
    return body;
  }
  return {
    async getCustomers() {
      const body = await get<{ customers: PrivateDomainCustomer[] }>(
        "/api/customers?scope=mine"
      );
      return body.customers;
    },
    async getTodos() {
      const body = await get<{ todos: PrivateDomainTodo[] }>("/api/todos");
      return body.todos;
    }
  };
}

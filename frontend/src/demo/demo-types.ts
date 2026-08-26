export type DemoModule =
  | "dashboard"
  | "acquisition"
  | "conversations"
  | "private-domain"
  | "conversion"
  | "agents"
  | "scripts"
  | "trade-marketing"
  | "settings";

export type Platform = "抖音" | "小红书" | "快手" | "微信" | "微博";
export type IntentLevel = "高" | "中" | "低";
export type ConversationMode = "agent" | "manual" | "paused";
export type OpportunityStage = "new" | "qualified" | "quoted" | "negotiating" | "won" | "lost";

export interface DemoMessage {
  id: string;
  sender: "customer" | "agent" | "operator";
  body: string;
  sentAt: string;
  simulated: true;
}

export interface DemoConversation {
  id: string;
  customerId?: string;
  customerName: string;
  platform: Platform;
  intent: IntentLevel;
  unread: number;
  mode: ConversationMode;
  needSummary: string;
  risk: string;
  tags: string[];
  messages: DemoMessage[];
  updatedAt: string;
}

export interface DemoCustomer {
  id: string;
  conversationId: string;
  name: string;
  platform: Platform;
  intent: IntentLevel;
  group: "重点客户" | "待跟进" | "沉默客户" | "已创建商机";
  tags: string[];
  owner: string;
  needSummary: string;
  lastContactAt: string;
  nextFollowUpAt: string;
  status: "跟进中" | "待跟进" | "已沉默" | "已有商机";
}

export interface DemoOpportunity {
  id: string;
  customerId: string;
  title: string;
  amount: number;
  probability: number;
  stage: OpportunityStage;
  source: Platform;
  nextAction: string;
  quoteAmount?: number;
  quoteSentAt?: string;
  lossReason?: string;
  updatedAt: string;
}

export interface DemoActivity {
  id: string;
  kind: "message" | "transfer" | "follow-up" | "opportunity" | "quote" | "stage";
  title: string;
  detail: string;
  createdAt: string;
}

export interface DemoTask {
  id: string;
  title: string;
  priority: "高" | "中" | "低";
  module: DemoModule;
  relatedId: string;
  done: boolean;
  dueAt?: string;
  createdAt?: string;
}

export interface DemoSettings {
  agents: Record<"获客识别智能体" | "社媒沟通智能体" | "客户跟进智能体", boolean>;
  scripts: Record<Platform, boolean>;
}

export interface DemoState {
  version: 1;
  selectedConversationId: string;
  selectedCustomerId: string;
  selectedOpportunityId: string;
  conversations: DemoConversation[];
  customers: DemoCustomer[];
  opportunities: DemoOpportunity[];
  activities: DemoActivity[];
  tasks: DemoTask[];
  demoSettings: DemoSettings;
}

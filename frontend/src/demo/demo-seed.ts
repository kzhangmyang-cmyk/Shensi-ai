import type { DemoState } from "./demo-types";

export function createSeedDemoState(): DemoState {
  return {
    version: 1,
    selectedConversationId: "conversation-douyin-lin",
    selectedCustomerId: "customer-wechat-zhou",
    selectedOpportunityId: "opportunity-office",
    conversations: [
      {
        id: "conversation-douyin-lin",
        customerId: "customer-douyin-sun",
        customerName: "林女士",
        platform: "抖音",
        intent: "高",
        unread: 2,
        mode: "agent",
        needSummary: "正在寻找办公室设计服务，关注预算和交付周期。",
        risk: "尚未确认项目面积和所在城市。",
        tags: ["办公室设计", "近期采购"],
        updatedAt: "2026-07-29T08:42:00.000Z",
        messages: [
          { id: "message-1", sender: "customer", body: "我们准备重新设计办公室，想先了解大概费用。", sentAt: "2026-07-29T08:38:00.000Z", simulated: true },
          { id: "message-2", sender: "agent", body: "可以的，请问办公室面积和所在城市方便告知吗？", sentAt: "2026-07-29T08:40:00.000Z", simulated: true }
        ]
      },
      {
        id: "conversation-xhs-chen", customerId: "customer-xhs-gu", customerName: "陈先生", platform: "小红书", intent: "中", unread: 0, mode: "manual",
        needSummary: "关注品牌视觉升级方案和案例。", risk: "预算范围尚未明确。", tags: ["品牌升级"], updatedAt: "2026-07-29T08:20:00.000Z",
        messages: [{ id: "message-3", sender: "customer", body: "能看看餐饮品牌改造案例吗？", sentAt: "2026-07-29T08:20:00.000Z", simulated: true }]
      },
      {
        id: "conversation-kuaishou-wang", customerName: "王女士", platform: "快手", intent: "高", unread: 1, mode: "paused",
        needSummary: "计划开设新零售门店，需整体升级。", risk: "开店时间仍在确认。", tags: ["门店升级", "高意向"], updatedAt: "2026-07-29T08:12:00.000Z",
        messages: [{ id: "message-4", sender: "customer", body: "新店十月开业，设计周期来得及吗？", sentAt: "2026-07-29T08:12:00.000Z", simulated: true }]
      },
      {
        id: "conversation-weibo-zhao", customerId: "customer-weibo-he", customerName: "赵先生", platform: "微博", intent: "低", unread: 0, mode: "agent",
        needSummary: "浏览过办公改造内容，需求待进一步确认。", risk: "暂无明确采购时间。", tags: ["内容互动"], updatedAt: "2026-07-29T07:55:00.000Z",
        messages: [{ id: "message-5", sender: "agent", body: "您好，可以为您推荐适合的空间案例。", sentAt: "2026-07-29T07:55:00.000Z", simulated: true }]
      },
      {
        id: "conversation-wechat-li", customerId: "customer-wechat-zhou", customerName: "李女士", platform: "微信", intent: "中", unread: 0, mode: "agent",
        needSummary: "需要企业培训与空间服务的组合方案。", risk: "需要确认决策人和采购流程。", tags: ["企业服务"], updatedAt: "2026-07-29T07:40:00.000Z",
        messages: [{ id: "message-6", sender: "customer", body: "请把服务方案发到微信。", sentAt: "2026-07-29T07:40:00.000Z", simulated: true }]
      }
    ],
    customers: [
      { id: "customer-wechat-zhou", conversationId: "conversation-wechat-li", name: "周先生", platform: "微信", intent: "高", group: "重点客户", tags: ["年度合作", "决策人"], owner: "刘顾问", needSummary: "企业空间与培训年度合作。", lastContactAt: "2026-07-29T08:05:00.000Z", nextFollowUpAt: "2026-07-30T10:00:00.000Z", status: "跟进中" },
      { id: "customer-douyin-sun", conversationId: "conversation-douyin-lin", name: "孙女士", platform: "抖音", intent: "中", group: "待跟进", tags: ["预算确认"], owner: "陈顾问", needSummary: "办公室局部改造服务。", lastContactAt: "2026-07-28T16:30:00.000Z", nextFollowUpAt: "2026-07-30T14:00:00.000Z", status: "待跟进" },
      { id: "customer-xhs-gu", conversationId: "conversation-xhs-chen", name: "顾先生", platform: "小红书", intent: "高", group: "已创建商机", tags: ["品牌升级", "方案沟通"], owner: "刘顾问", needSummary: "品牌及办公空间升级服务。", lastContactAt: "2026-07-29T07:30:00.000Z", nextFollowUpAt: "2026-07-30T09:30:00.000Z", status: "已有商机" },
      { id: "customer-weibo-he", conversationId: "conversation-weibo-zhao", name: "何女士", platform: "微博", intent: "低", group: "沉默客户", tags: ["长期培育"], owner: "陈顾问", needSummary: "零售门店升级信息收集。", lastContactAt: "2026-07-10T09:00:00.000Z", nextFollowUpAt: "2026-08-05T10:00:00.000Z", status: "已沉默" }
    ],
    opportunities: [
      { id: "opportunity-office", customerId: "customer-wechat-zhou", title: "办公空间设计", amount: 120000, probability: 55, stage: "qualified", source: "微信", nextAction: "确认场地平面图", updatedAt: "2026-07-29T08:10:00.000Z" },
      { id: "opportunity-training", customerId: "customer-douyin-sun", title: "企业培训年度合作", amount: 68000, probability: 70, stage: "quoted", source: "抖音", nextAction: "跟进报价反馈", quoteAmount: 65000, quoteSentAt: "2026-07-28T14:00:00.000Z", updatedAt: "2026-07-28T14:00:00.000Z" },
      { id: "opportunity-retail", customerId: "customer-xhs-gu", title: "零售门店升级", amount: 188000, probability: 80, stage: "negotiating", source: "小红书", nextAction: "安排合同评审", quoteAmount: 180000, quoteSentAt: "2026-07-29T07:00:00.000Z", updatedAt: "2026-07-29T07:20:00.000Z" }
    ],
    activities: [
      { id: "activity-1", kind: "quote", title: "发送培训报价", detail: "企业培训年度合作报价已发送。", createdAt: "2026-07-28T14:00:00.000Z" },
      { id: "activity-2", kind: "stage", title: "商机进入谈判", detail: "零售门店升级进入合同评审阶段。", createdAt: "2026-07-29T07:20:00.000Z" },
      { id: "activity-3", kind: "transfer", title: "转入私域客户", detail: "周先生已由微信渠道进入重点客户池。", createdAt: "2026-07-29T08:05:00.000Z" },
      { id: "activity-4", kind: "follow-up", title: "创建跟进任务", detail: "明日确认周先生场地平面图。", createdAt: "2026-07-29T08:10:00.000Z" },
      { id: "activity-5", kind: "opportunity", title: "创建商机", detail: "已创建办公空间设计商机。", createdAt: "2026-07-29T08:11:00.000Z" },
      { id: "activity-6", kind: "message", title: "收到抖音咨询", detail: "林女士咨询办公室设计费用。", createdAt: "2026-07-29T08:38:00.000Z" },
      { id: "activity-7", kind: "message", title: "智能体已回复", detail: "已询问面积和所在城市。", createdAt: "2026-07-29T08:40:00.000Z" },
      { id: "activity-8", kind: "follow-up", title: "沉默客户待唤醒", detail: "何女士安排下周内容触达。", createdAt: "2026-07-29T08:42:00.000Z" }
    ],
    tasks: [
      { id: "task-conversation-lin", title: "确认林女士项目面积", priority: "高", module: "conversations", relatedId: "conversation-douyin-lin", done: false },
      { id: "task-private-sun", title: "跟进孙女士预算范围", priority: "中", module: "private-domain", relatedId: "customer-douyin-sun", done: false, dueAt: "2026-07-30T14:00:00.000Z", createdAt: "2026-07-28T16:30:00.000Z" },
      { id: "task-conversion-office", title: "收集办公空间平面图", priority: "高", module: "conversion", relatedId: "opportunity-office", done: false },
      { id: "task-conversion-retail", title: "准备零售门店合同评审", priority: "低", module: "conversion", relatedId: "opportunity-retail", done: false }
    ],
    demoSettings: {
      agents: { "获客识别智能体": true, "社媒沟通智能体": true, "客户跟进智能体": true },
      scripts: { "抖音": true, "小红书": true, "快手": false, "微信": true, "微博": false }
    }
  };
}

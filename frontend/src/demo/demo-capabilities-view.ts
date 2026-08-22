import type { DemoState } from "./demo-types";
import { escapeHtml } from "./demo-ui";

type CapabilityModule = "agents" | "scripts" | "trade-marketing" | "settings";

const agents = [
  { name: "获客识别智能体", role: "发现高意向线索", task: "整理今日新增的跨平台咨询", module: "acquisition", today: 18 },
  { name: "社媒沟通智能体", role: "协同回复社媒咨询", task: "跟进 3 条待确认项目需求", module: "conversations", today: 26 },
  { name: "客户跟进智能体", role: "推进私域客户跟进", task: "提醒 5 位客户确认下一步", module: "private-domain", today: 12 }
] as const;

const scripts = [
  { platform: "抖音", schedule: "每日 10:00、16:00", lastRun: "今日 09:58", task: "整理评论咨询话术" },
  { platform: "小红书", schedule: "工作日 11:00", lastRun: "今日 10:56", task: "生成笔记评论回复" },
  { platform: "快手", schedule: "每日 14:00", lastRun: "昨日 13:59", task: "归集直播间意向提问" },
  { platform: "微信", schedule: "每 4 小时", lastRun: "今日 08:00", task: "提醒客户查看案例" },
  { platform: "微博", schedule: "工作日 15:30", lastRun: "昨日 15:29", task: "汇总私信关键词" }
] as const;

function renderAgents(state: DemoState): string {
  const enabled = agents.filter((agent) => state.demoSettings.agents[agent.name]).length;
  return `
    <section class="demo-capabilities" aria-label="智能体中心">
      <header class="demo-capabilities-header">
        <div><span class="demo-status">演示模式</span><h2>智能体中心</h2><p>角色状态与执行数据均为本地模拟，不会连接真实渠道或自动执行任务。</p></div>
        <span class="demo-chip">${enabled} / ${agents.length} 已启用</span>
      </header>
      <div class="demo-capability-grid demo-agent-grid">
        ${agents.map((agent) => {
          const active = state.demoSettings.agents[agent.name];
          const currentTask = state.tasks.find((task) => !task.done && task.module === agent.module)?.title ?? agent.task;
          return `<article class="demo-capability-card ${active ? "is-active" : "is-paused"}">
            <header><span class="demo-capability-icon">AI</span><span class="demo-agent-status">${active ? "模拟运行中" : "模拟已暂停"}</span></header>
            <h3>${agent.name}</h3><p>${agent.role}</p>
            <dl><div><dt>当前任务</dt><dd>${escapeHtml(currentTask)}</dd></div><div><dt>今日处理</dt><dd>${agent.today} 条 <small>模拟数据</small></dd></div></dl>
            <button type="button" class="demo-capability-toggle" data-demo-action="toggle-agent" data-agent-name="${agent.name}" aria-pressed="${active}">${active ? "暂停（演示）" : "启用（演示）"}</button>
          </article>`;
        }).join("")}
      </div>
    </section>`;
}

function renderScripts(state: DemoState): string {
  const enabled = scripts.filter((script) => state.demoSettings.scripts[script.platform]).length;
  return `
    <section class="demo-capabilities" aria-label="自动工作流">
      <header class="demo-capabilities-header">
        <div><span class="demo-status">演示模式</span><h2>自动工作流</h2><p>仅展示平台工作流的模拟计划；不会登录平台、发布内容或发送消息。</p></div>
        <span class="demo-chip">${enabled} / ${scripts.length} 已启用</span>
      </header>
      <section class="demo-panel demo-script-list" aria-label="平台工作流列表">
        ${scripts.map((script) => {
          const active = state.demoSettings.scripts[script.platform];
          return `<article class="demo-script-row ${active ? "is-active" : "is-paused"}">
            <div class="demo-script-platform"><b>${script.platform}</b><span>${active ? "模拟已启用" : "模拟已暂停"}</span></div>
            <div><small>执行计划</small><b>${script.schedule}</b></div>
            <div><small>上次模拟运行</small><b>${script.lastRun}</b></div>
            <div><small>当前话术任务</small><b>${script.task}</b></div>
            <button type="button" class="demo-capability-toggle" data-demo-action="toggle-script" data-script-platform="${script.platform}" aria-pressed="${active}">${active ? "暂停（演示）" : "启用（演示）"}</button>
          </article>`;
        }).join("")}
      </section>
    </section>`;
}

function renderTradeMarketing(): string {
  return `
    <section class="demo-capabilities" aria-label="外贸营销">
      <header class="demo-capabilities-header"><div><span class="demo-status">演示模式</span><h2>外贸营销</h2><p>面向海外市场的内容与线索流程示意；不会发送邮件或接入境外平台。</p></div><span class="demo-chip">外贸流程预览</span></header>
      <div class="demo-trade-grid">
        <section class="demo-panel demo-trade-markets"><div class="demo-section-heading"><div><span class="demo-chip">目标市场</span><h3>市场定向</h3></div><small>演示策略卡</small></div><div>
          <article><b>北美</b><span>办公空间升级 · 英文内容</span></article>
          <article><b>中东</b><span>酒店与商业综合体 · 阿拉伯语摘要</span></article>
          <article><b>东南亚</b><span>新零售空间 · 英文/越南语提纲</span></article>
        </div></section>
        <section class="demo-panel demo-trade-flow"><div class="demo-section-heading"><div><span class="demo-chip">内容本地化</span><h3>内容与邮件序列</h3></div><small>演示版暂未接入</small></div>
          <ol><li><b>01</b><span>将案例重点调整为当地行业表达</span></li><li><b>02</b><span>生成首封介绍、案例补充与预约提醒邮件</span></li><li><b>03</b><span>按市场时区展示模拟触达节奏</span></li></ol></section>
        <section class="demo-panel demo-trade-handoff"><span class="demo-status">演示版暂未接入</span><h3>外贸线索交接</h3><p>海外询盘、邮箱验证、CRM 建档与销售交接目前只作为流程说明展示。</p><button type="button" class="demo-capability-toggle" disabled>查看交接预览</button></section>
      </div>
    </section>`;
}

function renderSettings(state: DemoState): string {
  const localData = [
    ["社媒会话", state.conversations.length],
    ["私域客户", state.customers.length],
    ["成交商机", state.opportunities.length],
    ["本地活动", state.activities.length]
  ];
  return `
    <section class="demo-capabilities" aria-label="设置中心">
      <header class="demo-capabilities-header"><div><span class="demo-status">连接与系统</span><h2>设置中心</h2><p>接入客户自己的官方搜索与 AI 模型 API；演示数据仍只保存在当前浏览器。</p></div></header>
      <section class="demo-panel demo-settings-connections"><div class="demo-section-heading"><div><span class="demo-chip">客户自带密钥</span><h3>官方搜索与 AI 模型连接</h3></div><small>保存 · 测试 · 人工启用</small></div><p>API Key 只提交给后端加密保存，保存后不再回显。连接通过测试并人工确认启用后，才会用于真实获客任务。</p><div class="demo-settings-connection-grid">
        <article class="demo-settings-connection-card"><span class="demo-capability-icon">搜</span><div><b>官方搜索 API</b><span>配置真实搜索数据源，用于发现公开商机与补充证据。</span></div><button type="button" class="demo-primary" data-demo-action="open-connection-center" data-connection-mode="search">配置搜索 API</button></article>
        <article class="demo-settings-connection-card"><span class="demo-capability-icon">AI</span><div><b>官方 AI 模型</b><span>支持 OpenAI、Kimi、MiniMax、GLM、DeepSeek、通义等官方端点。</span></div><button type="button" class="demo-primary" data-demo-action="open-connection-center" data-connection-mode="model">配置 AI 模型</button></article>
      </div></section>
      <section class="demo-panel demo-settings-data"><div class="demo-section-heading"><div><span class="demo-chip">本地数据</span><h3>演示数据概览</h3></div><small>保存在当前浏览器</small></div><div class="demo-settings-counts">${localData.map(([label, value]) => `<div><small>${label}</small><b>${value}</b></div>`).join("")}</div><div class="demo-settings-reset"><div><b>重置演示数据</b><span>恢复初始客户、会话、商机和模拟开关；此操作不可撤销。</span></div><button type="button" class="demo-danger-button" data-demo-action="open-reset-dialog">重置演示数据</button></div></section>
      <section class="demo-panel demo-settings-unavailable"><div><span class="demo-chip">演示版暂未接入</span><h3>外观、通知与权限</h3></div><div><article><b>外观偏好</b><span>主题和工作台布局</span></article><article><b>通知提醒</b><span>站内、邮件与平台通知</span></article><article><b>访问权限</b><span>成员角色与渠道授权</span></article></div></section>
      <dialog id="demoResetDialog" class="demo-reset-dialog" aria-labelledby="demoResetDialogTitle"><form method="dialog"><span class="demo-status">确认操作</span><h3 id="demoResetDialogTitle">重置本地演示数据？</h3><p>会恢复初始演示数据，并移除当前浏览器中所有本次操作。</p><div><button type="button" data-demo-action="cancel-reset">取消</button><button type="button" class="demo-danger-button" data-demo-action="confirm-reset">确认重置</button></div></form></dialog>
    </section>`;
}

export function renderCapabilityDemoView(
  module: CapabilityModule,
  state: DemoState,
  main: HTMLElement,
  inspector: HTMLElement
): void {
  if (module === "agents") {
    main.innerHTML = renderAgents(state);
    inspector.innerHTML = `<section class="demo-panel demo-capability-inspector"><span class="demo-chip">状态说明</span><h3>模拟智能体协作</h3><p>启用或暂停只会写入本地演示设置。不会读取、发送或处理真实客户数据。</p></section>`;
    return;
  }
  if (module === "scripts") {
    main.innerHTML = renderScripts(state);
    inspector.innerHTML = `<section class="demo-panel demo-capability-inspector"><span class="demo-chip">平台安全</span><h3>无真实平台连接</h3><p>工作流状态与运行记录均为静态演示信息，未接入任何账号、API 或发布能力。</p></section>`;
    return;
  }
  if (module === "trade-marketing") {
    main.innerHTML = renderTradeMarketing();
    inspector.innerHTML = `<section class="demo-panel demo-capability-inspector"><span class="demo-chip">外贸模块</span><h3>仅展示流程</h3><p>市场定向、内容本地化、邮件序列和线索交接均为演示版说明，暂不执行真实动作。</p></section>`;
    return;
  }
  main.innerHTML = renderSettings(state);
  inspector.innerHTML = `<section class="demo-panel demo-capability-inspector"><span class="demo-chip">客户自带密钥</span><h3>真实连接，可控启用</h3><p>官方 API Key 只在创建或轮换时提交；连接需先测试，再人工确认启用。演示数据仍存储在当前浏览器。</p></section>`;
}

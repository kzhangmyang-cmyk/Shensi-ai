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
        <div><span class="demo-status">预览 · 待接入</span><h2>自动工作流</h2><p>仅展示平台工作流的模拟计划；不会登录平台、发布内容或发送消息。</p></div>
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
      <header class="demo-capabilities-header"><div><span class="demo-status">预览 · 待接入</span><h2>外贸营销</h2><p>面向海外市场的内容与线索流程示意；不会发送邮件或接入境外平台。</p></div><span class="demo-chip">外贸流程预览</span></header>
      <div class="demo-trade-grid">
        <section class="demo-panel demo-trade-markets"><div class="demo-section-heading"><div><span class="demo-chip">目标市场</span><h3>市场定向</h3></div><small>演示策略卡</small></div><div>
          <article><b>北美</b><span>办公空间升级 · 英文内容</span></article>
          <article><b>中东</b><span>酒店与商业综合体 · 阿拉伯语摘要</span></article>
          <article><b>东南亚</b><span>新零售空间 · 英文/越南语提纲</span></article>
        </div></section>
        <section class="demo-panel demo-trade-flow"><div class="demo-section-heading"><div><span class="demo-chip">内容本地化</span><h3>内容与邮件序列</h3></div><small>预览 · 待接入</small></div>
          <ol><li><b>01</b><span>将案例重点调整为当地行业表达</span></li><li><b>02</b><span>生成首封介绍、案例补充与预约提醒邮件</span></li><li><b>03</b><span>按市场时区展示模拟触达节奏</span></li></ol></section>
        <section class="demo-panel demo-trade-handoff"><span class="demo-status">预览 · 待接入</span><h3>外贸线索交接</h3><p>海外询盘、邮箱验证、CRM 建档与销售交接目前只作为流程说明展示。</p><button type="button" class="demo-capability-toggle" disabled>查看交接预览</button></section>
      </div>
    </section>`;
}

function renderSettings(): string {
  return `
    <section class="demo-capabilities real-settings-workspace" aria-label="设置中心">
      <header class="real-settings-page-heading">
        <h2>设置中心</h2>
        <p>管理自动营销系统的偏好与权限</p>
      </header>
      <div class="real-settings-layout">
      <aside class="demo-panel real-settings-nav" aria-label="设置分类">
        <strong>设置分类</strong>
        <button type="button" data-settings-target="settings-appearance" aria-controls="settings-appearance"><i class="ph ph-palette" aria-hidden="true"></i>外观主题</button>
        <button type="button" class="active" data-settings-target="settings-model" aria-controls="settings-model" aria-current="true"><i class="ph ph-cube" aria-hidden="true"></i>模型与搜索</button>
        <button type="button" data-settings-target="settings-voice" aria-controls="settings-voice"><i class="ph ph-microphone" aria-hidden="true"></i>语音服务</button>
        <button type="button" data-settings-target="settings-greeting" aria-controls="settings-greeting"><i class="ph ph-chat-circle-dots" aria-hidden="true"></i>启动问候</button>
        <button type="button" data-settings-target="settings-account" aria-controls="settings-account"><i class="ph ph-desktop-tower" aria-hidden="true"></i>账号与工作区</button>
      </aside>
      <div class="real-settings-content">
        <section id="settings-appearance" class="demo-panel real-settings-section product-theme-settings" aria-label="外观主题" tabindex="-1">
          <h3>外观主题</h3><p>仅调整本机显示，不改变账号或业务数据。</p>
          <div class="product-theme-choices" role="group" aria-label="外观主题">
            <button type="button" data-theme-choice="dark" aria-pressed="true">黑绿深色</button>
            <button type="button" data-theme-choice="light" aria-pressed="false">蓝白浅色</button>
          </div>
        </section>
        <section id="settings-model" class="demo-panel real-settings-section" aria-label="模型与搜索" tabindex="-1">
          <header><h3>模型与搜索</h3><span>客户自带密钥 · 保存后不回显</span></header>
          <article class="real-settings-row"><i class="ph ph-cube" aria-hidden="true"></i><div><b>AI 模型</b><span>经营问答使用的模型</span></div><em data-settings-status="model">正在读取…</em><button type="button" data-demo-action="open-connection-center" data-connection-mode="model">管理模型</button></article>
          <article class="real-settings-row"><i class="ph ph-magnifying-glass" aria-hidden="true"></i><div><b>搜索服务</b><span>用于公开信息检索</span></div><em data-settings-status="search">正在读取…</em><button type="button" data-demo-action="open-connection-center" data-connection-mode="search">配置搜索</button></article>
        </section>
        <section id="settings-voice" class="demo-panel real-settings-section" aria-label="语音与启动" tabindex="-1">
          <header><h3>语音与启动</h3><span>偏好仅影响当前设备</span></header>
          <article class="real-settings-row real-settings-voice-row"><i class="ph ph-microphone" aria-hidden="true"></i><div><b>实时语音服务</b><span>连续对话、插话打断与经营总管语音回复</span></div><dl class="real-settings-voice-meta"><div><dt>提供商</dt><dd>百炼</dd></div><div><dt>状态</dt><dd data-settings-status="voice">正在读取…</dd></div></dl><button type="button" data-settings-voice-check aria-label="检测实时语音连接">连接检测</button><button type="button" data-settings-voice-configure>配置</button></article>
          <article id="settings-greeting" class="real-settings-row real-settings-greeting-row" aria-label="启动问候" tabindex="-1"><i class="ph ph-chat-circle-dots" aria-hidden="true"></i><div><b>启动问候</b><span>进入应用后播放一句自然问候，可随时停止</span></div><em data-greeting-preference-status>正在读取本机偏好</em><label class="real-settings-switch"><input type="checkbox" data-greeting-enabled><span data-greeting-enabled-label>启动问候</span></label></article>
          <article class="real-settings-row real-settings-voice-choice-row"><i class="ph ph-waveform" aria-hidden="true"></i><div><b>音色选择</b><span>Ethan 男声 / Tina 女声，由百炼实时语音生成并缓存在本机</span></div><div class="real-settings-segmented" role="group" aria-label="启动问候音色"><button type="button" data-greeting-voice="male" aria-pressed="false">男声</button><button type="button" data-greeting-voice="female" aria-pressed="false">女声</button></div><button type="button" data-greeting-preview>试听</button></article>
          <article class="real-settings-row real-settings-random-row"><i class="ph ph-shuffle" aria-hidden="true"></i><div><b>问候方式</b><span>随机问候会从已审核的三句文案中选择</span></div><em>当前 Mac</em><label class="real-settings-switch"><input type="checkbox" data-greeting-random><span>随机问候</span></label></article>
          <article class="real-settings-row real-settings-example"><i class="ph ph-quotes" aria-hidden="true"></i><div><b>示例</b><span>老板，你来啦。今天咱们先忙点什么？</span></div></article>
        </section>
        <section id="settings-account" class="demo-panel real-settings-section" aria-label="账号与工作区" tabindex="-1">
          <header><h3>账号与工作区</h3><span>当前登录会话隔离</span></header>
          <article class="real-settings-row real-settings-account-row"><i class="ph ph-desktop-tower" aria-hidden="true"></i><div><b>当前设备</b><span>业务数据与当前登录账号、工作区保持隔离</span></div><em>本机设置</em><span class="demo-settings-location">设备级</span></article>
        </section>
      </div>
      </div>
      <footer class="demo-panel real-settings-footer"><button type="button" class="demo-primary" data-greeting-save>保存启动问候</button><span><i class="ph ph-shield-check" aria-hidden="true"></i>仅保存本机启动问候；模型、搜索与语音连接在各自入口保存</span></footer>
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
  main.innerHTML = renderSettings();
  inspector.innerHTML = "";
}

# 业务顾问中心前端打磨实施计划

> **执行要求：** 按任务顺序使用红—绿—重构循环；每个新增行为先写失败测试，看到预期失败后再写实现。完成每个任务后运行对应测试并提交。

**目标：** 在不改变现有路由、接口和业务数据的前提下，把业务顾问团队总览、诊断报告、Agent 工作台和报表上传流程统一成现有 GoodJob 深色指挥中心视觉，并补齐可访问交互与移动端布局。

**架构约束：** `src/growth/agents/view.ts` 只负责纯 HTML 渲染；`src/growth/agents/controller.ts` 维护文件选择、拖放和问题示例交互；`src/growth/styles.css` 复用 `replica-dashboard.css` 的现有设计令牌并限制选择器作用域；不新增运行时依赖，不修改 API 协议。

**技术栈：** TypeScript、原生 DOM、CSS、Vitest 风格自测脚本（`tsx src/self-test.ts`）、Playwright。

---

## Task 1：接入 Growth 样式并升级团队总览

**文件：**

- 修改：`index.html`
- 修改：`src/growth/agents/view.ts`
- 修改：`src/growth/agents/controller.ts`
- 修改：`src/growth/agents/view.self-test.ts`
- 修改：`src/growth/styles.css`
- 修改：`tests/growth-bootstrap.spec.ts`

### 1.1 写总览渲染失败测试

在 `src/growth/agents/view.self-test.ts` 增加断言，要求总览包含：

```ts
const overview = renderAgentsOverview(agents, {
  sourceLabel: "示例企业经营数据",
  healthScoreBps: 4600,
  sources: ["资产负债表", "利润表", "现金流量表"],
});

assertIncludes(overview, 'aria-label="企业健康评分 46 分"');
assertIncludes(overview, 'class="health-score-ring"');
assertIncludes(overview, 'class="data-source-badge"');
assertIncludes(overview, "资产负债表");
```

在 `tests/growth-bootstrap.spec.ts` 的团队页用例增加真实消费者样式断言：

```ts
await expect(page.locator(".agents-grid")).toBeVisible();
expect(await page.locator(".agents-grid").evaluate((element) => getComputedStyle(element).display)).toBe("grid");
```

### 1.2 运行测试并确认红灯

运行：

```bash
npm test
npx playwright test tests/growth-bootstrap.spec.ts --grep "团队"
```

预期：视图自测因新参数/标记缺失失败；Playwright 因 `growth/styles.css` 未接入而得到非 `grid` 布局。

### 1.3 实现健康分和数据源模型

在 `view.ts` 扩展参数并添加纯渲染 helper：

```ts
interface AgentsOverviewOptions {
  readonly sourceLabel: string;
  readonly showImport?: boolean;
  readonly demo?: boolean;
  readonly healthScoreBps?: number;
  readonly sources?: readonly string[];
}

function healthScoreMarkup(healthScoreBps?: number): string {
  if (healthScoreBps === undefined) {
    return `<div class="health-score-ring is-pending" aria-label="企业健康评分待生成" role="img"><strong>待生成</strong></div>`;
  }
  const score = Math.max(0, Math.min(100, Math.round(healthScoreBps / 100)));
  return `<div class="health-score-ring" style="--health-score:${score}%" aria-label="企业健康评分 ${score} 分" role="img"><strong>${score}</strong><span>/ 100</span></div>`;
}
```

在 `controller.ts` 从当前 `BusinessReportInput` 推导真实数据源标签：

```ts
function sourceBadgesForInput(input: BusinessReportInput): readonly string[] {
  return [
    "资产负债表",
    "利润表",
    "现金流量表",
    ...(input.costDetail ? ["成本明细"] : []),
    ...(input.taxRisk ? ["税务风险"] : []),
  ];
}
```

演示模式使用现有 `demoDiagnosisReport().healthScoreBps`，真实模式仅在已有报告时显示分数，否则显示“待生成”。

### 1.4 接入并实现深色总览样式

在 `index.html` 的现有 CSS 链接之后加入：

```html
<link rel="stylesheet" href="/src/growth/styles.css" />
```

在 `src/growth/styles.css` 使用现有 `--replica-*` 令牌重做以下区域：

- `.growth-panel`、`.growth-header`
- `.agents-hero`、`.agents-grid`、`.agent-card`
- `.health-score-ring`（`conic-gradient`）
- `.data-source-badge`
- Agent 头像、状态标签和主次按钮

约束：选择器限制在 `#growthWorkspace` 或 `.replica-shell` 下；绿色只表示主动作/可用状态，红黄只表示风险；支持 `prefers-reduced-motion`。

### 1.5 运行绿灯并提交

运行：

```bash
npm test
npx playwright test tests/growth-bootstrap.spec.ts --grep "团队"
```

提交：

```bash
git add index.html src/growth/agents/view.ts src/growth/agents/controller.ts src/growth/agents/view.self-test.ts src/growth/styles.css tests/growth-bootstrap.spec.ts
git commit -m "feat: polish business advisor overview"
```

---

## Task 2：实现可访问的拖放上传与多公司选择

**文件：**

- 修改：`src/growth/agents/view.ts`
- 修改：`src/growth/agents/controller.ts`
- 修改：`src/growth/agents/view.self-test.ts`
- 修改：`src/growth/styles.css`
- 修改：`tests/growth-bootstrap.spec.ts`

### 2.1 写上传标记与交互失败测试

视图自测要求两个原生文件输入分别位于可点击投放区，并包含状态播报：

```ts
assertIncludes(overview, 'data-statements-drop="balance"');
assertIncludes(overview, 'data-statements-file-name="balance"');
assertIncludes(overview, 'data-statements-drop="income"');
assertIncludes(overview, 'data-statements-feedback');
assertIncludes(overview, 'aria-live="polite"');
```

Playwright 增加两个行为：

```ts
await page.locator('[data-statements-file="balance"]').setInputFiles({
  name: "balance.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  buffer: Buffer.from("balance"),
});
await expect(page.locator('[data-statements-file-name="balance"]')).toContainText("balance.xlsx");
```

第二个测试在投放区派发含 `File` 的 `drop` 事件，要求文件名和已选数量同步更新。

### 2.2 运行并确认红灯

运行：

```bash
npm test
npx playwright test tests/growth-bootstrap.spec.ts --grep "报表|集团"
```

预期：新投放区标记不存在，文件变更后 UI 不更新。

### 2.3 实现上传状态与拖放控制器

在 `view.ts` 保留原生 `<input type="file">`，通过 `<label class="statement-dropzone">` 扩大点击目标，输出：

- 文件类型说明
- 当前文件名槽位
- `aria-live` 反馈
- 已选择数量

在 `controller.ts` 增加：

```ts
function syncStatementSelection(): void
function handleStatementDragOver(event: DragEvent): void
function handleStatementDragLeave(event: DragEvent): void
function handleStatementDrop(event: DragEvent): void
```

拖放时将 `DataTransfer.files` 写回对应原生输入并触发 `change`，确保提交继续复用现有解析流程；无文件时在面板内反馈，不替换整个页面。

### 2.4 升级多公司选择视觉

保持 `renderCompanyPicker` 的现有选择行为和数据结构，补充：

- 表头与公司数量
- 每行独立按钮和错误状态
- `company-picker-row`、`has-error` 等语义类
- 移动端单列布局

不得隐藏或改写导入错误原文。

### 2.5 运行绿灯并提交

运行：

```bash
npm test
npx playwright test tests/growth-bootstrap.spec.ts --grep "报表|集团"
```

提交：

```bash
git add src/growth/agents/view.ts src/growth/agents/controller.ts src/growth/agents/view.self-test.ts src/growth/styles.css tests/growth-bootstrap.spec.ts
git commit -m "feat: add statement dropzone interactions"
```

---

## Task 3：升级诊断报告的风险层级、证据和 90 天时间轴

**文件：**

- 修改：`src/growth/agents/view.ts`
- 修改：`src/growth/agents/view.self-test.ts`
- 修改：`src/growth/styles.css`
- 修改：`tests/growth-bootstrap.spec.ts`

### 3.1 写报告语义失败测试

在视图自测增加：

```ts
const reportHtml = renderDiagnosisReport(demoDiagnosisReport());
assertIncludes(reportHtml, 'aria-label="企业健康评分 46 分"');
assertIncludes(reportHtml, 'class="report-issue issue-red"');
assertIncludes(reportHtml, '<details class="report-evidence"');
assertIncludes(reportHtml, 'class="report-timeline"');
```

Playwright 增加证据折叠测试：证据正文初始不可见，点击 `summary` 后可见；并断言红/黄问题卡与 90 天时间轴存在。

### 3.2 运行并确认红灯

运行：

```bash
npm test
npx playwright test tests/growth-bootstrap.spec.ts --grep "报告|诊断"
```

预期：报告缺少 `<details>`、风险类和时间轴结构。

### 3.3 实现报告语义结构

在 `renderDiagnosisReport`：

- 复用总览健康分 helper；
- 每条问题输出 `.report-issue.issue-red` 或 `.report-issue.issue-yellow`；
- 原因、风险、建议使用明确标签；
- 证据使用原生 `<details>/<summary>`；
- 完整证据链也使用可折叠结构；
- 90 天行动输出 `.report-timeline` 有序列表。

继续使用 `escapeHtml` 处理所有来自数据模型的字符串。

### 3.4 实现桌面与移动端视觉

在 `src/growth/styles.css`：

- 红/黄左边线及低饱和背景；
- 折叠摘要有清晰焦点态；
- 桌面横向 30/60/90 天节点；
- `max-width: 768px` 时转为纵向时间轴；
- 长证据文本可换行，不造成横向滚动。

### 3.5 运行绿灯并提交

运行：

```bash
npm test
npx playwright test tests/growth-bootstrap.spec.ts --grep "报告|诊断"
```

提交：

```bash
git add src/growth/agents/view.ts src/growth/agents/view.self-test.ts src/growth/styles.css tests/growth-bootstrap.spec.ts
git commit -m "feat: clarify diagnosis report hierarchy"
```

---

## Task 4：升级 Agent 工作台的提问引导和结构化结论

**文件：**

- 修改：`src/growth/agents/view.ts`
- 修改：`src/growth/agents/controller.ts`
- 修改：`src/growth/agents/view.self-test.ts`
- 修改：`src/growth/styles.css`
- 修改：`tests/growth-bootstrap.spec.ts`

### 4.1 写问题示例与结构化输出失败测试

视图自测要求每个 Agent 至少三个可点击示例，并有聊天/结论语义区：

```ts
assertIncludes(detail, 'data-agent-question="哪个产品是假利润？"');
assertIncludes(detail, 'class="agent-question-examples"');
assertIncludes(detail, 'class="agent-answer-empty"');
```

Playwright 验证点击问题示例只填入输入框、不自动提交：

```ts
await page.getByRole("button", { name: "哪个产品是假利润？" }).click();
await expect(page.locator('[data-agent-question-input]')).toHaveValue("哪个产品是假利润？");
await expect(page.locator(".agent-answer-empty")).toBeVisible();
```

提交后断言 `.agent-answer-conclusion`、`.agent-answer-evidence` 和 `.agent-answer-actions` 都存在。

### 4.2 运行并确认红灯

运行：

```bash
npm test
npx playwright test tests/growth-bootstrap.spec.ts --grep "工作台|产品"
```

预期：示例仍为静态文本，结构化回答容器不存在。

### 4.3 实现问题示例和输入联动

将单个 `agentPromptExample` 改为返回三条问题的 `agentPromptExamples`，按钮只负责：

```ts
input.value = button.dataset.agentQuestion ?? "";
input.focus();
```

不自动提交，不改动 hash，不发起网络请求。

### 4.4 实现结构化回答卡

保留现有分析文本和数据，不伪造置信度。把结果分为：

- `.agent-answer-conclusion`：结论
- `.agent-answer-evidence`：判断依据
- `.agent-answer-actions`：建议动作
- `.report-evidence`：证据链

空状态使用 `.agent-answer-empty`，明确说明“选择示例问题或输入问题后提交”。

### 4.5 运行绿灯并提交

运行：

```bash
npm test
npx playwright test tests/growth-bootstrap.spec.ts --grep "工作台|产品"
```

提交：

```bash
git add src/growth/agents/view.ts src/growth/agents/controller.ts src/growth/agents/view.self-test.ts src/growth/styles.css tests/growth-bootstrap.spec.ts
git commit -m "feat: improve advisor question workflow"
```

---

## Task 5：文档同步、视觉核验和全量验证

**文件：**

- 修改：`README.md`
- 必要时修改：`NEXT_AI_TASKS.md` 的当前执行状态（仅当仓库内存在且仍作为当前入口）

### 5.1 同步当前入口文档

在 `README.md` 的路由/演示入口中补充：

```md
- `#growth/agents`：业务顾问团队、经营体检报告与单 Agent 工作台
```

说明报表上传仍为本地演示解析；不要写尚未存在的后端能力。

### 5.2 运行静态与单元验证

运行：

```bash
npm test
npm run typecheck
npm run build
```

如果脚本名与仓库实际不符，先读取 `package.json`，使用等价的现有脚本，不新增临时脚本。

### 5.3 运行完整 Playwright

运行：

```bash
npx playwright test tests/growth-bootstrap.spec.ts
```

预期：全部用例通过，且测试不依赖 5188 端口上无关项目。

### 5.4 浏览器视觉核验

使用当前项目的 `http://127.0.0.1:5189` 依次核验：

- `#agents`：总览层级、健康分、数据源标签、上传面板；
- `#agents/demo`：演示数据和生成报告；
- `#agents/demo/report`：问题卡、折叠证据、90 天时间轴；
- `#agents/demo/profit`：问题示例、输入焦点、结构化回答；
- 390px 宽度：报告时间轴纵向且无横向滚动。

分别截取桌面与移动端截图，与已确认的概念图对照：

- `docs/superpowers/specs/assets/2026-08-14-business-advisor/team-overview.png`
- `docs/superpowers/specs/assets/2026-08-14-business-advisor/diagnosis-report.png`
- `docs/superpowers/specs/assets/2026-08-14-business-advisor/agent-workbench.png`
- `docs/superpowers/specs/assets/2026-08-14-business-advisor/statement-upload.png`
- `docs/superpowers/specs/assets/2026-08-14-business-advisor/diagnosis-report-mobile.png`

检查浏览器控制台无新增 error/warning。

### 5.5 最终提交

运行：

```bash
git status --short
git diff --check
```

确认 `pnpm-workspace.yaml` 和 `debug-agents.mts` 仍未纳入提交，然后提交文档与验证所需的小修：

```bash
git add README.md
git commit -m "docs: document business advisor routes"
```

最终记录准确的测试数量、构建结果、浏览器检查页面和仍保留的用户改动。

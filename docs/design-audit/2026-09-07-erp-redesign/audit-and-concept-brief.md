# Shensi Electron ERP 视觉审计与概念简报

日期：2026-09-07  
范围：审计、概念选择、现有 Electron 源码实现与桌面开发态验收；未生成或安装新安装包。

## 已确认的产品约束

- 继续使用现有 Electron 壳层、左侧导航和黑色背景 + 鲜绿色强调色。
- 自动营销总览以经营指标为第一优先级。
- 默认时间范围为最近三个月，必须同时显示精确起止日期、对比周期和数据口径。
- 概念稿中的数字只能标为设计样例；生产页面不得伪造经营数据。
- 其余六个业务页在总览视觉方向确认后展开，避免在未选定方向前重复实现。

## 当前技术栈与设计基线

- Electron 44 + Vite 6 + TypeScript；React 19 已安装，但当前多个核心视图仍由 TypeScript 字符串渲染器生成。
- 主要色彩令牌来自 `frontend/src/replica-dashboard.css`：背景 `#020303`、正文 `#f1f3f0`、次级文字 `#8c928e`、强调色 `#18ed78`、危险色 `#ff5d56`、警示色 `#f0a44b`。
- 当前窗口由 `desktop/src/main/create-window.ts` 创建；启动逻辑位于 `desktop/src/main/main.ts`。
- 七个页面入口分别位于：
  - `frontend/src/demo/demo-app.ts`
  - `frontend/src/growth/advisor/view.ts`
  - `frontend/src/growth/catalog/view.ts`
  - `frontend/src/growth/quotes/view.ts`
  - `frontend/src/growth/finance/view.ts`
  - `frontend/src/growth/roi/view.ts`
  - `frontend/src/growth/council/view.ts`

## 当前页面证据

最新源码运行截图位于 `current/`：

1. `01-operating-cockpit-latest.png`
2. `02-growth-advisor-latest.png`
3. `03-customer-catalog-latest.png`
4. `04-quote-workbench-latest.png`
5. `05-finance-operations-latest.png`
6. `06-roi-analysis-latest.png`
7. `07-financial-council-latest.png`

总览与选定 v2 概念的同视口对照位于
`comparisons/dashboard-v2-vs-real-1280x768.png`。生产界面保留真实零数据，不复制
概念稿中的样例数字；同时保留指标条、筛选、表头、导入区、流程阶段和下一步入口，
避免空工作区退化为不可操作的大空白。六个 Growth 路由不再显示上一页遗留的搜索和
“新建智能体”动作；1280×768 下侧栏可独立滚动，财务委员会入口可见且不会带动主体页面跳转。
本轮聚焦渲染/路由测试、TypeScript 检查和桌面 renderer 构建通过。全量前端中的既有
Douyin 轮询顺序间歇失败与 CFO 音频竞态不在本视觉改动中宣称已通过。

## 七个页面的目标信息架构

### 自动营销总览

- 顶部：最近三个月日期、上期对比、数据更新时间和样例/真实数据状态。
- 第一层：线索、有效线索、商机、赢单、回款、回款率等经营 KPI。
- 第二层：金额趋势与数量趋势必须分图、分单位；禁止把线索数量放入 CNY 纵轴。
- 第三层：转化漏斗、渠道贡献、今日待办、异常与提醒。
- 漏斗百分比必须统一口径：要么明确为总线索占比，要么按上一阶段计算阶段转化率。

### 增长顾问

- 推荐队列、优先级、证据与影响范围置于左侧主列表。
- 右侧为推荐详情、依据、可执行动作和审批历史。
- 清楚区分“建议”“已批准”“执行中”“已完成”“失败”。

### 客户目录

- 可保存的筛选视图、客户分群、批量分配/打标签/导出。
- 列表显示负责人、生命周期、最近互动、商机金额、风险与下一步。
- 右侧详情包含摘要、联系人、商机、报价、互动时间线和审计记录。

### 报价工作台

- 主列表提供状态、客户、版本、金额、毛利、有效期、负责人和审批进度。
- 详情必须包含逐行产品、数量、单价、折扣、税、总计、条款、版本差异。
- 明确支持提交审批、驳回、撤回、复制新版本和发布；保留审批轨迹。

### 财务经营

- 导入流程采用上传、字段映射、预览、校验、确认五步，并显示错误行下载。
- 导入完成后进入账本列表，支持凭证、账户、期间、金额、状态筛选和批量处理。
- 数据缺失、未匹配、重复和已锁定期间要在行级明确提示。

### ROI 经营分析

- 最近三个月趋势、渠道/活动对比、投入—产出、回款与归因状态。
- 漏斗和 cohort 视图分开；每个指标提供口径说明和可下钻的底层记录。
- 无归因数据时说明缺失条件，不显示伪造折线或百分比。

### 财务委员会

- 顶部显示当前审议阶段、参与角色、材料完整度和待决事项。
- 主列表为议题/发现/建议/异议/共识/审批阶段。
- 详情展示证据、模型来源、反驳、决议、负责人、执行期限和审计时间线。

## 外部产品模式与复用边界

| 参考 | 可借鉴模式 | 许可证/维护判断 | Shensi 复用边界 |
| --- | --- | --- | --- |
| Frappe Desk / ERPNext | 固定模块导航、可保存列表视图、过滤/分页、表单时间线、Lead→Opportunity→Quotation→Customer 流程 | Frappe Framework 为 MIT；ERPNext 为 GPL-3.0；Frappe CRM 为 AGPL-3.0，活跃发布 | 只借鉴信息架构，不复制 GPL/AGPL 代码或资产 |
| Odoo 19 | List/Form/Kanban/Graph/Pivot、多层审批、全局过滤和下钻 | Odoo 社区核心为 LGPLv3；企业模块许可不同 | 只借鉴通用交互模式，不引入整套框架或企业资产 |
| 金蝶 EAS Cloud | 顶部工具栏、行级下钻、批量提交/审批/导出、财务共享处理与异常队列 | 商业专有软件 | 只观察公开产品模式，不复用代码、素材或专有流程文本 |

主要来源：

- [Frappe Desk](https://docs.frappe.io/framework/user/en/desk)
- [Frappe List API](https://docs.frappe.io/framework/user/en/api/list)
- [ERPNext CRM](https://docs.frappe.io/erpnext/CRM)
- [ERPNext Quotation](https://docs.frappe.io/erpnext/quotation)
- [ERPNext Workflows](https://docs.frappe.io/erpnext/workflows)
- [Frappe CRM repository](https://github.com/frappe/crm)
- [ERPNext releases](https://github.com/frappe/erpnext/releases)
- [Odoo backend views](https://www.odoo.com/documentation/19.0/developer/tutorials/backend.html)
- [Odoo dashboards](https://www.odoo.com/documentation/19.0/applications/productivity/dashboards.html)
- [Odoo approval rules](https://www.odoo.com/documentation/19.0/applications/studio/approval_rules.html)
- [Odoo core license](https://github.com/odoo/odoo/blob/19.0/LICENSE)
- [金蝶结算处理列表](https://vip.kingdee.com/eascloud/help/8.6/FSSC.web/topics/noname1383.html)
- [金蝶财务共享处理](https://vip.kingdee.com/eascloud/help/8.6/FSSC.web/topics/noname917.html)

安全与适配结论：维持当前 capability gate、工作区隔离、幂等键、ETag/版本冲突和审计轨迹；不引入外部 ERP 的插件生态或数据权限模型。

## 概念稿

- 推荐方向：`concepts/direction-operating-cockpit-v2.png`
  - 已改为最近三个月 `2026-06-07 ~ 2026-09-07`，并给出上期对比。
  - 金额与线索数量已拆成独立图表；保留漏斗、渠道环图、今日待办和异常栏。
  - 仍是设计样例，生产实现必须使用代码原生文字和真实接口数据。
- 备选：`concepts/direction-workflow-control-tower.png`
- 备选：`concepts/direction-decision-review-desk.png`

## 启动 Logo 动效预览

- 可播放预览：`startup-motion/preview.html`
- 原始品牌资产：`startup-motion/assets/shensi-logo-original.png`
- 关键帧：
  - `startup-motion/keyframes/01-three-atoms.jpg`
  - `startup-motion/keyframes/02-orbit-convergence.jpg`
  - `startup-motion/keyframes/03-complete-logo.jpg`
  - `startup-motion/keyframes/04-app-entered.jpg`

实测结论：启动遮罩已集成到同一个 BrowserWindow。三个外原子沿多层青绿轨迹旋转
聚拢，随后形成单张原始 Logo，再淡出进入登录页；初始化与动效并行，失败态提供重试。
运行时仍以 `frontend/public/assets/shensi-logo.png` 为唯一品牌字形源，用 SVG
颜色矩阵仅将其白色底色键出为透明，不使用重绘 Logo 替代它；原图未被改写。
应用内截图接口返回时动效已经结束，因此早期截图只记录到登录页。macOS 连续取帧已
捕获实际播放过程，`current/00-startup-splash-latest.png` 是运行中原子/轨道阶段的真实帧。
`prefers-reduced-motion` 使用静态 Logo 和较短停留时间，保留系统辅助功能偏好。

## 已实施的准确范围

- 总览：`frontend/src/demo/demo-app.ts`
- 六个业务视图：`frontend/src/growth/{advisor,catalog,quotes,finance,roi,council}/view.ts`
- 页面编排：`frontend/src/growth/runtime.ts`
- 导航：`frontend/index.html`
- 视觉令牌与布局：`frontend/src/replica-dashboard.css`
- 启动遮罩：`frontend/src/desktop/startup-splash.ts`
- Electron 窗口与就绪事件：`desktop/src/main/create-window.ts`、`desktop/src/main/main.ts`

已覆盖各页渲染、日期与口径、真实空状态、报价/财务/ROI/委员会路由、启动成功、
超时、重试和减少动态的聚焦测试。真实数据分支继续由原有领域与集成测试负责。

## 当前可执行验证命令

```bash
pnpm --filter ./frontend test
pnpm --filter ./frontend build:desktop
pnpm --dir desktop test
pnpm --dir desktop typecheck
pnpm desktop:build:renderer
pnpm desktop:local
```

本阶段已运行前端类型检查与桌面 renderer build，且验证构建不包含 remote canvas；
未运行安装包构建或安装。以上为仓库当前 `package.json` 中实际存在的入口。

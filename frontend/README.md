# Shensi Sales 前端

本目录是 Shensi Sales Monorepo 的前端 workspace，包含黑色智能体业务壳、真实 Growth/财务委员会界面、演示模式、浏览器扩展和 Playwright 验收。后端位于仓库根目录的 `backend/`。

共享壳的演示提交处理仅接管显式带 `data-demo-action` 且未被处理的表单；真实业务模块自行报告接口结果，不显示模拟提交成功。回归入口为 `pnpm --dir frontend test:real-primary-actions`。

产品外观提供黑绿深色（默认）与蓝白浅色，在侧栏和设置中心切换。`public/theme-init.js` 在样式加载前恢复偏好；`theme.ts` 保存不含账号信息的本机外观偏好，通过 host 范围 cookie 适配桌面随机网关端口。平台运营后台不加载此入口。`theme.css` 提供浅色语义颜色，组件保留深色原值作为回退；首页 3D 场景和五角色星盘保留完整深色艺术区域，不使用反色滤镜或把浅色节点文字放在白底上。主题行为回归：`pnpm --dir frontend test:theme`；星盘明暗主题和窄屏对比度回归：`pnpm --dir frontend exec playwright test --config=playwright.decision-theme.config.ts`。逐页视觉覆盖以实际验收记录为准，行为测试不替代视觉验收。

## 当前范围

- 运营后台独立入口 `admin.html`，四页为企业客户、账号、套餐授权、操作日志；源码在 `src/platform-admin/`，DTO由 `contracts/openapi/platform-admin.v1.yaml` 生成。依赖同源API与独立MFA运营会话，现有客户业务壳不变。部署和剩余恢复/老客户纳管工作见 `../docs/modules/platform-administration.md`。

- 企业查询：侧栏 `#enterprise-query`，全国省市与四级行业筛选已有资料；爱企查普通关键词搜索回传首批，显式“加载更多”逐页去重追加并保留详情，失败保留、受限停止、新查询清空，明确不应用地区行业。另有GLEIF名称查询；需要网站权限的两级行业/省市高级查询折叠为次要入口，受限不降级、不自动入池。字段、来源及验收边界见 `../docs/modules/enterprise-query.md`。

- 所有真实文件入口按用途提供批量暂存：企业资料多选/拖放、逐份解析/失败重试/移除，选中的成功集合分析与导出；入账逐文件映射确认，正式三表同一表种多份候选由用户明确选用，不合并期间。入口及验收见 `docs/modules/file-upload-inventory.md`（仓库根目录）。

- 通用只读入口同时支持 `.xls`：前端文件过滤与 `application/vnd.ms-excel` 请求一致，后端按 OLE 或受限 HTML/SpreadsheetML 实际内容读取。结构化入账仍仅 CSV/XLSX；不要改名冒充转换格式。

- 财务、ROI、财务委员会共用 `growth/finance/enterprise-analysis.ts` 的通用资料入口：选文件只读解析，显式调用当前模型生成带来源报告，复用桌面 PDF 导出桥。缺少 ROI 依据只给定性建议；结构化入账和正式三表分析独立保留，不阻塞资料阅读。页面内报告需导出保存，不写成正式委员会历史。

- 客户业务前端为黑色智能体业务壳；`#agents` 的六张智能体卡牌是智能体首页，`#dashboard` 是可用的自动营销总览
- 主侧栏显示「燊锶」品牌名，图标复用已批准的 `/assets/shensi-logo.png` 原子图形，以局部 SVG 视口和独立深色适配滤镜去白底、提高对比度；不替换原始素材或改变启动动画。
- 登录入口沿用黑绿品牌双栏：左侧为品牌插画和简短业务说明，右侧为账号／密码表单与登录／注册切换；小屏收起装饰插画并改为单栏。插画使用本地 `/assets/shensi-login-hero.png`，没有新增登录方式、凭据保存规则或认证接口。
- 主导航只保留六个实际入口：自动营销总览、获客中心、社媒对话、私域客户池、智能体中心和设置中心；`#demoModuleMain` 是唯一可见主内容宿主
- 侧栏提供 `#growth/advisor`、`#growth/catalog`、`#growth/quotes`、`#growth/finance`、`#growth/roi` 和 `#financial-council` 六个真实 Growth 入口；`/`、空 Hash 和未知 Hash 自动回到 `#agents`，旧白色 CRM 不再提供入口
- 六个 Growth 页面共享当前黑灰绿经营工作台密度；空工作区仍保留指标、筛选、表格或流程结构。`#growth/finance` 使用极简页头并隐藏主操作，其余 Growth 页面显示“查看今日待办”。真实模式的顶部搜索仅在获客中心筛选获客任务；私域客户、社媒候选和报价使用各自页面已有的搜索框，⌘K / Ctrl+K 聚焦当前页面搜索，没有搜索的页面不拦截此快捷键。侧栏可独立滚动，不会在寻找底部经营入口时带动主体内容跳转
- 共用页头不展示尚未接入的提醒、消息按钮或静态通知圆点；获客看板的“真实状态”是文字说明，任务组箭头仍可折叠列表。
- 桌面宽度从 1000px 起，公共顶部为标题、可伸缩搜索和完整操作区；操作按钮不被搜索框挤压，键盘焦点沿用绿色强调。获客四张指标卡等宽，标题、数值和说明按紧凑行距排列，不再让第四张卡片过窄或用负间距叠放数值。布局修改须检查 1280px 等实际窗口宽度下的重叠、换行和操作可达性；孤立组件截图不替代真实登录的整页验收。
- 历史 `#conversion`、`#scripts` 和 `#trade-marketing` 纯演示页已移出导航；旧链接分别导向真实报价工作台或智能体中心，不再展示伪造的本地商机。真实登录下的 `#conversations` 是公开证据受控外联工作台，与 `#acquisition` 共用服务器批次/修订/审批/回执权威，且明确不是抖音官方 inbox
- 共享的右侧 inspector 只在总览和私域客户池中由当前路由拥有；私域客户池初次进入不会预选客户，只有用户在表中明确选择或由携带真实客户标识的深链进入时才显示详情。社媒对话把发送与审批说明收进主工作区的可展开帮助，避免技术说明挤占私信编辑首屏。智能体、设置和 Growth 页面进入时会清空并隐藏 inspector，防止上一页的详情面板残留遮挡。
- 真实私域客户列表在未选中客户时占满主内容区；客户详情只由右侧 inspector 承载，并在桌面窄列中使用两列事实卡片和本机时区的紧凑时间显示，避免列表被旧演示分组列压缩或详情横向溢出。详情使用负责人等业务字段，不显示内部客户标识。今日跟进中的已关联客户使用可聚焦的原生按钮打开同一详情；“全部客户 / 待跟进 / 今日待办”使用单选语义的 `aria-pressed` 筛选按钮组，不伪装成缺少面板和键盘模型的页签。客户表以 10–12px 的分层文本保留来源、最近跟进、下一步、筛选、刷新、开始获客与 20/50/100 条分页；零客户只显示真实空状态，不补造 CRM 记录。
- 桌面获客中心只展示真实业务入口，不再暴露可切换的本地演示模式；真实抖音任务为空时以紧凑状态行保留任务列表层级，不伪造任务。私域客户池把客户总数、刷新和“开始获客”收在同一工具栏，避免空状态占用整屏。
- 自动营销总览在工作区没有客户、活跃商机或待办时明确显示“暂无可判断的经营数据”，不把空数据推断成低风险或金额影响；趋势、漏斗、渠道和待办均明确标注为空，不以虚构数值替代真实记录。财务经营页使用结构化台账表格承载真实事实与成本；ROI 的“数据截至”在筛选栏固定显示为紧凑中文日期，展开“调整”后可用原生时间控件按本机时区编辑至毫秒，提交时保留该精度并转换为 ISO 时间。
- 启动问候的停止与静音控制位于左侧栏底部，不再以全局悬浮层覆盖业务内容；设置中心可管理启用状态、Ethan/Tina 音色、固定/随机审核文案、试听和设备级保存。经营总管实时语音设置仍在智能体中心，设置中心会只读显示当前工作区的未配置、已保存待检测或最近检测结果；打开页面不会连接供应商、启动语音或播放问候。“连接检测”只会在用户点击时调用实时服务；左侧分类只定位模型与搜索、语音服务、启动问候和账号与工作区的真实区块，底部“保存启动问候”只持久化本机问候偏好。设置中心只保留真实搜索、AI、语音、问候和本机服务入口，不展示旧的本地演示重置操作。
- 真实模式从 Shensi 账号入口开始，同一表单可在登录与注册之间切换，页面不内置账号或密码。每次启动都通过同源 `/api/auth/me` 核验会话，即使当前本地端口没有 `gj_user` 缓存也会核验；只有成功响应才恢复工作区，`401` 或网络失败保持未登录，退出或销毁后迟到响应不能恢复旧身份。任何真实总览请求收到 `401` 都会清除已过期的本地身份并回到登录，不把会话过期显示为可重试的数据读取失败
- 注册账号为 3–32 位：首位是字母或数字，其余只允许字母、数字、下划线或连字号；密码为 8–128 位。注册成功建立独立工作区管理员会话；已启用运营管理时显示“账号已注册，等待运营开通”、企业编号及账号，业务界面保持关闭。运营开通后由用户刷新授权并按提示重新登录。暂停、未配置、尚未生效的企业显示对应状态；到期保留只读提示，实际权限由服务端校验。登录、注册和 `/api/auth/me` 共用生成的 `CustomerAccess` 契约；未纳管旧工作区和演示模式保持原行为，不复制其他租户的凭据、候选人、任务或外联状态。
- 授权状态支持用户主动刷新，并在窗口重新获得焦点时最多每 15 秒核验一次，不运行定时轮询。刷新失败保留当前状态并提示重试；服务端撤销会话返回 `401` 时清除本地身份并提示重新登录，退出或销毁后的迟到响应不能恢复身份。针对性验证：`pnpm --dir frontend exec tsx src/app-session.self-test.ts`。

## 财务文件与智能体资料

真实主操作按当前页面执行：私域“添加客户”打开真实表单，客户详情支持跟进、关联待办与完成；社媒仅准备当前候选人的外联草稿，不审批或发送。其他经营页面的“查看今日待办”等待真实总览加载后定位待办；智能体主操作聚焦已有对话，不新建演示智能体。写入失败保留输入，切页与换账号隔离迟到结果。

设置中心的“语音服务 → 配置”直接进入智能体中心并打开同一个语音设置窗口，只有目标界面就绪后才打开；离开目标或切换账号取消待处理的打开动作。

财务委员会从侧栏进入会读取当前工作区的历史并恢复最近运行，也支持指定运行深链。
六位角色分别显示真实执行、完成、缺资料或失败状态；时间线展示公开结论、引用证据和
一轮交叉复核，不展示内部推理。新建分析仅使用已确认三表和就绪的模型/策略。
八章详细报告包含目录、修订意见、场景建议与公式/版本附录；查看、HTML 下载和桌面 PDF
导出复用当前加载的同一 reportId，不另外取新版本。阶段结果和总管降级状态不会冒充完整
模型成功分析。轮询保留阅读位置与未提交编辑，单项读取失败可重试而不会清空成功结果。

财务经营的“选择文件”或拖拽接受 CSV/XLSX、文字 PDF 和 DOCX，页面立即显示文件名和大小；
默认识别来源，不按费用明细处理。摘要顶部显示“让 AI 读取”和状态，原文默认折叠、可展开。
点击读取后，可在智能体中心按原始行列、PDF 页码/文本项或 Word 段落/表格格来源追问；缺少完整三表不阻止阅读。
扫描件需先 OCR，旧 DOC 需转 DOCX，加密文件需用户解密；不支持格式不能显示为已读取。
成本/财务事实用途仍只接受 CSV/XLSX，明确选择用途后才进行
列映射、入账预览与确认；错误按字段/原因汇总，接受行数为零不可确认。
缺文件、空文件、格式不符或超过 5 MB 使用页面内提示。更换文件或用途撤销旧预览，
离开页面取消请求并清空 File；迟到响应不可改写下一份文件或下一工作区。

桌面代理与后端仅对三个准确的 POST 文件路由放行 Base64 请求预算：原表识别和普通财务导入
7,056,044 字节，三表导入 21,037,060 字节（每文件仍限 5 MiB，另含 64 KiB JSON 元数据）。
其他请求保留默认限制；预览表单不冒泡到旧演示提交处理器，不显示模拟成功提示。

六角色文字问答与 CFO 语音携带同一个明确选择的 `documentId`；原表过期、被替换或服务
重启后明确提示重新读取，不静默切回旧三表。取消当前资料后显式使用已确认报表。
来源区分“只读原表”与“已确认报表”，不把原表阅读冒充正式三表验证；费用台账、
未确认三表预览和聊天内容不会自动成为问答资料。规则见
[`finance-document-reading.md`](../docs/modules/finance-document-reading.md)。

针对性文件选择、拖拽、预览和错误反馈回归：

```bash
pnpm --dir frontend exec playwright test --config=playwright.finance-import.config.ts
```

这套隔离浏览器测试使用合成响应，不替代原生 Electron 与真实后端的上传验收。

## 桌面源码开发

完整桌面开发态从仓库根目录启动：

```bash
pnpm desktop:local
```

该命令复用本地 MySQL 数据，构建当前 Main、Preload 和 Renderer 后打开 Electron；
日常源码修复不需要生成或安装新的 `.app` / DMG。

仅需隔离调试前端模块时可运行：

```bash
pnpm install --frozen-lockfile
pnpm --filter goodjob-crm-frontend dev
```

该命令只启动 `http://127.0.0.1:5188` 的 Vite 页面，不包含桌面 Main/Preload、
本地 Sidecar 或完整客户体验，不能作为桌面验收入口。

## 验证

```bash
pnpm --filter goodjob-crm-frontend run test:types
pnpm --filter goodjob-crm-frontend test
pnpm --filter goodjob-crm-frontend run test:e2e
pnpm --filter goodjob-crm-frontend run test:detail-focus-layout
pnpm --dir frontend test:real-primary-actions
pnpm --filter goodjob-crm-frontend build
```

外壳次级入口隔离回归：`pnpm --dir frontend exec node --import tsx scripts/test-shell-secondary-actions.mts`。
该脚本使用合成 DOM、当前外壳样式和受控启动边界，覆盖本页搜索、快捷键、空按钮移除与状态展示。

`test:detail-focus-layout` 使用已安装的 Chrome 无头实例、真实详情渲染函数和页面样式，
测量单候选全宽与普通列表双栏在四种宽度的实际布局；不启动应用服务器或访问业务 API。
桌面 Renderer 构建后可追加 `--built` 校验 `dist-desktop` 中的实际打包样式。

平台轮播的隔离桌面回归使用受信开发端口 5188 和本地 HTTP 夹具 5391，
不会访问真实业务数据库或执行平台动作：

```bash
pnpm --dir frontend exec playwright test --config=playwright.desktop-progress.config.ts --grep 'platform selector' --reporter=line --output=/tmp/shensi-platform-tests
```

真实获客页面的五张平台卡都可以通过箭头、点击、横向拖动/滚轮与键盘浏览。
未接入平台即使移到中央，也继续显示“当前浏览 · 待接入”，不会改变抖音任务、
进入隐藏的演示任务或获得执行权限。卡片保持原有堆叠过渡和减少动态效果设置。

本地或公网发布切换完成后，用显式目标和临时环境变量运行独立验收；该测试不会启动或回退到任何旧端口：

```bash
SHENSI_TEST_ORIGIN="<pnpm trial:status 返回的 origin 或 http://127.0.0.1:5608>" \
SHENSI_TEST_EMAIL="<测试账号>" \
SHENSI_TEST_PASSWORD="<测试密码>" \
pnpm --filter goodjob-crm-frontend run test:e2e:shensi-cutover
```

演示模块不会直接连接抖音、小红书、快手、微信或微博，也不会代表用户执行营销动作。
真实登录下的 `#conversations` 默认打开私信标签，左侧搜索并选择真实收件人，右侧只显示该收件人的独立私信编辑与确认；公开评论和发送记录在独立标签。三个标签不会先渲染评论与私信组合步骤再隐藏其中一部分：私信只产生私信确认与结果，公开评论只产生评论审批与结果，发送记录只读展示真实历史回执。搜索不会隐式替换收件人，状态轮询保留正文、输入焦点和光标。管理发送账号链接进入获客中心的抖音登录与本机绑定控件。历史审批批次入口只在发送记录标签展示，不占用私信编辑区。预览即时显示所选收件人的精确正文，编辑会撤销确认且不重建输入框。单一真实候选的私信页把发送账号和当日上限收进标题摘要，公开证据默认折叠但始终可展开；预览和单独确认仍在首屏可见，未勾选确认不会排队任何私信。
本地截图和回归若需要固定私信展示态，可在 `localhost` 或 `127.0.0.1` 上访问 `/?captureFixture=conversations#conversations`；该参数只在本地开发/截图路径生效，生产或公网环境会忽略。
社媒对话的私信、公开评论和发送记录三个标签都会清空并隐藏共享右侧 inspector；发送与审批说明只在主工作区的默认折叠帮助中呈现，标签切换不会恢复技术栏。公开评论和发送记录使用紧凑的标签工具条，不重复壳层已有的“社媒对话”页名；候选列表在桌面证据视图固定为约 280–312px，给公开证据和回执留下主要阅读宽度。三个标签共用同一个黑绿候选搜索框，避免在评论或发送记录页退回浏览器默认控件。
页面先读获客总览，复用获客中心的 `candidateRunId` 选择规则：新运行已停止且没有候选时，
继续读取最后保留结果的运行，并校验其所属计划。候选列表沿服务端游标续读；遇重复游标或
达到 100 页上限时明确提示未完整读取。当前范围是总览最近 20 个任务及每任务选定的结果运行，
不是所有历史运行的全局通讯录。再按
`runId + candidateId` 读取候选范围最近 50 个批次，默认载入最新批次；“历史审批批次”
可切回旧动作的回执与只读核对入口。切换时清空旧复核勾选，不创建、审批或重发动作。
回执轮询结果未变化时不重绘审批视图，保留展开详情和用户正在勾选的只读确认。搜索和标签切换读取当前控制器中的本地草稿与额度，不使用上一次通知的旧状态覆盖输入。
刷新后通过 overview、candidate、
collection GET 和 batch GET 重建服务器权威，不依赖 session 选择顺序，也不回退到
本地演示会话。只有精确 `https://www.douyin.com/video/{id}` 证据可创建一个单候选待审批
批次，编辑评论和私信草稿并保存新修订；profile-only 证据不能创建评论批次，但仍可进入候选核对与私域交接。
候选详情底部“关闭”只退出窗口，不提交交接。私域入池核对姓名、公开来源与当前账号负责人后，明确创建/关联客户及首次跟进，无需 AI 研判或人工资格审核。
交接表单在同一弹窗内替换资料视图，不嵌套原生 dialog；使用局部黑绿样式、紧凑单选框、独立字段滚动区和固定取消/确认栏。来源显示名称摘要，不向用户呈现内部 Run/event 标识；这些标识仍由状态携带。编辑和模式切换保留输入。
审批工作台沿用现有黑灰绿界面，从批次公开 DTO 直接显示并复核冻结的
`commentTargetPublicUrl` 视频和只读的 `publicProfileUrl` 候选人主页。这两个公开目标参与
批次哈希；`evidenceText` 和 `publicActorKey` 仍为服务端私有字段，不会显示或
下发给浏览器。页面同时显示发送账号、账号 ID 和登录状态版本；只有当前账号处于
active、具有可核对的真实账号名称时，评论确认要求其 ID 与 `loginStateVersion` 都和批次一致；私信独立确认使用同一账号 ID 的当前登录版本，可晚于旧批次冻结版本。任一目标
缺失或格式错误也会禁用复核框和最终按钮。评论限制为 300 字并显示实时计数；
800 字私信正文可在评论未批准、排队、失败或结果不确定时独立编辑和确认，无需先发表评论。操作者必须逐项选择批次内的精确收件人；账号、收件人、正文或额度变化都会撤销本次确认。
私信每日默认 50 条，可配 1–100 条；它与采集评论数量、公开评论审批额度独立。
获客中心与社媒对话均续读候选分页并按候选 ID 去重，不限于第一页或 5 人。
候选发现不设人数上限；历史 dailyCandidateLimit 仅保留公开评论审批兼容语义，同账号当日已有审批占用会扣减发送剩余额度，不截断采集候选。
“每次采集评论数”默认 100，可配置 1–10000，按评论 ID 去重计数，视频与作者不占数量；保存后从下一次运行生效。实时区分别显示本机评论进度和公开记录数。桌面“暂停采集”保留同一进程/任务和已保存结果，暂停时间不计入采集时长；“继续采集”恢复同一任务，“结束采集并保存”正常收尾入库，不等于取消。结束后不继续，历史运行和已批准动作不改写。
获客证据查看器与社媒三个候选标签提供“核对并交接私域”，携带当前候选、真实计划和候选所属运行进入资料详情。直接候选视图只读取姓名、公开证据、来源运行和交接状态，不读取或展示研判、重试研判、人工资格审核，也不启动相关任务。交接来源从指定运行的 presentation 按游标查找对应发现事件；关闭和切换后的过期响应不会覆盖候选或来源。确认交接使用 v2 直入接口，同候选重复提交返回原客户；成功后可查看真实客户和待办。评论私信审批、其他智能体与财务评估不变。
单候选详情采用全宽单列；普通任务候选视图保留候选列表与详情双栏，窄屏按原断点堆叠。
任何未保存草稿都会重新关闭对应的复核框和确认按钮。批次与动作状态使用
中文说明，稳定错误码仅保留在折叠的技术信息中。
“保存为新修订”只保存人工编辑，不调用 AI 重新生成。合理短句如“方便的话聊聊？”可保存，仍校验非空、字数和安全内容；不合格编辑提示手动文案校验失败并保留草稿，不提示切换模型。保存不授权发送，必须重新核对后确认。
待审批批次创建在请求完成前保持锁定，快速重复点击只提交一次。只有明确的批次陈旧或
ETag 前置条件错误会重新载入最新修订；候选人当日已进入过真实动作等业务冲突会保留
当前批次，并直接显示可执行的中文原因。
候选批次只能从已完成终态入库和当前运行别名投影的采集结果生成；最终审批会再次
复核同一边界。若采集仍在进行、终态入库尚未完成或别名投影被重新打开，页面保留
待审批批次并显示中文等待提示，后端不会创建评论或私信动作。失败、暂停或取消的
采集必须重新运行，且同一公开身份的证据若在最终投影前发生变化，需要从最终候选
重新生成批次。
页面不宣称接入官方 inbox 或 DM API，也没有浏览器直发入口。评论与私信各自拥有唯一的人工发送授权；
评论按钮明确标注为真实评论；私信按钮明确标注为“确认并排队私信”。私信确认不会批准评论、改变批次状态或复用评论授权；新私信动作使用 v3 独立授权且没有前置评论动作，历史 v2 私信继续只读展示。
同一批次修订/候选人永久只能批准一条私信；同一账号当地日内，同一候选人也不能
从另一个批次重复批准。次日的新批次可以重新审批，但不会重新打开旧批次修订。
历史非 v2/v3 私信动作仍可只读显示，不回填新授权字段且不会被 Memory/MySQL 领取器领取。
动作列表第一次为空时仍会继续有界轮询，避免审批刚提交时页面停在
空回执状态；每次重新加载或手动刷新都会切换轮询 epoch，旧请求不能覆盖新状态或启动
第二条轮询链。历史 v2 私信仍按其冻结的评论前置关系只读呈现；v3 私信不受评论结果驱动。
未知或含糊回执一律 fail closed 并进入风险暂停，不会重复提交。页面的协调只做同一冻结动作的无写证据
检查；即使找到唯一成功回执，也不会自动恢复账号或后继私信，后续显式恢复入口仍是
待补能力。含糊的评论回执在动作列表中显示为“结果待确认”，并明确提示评论可能已提交、
不会自动重发；只有持久化平台回执才显示成功。
MediaCrawler 上游提供采集/浏览器基础；评论和私信执行都是 Shensi 扩展，不是官方或上游原生 API。真实动作运行时要求可见浏览器。只有目标页初次导航立即出现的验证页会进入有界人工窗口并复检同一动作；后续出现滑块、CAPTCHA、登录或风控验证会立即安全停止。系统不识别/解题、不注入令牌，也不调用绕过服务。
评论 sidecar 始终以 DOM/ARIA 作为操作控件权威；只有显式设置
`DOUYIN_ACTION_VISUAL_LOCATOR=rapidocr` 时，才可用本地 RapidOCR 建议缺失的评论入口/发送控件，
并必须回绑到精确白名单 DOM。默认值是 `disabled`；视觉 MCP 只用于开发诊断，
模型供应商不参与浏览器控制或审批。
私信由 focused vendored `cv-cat/DouYin_Spider` 传输执行，不依赖 DOM 控件：它要求
冻结的公开 `/user/{sec_uid}` 与 API 解析的收件人完全一致，创建会话后只发送一次已审批
文本，并使用由不可变动作 ID 生成的确定性 UUIDv5 客户端消息 ID。页面只读取脱敏
`douyin-im:<sha256>` 回执；正文、会话/票据 ID、Cookie、安全材料和原始 `sec_uid` 均不
返回。该上游未发现公开 `LICENSE`，复用依据是操作方声明已获作者许可，证据存于 Git 外。

## 抖音自动获客任务

当同源后端提供获客 API 时，`#acquisition` 以真实 MediaCrawler 自动采集为主入口。
登录会话返回的 `interactionSurface` 决定浏览器交互方式。
`LocalDesktopBrowserRuntime` 处理 `external_window`：页面提示用户在已经打开的外部
Chrome 中完成登录，只提供“我已完成登录，重新检测”和“取消登录”，继续轮询同一
session。这个分支不调用 `/live-sessions` 或 interactions，不加载/mount noVNC，也不把
`loginPage`、`qrImageDataUrl` 或 `qrStatus` 当作登录前置条件。
独立的 `#douyin-live-login?sessionId=...` 入口同样先读取 session surface；它只为
`remote_canvas` 动态加载 RFB/noVNC，不能成为 `external_window` 绕回 `/live-sessions` 的旁路。
`RemoteBrowserRuntime` 处理 `remote_canvas` 并保留现有 Web/noVNC 行为。API 同时透传
`runtimeState`、`authState`、`taskState`、`diagnostic`、`screenshotAvailable` 和
`qrAvailable`，界面不再用一个粗粒度状态猜测窗口、认证和任务生命周期。旧服务未返回
新增字段时只按 `remote_canvas` 兼容处理。Electron 壳已在 `desktop/` 实现；源码修改不会
自动更新已安装应用，自动化测试不能替代真实 macOS 登录与同 Profile 采集验收。

桌面认证工作区通过同源 API 申请 60 秒 enrollment，再由 Main 兑换并加密保存设备凭据。
Renderer 只获得注册结果，不获得 device token。登录同步成功后先读取准确绑定版本，
再提交账号绑定；仅中央成功响应写入 Main。账号卡复用原配色和布局，显示本机执行状态、
重新绑定和需要单独确认的设备交接；存在未解决动作时不允许交接。状态事件只更新账号卡
状态区域，整页刷新使用稳定节点更新，不重新聚焦候选人或自动滚动。
退出业务账号清空 Main 工作区；Renderer 重载/视图卸载只退订，不中断 Main 执行。
离线超过 90 秒导致绑定租约失效时，需要在有效登录下重新绑定本机账号后再只读核对，
不会自动重发。动作状态使用持久化 `executionTarget` 区分桌面与旧服务端；两种审批仍独立。

登录达到 Sidecar 的权威 `active` 状态后，桌面 runtime 只同步公开账号标识、
显示名称和登录版本。桌面立即运行由 `LocalDesktopBrowserRuntime` 串联云端 prepare、
本地 start、精确 claim/lease、幂等分页上传和云端 complete。任务能力只留在这个
generation-fenced 内存协调器中；不进入 URL、Web Storage 或日志。只有云端候选人
投影耐久成功后才调用本地 `acknowledgeDouyinCollection`，中途取消或身份漂移会关闭两端任务。

在 `remote_canvas` 模式下，连接会话创建后，登录弹窗会持续读取服务端的 `qrStatus`。仅当状态为 `ready` 且
`qrImageDataUrl` 存在时，弹窗直接显示可扫描二维码；`expired`、`network_error` 或
`verification_required` 会清除旧二维码并显示对应操作。内嵌 noVNC/RFB 作为交互操作面，
它调用
`POST /api/v1/acquisition/social-accounts/douyin/login-sessions/{sessionId}/live`
获得短期一次性连接，再由 noVNC 连接同源
`/douyin-live/{token}` WebSocket，直接点击、输入、扫码或刷新二维码。
当 live context 尚未就绪时，该接口公开返回可重试 HTTP `409`
`douyin_login_session_not_ready`，内嵌客户端会等待并为同一会话重新申请一次性 token，
不会新建 profile。连接动作使用 single-flight；创建请求进行中或当前未失败会话仍为
`qrStatus: opening` 时，创建新会话按钮保持禁用。`409` 只为同一 session 安排一个受控
重试，手动重连不能绕过该节奏。组件卸载会中止请求、清除重试计时器、断开 RFB，并推进
客户端 generation，避免迟到回调重新连接。显式关闭按“断开 RFB，再请求删除服务端登录
会话”的顺序执行；登出、模式切换和 `pagehide` 也会同步清空前端登录状态并发起一次非阻塞
best-effort 删除，防止隐藏页面继续持有 live WebSocket。删除送达并成功时，刷新后会创建新会话；
当删除未送达或双标签页、重试请求并发产生不同幂等键时，后端通过工作区级 opening lease/fence 复用同一个
仍有效的待登录会话，不会创建第二个上游 Bootstrap；该复用不会跨工作区。这个窗口控制的是同一个 sidecar persistent profile，采集、
评论和私信后续都复用该 profile。原获客页面在扫码后仍持续轮询同一登录会话，
直到服务端返回 `active` 才绑定工作区账号。登录会话状态读取和交互使用 70 秒网关运输
预算，其中前端交互请求以 75 秒为上限；其他 MediaCrawler 请求不因此扩大超时。VNC TCP 只侦听 sidecar
loopback，不向宿主机、局域网或公网发布；Cookie、浏览器安全材料、X11 与 CDP
也不离开 sidecar。

允许的官方抖音页面到达后，服务端先注册 display/context、worker VNC handle 和 context
generation，使 noVNC 可连接；截图、DOM、二维码和登录面板识别随后以 best-effort 方式
准备。因此 `loginPage: null` 或 `qrStatus: opening` 可能只表示备用画面尚不可用，不能据此
判断会话已关闭。只有浏览器、display/VNC 或非允许页面等致命错误才会结束会话。

新标签页 `#douyin-live-login?sessionId=...` 和原登录弹窗中的固定尺寸 JPEG
及点击/文字/按键/滚动指令都仅作备用控制面，并且始终指向同一 login session/profile。
“刷新二维码”发送语义化 `refresh_qr` 指令，只对当前页面执行一次受限
刷新。普通登录页执行 `reload → 打开登录面板 → 激活二维码 → 探测二维码`；若页面
明确显示二维码失效，则只查找唯一可见的“点击刷新”、点击一次并在同一预算内等待新
二维码，不使用猜测坐标。“重新连接画面”只重新签发
当前会话的 live token；“创建新登录会话”才会替换 profile。登录或
平台验证由人工完成，系统不绕过。指针按下与松开由稳定的工作区容器配对，即使轮询期间
登录截图更新也只提交一次点击；拖动不会提交点击。一次指针或滚轮操作等待新画面期间，
后续指针和滚轮操作不会排队，键盘文字仍按顺序送入同一登录会话。会话到达过期时间或
服务端返回 HTTP 410 时，旧画面会立即清除并进入“登录已过期”，不会继续显示可操作状态。
内嵌窗口的“重新连接画面”只为当前 session/profile 重新签发 live token。只有登录会话已
过期、进入终态失败，或用户明确选择重新打开登录页时，账号级刷新才会关闭未完成会话并
创建一个替代会话。随后创建并批准仅限抖音的计划，编辑手工关键词、本地
日程、时区和每日候选上限后启动一次受控运行。手工关键词不需要公开搜索 API 或 AI
连接；AI 关键词建议、通用公开搜索和手动公开链接都是独立的可选增强。

运行详情只读取服务端持久化的爬虫状态、候选和公开证据。每次刷新先验证状态，再请求
候选页；采集中已投影的候选可以在终态就绪前出现，`ready` 状态是最终候选读取的顺序
边界，`ready` 或 `failed` 配对的候选读取完成后停止轮询。终态 `ready` 且零候选仍是有效
结果，候选读取失败不会清除已经验证的终态。状态、阶段、浏览器模式和候选投影状态
只接受闭合枚举中的原始字符串，数组、数字或对象会被拒绝。首个状态到达前的排队提示
按运行 ID 只礼貌播报一次；同一运行重绘保持静默，状态到达、意图清除或新运行会重置。
候选页只接受精确的 `items/nextCursor` 字段，候选和证据对象也必须只有合同声明字段；候选必填字段为 `id/status/displayName/evidence`，可省略的 `avatarUrl/coverUrl` 仅是公开 HTTPS 图像显示提示，缺失或加载失败时使用通用图标，绝不改变候选、发送账号、审批或动作权限；
每页最多 100 项，候选 ID/状态不能为空，名称、摘要和非空游标分别执行 200、500 和
8,192 个 Unicode 码点上限。证据地址必须原样包含 HTTP(S) authority 和主机名，不允许
用户名/密码、反斜杠、空白/控制/格式字符、错误百分号转义或依赖 URL 解析器修复的
authority。任一成员不合法都会拒绝整页，不会渲染部分候选。
公开评论主体仍需经过既有核验和人工审核流程，访问受限或无可用公开样本不表示“没有
客户”。

只有当前计划版本仍是已批准版本、最新运行绑定该版本、公开评论样本已启用，
且运行处于排队或运行中的抖音任务，才可在详情中主动创建 120 秒的授权视觉读取
会话。网页只通过短时、同页面的结构化通道接收当前抖音
标签页中已显示的一级评论，并由网页使用现有同源登录态和 CSRF 保护写入
`POST /api/v1/acquisition/visual-reader-sessions` 及其会话子路由。网页不接受
浏览器读取器直接声明的“完成”作为业务事实，观察必须先由服务端持久化。
已保存的遮挡制品只通过
`GET /api/v1/acquisition/visual-reader-artifacts/:artifactId` 按当前登录范围读取。

制品上传默认开启，仅允许上传已遮挡的单张评论卡 WebP；关闭后仅提交
DOM 或可访问性文字观察，浏览器读取器不应进入 OCR。该通道不读取或上传
Cookie 或浏览器配置，也不上传完整页面截图，不执行私信、点赞、评论、关注或验证码处理。
制品开启且正文缺失或截断时，原始视口截图仅在扩展内存中短暂存在，用于本地裁剪、
遮挡和 OCR；离开扩展前只有遮挡后的评论卡 WebP。声明了头像范围的裁剪必须由一个或
多个遮挡矩形的几何并集完全覆盖头像，否则网页在调用服务端前拒绝该观察。

### 安装未打包的只读扩展

```bash
pnpm --filter goodjob-crm-frontend run test:visual-reader
pnpm --filter goodjob-crm-frontend run build:visual-reader
pnpm --filter goodjob-crm-frontend run verify:visual-reader-build-order
```

在 Chrome 的扩展程序页面开启开发者模式，选择“加载已解压的扩展程序”，目录为
`dist-visual-reader/douyin-visual-reader`。该目录与主站 `dist` 分离，运行主站构建不会
删除扩展制品；`pnpm run check:visual-reader-bundle` 只审计已有制品，不会重写 manifest。
开发构建只允许连接
`http://127.0.0.1:5191/*`；发布构建必须显式设置以逗号分隔的 HTTPS
`GOODJOB_APP_ORIGINS`，并设置 `VISUAL_READER_RELEASE=1`，否则构建会失败。
开发环境即使提供 `GOODJOB_APP_ORIGINS` 也只接受这一精确 local origin；空值回退到它，
任何其他 origin、路径或多 origin 都会被拒绝。
审计会将完整 manifest 与当前模板和构建 origin 深度比对，包含 CSP、可选权限、内容脚本
的 matches/js/run_at/world/all_frames，以及 background、action 和 web-accessible resources；
任何额外、缺失或篡改字段都会被拒绝，检查命令不会修复制品。

使用时先在 GoodJob 运行详情中创建短时授权会话，再打开扩展弹窗，明确选择一个
`https://www.douyin.com/video/<id>` 标签页并点击“开始只读读取”。关闭弹窗不会停止；
点击“停止”、离开已绑定的可见抖音标签页，或用户在抖音页面滚动、点击、按键时会
安全停止。已绑定标签页即使以相同 canonical URL 重载、Chrome 在 loading 时未提供 URL、
或该 tab 被替换，也会立即安全停止；其他窗口的标签页活动不会误停。扩展后台进程若在
读取中重启，会清除残留授权并通知仍存活的网页和抖音内容脚本以
`partial_success + visual_reader_session_expired` 失败关闭，不会静默续读或把它记为用户
接管，也不会把原始 nonce 写入存储。service worker 到 content 的批次 ACK 是 closed message，
携带当前会话仅存在内存中的 nonce；content 只有在 session、nonce、owner object 与 lifecycle
generation 全部匹配时才清除 pending batch，旧 lifecycle 的迟到 ACK 不能作用于同 session replacement。
当前扩展只读取
页面已显示的
一级评论文字、公开时间、公开计数和卡内公开主页链接，最多程序滚动 5 次；不读取
Cookie、脚本数据、头像地址、二级回复正文或页面内部状态，不执行任何写入或互动。
总会话时限中的最后一小段（时限的 20%，最多 1 秒、至少 1ms）专供终态投递；DOM 读取、
批次、ACK 和滚动会在较早的 work deadline 停止。预算用尽时会在该 deadline 触发点
幂等排队 terminal。合法 start 到达时若 work window 已为空或到期，会在创建 DOM adapter、
解析页面 source、创建 reader 或安装接管监听器之前同步进入终态投递；首次 deadline 判断和
发送发起使用同一同步决策。因此总时限仅 1ms 时仍会在初始化前发起一次，若排队时总时限
已经到达则不会发起；重试和 timeout 都不会越过总时限。

完整 DOM/ARIA 正文不运行 OCR。只有服务端授权的 `artifactUploadEnabled=true`
会话中，已绑定且当前可见的抖音标签页出现正文缺失或截断时，后台才会在
OCR 预算内调用 `captureVisibleTab`。截图前、截图后、offscreen 返回后以及异步 WebP
逐像素验证完成、放行 content 前都会用不可变的
session/tab/window/generation owner 重新授权；停止或接管在首个 await 前就会撤销 active
coordinator 并使 runtime generation 失效，同时抢占等待队列、清理 offscreen
正在处理的 raw 资源，并拒绝已结束 generation 的迟到消息；新 generation 使用独立队列，
不会被旧 generation 挂起的 OCR 阻塞。旧 coordinator 的 abort/finish 持久化和 offscreen end
则通过 transition barrier 完全沉降后，新 start 才会安装和持久化新 coordinator，避免旧终态
覆盖新会话；每个 start 还绑定入口处的 transition revision，后到的停止、接管或 start 会同步
撤销尚在排队或授权持久化中的旧 start。coordinator 自身的授权、标签确认、用量和终态 mutation
也共享 FIFO，replacement 会等旧队列完全持久化后再安装。popup 标签确认绑定不可变 coordinator、
generation、revision、session 与制品开关的一次性 30 秒内存 token，在每个浏览器 await 及
确认/发送边界复核；replacement、停止、接管或新 popup snapshot 会立即使旧 token 失效，
不能把旧界面选择绑定到新会话。
每次 service worker 启动生成新的本地 epoch，启动
恢复会先关闭遗留 offscreen document，后续 sync/end/process 同时绑定 epoch 和 generation。
原始 PNG 在截图后只存于可同步擦除的 service-worker holder；offscreen message 同步克隆后
立即清除字段引用，crop/redaction 后即清理。encoder scratch 也注册在该 generation 的
可抢占清理域内，不写入 storage、IndexedDB、日志或错误载荷。
offscreen pipeline 将评论卡夹到视口，以 crop pixel 坐标遮挡头像和文字/公开元数据
矩形外的每个像素；固定遮挡色为 `[17,61,51,255]`，允许面积不超过 80%。
遮挡后 WebP 使用 lossless candidate，并在本地解码后逐字节对比；任何色偏或超过
256 KiB 都直接拒绝。每个批次最多 5 张 crop。
service worker 在放行前还会按授权 request 重新推导 crop 尺寸与 proof geometry，真实解码
WebP，并逐像素验证 alpha、头像及允许区域外的固定遮挡色；只信任 payload 自述字段不足以通过。

OCR 固定使用扩展内的 `tesseract.js 7.0.0`、`tesseract.js-core 7.0.0` 和
`chi_sim+eng` 语言资产，不使用 CDN、远程脚本、持久缓存或动态代码。语言包
只在构建期从 pinned `best_int` gzip 解压；扩展运行时只读本地未压缩
`.traineddata`，不包含 Node `Buffer` 兼容分支。每会话
惰性创建一个 worker，初始化和单次识别各有 20 秒上限，空闲 30 秒或会话结束时立即
terminate；晚到的 worker 也会立即销毁。Tesseract 输出只读取
`blocks[].paragraphs[].lines[].words[]`，不会把块、段、行或 symbol 重复拼入正文；同一行按
垂直重叠分组后按 x 坐标重建，offscreen 与异步 evidence validator 共用该规则。OCR 输入会从正文区域逐像素减去时间与点赞/
回复等公开元数据区域，即使两者几何重叠也不例外；任何与 metadata 相交的 OCR word 都会
在 offscreen 重建和 service-worker 异步 evidence 验证两处被拒绝。识别结果不能生成
评论 ID、主页地址或 secUid；低召回、低置信或 DOM/OCR 冲突仅作人工复核证据，
截断 DOM 在 OCR 空、失败或无效时仍以低置信观察保留，不拼接补全文字或金额。
capture 消息 transport 拒绝也走相同的低置信截断 DOM 保留路径；原正文缺失时仍返回 null。
每条提交和服务端归一化观察都分别保留 required-nullable `domTextHash` / `ocrTextHash`；
它们是来源证明，不替代服务端独立生成的 `textHash`。扩展 CSP 精确为
`script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`；`ocr-assets.json` 记录所有本地
worker/core/WASM/语言文件的版本、字节数和 SHA-256。当前未压缩扩展约 29 MiB，
构建强制小于 80 MiB。

当前实现只经过合成 fixture、本地 OCR 和扩展构建审计，不代表已在真实抖音页面完成
兼容性验证或已发布到 Chrome 应用商店。

候选公开证据链只在 provenance 为 `authorized_visual_observation` 且包含非空
`artifactId` 时显示“查看遮挡裁剪”。网页使用同源制品 API 读取并验证
`image/webp` Content-Type、RIFF/WEBP 签名、声明长度和浏览器可解码性；全部通过后才创建
临时 object URL。图片关闭、候选替换、详情关闭或页面销毁时会释放该 URL，异步解码完成后
还会重新核对当前 Evidence 授权。错误 MIME、伪造字节或无权读取均不显示图片。
制品过期后仍保留 Evidence ID 和证据哈希，并显示“制品已到期，证据哈希仍保留”；
过期不等于撤销已经持久化的文字证据。

确定性验收只使用本地 Vite、API fixture 和页面消息 harness，不安装真实扩展、不打开
抖音、不访问外网。fixture 会阻断所有非本地 Vite origin，并审计请求、日志和浏览器存储，禁止原始截图、Cookie、
浏览器配置、私信/评论/点赞/关注/发布以及自动 CRM 转换：

```bash
pnpm --filter goodjob-crm-frontend run test:e2e -- acquisition-visual-reader.spec.ts
```

### 卸载与手工 Beta smoke

停止正在进行的会话后，可在 Chrome 扩展程序页面移除“GoodJob 抖音可见评论读取器”，
并删除本地 `dist-visual-reader/douyin-visual-reader` 构建目录。卸载不会删除服务端 Evidence；
遮挡制品按服务端保留期到期，证据哈希继续保留。若扩展已被直接移除，GoodJob 页面会在
探测超时后显示未连接，不能创建新的读取会话。

真实 Chrome smoke 不属于自动测试或 CI。只有人工操作者已确认使用自己的公开测试视频、
设置 `GOODJOB_VISUAL_READER_SMOKE=1`、在扩展弹窗中亲自选择该视频并点击开始时才允许执行；
没有开关时必须停止。smoke 输出只能包含会话状态、有界数量、提取方法和稳定错误码，
不得输出评论正文、昵称、主页标识、Cookie、截图、nonce 或其他个人字段。它仍只是
`authorized_visible_top_level_sample` Beta 兼容性检查，不是抖音官方连接器或全量评论能力。

## Growth 真实模式（Real Mode）

前端钉住了 Growth 合同消费快照（`contracts/pinned/`，当前 1.0.29）；可编辑合同的唯一来源是 Monorepo 根目录 `../contracts/`，合同门禁会验证两者身份与哈希一致。
`src/growth/` 提供由同一黑色前端壳承载的真实业务界面：

- `#growth/advisor` 增长顾问今日视图与受控建议；没有可核对的客户、报价或财务资料时，仍保留紧凑的依据、摘要和真实导航，但不补造经营指标、建议或历史记录。刷新只在用户点击后读取今日视图
- `#agents` 是六位经营顾问的唯一首页；旧 `#growth/agents` 与其角色子路径统一规范化到 `#agents`
- `#growth/catalog` 客户目录（复用真实 CRM 数据和行为）；客户与线索页签提供文本、等级、阶段、负责人筛选及 20/50/100 条分页，并在筛选区显示当前真实客户数。目录列表按客户等级、阶段、负责人、首次或下次跟进、预期金额和操作展示；私域客户池则独立显示来源、最近跟进和下一步。产品与定价页签读取真实产品 / 套餐 / 定价策略；具备管理权限时可新增产品或服务与基础定价草稿，明确激活草稿或停用已启用套餐版本。表单失败保留输入，相同内容的未确认写入重试沿用原请求和幂等键，金额精确转换，不创建模拟资料
- `#growth/quotes` 报价工作台；列表按案例的进行中、已关闭、已取消筛选并计数，与版本审批状态分开。获客商机沿用可信交接评估，普通 CRM 商机先冻结负责人填写的需求、预算、决策人、成交概率和依据，再选择已激活产品与定价策略，完成预览、草稿、提交和人工审批
- `#growth/finance` 成本、财务事实与 CSV/XLSX 预览导入；该页使用更克制的标题区，不显示“查看今日待办”按钮。其余 Growth 路由保留主操作并写入对应路由文案；搜索由具备搜索功能的页面在本页提供。
- `#growth/roi` 预计、已关账实际与现金回收三种 ROI 口径；同一时间只显示当前选中的真实数据面板。三种口径使用关联的 ARIA 标签页，左右方向键以及 Home、End 会同步移动焦点和结果面板。每次挂载独立持有查询，新筛选取消旧请求，相同在途查询不重复发起，失败保留筛选并可重试；现金指标读取契约的 `valueBps`。未选择或尚无批次时仅展示真实查询所需的获客成本、关联商机和已核对回款依据，并可定位到数据说明，不补造 cohort、图表或经营数字
- `#financial-council` 财务委员会入口；准备资料、专项分析、汇总审阅、确认建议共用紧凑四步工作台，真实运行必须先从 `#agents` 完成三表 package 流程
- `#financial-council/run/<runId>` 财务委员会工作台。它和 `#agents` 共用同一 `.replica-shell`，不会切换到旧白色 Growth 页面。

`1.0.29` 类型覆盖 CSV/XLSX/PDF/DOCX 原始来源识别、取消阅读选择、六角色 question/history/role/documentId 问答、普通 CRM 人工报价评估、抖音与搜索归因、三表 package、现金预测、六角色模型路由及财务导入 JSON。workspace、连接归属与 capabilities 由服务端认证上下文决定；前端不能提交凭据、prompt、服务端声明权威或标准化业务数据。

真实 `#agents` 的经营总管文字编辑区独立挂载，报表刷新不重建输入框。桌面右侧保持紧凑的本次对话与财务委员会准备摘要；用户明确点击“准备财务分析”后，三表导入、模型路由和委员会启动控制会在全宽对话框中出现，不会把窄栏压成竖排卡片。只有用户明确触发受支持的操作才会请求真实服务。

财务委员会的三条报表准备链接及补资料操作均进入 `#agents`，不进入费用/财务事实台账。准备对话框的角色 `ready` 显示为“等待运行”，仅表示尚无运行，不代替独立的已确认资料与模型就绪检查；已有分析中、已完成及失败状态保持真实投影。
普通 Hash 链接、浏览器前进/后退和侧栏切页共用主路由的页面归属判断：离开 Growth 后返回同一智能体模块也会恢复标题、当前导航、页面类和右侧准备区域；不会只改变 URL 或保留委员会的壳。定点主入口回归使用 `pnpm --dir frontend exec playwright test --config playwright.agent-navigation.config.ts`，在受信开发端口 5188 启动桌面模式和隔离 HTTP 夹具 4388，不使用原生窗口或数据库。
六位真实经营顾问以同一聊天区上方的紧凑角色条直接切换；切换会终止旧角色请求、清空当前显示并保留未发送问题，不删除已保存的经营总管文字会话；只有经营总管角色显示连续语音入口。
经营总管左侧历史列表读取当前账号/工作区最近50个加密文字会话；可恢复完成问答、新建对话，切换保留未发送输入。CFO session接口以实际NDJSON事件展示资料/技能/模型/保存阶段；断线不自动重发，资料不匹配时不自动切换。其他五角色和语音协议保持不变，语音转写不由文字历史功能持久化。
首次打开或切换到尚无真实消息的角色时，智能体中心保留完整对话工作区和底部输入区，只显示真实空对话起点；不预置演示聊天记录，也不会自动调用模型、连续语音或获客/CRM 动作。
明确要求软件执行抖音获客的文字或语音转写不会进入只读财务问答；界面会保留原始指令并由用户点击进入现有获客计划草稿，人工核对后才可批准运行。
「和经营总管聊聊 → 语音服务设置」提供北京百炼 Key 与可选业务空间 ID 的本机加密配置；公共入口不使用空间 ID 拼接地址。
保存前按字段校验；保存失败保留遮罩输入，成功或关闭窗口才清空 Key。
连续语音入口仅在已保存配置通过连接检测后启用；点击开始才请求麦克风，
以 AudioWorklet 采集 PCM、Web Audio 播放流式响应，不用文字 streaming 冒充实时音频。
聊天正文 15px、角色标签 11px，短句气泡按内容收缩，多轮历史在聊天区内滚动；不修改全局缩放。
无工具调用的语音轮次由 Main 根据真实转写处理：独立问候简短回应，业务问题和上下文追问仍调用既有经营总管。
隔离 UI/静音 PCM 验证命令为 `pnpm exec playwright test --config=playwright.cfo-voice.config.ts`；
该测试不使用真实 Key 或物理麦克风，不替代真实服务和听感验收。
启动问候在 Logo 完全退出后播放本机私有 WAV 缓存。设置中心可启用或关闭问候、
选择 Ethan 男声或 Tina 女声、切换固定/随机审核文案、试听未保存设置并显式保存。
试听不会暗中保存；保存失败不会改变当前生效偏好；离开页面会停止仍在播放的试听。
默认 Tina 固定文案可从应用内置的已验证音频初始化缓存，无需先填写 Key；其他
音色或文案需已有有效百炼配置才能首次生成，生成后复用本机缓存。该能力从不打开
麦克风；详见
`../docs/modules/cfo-conversation.md`。

进入真实模式前，前端会调用 `GET /api/v1/growth/bootstrap` 做合同门禁：
合同大版本或哈希与钉住 manifest 不一致时显示
`contract_mismatch` 不可用状态；未选择具体工作区时显示
`workspace_selection_required`。所有页面能力（feature）与敏感字段
（`pricing.sensitive.read` 等 capability）均由服务端 bootstrap 投影决定，
演示模式不会发起任何 Growth API 请求。

Growth API 与主应用共用同源 Cookie 登录态和 `gj_csrf` CSRF Cookie。
bootstrap 返回 `ready` 后，前端把该响应中的具体 `workspaceId` 固定到当前
Growth 运行时，并在目录、报价、财务、ROI、顾问、智能体中心和财务委员会的
后续请求中统一发送 `X-Workspace-Id`。侧栏直接进入报价工作台时先读取可选报价案例；
没有案例、成本预估或 ROI cohort 时展示可操作的空状态，不把缺少业务数据显示成
接口错误。
未登录时可保留 `#growth/...` 或 `#financial-council/...` 目标路由；用户登录或恢复有效会话后，前端会
自动重新执行 bootstrap，不会跳回 `#acquisition`。Growth 工作区显示时会
继续使用唯一黑色壳；`#growthWorkspace` 永久隐藏且不承载可见产品页面。

`body[data-session-mode="demo"]` 只挂载明确标记的本地演示 controller；
`body[data-session-mode="real"]` 只挂载真实 agent-center API/controller。登录、退出或会话
authority 变化会销毁旧 controller、终止未完成请求并清空主内容/检查器，然后只挂载一个
匹配新 authority 的实例。真实模式不读取示例报告、本地演示会话或浏览器端旧报表权威。

真实三表流程固定为资产负债表、利润表和现金流量表：`0/3 → 服务端预览 → 填写未来 30 天流入/流出与 31–90 天流入/流出 → 明确填写应收账款列表（可为空）→ 管理层预测声明与第三方模型数据传输授权 → commit 形成 verified package → 创建 Council run`。浏览器状态只保留
文件名、大小、时间与哈希等元数据；原始内容仅在发起预览请求所需的短生命周期内存在，
不会写入页面、URL、localStorage 或 sessionStorage。服务端未返回或无法计算的字段显示
“暂不可计算”，不能用 `0` 或演示数据补齐。

六角色卡片和模型路由都消费服务端投影。普通用户只能查看选中模型；拥有
`finance.council.policy.manage` 的管理员可在同一智能体中心固定主模型和备用模型，保存时
使用当前 ETag 与稳定幂等键。财务数据传输授权在文件、预览或工作区变化后重置。

委员会工作台展示专家审计、反驳/少数意见、CFO 诊断、三套服务端组合、重新优化和审批。
过期、不可行、无权限、不完整或不可计算的运行不能审批。审批只创建内部草稿与待办，
不付款、不报税、不记账、不发送外部消息；税务结论必须由具备资质的专业人士复核。

## 验证（Growth 门禁）

```bash
pnpm --filter goodjob-crm-frontend run contract:check
pnpm --filter goodjob-crm-frontend run test:types
pnpm --filter goodjob-crm-frontend test
pnpm --filter goodjob-crm-frontend run test:e2e
pnpm --filter ./frontend exec playwright test \
  agent-center-shell.spec.ts financial-council-agent-center.spec.ts \
  growth-financial-council.spec.ts demo-auth.spec.ts --project=chromium
pnpm --filter goodjob-crm-frontend build
git diff --check
```

财务委员会的真实纵向验收使用独立 Playwright 配置，会启动 `127.0.0.1:4288`
的 test-only 后端和 `127.0.0.1:5388` 的 Vite 前端。浏览器只访问 Vite 同源 API
代理，测试不拦截或伪造网络响应。`5388` 只在该自动化测试的短生命周期内使用，
不得作为人工体验入口、客户链接或发布证据。运行前需要提供可用的 MySQL 测试管理连接：

```bash
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" \
pnpm --filter goodjob-crm-frontend run test:e2e:financial-council:real
```

可通过 `FINANCIAL_COUNCIL_E2E_USER`、`FINANCIAL_COUNCIL_E2E_PASSWORD` 和
`FINANCIAL_COUNCIL_E2E_DATA_AS_OF` 覆盖 test-only server 的默认账号与数据截止时间。
未提供 `MYSQL_TEST_ADMIN_URL` 时，不能将真实 MySQL/browser 验收记为通过。随机库迁移/竞态和跨 runtime 恢复已真实通过；`1.0.12` forecast-backed 链路也已在两个独立随机 MySQL 数据库中连续通过无 route-intercept Chromium，覆盖五专家、恰好一次反驳、三组合、revision 2、balanced 审批、成功回执与 reload identity。三表 parser 对 consent-only 调用仍如实标记 30/90 天 forecast `not_computable`，不能用历史数据补齐。真实双供应商门禁因凭据缺失保持 BLOCKED。

## 专项问答与语音显示

智能体中心问答面板“本次咨询”可选六个真实角色，使用相同闭合 API
并提交所选 role；角色切换会取消未完成请求、清空会话并保留未发送问题。
所有角色支持文字，只有经营总管显示实时语音入口。用户在右侧显示账号
首字母，智能体在左侧复用角色头像；正文 15px、标签 11px。
实际语音转写增量更新同一气泡，打断文字保留标记但不写入完整历史，
不模拟逐字动画，不更改整个页面缩放。

隔离浏览器验收：`pnpm exec playwright test -c playwright.cfo-voice.config.ts`。
包括六角色请求/头像、设置失败保留输入、390px、真实无声 Web Audio、
同 DOM 增量更新和打断。当前运行应用状态以 `../docs/PROJECT_STATUS.md` 为准。

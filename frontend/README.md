# Shensi Sales 前端

本目录是 Shensi Sales Monorepo 的前端 workspace，包含黑色智能体业务壳、真实 Growth/财务委员会界面、演示模式、浏览器扩展和 Playwright 验收。后端位于仓库根目录的 `backend/`。

## 当前范围

- 唯一产品前端为黑色智能体业务壳；`#agents` 的六张智能体卡牌是智能体首页，`#dashboard` 是可用的自动营销总览
- 原有九个主导航入口继续可见；获客、社媒对话、私域客户池、成交工作台、自动工作流与财务委员会深链继续由同一黑色壳承载；`#demoModuleMain` 是唯一可见主内容宿主
- 侧栏提供 `#growth/advisor`、`#growth/catalog`、`#growth/quotes`、`#growth/finance`、`#growth/roi` 和 `#financial-council` 六个真实 Growth 入口；`/`、空 Hash 和未知 Hash 自动回到 `#agents`，旧白色 CRM 不再提供入口
- 本地演示和待接入模块明确标记为“预览 · 待接入”，并只使用本地确定性数据；真实登录下的 `#conversations` 是例外：它是公开证据受控外联工作台，与 `#acquisition` 共用服务器批次/修订/审批/回执权威，且明确不是抖音官方 inbox
- 真实模式从 Shensi 企业登录开始，页面不内置账号或密码，且只恢复经服务端 `/api/auth/me` 验证的会话
- 本次壳迁移未删除或改动后端、数据库、合同、权限边界或既有业务数据

## 本地运行

```bash
pnpm install --frozen-lockfile
pnpm --filter goodjob-crm-frontend dev
```

从 Monorepo 根目录运行上述命令后，访问 `http://127.0.0.1:5188/#agents`。页面首先显示 Shensi 登录；真实部署使用管理员分配的企业账号。访问 `#dashboard` 可查看本地演示数据的自动营销总览。

## 验证

```bash
pnpm --filter goodjob-crm-frontend run test:types
pnpm --filter goodjob-crm-frontend test
pnpm --filter goodjob-crm-frontend run test:e2e
pnpm --filter goodjob-crm-frontend build
```

演示模块不会直接连接抖音、小红书、快手、微信或微博，也不会代表用户执行营销动作。
真实登录下的 `#conversations` 先读获客总览和最新运行候选，再按
`runId + candidateId` 读取候选范围的最新批次；刷新后通过 overview、candidate、
collection GET 和 batch GET 重建服务器权威，不依赖 session 选择顺序，也不回退到
本地演示会话。只有精确 `https://www.douyin.com/video/{id}` 证据可创建一个单候选待审批
批次，编辑评论/私信并保存新修订；profile-only 证据仅可阅读，创建按钮禁用。
页面不宣称接入官方 inbox 或 DM API，也没有浏览器直发入口。最终审批是唯一发送授权；
只在后端与 sidecar 动作开关均启用时，才会排队评论与前置阻塞的私信。
MediaCrawler 上游提供采集/浏览器基础；评论与私信执行是 Shensi 扩展。可见浏览器中的
滑块、CAPTCHA、登录或风控验证只允许用户手动完成；系统仅有界等待并复检同一动作，
不识别/解题、不注入令牌，也不调用绕过服务。

## 抖音自动获客任务

当同源后端提供获客 API 时，`#acquisition` 以真实 MediaCrawler 自动采集为主入口：
操作者通过二维码连接工作区账号，创建并批准仅限抖音的计划，编辑手工关键词、本地
日程、时区和每日候选上限后启动一次受控运行。手工关键词不需要公开搜索 API 或 AI
连接；AI 关键词建议、通用公开搜索和手动公开链接都是独立的可选增强。

运行详情只读取服务端持久化的爬虫状态、候选和公开证据。每次刷新先验证状态，再请求
候选页；采集中已投影的候选可以在终态就绪前出现，`ready` 状态是最终候选读取的顺序
边界，`ready` 或 `failed` 配对的候选读取完成后停止轮询。终态 `ready` 且零候选仍是有效
结果，候选读取失败不会清除已经验证的终态。状态、阶段、浏览器模式和候选投影状态
只接受闭合枚举中的原始字符串，数组、数字或对象会被拒绝。首个状态到达前的排队提示
按运行 ID 只礼貌播报一次；同一运行重绘保持静默，状态到达、意图清除或新运行会重置。
候选页只接受精确的 `items/nextCursor` 字段，候选和证据对象也必须只有合同声明字段；
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

前端钉住了 Growth 合同消费快照（`contracts/pinned/`，当前 1.0.12）；可编辑合同的唯一来源是 Monorepo 根目录 `../contracts/`，合同门禁会验证两者身份与哈希一致。
`src/growth/` 提供由同一黑色前端壳承载的真实业务界面：

- `#growth/advisor` 增长参谋今日视图与受控建议
- `#agents` 是六位经营顾问的唯一首页；旧 `#growth/agents` 与其角色子路径统一规范化到 `#agents`
- `#growth/catalog` 产品目录 / 套餐 / 定价策略
- `#growth/quotes` 报价工作台
- `#growth/finance` 成本、财务事实与 Excel 导入
- `#growth/roi` 预计与已关账实际 ROI
- `#financial-council` 财务委员会入口；真实运行必须先从 `#agents` 完成三表 package 流程
- `#financial-council/run/<runId>` 财务委员会工作台。它和 `#agents` 共用同一 `.replica-shell`，不会切换到旧白色 Growth 页面。

`1.0.12` 类型还覆盖闭合的三表 package preview/commit、管理层现金预测、run-from-package、六角色模型路由与脱敏 agent-center API。workspace、连接归属与 capabilities 由服务端认证上下文决定；前端不能提交 workspace、凭据、prompt、服务端声明权威或标准化业务数据。

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
代理，测试不拦截或伪造网络响应。运行前需要提供可用的 MySQL 测试管理连接：

```bash
MYSQL_TEST_ADMIN_URL="$MYSQL_TEST_ADMIN_URL" \
pnpm --filter goodjob-crm-frontend run test:e2e:financial-council:real
```

可通过 `FINANCIAL_COUNCIL_E2E_USER`、`FINANCIAL_COUNCIL_E2E_PASSWORD` 和
`FINANCIAL_COUNCIL_E2E_DATA_AS_OF` 覆盖 test-only server 的默认账号与数据截止时间。
未提供 `MYSQL_TEST_ADMIN_URL` 时，不能将真实 MySQL/browser 验收记为通过。随机库迁移/竞态和跨 runtime 恢复已真实通过；`1.0.12` forecast-backed 链路也已在两个独立随机 MySQL 数据库中连续通过无 route-intercept Chromium，覆盖五专家、恰好一次反驳、三组合、revision 2、balanced 审批、成功回执与 reload identity。三表 parser 对 consent-only 调用仍如实标记 30/90 天 forecast `not_computable`，不能用历史数据补齐。真实双供应商门禁因凭据缺失保持 BLOCKED。

# Shensi macOS 桌面客户端架构

本文档是 macOS 桌面版的当前执行规范。Git 历史和外部浏览器取证见 `macos-external-browser-audit.md`。
客户无需安装 Chrome；内置、随包和系统默认浏览器的职责及 V1.0 跨浏览器验收见 [浏览器兼容边界](browser-compatibility-acceptance.md)。

## 登录外观与记忆

登录和注册共用双主题界面：黑绿使用深色品牌视觉；蓝白使用浅蓝品牌区、
蓝色品牌标志与独立的白色表单区。登录页也提供主题切换入口，启动动画跟随
同一主题。`theme-init.js` 在样式绘制和账号检查之前恢复外观，不依赖账号已登录。
上次选择保存于 `shensi.theme` 本地存储及一年有效的 `shensi_theme` 主机 Cookie；
Cookie 优先，使 Electron 网关端口变化后仍能恢复。退出账号不清除外观。
首次启动默认黑绿；用户清理应用数据或存储被禁用时不保证恢复。
隔离验收：`pnpm --dir frontend exec playwright test --config=playwright.login.config.ts`
与 `pnpm --dir frontend test:theme`，覆盖登录/注册、宽窄屏、首次绘制与跨端口恢复。

## 产品边界

日常源码开发使用仓库根目录的 `pnpm desktop:local`。它保留本地数据库，
构建最新 Main/Renderer，并启用外联审批及桌面执行、关闭服务器执行。
只读验收使用的临时三项 `false` 启动器不是日常入口。结束此类验收后，
恢复桌面执行前检查旧 `queued`、`blocked_by_predecessor`、`executing` 任务；
有旧任务时先按用户明确决定处理，不能通过启用开关自动发送它们。
`reconciliation_required` 记录保持待核验，不作为重发对象。
账号当前无执行设备（`executorMode: null`）时，检测本机登录后可以首次绑定，
前端不把它当作跨设备交接；旧待核验动作继续受原动作身份及回执规则约束。
绑定到其他桌面或从服务器迁移且有未解决动作时，仍阻止切换。
后台以 `executor_binding_generation_high_water` 持久保存历史最高绑定代数。
断开会清除当前设备绑定，但不清除该值；再次绑定分配比历史值更高的代数，
同设备有效绑定续租保持当前代数。Main 继续拒绝代数回退。

`Shensi.app` 由 Electron Main、受限 Preload、现有最新 Renderer 构建和本地 MediaCrawler Sidecar 组成。桌面版只把需要本机可见浏览器的能力留在本地：抖音登录、持久化 Profile、登录状态和采集。用户、CRM、获客数据、AI、权限、订阅和业务数据库继续由远程业务后端负责。

桌面版不打包 PostgreSQL、MySQL、Redis、Docker、Xvfb、VNC、x11vnc、noVNC 或完整线上后端。Web/remote 模式的 noVNC 兼容链保留，但桌面运行时不调用 `/live-sessions`、不加载 noVNC，也不建立 VNC WebSocket。

## 进程和信任边界

Renderer 的本地资源网关使用动态端口。真实模式每次启动均通过同源
`GET /api/auth/me` 验证既有服务器会话；新端口下缺少 `gj_user` 缓存不能
阻止该检查，本地缓存本身也不能授权登录。仅成功响应恢复账号与工作区，
未登录或读取失败保持登录页；退出及窗口销毁后，旧响应不能重新登录。
此流程不复制 Cookie、保存密码、固定端口或延长服务端会话有效期。

经营总管试点使用独立 `window.shensiCfoVoice`（status/greet/stop/setMuted），
Main 校验窗口、主 frame 和本地 origin；不接受音频文件路径或任意命令。
应用真正启动且 Shensi 登录/工作区就绪后，最多播放一次原生 Mac 问候。
静音偏好保存在本应用 userData 的 `voice-preferences/greeting.json`；
窗口关闭/退出/退出登录停止问候。问候不录音。
「智能体中心 → 和经营总管聊聊 → 语音服务设置」使用独立 `shensiCfoRealtime`。
Main 在本地 `realtime-voice` 目录使用 safeStorage 加密北京百炼 Key 与可选业务空间 ID，
使用官方公共 DashScope 入口，不将空间 ID 拼入连接地址。
按当前认证账号和工作区隔离；读取 IPC 不返回 Key。连接检测等待百炼
`session.updated` 确认，不打开麦克风。用户明确开始后才获取音轨，以 AudioWorklet
发送 16k PCM，并用 Web Audio 流式播放 24k PCM；业务回答仍调用既有 CFO 文字模型。
只记录完整播放的回答，打断时取消并重建百炼会话，不发送不存在的 truncate 命令。
独立问候由 Main 提供会话回应，业务追问仍走原模型；无自主工具调用时用当前转写恢复路由。
实际语音输出与设备听说验收见当前 PROJECT_STATUS；后续签名发行还须补产品麦克风
用途说明及限定的 audio-input entitlement，不能把本次开发构建当作安装包验收。
试点接口和接入要求见 `../modules/cfo-conversation.md`。

```text
本地 Renderer build
  ├── 同源 /api ──→ Electron 本地资源网关 ──→ 远程业务后端
  └── window.shensiDesktop ──→ Preload 白名单 ──→ Main IPC
                                                     └── SidecarProcessManager
                                                           └── 127.0.0.1:系统随机端口
                                                                 └── Playwright 外部可见浏览器
```

Renderer 不拥有 Node.js、`ipcRenderer`、`child_process`、`fs`、`shell`、Sidecar token、Sidecar 端口或任意路径/命令/URL 能力。Main 是 Sidecar 的唯一进程所有者，对 IPC 发送者和所有参数做二次验证。

BrowserWindow 固定使用：

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- `webviewTag: false`

生产 Renderer 只加载本地构建产物。本地资源网关绑定 `127.0.0.1:0`，仅提供静态文件和受控 `/api` 转发，不暴露桌面 IPC 或 Sidecar 信息。网关只接受当前随机 loopback Origin/Host 的请求；转发前再把来源改写为配置的业务后端 Origin。

Preload 必须由 `desktop/scripts/build-preload.mjs` 打包为单一 CommonJS 文件 `dist/preload/preload.cjs`。不能直接把 TypeScript 编译出的 ESM Preload 交给 sandboxed Renderer；真实 Electron 启动曾因此报 `Cannot use import statement outside a module`，并导致 `window.shensiDesktop` 缺失。

Renderer 的 CSP 保持 `script-src 'self'`。现有前端需要 inline style，因此仅 `style-src` 允许 `'unsafe-inline'`；不得把该放行扩展到脚本。

## 桌面 API

连接器 Preload 暴露 `window.shensiDesktop`；经营语音使用专用的
`window.shensiCfoVoice` / `window.shensiCfoRealtime`，财务报告使用专用的
`window.shensiCouncilReport.exportPdf({html, filename})`。报告桥仅接受有界静态
报告 HTML 和建议文件名，不接受路径或 URL；Main 验证当前顶层本地发送者，
通过原生保存对话框选择位置，在禁脚本、禁网络的临时沙箱窗口中打印 PDF，
完成、取消或异常后清理，不替换主窗口。屏幕、HTML 和 PDF 复用同一报告投影。

连接器接口：

```ts
interface ShensiDesktopApi {
  getRuntimeInfo(): Promise<DesktopRuntimeInfo>;
  getConnectorStatus(): Promise<ConnectorStatus>;
  restartConnector(): Promise<ConnectorStatus>;
  startDouyinLogin(accountId: string): Promise<DouyinLoginStatus>;
  getDouyinLoginStatus(sessionId: string): Promise<DouyinLoginStatus>;
  confirmDouyinLogin(sessionId: string): Promise<DouyinLoginStatus>;
  cancelDouyinLogin(sessionId: string): Promise<void>;
  startDouyinCollection(accountId: string, task: DouyinCollectionTask): Promise<DouyinCollectionStatus>;
  getDouyinCollectionStatus(taskId: string): Promise<DouyinCollectionStatus>;
  getDouyinCollectionResults(taskId: string, cursor?: string): Promise<DouyinCollectionPage>;
  acknowledgeDouyinCollection(taskId: string): Promise<void>;
  cancelDouyinCollection(taskId: string): Promise<void>;
  controlDouyinCollection(taskId: string, action: "pause" | "resume" | "stop"): Promise<DouyinCollectionStatus>;
  openLogsDirectory(): Promise<void>;
  getAppVersion(): Promise<string>;
  onConnectorStatus(listener: (status: ConnectorStatus) => void): () => void;
}
```

`accountId` 是当前已登录 Shensi 工作区的稳定标识，Main 用带域分隔的 SHA-256 转成 Sidecar 需要的 64 位 `account_key`；原值不记日志。Renderer 不能提供可执行文件、端口、token、本地路径、Sidecar 路由或额外命令行参数。

`sessionId`、`taskId` 和结果 `cursor` 经过同一个严格的不透明标识符边界：长度 1–200，首字符可为 ASCII 字母、数字、`_` 或 `-`，后续字符另可为 `.` 或 `:`。这覆盖 Python `secrets.token_urlsafe()` 可能以 `_` / `-` 开头的真实 Sidecar 会话令牌，同时仍拒绝空白、`/`、`\` 和超长值；Main 到 Sidecar 的路径和查询参数继续通过 `encodeURIComponent` 编码。

## Renderer API 请求预算

Main 的同源 API 代理按准确方法与路径设置请求预算：普通请求 10 秒；
`POST /api/v1/acquisition/plans/{planId}/automation/keyword-suggestions` 为 40 秒；
`POST /api/tools/ai-config/test` 为 250 秒，覆盖模型测试原有的有界格式修复；
既有财务长请求保持 130 秒。其他路径不因包含相似字符串而放宽。
Renderer 断连会取消代理的上游 HTTP；Backend 内的模型任务取消尚未贯通，
不能把 HTTP 断连等同于供应商停止处理。

## Sidecar 启动协议

桌面登录会话结束（expired/failed）后，Renderer 清除该会话缓存；Main 已不再持有会话时，后台查询停止并提示重新打开，只有用户明确连接才创建新会话，不自动重启连接器。连接操作保持单飞。业务账号成功断开后同时取消本次桌面登录会话，清除对应检测提示，但保留计划与关键词；业务断开失败不伪报账号已断开，浏览器取消失败单独显示错误。Main 在查询或确认返回时再次核对会话归属，断开前的迟到结果不能恢复旧会话和采集身份。

普通路由退出不等于退出抖音账号。明确断开在请求前捕获本机登录所属的启动任务或会话；业务断开成功后，即使页面已离开，也只清理捕获的旧会话，不取消新登录。业务断开失败保留本机状态；浏览器取消失败保留准确的待清理句柄，下次连接先重试清理，不复用旧 active 会话或登录幂等键。Main 对取消、新登录和终态推进账号代际，迟到身份检测与状态写回必须仍属于该代际，旧失败不清除新身份。
新登录同时撤销该账号的旧会话登记；旧状态请求不可恢复其身份，旧取消仍按准确 ID 转发 Sidecar 完成清理，但不撤销新登录的身份。

`LocalBrowserSessionManager` 将 Worker 明确返回的 `douyin_browser_context_closed` 作为已关闭会话处理，释放该会话资源，允许下次明确连接使用同一持久 Profile 新建会话；普通临时登录检测错误仍保留窗口。取消和过期不会删除桌面 Profile，也不等同于清除抖音站点登录记录。

Main 每次启动生成至少 32 字节随机 token，写入当前用户所有、权限 `0600`、非符号链接的临时 secret 文件。token 不出现在 argv、Renderer 或日志中。

开发模式通过仓库锁定的 `uv` 环境启动 `python -m shensi_adapter.desktop_entrypoint`；打包模式只启动 `process.resourcesPath/sidecar/shensi-sidecar`。两者均不使用 `shell=true`。

打包 Sidecar 由版本化的 `desktop/shensi-sidecar.spec` 生成 PyInstaller `onedir`，spec 只从自身位置推导仓库路径，不保存开发机绝对路径。资源根 `_internal/` 明确包含 MediaCrawler/Shensi 模块、LICENSE、两份 mstoken profile、`libs/stealth.min.js`、`libs/douyin.js`、Playwright Python 包、driver、metadata、`playwright/driver/node` 和 certifi CA/metadata。Playwright Chromium 由锁定的 Python Playwright 1.61.0 在构建时安装到独立 `Contents/Resources/playwright/`，首次启动不下载浏览器；构建会删除 Playwright 仅供 SDK 垃圾回收使用、且包含安装机绝对路径的 `.links` 元数据，浏览器运行不依赖该目录。

frozen 入口在参数解析前调用 `multiprocessing.freeze_support()`。仅在 frozen 模式，它先要求 `sys._MEIPASS` 是非空绝对路径，再解析并校验其下的 `playwright/driver/node` 必须位于 frozen 资源根内、是普通且可执行的文件，然后只把该目录前置到 Sidecar 子进程的 `PATH`，供 PyExecJS 使用；缺失、相对路径、符号链接逃逸或不可执行均停止启动，不会回退到当前工作目录。非 frozen 开发模式不改写 `PATH`，也不依赖这份 Node。

Sidecar 先校验 secret 和目录，再绑定 `127.0.0.1:0`，通过专用 ready pipe 返回 `{type, protocolVersion, pid, port}`。Main 不解析人类日志，并且只在带 Bearer token 的 `/internal/v1/health` 成功且协议版本匹配后发布 `ready`。

退出顺序是：停止接受新任务、取消登录/采集、请求优雅关闭、等待有界超时、定向强制终止、移除监听器和 secret 文件。异常退出最多受控重启两次，不进入无限循环。

## 数据目录

Main 从 Electron `app.getPath()` 生成下列绝对路径：

- `userData`
- `<userData>/logs`
- `<userData>/profiles`
- `<userData>/cache`
- `<userData>/temp`

开发和生产使用不同的 Electron app name/userData；测试使用临时目录。Sidecar 接收 `SHENSI_USER_DATA_DIR=<userData>` 和 `SHENSI_LOG_DIR=<logs>`，Profile 最终位于 `<userData>/profiles/douyin/<stable-account-key>/`。不写 `.app`、asar 或代码仓库。

## 云端同步边界

登录 Cookie、Profile、Sidecar token/端口和本地路径永不上传。Sidecar 确认登录后，Renderer 只把受限的公开账号标识、显示名称和单调登录版本提交给经过认证、活动工作区校验、CSRF 与幂等保护的业务 API。

## macOS 兼容与多机账号

当前锁定 Electron 44.1.1 的实际 `Info.plist` 和 Mach-O
`LC_BUILD_VERSION` 都声明 macOS 13.0，因此产品系统下限固定为
macOS 13.0；`electron-builder.yml` 同步显式声明该下限。构建脚本分别
支持 Apple Silicon `arm64` 和 Intel `x64`，但当前真实开发运行与历史
安装包证据只来自 arm64/macOS 26.5；x64 仍须在 Intel Mac 或 x86_64
macOS runner 上从同一锁文件构建并通过完整验收，不能从 arm64 结果推定。

多台 Mac 连接同一 HTTPS 业务后端和同一中心 MySQL；同一用户的
每台 Mac 都生成独立安装标识与加密设备凭据，但访问同一服务端
工作区数据。不同用户/工作区继续由服务端会话、成员资格和
`workspaceId + userId + teamId` 边界隔离。本地抖音 Profile/Cookie 不跨 Mac
同步，且同一抖音账号同一时刻只有一台绑定设备能执行外联；
切换执行 Mac 必须经过页面人工交接，generation 递增并使旧设备失效。

写请求准入仍由 Main 插入的完整构建清单 SHA-256 精确匹配。服务端
`exact` 模式需要一个主摘要，可选接受最多七个额外、不重复的精确摘要，
用于 arm64/x64 同版本并存或受控滚动升级。不存在版本范围、通配或关闭
准入；未列入的任何构建继续返回 `desktop_client_build_not_admitted`。

桌面立即运行的顺序固定为：业务后端冻结运行意图并创建 `executionTarget=desktop` 的任务 → Renderer 通过窄桥接启动相同 `taskId` 的本地采集 → 使用仅保存在内存中的任务能力精确领取并续租后端任务 → 本机采集终止后，以游标和幂等键上传标准化公开记录页 → 后端通过现有候选人投影完成耐久入库 → Renderer 最后调用 `acknowledgeDouyinCollection(taskId)`，启动本地结果 24 小时保留期，而非立即删除。服务端 worker 只领取 `executionTarget=server` 的任务；桌面完成路径不调用远程 MediaCrawler acknowledgement。任何 workspace、run、task、登录版本、游标、租约或 generation 不一致都会停止对应同步流程。

运行中的桌面页面通过现有采集状态轮询读取本机阶段、关键词、更新时间和“本机已采集”数量，同时独立显示后端的“已入库公开记录”。本机进度仅保存在当前运行的内存中，绑定工作区、run、task 和 generation；取消或切换计划后不继续展示旧进度。后端入库与候选人额度仍是业务权威，本机完成但后端未完成时显示“本机采集结束，等待结果入库”，不会提前放开下一次运行或审批。重启后恢复的历史运行读取后端结果，不恢复本机显示缓存。采集进程与 Profile 的收尾边界见 [获客模块规范](../modules/acquisition.md)，验收证据见 [当前状态](../PROJECT_STATUS.md)。

## 外联动作桥当前阶段

后端已分离审批、服务端执行和桌面执行三道严格门。任一 canonical split flag 出现时，三项都必须是精确小写 `true`/`false`；全部缺失时才允许 Web/Trial 用旧 `DOUYIN_OUTREACH_ACTIONS_ENABLED` 同时映射审批与服务端执行，桌面执行固定关闭。服务端执行还必须存在私有 MediaCrawler gateway，否则启动失败。

Task 5 已完成后端内部的 fenced claim/start/receipt、sweep、同设备重启恢复和人工核对持久化核心。领取时，唯一的候选人/证据/DNC 授权解析器在持久化层已锁定的同一事务中运行；拒绝或异常不会留下 claim、attempt、配额、冷却或 replay 副作用。桌面 post-start 不确定结果进入 `reconciliation_required`；零写入过期 claim 才可重新排队，count-one/executing 过期仍进入核对；旧服务端不确定结果继续 `risk_paused`。重启恢复返回含账号身份、kind、canonical target、精确内容、approved/request hash、全新有界恢复截止时间、原 lease 与 binding/login version 的完整不可变只读任务，以及仅限 reconciliation 的新进程 capability。它不能通过 `started` 或普通写回执路径；原始回执与观察回执采用 first-valid-wins，精确重放稳定，证据改变冲突。

认证用户提交人工核对后，后端持久化请求，由现有设备 claim 轮询返回 `kind: reconcile` 只读任务；Main 本地 journal 已清理也能发现。Main 仅调用 Sidecar 的 reconcile，不执行 started/execute，也不重新创建写入 journal。当前账号/设备/登录版本/绑定代数及原动作冻结内容必须匹配；只读结果单独保存在人工请求的 `desktopDispatch` 中，原始 attempt 回执不覆盖。Sidecar 可读取已确认入库的不确定 tombstone 的原时间界限进行核验，但不改写它；核验成功才解除该动作阻塞，未找到回执仍待核对，绝不自动重发。此 JSON 元数据扩展不需要数据库 DDL 迁移。评论与私信仍各自审批。页面不拥有动作执行接口；源码变更需通过开发入口重启生效，不自动改动已安装历史包。

本地动作桥的代码边界：

- Sidecar 从与登录相同的 `account_key` 恢复持久化账号身份，返回账号 handle、显示名和登录版本，不返回 Profile 路径或 Cookie。
- 桌面动作请求只接受 `canonical_target_public_url` 与 `request_hash`；校验通过后复用既有评论/私信执行器。Web gateway 的旧请求结构保持兼容。
- Main 的 `SidecarClient` 包含身份恢复、执行、只读核对和精确回执确认；只投影本地需要的字段，不传云端设备凭据或 task token。回执参与哈希的时间严格使用毫秒 UTC `Z`；确认清理的普通时间允许 Python 的零位或六位小数，避免成功清理被误判为失败。
- 已完成动作的清理确认支持响应丢失后重试。Sidecar 保留不含内容、目标 URL 或凭据的回执确认记录，相同动作再次到达也不会重新执行。
- `DesktopCentralApiClient` 已提供注册、领取、完成和恢复四个固定业务 API，使用与前端同源生成的 DTO；请求和响应均限制为 64 KiB，10 秒预算覆盖响应读取，禁止重定向，不自动重试。Origin 和构建摘要由 Main 提供；客户端不读取 Renderer 配置，也不自行注册安装身份或启动执行循环。
- `device-installation.ts` 保存稳定安装标识；`device-credential-store.ts` 通过注入 Electron `safeStorage` 的加密接口保存工作区凭据；`outreach-action-journal.ts` 保存每账号至多一条、设备至多两条恢复记录。文件为 `0600`，专用目录为 `0700`，写入及目录更新均落盘。恢复记录不含内容、目标、账号 handle 或任何 token。

Main 启动本地 Sidecar 时明确设置桌面动作能力 `true`、旧服务端动作能力 `false`，并剔除业务后端 Origin；这只是本地受认证端口的能力配置。Main 组合真实 `safeStorage`、独立安装/凭据/恢复目录、中央客户端和协调器，Sidecar ready 后才初始化。页面经认证工作区 bootstrap 申请 enrollment 并交给 Main 注册，随后读取准确绑定版本、记录中央成功绑定响应、选择当前工作区。退出登录清空上下文，Renderer 重载只恢复状态订阅。未注册、未绑定或中央执行门未启用时不会因应用启动而发送。

`window.shensiDesktop` 的动作管理新增白名单为 `getDesktopInstallationInfo`、`registerDesktopInstallation`、`recordDesktopBinding`、`setDesktopWorkspace`、`getDesktopOutreachStatus` 和 `onDesktopOutreachStatusChanged`。没有 claim/start/execute/complete/reconcile IPC。所有 invoke 必须来自同一 webContents 的顶层 frame 和本地 Origin；状态事件不含 ID、账号 handle、内容、目标、Profile、凭据或回执。账号卡使用原有黑绿样式，设备交接需单独勾选确认；中央只读绑定接口提示未解决动作时禁用交接。动作回执按持久化执行目标显示桌面状态，评论与私信保持两次独立审批。

账号卡的“重新检测本机登录”只读取持久化身份，不创建登录会话、不递增登录版本。检测结果与当前工作区的有效账号版本一致时，读取中央设备绑定并恢复“重新绑定本机账号”入口；检测本身不续租、不领取动作。用户点击重新绑定后，沿用现有同设备绑定接口续接租约并刷新 Main 的绑定记录，不改动已审批内容和原动作写入次数。切换工作区后丢弃旧检测结果；跨设备且存在未解决动作时仍禁止交接。领取接口的 HTTP 404 显示设备授权/绑定不可用，不再误报本地连接器故障。Main 日志只记录失败阶段、来源和 HTTP 状态，不记录请求内容、身份或凭据。

离线超过 90 秒导致绑定租约失效时，既有恢复权限要求有效登录下重新绑定同一设备、同一 generation；成功后 Main 才重试只读核对。该步骤不会重新发送内容，也不会解除风控或把未知结果标成成功。

协调器每设备最多两个账号执行槽，同一账号先恢复旧记录才领取新任务。顺序为持久化 claimed → 中央 started → 本地 central_started → Sidecar 执行 → 本地回执 → 中央接收 → Sidecar 确认 → 清理记录。重启只走只读核对，不重放写权限；中央确认的未开始过期任务才可精确释放，中央接收的 pre-journal 账号忙回执无需确认不存在的 Sidecar 记录。中央已 started、Sidecar 无可靠记录，或 Sidecar 只返回中央尚未收到的原始失败回执（而非新核对的成功/明确不存在），仍保留待核对，不伪造回执、不自动重发。空轮询间隔 3–5 秒，临时连接失败按 2/4/8/16/32/60 秒退避。

既有登录 IPC 名为 `accountId` 的参数实际是工作区 ID；协调器复用 `accountKey(workspaceId)` 找到同一 Profile，不改用后端社交账号 ID 另建空 Profile。执行隔离及中央绑定仍使用真实社交账号 ID。

`desktop-build-identity.ts` 从 Main 独占读取规范构建清单，固定同一 Origin/摘要供代理和设备 API 使用。生产清单位于 Resources 的 `desktop-build-manifest.json`；开发清单由受控 producer 写在 `.runtime/desktop-dev/<sourceRootHash>/`。缺失、错误权限、符号链接或不规范内容均拒绝启动，不信任 Renderer 提供的摘要。

新增模块的定向验证：

```bash
pnpm --dir desktop exec tsx --test tests/device-installation.test.ts tests/device-credential-store.test.ts tests/outreach-action-journal.test.ts tests/private-storage.test.ts tests/sidecar-client.test.ts tests/sidecar-outreach-client.test.ts
pnpm --dir desktop exec tsx --test tests/desktop-central-api-client.test.ts
pnpm --dir desktop exec tsx --test tests/outreach-action-coordinator.test.ts tests/outreach-action-lifecycle.test.ts tests/controlled-shutdown.test.ts tests/desktop-build-identity.test.ts
pnpm --dir desktop exec tsx --test tests/desktop-enrollment-service.test.ts tests/outreach-action-bridge.integration.test.ts tests/acquisition-scroll-stability.e2e.test.ts
uv run --frozen --project services/media-crawler pytest -q services/media-crawler/tests/shensi_adapter/test_desktop_action_recovery.py
```

上述跨设备回归组合真实 Main 客户端、本机 HTTP、后端服务和内存事务仓库，使用临时独立数据目录及 recording fake Sidecar；不接触抖音、真实 MySQL 或已安装应用。浏览器回归验证连续状态更新期间候选勾选、焦点和滚动位置（误差不超过 1 像素）。完整可销毁 MySQL 故障矩阵、安装包及真实双 Mac 验收尚未完成，见[阿里云双 Mac 验收清单](acceptance/aliyun-two-mac-checklist.md)。

同账号业务数据共享由现有 Backend HTTP 路由验证：两个独立 Cookie/CSRF
客户端登录同一新账号后可跨客户端创建、读取和更新同一客户；退出一个客户端
不影响另一个，另一工作区不能读取该客户。`pnpm api:verify:multi-mac-crm:mysql`
又在独立可销毁的真实 MySQL 8.4 中复现该流程，并验证关闭、重建 Backend store
后仍能读取同一更新记录；该验收于 2026-09-07 通过并自动清理测试资源。它仍不
替代 WAN/TLS、阿里云恢复或两台物理 Mac 验收；部署与现用账号数据保留步骤见
[Multi-Mac Central Service Plan](multi-mac-central-service-plan.md)。

数据库专项入口为 `pnpm api:verify:desktop-action-bridge:mysql`。获得一次性测试环境授权后，该命令创建独立 MySQL、传递有效 owner-lock nonce，使用真实 MySQL 仓库运行跨设备故障用例，最后保留脱敏结果并按所有权清理。测试子进程使用已选运行时的 PATH 和 Unix socket，继续执行完整所有权校验。失败日志仅保留固定阶段、错误类别、静态 schema 对象、有界语句序号、用例编号和进程状态，不回显 SQL 或数据。完整 MySQL 矩阵尚无通过证据。专项入口 `node scripts/verify-desktop-action-storage.mjs outreach-schema` 仅运行空库建表与重复初始化，不启动业务服务或执行抖音动作；CHECK 元数据引号归一化、空库初始化和不修复的第二次 ensure 已在 `job-mtoceraq-07af969c` 通过。其结果不代替完整矩阵验收，见[部署说明](../DEPLOYMENT.md#isolated-outreach-schema-reproduction)。

## macOS 生命周期

应用使用单实例锁；第二次启动只恢复并聚焦已有窗口。关闭最后一个窗口不退出 macOS 应用，Dock 重新激活会新建窗口；Cmd+Q 或 `before-quit` 先停止协调器领取，并最多等 10 秒处理当前回执，再依次关闭 Sidecar 和 Renderer 网关。Renderer 重载不拥有协调器生命周期；Sidecar 替换会重新恢复身份，不删除持久绑定。

## 开发与构建

桌面实时进度的隔离浏览器回归使用当前桌面 Vite 模式，不加载保留的 noVNC 入口：

```bash
pnpm --dir frontend exec playwright test --config=playwright.desktop-progress.config.ts --project=chromium
```

此测试以受控状态验证实际 Renderer 的阶段、采集量/入库量区分、滚动稳定性和窄窗口布局，不发送评论、私信，也不替代真实采集验收。

开发模式下，`SHENSI_REMOTE_ORIGIN` 必须指向业务后端认可的可信入口，例如本机真实试用网关 `http://127.0.0.1:5608`，不能绕过入口直接连接仅供内部进程使用的 `http://127.0.0.1:5611`。直连 `5611` 时后端会按 Origin/CORS 策略返回 `403 不允许的请求来源`，这不是账号密码错误。公网生产配置只接受准确的 HTTPS Origin；开发时允许准确的 loopback HTTP Origin。

当前命令：

```text
pnpm desktop:local
pnpm desktop:local:prepare
pnpm test:desktop-local
pnpm desktop:dev
pnpm desktop:test
pnpm desktop:typecheck
pnpm desktop:build:renderer
pnpm desktop:build:main
pnpm desktop:build
pnpm desktop:package:mac
pnpm desktop:verify:mac
pnpm desktop:package:mac:release
pnpm desktop:verify:mac:release
```

日常使用 `desktop:local`：独立 MySQL 数据库 `shensi_desktop` 保存在持久卷中，端口 `3313`；本机 Backend 端口 `5638`。首次初始化生成独立凭据，不复制旧账号、业务数据或 API Key。进入应用后注册普通账号创建新工作区。Cmd+Q 退出开发应用或 Ctrl+C 会停止它启动的 Backend，保留 MySQL 和数据；下次启动继续使用同一数据库。旧试用和已安装应用保持不变。

本地开发入口启用人工审批与桌面执行，服务端发送保持关闭。生成批次使用已启用的 AI 模型，评论和私信在页面分两次确认；仅生成草稿不会发送。重新检测登录后，新批次使用当前有效登录版本，原采集证据保持不变；已存在的旧批次不能自动换用新登录。关闭发送门时显示“桌面执行尚未启用”，而不是中心服务离线。

评论提交后若出现“接收短信验证码”等已识别验证提示，保留并置前同一浏览器供用户手动处理；等待最多使用配置的人工验证时长（默认 120 秒），并受本动作剩余截止时间限制。验证结束后重新核对账号和目标，只读检查已提交评论的回执，不再输入或发送。验证超时、关闭窗口或身份改变会冻结为待只读对账；弹窗消失不等于发送成功。确认成功或结果不明确后保留页面 10 秒再关闭，不能无限延长任务或恢复发送。

新工作区登录后自动完成设备注册；没有抖音绑定时显示“本机尚未绑定该抖音账号”。注册凭证的两处 MySQL 读取显式返回 UTC 文本，不能按宿主机本地时区解释 DATETIME。真实接口专项验收使用 `desktop-local-acceptance.mjs enrollment`，详见[本地开发与验收命令](../DEPLOYMENT.md#fresh-local-desktop-development)。

抖音登录检测成功后，Sidecar 保存登录身份并关闭登录浏览器，释放同一 Profile 供采集使用。页面完成账号同步后显示“登录已保存，登录窗口已自动关闭”；本机绑定是否完成以账号卡为准。桌面登录完成接口的幂等摘要为 64 位裸十六进制，与账号回放表一致，不使用采集摘要的 `sha256:` 前缀。

启动器先构建最新 Main 与前端，再生成源内容清单，将真实清单摘要交给本机 Backend 做精确版本准入，随后打开 Electron。开发版和生产版均由 Main 静态网关提供页面和同源 API。没有 Vite/HMR，修改后重新运行此命令加载新内容。Main 是 Sidecar 的唯一所有者。日常开发不生成 `.app`、DMG 或 ZIP：

```bash
pnpm desktop:local
```

`desktop:build:renderer` 构建最新前端并验证桌面产物不包含可执行的 remote-canvas/noVNC 链。打包入口的 `afterPack` 在签名前生成 `desktop-build-manifest.json`，记录源码、Renderer、Main、Sidecar 和运行配置摘要；包验证器要求 Main 能读取该清单，缺失时不降级。开发包接受真实、准确、无凭据的 HTTPS Origin，或带显式端口的 `http://127.0.0.1:<port>`；release 只接受真实 HTTPS。所有模式均拒绝 `.example`、`.invalid`、`.test`、`.localhost` 等占位主机。本机隔离验收命令为：

```bash
SHENSI_REMOTE_ORIGIN=http://127.0.0.1:5680 pnpm desktop:package:mac
```

该命令将已有 `dist/desktop/macos` 移至带时间戳的 `.previous-*` 同级目录，保留恢复能力；重建任务自有的 `desktop/.build/sidecar` 和 staging 目录，随后生成当前宿主架构的 `Shensi-0.1.0-<arch>.dmg`、同名 ZIP、解包后的 app 和 `SHA256SUMS`。验证器检查 DMG 挂载结构、ZIP 完整性、校验和、所有 Mach-O 的宿主架构、具体 Chromium executable、Sidecar/CA/metadata/bundled Node、runtime config、asar 入口，并拒绝远程显示服务、secret、用户 Profile、Playwright `.links`，以及任意不超过 2 MiB、无 NUL 且为有效 UTF-8 的文件内容或符号链接目标中出现的具体 `/Users/<user>/` 或 `/home/<user>/` 开发机路径。包本身位于 `/Users/...` 不构成内容泄漏；Playwright 的通用 `/home/$Username/` WSL 脚本也不是开发机路径。脚本只支持 Darwin `arm64` 或 `x64` 宿主；当前实际构建与验证证据只有 arm64。

环回地址测试包使用 `Application Support/Shensi Test/packaged-local`，Chromium 会话位于其 `browser-session` 子目录，不复用正式版或源码开发版的资料。5680 仅为隔离验收 API，不是客户部署地址；后端必须精确准入该包的清单 SHA-256。生成清单不等于签名或客户端可信证明，也不代表安装、注册、人工开通或跨机器验收已经通过。

包验证器还要求 `Contents/Resources/audio/startup-greeting-qwen35-tina-v1.wav`
存在，并校验固定字节数、RIFF/WAVE 头和已验证样本的精确 SHA-256；缺失、
替换或损坏都会使构建验收失败。该资源只用于在新 Mac 首次启动时初始化
本机私有 `0600` 缓存，不包含模型凭据。

Intel x64 不能在当前 arm64 机器或 arm64 runner 上伪造。必须使用 `uname -m` 返回 `x86_64` 的 Intel Mac 或 x86_64 macOS runner，安装 Xcode Command Line Tools（提供 `xcrun`、`hdiutil`、`ditto`、`iconutil`、`codesign`、`lipo`）、Node、pnpm 和 uv，并从同一锁文件工作树运行：

```bash
uname -m  # 必须输出 x86_64
pnpm install --frozen-lockfile
SHENSI_REMOTE_ORIGIN="$PRODUCTION_API_ORIGIN" pnpm desktop:package:mac
pnpm desktop:verify:mac
```

这会由宿主检测选择 electron-builder `--x64`，并必须通过与 arm64 相同的 frozen Sidecar、具体 Chromium、资源/路径、ZIP/DMG、Mach-O 架构和校验和门禁。公开发布还必须在该 Intel 环境配置真实 Developer ID 与 notarytool Keychain profile、替换并审批正式图标，然后运行 `pnpm desktop:package:mac:release` 和 `pnpm desktop:verify:mac:release`；不能用 arm64 产物或 Rosetta 运行结果代替 x64 产物证据。

`desktop/build/icon-source.png` 是用户指定青蓝轨道三角 Logo 的高清 imagegen 图稿。`icon-approval.json` 记录用户授权、源文件和精确 SHA-256，素材状态为 `product-owner-approved`，不代表应用签名或发布验收通过。`generate-macos-icon.mjs` 先校验素材摘要及至少 1024 像素的正方形 PNG，再通过 macOS `sips` 从实际素材生成 16–1024 px 的 iconset，最后用 `iconutil` 生成 `build/icon.icns`；没有另行硬编码的 S 图案。修改素材须同步审阅审批记录，不能只绕过摘要检查。高清源为深色不透明背景，不宣称透明底。

## 发布边界

首版使用 Electron + TypeScript + electron-builder。依赖使用现有 pnpm workspace 并精确锁定，不全面升级前端。Renderer、Main、Preload、Sidecar 可执行物和 Playwright Chromium 都位于 asar 外的明确资源边界。开发模式设置 `CSC_IDENTITY_AUTO_DISCOVERY=false`，允许生成未签名或系统链接器 ad-hoc 状态的本机测试包；它不是 Developer ID 签名，不启用可验证的 hardened runtime，也不是公开发布物。

release 模式 fail closed，必须同时提供：

- 非 placeholder 的准确 HTTPS `SHENSI_REMOTE_ORIGIN`；
- Electron Builder 支持的 Developer ID 来源 `CSC_NAME` 或 `CSC_LINK`（相关密码只通过其支持的环境变量提供，不写入命令或仓库）；
- 只含名称的 `SHENSI_NOTARYTOOL_KEYCHAIN_PROFILE`，凭据预先由所有者写入系统 Keychain。

release 专用 Electron Builder overlay 强制 `forceCodeSigning=true`，并通过 custom `mac.sign` 包裹 electron-builder 传入的完整 `configuration.optionsForFile`（包括未来增加的 context/其余参数），最终仍调用锁定的 `@electron/osx-sign` 1.3.3 `signAsync`；开发配置不使用该 custom signer。base config 的 `entitlementsInherit` 明确指向空 plist，不再把主进程权限宽泛继承给嵌套对象。签名策略默认给代码对象空 entitlement 并保留 hardened runtime，只给明确的 V8 进程 `allow-jit`：Electron app/main 与普通主 Helper/Renderer/GPU、Sidecar 内的 Playwright driver Node，以及 Chromium app/main/Renderer/GPU。Electron Framework、Plugin Helper、Python Sidecar、普通 dylib/framework、ffmpeg、Chromium Framework 和其它 Chromium Helper 都为空。custom signer 不使用 `--deep`；只有下述发布验证器额外用 deep 检查整体结构。没有 Chromium 上游签名 allowlist，也没有 `allow-unsigned-executable-memory`、`disable-library-validation` 或非 Sandbox 场景无效的 network entitlement。

release hook 在任何 notarytool upload 前先对最外层 app 执行 `codesign --verify --deep --strict` 整体结构验证；随后不跟随符号链接地枚举所有嵌套 `.app`、`.framework` bundle 和 Mach-O 文件，对最外层及每个枚举对象分别执行 strict 签名、身份和 entitlement 验证。整体 deep 验证只是附加结构门禁，不能替代逐对象 allowlist。每个对象都必须拒绝 ad-hoc、缺少 `Developer ID Application` Authority、无效 10 位 Team ID 或缺少 hardened-runtime flag，并与最外层 app 的 Authority 和 Team ID 完全一致；验证器同时导出各对象 entitlement，按上述路径边界拒绝缺项或任何额外 key。Chromium 上游签名若未被项目 Developer ID 重签会停止发布。验证通过后才以 `notarytool --keychain-profile ... --wait` 提交临时 ZIP，随后 staple/validate app，再构造 DMG/ZIP；DMG 必须使用相同 Authority 与 Team ID 签名，并在上传前再次验证（hardened runtime 只适用于可执行代码，不要求 DMG 容器携带）。流程不使用 altool，也不把密码、私钥或 key 文件放到 argv。最终 release 验证还检查 Gatekeeper、app/DMG ticket 和三份 app 内容。

当前唯一非默认 entitlement 如下；没有 App Sandbox，也没有 `allow-unsigned-executable-memory`、`disable-library-validation`、`allow-dyld-environment-variables`、`get-task-allow` 或 `network.client/server`：

| entitlement | 所属边界 | 原因 | 移除证据 |
| --- | --- | --- | --- |
| `com.apple.security.cs.allow-jit` | Electron app/main 与普通主 Helper/Renderer/GPU、Playwright driver Node、Chromium app/main/Renderer/GPU | 这些可执行角色承载 V8/JIT；electron-builder 26.15.3 的本地类型说明明确指出 arm64 Electron 20+ 需要 JIT entitlement，锁定的 osx-sign 也只给 Renderer/GPU 默认 `allow-jit` | 正式 Developer ID 包必须分别启动 Electron Renderer、Sidecar driver Node 和可见 Chromium 才能评估进一步收紧；Framework 与 Plugin Helper 在没有具体错误证据时保持空 |

当前机器 `security find-identity -v -p codesigning` 返回 0 个有效身份，因此 release 命令按设计在预检阶段停止；没有签名、公证、Gatekeeper 通过、hardened runtime 或上述最小 entitlement 对真实运行影响的发布证据。正式证书环境若出现运行错误，只能根据具体失败对象追加最小权限并重新完成全套门禁，不得预先恢复宽 entitlement。发布前仍须在目标架构上重打包，并在签名安装版中实测认证读取与一个 CSRF 写请求。

## 源码验证与发布边界

Task 9 的历史源码验证包括 203 项桌面 TypeScript 测试、4 项构建清单 producer 测试、6 项 frozen-entrypoint 测试，以及 Renderer/Main 构建和类型检查。浏览器测试使用当前获客页面与模拟数据，验证选择、焦点、滚动和节点稳定。打包清单 producer 与环回测试资料隔离已有针对性测试；最新安装包、完整 disposable MySQL 矩阵及真实双 Mac 验收必须分别记录结果，不能由源码测试推断。当前总进度以 `../PROJECT_STATUS.md` 为准。

### 历史开发包验收（归档记录）

以下只保留早期开发包的观察结果，不代表上述 Task 9 源码已经打包安装，也不用于当前发布准入：

- 历史打包批次重建了 arm64 frozen Sidecar、Renderer/Main/Preload、DMG 与 ZIP。未解包 app、ZIP 内 app 和 DMG 内 app 均通过 2,667 项包内容、架构、资源和禁止项验证；DMG 和 ZIP 的 SHA-256 分别为 `cec78daf480e7c06183d09680c863a94e3531f3c53e7d796079ca443c5c709b8` 和 `609f0cf9453899aff014deb941666ff6376c5db4c4b46d477801df57be6a4956`。
- DMG 中的 app 已安装到 `/Applications/Shensi.app`；安装后 Bundle ID 为 `com.shensi.desktop`、版本 `0.1.0`、主程序/Sidecar/Chromium 均为 arm64。安装版 Renderer 暴露 15 个白名单方法，`window.require` 不存在，Connector 返回 `ready`、协议版本 1。
- 安装版实际启动 app Resources 内的 PyInstaller Sidecar、Playwright driver Node 和 Chromium 1228，没有使用系统 Python/Node。登录会话从 `starting` 进入 `running / waiting_for_user`，重复发起返回同一会话；Python `secrets.token_urlsafe()` 可以 `_` 或 `-` 开头的 ID 已在 Desktop 查询/确认/取消边界中完整往返。
- 同一账号标识在 app 重启后复用同一 `/Users/mac/Library/Application Support/Shensi/profiles/douyin/449a002cd880dfd59f9f9c2dbade561d6da1fce82a3a52a23ee1ae3d78471594` Profile 路径；这证明稳定 Profile 路由，不证明尚未完成登录的 Cookie 可用。取消会关闭 Chromium；Chromium 活跃时退出 app 也会回收 Electron、Sidecar、driver 和 Chromium，并删除当前 token。
- app 复制到包含空格的 `/private/tmp/Shensi Package Smoke.wCkEiQ/Shensi Installed Test.app` 后，可从非仓库目录启动并使用该 app 内的 Sidecar/Chromium；会话取消和受控退出通过。该临时副本已移入废纸篓。
- 桌面 Renderer 的资源请求中没有 `/live-sessions`、noVNC、websockify、Xvfb 或 VNC，进程追踪也只有外部可见 Chromium。历史开发包使用结构占位的 `https://desktop.internal.example` 业务 Origin，不能用于账号登录；当前策略已经禁止再次生成这种占位配置。源码 Electron 开发模式已通过 `http://127.0.0.1:5608` 完成真实 `test2` 账号登录，但现有历史 DMG/ZIP 在下次阶段性重打包前仍保持原配置。
- 本机没有 Developer ID；app/Sidecar/Chromium 只有开发阶段 ad-hoc/linker 签名，DMG 未签名，Gatekeeper 拒绝，app 和 DMG 均无 stapled ticket。该产物只是“仅开发测试版”。

尚未由人工完成真实二维码扫描，因此登录成功后的 UI 更新、真实评论采集、结构化结果回到业务页面和真实云端同步都没有验收证据。它们不得从自动化运行时检查推定为完成。

### 历史 16 项安装态验收记录

本表只记录上述历史包的实际观察；“未执行”表示当时没有端到端人工证据，不代表自动测试缺失。新的生产验收使用[阿里云双 Mac 验收清单](acceptance/aliyun-two-mac-checklist.md)。

| # | 验收项 | 结果 | 实际证据或缺口 |
| --- | --- | --- | --- |
| 1 | Electron 主窗口打开 | 通过 | 从 `/Applications/Shensi.app` 真实启动，Renderer `readyState=complete`。 |
| 2 | 原有前端主要页面正常显示 | 通过 | 安装包内是当前 desktop Renderer 产物，不包含 remote-canvas 执行链。 |
| 3 | 云端业务 API 正常工作 | 未执行 | 开发包的 remote Origin 为结构占位值，未执行真实云端认证/同步。 |
| 4 | 本地 Connector 显示已连接 | 通过 | 安装版 bridge 返回 `state=ready`、`protocolVersion=1`。 |
| 5 | 点击连接抖音 | 通过 | 安装版白名单 bridge 实际创建登录会话；本轮未重复手工鼠标点击。 |
| 6 | 外部 Chromium 打开 | 通过 | app Resources 内的 Google Chrome for Testing 149/Playwright Chromium 1228 实际启动。 |
| 7 | 用户可以直接点击 | 部分通过 | 是外部原生 Chromium 而不是截图/noVNC；本轮没有人工点击安装版登录控件。 |
| 8 | 用户可以扫码和刷新二维码 | 未执行 | 二维码可见，但未用手机扫码，也未完成人工刷新二维码验收。 |
| 9 | 登录成功后 Electron UI 更新 | 未执行 | 未完成真实扫码登录。 |
| 10 | 可以启动一次评论采集 | 未执行 | 未取得真实登录终态。 |
| 11 | 采集结果回到现有业务页面 | 未执行 | 未执行真实采集和真实云端同步。 |
| 12 | 快速点击连接多次只出现一个浏览器 | 通过 | 安装版重复发起返回同一 `sessionId`，只有一个主 Chromium。 |
| 13 | 退出应用后 Sidecar 和 Chromium 都退出 | 通过 | Chromium 保持活跃时对 app 发起受控退出，Electron/Sidecar/driver/Chromium 全部退出，当前 token 被删除。 |
| 14 | 重启应用后 Profile 正常复用 | 部分通过 | 重启后稳定复用同一 Profile 路径；未登录，所以不声称认证 Cookie 已复用。 |
| 15 | 没有 Xvfb/VNC/noVNC 进程 | 通过 | 安装态进程检查无匹配项。 |
| 16 | desktop 模式没有 `/live-sessions` 请求 | 通过 | 安装版 CDP Performance 资源列表无 `/live-sessions`、noVNC、websockify 或 VNC。 |

因此当前状态是“桌面工程实现和外部浏览器交互链路已验证，发布与真实业务验收未完成”。不能宣称 macOS 客户端已经可生产交付。

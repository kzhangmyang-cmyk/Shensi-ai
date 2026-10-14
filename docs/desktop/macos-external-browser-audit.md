# Shensi macOS 外部浏览器登录审计

审计日期：2026-09-02；实施状态复核：2026-09-03

本文先保存“抖音获客登录”从最后一个可工作的 macOS 外部浏览器实现，到迁移前 Xvfb/VNC/noVNC 工作区之间的 Git 取证；随后记录已经完成的 desktop/local 竖切。当前仍不进行 Electron 打包、不删除 Web 远程模式代码，也不把旧前端覆盖到当前前端。文中“迁移前 remote 基线”专指实施 desktop/local 竖切前的未提交工作区，不代表当前 desktop 运行路径。

## 结论摘要

Git 证据需要区分三个版本点：

| 含义 | Commit | 证据结论 |
| --- | --- | --- |
| 最近一次人工实测“外部可见 Chrome 扫码成功”事件的首次 Git 记录 | 48b7140a7a2c755b8d821b7822489d4e76c8937b | 该提交首次把 2026-08-25 的真实扫码成功记录写入 docs/PROJECT_STATUS.md |
| 最后仍保留该原始成功记录的提交快照 | c96bc06b4951cf1e4beddb9e8ba66da99046a45c | 只是继续保留同一历史记录，不代表再次执行了登录复测；004d15e 随后改写状态文档 |
| 最后一次实质完善外部浏览器、账号绑定和真实采集实现的版本 | 6e277e982326baafeeae9179d8a3904a2c5ab49d | 仍使用本机可见的 launch_persistent_context；加入更完整的身份提取、采集和动作能力 |
| 最后一个完全提交、且不含 Xvfb/VNC/noVNC/live-sessions 的快照 | 9060691cf96a61cffa151b998742bd03deb19919 | 当前 HEAD；6e277e9 到该提交的相关浏览器、账号和采集核心文件没有架构变化 |

因此：

1. Git 能证明的“最后一次正常工作事件”是 48b7140 首次记录的 2026-08-25 实测；没有后续真实登录复测证据可以证明一个更晚提交仍然实际正常。c96bc06 只是最后仍含该原始记录的快照，不应误称为重新验证。
2. 当前实现从 6e277e9/9060691 提取了外部浏览器、账号身份和同一 profile 采集边界；没有恢复 48b7140 的整个前端或整个工作树。
3. Git 历史中不存在“引入 noVNC 的 commit”。Xvfb、x11vnc、noVNC、live-sessions 和容器化 trial Sidecar 均位于 9060691 之后的未提交工作区。准确引入范围是 9060691 → 当前 WORKTREE，不能虚构单一 commit。
4. 迁移前 remote 基线中的 409 直接含义是“Context 尚未注册”；当时 real-trial 从 macOS 本机 Sidecar + 外部可见 Chrome 转为 Colima/Docker Chromium + Xvfb + x11vnc + noVNC。该链现在保留为 `web`/`remote_canvas` 模式，不再是 desktop 登录路径。
5. 当前 `SHENSI_RUNTIME_MODE=desktop` 已由 `app.py` 选择 `LocalBrowserSessionManager`，在 macOS 用户桌面启动外部可见 Chrome，并返回 `interactionSurface=external_window`。desktop 不调用 `/live-sessions`、不加载 noVNC，也不依赖截图或二维码提取；`SHENSI_RUNTIME_MODE=web` 继续使用原 remote/noVNC 链。
6. 当前完成的是本地外部浏览器架构、生命周期、合同和最新前端接入，不是完整业务验收。尚无真实扫码、真实账号认证或认证后评论采集成功证据。

## 1. 当前技术栈

仓库当前是 pnpm monorepo：

- 运行时：Node.js 22.22.3，pnpm 11.18.0。
- 前端：React 19、TypeScript 5.7、Vite 6、原有 acquisition controller/view；当前未提交工作区增加了 @novnc/novnc 1.7。
- 业务后端：Node.js、Express 4、TypeScript、Zod、OpenAPI、MySQL 8.4。
- MediaCrawler Sidecar：Python 3.11、FastAPI 0.110.2、Pydantic 2、Playwright 1.61+、uvicorn 0.29、pytest。
- 上游抖音采集：仓内固定的 MediaCrawler 源码，Shensi adapter 通过持久化 Playwright profile 调用 DouYinCrawler。
- 当前 real-trial/public-trial 默认运行：前端、业务后端和 gateway 在宿主机，MediaCrawler Sidecar 改为 Colima/Docker；容器内使用 Chromium、Xvfb 和 x11vnc。scripts/dev.mjs 仍保留宿主机 uvicorn Sidecar 入口，不能把该变化扩大成所有本地开发入口都已容器化。
- 当前远程画面：前端 noVNC RFB 客户端，经 gateway WebSocket 转发到 Sidecar，再由 Sidecar 自研 TCP-WebSocket 桥连接 x11vnc。仓库没有引入 websockify。
- 目标桌面架构：现有最新前端 → Electron → 本地 Sidecar → Playwright 外部可见 Chrome → 人工登录 → 同一 profile 继续采集 → 结构化结果同步到现有业务后端。

当前仓库还没有 Electron package 或桌面主进程实现。本阶段不会创建它。

## 2. Git 取证与版本边界

### 2.1 保护性检查

调查开始时：

~~~text
branch: main
HEAD: 9060691cf96a61cffa151b998742bd03deb19919
working tree: 90 个 tracked modified，14 个 untracked，共 104 项
~~~

所有已有修改均视为用户修改并保留。调查仅使用 git status、git log、git show、git diff、git blame 和文本搜索；没有 checkout、reset、clean、stash 或生产代码修改。

已检查：

- AGENTS.md、README.md、frontend/README.md。
- package.json、frontend/package.json、backend/package.json、contracts/package.json。
- services/media-crawler/pyproject.toml、requirements.txt、SHENSI_UPSTREAM.md。
- deploy/compose.yaml、Dockerfile.shensi、部署和获客模块文档。
- 所有命中 media-crawler、douyin、desktop、novnc、Xvfb、VNC、live-sessions 的当前文件和 Git 历史。

仓库中没有 CONTRIBUTING*，也没有名为 docker-compose*.yml 或
docker-compose*.yaml 的文件；实际部署编排文件是 deploy/compose.yaml。

### 2.2 最后正常版本

git log -S "completed the operator's scan" -- docs/PROJECT_STATUS.md 证明，
该成功段落首次加入于 48b7140（2026-08-25，
feat(acquisition): decouple Douyin crawling from search APIs）：

- 2026-08-25，真实 QR 登录从本机可见 Chrome profile 到达抖音。
- QR 在已认证的 acquisition 对话框显示。
- 操作者扫码后，账号进入 active workspace account。
- 同一流程在 headless Chromium 中遇到验证页，所以本地运行明确选择 visible Chrome。
- 后续一次已授权真实本地采集保留了 305 条标准化记录、13 页，并投影出 13 个候选人。

这是 Git 能证明的最近一次“人工真实扫码成功”事件。该记录也明确说明登录检查本身没有发起采集、评论或私信动作；后续采集由单独的 run 操作启动。

7d8802c（2026-08-26，fix(acquisition): recover retained crawler results）
继承了同一段历史登录记录，并新增后续 305 条记录/13 页的 crawl
recovery 证据；它没有记录一次新的登录复测。c96bc06 是最后仍保留该原始
成功段落的提交，004d15e 随后改写了状态文档。因此不能仅凭 Git 断言
48b7140 之后的某个提交是“最后一次仍实际正常运行”的版本。

### 2.3 外部浏览器实现的演进点

- 572b29a（2026-08-25，fix(acquisition): restore real Douyin QR login）恢复本机可见 Chrome，配置为 headless=false、channel=chrome。
- 48b7140（2026-08-25）首次记录该外部 Chrome 路径的真实扫码成功事件。
- 6e277e9（2026-08-29，feat: complete real Douyin acquisition runtime）是最后一次实质修改浏览器、账号身份和真实采集实现的提交，仍保留外部可见 persistent context。
- 9060691（2026-08-30，当前 HEAD）是最后一个不含远程画面链的 clean snapshot。6e277e9..9060691 对 browser_state.py、accounts.py、crawl_jobs.py、app.py 及登录链的核心文件没有相关架构差异。

### 2.4 noVNC 引入点

以下 exact-string 历史搜索均没有返回引入提交：

~~~text
git log -S "live-sessions" --all
git log -S "noVNC" --all
git log -S "Xvfb" --all
git log -S "x11vnc" --all
git log -S "websockify" --all
~~~

git log -G "novnc|vnc|xvfb|live-sessions" --all 返回过两个文本命中，
但完整阅读对应 diff 后确认只是文档/编码内容的字符串误命中，不包含运行时
Xvfb/VNC/noVNC/live-sessions 实现。git show HEAD: 和 git grep HEAD
也确认 9060691 中不存在这些运行代码。当前相关行的 git blame 均显示
00000000 Not Committed Yet。

结论：不能给 noVNC 虚构一个 commit。准确范围是：

~~~text
9060691（不含远程画面链）
  ↓ 当前未提交工作区
Colima/Docker + Chromium + Xvfb + x11vnc + live-sessions + noVNC
~~~

## 3. 正常行为与稳定复现

### 3.1 正常情况下应如何运行

1. 用户在最新 acquisition 页面点击“连接抖音”。
2. 最新前端调用现有业务 API；业务后端调用本机 Sidecar。
3. Sidecar 为当前工作区创建独立、权限为 0700 的持久化 profile。
4. Playwright 在 macOS 用户桌面启动一个外部可见 Chrome 窗口，并用该 profile 打开 douyin.com。
5. 用户直接在真实 Chrome 中点击、刷新二维码、扫码或完成人工验证。
6. Sidecar 轮询同一 Context，以 localStorage HasUserLogin == "1" 作为第一登录信号，并继续提取和校验绑定账号身份。
7. 登录成功后关闭该登录 Context，使 profile 状态安全落盘；保留 profile，不上传 cookies。
8. 用户在最新前端执行“立即运行”或等待计划任务。
9. CrawlJobManager 校验 account handle 和 loginStateVersion，取得同一个 profile 的 lease。
10. MediaCrawler 在独立子进程中用同一 userDataDir 启动新的 persistent context；pong 再次验证登录状态，然后搜索视频、逐页采集评论。
11. Sidecar 输出结构化结果，现有业务后端继续入库、投影和刷新当前最新前端。

这里的“同一 Profile 继续采集”不等于复用同一个 BrowserContext。旧实现会先关闭登录 Context，再用同一个 userDataDir 在 MediaCrawler 子进程中创建新的 Context，从而避免 Chromium profile 被两个进程同时占用。

以上是当前 desktop 设计与 6e277e9 身份加固后的行为边界。48b7140 所记录的
实测版本只用 HasUserLogin 判定登录，并在真正开始 crawl、
resolve_crawl_profile 时才关闭登录 Context；不能把后来的身份加固行为
倒推成当时已经实测。

### 3.2 迁移前 remote 基线中 409 的稳定代码级复现

1. POST /api/v1/acquisition/social-accounts/douyin/login-sessions。
2. AccountManager.create_login_session 先保存 context=None、qr_status=opening、bootstrap_pending=true 的占位 session，并立即返回。
3. remote/noVNC 前端看到 awaiting_scan 后立即 POST /:sessionId/live。
4. bootstrap 线程尚未完成 BrowserState.open_douyin_login，也尚未把 opaque Context handle 注册到 session。
5. AccountManager.create_live_login_session 检查到 context 为空，抛出 douyin_login_session_not_interactive。
6. FastAPI 返回 409，Node gateway 映射为 douyin_login_session_not_ready。
7. noVNC 前端每 1.5 秒重试。
8. 如果 bootstrap 卡在前驱线程、Xvfb/x11vnc、Chromium 启动、导航或全局浏览器锁，短暂 409 就会成为长期 409。

remote 回归测试已经把第 2～7 步编码为预期行为，因此这不是推测；desktop 路径不会进入第 3 步：

- backend/src/acquisition-social-account-router-test.ts：验证 retryable context-not-ready 被保留为 409。
- frontend/src/acquisition/douyin-live-login.self-test.ts：验证 409 后的定时重试。
- services/media-crawler/tests/shensi_adapter/test_accounts.py：验证 create 在浏览器打开完成前返回、Context 可在 prepare 完成前注册，以及致命 prepare 失败会删除已注册 Context。

当时读取到的 .runtime 日志没有足够的 session/bootstrap/live 请求记录，不能据此断言某一次真实运行具体卡在 Xvfb、Chromium 还是导航。当前 desktop 路径通过结构化 `runtimeState`、`authState`、`taskState` 和受限 `diagnostic` 报告阶段，并从调用链上绕过该 409 条件。

## 4. 旧版完整调用链

下图以 48b7140 所记录、并在 7d8802c 中仍保持的实测实现为准。
6e277e9 的后续身份加固差异单独列在 4.4；它不是要求恢复旧前端。

~~~mermaid
flowchart TD
    F["旧 acquisition connect handler"] --> FC["DouyinAutomationController.connect"]
    FC --> FA["DouyinAutomationApi.createLoginSession"]
    FA --> BR["Backend social-account router"]
    BR --> BS["AcquisitionSocialAccountService"]
    BS --> BG["MediaCrawlerGateway.createLoginSession"]
    BG --> SA["Sidecar app.create_login_session"]
    SA --> AM["AccountManager.create_login_session"]
    AM --> P["创建 profiles/<随机 token>，0700"]
    AM --> BO["BrowserState.open_douyin_login"]
    BO --> IPC["douyin-browser 子进程 IPC"]
    IPC --> OC["_open_context"]
    OC --> PC["chromium.launch_persistent_context(profile_path, headless=false, channel=chrome)"]
    PC --> DU["外部 Chrome 打开 douyin.com"]
    DU --> U["用户点击/扫码/刷新/人工验证"]
    U --> POLL["_browser_worker poll"]
    POLL --> SIG["HasUserLogin == 1"]
    SIG --> BIND["随机 account handle + loginStateVersion=1"]
    BIND --> READY["session active；登录 Context 暂时保留"]
    READY --> RUN["业务 runNow/计划任务"]
    RUN --> HANDOFF["resolve_crawl_profile"]
    HANDOFF --> CLOSE["worker 关闭登录 Context，保留 profile"]
    CLOSE --> CJ["CrawlJobManager.start + ProfileLease"]
    CJ --> MR["MediaCrawlerRunner 子进程"]
    MR --> MC["DouYinCrawler 用同一 userDataDir 新建 persistent Context"]
    MC --> SEARCH["pong → search → batch_get_note_comments"]
    SEARCH --> RESULT["JSONL/结构化结果 → 后端入库与投影"]
~~~

### 4.1 前端到 Sidecar

以 48b7140/7d8802c 的实测链文件为准：

- frontend/src/acquisition/douyin-automation-view.ts：连接按钮调用 controller.connect。
- frontend/src/acquisition/douyin-automation-controller.ts::connect：创建登录 session；pollLogin 每 2 秒查询。
- frontend/src/acquisition/douyin-automation-api.ts::createLoginSession：POST /api/v1/acquisition/social-accounts/douyin/login-sessions。
- backend/src/acquisition-social-account-router.ts：HTTP 路由。
- backend/src/acquisition-social-account-service.ts::createLoginSessionIdempotently：工作区和幂等边界。
- backend/src/acquisition-mediacrawler-gateway.ts::createLoginSession：转发到 Sidecar。
- services/media-crawler/shensi_adapter/app.py::create_login_session：调用 AccountManager。

旧前端只显示返回的 QR 和登录状态；用户实际交互发生在外部 Chrome，而不是前端画布中。当前实现保留最新前端，只按能力改变交互表面和状态呈现，没有复制这套旧 UI。

### 4.2 浏览器启动、userDataDir 与登录判断

以 48b7140/7d8802c 为准：

- browser_state.py::_open_context（该版本 43 行起）是真正启动函数。
- 使用 playwright.chromium.launch_persistent_context(profile_path, ...)，不是 browser.launch，也不是 CDP attach。
- _launch_options 只传 headless 和可选 channel；trial 配置为 headless=false、channel=chrome。
- accounts.py::create_login_session（该版本 218 行起）创建 root/profiles/<secrets.token_urlsafe(24)>，权限 0700。root 由 app.py::create_deployment_account_manager 从 MEDIACRAWLER_PROFILE_ROOT 读取，并受 MEDIACRAWLER_ENCRYPTED_VOLUME containment 校验。在 6e277e9/9060691 的 real-trial 配置中，该绝对路径默认展开为 <repo>/.runtime/real-trial/state/mediacrawler-profile/profiles/<random-token>。launch_persistent_context 接收的就是该 session profile 绝对路径。
- _open_context 取现有页或新建页，打开 https://www.douyin.com/，尝试点击“登录”，等待二维码并返回 data URL；同时外部窗口已经可直接操作。
- _browser_worker 的 poll（该版本 141-155 行）遍历 Context pages，只检查 window.localStorage.getItem("HasUserLogin") == "1"。
- AccountManager.get_login_session（该版本 239 行起）在 active 时生成随机 account_handle、设置 loginStateVersion=1；没有 canonical identity 校验，也不会立即关闭 Context。
- 上游 MediaCrawler 的 media_platform/douyin/client.py::pong 先检查 HasUserLogin；若不为 1，再以 LOGIN_STATUS cookie 兜底。两者是 OR/fallback，不是同时必须满足。

### 4.3 登录后继续评论采集

- 实测版 accounts.py::get_login_session 生成账号 handle 和 version=1，但保留登录 Context。
- accounts.py::resolve_crawl_profile 校验 account handle/version，调用 _close_session 关闭登录 Context，再返回同一 profile。
- crawl_jobs.py::CrawlJobManager.start 获取 ProfileLease，并创建带 cancellation Event 的线程。
- crawl_jobs.py::MediaCrawlerRunner.__call__ 将 exact profile 写入 request.json，启动独立 Python 子进程。
- crawl_jobs.py::_execute_upstream 配置 PLATFORM=dy、LOGIN_TYPE=qrcode、CRAWLER_TYPE=search、ENABLE_CDP_MODE=false、HEADLESS、SAVE_LOGIN_STATE=true、USER_DATA_DIR=同一 profile。
- media_platform/douyin/core.py::start → launch_browser → pong；已经登录时跳过 DouYinLogin.begin，继续 search → batch_get_note_comments → get_comments → client.get_aweme_all_comments。
- Shensi capture wrapper 将作品、作者和评论写入结构化 JSONL，Sidecar page API 再交给业务后端入库和投影。

### 4.4 6e277e9 的后续身份加固

6e277e9 没有改变外部可见 launch_persistent_context 和同一 profile
续接采集的架构，但增加了：

- _extract_bound_identity_with_retry 和 canonical identity fingerprint。
- 非空、长度受限的 display name 校验。
- identity ledger 中递增的 loginStateVersion。
- active/identity terminal 后立即关闭登录 Context，采集时只复用 profile。

这些安全加固已由当前实现保留，但仓库没有一条后续真实登录复测记录能
证明这组 hardened 身份路径曾像 48b7140 记录的旧路径一样完成过人工扫码。

## 5. 迁移前 remote/noVNC 完整调用链

本节保留实施 desktop/local 竖切前的故障基线，供 Web remote 回归和历史取证使用。当前 desktop 调用链见第 5.6 节。

~~~mermaid
flowchart TD
    F["最新 acquisition 点击连接"] --> C["controller.connect"]
    C --> API["POST login-sessions"]
    API --> B["Backend router/service/gateway"]
    B --> S["Sidecar app.create_login_session"]
    S --> PH["AccountManager 立即返回 context=None 的 opening 占位"]
    PH --> BT["douyin-login-bootstrap 线程"]
    BT --> WAIT["等待所有 predecessor bootstrap"]
    WAIT --> IPC["BrowserState 全局 IPC 锁"]
    IPC --> W["_browser_worker open"]
    W --> VD["_start_live_display: Xvfb + x11vnc"]
    VD --> PC["launch_persistent_context: 容器 Chromium"]
    PC --> REG["Context handle + VNC port 注册"]
    REG --> PREP["prepare: 页面/截图/QR"]
    PH --> LIVE["前端立即 POST /live-sessions"]
    LIVE --> COND{"Context 已注册？"}
    COND -- "否" --> E409["409 → 1.5 秒重试"]
    COND -- "是" --> TOKEN["单次 noVNC token"]
    TOKEN --> WS["RFB → gateway WS → FastAPI TCP bridge → x11vnc"]
    PREP --> POLL["登录检测"]
    WS --> USER["用户在远程画面交互"]
    USER --> POLL
    POLL --> CLOSE["active 后关闭 Context/display，保留 profile"]
    CLOSE --> RUN["runNow/计划任务"]
    RUN --> CRAWL["同一 profile 的 MediaCrawler 子进程"]
~~~

### 5.1 迁移前逐函数调用链

登录创建与 Context 准备：

| 步骤 | 真实文件与函数 |
| --- | --- |
| 前端点击 | frontend/src/acquisition/douyin-automation-view.ts::mountDouyinAutomationView 的 connect event handler |
| 前端控制器 | frontend/src/acquisition/douyin-automation-controller.ts::connect |
| Browser API | frontend/src/acquisition/douyin-automation-api.ts::createLoginSession |
| 业务 HTTP | backend/src/acquisition-social-account-router.ts 的 POST login-sessions route |
| 业务服务 | backend/src/acquisition-social-account-service.ts::createLoginSessionIdempotently |
| Sidecar gateway | backend/src/acquisition-mediacrawler-gateway.ts::createLoginSession |
| Sidecar HTTP | services/media-crawler/shensi_adapter/app.py::create_login_session |
| 占位 session | services/media-crawler/shensi_adapter/accounts.py::AccountManager.create_login_session |
| 异步启动 | accounts.py::_bootstrap_login_session |
| 浏览器 IPC | browser_state.py::MediaCrawlerDouyinBrowserState.open_douyin_login → _call |
| Context 创建 | browser_state.py::_browser_worker open → _start_live_display → _open_context → chromium.launch_persistent_context |
| Session 注册 | accounts.py::_bootstrap_login_session 将 opaque Context handle 写入 session |
| 截图/QR | BrowserState.prepare_douyin_login → worker prepare_login → _prepare_login_context → _capture_login_page |

live/noVNC：

| 步骤 | 真实文件与函数 |
| --- | --- |
| 挂载入口 | douyin-automation-view.ts::mountLiveLogin / mountDefaultLiveLogin |
| 前端 live client | frontend/src/acquisition/douyin-live-login.ts::mountDouyinLiveLoginPage |
| API | douyin-automation-api.ts::createLiveLoginSession |
| Backend | acquisition-social-account-router.ts live route → AcquisitionSocialAccountService.createLiveLoginSession → MediaCrawlerGateway.createLiveLoginSession |
| Sidecar | app.py::create_live_login_session → AccountManager.create_live_login_session |
| Token 领取 | app.py::_proxy_live_login_websocket → AccountManager.claim_live_login_session |
| RFB | douyin-live-login-entry.ts::mountRoutedDouyinLiveLogin 动态加载 douyin-rfb-runtime.ts::createDouyinRfb → noVNC RFB → gateway WebSocket → app.py::_proxy_live_login_websocket → x11vnc |

登录轮询：

~~~text
douyin-automation-controller.ts::pollLogin
→ douyin-automation-api.ts::getLoginSession
→ acquisition-social-account-router.ts GET login-sessions/:sessionId
→ AcquisitionSocialAccountService.getLoginSession
→ MediaCrawlerGateway.getLoginSession
→ app.py::get_login_session
→ AccountManager.get_login_session
→ BrowserState.poll_douyin_login
→ _browser_worker poll
→ _poll_login_context
→ AccountManager._finish_login_result
~~~

登录后的评论采集：

~~~text
DouyinAutomationController.runNow
→ DouyinAutomationApi.runNow
→ acquisition-douyin-automation-router.ts POST /plans/:planId/run-now
→ AcquisitionDouyinAutomationService.runNow
→ acquisition-application.ts::enqueueCrawlerJob
→ AcquisitionCrawlerWorker
→ MediaCrawlerGateway.startCrawlJob
→ app.py::start_crawl_job
→ CrawlJobManager.start
→ CrawlJobManager._execute
→ MediaCrawlerRunner.__call__
→ crawl_jobs.py::_execute_upstream
→ DouYinCrawler.start/search/batch_get_note_comments
~~~

### 5.2 迁移前前端与 API

- frontend/src/acquisition/douyin-automation-view.ts::mountDouyinAutomationView：连接按钮调用 controller.connect；当前工作区又用 mountDefaultLiveLogin/mountLiveLogin 将远程画面挂进最新 view。
- frontend/src/acquisition/douyin-automation-controller.ts::connect（当前约 377-414 行）：如果现有 session 已是 awaiting_scan + qrStatus=opening，会直接返回已完成 Promise，这解释了“重新连接没反应”的一个确定代码路径。
- frontend/src/acquisition/douyin-automation-api.ts：新增 live 和 interactions API。
- douyin-live-login-entry.ts：先读取 session surface；只有 `remote_canvas` 才动态加载 douyin-rfb-runtime.ts。后者导入 @novnc/novnc 并构造 RFB；`external_window` 在导入前返回外部浏览器提示。
- 未跟踪的 douyin-live-login.ts：POST live、设置 viewOnly=false、409 时每 1.5 秒重试；WebSocket 断开后需要手动 reconnect。
- backend/src/acquisition-social-account-router.ts：新增 /live 和 /interactions。
- backend/src/acquisition-social-account-service.ts::createLiveLoginSession：将 Sidecar token 转为同源 /douyin-live/<token>。
- backend/src/acquisition-mediacrawler-gateway.ts::createLiveLoginSession：转发到 Sidecar /internal/v1/douyin/login-sessions/<id>/live-sessions。

### 5.3 remote Session、Context 与 noVNC

- accounts.py::create_login_session（当前约 939-992 行）先注册占位 session，再启动 daemon bootstrap 后返回。
- accounts.py::_bootstrap_login_session（约 672-938 行）先等待所有前驱 bootstrap，再调用 BrowserState.open_douyin_login；只有 open 返回后才注册 Context handle，随后同步 prepare。
- browser_state.py::_browser_worker（约 2058-2336 行）持有 contexts 字典；open 时先 _start_live_display，再 _open_context(..., defer_auxiliary=true)，最后以 _ManagedLoginContext 包装 BrowserContext 和 display。
- browser_state.py::_start_live_display（约 640-704 行）在 Linux 为每个 session 启动 Xvfb 和只监听 loopback 的 x11vnc。
- browser_state.py::_open_context（约 1727-1807 行）仍使用 launch_persistent_context，但当前 trial 将 channel 设为空，因此是容器内 Playwright Chromium，不是宿主 Chrome。
- accounts.py::create_live_login_session（约 994-1032 行）在 Context 未注册、已关闭或正在关闭时抛 douyin_login_session_not_interactive。
- accounts.py::claim_live_login_session（约 1034-1049 行）pop token；token 是单次消费。
- app.py::_proxy_live_login_websocket（约 32-89 行）是仓内自研 TCP-WebSocket 桥，不是 websockify。
- scripts/real-trial-gateway.mjs 和 deploy/nginx/default.conf 转发 /douyin-live WebSocket。

### 5.4 remote 运行入口的关键变化

在 9060691：

- scripts/real-trial-runtime.mjs::trialSidecarCommand 直接在 macOS 运行 .venv/bin/uvicorn 或 uv run。
- scripts/real-trial-config.mjs 设置 MEDIACRAWLER_BROWSER_HEADLESS=false、MEDIACRAWLER_BROWSER_CHANNEL=chrome。

在当前未提交工作区的 real-trial/public-trial 默认入口：

- 宿主 Sidecar 启动路径被替换为 scripts/real-trial-sidecar-container.mjs。
- 该脚本经 Colima/Docker 启动 Linux Sidecar，宿主 127.0.0.1:5612 映射容器 8899。
- 配置强制 MEDIACRAWLER_BROWSER_DISPLAY=virtual、headless=false、browser channel 为空。
- Dockerfile.shensi 在 9060691 已经存在；未提交变化是新增 Xvfb/x11vnc、改用 xvfb-run，并让 real-trial 默认实际使用该容器。
- BrowserState 又为每个登录 session 启动一套 Xvfb/x11vnc，形成外层和会话级双虚拟显示。
- scripts/dev.mjs::runDevelopment 当前仍在 macOS 宿主执行 uv run ... uvicorn；它没有被该 real-trial 容器入口替换。

### 5.5 原有函数被删除、改写或包裹的位置

| 旧实现 | 当前未提交工作区变化 | 影响 |
| --- | --- | --- |
| scripts/real-trial-runtime.mjs::trialSidecarCommand | 已删除；startTrialRuntime 改为调用 real-trial-sidecar-container.mjs | Sidecar 从 macOS 宿主进程迁入 Colima/Docker |
| AccountManager.create_login_session | 从“同步打开浏览器、拿到 QR、注册 session 后返回”改为“先返回 opening 占位，再由 _bootstrap_login_session 异步打开” | create 与 live-sessions 之间产生确定竞态 |
| AccountManager._close_session | 原辅助函数已被删除；关闭流程拆为 _take_context_locked、_detach_session_locked 和 detached cleanup | 关闭路径更多，bootstrap/poll/interact 的失败语义不再一致 |
| browser_state.py::_open_context | 保留 launch_persistent_context，但增加 browser environment、代理、重试和 defer_auxiliary | Context 可先返回，页面准备/QR/截图改到后续 prepare |
| browser_state.py::_browser_worker open/poll/close | open 被 _start_live_display 和 _ManagedLoginContext 包裹；新增 prepare_login、interact、VNC port | 实际 Context 与 Xvfb/x11vnc 生命周期绑定 |
| MediaCrawlerDouyinBrowserState._call | 仍由单个 threading.Lock 串行 IPC，但命令集扩大到 prepare/interact/action | 慢登录命令会阻塞其他 Context；超时会 hard-stop 共享 worker |
| 旧前端 QR 状态展示 | 当前 view 通过 mountDefaultLiveLogin 动态加载未跟踪的 douyin-live-login-entry.ts/douyin-live-login.ts | 最新前端被 noVNC 画面包裹；不是旧前端被直接替换 |
| Backend login create/get | gateway/service/router 增加 live 和 interactions 路由 | 新增 Sidecar /live-sessions 及远程交互依赖 |

登录成功后的 AccountManager.resolve_crawl_profile、ProfileLease、
MediaCrawlerRunner 和 _execute_upstream 主干仍保留；迁移不需要重写采集数据链。

### 5.6 当前 desktop/local 完整调用链

~~~mermaid
flowchart TD
    UI["当前 acquisition 连接按钮"] --> CTL["DouyinAutomationController.connect"]
    CTL --> API["POST login-sessions"]
    API --> BE["Backend router → service → gateway"]
    BE --> KEY["workspace 派生稳定不透明 account_key"]
    KEY --> APP["Sidecar app.create_login_session"]
    APP --> AM["AccountManager 业务 session"]
    AM --> LM["LocalBrowserSessionManager.start_login"]
    LM --> LEASE["同 account/profile 的 process-safe ProfileLease"]
    LEASE --> WORKER["session-scoped worker"]
    WORKER --> CHROME["launch_persistent_context / headed Chrome / stable profile"]
    CHROME --> USER["用户在外部窗口手动登录"]
    AM --> POLL["GET session / 显式重新检测"]
    POLL --> AUTH["HasUserLogin + canonical identity 校验"]
    AUTH --> CLOSE["关闭 Context/worker 后释放 ProfileLease，保留 profile"]
    CLOSE --> CRAWL["CrawlJobManager → 同 profile ProfileLease → MediaCrawler"]
    CRAWL --> RESULT["结构化结果 → 现有后端与最新前端"]
~~~

当前边界：

- 后端从 workspace ID 以 SHA-256 派生 64 位十六进制不透明 `account_key`，仅放入后端到 Sidecar 的私有 login-create body。公开响应、日志和前端均不包含 account key、profile path、cookie 或 user-data-dir。
- Sidecar 对该 key 再做域分隔哈希，稳定映射到权限受限的 profile。登录 Context 整个存活期持有同一把 process-safe `ProfileLease`；关闭 Context 和 worker 真正完成后才释放。crawl/action 取得同一 lease，因此同一个 userDataDir 不会并发打开。
- `LocalBrowserSessionManager` 按 account 管理 generation、session-scoped worker、Context 和取消。registry/account lock 只保护短内存操作，不包围浏览器 I/O；取消先使 generation 失效并请求 abort，迟到 open 只能关闭自己创建的旧 Context，不能覆盖或关闭新 generation。
- public session 将一个粗粒度状态拆为 `runtimeState`、`authState`、`taskState`，并附带 `interactionSurface`、受限 `diagnostic`、`screenshotAvailable` 和 `qrAvailable`。desktop 固定 `external_window` 且后两项为 false；旧数据库缺失 surface 的行仅按 `remote_canvas` 兼容。
- 当前最新前端的 runtime adapter 在 `external_window` 下只轮询、重新检测和取消；不调用 live API、不 mount noVNC、不发送截图交互。直接 live route 也先读取 session，只有 `remote_canvas` 才动态加载 `douyin-rfb-runtime.ts` 并申请 token。
- 业务后端取消登录时先在仓储中以 workspace、public session、lease owner 和 fencing token 原子取得持久取消租约，再调用 Sidecar DELETE。成功只允许同一 fence 删除 session，失败只允许同一 fence 恢复 opening；迟到的 GET/DELETE 和另一客户端创建的 replacement 不能越过该 fence。
- 页面卸载期间的前端 DELETE 使用 `keepalive`，并把尚未确认完成的 opaque login session ID 放入本地清理队列；下次加载账户前重试。该队列只保存随机 session ID，不保存账号 key、profile、cookie 或凭据。
- Web `remote_canvas` 仍保留 Xvfb/x11vnc、单次 live token、gateway WebSocket 和 noVNC，不因 desktop 迁移而删除。
- Electron 仍未实现。当前 desktop/local 是宿主 Sidecar + 外部 Chrome 的竖切，并非已打包的 macOS 应用。

## 6. Context 所有权、关闭权、锁与取消

### 6.1 Context 所有权

| 职责 | 旧版 | 迁移前 remote 基线 | 当前 desktop/local |
| --- | --- | --- | --- |
| 实际创建者 | browser_state.py::_browser_worker → _open_context | 相同，但 open 前增加 _start_live_display | LocalBrowserSessionManager 的 session-scoped worker |
| 实际 BrowserContext owner | browser worker 子进程内的 contexts[handle] | 相同；value 变为 _ManagedLoginContext | local worker；manager 只持 opaque handle |
| display owner | 无 | _ManagedLoginContext，同时拥有 Context、x11vnc、Xvfb | 无远程 display；外部 Chrome 位于用户桌面 |
| 主进程所持对象 | opaque handle | opaque handle + vnc_port 等元数据 | generation + opaque local handle +稳定状态 |
| 业务生命周期 owner | AccountManager | AccountManager | AccountManager；浏览器生命周期委托 LocalBrowserSessionManager |
| profile lease owner | CrawlJobManager/ProfileLease | 相同 | 登录 manager 在 Context 全存活期持有；关闭后 crawl/action 再取得 |

下列位置是迁移前 remote 基线的实际关闭位置；Web 模式仍保留这些路径：

- browser_state.py::_open_context（约 1802-1807 行）：启动/导航失败时关闭刚创建的 Context。
- browser_state.py::_browser_worker close（约 2249-2256 行）：接收 handle 后执行 context.close 并从 contexts 移除。
- browser_state.py::_browser_worker finally（约 2326-2346 行）：关闭 worker 仍拥有的全部 Context。
- accounts.py::_cleanup_detached_session（约 412-428 行）及 bootstrap open/prepare 失败分支：通过 BrowserState.close 清理。
- accounts.py::_finish_login_result（约 1111-1165 行）：active 或 identity terminal 时取走并关闭 Context。
- accounts.py::get_login_session（约 1189 行起）：expiry/poll 异常路径 detach 并清理。
- accounts.py::interact_login_session：interaction 异常路径 detach 并清理。
- accounts.py::disconnect（约 1419-1451 行）：detach 后同步或异步清理。
- accounts.py::resolve_crawl_profile（约 1453-1487 行）：采集前关闭登录 Context，再返回同一 profile。
- accounts.py::close（约 1558 行起）：manager shutdown 清理所有 session 和 browser owner。
- browser_state.py::MediaCrawlerDouyinBrowserState._hard_stop（约 2503-2546 行）：命令超时或 IPC 故障时杀掉共享 browser worker；这一条会同时丢失该 worker 拥有的所有 Context。

### 6.2 锁

本条调用链没有全局 asyncio.Lock。

搜索到的 services/media-crawler/api/services/crawler_manager.py 中 asyncio.Lock 属于上游另一套 API manager，shensi_adapter 的真实采集链没有使用它。

remote 相关串行化为：

- AccountManager._lock：实例级 threading.RLock，保护 session/account/token registry。
- 每个 session 的 io_lock：threading.Lock，保护该 session 的 poll/interact/关闭交接。
- MediaCrawlerDouyinBrowserState._lock：实例级 threading.Lock；_call 在完整 open/prepare/poll/interact/close/action IPC 往返期间持锁，因此一个慢命令会阻塞所有登录 Context。
- identity ledger：fcntl.flock，保护跨进程版本账本。
- profile：ProfileLease 的非阻塞文件锁，防止同一 profile 并发打开。
- CrawlJobManager：threading.RLock 和每 job cancellation Event。
- bootstrap predecessor：虽然不是 Lock 对象，但新 session 会等待创建时捕获的所有活动 bootstrap 线程；一个卡死的旧 bootstrap 能级联阻塞后续全部登录。

### 6.3 取消

- 旧版和当前版 crawl job 均可取消：CrawlJobManager.cancel 设置 Event；runner 对子进程组发 SIGTERM，宽限后 SIGKILL。
- 旧版登录 session 可以通过 disconnect/DELETE 请求关闭 Context，但已经发出的同步 browser IPC open/poll 命令没有单 session 中断协议；必须等命令返回或走 BrowserState 超时/进程级 hard stop。因此“旧采集任务可取消”，不等于“旧登录命令可随时按 session 强制取消”。
- 前端 AbortController 只停止前端 fetch/timer，不能中断 Sidecar 中正在执行的同步 Playwright 命令。
- remote DELETE 会立即从 registry detach；如果 bootstrap 仍活着，只能设置 cleanup_pending，等阻塞的 open/prepare 返回后再清理。
- BrowserState 单条 IPC 命令不可按 session 取消；超时会 _hard_stop 整个共享 worker，影响所有 Context。
- noVNC token 单次消费；RFB 断开必须申请新 token。
- desktop/local 的取消由 LocalBrowserSessionManager 先提升 account generation、移除 current，再对该 session 的专用 worker 发 abort。旧 open 即使迟到也只能处置自己的 Context；ProfileLease 在 open/close 真正返回前不会释放。
- 业务后端以持久 cancellation fence 串行化 DELETE 和 replacement；普通重复连接幂等复用当前 external session，显式取消成功后才允许创建 replacement，取消失败不得越过 fence 新建。

## 7. 截图与二维码为何依赖 Context

需要区分旧版、当前最终工作区和无法取证的中间未提交状态：

### 7.1 旧版

9060691 的 _open_context 同步创建 Context、打开页面、提取 QR 后才返回。QR 捕获是 session 注册前的硬前置；该阶段失败会关闭 Context。

### 7.2 Web remote 工作区

remote `_open_context` 使用 defer_auxiliary=true，先返回 qr_status=opening 且没有截图/QR。AccountManager 注册 Context 后再调用 prepare_douyin_login。因此在 Web remote 路径中：

- 截图/QR 不是 Context 创建和首次注册的前置条件。
- Context 反而是截图/QR 的前置条件，因为 _login_context_page 和 _capture_login_page 必须从 context.pages 取得仍打开、host 合法的页面。
- /live-sessions 若早于 Context 注册会返回 409。
- _capture_login_page 的截图异常可由 best-effort 包装吞掉，所以单次截图失败不一定终止 session。
- _prepare_login_context 只把部分 verification、UI unsupported、QR unavailable 错误降级为 opening/verification_required。
- 其他 prepare RuntimeError 会走 fatal 分支：detach session、关闭已注册 Context、删除 profile；随后前端可能只看到 session 404/expired，而不是原始 prepare 错误。
- poll/interact 的异常也会 detach、close、删除 profile；多数错误再被 Node gateway 泛化为 503。

无法通过 Git 重建未提交工作区曾经出现过的每一个中间补丁状态，因此不对“哪一轮开始把 QR 当成硬前置”作无证据推断。

### 7.3 当前 desktop/local

desktop 不采集或展示登录页截图、二维码数据，也不生成 live token。外部 Chrome Context 创建并登记即可进入可人工操作阶段；`screenshotAvailable=false`、`qrAvailable=false` 是能力声明，不是错误。用户直接在 Chrome 内刷新二维码或完成验证，Sidecar 只轮询登录与身份状态。

## 8. 迁移前根因、表面症状和已处理问题

### 8.1 有 Git 证据的架构回退根因

1. real-trial/public-trial 默认运行位置改变：本机 macOS Sidecar 被替换为 Colima/Docker Linux Sidecar；scripts/dev.mjs 的宿主开发入口仍存在。
2. 浏览器表面改变：宿主机外部可见 Chrome 被替换为容器 Chromium 的虚拟 framebuffer。
3. 控制链变长：直接操作真实浏览器变为 noVNC RFB → gateway WebSocket → FastAPI TCP bridge → x11vnc → Xvfb → Chromium。
4. profile 位置改变：登录发生在容器运行环境，不再天然等同于用户桌面和未来 Electron 本地 Sidecar 的 profile 生命周期。
5. display mode 当时未接线：app.py::deployment_browser_display 只验证 operator/virtual 后丢弃返回值；MediaCrawlerDouyinBrowserState 在真实 factory 未注入时仍无条件选择 _start_live_display。当前已由 runtime config 和 app factory 显式选择 local/remote manager。

这些结论足以解释为什么迁移前默认 real-trial 不再具备旧版“桌面外部 Chrome”
行为，也证明了 409 竞态和若干长期阻塞条件。当时运行日志不足以确认用户某
一次点击无反应究竟停在 Xvfb、x11vnc、Chromium、页面导航、predecessor
还是 BrowserState 全局锁；本文不把其中任何一个候选伪装成已证实的实例级
根因。

### 8.2 表面症状

- /live-sessions 409：请求到达时 session 尚无可交互 Context。
- 页面一直“正在启动”：bootstrap 没有完成 Context 注册，或注册后又因 fatal prepare 被删除。
- 画面可见但点击无反应：远程 framebuffer 控制链某一段没有正确传递输入；它不是 DOM 嵌入页面。
- 二维码失效、截图空白、network_error：可能是页面状态、截图/QR 准备或容器网络的下游结果，不能单凭 UI 文案确定根因。
- Chromium 顶部的 `--no-sandbox` 警告：Playwright Chromium 默认在 `chromiumSandbox !== true` 时追加该参数，容器/root 并非唯一触发条件；它不是“点击无反应”的充分根因，但在 macOS desktop 已通过显式启用 Chromium sandbox 消除。

### 8.3 迁移前未提交 remote 实现引入的问题

1. create 先返回 opening，占位 session 与 live 请求存在确定竞态。
2. 所有 bootstrap 前驱被串行等待，一个卡死 session 会拖住后来 session。
3. BrowserState 的单个全局线程锁串行化全部 Context 命令。
4. 单条命令超时会杀共享 browser worker，故障半径跨 session。
5. fatal prepare 失败删除 session/profile，但不保留可查询的 failed session 和完整阶段诊断。
6. 前端在 awaiting_scan + opening 时 connect 直接 no-op，用户点击“重新连接”可能没有任何动作。
7. live token 单次消费，RFB 断开后的恢复路径脆弱。
8. 错误在 Sidecar → gateway → router 传播时大量被泛化，原始阶段和错误码丢失。
9. 同时存在 noVNC 画面、截图交互和 QR 三种控制/观察表面，状态容易分叉。
10. Dockerfile 外层 xvfb-run 与 session 级 Xvfb 重复。

当前 desktop/local 已通过 session-scoped worker、generation、显式取消、process-safe ProfileLease、状态拆分和前端 runtime adapter 处理其中与本地路径有关的问题。以上条目继续作为 Web remote 的风险清单，不表示 desktop 仍经过该链。

## 9. 可复用的旧代码

以下是“提取边界和行为”，不是回滚整个文件：

| 可复用项 | 来源 | 复用方式 |
| --- | --- | --- |
| 本机 persistent context 启动 | 6e277e9 browser_state.py::_open_context、_launch_options | 保留 launch_persistent_context(profile_path, headless=false, channel=chrome) 的语义，移入新的 local 策略 |
| 每账号独立 profile | 6e277e9 accounts.py::create_login_session | 复用 0700 与受控根目录边界；当前 desktop 由稳定不透明 account key 派生稳定 profile，根目录由 Sidecar app data 提供，未来 Electron 只负责传入该根目录 |
| 登录检测 | 6e277e9 _browser_worker poll、_extract_bound_identity_with_retry | 保留 HasUserLogin + canonical identity 双重验证 |
| 账号绑定/version | 6e277e9 AccountManager.get_login_session | 保留 one-way account handle 和 loginStateVersion |
| profile 交接 | 6e277e9 AccountManager.resolve_crawl_profile | 登录 Context 关闭后再把同一 profile 交给 crawl |
| profile lease | 6e277e9 crawl_jobs.py ProfileLease | 防止登录、采集、动作并发打开同一 profile |
| MediaCrawler 子进程边界 | 6e277e9 MediaCrawlerRunner、_execute_upstream | 保留隔离运行、取消、deadline、结构化 JSONL 捕获 |
| 二次登录校验 | upstream client.py::pong | 保留先检查 localStorage、失败时以 LOGIN_STATUS cookie 兜底的 OR/fallback 语义 |
| 当前业务 API、幂等、账号隔离、最新 UI | 当前最新前后端 | 原样保留并做小范围能力分支，禁止用旧前端覆盖 |
| 当前动作安全边界 | 当前 action controls、authority revalidation、人工确认 | 必须保留；不能为了恢复登录而回退真实动作保护 |

## 10. 桌面模式不应继续复用的 noVNC 代码

以下代码保留给显式 web/remote 模式，但不进入 macOS desktop/local 执行路径：

- browser_state.py::_LiveDisplay。
- browser_state.py::_start_live_display。
- browser_state.py::_browser_worker 中无条件启动 live display 的 open 分支。
- MediaCrawlerDouyinBrowserState 中默认选择 _start_live_display 的 factory 逻辑。
- _ManagedLoginContext 中对 x11vnc/Xvfb 的所有权部分。
- AccountManager._bootstrap_login_session 当前的 predecessor 全局排队和
  prepare 编排；desktop local 不能原样沿用。
- AccountManager.create_live_login_session 和 claim_live_login_session。
- schemas.py::LiveLoginSessionView，以及 LoginInteractionRequest 在远程截图
  控制链中的职责。
- _capture_login_page、_prepare_login_context、_interact_login_context 作为
  远程画面/截图控制硬依赖的接线；local 模式可以保留非阻塞诊断，但不能把
  它们作为外部窗口 Context 存活的条件。
- app.py 的 /internal/v1/douyin/login-sessions/<id>/live-sessions。
- app.py 的 /internal/v1/douyin/live/<token> WebSocket 和 _proxy_live_login_websocket。
- app.py、backend 和 frontend 的 /interactions 远程截图交互链。
- frontend 的 douyin-live-login.ts、douyin-live-login-entry.ts、novnc.d.ts。
- frontend/src/app-entry.ts、app-route.ts 中的 standalone live-login route。
- frontend/src/replica-dashboard.css 中的 live-login canvas 样式。
- @novnc/novnc 的 desktop bundle 入口。
- frontend/package.json 和 pnpm-lock.yaml 中的 noVNC 依赖；迁移期保留，
  但 desktop local 路径不得加载它。
- scripts/real-trial-sidecar-container.mjs 的 desktop 启动职责。
- deploy/nginx/default.conf 和 real-trial-gateway.mjs 的 /douyin-live 转发。
- backend 的 live/interactions gateway、service、router、OpenAPI 接线。
- contracts/openapi/ai-acquisition.v1.yaml 的 live-session/interactions 合同。
- deploy/compose.yaml 的 virtual display 配置。
- Dockerfile.shensi 的 Xvfb/x11vnc 依赖及 xvfb-run entrypoint。

这些代码本阶段不删除。迁移时通过显式 mode/strategy 隔离：

不新增第二套互相冲突的环境变量。唯一运行选择继续使用当前
MEDIACRAWLER_BROWSER_DISPLAY，并明确映射：

~~~text
MEDIACRAWLER_BROWSER_DISPLAY=operator
  → desktop local strategy
  → LocalBrowserSessionManager
  → 宿主外部 Chrome

MEDIACRAWLER_BROWSER_DISPLAY=virtual
  → web remote strategy
  → 现有远程 session manager
  → Xvfb/x11vnc/noVNC
~~~

API 使用 interactionSurface=external_window|remote_canvas 表达客户端能力；
它不是第二个运行模式配置源。

## 11. 已实现的 LocalBrowserSessionManager 边界

LocalBrowserSessionManager 已成为 desktop 本地人工登录会话的浏览器生命周期入口，但不把 Playwright 对象暴露给 AccountManager：

### 11.1 职责

- 在 Sidecar 应用数据根目录下分配、校验和保留独立 profile；未来 Electron 只提供该根目录。
- 支撑由 AccountManager 持久化的 runtime/auth/task 分离状态机。
- 请求专用 Playwright worker 创建外部可见 Chrome Context。
- Context 创建并登记后立即返回可观察状态，不等待截图或 QR。
- 轮询 HasUserLogin 并做 canonical identity 校验。
- active 时关闭登录 Context，AccountManager 原子持久化 account handle、loginStateVersion 和 profile metadata。
- 将同一 profile 安全交给现有 CrawlJobManager。
- 每个阶段记录 sessionId、generation、stage、durationMs、stable errorCode；不记录 cookies、二维码或敏感页面内容。
- 支持按 session 取消；取消一个登录不能终止其他 session 的 browser worker。

### 11.2 明确不负责

- 不创建 Xvfb、VNC、noVNC token 或远程 WebSocket。
- 不把 Douyin 页面嵌入 Electron webview/iframe。
- 不持有业务数据库事实，也不上传 cookies/profile。
- 不触发评论或私信动作；登录和采集/动作授权仍是独立边界。
- Electron 只监督本地 Sidecar、显示状态和聚焦外部窗口，不成为 BrowserContext owner。

### 11.3 已固定的所有权

- 实际 Context owner：每个 local session 的专用 Playwright child/worker。
- 浏览器生命周期 owner：LocalBrowserSessionManager；业务 session owner 仍是 AccountManager。
- registry lock：只保护短内存操作，不包围浏览器 I/O。
- session command lock：每 session 一个；禁止全局 browser I/O 锁。
- cancellation：manager 向专用 worker 发 terminate，超时只杀该 session worker。
- profile 锁：登录 Context 全存活期由 manager 持有 process-safe ProfileLease；关闭 worker/Context 后释放，crawl/action 才能获取同一 profile。

专用 session worker 把 Playwright 同步阻塞、崩溃和超时的故障半径限制在单账号会话。当前实现保留该边界；若以后改为共享 worker，必须先证明每 Context 独立取消和无全局 I/O 锁。

## 12. 已修改的准确文件与剩余范围

以下是当前 desktop/local 竖切实际涉及的文件边界；这不是要求恢复旧文件或继续扩展 noVNC。

### 12.1 已新增

- services/media-crawler/shensi_adapter/local_browser_session_manager.py
- services/media-crawler/shensi_adapter/profile_lease.py
- services/media-crawler/shensi_adapter/runtime_config.py
- services/media-crawler/tests/shensi_adapter/test_local_browser_session_manager.py
- services/media-crawler/tests/shensi_adapter/test_desktop_runtime_integration.py
- services/media-crawler/tests/shensi_adapter/test_runtime_config.py

### 12.2 已修改 Sidecar

- services/media-crawler/shensi_adapter/browser_state.py
  - 提取 local/remote browser strategy。
  - local 策略不调用 _start_live_display，使用外部 visible Chrome。
  - 将 local session 故障隔离到专用 worker。
- services/media-crawler/shensi_adapter/accounts.py
  - 依赖 session-manager 接口。
  - operator/local strategy 不创建 live token，不等待 bootstrap predecessor，不把截图/QR作为成功条件。
  - 保留账号身份、version、profile handoff 和现有动作安全边界。
- services/media-crawler/shensi_adapter/app.py
  - 将 deployment_browser_display 的结果真正传入 factory。
  - 按 operator → local、virtual → remote 的唯一映射选择 manager。
  - 保留 remote live routes，但 local response 明确声明 external_window。
- services/media-crawler/shensi_adapter/schemas.py
  - 增加向后兼容的 interactionSurface/capability 字段，避免前端猜运行模式。

### 12.3 已修改合同和现有业务后端

- contracts/openapi/ai-acquisition.v1.yaml
- contracts/test/openapi.test.mjs
- backend/src/acquisition-mediacrawler-gateway.ts
- backend/src/acquisition-mediacrawler-gateway-test.ts
- backend/src/acquisition-mediacrawler-server-configuration-test.ts
- backend/src/server.ts
- backend/src/acquisition-social-account.ts
- backend/src/acquisition-social-account-repository.ts
- backend/src/acquisition-social-account-mysql-repository.ts
- backend/src/acquisition-social-account-service.ts
- backend/src/acquisition-social-account-router.ts
- backend/src/acquisition-social-account-test.ts
- backend/src/acquisition-social-account-router-test.ts
- backend/src/acquisition-openapi.ts
- backend/src/acquisition-openapi-test.ts
- backend/src/acquisition-openapi-contract-drift-test.ts
- backend/src/acquisition-openapi-response-conformance-test.ts

只透传 interaction surface 和稳定状态/错误；不改变工作区隔离、幂等或账号绑定模型。

### 12.4 已修改当前最新前端

- frontend/src/acquisition/douyin-automation-api.ts
- frontend/src/acquisition/douyin-automation-api.self-test.ts
- frontend/src/acquisition/douyin-automation-controller.ts
- frontend/src/acquisition/douyin-automation-controller.self-test.ts
- frontend/src/acquisition/douyin-automation-view.ts
- frontend/src/acquisition/douyin-automation-view.self-test.ts
- frontend/src/generated/ai-acquisition.ts
- frontend/src/acquisition/acquisition-browser-runtime.ts
- frontend/src/acquisition/acquisition-browser-runtime.self-test.ts
- frontend/src/acquisition/douyin-live-login-entry.ts
- frontend/src/acquisition/douyin-live-login-entry.self-test.ts
- frontend/src/acquisition/douyin-rfb-runtime.ts
- frontend/src/acquisition/runtime.ts
- frontend/src/acquisition/runtime.self-test.ts

已固定的要求：

- 基于当前文件增量修改，不复制或恢复 48b7140 的旧页面。
- interactionSurface=external_window 时显示“已在外部 Chrome 打开”“聚焦浏览器”“取消连接”和阶段状态，不 mount noVNC。
- interactionSurface=remote_canvas 时继续使用当前 noVNC 组件。
- 普通重复连接必须幂等复用当前 external session；显式取消/重新连接必须先完成旧 session 的 durable DELETE，再允许 replacement，取消失败不得创建新会话。

### 12.5 已同步的本地运行与文档

- scripts/real-trial-config.mjs
- scripts/real-trial-runtime.mjs
- scripts/real-trial-sidecar-container.mjs：仅保留 virtual/remote 责任，不作为 operator/local launcher。
- scripts/real-trial-config.test.mjs
- scripts/real-trial-runtime.test.mjs
- scripts/real-trial-sidecar-container.test.mjs
- tools/mediacrawler-deployment.test.mjs
- services/media-crawler/SHENSI_UPSTREAM.md
- docs/ARCHITECTURE.md
- docs/PROJECT_STATUS.md
- docs/modules/acquisition.md
- docs/DEPLOYMENT.md
- docs/operations/real-customer-trial.md

运行入口边界必须固定：

- pnpm trial:start 和 pnpm trial:publish 是公网/real-trial，继续默认
  MEDIACRAWLER_BROWSER_DISPLAY=virtual，即 web remote，不因桌面迁移改成
  operator。
- 当前 scripts/dev.mjs::runDevelopment 已是宿主 Sidecar 入口，可作为
  operator 集成验证入口；若其现有职责不适合桌面验收，再新增独立的
  desktop-local launcher，而不是复用 public trial 容器入口。
- 未来 Electron 只启动 operator/local 路径。

README.md、frontend/README.md、docs/ARCHITECTURE.md、docs/PROJECT_STATUS.md、docs/modules/acquisition.md 和 services/media-crawler/SHENSI_UPSTREAM.md 已同步 desktop/web 边界。公网 trial 仍是 web/remote；Electron、签名和打包文档只有真正实现后再补。

## 13. 实际回归测试、RED 证据与人工验收

### 13.1 已实现的 Sidecar 测试（至少 20 项）

以下名称来自当前测试文件，不是计划项：

| # | 测试名称 | 覆盖行为 |
| --- | --- | --- |
| 1 | `test_start_login_registers_an_operable_context_without_qr_or_screenshot` | Context 可操作不依赖 QR/截图 |
| 2 | `test_each_account_gets_an_independent_private_stable_profile` | 每账号独立、稳定、私有 profile |
| 3 | `test_explicit_profile_path_is_supported_but_not_required` | 受控显式 profile 与默认派生 |
| 4 | `test_repeated_start_for_same_account_is_idempotent` | 同账号重复启动幂等 |
| 5 | `test_different_accounts_start_in_parallel_without_a_global_browser_lock` | 不同账号无全局 browser lock |
| 6 | `test_confirm_login_selector_failure_is_recoverable_and_keeps_context` | 身份选择器失败不误关 Context |
| 7 | `test_cancel_aborts_only_the_target_worker_and_invalidates_its_generation` | 取消隔离与 generation 作废 |
| 8 | `test_login_holds_cross_process_profile_lease_until_cancel` | 登录持有跨进程 lease |
| 9 | `test_cancel_releases_profile_lease_only_after_context_and_worker_close` | 真实关闭完成后才释放 lease |
| 10 | `test_concurrent_cancel_cleanup_cannot_release_lease_before_abort_finishes` | 并发 cleanup 不提前释放 |
| 11 | `test_cancel_keeps_profile_lease_until_in_flight_open_returns` | open-in-flight 返回前不释放 |
| 12 | `test_login_profile_lease_blocks_collection_until_context_closes` | 登录 Context 阻止同 profile 采集 |
| 13 | `test_profile_lease_conflict_is_reported_as_recoverable` | lease 冲突为可恢复诊断 |
| 14 | `test_cancel_aborts_before_graceful_close_when_poll_holds_command_lock` | poll 阻塞时先 abort |
| 15 | `test_close_session_is_bounded_when_poll_holds_command_lock` | close 有界，不被 I/O lock 永久卡住 |
| 16 | `test_cancel_during_blocked_factory_does_not_hold_the_account_profile_lock` | 阻塞 factory 不占 account/profile 内存锁 |
| 17 | `test_shutdown_is_bounded_while_browser_factory_is_blocked` | shutdown 有界 |
| 18 | `test_late_open_cannot_overwrite_replacement_session_or_close_new_context` | 迟到旧 open 不污染新 generation |
| 19 | `test_close_session_is_idempotent` | exactly-once/idempotent close |
| 20 | `test_fatal_post_context_startup_error_cleans_worker_resources` | 注册后致命启动错误清理 |
| 21 | `test_asyncio_cancelled_error_is_not_converted_to_a_failure` | CancelledError 保持取消语义 |
| 22 | `test_authenticated_profile_is_retained_and_reused_for_collection` | 认证 profile 保留并交给采集 |
| 23 | `test_same_account_reuses_profile_after_manager_restart` | manager 重启后稳定复用 |
| 24 | `test_shutdown_closes_every_owned_context_and_worker` | shutdown 无 Context/worker 泄漏 |
| 25 | `test_logs_and_diagnostics_never_expose_credentials_qr_cookies_or_profile` | 日志与诊断不泄密 |

同一回归面还包括：

- `test_external_browser_state_disables_live_display_by_configuration`：desktop 不启动 live display。
- `test_macos_external_login_enables_the_chromium_sandbox` 与 `test_web_or_non_macos_launch_keeps_existing_sandbox_behavior`：macOS 外部窗口消除 `--no-sandbox`，Web/Linux 保持现有行为。
- `test_external_login_poll_does_not_depend_on_qr_or_page_capture`：登录轮询不依赖 QR/截图。
- `test_account_manager_exposes_external_surface_and_stable_profile`：业务 session 暴露 external surface 且 profile 稳定。
- `test_external_disconnect_cleanup_never_deletes_reused_stable_profile`：断开不删除稳定 profile。
- `test_external_action_for_one_account_does_not_block_another_login`：不同账号可并行。
- `test_deployment_desktop_mode_wires_session_scoped_visible_workers`：部署工厂实际注入 local manager。
- `test_open_login_context_blocks_crawl_and_action_for_the_same_profile`：login/crawl/action 共用 process-safe lease。
- `test_virtual_runtime_preserves_the_web_remote_canvas_strategy`：Web remote/noVNC 保持。
- `test_authenticated_client_can_create_one_time_live_login_token` 和 `test_live_login_websocket_proxies_binary_vnc_and_consumes_token`：remote token/WebSocket 回归。

### 13.2 真实 RED → GREEN 证据

实现过程中先由确定性测试复现、随后修正的失败包括：

- Sidecar：blocked poll 无法及时 abort；bootstrap 注册前无法 abort；旧 bootstrap 关闭新 Context；lease root 类型错误；app 未注入 local manager；shutdown 超过 1 秒；并发 cleanup 在 abort 完成前释放 lease；open-in-flight 返回前释放 lease；ProfileLease 没有贯穿 Context 全存活期；macOS external 启动链没有传递 sandbox 运行面。ProfileLease 两项 RED 的实际失败均为预期 `ProfileLeaseBusy` 未抛出；sandbox 定向 RED 为 3 failed，修复后 3 passed，并由全量 551 项锁定。
- 前端：pending create 被 cancel 后立即 reconnect 产生两次 create；known-session DELETE 失败仍创建 replacement；late create 的 DELETE 失败被隐藏；pagehide/close 发生在 create 返回前会遗留迟到 session；卸载期 DELETE 失败被吞且无法重试；BFCache 的 `pagehide.persisted=true` 会永久关闭恢复后的 controller。修复后 controller/runtime/API 测试覆盖单次 replacement、迟到响应 fencing、可见错误、keepalive、持久清理重试，以及 BFCache 保活与普通 pagehide 清理分流。
- 后端：runtime config 有 3 个失败；gateway 错传 session ID、迟到相同 GET/delete fencing、Memory upstream mismatch 各失败；DELETE 恢复 opening 时 create 次数为 2；MySQL fake SQL 不兼容。修复后对应定向回归通过。

这些是开发过程的 RED 记录；不把后续全绿倒推为真实抖音认证成功。

### 13.3 已执行的自动验证

| 门禁 | 最终记录结果 | 备注 |
| --- | --- | --- |
| Sidecar `tests/shensi_adapter` | 551 passed / 25.59s | 增加 macOS Chromium sandbox 回归后，由最终独立全目录重跑确认 |
| frontend test | 57 项通过 | 包括 runtime adapter、controller 和 direct-route lazy noVNC |
| frontend typecheck | 通过 | 无跳过类型检查 |
| frontend build | 通过 | 仅有 bundle 大于 500 kB 的非阻塞警告 |
| contracts test | 99/99 通过 | OpenAPI 与生成类型一致 |
| backend acquisition | 1430 tests：1419 passed，11 skipped | 最终总回归通过；skipped 为测试框架报告，不冒充执行通过 |
| root `pnpm build` | 通过 | monorepo build 成功 |
| `pnpm test:trial-runtime` | 55/55 通过 | public trial/web 路径回归 |
| `node --test tools/mediacrawler-deployment.test.mjs` | 8/8 通过 | 部署边界回归 |
| root `pnpm lint` | 未执行成功 | 仓库没有 `lint` script；命令返回 `Command "lint" not found` |
| Python Ruff | 未执行成功 | 当前 Sidecar venv 未安装 Ruff；没有为本轮擅自新增依赖 |

本表记录本轮最后一次实际重跑；未列出或未执行的人工验收不得推定为通过。

### 13.4 已执行与未执行的 macOS 验收

已执行：在独立端口和独立 app-data 根启动宿主 Sidecar，真实启动 `/Applications/Google Chrome.app` 的 headed 进程；session 进入等待用户状态；重复 POST 幂等；DELETE 有界完成并关闭 Chrome；profile 权限与重启复用成立；调用和进程树不含 `/live-sessions`、Xvfb、x11vnc、websockify 或 noVNC。最终进程参数也不再含 `--no-sandbox`。

未执行：宿主验收时 macOS 处于锁屏状态，无法直接点击页面或观察二维码刷新；因此扫描有效二维码、完成真实账号认证、校验真实账号 identity、认证后以同一 profile 完成评论采集、Electron 重启与打包验收均未执行。目前不能宣称端到端抖音登录或评论采集已恢复。

## 14. macOS 迁移风险

| 风险 | 影响 | 控制 |
| --- | --- | --- |
| Chrome 与 Playwright 版本不匹配 | 启动失败或选择器行为变化 | 固定受支持 Chrome channel，启动时输出版本诊断 |
| Playwright 默认关闭 Chromium sandbox | macOS Chrome 显示 `--no-sandbox` 安全警告 | 仅 macOS `external_window` 显式 `chromium_sandbox=True`；Web/Linux 保持既有启动语义 |
| macOS 首次运行/自动化权限 | 窗口无法聚焦或系统提示 | 不依赖 AppleScript 完成登录；聚焦仅作可选增强 |
| App Sandbox/签名/notarization | Sidecar 或浏览器子进程无法启动 | Electron 打包阶段单独设计 helper entitlement；本阶段不打包 |
| 多 profile 并发 | profile 锁损坏 | 每 profile 独占 lease，禁止两个 Context 同时打开 |
| Sidecar 崩溃 | 残留 Chrome/worker | 当前以进程组 abort 和 shutdown 清理活 worker；后续增加 terminal reaper 和 orphan metadata 启动清理 |
| terminal handle 保留（P2） | 长运行进程中 session metadata 持续累积，但不持有活 Context、worker 或 lease | 增加有界 terminal reaper/TTL；不得在仍有外层引用时提前删除 |
| default executor 非协作任务（P2） | 极端 browser factory/open 永不返回时，底层线程可能晚于 manager 生命周期 | 保持 child-process abort；后续改为显式受管 executor/worker join 与健康诊断 |
| cookie/profile 泄露 | 高风险凭据暴露 | 0700、本机存储、日志脱敏、永不上传业务后端 |
| 抖音页面/反自动化变化 | 登录状态检测失效 | HasUserLogin + cookie + identity 多信号；人工验证，不绕过 CAPTCHA |
| 外部窗口被用户关闭 | session 状态悬挂 | page/context close 事件立即转 failed/cancelled |
| 当前 virtual/remote 回归 | 公网演示受影响 | 显式 strategy、remote 回归测试、迁移期保留现有代码 |
| 恢复旧实现时误带旧前端 | 丢失当前业务功能 | 只提取函数语义；禁止 checkout/revert 整棵前后端 |

## 15. 分阶段实施顺序

### 阶段 0：本审计

- 冻结事实、commit 边界、调用链、所有权和验收标准。
- 已完成；Git 历史证据保留在第 2～4 节。

### 阶段 1：Sidecar 本机外部浏览器竖切

- 已新增 LocalBrowserSessionManager 和专用 session worker。
- 已接通 operator/local 策略，并保留 virtual/remote。
- fake Playwright、进程级测试和无认证外部 Chrome smoke 已完成；真实扫码未执行。

### 阶段 2：合同与最新前后端接入

- 已增加 interactionSurface 与 runtime/auth/task/diagnostic 能力字段。
- 当前最新前端已按 external_window/remote_canvas 分支。
- 未导入旧 UI；现有采集、候选人、审批、评论和私信页面保持当前版本。

### 阶段 3：同 profile 采集闭环

- 自动测试已验证 Context 生命周期、ProfileLease 和同 profile handoff。
- 尚需用 test-owned 目标完成真实认证后采集验收。

### 阶段 4：Electron 壳与本地监督

- 在前 3 阶段稳定后才新增 Electron。
- Electron 负责启动/健康检查/关闭本地 Sidecar、存放 app data、打开现有前端和聚焦外部 Chrome。
- 不嵌入抖音、不拥有 BrowserContext。

### 阶段 5：Web 远程模式隔离与回归

- noVNC 已由 runtime adapter 和 direct-route surface guard 限定在 virtual/remote feature path。
- 当前部署和 remote 回归保留；是否长期维护远程模式不属于本阶段。

## 16. 现有实际测试与构建命令

仓库当前定义的主要门禁：

~~~bash
./scripts/context-check
pnpm test
pnpm build
pnpm check:acquisition-contracts
pnpm test:trial-runtime
pnpm trial:verify
pnpm --filter ./backend test:mediacrawler-gateway
pnpm --filter ./backend test:acquisition
pnpm --filter ./frontend test
pnpm --filter ./frontend test:e2e
uv run --directory services/media-crawler pytest -q tests/shensi_adapter
git diff --check
~~~

迁移前审计实际执行的定向验证：

~~~bash
pnpm --filter ./backend exec node --import tsx --test --test-concurrency=1 \
  --test-name-pattern='live login route preserves a retryable context-not-ready conflict' \
  src/acquisition-social-account-router-test.ts
# PASS: 1/1

pnpm --filter ./frontend exec tsx src/acquisition/douyin-live-login.self-test.ts
# PASS: {"ok":true,"suite":"douyin-live-login"}

services/media-crawler/.venv/bin/python -m pytest -q \
  services/media-crawler/tests/shensi_adapter/test_accounts.py \
  -k 'login_session_creation_returns_before_browser_open_and_keeps_manager_responsive or registered_login_context_is_live_before_optional_prepare_finishes or fatal_prepare_failure_removes_registered_context_instead_of_leaving_live'
# PASS: 3 passed, 110 deselected
~~~

这些测试证明 remote placeholder/409/prepare 生命周期是代码设计出的行为；它们不等同于对当前真实抖音网络登录成功的验收。desktop/local 的较新验证见第 13 节。

## 17. 最小修改方案、副作用与验收标准

### 17.1 已采用的最小修改方案

第一刀在 Sidecar 内新增 operator/local strategy 和 LocalBrowserSessionManager，并让 app.py 使用统一 runtime mode 选择；保持现有 API 兼容，以测试证明外部 Chrome、同 profile、单 session 取消和 virtual/remote 回归。第二刀增加 interactionSurface、状态拆分和稳定不透明账号键，并增量修改当前最新前后端。两刀均已进入当前未提交工作区。

不采用“把 browser_state.py 整体恢复到 6e277e9”的做法，因为这会同时丢失当前身份约束、动作安全、私信能力、日志和现有最新前后端契约。

### 17.2 潜在副作用

- macOS operator/local 运行将真正弹出 Chrome 窗口；这是预期行为。
- 同一 workspace 多个登录会话会增加 Chrome 子进程和内存占用。
- local 与 remote 两套策略在迁移期并存，测试矩阵扩大。
- API 新增 capability 字段已同步 OpenAPI 和生成类型；以后修改仍需同步。
- 旧数据库 session 缺失 surface 时按 remote_canvas 兼容；其他旧 opening session 仍按既有过期/恢复策略处理。

### 17.3 验收标准

只有同时满足以下条件，才能声称“外部浏览器登录恢复”：

1. 当前最新前端点击连接后，宿主 macOS 外部 Chrome 可见且真实可交互。
2. 登录 session 建立不依赖截图、QR data URL、VNC 或 live token。
3. 用户可手动刷新二维码并完成验证；前端收到 active 和正确账号 identity。
4. 登录 Context 关闭后，同一 profile 被 MediaCrawler 成功复用并完成评论采集。
5. 一个 session 卡死/取消/超时不影响另一个 session。
6. operator/local 的进程和请求链不出现 Xvfb、x11vnc、noVNC、/live-sessions。
7. virtual/remote 原有回归测试通过。
8. 当前前后端功能、页面内容、账号隔离和动作二次确认均未回退。
9. 新增结构化日志能明确回答失败卡在哪个 stage；不再只显示 internal_error 或 409。
10. 所有定向测试、acquisition contracts、frontend test/build、Sidecar pytest 和 git diff --check 通过。

## 18. 后续准确范围

已完成的 local manager、runtime mode、合同、后端透传和最新前端分支不应重复实现。下一阶段只做以下闭环：

1. 在隔离、获授权的测试账号上，从当前最新前端点击连接，确认外部 Chrome 可点击并可手动刷新有效二维码。
2. 完成真实扫码或人工验证，核对前端 active、canonical identity 和 loginStateVersion；失败时只依据结构化 stage/diagnostic 定位。
3. 关闭登录 Context 后，用同一 profile 执行一次 test-owned 评论采集，验证 ProfileLease 顺序和结构化结果入库；不得把评论发送动作混入登录验收。
4. 重跑第 13、16 节全部门禁并记录最终数字，同时回归 Web remote/noVNC。
5. 只有上述闭环稳定后才新增 Electron supervisor、app-data 接线、打包、签名和 notarization。Electron 不嵌入抖音，也不拥有 BrowserContext。

禁止范围保持不变：不恢复 48b7140 的旧前端或旧业务后端，不删除 Web remote/noVNC，不绕过验证码或平台安全验证。

## 19. 阶段 1–2 当前工作区实施状态（未提交）

本节记录审计后的实施进度，不改写前述 Git 历史结论，也不构成真实抖音登录验收。

- `runtime_config.py` 已将 `SHENSI_RUNTIME_MODE=desktop|web` 作为统一模式入口；
  `desktop` 对应 `external_window`/operator，`web` 对应
  `remote_canvas`/virtual，冲突配置会在启动时失败。
- desktop 的私有数据根为绝对 `SHENSI_USER_DATA_DIR`，未配置时为仓库下已忽略的
  `.local-data/`；profile、状态和 crawl output 分目录保存。
- 两种模式的 API、业务 session、profile/identity 持久化仍统一由 `AccountManager`
  管理。desktop 将 `LocalBrowserSessionManager` 作为 BrowserState facade 注入；后者只拥有
  opaque local-session handle 后面的 worker 与 Playwright Context。它按账号串行 profile
  操作，支持 generation 防迟到结果、显式重新检测、取消与关闭；显式取消先使旧 generation
  失效并请求 worker 中止，不等待被 poll/close 占用的 worker I/O 锁。旧 worker 或旧业务
  session 不能删除稳定 profile，也不能关闭后来创建的 Context。
- `app.py` 已按运行模式为 `AccountManager` 选择 local facade 或原 remote browser；
  desktop 不启动 Xvfb/x11vnc/noVNC、不创建 `/live-sessions` token，也不依赖截图、
  DOM 或 QR prepare 才允许用户操作。`screenshot_available` 和 `qr_available` 固定为 false，
  web/remote 路径继续保留当前实现。
- 可信后端已从 workspace ID 派生稳定的 64 位十六进制 opaque account key，并只在
  私有 Sidecar login-create 请求中发送。Sidecar 再以域分隔哈希映射到稳定 profile；
  public OpenAPI 不包含 account key 或 profile path。登录 Context 关闭后，采集解析器
  复用同一 profile。
- public login session 已增加必需的 `interactionSurface`、`runtimeState`、
  `authState`、`taskState`、`diagnostic`、`screenshotAvailable` 和 `qrAvailable`。
  旧数据库 session 行缺少 surface 时按 `remote_canvas` 兼容，避免历史 Web 会话被误判
  为本地窗口。
- 当前最新前端已按 `interactionSurface` 选择 `LocalDesktopBrowserRuntime` 或
  `RemoteBrowserRuntime`。`external_window` 只显示外部窗口说明、重新检测和取消，不
  调用 live-session API、不加载 noVNC；`remote_canvas` 保留原登录画面和重连逻辑。
  直接访问 `#douyin-live-login?sessionId=...` 也会先读取 session surface；只有
  `remote_canvas` 才动态加载 noVNC 模块并申请 live session，`external_window` 不会走旧入口
  旁路。重复点击当前 external session 只复用现有 session，不创建第二个浏览器。
- action 执行的单进程互斥顺序固定为 action ID 后账号 ID，再进入 process-safe
  `ProfileLease`：同一 action 的重放和同一账号的外部写操作会串行，不同账号且不同 action
  可并行。desktop 的登录轮询也不再被无关账号的浏览器 I/O 全局阻塞。
- 诊断字段边界已在 Sidecar、后端、OpenAPI 和前端统一为 code 100 字符、message 500
  字符；浏览器端拒绝任何嵌套的 account key、profile path 或 user-data-dir 字段。

2026-09-03 最终在本机使用独立端口 `127.0.0.1:5913` 和独立
`.local-data/final-verification-20260903` 执行了不含账号登录的 desktop 进程冒烟：真实启动了
`/Applications/Google Chrome.app`，主进程使用 headed Chrome、启用 Chromium sandbox 和独立 64 位哈希 profile；
session 从 `starting/preparing` 进入 `running/waiting_for_user/idle`，截图与 QR 均为 false。
同一账号 key 的重复 POST 返回同一 public session；最终 DELETE 在 4.5ms 返回 204，随后查询为
404，Chrome 主进程退出且 0700 profile 保留。Sidecar 完整重启后，同一 key 再次使用了同一
profile inode 和路径。该调用日志只有 health/login create/get/delete，没有 `/live-sessions`；
该 profile 进程树没有 Xvfb、x11vnc、websockify、noVNC 或 `--no-sandbox`。宿主当时锁屏，
所以没有把“页面可点击、二维码可刷新”冒充为已执行的人工验收。

尚未完成的边界：Electron 主进程/Sidecar 监督、打包、签名和 notarization 均未开始；
本次也没有扫码、点击二维码刷新、完成真实账号认证，或在认证后用同一 profile 执行评论
采集。只有第 17.3 节全部标准通过后，才能宣称端到端外部浏览器登录与采集均已恢复。

## 20. 2026-09-05 外联动作桥当前阶段快照

本节只补充当前阶段，不改写上面的历史取证。后端已实现三道独立严格门及旧 Web/Trial
fallback，并在内部 Memory/MySQL 核心中完成 desktop claim/start/receipt、目标区分 sweep、
同设备重启只读 recovery 和 first-valid receipt 仲裁。recovery task 带完整不可变
ActionRequest 与原 lease/binding/login 快照；reconciliation-only capability 不能启动或写平台。
公开 desktop mutation 路由和生产 composition 仍属 Task 6，本文也没有新增 Electron/Sidecar
动作桥或真实抖音写入证据。因此这些自动化结果不构成部署、迁移、签名发布或 live acceptance。

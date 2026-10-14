# Shensi 桌面唯一入口与中心 API 迁移设计

## 1. 决策与交付边界

Shensi 的用户入口统一为 macOS 桌面应用。现有最新前端继续作为 Electron Renderer 构建，不恢复旧前端，不再维护供用户直接访问的本地网页或公网网页。

业务数据、认证、租户隔离、智能体、工作流、模型连接、CRM、获客审批、配额和任务状态仍由一个中心业务 API 与 MySQL 负责。需要访问用户本机抖音登录态的工作只在桌面应用内执行：Electron Main 管理本地 MediaCrawler Sidecar，Sidecar 管理 Playwright 外部可见浏览器、Profile、Cookie、采集、评论和私信。

当前没有云服务器，因此实施顺序固定为：

1. 在当前 Mac 上建立没有 Web 前端的 API-only 运行时；
2. 让桌面应用完成所有页面、登录、采集、评论、私信、智能体和业务数据的闭环；
3. 用自动测试模拟多设备认领、冲突、断线、恢复与幂等；
4. 在旧 Web 运行时完全停止的条件下完成单机冷启动验收；
5. 保留可回滚数据后，清理旧网页运行产物和公网隧道；
6. 购买阿里云资源后，把同一套 API、Worker 和数据库部署到阿里云，再进行真实多 Mac 验收。

本阶段不接入 Railway，也不把业务代码绑定到任何云厂商。未来阿里云只改变 API 部署地址、数据库连接和基础设施配置，不改变桌面前端、IPC、Sidecar 或抖音执行流程。

“开发完整”在阿里云上线前表示：单机桌面功能通过、中心 API 契约稳定、多设备行为通过确定性自动测试。真实异地同步、阿里云网络、RDS TLS、负载均衡和公网证书只能在阿里云资源存在后验收，不能由本机测试推定为完成。

## 2. 不在本次迁移中做的事情

- 不把完整 Backend、MySQL、Docker 或 Redis 打进 `Shensi.app`；
- 不让 Renderer 直接访问数据库或持有数据库密钥；
- 不上传抖音 Cookie、Profile、Sidecar token、Sidecar 端口或本地路径；
- 不在桌面路径使用 Xvfb、VNC、websockify、noVNC、`/live-sessions` 或远程浏览器画面；
- 不把 Web iframe/webview 作为抖音登录界面；
- 不在没有人工二次确认时发评论或私信；
- 不自动处理滑块、验证码或其他平台验证；
- 不在数据备份、回滚和桌面动作桥验收前删除旧运行时；
- 不删除 `frontend/` 源码。它是桌面 Renderer 的唯一最新前端源码；
- 不为了迁移全面升级 Electron、前端框架、MediaCrawler 或数据库驱动。

## 3. 目标架构

### 3.1 当前 Mac 开发与验收

```text
Shensi.app
├── Electron Renderer（frontend/dist-desktop）
│   └── 同源 /api
├── Electron Main
│   ├── 随机 loopback Renderer Server / API Proxy
│   │   └── 强制注入打包版本兼容标识
│   ├── DesktopOutreachActionCoordinator
│   └── SidecarProcessManager
│       └── 随机 loopback Sidecar
│           └── Playwright 外部可见 Chromium
│               └── 本机持久化 Douyin Profile
└── API Proxy → http://127.0.0.1:5608
                 └── API-only Gateway
                     └── Backend（容器内 4188）
                         └── MySQL（目标主机 3311，目标库 shensi）
```

API-only 运行时不启动 Web 前端、Cloudflare Tunnel、服务器 MediaCrawler、Xvfb、VNC、noVNC 或 WebSocket 画面。保留 `127.0.0.1:5608` 是为了兼容当前安装应用内的 `desktop-config.json`，后续开发构建仍通过配置注入同一个 API Origin。在阿里云 API 可用前，本机 API-only Gateway、Backend 与 MySQL 是由开发者/运维先启动并验证的后台前置条件；`Shensi.app` 是唯一用户界面，但它不负责把中心 Backend、MySQL 或 Docker 打进应用并自行启动。

### 3.2 未来阿里云生产

```text
多台 Shensi.app
├── HTTPS /api → 阿里云公网 API 域名
└── 本机 Sidecar → 本机 Playwright/Profile → Douyin

阿里云 HTTPS 入口
└── API Gateway / Reverse Proxy
    └── Backend + Durable Workers（私网）
        └── MySQL/RDS（私网、TLS、备份）
```

公网只暴露 HTTPS API。Backend 和数据库不直接暴露公网。建议保留一个固定的反向代理 hop，使现有可信代理、Origin、Cookie 和审计规则有可验证的单一边界；阿里云 SLB、WAF 或 CDN 只能放在该边界外侧，不能未经测试直接扩大 `TRUSTED_PROXY_CIDRS`。

## 4. 组件职责与所有权

### 4.1 Renderer

- 展示现有最新界面和全部业务模块；
- 业务读写继续使用同源 `/api`；
- 只通过 `window.shensiDesktop` 调用严格白名单的本地能力；
- 不接触 Node.js、文件系统、进程、任意 URL、Sidecar token/端口或 Profile 路径；
- 对评论和私信分别显示精确目标、精确内容、发送账号与独立二次确认；
- 只显示服务器确认后的耐久任务状态，不把浏览器点击当作中心数据已完成。

### 4.2 Electron Main

- 是 Sidecar 进程和本地动作协调器的唯一所有者；
- 验证 IPC sender、参数、任务能力、当前用户/工作区和协议版本；
- 持有设备安装标识、内存中的短期任务能力以及本地恢复日志；
- 从严格的 `Contents/Resources/desktop-build-manifest.json` 读取不可由 Renderer 覆盖的构建摘要，并注入 Renderer API 代理及 Main 直连中心请求；
- 启动、重启和关闭 Sidecar；
- 认领绑定到当前设备和抖音账号的中心任务；
- 把不可变动作请求交给 Sidecar，并把脱敏回执提交给中心 API；
- Renderer 崩溃不终止已安全认领的动作；应用退出会停止认领并有界关闭本地执行。

### 4.3 本地 Sidecar

- 绑定随机 `127.0.0.1` 端口，仅接受 Main 生成的 Bearer token；
- 管理一个账号 Profile 的非阻塞租约；
- 使用外部可见 Playwright Chromium 完成人工登录和验证；
- 执行精确且不可变的采集、评论或私信请求；
- 在唯一平台写点击之前写入耐久 `started` journal；
- 平台写结果不确定时只读对账，不自动二次点击；
- 返回脱敏状态与回执，不向中心 API暴露 Cookie/Profile。

### 4.4 中心 Backend

- 是用户、工作区、权限、数据、审批、配额、任务和回执的唯一业务权威；
- 运行现有智能体、工作流、模型路由、CRM、获客投影和后台恢复任务；
- 创建并冻结采集或外联意图；
- 按工作区、账号、登录版本、设备绑定和 fencing token 分发桌面任务；
- 在业务 mutation 与桌面设备/动作路由进入仓储前执行 `migration_locked|exact` 客户端兼容准入；构建摘要只防止旧客户端误用，不替代会话、CSRF、设备或任务能力认证；
- 只接受幂等、可审计且与当前租约匹配的结果；
- 不直接调用桌面 Sidecar，不持有抖音登录态。

### 4.5 MySQL

- 是多设备共享业务状态的唯一耐久数据源；
- 保存租户业务数据、任务、租约、审批哈希、回执和设备绑定；
- 不保存抖音 Cookie、浏览器 Profile、Sidecar token 或截图；
- 本地开发使用规范库名 `shensi`，未来通过加密逻辑备份迁移到阿里云 RDS/MySQL。

## 5. 功能迁移范围

桌面应用必须承载当前最新 Renderer 中所有可见模块，而不是只迁移获客页：

- 登录、注册、工作区和权限；
- 总览；
- 智能体、增长智能体、工作流和任务状态；
- 获客中心、候选人与证据、审批批次、评论与私信回执；
- 会话、客户私域、成交转化、话术、营销和设置；
- AI 模型连接、搜索连接、配置测试与密钥更新；
- 当前 Growth 路由及其中心 API 数据；
- 抖音账号登录、登录状态、计划、手动/定时采集、结果同步；
- 真实评论与真实私信的独立人工确认、本地执行和中心回执。

模块是否迁移完成以桌面冷启动后的真实路由/API 行为为准，不能以“前端文件已被打进应用”代替业务验收。

## 6. API-only 运行时

### 6.1 新入口

新增独立入口，避免继续扩展已经承担展示、隧道和虚拟浏览器职责的 Trial supervisor：

- `deploy/compose.api-only.yaml`
- `deploy/nginx/api-only.conf`
- `scripts/api-only-runtime.mjs`
- `scripts/api-only-runtime.test.mjs`

根 `package.json` 增加：

```text
api:start
api:stop
api:status
api:verify
```

API-only Gateway 固定监听 `127.0.0.1:5608`，只允许：

```text
GET /healthz  -> 200
/api/*        -> Backend
其他路径      -> 404
```

`/`、`/douyin-live/*`、`/live-sessions/*`、noVNC 静态文件和升级到远程画面的 WebSocket 都必须返回 404。API-only supervisor 先从当前容器引擎 IPAM 和主机路由中选择、校验并持久化一个项目独占的私网 `/24` 与 Gateway 地址；不得复用 Trial 的 `172.30.0.0/24`，也不得与 disposable、VPN 或其他项目重叠。Backend 的 `TRUSTED_PROXY_CIDRS` 从该 Gateway 地址精确派生，`CORS_ORIGINS` 为 `http://127.0.0.1:5608`。

本地停止命令只停止容器，不删除 volume，禁止在正常停止流程中使用 `docker compose down --volumes`。

### 6.2 Backend 运行角色

API-only 运行时首次建立时使用明确配置：

```text
CRM_STORE=mysql
DOUYIN_OUTREACH_ACTIONS_ENABLED=false
```

同时不提供 `MEDIACRAWLER_BASE_URL` 和 `MEDIACRAWLER_SERVICE_SECRET_FILE`，避免 Backend 误启动服务器 Sidecar 调用链。桌面动作桥先把当前耦合开关拆成三个职责明确的开关；在 disposable/fake 环境完成验证后，保留目标运行时的桌面执行开关为 `false`，直到只读迁移验收完成并进入不可逆写入激活事务：

```text
DOUYIN_OUTREACH_APPROVALS_ENABLED=true
DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED=false
DOUYIN_OUTREACH_DESKTOP_EXECUTION_ENABLED=false  # cutover_read_only
SHENSI_DESKTOP_CLIENT_ADMISSION_MODE=migration_locked
# SHENSI_DESKTOP_ADMITTED_BUILD_MANIFEST_SHA256 必须不存在
```

写入激活事务先消费一次性确认并停止只读运行时，再重验数据指纹、构建/网络身份、冷启动结果和动作桥证据；全部一致后，才原子持久化 `write_activation_pending`、`rollbackClosedAt` 与 `desktopClientAdmission:{ mode:"migration_locked", admittedBuildManifestSha256:null }`，永久关闭 Trial 回滚。随后才可把桌面执行开关切换为 `true` 并启动中心写运行时，但 Gateway 与 Backend 仍在仓储调用前拒绝所有 App 的业务 mutation、设备注册/绑定及动作 claim/complete/reconcile；写入验收只能使用监督器私有且不可由 HTTP header、Renderer、argv 或环境变量铸造的内部能力。终态 `accepted` 继续保留此锁，因此旧 `/Applications/Shensi.app` 不会在联合推广前误写。进入 `write_activation_pending` 后的失败只能在同一 attempt、同一构建/网络/数据指纹与同一证据上执行 `pnpm api:accept:resume` 向前恢复；不得重新生成或消费确认令牌，也不能回到 Trial。

每个 App 打包时生成规范化的 `desktop-build-manifest.json`，分别绑定最新 Renderer、Main、Sidecar、runtime config、架构与 bundle ID；其规范字节 SHA-256 与 App tree hash 分开记录，避免自引用。Electron Main 删除 Renderer 自带的同名 header，再强制注入 `X-Shensi-Desktop-Build-Manifest-SHA256`；Main 的设备 API 客户端注入同一值。最终联合里程碑只有在 `normal_activation_pending` 中打开正常 Gateway 的最后一步，才把 Backend/Gateway 同时切换为 `desktopClientAdmission:{ mode:"exact", admittedBuildManifestSha256:<当前候选> }`。重启从固定 active-version record 恢复这一值；回退到 prior set 必须恢复 `migration_locked`。该摘要不是秘密，也不能绕过任何业务授权。

审批开关只控制冻结草稿和创建动作；服务器执行开关只控制现有 `AcquisitionOutreachActionWorker`；桌面执行开关只控制桌面 claim/complete API。三者不能再通过是否配置 remote MediaCrawler gateway 相互推断。

现有 Backend 已承载智能体、CRM、模型连接、增长、财务与获客服务，不新增一个重复的“智能体服务器”。

### 6.3 Renderer Proxy 容量

`desktop/src/main/renderer-server.ts` 当前有有界请求/响应和超时限制。迁移验收必须盘点导入、报告、智能体长请求和流式响应的最大实际负载，并为这些已知 API 设置按路由的显式限制。不得用全局无限 body 或无限超时解决问题，也不得在未测试前认定现有限制覆盖所有模块。

## 7. 数据迁移与回滚

当前 Trial 库 `shensi_trial` 迁移到目标库 `shensi` 时使用现有工具：

- `scripts/backup.mjs`
- `scripts/migrate-data.mjs`
- `scripts/restore.mjs`
- `scripts/verify-data.mjs`
- `docs/DATA_MIGRATION.md`

固定步骤：

1. 停止 Trial Backend 和所有会写数据库的 Worker；
2. 对源库做加密、流式逻辑备份；
3. 记录源表清单、行数、稳定 ID 和迁移清单哈希；
4. 恢复到全新的空库 `shensi`，不复制 datadir，不直接改库名；
5. 验证表、行数、稳定 ID、密文身份和关键业务投影；
6. 用独立只读 MySQL 账号（仅 `SELECT`/`SHOW VIEW`）、`SHENSI_RUNTIME_READ_ONLY=true`、零后台 Worker 和拒绝 mutation 的只读 Gateway 启动 API-only Backend；登录只验证密码且不升级哈希；
7. 对目标数据做前后指纹校验，完成登录/工作区/全部模块只读验收；随后由一次性确认进入持久化的 `write_activation_pending`，先关闭 Trial 回滚，再切换写账号和正常中心运行角色，但保持桌面客户端准入 `migration_locked`，直至最终联合候选被精确准入；失败只能在目标库向前恢复；
8. 回滚窗口结束前保留 `shensi_trial`、加密备份、校验报告和旧 secrets。

不可逆边界之前的迁移失败不得先标成“已恢复”。监督器先原子进入非终态 `recovery_pending`，按同一 attempt 幂等停止失败目标并恢复、验证 Trial；只有 Trial 健康检查与原账号登录都通过后，才在一次原子状态写入中同时记录 `failed_recovered`、`activeRuntime:"trial"` 和恢复证据哈希。崩溃重试只能续跑该恢复，不能新建 attempt 或重复迁移。

必须原样保留所有数据解密和稳定身份所依赖的现有 secrets，包括 `PROVIDER_CREDENTIAL_KEY`、`AGENT_JOB_ENCRYPTION_KEY`、`ACQUISITION_MASTER_SECRET` 以及 JWT、cursor、idempotency、identity 类 secrets。密钥值不得进入代码、文档、命令参数或测试输出。

抖音 Profile 是设备本地状态，不随 MySQL 迁移。应用当前 Profile 保留在 Electron `userData` 下；服务器 Trial Profile 不自动复制到应用。无法证明账号和登录版本一致时必须由用户在应用中重新登录。

## 8. 桌面采集链

现有 `backend/src/acquisition-desktop-sync.ts` 和 `backend/src/acquisition-desktop-sync-router.ts` 已实现桌面采集意图、任务能力、claim、lease、分页上传、终态完成与中心投影。前端 `frontend/src/acquisition/acquisition-browser-runtime.ts` 已协调本地 Sidecar 和中心 API。

该链继续复用以下约束：

- `executionTarget=desktop` 与服务器 Worker 分队列；
- 工作区、运行、计划、账号、登录版本、任务能力和 fencing token 全部匹配；
- 结果按 cursor 与幂等键上传；
- 中心耐久完成后才调用本地 acknowledgement；
- stale lease、重放页或账号绑定变化立即停止；
- Profile/Cookie 永不上传。

## 9. 桌面评论与私信动作桥

### 9.1 当前缺口

当前评论/私信由 `backend/src/acquisition-outreach-action-worker.ts` 领取中心队列并通过 MediaCrawler gateway 调用服务器 Sidecar。Electron 的 `DESKTOP_CHANNELS`、`desktop/src/main/desktop-ipc.ts` 和 `desktop/src/main/sidecar-client.ts` 只有登录与采集方法。

因此关闭服务器 Sidecar 后，现状只能保存审批和显示 queued，不能执行真实评论或私信。新增动作桥之前不得停用旧动作执行链，也不得宣称桌面私信已迁移。

当前没有发现一把覆盖全部任务的全局 `asyncio.Lock`。现有并发边界是 MySQL 行锁与 `SKIP LOCKED`、Backend Worker 实例内 Promise 串行链、Sidecar 的每动作/每账号线程锁、Profile 跨进程文件锁，以及 AccountManager 的短期元数据 `RLock`。桌面迁移应复用这些细粒度边界，不新增一把会让所有账号互相阻塞的全局锁。

### 9.2 设备身份与账号绑定

首次启动生成随机 256-bit `deviceInstallationId`，保存在 Electron `userData` 的 owner-only 文件中；中心只保存其带域分隔的哈希。不得使用 MAC 地址、序列号或其他硬件指纹。

设备注册使用一次性 enrollment：已登录 Renderer 通过用户会话、CSRF 和工作区权限申请一个 60 秒单次 enrollment token，再通过窄 IPC 把它交给 Main。Main 直接向中心 API 换取长期设备凭据，并通过 Electron `safeStorage` 加密后写入 owner-only 文件；macOS 上其加密密钥由 Keychain 保护。长期凭据永不返回 Renderer。Main 每次重启另生成 `processInstanceId`，用于区分同一安装的旧进程。

中心社交账号新增执行绑定：

```text
executorMode = desktop
executorDeviceIdHash
executorBindingGeneration
executorLeaseExpiresAt
```

一次只有一个设备可以成为某抖音账号的动作执行者。重新连接、显式接管或登录版本变化会增加 `executorBindingGeneration`；旧设备即使仍在线也不能领取或完成新任务。

Electron Main 不能只依赖当前 `desktop-ipc.ts` 内存中的 `accountId -> handle/version` 映射。Sidecar 必须提供按安全 `accountKey` 查询已持久化登录身份的只读端点，Main 在启动、重启和认领动作前恢复并校验 handle、登录版本与 Profile 租约。

### 9.3 中心任务协议

新增经过认证、工作区隔离、CSRF/设备能力与幂等保护的最小端点：

```text
POST /api/v1/acquisition/desktop-installations/enrollments
POST /api/v1/acquisition/desktop-installations/register
POST /api/v1/acquisition/social-accounts/{accountId}/desktop-binding
POST /api/v1/acquisition/desktop-outreach-actions/claim
POST /api/v1/acquisition/desktop-outreach-actions/{actionId}/complete
POST /api/v1/acquisition/desktop-outreach-actions/{actionId}/reconcile
```

`enrollments` 与 `desktop-binding` 由已登录 Renderer 使用普通用户会话和 CSRF 调用；`register`、`claim`、`complete` 与 `reconcile` 由 Main 使用设备凭据调用。两条链都必须携带 Main 从当前 App 内嵌 manifest 计算并强制注入的构建摘要；`migration_locked` 时全部拒绝，`exact` 时只接受 active-version record 指定的摘要，然后仍完整执行会话/CSRF 或设备凭据校验。绑定只有在本地 Sidecar 返回当前账号 handle/login version 证明后才能建立；换机是显式 handoff，并增加 binding generation。

`claim` 使用有界长轮询或带抖动的有界轮询，一次只返回一个不可变动作：

```text
actionId
workspaceId
accountId
accountHandle
loginStateVersion
executorBindingGeneration
kind = comment | direct_message
canonicalTargetPublicUrl
content
approvedContentHash
deadlineAt
leaseVersion
taskCapability
predecessorReceipt（私信必需）
```

客户端不能改变 action kind、目标、内容、审批哈希、前序回执或配额。私信和评论分别需要页面二次确认；私信仍要求成功评论回执、DNC、限额和当前审批版本通过。

中心领取条件同时检查：

- 当前用户会话、工作区和权限；
- action 明确标记为 `executionTarget=desktop`；
- 账号 active、handle 已绑定且登录版本相同；
- 设备绑定和 generation 相同；
- action 状态、deadline、尝试次数和前序回执有效；
- 同账号没有另一有效执行租约；
- 内容哈希和目标 URL 仍与审批快照一致。

每次领取返回单调 `leaseVersion` 和不可伪造的任务能力。执行期限固定为 Sidecar action deadline 加上有界回传余量，不做会掩盖卡死任务的无限续租。正常完成和同进程对账必须同时匹配 action、workspace、device、process instance、binding generation、lease version 和能力哈希。Main 重启后不能拿新 `processInstanceId` 直接完成旧 fence；它只能提交本地耐久 journal 中的 action、request hash、原 lease/binding/login 版本和 phase，由中心核对原执行记录后为同一设备签发一个绑定新进程的只读 recovery fence。该 fence 只能观察/回传对账结果，不能再次执行平台写动作。claim 请求带幂等键；响应丢失后重放只能返回同一任务，不能领取下一条。

### 9.4 本地执行与回执

Electron Main 新增 `DesktopOutreachActionCoordinator`，职责为：

1. 仅在 Backend 会话、设备注册、Connector ready 和账号身份全部有效时认领；
2. 先把不可变 action、request hash、lease/binding/login 快照以 `claimed` 写入账号专属本地耐久 journal；
3. 用同一逻辑幂等键向中心提交 `{ event:"started" }`，只有中心成功将 `platformWriteAttemptCount` 从 0 保留为 1 后，才将本地 phase 耐久写为 `central_started`；
4. 仅在 `central_started` 已落盘后把不可变请求交给 `SidecarClient.executeDouyinAction()`；中心 started 失败时禁止调用 Sidecar；
5. 在固定执行期限内校验当前租约；所有权丢失时阻止尚未发生的平台点击；
6. Sidecar 返回终态后先耐久保存回执哈希，再提交脱敏回执；
7. 中心确认耐久完成后才确认 Sidecar journal 并清理 Main journal；
8. Renderer、网络或 Backend 短暂失败时保持受控恢复；
9. 应用退出时停止新领取；未 central-started 的任务在期限结束后可安全回队，central-started 任务保留等待只读对账。

Sidecar 的动作请求使用现有 action endpoint，但桌面启动协议必须显式允许本地动作；服务器环境变量不再决定桌面是否可以执行。真正授权来自中心冻结任务、任务能力、Main 白名单和 Sidecar 内容哈希校验四层共同结果。

动作状态分为：

```text
blocked_by_predecessor --(前序评论成功且回执精确匹配)--> queued
blocked_by_predecessor --(前序终态非成功)---------------> failed(predecessor_failed)
queued -> claimed -> executing -> succeeded | failed | risk_paused
                         \-> reconciliation_required
```

`blocked_by_predecessor` 只用于依赖评论回执的私信动作；在释放为 `queued` 前，任何 server/desktop claim 都不得看到它。前序评论失败或其他终态非成功结果必须原子地将依赖项标记为 `failed/predecessor_failed`，不能在 sweep 或清理时静默回队。

唯一平台写点击前，Sidecar 写入包含 actionId、请求哈希、账号/登录版本、目标哈希和 startedAt 的耐久 journal，不保存 Cookie 或完整消息内容。收到明确平台回执后写入 completed receipt。中心回执只包含 actionId、状态、平台回执引用、发生时间、允许的失败码和请求哈希。

如果平台点击可能发生但客户端没有得到确定回执，任务进入 `reconciliation_required`：

- 不自动重新点击；
- 仅允许同设备、同 Profile、同账号版本进行只读对账；
- 找到唯一匹配的公开评论/发出消息后提交成功回执；
- 无法唯一证明时保持人工处理，不把它自动改为 queued。

中心 `complete` 必须支持同一 action/fence/receipt 的幂等重放。当前 `completeActionSuccess/Failure` 对响应丢失后的相同 fence 重试会返回 false/409，实施时必须增加“已完成且回执哈希相同则返回 replayed success；回执不同则 conflict”的语义。

## 10. 多设备一致性

多台 Mac 可以同时查看同一工作区和中心数据，但同一个抖音账号在同一时间只有一台绑定设备执行浏览器动作。

- 中心账号绑定决定执行设备，不能用“谁先轮询到”代替；
- 每次接管增加 generation，旧 generation 的 claim/lease/complete 全部拒绝；
- action 通过数据库行锁、状态条件和 fencing token 原子领取；
- 进程退出或固定期限失效后，只允许未 started 的任务安全回队；
- started 且无终态的任务只能进入对账，不自动交给另一台 Mac；
- 每条平台写动作的最大自动执行尝试次数为 1；
- 断网、应用崩溃、Backend 重启和响应丢失分别有确定测试。

在阿里云上线前，使用两个独立临时 Electron `userData`、两个设备凭据和可控假 Sidecar 完成并发测试；上线后仍必须用两台真实 Mac 做绑定接管、冲突、断线和恢复验收。

## 11. 安全与隐私

- Electron Renderer 继续使用 `nodeIntegration:false`、`contextIsolation:true`、`sandbox:true` 和 `webviewTag:false`；
- Main IPC 只接受固定 schema，不接受任意 URL、路径、命令、选择器或脚本；
- Sidecar 仅绑定随机 loopback，token 通过 `0600` secret 文件传入；
- 中心设备凭据通过 Electron `safeStorage` 加密，macOS 上由 Keychain 保护；磁盘文件只保存版本化密文，另一个 owner-only 元数据文件只保存非秘密安装 ID 和协议版本；
- API 日志、应用日志和 Sidecar 日志统一脱敏 token、Cookie、密钥、完整私信、Profile 路径和账号原始标识；
- 真实发送必须保留独立二次确认、冻结哈希、目标链接、发送账号和审计人；
- 不提供验证码/滑块绕过、指纹伪装、隐藏浏览器或替代写路径；
- 模型只生成草稿，不获得平台写权限；模型厂商不影响本地确定性执行链。

## 12. 故障处理

| 故障 | 应用行为 | 数据行为 |
| --- | --- | --- |
| 中心 API 不可达 | 显示离线；本地登录页可关闭；停止领取动作 | 不产生中心写入，不执行新平台动作 |
| Sidecar 不可达 | 其他业务页继续可用；抖音能力显示暂停和重连 | 中心任务保持 queued 或安全释放 |
| Profile busy | 显示账号正在另一任务使用 | 未 started 任务按受控退避重试 |
| 设备租约丢失 | 停止未发生的平台点击 | stale fence 不能完成任务 |
| 写点击后断网 | 不自动重发；进入只读对账 | 保留本地 journal 与中心 reconciliation 状态 |
| Renderer 崩溃 | Main 保持安全执行/对账，重开窗口恢复展示 | 中心状态不由页面内存决定 |
| Backend 重启 | 客户端重新注册/续租；使用幂等键恢复 | 已完成相同回执可重放成功 |
| 协议版本不匹配 | 阻止动作并提示升级 | 不领取或完成不兼容任务 |

## 13. Web 运行时退役

退役分两步，不把“停止服务”和“删除源码”混为一件事。

### 13.1 停止与验收

在桌面评论/私信桥和所有模块通过后：

1. 停止 Trial frontend、Cloudflare Tunnel、Trial gateway 的 Web 路由和服务器 MediaCrawler；
2. 只启动 API-only Gateway、Backend、MySQL 与 `Shensi.app`；
3. 冷启动应用并完成完整验收；
4. 连续重启 API、应用和 Mac，确认没有隐式依赖旧进程；
5. 在 `cutover_read_only` 验收窗口保留 Trial 回滚命令；一旦进入 `write_activation_pending|accepted`，该命令立即 fail closed。只有迁移到 `accepted`、运行时退役回执完整、源码删除另获授权且零引用证明通过后，才在桌面功能/Web 退役计划的 Task 7 中删除其 alias、handler 和 Trial adapter；受保护数据与恢复证据继续保留。

### 13.2 清理

迁移状态已经是 `accepted`、受保护证据完整、桌面功能/Web 退役计划 Task 6 的精确清单经过单独授权后，才可以移动或归档：

- Trial PID、日志、临时 Tunnel 信息和 Web frontend release；
- 不再被任何入口引用的 cloudflared 本地二进制与缓存；
- 可重建的旧前端发布产物；
- noVNC/Xvfb/VNC/Web-only 源码应在单独删除任务中通过引用搜索、构建和回归测试后移除。

不得删除：

- `frontend/` 最新源码和桌面 Renderer 构建入口；
- 目标 `shensi` 数据库、源 `shensi_trial` 受保护恢复/取证归档、加密备份与校验报告；
- Electron `userData` 下的有效 Profiles；
- 当前 API、契约和桌面源码；通用备份/恢复/数据验证工具、不可变迁移证据与仍受单独授权保护的 GC/status readers。终态 `accepted` 后可按 Task 7 精确回执删除仅服务于 pre-accept 的 cutover/accept/resume alias、handler 与 Trial adapter，它们不属于此处必须永久保留的通用迁移工具。

## 14. 准确修改范围

### 14.1 API-only 运行时

- 新增 `deploy/compose.api-only.yaml`
- 新增 `deploy/nginx/api-only.conf`
- 新增 `scripts/api-only-runtime.mjs`
- 新增 `scripts/api-only-runtime.test.mjs`
- 修改根 `package.json`

### 14.2 中心动作分发

- 修改 `backend/src/acquisition-outreach-batch.ts`
- 修改 `backend/src/acquisition-outreach-batch-repository.ts`
- 修改 `backend/src/acquisition-outreach-batch-mysql-repository.ts`
- 修改 `backend/src/acquisition-outreach-action-worker.ts`
- 修改 `backend/src/acquisition-application.ts`
- 新增 `backend/src/acquisition-desktop-outreach-sync.ts`
- 新增 `backend/src/acquisition-desktop-outreach-sync-router.ts`
- 新增对应 Memory/MySQL repository、router、service 和恢复测试
- 修改 `backend/schema.mysql.sql`
- 修改 `backend/goodjob_crm.full.sql`
- 修改 `contracts/openapi/ai-acquisition.v1.yaml`
- 修改 `backend/src/acquisition-openapi.ts`
- 重新生成 `frontend/src/generated/ai-acquisition.ts`

### 14.3 Electron 与 Sidecar

- 新增 `desktop/src/main/desktop-build-identity.ts`，修改 `renderer-server.ts` 和 Main 直连中心客户端，统一注入不可由 Renderer 覆盖的 App 构建摘要；
- 修改 `desktop/src/shared/contracts.ts`
- 修改 `desktop/src/shared/validation.ts`
- 修改 `desktop/src/main/sidecar-client.ts`
- 修改 `desktop/src/main/desktop-ipc.ts`
- 修改 `desktop/src/preload/desktop-api.ts`
- 新增 `desktop/src/main/outreach-action-coordinator.ts`
- 新增对应 desktop tests 与 fake Sidecar 场景
- 修改 `services/media-crawler/shensi_adapter/app.py`
- 修改 `services/media-crawler/shensi_adapter/accounts.py`
- 修改 `services/media-crawler/shensi_adapter/action_jobs.py`
- 修改 `services/media-crawler/shensi_adapter/desktop_entrypoint.py`
- 修改对应 Sidecar tests

### 14.4 Renderer

- 修改 `frontend/src/desktop/desktop-bridge.ts`
- 新增桌面动作协调状态适配器及 self-test
- 修改 `frontend/src/acquisition/outreach-batch-api.ts`
- 修改 `frontend/src/acquisition/outreach-batch-controller.ts`
- 修改 `frontend/src/acquisition/outreach-batch-view.ts`
- 按共享控制器行为同步 `frontend/src/conversations/real-*`
- 只在证据表明需要时修改 `frontend/src/replica-dashboard.css`，不改变现有黑/绿风格和颜色

### 14.5 Web/Trial 与远程画面退役

- 新增中立的 process ownership 与 runtime environment helper，先迁出 API-only 仍需能力，再删除 Trial adapter/launcher；
- 仅在 `accepted`、运行时退役回执和源码删除授权齐备后，原子删除 pre-accept aliases/handlers，并保留 accepted-target、GC、备份/恢复和 Web-retirement 生命周期命令；
- 新增 source-retirement audit/one-use prepare/receipt 工具，绑定精确授权集、before/after manifest、零引用扫描、验证命令和未变运行时/数据身份；联合里程碑必须消费该精确回执；
- 删除 Renderer 的 noVNC、截图输入转发与 Web 登录路由，只保留最新桌面 Renderer 和 `LocalDesktopBrowserRuntime`；
- 删除 Backend 公网 login-session/live/interactions API 与 live repository writer，但保留历史兼容列/行、`/desktop-login-completions` 和业务 API；
- 删除 Sidecar Xvfb/VNC/live-token/remote-display 分支，保留内部 POST/GET/DELETE login-session、外部可见 Chromium、Profile、采集和动作；
- 删除旧 Web/Trial/Cloudflare/Baota 生产入口，保留 Electron-owned loopback dev/test fixture；
- 在证明桌面 PyInstaller/import 零依赖后删除 MediaCrawler 上游 `api/` 与 `webui/` 控制面，保留 `shensi_adapter`、核心爬取/存储/工具/脚本与 FastAPI/Uvicorn Sidecar 依赖；
- 修改 root/frontend lockfiles、CI、SQL snapshots、OpenAPI/generated client 和当前运行文档。

### 14.6 联合里程碑与 macOS 应用推广

- 新增 `scripts/desktop-milestone.mjs` 及测试，由唯一公开 coordinator 在独占 root 的固定 `backend/`、`gateway/`、`app/`、`evidence/` 子目录联合构建/绑定 Backend image、Gateway snapshot 与唯一 promotable run-scoped `Shensi.app`；Task 5 独立 `fixtureOnly:true` App 和直接低层 builder 不可推广；
- 修改 `scripts/api-only-runtime.mjs` 与 `deploy/compose.api-only.yaml`，支持 immutable image/config ref、maintenance/read-only 激活和 prior-version 恢复；激活 dry-run 经单独确认后生成一次性 token，首次服务变更前必须持久化 activation intent、进入 `services_activation_pending` 并消费 token；
- 新增 `deploy/nginx/api-only-maintenance.conf`，只允许绑定候选的读/健康验收路由并拒绝业务变更；`milestone-read-only` 验证必须同时核对该 snapshot、只读数据库主体、零 worker 与里程碑 journal 状态；
- 新增唯一的 `desktop:milestone:verify` 状态推进命令，亲自运行并绑定全部候选验收结果后才进入 `candidate_verified_pending_promotion`；新增 pre-swap `desktop:milestone:abort`，在用户拒绝继续时验证并恢复 prior set，避免 journal 永久锁住正常生命周期；
- 新增 `scripts/desktop-app-promotion.mjs` 及测试；
- 新增 `desktop/native/macos-app-swap.c`，用测试过的同一二进制执行 `RENAME_EXCL`/`RENAME_SWAP`；
- 修改 `desktop/scripts/package-macos-dir.sh`、desktop/root package aliases 与 build contract；
- 新增 owner-only、fsynced milestone/promotion journal、服务激活与 App 推广各自的一次性确认、逐阶段 intent/receipt 与 hash reconciliation；
- 联合 manifest 和角色 verifier 分别绑定不变的 `acceptedLiveSchemaHash`、当前 `bootstrapSchemaHash` 与双 schema 兼容报告，不把两种哈希误判为必须相等，也不在 accepted 数据库隐式执行 DDL；normal 角色固定验证 approvals=true、server=false、desktop=true、无 remote MediaCrawler 配置、精确 worker/route 集合，以及 Gateway/Backend 同时只准入候选 App 的 embedded build-manifest hash；此前 accepted/prior/abort/recovered runtime 必须维持 `migration_locked`；
- 在任何服务激活前，从“有完整 prior-version 兼容回执的当前安装版”或“Task 5 sealed evidence 加 API acceptance 绑定的 recovery-only App”中选出唯一 `verifiedRollbackSeed`；两者都不合格则阻塞。无兼容证据的旧安装版只能成为 `nonRollbackDisplacedApp`，在授权交易中完整隔离取证后移出 `/Applications`，绝不能直接成为 rollback；
- 将 Task 5 原始验收 manifest/reports、激活与 rollback 所需的 image/config/manifest/receipt/helper 证据复制到固定 content-addressed version/evidence root，并用私有 journal-capability 冷重启证明不依赖一次性 build root；
- 最终 `/Applications` 只保留当前应用和一份受保护 rollback，其他未归属产物只审计、不自动删除。

### 14.7 当前文档

- 修改 `README.md`
- 修改 `frontend/README.md`
- 修改 `docs/ARCHITECTURE.md`
- 修改 `docs/DEPLOYMENT.md`
- 修改 `docs/PROJECT_STATUS.md`
- 修改 `docs/modules/acquisition.md`
- 修改 `docs/desktop/macos-electron-client.md`
- 新增阿里云部署与多 Mac 验收文档，只在真实资源存在后填写实际域名、TLS 和 RDS 证据
- 文档切换分阶段提交真实状态：`accepted` 前当前 runbook 仍指向实际 Trial/Web；`accepted` 后可写 API-only 与动作桥服务能力已部署，但必须明确 `desktopClientAdmission=migration_locked`，安装版 App 在最终联合推广前不能业务写入或领取动作；只有 source-retirement receipt 完成后才可写 Web/noVNC 源码已移除，只有 milestone `finalized` 后才可写 `/Applications/Shensi.app` 被精确准入并可正常使用。
- Feature Task 8 对 `finalized` 后的最后一次当前文档同步负责：必须从固定 active-version record 写入非秘密的当前 admitted build-manifest digest，并由状态感知契约统一验证上述七份当前产品文档和 API-only runbook；若同步失败，只重试文档步骤，不重放推广或改动已验证运行时。

## 15. 测试与验收标准

### 15.1 自动测试

- API-only Gateway 只暴露 `/healthz` 和 `/api/*`；所有 Web/noVNC 路由为 404；
- API-only start/status/verify/stop 可重复执行，停止不删除数据库卷；
- 数据迁移验证表、行数、稳定 ID、密文和关键投影；
- 桌面 Renderer 所有当前路由在没有 Web frontend 时可加载并完成授权 API 请求；
- 注册、登录、退出、CSRF、Cookie 重写、工作区与租户隔离；
- 智能体、工作流、模型连接、CRM、获客和会话的核心 CRUD/状态流；
- 登录、采集和分页上传已有桌面链回归；
- 评论/私信 claim、lease、fence、binding generation、daily limit 和 predecessor receipt；
- 相同完成回执幂等重放，不同回执冲突；
- 两设备并发时只有绑定设备领取，同账号只有一个有效动作；
- `accepted` 到联合里程碑完成前，Gateway/Backend 均以 `migration_locked` 拒绝旧安装版、Task 5 App 和任意候选的业务 mutation/设备动作；最终正常角色只接受当前候选 embedded build digest，Renderer 伪造 header 会被 Main 覆盖；
- 接管后旧设备的 lease/complete 被拒绝；
- started 前断线可安全释放，started 后断线只进入对账；
- 假 Sidecar 证明每条动作最多一个平台写调用；
- app/Backend/Sidecar 重启后身份、任务和回执恢复；
- 日志和 API 响应不泄漏 secret、Cookie、Profile、完整私信或设备凭据；
- desktop build、typecheck、Sidecar suite、Backend suite、contracts suite、frontend suite 和 `git diff --check` 全部通过。

### 15.2 单机人工验收

旧 Web 运行时必须完全停止，随后从冷启动执行：

1. 启动 API-only runtime 与安装版 `Shensi.app`；
2. 注册一个新账号，退出并重新登录；
3. 逐一打开全部当前路由，验证真实中心数据而非 demo/空壳；
4. 新增并测试一个模型连接，不在页面或日志显示密钥；
5. 创建、编辑、运行并恢复智能体/工作流；
6. 打开外部可见抖音浏览器，人工扫码/验证并确认登录；
7. 执行一次采集，确认结果中心耐久后重启应用仍存在；
8. 在页面分别二次确认一条真实评论和一条满足前序条件的真实私信；
9. 保持成功页面和回执可见，确认平台结果后再关闭；
10. 断开网络、重启 Sidecar、重启 Backend、重启应用，验证故障文案和恢复；
11. 确认没有 frontend preview、cloudflared、服务器 Sidecar、Xvfb/VNC/noVNC 进程或 `/live-sessions` 请求。

真实评论和私信只在用户明确选择的测试目标和内容上进行一次，不由自动测试触发。

### 15.3 阿里云后验收

- 同一构建的两台 Mac 登录同一工作区并实时看到中心数据；
- 一台绑定抖音执行设备，另一台只读；
- 显式接管后旧设备无法领取或完成；
- RDS TLS、备份恢复、私网访问、SLB/代理来源、HTTPS Cookie 和证书续期通过；
- 公网 API 故障、网络抖动和响应丢失不造成重复评论或私信；
- 所有测试数据与真实租户严格隔离。

## 16. 分阶段实施顺序

### 阶段 1：API-only 脚手架与隔离验证

建立 API-only Compose/Gateway、运行时发现和受控命令；只在独立一次性数据库与端口上完成启动、代理、全模块 API smoke 和清理证明。不得在此阶段冻结 Trial、迁移真实数据或占用规范端口。

### 阶段 2：桌面动作桥（全假件）

先增加契约和中心数据库语义，再实现设备绑定与幂等领取/完成，然后实现 Main coordinator、Sidecar 身份恢复和动作调用，最后接入 Renderer 状态。所有自动验证使用假平台执行器，不进行真实评论或私信。

### 阶段 3：最新 Renderer 全模块闭环

逐路由替换仍依赖演示数据或 `localStorage` 的模块，验证认证、Cookie、请求大小/超时、智能体、工作流、模型连接、CRM 和获客数据；构建一次当前源码的 run-scoped `.app`，先通过冷启动 harness 单元测试，不生成 DMG/ZIP。

### 阶段 4：单独授权的数据迁移与只读切换

只有阶段 1–3 的前置证据全部通过后，才分别请求授权冻结 Trial、迁移真实数据、切换规范端口和打开当前源码的 run-scoped `.app`。`cutover_read_only` 中只允许唯一的 Task 5 owner coordinator 生成一次 run nonce，亲自执行前后两组 package/API/cold-start 检查并通过可见 packaged-App route adapter 遍历最新 Renderer 全部路由；App/Helper 关闭、身份未漂移且命令自有证据齐全后才能 seal，人工散落报告或手写 route result 不能补齐回执。先完成该只读冷启动与全模块验收，再单独授权恢复中心写运行时；终态 `accepted` 仍保持 App 客户端准入锁定，直到阶段 5 的联合推广完成。真实评论/私信还需各自页面二次确认。

### 阶段 5：安全清理与最终当前源码构建

保留数据恢复/取证资产，只清理已证明无引用的 Web 运行产物。Web/noVNC 源码删除作为独立、可审计任务执行。失败或已回滚的迁移目标卷只进入只读 GC 审计；真正 purge 必须针对精确集合另行授权，不能作为验收的隐式副作用。清理完成后，从稳定的同一源码快照离线构建一个 Backend/Gateway/App 联合候选，并在任何服务变更前选定与 prior Backend/Gateway/schema/contract 有完整回执绑定的唯一 rollback seed；无证据旧 App 不得入选。再通过有界维护/只读窗口启动候选 Backend，在 run-scoped 和安装版 App 都完成只读验收前持续禁止业务写入与 worker，并验证 MySQL 容器、卷、schema 和受保护数据未被构建流程破坏。替换 `/Applications/Shensi.app` 与随后跨过 `normal_activation_pending` 写入边界必须在同一明确授权中展示并绑定：边界前失败在 maintenance 下恢复并验证 prior Backend、原子安装已验证 seed（不是盲目恢复无证据旧 App），再以 prior Gateway 最后开放流量；边界后候选服务可能已写数据，只允许同版本向前恢复。正常 Gateway 最后打开时，Gateway/Backend 同时只准入候选 embedded build digest。成功后用固定版本记录完成一次无构建冷重启，`/Applications` 内只保留当前应用与一份已验证 rollback，不生成 DMG/ZIP。

### 阶段 6：阿里云部署

购买资源后部署同一 API/Worker 构建，迁移 MySQL/RDS，配置 HTTPS 和私网，更新应用 API Origin，完成两台真实 Mac 验收；之后才生成正式签名、公证和发布安装包。

## 17. 方案副作用与取舍

- 当前 Mac 在上云前仍需运行一个无界面的中心 API 和 MySQL；这是保留真实业务数据与未来多设备一致性的必要条件，不等于继续维护网页；
- 评论/私信动作桥比直接从 Renderer 调用 Sidecar 多一层租约协议，但它避免多 Mac 重复发送和响应丢失后的二次点击；
- 现阶段不把 Backend 打进 `.app`，因此安装包更小、升级边界清晰，也避免未来上云再拆一次数据库；
- 保留旧 Web/noVNC 源码到迁移验收后会暂时占用少量仓库空间，但比提前删除导致无法回滚更安全；
- 日常开发只运行 `desktop:dev` 和 API-only runtime，不生成新的 DMG/ZIP。只有阶段性安装验收或发布时才打包；自动清理仅限 owner manifest 精确列出且未被 active、rollback 或 evidence 引用的临时子路径，最终 run root 不整棵删除，固定的 version/evidence roots 持续保留；未归属旧产物必须先单独审计并获得授权。

## 18. 完成定义

桌面迁移只有在以下条件全部满足时才能宣布完成：

- `Shensi.app` 是唯一用户界面，用户不再访问网页；阿里云上线前由开发者/运维先启动并验证本机 API-only 后台，云端 API 可用后才达到仅打开应用即可使用；
- 旧 Web frontend、Tunnel、服务器 Sidecar 与 noVNC 全部停止后应用仍完整工作；
- 所有最新业务模块均有真实 API 数据和权限行为；
- 抖音登录、采集、评论和私信都使用本机外部可见浏览器与同一 Profile；
- 评论和私信具有独立人工确认、单次执行、幂等回执和异常对账；
- 当前 MySQL 数据完整迁移；`accepted` 前可回滚到 Trial，`accepted` 后只允许基于目标库与加密备份向前恢复；
- 最终联合里程碑已将 Gateway 与 Backend 从 `migration_locked` 原子收敛为只准入当前 `/Applications/Shensi.app` 内嵌 build-manifest SHA-256 的 `exact` 模式；旧安装版、Task 5 recovery seed、其他候选和伪造 header 均不能写入、绑定设备或领取动作；
- 推广前已选定并验证与 prior Backend/Gateway/schema/contract/admission 完整绑定的唯一 `verifiedRollbackSeed`；无证据旧安装版仅作为 `nonRollbackDisplacedApp` 隔离，绝不被误标为 rollback，且最终 rollback slot 及其稳定依赖可独立验证；
- 自动测试、单机人工验收和文档同步完成；
- 阿里云上线前明确标注“未完成真实异地验收”；阿里云上线后完成两台真实 Mac 与 RDS/HTTPS 验收。

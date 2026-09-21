# Task 7 Electron Main 与打包独立审查

## 结论

**NOT APPROVED。** 当前 Main/Preload 的基本隔离、打包资源布局和 Sidecar
生命周期实现已有明确边界，但尚不能形成可交付的 macOS 安装包。当前有两个
P0 交付阻塞和三个 P1 安全/生命周期缺陷。以下结论仅基于当前工作区源码和实际
只读验证；未执行真实抖音扫码、登录或采集。

## 已确认符合要求的部分

- `desktop/src/main/create-window.ts:4-7` 设置了 `nodeIntegration: false`、
  `contextIsolation: true`、`sandbox: true`、`webviewTag: false`，拒绝新窗口及跨
  Origin 导航。
- `desktop/src/preload/desktop-api.ts:1-5` 只暴露固定方法，不把 raw
  `ipcRenderer`、Sidecar token/port、路径或命令暴露给 Renderer。
- `desktop/src/main/desktop-ipc.ts:18-23` 同时校验授权 WebContents、精确本地
  Origin 和通道参数；账号键为带域分隔的完整 SHA-256。
- `desktop/src/main/runtime-location.ts:12-28` 将生产本地静态资源与开发 Vite
  Origin 分开；`electron-builder.yml:12-21` 把 Renderer、Sidecar、Chromium 和
 许可证放在 asar 外，未声明 noVNC/Xvfb/VNC/数据库服务资源。
- `desktop/src/main/main.ts:101-123` 有单实例聚焦、macOS activate、不随最后窗口
 关闭退出以及受控退出入口；Sidecar manager 自身的进程树回收测试通过。

## 阻塞问题

### [P0] Finder 启动的生产应用没有远端业务 API 配置来源，Main 必然在创建窗口前失败

`desktop/src/main/main.ts:44-48` 只从进程环境读取 `SHENSI_REMOTE_ORIGIN`，缺失时
直接抛错。`electron-builder.yml`、应用资源和当前文档均没有提供受信任的生产
Origin 配置；Finder 启动 `.app` 通常不继承开发者 shell 的该变量。因此即使 DMG
构建成功，普通安装启动也无法创建 Renderer gateway 或主窗口。

该异常还经 `desktop/src/main/main.ts:131` 的无终止 rejection handler 的
`void app.whenReady().then(main)` 逸出，既没有记录明确诊断，也没有受控退出。验证
方式是从无 `SHENSI_REMOTE_ORIGIN` 的环境启动生产 `.app`：代码必经上述 throw。

修复标准：构建时或签名资源中提供固定、校验为 HTTPS 且不可由 Renderer 修改的
业务 Origin；Main 初始化失败必须写脱敏日志并受控退出。增加模拟 packaged/Finder
空环境的 Main 生命周期测试。

### [P0] 当前最新 Renderer 无法构建，因而 Task 7 打包链不能生成所声明的最新前端

实际执行 `pnpm desktop:build:renderer` 失败，TypeScript 在
`frontend/src/acquisition/acquisition-browser-runtime.ts:307-349` 报 8 个错误，包括
缺少 `externalAbort`、字面量状态被推断为 `"starting"`、`prepared/cloudCursor`
被推断为 `null` 以及 `Promise<never>` 不匹配。当前也不存在
`frontend/dist-desktop` 或 `desktop/release`。因此 `electron-builder.yml:14-17`
需要的 Renderer 资源缺失，无法证明 DMG 包含“最新前端”。

修复标准：先让 `pnpm desktop:build:renderer` 通过，再完整执行
`pnpm desktop:package:mac` 和 `pnpm --dir desktop verify:package`；验证 `.app` 中的
Renderer hash/内容来自本次构建，而非旧产物。

## 高优先级问题

### [P1] Main 的登录身份授权 fence 仍可被终态或错配 session 绕过

`desktop/src/main/desktop-ipc.ts:15` 只在 active 时写入 `identities`，但在同一会话
后续返回 `expired`/`failed` 时不会删除既有身份。`getDouyinLoginStatus` 和
`confirmDouyinLogin` 在 `desktop/src/main/desktop-ipc.ts:30-31` 也未验证 Sidecar
返回的 `status.sessionId` 与请求 session 相同，就会用请求 session 的 account key
记住返回身份。随后 `desktop/src/main/desktop-ipc.ts:33` 仍允许开始采集。

后果是已失效登录或迟到/错配响应仍可能授权错误账号 Profile 的采集。现有
`desktop/tests/desktop-ipc.test.ts:47-54` 只覆盖 active 与版本号不匹配，没有覆盖
active→expired、active→failed、响应 session mismatch、cancel/status 竞态。

修复标准：每个 public session 绑定 account key 与 connector generation；所有非
active 状态删除身份；所有 status/confirm 响应要求 exact session；取消和 connector
重启让旧响应失效。增加上述确定性竞态测试。

### [P1] Renderer gateway 的请求与响应上限并不构成真正的资源边界，退出可被本地连接无限阻塞

`desktop/src/main/renderer-server.ts:18` 读取请求体时没有 deadline；本地客户端发送
部分 `/api` body 后不结束即可让 handler 永久等待。`server.close()` 在
`desktop/src/main/renderer-server.ts:51` 不销毁跟踪 socket，也不能中止这个读请求，
而 `desktop/src/main/main.ts:116-122` 会无限等待 `renderer.close()` 后才允许退出。

同时 `desktop/src/main/renderer-server.ts:42` 先执行
`upstreamResponse.arrayBuffer()`，把整个解压后响应放入内存，再检查 1 MiB 上限。
恶意或失控上游可在“限额”生效前造成无界内存占用。

修复标准：请求读取和 upstream fetch 共用有界 AbortSignal；流式累计响应并在超过
上限时立即 abort；gateway 跟踪 sockets/in-flight controllers，`close()` 先停止新
请求、再 abort/定向关闭连接并有总超时。增加 slowloris、超大 chunked/gzip 响应和
退出时在途请求测试。

### [P1] 单实例锁取得过晚，冷启动竞态未被测试

`desktop/src/main/main.ts:15-19` 直到 `app.whenReady()` resolve 后才调用
`requestSingleInstanceLock()`（调用点见 line 131）。Electron 的单实例锁应在应用
初始化/ready 前取得；两个冷启动实例都可在 ready 前执行各自初始化，当前测试也
没有导入或驱动 `main.ts`。这会使 Profile/Sidecar 独占问题依赖较晚的失败路径，而
不是由应用层单实例边界阻止。

修复标准：在等待 ready 前取得锁，失败实例立即退出；增加两个受控并发冷启动的
Main 生命周期测试，确认只有持锁实例创建 gateway、Sidecar 和窗口。

## 测试与打包证据

- `pnpm --dir desktop test`：exit 0，55/55 通过。
- `pnpm --dir desktop typecheck`：exit 0。
- `pnpm --dir desktop build:main`：exit 0，Main/Preload 编译产物存在。
- `pnpm desktop:build:renderer`：exit 1，8 个 TypeScript 错误，见 P0。
- `pnpm desktop:package:mac`：未继续执行；其必要的 Renderer 构建已失败。
- `pnpm --dir desktop verify:package`：未执行；当前无 `desktop/release` `.app`。
- 代码签名、notarization、DMG 安装启动、Intel/universal 架构：未验证，不应声称完成。

## 测试覆盖缺口

当前 `desktop/tests/build-contract.test.ts` 主要检查脚本文本和配置正则，并不能证明
资源实际可构建或 `.app` 可运行。Task 7 完成前至少需要增加/执行：

1. 无 shell 环境变量的 packaged Main 启动与受信任 API Origin 测试；
2. Main 初始化失败、双冷启动、重复 Cmd+Q、在途 gateway 请求退出测试；
3. 登录 active→终态、session mismatch 与 connector generation fence 测试；
4. 完整 Renderer build、Sidecar build、electron-builder `.app`/DMG 构建；
5. 对真实 `.app` 运行 `verify:package`，再做安装、启动、退出无遗留进程验证。

# Task 7 Electron Main 与打包复审（r2）

## 结论

**NOT APPROVED。** 上轮两个代码级 P0 和三个 P1 均已修复，sandboxed
Preload 也已在新打包的真实 Electron Renderer 中成功注入。不过当前 DMG 仍写入
占位业务 API Origin，且本地 Renderer gateway 会把任意来访网页的 Origin 提升为
受信任云端 Origin。前者使当前交付物无法连接真实业务，后者破坏了 Origin/CSRF
信任边界。

本次没有触发真实抖音登录、评论、私信或外联操作。

## 上轮问题逐项复核

### 已关闭：生产 API 配置来源与 Main bootstrap 异常

- `desktop/src/main/runtime-config.ts:25-38` 从 packaged resources 的
  `desktop-config.json` 读取唯一 `remoteOrigin`，要求生产 HTTPS exact origin。
- `desktop/scripts/write-runtime-config.mjs:10-29` 在打包前生成该资源；
  `desktop/electron-builder.yml:14-18` 明确打入 `.app`。
- `desktop/src/main/main-bootstrap.ts:9-22` 在 readiness 之前取得单实例锁，并在
  bootstrap rejection 后报告并退出；`desktop/src/main/main.ts:130-150` 已接线。

### 已关闭：最新 Renderer 构建失败

`pnpm desktop:build:renderer` 本轮 exit 0：129 modules，15 files，桌面构建中
`remoteCanvasIncluded: false`。`pnpm build` 也 exit 0。

### 已关闭：登录身份终态、session mismatch 与 generation fence

`desktop/src/main/desktop-ipc.ts:19-43` 会在 expired/failed 删除身份，验证 exact
session，并拒绝旧 connector generation；回归测试位于
`desktop/tests/desktop-ipc.test.ts:48-109`。

### 已关闭：gateway 无界 body/response 与退出阻塞

`desktop/src/main/renderer-server.ts:59-135` 对请求和流式响应设置 deadline/上限；
`renderer-server.ts:195-198,294-317` 跟踪 socket/controller 并在 close 时 abort、
destroy。slow request、流式超限和 upstream body deadline 测试均通过。

### 已关闭：单实例锁取得过晚

`desktop/src/main/main-bootstrap.ts:12-17` 在 `whenReady()` 前取得锁；
`desktop/tests/main-bootstrap.test.ts:5-48` 覆盖持锁、第二实例和启动失败。

## Preload 与真实打包验证

- `desktop/scripts/build-preload.mjs:11-19` 使用 esbuild 生成 bundled CommonJS
  `dist/preload/preload.cjs`，只 externalize Electron；生产和开发路径均由
  `desktop/src/main/runtime-location.ts:31-46` 指向该文件。
- 对本轮重新生成的 `desktop/release/mac-arm64/Shensi.app` 进行真实启动，并通过
  Chrome DevTools Protocol 在 Renderer 内求值，结果为：

```json
{"bridge":"object","keys":["acknowledgeDouyinCollection","cancelDouyinCollection","cancelDouyinLogin","confirmDouyinLogin","getAppVersion","getConnectorStatus","getDouyinCollectionResults","getDouyinCollectionStatus","getDouyinLoginStatus","getRuntimeInfo","onConnectorStatus","openLogsDirectory","restartConnector","startDouyinCollection","startDouyinLogin"],"node":"undefined","origin":"http://127.0.0.1:63817"}
```

这证明 `sandbox: true` 下实际 bridge 注入成功，且 Renderer 没有 `window.require`。
退出本次实例后未遗留对应 Shensi/Sidecar 进程。

- 当前 CSP 在 `desktop/src/main/renderer-server.ts:273-279` 只对
  `style-src` 放行 `'unsafe-inline'`，以兼容现有 Renderer 的 React inline style；
  `script-src` 仍严格为 `'self'`，同时保留 `frame-ancestors 'none'`、
  `object-src 'none'`、`base-uri 'none'` 和 `form-action 'self'`。对应测试通过。
- 当前 package verifier 不再只验证 `app.asar` 文件存在：
  `desktop/scripts/verify-package.mjs:28-36` 实际枚举 asar，要求
  `/dist/main/main.js` 与 `/dist/preload/preload.cjs`，并拒绝旧
  `/dist/preload/preload.js`；对当前 `.app` 验证通过。

## 剩余阻塞

### [P0] 当前实际 DMG 使用占位 API Origin，无法连接真实 Shensi 后端

本轮打包使用的资源
`desktop/release/mac-arm64/Shensi.app/Contents/Resources/desktop-config.json`
内容为：

```json
{"remoteOrigin":"https://api.shensi.example"}
```

`api.shensi.example` 是占位域名，不是可用业务端点。结构化配置机制已修复，但当前
`.app`/DMG 仍无法完成登录、工作区或云端采集同步，因此不能作为可用交付物。

关闭标准：由发布配置提供真实受控 HTTPS API origin，重新执行完整 desktop build
和 package；在不依赖 shell 环境变量的安装版中实测认证读取及一个 CSRF 写请求。

### [P1] Renderer gateway 接受任意网页 Origin，再将其改写为受信任云端 Origin

`desktop/src/main/renderer-server.ts:200-219` 没有验证请求 `Host`、`Origin` 或
`Sec-Fetch-Site` 是否属于当前随机 loopback origin；相反会无条件删除来访 Origin
并写成云端 `upstream.origin`。现有测试
`desktop/tests/renderer-server.test.ts:65-75` 甚至明确从
`Origin: https://evil.example` 发请求，并断言上游看到受信任 Origin。

这使 gateway 成为 Origin 信任提升器。随机端口降低远程网页命中概率，但不是安全
边界；本地恶意页面、端口探测或重绑定场景可向 gateway 发起 simple requests。
登录类非 CSRF endpoint 可能遭 login-CSRF，任何依赖 Origin 检查的云端写操作都会
错误地把攻击请求视为可信桌面请求。

开发链存在相同原则：`frontend/src/desktop/dev-api-proxy.ts:27-31` 无条件把 Vite
来访请求 Origin/Referer 写成 target。该模块正确解决了“开发 API 请求被后端 CORS
拒绝”的功能问题，但没有验证请求确实来自本机 Renderer dev origin；同时
`dev-api-proxy.ts:16-21` 允许任意公网明文 HTTP target，与
`desktop/src/main/runtime-config.ts:19-22` 的“仅 HTTPS 或 loopback HTTP”规则不一致。

关闭标准：生产 gateway 验证 exact Host，若存在 Origin/Referer 必须为 exact local
origin，并拒绝 `Sec-Fetch-Site: cross-site`；之后才允许改写给受信任 upstream。
开发 proxy 采用同等来源校验，并把明文 HTTP 限制为 loopback。增加恶意 Origin、
错误 Host、cross-site fetch、无 Origin 合法 GET、正常 cookie+CSRF 写请求测试。

## 实际验证结果

- `pnpm --dir desktop test`：68/68，exit 0。
- `pnpm --dir desktop typecheck`：exit 0。
- `pnpm --dir desktop build:main`：exit 0；生成 `preload.cjs`。
- `pnpm --filter ./frontend test`：57 checks，exit 0；有 Node MockTimers
  experimental warning。
- `pnpm --filter ./frontend test:types`：exit 0。
- `pnpm desktop:build:renderer`：exit 0；有单 chunk 超过 500 kB warning。
- `pnpm --filter ./frontend build`：exit 0；同一 chunk-size warning。
- `pnpm build`：exit 0；同一 chunk-size warning。
- `SHENSI_REMOTE_ORIGIN=https://api.shensi.example pnpm --dir desktop package:mac`：
  exit 0，产生 arm64 `.app`、DMG 和 blockmap。electron-builder 警告 description、
  author、icon 缺失，并明确跳过 Developer ID 签名。
- `pnpm --dir desktop verify:package`：exit 0，2721 entries，arm64。
- 新 `.app` 真实启动及 sandbox Preload 注入：通过；没有执行真实业务动作。
- `/usr/bin/codesign --verify --deep --strict`：失败，提示
  `code has no resources but signature indicates they must be present`；
  `/usr/sbin/spctl --assess` 同样未通过。签名、公证和 Gatekeeper 分发仍未完成，
  只能按规格诚实标记为未验证/不可发布，不能声称生产签名完成。

## 非阻塞但必须保留的发布说明

- 当前仅构建 arm64，未构建 x64/universal。
- 默认 Electron icon，package metadata 缺 description/author。
- 真实扫码、登录、Profile 复用、采集、云端同步均未在本轮执行。

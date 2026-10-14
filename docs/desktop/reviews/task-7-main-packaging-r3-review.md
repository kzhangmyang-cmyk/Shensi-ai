# Task 7 Electron Main 与打包最终复审（r3）

## 结论

**APPROVED（代码）。** 本轮限定范围内没有剩余 P0/P1 代码缺陷。生产 Renderer
gateway 和开发 Vite proxy 的来源校验均已按 exact Host、可选同源
Origin/Referer、拒绝 cross-site 的规则闭合；正常 Electron/Vite 请求仍可通过。
Preload、CSP 和 asar 入口也已验证。

当前占位 API Origin、Developer ID 签名和 notarization 是**发布配置/发布凭据门禁**，
不是本轮代码实现缺陷。使用占位 Origin 的现有 DMG 不能作为生产交付物。

## 来源校验

### 生产 Renderer gateway

`desktop/src/main/renderer-server.ts:188-205`：

- `Host` 必须精确等于实际随机 loopback origin 的 host/port；
- `Origin` 可缺省，存在时必须精确等于 local origin；
- `Referer` 可缺省，存在时其 parsed origin 必须精确相同；
- 数组型/歧义 header 被拒绝；
- `Sec-Fetch-Site: cross-site` 被拒绝。

检查发生在静态文件或 `/api` 处理之前（`renderer-server.ts:220-225`），只有通过后
才在 `renderer-server.ts:234-242` 把请求改写为受信任 upstream Origin。错误 Host、
恶意 Origin/Referer 和 cross-site 请求均返回 403，且测试证明 upstream 调用数为 0
（`desktop/tests/renderer-server.test.ts:105-126`）。

正常路径未回归：无 Origin/Referer 的合法 GET、同源 POST、同源 Referer、cookie 与
CSRF header 均通过并被正确转发（`renderer-server.test.ts:80-103`）。Electron 实际
页面加载请求的 Host 为 gateway host，导航请求允许 Origin/Referer 缺省，符合该规则。

### 开发 Vite proxy

`frontend/src/desktop/dev-api-proxy.ts:28-45` 将 target 限制为 exact HTTPS origin，
或带显式端口的 `127.0.0.1` HTTP origin；公网明文 HTTP 被拒绝。Renderer origin 本身
也必须是 exact `127.0.0.1:port` HTTP origin。

`dev-api-proxy.ts:47-64,77-87` 对 Host、可选 Origin/Referer 和 Sec-Fetch-Site 使用
与生产一致的来源规则，通过后才改写 upstream Origin/Referer。Vite 配置固定传入
`http://127.0.0.1:5188`（`frontend/vite.config.ts:7,39-42`）。自测覆盖正常无 Origin
请求、错误 Host、恶意 Origin/Referer、cross-site、公网 HTTP target 和非法 Renderer
origin（`frontend/src/desktop/dev-api-proxy.self-test.ts:25-53`）。

## CSP、Preload 与 asar

- CSP 位于 `desktop/src/main/renderer-server.ts:296-302`：
  `style-src 'self' 'unsafe-inline'` 仅用于现有 Renderer inline style；
  `script-src 'self'` 不允许 inline script，并保留 `frame-ancestors 'none'`、
  `object-src 'none'`、`base-uri 'none'`、`form-action 'self'`。测试通过。
- `desktop/scripts/build-preload.mjs:11-19` 生成 bundled CommonJS
  `dist/preload/preload.cjs`；`desktop/src/main/runtime-location.ts:31-46` 的开发和
  生产路径均指向该文件。此前对真实 packaged Electron Renderer 的 CDP 求值证明
  `window.shensiDesktop` 为完整 15 方法对象且 `window.require === undefined`。
- `desktop/scripts/verify-package.mjs:28-36` 实际解析 `app.asar`，要求
  `/dist/main/main.js` 和 `/dist/preload/preload.cjs`，并拒绝旧
  `/dist/preload/preload.js`。当前 package verifier 通过。

## 验证

- `pnpm --dir desktop test`：69/69，exit 0。
- `pnpm --filter ./frontend test`：57 checks，exit 0；仅 MockTimers experimental
  warning。
- `pnpm --filter ./frontend test:types`：exit 0。
- `pnpm --dir desktop typecheck`：exit 0。
- `pnpm --dir desktop build:main`：exit 0，生成 bundled `preload.cjs`。
- `pnpm desktop:build:renderer`：exit 0，129 modules / 15 files，
  `remoteCanvasIncluded: false`；有大于 500 kB chunk warning。
- `pnpm --dir desktop verify:package`：exit 0，2721 entries，arm64，且校验 asar
  Main/Preload 入口。

最终来源校验修改晚于当前已存在 `.app` 的时间戳。尝试重打包时检测到共享工作区中
另一个 electron-builder 正在同时打包，为避免破坏其产物，本审查中止了自己的重复
打包。因此当前源码/测试通过，但必须以共享打包任务完成后的新 `.app` 再运行一次
`verify:package` 和启动 smoke，不能把旧 `.app` 当作最新来源校验的二进制证据。

## 发布门禁（非代码缺陷）

1. 当前生成配置仍是 `https://api.shensi.example`。发布时必须提供真实受控 HTTPS
   Origin，重新打包，并从 Finder 启动验证认证读取及 CSRF 写请求。
2. 当前没有有效 Developer ID Application 身份，签名严格校验/Gatekeeper assess
   未通过，也没有 notarization 证据；不得声称可公网分发。
3. 当前只构建 arm64，x64/universal 未验证。
4. 真实抖音扫码、登录、Profile 复用与采集未在本轮执行。

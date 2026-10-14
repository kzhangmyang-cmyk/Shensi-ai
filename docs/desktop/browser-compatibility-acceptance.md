# V1.0 浏览器与桌面窗口验收边界

本页记录 2026-09-23 源码开发版的实际边界，不是已发行 V1.0 的兼容承诺。正式包仍须在公网业务验收、签名公证和第二台 Mac 安装验收后生成。客户**不需要安装 Chrome**才能使用桌面主程序、抖音登录或企业查询的内置爱企查窗口。

| 路径 | 使用的浏览器/会话 | Chrome 安装要求 | 当前证据与限制 |
| --- | --- | --- | --- |
| Shensi 账号注册、登录和业务页面 | Electron Renderer，经随机本机网关同源访问远程 `/api` | 无 | `create-window.ts` 只允许主窗口停留在本机 Renderer origin；`app-session.ts` 使用同源认证。外部 Safari/Firefox/Edge 的 Cookie 不会导入 Electron，也没有 OAuth 登录回跳。固定公网 HTTPS API、真实 Cookie/CSRF 与客户账号仍需独立验收。 |
| 抖音扫码、手动验证、采集及受控动作 | Sidecar 的 Playwright 可见、持久化**随包 Chromium**；独立 Profile | 无 | `sidecar-process-manager.ts` 固定 `MEDIACRAWLER_BROWSER_CHANNEL=chromium`，`browser_state.py` 使用 `launch_persistent_context`。不能把用户默认浏览器中已有抖音登录视为 Sidecar 已登录；抖音二维码、验证和页面交互受第三方站点/网络限制，需目标 Mac 实测。 |
| 企业查询普通搜索、手动登录和读取 | Electron 内置隔离 `BrowserWindow`，只允许爱企查及百度登录域 | 无 | `enterprise-local-browser.ts` 有独立持久 session，禁止 Node/preload、下载与任意外站跳转；当前账号曾完成真实内置登录和可见页面读取。爱企查会员、验证码、登录策略和页面变动不能由程序保证。 |
| 企业查询扩展预览 | Chrome 扩展 + Chrome Native Messaging Host | **仅选用此可选入口时需要** | 扩展只注册 Chrome；不声称 Safari、Firefox、Edge 扩展可用。无 Chrome 时使用上方内置窗口；扩展与内置会话不共享 Cookie。 |
| 应用中的官方文档、抖音公开来源等新窗口 HTTPS 链接 | macOS 系统默认浏览器 | 无 | 主窗口仍拒绝新 Electron 子窗口；Main 仅把不含凭据、非本机/IP 主机的标准 HTTPS 链接交给 `shell.openExternal`，拒绝 `javascript:`、`file:`、HTTP 和本机目标。默认浏览器可为 Safari、Firefox、Edge 或 Chrome；第三方站点能否登录不由 Shensi 保证。 |
| 品牌官网与咨询页面 | 普通 Web 浏览器 | 无 | 本机预渲染页面及移动菜单、英文产品页、咨询未开通反馈在 Playwright Chromium/Firefox/WebKit 三引擎通过；这不等于原生 Edge/Safari 实机、网络或邮件真实投递已验收。 |
| 官网到安装包 | 浏览器下载后由 macOS 安装 | 无 | 官网目前没有客户安装包下载链接；不得放出旧 `127.0.0.1:5680` 本机验收包。公网、签名/公证、第二台 Mac 验收后再开放准确的 V1.0 下载入口。 |

## 实际验证

```sh
pnpm --dir desktop exec tsx --test tests/electron-security.test.ts
pnpm --dir frontend exec tsx --test src/enterprise-query/browser-preview.test.ts
pnpm website:build
pnpm --dir frontend exec playwright test --config=playwright.website-browsers.config.ts
```

官网三引擎测试使用本机 5694 和**未配置 SMTP** 的合成表单；预期是保留填写内容并显示“尚未开通”，没有真实邮件或 CRM 写入。截图在 `/tmp/shensi-website-browser-{chromium,firefox,webkit}.png`。Browser 插件当前不可用，使用仓库已有 Playwright；WebKit 是 Safari 引擎近似验收，Firefox/Chromium 是 Playwright 运行时，不替代目标客户机器上的浏览器实测。

## 正式 V1.0 前还需核验

1. 第二台干净 Mac **不安装 Chrome**：安装公证包，Shensi 注册/人工开通/重登，抖音随包 Chromium 出现并由本人扫码，企业查询内置爱企查可点击/登录/读取；重开保持各自独立 Profile。
2. 将 macOS 默认浏览器分别设为 Safari 与 Firefox，点击应用内官方文档和公开来源链接；确认只在该浏览器打开，App 不离开工作区，异常 URL 不触发外部打开。若支持 Edge，再在已装 Edge 的机器复测；不将 Edge 引擎等同于原生实测。
3. 正式 HTTPS 官网在原生 Safari、Firefox、Edge/Chrome 的桌面与手机上完成导航、产品→咨询、隐私链接和真实邮件回执；未配置或失败时不能出现发送成功。官网到下载包的链接、哈希、公证和安装链须另行验收。
4. 检查抖音/爱企查登录及人工验证的第三方页面变化、系统代理/网络失败、过期会话和重试提示。不得复制默认浏览器 Cookie，也不绕过站点限制。

以上未完成项不能仅由单元测试、Playwright 或开发机截图标记为客户验收通过。

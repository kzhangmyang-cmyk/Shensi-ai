# 客户端临时公网接入与 macOS 发行准备

核查日期：2026-09-23。当前范围是本地可审查准备，不是公开发布记录。
官网、运营后台和产品工作台是三个不同入口；官网上线不代表业务后端或桌面包上线。

## 当前结论

现有 `dist/desktop/macos/mac-arm64/Shensi.app` 的资源配置实读为
`http://127.0.0.1:5680`，构建清单摘要为
`0c0a7c126e255cc72901cc0a50adc90db44172dde989120bd1e8e4275d367f04`。
这是本机隔离验收包：客户电脑的 127.0.0.1 指向客户自己，不能用它访问开发者的后端。
当前开发源码的后续主题修改不因该包存在而自动进入安装包。
新版客户安装包的生成时机由产品验收决定：官网、业务后端和账号系统须先在外网连通，
客户能够正常注册、登录并完成主要业务操作。所有功能和视觉工作先同步到最新应用开发版，
完成实际页面与主要业务验收；通过上述公网客户验收后生成客户安装包，并将正式发布版本标为 V1.0。
视觉迭代和临时 HTTPS 联调继续使用开发版，不触发新的 App、DMG 或 ZIP 构建。

| 交付面 | 可以准备的范围 | 开放使用前的阻断 |
| --- | --- | --- |
| Pages 产品静态界面 | Vite 普通 Web 构建的静态资源 | 同源 `/api` 尚需独立后端及受控代理；上传静态文件不提供账号与业务服务 |
| Web 业务测试 | 独立测试库上的登录、人工开通及有真实 API 的业务模块 | HTTPS、Cookie/CSRF、权限/限流、跨租户隔离及公网验证 |
| 桌面远程 API 联调 | 源码 Electron 连接已确认 HTTPS，保留本地 Sidecar | 独立 API/数据库、准确客户端准入；不是安装验收 |
| 可安装 Mac 发行包 | 复用既有打包/签名/公证链 | 固定 HTTPS、隔离策略、Apple 身份、公证、第二台 Mac 验收 |

Web 页面不拥有 Electron Preload/Main 或本机 Sidecar。Pages 上的抖音浏览器操作、
本机 Profile、原生语音/文件能力不能仅因界面可见就宣称可用；也不在本阶段重新启用 noVNC。
普通构建同时包含 `admin.html`、`ui-kit.html`；不可未经筛选就把整个 `frontend/dist`
作为独立客户工作台发布。运营后台的发布文件和访问策略由对应任务管理。

## 已有实现与准确接入点

- `desktop/scripts/release-policy.mjs`：release 要求精确无凭据 HTTPS origin，拒绝占位域名、路径、查询参数；要求签名身份和 notarytool profile。
- `desktop/scripts/write-runtime-config.mjs`：将构建时 `SHENSI_REMOTE_ORIGIN` 写入资源。打包应用只读取包内配置，不接受运行时环境变量换服务器。
- `desktop/src/main/runtime-config.ts`：源码走 development；HTTP loopback 安装包走 test/packaged-local；**所有 HTTPS 安装包目前走 production**。
- `desktop/src/main/app-paths.ts`：分别使用 Shensi Development、Shensi Test/<testId>、Shensi，分隔 Profile、设备凭据与动作日志。
- `desktop/scripts/macos-release-hooks.mjs`：afterPack 在签名前生成清单，包含源码、Renderer、Main、Sidecar、runtime config、架构与 bundle ID；改 origin 必须重新生成身份，不能修改已签名包中的 JSON。
- `backend/src/desktop-client-admission.ts`：migration_locked 或 exact；一个主摘要加最多七个附加精确摘要，便于 arm64/x64 或受控升级重叠。摘要不是 Apple 签名证明，也不替代登录、租户权限及设备/账号/审批验证。
- `frontend/src/app-session.ts`：相对 `/api/auth/*` 且 credentials=same-origin；仅设置 Vite 开发代理不会给 Pages 生产部署创建 API 代理。

临时 HTTPS 包不能直接复用现有 production 资料目录做隔离验收。最小选择是先用源码 development
与独立测试账号联调；需要实际 HTTPS 测试安装包时，再增加受构建身份绑定的显式测试环境配置，
同时覆盖配置解析、路径隔离和打包测试。不得从 Renderer、任意 URL 参数或环境变量切换已打包客户端的身份。
当前未实施该配置扩展，未搬移或复制任何正式 Profile/凭据。

## Cloudflare 临时能力的边界

Pages 提供静态构建与 pages.dev 地址，但不会把现有 Express/MySQL 应用自动变成云端 API/数据库。
可以由后端任务提供独立测试 API，再为工作台部署受控同源 `/api` 路由；不要通过通配 CORS 或关闭 CSRF 简化上线。
Quick Tunnel 是测试用途，随机地址不适合写死到分发安装包；官方还明确无可用性 SLA、200 并发请求上限且不支持 SSE。
Tunnel 也不提供 API 进程或数据库的常驻托管，源主机关闭仍不可用。

固定 HTTPS origin 确定后，未来迁国内优先保留该 origin、切换其受控上游并验收数据迁移/回退；
如果变更 origin，则按现有实现必须重打包和更新准入，不能承诺老安装包无改动自动切换。
本轮不选定未确认的域名，不购买资源，不创建隧道，不把 5638、旧 Trial 或旧任务接公网。

依据：[Pages Vite 部署](https://developers.cloudflare.com/pages/framework-guides/deploy-a-vite3-project/)、
[Quick Tunnel 限制](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)。

## 发行顺序与外部资源

1. 后端任务确认固定 HTTPS、独立 API 运行资源、独立持久 MySQL、秘密配置和备份/回退；保持既有真实 5638 不变，外联执行初始关闭。
2. 先用源码客户端验收登录/人工开通、跨租户拒绝、业务保存/重启读取、网络失败恢复及代理 Cookie/CSRF。缺 API 时仅静态预览，不显示业务验收完成。
3. 外网实测官网、业务后端与账号系统，确认客户可注册、登录、进入工作台并完成主要业务操作；同时确认测试包/正式包资料隔离与版本。只有这些前置条件通过后，才在拥有 Developer ID Application 身份的 Mac 上设置 `SHENSI_REMOTE_ORIGIN`、`CSC_NAME` 或 `CSC_LINK`、`SHENSI_NOTARYTOOL_KEYCHAIN_PROFILE`，执行 `pnpm desktop:package:mac:release`。秘密不写文档/源码/日志。
4. 打包脚本执行既有签名、公证和 stapling；运行 `pnpm desktop:verify:mac:release`，核对 App/DMG/ZIP、Gatekeeper、架构及包资源。后端仅准入该最终 manifest，不复用本机包摘要，也不采用通配。
5. 第二台干净 Mac 从 HTTPS 下载，正常安装和启动，不移除 quarantine 绕过验收；验证无开发工具启动、注册/开通/重登、保存/重开、Profile 与凭据隔离、卸载重装/升级保留行为。若对外支持 Intel，补 x64 本机构建与 Intel 实机同等验收。
6. 单独批准真实抖音及麦克风测试，保留评论/私信二次确认；网站入口仅在对应产物真正验收后开放下载。

仍缺：确认的固定 HTTPS API 与隔离持久运行资源、Cloudflare 对应项目/域名授权（由部署任务核实）、
Apple Developer Program 可用 Developer ID Application 证书及私钥、可工作的 notarytool Keychain profile、
第二台 Mac（以及承诺 Intel 时的 Intel 验收设备）。本机只读 `security find-identity -v -p codesigning`
返回 **0 valid identities found**；未尝试读取 Keychain 秘密或提交公证。
Apple 的发行要求见 [Developer ID](https://developer.apple.com/developer-id/)。

## 本次验证

以下现有针对性测试 31/31 通过，覆盖 origin、测试资料目录、清单生成/读取、签名与 entitlement 策略；
它们不替代公网、真实 Apple 签名或跨机安装：

```sh
pnpm --dir desktop exec tsx --test tests/runtime-config.test.ts tests/release-policy.test.ts tests/packaged-build-producer.test.ts tests/desktop-build-identity.test.ts tests/app-paths.test.ts tests/macos-signature-policy.test.ts tests/release-entitlements-policy.test.ts
```

本次交付仅新增此准备文档并链接现有验收文档，没有改生产代码、后台资源、官网配置或已有安装包。

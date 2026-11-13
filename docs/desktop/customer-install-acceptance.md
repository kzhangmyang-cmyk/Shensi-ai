# macOS 隔离安装包验收

当前单机内部产物、合成验收方案及未测边界见 [单机内部验收](standalone-internal-acceptance.md)。本页以下为2026-09-22远程客户端测试包的历史证据，不是当前单机包或启动入口。公网接入历史背景见 [客户端公网准备](public-client-readiness.md)。

## 2026-09-22 测试产物

最新青蓝 Logo 包（仅图标及构建清单分类变更）：CPJ `job-mubj32ht-bd229c8f` exit 0，三份包各 2694 条检查通过。DMG SHA-256 `592e2405065b4cd21537e820ad090ea0840b20ab53d12830e1b81c58a6798b80`，ZIP `8ce402f67dfa93011501bbd9568293e95d1a2e7d0de7f5ac888215233f116a9c`，构建身份 `0c0a7c126e255cc72901cc0a50adc90db44172dde989120bd1e8e4275d367f04`。包内 `icon.icns` 与生成器产物 SHA-256 均为 `c4a3e19d4615a5a2286caf8dab2a4c27b31ddfb7d552a2829f646b223e0ab94f`。图标素材已按用户明确指定批准；下述业务链路证据对应同日上一测试包。

### 业务链路验收包

青蓝图标原生复验：手动退出旧实例后启动当前 `dist/desktop/macos/mac-arm64/Shensi.app`；进程 41866 的可执行路径经 `ps`/`lsof` 核对指向该包，窗口网关为 53782，清单摘要为上述 `0c0a7c…`。原生“关于 Shensi”面板截图明确显示青蓝轨道三角图标及版本 0.1.0。Dock 专用窗口读取超时，未将 Dock 缓存状态计为已验收；未绕过系统锁屏或修改正式应用。

- 产物：`dist/desktop/macos/Shensi-0.1.0-arm64.dmg`、同名 ZIP、`mac-arm64/Shensi.app`。
- DMG SHA-256：`4fba6f67e95ee7fe45cea15fed7ad15be8ec0f6c1f32105920fa6da6e287f55e`。
- ZIP SHA-256：`589c0ba5e354ede32750eeb2892cca9802ea3945ebe503262113ceb9e217339c`。
- 构建身份：`06bf2d0eee33df666b6a624337d1d9a86ca3a492cf28603fe9ab1f4793d4e11e`。
- CPJ：`job-mubg2477-08100d05`，exit 0；18 项真实/演示操作回归通过；app、ZIP、DMG 各 2694 条包内容检查通过。

## 已观察与待验收边界

前一测试包在原生 Electron 窗口完成注册、等待运营开通、后台人工开通、刷新要求重新登录、登录进入工作台以及新增合成产品。专用 MySQL 只读查询确认 `PKG0922` 存在且属于合成注册企业；不是凭成功提示推断保存。

验收发现并修复两处问题：隔离后端必须允许桌面代理规范化后的固定上游 Origin；共享壳演示提交只能处理显式 `data-demo-action` 且未被处理的表单。最终包已包含第二处修复：关闭旧实例并重开最终包后，原生窗口保留测试登录、重新读取 `PKG0922`；新增 `PKGFIX0922` 后显示 2 个产品及“已保存，目录已刷新”，未出现演示提交提示。最终包网关为随机环回端口 56564，此端口不是客户部署地址。独立只读 SQL 核验确认两条产品均存在且归属同一合成企业；无秘密的核验结果位于 `.runtime/admin-preview/artifacts/package-sql-result.json`。

该包仅连接 `http://127.0.0.1:5680`，使用 `Shensi Test/packaged-local` 独立资料。四项外联开关关闭，未测试真实评论或私信；未修改真实 5638 数据库、正式安装应用或已有抖音 Profile。旧打包产物保留在带时间戳的 previous 目录。

此产物不是客户公开发行版：缺少确定的公网 HTTPS 后端、Developer ID 签名及公证和第二台 Mac 验收；当前只有 arm64 本机证据，不代表 Intel、Windows 或跨机器安装通过。

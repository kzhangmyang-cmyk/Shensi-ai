# 桌面应用内更新

当前 Mac 安装包由 `desktop/scripts/package-macos.sh` 生成。开发打包使用 ad-hoc 签名（`identity=-`），本机没有 Developer ID 证书，也没有公证。因此应用内更新**不能**退出后替换正在运行的 `.app` 再自动重启。不会执行 shell 覆盖、关闭系统安全检查或提升权限。

## 现在支持的流程

1. 应用向固定地址 `https://www.shensi.me/downloads/desktop-updates.json` 读取发布清单。这个地址不经过业务 API，也不发送 `X-Shensi-Desktop-Build-Manifest-SHA256`。桌面准入返回 409 时，检查更新和下载仍然可以继续。
2. 清单只接受 `https://www.shensi.me/downloads/` 下、文件名符合 `Shensi-*.dmg` 的地址。拒绝重定向、查询串、其他主机和降级版本。
3. 版本顺序是 `releaseSequence`。`0.1.0` 已被多个互不相同的包复用，所以相同版本号只有在序号更大时才算更新；更低的语义化版本一律不提供。
4. 当前源码身份是 `0.2.0`，序号 `1`。已上传的 `Shensi-0.1.0-arm64-6749085e0e91.dmg` 是更早的 main `6749085` 包，不含本更新器，不能用它自己检查更新。
5. 用户确认后，应用下载安装包、显示进度，并允许取消和重试。下载完成后核对字节数和 SHA-256。校验失败会删除未完成文件。
6. 校验通过后，用户选择“在访达中显示”。用户需要退出 Shensi，打开 DMG，把 Shensi 拖到“应用程序”后再打开。

## 自动替换安装的前提

只有同时具备 Developer ID 签名、公证并装订票据之后，才能改成系统支持的更新安装。在那之前，`automaticInstallSupported` 固定为 `false`。不要把 ad-hoc 包描述成可以重启后自动完成更新。

## 发布清单

在持有 DMG 的机器上本地生成清单，本工具不上传：

```bash
pnpm --dir desktop exec node --import tsx scripts/publish-desktop-update.ts \
  --dmg /absolute/Shensi-0.2.0-arm64.dmg \
  --feed /absolute/desktop-updates.json \
  --version 0.2.0 \
  --sequence 2 \
  --arch arm64 \
  --build-manifest-sha256 <64 位小写摘要> \
  --url https://www.shensi.me/downloads/Shensi-0.2.0-arm64.dmg \
  --notes-file /absolute/notes.txt \
  --published-at 2026-11-14T00:00:00.000Z
```

序号必须大于同架构已有条目，版本不能降低。把生成的 JSON 和 DMG 放到 `https://www.shensi.me/downloads/` 需要单独授权；本次不部署、不改 nginx。

## 准入

当前线上 exact 准入摘要是 `7d9fcdc79fcd39ef49a8a8d141425ddede86488e655051bb22306bc4295dcfe3`。它对应已经安装并重启过的客户端。新的安装包会生成另一个 `desktop-build-manifest.json` 摘要。下载和校验不依赖这个摘要，所以旧客户端被准入拒绝之前仍可取得更新包。新包安装之后，业务 API 会返回 `409 desktop_client_build_not_admitted`，直到另行把新摘要加入准入名单。本功能不修改服务端准入策略，也不改 `DOUYIN_OUTREACH_SERVER_EXECUTION_ENABLED`。

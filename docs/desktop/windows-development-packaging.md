# Windows 开发包实施状态

核查日期：2026-09-30。目标是现有前后端的 Windows 开发客户端，不是重新设计单机数据库或恢复平台外发。

## 已完成

- 冻结 Sidecar 的 Python 启动器按 Windows 平台解析随包 `playwright/driver/node.exe`，其他平台保留 `node`。缺少 `.exe` 不回退到 Unix 文件；资源根目录、常规文件和可执行性检查保留。
- 两项 Windows 文件名行为测试先失败后通过；启动器全部八项测试在 macOS 通过。这是跨平台分支单测，不是 Windows 二进制运行验收。

## 当前构建事实

- 本机是 macOS arm64，现有安装脚本为 `desktop/scripts/package-macos.sh`，输出 DMG/ZIP。产品版本仍是 `0.1.0`。
- `.github/workflows/quality.yml` 和 `acquisition-contracts.yml` 使用 Ubuntu，没有 Windows 构建任务。本次不上传源码、不启用远程 CI。
- 本机 PATH 未发现 `prlctl`、`VBoxManage`、`qemu-system-x86_64` 或 `wine`；未发现仓库已暂存 Windows 可执行资源。这不能证明其他机器没有 Windows 环境。
- Sidecar 使用 PyInstaller。官方明确它不是跨平台编译器，Windows 冻结产物应在 Windows 构建。Electron Builder 的 Windows 壳交叉打包不能替代 Python Sidecar 的目标平台构建。
- macOS内部单机App已携带本地业务后端、Node及MySQL，并有包内组件和部分安装业务验收，详见[单机内部验收](standalone-internal-acceptance.md)。该内部打包配置不是Windows成品资源链；旧远程客户端配置不能用作Windows单机交付。

## 最小适配顺序与准确范围

1. `desktop/scripts/build-sidecar.mjs`：Windows 的 `shensi-sidecar.exe`、`node.exe`、Chromium `chrome.exe` 路径与目标架构校验；路径分隔符规范化；不能把 Mac 暂存目录当作 Windows 资源。
2. `desktop/src/main/sidecar-process-manager.ts`：目标可执行文件名、Windows 启动握手及子进程归属/退出。现有专用 fd 3 不能在未验证 Windows Node→Python 继承语义时视为可用；现有 Unix `ps`/进程组机制不能直接套用 Windows。
3. `services/media-crawler/shensi_adapter/desktop_entrypoint.py`：`os.getuid()` 与 POSIX 0600 检查需 Windows 等价的当前用户访问控制验证，不能简单跳过。此项涉及冻结核心的启动安全边界，尚未修改。
4. `desktop/src/shared/contracts.ts`、`desktop/src/main/main.ts`、`frontend/src/desktop/desktop-bridge.ts`：运行平台当前写死 `darwin`，需让真实平台信息贯通，保持生成协议来源一致。
5. 新增 Windows 专用 Builder 配置与原生构建入口，复用依赖锁和资源白名单，不继承 Mac 签名钩子；先目录包通过资源/秘密排除校验，再生成 NSIS 开发安装包及 SHA256。`desktop/scripts/verify-package.mjs` 当前使用 `.app/Contents`、Mach-O 和 Mac Chromium 路径，不能直接当 Windows 验证器。
6. 在 Windows x64 环境验证安装、干净用户目录启动、登录 API 连接、Sidecar 握手/健康/关闭与卸载。不需要启用评论、私信或恢复旧任务。Windows ARM64、Mac Intel 均不能由本机 arm64 构建推定已支持。

## 当前验证与交付边界

需要一台可供构建和验收的 Windows x64 机器，或已有授权的 Windows x64 虚拟机；构建机安装锁定 Node/pnpm、Python/uv，以及对应 Windows MySQL、Playwright Chromium 资源。客户机器不需要这些开发工具。当前未授权购买虚拟环境或上传远程CI源码，不能仅在 Mac 生成壳包后宣称完成。

用户已确认没有Windows虚拟机。仓库两个工作流均为ubuntu-latest，无现成Windows runner配置；当前checkout只有禁推的本地legacy-origin。候选是现有私有 `kzhangmyang-cmyk/Shensi-ai` 的GitHub Actions标准Windows runner，但须另获授权：上传审核后的精选源码及构建工作流，运行依赖安装、原生冻结、测试和内部产物上传，不含业务数据/密钥。私有仓库按账号套餐使用额度，超额分钟及存储可能收费；尚未读取账号余额，不能报价为免费，也未触发任何工作流。见[官方计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。当前Windows阻塞在获准的实际构建环境，Mac内部验收不受此阻塞影响。

本地 MySQL runtime 当前明确拒绝非darwin平台；除下述 Sidecar 工作，还需实现 Windows 私有目录 ACL、数据库启动连接、系统凭据保护及自有进程回收，不能以 chmod 或 Unix socket 替代 Windows 验证。开发包可在用户接受系统未识别发布者提示后测试；正式可信发行还需代码签名证书及签名验证，目前没有已确认的 Windows 签名凭据或成功签名记录。macOS 公证不是 Windows 验收项。

运行 `uv run --frozen --project services/media-crawler pytest -q desktop/tests/test_frozen_sidecar_entrypoint.py` 验证启动器分支。
最终仍需根 `pnpm test`、`pnpm build`、`pnpm desktop:typecheck`、`./scripts/context-check`、`git diff --check` 和目标平台打包/启动验收。
尚无本轮 Windows 安装包、签名、公证或 Windows 实机通过记录；当前不能向客户交付旧包代替。

## 参考依据

- [PyInstaller 跨系统打包说明](https://pyinstaller.org/en/stable/usage.html)
- [Electron Builder 26 多平台构建](https://www.electron.build/v26/docs/features/multi-platform-build/)

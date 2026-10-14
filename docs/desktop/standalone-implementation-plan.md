# 单机开发版实施计划

**目标：** 在客户机器运行完整业务后端与持久数据库，交付分别验收的 Mac/Windows 开发包。
**依据：** [已确认设计](standalone-development-design.md)。当前会话原地实施，保留已有修改，不推送源码。
**技术：** 现有 Electron、TypeScript/Express、mysql2/MySQL、Python Sidecar；不换数据库架构。

## 全局边界

模型 API 由客户自行配置；不携带开发账号、密钥、数据、Profile，不恢复外发。当前授权不含购买、开源、远程 CI 或客户消息。数据库分发路径单独核查，不把客户独立安装冒充已选免依赖安装体验。

## 验证重点

- 用户在数据库启动期间退出：取消启动，不继续打开后端。
- 后端启动失败：清理本应用已启动服务，保留数据，不杀其他进程。
- 停止失败：继续后续清理，不能把残留进程当成已停止再启动。
- 重启数据不丢，初始化中断不删除重建用户库。
- 新客户没有当前开发者的 API 配置和平台授权。

## 1. 本地服务生命周期（本轮）

文件：新增 `desktop/src/main/local-service-lifecycle.ts` 与 `desktop/tests/local-service-lifecycle.test.ts`。
接口：`LocalServiceLifecycle({database,backend})`，服务提供 `start(signal):Promise<void>`、`stop():Promise<void>`；公开 `start()/stop()/getState()`。

- [x] 测试数据库就绪后才能启动后端、后端就绪才 ready；失败逆序清理并脱敏。
- [x] 测试启动中取消、并发 start 拒绝、重复 stop 不重复关闭、清理失败阻止重启。
- [x] 实现顺序状态机，保留独立 remote 模式；不把通用接口测试当作真实 MySQL 测试。
- [x] 运行专项、桌面类型检查和完整项目测试构建（`job-munzhjqk-87a45345`，不含随后新增后端驱动）。

## 2. 原生运行时与数据初始化

文件：新增 `desktop/src/main/local-mysql-runtime.ts`、`local-backend-runtime.ts` 与对应测试；复用 `backend/src/mysql-store.ts` 的 schema 初始化能力。
接口：两个驱动实现步骤1的服务接口；后端另提供只读 `origin`，仅 ready 后可读取。

- [ ] 核实目标 OS 运行时来源/版本/完整性和分发条件，不引入客户数据。
- [ ] 在新临时用户目录真实启动独立数据库、生成本机凭据、初始化专用库及最小用户；禁止外网监听及无密码网络窗口。
- [x] 独立探针启动编译后端，验证 MySQL 健康、登录和合成业务写入，后端与数据库重启后读回；不连接开发库。生产驱动与 Electron 接入仍待实现。
- [ ] 测试端口冲突、坏权限、半初始化数据、错误架构和异常退出，仅操作自有进程。

## 3. 接入应用与首次账号

文件：修改 `desktop/src/main/runtime-config.ts`、`app-paths.ts`、`main.ts`；新增后端单机初始化路由及前端首次设置入口，独立于云注册门禁。

- [ ] 测试显式单机模式不继承远程地址/开发 Profile；本地服务 ready 后才打开业务 UI。
- [ ] 首次设置通过一次性本机能力创建客户账号及本地模块授权，完成后关闭设置能力；不内置默认密码。
- [ ] 接入步骤1/2与已有 controlled shutdown，保留云端模式行为。
- [ ] 客户模型 API 配置、连接测试、加密保存和重启读取；模拟凭据测试与真实调用分开记录。

## 4. 逐模块隔离验收

按设计矩阵运行 CRM、获客只读链路、智能体、财务、ROI、委员会、星盘、产品报价、设置；记录真实通过/失败/未测。
真人扫码和模型实际调用仅在相应授权下执行；不为过测试恢复评论、私信或邮件外发。

## 5. 两平台打包

修改 `desktop/scripts/verify-package.mjs`、构建资源清单；新增 Windows 独立构建与验证入口，Mac 保留现有流程并增加单机资源。
白名单校验原生数据库资源，保留许可证与发行材料；不能整体移除原有敏感资源排除规则。
分别验证干净安装、首次配置、重启持久化、退出、卸载保留数据；输出版本、架构、体积、SHA256和签名状态。

## 当前执行记录

- 方向和客户自行配置 API 已获同意，不重复询问。
- Windows 冻结 node.exe 分支八项 Python 测试通过。
- 关闭顺序扩展五项专项通过；尚未注入真实本地服务。
- 基线 `job-munyczcx-a5edaa50` 全部通过；后续回归 `job-munyx54r-d2bb71c2` 桌面测试、模型网关、根测试/构建、桌面类型、context、diff全部通过。该批次不含随后新增的生命周期模块。
- 生命周期模块六项测试与原关闭管理五项测试共11项通过。模块尚未在 Main 引用；当前开发应用及业务库未变。
- macOS arm64 原生 MySQL 8.4.11 独立探针通过（`job-munzga2p-1a0f9e5d`）：不使用 Docker，只监听私有 Unix socket；合成事务回滚、数据库重启保留、编译后端登录、真实 todo API 写入、后端与数据库同时重启后读回全部通过。测试自有进程已停止，模型和平台调用均为零。
- 探针位于本地忽略文件 `.runtime/native-mysql-acceptance.mjs`，合成证据目录 `/tmp/shensi-mysql-acceptance-DA5Ko5`。探针使用临时私有 socket 的测试 root，不能作为客户最小权限账号初始化实现，也不等于安装包验收。
- `local-backend-runtime.ts` 实现直接子进程启动/停止：显式 Node 路径与环境、不继承宿主变量、固定回环地址、强制禁发；先收到自身监听成功输出再校验 MySQL health，避免把占用端口的其他服务当作已启动。七项真实 Node 子进程专项及桌面类型检查通过；超时保留进程所有权，不扫描或终止其他进程。
- 后端驱动的实际编译后端登录、todo 写入、后端与原生 MySQL 重启读回通过（`job-munzqmfv-3a52890d`，证据 `/tmp/shensi-mysql-acceptance-gBtVkJ`）；同批桌面测试、根测试/构建、桌面类型、context、diff全部通过。该批数据库使用隔离探针，产品数据库驱动证据独立列在下方。
- `local-installation-secrets.ts` 复用私有文件存储与 Electron safeStorage 接口：每安装独立生成数据库/后端密钥，完整加密落盘，丢失或无法解密不重置；三项测试通过，加密边界使用 AES 测试替身，尚非系统钥匙串实测。
- `local-mysql-runtime.ts` 已实现 macOS socket-only 初始化和自有进程退出、独立 schema 业务账号、半初始化保留并拒绝启动。`job-muo0ahuy-d89ac0f3` 六项测试无跳过全部通过，包含真实初始化、重启保留、业务账号不能读取 mysql.user、错误凭据拒绝；类型检查通过。Windows 明确拒绝，未宣称支持；Main 接入仍待实施。
- `local-application-runtime.ts` 将两个产品驱动接入生命周期控制器，数据库 ready 后才创建后端，退出逆序，使用独立安装密钥且固定禁发。构建身份校验及真实登录/业务写入/完整重启验收通过（`job-muo0gjoz-7582a35e`）。
- 运行 socket 使用 `/private/tmp` 下随机 0700 短目录，自有 MySQL 退出后清理；持久数据仍在原应用数据目录。长数据路径、socket 权限与退出清理真实复验通过；同批五项原生专项无跳过，桌面/根测试、构建、类型、context与diff全部通过。下一步接入 Main 和客户首次设置，不再重复数据库探针。
- Main 已增加显式 standalone 分支：生产配置为仅含 `mode: standalone` 的对象；开发使用 `SHENSI_DESKTOP_MODE=standalone` 并显式提供原生 Node/MySQL 路径。数据与 Chromium 使用独立 Standalone 目录，先启动本地服务再打开当前前端，退出先关桌面服务再停本地服务；发送仍关闭。12项配置/路径/缺失凭据专项与类型检查通过。系统 safeStorage、编译后工厂整链及 Main 原生窗口验收待完成。
- 系统 safeStorage 与编译后工厂整链通过 `job-muo0xu4p-ec5c7767`：真实 Electron 加密、不含明文数据库密码、重新创建工厂与数据库/后端重启后登录成功；零平台外发。该批 Main 构建、桌面/根测试、构建、类型、context与diff通过。验收目录 `/private/var/folders/8r/807dkr895rd328bk48vxnkfh0000gn/T/shensi-electron-standalone-TJKbB2` 仅含合成测试资料；未覆盖 Electron 整个进程重启、Main 业务窗口或客户首次设置。
- 首次客户账号沿用现有空库 `INITIAL_ADMIN_*` 初始化并由后端哈希密码，不新增公开注册接口，也不改变云注册。Main-only 运行参数支持经校验的客户账号（3–32位字母开头账号，12–128位密码，与生产首次初始化下限一致）。`job-muo19gs9-90d7c734` 四项测试无跳过通过，包含客户登录、业务写入、重新创建运行时后保留及隐藏 bootstrap 登录返回401；类型与diff通过。设置窗口仍待接入。
- 首次设置窗口组合验收通过 `job-muo1twz5-7423ecfc`：Playwright 驱动真实 Electron 设置窗口，620/390双主题、密码不一致反馈、填表提交、加密落盘和重建运行时登录通过；页面脚本错误0、平台外发0。截图 `/tmp/shensi-first-setup-qa.qosK5J/`，合成数据 `/private/var/folders/8r/807dkr895rd328bk48vxnkfh0000gn/T/shensi-electron-standalone-ivtAxL`。同批完整回归通过；下一步验证实际 Main 业务窗口与客户模型API入口，不把设置窗口测试扩为全应用验收。

# 小红书独立适配环境

源码已连接后端独立路由、Electron Main/Preload、私有stdio进程与社媒对话入口；当前运行应用尚未更新，真实平台登录、消息发送和真实MySQL验收未完成。发送默认关闭。

## 环境与启动

固定参考 `cv-cat/Spider_XHS@7077c88f82771f547cc1afdadaec4025be2355e6`。上游README限定非商业学习交流，固定提交无LICENSE文件；不据MIT徽章推断再分发许可。只在用户授权的非商业本机开发范围使用，源码保留在独立外部目录，不复制到本仓库或抖音Sidecar。

运行 `uv sync --frozen --project services/xiaohongshu`。Python环境独立锁定；Playwright1.61.0与项目既有版本一致，安装Python依赖不会下载Chromium。必须使用本机已准备的Playwright浏览器，不提供自动下载/安装路径。

启动桌面开发实例前设置 `SHENSI_XHS_UPSTREAM_PATH` 为固定提交的干净Git仓库绝对路径。主进程使用本目录 `.venv/bin/python`，运行器校验仓库根目录、精确提交和工作区干净状态后才导入上游。当前不支持打包分发，不产生新App/DMG。

后端模块由`XHS_MODULE_ENABLED=true`显式启用；默认不注册业务处理、不建表，接口返回`xhs_module_unavailable`。启用模块前先完成独立MySQL验收和schema安排，聊天更新无需附带该迁移。
`XHS_DESKTOP_SENDING_ENABLED` 在桌面Main与后端分别默认false；需要后续真实验收时两端均明确启用，不能由Renderer设置。`XHS_DAILY_LIMIT` 后端默认20、范围1–100。模块启用后的发送开关不影响独立账号登录/绑定。现有抖音开关和历史队列不变。

## 产品路径

社媒对话 → 小红书私信 → 打开登录浏览器 → 用户手动登录官网 → 已登录，连接账号 → 选择发送账号 → 精确收件人/正文 → 保存草稿 → 批准当前版本 → 二次确认发送 → 展示平台回执或结果未知。

正文/收件人编辑撤销批准；未保存编辑不能直接批准或发送旧版本。结果未知和终态记录不提供重发。桌面禁发、登录窗口未打开均显示明确中文操作提示，不改变权限和发送开关。前端黑绿/蓝白、1440/390使用离线合成API验收，不代表真实平台发送通过。

## 模块与边界

- `browser_login.py`：独占可见persistent Context，不生成二维码、不截图、不引入noVNC。仅读取本Context官方页面IM状态与push域Cookie；过期/缺失状态返回未就绪，不生成认证字段。上下文仅由本模块关闭。
- `worker_process.py`：无HTTP端口，仅父进程stdin/stdout；按工作区/用户/设备派生私有根目录，0700 Profile与0600日志/租约。flock阻止同身份重复进程。EOF/SIGTERM取消请求并关闭本进程会话；不恢复队列。
- `protocol.py`：open/connect/close/execute四种严格操作，UUID关联、64KiB UTF-8限制、重复键/未知字段拒绝。批准身份必须匹配进程Owner，后端毫秒截止时间转换为秒。公开消息不含Cookie、认证状态、Profile路径或原始异常。
- `worker_runtime.py`：调度浏览器、IM会话及单次执行，关闭账号会取消该账号请求。公开ready来自IM连接成功而非仅浏览器登录。固定上游connect等待握手ACK后返回。
- `sessions.py`：账号独占、身份/代次隔离、账号内锁，无全局发送锁；关闭失败保留占用。排队后重验过期，取消留下未知状态。
- `single_send.py`：网络写入前将命令绑定摘要和未知状态提交SQLite，不存正文/凭据。重复命令不再写socket，冲突拒绝。重启不重发。
- `upstream_transport.py`/`receipts.py`：复用固定上游WS编码与事件，保留持久化mid。只接受精确账号/代次/mid的chatACK，传输返回不视为成功；无HTTP补发。
- `desktop/src/main/xiaohongshu-*.ts`：当前用户会话/CSRF与已有设备凭据留在Main。Renderer仅可传账号ID、草稿ID/修订等窄参数；正文命令必须由Main从后端单次领取。身份变化阻止发送，关闭应用时回收独立进程。
- `backend/src/xiaohongshu-application.ts`：由当前Acquisition应用装配，复用其池与桌面设备认证器。MySQL模式建立独立加密CAS表；仅宿主明确内存模式使用内存仓库，不在DB失败后降级。HTTP位于正常鉴权/CSRF/工作区中间件后。
- `frontend/src/conversations/xiaohongshu.ts`：独立平台工作区；共享DTO来自 `contracts/openapi/xiaohongshu-messaging.v1.yaml`，不手写业务DTO。

## 验证

```sh
uv run --frozen --project services/xiaohongshu python -m unittest discover -s services/xiaohongshu -p 'test_*.py'
uv run --frozen --project services/xiaohongshu python services/xiaohongshu/verify_upstream.py /path/to/Spider_XHS
pnpm --dir backend test:xiaohongshu
pnpm --dir desktop exec tsx --test tests/xiaohongshu-*.test.ts
pnpm --dir frontend test:xiaohongshu
pnpm --dir frontend exec playwright test --config=playwright.xiaohongshu.config.ts
pnpm test && pnpm build && ./scripts/context-check && git diff --check
```

兼容检查使用真实上游编码/解码器与合成socket，无网络。隔离Electron验收已贯通生产整页、真实Preload/Main/worker及合成API，验证未登录拒绝、编辑/批准、发送关闭和进程回收；不打开平台浏览器或执行消息发送。MySQL SQL边界目前使用受控驱动；只有明确配置隔离测试库才能执行真实MySQL验收，不替换为用户数据库。当前进度见 `../../docs/PROJECT_STATUS.md`。

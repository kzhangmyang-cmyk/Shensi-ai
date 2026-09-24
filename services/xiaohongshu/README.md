# 小红书独立适配环境

状态：独立依赖锁定、上游导入和消息回执关联内核已通过离线验证，尚未连接产品的登录、批准或发送入口。不能据此认为私信可用。

固定参考 `cv-cat/Spider_XHS@7077c88f82771f547cc1afdadaec4025be2355e6`，开发源码置于独立目录，不复制到抖音Sidecar。上游README标注非商业学习交流，虽然徽章链接MIT，固定提交未包含LICENSE文件；不据徽章推断可再分发。当前仅在用户已授权的非商业本机开发范围使用。

`apis/xhs_live.py` 的导入链只需 `curl_cffi`，WebSocket连接另需 `aiohttp`。本环境不安装上游的图像、Excel、二维码、PyExecJS依赖；不导入整个采集应用。完整认证签名路径是否需要其他依赖，应在接入该路径时单独验证，当前不宣称覆盖。

环境准备：`uv sync --project services/xiaohongshu`；重建使用 `uv sync --frozen --project services/xiaohongshu`。依赖独立锁定，不改 `services/media-crawler`。

离线测试：`uv run --frozen --project services/xiaohongshu python -m unittest discover -s services/xiaohongshu -p 'test_*.py'`。

固定上游兼容检查：`uv run --frozen --project services/xiaohongshu python services/xiaohongshu/verify_upstream.py /path/to/Spider_XHS`。只接受指定提交的干净源码；用手写合成protobuf经过上游真实解码器检验直接ACK和推送批次，不连接网络。

`receipts.py` 的 `ReceiptTracker`只关联当前账号、会话代次和客户端消息ID的`chatACK`。握手、其他ID、畸形事件保持未决；断线变为未知；精确迟到ACK可对账；终态不会被重复事件覆盖。账号和代次由会话拥有者传入，不得接受网络自报身份。模块不发送消息、不承担批准、持久化或重发控制；这些调用链尚待实现。

`single_send.py`提供私有SQLite单次提交日志与可注入transport执行边界，默认关闭。日志在网络操作前持久化未知状态；相同命令不会重复调用transport，重启也不重发。批准的账号、收件人、正文、修订及作用域绑定为摘要，不存正文或凭据。超时、连接错误、取消保留未知；只有匹配消息ACK变为确认/拒绝。目录必须属于当前用户且权限0700，文件0600，不接受符号链接。测试目录须使用macOS解析后的真实路径。

此层接受可信调用方传入的`ApprovedCommand`，不是公开鉴权接口；后端批准验证、设备注册、配额尚待接通。不可将构造此对象等同于获得用户批准，当前未注册任何产品外发入口。

`sessions.py`管理本进程专用IM客户端，按账号独占、按工作区/用户/设备及会话代次校验执行。账号内串行等待后重新读取时钟验证批准有效期，关闭取消正在连接和执行的工作，未决日志保持未知；关闭失败保留账号占用，不新建重叠连接。其他账号不共享锁。它只接受可信登录层交付的客户端，不加载凭据、不扫描浏览器，也不是已经实现的网页登录入口。进程级单实例、正常登录获取客户端和后端批准验证须由后续产品装配实现。

`upstream_transport.py`桥接固定上游`XHSWebSocket.send_chat_message/events`，保留已持久化的客户端消息ID，不使用上游会生成新ID的快捷方法。发送前和接收时校验平台用户身份；传输返回不视为成功。不提供HTTP补发。兼容检查已覆盖真实上游编码器→合成socket→真实解码器→持久回执，重复执行仅一次socket写入；没有实际连接平台。

既定行为与验收见 `../../docs/design/xiaohongshu-independent-messaging.md`。正常专用会话登录、单条批准、消息ACK关联和未知结果不重发是后续接入要求；当前不启动浏览器、不读取认证材料、不访问小红书、不外发。

后端独立业务内核位于`backend/src/xiaohongshu-messaging.ts`，具备能力校验、作用域加密存储、正文/收件人版本批准、UTC日配额预留及执行重验、单次领取和精确回执。正文或收件人编辑撤销批准；账号/设备不可编辑，需新建草稿。超过批准有效期的未决执行读取为未知，不重新发放命令；精确迟到回执可对账。当前仅可信内部接口，尚未挂载HTTP、设备鉴权或产品账号读取器。MySQL独立仓库使用工作区/用户主键和聚合修订CAS保护并发配额；SQL边界测试使用受控驱动，尚未实际创建表或执行真实MySQL验收。可运行`pnpm --dir backend test:xiaohongshu`，已纳入根测试。

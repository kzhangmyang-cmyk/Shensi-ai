# 小红书独立适配环境

状态：独立依赖锁定、上游导入和消息回执关联内核已通过离线验证，尚未连接产品的登录、批准或发送入口。不能据此认为私信可用。

固定参考 `cv-cat/Spider_XHS@7077c88f82771f547cc1afdadaec4025be2355e6`，开发源码置于独立目录，不复制到抖音Sidecar。上游README标注非商业学习交流，虽然徽章链接MIT，固定提交未包含LICENSE文件；不据徽章推断可再分发。当前仅在用户已授权的非商业本机开发范围使用。

`apis/xhs_live.py` 的导入链只需 `curl_cffi`，WebSocket连接另需 `aiohttp`。本环境不安装上游的图像、Excel、二维码、PyExecJS依赖；不导入整个采集应用。完整认证签名路径是否需要其他依赖，应在接入该路径时单独验证，当前不宣称覆盖。

环境准备：`uv sync --project services/xiaohongshu`；重建使用 `uv sync --frozen --project services/xiaohongshu`。依赖独立锁定，不改 `services/media-crawler`。

离线测试：`uv run --frozen --project services/xiaohongshu python -m unittest discover -s services/xiaohongshu -p 'test_*.py'`。

固定上游兼容检查：`uv run --frozen --project services/xiaohongshu python services/xiaohongshu/verify_upstream.py /path/to/Spider_XHS`。只接受指定提交的干净源码；用手写合成protobuf经过上游真实解码器检验直接ACK和推送批次，不连接网络。

`receipts.py` 的 `ReceiptTracker`只关联当前账号、会话代次和客户端消息ID的`chatACK`。握手、其他ID、畸形事件保持未决；断线变为未知；精确迟到ACK可对账；终态不会被重复事件覆盖。账号和代次由会话拥有者传入，不得接受网络自报身份。模块不发送消息、不承担批准、持久化或重发控制；这些调用链尚待实现。

既定行为与验收见 `../../docs/design/xiaohongshu-independent-messaging.md`。正常专用会话登录、单条批准、消息ACK关联和未知结果不重发是后续接入要求；当前不启动浏览器、不读取认证材料、不访问小红书、不外发。

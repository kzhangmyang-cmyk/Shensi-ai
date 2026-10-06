# 本地参考知识库

当前阶段：合同、领域、加密原件、MySQL 仓储及认证 HTTP 上传/查询已实现并专项验证；解析索引、页面和问答接入尚未交付。实施依据为 [设计](../design/local-knowledge-base.md) 和 [计划](../design/local-knowledge-base-implementation.md)，实际进度见 [PROJECT_STATUS](../PROJECT_STATUS.md)。

## 已实现边界

`backend/src/knowledge/domain.ts` 定义资料、版本、原文坐标和处理状态。仓储接口所有用户操作携带已认证的 `ActiveWorkspaceContext`，workspace＋actor 双重隔离，拒绝 `all`。角色标签仅决定六专家适用性，不授予账户访问权。

`MemoryKnowledgeRepository` 是领域测试替身，不是产品存储 fallback。命令验证幂等键和 revision；未收完原件不可领取任务，解析进入 indexing 后才可发布 ready。租约 fence、替换、停用、删除和取消阻止旧任务发布；替换就绪之前保留上一有效版本。

三个本人资料能力为 `knowledge.read`、`knowledge.upload`、`knowledge.manage_own`；它们不授予 `finance.council.run`。原件和正文不暴露存储 key、actor 或私有路径。

## 本地持久存储

`MysqlKnowledgeRepository` 仅幂等创建 `knowledge_documents`、`knowledge_versions`、`knowledge_chunks`、`knowledge_jobs`、`knowledge_commands` 五表，不迁移或删除现有业务表。资料 metadata、版本 metadata、正文片段和命令结果使用独立 AES-256-GCM 加密；可查询的 owner、记录标识、revision、处理状态及租约仅服务权限筛选和调度。每个写入事务锁定所属资料，复核 revision 与 worker fence/lease；ready 的版本发布和有效版切换在同一事务完成。

`createKnowledgeCrypto` 必须收到明确稳定密钥（至少32字符），以 HKDF 分离 metadata、原件和分页签名用途；没有随机开发 fallback。接入模块将消费本地安装的稳定 `AGENT_JOB_ENCRYPTION_KEY`。丢失该密钥不能恢复私有资料，不应自动替换密钥或改为明文。

`createKnowledgeFileStore` 使用可信的绝对 root，目录0700、文件0600、拒绝软链接和跨 owner 访问。原件按50MiB上限流式加密，附加数据绑定 workspace、actor、document、version、格式和原始字节数。消费者只能在 GCM 及 SHA-256 全部校验之后拿到临时原件；正常结束、解析异常或取消后 finally 清理私有临时目录。删除仅作用于 opaque key 对应的私有副本，不能删除用户上传前的原始路径。`KnowledgeService` 在数据库成功读回、证明新副本未被引用时补偿删除；提交结果不确定或数据库不可读时保留加密副本并返回 unavailable，不能自动重传或删除可能已提交的原件。该不确定分支尚无自动孤儿清扫器。显式删除先撤销读取，再清理本人副本；相同删除命令可手动重试清理。

Main 的 `paths.knowledge` 固定为 `userData/knowledge`，单机启动准备创建该私有目录并通过后端环境 `SHENSI_KNOWLEDGE_STORAGE_ROOT` 注入；源码开发 launcher 使用自身 `.runtime/desktop-local/knowledge`。生产、开发和测试目录互不共用。Renderer 不能指定此路径；源开发也不继承外部同名环境变量。现有安装凭据和业务数据库身份保持不变。

## 合同

独立定义在 `contracts/openapi/knowledge.v1.yaml`；共享公共 schema 为 `contracts/json-schema/knowledge.v1.schema.json`，前端使用生成的 `src/generated/knowledge.ts`。

支持上传格式 PDF/DOCX/XLSX/CSV/TXT/MD，单文件上限50MiB。资料 metadata 与原件字节分开提交，签名/文本编码验证通过及收完文件仅进入 queued，真实解析/索引未完成不能用于问答。公共 document 包含 activeVersionId 和 latestVersionId；版本包含自身 revision、opaque jobId 与真实状态。文档编辑/替换使用文档 revision，原件上传/重试使用版本 revision。

## HTTP 与桌面传输

`createKnowledgeModule` 在财务委员会之前安装，注册私有 `KNOWLEDGE_SERVICE`，只有真实 MySQL＋可信 root＋稳定密钥才启用；缺配置只使知识库 unavailable，不使用内存 fallback。现有平台功能授权仍适用（当前沿 CRM 功能门禁），没有新增授权绕过。

`/api/v1/knowledge` 接入既有 requireAuth、Cookie CSRF 及真实 workspace resolver。入口先鉴权再读取 body；普通 JSON 上限1MiB。只有准确 UUID 版本路径的 PUT/GET `/content` 流式传原始字节、上限50MiB和120秒；桌面代理保留来源、Cookie、CSRF、构建身份及禁止 redirect，邻近路径/其他 method 保留原预算。取消、断网及字节不符不会产生可领取的半文件。片段预览每页最多100条，cursor 签名绑定本人和文档版本。

写操作使用 Idempotency-Key 与带引号的 If-Match revision。收到不确定结果应先查文档/版本；产品不自动重传文件。人工使用原 key/revision 重试只接受相同字节，不重复创建原件；不同内容返回409。

Growth 1.0.38 为当前引用协议：CFO 文字输入及 session ask 可选 `knowledgeMode: auto|off`，省略保持旧调用/语音行为；可选 knowledge 包含详细正文、来源及不确定性，旧 answer 仍限4000字符。模型/聊天实际消费此字段需后续接入，不能据合同已生成声称问答可用。

书籍仅为不可信参考数据，不是系统指令、企业已核实事实或现行法规证明。最多六个命中片段，合计12000字符；详细正文最多12000字符，来源须带文档版本、hash、片段与物理页/章节/坐标。

## 验证

```bash
pnpm --dir backend test:knowledge
# 仅在显式配置 MYSQL_TEST_ADMIN_URL 后运行；不得回退 DATABASE_URL。
pnpm --dir backend test:knowledge:mysql
pnpm --filter ./contracts check:knowledge-types
pnpm check:growth-contracts
pnpm --dir frontend contract:check
```

MySQL 专项会随机创建/删除自己的测试库，关连接后另开 pool 验证读回；该证据不等于整个 MySQL daemon 或 Electron 已完整退出重启。2026-10-06 已验证 MySQL 8.4.11 三项真实专项、零跳过；桌面路径/启动准备专项通过，原生应用完整重启测试未配置资源时明确跳过。

私有21份PDF及4742页提取结果保留在本机，不进源码、公共搜索或客户安装包；当前尚未导入产品知识库。

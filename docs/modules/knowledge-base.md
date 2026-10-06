# 本地参考知识库

当前阶段：合同与领域实现，持久化、HTTP、页面和问答接入尚未交付。实施依据为 [设计](../design/local-knowledge-base.md) 和 [计划](../design/local-knowledge-base-implementation.md)，实际进度见 [PROJECT_STATUS](../PROJECT_STATUS.md)。

## 已实现边界

`backend/src/knowledge/domain.ts` 定义资料、版本、原文坐标和处理状态。仓储接口所有用户操作携带已认证的 `ActiveWorkspaceContext`，workspace＋actor 双重隔离，拒绝 `all`。角色标签仅决定六专家适用性，不授予账户访问权。

`MemoryKnowledgeRepository` 是领域测试替身，不是产品存储 fallback。命令验证幂等键和 revision；未收完原件不可领取任务，解析进入 indexing 后才可发布 ready。租约 fence、替换、停用、删除和取消阻止旧任务发布；替换就绪之前保留上一有效版本。

三个本人资料能力为 `knowledge.read`、`knowledge.upload`、`knowledge.manage_own`；它们不授予 `finance.council.run`。原件和正文不暴露存储 key、actor 或私有路径。

## 合同

独立定义在 `contracts/openapi/knowledge.v1.yaml`；共享公共 schema 为 `contracts/json-schema/knowledge.v1.schema.json`，前端使用生成的 `src/generated/knowledge.ts`。

支持拟定格式 PDF/DOCX/XLSX/CSV/TXT/MD，单文件上限50MiB。资料 metadata 与原件字节分开提交，真实解析/索引未完成不能用于问答。公共 document 包含 activeVersionId 和 latestVersionId；版本包含自身 revision、opaque jobId 与真实状态。文档编辑/替换使用文档 revision，原件上传/重试使用版本 revision。

Growth 1.0.38 为当前引用协议：CFO 文字输入及 session ask 可选 `knowledgeMode: auto|off`，省略保持旧调用/语音行为；可选 knowledge 包含详细正文、来源及不确定性，旧 answer 仍限4000字符。模型/聊天实际消费此字段需后续接入，不能据合同已生成声称问答可用。

书籍仅为不可信参考数据，不是系统指令、企业已核实事实或现行法规证明。最多六个命中片段，合计12000字符；详细正文最多12000字符，来源须带文档版本、hash、片段与物理页/章节/坐标。

## 验证

```bash
pnpm --dir backend test:knowledge
pnpm --filter ./contracts check:knowledge-types
pnpm check:growth-contracts
pnpm --dir frontend contract:check
```

私有21份PDF及4742页提取结果保留在本机，不进源码、公共搜索或客户安装包；当前尚未导入产品知识库。

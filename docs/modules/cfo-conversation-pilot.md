# 经营总管会话工作区试点

范围仅为现有经营总管文字工作区；保留六角色、黑绿外观、语音、模型路由和业务接口，不替换前后端技术栈。当前执行状态以 PROJECT_STATUS 为准。

## 已核对的复用与缺口

| 能力 | 当前实现 | 本次处理 |
| --- | --- | --- |
| 专业技能、事实与数字校验 | `skills/specialists.ts`、`skills/financial-answer.ts` | 复用，不再建另一套技能引擎 |
| 模型选择与调用记录 | `cfo-conversation.ts` 的持久模型快照、gateway | 复用，不绕过工作区模型配置 |
| 只读资料问答 | `finance-document-service.ts`、`finance-document-model.ts` | 与报表问答一起接入真实阶段 |
| 获客任务恢复 | `cfo-acquisition-workflow-api.ts` 和现有服务端 workflow | 保留，不以聊天记录代替任务状态 |
| 文字历史 | 专用加密 MySQL 会话仓库与历史列表 | 保存完成问答，模型上下文保持最近 10 条 |
| 问答执行状态 | CFO session NDJSON 阶段事件 | 展示实际阶段，不展示推理过程 |

参考 [B-agent](https://github.com/EricHong123/B-agent) 的只读快照
`4e449f26c944fabed0d112cb54b057e9b5e48121`。项目使用 MIT；参考历史会话工作区和事件封装思路，不复制其 Vue/Python 代码。
`backend/app/services/agent_runtime/runtime.py` 明确是迁移中的最小执行壳，不能据此假设已有完整任务执行或恢复能力。Shensi 不引入第二套 runtime。

## 实施顺序与准确边界

1. **真实阶段基础**：`backend/src/cfo-conversation-progress.ts` 定义内部观察器；`financial-council-agent-center.ts`、`cfo-conversation.ts`、`finance-document-service.ts`、`finance-document-model.ts` 在真实调用边界发出阶段。不改变原 JSON 回复、模型提示或语音协议。
2. **历史持久化**：新增专用 CFO 会话仓库，通过 `growth-financial-council-module.ts` 复用现有 MySQL 连接与加密配置。按 actor/workspace 隔离，保存已完成问答和来源元信息；不得将聊天塞入 AgentJob，不迁移或删除业务数据。历史是未核实对话，不是知识库事实。
3. **公开契约与界面**：在现有 Growth 契约定义历史和阶段接口并重新生成类型；扩展 `financial-council-agent-center-router.ts`。`frontend/src/growth/agents/cfo-conversation.ts` 接入 CFO 专用历史列表、新对话与实际状态，继续复用 `cfo-chat-messages.ts`。其他五角色沿用原路径。
4. **开发版验收**：源码窗口验证切换/重开恢复、草稿保留、黑绿布局与语音回归，不生成安装包。

## 验证标准

- 阶段只表明真实操作边界：资料解析完毕不代表有已验证资料；模型请求开始不代表回答成功。
- 模型失败或取消不得出现验证完成；展示事件不包含推理过程、原始资料、密钥或估算百分比。
- 跨账号/工作区不得读取历史；迟到响应不覆盖新会话，资料切换不把旧来源当作当前来源。
- 断线不自动重发问题或恢复真实外部动作；已完成回答可恢复，未完成回答明确保留未完成状态。
- 无新增审批流程；现有获客真实任务状态仍由原业务接口提供。
- 执行 `pnpm --dir backend test:cfo-conversation`、相关前端与语音回归，以及根 `pnpm test`、`pnpm build`、`./scripts/context-check`、`git diff --check`。

阶段 1–4 已完成本轮范围：真实普通问答、页面重开和应用冷启动后恢复已验收。语音仅运行自动回归，未重新开麦；实际记录见 PROJECT_STATUS。

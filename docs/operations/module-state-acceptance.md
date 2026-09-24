# 跨模块状态核验

范围：当前源码的同文档路由切换、身份变化和异步完成；不代表关闭应用后的未保存资料恢复，不恢复抖音队列或自动重放业务写入。

| 表面 | 当前行为 | 证据与边界 |
| --- | --- | --- |
| 智能体聊天附件 | 按会话、角色、账号和工作区隔离；跨页保留文件及解析来源，新对话/清除解除引用，退出清空 | `growth/agents/chat-attachments.self-test.ts`、`cfo-attachments.self-test.ts`、`scripts/test-chat-attachments.mts`；服务端来源一小时过期仍禁止提问，不默用其他资料 |
| 智能体公开联网 | 各角色保存关键词与完成结果；新会话清空，离页取消进行中查询，不自动重试 | `growth/agents/web-research.self-test.ts`；新会话/退出后的迟到回答被丢弃 |
| 财务、ROI、委员会企业资料分析 | 三个用途各自保留原文件对象、选择、解析与完成报告；已启动分析可在离页完成 | `growth/finance/enterprise-analysis.self-test.ts`；登出和工作区变化清理；`runtime.ts` 分别以 finance/roi/management 挂载，不跨用途混用 |
| 星盘 | 保留同账号/工作区的原表单、文件、已读资料、步骤与回放选择；离页保存完成后返回不重发 | `decision-simulation/view.test.ts`、`scripts/test-decision-parameters.mts`；实际浏览器保留 FileList 与金额，切工作区立即移除私有内容；不延长服务端准备会话有效期 |
| 财务结构化入账队列 | 离开页面清空未提交文件/映射与本地队列并中止页面请求；已持久化台账重新读取 | `growth/runtime.ts` 的 finance unmount 明确清理；这与上方只读企业资料面板是两个不同流程。未实现未提交入账队列的跨页恢复，不将它计为已保留 |
| 报价工作台 | 按 quoteCaseId 重新读取服务端版本和目录，卸载中止页面命令；已保存草稿属于服务端数据 | `growth/runtime.ts` quote mount/unmount 与 `quotes/controller.ts`；尚未保存的表单不是持久报价版本，当前不承诺跨页保留，审批上下文不能作为可自动复用的草稿 |
| 财务委员会报告 | 按 runId 或历史入口读取已有任务，不通过回看重新创建分析 | `growth/council/entry.ts`、controller/entry 自测；报告阅读与创建操作分开，修订/审批仍受当前业务版本约束 |
| 增长顾问、客户目录、ROI指标 | 重新读取真实业务状态，导航不把显示缓存当作新业务事实 | `growth/runtime.ts` 的读取注册路径及各 controller 自测；刷新不是自动执行建议、确认报价或入账 |
| 抖音社媒 | 冻结 | 本轮不改变登录、采集、设备绑定、任务或外发。旧暂停队列不恢复 |

## 隔离验收命令

```bash
pnpm --dir frontend exec tsx src/growth/finance/enterprise-analysis.self-test.ts
pnpm --dir frontend exec tsx src/growth/agents/web-research.self-test.ts
pnpm --dir frontend exec tsx --test src/decision-simulation/*.test.ts
pnpm --dir frontend exec tsx scripts/test-chat-attachments.mts
pnpm --dir frontend exec tsx scripts/test-decision-parameters.mts
pnpm test
pnpm build
./scripts/context-check
git diff --check
```

表中的代码路径均相对 `frontend/src`，脚本路径相对 `frontend`。隔离浏览器使用合成资料与受控服务，不是当前运行桌面应用的发布验收。应用同步必须单独核验；在抖音运行实例冻结期间不能以重启同一实例完成该项。

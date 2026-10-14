# ROI 页面

`api.ts` 使用生成的 Growth 合同读取获客批次与经营绩效，`controller.ts` 将结果转换为页面状态，`view.ts` 展示预计 ROI、已关账实际 ROI 与现金回收。业务计算、权限与数据截止口径由 Backend 决定；视图不补造数据。

`runtime-binding.ts` 负责页面事件与异步生命周期。Growth 主运行时通过 `createRoiRuntimeBinding` 注册 ROI 页面，传入宿主查询、清理函数和控制器工厂。每次挂载使用独立控制器；离开页面、路由取消或销毁会取消读取并移除事件。请求即使忽略取消信号，返回时也必须仍属于同一次挂载、同一查询代次才可以更新页面。

查询期间保留筛选栏。相同范围的重复提交共用正在执行的查询；提交新范围会取消前一次查询，只有最后一次结果可以展示。当前查询失败时保留范围并允许重试；离开前的成功或失败均不能覆盖重新打开的筛选。销毁后不能重新挂载或写入 DOM。

`labels.ts` 提供计算状态、数据缺口原因和请求错误的中文说明。现金比率按生成合同中的 `valueBps` 展示，包括真实零值；预计/实际 ROI、覆盖率与计算依据的原始数值不变。内部枚举仍可保留在事件数据属性中，不能直接作为业务状态显示。

针对性验证（在 `frontend` 目录运行，不调用真实服务）：

```sh
node --import tsx --test --test-concurrency=1 src/growth/roi/runtime-binding.self-test.ts src/growth/roi/rendering-regression.self-test.ts src/growth/roi/api.self-test.ts src/growth/roi/controller.self-test.ts src/growth/roi/view.self-test.ts src/growth/roi/tabs.self-test.ts
```

生命周期测试使用 LinkeDOM 和受控 API，故意让旧请求忽略 AbortSignal，从而验证晚到成功、失败及批次列表都不能污染当前页面。测试覆盖范围不包括原生设备、真实 API/MySQL 或全产品构建。

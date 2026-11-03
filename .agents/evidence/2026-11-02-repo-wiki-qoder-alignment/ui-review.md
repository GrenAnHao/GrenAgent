# UI 任务 6 独立审查

## 结论

**需修复 1 项 P2 后验收。** 并行展开、README 阶段和计数隔离的方向正确；暂停后的陈旧单项回退仍会误报“当前内容/当前文档”。没有发现需要重做整体外观的问题。

本次以 `ui-review.diff` 的开工副本为归属基线，对照已批准设计与计划任务 6，读取当前产品源码；未把其他 dirty 变更归入本次实现。未改产品文件、未调用模型、未重跑已有测试。

## 必须修复

### [P2] 清除并行集合后，不应重新显示陈旧的单项

- 主位置：`D:/OneDrive/Project Files/Pi/electron-agent/src/features/repoWiki/knowledgeProjection.ts:103`。
- 受影响展示：`D:/OneDrive/Project Files/Pi/electron-agent/vendor/repo-wiki/apps/web/src/workspace/GenerationOverview.tsx:103`；`D:/OneDrive/Project Files/Pi/electron-agent/src/features/agentData/TaskDetailDrawer.tsx:178`。
- 触发条件：运行快照有多个 `activeItems`，同时保留兼容字段 `currentItem` / `detail.currentPage`；随后变为 `paused`，或者任务详情变为失败、取消等终态，而兼容字段仍保留最后一个条目。
- 原因：第 64 行正确把非运行状态的 `activeItems` 归零，但第 103 行又无条件回退到 `run.currentItem`。暂停仍属于 `view.inFlight`，概览因此在并行列表消失后重新显示“当前内容”。任务详情仅用 `!activeLabel` 判断是否显示 `detail.currentPage`，故暂停及终态同样重新出现陈旧“当前文档”。现有暂停断言只检查列表/数量消失，没有检查这个替代显示。
- 影响：界面一边说“生成已暂停”，一边仍把最后一项作为“当前”执行内容；三个入口对“在途”的含义不再一致，不满足暂停/终态不显示陈旧在途的验收要求。
- 具体修法：共享投影的 `currentItem` 与 `activeItems` 使用同一运行状态门控；运行时若提供了 `activeItems`（含空数组），以该集合为准，仅缺少该可选字段的旧快照才回退 `run.currentItem`。任务详情对有 knowledge 的任务使用该投影的单项，而不是无条件回退 `detail.currentPage`；无 knowledge 的其他旧任务继续沿用现有展示。若需要展示历史最后一项，应另标为“最后处理”，不要作为当前在途回退。
- 所需回归：保留陈旧 `currentItem/currentPage/activeItems`，从 running 切 paused、failed、cancelled，确认概览/任务详情不出现“当前内容/当前文档”；另保留旧 running 快照缺 `activeItems` 的兼容测试。增加运行态 `activeItems: []` + 陈旧兼容字段的断言，确认权威空集合不复活旧项。

## 已满足的规格与质量

- `readme` 有专用阶段文案，并加入未知分母阶段集合；进度和 prepared 标签没有把旧页面总数当作该阶段分母。
- 多项状态通过一个原生 `details/summary` 组件复用到概览、阅读 banner、任务详情；generate 按 Wiki/Cards 使用篇/张，目录等使用项。
- prepared、published 仍分开，未把准备完成或 99% 当成正式发布。
- 已查看 `parallel-light-narrow.png`：正文卡内长标题正常换行，层级清楚，没有可见横向溢出；与本次限定的小幅状态补充相称。
- 复用 `ui-report.md` 的 43 项单测和真实 Electron `repo-wiki` 162 PASS / 0 FAIL 证据；日志有真实鼠标展开、空格键收起、窄屏长项、旧快照及暂停反馈。该证据足以支持已有通过路径，不覆盖上述单项回退缺口。

## 验收边界

本审查不评价仍在施工的后端并发/发布实现。UI 桩与截图不构成真实模型 HTTP 并发证据。当前唯一阻碍 UI 任务 6 验收的是上述陈旧单项回退；修复后只需运行直接受影响的投影/任务详情测试与对应 repo-wiki 断言，不需要全量 UI 场景。

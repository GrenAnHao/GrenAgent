# 并行状态 UI 验证

Owner：root。实现计划任务 6。

## 结果

- 新增共享的原生 details 展开条目列表，概览、阅读横幅、任务详情复用；多项显示“处理中 N 篇/张/项”，单项及旧记录保留 currentItem 展示。
- readme 显示本地前置阶段且不画页面分母；暂停/终态忽略陈旧 activeItems；prepared/published 计数含义不变。
- `ui-red.log`：专项 3 文件 5 项按预期失败（缺 readme/activeItems/并行 UI）。
- `ui-green.log`：最终同三个文件全部 46 项通过，exit 0，11.52s。
- `ui-harness.log`：最终真实 Electron `repo-wiki` 场景 163 PASS / 0 FAIL，exit 0，58.4s；仅 1/44 场景，未跑其他 43 个。
- 已查看实际 `parallel-light-narrow.png`：窄屏超长条目在卡片内换行，无横向溢出；真实鼠标展开和原生空格键收起通过，暂停后列表消失。首次 probe 使用 Return 未产生原生 details 的空格激活事件，改为真实空格输入后通过，未改 harness 或产品键盘逻辑。

## 范围

实际 diff 见 ui-review.diff（相对开工工作区副本，不混入原有 Git dirty 变更）。产品改动仅 knowledgeProjection.ts、新 KnowledgeActiveItems.tsx、TaskDetailDrawer.tsx、vendor GenerationOverview.tsx/KnowledgeRunStatus.tsx；相应三个测试和 repo-wiki 场景/probe 同步。

未调用付费模型、未修改模型配置、未重启用户实例。核心实际并发仍由 implement_core 的后端/集成验收负责，UI 桩不作为模型 HTTP 并发证明。

## 独立审查修复

ui-review.md 发现暂停/终态仍回退兼容 currentItem/currentPage。ui-fix-red.log 中 5 项断言按预期失败后，投影改为只在实际活动状态显示单项，提供 activeItems 时以集合（含空数组）为准；有 knowledge 的任务详情消费同一投影，普通旧任务 currentPage 行为保持。最终 GREEN 和 Electron 场景已覆盖修复，定向 diff 为 ui-review-fix.diff。

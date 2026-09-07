# AgentData 任务列表与详情样稿实现计划

> **面向 AI 代理的工作者：** 本计划只覆盖任务列表与任务详情的视觉层级，不改变任务协议、权限、轮询、重试或审计行为。

**目标：** 让 AgentData 任务列表和详情在桌面、窄屏、浅色与深色主题下具备稳定间距、可读的长路径和清晰的信息层级。

**架构：** 保留现有 Ant Design Drawer、React 组件和 `antd-style` 主题变量。列表继续显示任务名称、资源、状态、阶段/进度和能力按钮；详情改为分区信息块，长 ID/路径在视觉上截断但保留复制/完整阅读入口，不从 DTO 删除数据。

**技术栈：** React、Ant Design、antd-style、Vitest、Testing Library。

---

## 文件职责

- 修改 `electron-agent/src/features/agentData/operationsStyles.ts`：任务/详情/操作记录共用的间距、排版、长文本和响应式布局。
- 修改 `electron-agent/src/features/agentData/agentDataStyles.ts`：任务行、路径摘要、状态标签和操作按钮的基础可读性。
- 修改 `electron-agent/src/features/agentData/JobsPanel.tsx`：列表只呈现摘要，完整工作区/资源保留在详情和可访问文本中。
- 修改 `electron-agent/src/features/agentData/TaskDetailDrawer.tsx`：增加标题区、状态摘要、元数据分组、可折叠摘要和事件时间线的语义结构。
- 扩展 `electron-agent/src/features/agentData/JobsPanel.operations.test.tsx` 与 `TaskDetailDrawer.test.tsx`：锁定长路径、分组标题、系统任务只读和窄屏结构。

## 任务 1：详情结构回归

- [x] 在现有详情测试中增加失败断言：详情包含“状态摘要”“任务信息”“执行摘要”“任务事件”四个分组；完整 ID 与工作区仍能通过语义元素读取；输入/输出摘要保持折叠。
- [x] 增加失败断言：错误信息、阶段和事件文本在长字符串下仍位于详情滚动区域，不改变 `TaskView` 能力按钮。
- [x] 运行目标测试确认新增断言先失败，随后由结构调整通过。

## 任务 2：列表摘要与视觉令牌

- [x] 给任务行增加稳定的摘要样式：名称与错误上下排列，路径/资源使用单行省略；完整值通过 `title` 或详情抽屉保留。
- [x] 将操作按钮统一为紧凑但可点击的 32px 控件，状态标签使用统一内边距与行高；系统任务继续只读且不显示可执行按钮。
- [x] 在 `operationsStyles` 中建立详情分区、字段网格、事件时间线、摘要卡片和小于 800px 的响应式规则；使用 Ant Design token，不引入新组件库或硬编码主题色。
- [x] 运行任务测试，确认系统任务能力、复合 ID 和长路径断言通过。

## 任务 3：详情抽屉和响应式验证

- [x] 使用明确的标题区和状态摘要块包裹详情；元数据按“任务信息 / 资源信息 / 执行摘要”分组，保留重试确认和错误行为不变。
- [x] 为 Drawer body 设置稳定滚动、最小宽度和窄屏满宽行为；详情内部不得让 `dl`、`pre`、事件列表溢出 Drawer。
- [x] 运行目标任务回归：3 文件、52 项通过；构建通过。
- [x] 使用隔离内存数据检查深色 1440×900、深色 760×800；窄屏无横向溢出，长路径、错误、系统任务只读和详情滚动可见。

## 任务 4：阶段验收

- [ ] 运行 AgentData 前端全量回归和 Electron 构建；本轮已运行目标任务回归与 `npm run build`，全量回归留给合并前验收。
- [x] 对比 `git diff --check`，确认本轮修改集中在任务 UI、对应测试和计划文档。
- [x] 记录未覆盖的真实模型、CodeGraph、用户数据库和生产 Electron 重启边界。

## 全工作台一致性审查（接续反馈）

用户反馈不仅涉及任务页，审查范围扩展到 Overview、Memory、Wiki、Code、Jobs、Audit/Diagnostics 六个面板。统一规则如下：

- 正文 13px、辅助文字 12px、面板标题 14–16px、统计数字只在真实数值时使用 24px。
- 输入、选择器和操作按钮统一 34px 高度与 12–13px 字号；保留现有深色/浅色主题 token。
- 长文本在列表与概览中使用两行摘要或单行省略，并通过 `title`、详情或滚动区域保留完整内容。
- 表格、Memory 文档、Wiki 文档和 Code 结果使用一致的行高、边框、滚动和窄屏规则。

本轮已应用到共享样式、Overview、Memory、Wiki、Code 和任务/审计样式；AgentData 前端 29 文件、366 项测试通过，Electron 构建通过。真实 Electron 窗口、真实模型、CodeGraph 和用户数据库仍需重启/指定环境后复核。

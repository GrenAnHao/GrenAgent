# Agent Note: 专业工作台的布局与视觉层级

Status: implemented

## Problem

新对话页的标题居中、编辑器贴底，两者相距过远；侧栏项目与会话视觉层级接近，边线与输入框阴影过重。用户在两版视觉提案中选择保留常驻导航的「专业工作台」。

## Decision

保留导航、会话状态、消息宽度、Dock 标签及输入操作。新对话页把项目标识、简短标题、输入框组成居中区域；有消息后输入框继续贴底。同一份 ChatInput 只改变容器样式，不随空态切换重挂载，保护正文、附件、偏好与任务卡。

输入框实际最大宽度 880px，初始高度约 120–140px，支持内容增长；侧栏以淡底、缩进、字重和行距建立层级。工作台外壳使用中性暖灰与低饱和绿，深浅色同步，表单、错误、审批与注意状态继续使用原语义主题色。

## Related notes

当前空态布局以用户视觉确认后的[响应式整体居中](../bug-fix/2026-10-31-responsive-empty-chat.md)为准，取代中间阶段的[草稿统一贴底](../bug-fix/2026-10-31-draft-composer-bottom.md)；输入区节点延续、侧栏与其他视觉决定继续有效。

本篇的自定义配色保留策略和消息态 880px 限宽已由[单一工作台配色与输入对齐](../simplification/2026-10-30-single-workbench-theme.md)部分取代；其余空态分组、编辑器延续、侧栏层级和滚轮规则继续有效。

已检索新对话、欢迎页、输入框布局、侧栏样式、主题 token 与工作台。相关的[会话偏好与草稿归属](../../implemented/feature/2026-10-28-session-preferences-behavior.md)、[会话查找](../../implemented/feature/2026-10-23-find-in-session-and-file.md)仅部分重叠，继续保留其会话身份与查找范围约束。其余命中无关，无旧决定被完全取代。

## Alternatives considered

- 专注画布把项目导航收进顶部，可以给单任务更多空间；用户使用多个项目与会话，选择常驻侧栏，因此不作为本次默认布局。
- 为空态创建另一份编辑器能更直接排版；但会复制草稿、附件、会话偏好与事件生命周期，布局切换也可能丢失正在输入的内容，因此只移动既有容器的位置。
- 全局更换 antd 主色与所有表面能让管理面板也完全一致；这会扩张到本次之外的页面，因此只提供工作台外壳变量，语义控件保持原有主题。

## Consequences

空态的视觉重心集中到任务输入，侧栏保留多项目导航效率。代价是主对话外壳拥有独立的中性色板，管理面板及表单仍沿用用户原主题方案；本次不统一所有页面，也不改消息阅读列宽。

极矮窗口和多附件可能超过空态高度，空态整区允许原生滚动，自动外边距在空间不足时归零，标题不会被负向居中裁掉。MessageEditor 只在消息态提供 scrollTranscript 时注册草稿边界滚轮转发，空态留给外层自然接管；否则短草稿会无条件 preventDefault，吞掉滚轮。

新增 workbench-layout 使用真实组件和真实 store，只替换宿主读写。场景在挂载输入框前等待附件 rehydrate、清理自己固定 fixture owner 的残留数据，避免上次短窗口的附件污染下次空态尺寸。

## Verification

- `npx vitest run` 定向运行 EmptyChatPrompt、ChatView、ChatInput、ThemeBridge、Titlebar、ModuleRail、SessionItem、ProjectItem、SidebarSectionHeader：9 文件、103 项通过。布局测试先观察旧版 absolute 空态失败，再验证原编辑器节点在布局切换后保持；标题测试先观察旧文案失败。
- `npm run ui:check -- workbench-layout`：48 项通过；保留存档连续复跑仍为 48 项通过。大屏输入卡实测 880×135.39px，760px 窗口时 396×123.33px，标题到卡片间距均 32px。覆盖完整标题栏与模块栏、深浅色、消息末行无遮挡、编辑器节点与草稿延续、侧栏选择折叠及短窗口多粘贴块滚轮。
- 短窗口滚轮先失败（263.33→263.33），修复后通过（498→398）；对应红绿日志保留。
- `npm run ui:check -- session-row sidebar-sections`：68 + 59 项通过。`--changed --dry-run` 因共享 ThemeBridge 与工作区其他未提交修改列出全部 40 个场景；本次只实际执行上述 3 个相关场景，其余未运行。
- 证据与实际组件截图：`.agents/evidence/2026-10-30-professional-workbench/`。验证范围是渲染层与受控宿主桩，不覆盖真实主进程业务或打包安装。

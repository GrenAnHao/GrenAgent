# Agent Note: 草稿输入框统一贴底

Status: implemented

用户通过视觉对比确认后，空态固定底部的决定已由[响应式整体居中](2026-10-31-responsive-empty-chat.md)取代；本篇的已有消息贴底、编辑器/草稿延续等约束继续有效。

## Problem

专业工作台曾把空白页标题和输入框组合居中。用户现在明确要求草稿输入框保持底部；当前 showEmptyLayout 切换 composer-seat 为 relative 和自动上下外边距，使新建或恢复的空草稿回到页面中间。

## Decision

同一份 composer-seat 在空草稿、恢复、已有消息与加载阶段都固定到聊天区底部；欢迎标题独立居中，并按既有 seatHeight 为底部输入区让位。仍保留空态紧凑宽度、消息态与内容列对齐，不重建编辑器、不清理草稿或附件。

仅空态输入区限制到可用聊天区高度并允许内部原生滚动，保持极矮窗口多附件可访问；消息态滚轮路由不改。prompt/enhance 浮层挂在 seat 外的聊天列，@ / / 菜单挂在顶层，不因该滚动区新增裁剪。

## Related notes

检索空态、草稿、居中、贴底，命中[专业工作台](../../implemented/feature/2026-10-30-professional-workbench.md)与[单一主题和输入对齐](../../implemented/simplification/2026-10-30-single-workbench-theme.md)。本篇只取代空态标题和输入框组合居中的布局决定，保留配色、尺寸、节点延续和消息态宽度；两篇仍有其他有效决定，不归档。

## Alternatives considered

- 保留空态分组居中能让欢迎页重心集中；用户已明确要求草稿输入框贴底，因此不保留。
- 输入正文非空后才移到底部能保留空白欢迎页效果；但首次键入或恢复草稿仍会让编辑器跳位，因此所有草稿状态采用同一底部位置。
- 只恢复 absolute 并裁掉溢出区域，代码最少；极矮窗口的多附件会跑到视口顶部之外，因此仅空态 seat 增加限高原生滚动，保留浮层原有 portal。

## Consequences

草稿不再因为消息列表为空而切换到页面中间。欢迎标题与输入框不再组成一组，空态沿用独立标题留白；代价是取消先前的紧凑欢迎页组合。空态 seat 内部原生滚动保留极矮窗口访问附件、正文及发送按钮的能力，不改消息态的滚轮转发或浮层 portal。

## Verification

- `npx vitest run src/features/chat/ChatView.test.tsx src/features/chat/ChatInput.test.tsx`：2 文件、60 项通过。先观察旧 relative 草稿的 2 失败 / 38 通过，再实现固定底部。
- `npm run ui:check -- workbench-layout`：142 项通过，仅运行当前场景 1/42，其他 41 个未运行。覆盖新建、两份 draftId 来回切换、同 owner 重挂载草稿正文恢复、未重挂载时编辑器节点延续、消息/空态往返、深浅色、宽窄屏与底边几何。
- 800×300 多粘贴块时 seat 下沿=视口下沿 300px，内部 clientHeight=218 / scrollHeight=455；真实滚轮可到正文/发送，发送按钮在视区内并可命中。欢迎标题位于常规高度的输入区上方，消息态宽度对齐继续通过。
- 源码审查确认 prompt/enhance 的 portal 在聊天列，@ / / 菜单的 portal 在顶层，不由新增 seat overflow 裁剪；极矮窗口锚点越界的既有菜单高度限制不属于本次改造。
- 证据与实际组件截图：`.agents/evidence/2026-10-31-draft-composer-bottom/`。宿主读写使用桩，不代表真实后端会话切换或安装包验证。

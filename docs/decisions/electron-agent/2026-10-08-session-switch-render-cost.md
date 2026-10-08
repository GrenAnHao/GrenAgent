---
title: 切会话卡顿：emotion 改 speedy、activeWorkspace 订阅下沉、侧栏列表结构共享
status: active
date: 2026-10-08
scope: electron-agent
files:
  - electron-agent/src/theme/speedyStyles.ts
  - electron-agent/src/theme/installSpeedyStyles.ts
  - electron-agent/src/main.tsx
  - electron-agent/src/App.tsx
  - electron-agent/src/lib/structuralShare.ts
  - electron-agent/src/features/sessions/useConversations.ts
  - electron-agent/src/features/sessions/useProjectGroups.ts
supersedes:
superseded_by:
---

## 背景

生产渲染层下切会话仍是一帧 180~330ms 的长任务，基本都是点击事件里 React 同步渲染的脚本。CPU 剖析和断点计数显示三处浪费：一、antd-style 默认实例写死 `speedy: false`，一条规则一个 `<style>`，head 里有 2295 个标签；antd 每次注入 cssinjs 都要扫一遍 head 子节点（rc-util `findStyles`，10 次切换累计 335ms），新标签还让整页重算样式。二、App 订阅 `activeWorkspace`，切到别的项目的会话会连主题 Provider、全局样式、弹窗一起重渲。三、侧栏每次切换渲染两遍，4 个对话行、17 个项目行、5 个会话行全部重渲：`useConversations` / `useProjectGroups` 整份重建条目对象，父组件传下来的回调依赖当前工作区的 store，切项目就全换引用，memo 失效，每行都带 antd Dropdown 和 Tooltip。

## 决定

- `main.tsx` 第一个导入 `theme/installSpeedyStyles`，把 antd-style 默认实例的 `styleManager.sheet.isSpeedy` 设为 true，规则改用 insertRule 写进同一个标签。要早于其它模块求值：@lobehub/ui 的 `createStaticStyles` 在导入时就插样式，放在 main.tsx 函数体里还会留下 1300 多个标签。生产包里入口 chunk 静态导入的共享 chunk（Icon、ActionIcon 等）仍先于它求值，约 80 条规则各占一个标签，没有为此打开 rolldown 的 `strictExecutionOrder`。
- `activeWorkspace` 的订阅下沉到 `ActiveWorkspace` 组件，只包住 `AgentStoreProvider` 和 `Workspace`。
- `shareUnchanged` 做结构共享：字段（数组按元素引用）没变的条目沿用上一轮对象。会话分组先共享 `sessions` 再共享分组。传给侧栏的回调经 `useStableCallback` 固定引用，调用时转到最新实现。

改完 head 里 186 个 style 标签；切会话剩一帧 60~107ms（平均 86ms），侧栏每次只重渲选中状态变了的 2 行。

## 放弃的方案

- 用 antd-style 的 `StyleProvider speedy` 包住应用：Provider 新建的 emotion 实例只管经 Context 的 `createStyles`，静态样式和 `cx` 仍走默认实例。
- 给 `<Sidebar>` 外层再加一层 memo：回调和条目引用照样每次都变，memo 拦不住。
- 侧栏行去掉 antd Dropdown、改成点开时再挂：行为改动面大，引用稳定后这些行本来就不再重渲。
- 切会话包 `startTransition`：会话状态在 zustand，`useSyncExternalStore` 触发的更新总是同步渲染，transition 不生效。

## 后果

- speedy 模式下规则不出现在 `<style>` 的文本里，DevTools 仍能在 Styles 面板看到和编辑；排查样式时不要再去 head 里找文本。ui-harness 的入口没有打开 speedy，和应用有这一处差别。
- 结构共享依赖条目是浅层数据；以后给 `ConversationItem` / `ProjectGroup` 加嵌套对象字段，该字段每次都会判成“变了”，只是退回原来的全量重渲，不会出错。
- 剩下的一帧主要是新会话自己的内容渲染（Markdown、消息操作栏的 Tooltip/Dropdown）和 `VirtualizedMessageList` 贴底时的强制布局，要再降得从消息列表的渲染缓存入手。

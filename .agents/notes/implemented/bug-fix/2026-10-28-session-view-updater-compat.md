# Agent Note: 会话视图展开状态接管 React setter 时保留函数式更新

Status: implemented

## Problem

落实[每对话独立记忆](../feature/2026-10-28-session-preferences-behavior.md)时，`useSessionViewExpandedState` 最初只接受 boolean，但 `ReasoningInline`、`CodemodeCard`、`ToolExecution` 原本就调用 `setExpanded(v => !v)`。实际 include 渲染代码的 TypeScript 检查发现参数类型错误；仅验证上下文组的布尔回调不能覆盖这些既有调用点。

Vite 不做类型检查时，函数可能进入布尔状态，卡片点击与持久化都会出错。这是本次接入引入的回归，单独记录。

## Decision

展开 hook 保持 React setter 的输入契约：接受布尔值或 `(previous: boolean) => boolean`。有身份时从当前 owner/viewId 的最新 store 值求 previous，未保存时使用 defaultExpanded；无身份时调用本地 React setter。存入持久 store 的始终是布尔值。

显式 `toggle()` 也在调用时读最新值，不使用上一次渲染的闭包；同一 act 中连续两次翻转回到原状态。运行中默认展开的卡片第一次点击能正确收起，用户关闭后后续流式追加不会重新展开。

生产 hook 使用既有 `useOptionalAgentStoreContext`。组件测试缺少该导出时更新测试桩，不在生产代码里添加用于识别 Vitest mock 的 try/catch、namespace 反射或假 context。

## Alternatives considered

逐一把所有函数式调用改成 toggle，改动直观且类型面小；但把既有 setter 统一接管后再缩窄语义容易漏新调用点，因此在 hook 边界兼容原输入。

将 updater 原样传入 store、存盘前才过滤函数，可以推迟求值；但 store 已经持有错误类型，视图和持久状态会分离，因此不用。

按上次渲染的 expanded 求值，写法最短；但快速连续两次调用都会读同一个旧值，因此读取调用瞬间的 store 状态。

## Consequences

既有工具卡和思考正文不需要改写交互约定，新增持久化不改变 React setter 的语义。代价是 hook 明确区分有身份和本地状态两种求值路径，测试必须覆盖这两条路径以及连续调用。

## 验证

结果：通过。证据在 `.agents/evidence/2026-10-28-session-preferences-behavior/`。

- `view-updater-red.log`：函数式 setter 与真实卡片点击相关 7 条失败，包含把函数当布尔、展开状态 undefined、思考正文不收起。
- `view-updater-green.log`、`view-tools-green.log`：对应回归 25 条通过。
- 主线程复核命令：`cd electron-agent && npx vitest run src/stores/sessionViewStateStore.test.ts src/features/chat/useSessionViewExpanded.test.tsx src/features/tools/toolViewExpansion.test.tsx src/features/tools/ToolExecution.test.tsx src/features/chat/TurnTimeline.test.tsx src/features/chat/ChatMessageItems.test.tsx`，6 文件、96 条通过；见 `view-final-compat-green.log`，包含 toggle 连续两次与测试桩补齐后的组件回归。
- `npm run ui:check -- session-preferences`：98 条通过，真实工具行点击保存 boolean、A/B 同工具 ID 不串、页面重载恢复。见 `view-ui-session-preferences.log`。
- `npm run ui:check -- codemode-card invalid-arguments-card`：55＋27 条通过，见 `view-ui-tool-cards.log`。未跑无关全量 UI。
- `view-tsc.log` 的定向 include 中，本次 TS2345/TS7006 已消失；依赖中的既有声明/主题类型诊断保留，不宣称整个工程类型检查通过。

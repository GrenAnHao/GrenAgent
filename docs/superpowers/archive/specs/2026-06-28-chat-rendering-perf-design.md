# 聊天渲染性能加固设计（虚拟化 + 全量预计算缓存 + 定点更新）

- 日期：2026-06-28
- 状态：设计草案（brainstorming 产出），待用户审查 → writing-plans
- 范围：消除"渲染开销随会话总长线性增长"的几处热路径，使开销与**可见消息数**成正比、与会话总长**无关**。覆盖 4 项：(1) 每渲染全量预计算，(2) 列表虚拟化，(3) `agent_end` 全量 map，(4) Rust 回退整文件读取。**纯性能/视图层改动，无数据语义变化、零 Pi fork。**
- 运行时基准：`@earendil-works/pi-coding-agent`（npm 包，仓库无 `pi/` fork）。
- 驱动：主动加固（暂无观察到的卡顿症状），按影响面优先级逐项优化。
- 关联：在 SP-6 上下文控制（`2026-06-26-context-control-design.md`）落地后，对其涉及的聊天渲染链路做性能加固。

## 1. 背景与目标

聊天主对话与子代理对话目前**不做数组级虚拟化**：滚动浏览过整段历史后，所有消息最终全部挂载（`LazyMount` 一旦可见即永久保留）。叠加每次渲染的若干 O(N) 全量遍历，长会话 + 活跃流式下渲染开销随会话增长线性上升。

成功标准：

1. DOM 节点数 / 已挂载组件数 / 每渲染 JS 开销与**可见消息数**成正比，与会话总长**无关**。
2. 流式贴底、`atBottom` 跟随、切会话、子代理对话等**行为与现状一致**。
3. 主对话 + 子代理对话**统一受益**（共享一套虚拟化）。
4. 纯视图层，**无数据语义变化**；现有测试全绿，新增针对性测试。

## 2. 现状核验（实地，带锚点）

- `tauri-agent/src/features/chat/ChatListView.tsx:30` —— `useThrottledValue(messages, 100, { enabled: isStreaming })` 流式 100ms 节流；`:31` `groupMessages(throttledMessages)`（useMemo）；`:50` `useLayoutEffect(scrollToBottom)`、`:56` `ResizeObserver` 贴底；`:81` `<ChatMessageItems messages={display} lazy />`。
- `tauri-agent/src/features/chat/ChatMessageItems.tsx:31-42` —— `unitsByMessage`：**每渲染**全量遍历 messages，把每次 `spawn_agent` 展开为逐个子代理并赋全局连号 #N。`:45-53` —— `answeredQuestions`：**每渲染**反向全量扫描判定提问卡"已答"。`:128-135` —— `messages.map`，离屏条目用 `LazyMount` 包裹，末尾 `EAGER_TAIL=6`（`:145`）立即渲染。
- `tauri-agent/src/features/chat/LazyMount.tsx:20-51` —— IntersectionObserver 进视口即 `setShown(true)` 且 `if (shown) return` **永不回退**：滚过的历史全部常驻 DOM。
- `tauri-agent/src/features/panels/SubAgentConversation.tsx:72-91` —— 自有滚动容器 + `atBottomRef` 跟随，`:88` `<ChatMessageItems messages={display} />`（**未传 `lazy`** → 全量渲染，无虚拟化）。
- `tauri-agent/src/stores/agentReducer.ts`（`applyEvent` 的 `agent_end` 分支）—— 清流式时 `messages.map((m) => m.kind === 'assistant' ? { ...m, streaming: false } : m)`：**每轮结束克隆整段历史**（即便绝大多数 assistant 早已非流式）。
- `tauri-agent/src-tauri/src/commands/agent.rs` —— `find_entry_id_by_timestamp` 用 `std::fs::read_to_string(session_file)` 把**整个会话文件**读入内存再逐行扫描取最后匹配；`agent_rewind_to` 每次"回退到此"调用它。
- `tauri-agent/package.json:37` —— `virtua` 已是依赖（无需引新包）。

结论：item 1（全量预计算）与 item 2（虚拟化）共处同一渲染链路，统一重构收益最大；item 3、item 4 为独立的机械优化。

## 3. 组件设计

### 3.1 共享 `VirtualizedMessageList`（item 2 核心 + 吸收 item 1 的渲染开销）

**职责**：给定 `display: DisplayMessage[]`，只渲染视口 ± overscan 的条目（离屏卸载），并内置"贴底 / `atBottom` 跟随"。主对话与子代理对话共用。

**机制**：

- 基于 `virtua` 的 `VList`（动态高度自动测量）。`renderBody`（user/turn/tool/notice 分发，现 `ChatMessageItems.tsx:55-124`）抽出为纯 item 渲染器（index → node），供 `VList` 调用。
- 贴底：维护 `atBottom`（virtua `onScroll` + range 信息）；发送/流式增长且 `atBottom` 时 `scrollToIndex(last, { align: 'end' })`；用户上滑则不跟随。替代现有手写 `scrollTop = scrollHeight` + `ResizeObserver`。
- 流式：最后一条持续增长 → virtua 重测高度；贴底逻辑据此跟随。
- overscan 取小值（数条），保证 DOM 有界。
- `ChatListView` 与 `SubAgentConversation` 都改用本组件，**顺手消除两处重复的滚动/atBottom 逻辑**（brainstorming 的"改进经手代码"）。
- `LazyMount` 退役（直接替换，无开关）。

**职责边界**：本组件只管"窗口化渲染 + 贴底滚动"；消息分组（`groupMessages`）与全局预计算（见 3.2）仍在调用方，作为 props 传入。

### 3.2 全局预计算缓存（item 1）

`unitsByMessage`（子代理 #N 连号）与 `answeredQuestions`（已答判定）需要**全局**视图，不能窗口化。改为在调用方（`ChatListView` / `SubAgentConversation`）用 `useMemo(() => compute(display), [display])` 缓存：仅在消息变化（已被 100ms 节流）时算一次，不再每渲染/每滚动重算。结果作为 props（或 context）传给 `VirtualizedMessageList` 的 item 渲染器。

`groupMessages` 已 `useMemo`（`ChatListView.tsx:31`），保留。分组本身是 O(n) 轻量重排，不窗口化（连号/已答需全量）。

### 3.3 `agent_end` 定点清流式（item 3）

在 `AgentState` 维护 `streamingMessageId?: string`（`agent_start` / 首个 assistant 增量时置位）。`agent_end` 只定点更新该 id 对应的消息 `streaming: false`，不再克隆整段历史。`streamingMessageId` 缺失时**回退**到现有全量 `messages.map`（安全网）。

### 3.4 Rust 流式读会话文件（item 4）

`find_entry_id_by_timestamp` 把 `read_to_string` 改为 `BufReader` 逐行流式读取，恒定内存。仍需扫到末尾取最后匹配（行为不变）；仅内存曲线由 O(file) 降为 O(1)。

## 4. 数据流

```
messages
  → (流式时 useThrottledValue 100ms)
  → groupMessages (useMemo)
  → 全局预计算 unitsByMessage / answeredQuestions (useMemo)
  → VirtualizedMessageList (virtua VList，仅渲染窗口内)
```

贴底：发送 / 流式增长且 `atBottom` 时 `scrollToIndex(last, {align:'end'})`；`onScroll` 更新 `atBottom`，用户上滑后不打扰。

## 5. 错误处理与降级

- 纯视图层改动，无数据风险；空 / 加载态（`ChatListSkeleton` / `PreparingIndicator`）保留。
- item 3 定点更新在 `streamingMessageId` 缺失时回退全量 map。
- item 4 错误返回不变（读失败 → `Err(String)`），仅内存曲线变化。
- virtua 测高/滚动异常不致数据问题（纯展示）。

## 6. 测试策略

- 单测（可在 jsdom 跑）：
  - 全局预计算抽成纯函数：`unitsByMessage` 连号、`answeredQuestions` 判定与重构前**等价**（同输入同输出）。
  - `agentReducer`：现有 `agent_end` 清流式用例须绿；新增 `streamingMessageId` 定点更新用例（含缺失回退）。
  - `renderBody` 作为纯分发函数的既有覆盖保留。
- virtua 在 jsdom 无法测真实测高/滚动 → 列表层只测"条目数 / key 正确"；滚动、贴底、流式跟随靠**手动验收清单**。
- Rust：`find_entry_id_by_timestamp` 流式版单测（最后匹配、空行、缺失 timestamp、读失败）。
- 手动验收清单：长会话滚动流畅度、流式贴底、切会话滚动位置、子代理对话渲染、跳转/引用行为、空态/加载态。

## 7. 风险与回归点

聊天核心 + 滚动语义重写，回归风险中等：

- 贴底抖动 / 流式增长跟随时机。
- 切会话后滚动位置与首屏。
- 子代理面板（共享组件后）渲染与贴底。
- 动态高度测量在极端长 markdown / 代码块 / 图片下的稳定性。

缓解：纯函数单测 + 全面手动验收（用户已选"直接替换 + 充分测试/验收"路线）。

## 8. 范围边界（YAGNI / 不做什么）

- 不引新依赖（用已在依赖的 `virtua`）。
- 不为"离屏重渲重型 markdown"加渲染结果缓存（除非验收发现来回滚动明显卡，再单列）。
- 不做 find-in-page / 全文搜索（当前无此功能；虚拟化导致的 Ctrl+F 覆盖问题因而不适用）。
- 不处理本次审查中归为"可忽略"的两项（multi-agent `sessionSpawnCount` 只增不删、`scanForAgentEnd` 残行理论重复解析）——非本设计范围。

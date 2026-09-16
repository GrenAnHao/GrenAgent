# GrenAgent 对话渲染 1:1 复刻 lobehub 设计

> 状态：设计已通过视觉伴侣逐屏评审（5 屏全部获批）。下一步：writing-plans 拆实现计划。
> 视觉原型：`.superpowers/brainstorm/chatlist-replica/content/`（10 骨架 / 20 工具 / 30 思考 / 40 子代理 / 51 网页查询-v2）。

## 1. 背景与问题

`tauri-agent` 的对话渲染在 CR-A5/A6 重构中改成了**包裹 `@lobehub/ui/chat` 的高层 `<ChatList>`**，再用 `renderMessages` 把 user/assistant/system 全部覆盖重画（即旧 brainstorm 的「方案 A：假 role + renderMessages」）。结果：

- 满屏 `as any`：`data={lobeMessages as any}`、`renderMessages={... as any}`、`props: any`。
- 双重转换：`messages → groupMessages → toLobeMessages → ChatList → renderMessages` 又把渲染全覆盖回来，等于和组件库对着干。
- 把 `tool`/`notice` 硬塞成 `system` role，靠 `extra.kind` 分派，脆弱。
- 即便 `showAvatar=false` 仍被迫填 `meta/createAt/updateAt`；`loading` prop 触发 DOM 警告（hotfix 历史可证）。

**根因**：lobehub (lobe-chat) 本身**根本不用** `@lobehub/ui/chat` 的高层 `ChatList`/`ChatBubble`。它用 `@lobehub/ui` 的**底层原语**（`Flexbox`/`Accordion`/`Block`/`Icon`/`Markdown`）自建 `MessageItem`(按 role 路由) + 自研 `ChatItem` 外壳 + `ContentBlock`。Pi 走了相反方向，所以才需要那一串 hack。

## 2. 目标 / 非目标

**目标**：把对话消息渲染**像素级 1:1 复刻 lobehub**，覆盖四类：工具调用、思考过程、子代理、网页查询。彻底铲除 `as any`/适配器/假 role，类型干净。

**非目标（本期不做）**：
- 模型原生 SearchGrounding 的 citation 角标 / 来源脚注（需要模型回传 citation 数据）——网页查询走「工具插件式」即可，未来再加。
- 会话侧栏（Sidebar）的改造——本期只动消息渲染区。
- 消息编辑 / 分支 / 重新生成等 lobe-ui ChatList 自带能力——GrenAgent 暂不需要。

## 3. 关键决策（已与用户确认）

| 编号 | 决策 | 选择 |
|------|------|------|
| Q1 | 架构保真度 | **A·彻底复刻**：弃用高层 `<ChatList>`，用 `@lobehub/ui` 原语自建 `MessageItem`+`ChatItem`+`ContentBlock`；自管虚拟滚动；铲除 as-any/adapter/假 role |
| Q2 | 子代理渲染 | **两者都要**：对话流内内联可折叠嵌套子会话 **+** 保留右侧 `RightPanel` tab 深看 |
| Q3 | 网页查询 | **工具插件式**：Inspector（查询词高亮 + 结果数）+ 展开横滑结果卡（ScrollShadow，无原生滚动条） |
| — | 头像 | **不要头像**（用户明确要求；助手/用户均 `showAvatar=false`，且不显示角色标题） |

## 4. 目标架构

### 4.1 数据流（去掉反向覆盖）

```
agentStore.messages (ChatMessage[])
  └─ groupMessages()  → DisplayMessage[]   ← 保留，已产出 assistantGroup
       └─ <ChatList>（自研，非 lobe-ui）   ← 新：直接渲染 DisplayMessage，不再转 lobe ChatMessage
            └─ <MessageItem> 按 kind 路由
                 ├─ user           → <UserMessage>      右对齐气泡
                 ├─ assistantGroup → <AssistantMessage> → <ContentBlock>
                 │                      Reasoning(Thinking) → Markdown → Tools
                 ├─ tool(孤立)     → <ToolExecution>
                 └─ notice         → <NoticePill>
```

`toLobeMessages` 适配器删除。`groupMessages` 保留（已是正确的中间模型）。

### 4.2 ContentBlock 垂直栈（助手消息核心）

对齐 lobehub `AssistantGroup/components/ContentBlock.tsx`：单个 `Flexbox gap={8}`，顺序固定：

```
Reasoning(Thinking) → MessageContent(Markdown) → [ImageList] → Tools
```

多工具时，连续 tool 聚成 workflow segment：单 tool 内联，多 tool 用 `WorkflowCollapse` 总折叠（对齐 lobehub `Group.tsx` 的 partitionBlocks）。

## 5. 视觉规范（深色 token · lobehub 实际取值）

来源：`@lobehub/ui` `generateColorNeutralPalette` + `darkAlgorithm`（gray 中性色 = 零配置默认）；`archive/reference/lobe-ui` 有源码副本可核对。**实现时直接用 `cssVar.*`（antd-style），下表是其在 gray 深色下的实际取值，用于原型与核对。**

| 用途 | token | gray 深色实际值 |
|------|-------|------|
| 页面/对话面 | colorBgContainer | `#0d0d0d` |
| 悬浮层 | colorBgElevated | `#1a1a1a` |
| 边框 | colorBorder | `#202020` |
| 次级边框（状态块/分隔） | colorBorderSecondary | `#1a1a1a` |
| 填充·气泡/块 | colorFillTertiary | `rgba(255,255,255,.06)` |
| 填充·次级（tab 选中） | colorFillSecondary | `rgba(255,255,255,.10)` |
| 填充·四级（hover） | colorFillQuaternary | `rgba(255,255,255,.02)` |
| 正文 | colorText | `#ffffff` |
| 次要文字 | colorTextSecondary | `#aaaaaa` |
| 三级/描述（思考正文·工具标题） | colorTextTertiary / Description | `#6f6f6f` |
| 四级（耗时·禁用） | colorTextQuaternary | `#555555` |
| 成功（勾） | colorSuccess | `#c4f042`（lime） |
| 错误（叉） | colorError | `#f4416c` |
| 警告 | colorWarning | `#ffb224` |
| 信息/主色高亮 | colorInfo | `#60b1ff` |
| 圆角 | borderRadius / LG / SM | `8 / 12 / 6` |
| 字号 | fontSize / SM | `14 / 12` |
| 字体 | fontFamily / Code | HarmonyOS Sans … / Hack,ui-monospace,… |

> 注：用户若启用 sand 暖色等中性色，token 自动变化——实现用 `cssVar.*` 即可随主题走，不写死 hex。

`shinyText`（流式扫光，`src/styles/loading.ts`）：
```css
@keyframes shine { 0%{background-position:100%} 100%{background-position:-100%} }
.shiny{ background:linear-gradient(120deg,transparent 40%,var(--colorTextSecondary) 50%,transparent 60%);
  background-clip:text; -webkit-text-fill-color:transparent; background-size:200% 100%; animation:shine 1.5s linear infinite; }
```

## 6. 组件设计（逐个 · 含精确数值）

### 6.1 ChatItem 外壳（无头像）
- `Flexbox gap={8} paddingBlock={8}`；用户 `paddingInlineStart:36`、右对齐；助手左对齐、body `width:100%`。
- **不渲染头像、不渲染角色标题**（去掉 lobehub 的 avatar/Title header）。
- 时间/操作栏：hover 才显隐（`opacity` 200ms）——本期可省略 actions，仅保留结构位。

### 6.2 用户消息
- 右对齐 + bubble：`padding 8px 12px`，`border-radius: borderRadiusLG(12)`，`background: colorFillTertiary`，`fontSize 14`。

### 6.3 助手消息 → ContentBlock
- 左对齐、全宽、**无气泡**。
- Markdown 走 `LazyMarkdown`（已是 `@lobehub/ui` Markdown `variant="chat"`），行内 code/列表/代码块语法高亮（shiki）。

### 6.4 思考（Thinking）—— 现状已基本对齐，仅核对
- `Collapse/Accordion` borderless，item `paddingBlock/Inline 4`，`gap 8`。
- 标题行 `gap 6`：状态块（24×24 outlined）+ 文案。
  - 进行中：`Loader2` spin + `shinyText`「深度思考中…」。
  - 完成：`Atom` + `Text type=secondary fontSize 12`「已深度思考（用时 X 秒）」。
- 正文：`max-height: min(40vh,320px)`，`padding-inline 8`、`padding-block-end 8`，**整体 `colorTextDescription` 浅色**（含 `article *`）；推理中自动展开 + 自动滚底（`useAutoScroll` threshold 120），结束自动收起。
- 现状 `Thinking.tsx` 已实现以上（注释即写「对齐 lobehub」），**本期保持，仅核对视觉**。

### 6.5 工具调用（Tool）
- 容器：`AccordionItem`（@lobehub/ui Accordion），`paddingBlock/Inline 4`。
- **Inspector（标题行）**：`Flexbox horizontal align=center gap=6`：
  - **StatusIndicator**：`Block variant="outlined"` 24×24，`border:1px colorBorderSecondary`、`background:colorBgContainer`、`borderRadius 8`、`fontSize 12`。图标：done=`Check`(colorSuccess)、error=`X`(colorError)、running=`Loader2` spin（lobehub 用 `NeuralNetworkLoading`，可后续升级；MVP 用 spin）。
  - **ToolTitle**：1 行省略；`name` 用 `fontFamilyCode` + `colorTextSecondary`；`sep`=`ChevronRight`/`›`(tertiary)；`paramKey` code 12 tertiary、`paramValue` code 12 secondary。
  - **ExecutionTime**：`Text fontSize 12 type=secondary`，如 `· 0.1s`。
- **Detail（展开）**：`Flexbox gap=8 paddingBlock=8` + 末尾 `Divider dashed`。按工具类型差异化（现状 `ToolExecution.tsx` 已有，保留并对齐视觉）：
  - `read`：路径标签（code 12 secondary）+ 代码高亮块（`colorFillQuaternary` 底、`colorBorderSecondary` 边、`borderRadius 8`、`maxHeight 320`）。
  - `bash`：命令高亮 + 终端输出块（`colorFillTertiary` 底、code 12，error 时 `#ffa198`）。
  - `edit`：diff（shiki diff 风格：增 `rgba(63,185,80,.15)/#7ee787`，删 `rgba(248,81,73,.15)/#ffa198`）。
  - fallback：JSON 高亮。
- **多工具 WorkflowCollapse**：borderless Accordion；折叠头=状态块 + `Text secondary`「运行了 N 个工具」+ 耗时(`colorTextQuaternary`)；展开切换=`Maximize2`/`Minimize2`（24px 方块、图标 12）；展开为左侧细线列表；运行中标题 `shinyText`，pending `colorInfo`。

### 6.6 子代理（两者都要）
- **流内内联**（新）：`spawn_agent` 在对话流渲染为可折叠块：
  - 折叠头：`Network` 状态块 + `子代理 #n · {task}` + badge「已完成·N步」/状态 + chevron。
  - 展开：嵌套子会话，左侧 2px 细线缩进，**复用主对话的 Thinking/Tool/Markdown 组件**（略小，20px 状态块）；运行中标题 `shinyText`、实时展开，完成自动收起。
  - 数据：来自 `spawn_agent` 结果的 `details.transcript`（JSONL）→ `messagesFromTranscript` → `groupMessages` → 同款渲染（现状 `SubAgentConversation.tsx` 已有此还原逻辑，复用）。
- **右侧面板**（保留 `RightPanel.tsx`）：tab 切换（状态点 绿=完成/黄=运行/红=错误，对齐现状）+ 完整 `SubAgentConversation`。
- 内联与面板**共用** `ChatMessageItems` / `groupMessages`，保证一致。

### 6.7 网页查询（工具插件式）
- **Inspector**：状态块（`Search`/`Globe`）+ `搜索：{query}(N)`，query 带高亮 marker（`linear-gradient(to top, 主色 ~30% 42%, transparent 42%)`）。
- **结果卡**：展开为横向 **ScrollShadow**——**隐藏原生滚动条**（`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`），右缘渐隐到 `colorBgContainer` 提示「更多 →」，滚到底淡出。卡片 160×80：`Block outlined`、`padding 8`、标题 2 行省略（colorText 12）、底部 favicon 14 + 域名（colorTextSecondary 11）。运行中走 skeleton（5 张 160×80 闪烁）。
- **fetch_url**：`Globe` 状态块 + `fetch_url › {url} · {status}` + 展开抓取正文（Markdown/文本）。
- 现状 `extensionCards.tsx` 的 `WebSearchCard`/`FetchUrlCard` 重写为以上结构。

### 6.8 图标（lucide-react，经 `@lobehub/ui` Icon）
done=`Check` · error=`X` · running=`Loader2`(spin，后续可换 `NeuralNetworkLoading`) · 思考完成=`Atom` · chevron=`ChevronRight` · 搜索=`Search`/`Globe` · 子代理=`Network` · workflow 展开=`Maximize2`/`Minimize2` · 注入提示=`Sparkles`。

## 7. 数据模型映射（保留 / 重写 / 淘汰）

| 文件 | 处置 |
|------|------|
| `stores/agentReducer.ts`（ChatMessage 模型） | 保留 |
| `features/chat/groupMessages.ts`（DisplayMessage） | 保留 |
| `features/chat/messageAdapter.ts`（toLobeMessages） | **淘汰** |
| `features/chat/ChatListView.tsx` | **重写**：自研列表渲染 DisplayMessage，去 `<ChatList>`/as-any |
| `features/chat/AssistantMessage.tsx` | **重写**：自研 ChatItem 外壳 + ContentBlock（去 lobe `ChatItem` 的 docs/avatar） |
| `features/chat/UserMessage.tsx` | **重写**：自研右对齐气泡 |
| `features/chat/Thinking.tsx` | 保留（核对视觉） |
| `features/tools/ToolExecution.tsx`、`StatusIndicator.tsx`、`cardStyles.ts` | 保留 + 对齐视觉（Accordion/Block/ToolTitle 数值） |
| `features/tools/extensionCards.tsx`（web_search/fetch_url/spawn_agent） | **重写**对应卡片为 1:1 结构 |
| `features/panels/RightPanel.tsx`、`SubAgentConversation.tsx`、`ChatMessageItems.tsx` | 保留 + 新增「流内内联子代理」入口 |
| `features/chat/NoticePill.tsx` | 保留 |

## 8. 性能

- **虚拟滚动**：自研列表用 `virtua`（lobehub 同款 `VList`）承长对话；流式期间对最后一条放开实测，避免每 token 重算（保留现有 `useThrottledValue` 100ms 节流思路）。
- **memo**：User/Assistant/Tool/Notice/SubAgent 项全部 `React.memo`（现状已部分有）。
- **分组 memo**：`groupMessages` 走 `useMemo`，引用变化才重算。

## 9. 测试

- 单测：`groupMessages`（assistantGroup 合并、孤立 tool）、新列表渲染（各 kind 路由）、ToolTitle 参数摘要、子代理 transcript 还原。
- 视觉：对照 `.superpowers/brainstorm/chatlist-replica/content/` 五屏原型核对。
- 现有 `AssistantMessage.test.tsx`/`ChatListView.test.tsx` 等随重写更新。

## 10. 原型参考（视觉基准）
- `10-foundation-1to1.html`：骨架 / 无头像 / 用户气泡 / 助手 ContentBlock。
- `20-tools-1to1.html`：工具折叠·展开(read/bash/edit)·WorkflowCollapse。
- `30-thinking-1to1.html`：思考 进行中/完成。
- `40-subagent-1to1.html`：子代理 内联 + RightPanel。
- `51-websearch-1to1-v2.html`：网页查询 Inspector + ScrollShadow 结果卡 + fetch_url。

# 询问卡改为输入框浮层 — 设计规格

- 日期：2026-09-14
- 范围：GrenAgent 桌面端待答询问 / 选择 / 确认 / 输入的呈现位置与关闭规则
- 状态：已审查修订（2026-09-14 对照代码逐条核对；修订项见 §12）
- 取代：`docs/superpowers/archive/plans/2026-06-21-question-selector-redesign.md`（archive/plans，不是 specs）中「待答卡内联进对话流」的位置条款；皮肤、多选、多题分页、回传通路仍以该文为准

## 1. 背景与问题

待答的 `ask_user` 询问卡现在画在会话流的工具行里（`ToolExecution` → `InlineQuestionCard`）。普通 `ctx.ui.select` / `confirm` / `input` 画在输入框上方的文档流里（`PromptRequestCard`）。两种都和指令 `/` pop 不一样：指令 pop 浮在输入框上层、齐宽、不占会话流。

用户要的是：待答时卡浮在输入框上层；选完（或取消）后，会话里才留下摘要。待答卡不能像指令 pop 那样失焦就关。

## 2. 目标 / 非目标

**目标**

- 待答的询问卡、普通选择、确认、输入改为 Composer 锚定浮层（对齐指令 pop 的位置与齐宽）。
- 会话流待答时只留一行「等待你选择」；选完换成「已回答 / 已确认」，点取消换成「已取消」。
- 浮层不因失焦、点空白、Esc、打开 `/` 而关闭。
- 输入框在浮层打开时仍可用；用户发送普通消息 = 取消当前题 + 发送该消息。

**非目标**

- 不改审批卡（允许 / 拒绝 / 允许本次 / 总是允许）。它继续顶在输入框上方，不进浮层。
- 不改 `QuestionSelector` 皮肤、多选、多题分页、自定义项。
- 不改 pi core，不改 `extension_ui_request` / `extension_ui_response` 协议。
- 不改 `ExtensionUiHost` 的路由分发（`ExtensionUiHost.tsx:215-236`）：`__askUser` 仍进 `inlineQuestionStore`，其余 `select` / `confirm` / `input` 仍进 `uiPromptStore`。
- 不改 `source === 'permission'` 请求的回传通道（仍走 `pi.resolvePermission`，见 §4）。
- 不改 `!hasUI` 回退的 `QuestionsCard`（仍在对话流）。
- 不为普通选择 / 确认 / 输入的摘要做跨刷新回放（不改 sidecar 事件）。当次会话可见即可。
- 不把浮层挂到子代理面板（子代理没有独立 Composer）。

## 3. 已确认的设计决定

| 维度 | 决定 |
| --- | --- |
| 位置 | 独立 portal 浮层，锚定输入框（`surfaceRef`），`position: fixed`，齐宽，与 `createBoxMenu` 同一套量位置方式 |
| 范围 | `ask_user` + 非审批的 `select` / `confirm` / `input` |
| 审批 | 仍由 `PromptRequestCard` 在输入框上方占位；浮层的排除条件见 §5.1 |
| 待答会话 | 一行「等待你选择」（`ask_user` 见 §6.1；选择 / 确认 / 输入的优先级规则见 §6.2）；完整卡只在浮层 |
| 选完会话 | 「已回答 / 已确认」摘要 |
| 点取消 | 只回传取消，不发送新消息；占位变成「已取消」 |
| 发送消息 | 先回传取消，再走现有 `send()`；占位消失，不插「已取消」或「跳过提问」 |
| 关闭 | 仅：确定、取消（含卡上 X）、发送消息。失焦 / 点空白 / Esc / 打开 `/` 都不关 |
| 输入框 | 浮层打开时仍可打字、可开 `/` |
| `/` 叠层 | slash 菜单 z-index 高于浮层，可叠在上面；浮层不因此关掉 |
| 实现 | 方案 A：独立浮层宿主，不复用 slash 菜单组件，不把卡绝对定位在输入区内部 |

## 4. 关闭规则

浮层和指令 pop 长得像，关法不同。

**不关**

- 输入框或会话获得焦点
- 点击会话空白、侧栏、输入框
- Esc
- 打开或关闭 `/`、`@` 菜单

**关**

1. 用户在卡上选完并点确定 / 提交：按现有回传（询问卡 `formatAnswers` → `extension_ui_response.value`；选择 / 输入同样回 `value`；确认回 `confirmed: true`）。
2. 用户点卡上的「取消」（或卡上 X）：询问 / 选择 / 输入回 `cancelled: true`；确认回 `confirmed: false`。不发送新消息。
3. 用户发送一条普通消息（含选了 slash 命令后发送）：先按第 2 条回传取消，清浮层，去掉占位行，再走现有 `send()`。若当前回合未结束，走已有 SteerQueue。不新开发送通道，不插「跳过提问」代发文案。

卡上保留「取消」。不增加点遮罩关闭，也不加「点外面关闭」。

X 的处理：现有 `prompt-request-dismiss`（`PromptRequestCard.tsx:147`、`:211`）语义与「取消」相同，随卡一起搬进浮层，它不是第四种关闭方式，只是取消的第二个入口。

回传通道按请求来源分流（沿用 `PromptRequestCard.tsx:114-129`）：`request.source === 'permission'` 走 `pi.resolvePermission(id, 'deny')`，其余走 `extensionUiRespond(workspace, { type: 'extension_ui_response', id, ...payload })`。两条都要在回传后 `clear` 对应 store。

## 5. 架构

```
会话流                            Composer
┌──────────────────┐              ┌─────────────────────┐
│ 助手上文          │              │ ComposerPromptOverlay│
│ [等待你选择]      │              │ portal, fixed        │
│                  │              │ 询问 / 选择 / 确认 /  │
│                  │              │ 输入                  │
└──────────────────┘              └──────────▲──────────┘
                                  ┌──────────┴──────────┐
                                  │ 审批卡（若有，占位）  │
                                  │ 输入框（仍可用）      │
                                  └─────────────────────┘
```

### 5.1 浮层宿主

新建 `ComposerPromptOverlay`，挂在 `MessageEditor` 的 zone 里，用 portal 画到主题根节点，避免被输入区 overflow 裁切。

**portal 容器**：必须与 slash 菜单一致用 `document.getElementById(LOBE_THEME_APP_ID) ?? document.body`（`SlashBoxMenu.tsx:113-116`）。只有挂在同一个容器里，浮层 z-index 1050 与 slash 的 1100 才可比。注意 `VisualCard` / `SubagentHeaderCatalog` / `DockDndProvider` 是 `document.body` portal，会盖在浮层之上，与 z-index 无关；这是既有层级，本期接受。

**挂载位置**：放在 `surface` 那个 div **之后**（`MessageEditor.tsx:169` 之下），不要放在 zone 顶部。React 的 ref attach 与 layout effect 按 DOM 顺序推进，放在 `surface` 之后才能保证首次 measure 时 `surfaceRef.current` 非空。measure 仍要判空跳过（`SlashBoxMenu.tsx:118-121` 的做法），并由 `ResizeObserver` + `window resize` + 滚动捕获兜底。

**锚定与量法**：`surfaceRef`（与 slash 菜单相同）。`left / width` 取 `rect.left / rect.width`，`bottom = window.innerHeight - rect.top + 8`（`MENU_GAP = 8`）。窗口 resize、滚动、输入区高度变化时重新量，回调统一 `requestAnimationFrame` 包装。

**限高**：`QuestionSelector` 选项区已有 `max-height: 260px; overflow-y: auto`（`QuestionSelector/index.tsx:70-71`）。浮层整体再加一层 `max-height: min(60vh, 480px)` 并内部滚动；否则 8 题长卡会顶出屏幕顶部。浮层不跟编辑器的 `open` / blur 生命周期。

**排除审批**：`ComposerPromptOverlay` 只在下列两条**都不成立**时才渲染 `uiPromptStore` 的请求：

1. `request.source === 'permission'` —— 回传走 `pi.resolvePermission`，不属本期范围；
2. `isApprovalSelect(request.options)` —— `PromptRequestCard.tsx:20-22` 的导出函数，仅对 `method !== 'confirm' && method !== 'input'` 的请求有意义，判定沿用现有白名单。

`isApprovalSelect` 单独用不够：它只在 `isSelect` 分支生效，而 permission 来源的请求可能以任意 method 出现。两条取并集才与现状等价。

**单一浮层**：同一 workspace 同时只显示一张。`inlineQuestionStore` 与 `uiPromptStore` 都是 `Record<workspace, item>`、覆盖式写入（`inlineQuestionStore.ts:23`、`uiPromptStore.ts` 同构），天然按 workspace 一条。若两者同时有值（不应发生，因为 `ExtensionUiHost.tsx:219` 对 `__askUser` 直接 `return`，不会再写 `uiPromptStore`），询问卡优先。

### 5.2 谁渲染什么

| 请求 | 现在 | 之后 |
| --- | --- | --- |
| `ask_user`（工具名；载荷哨兵 `__askUser`） | `ToolExecution` 内 `InlineQuestionCard` | 浮层里同一套 `QuestionSelector`；工具行只画占位 |
| 非审批 `select` / `confirm` / `input` | `PromptRequestCard` 顶在输入框上方 | 浮层里同一套 UI |
| 审批 `select` | `PromptRequestCard` 顶在输入框上方 | 不变 |
| `!hasUI` `agent-questions` | `QuestionsCard` 在对话流 | 不变 |

`InlineQuestionCard` 的提交 / 取消逻辑迁到浮层（或抽成无布局的 hook，浮层调用）。`ToolExecution` 不再挂整张询问卡。

工具名与哨兵是两套机制，别混：`ToolExecution.tsx:252-258` 按**工具名小写** `ask_user` 分流，`__askUser` 是 `answers.ts:57-67` 解析 `ctx.ui.input` 载荷用的哨兵。两者各自独立，改动只碰前者。

占位的状态范围：`ConvStatus = 'running' | 'done' | 'error'`（`StatusGlyph.tsx:7`）。只有 `status === 'running'` 才画占位；`error` 不画（语义是失败，不是待答）。现在的写法 `status === 'done' ? 摘要 : <InlineQuestionCard />` 把 error 也算进去了，改的时候要收紧。

子代理面板没有 Composer。子代理 transcript 里若出现 `ask_user` 工具行，运行中同样只显示占位；完整卡仍在主会话输入框浮层，因为回传走同一 workspace 的 store。

### 5.3 与 slash 菜单

不把询问卡塞进 `createBoxMenu`。两套 portal 并存。slash / mention 的 z-index 保持 1100，浮层用 1050，所以 `/` 可以盖在询问卡上。用户选了命令并发送，走 §4 第 3 条。

## 6. 会话占位与摘要

### 6.1 `ask_user`

- 运行中：条件是 `status === 'running'` **且** 该 workspace 的 `inlineQuestionStore` 有条目。渲染一行占位，文案「等待你选择」，`data-testid="ask-user-pending"`。带 store 条件才能收放：确定 / 取消 / 发送取消都会 `clear()` store，此时工具 status 仍是 `running`，不带条件占位会一直挂着（还带呼吸动画）直到 sidecar 回报。这也与现状 `InlineQuestionCard` 的 `if (!item) return null` 等价。
- `status === 'error'`：不渲染占位，也不渲染摘要。
- 选完且工具 `done`：仍用现有 `AnsweredQuestionsCard`（「已回答 · N 题」）。刷新后仍在，因为工具结果在会话事件里。
- 点取消且工具 `done`：渲染「已取消」。判定只能用 `parseAnswers(result).length === 0`——`AnsweredQuestionsCard.tsx:124` 的 `count = Math.max(qdata.length, answers.length)`，取消时 `args.questions` 仍在 → `qdata.length ≥ 1` → `count ≥ 1`，所以现状的真实后果是渲染出「有题目、答案为空」的卡，不是整行空白，也不是空卡。`count === 0` 判不出取消。
- 发送消息取消：回传取消后 `clear()` store，占位随之消失（无需额外标记），**不**再渲染「已取消」，**不**插「跳过提问」代发消息。用户刚发送的那条就是记录。

### 6.2 普通选择 / 确认 / 输入

**待答占位**：底部等待文案已经存在，不要另起一行。`ChatListView.tsx:25` 用 `waitingUiPromptLabel(useStore((s) => s.waitingUiPrompt))` 取标签，经 `PreparingIndicator` 渲染成「等待批准… / 等待确认… / 等待输入…」（`waitingUiPrompt.ts:29-34`，由 approval 扩展的 `setStatus('ui-prompt')` 写入，`ExtensionUiHost.tsx:193-196`）。footer 是**单槽**（`ChatListView.tsx:53`），两条等待文案会互相顶掉。

规则：

1. `waitingLabel` 非空 → footer 照旧显示它，不追加第二行；
2. `waitingLabel` 为空，且当前 workspace 的 `uiPromptStore` 有非审批请求 → footer 画「等待你选择」，`data-testid="ui-prompt-pending"`；
3. 两者都无 → footer 维持现有 `showPreparing` 逻辑不变。

**已答留痕**：没有现成的 append action，直接在 agent store 上打补丁：

```ts
useStore.setState((s) => ({
  messages: [...s.messages, { kind: 'notice', id: `local-${crypto.randomUUID()}`, customType: 'ui-prompt-receipt', content }],
}));
```

notice 的形状见 `agentReducer.ts:34`（`{ kind: 'notice'; id: string; customType: string; content: string }`），渲染分支加在 `ChatMessageItems.tsx:96-104` 已有的 customType 分发表里，`data-testid="ui-prompt-receipt"`。

id 不要复用 `agentReducer.ts:64` 的 `nextId()`：它是模块私有的 `m${++counter}` 递增器，未导出，本地照抄会与后续会话事件的 id 撞车。用 `local-` 前缀的自造 id 即可，只要求在当前列表内唯一。

`content` 为 JSON：

- 选完：`{ "outcome": "answered" | "confirmed", "title": string, "value": string }`。`value` 是选项文案、确认「确定」、或提交的输入文本。渲染标题为「已回答」或「已确认」。
- 点取消：`{ "outcome": "cancelled", "title": string }`，渲染「已取消」。
- 发送消息取消：不追加 notice，footer 占位拿掉。

这些 notice 只保证当次会话可见。不写入 sidecar、不改 pi core。刷新后可能没有，第一期接受。

## 7. 发送即取消的时序

插入点是 `ChatInput.tsx:65-90` 的 `send()` **内部**，在空判 `if (!text && images.length === 0) return;`（第 73 行）**之后**、`editor.cleanDocument()`（第 74 行）**之前**。

不能写成「调用方先取消再调 `send()`」：是否真要发送只有 `send()` 自己知道（空输入 / 只有图片等），在外部取消会导致空敲回车也把待答题消掉。

步骤：

1. 读当前 workspace 的 `inlineQuestionStore` 条目，或非审批的 `uiPromptStore` 条目。
2. 若有：`await` 按 §4 第 2 条回传（permission 来源走 `resolvePermission`），成功后 `clear` 对应 store。
3. 拿掉会话占位：`uiPromptStore` 清空后 footer 占位自动消失；`ask_user` 需要显式抑制，见下。
4. 继续原有 `send()` 流程（`onSend(text, images, steer/followUp)`）。不新开发送通道。

`send()` 要改成 async：第 2 步的回传必须 await。调用方 `MessageEditor.tsx:205-210` 的 Enter 处理是 `send();`，`void send()` 即可，无其它调用点需要改。

**ask_user 占位的收放**：占位条件是 `status === 'running'` **且** `inlineQuestionStore.byWorkspace[workspace]` 有条目（见 §6.1）。`clear()` 之后条件不再成立，占位自动消失，不需要在 store 上加额外的抑制标记。四种收尾路径（确定 / 取消 / 发送取消 / `!hasUI` 回退）都靠这一条覆盖。

**回传失败**：toast 错误，浮层保留，本次发送中止（避免题目仍阻塞却已把用户稿发出去）。

## 8. 文件改动（预期）

**新建**

- `electron-agent/src/features/chat/input/ComposerPromptOverlay.tsx`（及测试）：锚定、portal、按 store 分发询问 / 选择 / 确认 / 输入。
- 占位行小组件 `electron-agent/src/features/chat/PromptPendingRow.tsx`：`ask_user` 工具行占位与列表 footer 占位共用同一行样式（与 `NoticePill` 同级视觉）。

**修改**

- `MessageEditor.tsx`（`src/features/chat/input/editor/MessageEditor.tsx:169` 之下）：挂浮层，位置在 surface 之后（原因见 §5.1）。
- `PromptRequestCard.tsx`：非审批 UI 抽给浮层复用；本文件只留审批分支（含 §5.1 的两条排除条件）。
- `ToolExecution.tsx`（`:252-258`）：`ask_user` 且 `status === 'running'` 改占位；`done` 且答案为空走「已取消」。
- `ChatListView.tsx`：footer 占位按 §6.2 的三条优先级规则；`ChatMessageItems.tsx:96-104` 加 `ui-prompt-receipt` 分支。
- `ChatInput.tsx`（`:65-90`）：`send()` 改 async，按 §7 在空判之后插入取消逻辑。
- `InlineQuestionCard.tsx`：逻辑迁走或改为被浮层复用；工具行不再直接渲染整卡。

**测试**

- `ToolExecution.test.tsx` 目前**没有** `ask_user` 用例（全项目 src 下也没有），需新增覆盖占位 / 已回答 / 已取消三种。
- `MessageEditor.test.tsx:60` 已 `vi.mock('../PromptRequestCard')`，新增的 `ComposerPromptOverlay` 同样要 mock——它依赖 `surfaceRef` 与 ResizeObserver，jsdom 下不 mock 会挂。
- 回归：`PromptRequestCard`、`InlineQuestionCard`、`ToolExecution`、`ChatListView`、`MessageEditor`、`ExtensionUiHost.test.tsx`（`__askUser` 与普通 `input` 的路由分发）。

**不改**

- `extensions/agent-mode/questions.ts` 与 `ask_user` 载荷。
- `createBoxMenu` 的失焦关闭行为。
- 审批文案与一键按钮。

## 9. 测试

- 浮层（`data-testid="composer-prompt-overlay"`）：有询问或非审批 UI 请求时出现，锚定宽度等于 `composer-surface`；审批请求（`source === 'permission'` 或 `isApprovalSelect`）不出现浮层、仍出现审批卡。
- 关闭：模拟失焦、Esc、打开 `/`，浮层仍在；确定 / 取消 / X / 发送后消失。
- 发送：有待答且编辑器有内容时，先 `cancelled` 再 `send`；编辑器为空时不取消、不回传。
- 发送失败回传：`extensionUiRespond`（或 `resolvePermission`）reject 则不 `send`，浮层还在。
- `ask_user` 运行中工具行是 `ask-user-pending`，不是 `inline-question` 整卡；`status === 'error'` 不出现占位；`done` + 有选择 → `answered-questions-card`；`done` + 取消 → 「已取消」。
- 占位收放：store 有条目 + `status === 'running'` → `ask-user-pending`；store 清空后即使 status 仍是 `running`，占位也不出现。
- footer：`waitingUiPrompt` 有值时不重复画「等待你选择」；无值且有非审批请求时画 `ui-prompt-pending`。
- 选择 / 确认 / 输入确定后，messages 里有 `ui-prompt-receipt`；取消也有；发送取消则没有。
- 回归：`PromptRequestCard` 审批用例、`QuestionSelector`、`ExtensionUiHost` 对 `__askUser` 与普通 `input` 的路由。

## 10. 风险

- **取消与模型续写抢跑**：回传 `cancelled` 后模型可能先生成「已取消」。发送走 SteerQueue 把用户原文送进同一回合，减轻但不消灭这个窗口。不为此改 pi core。
- **选择 / 确认 / 输入摘要不回放**：刷新后可能只剩后续助手消息、没有那条 notice。第一期接受。
- **本地 notice 与整表替换冲突**：`useChildSessionBinding.ts:33` 用 `s.messages.length >= msgs.length` 守卫子代理会话的整表补量。本地追加的 notice 会把 length 顶大，理论上可能挡住后续同步。主会话走 `applyEvent`，不受影响；实现时确认子代理面板是否读同一个 store，若是，notice 只追加到主会话 store。
- **浮层被 body portal 盖住**：`VisualCard`（全屏浮层）、`SubagentHeaderCatalog`、`DockDndProvider(z-index 9999)` 都 portal 到 `document.body`，会盖在 `lobe-ui-theme-app` 里的浮层之上。本期不与它们争层级。
- **与审批卡同时出现**：审批占位在输入框上方，询问浮层在输入框上层，可能挤。不合并、不排队，按现有「各管各的」处理。
- **子代理 ask_user**：完整卡在主 Composer。若用户正在看子代理面板，可能注意不到浮层。第一期不在子代理面板再挂一张卡。

## 11. 与 2026-06-21 计划的关系

`docs/superpowers/archive/plans/2026-06-21-question-selector-redesign.md`（实现计划，不是 specs 下的设计规格）把待答卡从输入框上方改到对话流，是为了「题目和选项在一起」。本文把**待答交互**改回输入框浮层，**结果摘要**留在对话流。皮肤、多题、回传哨兵、`!hasUI` 回退仍服从该计划。冲突条款以本文为准：待答不再内联整卡。

该计划任务 8 写的是「在对话列末尾挂载 `InlineQuestionCard`」，实际落地时已改为挂在 `ask_user` 工具行内（`ToolExecution.tsx:257`）。本文沿用现状位置，只把整卡换成占位。

## 12. 审查修订记录（2026-09-14）

对照代码逐条核对后的修订。分三级：**阻断** = 照原文写会实现错；**补漏** = 原文没写、实现时会卡住；**校准** = 表述与代码不符，按代码改。

| # | 级别 | 位置 | 修订 |
| --- | --- | --- | --- |
| 1 | 阻断 | §7 | 原时序要求「调用方先取消再调 `send()`」，同时又要求「空输入不取消」，两者互斥——空判在 `send()` 内部。改为插入点 = `ChatInput.send()` 内、空判之后。 |
| 2 | 阻断 | §6.1 / §7 | 占位条件补上「`inlineQuestionStore` 该 workspace 有条目」。只按 `status === 'running'` 占位的话，确定 / 取消之后（store 已清、工具仍未 done）占位会一直挂着并继续呼吸。加了 store 条件后不需要额外的抑制标记。 |
| 3 | 阻断 | §6.2 | footer 已有 `waitingUiPrompt` → `PreparingIndicator` 的等待文案，且是单槽。新增一行会互相顶掉。改为三条优先级规则。 |
| 4 | 阻断 | §6.1 | 占位状态范围收紧到 `status === 'running'`；`ConvStatus` 有 `'error'`，按原文「非 done 即占位」会把失败的工具行显示成「等待你选择」。 |
| 5 | 补漏 | §4 / §5.1 | 审批排除条件从「忽略 `isApprovalSelect`」改为「`source === 'permission'` 或 `isApprovalSelect` 取并集」，并补 permission 回传走 `pi.resolvePermission`。 |
| 6 | 补漏 | §4 | 补 X（`prompt-request-dismiss`）的归属：等同取消，不是第四种关闭方式。 |
| 7 | 补漏 | §5.1 | 补 portal 容器必须与 slash 同（`LOBE_THEME_APP_ID`），否则 1050 / 1100 无可比性。 |
| 8 | 补漏 | §5.1 | 补挂载位置陷阱：必须放在 `surface` 之后，否则首次 measure 时 `surfaceRef.current` 为 null。 |
| 9 | 补漏 | §5.1 | 补浮层整体限高 `min(60vh, 480px)`；`QuestionSelector` 的 260px 只管选项区。 |
| 10 | 补漏 | §6.2 | 补 notice 落盘的 concrete API（无现成 action，直接 `setState` 追加）与渲染挂载点。 |
| 11 | 补漏 | §9 | 补齐 testid：`composer-prompt-overlay` / `ask-user-pending` / `ui-prompt-pending` / `ui-prompt-receipt`。 |
| 12 | 补漏 | §8 | 补 `inlineQuestionStore` 抑制标记的改动条目、`ToolExecution` 无 `ask_user` 测试、`MessageEditor.test.tsx` 需 mock 新组件。 |
| 13 | 补漏 | §10 | 补两条风险：本地 notice 与 `useChildSessionBinding` 整表替换冲突；body portal 组件盖住浮层。 |
| 14 | 校准 | 头 / §11 | 引用路径错，实际是 `docs/superpowers/archive/plans/2026-06-21-question-selector-redesign.md`。 |
| 15 | 校准 | §6.1 | 「不要用空的 `AnsweredQuestionsCard`」表述不准：该组件 `count = Math.max(qdata.length, answers.length)`，取消时 `args.questions` 仍在 → `count ≥ 1` → 真实后果是「有题目、答案为空」的卡。判定取消必须用 `parseAnswers(result).length === 0`。 |
| 16 | 校准 | §5.2 | `ask_user`（工具名）与 `__askUser`（载荷哨兵）是两套机制，原文混用。 |
